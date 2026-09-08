/**
 * Harness driver reliability regressions (pre-deploy corrections).
 *
 * Three guarantees around the request_user_input resume:
 *
 *  1. The pending pause is cleared ONLY after InvokeHarness is accepted. If
 *     agentCore.send throws, the record must still say WAITING_FOR_INPUT with the full
 *     pending tool state so the same customer answer can be retried — never lost.
 *
 *  2. Exactly ONE request_user_input is supported per pause. A continuation that cannot
 *     cleanly resume the paused request (no structured answer) must NOT be converted into
 *     a "continue without it" step: the driver keeps WAITING_FOR_INPUT.
 *
 *  3. A real one-question answer still resumes on the SAME runtimeSessionId by replaying
 *     the original assistant toolUse followed by the customer's toolResult.
 *
 * Classification: MOCKED.
 */

import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { BedrockAgentCoreClient, InvokeHarnessCommand } from '@aws-sdk/client-bedrock-agentcore';
import { s3Client } from '../lambdas/shared/aws';
import { ddbDocClient } from '../lambdas/shared/aws';

const ddbMock = mockClient(ddbDocClient);
const agentCoreMock = mockClient(BedrockAgentCoreClient);
const s3Mock = mockClient(s3Client);

const SESSION_ID = 'mimo-calc-1-abcdefghijklmnopqrstuvwxyz012345';

const waitingRecord = () => ({
  calculation_id: 'calc-1',
  owner_user_id: 'user-1',
  name: 'Region test',
  status: 'WAITING_FOR_INPUT',
  execution_mode: 'agentcore-runtime',
  agent_session_id: SESSION_ID,
  pending_tool_use_id: 'tooluse_abc',
  pending_tool_name: 'request_user_input',
  pending_tool_input: {
    questionId: 'q-region',
    type: 'CHOICE',
    title: 'Primary region',
    question: 'Which region should this run in?',
    reason: 'The workbook does not name a region.',
    choices: [{ value: 'ap-south-1', label: 'Mumbai' }],
  },
  pending_tool_uses: [{
    toolUseId: 'tooluse_abc',
    name: 'request_user_input',
    input: {
      questionId: 'q-region',
      type: 'CHOICE',
      title: 'Primary region',
      question: 'Which region should this run in?',
      reason: 'The workbook does not name a region.',
      choices: [{ value: 'ap-south-1', label: 'Mumbai' }],
    },
  }],
  agent_questions: [{
    questionId: 'q-region',
    type: 'CHOICE',
    question: 'Which region should this run in?',
    reason: 'The workbook does not name a region.',
    choices: [{ value: 'ap-south-1', label: 'Mumbai' }],
  }],
});

// Imported lazily so the driver's module-level env reads happen after setup-env.ts.
const load = () => require('../lambdas/calculator-harness-driver');

beforeEach(() => {
  ddbMock.reset();
  agentCoreMock.reset();
  s3Mock.reset();
  ddbMock.on(GetCommand).resolves({ Item: waitingRecord() });
  ddbMock.on(UpdateCommand).resolves({});
  s3Mock.onAnyCommand().resolves({});
});

describe('request_user_input resume: pending state survives an InvokeHarness throw', () => {
  it('does not clear the pending pause when the continuation send is rejected', async () => {
    const answer = { questionId: 'q-region', value: 'ap-south-1', applyToSimilarResources: false };
    agentCoreMock.on(InvokeHarnessCommand).rejects(new Error('ThrottlingException'));

    const { handler } = load();
    await expect(handler({
      calculationId: 'calc-1',
      sessionId: SESSION_ID,
      iteration: 1,
      answers: [answer],
    })).rejects.toThrow('ThrottlingException');

    // The clearing patch must come only after a successful send, so on a throw nothing
    // touched the record: it still says WAITING_FOR_INPUT with the pending tool state,
    // which is what lets the answer route retry the same answer.
    expect(ddbMock).not.toHaveReceivedCommand(UpdateCommand);
  });

  it('keeps WAITING_FOR_INPUT when a continuation has no structured answer, rather than skipping the question', async () => {
    const { handler } = load();
    // A legacy text continuation (`userAnswer` only) must not run over an active pause:
    // there is no customer answer for the material question, so the driver refuses to
    // resume and keeps the wait state for a safe retry.
    const output = await handler({
      calculationId: 'calc-1',
      sessionId: SESSION_ID,
      iteration: 1,
      userAnswer: 'ap-south-1',
    });

    expect(output).toMatchObject({ done: true, status: 'WAITING_FOR_INPUT' });
    expect(agentCoreMock).not.toHaveReceivedCommand(InvokeHarnessCommand);
  });
});

describe('request_user_input resume: one answered question still resumes correctly', () => {
  it('replays assistant toolUse + user toolResult on the SAME session and only then clears the pause', async () => {
    const answer = { questionId: 'q-region', value: 'ap-south-1', applyToSimilarResources: false };
    agentCoreMock.on(InvokeHarnessCommand).resolves({});

    const { handler } = load();
    await handler({
      calculationId: 'calc-1',
      sessionId: SESSION_ID,
      iteration: 1,
      answers: [answer],
    });

    const call = agentCoreMock.commandCalls(InvokeHarnessCommand)[0].args[0].input as any;
    // Same runtimeSessionId — AgentCore continues the conversation rather than restarting.
    expect(call.runtimeSessionId).toBe(SESSION_ID);
    expect(call.messages[0].role).toBe('assistant');
    expect(call.messages[0].content[0].toolUse).toMatchObject({
      toolUseId: 'tooluse_abc',
      name: 'request_user_input',
    });
    expect(call.messages[1].role).toBe('user');
    const toolResult = call.messages[1].content[0].toolResult;
    expect(toolResult.status).toBe('success');
    expect(toolResult.toolUseId).toBe('tooluse_abc');
    expect(JSON.parse(toolResult.content[0].text)).toEqual({
      value: 'ap-south-1',
      applyToSimilarResources: false,
    });

    // The pause is cleared only after the Harness accepted the continuation (send
    // returned), so the very first UpdateCommand is the clearing write — and it is the
    // transition to BUILDING, not a silent deletion.
    const firstUpdate = ddbMock.commandCalls(UpdateCommand)[0].args[0].input as any;
    expect(JSON.stringify(firstUpdate)).toContain('pending_tool_use_id');
    expect(JSON.stringify(firstUpdate)).toContain('agent_questions');
    expect(JSON.stringify(firstUpdate)).toContain('BUILDING');
  });
});

describe('request_user_input resume: an exhausted retry never FAILs an unaccepted interrupt', () => {
  it('state-machine catch restores WAITING_FOR_INPUT with the pending question and SAME session, not FAILED', async () => {
    // Mirrors MarkCalculationFailed: the resume driver invocation threw (InvokeHarness
    // rejected), SFN retries exhausted, and the catch re-entered the driver in fail mode.
    const { handler } = load();
    const output = await handler({
      calculationId: 'calc-1',
      mode: 'fail',
      errorInfo: { Error: 'InvokeHarness failed after retries' },
    });

    expect(output).toMatchObject({ done: true, status: 'WAITING_FOR_INPUT' });
    // Same agent_session_id is reported back, so a retry resumes the same conversation.
    expect(output.sessionId).toBe(SESSION_ID);

    const update = ddbMock.commandCalls(UpdateCommand)[0].args[0].input as any;
    const serialized = JSON.stringify(update);
    expect(serialized).toContain('WAITING_FOR_INPUT');
    expect(serialized).toContain("We couldn't continue with that answer. Please try again.");
    // Not a FAILED conversion, and the durable pause is neither cleared nor rewritten, so
    // the answer route can accept the same answer again.
    expect(serialized).not.toContain('FAILED');
    expect(serialized).not.toContain('pending_tool_use_id');
    expect(serialized).not.toContain('agent_questions');
    expect(serialized).not.toContain('agent_session_id');
    expect(ddbMock).toHaveReceivedCommandTimes(UpdateCommand, 1);
  });

  it('keeps FAILED for an ordinary (non-interrupt) driver failure', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        ...waitingRecord(),
        status: 'BUILDING',
        progress_stage: 'BUILDING',
        pending_tool_use_id: undefined,
        pending_tool_name: undefined,
        pending_tool_input: undefined,
        pending_tool_uses: undefined,
        agent_questions: undefined,
      },
    });
    const { handler } = load();
    const output = await handler({ calculationId: 'calc-1', mode: 'fail', errorInfo: { Error: 'boom' } });

    expect(output).toMatchObject({ done: true, status: 'FAILED' });
    const serialized = JSON.stringify(ddbMock.commandCalls(UpdateCommand)[0].args[0].input as any);
    expect(serialized).toContain('FAILED');
  });
});
