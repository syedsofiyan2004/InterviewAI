/**
 * CloudFormation Custom Resource that provisions the AgentCore Harness.
 *
 * The Harness is the AWS-managed Claude agent loop: given a model, a system prompt
 * and a set of tools (here, the Calculator MCP behind an AgentCore Gateway), AgentCore
 * owns model invocation, tool selection, tool result handling, correction and retry.
 * MIMO submits a message and reads a result; it never runs a tool loop.
 *
 * Why a Custom Resource rather than an L1 construct: aws-cdk-lib 2.250.0 ships
 * CfnRuntime, CfnRuntimeEndpoint, CfnGateway, CfnGatewayTarget, CfnMemory and friends,
 * but no CfnHarness — the CloudFormation coverage lags the service API. Per the
 * migration brief the answer is to drive the real API from a provisioning Custom
 * Resource, not to substitute a different architecture for a missing construct.
 *
 * Behaviours confirmed against the live service before this was written
 * (scripts/live-harness-probe.mjs):
 *   - CreateHarness returns status CREATING and reaches READY in roughly 2-3 minutes,
 *     so this needs the Provider framework's isComplete polling rather than a single
 *     synchronous handler.
 *   - A DEFAULT endpoint is created automatically; CreateHarnessEndpoint is not needed.
 *   - The Harness provisions its own managed AgentCore Runtime with
 *     lifecycleConfiguration { idleRuntimeSessionTimeout: 900, maxLifetime: 28800 } —
 *     an 8 hour ceiling, which is what makes the long-running calculator legitimate.
 *   - UpdateHarness requires only harnessId; every configuration field is optional.
 */

import {
  BedrockAgentCoreControlClient,
  CreateHarnessCommand,
  UpdateHarnessCommand,
  DeleteHarnessCommand,
  GetHarnessCommand,
  ListHarnessesCommand,
  type HarnessTool,
} from '@aws-sdk/client-bedrock-agentcore-control';
import type { DocumentType } from '@smithy/types';

const client = new BedrockAgentCoreControlClient({});

interface HarnessResourceProperties {
  ServiceToken?: string;
  HarnessName: string;
  ExecutionRoleArn: string;
  ModelId: string;
  SystemPrompt: string;
  GatewayArn: string;
  /** Stringified numbers: CloudFormation renders all custom-resource values as strings. */
  MaxIterations?: string;
  MaxTokens?: string;
  TimeoutSeconds?: string;
  /** Tool names the agent may use. Empty/absent means "no restriction". */
  AllowedTools?: string[];
  /** Change this to force an update when only the prompt text changed. */
  ConfigHash?: string;
}

interface OnEventRequest {
  RequestType: 'Create' | 'Update' | 'Delete';
  PhysicalResourceId?: string;
  ResourceProperties: HarnessResourceProperties;
  OldResourceProperties?: HarnessResourceProperties;
}

interface OnEventResponse {
  PhysicalResourceId: string;
  Data?: Record<string, string>;
}

const number = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * The tool wiring: one AgentCore Gateway, which fronts the Pricing Calculator MCP on
 * an AgentCore Runtime. Outbound auth defaults to SigV4, which is what the Gateway's
 * AWS_IAM authorizer expects.
 */
const gatewayTool = (gatewayArn: string): HarnessTool => ({
  type: 'agentcore_gateway',
  name: 'calculator_mcp',
  config: { agentCoreGateway: { gatewayArn } },
});

/**
 * The human-in-the-loop tool. This is a first-class AgentCore `inline_function`, NOT a
 * second Gateway target and NOT behind the Gateway: when Claude calls it the Harness
 * pauses (messageStop.stopReason == "tool_use") and hands the toolUse back to MIMO,
 * which renders the question and later resumes the SAME runtimeSessionId with the
 * original assistant toolUse message followed by the user's toolResult.
 *
 * The input schema is the generic semantic request_user_input contract
 * (questionId/title/question/reason + scope/selectionMode/options/customInput/
 * allowApplyToSimilarResources). The legacy typed shape (resource/semanticField/type/
 * choices/unit) is retained as optional so an older caller still parses, but the schema
 * no longer REQUIRES a type. It intentionally contains NO Calculator field ids or MCP
 * implementation detail — it asks for missing customer workload facts only.
 */
const REQUEST_USER_INPUT_TOOL_NAME = 'request_user_input';

const REQUEST_USER_INPUT_DESCRIPTION =
  'Ask the customer ONE material workload, architecture, scope or commercial-pricing '
  + 'question that only the customer can answer, and whose guess could materially change '
  + 'the AWS Pricing Calculator estimate.\n\n'
  + 'Before calling it, try to resolve the value from the workbook, its instructions, user '
  + 'messages, previous answers, or official Pricing Calculator MCP guidance where the '
  + 'value is only a Calculator implementation/default detail.\n\n'
  + 'Do not ask customers for internal Calculator fields.\n\n'
  + 'Offer 2-4 useful contextual options, each with a value and a label (and a short '
  + 'description when it helps the customer choose), and set customInput.enabled so the '
  + 'customer can give their own value outside those options. Set selectionMode to '
  + '"multiple" only when several of the options genuinely combine; otherwise use '
  + '"single". Ask at the broadest useful scope: a decision that applies to many resources '
  + 'is asked once with allowApplyToSimilarResources honoured, and a decision unique to one '
  + 'resource is scoped to that resource.\n\n'
  + 'Call request_user_input for one material question at a time. Do not issue parallel '
  + 'request_user_input calls.';

const REQUEST_USER_INPUT_SCHEMA: DocumentType = {
  type: 'object',
  properties: {
    questionId: { type: 'string', description: 'Stable id used to match the customer’s answer back to this question.' },
    title: { type: 'string', description: 'Short heading for the question card.' },
    question: { type: 'string', description: 'The exact decision the customer needs to make.' },
    reason: { type: 'string', description: 'Why this decision is material to the estimate.' },
    scope: {
      type: 'string',
      description: 'What the decision applies to: a resource or sheet name, a resource group, or a broad scope such as "all EC2 instances" or "the whole estimate".',
    },
    selectionMode: {
      type: 'string',
      enum: ['single', 'multiple'],
      description: 'single = pick one option (or one custom value); multiple = several options may combine.',
    },
    options: {
      type: 'array',
      description: '2-4 distinct customer-facing choices.',
      items: {
        type: 'object',
        properties: {
          value: { type: 'string', description: 'A short stable token the agent recognises, e.g. "no_upfront_1yr".' },
          label: { type: 'string', description: 'Customer-facing text, e.g. "1 year, no upfront".' },
          description: { type: 'string', description: 'Optional elaboration shown under the label.' },
        },
        required: ['value', 'label'],
      },
    },
    customInput: {
      type: 'object',
      description: 'An "Other / give your own input" path for a value outside the listed options.',
      properties: {
        enabled: { type: 'boolean' },
        label: { type: 'string', description: 'e.g. "Other / give your own input".' },
        inputType: { type: 'string', enum: ['text', 'number'] },
        unit: { type: 'string' },
        placeholder: { type: 'string' },
      },
    },
    allowApplyToSimilarResources: {
      type: 'boolean',
      description: 'true when this same decision applies to every similar source resource, so the customer can answer once for all of them.',
    },
    // Legacy typed fields (pre-generic shape). Retained so an older request_user_input
    // input still parses; new callers should use options/customInput instead.
    resource: { type: 'string' },
    semanticField: { type: 'string' },
    type: { type: 'string', enum: ['CHOICE', 'NUMBER', 'BOOLEAN', 'TEXT'] },
    choices: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          value: { type: 'string' },
          label: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['value', 'label'],
      },
    },
    unit: { type: 'string' },
  },
  required: ['questionId', 'title', 'question', 'reason'],
};

const requestUserInputTool = (): HarnessTool => ({
  type: 'inline_function',
  name: REQUEST_USER_INPUT_TOOL_NAME,
  config: {
    inlineFunction: {
      description: REQUEST_USER_INPUT_DESCRIPTION,
      inputSchema: REQUEST_USER_INPUT_SCHEMA,
    },
  },
});

/**
 * Memory is explicitly OFF, and that is a decision rather than an omission.
 *
 * Leaving `memory` unset does not mean "no memory": the Harness provisions a managed
 * AgentCore Memory resource, and if the caller cannot create one the whole Harness lands
 * in CREATE_FAILED with
 *   "Memory operation failed: … not authorized to perform: bedrock-agentcore:CreateMemory
 *    on resource: …:memory/mimoCalc_dev-*"
 *
 * Disabling it is also the better design here. Continuation within a calculation uses the
 * same runtimeSessionId (the managed runtime allows 8-hour sessions), and continuation
 * across runs is rebuilt from workbook evidence MIMO already owns in S3. Managed memory
 * would add a third store holding customer workload content, with its own retention, for
 * no capability MIMO needs.
 */
const MEMORY_DISABLED = { disabled: {} } as const;

function configuration(properties: HarnessResourceProperties) {
  return {
    executionRoleArn: properties.ExecutionRoleArn,
    model: {
      bedrockModelConfig: {
        modelId: properties.ModelId,
        maxTokens: number(properties.MaxTokens, 8192),
      },
    },
    systemPrompt: [{ text: properties.SystemPrompt }],
    tools: [gatewayTool(properties.GatewayArn), requestUserInputTool()],
    ...(properties.AllowedTools?.length ? { allowedTools: properties.AllowedTools } : {}),
    // Context pressure is handled by summarising the *conversation*, never by dropping
    // workbook evidence. Evidence that will not fit stays in S3 and is fetched back
    // through get_workbook_evidence.
    truncation: {
      strategy: 'summarization' as const,
      config: { summarization: { summaryRatio: 0.5, preserveRecentMessages: 10 } },
    },
  };
}

export const onEvent = async (event: OnEventRequest): Promise<OnEventResponse> => {
  const properties = event.ResourceProperties;
  console.log(JSON.stringify({ event: 'harness_provisioner', requestType: event.RequestType, harnessName: properties.HarnessName }));

  if (event.RequestType === 'Delete') {
    const harnessId = event.PhysicalResourceId;
    // A failed Create leaves CloudFormation with a placeholder physical id rather than
    // a harness id; deleting that would be a hard error on an otherwise fine rollback.
    if (harnessId && harnessId.startsWith(properties.HarnessName)) {
      await client.send(new DeleteHarnessCommand({ harnessId })).catch((error) => {
        if ((error as Error).name === 'ResourceNotFoundException') return;
        throw error;
      });
    }
    return { PhysicalResourceId: harnessId || 'harness-not-created' };
  }

  const shared = {
    maxIterations: number(properties.MaxIterations, 60),
    timeoutSeconds: number(properties.TimeoutSeconds, 3600),
  };

  if (event.RequestType === 'Update' && event.PhysicalResourceId?.startsWith(properties.HarnessName)) {
    const harnessId = event.PhysicalResourceId;
    // UpdateHarness uses PATCH semantics for optional fields: `memory` is wrapped in
    // { optionalValue }, where CreateHarness takes the value bare. Passing the bare value
    // to Update is a type error and, untyped, would be silently ignored.
    await client.send(new UpdateHarnessCommand({
      harnessId,
      ...configuration(properties),
      memory: { optionalValue: MEMORY_DISABLED },
    }));
    const updated = (await client.send(new GetHarnessCommand({ harnessId }))).harness;
    return {
      PhysicalResourceId: harnessId,
      Data: { HarnessId: harnessId, HarnessArn: updated?.arn ?? '', HarnessName: properties.HarnessName },
    };
  }

  // Create. Renaming the harness produces a Create with a new name while the old
  // resource is deleted afterwards, so a stale same-named harness from a failed
  // earlier attempt has to be cleared first or CreateHarness conflicts.
  const clash = ((await client.send(new ListHarnessesCommand({}))).harnesses ?? [])
    .find((harness) => harness.harnessName === properties.HarnessName);
  if (clash?.harnessId) {
    console.log(`Deleting pre-existing harness ${clash.harnessId} with the same name`);
    await client.send(new DeleteHarnessCommand({ harnessId: clash.harnessId })).catch(() => undefined);
    // DeleteHarness is asynchronous; give it a moment before re-creating the name.
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }

  const created = (await client.send(new CreateHarnessCommand({
    harnessName: properties.HarnessName,
    ...configuration(properties),
    ...shared,
    memory: MEMORY_DISABLED,
    tags: { 'mimo:component': 'calculator-agentcore-harness' },
  }))).harness;

  return {
    PhysicalResourceId: created!.harnessId!,
    Data: { HarnessId: created!.harnessId!, HarnessArn: created!.arn!, HarnessName: properties.HarnessName },
  };
};

interface IsCompleteRequest extends OnEventRequest {
  PhysicalResourceId: string;
}

export const isComplete = async (event: IsCompleteRequest): Promise<{ IsComplete: boolean; Data?: Record<string, string> }> => {
  const harnessId = event.PhysicalResourceId;
  if (!harnessId || harnessId === 'harness-not-created') return { IsComplete: true };

  let harness;
  try {
    harness = (await client.send(new GetHarnessCommand({ harnessId }))).harness;
  } catch (error) {
    // Gone is the terminal state for Delete, and an error for anything else.
    if ((error as Error).name === 'ResourceNotFoundException') {
      return { IsComplete: event.RequestType === 'Delete' };
    }
    throw error;
  }

  if (event.RequestType === 'Delete') return { IsComplete: false };

  const status = harness?.status;
  console.log(JSON.stringify({ event: 'harness_status', harnessId, status }));

  if (status === 'READY') {
    return { IsComplete: true, Data: { HarnessId: harnessId, HarnessArn: harness!.arn! } };
  }
  if (typeof status === 'string' && status.includes('FAILED')) {
    throw new Error(`Harness ${harnessId} reached ${status}: ${harness?.failureReason ?? 'no failureReason given'}`);
  }
  return { IsComplete: false };
};
