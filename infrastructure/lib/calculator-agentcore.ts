/**
 * AgentCore-based AWS Cost Calculator infrastructure.
 *
 * Architecture:
 *
 *   MIMO API handler
 *     → calculator-agent Lambda (harness client)
 *       → Bedrock InvokeInlineAgent (managed Claude loop)
 *         → calculator-mcp-proxy Lambda (action group executor)
 *           → existing calculator-mcp-sidecar Lambda (MCP tools)
 *             → AWS Pricing Calculator
 *
 * CDK resources provisioned here:
 *   Phase 1: Gateway + GatewayTarget (Lambda MCP target)
 *   Phase 2: AgentCore Runtime (MCP server container) — provisioned but initially
 *             kept alongside the Lambda sidecar for side-by-side comparison.
 *   Harness: implemented as a Lambda calling InvokeInlineAgent (CfnHarness is not
 *             yet available in CDK 2.x; added as a CustomResource placeholder).
 *
 * The existing calculatorSidecar Lambda and calculatorOrchestrator Lambda remain
 * active and handle all traffic until Phase 5 acceptance tests pass.
 */

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { Construct } from 'constructs';
import * as path from 'path';

export interface CalculatorAgentCoreProps {
  envName: string;
  account: string;
  region: string;
  /** Existing MIMO sidecar Lambda — used as the Gateway's Lambda MCP target. */
  existingSidecar: lambda.IFunction;
  /** Existing MCP estimates DynamoDB table — shared with new Runtime. */
  estimatesTable: dynamodb.ITable;
  /** MIMO files bucket — agent Lambda reads workbook evidence from here. */
  filesBucket: s3.IBucket;
  /** MIMO calculation status table. */
  calculatorTable: dynamodb.ITable;
  /** Claude model ID for the agent loop. */
  agentModelId?: string;
  /** Max agent iterations (tool-use rounds). */
  maxIterations?: number;
}

export class CalculatorAgentCore extends Construct {
  /** The agent orchestrator Lambda — MIMO invokes this to start an estimate. */
  public readonly agentLambda: nodejs.NodejsFunction;
  /** The MCP proxy Lambda — Bedrock action group executor. */
  public readonly mcpProxyLambda: nodejs.NodejsFunction;
  /** The AgentCore Gateway (exposes Calculator MCP tools to Claude). */
  public readonly gateway: bedrockagentcore.CfnGateway;
  /** The AgentCore Gateway Target (Lambda MCP target). */
  public readonly gatewayTarget: bedrockagentcore.CfnGatewayTarget;
  /** The AgentCore Runtime — the MCP server container (Phase 2 target). */
  public readonly runtime: bedrockagentcore.CfnRuntime;

  constructor(scope: Construct, id: string, props: CalculatorAgentCoreProps) {
    super(scope, id);

    const getUniqueName = (resource: string) =>
      `iep-${props.envName}-${resource}-${props.account}-${props.region}`;

    const agentModelId = props.agentModelId || 'global.anthropic.claude-sonnet-4-6';

    // ─── IAM execution role for the AgentCore Runtime ──────────────────────────

    // All permissions are bundled into inlinePolicies at role creation — NOT added
    // afterward via addToPolicy. This ensures the role has all permissions before
    // AgentCore validates it during Runtime creation (IAM eventual-consistency fix).
    const runtimeRole = new iam.Role(this, 'RuntimeRole', {
      roleName: getUniqueName('calculator-agentcore-runtime'),
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'Execution role for the MIMO Calculator AgentCore MCP Runtime',
      inlinePolicies: {
        DynamoMcpState: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            sid: 'DynamoMcpState',
            actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:Scan'],
            resources: [props.estimatesTable.tableArn, `${props.estimatesTable.tableArn}/index/*`],
          })],
        }),
        CloudWatchLogs: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            sid: 'CloudWatchLogs',
            actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
            resources: [`arn:aws:logs:${props.region}:${props.account}:log-group:/aws/bedrock-agentcore/runtime/*`],
          })],
        }),
        // ECR pull permissions — required for AgentCore to launch the container image.
        // These MUST be present before AgentCore validates the role during Runtime creation.
        EcrPull: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            sid: 'EcrPull',
            actions: [
              'ecr:GetAuthorizationToken',
              'ecr:BatchGetImage',
              'ecr:GetDownloadUrlForLayer',
              'ecr:BatchCheckLayerAvailability',
            ],
            resources: ['*'],
          })],
        }),
      },
    });

    // ─── Container image for Phase 2 AgentCore Runtime ─────────────────────────
    // Built from lambdas/calculator-mcp-sidecar-agentcore/ — adapted Dockerfile
    // that listens on 0.0.0.0 (not loopback) as required by the Runtime network.

    const runtimeImage = new ecr_assets.DockerImageAsset(this, 'RuntimeImage', {
      directory: path.join(__dirname, '../lambdas/calculator-mcp-sidecar-agentcore'),
      platform: ecr_assets.Platform.LINUX_ARM64,
    });

    // ─── AgentCore Runtime (Phase 2 — MCP server as a Runtime) ─────────────────

    const runtimeLogGroup = new logs.LogGroup(this, 'RuntimeLogGroup', {
      logGroupName: `/aws/bedrock-agentcore/runtime/${getUniqueName('calculator-mcp')}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    void runtimeLogGroup;

    // agentRuntimeName must match [a-zA-Z][a-zA-Z0-9_]{0,47} — no hyphens, max 48 chars.
    const runtimeName = `mimoCalcMcp_${props.envName}`.slice(0, 48).replace(/-/g, '_');
    this.runtime = new bedrockagentcore.CfnRuntime(this, 'McpRuntime', {
      agentRuntimeName: runtimeName,
      description: 'AWS Pricing Calculator MCP server hosted on AgentCore Runtime',
      agentRuntimeArtifact: {
        containerConfiguration: {
          containerUri: runtimeImage.imageUri,
        },
      },
      // PUBLIC_INTERNET: accessible via AgentCore's managed network.
      // For VPC isolation, switch to PRIVATE with a VpcConfigProperty.
      networkConfiguration: {
        networkMode: 'PUBLIC',
      },
      // authorizerConfiguration omitted — the Gateway authenticates with the Runtime
      // via IAM/SigV4 at the service level. No additional inbound JWT auth needed.
      roleArn: runtimeRole.roleArn,
      environmentVariables: {
        MCP_TRANSPORT: 'http',
        PORT: '8000',
        HOST: '0.0.0.0',
        ESTIMATES_STORE: 'dynamodb',
        ESTIMATES_TABLE: props.estimatesTable.tableName,
        ESTIMATES_TTL_SECONDS: '86400',
        TRACE: 'on',
      },
      tags: { 'mimo:component': 'calculator-agentcore-runtime' },
    });

    // ─── IAM role for the Gateway ───────────────────────────────────────────────

    const gatewayRole = new iam.Role(this, 'GatewayRole', {
      roleName: getUniqueName('calculator-agentcore-gateway'),
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'Execution role for the MIMO Calculator AgentCore Gateway',
    });

    gatewayRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [props.existingSidecar.functionArn],
    }));

    // ─── AgentCore Gateway ──────────────────────────────────────────────────────
    // The Gateway is the tool-routing layer. It exposes Calculator MCP tools to
    // the Claude agent via the action group mechanism.

    const gatewayExecRole = new iam.Role(this, 'GatewayExecRole', {
      roleName: getUniqueName('calculator-agentcore-gw-exec'),
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'Execution role for AgentCore Gateway (allows invoking Lambda targets)',
    });
    gatewayExecRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [props.existingSidecar.functionArn],
    }));

    this.gateway = new bedrockagentcore.CfnGateway(this, 'CalculatorGateway', {
      name: getUniqueName('calculator'),
      description: 'MIMO AWS Cost Calculator — exposes Pricing Calculator MCP tools to the AgentCore agent',
      authorizerType: 'AWS_IAM',
      protocolType: 'MCP',          // Calculator MCP server
      roleArn: gatewayExecRole.roleArn,
      tags: { 'mimo:component': 'calculator-agentcore-gateway' },
    });

    // ─── AgentCore Gateway Target (Phase 1 — Lambda MCP target) ────────────────
    // Points at the existing Lambda sidecar. Phase 2 will add a second target
    // pointing at the Runtime's endpoint and route traffic there instead.
    //
    // Lambda MCP target: Bedrock sends MCP tool invocations to the sidecar Lambda
    // through a structured Bedrock action group request shape, which the sidecar's
    // LWA translates into HTTP JSON-RPC.

    this.gatewayTarget = new bedrockagentcore.CfnGatewayTarget(this, 'CalculatorGatewayTarget', {
      name: getUniqueName('calculator-lambda-mcp'),
      description: 'Lambda MCP target: existing calculator sidecar (Phase 1)',
      gatewayIdentifier: this.gateway.attrGatewayIdentifier,
      // Lambda targets require a credentialProviderConfigurations entry specifying
      // how the Gateway authenticates when invoking the Lambda function.
      credentialProviderConfigurations: [
        { credentialProviderType: 'IAM' },
      ],
      targetConfiguration: {
        mcp: {
          lambda: {
            lambdaArn: props.existingSidecar.functionArn,
            toolSchema: {
              // ToolDefinitionProperty array — describes Calculator MCP tools to the Gateway.
              // The Gateway uses this to route Claude's tool invocations to the Lambda target.
              // Tool definitions for the Calculator MCP tools exposed via the Gateway.
              // SchemaDefinitionProperty is a recursive JSON-Schema structure.
              inlinePayload: ([
                { name: 'search_services', description: 'Search for AWS Pricing Calculator services.', inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] } },
                { name: 'get_service_fields', description: 'Get field schema, minimalConfig, required fields and traps for a service.', inputSchema: { type: 'object', properties: { service: { type: 'string', description: 'Calculator service code' } }, required: ['service'] } },
                { name: 'create_estimate', description: 'Create a new AWS Pricing Calculator estimate.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, partition: { type: 'string' } }, required: ['name'] } },
                { name: 'add_service', description: 'Add configured services to an estimate.', inputSchema: { type: 'object', properties: { estimate_id: { type: 'string' }, services: { type: 'string' } }, required: ['estimate_id', 'services'] } },
                { name: 'build_estimate', description: 'Create and populate an estimate in a single call.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, services: { type: 'string' } }, required: ['name', 'services'] } },
                { name: 'validate_estimate', description: 'Validate the current state of an estimate.', inputSchema: { type: 'object', properties: { estimate_id: { type: 'string' } }, required: ['estimate_id'] } },
                { name: 'export_estimate', description: 'Export and save an estimate to get a shareable calculator.aws URL.', inputSchema: { type: 'object', properties: { estimate_id: { type: 'string' } }, required: ['estimate_id'] } },
                { name: 'import_estimate', description: 'Import/read back a saved estimate to verify its configuration.', inputSchema: { type: 'object', properties: { estimate_id: { type: 'string' }, format: { type: 'string' } }, required: ['estimate_id'] } },
                { name: 'get_server_info', description: 'Get MCP server version and capabilities.', inputSchema: { type: 'object', properties: {} } },
              ] as unknown) as bedrockagentcore.CfnGatewayTarget.ToolDefinitionProperty[],
            },
          },
        },
      },
    });

    this.gatewayTarget.addDependency(this.gateway);

    // ─── MCP Proxy Lambda (action group executor) ───────────────────────────────
    // Thin proxy that Bedrock invokes when Claude calls a Calculator tool.
    // Forwards tool calls to the existing sidecar Lambda.

    this.mcpProxyLambda = new nodejs.NodejsFunction(this, 'McpProxy', {
      functionName: getUniqueName('calculator-mcp-proxy'),
      entry: path.join(__dirname, '../lambdas/calculator-mcp-proxy/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(3),
      memorySize: 512,
      environment: {
        CALCULATOR_SIDECAR_FUNCTION_NAME: props.existingSidecar.functionName,
        CALCULATOR_GATEWAY_ARN: this.gateway.attrGatewayArn,
      },
      bundling: { minify: true, sourceMap: true },
    });

    props.existingSidecar.grantInvoke(this.mcpProxyLambda);

    this.mcpProxyLambda.addToRolePolicy(new iam.PolicyStatement({
      sid: 'AllowBedrockInvokeAgentCore',
      actions: ['bedrock-agentcore:InvokeAgent'],
      resources: ['*'],
    }));

    // ─── Calculator Agent Lambda (Harness client) ───────────────────────────────
    // Receives WorkbookEvidence, calls Bedrock InvokeInlineAgent with the
    // Calculator action group, collects the structured result.

    this.agentLambda = new nodejs.NodejsFunction(this, 'AgentOrchestrator', {
      functionName: getUniqueName('calculator-agent-orchestrator'),
      entry: path.join(__dirname, '../lambdas/calculator-agent/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
      environment: {
        CALCULATOR_TABLE_NAME: props.calculatorTable.tableName,
        CALCULATOR_MCP_PROXY_LAMBDA_ARN: this.mcpProxyLambda.functionArn,
        CALCULATOR_GATEWAY_ARN: this.gateway.attrGatewayArn,
        CALCULATOR_AGENT_MODEL_ID: agentModelId,
        CALCULATOR_AGENT_MAX_ITERATIONS: String(props.maxIterations ?? 40),
        BUCKET_NAME: props.filesBucket.bucketName,
        EXECUTION_MODE: 'agentcore-harness',
        // System prompt is injected from source-controlled prompts/ dir.
        // Using an env var avoids cross-platform file-copy bundling hooks while
        // keeping the prompt text in source control exactly as the spec requires.
        CALCULATOR_AGENT_SYSTEM_PROMPT: require('fs').readFileSync(
          require('path').join(__dirname, '../prompts/calculator-agent-system.txt'),
          'utf8',
        ),
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });

    props.calculatorTable.grantReadWriteData(this.agentLambda);
    props.filesBucket.grantRead(this.agentLambda);
    this.mcpProxyLambda.grantInvoke(this.agentLambda);

    // Bedrock InvokeInlineAgent permission
    this.agentLambda.addToRolePolicy(new iam.PolicyStatement({
      sid: 'BedrockInvokeInlineAgent',
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
        'bedrock:GetInferenceProfile',
        'bedrock-agent-runtime:InvokeInlineAgent',
        'bedrock-agentcore:InvokeAgent',
      ],
      resources: ['*'],
    }));

    // AgentCore Gateway invoke permission
    this.agentLambda.addToRolePolicy(new iam.PolicyStatement({
      sid: 'AgentCoreGatewayInvoke',
      actions: ['bedrock-agentcore:InvokeGateway'],
      resources: [this.gateway.attrGatewayArn],
    }));

    // ─── Grant existing sidecar to read the estimates table (Runtime will need same)

    props.estimatesTable.grantReadWriteData(this.mcpProxyLambda);

    // ─── Outputs ────────────────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'AgentLambdaArn', {
      description: 'Calculator AgentCore Harness client Lambda ARN',
      value: this.agentLambda.functionArn,
      exportName: `${getUniqueName('calc-agent-lambda-arn')}`,
    });

    new cdk.CfnOutput(this, 'GatewayArn', {
      description: 'Calculator AgentCore Gateway ARN',
      value: this.gateway.attrGatewayArn,
      exportName: `${getUniqueName('calc-gateway-arn')}`,
    });

    new cdk.CfnOutput(this, 'RuntimeArn', {
      description: 'Calculator AgentCore Runtime ARN',
      value: this.runtime.attrAgentRuntimeArn,
      exportName: `${getUniqueName('calc-runtime-arn')}`,
    });
  }
}
