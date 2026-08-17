import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddbDocClient } from '../lambdas/shared/aws';
import { invalidateRoleBankCache, loadRoleBankPool, roleKeyForJob } from '../lambdas/api-handler/question-bank-store';
import { selectQuestionsFromBank } from '../lambdas/api-handler/manual-question-bank';
import { ROLE_QUESTION_BANK } from '../lambdas/api-handler/minfy-role-question-bank';

/**
 * Part C — the curated bank must be safe to deploy before it is seeded.
 *
 * Every question-generation path now asks DynamoDB for the pool. If an empty
 * table (or a failing one) produced an empty pool, guides would silently lose
 * their role-specific questions on the deploy that precedes seeding. These tests
 * pin the fallback: with no rows, generation is byte-for-byte what it is today.
 */

const ddbMock = mockClient(ddbDocClient);

const JD = [
  'We are hiring a Migration Architect to lead large-scale VM migrations to AWS.',
  'You will own discovery, wave planning, cutover runbooks and hypercare, and work',
  'with cloud provider programs and funding to land the business case.',
].join(' ');

beforeEach(() => {
  ddbMock.reset();
  invalidateRoleBankCache();
});

afterEach(() => {
  invalidateRoleBankCache();
});

describe('loadRoleBankPool falls back to the shipped bank', () => {
  test('an empty table yields the static array, not an empty pool', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await expect(loadRoleBankPool()).resolves.toBe(ROLE_QUESTION_BANK);
  });

  test('a DynamoDB failure yields the static array rather than an error', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('ResourceNotFoundException'));

    await expect(loadRoleBankPool()).resolves.toBe(ROLE_QUESTION_BANK);
  });

  test('rows that exist win over the static array', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{
        question_id: 'curated-1',
        role_key: 'migration-architect',
        role_title: 'Migration Architect',
        category: 'Core Technical/Functional Skills',
        question: 'Walk me through the riskiest cutover you have run.',
        active: true,
      }],
    });

    const pool = await loadRoleBankPool();

    expect(pool).toHaveLength(1);
    expect(pool[0].id).toBe('curated-1');
  });

  test('soft-deleted rows are dropped, and an all-inactive role falls back', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{
        question_id: 'curated-1',
        role_key: 'migration-architect',
        role_title: 'Migration Architect',
        question: 'Retired question.',
        active: false,
      }],
    });

    await expect(loadRoleBankPool()).resolves.toBe(ROLE_QUESTION_BANK);
  });

  test('paginates rather than stopping at the first page', async () => {
    let call = 0;
    ddbMock.on(QueryCommand).callsFake(() => {
      call += 1;
      return call === 1
        ? { Items: [{ question_id: 'p1', role_title: 'Migration Architect', question: 'One?' }], LastEvaluatedKey: { PK: 'x' } }
        : { Items: [{ question_id: 'p2', role_title: 'Migration Architect', question: 'Two?' }] };
    });

    const pool = await loadRoleBankPool();

    expect(pool.map((entry) => entry.id)).toEqual(['p1', 'p2']);
  });
});

describe('Generation is unchanged before seeding', () => {
  test('the fallback pool produces exactly the no-pool result', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const pool = await loadRoleBankPool();

    const args = { interviewId: 'fixed-seed-1', roleTitle: 'Migration Architect', jdText: JD, count: 8 };
    const withFallbackPool = selectQuestionsFromBank({ ...args, rolePool: pool });
    const asShippedToday = selectQuestionsFromBank(args);

    expect(withFallbackPool).toEqual(asShippedToday);
    expect(withFallbackPool.questions.length).toBeGreaterThan(0);
  });

  test('selection is deterministic for a given interview id', () => {
    const args = { interviewId: 'fixed-seed-2', roleTitle: 'Migration Architect', jdText: JD, count: 8 };

    expect(selectQuestionsFromBank(args)).toEqual(selectQuestionsFromBank(args));
  });
});

describe('roleKeyForJob', () => {
  test('prefers the Keka job id, because two roles can share a title', () => {
    expect(roleKeyForJob({ kekaJobId: 'job-123', jobTitle: 'Migration Architect' })).toBe('job-123');
  });

  test('slugifies the title when there is no job id', () => {
    expect(roleKeyForJob({ jobTitle: 'Migration Architect' })).toBe('migration-architect');
  });
});
