import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand } from '@aws-sdk/client-s3';

import { ddbDocClient, s3Client } from '../lambdas/shared/aws';
import { loadEntityContext } from '../lambdas/chat/context';
import { CONTEXT_CHAR_BUDGET } from '../lambdas/chat/context/shared';
import { buildIntelligenceContext, buildInterviewContext, loadInterviewEvaluation } from '../lambdas/chat/context/evaluation';
import type { ChatApp } from '../schema/chat';
import type { DetailedEvaluationResult, InterviewRecord } from '../schema';
import type { InterviewIntelligenceRecord } from '../lambdas/api-handler/intelligence-integrations';

/**
 * The four context loaders — what the chat is allowed to know about an artifact, and what
 * it is told when there is nothing to know.
 *
 * Three properties here have already cost debugging time once and are asserted directly
 * rather than inferred:
 *
 *  1. The failure reasons are distinct. All four loaders used to answer a bare `null` for
 *     "no such record", "somebody else's record" and "nothing to talk about yet", which
 *     chat/index.ts turned into one sentence that was wrong about the reader's own records.
 *  2. The transcript reaches the context. Both interview builders used to state only
 *     `Transcript available: yes|no`, which is not something a question can be answered
 *     from.
 *  3. The transcript is what the clamp trims. It sits last in both `joinSections` arrays
 *     for exactly that reason, and a reordering that looked harmless would push the scores
 *     out of the window on any real interview.
 *
 * `lambdas/shared/transcript-excerpt.ts` is covered on its own in transcript-excerpt.test.ts;
 * nothing here re-tests the excerpting itself, only that an excerpt arrives and is marked.
 */

/**
 * The PDF/DOCX branch of `readTranscript` reaches its parser through a dynamic import, so
 * the parser is mocked rather than run: the point under test is that the extension decides
 * the path, not that pdf-parse works. A PDF decoded as UTF-8 is stream objects and font
 * tables, and the model would dutifully answer questions from them.
 */
const mockExtractTextFromBuffer = jest.fn();
jest.mock('../lambdas/shared/utils', () => ({
  extractTextFromBuffer: (buffer: Buffer, key: string) => mockExtractTextFromBuffer(buffer, key),
}));

const ddbMock = mockClient(ddbDocClient);
const s3Mock = mockClient(s3Client);

const CALCULATOR_TABLE = 'test-calculations';
const MOM_TABLE = 'test-moms';
const INTERVIEWS_TABLE = 'test-interviews';
const INTELLIGENCE_TABLE = 'test-intelligence';

const OWNER = 'owner-7';
const STRANGER = 'reader-2';

const RESULT_KEY = 'users/owner-7/results/result.json';
const TRANSCRIPT_KEY = 'users/owner-7/interviews/ev-1/transcript.txt';

/** S3 objects this test exposes, keyed by object key. Anything else is a NoSuchKey. */
let objects: Record<string, string | Error> = {};

/** DynamoDB items this test exposes, keyed by table name. */
let items: Record<string, Record<string, unknown>> = {};

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  objects = {};
  items = {};
  mockExtractTextFromBuffer.mockReset();
  // Both loaders log the failures they swallow. Silenced rather than asserted on, except
  // where the log line is the only record of a distinction the return value drops.
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);

  ddbMock.on(GetCommand).callsFake((input) => {
    const item = items[input.TableName as string];
    return item ? { Item: item } : {};
  });
  s3Mock.on(GetObjectCommand).callsFake((input) => {
    const stored = objects[input.Key as string];
    if (stored === undefined) throw new Error(`NoSuchKey: ${input.Key}`);
    if (stored instanceof Error) throw stored;
    return {
      Body: {
        transformToString: async () => stored,
        transformToByteArray: async () => new TextEncoder().encode(stored),
      },
    };
  });
});

afterEach(() => jest.restoreAllMocks());

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const calculation = (overrides: Record<string, unknown> = {}) => ({
  calculation_id: 'calc-9',
  owner_user_id: OWNER,
  name: 'Template Project',
  status: 'COMPLETED',
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
  prompt: 'two web servers and a database',
  resources: [{ name: 'web-01', service: 'EC2', size: 'm5.large', quantity: 2 }],
  result: {
    currency: 'USD',
    monthlyTotal: 269.65,
    lineItems: [{ service: 'EC2', detail: 'm5.large', monthly: 140.16, workings: '730 hours at 0.192' }],
    environments: [],
    assumptions: [],
    warnings: [],
  },
  ...overrides,
});

const momResult = (overrides: Record<string, unknown> = {}) => ({
  title: 'Go-live readiness review',
  date: '17-08-2026',
  overall_summary: 'The team confirmed the remaining readiness actions.',
  attendees: [{ name: 'Priya', role: 'Platform lead' }],
  agenda_items: ['Go-live readiness'],
  discussion_points: [{
    topic: 'Cutover window',
    summary: 'Agreed a Saturday cutover.',
    decisions: [{ decision: 'Cut over on Saturday' }],
    action_items: [{ task: 'Book the window', owner: 'Priya', due_date: '20-08-2026', priority: 'High' }],
  }],
  risks: [{ description: 'DNS propagation delay', likelihood: 'M', impact: 'H' }],
  next_steps: ['Confirm the rollback plan'],
  previous_actions: [],
  ...overrides,
});

const mom = (overrides: Record<string, unknown> = {}) => ({
  mom_id: 'mom-3',
  owner_user_id: OWNER,
  title: 'Go-live readiness review',
  status: 'COMPLETED',
  created_at: 1_700_000_000_000,
  result_s3_key: RESULT_KEY,
  ...overrides,
});

const interview = (overrides: Record<string, unknown> = {}) => ({
  PK: 'INTERVIEW#ev-1',
  SK: 'METADATA',
  interview_id: 'ev-1',
  owner_user_id: OWNER,
  status: 'COMPLETED',
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
  metadata: { candidate_name: 'Asha Rao', position: 'Platform Engineer', interview_date: '2026-08-14' },
  overall_score: 6,
  recommendation: 'Maybe',
  ...overrides,
}) as unknown as InterviewRecord & { deleted_at?: number };

const intelligence = (overrides: Record<string, unknown> = {}) => ({
  intelligence_id: 'i-1',
  owner_user_id: OWNER,
  status: 'analysis_complete',
  created_at: 1_700_000_000_000,
  candidate: { name: 'Asha Rao' },
  job: { title: 'Platform Engineer', requiredSkills: ['Kubernetes'] },
  aiEvaluation: {
    candidateEvaluation: {
      candidateScore: 7,
      candidateScoreReason: 'Deep migration experience, thin on cost governance.',
      recommendation: 'Hire',
      jdCoveragePercent: 82,
      strengths: ['Owned node pool sizing'],
      concerns: ['Limited cost governance exposure'],
      skillScores: [{ skill: 'Kubernetes', score: 8, evidence: 'Described a 1500-VM migration' }],
    },
    coverageMatrix: [{ jdSkill: 'Kubernetes', covered: 'yes', evidence: 'Discussed node pools' }],
  },
  ...overrides,
}) as unknown as InterviewIntelligenceRecord & { deleted_at?: number };

const evaluationResult = (overrides: Record<string, unknown> = {}) => ({
  overall_score: 8.5,
  recommendation: 'Hire',
  confidence: 80,
  coverage_percent: 75,
  dimension_breakdown: [{
    dimension: 'System design',
    score: 8,
    reason: 'Explained the migration in depth',
    evidence_found: true,
  }],
  strengths: ['Owned node pool sizing'],
  areas_for_review: ['Limited exposure to cost governance'],
  evidence_items: [{ quote: 'we moved 1500 VMs', context: 'migration', dimension: 'System design' }],
  executive_summary: 'A strong platform engineer with migration experience.',
  final_recommendation_note: 'Proceed to the architecture round.',
  ...overrides,
}) as unknown as DetailedEvaluationResult;

/** A multi-line transcript, long enough to matter and cheap to locate in a block. */
function transcriptLines(count: number, last = 'Interviewer: thank you, that is everything from us today.'): string {
  const lines = ['Interviewer: good morning, I am Priya from the platform team.'];
  for (let index = 0; index < count; index += 1) {
    lines.push(`Candidate: on the migration I owned node pool sizing for workstream ${index}, across both regions.`);
  }
  lines.push(last);
  return lines.join('\n');
}

/** The value of one `label: value` line in a built context block. */
function contextLine(context: string, label: string): string | undefined {
  return context.split('\n').find((entry) => entry.startsWith(`${label}: `))?.slice(label.length + 2);
}

/** Section headings, in the order the block presents them. */
function headings(context: string): string[] {
  return [...context.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
}

/**
 * The four apps, their tables, and a record for each.
 *
 * Driven through `loadEntityContext` rather than the loaders directly, so the dispatch and
 * the per-loader rules are asserted by the same table: an app wired to the wrong loader
 * would read the wrong table and fail these outright.
 */
const APPS: Array<{ app: ChatApp; table: string; entityId: string; record: (owner: string) => Record<string, unknown> }> = [
  { app: 'calculator', table: CALCULATOR_TABLE, entityId: 'calc-9', record: (owner) => calculation({ owner_user_id: owner }) },
  { app: 'mom', table: MOM_TABLE, entityId: 'mom-3', record: (owner) => mom({ owner_user_id: owner }) },
  { app: 'interview', table: INTERVIEWS_TABLE, entityId: 'ev-1', record: (owner) => interview({ owner_user_id: owner }) as unknown as Record<string, unknown> },
  { app: 'intelligence', table: INTELLIGENCE_TABLE, entityId: 'i-1', record: (owner) => intelligence({ owner_user_id: owner }) as unknown as Record<string, unknown> },
];

describe('loadEntityContext reads the table that app lives in', () => {
  test.each(APPS)('$app', async ({ app, table, entityId, record }) => {
    items[table] = record(OWNER);
    objects[RESULT_KEY] = JSON.stringify(momResult());

    await loadEntityContext(app, entityId, OWNER);

    // The reason the dispatch is worth a test at all: three of these tables are keyed
    // `{ id }` and one is not, so a mis-wired app does not fail loudly, it fails with a
    // DynamoDB ValidationException a user sees as "could not be read just now".
    expect(ddbMock.commandCalls(GetCommand)[0].args[0].input.TableName).toBe(table);
  });
});

describe('not_found and not_owner are different answers', () => {
  test.each(APPS)('$app: no record at all is not_found', async ({ app, entityId }) => {
    const result = await loadEntityContext(app, entityId, OWNER);

    // These three reasons were one `null` until this session, which chat/index.ts rendered
    // as "not found, or has no result to talk about yet" — routinely wrong about the
    // reader's own records, and hiding nothing from a probe that the REST layer's own
    // 403/404 split does not already disclose.
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  test.each(APPS)('$app: a record owned by somebody else is not_owner', async ({ app, table, entityId, record }) => {
    items[table] = record(OWNER);

    const result = await loadEntityContext(app, entityId, STRANGER);

    expect(result).toEqual({ ok: false, reason: 'not_owner' });
    // Refused before any stored result or transcript is fetched, so no part of another
    // person's record is even loaded into the process, let alone into a context block.
    expect(s3Mock).not.toHaveReceivedCommand(GetObjectCommand);
  });

  test.each(APPS.filter(({ app }) => app !== 'calculator'))(
    '$app: a soft-deleted record is not_found even when it is somebody else’s',
    async ({ app, table, entityId, record }) => {
      items[table] = { ...record(OWNER), deleted_at: 1_700_000_500_000 };

      // Deletion is checked before ownership on purpose: a deleted record is gone for its
      // owner too, so "it is somebody else's" is not the fact worth reporting about it.
      // (The estimate table has no soft delete — a deleted estimate is deleted outright.)
      expect(await loadEntityContext(app, entityId, STRANGER)).toEqual({ ok: false, reason: 'not_found' });
      expect(await loadEntityContext(app, entityId, OWNER)).toEqual({ ok: false, reason: 'not_found' });
    },
  );
});

describe('no_result belongs to the minutes loader alone', () => {
  test('minutes whose processor has not finished are no_result, not not_found', async () => {
    items[MOM_TABLE] = mom({ result_s3_key: undefined, status: 'PROCESSING' });

    const result = await loadEntityContext('mom', 'mom-3', OWNER);

    // The case the merged message was most often wrong about: the owner is looking at the
    // record while being told it does not exist.
    expect(result).toEqual({ ok: false, reason: 'no_result' });
  });

  test('a stored result that no longer matches the schema is also no_result', async () => {
    items[MOM_TABLE] = mom();
    objects[RESULT_KEY] = JSON.stringify({ title: 'Go-live readiness review' });

    const result = await loadEntityContext('mom', 'mom-3', OWNER);

    // There is genuinely nothing to talk about, and calling it "not found" would send the
    // owner looking for a record sitting in front of them. The log line is where the
    // difference between a missing result and an unreadable one belongs.
    expect(result).toEqual({ ok: false, reason: 'no_result' });
  });

  test('an estimate that has not been priced yet is still worth a conversation', async () => {
    items[CALCULATOR_TABLE] = calculation({ result: undefined, status: 'PROCESSING' });

    const result = await loadEntityContext('calculator', 'calc-9', OWNER);

    // Deliberately not no_result: the inventory and the request are already there, and the
    // builder says "not priced yet" where the totals would be.
    expect(result.ok).toBe(true);
    expect(result.ok && contextLine(result.entity.context, 'Monthly total')).toBe('not priced yet');
  });

  test('an interview workspace with no analysis yet is still worth a conversation', async () => {
    items[INTELLIGENCE_TABLE] = intelligence({ aiEvaluation: undefined, status: 'draft' }) as unknown as Record<string, unknown>;

    const result = await loadEntityContext('intelligence', 'i-1', OWNER);

    // The role, the panel and the question plan all exist before anybody is interviewed.
    expect(result.ok).toBe(true);
    expect(result.ok && result.entity.context).toContain('Platform Engineer');
  });
});

describe('the interviews table is composite-keyed', () => {
  test('read by PK and SK, never by a bare interview_id', async () => {
    await loadInterviewEvaluation('ev-1', OWNER);

    // `{ interview_id }` type-checks against InterviewRecord and then fails at runtime with
    // a ValidationException — which is exactly what it did until this was corrected this
    // session. toEqual rather than toMatchObject so a stray extra key fails too.
    const [call] = ddbMock.commandCalls(GetCommand);
    expect(call.args[0].input.TableName).toBe(INTERVIEWS_TABLE);
    expect(call.args[0].input.Key).toEqual({ PK: 'INTERVIEW#ev-1', SK: 'METADATA' });
  });
});

describe('the transcript reaches the context', () => {
  test('an intelligence workspace puts its inline transcript in the block', async () => {
    items[INTELLIGENCE_TABLE] = intelligence({
      transcript: { rawText: 'Interviewer: walk me through the migration.\nCandidate: nine months, 1500 VMs.', source: 'manual' },
    }) as unknown as Record<string, unknown>;

    const result = await loadEntityContext('intelligence', 'i-1', OWNER);

    // "Transcript available: yes" was all this used to say, and a yes/no flag is not
    // something the model can answer "what did they say about Kubernetes" from.
    expect(result.ok && result.entity.context).toContain('Candidate: nine months, 1500 VMs.');
    expect(result.ok && contextLine(result.entity.context, 'Transcript available'))
      .toBe('yes (an excerpt is included below)');
  });

  test('a manual evaluation puts its S3 transcript in the block', async () => {
    items[INTERVIEWS_TABLE] = interview({ transcript_s3_key: TRANSCRIPT_KEY }) as unknown as Record<string, unknown>;
    objects[TRANSCRIPT_KEY] = 'Interviewer: what broke during the cutover?\nCandidate: DNS, for about ten minutes.';

    const result = await loadEntityContext('interview', 'ev-1', OWNER);

    expect(result.ok && result.entity.context).toContain('Candidate: DNS, for about ten minutes.');
    expect(result.ok && contextLine(result.entity.context, 'Transcript available'))
      .toBe('yes (an excerpt is included below)');
  });

  test.each([
    ['an intelligence workspace', async () => {
      items[INTELLIGENCE_TABLE] = intelligence({
        transcript: { rawText: transcriptLines(400), source: 'teams_transcript' },
      }) as unknown as Record<string, unknown>;
      return loadEntityContext('intelligence', 'i-1', OWNER);
    }],
    ['a manual evaluation', async () => {
      items[INTERVIEWS_TABLE] = interview({ transcript_s3_key: TRANSCRIPT_KEY }) as unknown as Record<string, unknown>;
      objects[TRANSCRIPT_KEY] = transcriptLines(400);
      return loadEntityContext('interview', 'ev-1', OWNER);
    }],
  ])('%s over the excerpt budget says how much was cut', async (_label, load) => {
    const result = await load();

    // A truncated block that reads as a complete one is the failure mode this repo already
    // guards for bounded tables: the model treats what it was given as the whole interview
    // and answers confidently about the part it never saw.
    expect(result.ok && result.entity.context).toMatch(/\.\.\. \d+ characters omitted from the middle \.\.\./);
    expect(result.ok && result.entity.context).toContain('Interviewer: thank you, that is everything from us today.');
  });
});

describe('readTranscript never throws', () => {
  test('an unreadable object costs the excerpt, not the context', async () => {
    items[INTERVIEWS_TABLE] = interview({ transcript_s3_key: TRANSCRIPT_KEY }) as unknown as Record<string, unknown>;
    objects[TRANSCRIPT_KEY] = new Error('AccessDenied');

    const result = await loadInterviewEvaluation('ev-1', OWNER);

    // "There is no transcript" and "there is one and this Lambda could not read it" are
    // different facts about the record. Reporting the second as the first tells an owner
    // their upload never arrived.
    expect(result.ok).toBe(true);
    expect(result.ok && contextLine(result.entity.context, 'Transcript available'))
      .toBe('yes, but this assistant could not read it');
  });

  test('a record with no transcript key says so plainly', async () => {
    items[INTERVIEWS_TABLE] = interview({ transcript_s3_key: undefined }) as unknown as Record<string, unknown>;

    const result = await loadInterviewEvaluation('ev-1', OWNER);

    expect(result.ok && contextLine(result.entity.context, 'Transcript available')).toBe('no');
  });

  test('an object that exists but holds nothing usable is absent, not unreadable', async () => {
    items[INTERVIEWS_TABLE] = interview({ transcript_s3_key: TRANSCRIPT_KEY }) as unknown as Record<string, unknown>;
    objects[TRANSCRIPT_KEY] = '   \n\n \t ';

    const result = await loadInterviewEvaluation('ev-1', OWNER);

    // "Could not be read" would invite the owner to retry something that will fail
    // identically.
    expect(result.ok && contextLine(result.entity.context, 'Transcript available')).toBe('no');
  });

  test('a .pdf key is parsed as bytes, not decoded as text', async () => {
    const pdfKey = 'users/owner-7/interviews/ev-1/transcript.pdf';
    items[INTERVIEWS_TABLE] = interview({ transcript_s3_key: pdfKey }) as unknown as Record<string, unknown>;
    objects[pdfKey] = '%PDF-1.7 binary-ish bytes';
    mockExtractTextFromBuffer.mockResolvedValue('Interviewer: extracted from the PDF.\nCandidate: yes.');

    const result = await loadInterviewEvaluation('ev-1', OWNER);

    // The distinction is not pedantry: UTF-8 decoding a PDF yields stream objects and font
    // tables, and the model would answer questions from them without hesitating.
    expect(mockExtractTextFromBuffer).toHaveBeenCalledWith(expect.any(Buffer), pdfKey);
    expect(result.ok && result.entity.context).toContain('Interviewer: extracted from the PDF.');
  });

  test('a parser that throws on a .docx is unreadable rather than fatal', async () => {
    const docxKey = 'users/owner-7/interviews/ev-1/transcript.docx';
    items[INTERVIEWS_TABLE] = interview({ transcript_s3_key: docxKey }) as unknown as Record<string, unknown>;
    objects[docxKey] = 'not really a docx';
    mockExtractTextFromBuffer.mockRejectedValue(new Error('corrupt zip container'));

    const result = await loadInterviewEvaluation('ev-1', OWNER);

    // A transcript that cannot be read costs the turn a sentence, not the whole answer.
    expect(result.ok).toBe(true);
    expect(result.ok && contextLine(result.entity.context, 'Transcript available'))
      .toBe('yes, but this assistant could not read it');
  });
});

describe('loadStoredResult deliberately does not swallow failures', () => {
  test('an unreadable result object propagates', async () => {
    items[INTERVIEWS_TABLE] = interview({ result_s3_key: RESULT_KEY }) as unknown as Record<string, unknown>;
    objects[RESULT_KEY] = new Error('AccessDenied');

    // The opposite choice to readTranscript, and deliberately so: a context block that
    // quietly shows no scores makes the assistant answer confidently from nothing, which
    // is worse than the handler saying the record could not be read just now.
    await expect(loadInterviewEvaluation('ev-1', OWNER)).rejects.toThrow('AccessDenied');
  });

  test('a result object that is not JSON propagates too', async () => {
    items[INTERVIEWS_TABLE] = interview({ result_s3_key: RESULT_KEY }) as unknown as Record<string, unknown>;
    objects[RESULT_KEY] = '<!DOCTYPE html><html>upstream error page</html>';

    await expect(loadInterviewEvaluation('ev-1', OWNER)).rejects.toThrow();
  });

  test('a result that parses but fails validation falls back to the record’s own scores', async () => {
    items[INTERVIEWS_TABLE] = interview({ result_s3_key: RESULT_KEY }) as unknown as Record<string, unknown>;
    objects[RESULT_KEY] = JSON.stringify({ overall_score: 'eight point five' });

    const result = await loadInterviewEvaluation('ev-1', OWNER);

    // Wrong shape is not the same as unreadable: the record carries denormalised scores of
    // its own, so the block is still worth building from those rather than failing the turn.
    expect(result.ok).toBe(true);
    expect(result.ok && contextLine(result.entity.context, 'Overall score')).toBe('6');
    expect(result.ok && contextLine(result.entity.context, 'Recommendation')).toBe('Maybe');
  });
});

describe('under budget pressure the transcript is what shrinks', () => {
  test('the manual evaluation keeps its scores and trims the transcript', () => {
    const context = buildInterviewContext(interview(), evaluationResult({
      // A completed evaluation approaches the budget before a transcript is added at all,
      // which is the situation the placement decision exists for: two dozen rated
      // dimensions, each carrying a paragraph of reasoning.
      dimension_breakdown: [
        ...evaluationResult().dimension_breakdown,
        ...Array.from({ length: 23 }, (_, index) => ({
          dimension: `Dimension ${index}`,
          score: 7,
          reason: 'The candidate covered this at length, with examples from the migration. '.repeat(9),
          evidence_found: true,
        })),
      ],
    }), {
      status: 'excerpt',
      text: transcriptLines(400),
    }).context;

    expect(context.length).toBeLessThanOrEqual(CONTEXT_CHAR_BUDGET);
    // This is the assertion that protects the placement decision. Move the transcript
    // section earlier in `joinSections` and the clamp decapitates the block instead:
    // a forty-minute interview would push the scores, the breakdown and the quoted
    // evidence out of the window, leaving the chat unable to state the very thing it is
    // asked for first.
    expect(contextLine(context, 'Overall score')).toBe('8.5');
    expect(contextLine(context, 'Recommendation')).toBe('Hire');
    expect(context).toContain('Explained the migration in depth');
    expect(context).toContain('we moved 1500 VMs');
    // The transcript is present but no longer whole, and says so.
    expect(context).toContain('Interviewer: good morning, I am Priya from the platform team.');
    expect(context).not.toContain('Interviewer: thank you, that is everything from us today.');
    expect(context).toContain('[Context truncated to fit the model window.');
  });

  test('the intelligence workspace keeps its assessment and trims the transcript', () => {
    const context = buildIntelligenceContext(intelligence({
      transcript: { rawText: transcriptLines(400), source: 'teams_transcript' },
      aiEvaluation: {
        candidateEvaluation: {
          candidateScore: 7,
          jdCoveragePercent: 82,
          recommendation: 'Hire',
          // A long summary is the realistic way this block approaches the budget on its
          // own, before a transcript is added at all.
          summary: 'y'.repeat(18_000),
        },
        coverageMatrix: [{ jdSkill: 'Kubernetes', covered: 'yes', evidence: 'Discussed node pools' }],
      },
    })).context;

    expect(context.length).toBeLessThanOrEqual(CONTEXT_CHAR_BUDGET);
    expect(contextLine(context, 'Candidate score')).toBe('7');
    expect(contextLine(context, 'JD coverage')).toBe('82');
    expect(context).toContain('Interviewer: good morning, I am Priya from the platform team.');
    expect(context).not.toContain('Interviewer: thank you, that is everything from us today.');
    expect(context).toContain('[Context truncated to fit the model window.');
  });

  test.each([
    ['the manual evaluation', () => buildInterviewContext(interview(), evaluationResult(), {
      status: 'excerpt',
      text: 'Interviewer: short and complete.\nCandidate: agreed.',
    }).context],
    ['the intelligence workspace', () => buildIntelligenceContext(intelligence({
      transcript: { rawText: 'Interviewer: short and complete.\nCandidate: agreed.', source: 'manual' },
    })).context],
  ])('%s puts the transcript section last, which is what makes the trim safe', (_label, build) => {
    const context = build();

    // The structural fact the two tests above depend on, asserted directly so a reordering
    // fails here rather than only on a record long enough to hit the clamp.
    expect(headings(context).slice(-1)[0]).toMatch(/^Interview transcript/);
    expect(context).not.toContain('[Context truncated to fit the model window.');
  });
});

describe('read-only by design', () => {
  test.each([
    ['calculator', 'calc-9', CALCULATOR_TABLE, true],
    ['mom', 'mom-3', MOM_TABLE, true],
    ['interview', 'ev-1', INTERVIEWS_TABLE, false],
    ['intelligence', 'i-1', INTELLIGENCE_TABLE, false],
  ] as const)('%s exposes a change tool: %s', async (app, entityId, table, editable) => {
    items[table] = APPS.find((entry) => entry.app === app)!.record(OWNER);
    objects[RESULT_KEY] = JSON.stringify(momResult());

    const result = await loadEntityContext(app, entityId, OWNER);

    // A score is a judgement made at a point in time against a rubric. A conversation that
    // could rewrite it would make the record unciteable — "the chat and I agreed to raise
    // it" is not an audit trail — so both evaluation flavours are read-only.
    expect(result.ok).toBe(true);
    expect(result.ok && result.entity.editable).toBe(editable);
  });
});
