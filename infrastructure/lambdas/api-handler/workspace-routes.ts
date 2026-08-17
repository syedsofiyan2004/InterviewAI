import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { v4 as uuidv4 } from 'uuid';
import { ddbDocClient } from '../shared/aws';
import { successResponse, createdResponse, errorResponse } from '../shared/responses';
import {
  getCallerContext,
  requireAdminTier,
  hasTier,
  getWorkspaceAccess,
  CallerContext,
} from './authz.js';
import { writeAuditLog } from './audit.js';
import {
  DEFAULT_ORG_ID,
  keys,
  SK_PREFIX,
  CreateWorkspaceSchema,
  UpdateWorkspaceSchema,
  AddShareSchema,
  CreateCommentSchema,
  LinkRecordSchema,
  DecisionSchema,
} from '../../schema/admin.js';

const ADMIN_TABLE_NAME = process.env.ADMIN_TABLE_NAME!;

function parseBody(event: APIGatewayProxyEvent): any {
  try {
    return JSON.parse(event.body || '{}');
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Workspace CRUD
// ---------------------------------------------------------------------------

/**
 * POST /workspaces — manual review-workspace creation, REVIEWER+ (Part E).
 *
 * Members never need this route: a workspace is created for them by
 * ensureCandidateWorkspace when they open a scheduled interview or complete an
 * evaluation, with the caller as owner. Hand-creating an empty workspace is an
 * admin act, so it carries the same tier as the other manual-creation paths.
 */
export async function createWorkspace(event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  if (!caller) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');
  const denied = requireAdminTier(caller, 'REVIEWER');
  if (denied) return denied;

  const parsed = CreateWorkspaceSchema.safeParse(parseBody(event));
  if (!parsed.success) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid workspace payload', parsed.error.flatten());
  }

  const workspaceId = uuidv4();
  const now = Date.now();
  const item = {
    PK: keys.workspacePk(workspaceId),
    SK: keys.workspaceMetaSk(),
    entity_type: 'CANDIDATE_WORKSPACE',
    workspace_id: workspaceId,
    org_id: DEFAULT_ORG_ID,
    title: parsed.data.title,
    candidate_name: parsed.data.candidate_name,
    position: parsed.data.position,
    status: 'OPEN',
    owner_user_id: caller.userId,
    owner_email: caller.email,
    linked_records: [],
    created_at: now,
    updated_at: now,
    // GSI1 org recency
    gsi1_pk: DEFAULT_ORG_ID,
    gsi1_sk: now,
  };

  await ddbDocClient.send(new PutCommand({ TableName: ADMIN_TABLE_NAME, Item: item }));
  return createdResponse({ workspace_id: workspaceId, ...stripKeys(item) });
}

/** GET /workspaces — the caller's own review workspaces. */
export async function listWorkspaces(event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  if (!caller) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');

  // Own workspaces via GSI1 (org recency) filtered by owner.
  const result = await ddbDocClient.send(new QueryCommand({
    TableName: ADMIN_TABLE_NAME,
    IndexName: 'GSI1_OrgRecency',
    KeyConditionExpression: 'gsi1_pk = :org',
    ExpressionAttributeValues: { ':org': DEFAULT_ORG_ID },
    ScanIndexForward: false,
    Limit: 200,
  }));

  const items = (result.Items || [])
    .filter((i) => i.entity_type === 'CANDIDATE_WORKSPACE'
      && i.owner_user_id === caller.userId
      && !i.deleted_at)
    .map(stripKeys);

  return successResponse({ items, count: items.length });
}

/** GET /workspaces/shared-with-me — via GSI2 (shared_user_id). */
export async function listSharedWithMe(event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  if (!caller) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');

  const shares = await ddbDocClient.send(new QueryCommand({
    TableName: ADMIN_TABLE_NAME,
    IndexName: 'GSI2_SharedWithUser',
    KeyConditionExpression: 'gsi2_pk = :uid',
    ExpressionAttributeValues: { ':uid': caller.userId },
    ScanIndexForward: false,
    Limit: 200,
  }));

  // Fetch each shared workspace's metadata.
  const workspaces = await Promise.all((shares.Items || []).map(async (s) => {
    const ws = await ddbDocClient.send(new GetCommand({
      TableName: ADMIN_TABLE_NAME,
      Key: { PK: keys.workspacePk(s.workspace_id), SK: keys.workspaceMetaSk() },
    }));
    if (!ws.Item || ws.Item.deleted_at) return null;
    return { ...stripKeys(ws.Item), my_permission: s.permission };
  }));

  const items = workspaces.filter(Boolean);
  return successResponse({ items, count: items.length });
}

/** GET /workspaces/{id} — owner, share, or VIEWER+ admin. Audited if admin-access. */
export async function getWorkspace(id: string | undefined, event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  if (!caller) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');
  if (!id) return errorResponse(400, 'VALIDATION_ERROR', 'Missing id');

  const access = await getWorkspaceAccess(caller, id);
  if (!access.workspace) return errorResponse(404, 'NOT_FOUND', 'Review workspace not found');

  const viaAdmin = !access.isOwner && !access.sharePermission && hasTier(caller, 'VIEWER');
  if (!access.isOwner && !access.sharePermission && !viaAdmin) {
    return errorResponse(403, 'ACCESS_DENIED', 'You do not have access to this review workspace');
  }

  if (viaAdmin) {
    await writeAuditLog({
      actorUserId: caller.userId,
      actorEmail: caller.email,
      action: 'READ_WORKSPACE',
      targetType: 'workspace',
      targetId: id,
      targetOwnerUserId: access.workspace.owner_user_id,
    });
  }

  return successResponse(stripKeys(access.workspace));
}

/** PATCH /workspaces/{id} — owner or OWNER-tier admin. */
export async function updateWorkspace(id: string | undefined, event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  if (!caller) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');
  if (!id) return errorResponse(400, 'VALIDATION_ERROR', 'Missing id');

  const access = await getWorkspaceAccess(caller, id);
  if (!access.workspace) return errorResponse(404, 'NOT_FOUND', 'Review workspace not found');

  const viaAdmin = !access.isOwner && hasTier(caller, 'OWNER');
  if (!access.isOwner && !viaAdmin) {
    return errorResponse(403, 'ACCESS_DENIED', 'Only the owner or an OWNER-tier admin can edit');
  }

  const parsed = UpdateWorkspaceSchema.safeParse(parseBody(event));
  if (!parsed.success) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid update payload', parsed.error.flatten());
  }

  const now = Date.now();
  const merged = {
    ...access.workspace,
    ...parsed.data,
    updated_at: now,
    gsi1_sk: now,
  };
  await ddbDocClient.send(new PutCommand({ TableName: ADMIN_TABLE_NAME, Item: merged }));

  if (viaAdmin) {
    await writeAuditLog({
      actorUserId: caller.userId,
      actorEmail: caller.email,
      action: 'UPDATE_RECORD',
      targetType: 'workspace',
      targetId: id,
      targetOwnerUserId: access.workspace.owner_user_id,
    });
  }

  return successResponse(stripKeys(merged));
}

/** DELETE /workspaces/{id} — SOFT delete. Owner or OWNER-tier admin. */
export async function deleteWorkspace(id: string | undefined, event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  if (!caller) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');
  if (!id) return errorResponse(400, 'VALIDATION_ERROR', 'Missing id');

  const access = await getWorkspaceAccess(caller, id);
  if (!access.workspace) return errorResponse(404, 'NOT_FOUND', 'Review workspace not found');

  const viaAdmin = !access.isOwner && hasTier(caller, 'OWNER');
  if (!access.isOwner && !viaAdmin) {
    return errorResponse(403, 'ACCESS_DENIED', 'Only the owner or an OWNER-tier admin can delete');
  }

  const now = Date.now();
  await ddbDocClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE_NAME,
    Key: { PK: keys.workspacePk(id), SK: keys.workspaceMetaSk() },
    UpdateExpression: 'SET deleted_at = :ts, gsi1_sk = :ts REMOVE gsi1_pk',
    ExpressionAttributeValues: { ':ts': now },
  }));

  await writeAuditLog({
    actorUserId: caller.userId,
    actorEmail: caller.email,
    action: 'SOFT_DELETE',
    targetType: 'workspace',
    targetId: id,
    targetOwnerUserId: access.workspace.owner_user_id,
  });

  return successResponse({ success: true, soft_deleted: true });
}

// ---------------------------------------------------------------------------
// Sharing — only the workspace owner may manage shares. No share-with-org.
// ---------------------------------------------------------------------------

/** POST /workspaces/{id}/shares */
export async function addShare(id: string | undefined, event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  if (!caller) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');
  if (!id) return errorResponse(400, 'VALIDATION_ERROR', 'Missing id');

  const access = await getWorkspaceAccess(caller, id);
  if (!access.workspace) return errorResponse(404, 'NOT_FOUND', 'Review workspace not found');
  if (!access.isOwner) {
    return errorResponse(403, 'ACCESS_DENIED', 'Only the owner can share this review workspace');
  }

  const parsed = AddShareSchema.safeParse(parseBody(event));
  if (!parsed.success) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid share payload', parsed.error.flatten());
  }
  if (parsed.data.shared_user_id === caller.userId) {
    return errorResponse(400, 'VALIDATION_ERROR', 'You already own this review workspace');
  }

  const now = Date.now();
  await ddbDocClient.send(new PutCommand({
    TableName: ADMIN_TABLE_NAME,
    Item: {
      PK: keys.workspacePk(id),
      SK: keys.shareSk(parsed.data.shared_user_id),
      entity_type: 'WORKSPACE_SHARE',
      workspace_id: id,
      shared_user_id: parsed.data.shared_user_id,
      shared_email: parsed.data.shared_email,
      permission: parsed.data.permission,
      shared_by: caller.userId,
      shared_at: now,
      // GSI2 shared-with-me
      gsi2_pk: parsed.data.shared_user_id,
      gsi2_sk: now,
    },
  }));

  await writeAuditLog({
    actorUserId: caller.userId,
    actorEmail: caller.email,
    action: 'SHARE_ADD',
    targetType: 'workspace',
    targetId: id,
    detail: `to: ${parsed.data.shared_user_id} (${parsed.data.permission})`,
  });

  return successResponse({ success: true });
}

/** DELETE /workspaces/{id}/shares/{userId} */
export async function removeShare(
  id: string | undefined,
  userId: string | undefined,
  event: APIGatewayProxyEvent,
) {
  const caller = await getCallerContext(event);
  if (!caller) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');
  if (!id || !userId) return errorResponse(400, 'VALIDATION_ERROR', 'Missing id or userId');

  const access = await getWorkspaceAccess(caller, id);
  if (!access.workspace) return errorResponse(404, 'NOT_FOUND', 'Review workspace not found');
  if (!access.isOwner) {
    return errorResponse(403, 'ACCESS_DENIED', 'Only the owner can manage shares');
  }

  await ddbDocClient.send(new DeleteCommand({
    TableName: ADMIN_TABLE_NAME,
    Key: { PK: keys.workspacePk(id), SK: keys.shareSk(userId) },
  }));

  await writeAuditLog({
    actorUserId: caller.userId,
    actorEmail: caller.email,
    action: 'SHARE_REMOVE',
    targetType: 'workspace',
    targetId: id,
    detail: `from: ${userId}`,
  });

  return successResponse({ success: true });
}

// ---------------------------------------------------------------------------
// Comments — read: owner/share/REVIEWER+; write: owner/COMMENTER/REVIEWER+.
// ---------------------------------------------------------------------------

function canReadComments(caller: CallerContext, access: Awaited<ReturnType<typeof getWorkspaceAccess>>): boolean {
  return access.isOwner || !!access.sharePermission || hasTier(caller, 'REVIEWER');
}

function canWriteComments(caller: CallerContext, access: Awaited<ReturnType<typeof getWorkspaceAccess>>): boolean {
  return access.isOwner || access.sharePermission === 'COMMENTER' || hasTier(caller, 'REVIEWER');
}

/** GET /workspaces/{id}/comments */
export async function listComments(id: string | undefined, event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  if (!caller) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');
  if (!id) return errorResponse(400, 'VALIDATION_ERROR', 'Missing id');

  const access = await getWorkspaceAccess(caller, id);
  if (!access.workspace) return errorResponse(404, 'NOT_FOUND', 'Review workspace not found');
  if (!canReadComments(caller, access)) {
    return errorResponse(403, 'ACCESS_DENIED', 'You do not have access to these comments');
  }

  const result = await ddbDocClient.send(new QueryCommand({
    TableName: ADMIN_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': keys.workspacePk(id), ':sk': SK_PREFIX.COMMENT },
    ScanIndexForward: true,
    Limit: 200,
  }));

  return successResponse({
    items: (result.Items || []).map(stripKeys),
    count: result.Items?.length || 0,
    has_more: !!result.LastEvaluatedKey,
  });
}

/** POST /workspaces/{id}/comments */
export async function createComment(id: string | undefined, event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  if (!caller) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');
  if (!id) return errorResponse(400, 'VALIDATION_ERROR', 'Missing id');

  const access = await getWorkspaceAccess(caller, id);
  if (!access.workspace) return errorResponse(404, 'NOT_FOUND', 'Review workspace not found');
  if (!canWriteComments(caller, access)) {
    return errorResponse(403, 'ACCESS_DENIED', 'You do not have permission to comment');
  }

  const parsed = CreateCommentSchema.safeParse(parseBody(event));
  if (!parsed.success) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid comment payload', parsed.error.flatten());
  }

  const now = Date.now();
  const commentId = uuidv4();
  const item = {
    PK: keys.workspacePk(id),
    SK: keys.commentSk(now, commentId),
    entity_type: 'COMMENT',
    workspace_id: id,
    comment_id: commentId,
    author_user_id: caller.userId,
    author_email: caller.email,
    body: parsed.data.body,
    resolved: false,
    created_at: now,
  };
  await ddbDocClient.send(new PutCommand({ TableName: ADMIN_TABLE_NAME, Item: item }));

  return createdResponse(stripKeys(item));
}

/** POST /workspaces/{id}/comments/{commentId}/resolve */
export async function resolveComment(
  id: string | undefined,
  commentId: string | undefined,
  event: APIGatewayProxyEvent,
) {
  const caller = await getCallerContext(event);
  if (!caller) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');
  if (!id || !commentId) return errorResponse(400, 'VALIDATION_ERROR', 'Missing id or commentId');

  const access = await getWorkspaceAccess(caller, id);
  if (!access.workspace) return errorResponse(404, 'NOT_FOUND', 'Review workspace not found');
  if (!canWriteComments(caller, access)) {
    return errorResponse(403, 'ACCESS_DENIED', 'You do not have permission to resolve comments');
  }

  // Find the comment row (SK includes ts we don't have) via a filtered query.
  const found = await ddbDocClient.send(new QueryCommand({
    TableName: ADMIN_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    FilterExpression: 'comment_id = :cid',
    ExpressionAttributeValues: {
      ':pk': keys.workspacePk(id),
      ':sk': SK_PREFIX.COMMENT,
      ':cid': commentId,
    },
  }));
  const comment = found.Items?.[0];
  if (!comment) return errorResponse(404, 'NOT_FOUND', 'Comment not found');

  const now = Date.now();
  await ddbDocClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE_NAME,
    Key: { PK: comment.PK, SK: comment.SK },
    UpdateExpression: 'SET resolved = :r, resolved_by = :by, resolved_at = :at',
    ExpressionAttributeValues: { ':r': true, ':by': caller.userId, ':at': now },
  }));

  return successResponse({ success: true });
}

// ---------------------------------------------------------------------------
// Linking records to a review workspace — owner or OWNER-tier admin.
// ---------------------------------------------------------------------------

/** POST /workspaces/{id}/link */
export async function linkRecord(id: string | undefined, event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  if (!caller) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');
  if (!id) return errorResponse(400, 'VALIDATION_ERROR', 'Missing id');

  const access = await getWorkspaceAccess(caller, id);
  if (!access.workspace) return errorResponse(404, 'NOT_FOUND', 'Review workspace not found');
  if (!access.isOwner && !hasTier(caller, 'OWNER')) {
    return errorResponse(403, 'ACCESS_DENIED', 'Only the owner or an OWNER-tier admin can link records');
  }

  const parsed = LinkRecordSchema.safeParse(parseBody(event));
  if (!parsed.success) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid link payload', parsed.error.flatten());
  }

  const linked = access.workspace.linked_records || [];
  const exists = linked.some(
    (r: any) => r.record_type === parsed.data.record_type && r.record_id === parsed.data.record_id,
  );
  if (!exists) {
    linked.push({
      record_type: parsed.data.record_type,
      record_id: parsed.data.record_id,
      label: parsed.data.label,
      linked_at: Date.now(),
      linked_by: caller.userId,
    });
  }

  const now = Date.now();
  await ddbDocClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE_NAME,
    Key: { PK: keys.workspacePk(id), SK: keys.workspaceMetaSk() },
    UpdateExpression: 'SET linked_records = :lr, updated_at = :ts, gsi1_sk = :ts',
    ExpressionAttributeValues: { ':lr': linked, ':ts': now },
  }));

  // Stamp workspace_id onto the source record so GSI_Workspace resolves it.
  await stampWorkspaceIdOnRecord(parsed.data.record_type, parsed.data.record_id, id);

  return successResponse({ success: true, linked_records: linked });
}

/** POST /workspaces/{id}/unlink */
export async function unlinkRecord(id: string | undefined, event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  if (!caller) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');
  if (!id) return errorResponse(400, 'VALIDATION_ERROR', 'Missing id');

  const access = await getWorkspaceAccess(caller, id);
  if (!access.workspace) return errorResponse(404, 'NOT_FOUND', 'Review workspace not found');
  if (!access.isOwner && !hasTier(caller, 'OWNER')) {
    return errorResponse(403, 'ACCESS_DENIED', 'Only the owner or an OWNER-tier admin can unlink records');
  }

  const parsed = LinkRecordSchema.safeParse(parseBody(event));
  if (!parsed.success) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid unlink payload', parsed.error.flatten());
  }

  const linked = (access.workspace.linked_records || []).filter(
    (r: any) => !(r.record_type === parsed.data.record_type && r.record_id === parsed.data.record_id),
  );

  const now = Date.now();
  await ddbDocClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE_NAME,
    Key: { PK: keys.workspacePk(id), SK: keys.workspaceMetaSk() },
    UpdateExpression: 'SET linked_records = :lr, updated_at = :ts, gsi1_sk = :ts',
    ExpressionAttributeValues: { ':lr': linked, ':ts': now },
  }));

  return successResponse({ success: true, linked_records: linked });
}

// ---------------------------------------------------------------------------
// Aggregated view — one Query on WS#<id> returns everything the detail page
// needs. Never returns S3 keys or signed URLs.
// ---------------------------------------------------------------------------

/** GET /workspaces/{id}/full */
export async function getWorkspaceFull(id: string | undefined, event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  if (!caller) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');
  if (!id) return errorResponse(400, 'VALIDATION_ERROR', 'Missing id');

  const access = await getWorkspaceAccess(caller, id);
  if (!access.workspace) return errorResponse(404, 'NOT_FOUND', 'Review workspace not found');

  const viaAdmin = !access.isOwner && !access.sharePermission && hasTier(caller, 'VIEWER');
  if (!access.isOwner && !access.sharePermission && !viaAdmin) {
    return errorResponse(403, 'ACCESS_DENIED', 'You do not have access to this review workspace');
  }

  // One Query pulls META + shares + comments + decisions.
  const all = await ddbDocClient.send(new QueryCommand({
    TableName: ADMIN_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': keys.workspacePk(id) },
    Limit: 400,
  }));

  const shares: any[] = [];
  const comments: any[] = [];
  const decisions: any[] = [];
  for (const row of all.Items || []) {
    if (row.entity_type === 'WORKSPACE_SHARE') shares.push(stripKeys(row));
    else if (row.entity_type === 'COMMENT') comments.push(stripKeys(row));
    else if (row.entity_type === 'APPROVAL_DECISION') decisions.push(stripKeys(row));
  }
  comments.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  decisions.sort((a, b) => (b.decided_at || 0) - (a.decided_at || 0));

  // Linked record summaries — metadata only, never S3 keys.
  const linkedSummaries = (await Promise.all(
    (access.workspace.linked_records || []).slice(0, 50).map((r: any) =>
      summarizeLinkedRecord(r.record_type, r.record_id).then((summary) => ({ ...r, summary })),
    ),
  )).filter((r: any) => r.summary !== null);

  if (viaAdmin) {
    await writeAuditLog({
      actorUserId: caller.userId,
      actorEmail: caller.email,
      action: 'READ_WORKSPACE',
      targetType: 'workspace',
      targetId: id,
      targetOwnerUserId: access.workspace.owner_user_id,
    });
  }

  return successResponse({
    workspace: stripKeys(access.workspace),
    shares,
    comments: comments.slice(0, 200),
    comments_has_more: comments.length > 200,
    decisions,
    linked_records: linkedSummaries,
    my_access: {
      is_owner: access.isOwner,
      share_permission: access.sharePermission,
      via_admin_tier: viaAdmin ? caller.tier : null,
      can_comment: canWriteComments(caller, access),
      can_decide: hasTier(caller, 'APPROVER'),
    },
  });
}

// ---------------------------------------------------------------------------
// Final approval workflow (Phase 7) — APPROVER tier.
// ---------------------------------------------------------------------------

/** GET /admin/approvals — review workspaces awaiting a decision. APPROVER+. */
export async function adminListApprovals(event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  const denied = requireAdminTier(caller, 'APPROVER');
  if (denied) return denied;

  const result = await ddbDocClient.send(new QueryCommand({
    TableName: ADMIN_TABLE_NAME,
    IndexName: 'GSI1_OrgRecency',
    KeyConditionExpression: 'gsi1_pk = :org',
    ExpressionAttributeValues: { ':org': DEFAULT_ORG_ID },
    ScanIndexForward: false,
    Limit: 200,
  }));

  const items = (result.Items || [])
    .filter((i) => i.entity_type === 'CANDIDATE_WORKSPACE'
      && !i.deleted_at
      && (i.status === 'OPEN' || i.status === 'IN_REVIEW'))
    .map(stripKeys);

  return successResponse({ items, count: items.length });
}

/** POST /workspaces/{id}/decision — append an ApprovalDecision. APPROVER+. Audited. */
export async function postDecision(id: string | undefined, event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  const denied = requireAdminTier(caller, 'APPROVER');
  if (denied) return denied;
  if (!id) return errorResponse(400, 'VALIDATION_ERROR', 'Missing id');

  const ws = await ddbDocClient.send(new GetCommand({
    TableName: ADMIN_TABLE_NAME,
    Key: { PK: keys.workspacePk(id), SK: keys.workspaceMetaSk() },
  }));
  if (!ws.Item || ws.Item.deleted_at) {
    return errorResponse(404, 'NOT_FOUND', 'Review workspace not found');
  }

  const body = parseBody(event) as Record<string, unknown>;
  const rawDecision = body.decision ?? body.status ?? body.action;
  const decisionAlias: Record<string, 'APPROVED' | 'REJECTED'> = {
    APPROVE: 'APPROVED',
    APPROVED: 'APPROVED',
    ACCEPT: 'APPROVED',
    ACCEPTED: 'APPROVED',
    REJECT: 'REJECTED',
    REJECTED: 'REJECTED',
    DECLINE: 'REJECTED',
    DECLINED: 'REJECTED',
  };
  const normalizedDecision = typeof rawDecision === 'string'
    ? decisionAlias[rawDecision.trim().toUpperCase().replace(/[\s-]+/g, '_')] ?? rawDecision.trim().toUpperCase().replace(/[\s-]+/g, '_')
    : rawDecision;
  const parsed = DecisionSchema.safeParse({
    decision: normalizedDecision,
    note: typeof body.note === 'string'
      ? body.note
      : typeof body.comment === 'string'
        ? body.comment
        : undefined,
  });
  if (!parsed.success) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid decision payload', parsed.error.flatten());
  }

  const now = Date.now();
  // Append-only decision row (full history).
  await ddbDocClient.send(new PutCommand({
    TableName: ADMIN_TABLE_NAME,
    Item: {
      PK: keys.workspacePk(id),
      SK: keys.decisionSk(now),
      entity_type: 'APPROVAL_DECISION',
      workspace_id: id,
      decision: parsed.data.decision,
      decided_by: caller!.userId,
      decided_by_email: caller!.email,
      decided_at: now,
      note: parsed.data.note,
    },
  }));

  // Mirror newest decision onto workspace status for cheap filtering.
  const newStatus = parsed.data.decision === 'APPROVED' ? 'APPROVED' : 'REJECTED';
  await ddbDocClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE_NAME,
    Key: { PK: keys.workspacePk(id), SK: keys.workspaceMetaSk() },
    UpdateExpression: 'SET #s = :s, updated_at = :ts, gsi1_sk = :ts',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':s': newStatus, ':ts': now },
  }));

  await writeAuditLog({
    actorUserId: caller!.userId,
    actorEmail: caller!.email,
    action: parsed.data.decision === 'APPROVED' ? 'APPROVE' : 'REJECT',
    targetType: 'workspace',
    targetId: id,
    targetOwnerUserId: ws.Item.owner_user_id,
  });

  return successResponse({ success: true, status: newStatus });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Removes internal DynamoDB key/index attributes from a row before returning it. */
function stripKeys(item: Record<string, any>): Record<string, any> {
  const {
    PK, SK, gsi1_pk, gsi1_sk, gsi2_pk, gsi2_sk, gsi3_pk, gsi3_sk, gsi4_pk,
    ...rest
  } = item;
  return rest;
}

export async function handleLookupWorkspace(event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  if (!caller) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');
  
  const email = event.queryStringParameters?.email;
  const name = event.queryStringParameters?.name;
  
  const ws = await lookupCandidateWorkspace(email, name);
  if (ws) {
    return successResponse({ workspace: ws });
  }
  return errorResponse(404, 'NOT_FOUND', 'Candidate workspace not found');
}

export async function lookupCandidateWorkspace(candidateEmail?: string, candidateName?: string) {
  if (!candidateEmail && !candidateName) return null;
  const result = await ddbDocClient.send(new QueryCommand({
    TableName: ADMIN_TABLE_NAME,
    IndexName: 'GSI1_OrgRecency',
    KeyConditionExpression: 'gsi1_pk = :org',
    ExpressionAttributeValues: { ':org': DEFAULT_ORG_ID },
  }));
  const workspaces = (result.Items || []).filter(i => 
    i.entity_type === 'CANDIDATE_WORKSPACE' && !i.deleted_at
  );
  if (candidateEmail) {
    const match = workspaces.find(w => 
      w.candidate_email?.toLowerCase() === candidateEmail.toLowerCase() ||
      w.candidate?.email?.toLowerCase() === candidateEmail.toLowerCase()
    );
    if (match) return stripKeys(match);
  }
  if (candidateName) {
    const match = workspaces.find(w => w.candidate_name?.toLowerCase() === candidateName.toLowerCase());
    if (match) return stripKeys(match);
  }
  return null;
}

export async function ensureCandidateWorkspace(
  caller: CallerContext,
  candidateName: string,
  position: string,
  recordId: string,
  candidateEmail?: string,
  kekaMeetingTitle?: string
) {
  // Match by email first (stable across name spelling), then by name.
  let ws = await lookupCandidateWorkspace(candidateEmail, candidateName);
  if (!ws) {
    const workspaceId = uuidv4();
    const now = Date.now();
    const item = {
      PK: keys.workspacePk(workspaceId),
      SK: keys.workspaceMetaSk(),
      entity_type: 'CANDIDATE_WORKSPACE',
      workspace_id: workspaceId,
      org_id: DEFAULT_ORG_ID,
      title: `Interview Workspace - ${candidateName}`,
      candidate_name: candidateName,
      candidate_email: candidateEmail,
      position: position,
      status: 'OPEN',
      owner_user_id: caller.userId,
      owner_email: caller.email,
      linked_records: [{
        record_type: 'intelligence',
        record_id: recordId,
        label: kekaMeetingTitle || 'Initial Round',
        linked_at: now,
        linked_by: caller.userId,
      }],
      created_at: now,
      updated_at: now,
      gsi1_pk: DEFAULT_ORG_ID,
      gsi1_sk: now,
    };
    await ddbDocClient.send(new PutCommand({ TableName: ADMIN_TABLE_NAME, Item: item }));
    await stampWorkspaceIdOnRecord('intelligence', recordId, workspaceId);
    return item;
  }
  
  const currentLinked = ws.linked_records || [];
  const validLinkedSummaries = await Promise.all(
    currentLinked.map(async (r: any) => {
      const summary = await summarizeLinkedRecord(r.record_type, r.record_id);
      return summary ? r : null;
    })
  );
  const linked = validLinkedSummaries.filter(Boolean);

  if (!linked.some((r: any) => r.record_type === 'intelligence' && r.record_id === recordId)) {
    linked.push({
      record_type: 'intelligence',
      record_id: recordId,
      label: kekaMeetingTitle || 'Subsequent Round',
      linked_at: Date.now(),
      linked_by: caller.userId,
    });
    await ddbDocClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE_NAME,
      Key: { PK: keys.workspacePk(ws.workspace_id), SK: keys.workspaceMetaSk() },
      UpdateExpression: 'SET linked_records = :lr, updated_at = :ts, gsi1_sk = :ts',
      ExpressionAttributeValues: { ':lr': linked, ':ts': Date.now() },
    }));
    await stampWorkspaceIdOnRecord('intelligence', recordId, ws.workspace_id);
  } else if (linked.length !== currentLinked.length) {
    // If we only removed dead links but didn't add a new one, still update the DB
    await ddbDocClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE_NAME,
      Key: { PK: keys.workspacePk(ws.workspace_id), SK: keys.workspaceMetaSk() },
      UpdateExpression: 'SET linked_records = :lr, updated_at = :ts, gsi1_sk = :ts',
      ExpressionAttributeValues: { ':lr': linked, ':ts': Date.now() },
    }));
  }
  
  if (ws.owner_user_id !== caller.userId) {
    const shareNow = Date.now();
    await ddbDocClient.send(new PutCommand({
      TableName: ADMIN_TABLE_NAME,
      Item: {
        PK: keys.workspacePk(ws.workspace_id),
        SK: keys.shareSk(caller.userId),
        entity_type: 'WORKSPACE_SHARE',
        workspace_id: ws.workspace_id,
        shared_user_id: caller.userId,
        shared_email: caller.email,
        permission: 'COMMENTER',
        shared_by: 'system',
        shared_at: shareNow,
        gsi2_pk: caller.userId,
        gsi2_sk: shareNow,
      }
    }));
  }
  return ws;
}

const bedrockClient = new BedrockRuntimeClient({});
const lambdaClient = new LambdaClient({});

/**
 * A precondition the caller can fix, as opposed to a fault they cannot.
 *
 * Both used to collapse into "Failed to generate composite analysis. Please
 * retry." — advice that can never succeed when the real problem is that no round
 * has been reviewed yet. This type lets the worker pass its own message through
 * to the workspace row while everything else keeps the generic retry wording.
 */
class CompositeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompositeInputError';
  }
}

/**
 * POST /workspaces/{id}/composite-analysis — kicks off composite synthesis.
 *
 * Part D: this is now an APPROVER+ capability, and it runs asynchronously.
 * Synthesising several rounds through Sonnet 5 (at max_tokens 4000) routinely
 * exceeds API Gateway's 29s ceiling — the same failure that used to make the
 * old synchronous path 502 and never persist a result. We stamp a
 * `composite_status` lifecycle on the workspace row and self-invoke the
 * `composite-analysis` worker (InvocationType 'Event'), returning immediately
 * so the UI can poll — identical to the intelligence-analysis pattern.
 */
export async function generateCompositeAnalysis(id: string | undefined, event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  if (!caller) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');
  // Composite synthesis is a hiring-decision artifact: gate to APPROVER+.
  const denied = requireAdminTier(caller, 'APPROVER');
  if (denied) return denied;
  if (!id) return errorResponse(400, 'VALIDATION_ERROR', 'Missing id');

  const access = await getWorkspaceAccess(caller, id);
  if (!access.workspace) return errorResponse(404, 'NOT_FOUND', 'Review workspace not found');

  const linked = access.workspace.linked_records || [];
  const intellRecords = linked.filter((r: any) => r.record_type === 'intelligence');

  if (intellRecords.length === 0) {
    return errorResponse(400, 'VALIDATION_ERROR', 'No interview rounds to analyze');
  }

  // Idempotent: a second click while a synthesis is already running must not
  // queue a duplicate model call. Return the in-flight state instead.
  if (access.workspace.composite_status === 'processing') {
    return successResponse(access.workspace);
  }

  const now = Date.now();
  await ddbDocClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE_NAME,
    Key: { PK: keys.workspacePk(id), SK: keys.workspaceMetaSk() },
    UpdateExpression:
      'SET composite_status = :s, composite_progress_stage = :ps, composite_progress_message = :pm, '
      + 'composite_started_at = :st, composite_progress_events = :ev, composite_error = :err, updated_at = :ts, gsi1_sk = :ts',
    ExpressionAttributeValues: {
      ':s': 'processing',
      ':ps': 'queued',
      ':pm': 'Queued for composite synthesis...',
      ':st': now,
      // Start of a run: overwritten rather than appended, so the log cannot carry
      // stages from a previous synthesis of the same workspace.
      ':ev': [{ at: now, stage: 'queued', message: 'Queued for composite synthesis...' }],
      ':err': null,
      ':ts': now,
    },
  }));

  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
      InvocationType: 'Event',
      Payload: new TextEncoder().encode(JSON.stringify({
        __internalTask: 'composite-analysis',
        workspaceId: id,
      })),
    }));
    return successResponse({
      workspace_id: id,
      composite_status: 'processing',
      composite_progress_stage: 'queued',
      composite_progress_message: 'Queued for composite synthesis...',
      composite_started_at: now,
    });
  } catch (err) {
    console.error('Could not queue composite analysis:', err);
    await ddbDocClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE_NAME,
      Key: { PK: keys.workspacePk(id), SK: keys.workspaceMetaSk() },
      UpdateExpression: 'SET composite_status = :s, composite_error = :err, updated_at = :ts',
      ExpressionAttributeValues: {
        ':s': 'failed',
        ':err': 'Composite analysis could not be started. Please retry.',
        ':ts': Date.now(),
      },
    }));
    return errorResponse(502, 'COMPOSITE_QUEUE_FAILED', 'Composite analysis could not be started. Please retry.');
  }
}

/**
 * Records composite synthesis progress on the workspace row. Best-effort by
 * design (mirrors setIntelligenceProgress): a failed progress write must never
 * fail the synthesis itself.
 */
async function setCompositeProgress(workspaceId: string, stage: string, message: string): Promise<void> {
  const now = Date.now();
  try {
    await ddbDocClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE_NAME,
      Key: { PK: keys.workspacePk(workspaceId), SK: keys.workspaceMetaSk() },
      UpdateExpression: 'SET composite_progress_stage = :s, composite_progress_message = :m, updated_at = :now, '
        + 'composite_progress_events = list_append(if_not_exists(composite_progress_events, :empty), :event)',
      ExpressionAttributeValues: {
        ':s': stage,
        ':m': message,
        ':now': now,
        ':empty': [],
        ':event': [{ at: now, stage, message }],
      },
    }));
  } catch (err) {
    console.warn(`Could not record composite progress (${stage}) for ${workspaceId}:`, err);
  }
}

/**
 * One Bedrock composite call: invoke, then defensively extract the JSON object.
 *
 * Part D guards the two failure modes seen in the logs:
 *   - `content` empty -> the old `resultBody.content[0].text` threw a
 *     TypeError; we detect it explicitly and throw a labelled error.
 *   - No parseable JSON object -> throw before JSON.parse so the caller's
 *     single retry gets a clean second attempt.
 * The brace-substring (indexOf('{') .. lastIndexOf('}')) is the existing
 * markdown-fence strip, kept verbatim.
 */
async function invokeCompositeModel(prompt: string): Promise<any> {
  const modelId = process.env.BEDROCK_SONNET_5_PROFILE_ARN || 'global.anthropic.claude-sonnet-5';
  // We can't import anthropicRequestBody from index.ts (circular dependency),
  // so we construct the body inline using the same logic.
  const body: any = {
    anthropic_version: 'bedrock-2023-05-31',
    // Raised 1000 -> 4000: a truncated response is itself unparseable JSON,
    // a likely cause of the SyntaxError seen in the logs.
    max_tokens: 4000,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  };
  if (!modelId.includes('claude-sonnet-5')) {
    body.temperature = 0;
  }

  const response = await bedrockClient.send(new InvokeModelCommand({
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(body),
  }));

  const resultBody = JSON.parse(new TextDecoder().decode(response.body));
  const content = Array.isArray(resultBody.content) ? resultBody.content : [];
  if (content.length === 0) {
    throw new Error('COMPOSITE_EMPTY_CONTENT: model returned no content blocks');
  }
  const jsonStr: string = content.find((c: any) => c.type === 'text')?.text || '';
  const start = jsonStr.indexOf('{');
  const end = jsonStr.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('COMPOSITE_NO_JSON: model output contained no JSON object');
  }
  const cleanJsonStr = jsonStr.substring(start, end + 1);
  return JSON.parse(cleanJsonStr); // may throw SyntaxError -> retried by caller
}

/**
 * `__internalTask: 'composite-analysis'` worker. Runs off the API Gateway
 * request path (dispatched from index.ts), so it can take the time Sonnet 5
 * needs. Reads the workspace, gathers per-round scorecards, synthesises them,
 * and writes `composite_analysis` + the terminal `composite_status`. The
 * return value is discarded (fire-and-forget Event invoke); the workspace row
 * is the source of truth the UI polls.
 */
export async function runCompositeAnalysisWorker(workspaceId: string): Promise<APIGatewayProxyResult> {
  if (!workspaceId) return errorResponse(400, 'VALIDATION_ERROR', 'Missing workspace id');

  const wsRes = await ddbDocClient.send(new GetCommand({
    TableName: ADMIN_TABLE_NAME,
    Key: { PK: keys.workspacePk(workspaceId), SK: keys.workspaceMetaSk() },
    ConsistentRead: true,
  }));
  const ws = wsRes.Item;
  if (!ws) return errorResponse(404, 'NOT_FOUND', 'Review workspace not found');

  try {
    await setCompositeProgress(workspaceId, 'gathering', 'Collecting scorecards from each interview round...');

    const linked = ws.linked_records || [];
    const intellRecords = linked.filter((r: any) => r.record_type === 'intelligence');

    const scorecards = [];
    // Which rounds could not contribute, so the result can say so instead of
    // quietly synthesising a subset. The UI offers this action as soon as ONE
    // round is analysed, but a round only carries a scorecard once its AI review
    // has run — a round with manually submitted scores and no review passes that
    // gate and still has nothing to synthesise.
    const skipped: string[] = [];
    for (const r of intellRecords) {
      const ir = await ddbDocClient.send(new GetCommand({
        TableName: process.env.INTELLIGENCE_TABLE_NAME!,
        Key: { intelligence_id: r.record_id },
      }));
      if (ir.Item && ir.Item.aiEvaluation) {
        scorecards.push(`
ROUND: ${ir.Item.keka?.title || 'Interview Round'}
Interviewer: ${ir.Item.owner_email || ir.Item.owner_user_id}
Score: ${ir.Item.aiEvaluation.candidateEvaluation?.candidateScore}/100
Strengths: ${ir.Item.aiEvaluation.candidateEvaluation?.strengths?.join(', ')}
Concerns: ${ir.Item.aiEvaluation.candidateEvaluation?.concerns?.join(', ')}
Summary: ${ir.Item.aiEvaluation.candidateEvaluation?.summary}
Recommendation: ${ir.Item.aiEvaluation.candidateEvaluation?.recommendation}
        `);
      } else {
        skipped.push(ir.Item?.keka?.title || r.label || r.record_id);
      }
    }

    if (scorecards.length === 0) {
      // A precondition, not a transient fault: retrying cannot help, so the
      // message says what to do instead of inviting another identical attempt.
      throw new CompositeInputError(
        intellRecords.length === 1
          ? 'This round has no completed AI review yet, so there is nothing to synthesise. Run the AI review on the round first.'
          : `None of the ${intellRecords.length} linked rounds has a completed AI review yet. Run the AI review on at least one round first.`,
      );
    }

    const prompt = `You are a Principal Technical Recruiter. Synthesize these multiple interview rounds into one composite summary:
${scorecards.join('\n\n')}

Return a JSON with:
{
  "compositeScore": number 0-100,
  "overallSummary": "...",
  "keyStrengths": ["...", "..."],
  "majorConcerns": ["...", "..."],
  "finalRecommendation": "strongly_recommend|recommend|proceed|hold|reject|strongly_not_recommended"
}
Output only JSON.`;

    await setCompositeProgress(workspaceId, 'synthesizing', 'AI is synthesizing the rounds into a composite view...');

    let analysis: any;
    try {
      analysis = await invokeCompositeModel(prompt);
    } catch (firstErr) {
      // A truncated or empty response yields unparseable JSON; retry once
      // before surfacing an error.
      console.warn('Composite synthesis attempt 1 failed; retrying once.', firstErr);
      await setCompositeProgress(workspaceId, 'synthesizing', 'Retrying composite synthesis...');
      analysis = await invokeCompositeModel(prompt);
    }

    const now = Date.now();
    await ddbDocClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE_NAME,
      Key: { PK: keys.workspacePk(workspaceId), SK: keys.workspaceMetaSk() },
      UpdateExpression:
        'SET composite_analysis = :ca, composite_status = :s, composite_progress_stage = :ps, '
        + 'composite_progress_message = :pm, composite_error = :err, composite_rounds_used = :used, '
        + 'composite_rounds_total = :total, composite_rounds_skipped = :skipped, updated_at = :ts, gsi1_sk = :ts',
      ExpressionAttributeValues: {
        ':ca': analysis,
        ':s': 'done',
        ':ps': 'done',
        ':pm': 'Composite analysis complete.',
        ':err': null,
        // The header calls this a view "across all rounds". When it is not, the
        // UI needs the numbers to say which rounds it actually covers — a
        // composite built from 1 of 3 rounds is a different artifact.
        ':used': scorecards.length,
        ':total': intellRecords.length,
        ':skipped': skipped,
        ':ts': now,
      },
    }));

    return successResponse({
      success: true,
      analysis,
      rounds_used: scorecards.length,
      rounds_total: intellRecords.length,
    });
  } catch (err) {
    console.error('Composite analysis failed', err);
    // A missing precondition is the user's to fix and says how; anything else is
    // a genuine fault, where "please retry" is the right advice.
    const message = err instanceof CompositeInputError
      ? err.message
      : 'Failed to generate composite analysis. Please retry.';
    await ddbDocClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE_NAME,
      Key: { PK: keys.workspacePk(workspaceId), SK: keys.workspaceMetaSk() },
      UpdateExpression: 'SET composite_status = :s, composite_error = :err, composite_progress_stage = :ps, updated_at = :ts',
      ExpressionAttributeValues: {
        ':s': 'failed',
        ':err': message,
        ':ps': 'failed',
        ':ts': Date.now(),
      },
    }));
    return errorResponse(500, 'INTERNAL_ERROR', message);
  }
}

/** Fetches a minimal, S3-key-free summary of a linked source record. */
async function summarizeLinkedRecord(recordType: string, recordId: string): Promise<any | null> {
  try {
    if (recordType === 'interview') {
      const r = await ddbDocClient.send(new GetCommand({
        TableName: process.env.TABLE_NAME!,
        Key: { PK: `INTERVIEW#${recordId}`, SK: 'METADATA' },
      }));
      if (!r.Item) return null;
      return {
        candidate_name: r.Item.metadata?.candidate_name,
        position: r.Item.metadata?.position,
        status: r.Item.status,
        overall_score: r.Item.overall_score,
      };
    }
    if (recordType === 'mom') {
      const r = await ddbDocClient.send(new GetCommand({
        TableName: process.env.MOM_TABLE_NAME!,
        Key: { mom_id: recordId },
      }));
      if (!r.Item) return null;
      return { title: r.Item.title, status: r.Item.status };
    }
    if (recordType === 'intelligence') {
      const r = await ddbDocClient.send(new GetCommand({
        TableName: process.env.INTELLIGENCE_TABLE_NAME!,
        Key: { intelligence_id: recordId },
      }));
      if (!r.Item) return null;
      
      const aiStatus = r.Item.status;
      const mappedStatus = ['analysis_generated', 'approved', 'scores_submitted'].includes(aiStatus) ? 'COMPLETED' : 'IN_PROGRESS';
      
      return {
        candidate_name: r.Item.candidate?.name || r.Item.candidate_name,
        position_title: r.Item.job?.title || r.Item.position_title,
        status: mappedStatus,
        raw_status: aiStatus,
        keka_title: r.Item.keka?.title,
        // Which ground this round covered, so reviewers can compare rounds and
        // a later panel can choose different areas.
        selected_topics: r.Item.questionPlan?.selectedTopics || [],
        scheduled_at: r.Item.teams?.scheduledAt || r.Item.keka?.scheduledAt || r.Item.created_at,
        interviewer_email: r.Item.owner_email,
        interviewer_name: r.Item.owner_email?.split('@')[0],
        overall_score: r.Item.aiEvaluation?.candidateEvaluation?.candidateScore,
      };
    }
  } catch (err) {
    console.warn(`Failed to summarize ${recordType} ${recordId}:`, err);
  }
  return null;
}

/**
 * Detaches a deleted source record from its candidate workspace.
 *
 * Called from the record delete handlers so a removed round never lingers as a
 * dangling link. The workspace itself is closed (soft) only when this was its
 * last surviving round — a workspace that still has live rounds is left alone,
 * so nothing disappears because of a heuristic. Best-effort: a failure here
 * must never fail the delete the user actually asked for.
 */
export async function unlinkRecordFromWorkspaces(
  recordType: 'interview' | 'mom' | 'intelligence',
  recordId: string,
  workspaceIdHint?: string,
) {
  try {
    // Resolve which workspace(s) reference this record. The hint (workspace_id
    // stamped on the record) is the cheap path; fall back to an org scan.
    let candidates: any[] = [];
    if (workspaceIdHint) {
      const ws = await ddbDocClient.send(new GetCommand({
        TableName: ADMIN_TABLE_NAME,
        Key: { PK: keys.workspacePk(workspaceIdHint), SK: keys.workspaceMetaSk() },
      }));
      if (ws.Item) candidates = [ws.Item];
    }
    if (candidates.length === 0) {
      const result = await ddbDocClient.send(new QueryCommand({
        TableName: ADMIN_TABLE_NAME,
        IndexName: 'GSI1_OrgRecency',
        KeyConditionExpression: 'gsi1_pk = :org',
        ExpressionAttributeValues: { ':org': DEFAULT_ORG_ID },
        Limit: 400,
      }));
      candidates = (result.Items || []).filter((i) =>
        i.entity_type === 'CANDIDATE_WORKSPACE'
        && !i.deleted_at
        && (i.linked_records || []).some(
          (r: any) => r.record_type === recordType && r.record_id === recordId,
        ));
    }

    for (const ws of candidates) {
      const current = ws.linked_records || [];
      const remaining = current.filter(
        (r: any) => !(r.record_type === recordType && r.record_id === recordId),
      );
      if (remaining.length === current.length) continue; // nothing referenced it

      const now = Date.now();
      if (remaining.length === 0) {
        // Last round gone: close the workspace so it stops showing up in lists
        // and is not silently reused the next time this candidate is added.
        await ddbDocClient.send(new UpdateCommand({
          TableName: ADMIN_TABLE_NAME,
          Key: { PK: keys.workspacePk(ws.workspace_id), SK: keys.workspaceMetaSk() },
          UpdateExpression:
            'SET linked_records = :lr, deleted_at = :ts, updated_at = :ts, gsi1_sk = :ts',
          ExpressionAttributeValues: { ':lr': remaining, ':ts': now },
        }));
      } else {
        await ddbDocClient.send(new UpdateCommand({
          TableName: ADMIN_TABLE_NAME,
          Key: { PK: keys.workspacePk(ws.workspace_id), SK: keys.workspaceMetaSk() },
          UpdateExpression: 'SET linked_records = :lr, updated_at = :ts, gsi1_sk = :ts',
          ExpressionAttributeValues: { ':lr': remaining, ':ts': now },
        }));
      }
    }
  } catch (err) {
    console.warn(`Failed to unlink ${recordType} ${recordId} from workspace:`, err);
  }
}

/** Stamps workspace_id onto a source record so GSI_Workspace resolves it. */async function stampWorkspaceIdOnRecord(recordType: string, recordId: string, workspaceId: string) {
  try {
    if (recordType === 'interview') {
      await ddbDocClient.send(new UpdateCommand({
        TableName: process.env.TABLE_NAME!,
        Key: { PK: `INTERVIEW#${recordId}`, SK: 'METADATA' },
        UpdateExpression: 'SET workspace_id = :ws',
        ExpressionAttributeValues: { ':ws': workspaceId },
      }));
    } else if (recordType === 'mom') {
      await ddbDocClient.send(new UpdateCommand({
        TableName: process.env.MOM_TABLE_NAME!,
        Key: { mom_id: recordId },
        UpdateExpression: 'SET workspace_id = :ws',
        ExpressionAttributeValues: { ':ws': workspaceId },
      }));
    } else if (recordType === 'intelligence') {
      await ddbDocClient.send(new UpdateCommand({
        TableName: process.env.INTELLIGENCE_TABLE_NAME!,
        Key: { intelligence_id: recordId },
        UpdateExpression: 'SET workspace_id = :ws',
        ExpressionAttributeValues: { ':ws': workspaceId },
      }));
    }
  } catch (err) {
    console.warn(`Failed to stamp workspace_id on ${recordType} ${recordId}:`, err);
  }
}
