import { APIGatewayProxyEvent } from 'aws-lambda';
import { ScanCommand, QueryCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { ddbDocClient } from '../shared/aws';
import { successResponse, errorResponse } from '../shared/responses';
import { getCallerContext, requireAdminTier, getActiveTier, isAdmin } from './authz.js';
import { writeAuditLog } from './audit.js';
import {
  MeResponse,
  DEFAULT_ORG_ID,
  keys,
  SK_PREFIX,
  GrantTierSchema,
  ChangeBaseRoleSchema,
} from '../../schema/admin.js';

const cognitoClient = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION || 'ap-south-1',
});

const ADMIN_TABLE_NAME = process.env.ADMIN_TABLE_NAME!;

function isRealMomRecord(item: any) {
  if (!item) return false;
  const id = item.mom_id || item.id;
  if (!id) return false;
  const idStr = String(id).toUpperCase();
  if (idStr.startsWith('PROJECT#')) return false;
  const typeStr = String(item.item_type || '').toUpperCase();
  if (typeStr === 'PROJECT') return false;
  if (item.deleted_at) return false;
  return true;
}

async function scanAll(params: any) {
  const items: any[] = [];
  let ExclusiveStartKey: Record<string, any> | undefined;

  do {
    const result = await ddbDocClient.send(new ScanCommand({
      ...params,
      ExclusiveStartKey,
    }));
    items.push(...(result.Items || []));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return items;
}

/**
 * GET /me — the identity payload the frontend gates navigation on. Derived
 * entirely server-side from the Cognito-verified sub; the client never supplies
 * role or tier. Frontend gating on this is convenience only — every admin route
 * re-checks server-side.
 */
export async function getMe(event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  if (!caller) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');

  const body: MeResponse = {
    userId: caller.userId,
    email: caller.email,
    baseRole: caller.baseRole,
    tier: caller.tier,
    isAdmin: isAdmin(caller),
  };
  return successResponse(body);
}

/**
 * GET /admin/overview — aggregates only: counts per status. No audit (no
 * specific record access). Scans are expensive; production should consider a
 * scheduled aggregator Lambda populating a summary row instead.
 */
export async function getAdminOverview(event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  const denied = requireAdminTier(caller, 'VIEWER');
  if (denied) return denied;

  // Count interviews by status
  const interviews = await ddbDocClient.send(new ScanCommand({
    TableName: process.env.TABLE_NAME!,
    FilterExpression: 'begins_with(PK, :pk) AND SK = :sk AND attribute_not_exists(deleted_at)',
    ExpressionAttributeValues: { ':pk': 'INTERVIEW#', ':sk': 'METADATA' },
    ProjectionExpression: 'interview_id, #status',
    ExpressionAttributeNames: { '#status': 'status' },
  }));
  const interviewCounts = (interviews.Items || []).reduce((acc, i) => {
    acc[i.status || 'UNKNOWN'] = (acc[i.status || 'UNKNOWN'] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // Count moms by status
  const moms = await ddbDocClient.send(new ScanCommand({
    TableName: process.env.MOM_TABLE_NAME!,
    FilterExpression: 'attribute_exists(mom_id) AND attribute_not_exists(deleted_at)',
    ProjectionExpression: 'mom_id, item_type, deleted_at, #status',
    ExpressionAttributeNames: { '#status': 'status' },
  }));
  const momItems = (moms.Items || []).filter(isRealMomRecord);
  const momCounts = momItems.reduce((acc, m) => {
    acc[m.status || 'UNKNOWN'] = (acc[m.status || 'UNKNOWN'] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // Count intelligence interviews by status
  const intelligence = await ddbDocClient.send(new ScanCommand({
    TableName: process.env.INTELLIGENCE_TABLE_NAME!,
    FilterExpression: 'attribute_not_exists(deleted_at)',
    ProjectionExpression: 'intelligence_id, #status',
    ExpressionAttributeNames: { '#status': 'status' },
  }));
  const intelligenceCounts = (intelligence.Items || []).reduce((acc, i) => {
    acc[i.status || 'UNKNOWN'] = (acc[i.status || 'UNKNOWN'] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const workspaces = await ddbDocClient.send(new QueryCommand({
    TableName: ADMIN_TABLE_NAME,
    IndexName: 'GSI1_OrgRecency',
    KeyConditionExpression: 'gsi1_pk = :org',
    ExpressionAttributeValues: { ':org': DEFAULT_ORG_ID },
    ScanIndexForward: false,
    Limit: 500,
  }));
  const workspaceItems = (workspaces.Items || []).filter((item) =>
    item.entity_type === 'CANDIDATE_WORKSPACE' && !item.deleted_at
  );
  const workspaceCounts = workspaceItems.reduce((acc, item) => {
    acc[item.status || 'UNKNOWN'] = (acc[item.status || 'UNKNOWN'] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // Count cost estimates by status.
  const calculations = await ddbDocClient.send(new ScanCommand({
    TableName: process.env.CALCULATOR_TABLE_NAME!,
    ProjectionExpression: 'calculation_id, #status',
    ExpressionAttributeNames: { '#status': 'status' },
  }));
  const calculationCounts = (calculations.Items || []).reduce((acc, item) => {
    acc[item.status || 'UNKNOWN'] = (acc[item.status || 'UNKNOWN'] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const totalManual = interviews.Items?.length || 0;
  const totalIntel = intelligence.Items?.length || 0;

  return successResponse({
    interviews: interviewCounts,
    moms: momCounts,
    intelligence: intelligenceCounts,
    workspaces: workspaceCounts,
    calculations: calculationCounts,
    total_interviews: totalManual + totalIntel,
    total_moms: momItems.length,
    total_intelligence: totalIntel,
    total_workspaces: workspaceItems.length,
    total_calculations: calculations.Items?.length || 0,
  });
}

/**
 * GET /admin/search — full-text search across all three record types. Audited
 * because it exposes records the caller may not own. Query param: `q`.
 * Production should use OpenSearch or a purpose-built search index; this is a
 * Scan-based prototype acceptable only at small scale.
 */
export async function adminSearch(event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  const denied = requireAdminTier(caller, 'VIEWER');
  if (denied) return denied;

  const query = (event.queryStringParameters?.q || '').toLowerCase().trim();
  if (!query) return successResponse({ items: [], count: 0 });

  await writeAuditLog({
    actorUserId: caller!.userId,
    actorEmail: caller!.email,
    action: 'SEARCH',
    detail: `query: "${query}"`,
  });

  const results: any[] = [];

  // Search interviews
  const interviews = await scanAll({
    TableName: process.env.TABLE_NAME!,
    FilterExpression: 'begins_with(PK, :pk) AND SK = :sk AND attribute_not_exists(deleted_at)',
    ExpressionAttributeValues: { ':pk': 'INTERVIEW#', ':sk': 'METADATA' },
  });
  for (const item of interviews) {
    const candidateName = item.metadata?.candidate_name?.toLowerCase() || '';
    const position = item.metadata?.position?.toLowerCase() || '';
    if (candidateName.includes(query) || position.includes(query)) {
      results.push({
        type: 'interview',
        id: item.interview_id,
        candidate_name: item.metadata?.candidate_name,
        position: item.metadata?.position,
        status: item.status,
        created_at: item.created_at,
        owner_email: item.owner_email,
      });
    }
  }

  // Search moms
  const moms = await scanAll({
    TableName: process.env.MOM_TABLE_NAME!,
    FilterExpression: 'attribute_exists(mom_id) AND attribute_not_exists(deleted_at)',
  });
  for (const item of moms) {
    if (!isRealMomRecord(item)) continue;
    const title = (item.title || '').toLowerCase();
    if (title.includes(query)) {
      results.push({
        type: 'mom',
        id: item.mom_id,
        title: item.title,
        status: item.status,
        created_at: item.created_at,
        owner_email: item.owner_email,
      });
    }
  }

  // Search intelligence
  const intelligence = await scanAll({
    TableName: process.env.INTELLIGENCE_TABLE_NAME!,
    FilterExpression: 'attribute_not_exists(deleted_at)',
  });
  for (const item of intelligence) {
    const candidateName = (item.candidate_name || '').toLowerCase();
    const positionTitle = (item.position_title || '').toLowerCase();
    if (candidateName.includes(query) || positionTitle.includes(query)) {
      results.push({
        type: 'intelligence',
        id: item.intelligence_id,
        candidate_name: item.candidate_name,
        position_title: item.position_title,
        status: item.status,
        created_at: item.created_at,
        owner_email: item.owner_email,
      });
    }
  }

  return successResponse({
    items: results.sort((a, b) => (b.created_at || 0) - (a.created_at || 0)),
    count: results.length,
  });
}

/**
 * GET /admin/interviews — org-wide list (no owner filter). Metadata only, no
 * audit (not accessing specific records).
 */
export async function adminListInterviews(event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  const denied = requireAdminTier(caller, 'VIEWER');
  if (denied) return denied;

  const [manualScan, intelScan] = await Promise.all([
    scanAll({
      TableName: process.env.TABLE_NAME!,
      FilterExpression: 'begins_with(PK, :pk) AND SK = :sk AND attribute_not_exists(deleted_at)',
      ExpressionAttributeValues: { ':pk': 'INTERVIEW#', ':sk': 'METADATA' },
    }),
    scanAll({
      TableName: process.env.INTELLIGENCE_TABLE_NAME!,
      FilterExpression: 'attribute_not_exists(deleted_at)',
    }),
  ]);

  const manualItems = manualScan
    .map((item) => {
      const interviewId = item.interview_id || item.PK?.replace(/^INTERVIEW#/, '');
      if (!interviewId) return null;
      return {
        interview_id: interviewId,
        record_type: 'interview',
        source_label: 'Manual Evaluation',
        status: item.status,
        candidate_name: item.metadata?.candidate_name || item.candidate_name || 'Unnamed',
        position: item.metadata?.position || item.position || '',
        created_at: item.created_at || item.updated_at || 0,
        owner_email: item.owner_email,
        model_id: item.model_id,
        href: `/interviews/view?id=${encodeURIComponent(interviewId)}`,
      };
    })
    .filter(Boolean);

function extractCandidateName(item: any): string {
  if (!item) return 'Unnamed';

  let candidateObj = item.candidate;
  if (typeof candidateObj === 'string') {
    try { candidateObj = JSON.parse(candidateObj); } catch (_) {}
  }

  let jobObj = item.job;
  if (typeof jobObj === 'string') {
    try { jobObj = JSON.parse(jobObj); } catch (_) {}
  }

  let kekaObj = item.keka;
  if (typeof kekaObj === 'string') {
    try { kekaObj = JSON.parse(kekaObj); } catch (_) {}
  }

  let evalObj = item.aiEvaluation;
  if (typeof evalObj === 'string') {
    try { evalObj = JSON.parse(evalObj); } catch (_) {}
  }

  const name1 = item.candidate_name || item.candidateName || item.candidate_name_keka;
  if (name1 && typeof name1 === 'string' && name1.trim() && name1.trim().toLowerCase() !== 'unnamed') {
    return name1.trim();
  }

  const name2 = candidateObj?.name || candidateObj?.full_name || candidateObj?.candidate_name;
  if (name2 && typeof name2 === 'string' && name2.trim() && name2.trim().toLowerCase() !== 'unnamed') {
    return name2.trim();
  }

  const name3 = kekaObj?.candidate_name || kekaObj?.candidateName || kekaObj?.name;
  if (name3 && typeof name3 === 'string' && name3.trim() && name3.trim().toLowerCase() !== 'unnamed') {
    return name3.trim();
  }

  const name4 = evalObj?.candidate_name || evalObj?.candidateName;
  if (name4 && typeof name4 === 'string' && name4.trim() && name4.trim().toLowerCase() !== 'unnamed') {
    return name4.trim();
  }

  if (evalObj?.finalReport && typeof evalObj.finalReport === 'string') {
    const match = evalObj.finalReport.match(/^([^]+?)\s+was interviewed/i);
    if (match && match[1] && match[1].trim()) {
      return match[1].trim();
    }
  }

  const title = item.position_title || jobObj?.title || item.title || item.keka_job_title || item.position;
  if (title && typeof title === 'string' && title.trim()) {
    return title.trim();
  }

  return 'Unnamed';
}

  const intelItems = intelScan
    .map((item) => {
      if (!item.intelligence_id) return null;
      const candName = extractCandidateName(item);
      const position = item.position_title || item.position || item.job?.title || item.metadata?.position || '';

      return {
        interview_id: item.intelligence_id,
        record_type: 'intelligence',
        source_label: 'Interview Intelligence',
        status: item.status,
        candidate_name: candName,
        position,
        created_at: item.created_at || item.updated_at || 0,
        owner_email: item.owner_email || item.owner_user_id,
        model_id: item.source_mode || 'intelligence',
        href: `/interviews/intelligence/view?id=${encodeURIComponent(item.intelligence_id)}`,
      };
    })
    .filter(Boolean);

  const items = [...manualItems, ...intelItems].sort((a: any, b: any) => (b.created_at || 0) - (a.created_at || 0));

  return successResponse({ items, count: items.length });
}

/**
 * GET /admin/moms — org-wide list.
 */
export async function adminListMoms(event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  const denied = requireAdminTier(caller, 'VIEWER');
  if (denied) return denied;

  const scanItems = await scanAll({
    TableName: process.env.MOM_TABLE_NAME!,
  });

  const items = scanItems
    .filter(isRealMomRecord)
    .map((item) => {
      const momId = item.mom_id || item.id;
      return {
        mom_id: momId,
        status: item.status,
        title: item.title || 'Untitled meeting',
        project_title: item.project_title || 'General Workspace',
        meeting_date: item.meeting_date || null,
        created_at: item.created_at || item.updated_at || 0,
        owner_email: item.owner_email || item.owner_user_id,
        href: `/mom/view?id=${encodeURIComponent(momId)}`,
      };
    })
    .filter((item) => item.mom_id)
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

  return successResponse({ items, count: items.length });
}

/**
 * GET /admin/calculator — every cost estimate in the organisation.
 *
 * VIEWER, like the other org-wide read lists: an estimate carries no personal data
 * and admins are expected to see what the team has produced. Sorted newest first
 * and carrying the owner, since "who built this estimate" is the usual question.
 */
export async function adminListCalculations(event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  const denied = requireAdminTier(caller, 'VIEWER');
  if (denied) return denied;

  const scanItems = await scanAll({
    TableName: process.env.CALCULATOR_TABLE_NAME!,
  });

  const items = scanItems
    .filter((item) => item.calculation_id)
    .map((item) => ({
      calculation_id: item.calculation_id,
      name: item.name || 'Untitled estimate',
      status: item.status || 'PROCESSING',
      region: item.region || null,
      // The headline figure, so the list is useful without opening each one.
      monthly_total: item.result?.monthlyTotal ?? null,
      currency: item.result?.currency || 'USD',
      line_item_count: Array.isArray(item.result?.lineItems) ? item.result.lineItems.length : 0,
      environment_hours: item.environment_hours || [],
      input_file_name: item.input_file_name || null,
      created_at: item.created_at || item.updated_at || 0,
      owner_email: item.owner_email || item.owner_user_id,
      href: `/calculator/view?id=${encodeURIComponent(item.calculation_id)}`,
    }))
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

  return successResponse({ items, count: items.length });
}

/**
 * GET /admin/intelligence-interviews — org-wide list.
 */
export async function adminListIntelligenceInterviews(event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  const denied = requireAdminTier(caller, 'VIEWER');
  if (denied) return denied;

  const scanItems = await scanAll({
    TableName: process.env.INTELLIGENCE_TABLE_NAME!,
    FilterExpression: 'attribute_not_exists(deleted_at)',
  });

  const items = scanItems
    .map((item) => {
      const name1 = item.candidate_name || item.candidateName || item.candidate_name_keka;
      const name2 = item.candidate?.name || item.candidate?.full_name || item.candidate?.candidate_name;
      const title1 = item.position_title || item.job?.title || item.title || item.keka_job_title || item.position;

      let candName = 'Unnamed';
      if (name1 && String(name1).trim() && String(name1).trim().toLowerCase() !== 'unnamed') {
        candName = String(name1).trim();
      } else if (name2 && String(name2).trim() && String(name2).trim().toLowerCase() !== 'unnamed') {
        candName = String(name2).trim();
      } else if (title1 && String(title1).trim()) {
        candName = String(title1).trim();
      }

      return {
        intelligence_id: item.intelligence_id,
        candidate_name: candName,
        position_title: item.position_title || item.position || item.job?.title || '',
        status: item.status,
        source_mode: item.source_mode,
        created_at: item.created_at,
        owner_email: item.owner_email,
      };
    })
    .filter((item) => item.intelligence_id)
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

  return successResponse({ items, count: items.length });
}

/**
 * GET /admin/candidates — list CandidateWorkspace rows from GSI1 (org recency).
 */
export async function adminListCandidates(event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  const denied = requireAdminTier(caller, 'VIEWER');
  if (denied) return denied;

  const result = await ddbDocClient.send(new QueryCommand({
    TableName: process.env.ADMIN_TABLE_NAME!,
    IndexName: 'GSI1_OrgRecency',
    KeyConditionExpression: 'gsi1_pk = :org',
    ExpressionAttributeValues: { ':org': DEFAULT_ORG_ID },
    ScanIndexForward: false,
    Limit: 100,
  }));

  const items = (result.Items || [])
    .filter((item) => item.entity_type === 'CANDIDATE_WORKSPACE' && !item.deleted_at)
    .map((item) => ({
      workspace_id: item.workspace_id,
      title: item.title,
      candidate_name: item.candidate_name,
      position: item.position,
      status: item.status,
      owner_email: item.owner_email,
      linked_records: item.linked_records || [],
      created_at: item.created_at,
      updated_at: item.updated_at,
    }));

  return successResponse({ items, count: items.length });
}

/**
 * GET /admin/audit-log — paginated audit log for OWNER tier. Reading the log
 * is itself audited. Query params: `date` (yyyy-mm-dd, defaults to today),
 * `limit`, `start_key`.
 */
export async function getAuditLog(event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  const denied = requireAdminTier(caller, 'OWNER');
  if (denied) return denied;

  const dateParam = event.queryStringParameters?.date;
  const date = dateParam || new Date().toISOString().slice(0, 10);
  const limit = Math.min(
    parseInt(event.queryStringParameters?.limit || '50', 10),
    200,
  );
  const startKey = event.queryStringParameters?.start_key
    ? JSON.parse(Buffer.from(event.queryStringParameters.start_key, 'base64').toString())
    : undefined;

  await writeAuditLog({
    actorUserId: caller!.userId,
    actorEmail: caller!.email,
    action: 'READ_AUDIT_LOG',
    detail: `date: ${date}`,
  });

  const result = await ddbDocClient.send(new QueryCommand({
    TableName: process.env.ADMIN_TABLE_NAME!,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': keys.auditPk(date) },
    ScanIndexForward: false,
    Limit: limit,
    ExclusiveStartKey: startKey,
  }));

  return successResponse({
    items: result.Items || [],
    count: result.Items?.length || 0,
    last_evaluated_key: result.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
      : null,
  });
}

// ---------------------------------------------------------------------------
// Member & tier management (OWNER tier). All mutations are POST-only, append a
// row (never overwrite), audit, and reject self-targeting.
// ---------------------------------------------------------------------------

/** GET /admin/members — the full org membership list with current tier. */
export async function adminListMembers(event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  const denied = requireAdminTier(caller, 'OWNER');
  if (denied) return denied;

  const result = await ddbDocClient.send(new QueryCommand({
    TableName: process.env.ADMIN_TABLE_NAME!,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: {
      ':pk': keys.membershipPk(DEFAULT_ORG_ID),
      ':sk': SK_PREFIX.MEMBER,
    },
  }));

  // Resolve each member's active tier (newest non-revoked grant).
  const members = await Promise.all((result.Items || []).map(async (m) => ({
    user_id: m.user_id,
    email: m.email,
    base_role: m.base_role,
    tier: await getActiveTier(m.user_id),
    created_at: m.created_at,
    updated_at: m.updated_at,
  })));

  return successResponse({ items: members, count: members.length });
}

/** GET /admin/members/{userId}/grants — append-only grant history for a user. */
export async function adminGetMemberGrants(userId: string | undefined, event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  const denied = requireAdminTier(caller, 'OWNER');
  if (denied) return denied;
  if (!userId) return errorResponse(400, 'VALIDATION_ERROR', 'Missing userId');

  const result = await ddbDocClient.send(new QueryCommand({
    TableName: process.env.ADMIN_TABLE_NAME!,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': keys.grantPk(userId), ':sk': SK_PREFIX.GRANT },
    ScanIndexForward: false,
  }));

  return successResponse({ items: result.Items || [], count: result.Items?.length || 0 });
}

/**
 * POST /admin/members/{userId}/tier — grant or revoke a tier by appending a new
 * AdminGrant row. Rejects userId === caller (no self-escalation), even for an
 * existing OWNER. Body: { tier, note? }. To revoke, the frontend grants a lower
 * tier; a true revoke would append a row with revoked_at (handled via the same
 * append semantics if `tier` omitted — but here we require an explicit tier).
 */
export async function adminGrantTier(userId: string | undefined, event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  const denied = requireAdminTier(caller, 'OWNER');
  if (denied) return denied;
  if (!userId) return errorResponse(400, 'VALIDATION_ERROR', 'Missing userId');

  // No self-escalation — enforced before any other logic.
  if (userId === caller!.userId) {
    return errorResponse(403, 'ACCESS_DENIED', 'You cannot change your own tier');
  }

  const parsed = GrantTierSchema.safeParse(JSON.parse(event.body || '{}'));
  if (!parsed.success) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid tier payload', parsed.error.flatten());
  }

  // Target must be an existing member.
  const target = await ddbDocClient.send(new GetCommand({
    TableName: process.env.ADMIN_TABLE_NAME!,
    Key: { PK: keys.membershipPk(DEFAULT_ORG_ID), SK: keys.membershipSk(userId) },
  }));
  if (!target.Item) return errorResponse(404, 'NOT_FOUND', 'Member not found');
  if (target.Item.base_role !== 'ADMIN') {
    return errorResponse(409, 'VALIDATION_ERROR', 'Grant a tier only after setting base_role ADMIN');
  }

  const ts = Date.now();
  await ddbDocClient.send(new PutCommand({
    TableName: process.env.ADMIN_TABLE_NAME!,
    Item: {
      PK: keys.grantPk(userId),
      SK: keys.grantSk(ts),
      entity_type: 'ADMIN_GRANT',
      user_id: userId,
      email: target.Item.email,
      tier: parsed.data.tier,
      granted_by: caller!.userId,
      granted_at: ts,
      note: parsed.data.note,
    },
  }));

  await writeAuditLog({
    actorUserId: caller!.userId,
    actorEmail: caller!.email,
    action: 'GRANT_TIER',
    targetType: 'member',
    targetId: userId,
    detail: `tier: ${parsed.data.tier}`,
  });

  return successResponse({ success: true, tier: parsed.data.tier });
}

/**
 * POST /admin/members/{userId}/revoke — append a revocation row. Rejects self.
 */
export async function adminRevokeTier(userId: string | undefined, event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  const denied = requireAdminTier(caller, 'OWNER');
  if (denied) return denied;
  if (!userId) return errorResponse(400, 'VALIDATION_ERROR', 'Missing userId');

  if (userId === caller!.userId) {
    return errorResponse(403, 'ACCESS_DENIED', 'You cannot revoke your own tier');
  }

  const current = await getActiveTier(userId);
  if (!current) return errorResponse(409, 'VALIDATION_ERROR', 'Member has no active tier to revoke');

  const target = await ddbDocClient.send(new GetCommand({
    TableName: process.env.ADMIN_TABLE_NAME!,
    Key: { PK: keys.membershipPk(DEFAULT_ORG_ID), SK: keys.membershipSk(userId) },
  }));

  const ts = Date.now();
  await ddbDocClient.send(new PutCommand({
    TableName: process.env.ADMIN_TABLE_NAME!,
    Item: {
      PK: keys.grantPk(userId),
      SK: keys.grantSk(ts),
      entity_type: 'ADMIN_GRANT',
      user_id: userId,
      email: target.Item?.email,
      tier: current,
      granted_by: caller!.userId,
      granted_at: ts,
      revoked_at: ts,
      revoked_by: caller!.userId,
    },
  }));

  await writeAuditLog({
    actorUserId: caller!.userId,
    actorEmail: caller!.email,
    action: 'REVOKE_TIER',
    targetType: 'member',
    targetId: userId,
    detail: `revoked: ${current}`,
  });

  return successResponse({ success: true });
}

/**
 * POST /admin/members/{userId}/base-role — set MEMBER/ADMIN. Rejects self.
 * Setting base_role never creates a grant; a newly-ADMIN user holds no tier.
 */
export async function adminChangeBaseRole(userId: string | undefined, event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  const denied = requireAdminTier(caller, 'OWNER');
  if (denied) return denied;
  if (!userId) return errorResponse(400, 'VALIDATION_ERROR', 'Missing userId');

  if (userId === caller!.userId) {
    return errorResponse(403, 'ACCESS_DENIED', 'You cannot change your own base role');
  }

  const parsed = ChangeBaseRoleSchema.safeParse(JSON.parse(event.body || '{}'));
  if (!parsed.success) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid base_role payload', parsed.error.flatten());
  }

  const existing = await ddbDocClient.send(new GetCommand({
    TableName: process.env.ADMIN_TABLE_NAME!,
    Key: { PK: keys.membershipPk(DEFAULT_ORG_ID), SK: keys.membershipSk(userId) },
  }));

  const now = Date.now();
  const email = (existing.Item?.email || parsed.data.email || '').toLowerCase();
  if (!existing.Item && !email) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Email is required when creating a member profile');
  }

  const membershipItem = {
    ...(existing.Item || {
      PK: keys.membershipPk(DEFAULT_ORG_ID),
      SK: keys.membershipSk(userId),
      entity_type: 'MEMBERSHIP',
      org_id: DEFAULT_ORG_ID,
      user_id: userId,
      created_at: now,
    }),
    email,
    base_role: parsed.data.base_role,
    updated_at: now,
  };

  await ddbDocClient.send(new PutCommand({
    TableName: process.env.ADMIN_TABLE_NAME!,
    Item: {
      ...membershipItem,
      ...(email ? { gsi4_pk: email } : {}),
    },
  }));

  // Keep Cognito group in sync (defence in depth / console legibility).
  const group = parsed.data.base_role;
  try {
    if (group === 'ADMIN') {
      await cognitoClient.send(new AdminAddUserToGroupCommand({
        UserPoolId: process.env.USER_POOL_ID!,
        Username: userId,
        GroupName: 'ADMIN',
      }));
    } else {
      await cognitoClient.send(new AdminRemoveUserFromGroupCommand({
        UserPoolId: process.env.USER_POOL_ID!,
        Username: userId,
        GroupName: 'ADMIN',
      }));
    }
  } catch (err: any) {
    console.warn(`Cognito group sync failed for ${userId}: ${err.message}`);
  }

  await writeAuditLog({
    actorUserId: caller!.userId,
    actorEmail: caller!.email,
    action: 'CHANGE_BASE_ROLE',
    targetType: 'member',
    targetId: userId,
    detail: `base_role: ${parsed.data.base_role}`,
  });

  return successResponse({ success: true, base_role: parsed.data.base_role });
}

/**
 * GET /admin/cognito-users — the pool user picker for the grant UI. Audited.
 * Cross-references memberships so the UI can show who is already an admin.
 */
export async function adminListCognitoUsers(event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  const denied = requireAdminTier(caller, 'OWNER');
  if (denied) return denied;

  await writeAuditLog({
    actorUserId: caller!.userId,
    actorEmail: caller!.email,
    action: 'LIST_COGNITO_USERS',
  });

  const users: any[] = [];
  let paginationToken: string | undefined;
  do {
    const page = await cognitoClient.send(new ListUsersCommand({
      UserPoolId: process.env.USER_POOL_ID!,
      PaginationToken: paginationToken,
    }));
    for (const u of page.Users || []) {
      const email = (u.Attributes || []).find((a) => a.Name === 'email')?.Value || '';
      users.push({
        user_id: u.Username,
        email,
        enabled: u.Enabled,
        status: u.UserStatus,
      });
    }
    paginationToken = page.PaginationToken;
  } while (paginationToken);

  // Attach current base_role/tier from memberships.
  const memberships = await ddbDocClient.send(new QueryCommand({
    TableName: process.env.ADMIN_TABLE_NAME!,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: {
      ':pk': keys.membershipPk(DEFAULT_ORG_ID),
      ':sk': SK_PREFIX.MEMBER,
    },
  }));
  const byUser = new Map((memberships.Items || []).map((m) => [m.user_id, m]));

  const enriched = await Promise.all(users.map(async (u) => {
    const m = byUser.get(u.user_id);
    return {
      ...u,
      base_role: m?.base_role || 'MEMBER',
      tier: m ? await getActiveTier(u.user_id) : null,
      has_membership: !!m,
    };
  }));

  return successResponse({ items: enriched, count: enriched.length });
}
