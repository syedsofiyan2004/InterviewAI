/**
 * SUPERSEDED — no longer on the estimate path. See ./pipeline.ts.
 *
 * This is the agentic tool-use loop the Cost Calculator used to run. It is kept because
 * it works and is covered by tests, but index.ts no longer imports it, so nothing here
 * is bundled or executed. Read pipeline.ts for why it was replaced: four consecutive
 * live runs of the real COSEC workbook failed, each structurally rather than from a bug
 * in this file — one tool call per turn twice over, then a turn too large to generate
 * inside its own timeout, then a final generation that exceeded max_tokens and could not
 * be parsed. The common cause was asking a model to emit work that is a hash and some
 * arithmetic, and generation is what costs the minutes and what truncates.
 *
 * Bedrock tool-use loop for the Cost Calculator.
 *
 * It turns a plain-English workload description into a real AWS Pricing Calculator
 * estimate by letting Claude drive the sidecar's MCP tools, then returns the
 * shareable URL plus a breakdown.
 *
 * It was deliberately the first multi-turn tool-use code in this repo. Every other
 * Bedrock call here is single-shot (`anthropicRequestBody` in api-handler/index.ts
 * emits exactly one user message and cannot carry tools), so the request builder,
 * the loop, and the tool_use-aware response reader are all new. What is *not* new
 * and is copied on purpose: the `bedrock-2023-05-31` version string, the
 * "no temperature for sonnet-5" guard, profile-ARN resolution from env, and
 * AbortController-based timeouts.
 */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import type { McpSidecarClient, McpTool } from './mcp-client';
import { HOURS_PER_MONTH, lookupPrice } from './aws-pricing';

const REGION = process.env.AWS_REGION || 'ap-south-1';
const SONNET_5_MODEL_ID = 'global.anthropic.claude-sonnet-5';

/**
 * Our own tool, offered alongside the sidecar's.
 *
 * The MCP server can build and save an estimate but cannot price one: a saved
 * calculator.aws estimate carries no money, because the pricing runs in the browser.
 * This closes that gap with the AWS Price List Query API — the documented source of
 * published rates — so the model can obtain a real rate per resource and derive a
 * monthly cost from it.
 */
const PRICE_TOOL_NAME = 'get_aws_price';

const PRICE_TOOL = {
  name: PRICE_TOOL_NAME,
  description: [
    'Look up a published AWS on-demand price from the AWS Price List Query API.',
    'Returns { found, ratePerUnit, unit, description }. The rate is per unit (Hrs for compute, GB-Mo for storage).',
    'Use this for EVERY resource you need a cost for — the calculator.aws estimate does not contain prices.',
    'Pass Price List attribute filters exactly as that API names them. Common ones:',
    '- EC2 compute: serviceCode "AmazonEC2", filters { instanceType: "t3.large" }. Linux/Shared/no-preinstalled-software/Used-capacity are applied for you; override operatingSystem or tenancy only if the workload differs.',
    '- EBS volume: serviceCode "AmazonEC2", filters { volumeApiName: "gp3" } — priced per GB-month.',
    '- RDS instance: serviceCode "AmazonRDS", filters { instanceType: "db.t3.medium", databaseEngine: "PostgreSQL", deploymentOption: "Multi-AZ" }.',
    '- RDS storage: serviceCode "AmazonRDS", filters { volumeName: "General Purpose-GP3" } — per GB-month.',
    '- S3 storage: serviceCode "AmazonS3", filters { storageClass: "General Purpose", volumeType: "Standard" } — per GB-month.',
    '- Load balancer: serviceCode "AWSELB", filters { usagetype: "APS3-LoadBalancerUsage" } or productFamily "Load Balancer-Application".',
    '- NAT gateway: serviceCode "AmazonVPC", filters { usagetype: "APS3-NatGateway-Hours" }.',
    'If found is false, read the message, adjust the filters, and try once or twice more before reporting the line as unpriced.',
  ].join('\n'),
  input_schema: {
    type: 'object',
    properties: {
      serviceCode: { type: 'string', description: 'Price List service code, e.g. AmazonEC2' },
      region: { type: 'string', description: 'Region code being priced, e.g. ap-south-1' },
      filters: {
        type: 'object',
        description: 'TERM_MATCH attribute filters, e.g. {"instanceType":"t3.large"}',
        additionalProperties: { type: 'string' },
      },
    },
    required: ['serviceCode', 'region'],
  } as Record<string, unknown>,
};

const BATCH_TOOL_NAME = 'batch';
/**
 * Upper bound on one batch.
 *
 * Not only a runaway guard. Every call in a batch is output tokens the model must generate
 * before the turn returns, so an oversized batch trades one failure mode for another — a
 * 40-call batch took long enough to generate that it blew the per-call ceiling. Twenty is
 * still twenty times better than one call per turn, and two batches beat one that dies.
 */
const MAX_BATCH_CALLS = 20;
/** How many price lookups run at once inside a batch. Read-only queries, so this is safe. */
const PRICE_CONCURRENCY = 6;
/** The calls that multiply with the size of an uploaded inventory. */
const BATCHABLE = new Set(['get_service_fields', 'add_service', PRICE_TOOL_NAME]);

/**
 * Our own tool, and the one that makes an uploaded inventory finishable.
 *
 * Every turn of this loop costs a full Bedrock round trip — measured at ~11s against the
 * real COSEC workbook — and a 25-group inventory needs 60-80 calls. Two live runs were
 * told in the system prompt to put several tool_use blocks in one turn and ignored it
 * both times, emitting exactly one call per turn until the clock ran out. Asking a model
 * to change its output shape is unreliable; giving it a single tool whose whole purpose
 * is "do all of these" is not, because batching becomes one ordinary tool call.
 */
const BATCH_TOOL = {
  name: BATCH_TOOL_NAME,
  description: [
    'Run many tool calls in ONE turn and get all their results back together.',
    'This is the only way to finish a sizeable inventory: a turn costs ~10s of wall clock,',
    'so 60 calls made one per turn cannot complete inside the time budget.',
    'Pass calls as [{ "name": "add_service", "input": { ... } }, ...] using each tool\'s own',
    'argument shape, exactly as you would have called it alone.',
    `At most ${MAX_BATCH_CALLS} calls per batch.`,
    'Calls run in the order given, except get_aws_price lookups, which run concurrently',
    'because they only read published rates.',
    'Returns an array of { call, name, ok, result } — one entry per call, same order.',
    'A failure in one call does not stop the others: read each ok flag and retry just those.',
  ].join('\n'),
  input_schema: {
    type: 'object',
    properties: {
      calls: {
        type: 'array',
        description: 'The calls to run, in order.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Tool name, e.g. add_service or get_aws_price' },
            input: { type: 'object', description: "That tool's arguments", additionalProperties: true },
          },
          required: ['name', 'input'],
        },
      },
    },
    required: ['calls'],
  } as Record<string, unknown>,
};

/** What the model is told when the clock ran out before its call was reached. */
const SKIPPED_CALL_TEXT =
  'Not run: the time budget is spent and the estimate must be written up now. '
  + 'Report this resource as unpriced rather than waiting for it.';

/** Matches the resolution used across api-handler/index.ts and processor/index.ts. */
function resolveModelId(): string {
  return process.env.BEDROCK_SONNET_5_PROFILE_ARN || SONNET_5_MODEL_ID;
}

/**
 * Output ceiling per turn.
 *
 * Raised from 8k: the final <calculation_json> for an uploaded landscape carries a
 * line item per group with its arithmetic spelled out in workings, and truncation
 * there is unrecoverable -- the JSON cannot be parsed, so the whole run is lost.
 * This is a ceiling, not a target; ordinary turns are nowhere near it.
 */
const MAX_TOKENS = 16_000;
/**
 * Ceiling on model turns. Each iteration is one Bedrock round-trip plus the tools it
 * asks for, so this bounds both cost and wall-clock.
 *
 * A hand-described workload needs 6-10 turns. An uploaded inventory needs far more: the
 * COSEC model folds to 25 groups spanning a dozen services, and each one wants
 * get_service_fields, add_service and get_aws_price. The first live run of that sheet
 * hit 24 and died with nothing -- the sidecar log showed 8 add_service calls in 24
 * turns, because the model was asking for one tool per turn. The prompt now tells it to
 * batch (see BATCH YOUR TOOL CALLS below), which is the actual fix; this ceiling is
 * raised so the batching has room to pay off rather than being the thing that bites.
 *
 * In practice LOOP_DEADLINE_MS binds first -- at roughly 17s a turn the clock runs out
 * near turn 38 -- and reaching either now ends in a written answer rather than a throw.
 */
const MAX_ITERATIONS = 60;
/**
 * Whole-loop budget. The orchestrator Lambda is configured well above this.
 *
 * Enforced before every Bedrock call AND before every tool call, not just once per
 * iteration: a single turn can ask for several tools, and at 120s per Bedrock call
 * plus 60s per tool a turn beginning just inside the budget could run for minutes
 * past it. Overshooting means the Lambda is killed mid-loop, which leaves the row
 * at PROCESSING with no failure write and the UI polling forever — so the budget
 * has to bind at every await that can block, not just at the top of the turn.
 */
const LOOP_DEADLINE_MS = 11 * 60 * 1000;
/**
 * Budget held back for writing the answer down.
 *
 * When less than this is left the loop stops gathering and spends its remaining time
 * on the final breakdown. The orchestrator Lambda has 15 minutes, so 11 for the loop
 * plus this reserve still leaves minutes for the DynamoDB write.
 */
const FINALISE_RESERVE_MS = 165_000;
/**
 * Per-Bedrock-call timeout.
 *
 * 120s was fine while a turn carried one tool call, and became the thing that killed runs
 * the moment batching made turns big: a batch of add_service configs is thousands of
 * output tokens, generation ran past the ceiling, and this AbortController ended a run
 * that still had 477 of its 660 seconds unspent.
 */
const BEDROCK_CALL_TIMEOUT_MS = 300_000;
/** Per-tool-call ceiling. Narrowed to whatever the loop budget has left. */
const TOOL_CALL_TIMEOUT_MS = 60_000;

const SYSTEM_PROMPT = `You are a cloud cost estimator for Minfy. You turn a described workload into a real AWS Pricing Calculator estimate AND a priced cost breakdown.

USE THE "batch" TOOL FOR EVERYTHING REPEATED. Each turn costs about ten seconds of real
time and a described inventory needs sixty to eighty calls, so one call per turn does not
finish — it runs out of time with nothing saved. batch takes a calls array of
{ name, input } and runs all of them in a single turn, handing you every result at once:
all the get_service_fields together, then all the add_service calls together, then all
the get_aws_price lookups together. One batch carries up to 40 calls. Keep single calls
for the genuinely one-off steps — create_estimate, validate_estimate, export_estimate.
Create the estimate ONCE: if you already created one, keep adding to it. Never start over.

There are two halves to your job, and both are required:

A. BUILD THE ESTIMATE (the shareable link)
1. Call search_services to find the service keys you need.
2. Call get_service_fields before configuring ANY service, every time. This is not optional: several services need more fields than the schema marks as required, and without them the estimate saves successfully but prices at $0 (Lambda, for example, needs sizeOfMemoryAllocated, storageAmountEphemeral and architecture). When the response includes a "catalog" block, start from its minimalConfig and modify it, and obey its traps[]. Never guess field IDs or option values from memory.
3. Put every resource in a group named after its environment ("Production", "Staging", "Dev"). The calculator renders these as folders and the report's subtotals come from them, so an ungrouped resource cannot be attributed.
4. Where the workload arrives as GROUPS carrying a count ("12 x m6a.xlarge"), add ONE service for the group and set its quantity / number-of-instances field to that count. Do not add a service per machine: an uploaded inventory runs to hundreds or thousands of rows, and an estimate with a line for each is unreadable, slow to save, and prices the same configuration over and over.
5. Apply the runtime hours. For any resource whose environment runs fewer than 24 hours a day, find that service's utilization field with get_service_fields and set it to that share of the day. Without this a machine that runs 8 hours a day is configured as if it ran all month.
6. Call validate_estimate, then export_estimate (or build_estimate) to save and get the shareable URL. Do this as soon as every service is added and BEFORE you start pricing — the URL is the one thing that cannot be reconstructed later, so get it banked while there is plenty of turn budget left. Build exactly ONE estimate, for the BASELINE sizing. Where a second, right-sized scenario is supplied it is priced but never saved — the shareable link has to describe the configuration the client has actually agreed to.

B. PRICE IT (the numbers)
The saved calculator.aws estimate contains NO money — it stores configuration, and AWS computes pricing in the browser when a person opens the link. import_estimate reads back configuration only, with an empty subtotal. So you must price the workload yourself using get_aws_price, which returns published AWS rates from the Price List Query API.

For every resource:
7. Call get_aws_price for its rate. Retry with corrected filters if found is false.
8. Derive the monthly cost from that rate:
   - Billed per hour (unit "Hrs"): a billing month is exactly ${HOURS_PER_MONTH} hours, and partial-day use is that share of it. monthly = ratePerUnit x ${HOURS_PER_MONTH} x (hoursPerDay / 24) x quantity. So 24h/day uses all ${HOURS_PER_MONTH} hours and 8h/day uses ${(HOURS_PER_MONTH / 3).toFixed(1)}. Use ${HOURS_PER_MONTH}, not 30 x 24 — AWS and the Pricing Calculator both bill a month as ${HOURS_PER_MONTH} hours, and anything else makes this document disagree with the estimate link. Set timeBilled true and record hoursPerDay.
   - Where the workload states hours per MONTH directly, use that figure as given: monthly = ratePerUnit x hoursPerMonth x quantity. Do not convert it to hours per day first. A "12x5" schedule is exactly 260 hours a month, which is 8.55 hours a day and no whole number at all, so re-deriving it puts an error into every row that has one.
   - Where a group names a purchase model ("3-Yr No Upfront", "1-Yr Partial Upfront", "Compute Savings Plan", "On-Demand"), price it on that term and name the term in workings. Quoting On-Demand for a committed-term row overstates the cost by roughly a third to a half, which is the entire saving the client is being shown.
   - Billed per GB-month (unit "GB-Mo"): monthly = ratePerUnit x gigabytes. Set timeBilled false; hours do not apply to storage.
9. Put the arithmetic in "workings" exactly as you calculated it, including the rate, so a reader can check it. Example: "$0.0896/hr x 8h/day (243.3 of ${HOURS_PER_MONTH} hrs/month) x 2 = $43.61/mo".
10. If get_aws_price cannot find a rate after a couple of attempts, set monthly to null and add a warning naming the resource. NEVER substitute a price you remember — a number you invented is worse than a gap, because nobody can tell it is wrong.
11. Sum the line items into monthlyTotal, and per environment into environments[].
12. If a SCENARIO 2 (right-sized) list was supplied, price it the same way from the same live rates and put BOTH totals in scenarios[], baseline first. lineItems, monthlyTotal and environments[] always describe the BASELINE; the right-sized scenario needs only its total and one line saying how it was sized. Where the workload came from prose rather than an uploaded sheet there is only one sizing — omit scenarios entirely rather than inventing a second.
13. If the uploaded sheet stated a monthly total of its own, echo it verbatim as reportedMonthlyTotal. It is what the client believed before this was checked, never a price: every figure you report comes from get_aws_price. If your total differs from theirs by more than 20%, say so in warnings and name the likeliest reason (a rate that has moved, a different purchase term, a resource their model omitted).

Rules:
- Use the region the user asked for. If they did not name one, use ap-south-1 (Mumbai) and record that in assumptions.
- add_service ALWAYS APPENDS. If a save attempt went wrong, do NOT re-add the same service to the same estimate — that creates a duplicate line and inflates the cost. Start over with create_estimate.
- If a call is refused or warns, read its next_step text and fix the input rather than retrying it unchanged.
- Where the user is vague (instance size, request volume, storage), choose a defensible small-production default and state it in assumptions. Do not ask the user questions; you cannot — this runs unattended.

When the estimate is saved and every line is priced, stop calling tools and reply with ONLY this, no prose before or after:

<calculation_json>
{
  "url": "<the calculator.aws shareable URL, or null if no estimate was saved>",
  "currency": "USD",
  "monthlyTotal": <sum of line item monthly values, or null if none could be priced>,
  "lineItems": [{
    "service": "<name>",
    "detail": "<config summary>",
    "monthly": <number or null>,
    "workings": "<the arithmetic, including the rate>",
    "environment": "<the group you put it in>",
    "hoursPerDay": <the hours you priced it at, 1-24>,
    "timeBilled": <true for hourly-billed compute, false for storage and usage-based services>
  }],
  "environments": [{ "name": "<environment>", "hoursPerDay": <1-24>, "monthly": <sum for that environment or null> }],
  "scenarios": [
    { "key": "baseline", "label": "<short name, e.g. Lift-and-shift>", "monthly": <number or null>, "detail": "<how it was sized>" },
    { "key": "rightsized", "label": "<short name, e.g. Right-sized>", "monthly": <number or null>, "detail": "<how it was sized>" }
  ],
  "reportedMonthlyTotal": <the monthly total the uploaded sheet calculated for itself, or null>,
  "assumptions": ["<each default you chose on the user's behalf>"],
  "warnings": ["<anything you could not price, or a tool warned about; omit if none>"]
}
</calculation_json>

Omit "scenarios" and "reportedMonthlyTotal" when the workload came from prose rather than an uploaded sheet: there is one sizing and no figure of the client's to compare against.

Be accurate about "timeBilled": the report derives what scheduled shutdown saves from those lines alone, so marking storage as time-billed invents a saving that does not exist.`;

/** Anthropic tool schema, as carried in the InvokeModel request body. */
interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

function toAnthropicTools(tools: McpTool[]): AnthropicTool[] {
  return [
    ...tools.map(tool => ({
      name: tool.name,
      description: tool.description ?? tool.name,
      // MCP's inputSchema is already JSON Schema, which is what Anthropic expects.
      input_schema: (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
    })),
    // Ours, not the sidecar's — the sidecar has no pricing to give.
    PRICE_TOOL,
    // Ours too, and the reason the loop fits in its budget at all.
    BATCH_TOOL,
  ];
}

/**
 * The multi-turn request body. This is the piece `anthropicRequestBody` cannot
 * express — it carries the full conversation plus the tool catalogue.
 */
function toolRequestBody(
  modelId: string,
  messages: unknown[],
  tools: AnthropicTool[],
  system: string,
  temperature = 0,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: MAX_TOKENS,
    system,
    messages,
    // Omitted when empty rather than sent as []: the final write-up turn is made with
    // no tools at all, so the model cannot reach for one instead of answering.
    ...(tools.length ? { tools } : {}),
  };
  // Sonnet 5 rejects an explicit temperature; every builder in this repo guards the
  // same way. Keep the guard identical so behaviour stays consistent across models.
  if (!modelId.includes('claude-sonnet-5')) {
    body.temperature = temperature;
  }
  return body;
}

/**
 * What the model is told on its last turn.
 *
 * It is sent with no tools attached, so this is not a request it can decline by calling
 * something else. Every instruction here exists because the alternative is worse: a null
 * monthly with a warning is auditable, whereas a remembered price is a fabrication and a
 * dropped line item hides a resource the client is paying for.
 */
const FINAL_TURN_INSTRUCTION = `STOP. You have no tools on this turn and no turns left after it. Write the answer now from what you already have.

Output the <calculation_json> block exactly as specified, using the rates you have already looked up.
- Keep a line item for every resource you were given, including ones you did not reach: set monthly to null for those and add a warning naming each one and saying its rate was not retrieved.
- Never substitute a price from memory for a rate you did not look up.
- If you never saved an estimate, set "url" to null and add a warning saying the shareable link was not created.
- Sum only what you actually priced, and say in warnings that the total covers part of the landscape.
A breakdown with its gaps named is the required answer. Returning nothing is a failure.`;

/**
 * Appends a text block to the trailing user message, or starts a new one.
 *
 * The final-turn instruction has to arrive in the same user turn as the last batch of
 * tool results, so the tool_result blocks stay bound to the tool_use blocks that asked
 * for them. Pushing a second consecutive user message would work but is needless.
 */
function appendUserText(messages: any[], text: string): void {
  const last = messages[messages.length - 1];
  if (last && last.role === 'user' && Array.isArray(last.content)) {
    last.content.push({ type: 'text', text });
    return;
  }
  messages.push({ role: 'user', content: [{ type: 'text', text }] });
}

export interface LoopProgress {
  (update: { iteration: number; stage: string; message: string }): Promise<void> | void;
}

export interface LoopOutcome {
  /** Raw final assistant text — expected to contain the <calculation_json> block. */
  finalText: string;
  iterations: number;
  toolCalls: { name: string; isError: boolean }[];
}

/** Tool state that has to outlive a single turn. */
type CallState = { estimate?: string };

/** One tool invocation's outcome, in the shape the model gets back. */
type CallOutcome = { text: string; isError: boolean };

/** Everything a tool call needs that does not come from its own arguments. */
type CallContext = {
  mcp: McpSidecarClient;
  remaining: () => number;
  state: CallState;
  onCall?: (name: string) => Promise<void>;
};

/**
 * Runs one tool call, wherever it came from — a turn's tool_use block or inside a batch.
 *
 * Faults are returned as tool errors rather than thrown. Upstream's messages are
 * actionable and the model can usually recover (re-discover fields, fix filters, retry),
 * whereas throwing here discards every rate already gathered.
 */
async function executeCall(
  name: string,
  input: any,
  ctx: CallContext,
  depth = 0,
): Promise<CallOutcome> {
  if (name === BATCH_TOOL_NAME) {
    // Depth-1 only: a nested batch would make the reserve arithmetic unanalysable, and
    // there is no reason to write one.
    if (depth > 0) {
      return { text: 'A batch cannot contain another batch. List the calls directly.', isError: true };
    }
    return executeBatch(input, ctx);
  }

  // The write-up's reserve is not available to tool calls either, however many the model
  // asked for in one go.
  if (ctx.remaining() <= FINALISE_RESERVE_MS) {
    return { text: SKIPPED_CALL_TEXT, isError: true };
  }

  await ctx.onCall?.(name);

  try {
    if (name === PRICE_TOOL_NAME) {
      // Handled here rather than on the sidecar: it is our tool, backed by the AWS Price
      // List API.
      const args = (input || {}) as { serviceCode?: string; region?: string; filters?: Record<string, string> };
      const price = await lookupPrice({
        serviceCode: String(args.serviceCode || ''),
        region: String(args.region || ''),
        filters: args.filters,
      });
      // A miss is not a fault — the model is expected to adjust filters and retry, so
      // this must not be flagged as an error turn.
      return { text: JSON.stringify(price), isError: false };
    }

    if (name === 'create_estimate' && ctx.state.estimate) {
      // Refusing this is the whole point. On a live run the model created a second
      // estimate at turn 20, silently orphaning the services it had added at 16 and 17,
      // and the exported link described a fraction of the workload.
      return {
        text: 'You already created an estimate earlier in this run and it is still open. Do NOT create '
          + 'another one — add the remaining services to the existing estimate and export that one. '
          + `Its create_estimate response was:\n${ctx.state.estimate}`,
        isError: true,
      };
    }

    const outcome = await ctx.mcp.callTool(
      name,
      input ?? {},
      Math.min(TOOL_CALL_TIMEOUT_MS, Math.max(1_000, ctx.remaining())),
    );
    if (name === 'create_estimate' && !outcome.isError) {
      ctx.state.estimate = outcome.text;
    }
    return { text: outcome.text, isError: outcome.isError };
  } catch (error) {
    return { text: `Tool transport failure: ${(error as Error).message}`, isError: true };
  }
}

/**
 * Runs a batch of calls and reports each one's outcome separately.
 *
 * Ordering: everything except pricing runs strictly in the order given, because
 * add_service mutates one shared in-flight estimate and its ordering is observable.
 * Price lookups are pure reads of the Price List API, so they go out concurrently — for
 * a 25-group inventory that is the difference between ~4s and ~25s inside one turn.
 */
async function executeBatch(input: any, ctx: CallContext): Promise<CallOutcome> {
  const calls: { name?: string; input?: any }[] = Array.isArray(input?.calls) ? input.calls : [];
  if (!calls.length) {
    return {
      text: 'batch needs a non-empty "calls" array of { name, input } objects.',
      isError: true,
    };
  }

  const accepted = calls.slice(0, MAX_BATCH_CALLS);
  const outcomes: (CallOutcome | undefined)[] = new Array(accepted.length);
  const priceAt: number[] = [];

  accepted.forEach((call, at) => {
    if (call?.name === PRICE_TOOL_NAME) priceAt.push(at);
  });

  // Estimate-mutating half first, in order.
  for (let at = 0; at < accepted.length; at += 1) {
    if (accepted[at]?.name === PRICE_TOOL_NAME) continue;
    outcomes[at] = await executeCall(String(accepted[at]?.name || ''), accepted[at]?.input, ctx, 1);
  }

  // Then the pure reads, a windowful at a time.
  for (let from = 0; from < priceAt.length; from += PRICE_CONCURRENCY) {
    const window = priceAt.slice(from, from + PRICE_CONCURRENCY);
    await Promise.all(window.map(async (at) => {
      outcomes[at] = await executeCall(PRICE_TOOL_NAME, accepted[at]?.input, ctx, 1);
    }));
  }

  const report: { call: number; name: string | null; ok: boolean; result: string }[] =
    accepted.map((call, at) => ({
      call: at + 1,
      name: call?.name ?? null,
      ok: outcomes[at] ? !outcomes[at]!.isError : false,
      result: outcomes[at]?.text ?? 'Not run.',
    }));

  if (calls.length > accepted.length) {
    report.push({
      call: accepted.length + 1,
      name: BATCH_TOOL_NAME,
      ok: false,
      result: `${calls.length - accepted.length} further call(s) were dropped: one batch takes at most `
        + `${MAX_BATCH_CALLS}. Send the rest in your next batch.`,
    });
  }

  // Not flagged as an error even when individual calls failed: each carries its own ok
  // flag, and marking the batch would hide which part actually needs retrying.
  return { text: JSON.stringify(report), isError: false };
}

/**
 * Runs the conversation until Claude stops asking for tools.
 *
 * Returns the final assistant text; parsing the tagged JSON out of it is the
 * caller's job (it reuses the same tagged-JSON convention as the rest of the repo).
 */
export async function runEstimateLoop(
  prompt: string,
  mcp: McpSidecarClient,
  onProgress?: LoopProgress,
): Promise<LoopOutcome> {
  const client = new BedrockRuntimeClient({ region: REGION });
  const modelId = resolveModelId();
  const startedAt = Date.now();

  const mcpTools = await mcp.listTools();
  if (!mcpTools.length) {
    throw new Error('MCP sidecar reported no tools; refusing to start the estimate loop.');
  }
  const tools = toAnthropicTools(mcpTools);

  const messages: any[] = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
  const toolCalls: { name: string; isError: boolean }[] = [];
  // Survives across turns so a second create_estimate can be refused.
  const callState: CallState = {};
  // Set when a gathering turn fails: the run then writes up whatever it has already
  // priced, instead of dying alongside the one turn that went wrong.
  let forceFinal = false;
  let consecutiveFailures = 0;

  /** Milliseconds of budget left, floored at zero. */
  const remaining = () => LOOP_DEADLINE_MS - (Date.now() - startedAt);

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    // The last turn is spent writing the answer down, not gathering more of it.
    //
    // Running out of turns or clock used to throw, which discarded everything already
    // priced: the first live run of the COSEC workbook spent 6.9 minutes gathering live
    // rates and then reported "This estimate could not be built". Sending the final turn
    // with no tools means the model cannot reach for another call instead of answering,
    // and a partial estimate with its gaps named beats a failure every time.
    const finalTurn = forceFinal || iteration === MAX_ITERATIONS || remaining() <= FINALISE_RESERVE_MS;
    if (finalTurn) {
      appendUserText(messages, FINAL_TURN_INSTRUCTION);
      await onProgress?.({ iteration, stage: 'finalising', message: 'Writing the cost breakdown' });
    }

    if (remaining() <= 0) {
      throw new Error(`Estimate loop exceeded its ${LOOP_DEADLINE_MS / 1000}s budget after ${iteration - 1} turns.`);
    }

    const abort = new AbortController();
    // A gathering turn may not eat into the finalise reserve. On a live run turn 25 began
    // with ~90s left, spent 65s of it deciding on one more tool call, and the write-up
    // that followed was aborted mid-flight with nothing saved. Only the final turn, which
    // has no tools and nothing left to gather for, may spend everything that remains.
    const callBudget = finalTurn ? remaining() : remaining() - FINALISE_RESERVE_MS;
    const timer = setTimeout(
      () => abort.abort(),
      Math.max(10_000, Math.min(BEDROCK_CALL_TIMEOUT_MS, callBudget)),
    );
    let payload: any;
    try {
      const response = await client.send(
        new InvokeModelCommand({
          modelId,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify(toolRequestBody(modelId, messages, finalTurn ? [] : tools, SYSTEM_PROMPT)),
        }),
        { abortSignal: abort.signal },
      );
      payload = JSON.parse(new TextDecoder().decode(response.body));
      consecutiveFailures = 0;
    } catch (error) {
      // On the final turn there is nothing left to salvage into, so the failure is real.
      if (finalTurn) throw error;

      const fault = (error as Error).name || 'Error';
      const aborted = fault === 'AbortError' || /abort/i.test((error as Error).message || '');
      if (aborted) {
        // Our own ceiling fired, so this turn was too large to generate inside it.
        // Repeating it would generate the same thing and time out the same way.
        forceFinal = true;
      } else {
        // A transient Bedrock fault earns one retry. Throwing away several turns of
        // gathered rates over a single bad response would be its own bug.
        consecutiveFailures += 1;
        forceFinal = consecutiveFailures >= 2;
      }
      console.log(
        `Turn ${iteration} failed (${fault}); `
        + `${forceFinal ? 'writing up what is already priced' : 'retrying the turn'}.`,
      );
      continue;
    } finally {
      clearTimeout(timer);
    }

    const content: any[] = payload?.content ?? [];
    const stopReason: string | undefined = payload?.stop_reason;

    // Truncation mid-loop would silently drop a tool call, so surface it rather
    // than continuing with a half-formed turn.
    if (stopReason === 'max_tokens') {
      throw new Error('AI_OUTPUT_TRUNCATED: model hit max_tokens mid-estimate.');
    }

    if (stopReason !== 'tool_use') {
      const finalText = content
        .filter(block => block?.type === 'text')
        .map(block => block.text)
        .join('\n')
        .trim();
      return { finalText, iterations: iteration, toolCalls };
    }

    // Echo the assistant turn back verbatim — the tool_use blocks must be present
    // and unmodified for the tool_result blocks to bind to them.
    messages.push({ role: 'assistant', content });

    const requests = content.filter(block => block?.type === 'tool_use');
    // Logged per turn because diagnosing the 24-turn failure meant grepping the sidecar's
    // logs to count add_service calls. The tool names and the batch size are the two
    // things that explain a run that ran out of road.
    console.log(
      `Turn ${iteration}: ${requests.length} tool call(s) [${requests.map((block: any) => block.name).join(', ')}], `
      + `${Math.round(remaining() / 1000)}s budget left.`,
    );
    const ctx: CallContext = {
      mcp,
      remaining,
      state: callState,
      onCall: async (name) => {
        await onProgress?.({ iteration, stage: 'tool_use', message: `Calling ${name}` });
      },
    };

    // Each request may itself be a batch that fans out into dozens of calls, which is
    // why this no longer needs to be the place that worries about volume.
    const results: any[] = [];
    for (const request of requests) {
      const outcome = await executeCall(request.name, request.input, ctx);
      toolCalls.push({ name: request.name, isError: outcome.isError });
      results.push({
        type: 'tool_result',
        tool_use_id: request.id,
        content: [{ type: 'text', text: outcome.text }],
        ...(outcome.isError ? { is_error: true } : {}),
      });
    }

    messages.push({ role: 'user', content: results });

    // The same instruction sits in the system prompt and was ignored on two consecutive
    // live runs, so it is repeated here at the moment of the decision, with the live
    // clock in it. This arrives attached to the results the model is about to read.
    if (requests.length === 1 && BATCHABLE.has(requests[0].name)) {
      appendUserText(
        messages,
        `You just spent an entire turn on a single ${requests[0].name} call, and about `
        + `${Math.round(remaining() / 1000)}s of budget remain. At one call per turn this estimate `
        + `will not finish. Use the "batch" tool for your next step and put EVERY remaining `
        + `independent call into it — one batch carries up to ${MAX_BATCH_CALLS}.`,
      );
    }
  }

  // Unreachable: the MAX_ITERATIONS turn is always a finalTurn, which is sent without
  // tools and therefore returns text. Kept as a guard so a future change to the loop
  // condition fails loudly rather than returning undefined.
  throw new Error(
    `Estimate loop hit its ${MAX_ITERATIONS}-turn ceiling without reaching the final write-up.`,
  );
}
