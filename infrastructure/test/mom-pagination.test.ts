import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddbDocClient } from '../lambdas/shared/aws';
import { handler } from '../lambdas/api-handler/index';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const ddbMock = mockClient(ddbDocClient);

function event(resource: string): Partial<APIGatewayProxyEvent> {
  return {
    httpMethod: 'GET',
    resource,
    requestContext: {
      authorizer: {
        claims: { sub: 'owner-1', email: 'owner@minfytech.com' },
      },
    } as any,
  };
}

function body(response: { body: string }) {
  return JSON.parse(response.body);
}

beforeEach(() => {
  ddbMock.reset();
});

test('GET /moms follows DynamoDB pagination so project pages do not miss older reports', async () => {
  ddbMock
    .on(ScanCommand)
    .resolvesOnce({
      Items: [],
      LastEvaluatedKey: { mom_id: 'page-1-end' },
    })
    .resolvesOnce({
      Items: [{
        mom_id: 'mom-2',
        item_type: 'MOM',
        owner_user_id: 'owner-1',
        status: 'COMPLETED',
        title: 'Peer Review Scope',
        project_id: 'project-1',
        project_title: 'Minfy-Intranet',
        created_at: 10,
        updated_at: 20,
      }],
    });

  const response = await handler(event('/moms') as any);

  expect(response.statusCode).toBe(200);
  expect(body(response).items).toEqual([
    expect.objectContaining({
      mom_id: 'mom-2',
      project_id: 'project-1',
      project_title: 'Minfy-Intranet',
      status: 'COMPLETED',
    }),
  ]);
  expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(2);
  expect(ddbMock.commandCalls(ScanCommand)[1].args[0].input).toEqual(expect.objectContaining({
    ExclusiveStartKey: { mom_id: 'page-1-end' },
  }));
});

test('GET /mom-projects counts reports found after the first DynamoDB scan page', async () => {
  ddbMock
    .on(ScanCommand)
    .resolvesOnce({
      Items: [{
        mom_id: 'PROJECT#project-1',
        item_type: 'PROJECT',
        owner_user_id: 'owner-1',
        project_id: 'project-1',
        project_title: 'Minfy-Intranet',
        created_at: 5,
        updated_at: 5,
      }],
      LastEvaluatedKey: { mom_id: 'page-1-end' },
    })
    .resolvesOnce({
      Items: [{
        mom_id: 'mom-2',
        item_type: 'MOM',
        owner_user_id: 'owner-1',
        status: 'COMPLETED',
        title: 'Peer Review Scope',
        project_id: 'project-1',
        project_title: 'Minfy-Intranet',
        created_at: 10,
        updated_at: 20,
      }],
    });

  const response = await handler(event('/mom-projects') as any);

  expect(response.statusCode).toBe(200);
  expect(body(response).items).toEqual([
    expect.objectContaining({
      project_id: 'project-1',
      project_title: 'Minfy-Intranet',
      mom_count: 1,
      completed_count: 1,
      updated_at: 20,
    }),
  ]);
  expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(2);
});
