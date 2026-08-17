import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddbDocClient } from '../lambdas/shared/aws';
import { handler } from '../lambdas/api-handler/index';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const ddbMock = mockClient(ddbDocClient);
const lambdaMock = mockClient(LambdaClient);

beforeEach(() => {
  ddbMock.reset();
  lambdaMock.reset();
});

interface RouteCase {
  method: string;
  resource: string;
  pathParameters?: Record<string, string>;
  body?: any;
}

function mockEvent(route: RouteCase, userId: string, email: string): Partial<APIGatewayProxyEvent> {
  return {
    httpMethod: route.method,
    resource: route.resource,
    pathParameters: route.pathParameters || {},
    body: route.body ? JSON.stringify(route.body) : null,
    requestContext: { authorizer: { claims: { sub: userId, email } } } as any,
  } as any;
}

/** ADMIN base role with the given grant tier. */
function asAdminWithTier(tier: string) {
  ddbMock.on(GetCommand).callsFake((input) => {
    if (input.TableName === 'test-admin' && String(input.Key?.SK || '').startsWith('MEMBER#')) {
      return { Item: { base_role: 'ADMIN' } };
    }
    return {};
  });
  ddbMock.on(QueryCommand).resolves({ Items: [{ tier }] });
}

/** A plain member: no membership row at all, no grant. */
function asPlainMember() {
  ddbMock.on(GetCommand).resolves({});
  ddbMock.on(QueryCommand).resolves({ Items: [] });
}

/**
 * Part C — the question bank and the on-demand Keka sweep are org-wide
 * configuration, gated at the top tier. Asserted per route, not sampled: a route
 * that forgets its gate is a privilege hole, and there are seven of them.
 */
const OWNER_ROUTES: RouteCase[] = [
  { method: 'POST', resource: '/admin/keka-sync' },
  { method: 'GET', resource: '/admin/question-bank' },
  { method: 'GET', resource: '/admin/question-bank/{roleKey}', pathParameters: { roleKey: 'migration-architect' } },
  {
    method: 'PATCH', resource: '/admin/question-bank/{roleKey}',
    pathParameters: { roleKey: 'migration-architect' },
    body: { competencies: ['Large-scale VM migration'] },
  },
  {
    method: 'POST', resource: '/admin/question-bank/{roleKey}/questions',
    pathParameters: { roleKey: 'migration-architect' },
    body: { category: 'Core Technical/Functional Skills', question: 'Walk me through a migration you led end to end.' },
  },
  {
    method: 'PATCH', resource: '/admin/question-bank/{roleKey}/questions/{questionId}',
    pathParameters: { roleKey: 'migration-architect', questionId: 'q-1' },
    body: { question: 'Walk me through the riskiest cutover you have run.' },
  },
  {
    method: 'DELETE', resource: '/admin/question-bank/{roleKey}/questions/{questionId}',
    pathParameters: { roleKey: 'migration-architect', questionId: 'q-1' },
  },
];

/** Part D — composite synthesis is a hiring-decision artifact. */
const APPROVER_ROUTES: RouteCase[] = [
  { method: 'POST', resource: '/workspaces/{id}/composite-analysis', pathParameters: { id: 'ws-1' } },
];

/** Part E — manual candidate/workspace creation is an admin tool. */
const REVIEWER_ROUTES: RouteCase[] = [
  {
    method: 'POST', resource: '/intelligence-interviews',
    body: { source_mode: 'manual', job: { title: 'Migration Architect', description: 'x' }, candidate: { name: 'A' } },
  },
  { method: 'POST', resource: '/workspaces', body: { title: 'Manual workspace' } },
  { method: 'GET', resource: '/keka/jobs' },
  {
    method: 'GET', resource: '/keka/jobs/{jobId}/candidates',
    pathParameters: { jobId: 'job-1' },
  },
  {
    method: 'GET', resource: '/keka/jobs/{jobId}/candidates/{candidateId}/interviews',
    pathParameters: { jobId: 'job-1', candidateId: 'candidate-1' },
  },
];

/** A write to the admin table would mean the gate let the request through. */
function expectNoAdminWrites() {
  expect(ddbMock).not.toHaveReceivedCommandWith(PutCommand, { TableName: 'test-admin' });
  expect(ddbMock).not.toHaveReceivedCommandWith(UpdateCommand, { TableName: 'test-admin' });
  expect(ddbMock).not.toHaveReceivedCommandWith(PutCommand, { TableName: 'test-intelligence' });
}

describe.each([
  ['OWNER', OWNER_ROUTES, ['VIEWER', 'REVIEWER', 'APPROVER']],
  ['APPROVER', APPROVER_ROUTES, ['VIEWER', 'REVIEWER']],
  ['REVIEWER', REVIEWER_ROUTES, ['VIEWER']],
] as Array<[string, RouteCase[], string[]]>)(
  'A capability gated at %s',
  (required, routes, insufficientTiers) => {
    describe.each(insufficientTiers)(`is denied to a %s-tier admin`, (tier) => {
      test.each(routes)('$method $resource -> 403', async (route) => {
        asAdminWithTier(tier);

        const response = await handler(mockEvent(route, 'admin-low', 'low@minfytech.com') as any);

        expect(response.statusCode).toBe(403);
        expect(response.body).toContain(`Requires ${required} tier`);
        expectNoAdminWrites();
        expect(lambdaMock).not.toHaveReceivedCommand(InvokeCommand);
      });
    });

    describe('is denied to a plain member with no grant', () => {
      test.each(routes)('$method $resource -> 403', async (route) => {
        asPlainMember();

        const response = await handler(mockEvent(route, 'member-x', 'member@minfytech.com') as any);

        expect(response.statusCode).toBe(403);
        expect(response.body).toContain('Admin access required');
        expectNoAdminWrites();
        expect(lambdaMock).not.toHaveReceivedCommand(InvokeCommand);
      });
    });

    describe('is denied to an ADMIN holding no grant at all', () => {
      test.each(routes)('$method $resource -> 403', async (route) => {
        ddbMock.on(GetCommand).callsFake((input) => (
          input.TableName === 'test-admin' && String(input.Key?.SK || '').startsWith('MEMBER#')
            ? { Item: { base_role: 'ADMIN' } }
            : {}
        ));
        ddbMock.on(QueryCommand).resolves({ Items: [] });

        const response = await handler(mockEvent(route, 'admin-nogrant', 'nogrant@minfytech.com') as any);

        expect(response.statusCode).toBe(403);
        expect(response.body).toContain('No admin grant');
        expectNoAdminWrites();
      });
    });
  },
);

describe('The same routes are reachable at the required tier (the gate is not a wall)', () => {
  test('OWNER reaches the question bank listing', async () => {
    asAdminWithTier('OWNER');
    ddbMock.on(QueryCommand).resolves({ Items: [{ tier: 'OWNER' }] });
    // Grant lookup and the GSI1 role listing both use QueryCommand; distinguish
    // them by the index so the listing gets rows rather than a grant row.
    ddbMock.on(QueryCommand).callsFake((input) => (
      input.IndexName === 'GSI1_OrgRecency'
        ? { Items: [{ role_key: 'migration-architect', role_title: 'Migration Architect', competencies: ['Large-scale VM migration'] }] }
        : { Items: [{ tier: 'OWNER' }] }
    ));

    const response = await handler(mockEvent(OWNER_ROUTES[1], 'admin-owner', 'owner@minfytech.com') as any);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).items[0].role_key).toBe('migration-architect');
  });

  test('APPROVER queues composite analysis instead of running it inline', async () => {
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.TableName === 'test-admin' && String(input.Key?.SK || '').startsWith('MEMBER#')) {
        return { Item: { base_role: 'ADMIN' } };
      }
      if (input.TableName === 'test-admin' && input.Key?.SK === 'META') {
        return {
          Item: {
            workspace_id: 'ws-1',
            owner_user_id: 'someone-else',
            linked_records: [{ record_type: 'intelligence', record_id: 'i-1' }],
          },
        };
      }
      return {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [{ tier: 'APPROVER' }] });
    ddbMock.on(UpdateCommand).resolves({});
    lambdaMock.on(InvokeCommand).resolves({ StatusCode: 202 });

    const response = await handler(mockEvent(APPROVER_ROUTES[0], 'admin-appr', 'appr@minfytech.com') as any);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).composite_status).toBe('processing');
    // Queued, not computed: the request must return before the model runs.
    expect(lambdaMock).toHaveReceivedCommand(InvokeCommand);
    expect(ddbMock).toHaveReceivedCommandWith(UpdateCommand, {
      TableName: 'test-admin',
      UpdateExpression: expect.stringContaining('composite_status'),
    });
  });

  test('a second trigger while one is in flight does not queue a duplicate model call', async () => {
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.TableName === 'test-admin' && String(input.Key?.SK || '').startsWith('MEMBER#')) {
        return { Item: { base_role: 'ADMIN' } };
      }
      if (input.TableName === 'test-admin' && input.Key?.SK === 'META') {
        return {
          Item: {
            workspace_id: 'ws-1',
            owner_user_id: 'someone-else',
            composite_status: 'processing',
            linked_records: [{ record_type: 'intelligence', record_id: 'i-1' }],
          },
        };
      }
      return {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [{ tier: 'APPROVER' }] });

    const response = await handler(mockEvent(APPROVER_ROUTES[0], 'admin-appr', 'appr@minfytech.com') as any);

    expect(response.statusCode).toBe(200);
    expect(lambdaMock).not.toHaveReceivedCommand(InvokeCommand);
  });
});
