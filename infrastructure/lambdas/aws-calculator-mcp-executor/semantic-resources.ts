/**
 * From the pipeline's resource groups to the executor's semantic resources.
 *
 * This is the seam between MIMO's understanding of a workbook and the Calculator's
 * representation of it, and it is deliberately dull: it copies what the group says into the
 * semantic vocabulary the executor's mapper knows, preserving the source's own numbers and
 * periods. A count stated per day stays per day. A duration stated in hours stays in hours.
 * Nothing here converts to a month — the executor hands the Calculator the source figures and
 * the Calculator does its own arithmetic, so there is exactly one place that arithmetic
 * happens and it is not MIMO.
 *
 * The other thing it must not do is name a Calculator field. `instanceType`, `storageGb`,
 * `taskCount` are infrastructure words; `columnFormIPM` and `smallMemory_8` are not, and they
 * do not appear here.
 */

import type { PricingModelRequest } from '../../schema/estimate-plan';
import type { PricingScenarioKind, UpfrontPayment } from '../../schema/canonical-resource';
import type { CommitmentRequest } from '../shared/pricing-models';
import type { ResourceGroup } from '../calculator-orchestrator/prompt';
import type { PricingIntent, SemanticResource } from './types';

const numberOf = (value: unknown): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object' && 'originalValue' in (value as Record<string, unknown>)) {
    return numberOf((value as Record<string, unknown>).originalValue);
  }
  const parsed = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
};

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/** Period words to the frequency vocabulary the mapper matches against Calculator options. */
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

/** The database or cache engine a group names, in the Calculator's own wording. */
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

const isDatabaseOrCache = (group: ResourceGroup) => /rds|aurora|database|elasticache|redis|memorydb|opensearch|elasticsearch|documentdb|neptune|redshift/i.test(group.service || '')
  || /^(db|cache)\./i.test(String(group.size || ''))
  || /\.search\b/i.test(String(group.size || ''));

/**
 * The operating system as a licence statement: the family, plus the bundled SQL Server edition
 * when the sheet names one that is actually billed.
 *
 * Three exclusions matter, and each is a real mispricing: "BYOL" means the client already
 * holds the licence, so billing it again roughly doubles the machine; SQL Server Express is
 * free; and "MySQL" contains the letters "sql" and is not SQL Server at all.
 */
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
  const sqlServer = /sql\s*server|\bmssql\b|\bsql\s+(std|standard|ent|enterprise|web)\b/i.test(text) && !/mysql|postgres|nosql/i.test(text.replace(/sql\s*server/gi, ''));
  if (!sqlServer || byol || /express/i.test(text)) return family;
  const edition = /enterprise|\bent\b/i.test(text) ? 'Enterprise' : /\bweb\b/i.test(text) ? 'Web' : 'Standard';
  return `${family} with SQL Server ${edition}`;
}

const EC2_INSTANCE_TYPE = /^[a-z]\d[a-z\-]*\.(?:nano|micro|small|medium|large|xlarge|\d+xlarge|metal(?:-\d+xl)?)$/i;

/**
 * The AWS service a group is really about, in the name the Calculator uses.
 *
 * A sheet writes a service column however it likes — "EC2 with SQL Server Enterprise",
 * "Amazon EC2 - MySQL 8.0", "DB" — but the instance class is unambiguous: `m6a.xlarge` is
 * EC2, `db.r6g.large` is RDS, `cache.t4g.medium` is ElastiCache, `r7g.large.search` is
 * OpenSearch. Reading the class is infrastructure knowledge, not Calculator knowledge, and it
 * is what lets service resolution be an exact name match instead of a guess.
 */
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
  // Load balancers are named by kind: the Calculator has no "Elastic Load Balancing" service,
  // only the application, network, gateway and classic products.
  const balancer = `${service} ${size} ${(group.names || []).join(' ')}`;
  if (/load ?balanc|\balb\b|\bnlb\b|\bglb\b|\bclb\b|\belb\b/i.test(balancer)) {
    if (/network|\bnlb\b/i.test(balancer)) return 'Network Load Balancer';
    if (/gateway|\bglb\b/i.test(balancer)) return 'Gateway Load Balancer';
    if (/classic|\bclb\b/i.test(balancer)) return 'Classic Load Balancer';
    return 'Application Load Balancer';
  }
  if (EC2_INSTANCE_TYPE.test(size) || /\bec2\b/i.test(service)) return 'Amazon EC2';

  // Redshift Serverless is RPU-based with no provisioned instance class; provisioned uses
  // ra3.* and dc2.* nodes. Returning the specific name lets service resolution pick the
  // serverless Calculator schema — which has no instance-type requirement — without a model.
  if (/redshift/i.test(service)) {
    const hasRpu = (group.quantities || []).some((q) => q.unit === 'units/month' && /\brpu\b/i.test(q.basis || ''));
    const hasProvisionedSize = /^(ra3|dc2)\./i.test(size);
    if (hasRpu && !hasProvisionedSize) return 'Amazon Redshift Serverless';
  }

  return service;
}

/** The EBS volume type when the sheet names one; nothing is assumed when it does not. */
function storageTypeOf(group: ResourceGroup): string | undefined {
  const text = (group.details || []).join(' ');
  const match = /\b(gp3|gp2|io2|io1|st1|sc1)\b/i.exec(text);
  return match ? match[1].toLowerCase() : undefined;
}

/** A Fargate group's task semantics, from the canonical configuration when it carried one. */
function fargateConfiguration(group: ResourceGroup): Record<string, string | number> | undefined {
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

/**
 * The semantic configuration for one group.
 *
 * Reads the canonical quantities' ORIGINAL values and periods where they exist, and only falls
 * back to the monthly amount when the source stated a monthly figure in the first place.
 */
export function configurationOf(group: ResourceGroup): Record<string, string | number | boolean> {
  const config: Record<string, string | number | boolean> = {};
  const isFargate = /fargate/i.test(group.service || '');

  if (isFargate) {
    const task = fargateConfiguration(group);
    if (task) Object.assign(config, task);
    else {
      // No canonical task block: the group's own count and hours are the statement.
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
  // Redshift Serverless uses RPU capacity as its billing unit, not provisioned nodes. The
  // serverless schema has no instance-type or node-count field; carrying nodeCount would only
  // produce an unmapped key that misleads the model. Query hours per day is the operational
  // runtime the Calculator's own Query_period field expects (hours/day, 0–24).
  const isRedshiftServerless = /redshift/i.test(group.service || '')
    && (group.quantities || []).some((q) => q.unit === 'units/month' && /\brpu\b/i.test(q.basis || ''))
    && !/^(ra3|dc2)\./i.test(String(group.size || ''));

  // "r7g.large.search(2c16g)": the class is the class; the sheet's own annotation of its
  // vCPU and memory is not part of it.
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
    if (machine && group.count > 1) {
      // The Calculator's storage field is PER INSTANCE and it multiplies by the count itself;
      // the group's diskGb is the sum across its machines. Sending the sum would bill it
      // count times over — 4 x 400 GB for a group that has 400 GB in total.
      config.storageGbPerInstance = Math.round((group.diskGb / group.count) * 100) / 100;
    } else if (machine) {
      config.storageGbPerInstance = group.diskGb;
    } else {
      config.storageGb = group.diskGb;
    }
    const storageType = storageTypeOf(group);
    if (storageType) config.storageType = storageType;
  }

  for (const quantity of group.quantities || []) {
    const original = numberOf(quantity.originalValue);
    const period = periodWord(quantity.originalPeriod);
    switch (quantity.unit) {
      case 'GB/month':
        if (config.storageGb !== undefined || config.storageGbPerInstance !== undefined) break;
        // Canonical amounts are summed across the rows folded into the group. For a machine
        // group that sum is the estate's disk, and the Calculator's storage field is per
        // instance — so 11,737 GB across 37 servers is 317 GB each, not 11,737 each. That
        // exact mistake priced a workbook's storage 37 times over.
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
        // A count whose dimension only the basis text names ("monthly active users",
        // "notifications sent"). Carried with its basis so a model can place it; code will
        // not guess which Calculator field a bare "units" belongs to.
        config.usageCount = original ?? quantity.amount;
        config.usageFrequency = original !== undefined && period ? period : 'perMonth';
        config.usageBasis = quantity.basis;
        break;
      default:
        break;
    }
  }
  // Redshift Serverless expresses its operational runtime as hours of active query activity
  // per day (Calculator field: Query_period, range 0–24). Carry it from the workbook's own
  // hours/month figure so the field mapper does not have to ask.
  if (isRedshiftServerless) {
    const hoursPerMonth = group.hoursPerMonth ?? group.hoursPerDay * 30;
    const queryHoursPerDay = Math.min(24, Math.max(0, hoursPerMonth / 30));
    if (queryHoursPerDay > 0) config.queryHoursPerDay = queryHoursPerDay;
  }

  applyAnsweredRequirements(group, config);
  return config;
}

/** Review-answer keys whose wording differs from the semantic vocabulary's. */
const ANSWER_KEY_RENAMES: Record<string, string> = {
  durationMs: 'requestDurationMs',
  instancesPerEndpoint: 'instanceCount',
  multi_az: 'deployment',
};

const camel = (text: string) => text.replace(/[_\-\s]+([a-zA-Z0-9])/g, (_, letter: string) => letter.toUpperCase());

/**
 * Review and chat answers, from the resource's configuration onto semantic keys.
 *
 * A reviewer's answer is stored on the row under its requirement field —
 * `configuration['lambda.execution_profile'] = { memoryMb: 512, durationMs: 200 }` — and it is
 * the most authoritative statement about the resource there is: a person made it, in reply
 * to a question about exactly this gap. Every such answer becomes a semantic key. Keys the
 * vocabulary knows (memory, request duration, instance class, count) map by code; the rest
 * travel as stated for a model to place against the schema. Nothing is converted.
 */
function applyAnsweredRequirements(group: ResourceGroup, config: Record<string, string | number | boolean>): void {
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
      if (typeof value === 'number' || typeof value === 'string') {
        // An answer overrides what the sheet said: the question was asked because the sheet
        // was silent or ambiguous, and the person answering saw both.
        config[semanticKey] = value;
      }
    };
    const own = field.split('.').pop() || field;
    if (answer && typeof answer === 'object' && !Array.isArray(answer)) {
      const entries = Object.entries(answer as Record<string, unknown>);
      // The Review page's generic control stores a single answer as { value: X }; the key that
      // means something is the field's own name, not "value".
      if (entries.length === 1 && entries[0][0] === 'value') place(own, entries[0][1]);
      else for (const [key, value] of entries) place(key, value);
    } else {
      place(own, answer);
    }
  }
}

/** One line a reader recognises the group by. */
export function describeGroup(group: ResourceGroup): string {
  const parts = [
    group.count > 1 ? `${group.count} x` : '',
    group.size || group.service,
    group.os && !isDatabaseOrCache(group) ? group.os : '',
    group.names?.length ? `e.g. ${group.names.slice(0, 2).join(', ')}` : '',
  ].filter(Boolean);
  return parts.join(' ').slice(0, 140);
}

export interface GroupSemanticsInput {
  segmentKey: string;
  groups: ResourceGroup[];
  defaultRegion: string;
  /** The scenario's stated commitment, or undefined when the sheet's own cells decide. */
  commitment?: CommitmentRequest;
  /** A label for the scenario, written onto every resource. */
  scenarioLabel?: string;
}

export function toSemanticResources(input: GroupSemanticsInput): SemanticResource[] {
  return input.groups.map((group, index) => {
    const resource: SemanticResource = {
      resourceId: `${slug(input.segmentKey) || 'scenario'}-${index + 1}-${slug(group.size || group.service || 'resource')}`,
      service: serviceNameOf(group),
      region: group.region || input.defaultRegion,
      scenario: input.scenarioLabel,
      environment: group.environment,
      description: describeGroup(group),
      configuration: configurationOf(group),
    };
    if (!input.commitment) {
      const own = intentFromCommitment(parseSheetCommitment(group.purchaseModel));
      if (own.kind !== 'on-demand') resource.pricing = own;
    }
    return resource;
  });
}

/** Years and upfront from a sheet cell like "3-Yr Reserved Partial Upfront", or on-demand. */
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

const upfrontOf = (purchase: string | undefined): UpfrontPayment => (purchase === 'All Upfront' ? 'All' : purchase === 'Partial Upfront' ? 'Partial' : 'None');

/** A pipeline commitment request to the executor's pricing intent. Never substitutes. */
export function intentFromCommitment(commitment: CommitmentRequest | undefined): PricingIntent {
  if (!commitment || commitment.model === 'on-demand') return { kind: 'on-demand', upfrontPayment: 'None' };
  if (commitment.model === 'compute-savings-plan') {
    return { kind: commitment.years === 3 ? 'compute-savings-3yr' : 'compute-savings-1yr', upfrontPayment: 'None' };
  }
  const convertible = commitment.offeringClass === 'convertible';
  const kind: PricingScenarioKind = commitment.years === 3
    ? (convertible ? 'convertible-ri-3yr' : 'standard-ri-3yr')
    : (convertible ? 'convertible-ri-1yr' : 'standard-ri-1yr');
  return { kind, upfrontPayment: upfrontOf(commitment.purchase) };
}

/** The chat/plan vocabulary to the executor's pricing intent. Never substitutes. */
export function intentFromRequest(request: PricingModelRequest | string | undefined): PricingIntent | undefined {
  switch (request) {
    case 'on-demand': return { kind: 'on-demand', upfrontPayment: 'None' };
    case 'ri-1yr-no-upfront': return { kind: 'standard-ri-1yr', upfrontPayment: 'None' };
    case 'ri-1yr-partial-upfront': return { kind: 'standard-ri-1yr', upfrontPayment: 'Partial' };
    case 'ri-1yr-all-upfront': return { kind: 'standard-ri-1yr', upfrontPayment: 'All' };
    case 'ri-3yr-no-upfront': return { kind: 'standard-ri-3yr', upfrontPayment: 'None' };
    case 'ri-3yr-partial-upfront': return { kind: 'standard-ri-3yr', upfrontPayment: 'Partial' };
    case 'ri-3yr-all-upfront': return { kind: 'standard-ri-3yr', upfrontPayment: 'All' };
    case 'compute-savings-1yr': return { kind: 'compute-savings-1yr', upfrontPayment: 'None' };
    case 'compute-savings-3yr': return { kind: 'compute-savings-3yr', upfrontPayment: 'None' };
    default: return undefined; // 'sheet-specified' and unknown: each resource carries its own
  }
}
