import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddbDocClient } from '../shared/aws.js';
import { keys, ScheduledInterview } from '../../schema/admin.js';

/**
 * Data-access for the ScheduledInterview entity (Part A). Kept out of index.ts
 * so the admin-table SCHED partition — which the Keka sweep writes and the
 * My Interviews routes read — has one home, and so index.ts (the intelligence
 * orchestrator) never imports the admin schema for anything but types. The
 * route handlers live in index.ts because opening a round provisions an
 * intelligence record; this module only touches the SCHED rows themselves.
 */

const ADMIN_TABLE_NAME = process.env.ADMIN_TABLE_NAME!;
const PROVISIONING_LEASE_MS = 16 * 60 * 1000;

/**
 * Every scheduled interview in a panelist's partition, already chronological.
 *
 * PK = SCHED#<email> makes this a single Query with no GSI and no Scan; the SK
 * pads scheduled_at, so ascending string order is ascending time order.
 * Cancelled rows are returned too — the UI shows "cancelled" rather than a
 * round silently vanishing.
 */
export async function queryScheduledForPanelist(email: string): Promise<ScheduledInterview[]> {
  const norm = String(email || '').trim().toLowerCase();
  if (!norm) return [];
  const res = await ddbDocClient.send(new QueryCommand({
    TableName: ADMIN_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': keys.schedPk(norm) },
    ScanIndexForward: true,
    ConsistentRead: true,
  }));
  return (res.Items || []) as ScheduledInterview[];
}

/**
 * The one row in the panelist's partition for a given Keka interview id.
 *
 * keka_interview_id is unique within a panelist partition (one row per panelist
 * per interview), so a linear find over the window is correct and cheap. The
 * row existing in the CALLER's partition is exactly the panel-membership proof
 * the open route relies on — a caller can only address interviews they are on.
 */
export async function findScheduledByInterviewId(
  email: string,
  kekaInterviewId: string,
): Promise<ScheduledInterview | undefined> {
  const rows = await queryScheduledForPanelist(email);
  return rows.find((r) => r.keka_interview_id === kekaInterviewId);
}

/**
 * Stamps provisioning identity onto a SCHED row, but only if it has not already
 * been provisioned. The `attribute_not_exists(intelligence_id)` condition is
 * the idempotency guard: under two racing opens exactly one write wins, and the
 * loser is told 'already' so it can return the winner's round instead of its
 * own. Returns 'stamped' on success, 'already' when a concurrent open won.
 */
export async function claimScheduledProvisioning(
  row: Pick<ScheduledInterview, 'PK' | 'SK'>,
  opts: { token: string; intelligenceId: string; provisionedBy: string },
): Promise<{ status: 'claimed'; intelligenceId: string } | { status: 'busy' }> {
  const now = Date.now();
  try {
    const result = await ddbDocClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE_NAME,
      Key: { PK: row.PK, SK: row.SK },
      UpdateExpression: [
        'SET provisioning_token = :token',
        'provisioning_expires_at = :expires',
        'provisioning_by = :by',
        'provisioning_intelligence_id = if_not_exists(provisioning_intelligence_id, :iid)',
      ].join(', '),
      ConditionExpression: [
        'attribute_not_exists(intelligence_id)',
        '(attribute_not_exists(provisioning_expires_at) OR provisioning_expires_at < :now)',
      ].join(' AND '),
      ExpressionAttributeValues: {
        ':token': opts.token,
        ':expires': now + PROVISIONING_LEASE_MS,
        ':by': opts.provisionedBy,
        ':iid': opts.intelligenceId,
        ':now': now,
      },
      ReturnValues: 'ALL_NEW',
    }));
    return {
      status: 'claimed',
      intelligenceId: String(result.Attributes?.provisioning_intelligence_id || opts.intelligenceId),
    };
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') return { status: 'busy' };
    throw err;
  }
}

export async function stampScheduledProvisioned(
  row: Pick<ScheduledInterview, 'PK' | 'SK'>,
  opts: { token: string; intelligenceId: string; workspaceId?: string; provisionedBy: string },
): Promise<'stamped' | 'already'> {
  // Build the SET clause dynamically: workspace_id is optional, and referencing
  // an undefined placeholder (stripped by removeUndefinedValues) would break the
  // expression.
  const sets = ['intelligence_id = :iid', 'provisioned_at = :pa', 'provisioned_by = :pb'];
  const values: Record<string, unknown> = {
    ':iid': opts.intelligenceId,
    ':pa': Date.now(),
    ':pb': opts.provisionedBy,
  };
  if (opts.workspaceId) {
    sets.push('workspace_id = :wid');
    values[':wid'] = opts.workspaceId;
  }

  try {
    await ddbDocClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE_NAME,
      Key: { PK: row.PK, SK: row.SK },
      UpdateExpression: 'SET ' + sets.join(', ') + ' REMOVE provisioning_token, provisioning_expires_at, provisioning_by, provisioning_intelligence_id',
      ConditionExpression: 'attribute_not_exists(intelligence_id) AND provisioning_token = :token',
      ExpressionAttributeValues: { ...values, ':token': opts.token },
    }));
    return 'stamped';
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') return 'already';
    throw err;
  }
}

export async function releaseScheduledProvisioning(
  row: Pick<ScheduledInterview, 'PK' | 'SK'>,
  token: string,
): Promise<void> {
  try {
    await ddbDocClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE_NAME,
      Key: { PK: row.PK, SK: row.SK },
      UpdateExpression: 'REMOVE provisioning_token, provisioning_expires_at, provisioning_by',
      ConditionExpression: 'provisioning_token = :token',
      ExpressionAttributeValues: { ':token': token },
    }));
  } catch (err: any) {
    if (err?.name !== 'ConditionalCheckFailedException') throw err;
  }
}
