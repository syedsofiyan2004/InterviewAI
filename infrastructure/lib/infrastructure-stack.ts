import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { CalculatorAgentCore } from './calculator-agentcore';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { execSync } from 'child_process';
import * as path from 'path';

/**
 * The commit this deployment was synthesised from, stamped into the calculator's diagnostics
 * so a failed estimate can be tied to the exact code that produced it. 'unknown' outside a
 * git checkout rather than a synth failure: the stamp is diagnostic, not load-bearing.
 */
const MIMO_BUILD_SHA = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'unknown';
  } catch {
    return 'unknown';
  }
})();

/**
 * How often the Keka schedule sweep runs. An operator lever rather than a
 * constant: KEKA_SYNC_STATUS_MODE=all walks every candidate of every job, so the
 * floor stays above the worker lease/timing jitter. Clamped so a mistyped value
 * cannot become rate(0) or a rate EventBridge will not accept, and shared by the
 * rule and the Lambda env so the two cannot drift.
 */
export function kekaSyncRateMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const minutes = Number(env.KEKA_SYNC_RATE_MINUTES);
  if (Number.isFinite(minutes) && minutes > 0) {
    return Math.min(24 * 60, Math.max(15, Math.floor(minutes)));
  }
  const hours = Number(env.KEKA_SYNC_RATE_HOURS);
  if (Number.isFinite(hours) && hours > 0) {
    return Math.min(24 * 60, Math.max(15, Math.floor(hours * 60)));
  }
  return 6 * 60;
}

export function kekaSyncRateHours(env: NodeJS.ProcessEnv = process.env): number {
  return Math.ceil(kekaSyncRateMinutes(env) / 60);
}

export class IepStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const envName = process.env.NODE_ENV || 'dev';
    const isProduction = envName === 'prod';
    const account = cdk.Stack.of(this).account;
    const region = cdk.Stack.of(this).region;

    const prefix = 'iep';
    const teamsSecretArn = process.env.MS_TEAMS_SECRET_ARN || '';
    const kekaSecretArn = process.env.KEKA_SECRET_ARN || '';

    // The Lambda's KEKA_* credential env vars are deliberately blank (see the
    // environment block below) so CloudFormation never holds them, which leaves
    // Secrets Manager as the only credential source. Deploying live without the
    // secret therefore ships a handler that can authenticate to nothing, and the
    // failure would only surface on the first Keka call. Warn at synth instead of
    // failing the deploy, so an unrelated change can still ship.
    if ((process.env.KEKA_INTEGRATION_MODE || '').trim().toLowerCase() === 'live' && !kekaSecretArn) {
      throw new Error(
        'KEKA_INTEGRATION_MODE=live requires KEKA_SECRET_ARN because Keka credentials are read only from Secrets Manager at runtime.',
      );
    }

    // Helper for unique names
    const getUniqueName = (resource: string) => `${prefix}-${envName}-${resource}-${account}-${region}`;

    // 1. S3 Bucket for files
    const filesBucket = new s3.Bucket(this, 'FilesBucket', {
      bucketName: getUniqueName('files'),
      removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProduction,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      cors: [{
        allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.POST, s3.HttpMethods.GET],
        allowedOrigins: ['*'], // In production, restrict to your frontend domain
        allowedHeaders: ['*'],
      }],
    });
    filesBucket.addToResourcePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject'],
      resources: [filesBucket.arnForObjects('*')],
      principals: [new iam.ServicePrincipal('transcribe.amazonaws.com')],
      conditions: {
        StringEquals: { 'aws:SourceAccount': account },
        ArnLike: { 'aws:SourceArn': `arn:${cdk.Aws.PARTITION}:transcribe:${region}:${account}:transcription-job/*` },
      },
    }));
    filesBucket.addToResourcePolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [filesBucket.bucketArn],
      principals: [new iam.ServicePrincipal('transcribe.amazonaws.com')],
      conditions: {
        StringEquals: { 'aws:SourceAccount': account },
        ArnLike: { 'aws:SourceArn': `arn:${cdk.Aws.PARTITION}:transcribe:${region}:${account}:transcription-job/*` },
      },
    }));

    // 2. DynamoDB Table for interview metadata
    const interviewsTable = new dynamodb.Table(this, 'InterviewsTable', {
      tableName: getUniqueName('interviews-v2'),
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      pointInTimeRecovery: true,
    });

    const momTable = new dynamodb.Table(this, 'MomTable', {
      tableName: getUniqueName('moms'),
      partitionKey: { name: 'mom_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      pointInTimeRecovery: true,
    });

    const intelligenceTable = new dynamodb.Table(this, 'InterviewIntelligenceTable', {
      tableName: getUniqueName('interview-intelligence'),
      partitionKey: { name: 'intelligence_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      pointInTimeRecovery: true,
    });

    // Admin Portal & collaboration table. Single-table PK/SK design holding
    // Membership, AdminGrant, CandidateWorkspace, WorkspaceShare, Comment,
    // ApprovalDecision, and AuditLogEntry rows. Kept separate from the
    // interviews table so audit rows never slow the Scan-based list endpoints.
    // RETAIN in production so a rollback never drops access-control history.
    const adminTable = new dynamodb.Table(this, 'AdminTable', {
      tableName: getUniqueName('admin'),
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      pointInTimeRecovery: true,
    });
    // Sparse GSIs — rows only appear when they set the index attributes.
    adminTable.addGlobalSecondaryIndex({
      indexName: 'GSI1_OrgRecency',
      partitionKey: { name: 'gsi1_pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1_sk', type: dynamodb.AttributeType.NUMBER },
    });
    adminTable.addGlobalSecondaryIndex({
      indexName: 'GSI2_SharedWithUser',
      partitionKey: { name: 'gsi2_pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi2_sk', type: dynamodb.AttributeType.NUMBER },
    });
    adminTable.addGlobalSecondaryIndex({
      indexName: 'GSI3_AuditActor',
      partitionKey: { name: 'gsi3_pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi3_sk', type: dynamodb.AttributeType.NUMBER },
    });
    adminTable.addGlobalSecondaryIndex({
      indexName: 'GSI4_MemberEmail',
      partitionKey: { name: 'gsi4_pk', type: dynamodb.AttributeType.STRING },
    });

    // Link existing records to a CandidateWorkspace by workspace_id. Sparse:
    // no current row sets workspace_id, so existing data/queries are unaffected.
    interviewsTable.addGlobalSecondaryIndex({
      indexName: 'GSI_Workspace',
      partitionKey: { name: 'workspace_id', type: dynamodb.AttributeType.STRING },
    });
    momTable.addGlobalSecondaryIndex({
      indexName: 'GSI_Workspace',
      partitionKey: { name: 'workspace_id', type: dynamodb.AttributeType.STRING },
    });
    intelligenceTable.addGlobalSecondaryIndex({
      indexName: 'GSI_Workspace',
      partitionKey: { name: 'workspace_id', type: dynamodb.AttributeType.STRING },
    });

    // AWS Cost Calculator — the hub's third app. One row per estimate request,
    // holding the prompt, the PROCESSING/COMPLETED/FAILED lifecycle and the
    // finished breakdown. Same shape as momTable: a single-id table, because
    // estimates are only ever read by id or scanned per owner.
    const calculatorTable = new dynamodb.Table(this, 'CalculatorTable', {
      tableName: getUniqueName('calculations'),
      partitionKey: { name: 'calculation_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      pointInTimeRecovery: true,
    });

    // Scratch space for the MCP sidecar, NOT application data. The upstream
    // pricing-calculator server keeps an in-flight estimate across its
    // create_estimate -> add_service -> export_estimate calls; its default memory
    // store cannot survive between Lambda invocations, so it is pointed at this
    // table instead (ESTIMATES_STORE=dynamodb). Schema is upstream's: PK `id`,
    // a `snapshot` string, and `expiresAt` for TTL. DESTROY even in production —
    // a snapshot is worthless once its estimate is exported.
    const calculatorEstimatesTable = new dynamodb.Table(this, 'CalculatorEstimatesTable', {
      tableName: getUniqueName('calculator-estimates'),
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'expiresAt',
    });

    // Context chat transcripts. One thread per artifact per user: PK is
    // `{app}#{entityId}#{userId}` and SK is a monotonic turn number, so a thread's
    // history is one query and no thread can be read across accounts even if its id
    // leaks. Threads expire after 30 days (see lambdas/chat/store.ts) — the estimate,
    // the minutes and the evaluation are the record; a conversation about them is not,
    // and keeping model output about candidates indefinitely has no retention story.
    // Thirty rather than the ninety this shipped with, because these transcripts are now
    // readable by any REVIEWER-tier admin from the conversations list, which turns the
    // window from a housekeeping default into a deliberate choice about how long model
    // output discussing named candidates stays legible to the org.
    const chatTable = new dynamodb.Table(this, 'ChatTable', {
      tableName: getUniqueName('chat-threads'),
      partitionKey: { name: 'thread_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'seq', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'expires_at',
      pointInTimeRecovery: true,
    });


    // 3. SQS Queue and DLQ for evaluation
    const evaluationDlq = new sqs.Queue(this, 'EvaluationDlq', {
      queueName: getUniqueName('eval-dlq'),
    });

    const evaluationQueue = new sqs.Queue(this, 'EvaluationQueue', {
      queueName: getUniqueName('eval-queue'),
      visibilityTimeout: cdk.Duration.minutes(15),
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: evaluationDlq,
      },
    });

    const momDlq = new sqs.Queue(this, 'MomDlq', {
      queueName: getUniqueName('mom-dlq'),
    });

    const momQueue = new sqs.Queue(this, 'MomQueue', {
      queueName: getUniqueName('mom-queue'),
      visibilityTimeout: cdk.Duration.minutes(15),
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: momDlq,
      },
    });

    // 4. API Handler Lambda
    const apiHandler = new nodejs.NodejsFunction(this, 'ApiHandler', {
      functionName: getUniqueName('api-handler'),
      entry: path.join(__dirname, '../lambdas/api-handler/index.ts'),
      handler: 'handler',

      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(15), // Allows async AI review and recording transcription workers to finish reliably.
      memorySize: 1024,
      environment: {
        TABLE_NAME: interviewsTable.tableName,
        BUCKET_NAME: filesBucket.bucketName,
        QUEUE_URL: evaluationQueue.queueUrl,
        MOM_TABLE_NAME: momTable.tableName,
        MOM_QUEUE_URL: momQueue.queueUrl,
        INTELLIGENCE_TABLE_NAME: intelligenceTable.tableName,
        ADMIN_TABLE_NAME: adminTable.tableName,
        CALCULATOR_TABLE_NAME: calculatorTable.tableName,
        SEED_ADMIN_EMAIL: process.env.SEED_ADMIN_EMAIL || '',
        KEKA_INTEGRATION_MODE: process.env.KEKA_INTEGRATION_MODE || 'disabled',
        TEAMS_INTEGRATION_MODE: process.env.TEAMS_INTEGRATION_MODE || 'disabled',
        // Keka credentials are supplied through a dedicated runtime secret.
        // Do not copy local .env credential values into the Lambda template:
        // CloudFormation would expose them in stack metadata and synth output.
        KEKA_BASE_URL: '',
        KEKA_CLIENT_ID: '',
        KEKA_CLIENT_SECRET: '',
        KEKA_API_KEY: '',
        KEKA_SCOPE: '',
        KEKA_SECRET_ARN: kekaSecretArn,
        // Microsoft Graph credentials are read only at runtime from Secrets Manager.
        MS_TEAMS_SECRET_ARN: teamsSecretArn,
        KEKA_INTERVIEW_ACTIVE_STATUSES: process.env.KEKA_INTERVIEW_ACTIVE_STATUSES || '',
        // 'filtered' (default) sweeps only candidates whose Keka status is in
        // KEKA_INTERVIEW_ACTIVE_STATUSES. 'all' is the documented fallback for a
        // tenant with no usable status field — far more Keka calls, so raise
        // KEKA_SYNC_RATE_HOURS with it.
        KEKA_SYNC_STATUS_MODE: process.env.KEKA_SYNC_STATUS_MODE || 'filtered',
        KEKA_SYNC_RATE_MINUTES: String(kekaSyncRateMinutes()),
        KEKA_SYNC_RATE_HOURS: String(kekaSyncRateHours()),
        // How far either side of now the sweep indexes interviews. Blank means the
        // worker's own defaults (7 back, 30 forward). Raise the lookback to bring
        // already-completed rounds into My Interviews — it costs no extra Keka
        // calls, since the window only filters interviews the sweep already
        // fetched.
        KEKA_SYNC_LOOKBACK_DAYS: process.env.KEKA_SYNC_LOOKBACK_DAYS || '',
        KEKA_SYNC_LOOKAHEAD_DAYS: process.env.KEKA_SYNC_LOOKAHEAD_DAYS || '',
        // Standardized Model Sync (Sonnet 5 + legacy fallbacks + Nova)
        BEDROCK_SONNET_5_PROFILE_ARN: process.env.BEDROCK_SONNET_5_PROFILE_ARN || 'global.anthropic.claude-sonnet-5',
        CALCULATOR_FAST_MODEL_ID: process.env.CALCULATOR_FAST_MODEL_ID || 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
        CALCULATOR_REASONING_MODEL_ID: process.env.CALCULATOR_REASONING_MODEL_ID || 'global.anthropic.claude-sonnet-4-6',
        CALCULATOR_MODEL_ROUTING_MODE: process.env.CALCULATOR_MODEL_ROUTING_MODE || 'hybrid',
        BEDROCK_SONNET_PROFILE_ARN: 'arn:aws:bedrock:ap-south-1::inference-profile/apac.anthropic.claude-3-7-sonnet-20250219-v1:0',
        BEDROCK_SONNET_46_PROFILE_ARN: process.env.BEDROCK_SONNET_46_PROFILE_ARN || 'arn:aws:bedrock:ap-south-1::inference-profile/global.anthropic.claude-sonnet-4-6',
        BEDROCK_NOVA_PROFILE_ARN: 'arn:aws:bedrock:ap-south-1::inference-profile/apac.amazon.nova-pro-v1:0',
        ALLOW_BEDROCK_BASE_MODEL_FALLBACK: 'true',
        PLATFORM_VERSION: `v1.5.0-universal-${Date.now()}`,
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });

    // Permissions for API Handler
    interviewsTable.grantReadWriteData(apiHandler);
    momTable.grantReadWriteData(apiHandler);
    intelligenceTable.grantReadWriteData(apiHandler);
    adminTable.grantReadWriteData(apiHandler);
    calculatorTable.grantReadWriteData(apiHandler);
    filesBucket.grantReadWrite(apiHandler);
    filesBucket.grantDelete(apiHandler);
    evaluationQueue.grantSendMessages(apiHandler);
    momQueue.grantSendMessages(apiHandler);
    // The handler invokes itself asynchronously for long-running AI reviews.
    // A direct grant to itself creates a CloudFormation dependency cycle.
    apiHandler.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [cdk.Stack.of(this).formatArn({
        service: 'lambda',
        resource: 'function',
        resourceName: getUniqueName('api-handler'),
        arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
      })],
    }));
    apiHandler.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'transcribe:StartTranscriptionJob',
        'transcribe:GetTranscriptionJob',
        // cancelTranscriptionJobIfStarted() calls DeleteTranscriptionJob when a
        // record is deleted mid-transcription. Without this the call fails
        // AccessDenied into a try/catch that only warns, so abandoned jobs would
        // linger in the account forever and nobody would ever see why.
        'transcribe:DeleteTranscriptionJob',
      ],
      resources: ['*'],
    }));

    if (teamsSecretArn) {
      const teamsCredentialsSecret = secretsmanager.Secret.fromSecretCompleteArn(
        this,
        'TeamsGraphCredentialsSecret',
        teamsSecretArn,
      );
      teamsCredentialsSecret.grantRead(apiHandler);
    }
    if (kekaSecretArn) {
      const kekaCredentialsSecret = secretsmanager.Secret.fromSecretCompleteArn(
        this,
        'KekaHireCredentialsSecret',
        kekaSecretArn,
      );
      kekaCredentialsSecret.grantRead(apiHandler);
    }
    
    // Emergency Access Restoration: Revert to wildcard to restore Nova + Claude immediately
    const bedrockPolicy = new iam.PolicyStatement({
      actions: [
        'bedrock:InvokeModel',
        'bedrock:GetInferenceProfile',
        'aws-marketplace:ViewSubscriptions',
        'aws-marketplace:Subscribe'
      ],
      resources: ['*'], 
    });
    apiHandler.addToRolePolicy(bedrockPolicy);
    // 5. Async Worker Lambda
    const asyncWorker = new nodejs.NodejsFunction(this, 'AsyncWorker', {
      functionName: getUniqueName('async-worker'),
      entry: path.join(__dirname, '../lambdas/processor/index.ts'),
      handler: 'handler',

      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(10),
      memorySize: 1024,
      environment: {
        TABLE_NAME: interviewsTable.tableName,
        BUCKET_NAME: filesBucket.bucketName,
        // Standardized Worker Sync (Sonnet 5 + legacy fallbacks + Nova)
        BEDROCK_SONNET_5_PROFILE_ARN: process.env.BEDROCK_SONNET_5_PROFILE_ARN || 'global.anthropic.claude-sonnet-5',
        CALCULATOR_FAST_MODEL_ID: process.env.CALCULATOR_FAST_MODEL_ID || 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
        CALCULATOR_REASONING_MODEL_ID: process.env.CALCULATOR_REASONING_MODEL_ID || 'global.anthropic.claude-sonnet-4-6',
        BEDROCK_SONNET_PROFILE_ARN: 'arn:aws:bedrock:ap-south-1::inference-profile/apac.anthropic.claude-3-7-sonnet-20250219-v1:0',
        BEDROCK_SONNET_46_PROFILE_ARN: process.env.BEDROCK_SONNET_46_PROFILE_ARN || 'arn:aws:bedrock:ap-south-1::inference-profile/global.anthropic.claude-sonnet-4-6',
        BEDROCK_NOVA_PROFILE_ARN: 'arn:aws:bedrock:ap-south-1::inference-profile/apac.amazon.nova-pro-v1:0',
        ALLOW_BEDROCK_BASE_MODEL_FALLBACK: 'true',
        PLATFORM_VERSION: `v1.3.5-restored-${Date.now()}`,
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });

    // Permissions for Async Worker
    interviewsTable.grantReadWriteData(asyncWorker);
    filesBucket.grantReadWrite(asyncWorker);
    asyncWorker.addEventSource(new SqsEventSource(evaluationQueue));
    
    // Emergency Access Restoration: Worker
    asyncWorker.addToRolePolicy(bedrockPolicy);

    const momProcessor = new nodejs.NodejsFunction(this, 'MomProcessor', {
      functionName: getUniqueName('mom-processor'),
      entry: path.join(__dirname, '../lambdas/mom-processor/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(10),
      memorySize: 1024,
      environment: {
        MOM_TABLE_NAME: momTable.tableName,
        BUCKET_NAME: filesBucket.bucketName,
        MOM_MODEL_ID: process.env.MOM_MODEL_ID || 'global.anthropic.claude-sonnet-5',
        PLATFORM_VERSION: `v1.0.0-mom-${Date.now()}`,
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });

    momTable.grantReadWriteData(momProcessor);
    filesBucket.grantReadWrite(momProcessor);
    momProcessor.addEventSource(new SqsEventSource(momQueue, {
      batchSize: 1,
      maxConcurrency: 20,
    }));
    momProcessor.addToRolePolicy(bedrockPolicy);

    // AWS Cost Calculator — the MCP sidecar.
    //
    // The upstream pricing-calculator server is a Node process, not a library
    // (its package ships only a running server, with no exports), so it is run
    // as-is inside a container image with Lambda Web Adapter translating invokes
    // into the HTTP requests its Express app expects. This is the only container
    // image in the stack; everything else is a NodejsFunction.
    //
    // No Function URL: the orchestrator invokes it directly, which keeps the
    // sidecar off the public internet and avoids SigV4 signing entirely.
    const calculatorSidecar = new lambda.DockerImageFunction(this, 'CalculatorMcpSidecar', {
      functionName: getUniqueName('calculator-mcp-sidecar'),
      code: lambda.DockerImageCode.fromImageAsset(
        path.join(__dirname, '../lambdas/calculator-mcp-sidecar'),
      ),
      timeout: cdk.Duration.minutes(2),
      memorySize: 1024,
      environment: {
        MCP_TRANSPORT: 'http',
        // The in-memory store cannot survive between invocations, so the
        // in-flight estimate lives in DynamoDB. Snapshots expire after a day —
        // long past the point any loop could still be building that estimate.
        ESTIMATES_STORE: 'dynamodb',
        ESTIMATES_TABLE: calculatorEstimatesTable.tableName,
        ESTIMATES_TTL_SECONDS: '86400',
        // GET/DELETE /mcp answer 405, so an HTTP readiness probe would never pass.
        AWS_LWA_READINESS_CHECK_PROTOCOL: 'tcp',
      },
    });
    calculatorEstimatesTable.grantReadWriteData(calculatorSidecar);

    const calculatorBrowserValidator = new lambda.DockerImageFunction(this, 'CalculatorBrowserValidator', {
      functionName: getUniqueName('calculator-browser-validator'),
      code: lambda.DockerImageCode.fromImageAsset(
        path.join(__dirname, '../lambdas/calculator-browser-validator'),
      ),
      architecture: lambda.Architecture.X86_64,
      timeout: cdk.Duration.minutes(2),
      memorySize: 2048,
      ephemeralStorageSize: cdk.Size.gibibytes(1),
    });

    // The tool-use loop: N sequential Bedrock round-trips driving the sidecar's
    // tools. Its own budget is 8 minutes, so 15 leaves room for the final write
    // rather than being killed mid-loop.
    const calculatorOrchestrator = new nodejs.NodejsFunction(this, 'CalculatorOrchestrator', {
      functionName: getUniqueName('calculator-orchestrator'),
      entry: path.join(__dirname, '../lambdas/calculator-orchestrator/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
      environment: {
        CALCULATOR_TABLE_NAME: calculatorTable.tableName,
        CALCULATOR_SIDECAR_FUNCTION_NAME: calculatorSidecar.functionName,
        CALCULATOR_BROWSER_VALIDATOR_FUNCTION_NAME: calculatorBrowserValidator.functionName,
        // A landscape too large for a 400KB DynamoDB item has its parsed rows written
        // to S3 by the route; the orchestrator reads them back from here.
        BUCKET_NAME: filesBucket.bucketName,
        BEDROCK_SONNET_5_PROFILE_ARN: process.env.BEDROCK_SONNET_5_PROFILE_ARN || 'global.anthropic.claude-sonnet-5',
        PLATFORM_VERSION: `v1.0.0-calculator-${Date.now()}`,
        MIMO_BUILD_SHA,
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });

    calculatorTable.grantReadWriteData(calculatorOrchestrator);
    calculatorSidecar.grantInvoke(calculatorOrchestrator);
    calculatorBrowserValidator.grantInvoke(calculatorOrchestrator);
    // Read only: the orchestrator consumes the parsed-row spill, it never writes to the
    // bucket. The route owns both writing that object and deleting it.
    filesBucket.grantRead(calculatorOrchestrator);
    calculatorOrchestrator.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject'],
      resources: [`${filesBucket.bucketArn}/users/*/calculator/*/result.json`],
    }));
    calculatorOrchestrator.addToRolePolicy(bedrockPolicy);
    // The saved calculator.aws estimate carries no money — pricing runs in the
    // browser when a person opens the link. So the orchestrator reads published
    // rates from the Price List Query API and derives the costs itself. Read-only,
    // no resource-level ARNs (the API does not support them), and it only ever
    // answers in us-east-1 regardless of the region being priced.
    calculatorOrchestrator.addToRolePolicy(new iam.PolicyStatement({
      actions: ['pricing:GetProducts', 'pricing:DescribeServices', 'pricing:GetAttributeValues'],
      resources: ['*'],
    }));

    // POST /calculator fires the orchestrator asynchronously. Set after the
    // orchestrator exists rather than in the env block above, which is declared
    // earlier in this file. The self-invoke grant above is scoped to the handler's
    // own ARN, so it does NOT cover this — without an explicit grant every estimate
    // would fail at the queue step with AccessDenied.
    apiHandler.addEnvironment('CALCULATOR_ORCHESTRATOR_FUNCTION_NAME', calculatorOrchestrator.functionName);
    apiHandler.addEnvironment('CALCULATOR_SIDECAR_FUNCTION_NAME', calculatorSidecar.functionName);
    calculatorOrchestrator.grantInvoke(apiHandler);
    calculatorSidecar.grantInvoke(apiHandler);

    // ─── AgentCore Calculator (Phase 1–2) ─────────────────────────────────────
    //
    // Provisions the new AgentCore-based execution path alongside the existing
    // Lambda orchestrator. Production traffic stays on the old path until Phase 5
    // acceptance tests pass and the CALCULATOR_EXECUTION_MODE feature flag is
    // set to 'agentcore-harness'.
    //
    // CfnHarness is not yet available in aws-cdk-lib 2.250.0; the "Harness" is
    // implemented as a Lambda calling Bedrock InvokeInlineAgent (the managed agent
    // loop). CDK will be updated to use CfnHarness when the construct ships.
    const calculatorAgentCore = new CalculatorAgentCore(this, 'CalculatorAgentCore', {
      envName,
      account,
      region,
      existingSidecar: calculatorSidecar,
      estimatesTable: calculatorEstimatesTable,
      filesBucket,
      calculatorTable,
      agentModelId: process.env.BEDROCK_SONNET_46_PROFILE_ARN || 'global.anthropic.claude-sonnet-4-6',
      maxIterations: 40,
    });

    // Wire the agent Lambda into the API handler for the new execution path.
    calculatorAgentCore.agentLambda.grantInvoke(apiHandler);
    apiHandler.addEnvironment('CALCULATOR_AGENT_LAMBDA_ARN', calculatorAgentCore.agentLambda.functionArn);
    apiHandler.addEnvironment('CALCULATOR_AGENT_GATEWAY_ARN', calculatorAgentCore.gateway.attrGatewayArn);
    // Feature flag: set to 'agentcore-harness' after Phase 5 acceptance tests pass.
    // Until then, existing traffic continues through the old orchestrator.
    apiHandler.addEnvironment('CALCULATOR_EXECUTION_MODE', process.env.CALCULATOR_EXECUTION_MODE || 'legacy');

    // 6. Cognito User Pool (self sign-up enabled, email-based)
    //
    // Email delivery. Leaving COGNITO_SES_FROM_ADDRESS unset keeps Cognito's
    // built-in provider, which sends from the shared no-reply@verificationemail.com.
    // That address cannot be SPF/DKIM-aligned with the recipient's domain and its
    // reputation is pooled across every AWS account using the default, so corporate
    // security gateways treat it with suspicion. minfytech.com resolves MX to Barracuda
    // ESS at priority 0/1 ahead of Microsoft 365 at 100, so every inbound message is
    // filtered there first. Delivery is fragile rather than impossible -- as of
    // 2026-08-18, 12 of 13 @minfytech.com users had confirmed successfully -- which is
    // what makes it hard to diagnose: it fails for some recipients and not others.
    // Two mechanisms drive the intermittency, and both are properties of the default
    // provider. It is capped at 50 emails/day for the whole AWS account (not
    // adjustable, resets 0900 UTC) shared across all three pools here, and when the cap
    // is exhausted sends stop silently while SignUp still returns success. And a hard
    // bounce puts that one address on an AWS-managed suppression list we can neither
    // inspect nor clear, killing it permanently while its colleagues keep working.
    // Gmail sits behind neither a gateway nor those failure modes, so it works every
    // time -- hence 'personal mail always gets the code, work mail is a coin flip'.
    //
    // Setting COGNITO_SES_FROM_ADDRESS to an address on an SES-verified domain moves
    // sending to our own SES account: DKIM-signed by a domain we control, acceptable
    // to the gateway, and bounded by our SES quota rather than the 50/day cap. It
    // also gives us an account-level suppression list we can edit -- on the default
    // provider, hard bounces land on an AWS-managed list with no way to remove them.
    //
    // Ordering is load-bearing. The SES domain must be verified AND the account out
    // of the SES sandbox BEFORE this is set. In the sandbox SES rejects every
    // unverified recipient, so switching early breaks sign-up for everyone instead of
    // just @minfytech.com. ap-south-1 is a 'backwards compatible' pool region, so a
    // same-region SES identity is supported and is the default here.
    // EmailConfiguration updates in place, so flipping this never replaces the pool
    // or its existing users.
    // Verifying the whole sending domain beats verifying one address: the DNS work is
    // done once and any From address under it then works. Set COGNITO_SES_VERIFIED_DOMAIN
    // when that is what was verified, so the SES SourceArn points at the domain
    // identity -- derived from the From address alone it would name an address identity
    // that does not exist on its own.
    const cognitoSesFromAddress = (process.env.COGNITO_SES_FROM_ADDRESS || '').trim();
    const cognitoSesReplyTo = (process.env.COGNITO_SES_REPLY_TO_ADDRESS || '').trim();
    const cognitoSesVerifiedDomain = (process.env.COGNITO_SES_VERIFIED_DOMAIN || '').trim();

    const userPool = new cognito.UserPool(this, 'IepUserPool', {
      userPoolName: getUniqueName('user-pool'),
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      email: cognitoSesFromAddress
        ? cognito.UserPoolEmail.withSES({
            fromEmail: cognitoSesFromAddress,
            fromName: (process.env.COGNITO_SES_FROM_NAME || '').trim() || 'Interview Evaluation Platform',
            sesRegion: (process.env.COGNITO_SES_REGION || '').trim() || region,
            ...(cognitoSesReplyTo ? { replyTo: cognitoSesReplyTo } : {}),
            ...(cognitoSesVerifiedDomain ? { sesVerifiedDomain: cognitoSesVerifiedDomain } : {}),
          })
        : cognito.UserPoolEmail.withCognito(),
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // Message-delivery logging. Without it there is no record of a verification code
    // that failed to send: SignUp returns success either way, so a user who never
    // received a code is indistinguishable from one who ignored it. That gap is why
    // the @minfytech.com failures could only be inferred rather than read off a log.
    //
    // ERROR-level `userNotification` is the only combination that reports message
    // delivery, and CloudWatch Logs is its only permitted destination. It does not
    // require the Plus feature plan -- ESSENTIALS, which this pool is on, is enough.
    //
    // What it does and does not catch matters when reading it. Send-side failures land
    // here: the 50/day default-provider cap being exhausted, a suppressed recipient, a
    // hard bounce. A message AWS handed off successfully that a downstream gateway then
    // quarantined does NOT appear, because nothing failed from AWS's side. So silence
    // in this log during a reported failure is itself informative -- it points at the
    // recipient's mail path rather than at ours.
    //
    // Cognito requires the log group to be unencrypted and in this account. The
    // /aws/vendedlogs prefix keeps it clear of the 5120-character ceiling on log-group
    // resource policies that vended log delivery would otherwise run into.
    const userNotificationLogGroup = new logs.LogGroup(this, 'IepUserPoolNotificationLogs', {
      logGroupName: `/aws/vendedlogs/cognito/${getUniqueName('user-pool-notifications')}`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    new cognito.CfnLogDeliveryConfiguration(this, 'IepUserPoolLogDelivery', {
      userPoolId: userPool.userPoolId,
      logConfigurations: [{
        eventSource: 'userNotification',
        logLevel: 'ERROR',
        cloudWatchLogsConfiguration: {
          // This API takes the bare log-group ARN; CDK's logGroupArn appends a
          // trailing ':*' wildcard, so build it explicitly rather than reusing that.
          logGroupArn: cdk.Stack.of(this).formatArn({
            service: 'logs',
            resource: 'log-group',
            resourceName: userNotificationLogGroup.logGroupName,
            arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
          }),
        },
      }],
    });

    const userPoolClient = new cognito.UserPoolClient(this, 'IepUserPoolClient', {
      userPool,
      userPoolClientName: getUniqueName('user-pool-client'),
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      generateSecret: false, // Required for browser-side SDK
    });

    // Base-role groups for defence in depth and console legibility. The
    // DynamoDB Membership row is the source of truth for the base_role check;
    // group membership alone grants nothing.
    new cognito.CfnUserPoolGroup(this, 'MemberGroup', {
      userPoolId: userPool.userPoolId,
      groupName: 'MEMBER',
      description: 'Standard members — own their records only.',
      precedence: 10,
    });
    new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: userPool.userPoolId,
      groupName: 'ADMIN',
      description: 'Admin Portal base role. Tier is granted separately via AdminGrant.',
      precedence: 1,
    });

    // The handler lists pool users (grant UI) and syncs group membership.
    // Scoped to this user pool ARN — not a wildcard.
    apiHandler.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'cognito-idp:ListUsers',
        'cognito-idp:AdminAddUserToGroup',
        'cognito-idp:AdminRemoveUserFromGroup',
        'cognito-idp:AdminListGroupsForUser',
      ],
      resources: [userPool.userPoolArn],
    }));
    apiHandler.addEnvironment('USER_POOL_ID', userPool.userPoolId);

    // 7. API Gateway (REST API)
    const frontendDomain = process.env.FRONTEND_DOMAIN || '*';
    const api = new apigateway.RestApi(this, 'IepApi', {
      restApiName: getUniqueName('api'),
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Api-Key', 'X-Amz-Security-Token'],
      },
      deployOptions: {
        stageName: envName,
      },
    });

    // Cognito authorizer for all API routes
    const cognitoAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'IepAuthorizer', {
      cognitoUserPools: [userPool],
      authorizerName: getUniqueName('authorizer'),
    });

    const authMethodOptions: apigateway.MethodOptions = {
      authorizer: cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };

    // Use a single API Gateway invoke role rather than adding one Lambda
    // resource-policy statement per route. The latter has a fixed 20 KB limit
    // and becomes unreliable as the API grows.
    const apiInvokeRole = new iam.Role(this, 'ApiHandlerInvokeRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
    });
    apiHandler.grantInvoke(apiInvokeRole);
    const apiHandlerIntegration = new apigateway.Integration({
      type: apigateway.IntegrationType.AWS_PROXY,
      integrationHttpMethod: 'POST',
      uri: `arn:${cdk.Aws.PARTITION}:apigateway:${region}:lambda:path/2015-03-31/functions/${apiHandler.functionArn}/invocations`,
      options: {
        credentialsRole: apiInvokeRole,
      },
    });

    const interviewsSource = api.root.addResource('interviews');
    interviewsSource.addMethod('POST', apiHandlerIntegration, authMethodOptions);
    interviewsSource.addMethod('GET', apiHandlerIntegration, authMethodOptions);

    const singleInterview = interviewsSource.addResource('{id}', {
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Api-Key', 'X-Amz-Security-Token'],
      }
    });

    singleInterview.addMethod('GET', apiHandlerIntegration, authMethodOptions);
    singleInterview.addMethod('DELETE', apiHandlerIntegration, authMethodOptions);
    
    const uploadUrl = singleInterview.addResource('upload-url');
    uploadUrl.addMethod('POST', apiHandlerIntegration, authMethodOptions);

    const confirmUpload = singleInterview.addResource('confirm-upload');
    confirmUpload.addMethod('POST', apiHandlerIntegration, authMethodOptions);

    const analyze = singleInterview.addResource('analyze');
    analyze.addMethod('POST', apiHandlerIntegration, authMethodOptions);

    const questionGuide = singleInterview.addResource('question-guide');
    questionGuide.addMethod('POST', apiHandlerIntegration, authMethodOptions);

    const minfyJd = singleInterview.addResource('minfy-jd');
    minfyJd.addMethod('POST', apiHandlerIntegration, authMethodOptions);

    const result = singleInterview.addResource('result');
    result.addMethod('GET', apiHandlerIntegration, authMethodOptions);

    const report = singleInterview.addResource('report');
    report.addMethod('GET', apiHandlerIntegration, authMethodOptions);

    const intelligenceInterviews = api.root.addResource('intelligence-interviews');
    intelligenceInterviews.addMethod('GET', apiHandlerIntegration, authMethodOptions);
    intelligenceInterviews.addMethod('POST', apiHandlerIntegration, authMethodOptions);

    const keka = api.root.addResource('keka');
    const kekaJobs = keka.addResource('jobs');
    kekaJobs.addMethod('GET', apiHandlerIntegration, authMethodOptions);
    const kekaJob = kekaJobs.addResource('{jobId}');
    const kekaCandidates = kekaJob.addResource('candidates');
    kekaCandidates.addMethod('GET', apiHandlerIntegration, authMethodOptions);
    const kekaCandidate = kekaCandidates.addResource('{candidateId}');
    kekaCandidate.addResource('interviews').addMethod('GET', apiHandlerIntegration, authMethodOptions);

    const myInterviews = api.root.addResource('my-interviews');
    myInterviews.addMethod('GET', apiHandlerIntegration, authMethodOptions);
    myInterviews.addResource('refresh').addMethod('POST', apiHandlerIntegration, authMethodOptions);
    const myScheduledInterview = myInterviews.addResource('{schedId}');
    myScheduledInterview.addResource('open').addMethod('POST', apiHandlerIntegration, authMethodOptions);

    const singleIntelligenceInterview = intelligenceInterviews.addResource('{id}', {
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Api-Key', 'X-Amz-Security-Token'],
      }
    });
    singleIntelligenceInterview.addMethod('GET', apiHandlerIntegration, authMethodOptions);
    singleIntelligenceInterview.addMethod('DELETE', apiHandlerIntegration, authMethodOptions);
    singleIntelligenceInterview.addMethod('PATCH', apiHandlerIntegration, authMethodOptions);
    singleIntelligenceInterview.addResource('resume-upload-url').addMethod('POST', apiHandlerIntegration, authMethodOptions);
    singleIntelligenceInterview.addResource('confirm-resume').addMethod('POST', apiHandlerIntegration, authMethodOptions);
    singleIntelligenceInterview.addResource('generate-questions').addMethod('POST', apiHandlerIntegration, authMethodOptions);
    singleIntelligenceInterview.addResource('question-topics').addMethod('GET', apiHandlerIntegration, authMethodOptions);
    singleIntelligenceInterview.addResource('case-interview').addMethod('POST', apiHandlerIntegration, authMethodOptions);
    singleIntelligenceInterview.addResource('transcript').addMethod('POST', apiHandlerIntegration, authMethodOptions);
    singleIntelligenceInterview.addResource('sync-teams-transcript').addMethod('POST', apiHandlerIntegration, authMethodOptions);
    singleIntelligenceInterview.addResource('scores').addMethod('POST', apiHandlerIntegration, authMethodOptions);
    singleIntelligenceInterview.addResource('analyze').addMethod('POST', apiHandlerIntegration, authMethodOptions);
    singleIntelligenceInterview.addResource('approve').addMethod('POST', apiHandlerIntegration, authMethodOptions);
    singleIntelligenceInterview.addResource('report').addMethod('GET', apiHandlerIntegration, authMethodOptions);

    const integrations = api.root.addResource('integrations');
    integrations.addResource('status').addMethod('GET', apiHandlerIntegration, authMethodOptions);

    const minfyCareers = api.root.addResource('minfy-careers');
    const minfyCareerJobs = minfyCareers.addResource('jobs');
    minfyCareerJobs.addMethod('GET', apiHandlerIntegration, authMethodOptions);
    minfyCareerJobs.addResource('{jobId}').addMethod('GET', apiHandlerIntegration, authMethodOptions);

    const moms = api.root.addResource('moms');
    moms.addMethod('POST', apiHandlerIntegration, authMethodOptions);
    moms.addMethod('GET', apiHandlerIntegration, authMethodOptions);

    // AWS Cost Calculator. Same shape as the other apps: the collection takes
    // GET+POST, the item resource carries the CORS preflight block, and every
    // method goes through the Cognito authorizer.
    const calculator = api.root.addResource('calculator');
    calculator.addMethod('GET', apiHandlerIntegration, authMethodOptions);
    calculator.addMethod('POST', apiHandlerIntegration, authMethodOptions);
    // Presigned PUT for a resource spreadsheet. Static segment, declared before
    // {id} so it is matched as a literal and never captured as an id.
    calculator.addResource('review-catalog').addMethod('GET', apiHandlerIntegration, authMethodOptions);
    calculator.addResource('upload-url').addMethod('POST', apiHandlerIntegration, authMethodOptions);
    calculator.addResource('analyze').addMethod('POST', apiHandlerIntegration, authMethodOptions);

    const calculatorPlans = calculator.addResource('plans');
    const calculatorPlan = calculatorPlans.addResource('{id}');
    calculatorPlan.addMethod('GET', apiHandlerIntegration, authMethodOptions);
    calculatorPlan.addResource('proposals').addMethod('POST', apiHandlerIntegration, authMethodOptions);
    calculatorPlan.addResource('revisions').addMethod('POST', apiHandlerIntegration, authMethodOptions);
    calculatorPlan.addResource('confirm').addMethod('POST', apiHandlerIntegration, authMethodOptions);
    calculatorPlan.addResource('run').addMethod('POST', apiHandlerIntegration, authMethodOptions);

    const calculatorRuns = calculator.addResource('runs');
    calculatorRuns.addResource('{id}').addMethod('GET', apiHandlerIntegration, authMethodOptions);

    const singleCalculation = calculator.addResource('{id}', {
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Api-Key', 'X-Amz-Security-Token'],
      }
    });
    singleCalculation.addMethod('GET', apiHandlerIntegration, authMethodOptions);
    singleCalculation.addMethod('DELETE', apiHandlerIntegration, authMethodOptions);
    // Poll target — separate from the item route so the client can fetch just the
    // status and result without the prompt on every 3s tick.
    singleCalculation.addResource('result').addMethod('GET', apiHandlerIntegration, authMethodOptions);
    // Returns a presigned download URL for the client-facing PDF.
    singleCalculation.addResource('report').addMethod('GET', apiHandlerIntegration, authMethodOptions);
    // The same estimate as a TCO workbook, with live formulas instead of printed totals.
    singleCalculation.addResource('workbook').addMethod('GET', apiHandlerIntegration, authMethodOptions);
    // And as a Word document, which is the only one of the three that can carry a grid of
    // estimate links: OOXML has real hyperlink relationships, where a PDF has ink.
    singleCalculation.addResource('document').addMethod('GET', apiHandlerIntegration, authMethodOptions);
    // Apply a change the chat proposed. Deliberately on API Gateway behind the Cognito
    // authorizer rather than on the chat's Function URL: the conversation may only ever
    // propose, and the write path keeps the same gate as every other mutation.
    singleCalculation.addResource('revise').addMethod('POST', apiHandlerIntegration, authMethodOptions);

    // Estimate projects, mirroring mom-projects below: an estimate belongs to at most one
    // project and the calculator opens on the project list. A sibling of /calculator
    // rather than /calculator/projects, because that would collide with {id} at the
    // gateway and route the project list into getCalculation with id='projects'.
    const calculatorProjects = api.root.addResource('calculator-projects');
    calculatorProjects.addMethod('POST', apiHandlerIntegration, authMethodOptions);
    calculatorProjects.addMethod('GET', apiHandlerIntegration, authMethodOptions);

    const singleCalculatorProject = calculatorProjects.addResource('{id}', {
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Api-Key', 'X-Amz-Security-Token'],
      }
    });
    singleCalculatorProject.addMethod('GET', apiHandlerIntegration, authMethodOptions);
    singleCalculatorProject.addMethod('DELETE', apiHandlerIntegration, authMethodOptions);

    const momProjects = api.root.addResource('mom-projects');
    momProjects.addMethod('POST', apiHandlerIntegration, authMethodOptions);
    momProjects.addMethod('GET', apiHandlerIntegration, authMethodOptions);

    const singleMomProject = momProjects.addResource('{id}', {
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Api-Key', 'X-Amz-Security-Token'],
      }
    });
    singleMomProject.addMethod('GET', apiHandlerIntegration, authMethodOptions);
    singleMomProject.addMethod('DELETE', apiHandlerIntegration, authMethodOptions);

    const singleMom = moms.addResource('{id}', {
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Api-Key', 'X-Amz-Security-Token'],
      }
    });

    singleMom.addMethod('GET', apiHandlerIntegration, authMethodOptions);
    singleMom.addMethod('DELETE', apiHandlerIntegration, authMethodOptions);

    const momUploadUrl = singleMom.addResource('upload-url');
    momUploadUrl.addMethod('POST', apiHandlerIntegration, authMethodOptions);

    const momConfirmUpload = singleMom.addResource('confirm-upload');
    momConfirmUpload.addMethod('POST', apiHandlerIntegration, authMethodOptions);

    const momAnalyze = singleMom.addResource('analyze');
    momAnalyze.addMethod('POST', apiHandlerIntegration, authMethodOptions);

    const momResult = singleMom.addResource('result');
    momResult.addMethod('GET', apiHandlerIntegration, authMethodOptions);
    // Apply a chat-proposed edit to the stored minutes, then regenerate both documents.
    // POST, not PUT: this API is append-only by convention and an infrastructure test
    // asserts no PUT verb exists anywhere on it.
    singleMom.addResource('revise').addMethod('POST', apiHandlerIntegration, authMethodOptions);

    const momReport = singleMom.addResource('report');
    momReport.addMethod('GET', apiHandlerIntegration, authMethodOptions);

    // Hands the browser the chat Function URL at runtime. Serving it from here rather
    // than baking a NEXT_PUBLIC_* var in at build time avoids a deploy-then-rebuild
    // two-pass, since the URL does not exist until the stack that needs it is deployed.
    const chat = api.root.addResource('chat');
    chat.addResource('config').addMethod('GET', apiHandlerIntegration, authMethodOptions);
    // The caller's own thread for one artifact, so the drawer reopens on the conversation
    // it left off. GET on API Gateway rather than on the chat Function URL: only the
    // streaming turn needs to stream, and a history read belongs behind the same Cognito
    // authorizer as every other read. Owner-scoped by construction — it takes no user
    // parameter at all, see lambdas/api-handler/conversation-routes.ts.
    chat.addResource('history').addMethod('GET', apiHandlerIntegration, authMethodOptions);

    // --- NEW User Preference Routes ---
    const user = api.root.addResource('user');
    const preferences = user.addResource('preferences');
    preferences.addMethod('GET', apiHandlerIntegration, authMethodOptions);
    preferences.addMethod('POST', apiHandlerIntegration, authMethodOptions);

    // --- Admin Portal routes ---
    const me = api.root.addResource('me');
    me.addMethod('GET', apiHandlerIntegration, authMethodOptions);

    const admin = api.root.addResource('admin');
    admin.addResource('overview').addMethod('GET', apiHandlerIntegration, authMethodOptions);
    admin.addResource('search').addMethod('GET', apiHandlerIntegration, authMethodOptions);
    admin.addResource('interviews').addMethod('GET', apiHandlerIntegration, authMethodOptions);
    admin.addResource('moms').addMethod('GET', apiHandlerIntegration, authMethodOptions);
    // Org-wide cost estimates, VIEWER and above.
    admin.addResource('calculator').addMethod('GET', apiHandlerIntegration, authMethodOptions);
    admin.addResource('intelligence-interviews').addMethod('GET', apiHandlerIntegration, authMethodOptions);
    admin.addResource('candidates').addMethod('GET', apiHandlerIntegration, authMethodOptions);
    admin.addResource('audit-log').addMethod('GET', apiHandlerIntegration, authMethodOptions);
    // Context-chat oversight, REVIEWER and above. `thread` is a static segment and there
    // is deliberately no `{id}` sibling: a thread id is `{app}#{entityId}#{userId}` and a
    // `#` cannot travel in a URL path, so the three parts arrive as query parameters.
    const conversations = admin.addResource('conversations');
    conversations.addMethod('GET', apiHandlerIntegration, authMethodOptions);
    conversations.addResource('thread').addMethod('GET', apiHandlerIntegration, authMethodOptions);
    admin.addResource('approvals').addMethod('GET', apiHandlerIntegration, authMethodOptions);
    admin.addResource('cognito-users').addMethod('GET', apiHandlerIntegration, authMethodOptions);
    admin.addResource('keka-sync').addMethod('POST', apiHandlerIntegration, authMethodOptions);

    const adminQuestionBank = admin.addResource('question-bank');
    adminQuestionBank.addMethod('GET', apiHandlerIntegration, authMethodOptions);
    const adminQuestionBankRole = adminQuestionBank.addResource('{roleKey}');
    adminQuestionBankRole.addMethod('GET', apiHandlerIntegration, authMethodOptions);
    adminQuestionBankRole.addMethod('PATCH', apiHandlerIntegration, authMethodOptions);
    const adminQuestionBankQuestions = adminQuestionBankRole.addResource('questions');
    adminQuestionBankQuestions.addMethod('POST', apiHandlerIntegration, authMethodOptions);
    const adminQuestionBankQuestion = adminQuestionBankQuestions.addResource('{questionId}');
    adminQuestionBankQuestion.addMethod('PATCH', apiHandlerIntegration, authMethodOptions);
    adminQuestionBankQuestion.addMethod('DELETE', apiHandlerIntegration, authMethodOptions);

    const adminMembers = admin.addResource('members');
    adminMembers.addMethod('GET', apiHandlerIntegration, authMethodOptions);

    const adminMember = adminMembers.addResource('{userId}', {
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Api-Key', 'X-Amz-Security-Token'],
      },
    });
    adminMember.addResource('grants').addMethod('GET', apiHandlerIntegration, authMethodOptions);
    adminMember.addResource('tier').addMethod('POST', apiHandlerIntegration, authMethodOptions);
    adminMember.addResource('revoke').addMethod('POST', apiHandlerIntegration, authMethodOptions);
    adminMember.addResource('base-role').addMethod('POST', apiHandlerIntegration, authMethodOptions);

    // --- Candidate workspace / collaboration routes ---
    const workspaces = api.root.addResource('workspaces');
    workspaces.addMethod('POST', apiHandlerIntegration, authMethodOptions);
    workspaces.addMethod('GET', apiHandlerIntegration, authMethodOptions);
    workspaces.addResource('shared-with-me').addMethod('GET', apiHandlerIntegration, authMethodOptions);

    const workspace = workspaces.addResource('{id}', {
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Api-Key', 'X-Amz-Security-Token'],
      },
    });
    workspace.addMethod('GET', apiHandlerIntegration, authMethodOptions);
    workspace.addMethod('PATCH', apiHandlerIntegration, authMethodOptions);
    workspace.addMethod('DELETE', apiHandlerIntegration, authMethodOptions);
    workspace.addResource('full').addMethod('GET', apiHandlerIntegration, authMethodOptions);
    workspace.addResource('link').addMethod('POST', apiHandlerIntegration, authMethodOptions);
    workspace.addResource('unlink').addMethod('POST', apiHandlerIntegration, authMethodOptions);
    workspace.addResource('decision').addMethod('POST', apiHandlerIntegration, authMethodOptions);
    workspace.addResource('composite-analysis').addMethod('POST', apiHandlerIntegration, authMethodOptions);

    const shares = workspace.addResource('shares');
    shares.addMethod('POST', apiHandlerIntegration, authMethodOptions);
    shares.addResource('{userId}', {
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Api-Key', 'X-Amz-Security-Token'],
      },
    }).addMethod('DELETE', apiHandlerIntegration, authMethodOptions);

    const comments = workspace.addResource('comments');
    comments.addMethod('GET', apiHandlerIntegration, authMethodOptions);
    comments.addMethod('POST', apiHandlerIntegration, authMethodOptions);
    comments.addResource('{commentId}').addResource('resolve').addMethod('POST', apiHandlerIntegration, authMethodOptions);

    // Background Keka schedule sweep that populates My Interviews. Rate comes
    // from kekaSyncRateMinutes() so it matches the value handed to the Lambda.
    new events.Rule(this, 'KekaScheduleSyncRule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(kekaSyncRateMinutes())),
      targets: [new targets.LambdaFunction(apiHandler, {
        event: events.RuleTargetInput.fromObject({
          __internalTask: 'keka-schedule-sync',
          triggeredBy: 'eventbridge',
        }),
      })],
    });


    // Outputs
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
    new cdk.CfnOutput(this, 'BucketName', { value: filesBucket.bucketName });
    new cdk.CfnOutput(this, 'TableName', { value: interviewsTable.tableName });
    new cdk.CfnOutput(this, 'MomTableName', { value: momTable.tableName });
    new cdk.CfnOutput(this, 'InterviewIntelligenceTableName', { value: intelligenceTable.tableName });
    new cdk.CfnOutput(this, 'AdminTableName', { value: adminTable.tableName });
    new cdk.CfnOutput(this, 'CalculatorTableName', { value: calculatorTable.tableName });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });

    // 7. Frontend Hosting (S3 + CloudFront)
    const frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      bucketName: getUniqueName('web-hosting'),
      websiteIndexDocument: 'index.html',
      websiteErrorDocument: 'index.html',
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // CloudFront Function: rewrites /login → /login/index.html etc.
    // Without this, S3 returns 403 for paths like /login (no such object),
    // CloudFront's error response serves /index.html (dashboard), causing a loop.
    const spaRoutingFn = new cloudfront.Function(this, 'SpaRoutingFunction', {
      functionName: getUniqueName('spa-routing').replace(/-/g, '_'), // CF function names can't have hyphens in all regions
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.endsWith('/')) {
    request.uri += 'index.html';
  } else if (!uri.includes('.')) {
    request.uri += '/index.html';
  }
  return request;
}
`),
    });

    const distribution = new cloudfront.Distribution(this, 'IepDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(frontendBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [{
          function: spaRoutingFn,
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        }],
      },
      // Keep error responses as fallback for any edge cases
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
      ],
      comment: `Distribution for ${envName} Interview Platform`,
    });

    // 8. Context chat — a streaming Lambda Function URL.
    //
    // Declared here, after the distribution, because its CORS allowlist names the
    // CloudFront origin and nothing else. A Function URL cannot sit behind API Gateway's
    // Cognito authorizer, and API Gateway would buffer the whole answer anyway, which is
    // the one thing this feature cannot afford. So the handler verifies the Cognito ID
    // token itself (lambdas/chat/auth.ts) and re-checks record ownership per artifact.
    const chatFunction = new nodejs.NodejsFunction(this, 'ChatFunction', {
      functionName: getUniqueName('chat'),
      entry: path.join(__dirname, '../lambdas/chat/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      // Generous next to a chat turn's real cost, but the model streams: the user sees
      // the first token in well under a second regardless of where this sits.
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: {
        USER_POOL_ID: userPool.userPoolId,
        USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
        CHAT_TABLE_NAME: chatTable.tableName,
        CALCULATOR_TABLE_NAME: calculatorTable.tableName,
        MOM_TABLE_NAME: momTable.tableName,
        TABLE_NAME: interviewsTable.tableName,
        INTELLIGENCE_TABLE_NAME: intelligenceTable.tableName,
        BUCKET_NAME: filesBucket.bucketName,
        BEDROCK_SONNET_5_PROFILE_ARN: process.env.BEDROCK_SONNET_5_PROFILE_ARN || 'global.anthropic.claude-sonnet-5',
        CALCULATOR_FAST_MODEL_ID: process.env.CALCULATOR_FAST_MODEL_ID || 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
        CALCULATOR_REASONING_MODEL_ID: process.env.CALCULATOR_REASONING_MODEL_ID || 'global.anthropic.claude-sonnet-4-6',
        CALCULATOR_MODEL_ROUTING_MODE: process.env.CALCULATOR_MODEL_ROUTING_MODE || 'hybrid',
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });

    // Read-only on every artifact table: the chat proposes changes, it never writes one.
    // Applying a proposal goes through the API Gateway routes above, which keeps the
    // authorizer, the ownership gate and the revision history on the write path.
    chatTable.grantReadWriteData(chatFunction);
    calculatorTable.grantReadData(chatFunction);
    momTable.grantReadData(chatFunction);
    interviewsTable.grantReadData(chatFunction);
    intelligenceTable.grantReadData(chatFunction);
    filesBucket.grantRead(chatFunction);
    chatFunction.addToRolePolicy(bedrockPolicy);

    // ConverseStream maps to bedrock:InvokeModelWithResponseStream, which is a distinct
    // action from bedrock:InvokeModel in the shared policy above — without it every chat
    // turn fails with AccessDeniedException. Granted only here, because the chat is the
    // only caller that streams; the other three Lambdas use the buffered Converse API.
    chatFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModelWithResponseStream'],
      resources: ['*'],
    }));

    // RESPONSE_STREAM is the whole point: buffered, a 20-second answer arrives 20
    // seconds late as one block. AuthType NONE because Cognito ID tokens are not SigV4 —
    // the gate is verifyCaller() in the handler, which runs before Bedrock or DynamoDB
    // is touched. Origins are the CloudFront distribution plus an opt-in local origin,
    // never a wildcard.
    const chatAllowedOrigins = [
      `https://${distribution.distributionDomainName}`,
      ...(process.env.CHAT_DEV_ORIGIN ? [process.env.CHAT_DEV_ORIGIN] : []),
    ];
    const chatFunctionUrl = chatFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
      cors: {
        allowedOrigins: chatAllowedOrigins,
        allowedMethods: [lambda.HttpMethod.POST],
        allowedHeaders: ['Content-Type', 'Authorization'],
        maxAge: cdk.Duration.hours(1),
      },
    });

    // Handed to the browser at runtime by GET /chat/config. addEnvironment rather than
    // an entry in the environment block above, because the URL does not exist until the
    // function is declared, and the function is declared after the API handler.
    apiHandler.addEnvironment('CHAT_FUNCTION_URL', chatFunctionUrl.url);

    // The API handler reads threads back out for GET /chat/history and the two
    // /admin/conversations routes. The write is narrower than the grant can express: the
    // two apply routes set `applied_at` on one already-stored turn — the marker saying the
    // proposal in it was actually applied — under a condition that the turn exists, so a
    // wrong seq is a no-op rather than a new row. Turn authorship remains the chat
    // function's alone; nothing here writes content, and a route that could edit what was
    // said would make the transcript unciteable. Kept here beside the rest of the chat
    // wiring rather than up with the handler's other grants, so the whole feature's
    // plumbing reads in one place.
    chatTable.grantReadWriteData(apiHandler);
    apiHandler.addEnvironment('CHAT_TABLE_NAME', chatTable.tableName);

    new cdk.CfnOutput(this, 'ChatFunctionUrl', { value: chatFunctionUrl.url });
    new cdk.CfnOutput(this, 'ChatTableName', { value: chatTable.tableName });

    // 8. Frontend Deployment
    new s3deploy.BucketDeployment(this, 'DeployFrontend', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../../frontend/.next-build'))],
      destinationBucket: frontendBucket,
      distribution,
      distributionPaths: ['/*'], // Invalidate cache on deploy
      waitForDistributionInvalidation: false,
      // The exported frontend bundle is large enough that the 128 MiB provider
      // default can OOM while downloading and unpacking the deployment archive.
      memoryLimit: 1024,
      ephemeralStorageSize: cdk.Size.mebibytes(1024),
    });

    // Outputs
    new cdk.CfnOutput(this, 'FrontendUrl', { value: `https://${distribution.distributionDomainName}` });
  }
}
