import { GetCommand } from '@aws-sdk/lib-dynamodb';

import { ddbDocClient, getFileContent } from '../../shared/aws';
import { MomResultSchema, type MomRecord, type MomResult } from '../../../schema/mom';
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

const MOM_TABLE_NAME = process.env.MOM_TABLE_NAME!;
const BUCKET_NAME = process.env.BUCKET_NAME!;

export interface LoadedMom {
  item: MomRecord;
  result: MomResult;
}

/**
 * Load minutes and their stored result, enforcing ownership.
 *
 * Owner-only, with no admin fallback: the REST read path grants VIEWER-tier admins
 * access to somebody else's minutes for audit purposes, but an admin holding a
 * *conversation* about another person's meeting — one that can then rewrite it — is a
 * different thing, and not one this feature was asked for. Narrower is the safe default.
 *
 * Three ways this can fail and they are reported apart, because they need different
 * answers from the user: a wrong id, somebody else's minutes, and minutes of their own
 * that the processor has not finished with. That last one is the case this module has
 * always had and the one the old single "not found" message was most often wrong about.
 */
export async function loadMom(entityId: string, userId: string): Promise<EntityContextResult> {
  const found = await ddbDocClient.send(new GetCommand({
    TableName: MOM_TABLE_NAME,
    Key: { mom_id: entityId },
  }));
  const item = found.Item as (MomRecord & { deleted_at?: number }) | undefined;
  // Soft-deleted minutes are `not_found` rather than `not_owner`, and the check comes
  // first for that reason: they are gone for their owner too, so ownership is not the
  // fact worth reporting about them.
  if (!item || item.deleted_at) return { ok: false, reason: 'not_found' };
  if (item.owner_user_id !== userId) return { ok: false, reason: 'not_owner' };
  if (!item.result_s3_key) return { ok: false, reason: 'no_result' };

  const parsed = MomResultSchema.safeParse(JSON.parse(await getFileContent(BUCKET_NAME, item.result_s3_key)));
  // A stored result that no longer matches the schema the builder reads is `no_result`
  // too. There is genuinely nothing to talk about, and calling it "not found" would send
  // the owner looking for a record that is sitting right in front of them; the log line
  // is where the difference between the two belongs.
  if (!parsed.success) {
    console.warn(`[chat] stored MOM result for ${entityId} failed validation:`, parsed.error.issues.map(i => i.path.join('.')).join(', '));
    return { ok: false, reason: 'no_result' };
  }
  return { ok: true, entity: buildMomContext({ item, result: parsed.data }) };
}

/**
 * What the chat knows about a set of minutes.
 *
 * Unlike the estimate, this is included close to whole: minutes are the size of a
 * meeting, not the size of a data centre, and the request the feature exists to serve —
 * "cut what the client does not need to see" — needs every sentence that might be cut.
 * The row bounds below are a guard against a pathological transcript, not the norm.
 */
export function buildMomContext(loaded: LoadedMom): EntityContext {
  const { item, result } = loaded;

  const decisions = result.discussion_points.flatMap(point => point.decisions);
  const actions = result.discussion_points.flatMap(point => point.action_items);

  const overview = section('Minutes', [
    line('Title', result.title || item.title),
    line('Project', item.project_title),
    // The stored meeting date is whatever the transcript said, so it is echoed as
    // written rather than reformatted — a string like "last Tuesday" must not become
    // an invented calendar date.
    line('Meeting date (as recorded)', result.date || item.meeting_date),
    line('Status', item.status),
    line('Created', formatDate(item.created_at)),
    line('Reference', result.reference_no),
    line('Report type', result.report_type),
    line('Platform', result.platform),
    line('Duration', result.duration),
    line('Workstream', result.workstream),
    line('Facilitator', result.facilitator),
    line('Scribe', result.scribe),
    line('Distribution', result.distribution),
    line('Source file', item.source_file_name),
  ]);

  const summary = section('Executive summary', [result.overall_summary || null]);

  const attendees = section('Attendees', [
    boundedRows(
      result.attendees,
      person => `- ${[person.name, person.role, person.organisation].filter(Boolean).join(' — ')}`,
      60,
      'attendees',
    ),
  ]);

  const agenda = section('Agenda items', [
    boundedRows(result.agenda_items, (topic, index) => `${index + 1}. ${topic}`, 40, 'agenda items'),
  ]);

  const discussion = section('Discussion points', [
    boundedRows(
      result.discussion_points,
      (point, index) => {
        const head = `${index + 1}. ${point.topic}${point.raised_by ? ` (raised by ${point.raised_by})` : ''}`;
        return `${head}\n   ${point.summary}`;
      },
      40,
      'discussion points',
    ),
  ]);

  const decisionBlock = section('Decisions made', [
    boundedRows(
      decisions,
      (decision, index) => [
        `DEC-${String(index + 1).padStart(3, '0')}: ${decision.decision}`,
        decision.rationale ? `   rationale: ${decision.rationale}` : '',
        decision.decided_by ? `   decided by: ${decision.decided_by}` : '',
      ].filter(Boolean).join('\n'),
      40,
      'decisions',
    ),
  ]);

  const actionBlock = section('Action items', [
    boundedRows(
      actions,
      (action, index) => `ACT-${String(index + 1).padStart(3, '0')}: ${action.task} | owner: ${action.owner} | due: ${action.due_date} | priority: ${action.priority}`,
      60,
      'action items',
    ),
  ]);

  const risks = section('Risks and blockers', [
    boundedRows(
      result.risks,
      (risk, index) => [
        `RSK-${String(index + 1).padStart(3, '0')}: ${risk.description}`,
        `   likelihood: ${risk.likelihood} | impact: ${risk.impact}${risk.owner ? ` | owner: ${risk.owner}` : ''}${risk.category ? ` | category: ${risk.category}` : ''}`,
        risk.mitigation ? `   mitigation: ${risk.mitigation}` : '',
      ].filter(Boolean).join('\n'),
      40,
      'risks',
    ),
  ]);

  const nextSteps = section('Next steps', [
    boundedRows(result.next_steps, (step, index) => `${index + 1}. ${step}`, 40, 'next steps'),
  ]);

  const nextMeeting = section('Next meeting', [
    line('Date', result.next_meeting?.date),
    line('Purpose', result.next_meeting?.purpose),
    line('Proposed agenda', result.next_meeting?.proposed_agenda),
    line('Preparation required', result.next_meeting?.prep_required),
  ]);

  const previous = section('Review of previous meeting actions', [
    result.previous_actions.length
      ? boundedRows(
        result.previous_actions,
        action => `- ${[action.ref, action.action, action.owner, action.status].filter(Boolean).join(' | ')}`,
        40,
        'previous actions',
      )
      : null,
  ]);

  return {
    title: result.title || item.title,
    editable: true,
    context: clampContext(joinSections([
      overview,
      summary,
      attendees,
      agenda,
      discussion,
      decisionBlock,
      actionBlock,
      risks,
      nextSteps,
      nextMeeting,
      previous,
    ])),
  };
}
