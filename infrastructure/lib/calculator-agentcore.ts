/**
 * AgentCore-based AWS Cost Calculator infrastructure.
 *
 * Production architecture:
 *
 *   MIMO API handler                      (returns a calculationId immediately)
 *     → WorkbookEvidence / index / chunks in S3
 *       → AgentCore Harness               (AWS-managed Claude agent loop)
 *         → AgentCore Gateway             (tool routing, MCP)
 *           → AgentCore Runtime           (sample-aws-pricing-calculator-mcp)
 *             → AWS Pricing Calculator    → calculator.aws URL
 *
 * The Claude↔tool iteration belongs to the Harness. MIMO supplies workload
 * evidence and reads a structured result; it owns no Calculator field IDs, no
 * service codes and no tool schemas. Everything Calculator-shaped is discovered
 * from the MCP at run time.
 *
 * What this file used to be, and why the names still rhyme: the "AgentCore" path
 * here was a Lambda running its own `for` loop over InvokeModelCommand, calling a
 * proxy Lambda, calling the sidecar Lambda. The Gateway and Runtime below were
 * provisioned but never on the request path, and the Runtime was never even
 * declared as an MCP server (see protocolConfiguration). The custom loop survives
 * only as the `legacy-invokemodel` rollback mode and is not reachable in the
 * default execution mode.
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
import * as cr from 'aws-cdk-lib/custom-resources';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import * as path from 'path';
// No `.js` suffix: lib/ is loaded by ts-node under CommonJS, which does not remap a .js
// specifier onto a .ts file the way jest's moduleNameMapper does. With the suffix, tests
// pass and `cdk synth` dies with MODULE_NOT_FOUND.
import { GET_WORKBOOK_EVIDENCE_TOOL } from '../lambdas/calculator-evidence-tool/tool-schema';

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
  /** LEGACY (`legacy-invokemodel` rollback mode only): custom InvokeModel tool loop. */
  public readonly agentLambda: nodejs.NodejsFunction;
  /** LEGACY (`legacy-invokemodel` rollback mode only): sidecar Lambda MCP proxy. */
  public readonly mcpProxyLambda: nodejs.NodejsFunction;
  /** The AgentCore Gateway — fronts the Calculator MCP for the Harness. */
  public readonly gateway: bedrockagentcore.CfnGateway;
  /** The AgentCore Gateway Target — the MCP Runtime endpoint (NOT a Lambda). */
  public readonly gatewayTarget: bedrockagentcore.CfnGatewayTarget;
  /** MIMO's own `get_workbook_evidence` tool, exposed as a second Gateway target. */
  public readonly evidenceToolLambda: nodejs.NodejsFunction;
  /** Gateway target for the MIMO evidence tool. */
  public readonly evidenceGatewayTarget: bedrockagentcore.CfnGatewayTarget;
  /** Step Functions state machine that owns a calculation's lifecycle. */
  public readonly executionStateMachine: sfn.StateMachine;
  /** ARN of the AgentCore Harness — the AWS-managed Claude agent loop. */
  public readonly harnessArn: string;
  /** Id of the AgentCore Harness. */
  public readonly harnessId: string;
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
      // Without this the Runtime is served under the *HTTP* service contract,
      // which probes `GET /ping`. sample-aws-pricing-calculator-mcp serves only
      // POST /mcp and answers 405 on GET, so the health check can never pass:
      // the Runtime sits at READY (the container does start) while every MCP call
      // dies with "Runtime health check failed or timed out". Declaring MCP
      // switches AgentCore to the MCP contract — POST /mcp, port 8000, stateless
      // streamable HTTP, no /ping probe — which the upstream server already meets.
      // CloudFormation takes the flattened string; the SDK takes { serverProtocol }.
      protocolConfiguration: 'MCP',
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

    // ─── AgentCore Gateway ──────────────────────────────────────────────────────
    // The Gateway is the tool-routing layer: it fronts the Pricing Calculator MCP
    // and is what the Harness attaches to as an `agentcore_gateway` tool.
    //
    // A second role ('GatewayRole', granting lambda:InvokeFunction on the sidecar)
    // used to be created here and was never referenced by any resource — the Gateway
    // has only ever used GatewayExecRole. It is removed rather than left dangling.

    // Phase 32 least privilege: the Gateway's only job is to reach the Pricing MCP
    // Runtime, so InvokeAgentRuntime on that one Runtime is its only permission. It
    // deliberately no longer holds lambda:InvokeFunction on the sidecar — the sidecar
    // is legacy-rollback-only and is not reachable through this Gateway.
    //
    // The permission is an inlinePolicy on the role rather than a later addToPolicy,
    // for the same reason RuntimeRole above does it: addToPolicy produces a separate
    // AWS::IAM::Policy resource that CloudFormation is free to update *in parallel*
    // with creating the Gateway target. That is not theoretical — it is exactly how
    // the first attempt at this change failed:
    //
    //   7:23:25  GatewayExecRole/DefaultPolicy  UPDATE_IN_PROGRESS
    //   7:23:27  CalculatorRuntimeMcpTarget     CREATE_IN_PROGRESS   ← too early
    //   7:23:34  CalculatorRuntimeMcpTarget     CREATE_FAILED
    //            "Failed to connect and fetch tools from the provided MCP target
    //             server. Error - Authorization error when sending message"
    //
    // As an inlinePolicy the grant is part of the Role resource, so the role reaching
    // UPDATE_COMPLETE means the permission is already in place.
    const gatewayExecRole = new iam.Role(this, 'GatewayExecRole', {
      roleName: getUniqueName('calculator-agentcore-gw-exec'),
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'Execution role for AgentCore Gateway (reaches the MCP Runtime target)',
      inlinePolicies: {
        InvokeCalculatorMcpRuntime: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            sid: 'InvokeCalculatorMcpRuntime',
            actions: ['bedrock-agentcore:InvokeAgentRuntime'],
            resources: [
              this.runtime.attrAgentRuntimeArn,
              `${this.runtime.attrAgentRuntimeArn}/*`,
            ],
          })],
        }),
      },
    });

    this.gateway = new bedrockagentcore.CfnGateway(this, 'CalculatorGateway', {
      name: getUniqueName('calculator'),
      description: 'MIMO AWS Cost Calculator — exposes Pricing Calculator MCP tools to the AgentCore agent',
      authorizerType: 'AWS_IAM',
      protocolType: 'MCP',          // Calculator MCP server
      roleArn: gatewayExecRole.roleArn,
      tags: { 'mimo:component': 'calculator-agentcore-gateway' },
    });

    // ─── AgentCore Gateway Target — the MCP Runtime (Phase 6) ──────────────────
    //
    // The production target is the AgentCore Runtime's MCP endpoint, NOT a Lambda.
    // This replaced a `mcp.lambda` target that pointed at the legacy sidecar and
    // carried nine hand-written tool definitions — a copy of the MCP's surface that
    // drifted from it the moment upstream changed. With an `mcp.mcpServer` target
    // the Gateway performs MCP discovery itself (it literally calls tools/list on
    // create; a target whose server cannot be listed goes CREATE_FAILED), so there
    // is no schema for MIMO to maintain and nothing to drift.
    //
    // Deliberately the *only* target on this Gateway. A second Lambda target would
    // re-expose the same nine tool names through a different route, and duplicate
    // tool names are one of the reported symptoms. The sidecar Lambda still exists
    // for the legacy rollback modes, which reach it directly and not via the Gateway.

    // AgentCore Runtime MCP endpoint. The runtime ARN is URL-encoded into the path;
    // it is assembled from parts rather than encodeURIComponent'd because the ARN is
    // a CloudFormation token at synth time. Only the runtime id is a token, and its
    // grammar ([a-zA-Z][a-zA-Z0-9_]*-[A-Za-z0-9]+) contains nothing needing escaping.
    // Verified accepted by CreateGatewayTarget — see scripts/live-gateway-retarget-probe.mjs.
    const runtimeMcpEndpoint = `https://bedrock-agentcore.${props.region}.amazonaws.com/runtimes/`
      + `arn%3Aaws%3Abedrock-agentcore%3A${props.region}%3A${props.account}%3Aruntime%2F`
      + `${this.runtime.attrAgentRuntimeId}/invocations?qualifier=DEFAULT`;

    this.gatewayTarget = new bedrockagentcore.CfnGatewayTarget(this, 'CalculatorRuntimeMcpTarget', {
      // Deliberately NOT getUniqueName(). A Gateway target is already scoped to its
      // Gateway, so the account/region suffix buys nothing — and it costs correctness.
      //
      // The Gateway advertises tools as `<targetName>___<toolName>`, and the Harness
      // truncates tool names at 64 characters. With the conventional name
      // `iep-dev-calculator-runtime-mcp-996122083346-ap-south-1` the prefix alone is 56
      // characters, leaving 8 for the tool, so `get_server_info` and `get_service_fields`
      // both became `get_ser` and the Harness refused to start:
      //   RuntimeClientError: Failed to load tool …: Tool name
      //   'iep-dev-calculator-runtime-mcp-996122083346-ap-south-1___get_ser' already
      //   exists. Cannot register tools with exact same name.
      // `calcmcp___` is 10 characters, leaving 54 — comfortably more than the longest
      // Calculator tool name.
      name: 'calcmcp',
      description: 'MCP server target: AWS Pricing Calculator MCP on AgentCore Runtime',
      gatewayIdentifier: this.gateway.attrGatewayIdentifier,
      credentialProviderConfigurations: [{ credentialProviderType: 'GATEWAY_IAM_ROLE' }],
      targetConfiguration: {
        mcp: {
          mcpServer: { endpoint: runtimeMcpEndpoint },
        },
      },
    });

    // mcpServer targets under IAM auth need an explicit iamCredentialProvider on top
    // of GATEWAY_IAM_ROLE, naming the service to SigV4-sign for. Proven at the API:
    // omitting it fails CreateGatewayTarget with "IamCredentialProvider is required
    // for mcpServer targets using IAM authentication".
    //
    // Written as a property override because aws-cdk-lib 2.250.0's
    // CfnGatewayTarget.CredentialProviderProperty only models apiKeyCredentialProvider
    // and oauthCredentialProvider — the CloudFormation typing lags the service API.
    // The override emits the property regardless of the stale typing.
    this.gatewayTarget.addPropertyOverride(
      'CredentialProviderConfigurations.0.CredentialProvider.IamCredentialProvider',
      { Service: 'bedrock-agentcore', Region: props.region },
    );

    this.gatewayTarget.addDependency(this.gateway);
    // The Gateway calls tools/list on the Runtime while creating the target, so the
    // Runtime must be READY first or the target fails to create.
    this.gatewayTarget.addDependency(this.runtime);
    // And the Gateway must already be able to *reach* the Runtime when it does so.
    // Belt-and-braces alongside the inlinePolicy above: this makes the ordering
    // explicit in the template rather than relying on CloudFormation inferring it
    // from the RoleArn reference on the Gateway.
    this.gatewayTarget.node.addDependency(gatewayExecRole);

    // ─── MIMO evidence tool, as a second Gateway target (Phase 2) ──────────────
    //
    // `get_workbook_evidence` is what makes "chunk, never truncate" true: when a workbook
    // is too large to inline, the agent gets the index and pulls the rows it still needs.
    // Without this the agent can only reason about what fitted in one message, which is
    // the original defect wearing different clothes.
    //
    // A Lambda MCP target, not an mcpServer one, because MIMO owns this tool. Writing its
    // schema here is correct — the schema describes MIMO's own evidence store. That is the
    // opposite of the Calculator tools, whose schemas belong to the Pricing Calculator MCP
    // and must never be hand-copied into this repo.

    this.evidenceToolLambda = new nodejs.NodejsFunction(this, 'EvidenceTool', {
      functionName: getUniqueName('calculator-evidence-tool'),
      entry: path.join(__dirname, '../lambdas/calculator-evidence-tool/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(60),
      memorySize: 1024,
      environment: {
        BUCKET_NAME: props.filesBucket.bucketName,
        CALCULATOR_TABLE_NAME: props.calculatorTable.tableName,
      },
      bundling: { minify: true, sourceMap: true },
    });
    props.filesBucket.grantRead(this.evidenceToolLambda);
    // Read-only on the calculation record: it needs owner_user_id to resolve the S3
    // prefix, and deliberately cannot resolve a prefix the agent asks for directly.
    props.calculatorTable.grantReadData(this.evidenceToolLambda);

    gatewayExecRole.addToPolicy(new iam.PolicyStatement({
      sid: 'InvokeEvidenceTool',
      actions: ['lambda:InvokeFunction'],
      resources: [this.evidenceToolLambda.functionArn],
    }));

    this.evidenceGatewayTarget = new bedrockagentcore.CfnGatewayTarget(this, 'EvidenceToolTarget', {
      // Short for the same reason as `calcmcp`: the Gateway advertises tools as
      // `<targetName>___<toolName>` and the Harness truncates at 64 characters.
      name: 'mimoev',
      description: 'MIMO-owned workbook evidence retrieval tool',
      gatewayIdentifier: this.gateway.attrGatewayIdentifier,
      credentialProviderConfigurations: [{ credentialProviderType: 'GATEWAY_IAM_ROLE' }],
      targetConfiguration: {
        mcp: {
          lambda: {
            lambdaArn: this.evidenceToolLambda.functionArn,
            toolSchema: {
              inlinePayload: ([
                GET_WORKBOOK_EVIDENCE_TOOL,
              ] as unknown) as bedrockagentcore.CfnGatewayTarget.ToolDefinitionProperty[],
            },
          },
        },
      },
    });
    this.evidenceGatewayTarget.addDependency(this.gateway);
    this.evidenceGatewayTarget.node.addDependency(gatewayExecRole);
    this.evidenceGatewayTarget.node.addDependency(this.evidenceToolLambda);
    // Two targets on one Gateway are created serially: creating a target re-syncs the
    // Gateway's tool list, and two concurrent syncs race.
    this.evidenceGatewayTarget.addDependency(this.gatewayTarget);

    // ─── AgentCore Harness — the managed Claude agent loop (Phase 7) ───────────
    //
    // This is the component that owns model invocation → tool selection → Gateway
    // call → MCP result → continuation → correction → retry → final response. MIMO
    // submits a message and reads a result; there is no MIMO-authored tool loop in
    // the production path.
    //
    // Provisioned through a Custom Resource because aws-cdk-lib 2.250.0 has no
    // CfnHarness. The API itself is fully available in this account and region —
    // verified with scripts/probe-agentcore-availability.mjs and exercised end to end
    // with scripts/live-harness-probe.mjs, which created a Harness that reached READY
    // with an auto-created DEFAULT endpoint.

    const harnessSystemPrompt = require('fs').readFileSync(
      require('path').join(__dirname, '../prompts/calculator-agent-system.txt'),
      'utf8',
    ) as string;

    // Least privilege (Phase 32): the Harness needs exactly two things — permission to
    // invoke the one Claude model it is configured with, and permission to reach the one
    // Gateway that fronts the Calculator MCP. It gets no S3, no DynamoDB and no Lambda.
    //
    // Permissions are inlinePolicies rather than addToPolicy for the same reason as
    // GatewayExecRole: AgentCore validates the role during CreateHarness, and a
    // separately-managed AWS::IAM::Policy can still be updating at that moment.
    const harnessRole = new iam.Role(this, 'HarnessRole', {
      roleName: getUniqueName('calculator-agentcore-harness'),
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'Execution role for the MIMO Calculator AgentCore Harness',
      inlinePolicies: {
        InvokeModel: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            sid: 'InvokeClaude',
            actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
            // A cross-region inference profile fans out to the underlying foundation
            // models, so the profile ARN alone is not sufficient to authorise the call.
            resources: [
              `arn:aws:bedrock:*::foundation-model/*`,
              `arn:aws:bedrock:${props.region}:${props.account}:inference-profile/*`,
              `arn:aws:bedrock:*:${props.account}:inference-profile/*`,
            ],
          })],
        }),
        ReachGateway: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            sid: 'InvokeCalculatorGateway',
            actions: ['bedrock-agentcore:InvokeGateway'],
            resources: [this.gateway.attrGatewayArn, `${this.gateway.attrGatewayArn}/*`],
          })],
        }),
        Observability: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            sid: 'HarnessLogs',
            actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
            resources: [`arn:aws:logs:${props.region}:${props.account}:log-group:/aws/bedrock-agentcore/*`],
          })],
        }),
      },
    });

    // externalModules: [] is load-bearing. NodejsFunction leaves `@aws-sdk/*` external
    // by default on the assumption the Lambda runtime supplies it — but the Node 20
    // runtime's bundled SDK predates AgentCore and has no
    // @aws-sdk/client-bedrock-agentcore-control. The provisioner then failed at run time
    // with the genuinely confusing
    //   "Received response status [FAILED] … r.ListHarnessesCommand is not a constructor"
    // rather than a missing-module error. Bundling the SDK in pins the version that
    // actually has the Harness API.
    const agentCoreBundling = { minify: true, sourceMap: true, externalModules: [] };

    const harnessProvisioner = new nodejs.NodejsFunction(this, 'HarnessProvisioner', {
      functionName: getUniqueName('calculator-harness-provisioner'),
      entry: path.join(__dirname, '../lambdas/calculator-harness-provisioner/index.ts'),
      handler: 'onEvent',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      bundling: agentCoreBundling,
    });

    const harnessIsComplete = new nodejs.NodejsFunction(this, 'HarnessIsComplete', {
      functionName: getUniqueName('calculator-harness-is-complete'),
      entry: path.join(__dirname, '../lambdas/calculator-harness-provisioner/index.ts'),
      handler: 'isComplete',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      bundling: agentCoreBundling,
    });

    for (const fn of [harnessProvisioner, harnessIsComplete]) {
      fn.addToRolePolicy(new iam.PolicyStatement({
        sid: 'ManageCalculatorHarness',
        actions: [
          'bedrock-agentcore:CreateHarness',
          'bedrock-agentcore:UpdateHarness',
          'bedrock-agentcore:DeleteHarness',
          'bedrock-agentcore:GetHarness',
          'bedrock-agentcore:ListHarnesses',
          'bedrock-agentcore:ListHarnessEndpoints',
          'bedrock-agentcore:GetHarnessEndpoint',
          'bedrock-agentcore:CreateHarnessEndpoint',
          'bedrock-agentcore:UpdateHarnessEndpoint',
          'bedrock-agentcore:DeleteHarnessEndpoint',
          'bedrock-agentcore:TagResource',
          // CreateHarness is not a leaf operation: it provisions the Harness's own
          // managed AgentCore Runtime (observed as `harness_<name>-<suffix>`) plus its
          // DEFAULT endpoint and a workload identity, using the CALLER's permissions.
          // Without these it fails with
          //   "not authorized to perform: bedrock-agentcore:CreateAgentRuntime on
          //    resource: arn:aws:bedrock-agentcore:…:runtime/*"
          // which reads as though the harness needed them, not the provisioner.
          'bedrock-agentcore:CreateAgentRuntime',
          'bedrock-agentcore:UpdateAgentRuntime',
          'bedrock-agentcore:DeleteAgentRuntime',
          'bedrock-agentcore:GetAgentRuntime',
          'bedrock-agentcore:ListAgentRuntimes',
          'bedrock-agentcore:CreateAgentRuntimeEndpoint',
          'bedrock-agentcore:UpdateAgentRuntimeEndpoint',
          'bedrock-agentcore:DeleteAgentRuntimeEndpoint',
          'bedrock-agentcore:GetAgentRuntimeEndpoint',
          'bedrock-agentcore:CreateWorkloadIdentity',
          'bedrock-agentcore:DeleteWorkloadIdentity',
          'bedrock-agentcore:GetWorkloadIdentity',
        ],
        // Not resource-scoped, and this is the one place in this construct where that is
        // unavoidable rather than lazy: every id above is server-generated, so none of
        // these resources exist to be named at the moment they are created. The blast
        // radius is contained by this being a deploy-time-only provisioning role that
        // nothing else can assume.
        resources: ['*'],
      }));
      // Handing a role to AgentCore requires PassRole on it, scoped to that one role.
      fn.addToRolePolicy(new iam.PolicyStatement({
        sid: 'PassHarnessRole',
        actions: ['iam:PassRole'],
        resources: [harnessRole.roleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'bedrock-agentcore.amazonaws.com' } },
      }));
    }

    // CreateHarness reaches READY in ~2-3 minutes (measured), so the resource needs
    // isComplete polling rather than a single synchronous handler.
    const harnessProvider = new cr.Provider(this, 'HarnessProvider', {
      onEventHandler: harnessProvisioner,
      isCompleteHandler: harnessIsComplete,
      queryInterval: cdk.Duration.seconds(15),
      totalTimeout: cdk.Duration.minutes(30),
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    const harness = new cdk.CustomResource(this, 'CalculatorHarness', {
      serviceToken: harnessProvider.serviceToken,
      resourceType: 'Custom::AgentCoreHarness',
      properties: {
        HarnessName: `mimoCalc_${props.envName}`,
        ExecutionRoleArn: harnessRole.roleArn,
        ModelId: agentModelId,
        SystemPrompt: harnessSystemPrompt,
        GatewayArn: this.gateway.attrGatewayArn,
        MaxIterations: String(props.maxIterations ?? 60),
        MaxTokens: '8192',
        // Bounds ONE InvokeHarness call, not the calculation. Step Functions re-enters on
        // the same runtimeSessionId, and the managed runtime allows maxLifetime 28800s (8h).
        //
        // Deliberately minutes rather than the hour it used to be, because the
        // Gateway→Runtime hop hangs intermittently: measured over two identical sequential
        // runs, one stalled on the 5th tool call and the next got past it and stalled on
        // the 7th, on different tools, with every other call returning in under 1.1s. The
        // hang is an indefinite wait rather than an error, so the only defence is to bound
        // it. A short segment turns "this calculation is stuck for an hour" into "this
        // segment ends in seven minutes and the agent retries the tool on the next one".
        TimeoutSeconds: '420',
        // Forces an update when only the prompt text changed — CloudFormation would
        // otherwise see identical properties and skip the UpdateHarness call.
        ConfigHash: cdk.Fn.base64(`${agentModelId}:${harnessSystemPrompt.length}`).slice(0, 60),
      },
    });

    harness.node.addDependency(this.gatewayTarget);
    harness.node.addDependency(this.evidenceGatewayTarget);
    harness.node.addDependency(harnessRole);

    this.harnessId = harness.getAttString('HarnessId');
    this.harnessArn = harness.getAttString('HarnessArn');

    // ─── Asynchronous execution: Step Functions owns the job lifecycle ──────────
    //
    // Division of responsibility, and it matters:
    //
    //   AgentCore Harness   owns Claude ↔ tool iteration. Every model call, tool choice,
    //                       MCP invocation, error repair and retry happens in there.
    //   Step Functions      owns the JOB: start, continue, finish, fail, observe.
    //   the pump Lambda     owns ONE bounded InvokeHarness call and nothing else.
    //
    // There is no Claude loop in Step Functions and none in the Lambda. The pump reads a
    // stream and reports whether the agent finished; if it has not, the state machine
    // re-enters it with the SAME runtimeSessionId, which is how AgentCore continues a
    // conversation. That is what removes the 15-minute ceiling: no single Lambda owns the
    // calculation's lifetime, and the Harness's managed runtime permits 8-hour sessions
    // (maxLifetime 28800, measured).

    const driverLambda = new nodejs.NodejsFunction(this, 'HarnessDriver', {
      functionName: getUniqueName('calculator-harness-driver'),
      entry: path.join(__dirname, '../lambdas/calculator-harness-driver/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      // 14 minutes of Lambda for a 10-minute InvokeHarness segment: the segment budget is
      // what bounds the call, and this leaves room to finish writing the trace and the
      // status rather than being killed mid-write.
      timeout: cdk.Duration.minutes(10),
      memorySize: 1536,
      environment: {
        CALCULATOR_TABLE_NAME: props.calculatorTable.tableName,
        BUCKET_NAME: props.filesBucket.bucketName,
        CALCULATOR_HARNESS_ARN: this.harnessArn,
        CALCULATOR_AGENT_MODEL_ID: agentModelId,
        CALCULATOR_GATEWAY_ARN: this.gateway.attrGatewayArn,
        CALCULATOR_MCP_RUNTIME_ARN: this.runtime.attrAgentRuntimeArn,
        CALCULATOR_STEP_TIMEOUT_SECONDS: '420',
        MIMO_BUILD_SHA: process.env.MIMO_BUILD_SHA || 'unknown',
      },
      // The Node 20 runtime's bundled SDK predates AgentCore, so InvokeHarness must be
      // bundled in. Without this the driver fails at run time with the deeply unhelpful
      // "InvokeHarnessCommand is not a constructor".
      bundling: agentCoreBundling,
    });

    props.calculatorTable.grantReadWriteData(driverLambda);
    props.filesBucket.grantRead(driverLambda);
    driverLambda.addToRolePolicy(new iam.PolicyStatement({
      sid: 'WriteCalculatorArtifacts',
      actions: ['s3:PutObject'],
      resources: [`${props.filesBucket.bucketArn}/users/*/calculator/*`],
    }));
    driverLambda.addToRolePolicy(new iam.PolicyStatement({
      sid: 'InvokeCalculatorHarness',
      // The InvokeHarness *API* authorizes as InvokeAgentRuntime on the harness resource,
      // not as an action named after itself. Granting only `InvokeHarness` produced a 403
      // that named the action it actually wanted:
      //   "not authorized to perform: bedrock-agentcore:InvokeAgentRuntime on resource:
      //    arn:aws:bedrock-agentcore:…:harness/mimoCalc_dev-…"
      // Both are listed so the grant survives either naming.
      actions: ['bedrock-agentcore:InvokeAgentRuntime', 'bedrock-agentcore:InvokeHarness'],
      // The harness ARN is a Custom Resource attribute, so it resolves at deploy time.
      resources: [this.harnessArn, `${this.harnessArn}/*`],
    }));

    const invokeSegment = new tasks.LambdaInvoke(this, 'InvokeHarnessSegment', {
      lambdaFunction: driverLambda,
      payloadResponseOnly: true,
      // Retries cover Lambda/AgentCore transients. They do NOT retry a completed
      // calculation: the driver is re-entered with the same session, and a finished run
      // reports done immediately.
      retryOnServiceExceptions: true,
    });
    invokeSegment.addRetry({
      errors: ['States.TaskFailed', 'Lambda.ServiceException', 'Lambda.TooManyRequestsException'],
      interval: cdk.Duration.seconds(20),
      maxAttempts: 3,
      backoffRate: 2,
    });

    const finished = new sfn.Succeed(this, 'CalculationFinished');

    // Guard against a pathological non-terminating agent. 60 segments × 10 minutes is
    // 10 hours of ceiling — deliberately far above any legitimate run, so it can only
    // ever catch a genuine runaway rather than a large workbook.
    const tooManySegments = new sfn.Fail(this, 'TooManySegments', {
      error: 'AgentDidNotTerminate',
      cause: 'The AgentCore execution did not reach a terminal result within the segment budget.',
    });

    const decide = new sfn.Choice(this, 'AgentFinished?')
      .when(sfn.Condition.booleanEquals('$.done', true), finished)
      .when(sfn.Condition.numberGreaterThan('$.iteration', 60), tooManySegments)
      .otherwise(invokeSegment);

    invokeSegment.next(decide);

    // A failure inside the driver must still leave the customer's record in a terminal
    // state, or the UI shows a job that is neither running nor finished for ever.
    const markFailed = new tasks.LambdaInvoke(this, 'MarkCalculationFailed', {
      lambdaFunction: driverLambda,
      payloadResponseOnly: true,
      payload: sfn.TaskInput.fromObject({
        'calculationId.$': '$$.Execution.Input.calculationId',
        mode: 'fail',
        'errorInfo.$': '$.errorInfo',
      }),
    });
    markFailed.next(new sfn.Fail(this, 'CalculationFailed', {
      error: 'CalculationFailed',
      cause: 'The AgentCore calculator execution failed. See the calculation record and S3 trace.',
    }));
    invokeSegment.addCatch(markFailed, { resultPath: '$.errorInfo' });

    this.executionStateMachine = new sfn.StateMachine(this, 'CalculatorExecution', {
      stateMachineName: getUniqueName('calculator-agentcore-exec'),
      // STANDARD, not EXPRESS: Express caps at 5 minutes, which is the very limit this
      // design exists to escape. Standard also gives durable, queryable execution status,
      // which is what replaces the old 11-minute updated_at staleness guess.
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(invokeSegment),
      timeout: cdk.Duration.hours(12),
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, 'CalculatorExecutionLogs', {
          logGroupName: `/aws/vendedlogs/states/${getUniqueName('calculator-agentcore-exec')}`,
          retention: logs.RetentionDays.TWO_WEEKS,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        level: sfn.LogLevel.ERROR,
      },
    });

    new cdk.CfnOutput(this, 'ExecutionStateMachineArn', {
      description: 'Calculator AgentCore execution state machine ARN',
      value: this.executionStateMachine.stateMachineArn,
      exportName: `${getUniqueName('calc-exec-sm-arn')}`,
    });

    new cdk.CfnOutput(this, 'HarnessArnOutput', {
      description: 'Calculator AgentCore Harness ARN',
      value: this.harnessArn,
      exportName: `${getUniqueName('calc-harness-arn')}`,
    });

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
        // Legacy rollback mode only — see the file header. Named for what it is
        // rather than for what it was mislabelled as.
        EXECUTION_MODE: 'legacy-invokemodel',
        // AWS_REGION is deliberately NOT set: it is reserved by the Lambda runtime,
        // which populates it itself. Setting it fails synth outright with
        // «ReservedEnvironmentVariable» once the stack region resolves to a literal.
        //
        // CALCULATOR_AGENT_SYSTEM_PROMPT is deliberately NOT set either. It used to
        // carry the entire system prompt as an environment variable, which broke the
        // moment the prompt grew:
        //   UPDATE_FAILED  AWS::Lambda::Function  CalculatorAgentCore/AgentOrchestrator
        //   "Request must be smaller than 5120 bytes for the
        //    UpdateFunctionConfiguration operation" (413)
        // Lambda caps a function's whole configuration, so a prompt in env is a design
        // with a hard ceiling a few edits away. The authoritative prompt now lives on
        // the AgentCore Harness, passed through the Custom Resource where no such limit
        // applies. This Lambda is the `legacy-invokemodel` rollback path and falls back
        // to its own condensed prompt.
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });

    props.calculatorTable.grantReadWriteData(this.agentLambda);
    props.filesBucket.grantRead(this.agentLambda);
    // Agent Lambda writes result.json to S3 (same as the old orchestrator Lambda).
    this.agentLambda.addToRolePolicy(new iam.PolicyStatement({
      sid: 'S3WriteResult',
      actions: ['s3:PutObject'],
      resources: [`${props.filesBucket.bucketArn}/users/*/calculator/*`],
    }));
    this.mcpProxyLambda.grantInvoke(this.agentLambda);

    // Model access for the `legacy-invokemodel` rollback path only.
    //
    // The InvokeInlineAgent grants that used to be here are gone. They were never
    // exercised — nothing in this repo ever called InvokeInlineAgent — and Bedrock Agents
    // Classic is explicitly not part of this architecture. Keeping a permission for an
    // API you have decided not to use makes the design look ambiguous in exactly the
    // place it needs to be unambiguous, and an architectural gate now asserts the whole
    // synthesised template is free of it.
    this.agentLambda.addToRolePolicy(new iam.PolicyStatement({
      sid: 'BedrockInvokeModelLegacyPath',
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
        'bedrock:GetInferenceProfile',
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
