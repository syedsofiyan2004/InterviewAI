import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { GetCommand, UpdateCommand, DeleteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddbDocClient } from '../lambdas/shared/aws';
import { handler } from '../lambdas/api-handler/index';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const ddbMock = mockClient(ddbDocClient);

beforeEach(() => ddbMock.reset());

function mockEvent(
  httpMethod: string,
  resource: string,
  userId: string,
  email: string = 'test@minfytech.com',
  pathParameters?: Record<string, string>,
  body?: any,
): Partial<APIGatewayProxyEvent> {
  return {
    httpMethod,
    resource,
    pathParameters: pathParameters || {},
    body: body ? JSON.stringify(body) : null,
    requestContext: {
      authorizer: {
        claims: { sub: userId, email },
      },
    } as any,
  } as any;
}

/**
 * Every route that passes `minTier: 'OWNER'` to a getOwned*Record helper. The
 * brief requires the 403 rule be asserted per route rather than sampled: a route
 * that forgets to pass adminAccess, or passes too low a tier, is a privilege
 * hole, so each one is exercised individually below.
 */
const GUARDED_ROUTES: Array<{
  method: string;
  resource: string;
  table: 'test-interviews' | 'test-moms' | 'test-intelligence';
  key: Record<string, string>;
  id: string;
  body?: any;
}> = [
  // Deletes
  { method: 'DELETE', resource: '/interviews/{id}', table: 'test-interviews', key: { PK: 'INTERVIEW#r-1', SK: 'METADATA' }, id: 'r-1' },
  { method: 'DELETE', resource: '/moms/{id}', table: 'test-moms', key: { mom_id: 'r-1' }, id: 'r-1' },
  { method: 'DELETE', resource: '/mom-projects/{id}', table: 'test-moms', key: { mom_id: 'PROJECT#r-1' }, id: 'r-1' },
  { method: 'DELETE', resource: '/intelligence-interviews/{id}', table: 'test-intelligence', key: { intelligence_id: 'r-1' }, id: 'r-1' },
  // Mutations
  {
    method: 'POST', resource: '/interviews/{id}/confirm-upload', table: 'test-interviews',
    key: { PK: 'INTERVIEW#r-1', SK: 'METADATA' }, id: 'r-1',
    body: { file_type: 'jd', s3_key: 'users/owner/interviews/r-1/uploads/jd.pdf' },
  },
  { method: 'POST', resource: '/interviews/{id}/analyze', table: 'test-interviews', key: { PK: 'INTERVIEW#r-1', SK: 'METADATA' }, id: 'r-1', body: {} },
  { method: 'PATCH', resource: '/intelligence-interviews/{id}', table: 'test-intelligence', key: { intelligence_id: 'r-1' }, id: 'r-1', body: { metadata: { position: 'SDE-2' } } },
  { method: 'POST', resource: '/intelligence-interviews/{id}/transcript', table: 'test-intelligence', key: { intelligence_id: 'r-1' }, id: 'r-1', body: { transcript: 'hello' } },
  { method: 'POST', resource: '/intelligence-interviews/{id}/scores', table: 'test-intelligence', key: { intelligence_id: 'r-1' }, id: 'r-1', body: { scores: [] } },
];

describe.each(['VIEWER', 'REVIEWER', 'APPROVER'])(
  'A %s-tier admin is denied on every mutate/delete route they do not own',
  (tier) => {
    test.each(GUARDED_ROUTES)('$method $resource -> 403', async (route) => {
      ddbMock.on(GetCommand).callsFake((input) => {
        if (input.TableName === route.table) {
          return { Item: { owner_user_id: 'someone-else', status: 'COMPLETED' } };
        }
        if (input.TableName === 'test-admin' && input.Key?.SK === 'MEMBER#admin-low') {
          return { Item: { base_role: 'ADMIN' } };
        }
        return {};
      });
      ddbMock.on(QueryCommand).resolves({ Items: [{ tier }] });

      const response = await handler(mockEvent(
        route.method, route.resource, 'admin-low', 'low@minfytech.com', { id: route.id }, route.body,
      ) as any);

      expect(response.statusCode).toBe(403);
      expect(response.body).toContain('Requires OWNER tier');
      // Nothing was written to the record's table.
      expect(ddbMock).not.toHaveReceivedCommandWith(UpdateCommand, { TableName: route.table });
      expect(ddbMock).not.toHaveReceivedCommandWith(DeleteCommand, { TableName: route.table });
    });
  },
);

describe('A plain MEMBER (no admin grant) is denied on the same routes', () => {
  test.each(GUARDED_ROUTES)('$method $resource -> 403', async (route) => {
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.TableName === route.table) {
        return { Item: { owner_user_id: 'someone-else', status: 'COMPLETED' } };
      }
      return {}; // no membership row -> MEMBER, no grant
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const response = await handler(mockEvent(
      route.method, route.resource, 'member-x', 'member@minfytech.com', { id: route.id }, route.body,
    ) as any);

    expect(response.statusCode).toBe(403);
    expect(ddbMock).not.toHaveReceivedCommandWith(UpdateCommand, { TableName: route.table });
    expect(ddbMock).not.toHaveReceivedCommandWith(DeleteCommand, { TableName: route.table });
  });
});

describe('Admin access to mutate/delete routes — the 403 rule', () => {
  test('OWNER admin performs a soft delete on an interview they do not own, with audit', async () => {
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.TableName === 'test-interviews' && input.Key?.PK === 'INTERVIEW#i-999') {
        return { Item: { owner_user_id: 'owner-5', status: 'COMPLETED' } };
      }
      if (input.TableName === 'test-admin' && input.Key?.SK === 'MEMBER#admin-owner') {
        return { Item: { base_role: 'ADMIN' } };
      }
      return {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [{ tier: 'OWNER' }] });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});

    const response = await handler(mockEvent('DELETE', '/interviews/{id}', 'admin-owner', 'owner@minfytech.com', { id: 'i-999' }) as any);

    expect(response.statusCode).toBe(200);
    expect(ddbMock).toHaveReceivedCommandWith(PutCommand, {
      TableName: 'test-admin',
      Item: expect.objectContaining({ entity_type: 'AUDIT_LOG', action: 'SOFT_DELETE', target_id: 'i-999' }),
    });
    expect(ddbMock).toHaveReceivedCommandWith(UpdateCommand, {
      TableName: 'test-interviews',
      Key: { PK: 'INTERVIEW#i-999', SK: 'METADATA' },
      UpdateExpression: expect.stringContaining('deleted_at'),
    });
    expect(ddbMock).not.toHaveReceivedCommandWith(DeleteCommand, { TableName: 'test-interviews' });
  });

  test('Owner deleting their own interview performs a hard delete (no soft delete)', async () => {
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.TableName === 'test-interviews' && input.Key?.PK === 'INTERVIEW#i-owned') {
        return { Item: { owner_user_id: 'owner-self', status: 'COMPLETED' } };
      }
      return {};
    });
    ddbMock.on(DeleteCommand).resolves({});

    const response = await handler(mockEvent('DELETE', '/interviews/{id}', 'owner-self', 'owner@minfytech.com', { id: 'i-owned' }) as any);

    expect(response.statusCode).toBe(200);
    expect(ddbMock).toHaveReceivedCommandWith(DeleteCommand, {
      TableName: 'test-interviews',
      Key: { PK: 'INTERVIEW#i-owned', SK: 'METADATA' },
    });
    expect(ddbMock).not.toHaveReceivedCommandWith(PutCommand, { TableName: 'test-admin' });
  });
});

describe('Audit is synchronous — an admin action that cannot be logged fails', () => {
  test('a rejected audit write turns an OWNER soft delete into a 500 with no mutation', async () => {
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.TableName === 'test-interviews' && input.Key?.PK === 'INTERVIEW#i-x') {
        return { Item: { owner_user_id: 'owner-5' } };
      }
      if (input.TableName === 'test-admin' && input.Key?.SK === 'MEMBER#admin-owner') {
        return { Item: { base_role: 'ADMIN' } };
      }
      return {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [{ tier: 'OWNER' }] });
    ddbMock.on(PutCommand).rejects(new Error('audit down'));

    const response = await handler(mockEvent('DELETE', '/interviews/{id}', 'admin-owner', 'owner@minfytech.com', { id: 'i-x' }) as any);

    expect(response.statusCode).toBe(500);
    expect(ddbMock).not.toHaveReceivedCommandWith(UpdateCommand, { TableName: 'test-interviews' });
  });
});

describe('No self-escalation on membership routes', () => {
  test('OWNER cannot grant themselves a tier', async () => {
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.TableName === 'test-admin' && input.Key?.SK === 'MEMBER#owner-1') {
        return { Item: { base_role: 'ADMIN', email: 'owner@minfytech.com' } };
      }
      return {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [{ tier: 'OWNER' }] });

    const response = await handler(mockEvent('POST', '/admin/members/{userId}/tier', 'owner-1', 'owner@minfytech.com',
      { userId: 'owner-1' }, { tier: 'OWNER' }) as any);

    expect(response.statusCode).toBe(403);
    expect(response.body).toContain('own tier');
    expect(ddbMock).not.toHaveReceivedCommandWith(PutCommand, {
      Item: expect.objectContaining({ entity_type: 'ADMIN_GRANT' }),
    });
  });

  test('OWNER cannot revoke their own tier', async () => {
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.TableName === 'test-admin' && input.Key?.SK === 'MEMBER#owner-1') {
        return { Item: { base_role: 'ADMIN' } };
      }
      return {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [{ tier: 'OWNER' }] });

    const response = await handler(mockEvent('POST', '/admin/members/{userId}/revoke', 'owner-1', 'owner@minfytech.com',
      { userId: 'owner-1' }, {}) as any);

    expect(response.statusCode).toBe(403);
    expect(response.body).toContain('own tier');
  });

  test('OWNER cannot change their own base role', async () => {
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.TableName === 'test-admin' && input.Key?.SK === 'MEMBER#owner-1') {
        return { Item: { base_role: 'ADMIN' } };
      }
      return {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [{ tier: 'OWNER' }] });

    const response = await handler(mockEvent('POST', '/admin/members/{userId}/base-role', 'owner-1', 'owner@minfytech.com',
      { userId: 'owner-1' }, { base_role: 'MEMBER' }) as any);

    expect(response.statusCode).toBe(403);
    expect(response.body).toContain('own base role');
  });
});

describe('Tier grants are append-only', () => {
  test('granting a tier to another admin appends a new AdminGrant row (no overwrite/delete)', async () => {
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.TableName === 'test-admin' && input.Key?.SK === 'MEMBER#owner-1') {
        return { Item: { base_role: 'ADMIN' } };
      }
      if (input.TableName === 'test-admin' && input.Key?.SK === 'MEMBER#target-2') {
        return { Item: { base_role: 'ADMIN', email: 'target2@minfytech.com' } };
      }
      return {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [{ tier: 'OWNER' }] });
    ddbMock.on(PutCommand).resolves({});

    const response = await handler(mockEvent('POST', '/admin/members/{userId}/tier', 'owner-1', 'owner@minfytech.com',
      { userId: 'target-2' }, { tier: 'REVIEWER' }) as any);

    expect(response.statusCode).toBe(200);
    expect(ddbMock).toHaveReceivedCommandWith(PutCommand, {
      TableName: 'test-admin',
      Item: expect.objectContaining({ entity_type: 'ADMIN_GRANT', tier: 'REVIEWER', user_id: 'target-2' }),
    });
    expect(ddbMock).not.toHaveReceivedCommand(DeleteCommand);
  });
});

describe('Comment access is checked against WorkspaceShare, never org membership', () => {
  test('a MEMBER with no share gets 403 posting a comment on a candidate they do not own', async () => {
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.TableName === 'test-admin' && input.Key?.SK === 'MEMBER#member-1') {
        return { Item: { base_role: 'MEMBER' } };
      }
      if (input.TableName === 'test-admin' && input.Key?.SK === 'META') {
        return { Item: { owner_user_id: 'owner-9', status: 'OPEN' } };
      }
      if (input.TableName === 'test-admin' && input.Key?.SK === 'SHARE#member-1') {
        return {};
      }
      return {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const response = await handler(mockEvent('POST', '/workspaces/{id}/comments', 'member-1', 'member@minfytech.com',
      { id: 'ws-1' }, { body: 'looks good' }) as any);

    expect(response.statusCode).toBe(403);
    expect(ddbMock).not.toHaveReceivedCommandWith(PutCommand, {
      Item: expect.objectContaining({ entity_type: 'COMMENT' }),
    });
  });

  test('a COMMENTER share allows posting a comment', async () => {
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.TableName === 'test-admin' && input.Key?.SK === 'MEMBER#member-2') {
        return { Item: { base_role: 'MEMBER' } };
      }
      if (input.TableName === 'test-admin' && input.Key?.SK === 'META') {
        return { Item: { owner_user_id: 'owner-9', status: 'OPEN' } };
      }
      if (input.TableName === 'test-admin' && input.Key?.SK === 'SHARE#member-2') {
        return { Item: { permission: 'COMMENTER' } };
      }
      return {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});

    const response = await handler(mockEvent('POST', '/workspaces/{id}/comments', 'member-2', 'member2@minfytech.com',
      { id: 'ws-2' }, { body: 'strong hire' }) as any);

    expect(response.statusCode).toBe(201);
    expect(ddbMock).toHaveReceivedCommandWith(PutCommand, {
      TableName: 'test-admin',
      Item: expect.objectContaining({ entity_type: 'COMMENT', body: 'strong hire' }),
    });
  });
});
