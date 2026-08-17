/**
 * Bedrock tool-use loop for the Cost Calculator.
 *
 * This is the "AI" in the app: it turns a plain-English workload description into
 * a real AWS Pricing Calculator estimate by letting Claude drive the sidecar's
 * MCP tools, then returns the shareable URL plus a breakdown.
 *
 * It is deliberately the first multi-turn tool-use code in this repo. Every other
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

/** Matches the resolution used across api-handler/index.ts and processor/index.ts. */
function resolveModelId(): string {
  return process.env.BEDROCK_SONNET_5_PROFILE_ARN || SONNET_5_MODEL_ID;
}

const MAX_TOKENS = 8_000;
/**
 * Ceiling on model turns. Each iteration is one Bedrock round-trip plus the tools
 * it asks for, so this bounds both cost and wall-clock. Building a multi-service
 * estimate typically needs 6-10 turns (discover fields, add services, lint, export);
 * 24 leaves room for self-correction after a lint refusal without ever looping forever.
 */
const MAX_ITERATIONS = 24;
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
const LOOP_DEADLINE_MS = 8 * 60 * 1000;
/** Per-Bedrock-call timeout. */
const BEDROCK_CALL_TIMEOUT_MS = 120_000;
/** Per-tool-call ceiling. Narrowed to whatever the loop budget has left. */
const TOOL_CALL_TIMEOUT_MS = 60_000;

const SYSTEM_PROMPT = `You are a cloud cost estimator for Minfy. You turn a described workload into a real AWS Pricing Calculator estimate AND a priced cost breakdown.

There are two halves to your job, and both are required:

A. BUILD THE ESTIMATE (the shareable link)
1. Call search_services to find the service keys you need.
2. Call get_service_fields before configuring ANY service, every time. This is not optional: several services need more fields than the schema marks as required, and without them the estimate saves successfully but prices at $0 (Lambda, for example, needs sizeOfMemoryAllocated, storageAmountEphemeral and architecture). When the response includes a "catalog" block, start from its minimalConfig and modify it, and obey its traps[]. Never guess field IDs or option values from memory.
3. Put every resource in a group named after its environment ("Production", "Staging", "Dev"). The calculator renders these as folders and the report's subtotals come from them, so an ungrouped resource cannot be attributed.
4. Apply the runtime hours. For any resource whose environment runs fewer than 24 hours a day, find that service's utilization field with get_service_fields and set it to that share of the day. Without this a machine that runs 8 hours a day is configured as if it ran all month.
5. Call validate_estimate, then export_estimate (or build_estimate) to save and get the shareable URL.

B. PRICE IT (the numbers)
The saved calculator.aws estimate contains NO money — it stores configuration, and AWS computes pricing in the browser when a person opens the link. import_estimate reads back configuration only, with an empty subtotal. So you must price the workload yourself using get_aws_price, which returns published AWS rates from the Price List Query API.

For every resource:
6. Call get_aws_price for its rate. Retry with corrected filters if found is false.
7. Derive the monthly cost from that rate:
   - Billed per hour (unit "Hrs"): a billing month is exactly ${HOURS_PER_MONTH} hours, and partial-day use is that share of it. monthly = ratePerUnit x ${HOURS_PER_MONTH} x (hoursPerDay / 24) x quantity. So 24h/day uses all ${HOURS_PER_MONTH} hours and 8h/day uses ${(HOURS_PER_MONTH / 3).toFixed(1)}. Use ${HOURS_PER_MONTH}, not 30 x 24 — AWS and the Pricing Calculator both bill a month as ${HOURS_PER_MONTH} hours, and anything else makes this document disagree with the estimate link. Set timeBilled true and record hoursPerDay.
   - Billed per GB-month (unit "GB-Mo"): monthly = ratePerUnit x gigabytes. Set timeBilled false; hours do not apply to storage.
8. Put the arithmetic in "workings" exactly as you calculated it, including the rate, so a reader can check it. Example: "$0.0896/hr x 8h/day (243.3 of ${HOURS_PER_MONTH} hrs/month) x 2 = $43.61/mo".
9. If get_aws_price cannot find a rate after a couple of attempts, set monthly to null and add a warning naming the resource. NEVER substitute a price you remember — a number you invented is worse than a gap, because nobody can tell it is wrong.
10. Sum the line items into monthlyTotal, and per environment into environments[].

Rules:
- Use the region the user asked for. If they did not name one, use ap-south-1 (Mumbai) and record that in assumptions.
- add_service ALWAYS APPENDS. If a save attempt went wrong, do NOT re-add the same service to the same estimate — that creates a duplicate line and inflates the cost. Start over with create_estimate.
- If a call is refused or warns, read its next_step text and fix the input rather than retrying it unchanged.
- Where the user is vague (instance size, request volume, storage), choose a defensible small-production default and state it in assumptions. Do not ask the user questions; you cannot — this runs unattended.

When the estimate is saved and every line is priced, stop calling tools and reply with ONLY this, no prose before or after:

<calculation_json>
{
  "url": "<the calculator.aws shareable URL>",
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
  "assumptions": ["<each default you chose on the user's behalf>"],
  "warnings": ["<anything you could not price, or a tool warned about; omit if none>"]
}
</calculation_json>

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
    tools,
  };
  // Sonnet 5 rejects an explicit temperature; every builder in this repo guards the
  // same way. Keep the guard identical so behaviour stays consistent across models.
  if (!modelId.includes('claude-sonnet-5')) {
    body.temperature = temperature;
  }
  return body;
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

  /** Milliseconds of budget left, floored at zero. */
  const remaining = () => LOOP_DEADLINE_MS - (Date.now() - startedAt);

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    if (remaining() <= 0) {
      throw new Error(`Estimate loop exceeded its ${LOOP_DEADLINE_MS / 1000}s budget after ${iteration - 1} turns.`);
    }

    const abort = new AbortController();
    // Never wait past the loop budget, even on the first call of a turn.
    const timer = setTimeout(() => abort.abort(), Math.min(BEDROCK_CALL_TIMEOUT_MS, remaining()));
    let payload: any;
    try {
      const response = await client.send(
        new InvokeModelCommand({
          modelId,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify(toolRequestBody(modelId, messages, tools, SYSTEM_PROMPT)),
        }),
        { abortSignal: abort.signal },
      );
      payload = JSON.parse(new TextDecoder().decode(response.body));
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
    const results: any[] = [];

    // Sequential on purpose: these calls mutate one shared in-flight estimate, so
    // add_service ordering is observable and racing them is not safe.
    for (const request of requests) {
      if (remaining() <= 0) {
        throw new Error(
          `Estimate loop exceeded its ${LOOP_DEADLINE_MS / 1000}s budget part-way through turn ${iteration}.`,
        );
      }

      await onProgress?.({
        iteration,
        stage: 'tool_use',
        message: `Calling ${request.name}`,
      });

      let text: string;
      let isError: boolean;
      try {
        if (request.name === PRICE_TOOL_NAME) {
          // Handled here rather than on the sidecar: it is our tool, backed by the
          // AWS Price List API.
          const args = (request.input || {}) as { serviceCode?: string; region?: string; filters?: Record<string, string> };
          const price = await lookupPrice({
            serviceCode: String(args.serviceCode || ''),
            region: String(args.region || ''),
            filters: args.filters,
          });
          text = JSON.stringify(price);
          // A miss is not a fault — the model is expected to adjust filters and
          // retry, so this must not be flagged as an error turn.
          isError = false;
        } else {
          const outcome = await mcp.callTool(
            request.name,
            request.input ?? {},
            Math.min(TOOL_CALL_TIMEOUT_MS, remaining()),
          );
          text = outcome.text;
          isError = outcome.isError;
        }
      } catch (error) {
        // A transport fault is reported back to the model as a tool error instead of
        // aborting the loop: upstream's messages are actionable and the model can
        // often recover (e.g. re-discover fields and retry).
        text = `Tool transport failure: ${(error as Error).message}`;
        isError = true;
      }

      toolCalls.push({ name: request.name, isError });
      results.push({
        type: 'tool_result',
        tool_use_id: request.id,
        content: [{ type: 'text', text }],
        ...(isError ? { is_error: true } : {}),
      });
    }

    messages.push({ role: 'user', content: results });
  }

  throw new Error(
    `Estimate loop hit its ${MAX_ITERATIONS}-turn ceiling without producing a saved estimate.`,
  );
}
