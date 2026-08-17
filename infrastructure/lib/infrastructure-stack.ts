import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
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
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as path from 'path';

/**
 * How often the Keka schedule sweep runs. An operator lever rather than a
 * constant: KEKA_SYNC_STATUS_MODE=all walks every candidate of every job, which
 * must sweep far less often than the status-filtered default. Clamped so a
 * mistyped value cannot become rate(0) or a rate EventBridge will not accept,
 * and shared by the rule and the Lambda env so the two cannot drift.
 */
export function kekaSyncRateHours(env: NodeJS.ProcessEnv = process.env): number {
  return Math.min(24, Math.max(1, Number(env.KEKA_SYNC_RATE_HOURS) || 6));
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
        BEDROCK_SONNET_5_PROFILE_ARN: process.env.BEDROCK_SONNET_5_PROFILE_ARN || 'global.anthropic.claude-sonnet-5',
        PLATFORM_VERSION: `v1.0.0-calculator-${Date.now()}`,
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });

    calculatorTable.grantReadWriteData(calculatorOrchestrator);
    calculatorSidecar.grantInvoke(calculatorOrchestrator);
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
    calculatorOrchestrator.grantInvoke(apiHandler);

    // 6. Cognito User Pool (self sign-up enabled, email-based)
    const userPool = new cognito.UserPool(this, 'IepUserPool', {
      userPoolName: getUniqueName('user-pool'),
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
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
    calculator.addResource('upload-url').addMethod('POST', apiHandlerIntegration, authMethodOptions);

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

    const momReport = singleMom.addResource('report');
    momReport.addMethod('GET', apiHandlerIntegration, authMethodOptions);

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
    // from kekaSyncRateHours() so it matches the value handed to the Lambda.
    new events.Rule(this, 'KekaScheduleSyncRule', {
      schedule: events.Schedule.rate(cdk.Duration.hours(kekaSyncRateHours())),
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

    // 8. Frontend Deployment
    new s3deploy.BucketDeployment(this, 'DeployFrontend', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../../frontend/.next-build'))],
      destinationBucket: frontendBucket,
      distribution,
      distributionPaths: ['/*'], // Invalidate cache on deploy
      waitForDistributionInvalidation: false,
    });

    // Outputs
    new cdk.CfnOutput(this, 'FrontendUrl', { value: `https://${distribution.distributionDomainName}` });
  }
}
