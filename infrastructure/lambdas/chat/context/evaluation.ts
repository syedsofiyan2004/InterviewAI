import { GetCommand } from '@aws-sdk/lib-dynamodb';

import { ddbDocClient, getFileBuffer, getFileContent } from '../../shared/aws';
import { transcriptExcerpt } from '../../shared/transcript-excerpt';
import { DetailedEvaluationResultSchema, type DetailedEvaluationResult, type InterviewRecord } from '../../../schema';
import type { InterviewIntelligenceRecord } from '../../api-handler/intelligence-integrations';
import {
  boundedRows,
  clampContext,
  formatDate,
  joinSections,
  line,
  section,
  type EntityContext,
  type EntityContextResult,
} from './shared';

const TABLE_NAME = process.env.TABLE_NAME!;
const INTELLIGENCE_TABLE_NAME = process.env.INTELLIGENCE_TABLE_NAME!;
const BUCKET_NAME = process.env.BUCKET_NAME!;

/**
 * Candidate evaluations, in both flavours the platform has.
 *
 * Both are **read-only to the chat**, and that is a design decision rather than an
 * omission. A score is a record of a judgement made at a point in time against a
 * rubric; a conversation that could rewrite it would make the record unciteable, and
 * "the chat and I agreed to raise it" is not an audit trail. So this module builds
 * context and exposes no tool. Ask and it can be revisited — but not by default.
 *
 * Both flavours also put an excerpt of the transcript itself into the context. They used
 * to state only whether one existed, and the cost of that showed up the first time
 * somebody asked their assistant a question about how the interview was conducted — "this
 * is a past interview, so the questions were generated after it was recorded" — and got a
 * hedge back, because a yes/no flag is not something you can answer a question from. The
 * excerpt is bounded and marked as partial; see lambdas/shared/transcript-excerpt.ts for
 * why it is the two ends rather than the first few thousand characters.
 */

export interface LoadedEvaluation {
  title: string;
  context: string;
}

/**
 * What a builder knows about the transcript behind an evaluation.
 *
 * Three states rather than two, because "there is no transcript" and "there is one and
 * this Lambda could not read it" are different facts about the record, and reporting the
 * second as the first would have the model tell an owner their upload never arrived.
 */
export type TranscriptContext =
  | { status: 'absent' }
  | { status: 'unreadable' }
  | { status: 'excerpt'; text: string };

/**
 * Fetch a transcript from S3 and turn it into text.
 *
 * Transcripts are uploaded as .txt, .pdf or .docx — that is the content-type allowlist on
 * `UploadUrlSchema` — so the key's extension decides how the bytes become characters.
 * Plain text goes through `getFileContent` like every other stored string in this repo;
 * PDF and DOCX go through `extractTextFromBuffer`, which is the same path
 * lambdas/processor/index.ts uses to read this very object. The distinction is not
 * pedantry: a PDF decoded as UTF-8 is stream objects and font tables, and the model would
 * dutifully try to answer questions from them.
 *
 * The parser import is dynamic for the same reason the processor's is — pdf-parse and
 * mammoth are the heaviest things in the bundle, and this is a streaming endpoint whose
 * entire justification is time-to-first-token. Somebody chatting about a .txt transcript
 * should not pay to load a PDF parser.
 *
 * Never throws. A transcript that cannot be read must cost the turn a sentence, not the
 * whole answer, so every failure comes back as `unreadable` and is logged.
 */
async function readTranscript(key: string | undefined): Promise<TranscriptContext> {
  if (!key) return { status: 'absent' };
  try {
    const extension = key.split('.').pop()?.toLowerCase();
    let raw: string;
    if (extension === 'pdf' || extension === 'docx') {
      const { extractTextFromBuffer } = await import('../../shared/utils.js');
      raw = await extractTextFromBuffer(await getFileBuffer(BUCKET_NAME, key), key);
    } else {
      raw = await getFileContent(BUCKET_NAME, key);
    }
    const excerpt = transcriptExcerpt(raw);
    // An object that exists but holds nothing usable is `absent`, not `unreadable`: there
    // is no transcript to talk about either way, and "could not be read" would invite the
    // owner to retry something that will fail identically.
    return excerpt ? { status: 'excerpt', text: excerpt } : { status: 'absent' };
  } catch (error) {
    console.error(`[chat] could not read the transcript at ${key}:`, error);
    return { status: 'unreadable' };
  }
}

/** The one-line fact stated in the overview whether or not the excerpt section exists. */
function transcriptAvailability(transcript: TranscriptContext): string {
  if (transcript.status === 'excerpt') return 'yes (an excerpt is included below)';
  if (transcript.status === 'unreadable') return 'yes, but this assistant could not read it';
  return 'no';
}

/**
 * The transcript itself, headed so the model cannot mistake it for the whole thing.
 *
 * Returns '' for every state but `excerpt`, which keeps the section out of the block
 * entirely — the availability line above carries "no transcript", and an empty section
 * would only invite the model to describe silence.
 */
function transcriptSection(transcript: TranscriptContext): string {
  if (transcript.status !== 'excerpt') return '';
  return section('Interview transcript (an excerpt, not the whole transcript)', [
    'The opening and the closing are below; the middle is replaced by a line saying how many characters were cut. Quote it freely, but if the user asks about something that would sit in the cut middle, say that part is not in front of you rather than inferring it.',
    transcript.text,
  ]);
}

/**
 * The stored evaluation result, or undefined when there is not one to read yet.
 *
 * Unlike `readTranscript` this does not swallow its failures. An unreadable result object
 * on a record whose status says COMPLETED is a broken record rather than a missing
 * paragraph, and the handler's catch turning it into "could not be read just now" is a
 * truer answer than a context block that quietly shows no scores.
 */
async function loadStoredResult(key: string | undefined): Promise<DetailedEvaluationResult | undefined> {
  if (!key) return undefined;
  const parsed = DetailedEvaluationResultSchema.safeParse(
    JSON.parse(await getFileContent(BUCKET_NAME, key)),
  );
  return parsed.success ? parsed.data : undefined;
}

export async function loadInterviewEvaluation(entityId: string, userId: string): Promise<EntityContextResult> {
  const found = await ddbDocClient.send(new GetCommand({
    TableName: TABLE_NAME,
    // Composite key, unlike the other three artifact tables: this one holds several item
    // types per interview and the evaluation is the METADATA row. A bare
    // `{ interview_id }` type-checks against the record shape and then fails at runtime
    // with a ValidationException, which is what it did until this was corrected.
    Key: { PK: `INTERVIEW#${entityId}`, SK: 'METADATA' },
  }));
  const item = found.Item as (InterviewRecord & { deleted_at?: number }) | undefined;
  // Soft-deleted before ownership, and reported as `not_found`: a deleted evaluation is
  // gone for the person who owns it as much as for anybody else.
  if (!item || item.deleted_at) return { ok: false, reason: 'not_found' };
  if (item.owner_user_id !== userId) return { ok: false, reason: 'not_owner' };

  // Overlapped rather than queued. Both objects sit in the same bucket and neither read
  // depends on the other, so serialising them would add a round trip to the one number
  // this endpoint is judged on. The transcript is fetched even when there is no result
  // yet — an evaluation still being processed is mostly transcript, and that is exactly
  // when somebody asks the chat what is in it.
  const [result, transcript] = await Promise.all([
    loadStoredResult(item.result_s3_key),
    readTranscript(item.transcript_s3_key),
  ]);

  return { ok: true, entity: buildInterviewContext(item, result, transcript) };
}

export function buildInterviewContext(
  item: InterviewRecord & { deleted_at?: number },
  result: DetailedEvaluationResult | undefined,
  transcript: TranscriptContext = { status: 'absent' },
): EntityContext {
  const candidate = item.metadata?.candidate_name || 'Candidate';

  const overview = section('Evaluation', [
    line('Candidate', candidate),
    line('Position', item.metadata?.position),
    line('Interview date', formatDate(item.metadata?.interview_date)),
    line('Status', item.status),
    line('Transcript available', transcriptAvailability(transcript)),
    line('Overall score', result?.overall_score ?? item.overall_score),
    line('Recommendation', result?.recommendation ?? item.recommendation),
    line('Confidence', result?.confidence ?? item.confidence),
    line('JD coverage', result?.coverage_percent ?? item.coverage_percent),
    line('Technical depth', result?.technical_depth),
    line('JD fit score', result?.jd_fit_score),
    line('Experience level', result?.experience_level),
    line('Inferred role', item.inferred_role),
    line('Role mismatch flagged', item.is_mismatched ? item.alignment_reason || 'yes' : null),
    line('Failure', item.error_message),
  ]);

  const summary = section('Executive summary', [
    result?.executive_summary || null,
    result?.final_recommendation_note ? `Recommendation note: ${result.final_recommendation_note}` : null,
  ]);

  const dimensions = section('Dimension breakdown', [
    result?.dimension_breakdown?.length
      ? boundedRows(
        result.dimension_breakdown,
        entry => `- ${entry.dimension}: ${entry.score}/10 (${entry.evidence_found ? 'evidence found' : 'no evidence'}) — ${entry.reason}`,
        24,
        'dimensions',
      )
      : null,
  ]);

  const strengths = section('Strengths', [
    result?.strengths?.length ? result.strengths.map(s => `- ${s}`).join('\n') : null,
  ]);

  const concerns = section('Areas for review', [
    result?.areas_for_review?.length ? result.areas_for_review.map(s => `- ${s}`).join('\n') : null,
  ]);

  const evidence = section('Evidence quoted from the transcript', [
    result?.evidence_items?.length
      ? boundedRows(
        result.evidence_items,
        entry => `- [${entry.dimension}] "${entry.quote}" (${entry.context})`,
        16,
        'evidence items',
      )
      : null,
  ]);

  const fitGap = section('Fit and gap against the JD', [
    result?.fit_gap_analysis?.length
      ? boundedRows(
        result.fit_gap_analysis,
        entry => `- ${entry.requirement}: ${entry.fit} — ${entry.evidence}`,
        16,
        'requirements',
      )
      : null,
  ]);

  const execution = section('How the interview itself was conducted', [
    result?.interview_execution?.summary || null,
    result?.interview_execution?.panel_assessment
      ? [
        `Panel score: ${result.interview_execution.panel_assessment.score}/10`,
        `Questions asked: ${result.interview_execution.panel_assessment.questions_asked_count}`,
        `Planned coverage: ${result.interview_execution.panel_assessment.planned_question_coverage_percent}%`,
        `Follow-up quality: ${result.interview_execution.panel_assessment.follow_up_quality}`,
      ].join('\n')
      : null,
  ]);

  return {
    title: `${candidate} — ${item.metadata?.position || 'evaluation'}`,
    editable: false,
    // The transcript goes last, and that placement is the point. `clampContext` cuts from
    // the end, so whichever block sits there is the one a long record loses — and of
    // everything here the transcript is both the largest and the most redundant, since the
    // executive summary, the dimension breakdown and the quoted evidence are all derived
    // from it. Put earlier, a forty-minute interview would push the scores out of the
    // window and the chat would be unable to state the very thing it is asked for first.
    context: clampContext(joinSections([
      overview,
      summary,
      dimensions,
      strengths,
      concerns,
      evidence,
      fitGap,
      execution,
      transcriptSection(transcript),
    ])),
  };
}

export async function loadIntelligenceEvaluation(entityId: string, userId: string): Promise<EntityContextResult> {
  const found = await ddbDocClient.send(new GetCommand({
    TableName: INTELLIGENCE_TABLE_NAME,
    Key: { intelligence_id: entityId },
  }));
  const item = found.Item as (InterviewIntelligenceRecord & { deleted_at?: number }) | undefined;
  if (!item || item.deleted_at) return { ok: false, reason: 'not_found' };
  if (item.owner_user_id !== userId) return { ok: false, reason: 'not_owner' };
  // No `no_result` case: a workspace is worth a conversation from the moment it exists —
  // the role, the panel and the question plan are all there before anybody is interviewed.
  return { ok: true, entity: buildIntelligenceContext(item) };
}

export function buildIntelligenceContext(item: InterviewIntelligenceRecord & { deleted_at?: number }): EntityContext {
  const evaluation = item.aiEvaluation;
  const candidateEvaluation = evaluation?.candidateEvaluation;

  // Held inline on the record rather than in S3, so no read can fail and there is no
  // `unreadable` state to represent here.
  const excerpt = transcriptExcerpt(item.transcript?.rawText);
  const transcript: TranscriptContext = excerpt ? { status: 'excerpt', text: excerpt } : { status: 'absent' };

  const overview = section('Interview workspace', [
    line('Candidate', item.candidate?.name),
    line('Role', item.job?.title),
    line('Seniority', item.job?.seniority),
    line('Status', item.status),
    line('Created', formatDate(item.created_at)),
    line('Source mode', item.source_mode),
    line('Panel', (item.panel || []).map(person => [person.name, person.role].filter(Boolean).join(' — ')).join('; ') || null),
    line('Required skills', (item.job?.requiredSkills || []).join(', ') || null),
    line('Competencies', (item.job?.competencies || []).map(entry => `${entry.name} (${entry.source})`).join(', ') || null),
    line('Focus areas chosen', (item.questionPlan?.selectedTopics || []).join(', ') || null),
    line('Transcript available', transcriptAvailability(transcript)),
    // How and when the transcript arrived, because it settles a question users ask
    // directly: a workspace created for an interview that already happened has a manual
    // transcript uploaded after the fact, and the model can only say so if it can see it.
    line('Transcript source', item.transcript?.source),
    line('Transcript added', item.transcript ? formatDate(item.transcript.uploadedAt) : null),
    line('Approved', item.approved ? 'yes' : 'no'),
  ]);

  const scores = section('Candidate assessment', [
    line('Candidate score', candidateEvaluation?.candidateScore),
    line('Score reason', candidateEvaluation?.candidateScoreReason),
    line('Recommendation', candidateEvaluation?.recommendation),
    line('Recommendation reason', candidateEvaluation?.recommendationReason),
    line('JD coverage', candidateEvaluation?.jdCoveragePercent),
    line('Evidence confidence', candidateEvaluation?.evidenceConfidence),
    line('Decision confidence', candidateEvaluation?.decisionConfidence),
    line('Next action', candidateEvaluation?.nextAction),
    line('Summary', candidateEvaluation?.summary),
  ]);

  const strengths = section('Strengths', [
    candidateEvaluation?.strengths?.length ? candidateEvaluation.strengths.map(s => `- ${s}`).join('\n') : null,
  ]);

  const concerns = section('Concerns', [
    candidateEvaluation?.concerns?.length ? candidateEvaluation.concerns.map(s => `- ${s}`).join('\n') : null,
  ]);

  const skillScores = section('Skill scores', [
    candidateEvaluation?.skillScores?.length
      ? boundedRows(
        candidateEvaluation.skillScores,
        entry => `- ${entry.skill}: ${entry.score} — ${entry.evidence}`,
        24,
        'skills',
      )
      : null,
  ]);

  const competencies = section('Competency ratings', [
    candidateEvaluation?.competencyRatings?.length
      ? boundedRows(
        candidateEvaluation.competencyRatings,
        entry => [
          `- ${entry.competency} (${entry.status}${entry.rating === null ? '' : `, ${entry.rating}`})`,
          entry.questionAsked ? `  asked: ${entry.questionAsked}` : '',
          entry.ratingJustification ? `  justification: ${entry.ratingJustification}` : '',
          entry.requiredFollowUp ? `  follow-up needed: ${entry.requiredFollowUp}` : '',
        ].filter(Boolean).join('\n'),
        16,
        'competencies',
      )
      : null,
  ]);

  const coverage = section('JD coverage matrix', [
    evaluation?.coverageMatrix?.length
      ? boundedRows(
        evaluation.coverageMatrix,
        entry => `- ${entry.jdSkill}: ${entry.covered}${entry.askedBy?.length ? ` (asked by ${entry.askedBy.join(', ')})` : ''} — ${entry.evidence}`,
        24,
        'JD skills',
      )
      : null,
  ]);

  const panel = section('Interviewer assessments', [
    evaluation?.interviewerEvaluations?.length
      ? boundedRows(
        evaluation.interviewerEvaluations,
        entry => [
          `- ${entry.name}: panel score ${entry.panelScore}, ${entry.questionsAskedCount} questions, ${entry.jdCoveragePercent}% JD coverage, follow-ups ${entry.followUpQuality}`,
          entry.observations?.length ? `  observations: ${entry.observations.join(' | ')}` : '',
          entry.missedAreas?.length ? `  missed: ${entry.missedAreas.join(' | ')}` : '',
        ].filter(Boolean).join('\n'),
        12,
        'interviewers',
      )
      : null,
    evaluation?.panelCalibration
      ? `Panel calibration: ${evaluation.panelCalibration.summary}${evaluation.panelCalibration.humanReviewRequired ? ' (human review required)' : ''}`
      : null,
  ]);

  return {
    title: `${item.candidate?.name || 'Candidate'} — ${item.job?.title || 'interview'}`,
    editable: false,
    // Last for the same reason as in the interview builder above: the clamp trims the end,
    // and the transcript is what this block can afford to lose. The candidate assessment
    // and the coverage matrix are not.
    context: clampContext(joinSections([
      overview,
      scores,
      strengths,
      concerns,
      skillScores,
      competencies,
      coverage,
      panel,
      transcriptSection(transcript),
    ])),
  };
}
