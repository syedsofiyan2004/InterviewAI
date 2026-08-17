# Minfy AI Deployment Handoff

This package does not require sharing AWS access keys or secret keys.

## What CDK creates

The CDK stack creates the application infrastructure in the deploying AWS account:

- S3 buckets for frontend hosting and application files
- CloudFront distribution for the website
- API Gateway
- Lambda functions
- DynamoDB tables
- Cognito user pool and app client
- SQS queues
- IAM roles and permissions used by the application

## Required AWS access

The person deploying must authenticate from their own machine or CI/CD environment using one of:

- AWS SSO / IAM Identity Center
- An existing AWS CLI profile
- A company CI/CD role using OIDC
- Temporary credentials managed by the company

Do not hardcode AWS keys in the code.

## First deployment flow

1. Unzip the code.
2. Install dependencies:

```bash
cd frontend
npm install

cd ../infrastructure
npm install
```

3. Authenticate to the target AWS account:

```bash
aws sts get-caller-identity
```

4. Set the required Bedrock/model environment values in `infrastructure/.env`.
   Use `infrastructure/.env.example` as the template.

5. Bootstrap and deploy the AWS infrastructure:

```bash
cd infrastructure
npx cdk bootstrap
npx cdk deploy --all --require-approval never
```

6. Copy the CDK output values:

- `ApiUrl`
- `UserPoolId`
- `UserPoolClientId`
- AWS region

7. Create `frontend/.env.local`:

```env
NEXT_PUBLIC_API_BASE_URL=<ApiUrl without trailing slash if preferred>
NEXT_PUBLIC_COGNITO_USER_POOL_ID=<UserPoolId>
NEXT_PUBLIC_COGNITO_CLIENT_ID=<UserPoolClientId>
NEXT_PUBLIC_AWS_REGION=<AWS region>
```

8. Build the frontend:

```bash
cd ../frontend
npm run build
```

9. Deploy again so CDK uploads the newly built frontend to S3/CloudFront:

```bash
cd ../infrastructure
npx cdk deploy --all --require-approval never
```

## Notes

- The frontend is a static export, so API and Cognito public values are embedded at build time.
- If API Gateway or Cognito changes, rebuild the frontend and deploy again.
- Generated files such as `.env`, `.env.local`, `outputs.json`, `node_modules`, `.next`, `out`, and `cdk.out` should not be shared as source handoff files.
