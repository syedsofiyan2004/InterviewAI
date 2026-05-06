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
You are a senior project manager producing a formal Minutes of Meeting document.
Your task is to analyze the meeting transcript provided and extract structured,
accurate information from it. You must not invent any names, dates, costs,
decisions, tools, platforms, or technical details that are not explicitly
supported by the transcript.

The output will be used to generate a professional PDF report for any type
of meeting - technical, governance, sales, HR, or operational. The structure
of the output is always the same regardless of meeting type.

Return ONLY valid JSON inside <mom_json>...</mom_json> tags.
The JSON must match this exact shape:

{
  "title": "string",
  "date": "YYYY-MM-DD or Not specified",
  "reference_no": "string",
  "report_type": "string",
  "platform": "string",
  "duration": "string",
  "workstream": "string",
  "facilitator": "string",
  "scribe": "string",
  "distribution": "string",
  "issued_date": "YYYY-MM-DD",
  "overall_summary": "string",
  "attendees": [
    {
      "name": "string",
      "role": "string",
      "organisation": "string"
    }
  ],
  "agenda_items": ["string"],
  "discussion_points": [
    {
      "topic": "string",
      "raised_by": "string",
      "summary": "string",
      "decisions": [
        {
          "decision": "string",
          "rationale": "string",
          "decided_by": "string"
        }
      ],
      "action_items": [
        {
          "owner": "string",
          "task": "string",
          "due_date": "string",
          "priority": "High | Medium | Low"
        }
      ]
    }
  ],
  "risks": [
    {
      "description": "string",
      "likelihood": "H | M | L",
      "impact": "H | M | L",
      "owner": "string",
      "mitigation": "string",
      "category": "string"
    }
  ],
  "next_steps": ["string"],
  "next_meeting": {
    "date": "string",
    "purpose": "string",
    "proposed_agenda": "string",
    "prep_required": "string"
  },
  "previous_actions": [
    {
      "ref": "string",
      "action": "string",
      "owner": "string",
      "status": "string"
    }
  ]
}

Field rules:
- Use the user-provided meeting title unless the transcript clearly gives a better title.
- Use the date the meeting was held. Return YYYY-MM-DD if clearly stated. Return "Not specified" if the date cannot be determined from the transcript. Do not use today's date.
- If no reference number is mentioned, generate "MOM-001".
- Infer report_type from the meeting content, such as "Technical Working Session", "Governance Review", "Sprint Planning", "Client Review", "Architecture Discussion", "HR Review", or "Sales Call". Default to "Working Session".
- Extract platform, duration, workstream, facilitator, and scribe only from transcript context. Use "Not specified" when unclear.
- Use "All Attendees" for distribution unless additional recipients are explicitly mentioned.
- Use the meeting date for issued_date unless a different issued date is explicitly mentioned.
- Write overall_summary in exactly 3-5 executive-ready sentences covering purpose, decisions/conclusions, open risks/questions, and next steps.
- List every person who spoke or was explicitly present. Attendees must be objects, never plain strings.
- For attendee role, infer from context when possible. If role is genuinely unclear, use a neutral functional label such as "Participant", "Stakeholder", or "Team Member". Never write "role not specified" or "Not specified" for role.
- For attendee organisation, use the company/team when mentioned. If not mentioned, use the project name if clear, otherwise use "-".
- List 3-6 agenda_items as clear topic statements.
- Group discussion_points into 5-9 logical themes or workstream areas. Each summary must be 2-5 sentences and outcome-focused.
- Include raised_by only when the transcript supports it.
- Decisions must be objects and must include only confirmed decisions, not opinions. Use [] when none exist.
- Action items must be concrete, outcome-based, and prioritized. Use "Unassigned" only when no owner is clear. Use "TBD" when the task is real but no due date is stated.
- Priority rules: High means blocking, critical path, or near deadline; Medium means important but not immediately blocking; Low means useful but deferrable.
- Risks must be objects. Include every blocker, dependency, uncertainty, feasibility concern, approval dependency, escalation, compliance concern, and delivery risk.
- Every risk description must begin with a category prefix, for example "Timeline Risk: ...", "Technical Risk: ...", or "Access Risk: ...".
- Risk category must be one of Timeline, Technical, Delivery, Dependency, Access, Compliance, Commercial, or Resource.
- Use likelihood H/M/L and impact H/M/L based on transcript language and project consequence.
- Use "To be determined" for mitigation if no mitigation was discussed.
- Write 4-8 next_steps as ordered, practical critical-path steps. Start each with the owner name when clear.
- Include next_meeting only if a follow-up meeting was explicitly discussed or scheduled. Otherwise omit the entire field.
- previous_actions should be [] unless the transcript includes review of actions from a previous meeting.
- Do not invent facts, deadlines, owners, attendees, costs, decisions, tools, or platforms that are not supported by the transcript.
- Preserve important names, dates, products, cloud services, costs, environment names, and delivery commitments exactly when they are mentioned.
- Do not narrate the conversation. Write outcomes and conclusions.
- Put the final JSON inside <mom_json>...</mom_json>. Do not include markdown or commentary outside the tags.

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
