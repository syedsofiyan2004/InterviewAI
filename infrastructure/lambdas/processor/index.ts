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
    Key: { interview_id: id },
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
      Key: { interview_id: id },
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

  // 4. Step: Parse JD & Build Rubric
  console.log('Step 3: Parsing JD and building rubric...');
  const rubric = await withRetry(() => parseJDAndBuildRubric(jd, item.model_id), 3, 'JD_BEDROCK_PARSE_FAILED');

  // 5. Step: Extract Evidence & Score
  console.log('Step 4: Extracting evidence and scoring...');
  const evaluation = await withRetry(() => extractEvidenceAndScore(transcript, rubric, item.model_id), 3, 'AI_MALFORMED_OUTPUT');

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
      Analyze the following Job Description (JD) and build a structured, dynamic evaluation rubric.
      
      CRITICAL ANALYSIS RULES:
      1. Identify "Mandatory Non-Negotiables": These are specific skills, scale/experience levels, or certifications that are deal-breakers.
      2. Identify "Seniority Indicators": For Senior/Lead roles, focus the rubric on Strategy, Architectural Decisions, and Team/Scale impact over simple technical syntax.
      3. Assign "Decision Weights": High-risk dimensions (like "Scale Management" for an Architect) should have higher weights to ensure gaps there trigger a rejection.

      Output ONLY a valid raw JSON object. 
      NO MARKDOWN FENCES. NO CONVERSATIONAL TEXT.
      
      Schema:
      {
        "dimensions": [
          { "name": "string", "description": "string", "weight": number /* 1-10 */, "is_critical_deal_breaker": boolean }
        ]
      }
      
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

async function extractEvidenceAndScore(transcript: string, rubric: string, selection?: string): Promise<any> {
  const prompt = `
    Evaluate the interview transcript against the rubric with a SCEPTICAL executive lens.
    
    PERSONA: You are a Sceptical Executive Bar-Raiser. Your primary goal is to protect the organization from a "False Positive".
    
    SCORING HEURISTICS:
    1. EXECUTION VS. THEORY: Significant penalty if candidate fails to provide specific historical execution evidence for critical skills.
    2. VAGUE = GAP: High-level answers without verifiable detail must be marked as GAPs.
    3. DEAL-BREAKER PENALTY: Critical deal-breakers identified as GAPs force a No-Hire verdict and a sub-40 score.

    SCORING CALIBRATION:
    - 8.5 - 10.0: "Strong Hire" (Excellent execution across ALL non-negotiables)
    - 7.0 - 8.4: "Hire" (Strong execution across all criticals; minor nice-to-have gaps)
    - 4.0 - 6.9: "Maybe" (Has some good points but failed on at least one important indicator)
    - 0.0 - 3.9: "No Hire" (Failed a critical deal-breaker or showed significant seniority gaps)

    EVALUATION DEPTH:
    - executive_summary: Start with "CRITICAL RISKS & GAPS" before mentioning strengths. Be specific and blunt.
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
      "executive_summary": "SCEPTICAL executive assessment starting with risks",
      "final_recommendation_note": "A final verdict from a Bar-Raiser's perspective",
      "technical_depth": 0-10,
      "jd_fit_score": 0-100,
      "experience_level": "string",
      "fit_gap_analysis": [
        { "requirement": "summary", "fit": "Strong" | "Partial" | "Gap", "evidence": "verbatim quote" }
      ]
    }
    </evaluation_json>
    
    RUBRIC:
    ${rubric}

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
        inferenceConfig: { maxTokens: 4096, temperature: 0 }
      });
    } else {
      body = JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 4096,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        temperature: 0
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
  
  const MARGIN_X = 50;
  const MARGIN_TOP = 50;
  const MARGIN_BOTTOM = 50;
  const PAGE_WIDTH = 600;
  const PAGE_HEIGHT = 850;
  const DRAW_WIDTH = PAGE_WIDTH - (MARGIN_X * 2);
  
  // Design System
  const COLOR_PRIMARY = rgb(0.31, 0.27, 0.9); // Indigo #4F46E5
  const COLOR_TEXT = rgb(0.1, 0.1, 0.2);
  const COLOR_MUTED = rgb(0.4, 0.4, 0.5);
  const COLOR_SUCCESS = rgb(0.05, 0.6, 0.3);
  const COLOR_DANGER = rgb(0.8, 0.2, 0.2);

  let currentPage = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN_TOP;
  
  // Normalize score if it was passed in old scale (safety)
  const normScore = results.overall_score > 10 ? (results.overall_score / 10).toFixed(1) : results.overall_score;
  const isHire = Number(normScore) >= 7.0;

  const ensureSpace = (needed: number) => {
    if (y - needed < MARGIN_BOTTOM) {
      currentPage = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN_TOP;
      drawFooter(currentPage, pdfDoc.getPageCount());
      return true;
    }
    return false;
  };

  const drawFooter = (p: any, num: number) => {
    p.drawText(`Page ${num}  |  CONFIDENTIAL EXECUTIVE REPORT  |  Bar-Raiser AI`, {
      x: 180, y: 30, size: 7, font, color: rgb(0.6, 0.6, 0.6)
    });
  };

  const drawProgressBar = (p: any, val: number, max: number, x: number, py: number, width: number) => {
    const ratio = Math.min(Math.max(val / max, 0), 1);
    const color = val >= 8 ? COLOR_SUCCESS : val >= 6 ? COLOR_PRIMARY : COLOR_DANGER;
    p.drawRectangle({ x, y: py, width, height: 6, color: rgb(0.9, 0.95, 1), opacity: 0.5 });
    p.drawRectangle({ x, y: py, width: width * ratio, height: 6, color });
  };

  const drawFlowText = (text: string, size: number, f: any, lineH: number = 16, color: any = COLOR_TEXT, indent: number = 0) => {
    const paragraphs = text.split('\n');
    for (const para of paragraphs) {
      if (!para.trim()) { y -= lineH; continue; }
      const words = para.split(/\s+/);
      let line = '';
      for (const word of words) {
        const testLine = line + word + ' ';
        const width = f.widthOfTextAtSize(testLine.trim(), size);
        if (width > (DRAW_WIDTH - indent)) {
          ensureSpace(lineH);
          currentPage.drawText(line.trim(), { x: MARGIN_X + indent, y, size, font: f, color });
          line = word + ' ';
          y -= lineH;
        } else {
          line = testLine;
        }
      }
      ensureSpace(lineH);
      currentPage.drawText(line.trim(), { x: MARGIN_X + indent, y, size, font: f, color });
      y -= lineH + 6;
    }
  };

  const drawSectionHeader = (title: string) => {
    ensureSpace(80);
    y -= 40;
    currentPage.drawText(title.toUpperCase(), { x: MARGIN_X, y, size: 10, font: boldFont, color: COLOR_PRIMARY });
    y -= 12;
    currentPage.drawLine({ start: { x: MARGIN_X, y }, end: { x: PAGE_WIDTH - MARGIN_X, y }, thickness: 0.5, color: rgb(0.9, 0.9, 0.9) });
    y -= 25;
  };

  // --- Start Rendering ---
  drawFooter(currentPage, 1);

  // 1. Header
  const candidateName = (interviewParams.metadata?.candidate_name || 'Anonymous').toUpperCase();
  const position = interviewParams.metadata?.position || 'N/A';
  
  currentPage.drawText(candidateName, { x: MARGIN_X, y: y - 5, size: 24, font: boldFont, color: COLOR_TEXT });
  currentPage.drawText(`${position}  -  Technical Assessment`, { x: MARGIN_X, y: y - 30, size: 10, font, color: COLOR_MUTED });
  y -= 80;

  // 2. Metrics Grid
  const metricY = y;
  const drawMetric = (lbl: string, val: string, x: number) => {
    currentPage.drawRectangle({ x, y: metricY - 70, width: 120, height: 75, color: rgb(0.98, 0.99, 1), borderColor: rgb(0.9, 0.92, 0.95), borderWidth: 1, opacity: 0.8 });
    currentPage.drawText(lbl, { x: x + 12, y: metricY - 20, size: 7, font: boldFont, color: COLOR_MUTED });
    currentPage.drawText(val, { x: x + 12, y: metricY - 48, size: 18, font: boldFont, color: COLOR_PRIMARY });
  };
  drawMetric('OVERALL RATING', `${results.overall_score}/10`, 30);
  drawMetric('JD ALIGNMENT', `${results.jd_fit_score}%`, 165);
  drawMetric('TECHNICAL DEPTH', `${results.technical_depth || 0}/10`, 300);
  drawMetric('VERDICT', results.recommendation.toUpperCase(), 435);
  y -= 100;

  // 3. Sections
  drawSectionHeader('Executive Summary');
  drawFlowText(results.executive_summary, 9, font, 16);

  drawSectionHeader('Competency Analysis');
  results.dimension_breakdown.forEach(dim => {
    ensureSpace(60);
    const dScore = dim.score;
    currentPage.drawText(dim.dimension.toUpperCase(), { x: MARGIN_X, y, size: 8, font: boldFont });
    currentPage.drawText(`${dScore}/10`, { x: DRAW_WIDTH + MARGIN_X - 25, y, size: 8, font: boldFont, color: dScore >= 7.5 ? COLOR_SUCCESS : COLOR_PRIMARY });
    y -= 12;
    drawProgressBar(currentPage, dScore, 10, MARGIN_X, y, DRAW_WIDTH);
    y -= 18;
    drawFlowText(dim.reason, 8, font, 12, COLOR_MUTED, 5);
    y -= 8;
  });

  drawSectionHeader('Strength & Risks');
  const halfWidth = DRAW_WIDTH / 2 - 10;
  const startY = y;
  currentPage.drawText('KEY STRENGTHS', { x: MARGIN_X, y: startY, size: 8, font: boldFont, color: COLOR_SUCCESS });
  currentPage.drawText('IDENTIFIED RISKS', { x: MARGIN_X + halfWidth + 20, y: startY, size: 8, font: boldFont, color: COLOR_DANGER });
  y -= 15;
  
  const listY = y;
  results.strengths.slice(0, 4).forEach((s, i) => {
    currentPage.drawCircle({ x: MARGIN_X, y: listY - (i * 15) + 3, size: 1.5, color: COLOR_SUCCESS });
    currentPage.drawText(s.length > 50 ? s.substring(0, 47) + '...' : s, { x: MARGIN_X + 10, y: listY - (i * 15), size: 7, font });
  });
  results.areas_for_review.slice(0, 4).forEach((r, i) => {
    currentPage.drawCircle({ x: MARGIN_X + halfWidth + 20, y: listY - (i * 15) + 3, size: 1.5, color: COLOR_DANGER });
    currentPage.drawText(r.length > 50 ? r.substring(0, 47) + '...' : r, { x: MARGIN_X + halfWidth + 30, y: listY - (i * 15), size: 7, font });
  });
  y -= 75;

  drawSectionHeader('Verdict Details');
  ensureSpace(120);
  currentPage.drawRectangle({ x: MARGIN_X, y: y - 100, width: DRAW_WIDTH, height: 110, color: rgb(0.98, 0.99, 1), borderColor: COLOR_PRIMARY, borderWidth: 1 });
  currentPage.drawText('FINAL RECOMMENDATION:', { x: MARGIN_X + 20, y: y - 25, size: 9, font: boldFont, color: COLOR_MUTED });
  currentPage.drawText(results.recommendation.toUpperCase(), { x: MARGIN_X + 150, y: y - 25, size: 12, font: boldFont, color: results.overall_score >= 7 ? COLOR_SUCCESS : COLOR_DANGER });
  y -= 45;
  drawFlowText(results.final_recommendation_note, 9, font, 15, COLOR_TEXT, 20);

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
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


