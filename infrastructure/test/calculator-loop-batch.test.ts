import { mockClient } from 'aws-sdk-client-mock';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

/**
 * The batch tool.
 *
 * Two consecutive live runs of the real COSEC workbook emitted exactly one tool call per
 * turn — 25 turns, ~11s each — and ran out of clock before saving anything. The system
 * prompt asked for several tool_use blocks per turn both times and was ignored both
 * times. So batching is a tool now: one call the model makes, which fans out inside the
 * loop. These tests pin the parts that can go wrong silently — result-to-call alignment
 * (a price lookup runs in a later phase but must stay at its original index), the
 * concurrency window, and the refusal of a second create_estimate.
 */

const lookupPrice = jest.fn();

jest.mock('../lambdas/calculator-orchestrator/aws-pricing', () => ({
  HOURS_PER_MONTH: 730,
  lookupPrice: (...args: any[]) => lookupPrice(...args),
}));

// Imported after the mock is registered.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runEstimateLoop } = require('../lambdas/calculator-orchestrator/tool-loop');

const bedrockMock = mockClient(BedrockRuntimeClient);
const callTool = jest.fn();

const mcp = {
  listTools: async () => [
    { name: 'create_estimate', description: 'start one', inputSchema: { type: 'object' } },
    { name: 'add_service', description: 'add one', inputSchema: { type: 'object' } },
    { name: 'get_service_fields', description: 'describe one', inputSchema: { type: 'object' } },
  ],
  callTool,
} as any;

/** A tool_use block. */
function use(name: string, input: any, id = `id-${name}`) {
  return { type: 'tool_use', id, name, input };
}

const ANSWER = [{ type: 'text', text: '<calculation_json>{"url":null}</calculation_json>' }];

/** Replies with each turn's content in order, then repeats the last one. */
function script(...turns: any[][]) {
  let at = 0;
  bedrockMock.on(InvokeModelCommand).callsFake(() => {
    const content = turns[Math.min(at, turns.length - 1)];
    at += 1;
    return {
      body: Buffer.from(JSON.stringify({
        stop_reason: content.some((block: any) => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
        content,
      })),
    };
  });
}

function bodies(): any[] {
  return bedrockMock.commandCalls(InvokeModelCommand).map((call) => JSON.parse((call.args[0].input as any).body));
}

/** Every tool_result the model was handed, oldest first. */
function toolResults(): any[] {
  const last = bodies()[bodies().length - 1];
  return (last.messages as any[])
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block: any) => block.type === 'tool_result');
}

/** The batch report parsed back out of the first tool_result. */
function firstReport(): any[] {
  return JSON.parse(toolResults()[0].content[0].text);
}

beforeEach(() => {
  bedrockMock.reset();
  callTool.mockReset();
  callTool.mockImplementation(async (name: string) => ({ text: `${name} ok`, isError: false }));
  lookupPrice.mockReset();
  lookupPrice.mockResolvedValue({ found: true, ratePerUnit: 0.1, unit: 'Hrs', description: 'x' });
});

describe('the batch tool', () => {
  test('is offered alongside the sidecar tools', async () => {
    script(ANSWER);

    await runEstimateLoop('price this', mcp);

    expect(bodies()[0].tools.map((tool: any) => tool.name)).toContain('batch');
  }, 30_000);

  test('runs every call in one turn and returns results in the order given', async () => {
    script(
      [use('batch', {
        calls: [
          { name: 'get_service_fields', input: { service: 'ec2' } },
          { name: 'add_service', input: { service: 'ec2' } },
          { name: 'get_aws_price', input: { serviceCode: 'AmazonEC2', region: 'ap-south-1' } },
          { name: 'add_service', input: { service: 'ebs' } },
        ],
      })],
      ANSWER,
    );

    await runEstimateLoop('price this', mcp);

    // One turn, not four: the whole point.
    expect(toolResults()).toHaveLength(1);

    // Price lookups execute in a later phase than the sidecar calls, so this is the
    // assertion that catches an off-by-one in the reassembly: call 3 must still be the
    // price lookup, not an add_service result shifted up into its slot.
    const report = firstReport();
    expect(report.map((entry) => entry.name)).toEqual([
      'get_service_fields', 'add_service', 'get_aws_price', 'add_service',
    ]);
    expect(report.map((entry) => entry.call)).toEqual([1, 2, 3, 4]);
    expect(report.every((entry) => entry.ok)).toBe(true);
    expect(report[2].result).toContain('ratePerUnit');

    expect(callTool).toHaveBeenCalledTimes(3);
    expect(lookupPrice).toHaveBeenCalledTimes(1);
  }, 30_000);

  test('price lookups run concurrently, but no more than six at once', async () => {
    let inFlight = 0;
    let peak = 0;
    lookupPrice.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      inFlight -= 1;
      return { found: true, ratePerUnit: 0.1, unit: 'Hrs', description: 'x' };
    });

    script(
      [use('batch', {
        calls: Array.from({ length: 12 }, () => ({
          name: 'get_aws_price',
          input: { serviceCode: 'AmazonEC2', region: 'ap-south-1' },
        })),
      })],
      ANSWER,
    );

    await runEstimateLoop('price this', mcp);

    expect(lookupPrice).toHaveBeenCalledTimes(12);
    // Serial would peak at 1 and cost 12 round trips of latency; unbounded would peak at
    // 12 and hammer the Price List API.
    expect(peak).toBe(6);
    expect(firstReport()).toHaveLength(12);
  }, 30_000);

  test('one failed call does not sink the rest of the batch', async () => {
    callTool.mockImplementation(async (name: string, input: any) => (
      input?.service === 'bad'
        ? { text: 'unknown service key', isError: true }
        : { text: `${name} ok`, isError: false }
    ));

    script(
      [use('batch', {
        calls: [
          { name: 'add_service', input: { service: 'ec2' } },
          { name: 'add_service', input: { service: 'bad' } },
          { name: 'add_service', input: { service: 'ebs' } },
        ],
      })],
      ANSWER,
    );

    await runEstimateLoop('price this', mcp);

    const report = firstReport();
    expect(report.map((entry) => entry.ok)).toEqual([true, false, true]);
    // The batch itself is not an error turn: flagging it would hide which call to retry.
    expect(toolResults()[0].is_error).toBeUndefined();
  }, 30_000);

  test('drops calls past the cap and says so instead of silently truncating', async () => {
    script(
      [use('batch', {
        calls: Array.from({ length: 45 }, () => ({ name: 'add_service', input: { service: 'ec2' } })),
      })],
      ANSWER,
    );

    await runEstimateLoop('price this', mcp);

    expect(callTool).toHaveBeenCalledTimes(20);
    const report = firstReport();
    expect(report).toHaveLength(21);
    expect(report[20].ok).toBe(false);
    expect(report[20].result).toContain('25 further call(s) were dropped');
  }, 30_000);

  test('refuses a nested batch rather than recursing', async () => {
    script(
      [use('batch', { calls: [{ name: 'batch', input: { calls: [] } }] })],
      ANSWER,
    );

    await runEstimateLoop('price this', mcp);

    const report = firstReport();
    expect(report[0].ok).toBe(false);
    expect(report[0].result).toContain('cannot contain another batch');
  }, 30_000);

  test('an empty batch is reported as an error the model can act on', async () => {
    script([use('batch', { calls: [] })], ANSWER);

    await runEstimateLoop('price this', mcp);

    expect(toolResults()[0].is_error).toBe(true);
    expect(toolResults()[0].content[0].text).toContain('non-empty "calls" array');
  }, 30_000);
});

describe('the estimate is created exactly once', () => {
  test('a second create_estimate is refused without reaching the sidecar', async () => {
    callTool.mockResolvedValue({ text: '{"estimateId":"est-1"}', isError: false });

    script(
      [use('create_estimate', { name: 'first' }, 'a')],
      [use('create_estimate', { name: 'second' }, 'b')],
      ANSWER,
    );

    await runEstimateLoop('price this', mcp);

    // On a live run the model created a second estimate at turn 20, orphaning every
    // service it had added to the first one, and exported a link covering a fraction of
    // the workload.
    expect(callTool).toHaveBeenCalledTimes(1);

    const second = toolResults()[1];
    expect(second.is_error).toBe(true);
    expect(second.content[0].text).toContain('Do NOT create');
    // The first response is echoed back so the model can carry on with the real id.
    expect(second.content[0].text).toContain('est-1');
  }, 30_000);

  test('a failed create_estimate can still be retried', async () => {
    callTool
      .mockResolvedValueOnce({ text: 'upstream unavailable', isError: true })
      .mockResolvedValueOnce({ text: '{"estimateId":"est-2"}', isError: false });

    script(
      [use('create_estimate', {}, 'a')],
      [use('create_estimate', {}, 'b')],
      ANSWER,
    );

    await runEstimateLoop('price this', mcp);

    // Blocking the retry would strand the run with no estimate at all.
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(toolResults()[1].is_error).toBeUndefined();
  }, 30_000);
});

describe('a lone call earns a nudge', () => {
  test('spending a turn on one add_service is called out with the live clock', async () => {
    script([use('add_service', { service: 'ec2' })], ANSWER);

    await runEstimateLoop('price this', mcp);

    // The same instruction in the system prompt was ignored on two live runs, so it is
    // repeated where the decision is actually made.
    const text = JSON.stringify(bodies()[bodies().length - 1].messages);
    expect(text).toContain('spent an entire turn on a single add_service call');
    expect(text).toMatch(/about \d+s of budget remain/);
  }, 30_000);

  test('the one-off steps are not nagged', async () => {
    script([use('create_estimate', {})], ANSWER);

    await runEstimateLoop('price this', mcp);

    // create_estimate happens once by design; nudging it would be noise the model has to
    // reason past.
    expect(JSON.stringify(bodies()[bodies().length - 1].messages)).not.toContain('spent an entire turn');
  }, 30_000);

  test('a batch is never nudged', async () => {
    script(
      [use('batch', { calls: [{ name: 'add_service', input: { service: 'ec2' } }] })],
      ANSWER,
    );

    await runEstimateLoop('price this', mcp);

    expect(JSON.stringify(bodies()[bodies().length - 1].messages)).not.toContain('spent an entire turn');
  }, 30_000);
});
