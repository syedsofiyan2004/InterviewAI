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
    tools: [gatewayTool(properties.GatewayArn)],
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
