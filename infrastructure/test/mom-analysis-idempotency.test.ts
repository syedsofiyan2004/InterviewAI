import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { ddbDocClient } from '../lambdas/shared/aws';
import { handler } from '../lambdas/api-handler/index';

const ddbMock = mockClient(ddbDocClient);
const s3Mock = mockClient(S3Client);
const sqsMock = mockClient(SQSClient);

const failedMom = {
  mom_id: 'mom-1',
  owner_user_id: 'user-1',
  status: 'FAILED',
  updated_at: 1000,
  transcript_s3_key: 'users/user-1/moms/mom-1/uploads/transcript.txt',
};

function event(): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    resource: '/moms/{id}/analyze',
    pathParameters: { id: 'mom-1' },
    requestContext: { authorizer: { claims: { sub: 'user-1' } } } as any,
  } as unknown as APIGatewayProxyEvent;
}

describe('MOM analysis queue idempotency', () => {
  beforeEach(() => {
    ddbMock.reset();
    s3Mock.reset();
    sqsMock.reset();
    s3Mock.on(HeadObjectCommand).resolves({});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('does not enqueue when another request wins the processing claim', async () => {
    const conditionalError = Object.assign(new Error('claim lost'), {
      name: 'ConditionalCheckFailedException',
    });
    ddbMock.on(GetCommand)
      .resolvesOnce({ Item: failedMom })
      .resolvesOnce({ Item: { ...failedMom, status: 'PROCESSING', updated_at: 2000 } });
    ddbMock.on(UpdateCommand).rejectsOnce(conditionalError);

    const response = await handler(event());

    expect(response.statusCode).toBe(202);
    expect(ddbMock.commandCalls(UpdateCommand)[0].args[0].input.ConditionExpression).toContain('updated_at');
    expect(sqsMock).not.toHaveReceivedCommand(SendMessageCommand);
  });

  test('rolls the record back to failed when SQS rejects the claimed run', async () => {
    ddbMock.on(GetCommand).resolves({ Item: failedMom });
    ddbMock.on(UpdateCommand).resolves({});
    sqsMock.on(SendMessageCommand).rejects(new Error('SQS unavailable'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await handler(event());

    expect(response.statusCode).toBe(502);
    const updates = ddbMock.commandCalls(UpdateCommand);
    expect(updates).toHaveLength(2);
    expect(updates[1].args[0].input.ExpressionAttributeValues).toEqual(expect.objectContaining({
      ':failed': 'FAILED',
      ':message': 'The MOM analysis could not be started. Please retry.',
    }));
  });
});
