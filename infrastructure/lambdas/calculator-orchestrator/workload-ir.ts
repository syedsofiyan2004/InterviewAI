/**
 * MIMO-side workload IR conversion.
 *
 * This module owns the boundary between MIMO's internal ResourceGroup representation
 * and the CanonicalWorkloadIR contract the executor accepts.
 *
 * MIMO owns this layer. The executor must never import ResourceGroup or
 * calculator-orchestrator modules. Everything below stays on the MIMO side.
 *
 * Flow:
 *   ResourceGroup[] (groupResources output)
 *       ↓
 *   toCanonicalWorkloadIR(groups, options)
 *       ↓
 *   CanonicalWorkloadIR  ← executor contract
 *       ↓
 *   executeScenario(workload, mcp)   ← executor converts internally
 */

import type { CommitmentRequest } from '../shared/pricing-models';
import type { ResourceGroup } from './prompt';
import type {
  CanonicalWorkloadIR,
  CanonicalWorkloadResource,
  CanonicalWorkloadUsageItem,
  PricingIntent,
} from '../aws-calculator-mcp-executor/types';

// ─── Private helpers (copied from old semantic-resources.ts) ─────────────────

const numberOf = (value: unknown): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object' && 'originalValue' in (value as Record<string, unknown>)) {
    return numberOf((value as Record<string, unknown>).originalValue);
  }
  const parsed = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
};

const slug = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

const periodWord = (period: unknown): string | undefined => {
  const text = String(period || '').toLowerCase();
  if (!text) return undefined;
  if (/day/.test(text)) return 'perDay';
  if (/hour/.test(text)) return 'perHour';
  if (/minute/.test(text)) return 'perMinute';
  if (/second/.test(text)) return 'perSecond';
  if (/week/.test(text)) return 'perWeek';
  if (/month/.test(text)) return 'perMonth';
  if (/year|annual/.test(text)) return 'perYear';
  return undefined;
};

function engineOf(group: ResourceGroup): string | undefined {
  const text = `${group.service || ''} ${group.os || ''} ${(group.details || []).join(' ')}`.toLowerCase();
  if (/aurora/.test(text)) return /mysql/.test(text) ? 'Aurora MySQL' : 'Aurora PostgreSQL';
  if (/postgres/.test(text)) return 'PostgreSQL';
  if (/mysql/.test(text)) return 'MySQL';
  if (/maria/.test(text)) return 'MariaDB';
  if (/oracle/.test(text)) return 'Oracle';
  if (/sql\s*server|mssql/.test(text)) return 'SQL Server';
  if (/valkey/.test(text)) return 'Valkey';
  if (/memcached/.test(text)) return 'Memcached';
  if (/redis/.test(text)) return 'Redis';
  return undefined;
}

const isDatabaseOrCache = (group: ResourceGroup) =>
  /rds|aurora|database|elasticache|redis|memorydb|opensearch|elasticsearch|documentdb|neptune|redshift/i.test(group.service || '')
  || /^(db|cache)\./i.test(String(group.size || ''))
  || /\.search\b/i.test(String(group.size || ''));

export function operatingSystemOf(group: ResourceGroup): string | undefined {
  const os = String(group.os || '').trim();
  const text = `${os} ${group.service || ''} ${(group.details || []).join(' ')}`;
  const family = /windows|win\b/i.test(os) ? 'Windows'
    : /rhel|red\s*hat/i.test(os) ? 'RHEL'
      : /suse/i.test(os) ? 'SUSE'
        : /ubuntu pro/i.test(os) ? 'Ubuntu Pro'
          : /linux|ubuntu|debian|centos|amazon linux|rocky|alma/i.test(os) ? 'Linux'
            : os || undefined;
  if (!family) return undefined;
  const byol = /\bbyol\b|bring your own|licen[cs]e included: no|own licen[cs]e/i.test(text);
  const sqlServer = /sql\s*server|\bmssql\b|\bsql\s+(std|standard|ent|enterprise|web)\b/i.test(text)
    && !/mysql|postgres|nosql/i.test(text.replace(/sql\s*server/gi, ''));
  if (!sqlServer || byol || /express/i.test(text)) return family;
  const edition = /enterprise|\bent\b/i.test(text) ? 'Enterprise' : /\bweb\b/i.test(text) ? 'Web' : 'Standard';
  return `${family} with SQL Server ${edition}`;
}

const EC2_INSTANCE_TYPE = /^[a-z]\d[a-z\-]*\.(?:nano|micro|small|medium|large|xlarge|\d+xlarge|metal(?:-\d+xl)?)$/i;

export function serviceNameOf(group: ResourceGroup): string {
  const service = String(group.service || '').trim();
  const size = String(group.size || '').trim();
  const engine = engineOf(group);
  const cacheEngine = engine !== undefined && /redis|valkey|memcached/i.test(engine);
  if (/fargate/i.test(service)) return 'AWS Fargate';
  if (/memorydb/i.test(service) || (/^db\./i.test(size) && cacheEngine)) return 'Amazon MemoryDB';
  if (/^cache\./i.test(size) || /elasticache/i.test(service) || (cacheEngine && !/^db\./i.test(size) && !EC2_INSTANCE_TYPE.test(size))) return 'Amazon ElastiCache';
  if (/^db\./i.test(size) || /\brds\b|aurora/i.test(service)) {
    if (engine?.startsWith('Aurora')) return `Amazon ${engine}-Compatible`;
    if (engine) return `Amazon RDS for ${engine}`;
    return /^db\./i.test(size) ? 'Amazon RDS' : service;
  }
  if (/\.search$/i.test(size.replace(/\(.*?\)/g, '').trim()) || /opensearch|elasticsearch/i.test(service)) return 'Amazon OpenSearch Service';
  if (/^mq\./i.test(size) || /\bamazon mq\b|rabbitmq|activemq/i.test(service)) return 'Amazon MQ';
  const balancer = `${service} ${size} ${(group.names || []).join(' ')}`;
  if (/load ?balanc|\balb\b|\bnlb\b|\bglb\b|\bclb\b|\belb\b/i.test(balancer)) {
    if (/network|\bnlb\b/i.test(balancer)) return 'Network Load Balancer';
    if (/gateway|\bglb\b/i.test(balancer)) return 'Gateway Load Balancer';
    if (/classic|\bclb\b/i.test(balancer)) return 'Classic Load Balancer';
    return 'Application Load Balancer';
  }
  if (EC2_INSTANCE_TYPE.test(size) || /\bec2\b/i.test(service)) return 'Amazon EC2';
  if (/redshift/i.test(service)) {
    const hasRpu = (group.quantities || []).some((q) => q.unit === 'units/month' && /\brpu\b/i.test(q.basis || ''));
    const hasProvisionedSize = /^(ra3|dc2)\./i.test(size);
    if (hasRpu && !hasProvisionedSize) return 'Amazon Redshift Serverless';
  }
  return service;
}

function storageTypeOf(group: ResourceGroup): string | undefined {
  const text = (group.details || []).join(' ');
  const match = /\b(gp3|gp2|io2|io1|st1|sc1)\b/i.exec(text);
  return match ? match[1].toLowerCase() : undefined;
}

function fargateConfig(group: ResourceGroup): Record<string, string | number> | undefined {
  const task = (group.configuration as { fargateTask?: Record<string, unknown> } | undefined)?.fargateTask;
  if (!task) return undefined;
  const out: Record<string, string | number> = {};
  const count = task.taskCount as { originalValue?: unknown; originalPeriod?: string } | undefined;
  const taskCount = numberOf(count?.originalValue);
  if (taskCount !== undefined) {
    out.taskCount = taskCount;
    out.taskFrequency = periodWord(count?.originalPeriod) || String(task.taskFrequency || 'perMonth');
  }
  const vcpu = numberOf((task.vcpuPerTask as Record<string, unknown> | undefined)?.originalValue);
  if (vcpu !== undefined) out.vcpuPerTask = vcpu;
  const memory = numberOf((task.memoryGbPerTask as Record<string, unknown> | undefined)?.originalValue);
  if (memory !== undefined) out.memoryGbPerTask = memory;
  const duration = task.taskDuration as { originalValue?: unknown; originalUnit?: string } | undefined;
  const durationValue = numberOf(duration?.originalValue);
  if (durationValue !== undefined) {
    out.duration = durationValue;
    out.durationUnit = String(duration?.originalUnit || 'hours');
  }
  return out;
}

const ANSWER_KEY_RENAMES: Record<string, string> = {
  durationMs: 'requestDurationMs',
  instancesPerEndpoint: 'instanceCount',
  multi_az: 'deployment',
};
const camel = (text: string) =>
  text.replace(/[_\-\s]+([a-zA-Z0-9])/g, (_, letter: string) => letter.toUpperCase());

function applyAnsweredRequirements(
  group: ResourceGroup,
  config: Record<string, string | number | boolean>,
): void {
  for (const [field, answer] of Object.entries(group.configuration || {})) {
    if (!field.includes('.') || field === 'resource.exclude' || answer === undefined || answer === null) continue;
    const place = (key: string, value: unknown) => {
      if (value === undefined || value === null || value === '') return;
      const semanticKey = ANSWER_KEY_RENAMES[key] || camel(key);
      if (typeof value === 'boolean') {
        if (semanticKey === 'deployment') config.deployment = value ? 'Multi-AZ' : 'Single-AZ';
        else config[semanticKey] = value;
        return;
      }
      if (typeof value === 'number' || typeof value === 'string') config[semanticKey] = value;
    };
    const own = field.split('.').pop() || field;
    if (answer && typeof answer === 'object' && !Array.isArray(answer)) {
      const entries = Object.entries(answer as Record<string, unknown>);
      if (entries.length === 1 && entries[0][0] === 'value') place(own, entries[0][1]);
      else for (const [key, value] of entries) place(key, value);
    } else {
      place(own, answer);
    }
  }
}

export function configurationOf(group: ResourceGroup): Record<string, string | number | boolean> {
  const config: Record<string, string | number | boolean> = {};
  const isFargate = /fargate/i.test(group.service || '');
  if (isFargate) {
    const task = fargateConfig(group);
    if (task) Object.assign(config, task);
    else {
      config.taskCount = group.count;
      config.taskFrequency = 'perMonth';
      if (group.vcpu !== undefined) config.vcpuPerTask = group.vcpu;
      if (group.ramGb !== undefined) config.memoryGbPerTask = group.ramGb;
      config.duration = group.hoursPerMonth ?? Math.round(group.hoursPerDay * 30.42);
      config.durationUnit = 'hours';
    }
    return config;
  }

  const machine = Boolean(group.size || group.vcpu !== undefined);
  const isRedshiftServerless = /redshift/i.test(group.service || '')
    && (group.quantities || []).some((q) => q.unit === 'units/month' && /\brpu\b/i.test(q.basis || ''))
    && !/^(ra3|dc2)\./i.test(String(group.size || ''));

  if (group.size) config.instanceType = String(group.size).replace(/\s*\(.*?\)\s*/g, ' ').trim();
  if (isDatabaseOrCache(group) && !isRedshiftServerless) config.nodeCount = group.count;
  else if (!isRedshiftServerless && machine) config.instanceCount = group.count;
  const os = operatingSystemOf(group);
  if (os && !isDatabaseOrCache(group)) config.operatingSystem = os;
  const engine = engineOf(group);
  if (engine && isDatabaseOrCache(group)) config.engine = engine;
  if (isDatabaseOrCache(group)) {
    const text = (group.details || []).join(' ');
    if (/multi-?az/i.test(text)) config.deployment = 'Multi-AZ';
    else if (/single-?az/i.test(text)) config.deployment = 'Single-AZ';
  }
  if (group.hoursPerDay && group.hoursPerDay < 24) config.hoursPerDay = group.hoursPerDay;
  if (group.diskGb > 0) {
    if (machine && group.count > 1) config.storageGbPerInstance = Math.round((group.diskGb / group.count) * 100) / 100;
    else if (machine) config.storageGbPerInstance = group.diskGb;
    else config.storageGb = group.diskGb;
    const storageType = storageTypeOf(group);
    if (storageType) config.storageType = storageType;
  }

  for (const quantity of group.quantities || []) {
    const original = numberOf(quantity.originalValue);
    const period = periodWord(quantity.originalPeriod);
    switch (quantity.unit) {
      case 'GB/month':
        if (config.storageGb !== undefined || config.storageGbPerInstance !== undefined) break;
        if (machine && group.count > 1) config.storageGbPerInstance = Math.round((quantity.amount / group.count) * 100) / 100;
        else if (machine) config.storageGbPerInstance = original ?? quantity.amount;
        else config.storageGb = original ?? quantity.amount;
        break;
      case 'GB-transfer/month':
        config.dataTransferGb = original ?? quantity.amount;
        break;
      case 'requests/month':
      case 'invocations/month':
        config.requestCount = original ?? quantity.amount;
        config.requestFrequency = original !== undefined && period ? period : 'perMonth';
        break;
      case 'units/month':
        config.usageCount = original ?? quantity.amount;
        config.usageFrequency = original !== undefined && period ? period : 'perMonth';
        config.usageBasis = quantity.basis;
        break;
      default: break;
    }
  }

  if (isRedshiftServerless) {
    const hoursPerMonth = group.hoursPerMonth ?? group.hoursPerDay * 30;
    const queryHoursPerDay = Math.min(24, Math.max(0, hoursPerMonth / 30));
    if (queryHoursPerDay > 0) config.queryHoursPerDay = queryHoursPerDay;
  }

  applyAnsweredRequirements(group, config);
  return config;
}

export function describeGroup(group: ResourceGroup): string {
  const parts = [
    group.count > 1 ? `${group.count} x` : '',
    group.size || group.service,
    group.os && !isDatabaseOrCache(group) ? group.os : '',
    group.names?.length ? `e.g. ${group.names.slice(0, 2).join(', ')}` : '',
  ].filter(Boolean);
  return parts.join(' ').slice(0, 140);
}

// ─── Pricing helpers ──────────────────────────────────────────────────────────

function upfrontOf(purchase: string | undefined): 'None' | 'Partial' | 'All' {
  return purchase === 'All Upfront' ? 'All' : purchase === 'Partial Upfront' ? 'Partial' : 'None';
}

export function parseSheetCommitment(purchaseModel: string | undefined): CommitmentRequest {
  const text = String(purchaseModel || '').toLowerCase();
  const years: 1 | 3 | undefined = /\b3\s*[-\s]?(yr|year)/.test(text) ? 3 : /\b1\s*[-\s]?(yr|year)/.test(text) ? 1 : undefined;
  const committed = /reserv|\bri\b|savings?\s*plan|\bsp\b|\bcsp\b|commit|upfront/.test(text);
  if (!committed && !years) return { model: 'on-demand' };
  const savings = /savings?\s*plan|\bcsp\b/.test(text) && !/reserv|\bri\b/.test(text);
  if (savings) return { model: 'compute-savings-plan', years: years ?? 1 };
  const purchase = /all\s*upfront/.test(text) ? 'All Upfront' : /partial\s*upfront/.test(text) ? 'Partial Upfront' : 'No Upfront';
  return { model: 'reserved', years: years ?? 1, purchase, offeringClass: /convertible/.test(text) ? 'convertible' : 'standard' };
}

export function intentFromCommitment(commitment: CommitmentRequest | undefined): PricingIntent {
  if (!commitment || commitment.model === 'on-demand') return { kind: 'on-demand', upfrontPayment: 'None' };
  if (commitment.model === 'compute-savings-plan') {
    return { kind: commitment.years === 3 ? 'compute-savings-3yr' : 'compute-savings-1yr', upfrontPayment: 'None' };
  }
  const convertible = commitment.offeringClass === 'convertible';
  const kind = commitment.years === 3
    ? (convertible ? 'convertible-ri-3yr' as const : 'standard-ri-3yr' as const)
    : (convertible ? 'convertible-ri-1yr' as const : 'standard-ri-1yr' as const);
  return { kind, upfrontPayment: upfrontOf(commitment.purchase) };
}

// ─── CanonicalWorkloadIR conversion ───────────────────────────────────────────

export interface WorkloadIROptions {
  segmentKey: string;
  estimateName: string;
  defaultRegion: string;
  /** Scenario-level commitment overrides per-resource purchase models when set. */
  commitment?: CommitmentRequest;
  scenarioLabel?: string;
}

/**
 * Converts the pipeline's ResourceGroup[] to a CanonicalWorkloadIR.
 *
 * This is the MIME side of the boundary. The result is passed directly to
 * executeScenario; the executor converts it internally to SemanticResource[]
 * without ever importing ResourceGroup.
 */
export function toCanonicalWorkloadIR(
  groups: ResourceGroup[],
  options: WorkloadIROptions,
): CanonicalWorkloadIR {
  const resources: CanonicalWorkloadResource[] = groups.map((group, index): CanonicalWorkloadResource => {
    const serviceIntent = serviceNameOf(group);
    const cfg = configurationOf(group);
    const resourceId = `${slug(options.segmentKey) || 'scenario'}-${index + 1}-${slug(group.size || group.service || 'resource')}`;

    // Extract usage metrics from config keys
    const usage: CanonicalWorkloadUsageItem[] = [];
    if (typeof cfg.storageGb === 'number') usage.push({ metric: 'storage', amount: cfg.storageGb, unit: 'GB' });
    if (typeof cfg.storageGbPerInstance === 'number') usage.push({ metric: 'storagePerInstance', amount: cfg.storageGbPerInstance, unit: 'GB' });
    if (typeof cfg.requestCount === 'number') usage.push({ metric: 'requests', amount: cfg.requestCount, unit: String(cfg.requestFrequency || 'perMonth') });
    if (typeof cfg.dataTransferGb === 'number') usage.push({ metric: 'dataTransfer', amount: cfg.dataTransferGb, unit: 'GB' });
    if (typeof cfg.usageCount === 'number') usage.push({ metric: String(cfg.usageBasis || 'usage'), amount: cfg.usageCount, unit: String(cfg.usageFrequency || 'perMonth') });

    // Extract sizing from config
    const sizing: CanonicalWorkloadResource['sizing'] = {};
    if (typeof cfg.instanceType === 'string') sizing.instanceType = cfg.instanceType;
    const count = (cfg.instanceCount ?? cfg.nodeCount ?? (typeof cfg.taskCount === 'number' ? cfg.taskCount : undefined)) as number | undefined;
    if (count !== undefined) sizing.count = count;
    if (typeof cfg.vcpuPerTask === 'number') sizing.vcpu = cfg.vcpuPerTask;
    if (typeof cfg.memoryGbPerTask === 'number') sizing.memoryGb = cfg.memoryGbPerTask;

    // Runtime
    const runtime: CanonicalWorkloadResource['runtime'] = {};
    if (typeof cfg.hoursPerDay === 'number') runtime.hoursPerDay = cfg.hoursPerDay;
    if (typeof cfg.queryHoursPerDay === 'number') runtime.hoursPerDay = cfg.queryHoursPerDay;

    // Attributes (anything else in cfg that isn't a standard field)
    const stdKeys = new Set(['instanceType', 'instanceCount', 'nodeCount', 'taskCount', 'taskFrequency', 'vcpuPerTask', 'memoryGbPerTask', 'operatingSystem', 'engine', 'deployment', 'hoursPerDay', 'queryHoursPerDay', 'storageGb', 'storageGbPerInstance', 'requestCount', 'requestFrequency', 'dataTransferGb', 'usageCount', 'usageBasis', 'usageFrequency', 'storageType', 'tenancy', 'duration', 'durationUnit']);
    const attributes: Record<string, string | number | boolean> = {};
    for (const [key, val] of Object.entries(cfg)) {
      if (!stdKeys.has(key) && (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean')) {
        attributes[key] = val;
      }
    }

    // Pricing intent: scenario commitment overrides per-resource purchase model
    const own = intentFromCommitment(parseSheetCommitment(group.purchaseModel));
    const pricingIntent: CanonicalWorkloadResource['pricingIntent'] = options.commitment
      ? toPricingIntentModel(intentFromCommitment(options.commitment))
      : toPricingIntentModel(own);

    // Source evidence
    const sourceEvidence = group.names?.slice(0, 4).map((name) => ({ label: 'source name', value: name })) || [];

    return {
      id: resourceId,
      environment: group.environment,
      serviceIntent,
      region: group.region || options.defaultRegion,
      sizing,
      runtime,
      usage,
      pricingIntent,
      attributes,
      sourceEvidence,
    };
  });

  return {
    version: '1.0',
    estimate: {
      name: options.estimateName,
      partition: 'aws',
      defaultRegion: options.defaultRegion,
    },
    resources,
  };
}

function toPricingIntentModel(intent: PricingIntent): CanonicalWorkloadResource['pricingIntent'] {
  const kind = intent.kind;
  if (kind === 'on-demand') return { model: 'on-demand' };
  if (kind === 'spot') return { model: 'spot' };
  if (kind.startsWith('compute-savings')) return { model: 'compute-savings-plan', term: kind.includes('3yr') ? 3 : 1 };
  if (kind.startsWith('ec2-instance-savings')) return { model: 'ec2-instance-savings-plan', term: kind.includes('3yr') ? 3 : 1 };
  const term: 1 | 3 = kind.includes('3yr') ? 3 : 1;
  const paymentOption = intent.upfrontPayment === 'All' ? 'all' as const : intent.upfrontPayment === 'Partial' ? 'partial' as const : 'none' as const;
  return { model: 'reserved', term, paymentOption };
}
