import type { PriceTerm } from './aws-pricing';
import type { ResourceGroup } from './prompt';
import { HOURS_PER_MONTH } from '../shared/unit-contract';
import { sqlLicensing } from '../shared/sql-licence';

export interface CompiledAdapterPlan {
  serviceCode: string;
  filters: Record<string, string>;
  term?: PriceTerm;
  calculatorKey?: string;
  calculatorConfig?: Record<string, unknown>;
  basis: string;
  calculatorUnsupported?: string;
  /** Only EC2 instance volumes may use the pipeline's EBS pricing path. */
  storageOwner?: 'ec2-ebs' | 'service-native' | 'none';
  /** Saved fields that form this adapter's deterministic read-back fingerprint. */
  fingerprintFields?: string[];
}

export interface AdapterContext {
  defaultRegion: string;
  term?: PriceTerm;
}

export interface CommitmentCapability {
  onDemand: true;
  reserved?: Array<{ years: 1 | 3; upfront: 'none' | 'partial' | 'all' }>;
  computeSavingsPlans?: Array<1 | 3>;
  instanceSavingsPlans?: Array<1 | 3>;
}

export interface CalculatorAdapter {
  serviceFamily: string;
  /** Contract revision for audit logs and fixture compatibility. */
  version: string;
  supportedCommitments: CommitmentCapability;
  matches(group: ResourceGroup): boolean;
  compile(group: ResourceGroup, context: AdapterContext): CompiledAdapterPlan | undefined;
}

const EC2_INSTANCE = /^[a-z][a-z0-9]*[0-9][a-z]*\.[a-z0-9]+$/i;
const RDS_INSTANCE = /^db\.[a-z][a-z0-9]*[0-9][a-z]*\.[a-z0-9]+$/i;
const CACHE_INSTANCE = /^cache\.[a-z][a-z0-9]*[0-9][a-z]*\.[a-z0-9]+$/i;
const OPENSEARCH_INSTANCE = /^[a-z][a-z0-9]*[0-9][a-z]*\.[a-z0-9]+\.search$/i;
const MQ_INSTANCE = /^mq\.[a-z][a-z0-9]*[0-9][a-z]*\.[a-z0-9]+$/i;

function normalizedInstanceType(value?: string): string {
  return String(value || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
}

function serviceText(group: ResourceGroup): string {
  return [group.service, group.size, group.names.join(' '), ...(group.details || []), ...(group.quantities || []).map((entry) => entry.basis)]
    .filter(Boolean).join(' ').toLowerCase();
}

function quantity(
  group: ResourceGroup,
  unit: string,
  basis?: RegExp,
): number {
  return (group.quantities || [])
    .filter((entry) => entry.unit === unit && (!basis || basis.test(entry.basis)))
    .reduce((sum, entry) => sum + entry.amount, 0);
}

/**
 * Reads a storage capacity when a workbook supplied it in a size label instead of a
 * canonical disk_gb or GB/month meter. This is deliberately content-based: a generic
 * workbook may say "200 GB Standard", "1.5 TB", or put the capacity in its evidence
 * text without using the Digital Assets/Core BOM layouts.
 */
function storageCapacityGb(group: ResourceGroup): number {
  const declared = quantity(group, 'GB/month') || group.diskGb;
  if (declared > 0) return declared;

  const text = [group.size, ...(group.details || [])].filter(Boolean).join(' ');
  let total = 0;
  for (const match of text.matchAll(/(?:^|[^\d.])(\d+(?:\.\d+)?)\s*(gib|gb|tib|tb)\b/gi)) {
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) continue;
    total += /tib|tb/i.test(match[2]) ? amount * 1024 : amount;
  }
  return total;
}

const frequency = (value: number, unit = 'perMonth') => ({ value: String(Math.max(0, value)), unit });
const fileSize = (value: number, unit = 'gb|month') => ({ value: Math.max(0, value), unit });
const wholeFrequency = (value: number, unit = 'perMonth') => frequency(Math.round(value), unit);

function description(group: ResourceGroup, label: string): string {
  return `${label}${group.environment ? ` (${group.environment})` : ''}`;
}

function statedNumber(group: ResourceGroup, label: RegExp): number {
  const text = serviceText(group);
  const match = new RegExp(`${label.source}[^0-9]{0,30}([0-9]+(?:\\.[0-9]+)?)`, 'i').exec(text);
  return match ? Number(match[1]) : 0;
}

function structuredDetail(group: ResourceGroup, label: string): Record<string, unknown> | undefined {
  const direct = group.configuration?.[label];
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct as Record<string, unknown>;
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const detail of group.details || []) {
    const match = new RegExp(`${escaped}\\s*:\\s*(\\{[^|]+\\})`, 'i').exec(detail);
    if (!match) continue;
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function detailText(group: ResourceGroup, label: string): string | undefined {
  const direct = group.configuration?.[label];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const marker = `${label.toLowerCase()}:`;
  for (const detail of group.details || []) {
    const at = detail.toLowerCase().indexOf(marker);
    if (at < 0) continue;
    const value = detail.slice(at + marker.length).split('|')[0].trim();
    if (value) return value;
  }
  return undefined;
}

function numberField(value: Record<string, unknown> | undefined, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const parsed = Number(value?.[key]);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function objectField(value: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const child = value?.[key];
  return child && typeof child === 'object' && !Array.isArray(child)
    ? child as Record<string, unknown>
    : undefined;
}

function groupConfiguration(group: ResourceGroup, key: string): Record<string, unknown> | undefined {
  const direct = group.configuration?.[key];
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct as Record<string, unknown>;
  return structuredDetail(group, key);
}

function sourceNumber(value: unknown): number | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return numberField(record, 'originalValue', 'value', 'derivedValue');
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function derivedNumber(value: unknown): number | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const derived = objectField(record, 'derived');
    return numberField(derived, 'value') ?? numberField(record, 'derivedValue', 'originalValue', 'value');
  }
  return sourceNumber(value);
}

function nearestBedrockSchedule(monthlyCalls: number): { requestsPerMinute: number; hoursPerDay: number; representedCalls: number } {
  const billingUnits = Math.max(1, Math.round(monthlyCalls / (60 * 30)));
  let hoursPerDay = 24;
  while (hoursPerDay > 1 && billingUnits % hoursPerDay !== 0) hoursPerDay--;
  const requestsPerMinute = billingUnits / hoursPerDay;
  return { requestsPerMinute, hoursPerDay, representedCalls: billingUnits * 60 * 30 };
}

function cloudFrontGeography(region: string): string {
  if (region === 'ap-south-1') return 'India';
  if (/^ap-northeast-/.test(region)) return 'Japan';
  if (region === 'ap-southeast-2') return 'Australia';
  if (/^ap-/.test(region)) return 'AP';
  if (/^eu-/.test(region)) return 'EU';
  if (/^me-/.test(region)) return 'ME';
  if (/^ca-/.test(region)) return 'Canada';
  if (/^sa-/.test(region)) return 'SouthAmerica';
  return 'US';
}

function priceListOs(os?: string): string {
  const text = String(os || '').toLowerCase();
  if (text.includes('rhel') || text.includes('red hat')) return 'RHEL';
  if (text.includes('suse') || text.includes('sles')) return 'SUSE';
  if (text.includes('win')) return 'Windows';
  return 'Linux';
}

function calculatorOs(os?: string, sql: 'NA' | 'SQL Std' | 'SQL Web' | 'SQL Ent' = 'NA'): string {
  const base = priceListOs(os);
  if (sql !== 'NA') {
    const edition = sql === 'SQL Ent' ? 'enterprise' : sql === 'SQL Web' ? 'web' : 'std';
    if (base === 'Windows') return `windows-${edition}`;
    if (base === 'RHEL') return `rhel-${edition}`;
    return `linux-${edition}`;
  }
  if (base === 'Windows') return 'windows';
  if (base === 'RHEL') return 'rhel';
  if (base === 'SUSE') return 'suse';
  return 'linux';
}

function billedPct(group: ResourceGroup, term?: PriceTerm): number {
  if (term) return 100;
  const exact = group.hoursPerMonth !== undefined
    ? (group.hoursPerMonth / HOURS_PER_MONTH) * 100
    : (group.hoursPerDay / 24) * 100;
  return Math.max(1, Math.min(100, Math.round(exact)));
}

function readEngine(group: ResourceGroup): string | undefined {
  const text = `${serviceText(group)} ${group.os || ''}`.toLowerCase();
  if (/aurora/.test(text)) return /mysql/.test(text) ? 'Aurora MySQL' : /postgres/.test(text) ? 'Aurora PostgreSQL' : undefined;
  if (/postgres/.test(text)) return 'PostgreSQL';
  if (/mysql/.test(text)) return 'MySQL';
  if (/maria/.test(text)) return 'MariaDB';
  if (/oracle/.test(text)) return 'Oracle';
  if (/sql\s*server|mssql/.test(text)) return 'SQL Server';
  return undefined;
}

function auroraConfig(group: ResourceGroup, region: string, size: string, term?: PriceTerm): Record<string, unknown> {
  return {
    region,
    edition: 'auroraStandard',
    columnFormIPM: {
      value: [{
        'Number of Nodes': { value: String(group.count) },
        'Instance Type': { value: size },
        undefined: { value: { unit: '100', selectedId: '%Utilized/Month' } },
        'Instance Family': { value: 'Memory optimized' },
        TermType: { value: term ? 'Reserved' : 'OnDemand' },
        ...(term ? {
          LeaseContractLength: { value: term.years === 1 ? '1yr' : '3yr' },
          PurchaseOption: { value: term.purchase },
        } : {}),
      }],
    },
    description: `${group.count} x ${size}${group.environment ? ` (${group.environment})` : ''}`,
  };
}

const ec2Adapter: CalculatorAdapter = {
  serviceFamily: 'EC2 + EBS',
  version: '2026-08-30',
  supportedCommitments: { onDemand: true },
  matches: (group) => EC2_INSTANCE.test(String(group.size || '')),
  compile(group, context) {
    const size = String(group.size || '');
    const os = priceListOs(group.os);
    const sql = sqlLicensing(`${group.os || ''} ${group.service || ''}`).billed;
    const base: CompiledAdapterPlan = {
      serviceCode: 'AmazonEC2',
      filters: {
        instanceType: size,
        operatingSystem: os,
        ...(sql !== 'NA' ? { preInstalledSw: sql } : {}),
      },
      term: context.term,
      basis: `EC2 instance type read from the canonical resource (${size}, ${os}${sql !== 'NA' ? `, ${sql}` : ''})`,
      storageOwner: 'ec2-ebs',
      fingerprintFields: ['tenancy', 'instanceType', 'selectedOS', 'workload', 'utilization', 'pricingStrategy', 'storageType', 'storageAmount'],
    };
    if (context.term) {
      return {
        ...base,
        calculatorUnsupported: 'The current Calculator EC2 service contract does not expose an exact Reserved Instance configuration for shared tenancy. No Savings Plan was substituted.',
      };
    }
    return {
      ...base,
      calculatorKey: 'ec2Enhancement',
      calculatorConfig: {
        region: group.region || context.defaultRegion,
        tenancy: 'shared',
        instanceType: size,
        selectedOS: calculatorOs(group.os, sql),
        workload: group.count,
        utilization: String(billedPct(group)),
        pricingStrategy: 'ondemand',
        ...(group.diskGb > 0 ? {
          storageType: 'Storage General Purpose gp3 GB Mo',
          storageAmount: {
            value: Math.max(1, Math.round(group.diskGb / Math.max(1, group.count))),
            unit: 'gb|NA',
          },
        } : {}),
        description: `${group.count} x ${size} ${os}${sql !== 'NA' ? ` + ${sql}` : ''}${group.environment ? ` (${group.environment})` : ''}`,
      },
    };
  },
};

const auroraAdapter: CalculatorAdapter = {
  serviceFamily: 'Aurora',
  version: '2026-08-30',
  supportedCommitments: {
    onDemand: true,
    reserved: [
      { years: 1, upfront: 'none' }, { years: 1, upfront: 'partial' }, { years: 1, upfront: 'all' },
      { years: 3, upfront: 'partial' }, { years: 3, upfront: 'all' },
    ],
  },
  matches: (group) => RDS_INSTANCE.test(String(group.size || '')) && /aurora/i.test(String(group.service || '')),
  compile(group, context) {
    const size = String(group.size || '');
    const engine = readEngine(group);
    if (!engine?.startsWith('Aurora')) return {
      serviceCode: 'AmazonRDS',
      filters: { instanceType: size } as Record<string, string>,
      term: context.term,
      basis: `Aurora instance type was read from the canonical resource (${size}), but its engine was not stated.`,
      calculatorUnsupported: 'Aurora requires an explicit MySQL-compatible or PostgreSQL-compatible engine before Calculator compilation.',
      storageOwner: 'service-native',
    };
    return {
      serviceCode: 'AmazonRDS',
      filters: { instanceType: size, databaseEngine: engine },
      term: context.term,
      calculatorKey: engine === 'Aurora MySQL'
        ? 'amazonAuroraMySQLCompatible'
        : 'amazonRDSAuroraPostgreSQLCompatibleDB',
      calculatorConfig: auroraConfig(group, group.region || context.defaultRegion, size, context.term),
      basis: `Aurora instance type and engine read from the canonical resource (${size}, ${engine})`,
      storageOwner: 'service-native',
      fingerprintFields: ['edition', 'columnFormIPM'],
    };
  },
};

const rdsAdapter: CalculatorAdapter = {
  serviceFamily: 'RDS',
  version: '2026-08-30',
  supportedCommitments: { onDemand: true },
  matches: (group) => RDS_INSTANCE.test(String(group.size || '')),
  compile(group, context) {
    const size = String(group.size || '');
    const engine = readEngine(group);
    if (!engine) return undefined;
    const calculatorKey = engine === 'MySQL' ? 'amazonRDSMySQLDB'
      : engine === 'PostgreSQL' ? 'amazonRDSPostgreSQLDB'
        : engine === 'MariaDB' ? 'amazonRDSMariaDB' : undefined;
    if (!calculatorKey) return {
      serviceCode: 'AmazonRDS',
      filters: { instanceType: size, databaseEngine: engine },
      term: context.term,
      basis: `RDS instance type and engine read from the canonical resource (${size}, ${engine})`,
      calculatorUnsupported: 'This RDS engine is not covered by a verified Calculator service adapter.',
      storageOwner: 'service-native',
    };
    const text = serviceText(group);
    const multiAz = /multi[- ]?az[^|]*(?:yes|required|true)|multi[- ]?az required/.test(text);
    const storageField = engine === 'PostgreSQL' ? 'storageVolume' : 'storageType';
    return {
      serviceCode: 'AmazonRDS', filters: { instanceType: size, databaseEngine: engine }, term: context.term,
      calculatorKey,
      calculatorConfig: {
        region: group.region || context.defaultRegion,
        columnFormIPM: { value: [{
          'Number of Nodes': { value: String(group.count) },
          'Instance Type': { value: size },
          undefined: { value: { unit: String(billedPct(group, context.term)), selectedId: '%Utilized/Month' } },
          'Deployment Option': { value: multiAz ? 'Multi-AZ' : 'Single-AZ' },
          TermType: { value: context.term ? 'Reserved' : 'OnDemand' },
          ...(context.term ? {
            LeaseContractLength: { value: context.term.years === 1 ? '1yr' : '3yr' },
            PurchaseOption: { value: context.term.purchase },
          } : {}),
        }] },
        ...(group.diskGb ? { [storageField]: 'General Purpose-GP3', storageAmount: fileSize(group.diskGb / Math.max(1, group.count), 'gb|NA') } : {}),
        description: description(group, `${group.count} x ${size} ${engine}`),
      },
      basis: `RDS instance, engine, deployment mode and owned storage compiled from the canonical resource (${size}, ${engine}).`,
      storageOwner: 'service-native', fingerprintFields: ['columnFormIPM', storageField, 'storageAmount'],
    };
  },
};

const elasticacheAdapter: CalculatorAdapter = {
  serviceFamily: 'ElastiCache',
  version: '2026-08-30',
  supportedCommitments: { onDemand: true },
  matches: (group) => CACHE_INSTANCE.test(String(group.size || '')),
  compile(group, context) {
    const size = String(group.size || '');
    const base: CompiledAdapterPlan = {
      serviceCode: 'AmazonElastiCache',
      filters: { instanceType: size, cacheEngine: 'Redis' },
      term: context.term,
      basis: `ElastiCache node type read from the canonical resource (${size})`,
      storageOwner: 'service-native',
      fingerprintFields: ['columnFormIPM'],
    };
    if (context.term) return {
      ...base,
      calculatorUnsupported: 'The current Calculator ElastiCache contract rejects this Reserved tuple. It was not replaced with On-Demand.',
    };
    return {
      ...base,
      calculatorKey: 'amazonElastiCache',
      calculatorConfig: {
        region: group.region || context.defaultRegion,
        columnFormIPM: {
          value: [{
            'Number of Nodes': { value: String(group.count) },
            'Instance Type': { value: size },
            undefined: { value: { unit: '100', selectedId: '%Utilized/Month' } },
            'Cache Engine': { value: 'Redis' },
            'Instance Family': { value: 'Memory optimized' },
            TermType: { value: 'OnDemand' },
          }],
        },
        description: `${group.count} x ${size}${group.environment ? ` (${group.environment})` : ''}`,
      },
    };
  },
};

const fargateAdapter: CalculatorAdapter = {
  serviceFamily: 'ECS Fargate',
  version: '2026-08-31',
  supportedCommitments: { onDemand: true, computeSavingsPlans: [1, 3] },
  matches: (group) => /\bfargate\b/.test(serviceText(group)),
  compile(group, context) {
    const semantic = groupConfiguration(group, 'fargateTask');
    const vcpuHours = quantity(group, 'vCPU-hours/month');
    const memoryHours = quantity(group, 'GB-hours/month');
    const taskCountMeasure = objectField(semantic, 'taskCount');
    const durationMeasure = objectField(semantic, 'taskDuration');
    const vcpuMeasure = objectField(semantic, 'vcpuPerTask');
    const memoryMeasure = objectField(semantic, 'memoryGbPerTask');
    const taskCount = sourceNumber(taskCountMeasure) ?? group.count;
    const taskFrequency = String(semantic?.taskFrequency || '').trim() || 'perMonth';
    const durationHours = derivedNumber(durationMeasure) ?? group.hoursPerMonth ?? (group.hoursPerDay / 24) * 730;
    const durationUnit = String((durationMeasure as any)?.derived?.unit || (durationMeasure as any)?.derivedUnit || 'hours');
    const vcpu = sourceNumber(vcpuMeasure) ?? group.vcpu;
    const memory = sourceNumber(memoryMeasure) ?? group.ramGb;
    if (!taskCount || !vcpu || !memory || !durationHours) return {
      serviceCode: 'AmazonECS', filters: {} as Record<string, string>, basis: 'Fargate was detected but its vCPU-hours and GB-hours are incomplete.',
      calculatorUnsupported: 'Fargate requires task count, task frequency, task duration, task duration unit, vCPU per task, memory per task and region before Calculator compilation.',
      storageOwner: 'service-native',
    };
    const tasks = Math.max(1, taskCount);
    const expectedVcpuHours = tasks * (/perday/i.test(taskFrequency) ? 730 / 24 : 1) * durationHours * vcpu;
    const expectedMemoryHours = tasks * (/perday/i.test(taskFrequency) ? 730 / 24 : 1) * durationHours * memory;
    return {
      serviceCode: 'AmazonECS',
      filters: { usagetype: '*Fargate-vCPU-Hours:perCPU' },
      calculatorKey: 'awsFargate',
      calculatorConfig: {
        region: group.region || context.defaultRegion,
        operatingSystem: /win/i.test(group.os || '') ? 'windows' : 'linux',
        selectArchitecture: /arm|graviton/i.test(serviceText(group)) ? 'arm' : 'x86',
        numberOfTasks: frequency(tasks, taskFrequency),
        taskDuration: { value: String(durationHours), unit: /^min/i.test(durationUnit) ? 'minutes' : 'hr' },
        vcpuPerTask: String(vcpu),
        ...(vcpu <= 0.5 ? { smallMemory: String(memory) }
          : vcpu <= 4 ? { memoryStandardFargateOnDemand: fileSize(memory, 'gb|NA') }
            : vcpu === 8 ? { smallMemory_8: String(memory) } : { smallMemory_16: String(memory) }),
        storageAmountECS: fileSize(20, 'gb|NA'),
        description: description(group, `${tasks} Fargate task(s)`),
      },
      basis: `Fargate compiled from source task semantics: ${tasks} task(s) ${taskFrequency}, ${durationHours} hour duration, ${vcpu} vCPU and ${memory} GB per task${vcpuHours || memoryHours ? `; derived monthly cross-check ${vcpuHours}/${expectedVcpuHours.toFixed(2)} vCPU-hours and ${memoryHours}/${expectedMemoryHours.toFixed(2)} GB-hours` : ''}.`,
      storageOwner: 'service-native',
      fingerprintFields: ['operatingSystem', 'selectArchitecture', 'numberOfTasks', 'taskDuration', 'vcpuPerTask', 'smallMemory', 'memoryStandardFargateOnDemand', 'smallMemory_8', 'smallMemory_16', 'storageAmountECS'],
    };
  },
};

const s3Adapter: CalculatorAdapter = {
  serviceFamily: 'S3 Standard', version: '2026-08-31', supportedCommitments: { onDemand: true },
  matches: (group) => /\bs3\b|simple storage/.test(serviceText(group)),
  compile(group, context) {
    const storage = storageCapacityGb(group);
    const puts = quantity(group, 'requests/month', /put|write|upload/i);
    const gets = quantity(group, 'requests/month', /get|read|select/i);
    if (!storage && !puts && !gets) return undefined;
    const calculatorPuts = puts ? Math.round(puts) : 0;
    const calculatorGets = gets ? Math.round(gets) : 0;
    const requestRounding = [
      puts && puts !== calculatorPuts ? `PUT ${puts} to ${calculatorPuts}` : '',
      gets && gets !== calculatorGets ? `GET ${gets} to ${calculatorGets}` : '',
    ].filter(Boolean);
    return {
      serviceCode: 'AmazonS3', filters: { storageClass: 'General Purpose' },
      calculatorKey: 'amazonS3Standard',
      calculatorConfig: {
        region: group.region || context.defaultRegion,
        ...(storage ? { s3StandardStorageSize: fileSize(storage) } : {}),
        moveToStorageClassMethod: 'No movement required',
        ...(puts ? { s3StandardPutRequests: calculatorPuts } : {}),
        ...(gets ? { s3StandardGetRequests: calculatorGets } : {}),
        description: description(group, 'S3 Standard'),
      },
      basis: `S3 storage and request dimensions compiled from canonical monthly quantities${requestRounding.length
        ? `; fractional annual-to-month request conversions were rounded to Calculator-supported whole requests (${requestRounding.join(', ')})`
        : ''}.`,
      storageOwner: 'service-native',
      fingerprintFields: ['s3StandardStorageSize', 'moveToStorageClassMethod', 's3StandardPutRequests', 's3StandardGetRequests'],
    };
  },
};

const lambdaAdapter: CalculatorAdapter = {
  serviceFamily: 'Lambda', version: '2026-08-31',
  supportedCommitments: { onDemand: true, computeSavingsPlans: [1, 3] },
  matches: (group) => /\blambda\b/.test(serviceText(group)),
  compile(group, context) {
    const requests = quantity(group, 'invocations/month') || quantity(group, 'requests/month');
    const gbSeconds = quantity(group, 'GB-seconds/month');
    const profile = structuredDetail(group, 'lambda.execution_profile');
    const memoryMb = numberField(profile, 'memoryMb', 'memory_mb', 'memoryMB', 'memory');
    const durationMs = numberField(profile, 'durationMs', 'duration_ms', 'durationMS', 'duration');
    if (!requests || !memoryMb || !durationMs) return {
      serviceCode: 'AWSLambda',
      filters: {} as Record<string, string>,
      basis: 'Lambda was detected but its Calculator execution profile is incomplete.',
      calculatorUnsupported: 'Lambda Calculator compilation requires explicit monthly invocations, memory MB and duration ms. Aggregate GB-seconds are preserved as evidence only; the pipeline will not manufacture a memory/duration pair.',
      storageOwner: 'none',
    };
    const calculatorRequests = Math.max(1, Math.round(requests));
    const representedGbSeconds = (calculatorRequests * memoryMb / 1024 * durationMs) / 1000;
    const computeVariance = gbSeconds
      ? Math.abs(representedGbSeconds - gbSeconds) / Math.max(gbSeconds, 1) * 100
      : undefined;
    return {
      serviceCode: 'AWSLambda', filters: { group: 'AWS-Lambda-Duration' },
      calculatorKey: 'aWSLambda',
      calculatorConfig: {
        region: group.region || context.defaultRegion,
        selectArchitectureRequests: /arm|graviton/i.test(serviceText(group)) ? '2' : '1',
        numberOfRequests: wholeFrequency(requests),
        durationOfEachRequest: String(Math.round(durationMs)),
        sizeOfMemoryAllocated: fileSize(Math.round(memoryMb), 'mb|NA'),
        selectArchitectureConcurrency: '1',
        description: description(group, 'Lambda aggregate workload'),
      },
      basis: `Lambda uses the explicit execution profile (${Math.round(memoryMb)} MB, ${Math.round(durationMs)} ms) for ${calculatorRequests} invocations${gbSeconds ? `; workbook GB-seconds/month cross-check variance ${computeVariance!.toFixed(4)}%` : ''}${calculatorRequests !== requests ? `; fractional annual-to-month invocations were rounded from ${requests} to ${calculatorRequests} because AWS Calculator requires whole requests` : ''}.`,
      storageOwner: 'none',
      fingerprintFields: ['selectArchitectureRequests', 'numberOfRequests', 'durationOfEachRequest', 'sizeOfMemoryAllocated'],
    };
  },
};

const openSearchAdapter: CalculatorAdapter = {
  serviceFamily: 'OpenSearch', version: '2026-08-31', supportedCommitments: { onDemand: true },
  matches: (group) => OPENSEARCH_INSTANCE.test(normalizedInstanceType(group.size)) || /opensearch|elastic search/.test(serviceText(group)),
  compile(group, context) {
    const size = normalizedInstanceType(group.size);
    if (!OPENSEARCH_INSTANCE.test(size)) return undefined;
    return {
      serviceCode: 'AmazonES', filters: { instanceType: size },
      calculatorKey: 'amazonElasticsearchService',
      calculatorConfig: {
        region: group.region || context.defaultRegion,
        columnFormIPM_1: { value: [{
          'Number of Nodes Data instance': { value: String(group.count) },
          'Instance Type': { value: size },
          undefined: { value: { unit: '100', selectedId: '%Utilized/Month' } },
          'Instance Family': { value: /^r/i.test(size) ? 'Memory optimized' : /^c/i.test(size) ? 'Compute optimized' : 'General purpose' },
          TermType: { value: 'OnDemand' },
          Storage: { value: 'EBS Only' },
        }] },
        columnFormIPM_2: { value: [{
          'Number of Nodes Dedicated master': { value: '0' },
          'Instance Type': { value: 'r5.2xlarge.search' },
        }] },
        columnFormIPM: { value: [{ 'Number of Nodes': { value: '0' } }] },
        numberOfInstances: group.count,
        storageType: 'GP3',
        ...(group.diskGb ? { storageAmount: fileSize(group.diskGb / Math.max(1, group.count), 'gb|NA') } : {}),
        description: description(group, `${group.count} x ${size}`),
      },
      basis: `OpenSearch node class and owned storage compiled from the canonical resource (${size}).`,
      storageOwner: 'service-native',
      fingerprintFields: ['columnFormIPM_1', 'columnFormIPM_2', 'columnFormIPM', 'numberOfInstances', 'storageType', 'storageAmount'],
    };
  },
};

const cognitoAdapter: CalculatorAdapter = {
  serviceFamily: 'Cognito', version: '2026-08-31', supportedCommitments: { onDemand: true },
  matches: (group) => /cognito/.test(serviceText(group)),
  compile(group, context) {
    const profile = structuredDetail(group, 'cognito.tier');
    const tier = String(profile?.tier || detailText(group, 'cognito.tier') || '').toLowerCase();
    const monthlyActiveUsers = quantity(group, 'units/month', /monthly active|\bmau\b|users?/i)
      || statedNumber(group, /monthly active users?|\bmau\b/);
    const monthlyTokenRequests = numberField(profile, 'monthlyTokenRequests', 'tokenRequests');
    const federatedMau = numberField(profile, 'federatedMau', 'samlOidcMau');
    if (!monthlyActiveUsers || !/lite|essential|plus/.test(tier)
      || monthlyTokenRequests === undefined || monthlyTokenRequests < 0) return {
      serviceCode: 'AmazonCognito', filters: {},
      basis: 'Cognito was detected, but its monthly active users or pricing tier is incomplete.',
      calculatorUnsupported: 'Cognito requires monthly active users, an explicit tier, and monthly token requests; federated MAU is required only when SAML/OIDC is used.',
      storageOwner: 'none',
    };
    // The deployed Calculator export contract currently requires the Essentials MAU
    // component even when the catalog still advertises the older generic/Lite field.
    // Lite's token meter remains the generic Cognito meter; using the rejected field
    // would make every affected scenario lose its shareable link at export time.
    const isPlus = tier.includes('plus');
    const isEssentials = tier.includes('essential');
    const mauField = isPlus ? 'cognito_NumberOfMAUs_Plus'
      : isEssentials ? 'cognito_NumberOfMAUs_Essential' : 'cognito_NumberOfMAUs_Essential';
    return {
      serviceCode: 'AmazonCognito', filters: {}, calculatorKey: 'amazonCognito',
      calculatorConfig: {
        region: group.region || context.defaultRegion,
        [mauField]: String(monthlyActiveUsers),
        // The deployed Calculator export guard currently requires these neutral
        // defaults for every Cognito template. Saved read-back still fingerprints
        // the tier-specific fields, so a wrong Lite/Essentials/Plus rehydration fails.
        optimizationRateTokenRequests: 0,
        optimizationRateAppClients: 0,
        ...(isPlus ? {
          cognitoPlus_userTokenRequests: String(monthlyTokenRequests),
          ...(federatedMau !== undefined ? { SAMLOIDC_Plus: String(federatedMau) } : {}),
        } : isEssentials ? {
          cognitoEssentials_userTokenRequests: String(monthlyTokenRequests),
          ...(federatedMau !== undefined ? { SAMLOIDC_Essentials: String(federatedMau) } : {}),
        } : {
          cognito_NumberOfTokenRequests: String(monthlyTokenRequests),
          ...(federatedMau !== undefined ? { percentSAMLOIDC: String(federatedMau) } : {}),
        }),
        description: description(group, `Cognito ${isPlus ? 'Plus' : isEssentials ? 'Essentials' : 'Lite'} ${monthlyActiveUsers} MAU`),
      },
      basis: `Cognito tier, ${monthlyActiveUsers} monthly active users and ${monthlyTokenRequests} monthly token requests were compiled from confirmed values.`,
      storageOwner: 'none', fingerprintFields: [mauField,
        isPlus ? 'cognitoPlus_userTokenRequests'
          : isEssentials ? 'cognitoEssentials_userTokenRequests' : 'cognito_NumberOfTokenRequests'],
    };
  },
};

const sageMakerAdapter: CalculatorAdapter = {
  serviceFamily: 'SageMaker real-time inference', version: '2026-08-31', supportedCommitments: { onDemand: true },
  matches: (group) => /sagemaker|custom model hosting/.test(serviceText(group)),
  compile(group, context) {
    const profile = structuredDetail(group, 'sagemaker.inference_configuration');
    const textProfile = detailText(group, 'sagemaker.inference_configuration') || '';
    const workload = String(profile?.workloadType || profile?.workload || textProfile).toLowerCase();
    const instanceType = String(profile?.instanceType || profile?.instanceClass
      || /ml\.[a-z0-9.-]+/i.exec(textProfile)?.[0] || '').trim();
    const modelsPerEndpoint = Math.max(1, Math.round(numberField(profile, 'modelsPerEndpoint', 'modelsPerEndPoint') || 1));
    const modelsDeployed = Math.max(1, Math.round(numberField(profile, 'modelsDeployed')
      || new Set(group.names.filter(Boolean)).size || 1));
    const endpoints = Math.max(1, Math.ceil(modelsDeployed / modelsPerEndpoint));
    const derivedInstances = group.count / endpoints;
    const instancesPerEndpoint = numberField(profile, 'instancesPerEndpoint', 'instancesPerEndPoint') ?? derivedInstances;
    const hoursPerDay = numberField(profile, 'hoursPerDay', 'endpointHoursPerDay') ?? group.hoursPerDay;
    const daysPerMonth = numberField(profile, 'daysPerMonth', 'endpointDaysPerMonth')
      ?? ((group.hoursPerMonth || HOURS_PER_MONTH) / Math.max(1, hoursPerDay));
    if (!/real.?time|inference/.test(workload) || !/^ml\.[a-z0-9.-]+$/i.test(instanceType)
      || !Number.isInteger(instancesPerEndpoint) || instancesPerEndpoint < 1
      || hoursPerDay <= 0 || hoursPerDay > 24 || daysPerMonth <= 0 || daysPerMonth > 31) return {
      serviceCode: 'AmazonSageMaker', filters: {} as Record<string, string>,
      basis: 'SageMaker was detected, but its confirmed real-time endpoint shape is incomplete.',
      calculatorUnsupported: 'SageMaker real-time inference requires an ml.* instance class and an integer endpoint/model/instance shape whose runtime is within Calculator limits.',
      storageOwner: 'service-native',
    };
    return {
      serviceCode: 'AmazonSageMaker', filters: { instanceType }, calculatorKey: 'sageMakerRealTimeInference',
      calculatorConfig: {
        region: group.region || context.defaultRegion,
        modelsDeployed: String(modelsDeployed),
        modelsPerEndPoint: String(modelsPerEndpoint),
        instancesPerEndPoint: String(instancesPerEndpoint),
        endpointHrsPerDay: String(hoursPerDay),
        EndPointDaysPerMonth: String(Math.round(daysPerMonth)),
        columnFormIPM: { value: [{ 'Instance Name': { value: instanceType } }] },
        description: description(group, `${modelsDeployed} SageMaker real-time model(s), ${group.count} x ${instanceType}`),
      },
      basis: `SageMaker real-time inference compiled from the confirmed ${instanceType} endpoint shape and canonical instance count.`,
      storageOwner: 'service-native',
      fingerprintFields: ['modelsDeployed', 'modelsPerEndPoint', 'instancesPerEndPoint', 'endpointHrsPerDay', 'EndPointDaysPerMonth', 'columnFormIPM'],
    };
  },
};

const bedrockAdapter: CalculatorAdapter = {
  serviceFamily: 'Bedrock on-demand inference', version: '2026-08-31', supportedCommitments: { onDemand: true },
  matches: (group) => /bedrock/.test(serviceText(group)),
  compile(group, context) {
    const modelProfile = structuredDetail(group, 'bedrock.model');
    const modelText = detailText(group, 'bedrock.model') || '';
    const provider = String(modelProfile?.provider || (/claude|anthropic/i.test(modelText) ? 'anthropic' : '')).toLowerCase();
    let model = String(modelProfile?.model || modelProfile?.modelName || modelText).trim();
    if (model && !/:/.test(model) && /claude/i.test(model)) model = `Anthropic: ${model}`;
    const tokenProfile = structuredDetail(group, 'bedrock.tokens_per_call');
    const tokenText = detailText(group, 'bedrock.tokens_per_call') || '';
    const inputTokens = numberField(tokenProfile, 'inputTokens', 'averageInputTokens')
      ?? Number(/input\D{0,20}(\d+(?:\.\d+)?)/i.exec(tokenText)?.[1]);
    const outputTokens = numberField(tokenProfile, 'outputTokens', 'averageOutputTokens')
      ?? Number(/output\D{0,20}(\d+(?:\.\d+)?)/i.exec(tokenText)?.[1]);
    const monthlyCalls = quantity(group, 'requests/month', /bedrock|model calls?/i)
      || quantity(group, 'units/month', /interactions?|model calls?|calls?/i);
    if (provider !== 'anthropic' || !model || !monthlyCalls
      || !Number.isFinite(inputTokens) || inputTokens <= 0
      || !Number.isFinite(outputTokens) || outputTokens <= 0) return {
      serviceCode: 'AmazonBedrock', filters: {},
      basis: 'Bedrock was detected, but its provider/model/token contract is incomplete or not yet supported.',
      calculatorUnsupported: provider && provider !== 'anthropic'
        ? `The deterministic Bedrock adapter has not yet verified the ${provider} provider catalog; it will not substitute an Anthropic model.`
        : 'Bedrock requires an explicit Anthropic model, monthly model-call volume, and average input/output tokens per call.',
      storageOwner: 'none',
    };
    const schedule = nearestBedrockSchedule(monthlyCalls);
    return {
      serviceCode: 'AmazonBedrock', filters: {}, calculatorKey: 'anthropic',
      calculatorConfig: {
        region: group.region || context.defaultRegion,
        location: 'Global',
        tierIR: 'On Demand - Standard',
        modelSelection: model,
        selectedModel: model,
        selectedModel_od: model,
        avgRequestsPerMin: String(schedule.requestsPerMinute),
        hoursPerDayAtThisRate: String(schedule.hoursPerDay),
        avgInputTokensPerRequest: String(inputTokens),
        avgOutputTokensPerRequest: String(outputTokens),
        description: description(group, `${model}, ${Math.round(monthlyCalls)} calls/month`),
      },
      basis: `Bedrock ${model} uses the nearest Calculator-representable integer schedule (${schedule.representedCalls} calls/month versus ${monthlyCalls}) with the confirmed per-call token profile.`,
      storageOwner: 'none',
      fingerprintFields: ['location', 'tierIR', 'modelSelection', 'selectedModel', 'selectedModel_od', 'avgRequestsPerMin', 'hoursPerDayAtThisRate', 'avgInputTokensPerRequest', 'avgOutputTokensPerRequest'],
    };
  },
};

const loadBalancerAdapter: CalculatorAdapter = {
  serviceFamily: 'Elastic Load Balancing', version: '2026-08-31', supportedCommitments: { onDemand: true },
  matches: (group) => /load balanc|\balb\b|\bnlb\b/.test(serviceText(group)),
  compile(group, context) {
    const root = structuredDetail(group, 'load_balancer.capacity_profile');
    const isNlb = /network load balancer|\bnlb\b/.test(serviceText(group));
    const profile = objectField(root, isNlb ? 'nlb' : 'alb') || root;
    const processedPerHour = numberField(profile, 'processedGbPerHour', 'processedGbPerLoadBalancerHour')
      ?? (() => {
        const monthly = numberField(profile, 'processedGbPerMonth', 'processedGbPerLoadBalancerMonth');
        return monthly === undefined ? undefined : monthly / HOURS_PER_MONTH;
      })();
    if (!profile || processedPerHour === undefined || processedPerHour < 0) return {
      serviceCode: 'AmazonEC2', filters: {},
      basis: 'A load balancer was detected without a complete confirmed capacity profile.',
      calculatorUnsupported: 'ALB/NLB compilation requires processed GB per load balancer per hour (or the monthly equivalent); no traffic default is invented.',
      storageOwner: 'none',
    };
    if (isNlb) {
      const protocol = String(profile.protocol || 'TCP').toUpperCase();
      const field = protocol === 'UDP' ? 'sizeOfDataProcessedPerNLBForUDP'
        : protocol === 'TLS' ? 'sizeOfDataProcessedPerNLBForTLS' : 'sizeOfProcessedDataPerNLBForTCP';
      return {
        serviceCode: 'AmazonEC2', filters: {}, calculatorKey: 'networkLoadBalancer',
        calculatorConfig: {
          region: group.region || context.defaultRegion,
          numberOfNetworkLoadBalancers: String(group.count),
          [field]: fileSize(processedPerHour, 'gb|hour'),
          description: description(group, `${group.count} Network Load Balancer(s), ${protocol}`),
        },
        basis: `NLB count, ${protocol} protocol and processed data were compiled from confirmed canonical values.`,
        storageOwner: 'none', fingerprintFields: ['numberOfNetworkLoadBalancers', field],
      };
    }
    return {
      serviceCode: 'AmazonEC2', filters: {}, calculatorKey: 'applicationLoadBalancer',
      calculatorConfig: {
        region: group.region || context.defaultRegion,
        numberOfApplicationLoadBalancers: String(group.count),
        sizeOfDataProcessedForEC2InstanceAndIPAddressTargets: fileSize(processedPerHour, 'gb|hour'),
        description: description(group, `${group.count} Application Load Balancer(s)`),
      },
      basis: 'ALB count and EC2/IP-target processed data were compiled from confirmed canonical values.',
      storageOwner: 'none', fingerprintFields: ['numberOfApplicationLoadBalancers', 'sizeOfDataProcessedForEC2InstanceAndIPAddressTargets'],
    };
  },
};

const wafAdapter: CalculatorAdapter = {
  serviceFamily: 'AWS WAF', version: '2026-08-31', supportedCommitments: { onDemand: true },
  matches: (group) => /\bwaf\b|web application firewall/.test(serviceText(group)),
  compile(group, context) {
    const profile = structuredDetail(group, 'waf.traffic_profile');
    const webAclCount = numberField(profile, 'webAclCount', 'webAcls');
    const rulesPerAcl = numberField(profile, 'rulesPerAcl', 'rulesPerWebAcl');
    const monthlyRequestsMillions = numberField(profile, 'monthlyWebRequestsMillions', 'webRequestsMillionsPerMonth');
    if (!webAclCount || rulesPerAcl === undefined || rulesPerAcl < 0
      || monthlyRequestsMillions === undefined || monthlyRequestsMillions < 0) return {
      serviceCode: 'AWSWAF', filters: {}, basis: 'WAF was detected without a complete confirmed traffic profile.',
      calculatorUnsupported: 'WAF requires Web ACL count, rules per ACL, and monthly web requests in millions.', storageOwner: 'none',
    };
    return {
      serviceCode: 'AWSWAF', filters: {}, calculatorKey: 'awsWebApplicationFirewall',
      calculatorConfig: {
        region: group.region || context.defaultRegion,
        numberOfWebAcls: frequency(webAclCount),
        numberOfRulesPerWebAcl: frequency(rulesPerAcl),
        numberOfWebRequests: frequency(monthlyRequestsMillions),
        description: description(group, `${webAclCount} WAF Web ACL(s)`),
      },
      basis: 'WAF ACL, rule and request dimensions were compiled from confirmed canonical values.', storageOwner: 'none',
      fingerprintFields: ['numberOfWebAcls', 'numberOfRulesPerWebAcl', 'numberOfWebRequests'],
    };
  },
};

const memoryDbAdapter: CalculatorAdapter = {
  serviceFamily: 'MemoryDB', version: '2026-08-31', supportedCommitments: { onDemand: true },
  matches: (group) => /memory\s*db/.test(serviceText(group)),
  compile(group, context) {
    const size = normalizedInstanceType(group.size);
    const dataProfile = structuredDetail(group, 'memorydb.data_profile');
    const dataWrittenGb = Number(dataProfile?.dataWrittenGb);
    const snapshotStorageGb = Number(dataProfile?.snapshotStorageGb);
    if (!/^db\.[a-z0-9.]+$/i.test(size) || group.count < 1
      || !Number.isFinite(dataWrittenGb) || dataWrittenGb < 0
      || !Number.isFinite(snapshotStorageGb) || snapshotStorageGb < 0) return {
      serviceCode: 'AmazonMemoryDB', filters: {} as Record<string, string>,
      basis: 'MemoryDB was detected but its node class, count, data-written, or snapshot-storage dimensions are incomplete.',
      calculatorUnsupported: 'MemoryDB requires node class, node count, monthly data written and snapshot storage before Calculator compilation.',
      storageOwner: 'service-native',
    };
    return {
      serviceCode: 'AmazonMemoryDB', filters: { instanceType: size },
      calculatorKey: 'amazonMemoryDbForRedis',
      calculatorConfig: {
        region: group.region || context.defaultRegion,
        columnFormIPM: { value: [{
          'Instance Type': { value: size },
          'Number of nodes': { value: String(group.count) },
          undefined: { value: { unit: '100', selectedId: '%Utilized/Month' } },
          'Instance Family': { value: /^db\.t/i.test(size) ? 'General purpose' : 'Memory optimized' },
          TermType: { value: 'OnDemand' },
        }] },
        columnFormIPMDT: { value: [{ 'Number of Nodes': { value: '0' } }] },
        Data_Written: fileSize(dataWrittenGb, 'gb|NA'),
        Mdb_BackupStorage: fileSize(snapshotStorageGb, 'gb|NA'),
        description: description(group, `${group.count} x ${size} MemoryDB`),
      },
      basis: `MemoryDB node class and count compiled from canonical values (${group.count} x ${size}).`,
      storageOwner: 'service-native', fingerprintFields: ['columnFormIPM', 'columnFormIPMDT', 'Data_Written', 'Mdb_BackupStorage'],
    };
  },
};

const mqAdapter: CalculatorAdapter = {
  serviceFamily: 'Amazon MQ', version: '2026-08-31', supportedCommitments: { onDemand: true },
  matches: (group) => MQ_INSTANCE.test(normalizedInstanceType(group.size)) || /amazon mq|rabbitmq|active\s*mq/.test(serviceText(group)),
  compile(group, context) {
    const size = normalizedInstanceType(group.size);
    const text = serviceText(group);
    if (!MQ_INSTANCE.test(size)) return {
      serviceCode: 'AmazonMQ', filters: {} as Record<string, string>, basis: 'Amazon MQ was detected without a valid broker instance class.',
      calculatorUnsupported: 'Amazon MQ requires an explicit broker engine, topology, instance class, count and storage.', storageOwner: 'service-native',
    };
    if (!/rabbitmq/.test(text)) return {
      serviceCode: 'AmazonMQ', filters: { instanceType: size }, basis: 'The MQ engine was not explicitly identified as RabbitMQ.',
      calculatorUnsupported: 'The current deterministic MQ adapter requires an explicit RabbitMQ engine; ActiveMQ must use its own verified field set.', storageOwner: 'service-native',
    };
    const clustered = /3\s*node|cluster/.test(text);
    const brokers = Math.max(1, group.count);
    const perBrokerStorage = group.diskGb > 0 ? group.diskGb / brokers : 200;
    return {
      serviceCode: 'AmazonMQ', filters: { instanceType: size }, calculatorKey: 'amazonMQ',
      calculatorConfig: clustered ? {
        region: group.region || context.defaultRegion,
        rabbitBrokerType: '0',
        rabbitmqNumberOfClusteredBrokers: brokers,
        rabbitmqInstanceTypeClustered: size,
        rabbitmqstoragePerNodeClustered: fileSize(perBrokerStorage, 'gb|NA'),
        description: description(group, `${brokers} RabbitMQ 3-node cluster broker(s) ${size}`),
      } : {
        region: group.region || context.defaultRegion,
        rabbitBrokerType: '1',
        rabbitmqNumberOfBrokers: brokers,
        rabbitmqInstanceType: size,
        rabbitmqBrokerStorageType: 'Throughput optimized (EBS)',
        rabbitmqStoragePerBroker: fileSize(perBrokerStorage, 'gb|NA'),
        description: description(group, `${brokers} RabbitMQ single-instance broker(s) ${size}`),
      },
      basis: `RabbitMQ engine, ${clustered ? '3-node cluster' : 'single-instance'} topology, broker class, count and owned storage were read from canonical values.`,
      storageOwner: 'service-native',
      fingerprintFields: clustered
        ? ['rabbitBrokerType', 'rabbitmqNumberOfClusteredBrokers', 'rabbitmqInstanceTypeClustered', 'rabbitmqstoragePerNodeClustered']
        : ['rabbitBrokerType', 'rabbitmqNumberOfBrokers', 'rabbitmqInstanceType', 'rabbitmqBrokerStorageType', 'rabbitmqStoragePerBroker'],
    };
  },
};

const redshiftAdapter: CalculatorAdapter = {
  serviceFamily: 'Redshift Serverless', version: '2026-08-31', supportedCommitments: { onDemand: true },
  matches: (group) => /redshift/.test(serviceText(group)),
  compile(group, context) {
    const rpu = quantity(group, 'units/month', /rpu/i) || Number(/\brpu\D+(\d+)/i.exec(serviceText(group))?.[1]);
    const runtime = quantity(group, 'hours/month') || group.hoursPerMonth || 0;
    const storage = quantity(group, 'GB/month') || group.diskGb;
    if (!rpu || !runtime) return undefined;
    return {
      serviceCode: 'AmazonRedshift', filters: { productFamily: 'Serverless' },
      calculatorKey: 'amazonRedshift',
      calculatorConfig: {
        region: group.region || context.defaultRegion,
        select_Workload_size: rpu <= 16 ? 'small' : rpu <= 64 ? 'medium' : rpu <= 256 ? 'large' : 'extra_large',
        RPU_Size: String(rpu),
        Query_period: Math.min(24, runtime / 30),
        ...(storage ? { sizeOfManagedStorage: fileSize(storage, 'gb|NA') } : {}),
        description: description(group, `Redshift Serverless ${rpu} RPU`),
      },
      basis: `Redshift Serverless compiled from ${rpu} RPU, ${runtime} query hours/month and ${storage || 0} GB managed storage.`,
      storageOwner: 'service-native',
      fingerprintFields: ['select_Workload_size', 'RPU_Size', 'Query_period', 'sizeOfManagedStorage'],
    };
  },
};

const cloudFrontAdapter: CalculatorAdapter = {
  serviceFamily: 'CloudFront', version: '2026-08-31', supportedCommitments: { onDemand: true },
  matches: (group) => /cloudfront/.test(serviceText(group)),
  compile(group, context) {
    const transfer = quantity(group, 'GB-transfer/month');
    const requests = quantity(group, 'requests/month');
    if (!transfer && !requests) return undefined;
    const region = group.region || context.defaultRegion;
    const geography = cloudFrontGeography(region);
    return {
      serviceCode: 'AmazonCloudFront', filters: {}, calculatorKey: 'amazonCloudFront',
      calculatorConfig: {
        region,
        ...(transfer ? { [`dataTransferedToInternet_${geography}`]: fileSize(transfer) } : {}),
        ...(requests ? { [`numberOfHttpsRequests_${geography}`]: frequency(requests) } : {}),
        description: description(group, `CloudFront ${geography} traffic`),
      },
      basis: `CloudFront traffic compiled from canonical monthly transfer and HTTPS request quantities for the selected ${region} geography.`,
      storageOwner: 'none', fingerprintFields: [`dataTransferedToInternet_${geography}`, `numberOfHttpsRequests_${geography}`],
    };
  },
};

const natAdapter: CalculatorAdapter = {
  serviceFamily: 'NAT Gateway', version: '2026-08-31', supportedCommitments: { onDemand: true },
  matches: (group) => /nat gateway/.test(serviceText(group)),
  compile(group, context) {
    const transfer = quantity(group, 'GB-transfer/month') || quantity(group, 'GB/month');
    const profile = structuredDetail(group, 'nat_gateway.configuration');
    const mode = String(profile?.mode || '').toLowerCase();
    const azCount = numberField(profile, 'availabilityZoneCount', 'azCount');
    if (!/regional/.test(mode) || !azCount || azCount < 1 || azCount > 10) return {
      serviceCode: 'AmazonVPC', filters: {},
      basis: 'NAT Gateway was detected without a currently valid Regional NAT configuration.',
      calculatorUnsupported: /legacy/.test(mode)
        ? 'The deployed Calculator gateway currently rejects the documented zero-valued Regional NAT fields required by a legacy NAT estimate; it will not add a chargeable Regional NAT default as a workaround.'
        : 'NAT Gateway requires a confirmed Regional NAT mode and Availability Zone count before Calculator compilation.',
      storageOwner: 'none',
    };
    return {
      serviceCode: 'AmazonVPC', filters: {}, calculatorKey: 'networkAddressTranslationNatGatewayVpc',
      calculatorConfig: {
        region: group.region || context.defaultRegion,
        numberOfGateways: '0',
        dataProcessedPerNATGateway: fileSize(0),
        regionalNatGatewayCount: String(Math.max(1, group.count)),
        regionalNatGatewayAzCount: String(Math.round(azCount)),
        regionalNatGatewayDataProcessed: fileSize(transfer / Math.max(1, group.count)),
        description: description(group, `${Math.max(1, group.count)} Regional NAT Gateway(s)`),
      },
      basis: 'Regional NAT Gateway count, Availability Zones and owned data processing compiled from confirmed canonical values.',
      storageOwner: 'none', fingerprintFields: [
        'numberOfGateways', 'dataProcessedPerNATGateway',
        'regionalNatGatewayCount', 'regionalNatGatewayAzCount', 'regionalNatGatewayDataProcessed',
      ],
    };
  },
};

const apiGatewayAdapter: CalculatorAdapter = {
  serviceFamily: 'API Gateway', version: '2026-08-31', supportedCommitments: { onDemand: true },
  matches: (group) => /api gateway/.test(serviceText(group)),
  compile(group, context) {
    const requests = quantity(group, 'requests/month'); if (!requests) return undefined;
    const text = serviceText(group);
    const kind = /websocket/.test(text) ? 'websocket' : /\brest\b/.test(text) ? 'rest' : 'http';
    const requestField = kind === 'websocket' ? 'numberOfWSRequests' : kind === 'rest' ? 'numberOfRESTRequests' : 'numberOfAPIRequests';
    const multiplierField = kind === 'websocket' ? 'WebSocketMult' : kind === 'rest' ? 'RESTMult' : 'APIOpsMult';
    return {
      serviceCode: 'AmazonApiGateway', filters: {}, calculatorKey: 'amazonApiGateway',
      calculatorConfig: {
        region: group.region || context.defaultRegion,
        [multiplierField]: '1',
        [requestField]: frequency(requests),
        ...(kind === 'websocket' ? { msgSize: fileSize(32, 'kb|NA') } : {}),
        description: description(group, `API Gateway ${kind.toUpperCase()} API`),
      },
      basis: kind === 'http'
        ? 'HTTP API is the recorded deterministic default when the workbook states API Gateway requests without REST or WebSocket.'
        : `The workbook explicitly identifies ${kind} API traffic.`,
      storageOwner: 'none', fingerprintFields: [multiplierField, requestField, ...(kind === 'websocket' ? ['msgSize'] : [])],
    };
  },
};

const quickSightAdapter: CalculatorAdapter = {
  serviceFamily: 'QuickSight', version: '2026-08-31', supportedCommitments: { onDemand: true },
  matches: (group) => /quicksight/.test(serviceText(group)),
  compile(group, context) {
    const readers = quantity(group, 'units/month', /reader/i) || statedNumber(group, /readers?/);
    const authors = quantity(group, 'units/month', /author/i) || statedNumber(group, /authors?/);
    const profile = structuredDetail(group, 'quicksight.subscription_profile');
    const annualAuthorPercent = numberField(profile, 'annualAuthorPercent', 'percentAnnualAuthors');
    const monthlyAuthorPercent = numberField(profile, 'monthlyAuthorPercent', 'percentMonthlyAuthors');
    const spiceGb = numberField(profile, 'spiceGb', 'spiceGBs');
    if (!readers && !authors) return undefined;
    if (annualAuthorPercent === undefined || monthlyAuthorPercent === undefined
      || annualAuthorPercent < 0 || monthlyAuthorPercent < 0
      || annualAuthorPercent + monthlyAuthorPercent !== 100
      || spiceGb === undefined || spiceGb < 10 || !Number.isInteger(spiceGb)) return {
      serviceCode: 'AmazonQuickSight', filters: {},
      basis: 'QuickSight author and reader counts were detected, but its subscription profile is incomplete.',
      calculatorUnsupported: 'QuickSight requires confirmed annual/monthly author percentages totalling 100 and integer SPICE capacity of at least 10 GB.',
      storageOwner: 'service-native',
    };
    return {
      serviceCode: 'AmazonQuickSight', filters: {}, calculatorKey: 'amazonQuickSightReadersAuthorsSpice',
      calculatorConfig: {
        region: group.region || context.defaultRegion,
        numberOfReaders: String(readers),
        numberOfAuthors: String(authors),
        percentAnnualAuthors: annualAuthorPercent,
        percentMonthlyAuthors: monthlyAuthorPercent,
        spiceGBs: String(spiceGb),
        description: description(group, 'QuickSight readers and authors'),
      },
      basis: 'QuickSight author and reader counts come from separate canonical meters; author billing mix and SPICE capacity come from the confirmed structured requirement.',
      storageOwner: 'service-native',
      fingerprintFields: ['numberOfReaders', 'numberOfAuthors', 'percentAnnualAuthors', 'percentMonthlyAuthors', 'spiceGBs'],
    };
  },
};

const sesAdapter: CalculatorAdapter = {
  serviceFamily: 'SES', version: '2026-08-31', supportedCommitments: { onDemand: true },
  matches: (group) => /\bses\b|simple email/.test(serviceText(group)),
  compile(group, context) {
    const emails = quantity(group, 'units/month') || quantity(group, 'requests/month'); if (!emails) return undefined;
    const fromEc2 = /send_source[^|]*(?:ec2)|sent from ec2/.test(serviceText(group));
    const field = fromEc2 ? 'numberOfEmailMessagesSentFromEC2' : 'numberOfEmailMessagesSentFromEmailClient';
    return {
      serviceCode: 'AmazonSES', filters: {}, calculatorKey: 'amazonSimpleEmailService',
      calculatorConfig: { region: group.region || context.defaultRegion, [field]: frequency(emails), description: description(group, 'SES outbound email') },
      basis: fromEc2 ? 'SES send source was confirmed as EC2.' : 'Email client is the recorded deterministic default when the source is not stated.',
      storageOwner: 'none', fingerprintFields: [field],
    };
  },
};

const snsAdapter: CalculatorAdapter = {
  serviceFamily: 'SNS', version: '2026-08-31', supportedCommitments: { onDemand: true },
  matches: (group) => /\bsns\b|simple notification/.test(serviceText(group)),
  compile(group, context) {
    const notifications = quantity(group, 'units/month') || quantity(group, 'requests/month');
    const text = serviceText(group);
    const field = /mobile push|delivery_type[^|]*mobile/.test(text) ? 'numberOfMobilePushNotifications'
      : /delivery_type[^|]*http|https notifications?/.test(text) ? 'numberOfHTTPNotifications'
        : /delivery_type[^|]*email/.test(text) ? 'numberOfEmailNotifications'
          : /delivery_type[^|]*sqs/.test(text) ? 'numberOfSQSNotifications'
            : /delivery_type[^|]*lambda/.test(text) ? 'aws_Lambda' : undefined;
    if (!notifications || !field) return {
      serviceCode: 'AmazonSNS', filters: {} as Record<string, string>, basis: 'SNS was detected but its delivery channel is ambiguous.',
      calculatorUnsupported: 'SNS notification pricing requires a confirmed delivery type; SMS must use the Calculator SMS service rather than Standard Topics.',
      storageOwner: 'none',
    };
    return {
      serviceCode: 'AmazonSNS', filters: {}, calculatorKey: 'standardTopics',
      calculatorConfig: { region: group.region || context.defaultRegion, numberOfRequests: frequency(notifications), [field]: frequency(notifications), description: description(group, 'SNS Standard Topic') },
      basis: `SNS request and ${field} delivery counts use the confirmed delivery type.`, storageOwner: 'none', fingerprintFields: ['numberOfRequests', field],
    };
  },
};

const simpleUsageAdapters: CalculatorAdapter[] = [
  {
    serviceFamily: 'SQS', version: '2026-08-31', supportedCommitments: { onDemand: true },
    matches: (group) => /\bsqs\b|simple queue/.test(serviceText(group)),
    compile(group, context) {
      const requests = quantity(group, 'requests/month'); if (!requests) return undefined;
      const fifo = /\bfifo\b/.test(serviceText(group));
      return { serviceCode: 'AWSQueueService', filters: {}, calculatorKey: 'amazonSimpleQueueService',
        calculatorConfig: { region: group.region || context.defaultRegion, [fifo ? 'fifoQueueRequests' : 'standardQueueRequests']: frequency(requests), description: description(group, fifo ? 'SQS FIFO' : 'SQS Standard') },
        basis: fifo ? 'SQS FIFO queue type was explicit.' : 'SQS Standard is the deterministic default when FIFO is not stated.', storageOwner: 'none', fingerprintFields: [fifo ? 'fifoQueueRequests' : 'standardQueueRequests'] };
    },
  },
  {
    serviceFamily: 'EventBridge', version: '2026-08-31', supportedCommitments: { onDemand: true },
    matches: (group) => /eventbridge/.test(serviceText(group)),
    compile(group, context) { const events = quantity(group, 'requests/month') || quantity(group, 'units/month'); if (!events) return undefined; return {
      serviceCode: 'AmazonEventBridge', filters: {}, calculatorKey: 'amazonEventBridge', calculatorConfig: { region: group.region || context.defaultRegion, Size_of_the_payload: fileSize(1, 'kb|NA'), Number_of_custom_events: frequency(events), description: description(group, 'EventBridge custom events') },
      basis: 'EventBridge custom-event volume was explicit; 1 KB is the Calculator billing increment.', storageOwner: 'none', fingerprintFields: ['Size_of_the_payload', 'Number_of_custom_events'],
    }; },
  },
  {
    serviceFamily: 'Step Functions Standard', version: '2026-08-31', supportedCommitments: { onDemand: true },
    matches: (group) => /step functions?/.test(serviceText(group)),
    compile(group, context) { const transitions = quantity(group, 'units/month') || quantity(group, 'requests/month'); if (!transitions) return undefined; return {
      serviceCode: 'AWSStepFunctions', filters: {}, calculatorKey: 'stepFunctionStandard', calculatorConfig: { region: group.region || context.defaultRegion, numberOfExecutions: frequency(transitions), stateTransition: 1, description: description(group, 'Step Functions Standard transitions') },
      basis: 'Total state transitions are represented as one transition per execution; the saved Calculator multiplication is exactly the canonical monthly total.', storageOwner: 'none', fingerprintFields: ['numberOfExecutions', 'stateTransition'],
    }; },
  },
];

export const calculatorAdapterRegistry: readonly CalculatorAdapter[] = [
  fargateAdapter,
  cognitoAdapter,
  sageMakerAdapter,
  bedrockAdapter,
  loadBalancerAdapter,
  wafAdapter,
  memoryDbAdapter,
  mqAdapter,
  auroraAdapter,
  rdsAdapter,
  elasticacheAdapter,
  openSearchAdapter,
  redshiftAdapter,
  s3Adapter,
  lambdaAdapter,
  cloudFrontAdapter,
  natAdapter,
  apiGatewayAdapter,
  quickSightAdapter,
  sesAdapter,
  snsAdapter,
  ...simpleUsageAdapters,
  ec2Adapter,
];

export const ADAPTER_REGISTRY_VERSION = calculatorAdapterRegistry
  .map((adapter) => `${adapter.serviceFamily}@${adapter.version}`)
  .join('|');

export function compileWithCalculatorAdapter(
  group: ResourceGroup,
  context: AdapterContext,
): CompiledAdapterPlan | undefined {
  for (const adapter of calculatorAdapterRegistry) {
    if (!adapter.matches(group)) continue;
    const compiled = adapter.compile(group, context);
    if (compiled) return compiled;
  }
  return undefined;
}
