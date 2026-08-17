import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { ddbDocClient } from '../lambdas/shared/aws';
import { keys } from '../schema/admin';
import { runCompositeAnalysisWorker } from '../lambdas/api-handler/workspace-routes';

/**
 * Part D — "Analyze All Rounds".
 *
 * The action is offered as soon as ONE linked round reports a completed status,
 * but a round only carries a scorecard once its AI review has actually run. That
 * gap produced two bad outcomes: a workspace where no round had been reviewed
 * failed with "please retry" — advice that can never succeed — and a workspace
 * where some rounds had been reviewed silently synthesised the subset while the
 * heading still claimed to cover every round. Both are pinned here.
 */

const ddbMock = mockClient(ddbDocClient);
const bedrockMock = mockClient(BedrockRuntimeClient);

const WS = 'ws-1';

const round = (id: string, opts: { reviewed: boolean; title: string }) => ({
  intelligence_id: id,
  keka: { title: opts.title },
  owner_email: 'panel@minfytech.com',
  ...(opts.reviewed
    ? {
      aiEvaluation: {
        generatedAt: 1,
        candidateEvaluation: {
          candidateScore: 72,
          summary: 'Solid migration depth.',
          strengths: ['Wave planning'],
          concerns: ['Limited cutover ownership'],
          recommendation: 'hire',
        },
      },
    }
    : {}),
});

/** Workspace META plus each linked round, routed by key. */
function given(rounds: Array<{ id: string; reviewed: boolean; title: string }>) {
  ddbMock.on(GetCommand).callsFake((input) => {
    if (input.Key?.SK === keys.workspaceMetaSk()) {
      return {
        Item: {
          workspace_id: WS,
          linked_records: rounds.map((r) => ({ record_type: 'intelligence', record_id: r.id, label: r.title })),
        },
      };
    }
    const match = rounds.find((r) => r.id === input.Key?.intelligence_id);
    return match ? { Item: round(match.id, match) } : {};
  });
}

function modelReturns(payload: unknown) {
  bedrockMock.on(InvokeModelCommand).resolves({
    body: new TextEncoder().encode(JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify(payload) }],
    })),
  } as any);
}

/** The terminal write — the row the UI actually reads. */
function finalWrite() {
  const calls = ddbMock.commandCalls(UpdateCommand)
    .map((call) => call.args[0].input as any)
    .filter((input) => String(input.UpdateExpression).includes('composite_status'));
  return calls[calls.length - 1];
}

beforeEach(() => {
  ddbMock.reset();
  bedrockMock.reset();
  ddbMock.on(UpdateCommand).resolves({});
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('A workspace with no reviewed round fails with something the user can act on', () => {
  test('the single-round case names the missing step instead of saying retry', async () => {
    given([{ id: 'i-1', reviewed: false, title: 'Technical Round 1' }]);

    await runCompositeAnalysisWorker(WS);

    const write = finalWrite();
    expect(write.ExpressionAttributeValues[':s']).toBe('failed');
    expect(write.ExpressionAttributeValues[':err']).toBe(
      'This round has no completed AI review yet, so there is nothing to synthesise. Run the AI review on the round first.',
    );
    // "Please retry" is the one thing that cannot help here.
    expect(write.ExpressionAttributeValues[':err']).not.toContain('retry');
    expect(bedrockMock).not.toHaveReceivedCommand(InvokeModelCommand);
  });

  test('the multi-round case says how many rounds are waiting', async () => {
    given([
      { id: 'i-1', reviewed: false, title: 'Technical Round 1' },
      { id: 'i-2', reviewed: false, title: 'Technical Round 2' },
      { id: 'i-3', reviewed: false, title: 'Managerial' },
    ]);

    await runCompositeAnalysisWorker(WS);

    expect(finalWrite().ExpressionAttributeValues[':err']).toContain('None of the 3 linked rounds');
  });

  test('a genuine model failure still tells the user to retry', async () => {
    // The distinction matters in both directions: a transient Bedrock fault IS
    // worth retrying, and must not inherit the precondition wording.
    given([{ id: 'i-1', reviewed: true, title: 'Technical Round 1' }]);
    bedrockMock.on(InvokeModelCommand).rejects(new Error('ThrottlingException'));

    await runCompositeAnalysisWorker(WS);

    expect(finalWrite().ExpressionAttributeValues[':err']).toBe('Failed to generate composite analysis. Please retry.');
  });
});

describe('A partial synthesis says which rounds it covers', () => {
  test('rounds without a review are counted and named, not silently dropped', async () => {
    given([
      { id: 'i-1', reviewed: true, title: 'Technical Round 1' },
      { id: 'i-2', reviewed: false, title: 'Technical Round 2' },
      { id: 'i-3', reviewed: false, title: 'Managerial' },
    ]);
    modelReturns({ compositeScore: 71, overallSummary: 'Promising.', keyStrengths: [], majorConcerns: [], finalRecommendation: 'proceed' });

    const response = await runCompositeAnalysisWorker(WS);

    expect(JSON.parse(response.body)).toEqual(expect.objectContaining({ rounds_used: 1, rounds_total: 3 }));
    const write = finalWrite();
    expect(write.ExpressionAttributeValues[':s']).toBe('done');
    expect(write.ExpressionAttributeValues[':used']).toBe(1);
    expect(write.ExpressionAttributeValues[':total']).toBe(3);
    expect(write.ExpressionAttributeValues[':skipped']).toEqual(['Technical Round 2', 'Managerial']);
  });

  test('when every round contributed, used and total agree', async () => {
    given([
      { id: 'i-1', reviewed: true, title: 'Technical Round 1' },
      { id: 'i-2', reviewed: true, title: 'Technical Round 2' },
    ]);
    modelReturns({ compositeScore: 80, overallSummary: 'Strong.', keyStrengths: [], majorConcerns: [], finalRecommendation: 'recommend' });

    await runCompositeAnalysisWorker(WS);

    const write = finalWrite();
    expect(write.ExpressionAttributeValues[':used']).toBe(2);
    expect(write.ExpressionAttributeValues[':total']).toBe(2);
    expect(write.ExpressionAttributeValues[':skipped']).toEqual([]);
  });

  test('every reviewed round reaches the model, not just the first', async () => {
    given([
      { id: 'i-1', reviewed: true, title: 'Technical Round 1' },
      { id: 'i-2', reviewed: true, title: 'Technical Round 2' },
    ]);
    modelReturns({ compositeScore: 80, overallSummary: 'Strong.', keyStrengths: [], majorConcerns: [], finalRecommendation: 'recommend' });

    await runCompositeAnalysisWorker(WS);

    const sent = bedrockMock.commandCalls(InvokeModelCommand)[0].args[0].input as any;
    const prompt = JSON.parse(sent.body).messages[0].content[0].text as string;
    expect(prompt).toContain('Technical Round 1');
    expect(prompt).toContain('Technical Round 2');
    // The scorecard fields are read from the record, so a renamed path would show
    // up here as "undefined" reaching the model.
    expect(prompt).not.toContain('undefined');
  });
});
