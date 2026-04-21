import * as cdk from 'aws-cdk-lib';
import * as dotenv from 'dotenv';
import { IepStack } from '../lib/infrastructure-stack';

dotenv.config();

const app = new cdk.App();
const envName = process.env.NODE_ENV || 'dev';

new IepStack(app, `IepStack-${envName}`, {
  env: { 
    account: process.env.CDK_DEFAULT_ACCOUNT, 
    region: process.env.CDK_DEFAULT_REGION || 'ap-south-1' 
  },
});


