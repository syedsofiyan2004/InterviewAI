import { SQSEvent } from 'aws-lambda';
import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import {
  bedrockClient,
  ddbDocClient,
  getFileBuffer,
  saveFileContent,
  validateEnv,
} from '../shared/aws';
import { extractJson, extractTextFromBuffer } from '../shared/utils.js';
import { generateMomPdfReport } from '../shared/mom-report.js';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { MomResultSchema } from '../../schema/mom.js';

validateEnv(['MOM_TABLE_NAME', 'BUCKET_NAME', 'MOM_MODEL_ID']);

const MOM_TABLE_NAME = process.env.MOM_TABLE_NAME!;
const BUCKET_NAME = process.env.BUCKET_NAME!;
const MOM_MODEL_ID = process.env.MOM_MODEL_ID!;

export const handler = async (event: SQSEvent) => {
  for (const record of event.Records) {
    const { mom_id } = JSON.parse(record.body || '{}');

    try {
      if (!mom_id) throw new Error('MOM_ID_MISSING');
      await runMomPipeline(mom_id);
    } catch (err: any) {
      console.error(`MOM analysis failed for ${mom_id || 'unknown'}:`, err);
      if (mom_id) {
        await updateMom(mom_id, 'FAILED', {
          error_message: err.message || 'MOM analysis failed',
        });
      }
    }
  }
};

async function runMomPipeline(id: string) {
  await updateMom(id, 'PROCESSING');

  const record = await ddbDocClient.send(new GetCommand({
    TableName: MOM_TABLE_NAME,
    Key: { mom_id: id },
  }));

  const item = record.Item;
  if (!item) throw new Error('MOM_NOT_FOUND');
  if (!item.owner_user_id) throw new Error('MOM_OWNER_MISSING');
  if (!item.transcript_s3_key) throw new Error('TRANSCRIPT_MISSING');

  let transcript: string;
  try {
    const buffer = await getFileBuffer(BUCKET_NAME, item.transcript_s3_key);
    transcript = normalizeText(await extractTextFromBuffer(buffer, item.transcript_s3_key));
    if (!transcript.trim()) throw new Error('TRANSCRIPT_EMPTY');
  } catch (err: any) {
    throw new Error(err.message || 'TRANSCRIPT_EXTRACTION_FAILED');
  }

  const result = await analyzeTranscript(item.title || 'Untitled meeting', transcript);
  const resultS3Key = `users/${item.owner_user_id}/moms/${id}/processed/result.json`;
  const reportS3Key = `users/${item.owner_user_id}/moms/${id}/processed/report.pdf`;
  const pdfReport = await generateMomPdfReport(result, {
    projectTitle: item.project_title || 'General',
  });

  await saveFileContent(BUCKET_NAME, resultS3Key, JSON.stringify(result, null, 2));
  await saveFileContent(BUCKET_NAME, reportS3Key, pdfReport, 'application/pdf');
  await updateMom(id, 'COMPLETED', {
    result_s3_key: resultS3Key,
    report_s3_key: reportS3Key,
    title: result.title || item.title,
    meeting_date: result.date || 'Not specified',
    meeting_date_sort: parseMeetingDateToEpoch(result.date),
    error_message: null,
  });
}

async function analyzeTranscript(title: string, transcript: string) {
  const prompt = `
You are a senior delivery manager creating concise, executive-ready minutes of meeting.
Analyze the transcript for facts, commitments, risks, blockers, owners, dates, and final decisions.

Return valid JSON only. The JSON must exactly match this shape:
{
  "title": "string",
  "date": "YYYY-MM-DD or Not specified",
  "attendees": ["string"],
  "agenda_items": ["string"],
  "discussion_points": [
    {
      "topic": "string",
      "summary": "string",
      "decisions": ["string"],
      "action_items": [
        { "owner": "string", "task": "string", "due_date": "string" }
      ]
    }
  ],
  "risks": ["string"],
  "next_steps": ["string"],
  "overall_summary": "string"
}

Rules:
- Use the user-provided meeting title unless the transcript clearly gives a better title.
- Use the date when the meeting was held for "date". Return it as YYYY-MM-DD when it is clearly stated; use "Not specified" when the meeting date is unknown.
- Use "Not specified" when an owner, role, agenda item, or field is unknown.
- Do not invent facts, deadlines, owners, attendees, costs, decisions, tools, or platforms that are not supported by the transcript.
- Preserve important names, dates, products, cloud services, costs, environment names, and delivery commitments exactly when they are mentioned.
- Keep "overall_summary" to 3-5 crisp sentences that explain what happened, why it matters, and the current state.
- Keep "agenda_items" to the main 3-6 business topics.
- Keep "discussion_points" to 4-8 grouped themes. Avoid transcript-style narration.
- For each discussion point, write a short outcome-focused summary.
- Add only explicit decisions to "decisions"; if there are none, use an empty array.
- Keep action items concrete and outcome based. Assign "Unassigned" only when no owner is clear.
- Use "Not specified" for due_date unless a timeline or date is clearly stated.
- Put blockers, dependencies, uncertainties, escalations, compliance concerns, and delivery risks in "risks".
- Keep "next_steps" short, ordered, and practical. Do not repeat every action item.
- Put the final JSON inside <mom_json>...</mom_json>.

Meeting title provided by user: ${title}

Transcript:
${transcript.slice(0, 180000)}
`;

  const response = await bedrockClient.send(new InvokeModelCommand({
    modelId: MOM_MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 8000,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      temperature: 0,
    }),
  }));

  const payload = JSON.parse(new TextDecoder().decode(response.body));
  const text = payload.content?.[0]?.text || '';
  const tagged = text.match(/<mom_json>([\s\S]*?)<\/mom_json>/i)?.[1]?.trim();
  const jsonText = tagged || extractJson(text);
  if (!jsonText) throw new Error('AI_EMPTY_RESPONSE');

  const parsed = JSON.parse(jsonText);
  const validation = MomResultSchema.safeParse(parsed);
  if (!validation.success) {
    const reason = validation.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join(', ');
    throw new Error(`MOM_RESULT_VALIDATION_FAILED: ${reason}`);
  }

  return validation.data;
}

async function updateMom(id: string, status: string, extra: Record<string, any> = {}) {
  const names: Record<string, string> = { '#st': 'status' };
  const values: Record<string, any> = {
    ':status': status,
    ':now': Date.now(),
  };

  let updateExpression = 'SET #st = :status, updated_at = :now';
  for (const [key, value] of Object.entries(extra)) {
    const nameKey = `#${key}`;
    const valueKey = `:${key}`;
    names[nameKey] = key;
    values[valueKey] = value;
    updateExpression += `, ${nameKey} = ${valueKey}`;
  }

  await ddbDocClient.send(new UpdateCommand({
    TableName: MOM_TABLE_NAME,
    Key: { mom_id: id },
    UpdateExpression: updateExpression,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

function normalizeText(value: string): string {
  return value
    .replace(/\u0000/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseMeetingDateToEpoch(value: string | undefined): number | null {
  if (!value || value.trim().toLowerCase() === 'not specified') return null;

  const trimmed = value.trim();
  const isoMatch = trimmed.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return Date.UTC(Number(year), Number(month) - 1, Number(day));
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;
  const date = new Date(parsed);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}
