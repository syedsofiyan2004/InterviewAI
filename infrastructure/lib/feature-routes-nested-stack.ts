import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';

export interface FeatureRoutesNestedStackProps extends cdk.NestedStackProps {
  apiId: string;
  apiRootResourceId: string;
  handler: lambda.IFunction;
  authorizer: apigateway.IAuthorizer;
  region: string;
}

export type FeatureRouteSet = 'mom' | 'hire-rite';

/** Feature-owned API routes. The REST API itself stays in the parent stack. */
export class FeatureRoutesNestedStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props: FeatureRoutesNestedStackProps, feature: FeatureRouteSet) {
    super(scope, id, props);

    const api = apigateway.RestApi.fromRestApiAttributes(this, 'ExistingApi', {
      restApiId: props.apiId,
      rootResourceId: props.apiRootResourceId,
    });
    const invokeRole = new iam.Role(this, 'ApiHandlerInvokeRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
    });
    props.handler.grantInvoke(invokeRole);
    const integration = new apigateway.Integration({
      type: apigateway.IntegrationType.AWS_PROXY,
      integrationHttpMethod: 'POST',
      uri: `arn:${cdk.Aws.PARTITION}:apigateway:${props.region}:lambda:path/2015-03-31/functions/${props.handler.functionArn}/invocations`,
      options: { credentialsRole: invokeRole },
    });
    const methodOptions: apigateway.MethodOptions = {
      authorizer: props.authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };
    const add = (resource: apigateway.IResource, path: string, method: string) => {
      resource.addResource(path).addMethod(method, integration, methodOptions);
    };

    if (feature === 'mom') {
      const moms = api.root.addResource('moms');
      moms.addMethod('POST', integration, methodOptions);
      moms.addMethod('GET', integration, methodOptions);
      const singleMom = moms.addResource('{id}', { defaultCorsPreflightOptions: cors() });
      singleMom.addMethod('GET', integration, methodOptions);
      singleMom.addMethod('DELETE', integration, methodOptions);
      add(singleMom, 'upload-url', 'POST');
      add(singleMom, 'confirm-upload', 'POST');
      add(singleMom, 'analyze', 'POST');
      add(singleMom, 'result', 'GET');
      add(singleMom, 'revise', 'POST');
      add(singleMom, 'report', 'GET');

      const projects = api.root.addResource('mom-projects');
      projects.addMethod('POST', integration, methodOptions);
      projects.addMethod('GET', integration, methodOptions);
      const project = projects.addResource('{id}', { defaultCorsPreflightOptions: cors() });
      project.addMethod('GET', integration, methodOptions);
      project.addMethod('DELETE', integration, methodOptions);

    } else {
      const intelligence = api.root.addResource('intelligence-interviews');
      intelligence.addMethod('GET', integration, methodOptions);
      intelligence.addMethod('POST', integration, methodOptions);
      const single = intelligence.addResource('{id}', { defaultCorsPreflightOptions: cors() });
      single.addMethod('GET', integration, methodOptions);
      single.addMethod('DELETE', integration, methodOptions);
      single.addMethod('PATCH', integration, methodOptions);
      add(single, 'resume-upload-url', 'POST');
      add(single, 'confirm-resume', 'POST');
      add(single, 'resume', 'GET');
      add(single, 'generate-questions', 'POST');
      add(single, 'question-topics', 'GET');
      add(single, 'case-interview', 'POST');
      add(single, 'transcript', 'POST');
      add(single, 'sync-teams-transcript', 'POST');
      add(single, 'scores', 'POST');
      add(single, 'analyze', 'POST');
      add(single, 'approve', 'POST');
      add(single, 'keka-feedback', 'POST');
      add(single, 'report', 'GET');

      const keka = api.root.addResource('keka');
      const jobs = keka.addResource('jobs');
      jobs.addMethod('GET', integration, methodOptions);
      const job = jobs.addResource('{jobId}');
      const candidates = job.addResource('candidates');
      candidates.addMethod('GET', integration, methodOptions);
      const candidate = candidates.addResource('{candidateId}');
      add(candidate, 'interviews', 'GET');

      const myInterviews = api.root.addResource('my-interviews');
      myInterviews.addMethod('GET', integration, methodOptions);
      add(myInterviews, 'refresh', 'POST');
      add(myInterviews.addResource('{schedId}'), 'open', 'POST');

    }
  }
}

function cors(): apigateway.CorsOptions {
  return {
    allowOrigins: apigateway.Cors.ALL_ORIGINS,
    allowMethods: apigateway.Cors.ALL_METHODS,
    allowHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Api-Key', 'X-Amz-Security-Token'],
  };
}
