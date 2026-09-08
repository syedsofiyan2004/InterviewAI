/**
 * AgentCore Calculator infrastructure tests, and the Phase 30 architectural hard gates.
 *
 * These are CDK synthesis + source-inspection tests. No live AWS. Live proof lives in
 * infrastructure/scripts/live-*.mjs and is recorded in
 * docs/CALCULATOR_AGENTCORE_MIGRATION_CHECKLIST.md.
 *
 * Several assertions here previously encoded the OLD architecture and passed happily
 * while nothing about it worked — a GatewayTarget pointing at the Lambda sidecar, an IAM
 * grant for `InvokeInlineAgent`, and an execution mode named `agentcore-harness` that was
 * a hard-coded string literal in a Lambda running its own InvokeModel loop. Tests that
 * assert the thing being removed are worse than no tests, because they make the removal
 * look like a regression. They are inverted here: each is now a gate that fails if the
 * old design comes back.
 *
 * Classification: MOCKED.
 */

import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { IepStack } from '../lib/infrastructure-stack';
import { buildInitialMessage } from '../lambdas/calculator-harness-driver';
import * as awsShared from '../lambdas/shared/aws';

let template: Template;
let templateJson: string;

const readSource = (relativePath: string): string =>
  require('fs').readFileSync(require('path').join(__dirname, '..', relativePath), 'utf8');

beforeAll(() => {
  const app = new cdk.App();
  const stack = new IepStack(app, 'TestStack', {
    env: { account: '123456789012', region: 'ap-south-1' },
  });
  template = Template.fromStack(stack);
  templateJson = JSON.stringify(template.toJSON());
});

describe('AgentCore Runtime (MCP server)', () => {
  it('provisions an AgentCore Runtime for the pricing MCP', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      AgentRuntimeName: Match.stringLikeRegexp('mimoCalcMcp'),
      NetworkConfiguration: { NetworkMode: 'PUBLIC' },
    });
  });

  it('declares the server protocol as MCP', () => {
    // Without this the Runtime is served under the HTTP contract, which probes GET /ping.
    // sample-aws-pricing-calculator-mcp answers 405 on GET, so it reported READY while
    // every MCP call died with "Runtime health check failed or timed out".
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      ProtocolConfiguration: 'MCP',
    });
  });

  it('Runtime listens on 0.0.0.0:8000 over streamable HTTP', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      EnvironmentVariables: Match.objectLike({
        HOST: '0.0.0.0',
        PORT: '8000',
        MCP_TRANSPORT: 'http',
      }),
    });
  });

  it('Runtime keeps its dedicated MCP working-state table (Phase 23)', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      EnvironmentVariables: Match.objectLike({
        ESTIMATES_STORE: 'dynamodb',
        ESTIMATES_TTL_SECONDS: Match.anyValue(),
      }),
    });
  });

  it('Runtime execution role is assumed by AgentCore', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: Match.stringLikeRegexp('calculator-agentcore-runtime'),
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Principal: { Service: 'bedrock-agentcore.amazonaws.com' } }),
        ]),
      }),
    });
  });
});

describe('AgentCore Gateway', () => {
  it('delivers Gateway diagnostic logs with bounded retention', () => {
    template.hasResourceProperties('AWS::Logs::DeliverySource', { LogType: 'APPLICATION_LOGS' });
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: Match.stringLikeRegexp('/aws/vendedlogs/bedrock-agentcore/gateway/'),
      RetentionInDays: 7,
    });
    template.resourceCountIs('AWS::Logs::Delivery', 1);
  });
  it('retains downstream MCP sessions for the Harness lifetime', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
      AuthorizerType: 'AWS_IAM',
      ProtocolConfiguration: {
        Mcp: { SessionConfiguration: { SessionTimeoutInSeconds: 28800 } },
      },
    });
  });
  it('provisions a Gateway with AWS_IAM authorizer over MCP', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
      Name: Match.stringLikeRegexp('calculator'),
      AuthorizerType: 'AWS_IAM',
      ProtocolType: 'MCP',
    });
  });

  it('targets the AgentCore Runtime MCP endpoint, not a Lambda (Phase 6)', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::GatewayTarget', {
      TargetConfiguration: { Mcp: { McpServer: { Endpoint: Match.anyValue() } } },
    });
  });

  it('carries NO hand-written Calculator tool schema', () => {
    // The removed Calculator target carried nine inline tool definitions — a copy of the
    // MCP's surface that drifted from it the moment upstream changed. The Gateway now
    // discovers those by calling tools/list on the Runtime itself.
    //
    // The evidence target is the deliberate exception and the distinction is the whole
    // ownership rule: `get_workbook_evidence` is MIMO's tool over MIMO's data, so MIMO
    // writes its schema. No Calculator tool may be declared here at all.
    const calculatorToolNames = [
      'search_services', 'get_service_fields', 'create_estimate', 'add_service',
      'build_estimate', 'validate_estimate', 'export_estimate', 'import_estimate',
      'get_server_info',
    ];
    for (const target of Object.values(template.findResources('AWS::BedrockAgentCore::GatewayTarget'))) {
      const mcp = JSON.stringify((target as any).Properties?.TargetConfiguration?.Mcp ?? {});
      for (const toolName of calculatorToolNames) expect(mcp).not.toContain(toolName);
    }
  });

  it('routes the Calculator to the Runtime, never to a Lambda', () => {
    const targets = Object.values(template.findResources('AWS::BedrockAgentCore::GatewayTarget'));
    const calculatorTarget = targets.find((t: any) => t.Properties?.Name === 'calcmcp') as any;
    expect(calculatorTarget).toBeDefined();
    expect(calculatorTarget.Properties.TargetConfiguration.Mcp.Lambda).toBeUndefined();
    expect(calculatorTarget.Properties.TargetConfiguration.Mcp.McpServer.Endpoint).toBeDefined();
  });

  it('exposes get_workbook_evidence as a second, MIMO-owned target', () => {
    // Without this the agent can only reason about what fitted into one message, which is
    // the original truncation defect wearing different clothes.
    const targets = Object.values(template.findResources('AWS::BedrockAgentCore::GatewayTarget'));
    const evidenceTarget = targets.find((t: any) => t.Properties?.Name === 'mimoev') as any;
    expect(evidenceTarget).toBeDefined();

    // CloudFormation renders the schema's own keys PascalCased (Name/Description/
    // InputSchema/Properties/Type/Required); the parameter names inside Properties are
    // data and stay as written.
    const schema = evidenceTarget.Properties.TargetConfiguration.Mcp.ToolSchema
      ?? evidenceTarget.Properties.TargetConfiguration.Mcp.Lambda.ToolSchema;
    const payload = schema.InlinePayload;
    expect(payload).toHaveLength(1);
    expect(payload[0].Name).toBe('get_workbook_evidence');
    for (const parameter of ['calculationId', 'chunkId', 'sheet', 'rowsFrom', 'rowsTo',
      'environment', 'fiscalPeriod', 'costRelevantOnly']) {
      expect(Object.keys(payload[0].InputSchema.Properties)).toContain(parameter);
    }
    expect(payload[0].InputSchema.Required).toEqual(['calculationId']);
  });

  it('signs to the Runtime with an explicit IAM credential provider', () => {
    // mcpServer targets under IAM auth need this on top of GATEWAY_IAM_ROLE, or
    // CreateGatewayTarget refuses with "IamCredentialProvider is required for mcpServer
    // targets using IAM authentication".
    template.hasResourceProperties('AWS::BedrockAgentCore::GatewayTarget', {
      CredentialProviderConfigurations: Match.arrayWith([
        Match.objectLike({
          CredentialProviderType: 'GATEWAY_IAM_ROLE',
          CredentialProvider: Match.objectLike({
            IamCredentialProvider: Match.objectLike({ Service: 'bedrock-agentcore' }),
          }),
        }),
      ]),
    });
  });

  it('keeps the target name short enough for the 64-char tool-name limit', () => {
    // The Gateway advertises tools as `<targetName>___<toolName>` and the Harness
    // truncates at 64 characters. With the conventional
    // iep-dev-calculator-runtime-mcp-<account>-<region> name the prefix alone is 56
    // chars, so get_server_info and get_service_fields both became `get_ser` and the
    // Harness refused to start with "Tool name … already exists".
    const targets = template.findResources('AWS::BedrockAgentCore::GatewayTarget');
    const longestToolName = 'get_service_fields'.length;
    for (const target of Object.values(targets)) {
      const name = (target as any).Properties?.Name as string;
      expect(typeof name).toBe('string');
      expect(name.length + '___'.length + longestToolName).toBeLessThanOrEqual(64);
    }
  });

  it('Gateway role can reach the Runtime and is granted it at role creation', () => {
    // As an inlinePolicy, not addToPolicy: a separately-managed AWS::IAM::Policy can
    // still be updating while CloudFormation creates the target, which is exactly how
    // the first attempt failed with "Authorization error when sending message".
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: Match.stringLikeRegexp('calculator-agentcore-gw-exec'),
      Policies: Match.arrayWith([
        Match.objectLike({
          PolicyDocument: Match.objectLike({
            Statement: Match.arrayWith([
              Match.objectLike({ Action: 'bedrock-agentcore:InvokeAgentRuntime' }),
            ]),
          }),
        }),
      ]),
    });
  });
});

describe('AgentCore Harness (managed Claude loop)', () => {
  it('provisions the Harness as a custom resource', () => {
    // aws-cdk-lib 2.250.0 has no CfnHarness, so the real CreateHarness API is driven
    // from a provisioning Custom Resource rather than the architecture being changed to
    // suit a missing construct.
    template.resourceCountIs('Custom::AgentCoreHarness', 1);
  });

  it('exposes the complete official Calculator MCP surface plus workbook evidence', () => {
    const harness = Object.values(template.findResources('Custom::AgentCoreHarness'))[0];
    expect(harness.Properties.AllowedTools).toContain('@calculator_mcp/calcmcp___get_server_info');
    expect(harness.Properties.AllowedTools).toContain('@calculator_mcp/calcmcp___search_services');
    expect(harness.Properties.AllowedTools).toContain('@calculator_mcp/calcmcp___get_service_fields');
    expect(harness.Properties.AllowedTools).toContain('@calculator_mcp/calcmcp___create_estimate');
    expect(harness.Properties.AllowedTools).toContain('@calculator_mcp/calcmcp___add_service');
    expect(harness.Properties.AllowedTools).toContain('@calculator_mcp/calcmcp___validate_estimate');
    expect(harness.Properties.AllowedTools).toContain('@calculator_mcp/calcmcp___build_estimate');
    expect(harness.Properties.AllowedTools).toContain('@calculator_mcp/calcmcp___export_estimate');
    expect(harness.Properties.AllowedTools).toContain('@calculator_mcp/calcmcp___import_estimate');
    expect(harness.Properties.AllowedTools).toContain('@calculator_mcp/mimoev___get_workbook_evidence');
    // Inline functions are NOT Gateway tools, so allowedTools names them by their exact
    // plain tool name rather than the `<target>___<tool>` form. The gateway tools above
    // stay namespaced; request_user_input must not be.
    expect(harness.Properties.AllowedTools).toContain('request_user_input');
    expect(harness.Properties.AllowedTools).not.toContain('@calculator_mcp/request_user_input');
    expect(harness.Properties.AllowedTools).not.toContain('*');
  });

  it('passes the source-controlled system prompt and the Gateway ARN to the Harness', () => {
    const harness = Object.values(template.findResources('Custom::AgentCoreHarness'))[0] as any;
    expect(harness.Properties.SystemPrompt).toContain('AWS Cost Estimation agent');
    expect(harness.Properties.GatewayArn).toBeDefined();
    expect(harness.Properties.ModelId).toContain('claude');
  });

  it('does NOT pass the system prompt as a Lambda environment variable', () => {
    // It used to. Lambda caps the whole function configuration, so growing the prompt
    // broke every deploy with "Request must be smaller than 5120 bytes for the
    // UpdateFunctionConfiguration operation".
    expect(templateJson).not.toContain('CALCULATOR_AGENT_SYSTEM_PROMPT');
  });

  it('Harness role is least privilege: model invoke + Gateway only', () => {
    const roles = template.findResources('AWS::IAM::Role');
    const harnessRole = Object.values(roles).find((role: any) =>
      typeof role.Properties?.RoleName === 'string'
      && role.Properties.RoleName.includes('calculator-agentcore-harness')) as any;
    expect(harnessRole).toBeDefined();

    const actions = JSON.stringify(harnessRole.Properties.Policies ?? []);
    expect(actions).toContain('bedrock:InvokeModel');
    expect(actions).toContain('bedrock-agentcore:InvokeGateway');
    // No data-plane access: the Harness reads evidence through tools, not directly.
    expect(actions).not.toContain('s3:GetObject');
    expect(actions).not.toContain('dynamodb:GetItem');
  });

  it('passes the browser validator to the harness driver for calculator total read-back', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: Match.stringLikeRegexp('calculator-harness-driver'),
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          CALCULATOR_BROWSER_VALIDATOR_FUNCTION_NAME: Match.anyValue(),
        }),
      }),
    });
  });
});

describe('AgentCore workbook handoff', () => {
  it('makes the agent own multi-scenario clarification before Calculator MCP execution', async () => {
    jest.spyOn(awsShared, 'getFileBuffer').mockImplementation(async (_bucket: string, key: string) => {
      if (key.endsWith('/evidence/index.json')) {
        return Buffer.from(JSON.stringify({
          fileName: 'multi-scenario.xlsx',
          sheets: [{ name: 'Digital Assets', rowCount: 20 }],
          chunks: [],
          detectedEnvironments: ['Dev', 'UAT'],
          detectedFiscalPeriods: ['26-27', '27-28'],
          serviceHints: ['AWS Fargate'],
          accounting: { totalRows: 20, costRelevantRows: 18, totalChunks: 0 },
        }));
      }
      if (key.endsWith('/evidence/evidence.json')) {
        return Buffer.from(JSON.stringify({
          fileName: 'multi-scenario.xlsx',
          sheets: [{
            name: 'Digital Assets',
            rows: [{
              rowId: 'Digital Assets!2',
              cells: [{ address: 'A2', header: 'Service', formatted: 'AWS Fargate' }],
            }],
          }],
        }));
      }
      throw new Error('full evidence not present');
    });

    const message = await buildInitialMessage({
      calculation_id: 'calc-1',
      owner_user_id: 'user-1',
      name: 'Multi scenario estimate',
      prompt: 'Price the workbook accurately.',
      status: 'ANALYZING',
      environment_hours: [],
      resources: [],
      input_warnings: [],
      created_at: Date.now(),
      updated_at: Date.now(),
    } as any, 'calc-1');

    expect(message).toContain('Call get_workbook_evidence before creating any AWS Pricing Calculator estimate.');
    expect(message).not.toContain('This workbook contains multiple environments and/or fiscal periods.');
    expect(message).not.toContain('Service hints');
  });
});

describe('Phase 30 — architectural hard gates', () => {
  it('no resource anywhere grants InvokeInlineAgent (no Bedrock Agents Classic)', () => {
    expect(templateJson).not.toContain('InvokeInlineAgent');
    expect(templateJson).not.toContain('bedrock:CreateAgent');
  });

  it('the harness driver contains no Claude tool loop', () => {
    const driver = readSource('lambdas/calculator-harness-driver/index.ts');
    // It reads a stream; it never calls a model or dispatches a tool.
    expect(driver).not.toContain('InvokeModelCommand');
    expect(driver).not.toContain('executeTool');
    expect(driver).toContain('InvokeHarnessCommand');
  });

  it('the harness driver has no dependency on the MIMO Calculator compiler', () => {
    const driver = readSource('lambdas/calculator-harness-driver/index.ts');
    expect(driver).not.toContain('service-adapters');
    expect(driver).not.toContain('compileWithCalculatorAdapter');
    expect(driver).not.toContain('calculatorConfig');
    expect(driver).not.toContain('calculatorKey');
    expect(driver).not.toContain('mcp-client');
  });

  it('the harness driver reads rendered calculator totals after AgentCore exports a link', () => {
    const driver = readSource('lambdas/calculator-harness-driver/index.ts');
    expect(driver).toContain('CALCULATOR_BROWSER_VALIDATOR_FUNCTION_NAME');
    expect(driver).toContain('readRenderedTotals');
    expect(driver).toContain('result.monthly ??');
    expect(driver).toContain('renderedTotals.monthly');
  });

  it('the harness driver owns no Calculator-internal field names (Phase 14/15)', () => {
    const driver = readSource('lambdas/calculator-harness-driver/index.ts');
    for (const fieldId of ['columnFormIPM', 'Data_Written', 'Mdb_BackupStorage',
      'modelsDeployed', 'modelsPerEndPoint', 'Number_of_custom_events', 'Size_of_the_payload']) {
      expect(driver).not.toContain(fieldId);
    }
  });

  it('the workbook evidence format owns no Calculator-internal field names', () => {
    const evidence = readSource('lambdas/shared/workbook-evidence.ts');
    for (const fieldId of ['columnFormIPM', 'Data_Written', 'Mdb_BackupStorage',
      'modelsDeployed', 'modelsPerEndPoint', 'Number_of_custom_events', 'Size_of_the_payload']) {
      expect(evidence).not.toContain(fieldId);
    }
  });

  it('the workbook evidence builder contains no row cap', () => {
    // The regression this whole migration exists to prevent: evidence was cut to the
    // first 200-300 rows before Claude ever saw it, so Claude asked for values whose
    // evidence had already been thrown away.
    //
    // Comments are stripped before matching, because the file legitimately *documents*
    // the removed `sheets.slice(0, 300)`. A gate that cannot tell code from prose about
    // code fails on its own explanation.
    const code = readSource('lambdas/shared/workbook-evidence.ts')
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
      })
      .join('\n');
    expect(code).not.toMatch(/EVIDENCE_ROW_LIMIT/);
    expect(code).not.toMatch(/\.slice\(0,\s*\d{2,3}\)/);
  });

  it('the evidence tool does not trust an agent-supplied owner id', () => {
    // Otherwise a prompt-injected calculationId could read another tenant's evidence.
    const tool = readSource('lambdas/calculator-evidence-tool/index.ts');
    expect(tool).toContain('resolveOwner');
    expect(tool).not.toMatch(/args\.owner/);
  });
});

describe('Legacy retention and rollback (Phase 33)', () => {
  it('the legacy orchestrator and the legacy agent Lambda still exist', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: Match.stringLikeRegexp('calculator-orchestrator'),
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: Match.stringLikeRegexp('calculator-agent-orchestrator'),
    });
  });

  it('the legacy InvokeModel Lambda is no longer labelled "agentcore-harness"', () => {
    // That name asserted an architecture the code did not have, and made logs and tests
    // "prove" AgentCore usage that never happened.
    const functions = template.findResources('AWS::Lambda::Function');
    const legacyAgent = Object.values(functions).find((fn: any) =>
      typeof fn.Properties?.FunctionName === 'string'
      && fn.Properties.FunctionName.includes('calculator-agent-orchestrator')) as any;
    expect(legacyAgent.Properties.Environment.Variables.EXECUTION_MODE).toBe('legacy-invokemodel');
  });
});

describe('Agent system prompt', () => {
  it('is source-controlled and states the success contract', () => {
    const prompt = readSource('prompts/calculator-agent-system.txt');
    expect(prompt).toContain('AWS Cost Estimation agent');
    expect(prompt).toContain('COMPLETED');
    expect(prompt).toContain('calculator.aws');
    expect(prompt).toContain('FAILED');
    // The old NEEDS_INPUT-as-assistant-text interruption mechanism is gone: pauses now
    // happen through the request_user_input inline function, not by asking Claude to
    // print a JSON object.
    expect(prompt).not.toContain('NEEDS_INPUT');
  });

  it('keeps the MCP authoritative instead of overriding Calculator behavior', () => {
    const prompt = readSource('prompts/calculator-agent-system.txt');
    expect(prompt).toContain('The MCP is authoritative about Calculator service fields, minimalConfig, supported values, validation and export behavior');
    expect(prompt).not.toContain('Do not call build_estimate');
    expect(prompt).not.toContain('build_estimate is unsupported');
  });

  it('clarifies material workload facts through the request_user_input inline function, never NEEDS_INPUT JSON', () => {
    const prompt = readSource('prompts/calculator-agent-system.txt');
    expect(prompt).toContain('request_user_input');
    expect(prompt).toContain('request_user_input is an accuracy mechanism. Do not use it merely to show questions.');
    expect(prompt).not.toContain('NEEDS_INPUT');
    expect(prompt).not.toContain('CHOICE|NUMBER|BOOLEAN|TEXT');
  });

  it('tells the agent to use get_workbook_evidence when evidence may be incomplete', () => {
    const prompt = readSource('prompts/calculator-agent-system.txt');
    expect(prompt).toContain('get_workbook_evidence');
  });

  it('requires individual Calculator line items per distinct source resource', () => {
    const prompt = readSource('prompts/calculator-agent-system.txt');
    expect(prompt).toContain('Every source workload/resource that must be priced must be represented individually in AWS Pricing Calculator');
    expect(prompt).toContain('Do not merge several independent source resources into one Calculator line item');
  });

  it('tells the agent to read every cost-relevant evidence row before pricing', () => {
    const prompt = readSource('prompts/calculator-agent-system.txt');
    expect(prompt).toContain('moreAvailable=false');
    expect(prompt).toContain('costRelevantOnly=true');
    expect(prompt).toContain('Never assume the first evidence response is the whole workbook');
  });

  it('batches add_service and reuses schema discovery instead of re-running it per resource', () => {
    const prompt = readSource('prompts/calculator-agent-system.txt');
    expect(prompt).toContain('Discover each service');
    expect(prompt).toContain('schema once');
    expect(prompt).toContain('Do not validate after every batch');
    expect(prompt).toContain('add_service calls');
    expect(prompt).toContain('batched add_service');
  });

  it('makes coverage a completion condition: priced, excluded, unsupported or awaiting the customer — never silently dropped', () => {
    const prompt = readSource('prompts/calculator-agent-system.txt');
    expect(prompt).toContain('Coverage is a completion condition');
    expect(prompt).toContain('evidenceConsumed');
    expect(prompt).toContain('evidenceExcluded');
    expect(prompt).toContain('evidenceUnsupported');
    expect(prompt).toContain('call request_user_input instead of returning COMPLETED');
  });

  it('treats statuses as UI states and material mismatches as questions, not ask-rules or nearest-fit', () => {
    const prompt = readSource('prompts/calculator-agent-system.txt');
    expect(prompt).toContain('not rules about when you may ask');
    expect(prompt).toContain('Material mismatches are questions, not nearest-fit assumptions');
    expect(prompt).toContain('A guess that materially changes cost is a request_user_input, not a warning');
  });

  it('offers 2-4 options plus an Other/customInput path and honours allowApplyToSimilarResources', () => {
    const prompt = readSource('prompts/calculator-agent-system.txt');
    expect(prompt).toContain('Offer 2-4 useful contextual options');
    expect(prompt).toContain('customInput');
    expect(prompt).toContain('allowApplyToSimilarResources');
    expect(prompt).toContain('Call request_user_input for one material question at a time');
  });

  it('applies a commercial pricing strategy only to eligible resources and never silently picks On-Demand', () => {
    const prompt = readSource('prompts/calculator-agent-system.txt');
    expect(prompt).toContain('do not silently pick On-Demand');
    expect(prompt).toContain('only to the resources actually eligible for it');
  });

  it('requires one final validate -> export -> import readback before COMPLETED', () => {
    const prompt = readSource('prompts/calculator-agent-system.txt');
    expect(prompt).toContain('validate_estimate, then export_estimate, then import_estimate once');
    expect(prompt).toContain('nothing was aggregated or duplicated');
    // Part 37: the readback closes the export/import loop — the estimate handed to the
    // customer is the one AWS actually holds, so it must confirm the priced cost-relevant
    // rows are present in the imported estimate, not merely reported in evidence arrays.
    expect(prompt).toContain('the estimate handed to the customer is the one AWS actually holds');
    expect(prompt).toContain('every cost-relevant row you priced is present and priced in the imported estimate');
  });
});
