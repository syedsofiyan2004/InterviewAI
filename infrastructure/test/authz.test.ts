import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddbDocClient } from '../lambdas/shared/aws';
import {
  requireAdminTier,
  hasTier,
  isAdmin,
  tierRank,
  getActiveTier,
  getCallerContext,
  CallerContext,
} from '../lambdas/api-handler/authz';

const ddbMock = mockClient(ddbDocClient);

beforeEach(() => ddbMock.reset());

function caller(partial: Partial<CallerContext>): CallerContext {
  return { userId: 'u1', email: 'u1@minfytech.com', baseRole: 'MEMBER', tier: null, ...partial };
}

describe('requireAdminTier — the single tier gate', () => {
  test('no caller -> 401', () => {
    expect(requireAdminTier(null, 'VIEWER')?.statusCode).toBe(401);
  });

  test('MEMBER base role is denied regardless of a (stale) tier', () => {
    expect(requireAdminTier(caller({ baseRole: 'MEMBER', tier: null }), 'VIEWER')?.statusCode).toBe(403);
    // A leftover grant row must never let a non-admin through.
    expect(requireAdminTier(caller({ baseRole: 'MEMBER', tier: 'OWNER' }), 'VIEWER')?.statusCode).toBe(403);
  });

  test('ADMIN with NO grant is denied — the no-default-viewer rule', () => {
    const denied = requireAdminTier(caller({ baseRole: 'ADMIN', tier: null }), 'VIEWER');
    expect(denied?.statusCode).toBe(403);
    expect(denied?.body).toContain('No admin grant');
  });

  test('ADMIN meeting or exceeding the minimum tier is allowed', () => {
    expect(requireAdminTier(caller({ baseRole: 'ADMIN', tier: 'VIEWER' }), 'VIEWER')).toBeNull();
    expect(requireAdminTier(caller({ baseRole: 'ADMIN', tier: 'OWNER' }), 'APPROVER')).toBeNull();
    expect(requireAdminTier(caller({ baseRole: 'ADMIN', tier: 'REVIEWER' }), 'REVIEWER')).toBeNull();
  });

  test('ADMIN below the minimum tier is denied', () => {
    expect(requireAdminTier(caller({ baseRole: 'ADMIN', tier: 'VIEWER' }), 'REVIEWER')?.statusCode).toBe(403);
    expect(requireAdminTier(caller({ baseRole: 'ADMIN', tier: 'REVIEWER' }), 'APPROVER')?.statusCode).toBe(403);
    expect(requireAdminTier(caller({ baseRole: 'ADMIN', tier: 'APPROVER' }), 'OWNER')?.statusCode).toBe(403);
  });

  test('full (tier x required) matrix is monotonic', () => {
    const tiers = ['VIEWER', 'REVIEWER', 'APPROVER', 'OWNER'] as const;
    for (const held of tiers) {
      for (const need of tiers) {
        const allowed = requireAdminTier(caller({ baseRole: 'ADMIN', tier: held }), need) === null;
        expect(allowed).toBe(tierRank(held) >= tierRank(need));
      }
    }
  });
});

describe('hasTier / isAdmin', () => {
  test('hasTier respects base role and rank', () => {
    expect(hasTier(caller({ baseRole: 'ADMIN', tier: 'OWNER' }), 'APPROVER')).toBe(true);
    expect(hasTier(caller({ baseRole: 'ADMIN', tier: 'VIEWER' }), 'OWNER')).toBe(false);
    expect(hasTier(caller({ baseRole: 'MEMBER', tier: 'OWNER' }), 'VIEWER')).toBe(false);
    expect(hasTier(null, 'VIEWER')).toBe(false);
  });

  test('isAdmin requires ADMIN base role AND a grant', () => {
    expect(isAdmin(caller({ baseRole: 'ADMIN', tier: 'VIEWER' }))).toBe(true);
    expect(isAdmin(caller({ baseRole: 'ADMIN', tier: null }))).toBe(false);
    expect(isAdmin(caller({ baseRole: 'MEMBER', tier: 'OWNER' }))).toBe(false);
  });
});

describe('getActiveTier — newest grant row wins (append-only)', () => {
  test('returns the tier of the newest non-revoked grant', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ tier: 'APPROVER' }] });
    expect(await getActiveTier('u1')).toBe('APPROVER');
  });

  test('a newest row carrying revoked_at means no access', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ tier: 'OWNER', revoked_at: 123 }] });
    expect(await getActiveTier('u1')).toBeNull();
  });

  test('no grant rows -> null', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    expect(await getActiveTier('u1')).toBeNull();
  });
});

describe('getCallerContext — role/tier always come from DynamoDB, never the client', () => {
  const event: any = {
    requestContext: { authorizer: { claims: { sub: 'u1', email: 'U1@Minfytech.com' } } },
  };

  test('null when there is no verified sub', async () => {
    expect(await getCallerContext({ requestContext: { authorizer: { claims: {} } } } as any)).toBeNull();
  });

  test('base role from membership row, tier from newest grant', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { base_role: 'ADMIN' } });
    ddbMock.on(QueryCommand).resolves({ Items: [{ tier: 'OWNER' }] });
    const ctx = await getCallerContext(event);
    expect(ctx).toEqual({ userId: 'u1', email: 'u1@minfytech.com', baseRole: 'ADMIN', tier: 'OWNER' });
  });

  test('missing membership row defaults to MEMBER with no tier (fail closed)', async () => {
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const ctx = await getCallerContext(event);
    expect(ctx?.baseRole).toBe('MEMBER');
    expect(ctx?.tier).toBeNull();
  });
});
