import { DeleteCommand, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { ddbDocClient } from '../shared/aws.js';
import { errorResponse, successResponse } from '../shared/responses.js';
import {
  DEFAULT_ORG_ID,
  keys,
  ScheduledInterview,
  SyncState,
} from '../../schema/admin.js';
import {
  createKekaIntegration,
  KekaCandidate,
  KekaJob,
  KekaScheduledInterview,
} from './intelligence-integrations.js';

const ADMIN_TABLE_NAME = process.env.ADMIN_TABLE_NAME!;
const SCHED_GSI1_PK = 'SCHED_ROW';
const KEKA_SYNC_SOURCE = 'keka';
const DAY_MS = 24 * 60 * 60 * 1000;
// The API handler Lambda has a 15-minute maximum runtime. The extra minute
// keeps a live invocation covered while ensuring a timed-out run unlocks soon.
const SYNC_LEASE_DURATION_MS = 16 * 60 * 1000;

type SyncLeaseState = SyncState & {
  lease_owner?: string;
  lease_expires_at?: number;
};

type SyncCounters = {
  jobsTotal: number;
  jobsProcessed: number;
  candidatesScanned: number;
  candidatesActive: number;
  interviewsSeen: number;
  interviewsIndexed: number;
  rowsWritten: number;
  rowsCancelled: number;
  rowsSuperseded: number;
  /**
   * In-window interviews dropped because not one panel member had an email.
   *
   * A SCHED row is keyed by panelist email, so without one there is nowhere to
   * write it and the round can never appear in My Interviews. Counted rather than
   * silently skipped: when Keka Hire omits interviewer emails and the HRIS
   * employee lookup is not permitted, this number is the whole explanation for an
   * empty My Interviews page, and nothing else in the response would show it.
   */
  interviewsWithoutPanelEmail: number;
};

/**
 * The slice of time the sweep is authoritative for. Everything outside it is
 * none of this sweep's business — see stampVanishedRowsCancelled.
 */
type SyncWindow = { from: number; to: number };

/**
 * How far either side of now the sweep indexes, in days.
 *
 * Operator levers, not constants. The defaults (7 back, 30 forward) suit a live
 * schedule, but they also mean a round that happened last month is invisible to
 * My Interviews — which makes the feature untestable against the interviews a
 * tenant already has, and hides recently-completed rounds an interviewer may
 * still be writing up. Widening the lookback costs nothing per extra day: the
 * Keka calls are driven by job and candidate counts, and the window only decides
 * which of the interviews already fetched get a row.
 *
 * Clamped because both bounds have real failure modes: 0 lookback would hide an
 * interview that started an hour ago, and an unbounded lookback would index
 * years of history into every panelist's partition.
 */
const SYNC_LOOKBACK_DEFAULT_DAYS = 7;
const SYNC_LOOKAHEAD_DEFAULT_DAYS = 30;

function windowDays(name: string, fallback: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(raw)));
}

export function syncWindowDays(): { lookback: number; lookahead: number } {
  return {
    lookback: windowDays('KEKA_SYNC_LOOKBACK_DAYS', SYNC_LOOKBACK_DEFAULT_DAYS, 730),
    lookahead: windowDays('KEKA_SYNC_LOOKAHEAD_DAYS', SYNC_LOOKAHEAD_DEFAULT_DAYS, 365),
  };
}

/**
 * Which candidates the sweep walks.
 *
 * `filtered` (the default) trusts KEKA_INTERVIEW_ACTIVE_STATUSES, which keeps the
 * sweep to a few hundred Keka calls. `all` is the fallback documented in the
 * brief for a tenant whose candidate rows carry no usable status field: every
 * candidate is walked and the scheduling window does the filtering instead. That
 * costs jobs x candidates calls, so it should be paired with a longer
 * KEKA_SYNC_RATE_HOURS on the EventBridge rule.
 */
type StatusFilterMode = 'filtered' | 'all';

function normalizeStatus(value?: string): string {
  return String(value || '').trim().toLowerCase();
}

function activeStatuses(): Set<string> {
  return new Set(
    String(process.env.KEKA_INTERVIEW_ACTIVE_STATUSES || '')
      .split(',')
      .map(normalizeStatus)
      .filter(Boolean),
  );
}

function statusFilterMode(): StatusFilterMode {
  return normalizeStatus(process.env.KEKA_SYNC_STATUS_MODE) === 'all' ? 'all' : 'filtered';
}

function shouldIncludeCandidate(
  candidate: KekaCandidate,
  statuses: Set<string>,
  mode: StatusFilterMode,
): boolean {
  if (mode === 'all') return true;
  if (statuses.size === 0) return false;
  return statuses.has(normalizeStatus(candidate.status));
}

function parseInterviewTime(interview: KekaScheduledInterview): number | undefined {
  const value = String(interview.scheduledAt || '').trim();
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

function syncWindow(now: number): SyncWindow {
  // One helper for both the indexing decision and the cancellation sweep: if
  // those two disagreed, a row could be written by one run and immediately
  // cancelled by the next for being "outside the window".
  const { lookback, lookahead } = syncWindowDays();
  return { from: now - lookback * DAY_MS, to: now + lookahead * DAY_MS };
}

function scheduledInWindow(scheduledAt: number, bounds: SyncWindow): boolean {
  return scheduledAt >= bounds.from && scheduledAt <= bounds.to;
}

async function acquireSyncLease(leaseOwner: string): Promise<boolean> {
  const now = Date.now();
  try {
    await ddbDocClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE_NAME,
      Key: { PK: keys.syncPk(KEKA_SYNC_SOURCE), SK: keys.syncStateSk() },
      UpdateExpression: 'SET #entity_type = :entity_type, #source = :source, #lease_owner = :lease_owner, #lease_expires_at = :lease_expires_at',
      ConditionExpression: 'attribute_not_exists(#lease_expires_at) OR #lease_expires_at < :lease_now',
      ExpressionAttributeNames: {
        '#entity_type': 'entity_type',
        '#source': 'source',
        '#lease_owner': 'lease_owner',
        '#lease_expires_at': 'lease_expires_at',
      },
      ExpressionAttributeValues: {
        ':entity_type': 'SYNC_STATE',
        ':source': KEKA_SYNC_SOURCE,
        ':lease_owner': leaseOwner,
        ':lease_expires_at': now + SYNC_LEASE_DURATION_MS,
        ':lease_now': now,
      },
    }));
    return true;
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

async function getSyncState(): Promise<SyncLeaseState | undefined> {
  const res = await ddbDocClient.send(new GetCommand({
    TableName: ADMIN_TABLE_NAME,
    Key: { PK: keys.syncPk(KEKA_SYNC_SOURCE), SK: keys.syncStateSk() },
    ConsistentRead: true,
  }));
  return res.Item as SyncLeaseState | undefined;
}

async function updateSyncState(
  values: Partial<SyncState>,
  leaseOwner: string,
  releaseLease = false,
): Promise<void> {
  const sets: string[] = [
    '#entity_type = :entity_type',
    '#source = :source',
  ];
  const names: Record<string, string> = {
    '#entity_type': 'entity_type',
    '#source': 'source',
    '#lease_owner': 'lease_owner',
  };
  const exprValues: Record<string, unknown> = {
    ':entity_type': 'SYNC_STATE',
    ':source': KEKA_SYNC_SOURCE,
    ':lease_owner': leaseOwner,
  };

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const nameKey = `#${key}`;
    const valueKey = `:${key}`;
    names[nameKey] = key;
    exprValues[valueKey] = value;
    sets.push(`${nameKey} = ${valueKey}`);
  }

  const removes = releaseLease ? ['#lease_owner', '#lease_expires_at'] : [];
  if (releaseLease) names['#lease_expires_at'] = 'lease_expires_at';
  const removeExpression = removes.length ? ` REMOVE ${removes.join(', ')}` : '';

  await ddbDocClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE_NAME,
    Key: { PK: keys.syncPk(KEKA_SYNC_SOURCE), SK: keys.syncStateSk() },
    UpdateExpression: `SET ${sets.join(', ')}${removeExpression}`,
    ConditionExpression: '#lease_owner = :lease_owner',
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: exprValues,
  }));
}

/**
 * Every row already in this panelist's partition for one Keka interview.
 *
 * There should be exactly one — but SK embeds scheduled_at, so a RESCHEDULE
 * lands on a new row and leaves the old one behind. The partition is a single
 * interviewer's own schedule (tens of rows), so re-reading it per upsert is
 * cheap and needs no index.
 */
async function listPanelistRowsForInterview(
  panelistEmail: string,
  kekaInterviewId: string,
): Promise<ScheduledInterview[]> {
  const res = await ddbDocClient.send(new QueryCommand({
    TableName: ADMIN_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': keys.schedPk(panelistEmail) },
    ConsistentRead: true,
  }));
  return ((res.Items || []) as ScheduledInterview[])
    .filter((row) => row.keka_interview_id === kekaInterviewId);
}

async function upsertScheduledInterview(input: {
  job: KekaJob;
  candidate: KekaCandidate;
  interview: KekaScheduledInterview;
  panelistEmail: string;
  scheduledAt: number;
  syncRunId: string;
}): Promise<number> {
  const { job, candidate, interview, panelistEmail, scheduledAt, syncRunId } = input;
  const panel = (interview.panel || []).map((member, index) => ({
    interviewerId: member.interviewerId || `panel-${index + 1}`,
    name: member.name || `Interviewer ${index + 1}`,
    email: member.email,
    role: member.role,
    focusArea: member.focusArea,
  }));

  const names: Record<string, string> = {
    '#entity_type': 'entity_type',
    '#org_id': 'org_id',
    '#panelist_email': 'panelist_email',
    '#keka_interview_id': 'keka_interview_id',
    '#keka_job_id': 'keka_job_id',
    '#keka_candidate_id': 'keka_candidate_id',
    '#job_title': 'job_title',
    '#department': 'department',
    '#candidate_name': 'candidate_name',
    '#candidate_email': 'candidate_email',
    '#scheduled_at': 'scheduled_at',
    '#title': 'title',
    '#panel': 'panel',
    '#meeting_url': 'meeting_url',
    '#meeting_id': 'meeting_id',
    '#organizer_email': 'organizer_email',
    '#organizer_user_id': 'organizer_user_id',
    '#keka_status': 'keka_status',
    '#synced_at': 'synced_at',
    '#last_seen_sync_id': 'last_seen_sync_id',
    '#gsi1_pk': 'gsi1_pk',
    '#gsi1_sk': 'gsi1_sk',
    '#cancelled_at': 'cancelled_at',
  };
  const values: Record<string, unknown> = {};
  const sets: string[] = [];
  const removes = ['#cancelled_at'];

  const setValue = (nameKey: string, valueKey: string, value: unknown) => {
    if (value === undefined || value === '') {
      removes.push(nameKey);
      return;
    }
    values[valueKey] = value;
    sets.push(`${nameKey} = ${valueKey}`);
  };

  setValue('#entity_type', ':entity_type', 'SCHEDULED_INTERVIEW');
  setValue('#org_id', ':org_id', DEFAULT_ORG_ID);
  setValue('#panelist_email', ':panelist_email', panelistEmail);
  setValue('#keka_interview_id', ':keka_interview_id', interview.id);
  setValue('#keka_job_id', ':keka_job_id', job.id);
  setValue('#keka_candidate_id', ':keka_candidate_id', candidate.id);
  setValue('#job_title', ':job_title', job.title);
  setValue('#department', ':department', job.department);
  setValue('#candidate_name', ':candidate_name', candidate.name);
  setValue('#candidate_email', ':candidate_email', candidate.email);
  setValue('#scheduled_at', ':scheduled_at', scheduledAt);
  setValue('#title', ':title', interview.title);
  setValue('#panel', ':panel', panel);
  setValue('#meeting_url', ':meeting_url', interview.meetingUrl);
  setValue('#meeting_id', ':meeting_id', interview.meetingId);
  setValue('#organizer_email', ':organizer_email', interview.organizerEmail);
  setValue('#organizer_user_id', ':organizer_user_id', interview.organizerUserId);
  setValue('#keka_status', ':keka_status', interview.status || candidate.status);
  setValue('#synced_at', ':synced_at', Date.now());
  setValue('#last_seen_sync_id', ':last_seen_sync_id', syncRunId);
  setValue('#gsi1_pk', ':gsi1_pk', SCHED_GSI1_PK);
  setValue('#gsi1_sk', ':gsi1_sk', scheduledAt);

  // Reschedule carry-forward. Because SK embeds scheduled_at, a moved interview
  // is a NEW row: without this the interviewer would see a fresh, unprovisioned
  // round and opening it would create a SECOND intelligence record for the same
  // Keka interview. Provisioning identity moves to the new row, and the stale
  // rows are deleted after the write (they are the same round at a stale time,
  // not a cancellation — leaving them would show a phantom "cancelled" twin).
  const targetSk = keys.schedSk(scheduledAt, interview.id);
  const existingRows = await listPanelistRowsForInterview(panelistEmail, interview.id);
  const target = existingRows.find((row) => row.SK === targetSk);
  const superseded = existingRows.filter((row) => row.SK !== targetSk);
  const donor = superseded.find((row) => row.intelligence_id);
  const now = Date.now();
  const activeLeaseRows = existingRows.filter((row) => (
    Boolean(row.provisioning_token) && Number(row.provisioning_expires_at || 0) > now
  ));

  // A row being opened is temporarily immutable. Moving its lease to the new
  // schedule sort key would leave the opener finalizing the old row while the
  // new row remained unprovisioned. Mark the leased row as observed and let the
  // next sweep perform the reschedule after the bounded lease finishes.
  if (activeLeaseRows.length) {
    for (const leased of activeLeaseRows) {
      await ddbDocClient.send(new UpdateCommand({
        TableName: ADMIN_TABLE_NAME,
        Key: { PK: leased.PK, SK: leased.SK },
        UpdateExpression: 'SET last_seen_sync_id = :run, synced_at = :now',
        ConditionExpression: 'provisioning_token = :token AND provisioning_expires_at > :now',
        ExpressionAttributeValues: {
          ':run': syncRunId,
          ':now': now,
          ':token': leased.provisioning_token,
        },
      }));
    }
    return 0;
  }

  if (!target?.intelligence_id && donor?.intelligence_id) {
    const carry = (attr: string, value: unknown) => {
      if (value === undefined || value === '') return;
      names[`#${attr}`] = attr;
      values[`:${attr}`] = value;
      sets.push(`#${attr} = :${attr}`);
    };
    carry('intelligence_id', donor.intelligence_id);
    carry('workspace_id', donor.workspace_id);
    carry('provisioned_at', donor.provisioned_at);
    carry('provisioned_by', donor.provisioned_by);
  }

  await ddbDocClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE_NAME,
    Key: {
      PK: keys.schedPk(panelistEmail),
      SK: targetSk,
    },
    UpdateExpression: `SET ${sets.join(', ')} REMOVE ${Array.from(new Set(removes)).join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));

  let rowsSuperseded = 0;
  for (const stale of superseded) {
    await ddbDocClient.send(new DeleteCommand({
      TableName: ADMIN_TABLE_NAME,
      Key: { PK: stale.PK, SK: stale.SK },
    }));
    rowsSuperseded += 1;
  }

  return rowsSuperseded;
}

/**
 * Rows whose scheduled_at falls inside the sweep window.
 *
 * Scoped by a gsi1_sk range rather than reading the whole SCHED_ROW partition,
 * because the sweep is only authoritative for the window it walked: rows outside
 * it were never looked up in Keka this run, so their absence from the run proves
 * nothing. gsi1_sk is the NUMBER scheduled_at, so BETWEEN is exact.
 */
async function listScheduledRowsInWindow(bounds: SyncWindow): Promise<ScheduledInterview[]> {
  const rows: ScheduledInterview[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const page = await ddbDocClient.send(new QueryCommand({
      TableName: ADMIN_TABLE_NAME,
      IndexName: 'GSI1_OrgRecency',
      KeyConditionExpression: 'gsi1_pk = :pk AND gsi1_sk BETWEEN :from AND :to',
      ExpressionAttributeValues: {
        ':pk': SCHED_GSI1_PK,
        ':from': bounds.from,
        ':to': bounds.to,
      },
      ExclusiveStartKey: lastKey,
    }));
    rows.push(...((page.Items || []) as ScheduledInterview[]));
    lastKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);
  return rows;
}

/**
 * Marks interviews that vanished from Keka as cancelled — but only inside the
 * sweep window.
 *
 * A row the sweep did not touch is "gone from Keka" only if the sweep would have
 * seen it had it still existed. Interviews that simply AGE OUT past the window's
 * lower bound were never queried, so cancelling them would tell an interviewer
 * their completed round was cancelled and (for an unprovisioned round) lock it
 * out of being opened. Rows are stamped, never deleted, so nothing silently
 * vanishes from a page that is already open.
 */
async function stampVanishedRowsCancelled(syncRunId: string, bounds: SyncWindow): Promise<number> {
  const rows = await listScheduledRowsInWindow(bounds);
  const now = Date.now();
  let cancelled = 0;

  for (const row of rows) {
    if ((row as ScheduledInterview & { last_seen_sync_id?: string }).last_seen_sync_id === syncRunId) continue;
    if (row.cancelled_at) continue;
    // Defensive: a row whose scheduled_at disagrees with its index entry is not
    // this sweep's to judge.
    if (!scheduledInWindow(Number(row.scheduled_at), bounds)) continue;
    await ddbDocClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE_NAME,
      Key: { PK: row.PK, SK: row.SK },
      UpdateExpression: 'SET cancelled_at = :cancelled_at, synced_at = :synced_at',
      ExpressionAttributeValues: {
        ':cancelled_at': now,
        ':synced_at': now,
      },
    }));
    cancelled += 1;
  }

  return cancelled;
}

export async function runKekaScheduleSyncWorker(triggeredBy = 'internal'): Promise<APIGatewayProxyResult> {
  const leaseOwner = uuidv4();
  if (!await acquireSyncLease(leaseOwner)) {
    return successResponse({ status: 'SKIPPED', reason: 'LEASE_HELD' });
  }

  const mode = statusFilterMode();
  const statuses = activeStatuses();
  let counters: SyncCounters = {
    jobsTotal: 0,
    jobsProcessed: 0,
    candidatesScanned: 0,
    candidatesActive: 0,
    interviewsSeen: 0,
    interviewsIndexed: 0,
    rowsWritten: 0,
    rowsCancelled: 0,
    rowsSuperseded: 0,
    interviewsWithoutPanelEmail: 0,
  };
  let syncRunId: string | undefined;

  try {
    // Fail closed only in the default mode: with no status vocabulary the sweep
    // cannot tell an active pipeline candidate from a rejected one, and walking
    // every candidate is a jobs x candidates call fan-out that must be an explicit
    // operator decision (KEKA_SYNC_STATUS_MODE=all) rather than an accident.
    if (mode === 'filtered' && statuses.size === 0) {
      const message = 'Set KEKA_INTERVIEW_ACTIVE_STATUSES after running the Keka status probe, or set KEKA_SYNC_STATUS_MODE=all to sweep every candidate, before enabling schedule sync.';
      await updateSyncState({
        started_at: Date.now(),
        finished_at: Date.now(),
        cursor_job_index: 0,
        last_error: message,
        triggered_by: triggeredBy,
      }, leaseOwner, true);
      return errorResponse(409, 'KEKA_STATUS_VOCABULARY_REQUIRED', message);
    }

    const previous = await getSyncState();
    const startIndex = Math.max(0, previous?.cursor_job_index ?? 0);
    syncRunId = previous?.sync_run_id && startIndex > 0 ? previous.sync_run_id : uuidv4();
    await updateSyncState({
      started_at: previous?.started_at && startIndex > 0 ? previous.started_at : Date.now(),
      finished_at: undefined,
      cursor_job_index: startIndex,
      last_error: '',
      triggered_by: triggeredBy,
      sync_run_id: syncRunId,
    }, leaseOwner);

    const keka = createKekaIntegration('live');
    const jobs = await keka.listJobs();
    counters = { ...counters, jobsTotal: jobs.length };
    await updateSyncState({ jobs_total: jobs.length }, leaseOwner);

    const now = Date.now();
    const bounds = syncWindow(now);
    for (let jobIndex = startIndex; jobIndex < jobs.length; jobIndex += 1) {
      const job = jobs[jobIndex];
      const candidates = await keka.listCandidates(job.id);
      counters = {
        ...counters,
        candidatesScanned: counters.candidatesScanned + candidates.length,
      };

      for (const candidate of candidates) {
        if (!shouldIncludeCandidate(candidate, statuses, mode)) continue;
        counters = { ...counters, candidatesActive: counters.candidatesActive + 1 };

        const interviews = await keka.listInterviews(job.id, candidate.id);
        for (const interview of interviews) {
          counters = { ...counters, interviewsSeen: counters.interviewsSeen + 1 };
          const scheduledAt = parseInterviewTime(interview);
          if (!scheduledAt || !scheduledInWindow(scheduledAt, bounds)) continue;

          const panelistEmails = Array.from(new Set(
            (interview.panel || [])
              .map((member) => String(member.email || '').trim().toLowerCase())
              .filter(Boolean),
          ));
          if (!panelistEmails.length) {
            counters = {
              ...counters,
              interviewsWithoutPanelEmail: counters.interviewsWithoutPanelEmail + 1,
            };
            continue;
          }

          counters = { ...counters, interviewsIndexed: counters.interviewsIndexed + 1 };
          for (const panelistEmail of panelistEmails) {
            const rowsSuperseded = await upsertScheduledInterview({
              job,
              candidate,
              interview,
              panelistEmail,
              scheduledAt,
              syncRunId,
            });
            counters = {
              ...counters,
              rowsSuperseded: counters.rowsSuperseded + rowsSuperseded,
              rowsWritten: counters.rowsWritten + 1,
            };
          }
        }
      }

      counters = { ...counters, jobsProcessed: counters.jobsProcessed + 1 };
      await updateSyncState({
        cursor_job_index: jobIndex + 1,
        jobs_total: jobs.length,
        interviews_indexed: counters.interviewsIndexed,
        rows_written: counters.rowsWritten,
        last_error: '',
      }, leaseOwner);
    }

    counters = {
      ...counters,
      rowsCancelled: await stampVanishedRowsCancelled(syncRunId, bounds),
    };
    await updateSyncState({
      finished_at: Date.now(),
      cursor_job_index: 0,
      jobs_total: jobs.length,
      interviews_indexed: counters.interviewsIndexed,
      rows_written: counters.rowsWritten,
      // A permission gap is not a run failure — the sweep did everything it was
      // allowed to — but it must survive on the row so the admin page can show it
      // after the response is long gone.
      last_error: keka.panelEmailLookupError || '',
      sync_run_id: '',
    }, leaseOwner, true);

    // The window is reported back because it decides what the run could possibly
    // have found: "0 rows written" reads very differently once you can see the
    // sweep only looked 7 days back.
    const days = syncWindowDays();
    return successResponse({
      status: 'DONE',
      statusMode: mode,
      windowLookbackDays: days.lookback,
      windowLookaheadDays: days.lookahead,
      // Present only when the panel-email directory refused the lookup. Paired
      // with interviewsWithoutPanelEmail it turns an empty My Interviews page from
      // a mystery into a named permission to grant.
      panelEmailLookupError: keka.panelEmailLookupError,
      ...counters,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Keka schedule sync failed.';
    await updateSyncState({
      last_error: message,
      jobs_total: counters.jobsTotal,
      interviews_indexed: counters.interviewsIndexed,
      rows_written: counters.rowsWritten,
      triggered_by: triggeredBy,
      sync_run_id: syncRunId,
    }, leaseOwner, true);
    throw err;
  }
}
