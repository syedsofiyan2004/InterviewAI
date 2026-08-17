import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { ddbDocClient } from '../shared/aws';
import { AuditAction, AuditLogEntry, keys } from '../../schema/admin.js';

const ADMIN_TABLE_NAME = process.env.ADMIN_TABLE_NAME!;

export interface AuditInput {
  actorUserId: string;
  actorEmail?: string;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  targetOwnerUserId?: string;
  detail?: string;
  /** Injected in tests; defaults to Date.now() at call time in production. */
  now?: number;
}

function isoDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10); // yyyy-mm-dd
}

/**
 * Writes one AuditLogEntry and AWAITS it. This is intentionally NOT
 * fire-and-forget: every admin-tier read of another user's data, and every
 * grant/revoke/approve/reject/share, must be logged in the same request before
 * the data is returned. If the write throws, it propagates to the caller, which
 * turns into a 500 — an admin action with no audit trail must fail, not succeed
 * silently.
 *
 * Returns the stored entry so callers can assert on it in tests.
 */
export async function writeAuditLog(input: AuditInput): Promise<AuditLogEntry> {
  const ts = input.now ?? Date.now();
  const auditId = uuidv4();

  const entry: AuditLogEntry = {
    PK: keys.auditPk(isoDate(ts)),
    SK: keys.auditSk(ts, auditId),
    entity_type: 'AUDIT_LOG',
    audit_id: auditId,
    ts,
    actor_user_id: input.actorUserId,
    actor_email: input.actorEmail,
    action: input.action,
    target_type: input.targetType,
    target_id: input.targetId,
    target_owner_user_id: input.targetOwnerUserId,
    detail: input.detail,
    // GSI3: actor -> their actions, newest first.
    gsi3_pk: input.actorUserId,
    gsi3_sk: ts,
  };

  await ddbDocClient.send(new PutCommand({
    TableName: ADMIN_TABLE_NAME,
    Item: entry,
  }));

  return entry;
}
