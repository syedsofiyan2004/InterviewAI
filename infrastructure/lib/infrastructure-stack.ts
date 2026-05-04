import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as path from 'path';

export class IepStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const envName = process.env.NODE_ENV || 'dev';
    const isProduction = envName === 'prod';
    const account = cdk.Stack.of(this).account;
    const region = cdk.Stack.of(this).region;

    const prefix = 'iep';

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

    const terraformRunnerRole = new iam.Role(this, 'TerraformRunnerRole', {
      roleName: getUniqueName('terraform-runner-role'),
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
    });

    const terraformRunner = new codebuild.Project(this, 'TerraformRunner', {
      projectName: getUniqueName('terraform-runner'),
      role: terraformRunnerRole,
      timeout: cdk.Duration.minutes(30),
      concurrentBuildLimit: 2,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
        privileged: false,
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            commands: [
              'set -euo pipefail',
              'yum install -y unzip >/dev/null',
              'curl -fsSL -o /tmp/terraform.zip https://releases.hashicorp.com/terraform/1.8.5/terraform_1.8.5_linux_amd64.zip',
              'unzip -o /tmp/terraform.zip -d /usr/local/bin >/dev/null',
              'terraform version',
            ],
          },
          pre_build: {
            commands: [
              'set -euo pipefail',
              'mkdir -p /tmp/tfwork',
              'aws s3 sync "s3://$TF_BUCKET/$TF_PREFIX" /tmp/tfwork --exclude "plan.txt" --exclude "apply.txt"',
              'cd /tmp/tfwork',
              'ls -la',
            ],
          },
          build: {
            commands: [
              'set -euo pipefail',
              'terraform fmt -check -recursive',
              'terraform init -input=false -backend-config="bucket=$TF_BUCKET" -backend-config="key=$TF_PREFIX/state/terraform.tfstate" -backend-config="region=$AWS_DEFAULT_REGION"',
              'terraform validate',
              'if [ "$TF_ACTION" = "PLAN" ]; then terraform plan -input=false -out=tfplan | tee plan.txt; aws s3 cp plan.txt "s3://$TF_BUCKET/$TF_PREFIX/plan.txt"; fi',
              'if [ "$TF_ACTION" = "APPLY" ]; then terraform plan -input=false -out=tfplan | tee plan.txt; terraform apply -input=false -auto-approve tfplan | tee apply.txt; aws s3 cp plan.txt "s3://$TF_BUCKET/$TF_PREFIX/plan.txt"; aws s3 cp apply.txt "s3://$TF_BUCKET/$TF_PREFIX/apply.txt"; fi',
            ],
          },
        },
      }),
    });

    // 4. API Handler Lambda
    const apiHandler = new nodejs.NodejsFunction(this, 'ApiHandler', {
      functionName: getUniqueName('api-handler'),
      entry: path.join(__dirname, '../lambdas/api-handler/index.ts'),
      handler: 'handler',

      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(60), // Increased for Bedrock alignment
      memorySize: 512,                  // Increased to prevent OOM/Initialization lag
      environment: {
        TABLE_NAME: interviewsTable.tableName,
        BUCKET_NAME: filesBucket.bucketName,
        QUEUE_URL: evaluationQueue.queueUrl,
        MOM_TABLE_NAME: momTable.tableName,
        MOM_QUEUE_URL: momQueue.queueUrl,
        TERRAFORM_RUNNER_PROJECT_NAME: terraformRunner.projectName,
        // Standardized Model Sync (Sonnet 3.7 + Nova)
        BEDROCK_SONNET_PROFILE_ARN: 'arn:aws:bedrock:ap-south-1::inference-profile/apac.anthropic.claude-3-7-sonnet-20250219-v1:0',
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
    filesBucket.grantReadWrite(apiHandler);
    filesBucket.grantDelete(apiHandler);
    evaluationQueue.grantSendMessages(apiHandler);
    momQueue.grantSendMessages(apiHandler);
    apiHandler.addToRolePolicy(new iam.PolicyStatement({
      actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'],
      resources: [terraformRunner.projectArn],
    }));
    
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
    filesBucket.grantReadWrite(terraformRunner);
    terraformRunner.addToRolePolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [
        'arn:aws:iam::*:role/TerraformDeployRole',
        'arn:aws:iam::*:role/MinfyTerraformDeployRole',
      ],
    }));

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
        // Standardized Worker Sync (Sonnet 3.7 + Nova)
        BEDROCK_SONNET_PROFILE_ARN: 'arn:aws:bedrock:ap-south-1::inference-profile/apac.anthropic.claude-3-7-sonnet-20250219-v1:0',
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
        MOM_MODEL_ID: process.env.MOM_MODEL_ID || 'global.anthropic.claude-sonnet-4-6',
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

    const apiHandlerIntegration = new apigateway.LambdaIntegration(apiHandler, {
      allowTestInvoke: false,
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

    const result = singleInterview.addResource('result');
    result.addMethod('GET', apiHandlerIntegration, authMethodOptions);

    const report = singleInterview.addResource('report');
    report.addMethod('GET', apiHandlerIntegration, authMethodOptions);

    const moms = api.root.addResource('moms');
    moms.addMethod('POST', apiHandlerIntegration, authMethodOptions);
    moms.addMethod('GET', apiHandlerIntegration, authMethodOptions);

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

    const tfJobs = api.root.addResource('tf-jobs');
    tfJobs.addMethod('POST', apiHandlerIntegration, authMethodOptions);

    const singleTfJob = tfJobs.addResource('{id}', {
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Api-Key', 'X-Amz-Security-Token'],
      }
    });
    singleTfJob.addMethod('GET', apiHandlerIntegration, authMethodOptions);

    const tfPlan = singleTfJob.addResource('plan');
    tfPlan.addMethod('POST', apiHandlerIntegration, authMethodOptions);

    const tfApprove = singleTfJob.addResource('approve');
    tfApprove.addMethod('POST', apiHandlerIntegration, authMethodOptions);

    const tfApply = singleTfJob.addResource('apply');
    tfApply.addMethod('POST', apiHandlerIntegration, authMethodOptions);

    // --- NEW User Preference Routes ---
    const user = api.root.addResource('user');
    const preferences = user.addResource('preferences');
    preferences.addMethod('GET', apiHandlerIntegration, authMethodOptions);
    preferences.addMethod('POST', apiHandlerIntegration, authMethodOptions);


    // Outputs
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
    new cdk.CfnOutput(this, 'BucketName', { value: filesBucket.bucketName });
    new cdk.CfnOutput(this, 'TableName', { value: interviewsTable.tableName });
    new cdk.CfnOutput(this, 'MomTableName', { value: momTable.tableName });
    new cdk.CfnOutput(this, 'TerraformRunnerRoleArn', { value: terraformRunnerRole.roleArn });
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
      sources: [s3deploy.Source.asset(path.join(__dirname, '../../frontend/out'))],
      destinationBucket: frontendBucket,
      distribution,
      distributionPaths: ['/*'], // Invalidate cache on deploy
      waitForDistributionInvalidation: false,
    });

    // Outputs
    new cdk.CfnOutput(this, 'FrontendUrl', { value: `https://${distribution.distributionDomainName}` });
  }
}
