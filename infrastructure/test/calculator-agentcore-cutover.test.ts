/**
 * Cutover tests: DynamoDB item sizing (Step 9) and execution-status liveness (Step 7).
 *
 * Both cover failures a user actually saw. The sizing tests exist because calculations
 * died on "Item size to update has exceeded the maximum allowed size"; the liveness tests
 * exist because healthy long-running estimates were told "The estimate worker stopped
 * before finishing" after eleven minutes.
 *
 * Classification: MOCKED.
 */

import { mockClient } from 'aws-sdk-client-mock';
import { SFNClient, DescribeExecutionCommand, StartExecutionCommand } from '@aws-sdk/client-sfn';

const sfnMock = mockClient(SFNClient);

beforeEach(() => {
  sfnMock.reset();
});

// ─── Step 9: DynamoDB item sizing ────────────────────────────────────────────

describe('DynamoDB item size budget', () => {
  // Imported lazily so the module-level env reads in calculator-routes happen after
  // test/setup-env.ts has run.
  const load = () => require('../lambdas/api-handler/calculator-routes');

  const bigString = (bytes: number) => 'x'.repeat(bytes);

  it('exposes a 50 KB target and a 100 KB hard guard', () => {
    const { DYNAMO_ITEM_TARGET_BYTES, DYNAMO_ITEM_HARD_GUARD_BYTES } = load();
    expect(DYNAMO_ITEM_TARGET_BYTES).toBe(50_000);
    expect(DYNAMO_ITEM_HARD_GUARD_BYTES).toBe(100_000);
    // Well clear of DynamoDB's own 400 KB ceiling, with room for a later result write.
    expect(DYNAMO_ITEM_HARD_GUARD_BYTES).toBeLessThan(400_000);
  });

  it('leaves a normal record untouched', () => {
    const { enforceItemSizeBudget, calculationRecordBytes, DYNAMO_ITEM_TARGET_BYTES } = load();
    const record = {
      calculation_id: 'calc-1',
      owner_user_id: 'user-1',
      status: 'ANALYZING',
      name: 'FY27 landscape',
      resources: [{ service: 'Amazon EC2', size: 'm5.xlarge', quantity: 3 }],
      evidence_index_s3_key: 'users/user-1/calculator/calc-1/evidence/index.json',
      result_s3_key: 'users/user-1/calculator/calc-1/result.json',
      created_at: 1, updated_at: 2,
    };

    const sized = enforceItemSizeBudget(record);
    expect(sized.dropped).toEqual([]);
    expect(sized.record).toEqual(record);
    expect(calculationRecordBytes(sized.record)).toBeLessThan(DYNAMO_ITEM_TARGET_BYTES);
  });

  it('drops the workbook insights first when a record is over the guard', () => {
    const { enforceItemSizeBudget, DYNAMO_ITEM_HARD_GUARD_BYTES } = load();
    const record = {
      calculation_id: 'calc-2',
      workbook: { blob: bigString(150_000) },
      resources: [{ service: 'Amazon EC2' }],
      plan_v2: { revisions: [] },
    };

    const sized = enforceItemSizeBudget(record);
    expect(sized.dropped).toContain('workbook');
    expect(sized.record.workbook).toBeUndefined();
    // plan_v2 is read directly by the review workflow, so it is given up last.
    expect(sized.record.plan_v2).toBeDefined();
    expect(sized.bytes).toBeLessThanOrEqual(DYNAMO_ITEM_HARD_GUARD_BYTES);
  });

  it('keeps shedding until the record fits, in value-per-byte order', () => {
    const { enforceItemSizeBudget, DYNAMO_ITEM_HARD_GUARD_BYTES } = load();
    const record = {
      calculation_id: 'calc-3',
      workbook: { blob: bigString(200_000) },
      resources: [{ raw: bigString(200_000) }],
      plan_v2: { blob: bigString(10_000) },
    };

    const sized = enforceItemSizeBudget(record);
    expect(sized.dropped).toEqual(expect.arrayContaining(['workbook', 'resources']));
    expect(sized.bytes).toBeLessThanOrEqual(DYNAMO_ITEM_HARD_GUARD_BYTES);
  });

  it('stays under the guard at every lifecycle stage', () => {
    const { enforceItemSizeBudget, calculationRecordBytes, DYNAMO_ITEM_HARD_GUARD_BYTES } = load();

    const base = {
      calculation_id: 'calc-4',
      owner_user_id: 'user-1',
      input_s3_key: 'users/user-1/calculator/uploads/abc-book.xlsx',
      created_at: 1,
      updated_at: 2,
    };

    // Each stage adds only the small fields the new architecture writes. Every large
    // artifact — evidence, chunks, trace, full result — is an S3 key, not a value.
    const stages: Array<[string, Record<string, unknown>]> = [
      ['after upload', { ...base, status: 'REVIEW_REQUIRED' }],
      ['after analysis', {
        ...base,
        status: 'REVIEW_REQUIRED',
        resources: Array.from({ length: 40 }, (_, i) => ({ service: 'Amazon EC2', size: 'm5.xlarge', quantity: i })),
        workbook_ir_s3_key: 'users/user-1/calculator/analysis/hash/workbook-ir.json',
        resources_s3_key: 'users/user-1/calculator/parsed/abc.json',
      }],
      ['after execution start', {
        ...base,
        status: 'ANALYZING',
        execution_mode: 'agentcore-runtime',
        state_machine_execution_arn: 'arn:aws:states:ap-south-1:1234:execution/sm/calc-4-abc',
        agent_session_id: 'mimo-calc-4-abcdefghijklmnopqrstuvwxyz012345',
        evidence_index_s3_key: 'users/user-1/calculator/calc-4/evidence/index.json',
        evidence_chunk_count: 87,
        evidence_row_count: 4213,
      }],
      ['during processing', {
        ...base,
        status: 'BUILDING',
        progress_stage: 'BUILDING',
        progress_message: 'Creating AWS Pricing Calculator estimate...',
        agent_last_activity_at: 3,
        tool_call_count: 42,
        mcp_tools_used: ['get_service_fields', 'create_estimate', 'add_service', 'validate_estimate'],
      }],
      ['after completion', {
        ...base,
        status: 'COMPLETED',
        calculator_url: 'https://calculator.aws/#/estimate?id=3a25374a11b4baea77709fc7ad13ec661fe7c8dc',
        monthly_total: 12345.67,
        upfront_total: 0,
        total_12_months: 148148.04,
        warning_count: 2,
        question_count: 0,
        result_s3_key: 'users/user-1/calculator/calc-4/result.json',
      }],
      ['after failure', {
        ...base,
        status: 'FAILED',
        error_message: "We couldn't complete this AWS estimate automatically.",
      }],
    ];

    for (const [label, record] of stages) {
      const sized = enforceItemSizeBudget(record);
      expect(sized.dropped).toEqual([]);
      expect(calculationRecordBytes(sized.record)).toBeLessThan(DYNAMO_ITEM_HARD_GUARD_BYTES);
      // Recorded per stage so a failure names the stage rather than just a number.
      expect({ label, bytes: calculationRecordBytes(sized.record) })
        .toEqual({ label, bytes: expect.any(Number) });
    }
  });

  it('no longer keeps 120 KB of rows inline', () => {
    const source = require('fs').readFileSync(
      require('path').join(__dirname, '../lambdas/api-handler/calculator-routes.ts'), 'utf8',
    );
    const code = source.split('\n')
      .filter((line: string) => {
        const trimmed = line.trim();
        return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
      })
      .join('\n');
    expect(code).toMatch(/RESOURCE_BYTES_ON_ITEM = 16_000/);
    expect(code).not.toMatch(/RESOURCE_BYTES_ON_ITEM = 120_000/);
  });
});

// ─── Step 7: liveness from execution status, not elapsed time ────────────────

describe('AgentCore execution liveness', () => {
  const load = () => require('../lambdas/api-handler/calculator-agentcore-dispatch');

  it('reports a long-RUNNING execution as alive', async () => {
    sfnMock.on(DescribeExecutionCommand).resolves({ status: 'RUNNING' });
    const { describeExecutionLiveness } = load();
    await expect(describeExecutionLiveness('arn:aws:states:x:1:execution/sm/e'))
      .resolves.toEqual({ verdict: 'running' });
  });

  it.each(['FAILED', 'TIMED_OUT', 'ABORTED'] as const)('reports %s as dead', async (status) => {
    sfnMock.on(DescribeExecutionCommand).resolves({ status });
    const { describeExecutionLiveness } = load();
    await expect(describeExecutionLiveness('arn:aws:states:x:1:execution/sm/e'))
      .resolves.toEqual({ verdict: 'failed', reason: status });
  });

  it('reports SUCCEEDED separately, because the driver already wrote the result', async () => {
    sfnMock.on(DescribeExecutionCommand).resolves({ status: 'SUCCEEDED' });
    const { describeExecutionLiveness } = load();
    await expect(describeExecutionLiveness('arn:aws:states:x:1:execution/sm/e'))
      .resolves.toEqual({ verdict: 'succeeded' });
  });

  it('does not call a calculation dead just because DescribeExecution failed', async () => {
    // An IAM or throttling blip must never mark a healthy calculation as failed — that is
    // the same class of unfounded verdict as the eleven-minute rule.
    sfnMock.on(DescribeExecutionCommand).rejects(new Error('AccessDeniedException'));
    const { describeExecutionLiveness } = load();
    await expect(describeExecutionLiveness('arn:aws:states:x:1:execution/sm/e'))
      .resolves.toEqual({ verdict: 'unknown' });
  });

  it('gives a record with no execution ARN far longer than the old 11 minutes', () => {
    const { NO_EXECUTION_ARN_GRACE_MS } = load();
    expect(NO_EXECUTION_ARN_GRACE_MS).toBeGreaterThan(11 * 60 * 1000);
    // And longer than the Harness's own 900s idle session timeout, so a live agent that is
    // merely quiet between tool calls can never be pre-empted.
    expect(NO_EXECUTION_ARN_GRACE_MS).toBeGreaterThan(900 * 1000);
  });

  it('starts an execution with a runtimeSessionId of at least 33 characters', async () => {
    sfnMock.on(StartExecutionCommand).resolves({ executionArn: 'arn:aws:states:x:1:execution/sm/e1' });
    const { startAgentCoreExecution, newRuntimeSessionId } = load();

    // AgentCore rejects anything shorter: "Member must have length greater than or equal
    // to 33". A short calculation id alone is not enough.
    const sessionId = newRuntimeSessionId('c1');
    expect(sessionId.length).toBeGreaterThanOrEqual(33);

    await startAgentCoreExecution({ calculationId: 'c1', sessionId });
    const call = sfnMock.commandCalls(StartExecutionCommand)[0].args[0].input;
    expect(JSON.parse(call.input as string)).toMatchObject({ calculationId: 'c1', sessionId, iteration: 0 });
  });

  it('continues on the SAME session id rather than restarting the workbook', async () => {
    sfnMock.on(StartExecutionCommand).resolves({ executionArn: 'arn:aws:states:x:1:execution/sm/e2' });
    const { continueAgentCoreExecution } = load();

    const sessionId = 'mimo-c1-abcdefghijklmnopqrstuvwxyz0123456';
    await continueAgentCoreExecution({ calculationId: 'c1', sessionId, userAnswer: 'db.r6g.large' });

    const call = sfnMock.commandCalls(StartExecutionCommand)[0].args[0].input;
    const payload = JSON.parse(call.input as string);
    // Same session => AgentCore continues the conversation, so the agent keeps its
    // estimate and its assumptions. No re-read of the workbook, no recompiled plan.
    expect(payload.sessionId).toBe(sessionId);
    expect(payload.userAnswer).toBe('db.r6g.large');
    expect(payload.iteration).toBeGreaterThan(0);
  });
});

// ─── Step 6: the route must not reach legacy infrastructure ──────────────────

describe('production dispatch does not touch legacy infrastructure', () => {
  const routeSource = (): string => require('fs').readFileSync(
    require('path').join(__dirname, '../lambdas/api-handler/calculator-routes.ts'), 'utf8',
  );

  /**
   * BOTH entry points must be covered. POST /calculator builds immediately and dispatches
   * its own worker; POST /calculator/plans/{id}/run dispatches the reviewed one. Cutting
   * over only the second left the first firing the legacy orchestrator, and a live test
   * caught the two racing the same calculation — the legacy worker won and stamped
   * "Validated estimate ready" over a healthy AgentCore execution.
   */
  const agentCoreBranches = (): string[] => {
    const source = routeSource();
    const branches: string[] = [];
    // Anchored on the dispatch call itself rather than on `isAgentCoreMode()`, which also
    // appears in failIfStale's liveness check and is not a dispatch site.
    const marker = 'await startAgentCoreExecution({';
    let cursor = 0;
    for (;;) {
      const at = source.indexOf(marker, cursor);
      if (at < 0) break;
      const start = source.lastIndexOf('if (isAgentCoreMode()) {', at);
      // Ends where the rollback path begins. Both entry points hand over to a legacy
      // `try { lambdaClient.send(...) }`; the run route labels the handover with a banner
      // first. Whichever comes first is the boundary — without this the slice runs on into
      // the legacy dispatch and the "no Lambda invoke" assertion trips on the wrong code.
      const candidates = ['\n  try {', '// ─── rollback modes only']
        .map((marker) => source.indexOf(marker, at))
        .filter((index) => index > at);
      const end = candidates.length ? Math.min(...candidates) : at + 3000;
      branches.push(source.slice(start, end));
      cursor = at + marker.length;
    }
    return branches;
  };

  it('has an agentcore-runtime branch on BOTH dispatch entry points', () => {
    expect(agentCoreBranches()).toHaveLength(2);
  });

  it('every agentcore-runtime branch starts a state machine and invokes no Lambda', () => {
    for (const branch of agentCoreBranches()) {
      expect(branch).toContain('startAgentCoreExecution');
      expect(branch).toContain('persistWorkbookEvidence');
      // No Lambda invoke of any kind in a production branch.
      expect(branch).not.toContain('InvokeCommand');
      expect(branch).not.toContain('AGENT_LAMBDA_ARN');
      expect(branch).not.toContain('ORCHESTRATOR_FUNCTION_NAME');
    }
  });

  it('records the execution ARN in every agentcore-runtime branch', () => {
    // Without it, liveness falls back to elapsed time — the bug being removed.
    for (const branch of agentCoreBranches()) {
      expect(branch).toContain('state_machine_execution_arn');
      expect(branch).toContain('agent_session_id');
    }
  });

  it('the legacy agent Lambda is only reachable under legacy-invokemodel', () => {
    const source = routeSource();
    expect(source).toMatch(/EXECUTION_MODE === 'legacy-invokemodel' && AGENT_LAMBDA_ARN/);
    // The misleading old mode name must not select anything any more.
    expect(source).not.toMatch(/EXECUTION_MODE === 'agentcore-harness'/);
  });

  it('the eleven-minute rule no longer applies to a managed execution', () => {
    const source = routeSource();
    expect(source).toContain('LEGACY_CALCULATION_STALE_AFTER_MS');
    expect(source).toContain('describeExecutionLiveness');
    // The old customer-facing sentence survives only for legacy rows.
    const staleFn = source.slice(source.indexOf('async function failIfStale'), source.indexOf('async function loadOwned'));
    expect(staleFn).toContain('executionArn');
    expect(staleFn).toMatch(/verdict === 'running'/);
  });
});
