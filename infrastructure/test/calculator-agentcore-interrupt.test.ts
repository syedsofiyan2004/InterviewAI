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

  it('projects a GENERIC question (options + single selection, no type) with type absent', () => {
    const { toolInputToAgentQuestion } = load();
    const question = toolInputToAgentQuestion({
      questionId: 'q-savings-plan',
      title: 'Savings Plan term',
      question: 'Which commitment would you like on the EC2 fleet?',
      reason: 'A commitment materially changes the monthly cost.',
      scope: 'all EC2 instances',
      selectionMode: 'single',
      options: [
        { value: 'on_demand', label: 'On-Demand', description: 'No commitment, highest unit price.' },
        { value: 'sp_1yr_no_upfront', label: '1 year, no upfront' },
      ],
      customInput: { enabled: true, label: 'Other', inputType: 'text' },
      allowApplyToSimilarResources: true,
    });
    expect(question).toMatchObject({
      questionId: 'q-savings-plan',
      title: 'Savings Plan term',
      question: 'Which commitment would you like on the EC2 fleet?',
      reason: 'A commitment materially changes the monthly cost.',
      scope: 'all EC2 instances',
      selectionMode: 'single',
      customInput: { enabled: true, label: 'Other', inputType: 'text' },
      allowApplyToSimilarResources: true,
    });
    expect(question?.type).toBeUndefined();
    expect(question?.choices).toBeUndefined();
    expect(question?.options).toEqual([
      { value: 'on_demand', label: 'On-Demand', description: 'No commitment, highest unit price.' },
      { value: 'sp_1yr_no_upfront', label: '1 year, no upfront' },
    ]);
  });

  it('projects a GENERIC multiple question with a numbered custom input', () => {
    const { toolInputToAgentQuestion } = load();
    const question = toolInputToAgentQuestion({
      questionId: 'q-hours',
      title: 'Running hours',
      question: 'Which hours apply to these servers?',
      reason: 'Hours change the monthly total.',
      selectionMode: 'multiple',
      options: [
        { value: '24x7', label: '24x7' },
        { value: 'business', label: 'Business hours' },
      ],
      customInput: { enabled: true, inputType: 'number', unit: 'hours/day', placeholder: 'e.g. 12' },
    });
    expect(question?.type).toBeUndefined();
    expect(question?.selectionMode).toBe('multiple');
    expect(question?.customInput).toEqual({ enabled: true, inputType: 'number', unit: 'hours/day', placeholder: 'e.g. 12' });
  });

  it('a bare question with no type, options or custom input stays a free-text question', () => {
    const { toolInputToAgentQuestion } = load();
    const question = toolInputToAgentQuestion({
      questionId: 'q-freetext',
      title: 'Anything else',
      question: 'Tell us anything else about the workload that affects cost.',
    });
    expect(question?.type).toBeUndefined();
    expect(question?.options).toBeUndefined();
    expect(question?.customInput).toBeUndefined();
    expect(question?.question).toBe('Tell us anything else about the workload that affects cost.');
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

  it('serialises an array answer for a selectionMode "multiple" question unchanged', () => {
    const { buildResumeMessages } = load();
    const input = {
      questionId: 'q-hours',
      question: 'Which hours apply to these servers?',
      selectionMode: 'multiple',
      options: [{ value: '24x7', label: '24x7' }],
    };
    const messages = buildResumeMessages(
      [{ toolUseId: 'tooluse_1', name: 'request_user_input', input }],
      [{ questionId: 'q-hours', value: ['24x7', 'until 18:00 local'] }],
    );
    const body = JSON.parse((messages[1] as any).content[0].toolResult.content[0].text as string);
    expect(body.value).toEqual(['24x7', 'until 18:00 local']);
    expect(body.applyToSimilarResources).toBe(false);
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

  it('refuses to resume an unanswered material request instead of saying "continue without it"', () => {
    const { buildResumeMessages } = load();
    const build = () => buildResumeMessages(
      [{ toolUseId: 'tooluse_1', name: 'request_user_input', input: { questionId: 'q1', question: 'A?' } }],
      [],
    );
    // An unanswered MATERIAL request must never be resumed with an error toolResult that
    // tells the agent to continue without the fact — so no messages are produced at all.
    expect(build).toThrow(/refusing to resume by telling the agent to continue without it/);
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

  it('clears the pending pause only AFTER InvokeHarness is accepted, never before', () => {
    const source = require('fs').readFileSync(
      require('path').join(__dirname, '../lambdas/calculator-harness-driver/index.ts'), 'utf8',
    );
    // The clearing patch must sit after the send, so an InvokeHarness throw leaves
    // WAITING_FOR_INPUT + the full pending state intact for a safe retry.
    const sendAt = source.indexOf('await agentCore.send(new InvokeHarnessCommand');
    const clearAt = source.indexOf('pending_tool_use_id: null');
    expect(sendAt).toBeGreaterThanOrEqual(0);
    expect(clearAt).toBeGreaterThan(sendAt);
    // No error toolResult that tells the agent to keep going without an unanswered
    // material fact may exist anywhere in the driver.
    expect(source).not.toContain('Continue without it');
  });
});
