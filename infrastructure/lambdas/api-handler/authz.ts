import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddbDocClient } from '../shared/aws';
import { errorResponse } from '../shared/responses';
import {
  AdminTier,
  DEFAULT_ORG_ID,
  SK_PREFIX,
  TIER_RANK,
  keys,
} from '../../schema/admin.js';

const ADMIN_TABLE_NAME = process.env.ADMIN_TABLE_NAME!;

/**
 * The verified caller. `baseRole`/`tier` are ALWAYS re-fetched from DynamoDB
 * using the Cognito-verified `sub` — never read from a request body, header,
 * or query param. `tier: null` means no active AdminGrant row exists, which is
 * treated as "no admin access of any kind" (fail closed, never default-viewer).
 */
export interface CallerContext {
  userId: string;
  email: string;
  baseRole: 'MEMBER' | 'ADMIN';
  tier: AdminTier | null;
}

export type AdminTierName = AdminTier;

function getSub(event: APIGatewayProxyEvent): string | null {
  return event.requestContext.authorizer?.claims?.sub || null;
}

function getEmail(event: APIGatewayProxyEvent): string {
  const claims = event.requestContext.authorizer?.claims;
  const email = claims?.email || claims?.username || '';
  return String(email).toLowerCase();
}

/**
 * Reads the caller's Membership row and newest active AdminGrant from the admin
 * table. Returns null only when the request carries no verified identity.
 *
 * A user with no Membership row is treated as a plain MEMBER with no tier — the
 * seed script backfills memberships, and admin routes fail closed regardless.
 */
export async function getCallerContext(
  event: APIGatewayProxyEvent,
): Promise<CallerContext | null> {
  const userId = getSub(event);
  if (!userId) return null;

  const email = getEmail(event);

  // Layer 1: base_role from the Membership row (source of truth, not the group).
  const membership = await ddbDocClient.send(new GetCommand({
    TableName: ADMIN_TABLE_NAME,
    Key: { PK: keys.membershipPk(DEFAULT_ORG_ID), SK: keys.membershipSk(userId) },
  }));

  const baseRole = (membership.Item?.base_role === 'ADMIN' ? 'ADMIN' : 'MEMBER') as
    'MEMBER' | 'ADMIN';

  // Layer 2: newest AdminGrant row. Newest row with no revoked_at wins.
  const tier = await getActiveTier(userId);

  return { userId, email, baseRole, tier };
}

/**
 * The newest GRANT# row for a user decides current access: if that row carries
 * a `revoked_at`, access is revoked (null); otherwise its tier is active.
 * Append-only history means every grant/revoke is a new row, never an overwrite.
 */
export async function getActiveTier(userId: string): Promise<AdminTier | null> {
  const grants = await ddbDocClient.send(new QueryCommand({
    TableName: ADMIN_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: {
      ':pk': keys.grantPk(userId),
      ':prefix': SK_PREFIX.GRANT,
    },
    ScanIndexForward: false, // newest first
    Limit: 1,
  }));

  const newest = grants.Items?.[0];
  if (!newest) return null;
  if (newest.revoked_at) return null;
  const parsed = AdminTier.safeParse(newest.tier);
  return parsed.success ? parsed.data : null;
}

/** Numeric rank of a tier, or 0 when the caller has none. */
export function tierRank(tier: AdminTier | null): number {
  return tier ? TIER_RANK[tier] : 0;
}

export function hasTier(caller: CallerContext | null, minTier: AdminTier): boolean {
  if (!caller) return false;
  if (caller.baseRole !== 'ADMIN') return false;
  if (!caller.tier) return false;
  return TIER_RANK[caller.tier] >= TIER_RANK[minTier];
}

export function isAdmin(caller: CallerContext | null): boolean {
  return !!caller && caller.baseRole === 'ADMIN' && !!caller.tier;
}

/**
 * The ONLY tier gate. Returns an error response to send back, or null when the
 * caller is allowed. Fails closed on every unknown:
 *   no caller          -> 401
 *   not base ADMIN     -> 403
 *   ADMIN but no grant -> 403  (the critical "no default viewer" rule)
 *   grant below minTier -> 403
 */
export function requireAdminTier(
  caller: CallerContext | null,
  minTier: AdminTier,
): APIGatewayProxyResult | null {
  if (!caller) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');
  if (caller.baseRole !== 'ADMIN') {
    return errorResponse(403, 'ACCESS_DENIED', 'Admin access required');
  }
  if (!caller.tier) {
    return errorResponse(403, 'ACCESS_DENIED', 'No admin grant');
  }
  if (TIER_RANK[caller.tier] < TIER_RANK[minTier]) {
    return errorResponse(403, 'ACCESS_DENIED', `Requires ${minTier} tier`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Workspace access — ownership OR explicit share OR admin tier.
// "Same org" NEVER grants access; sharing is opt-in per user.
// ---------------------------------------------------------------------------

export interface WorkspaceAccess {
  workspace: Record<string, any> | null;
  isOwner: boolean;
  sharePermission: 'VIEWER' | 'COMMENTER' | null;
  adminTier: AdminTier | null; // tier that would grant admin-side access, if any
}

/**
 * Resolves how (if at all) the caller may reach a workspace. Callers decide the
 * required capability from the returned flags — e.g. commenting needs
 * `isOwner || sharePermission === 'COMMENTER' || hasTier(caller,'REVIEWER')`.
 * Never infers access from org membership.
 */
export async function getWorkspaceAccess(
  caller: CallerContext,
  workspaceId: string,
): Promise<WorkspaceAccess> {
  const wsResult = await ddbDocClient.send(new GetCommand({
    TableName: ADMIN_TABLE_NAME,
    Key: { PK: keys.workspacePk(workspaceId), SK: keys.workspaceMetaSk() },
  }));

  const workspace = wsResult.Item && !wsResult.Item.deleted_at ? wsResult.Item : null;
  const isOwner = !!workspace && workspace.owner_user_id === caller.userId;

  let sharePermission: 'VIEWER' | 'COMMENTER' | null = null;
  if (workspace && !isOwner) {
    const shareResult = await ddbDocClient.send(new GetCommand({
      TableName: ADMIN_TABLE_NAME,
      Key: { PK: keys.workspacePk(workspaceId), SK: keys.shareSk(caller.userId) },
    }));
    if (shareResult.Item?.permission === 'VIEWER' || shareResult.Item?.permission === 'COMMENTER') {
      sharePermission = shareResult.Item.permission;
    }
  }

  return {
    workspace,
    isOwner,
    sharePermission,
    adminTier: caller.baseRole === 'ADMIN' ? caller.tier : null,
  };
}
