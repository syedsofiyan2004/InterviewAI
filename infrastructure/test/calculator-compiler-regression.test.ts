import fs from 'fs';
import path from 'path';

import { analyseWorkbook } from '../lambdas/api-handler/calculator-workbook';
import { groupResources } from '../lambdas/calculator-orchestrator/prompt';
import { materializePlanResources, planFromGroup } from '../lambdas/calculator-orchestrator/pipeline';
import { buildInitialPlan } from '../lambdas/shared/estimate-planning';

const fixture = (name: string) => path.resolve(__dirname, '..', '..', 'docs', name);

const digitalAssetsRevision = {
  requirements: [
    { scope: ['service:SageMaker'], field: 'sagemaker.inference_configuration', expected: { workloadType: 'real-time inference', instanceType: 'ml.g5.xlarge' } },
    { scope: ['service:Lambda'], field: 'lambda.execution_profile', expected: { memoryMb: 128, durationMs: 25 } },
    { scope: ['service:Bedrock'], field: 'bedrock.model', expected: 'Anthropic: Claude Sonnet 4' },
    { scope: ['service:Bedrock'], field: 'bedrock.tokens_per_call', expected: { inputTokens: 2000, outputTokens: 500 } },
    { scope: ['service:Cognito'], field: 'cognito.tier', expected: { tier: 'Essentials', monthlyTokenRequests: 1_000_000 } },
    { scope: ['service:SNS'], field: 'sns.delivery_type', expected: 'Mobile push' },
    { scope: ['service:NAT Gateway'], field: 'nat_gateway.configuration', expected: { mode: 'Regional NAT Gateway', availabilityZoneCount: 1 } },
    { scope: ['service:Aurora'], field: 'database.engine', expected: 'Aurora PostgreSQL' },
    { scope: ['service:QuickSight'], field: 'quicksight.subscription_profile', expected: { annualAuthorPercent: 100, monthlyAuthorPercent: 0, spiceGb: 10 } },
  ],
} as any;

describe('generic compiler regression workbooks', () => {
  test('service-owned Digital Assets storage never compiles as EC2 EBS', async () => {
    const analysis = await analyseWorkbook(fs.readFileSync(fixture('Digital_Assets.xlsx')), 'arbitrary-name.xlsx');
    const firstScenario = analysis.insights.bands?.[0]?.key;
    const rows = analysis.resources.filter((row) => !firstScenario || row.scenario === firstScenario);
    const groups = groupResources(rows, new Map(), 'baseline');
    for (const service of ['Amazon S3', 'Amazon Aurora', 'Amazon OpenSearch Service', 'Amazon Redshift']) {
      const plans = groups.filter((group) => group.service === service)
        .map((group) => planFromGroup(group, 'ap-south-1')).filter(Boolean);
      expect(plans.some((plan) => plan?.storageOwner === 'service-native')).toBe(true);
    }
    for (const service of ['Amazon S3', 'Amazon OpenSearch Service', 'Amazon Redshift']) {
      expect(groups.filter((group) => group.service === service)
        .map((group) => planFromGroup(group, 'ap-south-1'))
        .some((plan) => Boolean(plan?.calculatorKey))).toBe(true);
    }
    expect(groups.filter((group) => group.service === 'Amazon Aurora')
      .map((group) => planFromGroup(group, 'ap-south-1'))
      .some((plan) => /explicit.*engine/i.test(plan?.calculatorUnsupported || ''))).toBe(true);
    expect(groups.map((group) => planFromGroup(group, 'ap-south-1')).filter(Boolean).some((plan) => (
      plan?.serviceCode === 'AmazonEC2' && plan.storageOwner === 'ec2-ebs'
    ))).toBe(false);
  }, 30_000);

  test('confirmed Digital Assets inputs compile every first-period group without omission', async () => {
    const analysis = await analyseWorkbook(fs.readFileSync(fixture('Digital_Assets.xlsx')), 'renamed-input.xlsx');
    const resources = materializePlanResources(analysis.resources, digitalAssetsRevision);
    const firstScenario = analysis.insights.bands?.[0]?.key;
    const groups = groupResources(resources.filter((row) => row.scenario === firstScenario), new Map(), 'baseline');
    const plans = groups.map((group) => ({ group, plan: planFromGroup(group, 'ap-south-1') }));
    expect(plans.filter(({ plan }) => !plan?.calculatorKey || !plan?.calculatorConfig)).toEqual([]);
    expect(plans.map(({ plan }) => plan?.calculatorKey)).toEqual(expect.arrayContaining([
      'awsFargate', 'amazonRedshift', 'sageMakerRealTimeInference',
      'amazonRDSAuroraPostgreSQLCompatibleDB', 'amazonS3Standard', 'aWSLambda',
      'anthropic', 'amazonElasticsearchService', 'amazonElastiCache',
    ]));
    const fargate = plans.find(({ group }) => group.service === 'AWS Fargate');
    expect(fargate?.group.quantities).toEqual(expect.arrayContaining([
      expect.objectContaining({ unit: 'vCPU-hours/month', amount: 7_300 }),
      expect.objectContaining({ unit: 'GB-hours/month', amount: 14_600 }),
    ]));
    expect(fargate?.plan?.calculatorConfig).toMatchObject({
      numberOfTasks: { value: '10', unit: 'perMonth' },
      taskDuration: { value: '730', unit: 'hr' },
      memoryStandardFargateOnDemand: { value: 2, unit: 'gb|NA' },
      storageAmountECS: { value: 20, unit: 'gb|NA' },
    });
    const s3 = plans.find(({ group }) => group.service === 'Amazon S3');
    expect(s3?.plan?.calculatorConfig).toMatchObject({
      s3StandardPutRequests: 10_600,
      s3StandardGetRequests: 52_999,
    });
    const quickSight = plans.find(({ group }) => group.service === 'Amazon QuickSight');
    expect(quickSight?.plan?.calculatorConfig).toMatchObject({
      numberOfAuthors: '5', numberOfReaders: '20',
      percentAnnualAuthors: 100, percentMonthlyAuthors: 0, spiceGBs: '10',
    });
  }, 30_000);

  test('confirmed inputs compile every nonzero group in every Digital Assets scenario', async () => {
    const analysis = await analyseWorkbook(fs.readFileSync(fixture('Digital_Assets.xlsx')), 'another-customer-input.xlsx');
    const resources = materializePlanResources(analysis.resources, digitalAssetsRevision);
    const failures = (analysis.insights.bands || []).flatMap((band) => (
      groupResources(resources.filter((row) => row.scenario === band.key), new Map(), 'baseline')
        .map((group) => ({ group, plan: planFromGroup(group, 'ap-south-1') }))
        .filter(({ plan }) => !plan?.calculatorKey || !plan?.calculatorConfig)
        .map(({ group, plan }) => ({
          scenario: band.label,
          service: group.service,
          names: group.names,
          count: group.count,
          size: group.size,
          quantities: group.quantities,
          details: group.details,
          reason: plan?.calculatorUnsupported || 'No matching Calculator adapter',
        }))
    ));
    expect(analysis.insights.bands?.length).toBeGreaterThan(1);
    expect(failures).toEqual([]);
  }, 30_000);

  test('the same parsers recognise Core BOM by content under an arbitrary filename', async () => {
    const analysis = await analyseWorkbook(fs.readFileSync(fixture('Core BOM.xlsx')), 'customer-input.xlsx');
    const services = new Set(analysis.resources.map((row) => row.service).filter(Boolean));
    expect([...services]).toEqual(expect.arrayContaining(['Amazon EC2', 'Amazon RDS', 'Amazon S3', 'AWS WAF']));
    expect(analysis.resources.find((row) => row.service === 'Amazon S3')).toMatchObject({ disk_gb: 200 });
    expect(analysis.resources.filter((row) => row.service === 'AWS WAF'))
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'WAF', raw: 'WAF | Required' })]));

    const groups = groupResources(analysis.resources, new Map(), 'baseline');
    expect(groups.filter((group) => group.service === 'Elastic Load Balancing' && !group.size)).toHaveLength(0);
    expect(groups.find((group) => /network load balancer/i.test(group.size || ''))?.count).toBe(4);
    expect(groups.filter((group) => group.service === 'Amazon OpenSearch Service')
      .map((group) => planFromGroup(group, 'ap-south-1'))
      .every((plan) => plan?.calculatorKey === 'amazonElasticsearchService')).toBe(true);
    expect(groups.filter((group) => group.service === 'Amazon MQ')
      .map((group) => planFromGroup(group, 'ap-south-1'))
      .every((plan) => plan?.calculatorKey === 'amazonMQ')).toBe(true);
    expect(groups.filter((group) => group.service === 'Amazon MemoryDB')
      .map((group) => planFromGroup(group, 'ap-south-1'))
      .some((plan) => /data written/i.test(plan?.calculatorUnsupported || ''))).toBe(true);

    const plan = buildInitialPlan({ workbookId: 'fixture', resources: analysis.resources, defaultRegion: 'ap-south-1' });
    expect(plan.unresolved.map((question) => question.field)).toEqual(expect.arrayContaining([
      'resource.instance_type',
      'load_balancer.capacity_profile',
      'waf.traffic_profile',
      'memorydb.data_profile',
    ]));
    expect(analysis.resources.every((row) => row.sheet && row.raw)).toBe(true);
  }, 30_000);
});
