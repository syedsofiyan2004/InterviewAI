import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { DeleteCommand, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { ddbDocClient } from '../lambdas/shared/aws';
import { deleteCalculation } from '../lambdas/api-handler/calculator-routes';
import { adminListCalculations } from '../lambdas/api-handler/admin-routes';

/**
 * Deleting an estimate, and the org-wide admin list.
 *
 * The delete is a hard one — an estimate is a disposable working document — so the
 * ownership boundary matters more than usual: there is no soft-delete to recover
 * from. And the admin list is a read across every user's rows, so it has to be
 * gated and must not become a way to reach one estimate you do not own.
 */

const ddbMock = mockClient(ddbDocClient);
const s3Mock = mockClient(S3Client);

const OWNER = 'user-owner';
const OTHER = 'user-other';
const ID = 'calc-1';

const record = (overrides: Record<string, unknown> = {}) => ({
  calculation_id: ID,
  owner_user_id: OWNER,
  owner_email: 'owner@minfytech.com',
  name: 'Template Project',
  prompt: 'two web servers',
  status: 'COMPLETED',
  created_at: Date.now(),
  updated_at: Date.now(),
  input_s3_key: `users/${OWNER}/calculator/uploads/abc-resources.xlsx`,
  result: { url: 'https://calculator.aws/#/estimate?id=x', currency: 'USD', monthlyTotal: 269.65, lineItems: [{ service: 'EC2' }] },
  ...overrides,
});

function event(userId: string | null, email = 'owner@minfytech.com'): APIGatewayProxyEvent {
  return {
    httpMethod: 'DELETE',
    resource: '/calculator/{id}',
    pathParameters: { id: ID },
    requestContext: { authorizer: { claims: userId ? { sub: userId, email } : {} } },
  } as unknown as APIGatewayProxyEvent;
}

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  ddbMock.on(DeleteCommand).resolves({});
  s3Mock.on(DeleteObjectCommand).resolves({});
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Deleting an estimate', () => {
  test('the owner removes the row, the uploaded sheet and the PDF', async () => {
    // All three or none: an orphaned sheet in the bucket has nothing pointing at it
    // and would sit there indefinitely.
    ddbMock.on(GetCommand).resolves({ Item: record() });

    const response = await deleteCalculation(ID, event(OWNER));

    expect(response.statusCode).toBe(200);
    expect(ddbMock).toHaveReceivedCommandWith(DeleteCommand, {
      TableName: 'test-calculations',
      Key: { calculation_id: ID },
    });
    const deletedKeys = s3Mock.commandCalls(DeleteObjectCommand).map((call) => call.args[0].input.Key);
    expect(deletedKeys).toContain(`users/${OWNER}/calculator/uploads/abc-resources.xlsx`);
    expect(deletedKeys).toContain(`users/${OWNER}/calculator/${ID}/estimate.pdf`);
  });

  test('someone else gets 404 and nothing is deleted', async () => {
    // 404 rather than 403, so this cannot be used to discover that an id exists.
    ddbMock.on(GetCommand).resolves({ Item: record() });

    const response = await deleteCalculation(ID, event(OTHER, 'other@minfytech.com'));

    expect(response.statusCode).toBe(404);
    expect(ddbMock).not.toHaveReceivedCommand(DeleteCommand);
    expect(s3Mock).not.toHaveReceivedCommand(DeleteObjectCommand);
  });

  test('an unauthenticated caller is refused before any lookup', async () => {
    const response = await deleteCalculation(ID, event(null));

    expect(response.statusCode).toBe(401);
    expect(ddbMock).not.toHaveReceivedCommand(DeleteCommand);
  });

  test('a missing id is a validation error, not a delete of something else', async () => {
    expect((await deleteCalculation(undefined, event(OWNER))).statusCode).toBe(400);
    expect(ddbMock).not.toHaveReceivedCommand(DeleteCommand);
  });

  test('an estimate with no uploaded sheet still deletes cleanly', async () => {
    ddbMock.on(GetCommand).resolves({ Item: record({ input_s3_key: undefined }) });

    const response = await deleteCalculation(ID, event(OWNER));

    expect(response.statusCode).toBe(200);
    // All generated files, and an undefined input key must not become "undefined".
    const keys = s3Mock.commandCalls(DeleteObjectCommand).map((call) => call.args[0].input.Key);
    expect(keys).toEqual([
      ...['pdf', 'xlsx', 'docx'].map((ext) => `users/${OWNER}/calculator/${ID}/estimate.${ext}`),
      `users/${OWNER}/calculator/${ID}/result.json`,
    ]);
  });

  test('an S3 object that will not delete does not block removing the row', async () => {
    // Otherwise a stray permissions problem would leave the user permanently unable
    // to tidy their own list.
    ddbMock.on(GetCommand).resolves({ Item: record() });
    s3Mock.on(DeleteObjectCommand).rejects(new Error('AccessDenied'));

    const response = await deleteCalculation(ID, event(OWNER));

    expect(response.statusCode).toBe(200);
    expect(ddbMock).toHaveReceivedCommand(DeleteCommand);
  });
});

describe('The org-wide estimate list', () => {
  /** ADMIN base role with the given tier. */
  function asAdminWithTier(tier: string) {
    ddbMock.on(GetCommand).callsFake((input) => (
      input.TableName === 'test-admin' && String(input.Key?.SK || '').startsWith('MEMBER#')
        ? { Item: { base_role: 'ADMIN' } }
        : {}
    ));
    ddbMock.on(ScanCommand).resolves({
      Items: [
        record({ calculation_id: 'a', name: 'Older', created_at: 1000 }),
        record({ calculation_id: 'b', name: 'Newer', created_at: 2000, owner_email: 'someone@minfytech.com' }),
      ],
    });
    return { tier };
  }

  function adminEvent(userId: string) {
    return {
      httpMethod: 'GET',
      resource: '/admin/calculator',
      pathParameters: {},
      requestContext: { authorizer: { claims: { sub: userId, email: 'admin@minfytech.com' } } },
    } as unknown as APIGatewayProxyEvent;
  }

  test('a VIEWER admin sees every estimate, newest first', async () => {
    const { tier } = asAdminWithTier('VIEWER');
    ddbMock.on(require('@aws-sdk/lib-dynamodb').QueryCommand).resolves({ Items: [{ tier }] });

    const response = await adminListCalculations(adminEvent('admin-1'));

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.items.map((item: any) => item.name)).toEqual(['Newer', 'Older']);
    // The list is only useful if it names a person rather than a Cognito sub.
    expect(body.items[0].owner_email).toBe('someone@minfytech.com');
    expect(body.items[0].monthly_total).toBe(269.65);
    expect(body.items[0].href).toContain('/calculator/view?id=');
  });

  test('a plain member is refused', async () => {
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(require('@aws-sdk/lib-dynamodb').QueryCommand).resolves({ Items: [] });

    const response = await adminListCalculations(adminEvent('member-1'));

    expect(response.statusCode).toBe(403);
    expect(response.body).toContain('Admin access required');
  });
});
