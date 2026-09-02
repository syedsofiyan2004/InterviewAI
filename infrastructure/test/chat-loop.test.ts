import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { BedrockRuntimeClient, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { ddbDocClient } from '../lambdas/shared/aws';
import type { ChatStreamEvent } from '../schema/chat';
import { EstimateChangeProposalSchema } from '../schema/chat';
import { buildCalculatorReadTools } from '../lambdas/chat/context/calculator-tools';
import { LOOP_WALL_CLOCK_MS, MAX_MODEL_TURNS, runToolLoop } from '../lambdas/chat/loop';
import type { CalculationRecord } from '../schema/calculator';

/**
 * The chat's tool loop — the thing that turned a single-shot answerer into something that
 * can look a record up before it answers.
 *
 * Everything asserted here is a property that was either absent before the loop existed or
 * would break silently if it regressed, and "silently" is the operative word in all six
 * cases. There was exactly one `ConverseStream` call per request and no tool result was ever
 * returned to the model, so:
 *
 *  1. A tool result actually reaching the model, and the conversation continuing after it, is
 *     the whole feature. Asserted on the SECOND request's message list, not on the answer,
 *     because an answer that happens to mention a row proves nothing about what was sent.
 *  2. Both bounds must END WITH A SENTENCE. A loop that ran out of turns and fell silent is
 *     indistinguishable from a model that finished, so a half-checked figure would read as a
 *     final one — which for a cost estimate is the failure that reaches a client.
 *  3. A read-only look-up must never be mistaken for a proposal. The dispatch this replaced
 *     was a ternary that returned null for any name it did not recognise, and null was also
 *     how a malformed proposal was reported — so a perfectly good inventory read would have
 *     told the user "I could not put that change together properly".
 *  4. A tool argument must not widen access. The tools close over the already-authorised
 *     record and take no id, so an argument naming another estimate has to be inert; the test
 *     asserts it by counting DynamoDB reads, which is the only way to show that no second
 *     record was fetched.
 *  5. Deltas must keep streaming across turns. A loop that buffered until the end would throw
 *     away the one thing a Function URL in RESPONSE_STREAM mode was chosen for.
 *  6. A proposal carrying `scenarios` must survive validation. The matrix work is expressed
 *     entirely in that field, and if it fails `ChatProposalSchema` the user sees "I could not
 *     put that change together" with no way to tell the model got it right.
 */

/**
 * `awslambda` is ambient-only — @types/aws-lambda declares it, nothing provides it — and
 * chat/index.ts calls `streamifyResponse` at module scope. So the global has to exist before
 * the handler is required, or the import itself throws a ReferenceError.
 *
 * `from` returns the same object with the metadata attached rather than a wrapper, so one
 * capture object sees both the status decided by `open` and every byte written afterwards.
 */
interface CapturingStream {
  write(chunk: string): void;
  end(): void;
  metadata?: { statusCode: number };
  chunks: string[];
  ended: boolean;
}

function capturingStream(): CapturingStream {
  const stream: CapturingStream = {
    chunks: [],
    ended: false,
    write(chunk: string) { stream.chunks.push(chunk); },
    end() { stream.ended = true; },
  };
  return stream;
}

(globalThis as unknown as { awslambda: unknown }).awslambda = {
  HttpResponseStream: {
    from(underlying: CapturingStream, metadata: { statusCode: number }) {
      underlying.metadata = metadata;
      return underlying;
    },
  },
  streamifyResponse: (fn: unknown) => fn,
};

/**
 * Token verification is stubbed, not exercised.
 *
 * `USER_POOL_CLIENT_ID` is deliberately absent from test/setup-env.ts, so the real
 * `verifyCaller` refuses every request before Bedrock is reached — see chat/auth.ts. That gate
 * has its own coverage; what is under test here starts after it.
 */
jest.mock('../lambdas/chat/auth', () => ({
  verifyCaller: async () => ({ userId: 'owner-7', email: 'owner@minfytech.com' }),
}));

// Required after the global and the auth mock are in place.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambdas/chat/index') as { handler: (event: unknown, stream: CapturingStream) => Promise<void> };

const bedrockMock = mockClient(BedrockRuntimeClient);
const ddbMock = mockClient(ddbDocClient);

const CALCULATOR_TABLE = 'test-calculations';
const OWNER = 'owner-7';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * An estimate whose inventory is longer than the context block lists.
 *
 * 60 rows against a 40-row listing, so rows 40+ exist and are only reachable through
 * `list_inventory_rows` — which is the situation the read-only tools were added for.
 */
function calculation(overrides: Partial<CalculationRecord> = {}): CalculationRecord {
  const resources = Array.from({ length: 60 }, (_row, index) => ({
    name: `srv-${String(index).padStart(2, '0')}`,
    service: 'EC2',
    size: index < 30 ? 'm5.large' : 'm5.xlarge',
    quantity: 1,
    environment: index < 30 ? 'Production' : 'Dev',
    purchase_model: 'On-Demand',
  }));
  return {
    calculation_id: 'calc-9',
    owner_user_id: OWNER,
    name: 'Template Project',
    status: 'COMPLETED',
    prompt: 'sixty servers across production and dev',
    environment_hours: [],
    input_warnings: [],
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    resource_count: 60,
    resources,
    result: {
      url: null,
      currency: 'USD',
      monthlyTotal: 4269.65,
      lineItems: [{ service: 'EC2', detail: 'm5.large x30', monthly: 2140.16, workings: '730 hours at 0.096 x 30' }],
      environments: [],
      scenarios: [],
      assumptions: [],
      warnings: [],
    },
    ...overrides,
  } as CalculationRecord;
}

function turnEvent(message = 'which of the dev boxes are still on-demand?'): unknown {
  return {
    requestContext: { http: { method: 'POST' } },
    headers: { authorization: 'Bearer a-verified-token' },
    isBase64Encoded: false,
    body: JSON.stringify({ app: 'calculator', entity_id: 'calc-9', message }),
  };
}

// ---------------------------------------------------------------------------
// A scripted ConverseStream
// ---------------------------------------------------------------------------

interface ScriptedTurn {
  text?: string;
  tool?: { name: string; input: unknown };
  /** Overrides the stop reason the script would otherwise infer from `tool`. */
  stopReason?: string;
}

/**
 * Frames one turn the way Bedrock frames it, including the awkward parts.
 *
 * Tool arguments are split across two deltas on purpose: they arrive as partial JSON in real
 * streams, and a loop that parsed each fragment rather than the concatenation would pass this
 * test only if the fragments were never split.
 */
function framesFor(turn: ScriptedTurn, sequence: number): unknown[] {
  const frames: unknown[] = [{ messageStart: { role: 'assistant' } }];
  let index = 0;
  if (turn.text) {
    frames.push({ contentBlockDelta: { contentBlockIndex: index, delta: { text: turn.text } } });
    frames.push({ contentBlockStop: { contentBlockIndex: index } });
    index += 1;
  }
  if (turn.tool) {
    const json = JSON.stringify(turn.tool.input);
    const split = Math.ceil(json.length / 2);
    frames.push({ contentBlockStart: { contentBlockIndex: index, start: { toolUse: { toolUseId: `tu-${sequence}`, name: turn.tool.name } } } });
    frames.push({ contentBlockDelta: { contentBlockIndex: index, delta: { toolUse: { input: json.slice(0, split) } } } });
    frames.push({ contentBlockDelta: { contentBlockIndex: index, delta: { toolUse: { input: json.slice(split) } } } });
    frames.push({ contentBlockStop: { contentBlockIndex: index } });
  }
  frames.push({ messageStop: { stopReason: turn.stopReason || (turn.tool ? 'tool_use' : 'end_turn') } });
  return frames;
}

/**
 * Answers each call with the next scripted turn, repeating the last one forever.
 *
 * A fresh generator per call, not one shared iterable: an async generator object is consumed
 * once, so a shared one would make the second turn of every test read an exhausted stream.
 * Repeating the last turn is what lets the iteration-cap test script a single tool call and
 * still drive the loop into its bound.
 */
function script(...turns: ScriptedTurn[]): void {
  let at = 0;
  bedrockMock.on(ConverseStreamCommand).callsFake(() => {
    const turn = turns[Math.min(at, turns.length - 1)];
    at += 1;
    const frames = framesFor(turn, at);
    return {
      stream: (async function* replay() {
        for (const frame of frames) yield frame;
      })(),
    };
  });
}

/** Every request Bedrock was asked to make, in order. */
function requests(): Array<{ messages: Array<{ role: string; content: unknown[] }>; system: Array<{ text: string }>; inferenceConfig: Record<string, unknown>; toolConfig?: { tools: Array<{ toolSpec: { name: string } }> } }> {
  return bedrockMock.commandCalls(ConverseStreamCommand).map(call => call.args[0].input as never);
}

/** The stream's NDJSON lines, parsed. */
function events(stream: CapturingStream): ChatStreamEvent[] {
  return stream.chunks
    .join('')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as ChatStreamEvent);
}

function deltaText(stream: CapturingStream): string {
  return events(stream)
    .filter((event): event is Extract<ChatStreamEvent, { type: 'delta' }> => event.type === 'delta')
    .map(event => event.text)
    .join('');
}

/** Every toolResult text in a request's message list, flattened. */
function toolResults(request: { messages: Array<{ content: unknown[] }> }): string[] {
  return request.messages.flatMap(message => (message.content as Array<Record<string, any>>)
    .filter(block => block.toolResult)
    .flatMap(block => (block.toolResult.content as Array<{ text?: string }>).map(entry => entry.text || '')));
}

let record: CalculationRecord;

beforeEach(() => {
  bedrockMock.reset();
  ddbMock.reset();
  record = calculation();
  ddbMock.on(GetCommand).callsFake(input => (
    input.TableName === CALCULATOR_TABLE && input.Key?.calculation_id === 'calc-9' ? { Item: record } : {}
  ));
  // Both the history read and `nextSeq` are Queries; an empty thread satisfies each.
  ddbMock.on(QueryCommand).resolves({ Items: [] });
  ddbMock.on(PutCommand).resolves({});
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

// ---------------------------------------------------------------------------

describe('a read-only tool result goes back to the model and the turn continues', () => {
  test('the second request carries the look-up as a toolResult, and the answer spans both turns', async () => {
    script(
      { text: 'Let me look at the dev rows.', tool: { name: 'list_inventory_rows', input: { start: 40, count: 10 } } },
      { text: 'All ten are on-demand m5.xlarge.' },
    );
    const stream = capturingStream();

    await handler(turnEvent(), stream);

    const sent = requests();
    expect(sent).toHaveLength(2);

    // The load-bearing assertion: the model was shown the rows, in a message of its own,
    // after having been shown its own tool call.
    expect(sent[1].messages.map(message => message.role)).toEqual(['user', 'assistant', 'user']);
    const results = toolResults(sent[1]);
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('inventory rows 40-49 of 60');
    expect(results[0]).toContain('srv-40');

    // Rows 40+ are past the context block's 40-row listing, so this is the gap the tool set
    // exists to close: the block itself must not contain what the tool just fetched.
    expect(sent[0].system[0].text).not.toContain('srv-40');

    expect(deltaText(stream)).toContain('Let me look at the dev rows.');
    expect(deltaText(stream)).toContain('All ten are on-demand m5.xlarge.');
    expect(stream.ended).toBe(true);
  });

  test('deltas from the second turn are separated from the first, not run onto the end of it', async () => {
    script(
      { text: 'Checking.', tool: { name: 'summarise_inventory', input: { group_by: 'environment' } } },
      { text: 'Thirty in each.' },
    );
    const stream = capturingStream();

    await handler(turnEvent(), stream);

    // The model cannot know its own sentence was interrupted by a tool result, so without an
    // injected break the transcript reads "Checking.Thirty in each."
    expect(deltaText(stream)).toBe('Checking.\n\nThirty in each.');
    // Streamed, not assembled at the end: the user watches the first sentence while the
    // look-up runs, which is the only reason a loop is worth having on a streaming endpoint.
    const texts = events(stream).filter(event => event.type === 'delta');
    expect(texts.length).toBeGreaterThan(1);
  });

  test('the summary counts every row, including the ones the context block could not list', async () => {
    script(
      { tool: { name: 'summarise_inventory', input: { group_by: 'environment' } } },
      { text: 'Thirty production and thirty dev.' },
    );

    await handler(turnEvent(), capturingStream());

    expect(toolResults(requests()[1])[0]).toContain('Dev: 30 row(s), 30 machine(s)');
  });
});

describe('a read-only tool is never reported as a failed proposal', () => {
  test('an inventory look-up produces no proposal event and no "could not put that change together"', async () => {
    script(
      { tool: { name: 'list_inventory_rows', input: { start: 0, count: 5 } } },
      { text: 'The first five are m5.large in production.' },
    );
    const stream = capturingStream();

    await handler(turnEvent(), stream);

    expect(events(stream).filter(event => event.type === 'proposal')).toHaveLength(0);
    expect(deltaText(stream)).not.toContain('could not put that change together');
    expect(deltaText(stream)).toBe('The first five are m5.large in production.');
  });

  test('a tool the model invented is answered as a missing tool rather than a broken change', async () => {
    script(
      { tool: { name: 'delete_the_estimate', input: {} } },
      { text: 'I cannot do that, but I can tell you what is in it.' },
    );
    const stream = capturingStream();

    await handler(turnEvent(), stream);

    expect(toolResults(requests()[1])[0]).toContain('There is no tool called delete_the_estimate');
    expect(deltaText(stream)).not.toContain('could not put that change together');
  });
});

describe('a tool argument cannot widen access to another record', () => {
  test('arguments naming a different estimate are ignored, and no second record is read', async () => {
    script(
      {
        tool: {
          name: 'list_inventory_rows',
          input: { start: 0, count: 3, calculation_id: 'someone-elses-estimate', entity_id: 'calc-other', owner_user_id: 'stranger-1' },
        },
      },
      { text: 'Three rows, all from this estimate.' },
    );

    await handler(turnEvent(), capturingStream());

    const result = toolResults(requests()[1])[0];
    // The authorised record's own rows came back — the tool closes over it and has no
    // argument that names a record, so the invented ids are simply inert.
    expect(result).toContain('srv-00');
    expect(result).toContain('inventory rows 0-2 of 60');
    expect(result).not.toContain('someone-elses-estimate');

    // The only read of the calculator table is the ownership-checked one before the loop. A
    // tool that went back to DynamoDB would be a tool that could be pointed somewhere else.
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(GetCommand)[0].args[0].input.Key).toEqual({ calculation_id: 'calc-9' });
  });

  test('the read-only tools are built per record, so a stranger never reaches one', async () => {
    record = calculation({ owner_user_id: 'somebody-else' });
    const stream = capturingStream();

    await handler(turnEvent(), stream);

    // Refused before the stream opens, so it is a real 403 rather than an in-band error.
    expect(stream.metadata?.statusCode).toBe(403);
    expect(bedrockMock.commandCalls(ConverseStreamCommand)).toHaveLength(0);
  });
});

describe('both bounds end the loop out loud', () => {
  test('the iteration cap stops after MAX_MODEL_TURNS and says the answer may be incomplete', async () => {
    // One scripted turn, repeated: the model never stops asking for a look-up.
    script({ text: 'Still checking.', tool: { name: 'list_inventory_rows', input: { start: 0, count: 1 } } });
    const stream = capturingStream();

    await handler(turnEvent(), stream);

    expect(requests()).toHaveLength(MAX_MODEL_TURNS);
    expect(deltaText(stream)).toContain(`I stopped after ${MAX_MODEL_TURNS} rounds of looking things up`);
    // Silence here would be the defect: the user cannot tell a capped investigation from a
    // finished one, and would read the last figure as final.
    expect(deltaText(stream)).toContain('may be incomplete');
    expect(events(stream).some(event => event.type === 'done')).toBe(true);
  });

  test('the wall-clock budget stops the loop even with iterations to spare, and says so', async () => {
    script({ text: 'Working.', tool: { name: 'list_inventory_rows', input: { start: 0, count: 1 } } });
    const emitted: string[] = [];
    // A clock that jumps past the budget on its second reading: the bound is checked between
    // turns, so this ends the loop after one turn while five iterations remain.
    let reading = 0;
    const now = () => {
      reading += 1;
      return reading === 1 ? 0 : LOOP_WALL_CLOCK_MS + 1;
    };

    const outcome = await runToolLoop({
      modelId: 'global.anthropic.claude-sonnet-5',
      system: 'system',
      messages: [{ role: 'user', content: [{ text: 'how long?' }] }],
      toolSpecs: [],
      readTools: new Map(buildCalculatorReadTools(record).map(tool => [tool.name, tool])),
      emit: text => emitted.push(text),
      onProposal: () => undefined,
      now,
    });

    expect(outcome.stoppedBy).toBe('time');
    expect(outcome.turns).toBe(1);
    expect(outcome.turns).toBeLessThan(MAX_MODEL_TURNS);
    expect(emitted.join('')).toContain('ran out of time working through that');
    // What was persisted is exactly what was shown, notice included.
    expect(outcome.answer).toBe(emitted.join(''));
  });

  test('an answer truncated by the token cap says it was cut off instead of just stopping', async () => {
    script({ text: 'The first eight scenarios are', stopReason: 'max_tokens' });
    const stream = capturingStream();

    await handler(turnEvent(), stream);

    expect(requests()).toHaveLength(1);
    expect(deltaText(stream)).toContain('ran into the length limit');
  });
});

describe('a proposal still ends the turn, and carries its scenarios', () => {
  const MATRIX = {
    summary: 'Price FY26-27 three ways, and the lower environments on the same terms.',
    instruction: 'Price the production fleet on-demand, 1-year no-upfront reserved and 3-year all-upfront reserved.',
    scenarios: [
      { label: 'FY26-27 on-demand', pricing_model: 'on-demand', scope: 'FY26-27', environments: ['Production'] },
      {
        label: 'FY26-27 3-year all-upfront',
        pricing_model: 'ri-3yr-all-upfront',
        scope: 'FY26-27',
        environments: ['Production'],
        note: 'EC2 fleet on 3-year all-upfront reserved; Fargate stays on-demand because it has no reserved purchase model.',
      },
    ],
    deliverables: ['docx', 'xlsx'],
  };

  test('a scenario matrix validates against the schema and reaches the browser intact', async () => {
    script({ text: 'Proposing three scenarios for FY26-27.', tool: { name: 'propose_estimate_change', input: MATRIX } });
    const stream = capturingStream();

    await handler(turnEvent('price FY26-27 three ways please'), stream);

    const proposals = events(stream).filter((event): event is Extract<ChatStreamEvent, { type: 'proposal' }> => event.type === 'proposal');
    expect(proposals).toHaveLength(1);
    const proposal = EstimateChangeProposalSchema.parse(proposals[0].proposal);
    expect(proposal.scenarios.map(scenario => scenario.pricing_model)).toEqual(['on-demand', 'ri-3yr-all-upfront']);
    // `environments` defaults rather than being required, which is what keeps a whole-estimate
    // scenario expressible without the model remembering to say so.
    expect(proposal.scenarios[0].environments).toEqual(['Production']);
    expect(proposal.deliverables).toEqual(['docx', 'xlsx']);

    // One request, not two: the chat never applies anything, so there is nothing to feed back
    // after a proposal and continuing would stack competing diffs behind one Apply button.
    expect(requests()).toHaveLength(1);
  });

  test('the tool spec offers the closed pricing-model enum, so a free-text spelling is never taught', async () => {
    script({ text: 'ok' });

    await handler(turnEvent(), capturingStream());

    const spec = requests()[0].toolConfig?.tools.find(tool => tool.toolSpec.name === 'propose_estimate_change') as any;
    expect(spec.toolSpec.inputSchema.json.properties.scenarios.items.properties.pricing_model.enum)
      .toContain('compute-savings-3yr');
    expect(spec.toolSpec.inputSchema.json.properties.requirement_patches.items.properties.field.description)
      .toContain('fargate.taskFrequency');
    // The read-only tools are advertised alongside it, from the loaded record rather than the
    // app name.
    expect(requests()[0].toolConfig?.tools.map(tool => tool.toolSpec.name)).toContain('list_inventory_rows');
    expect(requests()[0].toolConfig?.tools.map(tool => tool.toolSpec.name)).toContain('pipeline_progress');
  });

  test('a semantic proposal carries typed requirement patches to the browser', async () => {
    script({
      text: 'I have prepared that change for review.',
      tool: {
        name: 'propose_estimate_change',
        input: {
          summary: 'Change Fargate to daily task frequency.',
          instruction: 'Audit: change Fargate to 10 tasks per day.',
          requirement_patches: [{
            target: { serviceFamily: 'AWS Fargate' },
            field: 'fargate.taskFrequency',
            operation: 'set',
            value: 'perDay',
            source: 'user',
            sourceInstruction: 'change Fargate to 10 tasks per day',
          }],
        },
      },
    });
    const stream = capturingStream();

    await handler(turnEvent('change Fargate to 10 tasks per day'), stream);

    const proposals = events(stream).filter((event): event is Extract<ChatStreamEvent, { type: 'proposal' }> => event.type === 'proposal');
    expect(proposals).toHaveLength(1);
    const proposal = EstimateChangeProposalSchema.parse(proposals[0].proposal);
    expect(proposal.requirement_patches).toEqual([
      expect.objectContaining({
        target: { serviceFamily: 'AWS Fargate' },
        field: 'fargate.taskFrequency',
        value: 'perDay',
      }),
    ]);
  });

  test('a proposal that fails validation is handed back once, then given up on in words', async () => {
    // `instruction` is required and absent, so zod rejects it both times.
    script({ tool: { name: 'propose_estimate_change', input: { summary: 'make it cheaper' } } });
    const stream = capturingStream();

    await handler(turnEvent('make it cheaper'), stream);

    // Two attempts: the retry the loop made possible, and no more than that.
    expect(requests()).toHaveLength(2);
    expect(toolResults(requests()[1])[0]).toContain('rejected before the user saw it');
    expect(events(stream).filter(event => event.type === 'proposal')).toHaveLength(0);
    expect(deltaText(stream)).toContain('I could not put that change together properly.');
  });
});

describe('what the loop must not change about the endpoint', () => {
  test('calculator chat uses the routed Haiku contract on every turn of a simple request', async () => {
    script(
      { tool: { name: 'pipeline_progress', input: {} } },
      { text: 'It finished.' },
    );

    await handler(turnEvent('is it done?'), capturingStream());

    const calls = bedrockMock.commandCalls(ConverseStreamCommand);
    expect(calls.every((call) => String(call.args[0].input.modelId).includes('claude-haiku-4-5'))).toBe(true);
    for (const request of requests()) {
      expect(request.inferenceConfig.temperature).toBe(0.2);
      expect(request.inferenceConfig.maxTokens).toBe(4000);
    }
  });

  test('a Bedrock failure part-way through the loop is reported in-band under the committed 200', async () => {
    let call = 0;
    bedrockMock.on(ConverseStreamCommand).callsFake(() => {
      call += 1;
      if (call === 1) {
        const frames = framesFor({ text: 'Checking.', tool: { name: 'list_inventory_rows', input: {} } }, 1);
        return { stream: (async function* replay() { for (const frame of frames) yield frame; })() };
      }
      throw new Error('ThrottlingException');
    });
    const stream = capturingStream();

    await handler(turnEvent(), stream);

    // The status was fixed by the first delta, so the only way to report this is a line
    // inside the 200 — and the text already shown stays shown.
    expect(stream.metadata?.statusCode).toBe(200);
    expect(deltaText(stream)).toContain('Checking.');
    const failure = events(stream).find((event): event is Extract<ChatStreamEvent, { type: 'error' }> => event.type === 'error');
    expect(failure?.message).toContain('could not finish that reply');
    expect(stream.ended).toBe(true);
  });

  test('a turn that could not be persisted still reports done with seq 0', async () => {
    script({ text: 'It finished.' });
    ddbMock.on(PutCommand).rejects(new Error('table is throttled'));
    const stream = capturingStream();

    await handler(turnEvent(), stream);

    // seq 0 is the sentinel the browser must OMIT rather than echo back to an apply route,
    // and it is how "answered but not remembered" is distinguished from a lost turn.
    const done = events(stream).find((event): event is Extract<ChatStreamEvent, { type: 'done' }> => event.type === 'done');
    expect(done?.seq).toBe(0);
  });

  test('the whole loop is skipped for an entity the caller does not own', async () => {
    record = calculation({ owner_user_id: 'somebody-else' });
    const stream = capturingStream();

    await handler(turnEvent(), stream);

    expect(stream.metadata?.statusCode).toBe(403);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });
});

describe('the pipeline progress tool is the only source of a stage or a time', () => {
  test('a running estimate reports the stage and the range that progress-eta derived', async () => {
    const now = 1_700_000_000_000;
    record = calculation({
      status: 'PROCESSING',
      result: undefined,
      progress_stage: 'pricing',
      progress_message: 'Pricing 12 group(s) from live AWS rates',
      progress_started_at: now - 90_000,
      progress_stage_started_at: now - 20_000,
      progress_history: [
        { stage: 'connecting', at: now - 90_000 },
        { stage: 'grouping', at: now - 70_000 },
        { stage: 'classifying', at: now - 60_000 },
        { stage: 'pricing', at: now - 20_000 },
      ],
    });
    script({ tool: { name: 'pipeline_progress', input: {} } }, { text: 'Still pricing.' });

    await handler(turnEvent('is it still running?'), capturingStream());

    const result = toolResults(requests()[1])[0];
    expect(result).toContain('Status: PROCESSING');
    expect(result).toContain('Pricing from live AWS rates');
    // The prose is handed over verbatim and the model is told to use those words, because a
    // stage and a duration are the two things it is most willing to invent.
    expect(result).toContain('Say this to the user, in these words:');
    expect(result).toContain('step 4 of 6');

    // The same sentence is already in the context block, so "is it still running" needs no
    // tool call at all — the tool exists for the same question asked late in a long turn.
    expect(requests()[0].system[0].text).toContain('Where this run is');
    expect(requests()[0].system[0].text).toContain('Pricing from live AWS rates');
  });

  test('a finished estimate is not passed through the estimator, so it cannot claim a nonsense duration', async () => {
    script({ text: 'It is done.' });

    await handler(turnEvent(), capturingStream());

    const block = requests()[0].system[0].text;
    // estimateProgress falls back to created_at when the worker never stamped a start, which
    // on a record from last week reads as "Finished in about 11000 minutes".
    //
    // dd-MM-yyyy, and in IST: formatDate renders in Asia/Kolkata, so this instant is the 15th
    // here and the 14th in UTC. A test asserting the UTC day would pass in CI and fail on the
    // machine of anyone who read the date off the page.
    expect(block).toContain('Finished on: 15-11-2023');
    expect(block).not.toContain('Say this if asked how it is going');
  });
});

describe('the context block covers the scenarios and links it used to drop', () => {
  test('every priced scenario appears with its own link and its addition caveat', async () => {
    record = calculation({
      result: {
        ...calculation().result!,
        url: 'https://calculator.aws/#/estimate?id=baseline',
        scenarios: [
          { key: '26-27', label: 'FY26-27', kind: 'period', monthly: 4269.65, url: 'https://calculator.aws/#/estimate?id=fy2627', detail: '10 Fargate tasks' },
          { key: '27-28', label: 'FY27-28', kind: 'period', monthly: 5312.4, url: 'https://calculator.aws/#/estimate?id=fy2728' },
        ],
      },
    });
    script({ text: 'Two years are priced.' });

    await handler(turnEvent('what have we priced so far?'), capturingStream());

    const block = requests()[0].system[0].text;
    expect(block).toContain('FY26-27');
    // The per-scenario links were dropped entirely before this: only the result-level url was
    // passed, so a five-year model collapsed to one link a client cannot budget from.
    expect(block).toContain('https://calculator.aws/#/estimate?id=fy2627');
    expect(block).toContain('https://calculator.aws/#/estimate?id=fy2728');
    expect(block).toContain('adding their monthly totals gives a multi-year');
  });

  test('the revision that produced this estimate is stated, since a revision is a new record', async () => {
    record = calculation({ revision_of: 'calc-1', revision_number: 3, revision_instruction: 'move the web tier to 3-year reserved' });
    script({ text: 'This is revision three.' });

    await handler(turnEvent('what changed last time?'), capturingStream());

    const block = requests()[0].system[0].text;
    expect(block).toContain('This estimate revises: calc-1');
    expect(block).toContain('Revision number: 3');
    expect(block).toContain('move the web tier to 3-year reserved');
  });
});
