/**
 * Pre-deploy reliability regression (final correction): answering a WAITING_FOR_INPUT
 * request_user_input pause must NOT clear the interrupt before the harness accepts the
 * resumed continuation.
 *
 * The answer route used to stamp the record ANALYZING and REMOVE agent_questions the moment
 * StartExecution returned. That undermined the driver's clear-after-accept contract: if the
 * resumed InvokeHarness then failed, the durable pause was already gone and the customer's
 * answer could not be retried. Now, for a real interrupt, the route only records that a
 * resume was requested (execution ARN + resume_requested_at + structured agent_answers) and
 * leaves status/progress/pending tool state and agent_questions untouched. The driver is the sole
 * writer that clears the pause and moves WAITING_FOR_INPUT -> BUILDING, only after
 * agentCore.send returns (covered by the calculator-agentcore-driver-reliability tests).
 *
 * Classification: MOCKED.
 */

import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { ddbDocClient } from '../lambdas/shared/aws';

const ddbMock = mockClient(ddbDocClient);
const sfnMock = mockClient(SFNClient);

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
    question: 'Which region should this run in?',
  },
  pending_tool_uses: [{
    toolUseId: 'tooluse_abc',
    name: 'request_user_input',
    input: {
      questionId: 'q-region',
      type: 'CHOICE',
      question: 'Which region should this run in?',
    },
  }],
  agent_questions: [{
    questionId: 'q-region',
    type: 'CHOICE',
    question: 'Which region should this run in?',
  }],
  created_at: 1,
  updated_at: 1,
});

const event = (body: unknown) => ({
  body: JSON.stringify(body),
  requestContext: { authorizer: { claims: { sub: 'user-1' } } },
}) as never;

beforeEach(() => {
  ddbMock.reset();
  sfnMock.reset();
  ddbMock.on(GetCommand).resolves({ Item: waitingRecord() });
  ddbMock.on(UpdateCommand).resolves({});
  sfnMock.on(StartExecutionCommand).resolves({
    executionArn: 'arn:aws:states:ap-south-1:123456789012:execution:sm/calc-1-cont-resume',
  });
});

describe('answerCalculationQuestion on a WAITING_FOR_INPUT request_user_input pause', () => {
  it('keeps agent_questions and pending_tool_* after StartExecution succeeds, recording only the resume request', async () => {
    // Imported lazily so the module-level env reads in calculator-routes happen after
    // test/setup-env.ts has run.
    const { answerCalculationQuestion } = require('../lambdas/api-handler/calculator-routes');

    const res = await answerCalculationQuestion('calc-1', event({
      answer: { questionId: 'q-region', value: 'ap-south-1', applyToSimilarResources: false },
      answers: [{ questionId: 'q-region', value: 'ap-south-1', applyToSimilarResources: false }],
    }));

    expect(res.statusCode).toBe(200);
    // The record is still WAITING_FOR_INPUT — the response tells the truth about the
    // durable state, which is only cleared once the driver confirms the continuation.
    expect(JSON.parse(res.body)).toMatchObject({ calculation_id: 'calc-1', status: 'WAITING_FOR_INPUT' });

    // StartExecution forwarded the structured answer for the inline-function resume.
    const start = sfnMock.commandCalls(StartExecutionCommand)[0].args[0].input as { input: string };
    const payload = JSON.parse(start.input);
    expect(payload.sessionId).toBe(SESSION_ID);
    expect(payload.iteration).toBe(1);
    expect(payload.answers).toEqual([expect.objectContaining({
      questionId: 'q-region',
      value: 'ap-south-1',
      applyToSimilarResources: false,
    })]);

    // The route's own write only records that a resume was requested...
    const update = ddbMock.commandCalls(UpdateCommand)[0].args[0].input as Record<string, unknown>;
    const serialized = JSON.stringify(update);
    expect(serialized).toContain('state_machine_execution_arn');
    expect(serialized).toContain('resume_requested_at');
    expect(serialized).toContain('agent_answers');

    // ...and does NOT transition out of the wait, does NOT clear the durable pause, and
    // does NOT remove the questions the driver will render until InvokeHarness accepts.
    expect(serialized).not.toContain('ANALYZING');
    expect(serialized).not.toContain('REMOVE');
    expect(serialized).not.toContain('agent_questions');
    expect(serialized).not.toContain('pending_tool_use_id');
    expect(serialized).not.toContain('pending_tool_uses');
  });
});
