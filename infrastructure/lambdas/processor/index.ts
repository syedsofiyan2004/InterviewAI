import { SQSEvent } from 'aws-lambda';
import { 
  ddbDocClient,
  s3Client,
  bedrockClient,
  validateEnv,
  getFileBuffer,
  saveFileContent
} from '../shared/aws';
import { 
  GetCommand,
  UpdateCommand 
} from '@aws-sdk/lib-dynamodb';
import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { z } from 'zod';
import { 
  DetailedEvaluationResult,
  InterviewStatus
} from '../../schema/index.js';

/**
 * [Surgical Fix] Internal 10-Point Schema
 * Defined locally to defeat AWS path caching for shared directories.
 */
const LocalEvaluationSchema = z.object({
  overall_score: z.number().min(0).max(10),
  recommendation: z.enum(['Strong Hire', 'Hire', 'Maybe', 'No Hire', 'Strong No Hire']),
  confidence: z.number().min(0).max(100),
  coverage_percent: z.number().min(0).max(100),
  dimension_breakdown: z.array(z.object({
    dimension: z.string(),
    score: z.number().min(0).max(10),
    reason: z.string(),
    evidence_found: z.boolean(),
  })),
  strengths: z.array(z.string()).max(10),
  areas_for_review: z.array(z.string()).max(10),
  evidence_items: z.array(z.object({
    quote: z.string(),
    context: z.string(),
    dimension: z.string(),
  })).max(10),
  executive_summary: z.string(),
  final_recommendation_note: z.string(),
  technical_depth: z.number().min(0).max(10).optional(),
  jd_fit_score: z.number().min(0).max(100).optional(),
  experience_level: z.string().optional(),
  fit_gap_analysis: z.array(z.object({
    requirement: z.string(),
    fit: z.enum(['Strong', 'Partial', 'Gap']),
    evidence: z.string(),
  })).max(12).optional(),
});
import pdf from 'pdf-parse';
import mammoth from 'mammoth';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { PassThrough } from 'stream';



validateEnv(['TABLE_NAME', 'BUCKET_NAME']);

const TABLE_NAME = process.env.TABLE_NAME!;
const BUCKET_NAME = process.env.BUCKET_NAME!;

export const handler = async (event: SQSEvent) => {
  for (const record of event.Records) {
    const { interview_id } = JSON.parse(record.body);
    
    try {
      await updateStatus(interview_id, 'PROCESSING');
      console.log(`Analyzing Interview: ${interview_id}`);
      
      await runEvaluationPipeline(interview_id);
      
    } catch (err: any) {
      console.error(`Evaluation failed for ${interview_id}:`, err);
      // Ensure we set clear error messages
      await updateStatus(interview_id, 'FAILED', {
        error_message: err.message || 'Evaluation engine failure'
      });
    }
  }
};

async function updateStatus(id: string, status: string, results: any = {}) {
  const updateExpr = 'SET #st = :status, updated_at = :now' + 
      Object.keys(results).map(key => `, ${key} = :${key}`).join('');

  const values: any = {
    ':status': status,
    ':now': Date.now(),
  };
  
  Object.keys(results).forEach(key => {
    values[`:${key}`] = results[key];
  });

  await ddbDocClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `INTERVIEW#${id}`, SK: 'METADATA' },
    UpdateExpression: updateExpr,
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: values,
  }));
}

async function runEvaluationPipeline(id: string) {
  // 1. Fetch record
  let item;
  try {
    const recordResult = await ddbDocClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `INTERVIEW#${id}`, SK: 'METADATA' },
    }));
    item = recordResult.Item;
  } catch (err) {
    throw new Error('DATABASE_FETCH_FAILED');
  }
  if (!item) throw new Error('INTERVIEW_NOT_FOUND');

  if (!item.transcript_s3_key || !item.jd_s3_key) {
    throw new Error('JD_OR_TRANSCRIPT_MISSING');
  }

  // 2. Load and Extract JD
  console.log('Step 1: Extracting Job Description text...');
  let jd: string;
  try {
    const { extractTextFromBuffer } = await import('../shared/utils.js');
    const jdBuffer = await getFileBuffer(BUCKET_NAME, item.jd_s3_key);
    const rawJd = await extractTextFromBuffer(jdBuffer, item.jd_s3_key);
    
    // Clean-Room Normalization: Remove PDF binary junk and noise
    jd = normalizeTranscript(rawJd);
    
    if (!jd || jd.trim().length === 0) {
      throw new Error('JD_EXTRACTION_EMPTY');
    }
  } catch (err: any) {
    console.error('JD extraction failed:', err);
    throw new Error(err.message || 'JD_EXTRACTION_FAILED');
  }

  // 3. Load and Extract Transcript
  console.log('Step 2: Extracting Transcript text...');
  let transcriptRaw: string;
  try {
    const { extractTextFromBuffer } = await import('../shared/utils.js');
    const transcriptBuffer = await getFileBuffer(BUCKET_NAME, item.transcript_s3_key);
    transcriptRaw = await extractTextFromBuffer(transcriptBuffer, item.transcript_s3_key);
    if (!transcriptRaw || transcriptRaw.trim().length === 0) {
       throw new Error('TRANSCRIPT_EXTRACTION_EMPTY');
    }
  } catch (err: any) {
    throw new Error(err.message || 'TRANSCRIPT_EXTRACTION_FAILED');
  }

  const transcript = normalizeTranscript(transcriptRaw);

  // 3.5 Load and Extract Resume (OPTIONAL)
  let resume: string | undefined = undefined;
  if (item.resume_s3_key) {
    console.log('Step 2.5: Extracting Resume text (Optional)...');
    try {
      const { extractTextFromBuffer } = await import('../shared/utils.js');
      const resumeBuffer = await getFileBuffer(BUCKET_NAME, item.resume_s3_key);
      const rawResume = await extractTextFromBuffer(resumeBuffer, item.resume_s3_key);
      resume = normalizeTranscript(rawResume);
      console.log('Resume extraction successful.');
    } catch (err: any) {
      console.warn('Optional resume extraction failed (continuing):', err);
    }
  }

  // 4. Step: Parse JD & Build Rubric
  console.log('Step 3: Parsing JD and building rubric...');
  const rubric = await withRetry(() => parseJDAndBuildRubric(jd, item.model_id), 3, 'JD_BEDROCK_PARSE_FAILED');

  // 5. Step: Extract Evidence & Score
  console.log('Step 4: Extracting evidence and scoring...');
  const evaluation = await withRetry(() => extractEvidenceAndScore(transcript, rubric, item.model_id, resume), 3, 'AI_MALFORMED_OUTPUT');

  // Data is already validated inside evaluateTranscript() using LocalEvaluationSchema
  const validatedResult = evaluation;

  // 7. Persist Full Result to S3
  const resultS3Key = `processed/${id}/result.json`;
  try {
    const serializedResult = JSON.stringify(validatedResult, null, 2);
    if (!serializedResult) throw new Error('SERIALIZATION_EMPTY');
    
    await saveFileContent(BUCKET_NAME, resultS3Key, serializedResult);
    console.log(`Step 6: Result JSON saved to S3: ${resultS3Key}`);
  } catch (err: any) {
    console.error('S3 Persistence Failure:', err);
    throw new Error(err.message === 'SERIALIZATION_EMPTY' ? 'RESULT_SERIALIZATION_FAILED' : 'RESULT_S3_SAVE_FAILED');
  }

  // 8. Generate and Persist PDF Report
  console.log('Step 7: Generating PDF report...');
  let reportS3Key: string | undefined = undefined;
  try {
    const pdfBuffer = await generatePdfReport(item, validatedResult);
    const key = `processed/${id}/report.pdf`;
    await saveFileContent(BUCKET_NAME, key, pdfBuffer, 'application/pdf');
    reportS3Key = key;
    console.log(`Step 8: PDF report saved to S3: ${reportS3Key}`);
  } catch (err) {
    console.error('PDF Generation Failed:', err);
    // Non-blocking: we continue with evaluation even if PDF fails
  }

  // 9. Update DynamoDB Compact Summary (Atomic finish)
  try {
    await updateStatus(id, 'COMPLETED', {
      result_s3_key: resultS3Key,
      report_s3_key: reportS3Key, // Only set if Step 8 succeeded
      overall_score: validatedResult.overall_score,
      recommendation: validatedResult.recommendation,
      confidence: validatedResult.confidence,
      coverage_percent: validatedResult.coverage_percent,
    });
    console.log(`Step 9: Interview ${id} marked as COMPLETED in DynamoDB`);
  } catch (err: any) {
    console.error('DynamoDB Finalization Failure:', err);
    throw new Error('RESULT_DDB_UPDATE_FAILED');
  }
}

function normalizeTranscript(text: string): string {
  if (!text) return '';
  return text
    .trim()
    .replace(/\[\d{1,2}:\d{2}(:\d{2})?\]/g, '') // Remove [00:00:00]
    .replace(/\(\d{1,2}:\d{2}\)/g, '')       // Remove (00:00)
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('\n');
}

async function parseJDAndBuildRubric(jd: string, selection?: string): Promise<string> {
  const { extractJson } = await import('../shared/utils.js');
  
  const buildRubric = async () => {
    const prompt = `
      You are an evaluation rubric builder. Your job is to read the Job Description below and 
      extract evaluation dimensions DIRECTLY from it.

      RULES:
      1. Every dimension MUST be grounded in a skill, responsibility, or requirement 
         explicitly stated in this JD. Do not invent or assume dimensions from outside the JD.
      2. Dimension names must reflect the actual domain of this role as described in the JD.
      3. Identify which requirements are non-negotiable (deal-breakers) vs. preferred vs. nice-to-have,
         based on the language used in the JD (e.g. "required", "minimum", "preferred", "advantageous").
         Assign weights accordingly: higher weight for critical requirements, lower for optional ones.
      4. Ignore any prior training bias — only use what the JD text actually says.

      Output ONLY a valid raw JSON object. 
      NO MARKDOWN FENCES. NO CONVERSATIONAL TEXT.
      
      Schema:
      {
        "dimensions": [
          { "name": "string", "description": "string", "weight": number /* 1-10 */, "is_critical_deal_breaker": boolean }
        ]
      }

      CONSTRAINTS:
      - Generate EXACTLY 6 to 9 dimensions. No more, no less.
      - Mark no more than 3 dimensions as is_critical_deal_breaker: true.
      - All dimensions must be directly derivable from the JD below.
      
      IMPORTANT: Wrap your final JSON output ONLY inside <rubric_json> tags.
      
      JD:
      ${jd}
    `;

    const response = await invokeBedrock(prompt, getModelId(selection));
    
    // Surgical Tag Extraction (Defeats AI Preamble)
    const match = response.match(/<rubric_json>([\s\S]*?)<\/rubric_json>/);
    const jsonStr = match ? match[1].trim() : extractJson(response);
    
    if (!jsonStr) throw new Error('AI_EMPTY_RESPONSE');

    // Precise Validation for Rubric
    try {
      const parsed = JSON.parse(jsonStr);
      if (!parsed.dimensions || !Array.isArray(parsed.dimensions)) throw new Error('Missing dimensions array');
      return jsonStr;
    } catch (valErr: any) {
      console.warn('[JD Rubric Parsing Fail]', valErr.message);
      throw new Error('AI_MALFORMED_OUTPUT');
    }
  };

  try {
    // Catch-All Resilience: Retry any failure (Access, Model, or Malformed)
    return await withRetry(buildRubric, 2, 'CATCH_ALL_FAILURE');
  } catch (err: any) {
    console.error('JD Rubric Stage Critical Failure:', err);
    throw new Error(`JD_RESULT_VALIDATION_FAILED: ${err.message || 'UnknownError'}`);
  }
}

function getModelId(selection?: string): string {
  // 1. Legacy Check & Auto-Migration
  const legacyKeys = ['claude-3-haiku', 'claude-3-5-sonnet', 'claude-opus-4-6'];
  let modelKey = selection || 'claude-3-sonnet';
  
  if (selection && legacyKeys.includes(selection)) {
    console.info(`[Legacy Migration] Promoting ${selection} -> claude-3-sonnet`);
    modelKey = 'claude-3-sonnet';
  }
  
  const mapping: Record<string, string | undefined> = {
    'claude-3-sonnet': process.env.BEDROCK_SONNET_PROFILE_ARN,
    'nova-pro': process.env.BEDROCK_NOVA_PROFILE_ARN,
  };

  const profileArn = mapping[modelKey];
  const allowFallback = process.env.ALLOW_BEDROCK_BASE_MODEL_FALLBACK === 'true';
  
  console.info('[Bedrock Resolution]', {
    requestedKey: modelKey,
    routingProfileArnExists: !!profileArn,
    fallbackEnabled: allowFallback
  });

  if (profileArn) {
    return profileArn;
  }

  if (allowFallback) {
    const fallbackMapping: Record<string, string> = {
      'claude-3-sonnet': 'apac.anthropic.claude-3-7-sonnet-20250219-v1:0',
      'nova-pro': 'amazon.nova-pro-v1:0',
    };
    const fallbackId = fallbackMapping[modelKey] || 'apac.anthropic.claude-3-7-sonnet-20250219-v1:0';
    console.warn('[Bedrock Resolved] Region-Locked Fallback to APAC Profile:', fallbackId);
    return fallbackId;
  }

  throw new Error(`MODEL_PROFILE_NOT_CONFIGURED: ${modelKey}`);
}

async function extractEvidenceAndScore(transcript: string, rubric: string, selection?: string, resume?: string): Promise<any> {
  const prompt = `
    Evaluate the interview transcript against the rubric with a SCEPTICAL executive lens.
    
    PERSONA: You are a Sceptical Executive Bar-Raiser. Your primary goal is to protect the organization from a "False Positive".
    
    SCORING HEURISTICS:
    1. EXECUTION VS. THEORY: Significant penalty if candidate fails to provide specific historical execution evidence for critical skills.
    2. VAGUE = GAP: High-level answers without verifiable detail must be marked as GAPs.
    3. DEAL-BREAKER PENALTY: Critical deal-breakers identified as GAPs force a No-Hire verdict and a sub-40 score.
    4. RESUME VERIFICATION: ${resume ? 'Use the provided RESUME to verify the candidate\'s claims in the TRANSCRIPT. Check for consistency in years of experience, specific projects, and technical depth.' : 'No resume provided for verification.'}
    
    WEIGHTED SCORING RULES:
    5. WEIGHT ENFORCEMENT: Each dimension has a "weight" (1-10) and 
       "is_critical_deal_breaker" flag from the rubric. 
       - Dimensions with weight >= 8 must be scored with maximum scrutiny.
       - A GAP (score < 5.0) on any is_critical_deal_breaker dimension 
         FORCES the overall recommendation to "No Hire" or lower, 
         regardless of other scores.
       - The overall_score should be a weighted average, not a simple 
         average. Higher-weight dimensions affect the final score more.
    6. INTERNAL REASONING: Before outputting JSON, mentally calculate:
       weighted_score = sum(dim.score * dim.weight) / sum(all weights)
       Use this as your overall_score baseline.

    SCORING CALIBRATION (STRICTLY ENFORCE):
    - 9.0 - 10.0: "Strong Hire" — Exceptional. Exceeded expectations on ALL critical dimensions.
    - 7.5 - 8.9: "Hire" — Strong execution across all criticals. Minor gaps in nice-to-haves only.
    - 5.0 - 7.4: "Maybe" — Adequate on some criticals but clear gaps. Needs further evaluation.
    - 2.5 - 4.9: "No Hire" — Failed at least one critical deal-breaker. Not ready for this role.
    - 0.0 - 2.4: "Strong No Hire" — Multiple critical failures or dishonesty detected. 
    
    The recommendation MUST mathematically match the overall_score range above.
    Do not override this mapping under any circumstances.

    EVALUATION DEPTH:
    - executive_summary: Open with the single most important risk or concern in plain language. Be direct and specific. Do not use all-caps headers or prefixes inside the summary text. Write in continuous prose, not bullet points.
    - areas_for_review: Be surgical. Identify exactly which requirement was not met and why the answer was insufficient.

    - Return ONLY valid raw JSON wrapped in <evaluation_json> tags. Escape all special characters. 
    
    - EVIDENCE DEPTH: Keep "quote" strings concise (max 150-200 characters). This is critical.
    
    - Use a scale of 0.0 to 10.0 for all scores (Decimals allowed, e.g., 8.5).
    - JD Fit Score: Percentage match (0-100).
    
    JSON Schema:
    <evaluation_json>
    {
      "overall_score": 0.0-10.0,
      "recommendation": "Strong Hire" | "Hire" | "Maybe" | "No Hire" | "Strong No Hire",
      "confidence": 0-100,
      "coverage_percent": 0-100,
      "dimension_breakdown": [
        { "dimension": "string", "score": 0.0-10.0, "reason": "concise explanation", "evidence_found": boolean }
      ],
      "strengths": ["string"], // Provide 5-8 high-impact strengths
      "areas_for_review": ["string"], // Provide 5-8 surgical gaps/risks
      "evidence_items": [
        { "quote": "string", "context": "string", "dimension": "string" }
      ], // Provide 5-8 verbatim evidence nuggets
      "executive_summary": "SCEPTICAL executive assessment starting with the primary risk",
      "final_recommendation_note": "A final verdict from a Bar-Raiser's perspective",
      "technical_depth": 0-10,
      "jd_fit_score": 0-100,
      "experience_level": "string",
      "fit_gap_analysis": [
        { "requirement": "summary", "fit": "Strong" | "Partial" | "Gap", "evidence": "verbatim quote" }
      ]
    }
    </evaluation_json>
    
    ANTI-HALLUCINATION RULES:
    - Every score and claim in evidence_items MUST be grounded in 
      something the candidate actually said in the TRANSCRIPT.
    - Do NOT infer or assume skills not evidenced in the transcript.
    - If a dimension has zero evidence in the transcript, 
      set evidence_found: false and score it 2.0 or below.
    - Quotes in evidence_items must be near-verbatim from the 
      transcript, not paraphrased reconstructions.

    RUBRIC:
    ${rubric}

    ${resume ? `CANDIDATE RESUME:\n${resume}\n\n` : ''}

    TRANSCRIPT:
    ${transcript}
  `;

  const response = await invokeBedrock(prompt, getModelId(selection));
  const jsonStr = extractJson(response);
  try {
    const rawResult = JSON.parse(jsonStr);
    
    // Strict schema validation (Baked local version to defeat caching)
    const validation = LocalEvaluationSchema.safeParse(rawResult);
    
    if (!validation.success) {
      const errorMsg = validation.error.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`).join(', ');
      console.error('[FINAL EVALUATION VALIDATION FAILED]', errorMsg);
      throw new Error(`FINAL_RESULT_VALIDATION_FAILED: ${errorMsg}`);
    }
    
    return validation.data;
  } catch (err: any) {
    if (err.message?.includes('VALIDATION_FAILED')) throw err;
    if (err.message?.includes('MODEL_PROFILE_NOT_CONFIGURED')) throw err;
    console.error('Evaluation Stage Error:', err);
    throw new Error(`FINAL_RESULT_VALIDATION_FAILED: ${err.message || 'UnknownError'}`);
  }
}

async function withRetry<T>(fn: () => Promise<T>, attempts: number = 2, retryErrorMsg: string = 'AI_MALFORMED_OUTPUT'): Promise<T> {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      // Retry if it matches the requested error OR if it's a 'CATCH_ALL' resilience request
      const isCatchAll = retryErrorMsg === 'CATCH_ALL_FAILURE';
      const isExplicitMatch = err.message === retryErrorMsg || err.message === 'AI_MALFORMED_OUTPUT';
      
      if ((isCatchAll || isExplicitMatch) && i < attempts - 1) {
        console.warn(`Retry attempt ${i + 1} for: ${err.message}`);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}
async function invokeBedrock(prompt: string, modelId: string): Promise<string> {
  try {
    const isNova = modelId.includes('amazon.nova');
    console.log('Invoking Bedrock model: ' + modelId);

    let body: string;
    if (isNova) {
      body = JSON.stringify({
        messages: [{ role: 'user', content: [{ text: prompt }] }],
        inferenceConfig: { maxTokens: 6000, temperature: 0.1 }
      });
    } else {
      body = JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 6000,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        temperature: 0.1
      });
    }

    const response = await bedrockClient.send(new InvokeModelCommand({
      modelId: modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: body,
    }));

    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    const text = isNova ? responseBody.output?.message?.content?.[0]?.text : responseBody.content?.[0]?.text;
    
    if (!text || text.trim().length === 0) {
      throw new Error('JD_BEDROCK_EMPTY_RESPONSE');
    }
    return text;
  } catch (err: any) {
    console.error('Bedrock Invocation Failure:', err);
    throw err;
  }
}

async function generatePdfReport(interviewParams: any, results: DetailedEvaluationResult): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const W = 595.28; // A4 width
  const H = 841.89; // A4 height
  const ML = 48;    // margin left
  const MR = 48;    // margin right
  const MT = 48;    // margin top
  const MB = 48;    // margin bottom
  const CW = W - ML - MR; // content width

  // ── Color palette ──────────────────────────────
  const C = {
    indigo:     rgb(0.310, 0.275, 0.898), // #4F46E5
    indigoDark: rgb(0.231, 0.212, 0.722), // #3B36B8
    indigoLight:rgb(0.937, 0.937, 0.996), // #EFEFFE
    white:      rgb(1, 1, 1),
    black:      rgb(0.067, 0.067, 0.067), // #111111
    gray800:    rgb(0.157, 0.165, 0.188), // #282A30
    gray600:    rgb(0.369, 0.384, 0.420), // #5E626B
    gray300:    rgb(0.820, 0.831, 0.847), // #D1D4D8
    gray100:    rgb(0.961, 0.965, 0.969), // #F5F6F7
    green:      rgb(0.016, 0.647, 0.439), // #04A570
    greenLight: rgb(0.878, 0.976, 0.945), // #E0F9F1
    amber:      rgb(0.851, 0.502, 0.000), // #D98000
    amberLight: rgb(1.000, 0.961, 0.878), // #FFF5E0
    red:        rgb(0.800, 0.133, 0.133), // #CC2222
    redLight:   rgb(0.996, 0.878, 0.878), // #FEE0E0
    divider:    rgb(0.910, 0.914, 0.922), // #E8E9EB
  };

  // ── Score-based verdict color ──────────────────
  const score = results.overall_score;
  const verdictColor = score >= 7.5 ? C.green : score >= 5.0 ? C.amber : C.red;
  const verdictBg    = score >= 7.5 ? C.greenLight : score >= 5.0 ? C.amberLight : C.redLight;

  // ── Page management ────────────────────────────
  let page = pdfDoc.addPage([W, H]);
  let y = H - MT;

  const newPage = () => {
    // Footer on current page
    page.drawText('CONFIDENTIAL — MINFY AI EVALUATION REPORT', {
      x: ML, y: 24, size: 6.5, font, color: C.gray300,
    });
    page.drawText(`Page ${pdfDoc.getPageCount()}`, {
      x: W - MR - 30, y: 24, size: 6.5, font, color: C.gray300,
    });
    page = pdfDoc.addPage([W, H]);
    y = H - MT;
  };

  const gap = (n: number) => { y -= n; };

  const needsSpace = (n: number) => {
    if (y - n < MB + 40) newPage();
  };

  // Wrap and draw text, returns lines used
  const drawText = (
    text: string,
    opts: {
      x?: number; size?: number; f?: any; color?: any;
      maxWidth?: number; lineHeight?: number; indent?: number;
    } = {}
  ): number => {
    const {
      x = ML, size = 9, f = font, color = C.gray800,
      maxWidth = CW, lineHeight = 14, indent = 0,
    } = opts;

    const words = String(text || '').split(/\s+/);
    let line = '';
    let linesDrawn = 0;

    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (f.widthOfTextAtSize(test, size) > maxWidth - indent && line) {
        needsSpace(lineHeight);
        page.drawText(line, { x: x + indent, y, size, font: f, color });
        y -= lineHeight;
        linesDrawn++;
        line = word;
      } else {
        line = test;
      }
    }
    if (line) {
      needsSpace(lineHeight);
      page.drawText(line, { x: x + indent, y, size, font: f, color });
      y -= lineHeight;
      linesDrawn++;
    }
    return linesDrawn;
  };

  const drawDivider = (opacity = 1) => {
    needsSpace(1);
    page.drawLine({
      start: { x: ML, y },
      end: { x: W - MR, y },
      thickness: 0.5,
      color: C.divider,
      opacity,
    });
    y -= 1;
  };

  const sectionTitle = (title: string) => {
    needsSpace(36);
    gap(20);
    page.drawText(title.toUpperCase(), {
      x: ML, y, size: 7.5, font: boldFont, color: C.indigo,
    });
    y -= 10;
    drawDivider();
    gap(10);
  };

  // ══════════════════════════════════════════════
  // PAGE 1 — COVER HEADER
  // ══════════════════════════════════════════════

  // Top navy bar
  page.drawRectangle({ x: 0, y: H - 56, width: W, height: 56, color: C.indigoDark });
  
  // Logo text in bar
  page.drawText('MINFY', { x: ML, y: H - 34, size: 13, font: boldFont, color: C.white });
  page.drawText('AI', { x: ML + 46, y: H - 34, size: 13, font, color: rgb(0.6, 0.6, 1) });
  page.drawText('EVALUATION REPORT', {
    x: W - MR - 110, y: H - 34, size: 8, font: boldFont, color: rgb(0.7, 0.7, 0.9),
  });

  y = H - 56 - 32;

  // Candidate name
  const name = (interviewParams.metadata?.candidate_name || 'Candidate').toUpperCase();
  page.drawText(name, { x: ML, y, size: 22, font: boldFont, color: C.black });
  y -= 26;

  // Position + date line
  const position = interviewParams.metadata?.position || 'N/A';
  const dateStr = new Date().toLocaleDateString('en-GB', { day:'2-digit', month:'long', year:'numeric' });
  page.drawText(`${position}  ·  Evaluated ${dateStr}`, {
    x: ML, y, size: 9, font, color: C.gray600,
  });
  y -= 20;

  drawDivider();
  gap(20);

  // ── Metrics strip (4 boxes) ────────────────────
  const metrics = [
    { label: 'Overall Rating', value: `${results.overall_score}/10` },
    { label: 'JD Fit Score',   value: `${results.jd_fit_score ?? '--'}%` },
    { label: 'Tech Depth',     value: `${results.technical_depth ?? '--'}/10` },
    { label: 'Confidence',     value: `${results.confidence ?? '--'}%` },
  ];

  const boxW = CW / 4 - 6;
  const boxH = 58;
  const boxY = y - boxH;

  metrics.forEach((m, i) => {
    const bx = ML + i * (boxW + 8);
    page.drawRectangle({ x: bx, y: boxY, width: boxW, height: boxH, color: C.gray100 });
    page.drawRectangle({ x: bx, y: boxY + boxH - 3, width: boxW, height: 3, color: C.indigo });
    page.drawText(m.label, { x: bx + 10, y: boxY + boxH - 16, size: 7, font, color: C.gray600 });
    page.drawText(m.value, { x: bx + 10, y: boxY + 16, size: 16, font: boldFont, color: C.indigoDark });
  });

  y = boxY - 20;

  // ── Verdict badge ──────────────────────────────
  const recText = results.recommendation.toUpperCase();
  const recW = boldFont.widthOfTextAtSize(recText, 11) + 28;
  page.drawRectangle({ x: ML, y: y - 26, width: recW, height: 26, color: verdictBg });
  page.drawRectangle({ x: ML, y: y - 26, width: 4, height: 26, color: verdictColor });
  page.drawText(recText, { x: ML + 12, y: y - 17, size: 11, font: boldFont, color: verdictColor });
  y -= 44;

  // ══════════════════════════════════════════════
  // EXECUTIVE SUMMARY
  // ══════════════════════════════════════════════
  sectionTitle('Executive Summary');
  drawText(results.executive_summary, { size: 9, lineHeight: 15, color: C.gray800 });
  gap(4);

  // ══════════════════════════════════════════════
  // COMPETENCY BREAKDOWN
  // ══════════════════════════════════════════════
  sectionTitle('Competency Analysis');

  results.dimension_breakdown.forEach((dim) => {
    needsSpace(52);

    // Dim name + score on one line
    const dimScore = dim.score;
    const dimColor = dimScore >= 8 ? C.green : dimScore >= 6 ? C.indigo : dimScore >= 4 ? C.amber : C.red;

    page.drawText(dim.dimension, {
      x: ML, y, size: 8.5, font: boldFont, color: C.black,
    });
    page.drawText(`${dimScore}/10`, {
      x: W - MR - 30, y, size: 8.5, font: boldFont, color: dimColor,
    });
    y -= 12;

    // Progress bar
    const barW = CW;
    const ratio = Math.min(Math.max(dimScore / 10, 0), 1);
    page.drawRectangle({ x: ML, y, width: barW, height: 5, color: C.gray100 });
    page.drawRectangle({ x: ML, y, width: barW * ratio, height: 5, color: dimColor });
    y -= 10;

    // Reason text
    drawText(dim.reason, { size: 8, lineHeight: 13, color: C.gray600, indent: 2 });
    gap(8);
  });

  // ══════════════════════════════════════════════
  // STRENGTHS & RISKS (two columns)
  // ════════════════════════════════════════──────────────────────
  sectionTitle('Strengths & Risks');

  const colW = CW / 2 - 12;
  const strengths = results.strengths.slice(0, 6);
  const risks = results.areas_for_review.slice(0, 6);
  const rows = Math.max(strengths.length, risks.length);

  // Column headers
  page.drawText('KEY STRENGTHS', { x: ML, y, size: 7.5, font: boldFont, color: C.green });
  page.drawText('AREAS FOR REVIEW', { x: ML + colW + 24, y, size: 7.5, font: boldFont, color: C.red });
  y -= 14;

  for (let i = 0; i < rows; i++) {
    needsSpace(20);

    if (strengths[i]) {
      page.drawCircle({ x: ML + 4, y: y + 3, size: 2.5, color: C.green });
      const s = strengths[i].length > 65 ? strengths[i].slice(0, 62) + '…' : strengths[i];
      page.drawText(s, { x: ML + 12, y, size: 7.5, font, color: C.gray800 });
    }

    if (risks[i]) {
      page.drawCircle({ x: ML + colW + 28, y: y + 3, size: 2.5, color: C.red });
      const r = risks[i].length > 65 ? risks[i].slice(0, 62) + '…' : risks[i];
      page.drawText(r, { x: ML + colW + 36, y, size: 7.5, font, color: C.gray800 });
    }

    y -= 16;
  }

  gap(4);

  // ══════════════════════════════════════════════
  // VERDICT BOX
  // ══════════════════════════════════════════════
  sectionTitle('Final Verdict');
  needsSpace(80);

  const vboxH = 72;
  page.drawRectangle({ x: ML, y: y - vboxH, width: CW, height: vboxH, color: C.indigoLight });
  page.drawRectangle({ x: ML, y: y - vboxH, width: 4, height: vboxH, color: C.indigo });

  page.drawText('RECOMMENDATION:', {
    x: ML + 14, y: y - 18, size: 7.5, font: boldFont, color: C.gray600,
  });
  page.drawText(recText, {
    x: ML + 110, y: y - 18, size: 9, font: boldFont, color: verdictColor,
  });

  y -= 30;
  drawText(results.final_recommendation_note, {
    x: ML + 14, size: 8.5, lineHeight: 14,
    color: C.gray800, maxWidth: CW - 24,
  });
  gap(16);

  // ══════════════════════════════════════════════
  // FOOTER on last page
  // ══════════════════════════════════════════════
  page.drawText('CONFIDENTIAL — MINFY AI EVALUATION REPORT', {
    x: ML, y: 24, size: 6.5, font, color: C.gray300,
  });
  page.drawText(`Page ${pdfDoc.getPageCount()}`, {
    x: W - MR - 30, y: 24, size: 6.5, font, color: C.gray300,
  });

  return Buffer.from(await pdfDoc.save());
}

function extractJson(text: string): string {
  // 1. Priority 1: Semantic tags
  const xmlMatch = text.match(/<evaluation_json>([\s\S]*?)<\/evaluation_json>/i);
  if (xmlMatch && xmlMatch[1].trim()) {
    return xmlMatch[1].trim();
  }

  // 2. Priority 2: Markdown blocks
  const mdMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (mdMatch && mdMatch[1].trim()) {
    return mdMatch[1].trim();
  }
  
  // 3. Priority 3: First { to last } (The "Deep Search")
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  
  if (start !== -1 && end !== -1 && end > start) {
    let candidate = text.substring(start, end + 1).trim();
    // Scrub potential trailing markdown artifacts if the AI didn't close the fence properly
    candidate = candidate.replace(/```$/g, '').trim();
    return candidate;
  }
  
  return text;
}


