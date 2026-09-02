import { mockClient } from 'aws-sdk-client-mock';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { runEstimateLoop } from '../lambdas/calculator-orchestrator/tool-loop';
import type { McpSidecarClient } from '../lambdas/calculator-orchestrator/mcp-client';

/**
 * The estimate loop's last turn.
 *
 * The first live run of the real COSEC workbook spent 6.9 minutes calling live pricing
 * tools, hit the turn ceiling, and reported "This estimate could not be built" — every
 * rate it had gathered was thrown away by a `throw` at the bottom of the loop. The
 * sidecar's own logs showed the cause: 8 add_service calls across 24 turns, because the
 * model was asking for one tool per turn.
 *
 * Two things had to change. The prompt now tells the model to batch its calls, which is
 * the actual fix and is asserted here only as prompt text. The loop now spends its last
 * turn writing the answer down with NO tools attached, so running out of road produces a
 * partial estimate with its gaps named instead of nothing at all. That is what these
 * tests pin, because it is the difference between a wasted seven minutes and a usable
 * answer, and it only ever fires on the runs nobody is watching.
 */

const bedrockMock = mockClient(BedrockRuntimeClient);

/** A model that never stops asking for tools — the shape that used to end in a throw. */
function alwaysAsksForTools() {
  bedrockMock.on(InvokeModelCommand).callsFake((input: any) => {
    const body = JSON.parse(input.body);
    // No tools offered means this is the final turn: answer instead of calling.
    if (!body.tools) {
      return {
        body: Buffer.from(JSON.stringify({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '<calculation_json>{"url":null}</calculation_json>' }],
        })),
      };
    }
    return {
      body: Buffer.from(JSON.stringify({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: `t${Math.random()}`, name: 'search_services', input: {} }],
      })),
    };
  });
}

/** Records every request body so the final turn's payload can be inspected. */
function capturedBodies(): any[] {
  return bedrockMock.commandCalls(InvokeModelCommand).map((call) => JSON.parse((call.args[0].input as any).body));
}

const mcp = {
  listTools: async () => [{ name: 'search_services', description: 'find services', inputSchema: { type: 'object' } }],
  callTool: async () => ({ text: '{"services":[]}', isError: false }),
} as unknown as McpSidecarClient;

beforeEach(() => {
  bedrockMock.reset();
});

describe('estimate loop finalisation', () => {
  test('a model that never stops calling tools still returns an answer', async () => {
    alwaysAsksForTools();

    const outcome = await runEstimateLoop('price this', mcp);

    // The old behaviour was: throw "hit its 24-turn ceiling without producing a saved
    // estimate", discarding every priced line. Reaching the ceiling must now produce text.
    expect(outcome.finalText).toContain('<calculation_json>');
    expect(outcome.toolCalls.length).toBeGreaterThan(0);
  }, 30_000);

  test('the final turn is sent with no tools, so the model cannot call one instead', async () => {
    alwaysAsksForTools();

    await runEstimateLoop('price this', mcp);

    const bodies = capturedBodies();
    const last = bodies[bodies.length - 1];
    expect(last.tools).toBeUndefined();
    // Every turn before it had them: stripping tools early would cripple the loop. Two,
    // because the loop adds its own get_aws_price alongside whatever the sidecar reports.
    expect(bodies[0].tools.map((tool: any) => tool.name)).toEqual(
      expect.arrayContaining(['search_services', 'get_aws_price']),
    );
  }, 30_000);

  test('the final turn instruction reaches the model, and forbids invented prices', async () => {
    alwaysAsksForTools();

    await runEstimateLoop('price this', mcp);

    const last = capturedBodies().pop();
    const messages = last.messages as any[];
    const text: string = messages[messages.length - 1].content
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join('\n');
    expect(text).toContain('STOP. You have no tools on this turn');
    expect(text).toContain('set monthly to null');
    expect(text).toContain('Never substitute a price from memory');
    // Null url is explicitly allowed, because CalculationResultSchema now accepts it and
    // a priced breakdown with no shareable link is still the answer.
    expect(text).toContain('set "url" to null');
  }, 30_000);

  test('the instruction rides along with the last tool results, not as a bare second user turn', async () => {
    alwaysAsksForTools();

    await runEstimateLoop('price this', mcp);

    const last = capturedBodies().pop();
    const messages = last.messages as any[];
    // Consecutive user messages are accepted by the API but needless; the instruction is
    // appended to the user turn that carries the tool_result blocks, which must stay
    // bound to the tool_use blocks that asked for them.
    for (let at = 1; at < messages.length; at += 1) {
      expect(messages[at].role).not.toBe(messages[at - 1].role);
    }
    const finalUser = messages[messages.length - 1];
    expect(finalUser.role).toBe('user');
    expect(finalUser.content.some((block: any) => block.type === 'tool_result')).toBe(true);
    expect(finalUser.content.some((block: any) => block.type === 'text')).toBe(true);
  }, 30_000);

  test('a model that answers immediately never sees the finalisation prompt', async () => {
    bedrockMock.on(InvokeModelCommand).resolves({
      body: Buffer.from(JSON.stringify({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '<calculation_json>{"url":"https://calculator.aws/#/estimate?id=1"}</calculation_json>' }],
      })) as any,
    });

    const outcome = await runEstimateLoop('price this', mcp);

    expect(outcome.iterations).toBe(1);
    expect(JSON.stringify(capturedBodies())).not.toContain('STOP. You have no tools');
  }, 30_000);

  test('progress reports the finalisation stage, so the UI stops saying "calling tools"', async () => {
    alwaysAsksForTools();
    const stages: string[] = [];

    await runEstimateLoop('price this', mcp, async (update) => { stages.push(update.stage); });

    expect(stages).toContain('finalising');
    expect(stages.filter((stage) => stage === 'finalising')).toHaveLength(1);
  }, 30_000);
});

describe('the prompt tells the model to batch', () => {
  // The root cause of the 24-turn failure was one tool call per turn. Raising the ceiling
  // alone would only have bought a slower, more expensive failure.
  test('batching is instructed before either half of the job is described', async () => {
    bedrockMock.on(InvokeModelCommand).resolves({
      body: Buffer.from(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] })) as any,
    });

    await runEstimateLoop('price this', mcp);

    const system: string = capturedBodies()[0].system;
    expect(system).toContain('USE THE "batch" TOOL');
    expect(system.indexOf('USE THE "batch" TOOL')).toBeLessThan(system.indexOf('A. BUILD THE ESTIMATE'));
    // Naming the three phases matters more than the word "batch": these are the calls
    // that multiply with the size of an uploaded inventory.
    expect(system).toMatch(/all\s+the\s+get_service_fields together/);
    expect(system).toMatch(/all\s+the\s+add_service calls together/);
    expect(system).toMatch(/all\s+the\s+get_aws_price lookups together/);
    // Two live runs restarted the estimate mid-flight, orphaning everything added so far.
    expect(system).toContain('Create the estimate ONCE');
  }, 30_000);

  test('the estimate is banked before pricing starts', async () => {
    bedrockMock.on(InvokeModelCommand).resolves({
      body: Buffer.from(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] })) as any,
    });

    await runEstimateLoop('price this', mcp);

    // The failed run never called export_estimate, so it had no URL to fall back on.
    expect(capturedBodies()[0].system).toContain('BEFORE you start pricing');
  }, 30_000);
});
