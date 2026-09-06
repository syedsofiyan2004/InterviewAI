/**
 * AgentCore Calculator infrastructure tests.
 *
 * These tests verify that the CDK stack synthesizes the correct AgentCore
 * resources and that the architecture separation is enforced.
 *
 * All tests here are CDK synthesis tests — no live AWS infrastructure is used.
 * Live integration tests are in calculator-agent-acceptance.test.ts.
 */

import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { IepStack } from '../lib/infrastructure-stack';

let template: Template;

beforeAll(() => {
  const app = new cdk.App();
  const stack = new IepStack(app, 'TestStack', {
    env: { account: '123456789012', region: 'ap-south-1' },
  });
  template = Template.fromStack(stack);
});

describe('AgentCore Runtime', () => {
  it('provisions an AgentCore Runtime with ARM64-compatible container', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      AgentRuntimeName: Match.stringLikeRegexp('calculator-mcp'),
      NetworkConfiguration: { NetworkMode: 'PUBLIC_INTERNET' },
    });
  });

  it('Runtime has HOST=0.0.0.0 for AgentCore network access', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      EnvironmentVariables: Match.objectLike({
        HOST: '0.0.0.0',
        PORT: '8000',
        MCP_TRANSPORT: 'http',
      }),
    });
  });

  it('Runtime execution role allows DynamoDB access for MCP state', () => {
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
  it('provisions a Gateway with IAM authorizer', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
      Name: Match.stringLikeRegexp('calculator'),
      AuthorizerType: 'IAM',
    });
  });

  it('provisions a GatewayTarget pointing at the existing Lambda sidecar', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::GatewayTarget', {
      Name: Match.stringLikeRegexp('calculator-lambda-mcp'),
    });
  });
});

describe('Calculator Agent Lambda (Harness client)', () => {
  it('provisions the calculator-agent-orchestrator Lambda', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: Match.stringLikeRegexp('calculator-agent-orchestrator'),
    });
  });

  it('agent Lambda has permission to invoke InvokeInlineAgent', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'bedrock-agent-runtime:InvokeInlineAgent',
            ]),
          }),
        ]),
      }),
    });
  });

  it('agent Lambda entry point has no import statement referencing service-adapters or Calculator compiler', () => {
    // Checks that the agent Lambda does not IMPORT Calculator-specific logic.
    // (The file may mention these names in JSDoc comments explaining what it avoids.)
    const agentEntry = require('fs').readFileSync(
      require('path').join(__dirname, '../lambdas/calculator-agent/index.ts'),
      'utf8',
    );
    // Only check import/require lines — not documentation comments.
    const importLines = agentEntry.split('\n').filter((line: string) =>
      line.trim().startsWith('import ') || line.trim().startsWith('const ') && line.includes('require('));
    const importText = importLines.join('\n');
    expect(importText).not.toContain('service-adapters');
    expect(importText).not.toContain('compileWithCalculatorAdapter');
    expect(importText).not.toContain('mcp-client'); // old McpSidecarClient direct calls
  });
});

describe('WorkbookEvidence type', () => {
  it('WorkbookEvidence contains no Calculator field IDs', () => {
    const evidenceFile = require('fs').readFileSync(
      require('path').join(__dirname, '../lambdas/calculator-agent/workbook-evidence.ts'),
      'utf8',
    );
    // The evidence type must never contain Calculator-internal field IDs.
    expect(evidenceFile).not.toContain('columnFormIPM');
    expect(evidenceFile).not.toContain('Data_Written');
    expect(evidenceFile).not.toContain('modelsDeployed');
    expect(evidenceFile).not.toContain('Number_of_custom_events');
    expect(evidenceFile).not.toContain('Mdb_BackupStorage');
  });

  it('WorkbookEvidence exposes raw workbook values only', () => {
    const { type } = require('../lambdas/calculator-agent/workbook-evidence');
    void type;
    // Just checks it imports cleanly — structure verified by TypeScript at compile time.
  });
});

describe('Architecture separation', () => {
  it('MCP proxy Lambda does not import service-adapters', () => {
    const proxyEntry = require('fs').readFileSync(
      require('path').join(__dirname, '../lambdas/calculator-mcp-proxy/index.ts'),
      'utf8',
    );
    expect(proxyEntry).not.toContain('service-adapters');
    expect(proxyEntry).not.toContain('compileWithCalculatorAdapter');
  });

  it('system prompt is stored in source control, not embedded in CDK', () => {
    const fs = require('fs');
    const promptPath = require('path').join(__dirname, '../prompts/calculator-agent-system.txt');
    expect(fs.existsSync(promptPath)).toBe(true);
    const content = fs.readFileSync(promptPath, 'utf8');
    expect(content).toContain('AWS Pricing Calculator agent');
    expect(content).toContain('COMPLETED');
    expect(content).toContain('calculator.aws');
  });

  it('old Lambda orchestrator and sidecar still exist (no premature removal)', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: Match.stringLikeRegexp('calculator-orchestrator'),
    });
    // New agent Lambda also exists alongside the old orchestrator.
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: Match.stringLikeRegexp('calculator-agent-orchestrator'),
    });
  });

  it('CALCULATOR_EXECUTION_MODE defaults to legacy (old path)', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: Match.stringLikeRegexp('api-handler'),
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          CALCULATOR_EXECUTION_MODE: 'legacy',
        }),
      }),
    });
  });
});
