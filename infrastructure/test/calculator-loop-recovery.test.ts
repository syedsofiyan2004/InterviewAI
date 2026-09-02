import { mockClient } from 'aws-sdk-client-mock';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { runEstimateLoop } from '../lambdas/calculator-orchestrator/tool-loop';
import type { McpSidecarClient } from '../lambdas/calculator-orchestrator/mcp-client';

/**
 * A failed gathering turn is not a failed run.
 *
 * A live run of the COSEC workbook reached turn 9, batching properly, with 477 of its 660
 * seconds still unspent — and then died on `AbortError: Request aborted`. The cause was
 * our own per-call ceiling: batching made each turn emit thousands of output tokens, so
 * generation ran past 120s and the AbortController fired. The ceiling was raised, but the
 * real defect was structural — the Bedrock call sat in `try { } finally { }` with no
 * catch, so one bad turn threw away every rate gathered before it.
 *
 * These tests pin the recovery: an over-long turn drops straight to the write-up, a
 * transient fault gets one retry, and only a failure with nothing left to write into is
 * allowed to surface.
 */

const bedrockMock = mockClient(BedrockRuntimeClient);

const ANSWER = {
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: '<calculation_json>{"url":null}</calculation_json>' }],
};

const TOOL_TURN = {
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: 't1', name: 'search_services', input: {} }],
};

const mcp = {
  listTools: async () => [{ name: 'search_services', description: 'find', inputSchema: { type: 'object' } }],
  callTool: async () => ({ text: '{}', isError: false }),
} as unknown as McpSidecarClient;

function fault(name: string, message = 'upstream said no'): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/**
 * Throws on the given 1-based call numbers. Otherwise replies with `reply` while tools are
 * on offer, and with the finished answer once they are withdrawn — matching the real API,
 * where a model handed no tools cannot emit a tool_use block.
 */
function failOn(failures: Map<number, Error>, reply: any = ANSWER) {
  let at = 0;
  bedrockMock.on(InvokeModelCommand).callsFake((input: any) => {
    at += 1;
    const boom = failures.get(at);
    if (boom) throw boom;
    return { body: Buffer.from(JSON.stringify(JSON.parse(input.body).tools ? reply : ANSWER)) };
  });
}

function bodies(): any[] {
  return bedrockMock.commandCalls(InvokeModelCommand).map((call) => JSON.parse((call.args[0].input as any).body));
}

beforeEach(() => {
  bedrockMock.reset();
});

describe('an over-long turn falls through to the write-up', () => {
  test('an abort mid-run produces an answer instead of failing the calculation', async () => {
    failOn(new Map([[1, fault('AbortError', 'Request aborted')]]));

    const outcome = await runEstimateLoop('price this', mcp);

    // The old code let this reach the caller, which surfaced as "This estimate could not
    // be built" with every gathered rate discarded.
    expect(outcome.finalText).toContain('<calculation_json>');
    expect(bodies()).toHaveLength(2);
  }, 30_000);

  test('the turn after an abort is the write-up turn, with no tools to reach for', async () => {
    failOn(new Map([[1, fault('AbortError', 'Request aborted')]]));

    await runEstimateLoop('price this', mcp);

    const last = bodies()[1];
    expect(last.tools).toBeUndefined();
    expect(JSON.stringify(last.messages)).toContain('STOP. You have no tools on this turn');
  }, 30_000);

  test('an abort is recognised by message as well as by name', async () => {
    // Depending on where the SDK raises it, the name is not always AbortError.
    failOn(new Map([[1, fault('Error', 'Request aborted')]]));

    await runEstimateLoop('price this', mcp);

    // Recognised as an abort, so no retry: straight to the write-up in two calls.
    expect(bodies()).toHaveLength(2);
    expect(bodies()[1].tools).toBeUndefined();
  }, 30_000);
});

describe('a transient fault is retried, not surrendered to', () => {
  test('one throttle costs a turn, not the run', async () => {
    failOn(new Map([[1, fault('ThrottlingException')]]), TOOL_TURN);

    await runEstimateLoop('price this', mcp);

    // The retry must still carry tools: a single bad response is no reason to stop
    // gathering with eight turns of budget left.
    expect(bodies()[1].tools).toBeDefined();
    expect(JSON.stringify(bodies()[1].messages)).not.toContain('STOP. You have no tools');
  }, 60_000);

  test('two faults in a row stop the gathering and bank what is priced', async () => {
    failOn(new Map([
      [1, fault('ThrottlingException')],
      [2, fault('ThrottlingException')],
    ]));

    await runEstimateLoop('price this', mcp);

    // Retrying forever would just spend the budget on the same failure.
    expect(bodies()[2].tools).toBeUndefined();
  }, 60_000);

  test('the failure counter resets, so faults spread across a long run each get a retry', async () => {
    failOn(new Map([
      [1, fault('ThrottlingException')],
      [3, fault('ThrottlingException')],
    ]), TOOL_TURN);

    await runEstimateLoop('price this', mcp);

    // Call 2 succeeded between them, so call 4 is a retry and not a forced write-up.
    // Without the reset, two unrelated blips half a run apart would end the gathering.
    expect(bodies()[3].tools).toBeDefined();
  }, 60_000);
});

describe('a failure with nothing left to salvage is reported', () => {
  test('an abort on the write-up turn itself surfaces', async () => {
    // Every call fails, so the forced write-up fails too. There is no answer to give and
    // silently returning an empty estimate would be worse than an error.
    failOn(new Map([
      [1, fault('AbortError', 'Request aborted')],
      [2, fault('AbortError', 'Request aborted')],
    ]));

    await expect(runEstimateLoop('price this', mcp)).rejects.toThrow(/abort/i);
  }, 30_000);
});
