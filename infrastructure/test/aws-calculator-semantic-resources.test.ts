/**
 * The seam from pipeline resource groups to the executor's semantic resources. The property
 * under test is preservation: whatever the group says, in the units and periods it says it,
 * arrives on the semantic resource unchanged, and no Calculator field name ever appears.
 */

import {
  configurationOf,
  intentFromCommitment,
  intentFromRequest,
  parseSheetCommitment,
  toSemanticResources,
} from '../lambdas/aws-calculator-mcp-executor/semantic-resources';
import type { ResourceGroup } from '../lambdas/calculator-orchestrator/prompt';

const group = (overrides: Partial<ResourceGroup>): ResourceGroup => ({
  service: 'Amazon EC2', hoursPerDay: 24, count: 1, rows: 1, diskGb: 0, names: [], members: [0], reportedMonthly: 0, ...overrides,
});

describe('a Fargate group with canonical task semantics', () => {
  it('keeps a per-day task count per day and a duration in the hours the sheet stated', () => {
    const config = configurationOf(group({
      service: 'AWS Fargate',
      count: 300,
      configuration: {
        fargateTask: {
          taskCount: { originalValue: 10, originalUnit: 'tasks', originalPeriod: 'day', derived: { value: 300, unit: 'tasks', formula: '10 x 30' } },
          taskFrequency: 'perDay',
          vcpuPerTask: { originalValue: 1 },
          memoryGbPerTask: { originalValue: 2, originalUnit: 'GB' },
          taskDuration: { originalValue: 730, originalUnit: 'hours', originalPeriod: 'month' },
        },
      },
    }));
    expect(config).toEqual({
      taskCount: 10, taskFrequency: 'perDay', vcpuPerTask: 1, memoryGbPerTask: 2, duration: 730, durationUnit: 'hours',
    });
  });

  it('falls back to the group count and hours when the row carried no canonical task block', () => {
    const config = configurationOf(group({ service: 'AWS Fargate', count: 4, vcpu: 2, ramGb: 4, hoursPerMonth: 240 }));
    expect(config).toEqual({ taskCount: 4, taskFrequency: 'perMonth', vcpuPerTask: 2, memoryGbPerTask: 4, duration: 240, durationUnit: 'hours' });
  });
});

describe('machine groups', () => {
  it('describes an EC2 group in infrastructure words and never in Calculator field names', () => {
    const config = configurationOf(group({ size: 'm6i.xlarge', count: 4, os: 'Linux', diskGb: 400, hoursPerDay: 12 }));
    // The group's 400 GB is the sum over four machines; the Calculator wants the per-machine
    // figure and multiplies by the count itself.
    expect(config).toEqual({ instanceType: 'm6i.xlarge', instanceCount: 4, operatingSystem: 'Linux', hoursPerDay: 12, storageGbPerInstance: 100 });
    expect(Object.keys(config).join(' ')).not.toMatch(/columnForm|smallMemory|selectedId|workload/);
  });

  it('states the operating system as a licence: family plus a billed SQL Server edition, never BYOL, Express or MySQL', () => {
    const os = (text: string, service = 'Amazon EC2') => configurationOf(group({ size: 'm6a.xlarge', os: text, service })).operatingSystem;
    expect(os('Windows Server 2019')).toBe('Windows');
    expect(os('Windows Server 2019 with SQL Server Standard')).toBe('Windows with SQL Server Standard');
    expect(os('Windows', 'EC2 with SQL Server Enterprise')).toBe('Windows with SQL Server Enterprise');
    expect(os('Windows Server 2019 with SQL Server Standard (BYOL)')).toBe('Windows');
    expect(os('Windows + SQL Server Express')).toBe('Windows');
    expect(os('Linux', 'Amazon EC2 - MySQL 8.0')).toBe('Linux');
    expect(os('Red Hat Enterprise Linux 9')).toBe('RHEL');
  });

  it('names the service from the instance class, whatever the sheet wrote in its service column', () => {
    const named = (overrides: Partial<ResourceGroup>) => toSemanticResources({ segmentKey: 's', groups: [group(overrides)], defaultRegion: 'ap-south-1' })[0].service;
    expect(named({ service: 'EC2 with SQL Server Enterprise', size: 'm6a.xlarge' })).toBe('Amazon EC2');
    expect(named({ service: 'Amazon EC2 - MySQL 8.0', size: 'm6a.xlarge' })).toBe('Amazon EC2');
    expect(named({ service: 'Amazon RDS PostgreSQL', size: 'db.r6g.large' })).toBe('Amazon RDS for PostgreSQL');
    expect(named({ service: 'Database', size: 'db.r6g.large', os: 'Aurora MySQL' })).toBe('Amazon Aurora MySQL-Compatible');
    expect(named({ service: 'Redis', size: 'cache.t4g.medium' })).toBe('Amazon ElastiCache');
    expect(named({ service: 'Search', size: 'r7g.large.search' })).toBe('Amazon OpenSearch Service');
    expect(named({ service: 'ECS Fargate' })).toBe('AWS Fargate');
    expect(named({ service: 'Amazon SageMaker' })).toBe('Amazon SageMaker');
    // db.* with a cache engine is MemoryDB, not RDS; a load balancer is named by its kind,
    // because the Calculator has no "Elastic Load Balancing" service.
    expect(named({ service: 'Amazon RDS', size: 'db.t4g.medium', names: ['redis'], os: 'Redis' })).toBe('Amazon MemoryDB');
    expect(named({ service: 'Elastic Load Balancing', size: 'Internal Network Load Balancer' })).toBe('Network Load Balancer');
    expect(named({ service: 'Elastic Load Balancing', size: 'ALB external' })).toBe('Application Load Balancer');
  });

  it('strips a sheet annotation from the instance class and carries a bare usage count with its basis for a model to place', () => {
    const search = configurationOf(group({ service: 'Search', size: 'r7g.large.search(2c16g)', count: 3 }));
    expect(search.instanceType).toBe('r7g.large.search');
    expect(search.nodeCount).toBe(3);
    const cognito = configurationOf(group({ service: 'Amazon Cognito', quantities: [{ unit: 'units/month', amount: 50_000, basis: 'monthly active users (MAU)', conversions: [] }] }));
    expect(cognito).toEqual({ usageCount: 50_000, usageFrequency: 'perMonth', usageBasis: 'monthly active users (MAU)' });
  });

  it('carries the EBS volume type only when the sheet names one', () => {
    expect(configurationOf(group({ size: 'm6a.large', diskGb: 100, details: ['Data storage: 100 GB gp3'] })).storageType).toBe('gp3');
    expect(configurationOf(group({ size: 'm6a.large', diskGb: 100 })).storageType).toBeUndefined();
  });

  it('reads a database group as nodes with an engine and a deployment', () => {
    const config = configurationOf(group({ service: 'Amazon RDS', size: 'db.r6g.large', count: 2, os: 'PostgreSQL', details: ['Deployment: Multi-AZ'] }));
    expect(config).toEqual({ instanceType: 'db.r6g.large', nodeCount: 2, engine: 'PostgreSQL', deployment: 'Multi-AZ' });
  });

  it('carries a usage quantity with the period the source stated rather than the monthly figure', () => {
    const config = configurationOf(group({
      service: 'Amazon API Gateway',
      quantities: [{ unit: 'requests/month', amount: 3_000_000, originalValue: 100_000, originalPeriod: 'day', basis: 'API calls', conversions: ['x 30'] }],
    }));
    expect(config).toEqual({ requestCount: 100_000, requestFrequency: 'perDay' });
  });
});

describe('scenario and row pricing', () => {
  it('reads a sheet cell into a commitment without substituting an instrument', () => {
    expect(parseSheetCommitment('3-Yr Reserved Partial Upfront')).toEqual({ model: 'reserved', years: 3, purchase: 'Partial Upfront', offeringClass: 'standard' });
    expect(parseSheetCommitment('1 Year Compute Savings Plan')).toEqual({ model: 'compute-savings-plan', years: 1 });
    expect(parseSheetCommitment('On-Demand')).toEqual({ model: 'on-demand' });
    expect(parseSheetCommitment(undefined)).toEqual({ model: 'on-demand' });
  });

  it('maps the chat vocabulary onto the executor intent one to one', () => {
    expect(intentFromRequest('ri-3yr-all-upfront')).toEqual({ kind: 'standard-ri-3yr', upfrontPayment: 'All' });
    expect(intentFromRequest('compute-savings-1yr')).toEqual({ kind: 'compute-savings-1yr', upfrontPayment: 'None' });
    expect(intentFromRequest('sheet-specified')).toBeUndefined();
  });

  it('gives each row its own intent for a sheet-specified scenario and none when the scenario states one', () => {
    const groups = [group({ size: 'db.r6g.large', service: 'Amazon RDS', purchaseModel: '3-Yr Reserved' }), group({ service: 'AWS Fargate', count: 2 })];
    const sheet = toSemanticResources({ segmentKey: 'FY26-27', groups, defaultRegion: 'ap-south-1', scenarioLabel: 'FY26-27' });
    expect(sheet[0].pricing).toEqual({ kind: 'standard-ri-3yr', upfrontPayment: 'None' });
    expect(sheet[1].pricing).toBeUndefined();
    const requested = toSemanticResources({ segmentKey: 'csp', groups, defaultRegion: 'ap-south-1', commitment: { model: 'compute-savings-plan', years: 3 } });
    expect(requested.every((resource) => resource.pricing === undefined)).toBe(true);
    expect(intentFromCommitment({ model: 'compute-savings-plan', years: 3 })).toEqual({ kind: 'compute-savings-3yr', upfrontPayment: 'None' });
  });

  it('gives every resource a stable id and the group region or the default', () => {
    const [first, second] = toSemanticResources({ segmentKey: 'Dev', groups: [group({ size: 'm5.large', region: 'us-east-1' }), group({ service: 'Amazon S3', quantities: [{ unit: 'GB/month', amount: 500, basis: 'bucket', conversions: [] }] })], defaultRegion: 'ap-south-1' });
    expect(first.resourceId).toBe('dev-1-m5-large');
    expect(first.region).toBe('us-east-1');
    expect(second.region).toBe('ap-south-1');
    expect(second.configuration).toEqual({ storageGb: 500 });
  });
});
