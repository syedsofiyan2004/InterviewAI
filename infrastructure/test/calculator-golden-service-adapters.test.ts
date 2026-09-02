import { compileWithCalculatorAdapter } from '../lambdas/calculator-orchestrator/service-adapters';
import type { ResourceGroup } from '../lambdas/calculator-orchestrator/prompt';

function group(overrides: Partial<ResourceGroup>): ResourceGroup {
  return {
    service: 'Unknown', hoursPerDay: 24, count: 1, rows: 1, diskGb: 0,
    names: [], members: [0], reportedMonthly: 0, ...overrides,
  };
}

const compile = (value: ResourceGroup) => compileWithCalculatorAdapter(value, { defaultRegion: 'ap-south-1' });

describe('golden-workbook Calculator adapters', () => {
  test('Cognito uses the confirmed tier-specific MAU field', () => {
    const plan = compile(group({
      service: 'Amazon Cognito',
      quantities: [{ unit: 'units/month', amount: 50_000, basis: 'monthly active users (MAU)', conversions: [] }],
      details: ['Cognito MAU | cognito.tier: {"tier":"Essentials","monthlyTokenRequests":1000000}'],
    }));
    expect(plan?.calculatorKey).toBe('amazonCognito');
    expect(plan?.calculatorConfig).toMatchObject({
      cognito_NumberOfMAUs_Essential: '50000', cognitoEssentials_userTokenRequests: '1000000',
    });
    expect(plan?.calculatorConfig).not.toHaveProperty('cognito_NumberOfMAUs');
  });

  test('Cognito Lite uses the current export-compatible MAU field', () => {
    const plan = compile(group({
      service: 'Amazon Cognito',
      quantities: [{ unit: 'units/month', amount: 50_000, basis: 'monthly active users (MAU)', conversions: [] }],
      details: ['cognito.tier: {"tier":"Lite","monthlyTokenRequests":10000}'],
    }));
    expect(plan?.calculatorConfig).toMatchObject({
      cognito_NumberOfMAUs_Essential: '50000', cognito_NumberOfTokenRequests: '10000',
    });
    expect(plan?.calculatorConfig).not.toHaveProperty('cognito_NumberOfMAUs');
  });

  test('S3 reads a generic size label when no canonical storage meter was emitted', () => {
    const plan = compile(group({ service: 'Amazon S3', size: '200 GB Standard' }));
    expect(plan?.calculatorKey).toBe('amazonS3Standard');
    expect(plan?.calculatorConfig?.s3StandardStorageSize).toEqual({ value: 200, unit: 'gb|month' });
  });

  test('SageMaker preserves the canonical endpoint count and confirmed ml instance class', () => {
    const plan = compile(group({
      service: 'Amazon SageMaker', count: 4, names: ['vision model', 'reasoning model'],
      details: ['sagemaker.inference_configuration: {"workloadType":"real-time inference","instanceType":"ml.g5.xlarge"}'],
    }));
    expect(plan?.calculatorKey).toBe('sageMakerRealTimeInference');
    expect(plan?.calculatorConfig).toMatchObject({
      modelsDeployed: '2', modelsPerEndPoint: '1', instancesPerEndPoint: '2',
      columnFormIPM: { value: [{ 'Instance Name': { value: 'ml.g5.xlarge' } }] },
    });
  });

  test('Bedrock turns monthly calls into an equivalent request rate without changing per-call tokens', () => {
    const plan = compile(group({
      service: 'Amazon Bedrock',
      quantities: [{ unit: 'requests/month', amount: 43_200, basis: 'Bedrock model calls', conversions: [] }],
      details: [
        'bedrock.model: Anthropic: Claude Sonnet 4',
        'bedrock.tokens_per_call: {"inputTokens":2000,"outputTokens":500}',
      ],
    }));
    expect(plan?.calculatorKey).toBe('anthropic');
    expect(plan?.calculatorConfig).toMatchObject({
      modelSelection: 'Anthropic: Claude Sonnet 4',
      selectedModel: 'Anthropic: Claude Sonnet 4',
      selectedModel_od: 'Anthropic: Claude Sonnet 4',
      avgRequestsPerMin: '1', hoursPerDayAtThisRate: '24',
      avgInputTokensPerRequest: '2000', avgOutputTokensPerRequest: '500',
    });
  });

  test('Bedrock treats explicitly labelled interactions as model calls', () => {
    const plan = compile(group({
      service: 'Amazon Bedrock',
      quantities: [{ unit: 'units/month', amount: 2_500, basis: 'Bedrock chat interactions', conversions: [] }],
      details: [
        'bedrock.model: Anthropic: Claude Sonnet 4',
        'bedrock.tokens_per_call: {"inputTokens":2000,"outputTokens":500}',
      ],
    }));
    expect(plan?.calculatorKey).toBe('anthropic');
    expect(plan?.calculatorConfig).toBeTruthy();
  });

  test('Lambda aggregate usage compiles to integer duration with a deterministic memory equivalent', () => {
    const plan = compile(group({
      service: 'AWS Lambda',
      quantities: [
        { unit: 'invocations/month', amount: 1_258_624.58, basis: 'invocations', conversions: [] },
        { unit: 'GB-seconds/month', amount: 3_974.94, basis: 'compute', conversions: [] },
      ],
    }));
    expect(plan?.calculatorKey).toBe('aWSLambda');
    expect(plan?.calculatorConfig?.numberOfRequests).toEqual({ value: '1258625', unit: 'perMonth' });
    expect(String(plan?.calculatorConfig?.durationOfEachRequest)).toMatch(/^\d+$/);
    expect(plan?.calculatorConfig?.sizeOfMemoryAllocated).toMatchObject({ unit: 'mb|NA' });
    expect(plan?.basis).toContain('rounded from 1258624.58 to 1258625');
  });

  test('legacy NAT explicitly zeroes the unused Regional NAT field set', () => {
    const plan = compile(group({
      service: 'Amazon VPC NAT Gateway', count: 2,
      quantities: [{ unit: 'GB-transfer/month', amount: 100, basis: 'NAT data', conversions: [] }],
      details: ['nat_gateway.configuration: {"mode":"Regional NAT Gateway","availabilityZoneCount":2}'],
    }));
    expect(plan?.calculatorConfig).toMatchObject({
      numberOfGateways: '0', regionalNatGatewayCount: '2', regionalNatGatewayAzCount: '2',
      regionalNatGatewayDataProcessed: { value: 50, unit: 'gb|month' },
    });
  });

  test.each([
    ['ALB external', 'applicationLoadBalancer', 'numberOfApplicationLoadBalancers'],
    ['Internal Network Load Balancer', 'networkLoadBalancer', 'numberOfNetworkLoadBalancers'],
  ])('load balancer %s requires and compiles a confirmed traffic profile', (size, key, countField) => {
    const plan = compile(group({
      service: 'Elastic Load Balancing', size, count: 3,
      details: ['load_balancer.capacity_profile: {"processedGbPerHour":5,"protocol":"TCP"}'],
    }));
    expect(plan?.calculatorKey).toBe(key);
    expect(plan?.calculatorConfig?.[countField]).toBe('3');
  });

  test('WAF compiles only confirmed ACL, rule and request dimensions', () => {
    const plan = compile(group({
      service: 'AWS WAF',
      details: ['waf.traffic_profile: {"webAclCount":2,"rulesPerAcl":8,"monthlyWebRequestsMillions":12.5}'],
    }));
    expect(plan?.calculatorKey).toBe('awsWebApplicationFirewall');
    expect(plan?.calculatorConfig).toMatchObject({
      numberOfWebAcls: { value: '2', unit: 'perMonth' },
      numberOfRulesPerWebAcl: { value: '8', unit: 'perMonth' },
      numberOfWebRequests: { value: '12.5', unit: 'perMonth' },
    });
  });

  test('QuickSight keeps author and reader meters separate and requires a confirmed profile', () => {
    const plan = compile(group({
      service: 'Amazon QuickSight',
      quantities: [
        { unit: 'units/month', amount: 5, basis: 'QuickSight authors', conversions: [] },
        { unit: 'units/month', amount: 20, basis: 'QuickSight readers', conversions: [] },
      ],
      details: ['quicksight.subscription_profile: {"annualAuthorPercent":100,"monthlyAuthorPercent":0,"spiceGb":10}'],
    }));
    expect(plan?.calculatorKey).toBe('amazonQuickSightReadersAuthorsSpice');
    expect(plan?.calculatorConfig).toMatchObject({
      numberOfAuthors: '5', numberOfReaders: '20', percentAnnualAuthors: 100,
      percentMonthlyAuthors: 0, spiceGBs: '10',
    });
    expect(plan?.calculatorConfig).not.toHaveProperty('percentActiveReaders');
  });
});
