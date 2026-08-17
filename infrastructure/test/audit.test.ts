import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddbDocClient } from '../lambdas/shared/aws';
import { writeAuditLog } from '../lambdas/api-handler/audit';

const ddbMock = mockClient(ddbDocClient);

beforeEach(() => ddbMock.reset());

describe('writeAuditLog', () => {
  test('writes a date-partitioned append row with the actor GSI populated', async () => {
    ddbMock.on(PutCommand).resolves({});
    const entry = await writeAuditLog({
      actorUserId: 'admin-1',
      actorEmail: 'admin@minfytech.com',
      action: 'READ_INTERVIEW',
      targetType: 'interview',
      targetId: 'i-123',
      targetOwnerUserId: 'owner-9',
      now: 1_700_000_000_000,
    });

    expect(entry.PK).toBe('AUDIT#2023-11-14');
    expect(entry.SK.startsWith('1700000000000#')).toBe(true);
    expect(entry.action).toBe('READ_INTERVIEW');
    expect(entry.gsi3_pk).toBe('admin-1');   // actor -> their actions
    expect(entry.gsi3_sk).toBe(1_700_000_000_000);

    expect(ddbMock).toHaveReceivedCommandWith(PutCommand, {
      TableName: 'test-admin',
      Item: expect.objectContaining({ entity_type: 'AUDIT_LOG', target_id: 'i-123' }),
    });
  });

  test('a failed audit write propagates (never swallowed) so the caller can 500', async () => {
    ddbMock.on(PutCommand).rejects(new Error('ddb down'));
    await expect(writeAuditLog({
      actorUserId: 'admin-1',
      action: 'SOFT_DELETE',
    })).rejects.toThrow('ddb down');
  });
});
