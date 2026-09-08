/**
 * request_user_input interrupt tests: the real AgentCore inline-function pause/resume.
 *
 * The old mechanism asked Claude to emit `{"status":"NEEDS_INPUT"}` as assistant text and
 * MIMO parsed JSON out of the prose. The replacement is a first-class Harness
 * `inline_function`: when Claude calls request_user_input the InvokeHarness stream ends
 * with messageStop.stopReason == "tool_use", MIMO persists a wait state, and the resume
 * replays the original assistant toolUse message followed by the customer's toolResult
 * on the SAME runtimeSessionId.
 *
 * These cover the projection of the semantic tool input onto the frontend question shape
 * and the exact Part 16 continuation-message construction — the two pieces of pure logic
 * the pause/resume depends on.
 *
 * Classification: MOCKED.
 */

// Imported lazily so the module-level env reads in the driver happen after
// test/setup-env.ts has run.
const load = () => require('../lambdas/calculator-harness-driver');

describe('request_user_input: tool input → agent question projection', () => {
  it('projects a full CHOICE request including choices and applyToSimilarResources', () => {
    const { toolInputToAgentQuestion } = load();
    const question = toolInputToAgentQuestion({
      questionId: 'q-region',
      resource: 'web-cluster',
      semanticField: 'region',
      type: 'CHOICE',
      title: 'Primary region',
      question: 'Which region should this run in?',
      reason: 'The workbook does not name a region.',
      choices: [
        { value: 'ap-south-1', label: 'Mumbai', description: 'Asia Pacific (Mumbai)' },
        { value: 'eu-west-1', label: 'Ireland' },
      ],
      allowApplyToSimilarResources: true,
    });
    expect(question).toMatchObject({
      questionId: 'q-region',
      resource: 'web-cluster',
      semanticField: 'region',
      field: 'region',
      type: 'CHOICE',
      title: 'Primary region',
      question: 'Which region should this run in?',
      reason: 'The workbook does not name a region.',
      allowApplyToSimilarResources: true,
    });
    expect(question?.choices).toEqual([
      { value: 'ap-south-1', label: 'Mumbai', description: 'Asia Pacific (Mumbai)' },
      { value: 'eu-west-1', label: 'Ireland' },
    ]);
  });

  it('keeps NUMBER + unit and coerces BOOLEAN', () => {
    const { toolInputToAgentQuestion } = load();
    const number = toolInputToAgentQuestion({
      questionId: 'q-instances',
      type: 'NUMBER',
      title: 'Instance count',
      question: 'How many app servers?',
      unit: 'servers',
    });
    expect(number?.type).toBe('NUMBER');
    expect(number?.unit).toBe('servers');

    const bool = toolInputToAgentQuestion({
      questionId: 'q-multi-az',
      type: 'boolean',
      question: 'Deploy across two AZs?',
    });
    expect(bool?.type).toBe('BOOLEAN');
    expect(bool?.allowApplyToSimilarResources).toBeUndefined();
  });

  it('returns undefined when the question text is missing', () => {
    const { toolInputToAgentQuestion } = load();
    expect(toolInputToAgentQuestion({ type: 'TEXT', title: 'no question body' })).toBeUndefined();
  });
});

describe('request_user_input: resume continuation messages (Part 16)', () => {
  it('replays the original assistant toolUse and supplies the matching toolResult', () => {
    const { buildResumeMessages } = load();
    const input = {
      questionId: 'q-region',
      type: 'CHOICE',
      title: 'Primary region',
      question: 'Which region?',
      reason: 'Missing from workbook',
      choices: [{ value: 'ap-south-1', label: 'Mumbai' }],
    };
    const messages = buildResumeMessages(
      [{ toolUseId: 'tooluse_1', name: 'request_user_input', input }],
      [{ questionId: 'q-region', value: 'ap-south-1', applyToSimilarResources: true }],
    );

    expect(messages).toHaveLength(2);

    // The ORIGINAL assistant toolUse message — not a text paraphrase of the answer.
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      content: [{ toolUse: { toolUseId: 'tooluse_1', name: 'request_user_input', input } }],
    });

    // The customer's toolResult, body as the exact JSON the Harness hands back.
    expect(messages[1]).toMatchObject({
      role: 'user',
      content: [{
        toolResult: {
          toolUseId: 'tooluse_1',
          status: 'success',
        },
      }],
    });
    const body = JSON.parse((messages[1] as any).content[0].toolResult.content[0].text as string);
    expect(body).toEqual({ value: 'ap-south-1', applyToSimilarResources: true });
  });

  it('pairs each paused tool use to the answer that names the same questionId', () => {
    const { buildResumeMessages } = load();
    const messages = buildResumeMessages(
      [
        { toolUseId: 'tooluse_a', name: 'request_user_input', input: { questionId: 'qa', question: 'A?' } },
        { toolUseId: 'tooluse_b', name: 'request_user_input', input: { questionId: 'qb', question: 'B?' } },
      ],
      [
        { questionId: 'qb', value: 'second' },
        { questionId: 'qa', value: 'first' },
      ],
    );

    const results = messages
      .filter((message: any) => message.role === 'user')
      .map((message: any) => ({
        toolUseId: message.content[0].toolResult.toolUseId,
        body: JSON.parse(message.content[0].toolResult.content[0].text),
      }));
    expect(results).toEqual([
      { toolUseId: 'tooluse_a', body: { value: 'first', applyToSimilarResources: false } },
      { toolUseId: 'tooluse_b', body: { value: 'second', applyToSimilarResources: false } },
    ]);
  });

  it('fails an unanswered tool use instead of resuming with bare text', () => {
    const { buildResumeMessages } = load();
    const messages = buildResumeMessages(
      [{ toolUseId: 'tooluse_1', name: 'request_user_input', input: { questionId: 'q1', question: 'A?' } }],
      [],
    );
    expect(messages).toHaveLength(2);
    const toolResult = (messages[1] as any).content[0].toolResult;
    expect(toolResult.status).toBe('error');
    expect(toolResult.toolUseId).toBe('tooluse_1');
    expect(String(toolResult.content[0].text)).toContain('No customer answer');
  });
});

describe('request_user_input: reading the persisted pause state (Part 14)', () => {
  const asRecord = (partial: object) => partial;

  it('prefers the pending_tool_uses array when present', () => {
    const { readPendingToolUses } = load();
    const record = asRecord({
      pending_tool_uses: [
        { toolUseId: 't1', name: 'request_user_input', input: { questionId: 'q1' } },
        { toolUseId: 't2', name: 'request_user_input', input: { questionId: 'q2' } },
      ],
      pending_tool_use_id: 'stale',
    });
    const pending = readPendingToolUses(record as never);
    expect(pending.map((entry: any) => entry.toolUseId)).toEqual(['t1', 't2']);
  });

  it('falls back to the singular canonical pause fields', () => {
    const { readPendingToolUses } = load();
    const record = asRecord({
      pending_tool_use_id: 'tooluse_1',
      pending_tool_name: 'request_user_input',
      pending_tool_input: { questionId: 'q1', question: 'A?' },
    });
    const pending = readPendingToolUses(record as never);
    expect(pending).toEqual([
      { toolUseId: 'tooluse_1', name: 'request_user_input', input: { questionId: 'q1', question: 'A?' } },
    ]);
  });

  it('returns an empty list when there is no pause', () => {
    const { readPendingToolUses } = load();
    expect(readPendingToolUses({} as never)).toEqual([]);
  });
});

describe('harness driver: real pause plumbing, not NEEDS_INPUT-as-text', () => {
  it('captures the tool_use stop reason and persists a WAITING_FOR_INPUT state', () => {
    const source = require('fs').readFileSync(
      require('path').join(__dirname, '../lambdas/calculator-harness-driver/index.ts'), 'utf8',
    );
    // Part 13/14 markers: the stream is watched for inline-function tool use and the
    // terminal reason is stopReason == tool_use, which drives a real wait-state write.
    expect(source).toContain("stopReason === 'tool_use'");
    expect(source).toContain("status: 'WAITING_FOR_INPUT'");
    expect(source).toContain('pending_tool_use_id');
    expect(source).toContain('pending_tool_input');
    expect(source).toContain('contentBlockDelta');
    expect(source).toContain('delta?.toolUse?.input');
    expect(source).toContain('agent_questions');
  });
});
