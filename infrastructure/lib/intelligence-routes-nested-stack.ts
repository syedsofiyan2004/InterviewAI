import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';

export interface IntelligenceRoutesNestedStackProps extends cdk.NestedStackProps {
  apiId: string;
  apiRootResourceId: string;
  parentResourceId: string;
  parentPath: string;
  handler: lambda.IFunction;
  authorizer: apigateway.IAuthorizer;
  region: string;
}

/**
 * Keeps legacy normal-evaluation child routes out of the parent template. The
 * existing REST API and its /interviews/{id} parent resource remain in place,
 * so this is a template-size change rather than an API replacement.
 */
export class IntelligenceRoutesNestedStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props: IntelligenceRoutesNestedStackProps) {
    super(scope, id, props);

    const api = apigateway.RestApi.fromRestApiAttributes(this, 'ExistingApi', {
      restApiId: props.apiId,
      rootResourceId: props.apiRootResourceId,
    });
    const parent = apigateway.Resource.fromResourceAttributes(this, 'ExistingParent', {
      restApi: api,
      resourceId: props.parentResourceId,
      path: props.parentPath,
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

    for (const [pathPart, method] of [
      ['upload-url', 'POST'],
      ['confirm-upload', 'POST'],
      ['question-guide', 'POST'],
      ['minfy-jd', 'POST'],
    ] as const) {
      parent.addResource(pathPart).addMethod(method, integration, methodOptions);
    }
  }
}
