import { SQSEvent } from 'aws-lambda';
import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import {
  bedrockClient,
  ddbDocClient,
  getFileBuffer,
  saveFileContent,
  validateEnv,
} from '../shared/aws';
import { extractTextFromBuffer } from '../shared/utils.js';
import { generateMomPdfReport } from '../shared/mom-report.js';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { MomOutputError, parseMomModelOutput } from './output-parser.js';

validateEnv(['MOM_TABLE_NAME', 'BUCKET_NAME', 'MOM_MODEL_ID']);

const MOM_TABLE_NAME = process.env.MOM_TABLE_NAME!;
const BUCKET_NAME = process.env.BUCKET_NAME!;
const MOM_MODEL_ID = process.env.MOM_MODEL_ID!;

function getUserFolder(item: any): string {
  const email = String(item?.owner_email || '').trim().toLowerCase();
  if (email) {
    const localPart = email.split('@')[0] || email;
    return localPart
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || item.owner_user_id || 'user';
  }
  return item.owner_user_id || 'user';
}

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
  // analysis_started_at is stamped once here and never rewritten, so the UI can
  // show a true elapsed time that survives a refresh (updated_at moves on every
  // progress write and would keep resetting the timer).
  const startedAt = Date.now();
  await updateMom(id, 'PROCESSING', {
    analysis_started_at: startedAt,
    progress_stage: 'reading_transcript',
    progress_message: 'Reading the meeting transcript...',
    // Start of a run: the log begins here rather than inheriting a previous
    // attempt's stages.
    progress_events: [{ at: startedAt, stage: 'reading_transcript', message: 'Reading the meeting transcript...' }],
  });

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

  await setMomProgress(id, 'extracting', 'AI is extracting decisions, action items, and owners. This is the longest step.');
  const result = await analyzeTranscript(item.title || 'Untitled meeting', transcript);
  const userFolder = getUserFolder(item);
  const resultS3Key = `users/${userFolder}/moms/${id}/processed/result.json`;
  const reportS3Key = `users/${userFolder}/moms/${id}/processed/report.pdf`;

  await setMomProgress(id, 'generating_report', 'Generating the meeting report PDF...');
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
    progress_stage: 'done',
    progress_message: 'Meeting report ready.',
    error_message: null,
  });
}

/**
 * Records the current phase for the UI progress banner. Best-effort: a failed
 * progress write must never fail the pipeline.
 */
async function setMomProgress(id: string, stage: string, message: string): Promise<void> {
  const now = Date.now();
  try {
    await ddbDocClient.send(new UpdateCommand({
      TableName: MOM_TABLE_NAME,
      Key: { mom_id: id },
      // progress_events is the history the UI renders as an activity log; the
      // stage pair above only ever holds the phase in flight. runMomPipeline
      // resets the list when it starts, so it stays bounded to one run.
      UpdateExpression: 'SET progress_stage = :s, progress_message = :m, updated_at = :now, '
        + 'progress_events = list_append(if_not_exists(progress_events, :empty), :event)',
      ExpressionAttributeValues: {
        ':s': stage,
        ':m': message,
        ':now': now,
        ':empty': [],
        ':event': [{ at: now, stage, message }],
      },
    }));
  } catch (err) {
    console.warn(`Could not record MOM progress (${stage}) for ${id}:`, err);
  }
}

export async function analyzeTranscript(title: string, transcript: string) {
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
- Use the user-provided meeting title. Do not replace it with a model-generated title.
- Use the date the meeting was held. Return YYYY-MM-DD if clearly stated. Return "Not specified" if the date cannot be determined from the transcript. Do not use today's date.
- If no reference number is mentioned, generate "MOM-001".
- Infer report_type from the meeting content, such as "Technical Working Session", "Governance Review", "Sprint Planning", "Client Review", "Architecture Discussion", "HR Review", or "Sales Call". Default to "Working Session".
- Extract platform, duration, workstream, facilitator, and scribe only from transcript context. Use "Not specified" when unclear.
- Use "All Attendees" for distribution unless additional recipients are explicitly mentioned.
- Use the meeting date for issued_date unless a different issued date is explicitly mentioned.
- Write a concise executive-ready overall_summary using only supported purpose, decisions, conclusions, open risks, questions, and next steps. Do not add content merely to reach a target length.
- List every person who spoke or was explicitly present. Attendees must be objects, never plain strings.
- For attendee role, use an explicitly stated role when available. Otherwise, infer a broad functional meeting role only when repeated responsibilities or multiple independent transcript cues support it, such as facilitation, project coordination, technical implementation, or content ownership.
- Do not infer seniority, HR grade, or an official job title from meeting behavior. Use "Participant" when the evidence is weak or ambiguous, and never assign a role from one isolated remark.
- For attendee organisation, use the company/team when mentioned. If not mentioned, use the project name if clear, otherwise use "-".
- Include only agenda_items that were actually discussed or explicitly listed in the transcript. Use [] when none are supported.
- Group only transcript-supported discussion_points into logical themes. Do not split, pad, or add themes to reach a target count. Use [] when the transcript contains no supported discussion points.
- Keep each discussion summary concise and outcome-focused, but do not add conclusions or implications that were not expressed in the transcript.
- Include raised_by only when the transcript supports it.
- Decisions must be objects and must include only confirmed decisions, not opinions. Use [] when none exist.
- Include an action item only when the transcript contains an explicit commitment, assignment, request for follow-up, or agreed task. Do not convert suggestions, observations, risks, or open questions into action items.
- Action items must be concrete and outcome-based. Copy the owner and due date only when supported; otherwise use "Unassigned" and "TBD". Use [] when no actions were agreed.
- Preserve whether work is already completed, in progress, or still planned. Do not turn completed work into a new action item; when a completed step has an explicit remaining follow-up, include only that remaining step.
- Set action priority from explicit urgency, blocking, critical-path, or deadline language in the transcript. Do not raise priority based on assumptions.
- Risks must be objects and must be supported by an explicitly discussed blocker, dependency, uncertainty, feasibility concern, approval dependency, escalation, compliance concern, or delivery risk. Do not invent anticipated risks. Use [] when none were discussed.
- Every risk description must begin with a category prefix, for example "Timeline Risk: ...", "Technical Risk: ...", or "Access Risk: ...".
- Risk category must be one of Timeline, Technical, Delivery, Dependency, Access, Compliance, Commercial, or Resource.
- Use likelihood H/M/L and impact H/M/L based on transcript language, without adding unstated consequences.
- Use "To be determined" for mitigation if no mitigation was discussed.
- Include only next_steps that were explicitly planned, requested, assigned, or committed to in the transcript. Use [] when no explicit next steps or follow-up commitments were discussed.
- Include next_meeting only if a follow-up meeting was explicitly discussed or scheduled. Otherwise omit the entire field.
- previous_actions should be [] unless the transcript includes review of actions from a previous meeting.
- Do not invent facts, deadlines, owners, attendees, costs, decisions, tools, or platforms that are not supported by the transcript.
- Preserve important names, dates, products, cloud services, costs, environment names, and delivery commitments exactly when they are mentioned.
- Do not narrate the conversation. Write outcomes and conclusions.
- Keep every field concise and avoid repeating the same point across sections. Prefer a complete, valid JSON document over additional prose.
- Put the final JSON inside <mom_json>...</mom_json>. Do not include markdown or commentary outside the tags.

Meeting title provided by user: ${title}

<meeting_transcript>
${transcript.slice(0, 180000)}
</meeting_transcript>
`;

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const retryInstruction = attempt === 1
      ? ''
      : `This is automatic retry ${attempt} of ${maxAttempts}. The previous response could not be parsed or validated. Return a complete JSON document matching the requested shape exactly.\n\n`;
    const body: Record<string, unknown> = {
      anthropic_version: 'bedrock-2023-05-31',
      // Rich MOMs can contain several structured sections. Sonnet needs
      // enough output budget to close the JSON document cleanly.
      max_tokens: 24000,
      messages: [{ role: 'user', content: [{ type: 'text', text: retryInstruction + prompt }] }],
    };
    if (!MOM_MODEL_ID.includes('claude-sonnet-5')) {
      body.temperature = 0;
    }

    const response = await bedrockClient.send(new InvokeModelCommand({
      modelId: MOM_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(body),
    }));
    const payload = JSON.parse(new TextDecoder().decode(response.body));

    try {
      const parsed = parseMomModelOutput(payload);
      if (parsed.repaired) {
        console.warn('MOM model JSON required deterministic repair', { attempt });
      }
      return parsed.value;
    } catch (error) {
      if (!(error instanceof MomOutputError)) throw error;
      console.warn('MOM model output rejected', {
        attempt,
        maxAttempts,
        kind: error.kind,
        ...error.diagnostics,
      });
      if (attempt === maxAttempts) {
        throw new Error('The AI response could not be validated after 3 automatic attempts. Please retry.');
      }
    }
  }

  throw new Error('The AI response could not be validated after 3 automatic attempts. Please retry.');
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
