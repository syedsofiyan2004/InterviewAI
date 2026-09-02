import { createHash } from 'crypto';

import type {
  ExecutionManifest,
  RequirementCheck,
  RequirementConstraint,
} from '../../schema/estimate-plan';
import { stableHash } from '../shared/estimate-planning';

export interface ManifestServiceInput {
  resourceIds: string[];
  serviceCode: string;
  calculatorService?: string;
  group: string;
  description: string;
  config?: Record<string, unknown>;
  fingerprintFields?: string[];
  requestedPricing: string;
  resolvedPricing: string;
  pricingStatus: 'EXACT' | 'MIXED' | 'UNSUPPORTED';
  pricingReason?: string;
}

export interface SavedServiceSnapshot {
  group: string;
  description: string;
  calculatorService?: string;
  config: Record<string, unknown>;
}

export interface SavedEstimateSnapshot {
  services: SavedServiceSnapshot[];
  monthly?: number;
  upfront?: number;
  total12Months?: number;
  raw: unknown;
  hash: string;
}

function criticalFields(config: Record<string, unknown>, fields?: string[]): Record<string, unknown> {
  const selected = fields || Object.keys(config).filter((key) => !['region', 'description'].includes(key));
  return Object.fromEntries(selected.filter((key) => config[key] !== undefined).map((key) => [key, config[key]]));
}

export function createExecutionManifest(input: {
  scenarioId: string;
  planRevisionId: string;
  inputHash: string;
  constraints: RequirementConstraint[];
  services: ManifestServiceInput[];
}): ExecutionManifest {
  const base = {
    scenarioId: input.scenarioId,
    planRevisionId: input.planRevisionId,
    inputHash: input.inputHash,
    expectedResources: input.services.map((service) => ({
      id: service.resourceIds.join(','),
      serviceCode: service.serviceCode,
      calculatorService: service.calculatorService || '',
      group: service.group,
      description: service.description,
      criticalFields: criticalFields(service.config || {}, service.fingerprintFields),
    })),
    constraints: input.constraints,
    pricingResolution: input.services.flatMap((service) => service.resourceIds.map((resourceId) => ({
      resourceId,
      requested: service.requestedPricing,
      resolved: service.resolvedPricing,
      status: service.pricingStatus,
      ...(service.pricingReason ? { reason: service.pricingReason } : {}),
    }))),
  };
  return { ...base, manifestHash: stableHash(base) };
}

function numeric(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstNumber(value: unknown, ...paths: string[]): number | undefined {
  for (const path of paths) {
    const result = numeric(path.split('.').reduce<any>((current, key) => current?.[key], value as any));
    if (result !== undefined) return result;
  }
  return undefined;
}

function flattenServices(parsed: any): SavedServiceSnapshot[] {
  const services: SavedServiceSnapshot[] = [];
  const normalizedComponents = (components: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(
    Object.entries(components).map(([key, value]) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        if (Object.keys(record).length === 1 && 'value' in record && !Array.isArray(record.value)
          && (record.value === null || typeof record.value !== 'object')) return [key, record.value];
      }
      return [key, value];
    }),
  );
  const append = (groupName: string, serviceKey: string, service: any, parent?: any): void => {
    const source = (service?.config && typeof service.config === 'object')
      ? service.config
      : (service?.calculationComponents && typeof service.calculationComponents === 'object')
        ? normalizedComponents(service.calculationComponents)
        : undefined;
    if (!source) return;
    const config = {
      ...source,
      ...(service?.region || parent?.region ? { region: service?.region || parent.region } : {}),
      ...(service?.description || parent?.description
        ? { description: service?.description || parent.description }
        : {}),
    };
    services.push({
      group: groupName,
      description: String(config.description ?? ''),
      calculatorService: String(service?.service ?? service?.serviceCode ?? service?.calculatorService ?? serviceKey),
      config,
    });
  };
  for (const [groupKey, group] of Object.entries<any>(parsed?.groups || {})) {
    const groupName = String(group?.name ?? groupKey);
    for (const [serviceKey, service] of Object.entries<any>(group?.services || {})) {
      if (Array.isArray(service?.subServices) && service.subServices.length) {
        service.subServices.forEach((child: any, index: number) => append(groupName, `${serviceKey}:${index}`, child, service));
      } else append(groupName, serviceKey, service);
    }
  }
  return services;
}

export function parseSavedEstimateSnapshot(text: string): SavedEstimateSnapshot {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('SAVED_ESTIMATE_NOT_JSON');
  const parsed = JSON.parse(text.slice(start));
  const services = flattenServices(parsed);
  const monthly = firstNumber(parsed, 'monthly', 'monthlyTotal', 'totals.monthly', 'estimate.monthlyCost');
  const upfront = firstNumber(parsed, 'upfront', 'upfrontTotal', 'totals.upfront', 'estimate.upfrontCost');
  const total12Months = firstNumber(parsed, 'total12Months', 'total_12_months', 'totals.total12Months');
  return {
    services,
    ...(monthly === undefined ? {} : { monthly }),
    ...(upfront === undefined ? {} : { upfront }),
    ...(total12Months === undefined ? {} : { total12Months }),
    raw: parsed,
    hash: createHash('sha256').update(JSON.stringify(parsed)).digest('hex'),
  };
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) return Number(value);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => [key, normalize(child)]));
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function normalizePurchaseModel(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim().toLowerCase();
  if (text === 'on-demand' || /\bon[ -]?demand\b/.test(text)) return 'on-demand';
  if (/compute.*savings/.test(text)) return /3\s*(?:year|yr)/.test(text)
    ? 'compute-savings-3yr' : 'compute-savings-1yr';
  if (!/\b(?:reserved|ri)\b/.test(text)) return value;
  const years = /3\s*(?:year|yr)/.test(text) ? 3 : 1;
  const upfront = /all[ -]?upfront/.test(text)
    ? 'all-upfront'
    : /partial[ -]?upfront/.test(text) ? 'partial-upfront' : 'no-upfront';
  return `ri-${years}yr-${upfront}`;
}

function comparable(field: string, value: unknown): unknown {
  if (field === 'resource.region') {
    const region = (entry: unknown) => {
      const text = String(entry || '').trim().toLowerCase();
      const aliases: Record<string, string> = {
        'asia pacific (mumbai)': 'ap-south-1', mumbai: 'ap-south-1',
        'us east (n. virginia)': 'us-east-1', 'n. virginia': 'us-east-1',
        'europe (frankfurt)': 'eu-central-1', frankfurt: 'eu-central-1',
      };
      return aliases[text] || text;
    };
    return Array.isArray(value) ? value.map(region) : region(value);
  }
  if (field === 'resource.purchase_model' || field === 'scenario.purchase_model') {
    return normalizePurchaseModel(value);
  }
  return value;
}

function servicesForConstraint(
  constraint: RequirementConstraint,
  services: SavedServiceSnapshot[],
  manifest: ExecutionManifest,
): SavedServiceSnapshot[] {
  const resourceIds = constraint.scope
    .filter((scope) => scope.startsWith('resource:'))
    .map((scope) => scope.slice('resource:'.length));
  if (!resourceIds.length) return services;
  const expected = manifest.expectedResources.filter((entry) => {
    const ids = entry.id.split(',');
    return resourceIds.some((id) => ids.includes(id));
  });
  return services.filter((service) => expected.some((entry) => (
    entry.group === service.group
      && (!entry.calculatorService || entry.calculatorService === service.calculatorService)
  )));
}

function actualField(
  constraint: RequirementConstraint,
  services: SavedServiceSnapshot[],
  manifest: ExecutionManifest,
): unknown {
  const field = constraint.field;
  const configs = servicesForConstraint(constraint, services, manifest).map((service) => service.config);
  const values = (key: string) => configs.map((config) => config[key]).filter((value) => value !== undefined);
  if (field === 'resource.region') return values('region');
  if (field === 'resource.instance_type') {
    return configs.flatMap((config: any) => [
      config.instanceType,
      ...(config.columnFormIPM?.value || []).map((row: any) => row['Instance Type']?.value),
      ...(config.columnFormIPM?.value || []).map((row: any) => row['Instance Name']?.value),
      ...(config.columnFormIPM_1?.value || []).map((row: any) => row['Instance Type']?.value),
      config.rabbitmqInstanceType,
      config.rabbitmqInstanceTypeClustered,
    ]).filter(Boolean);
  }
  if (field === 'resource.count') {
    return configs.flatMap((config: any) => [
      numeric(config.workload),
      ...(config.columnFormIPM?.value || []).map((row: any) => numeric(row['Number of Nodes']?.value)),
      ...(config.columnFormIPM_1?.value || []).map((row: any) => numeric(row['Number of Nodes Data instance']?.value)),
      numeric(config.rabbitmqNumberOfBrokers),
      numeric(config.rabbitmqNumberOfClusteredBrokers),
      numeric(config.numberOfApplicationLoadBalancers),
      numeric(config.numberOfNetworkLoadBalancers),
    ]).filter((value) => value !== undefined);
  }
  if (field === 'resource.hours_per_month') {
    return configs.map((config) => numeric(config.utilization)).filter((value): value is number => value !== undefined)
      .map((pct) => Math.round(730 * pct) / 100);
  }
  if (field === 'resource.purchase_model' || field === 'scenario.purchase_model') {
    return manifest.pricingResolution.map((entry) => entry.resolved);
  }
  if (field === 'database.multi_az') {
    return [
      ...configs.flatMap((config: any) => [config.multiAZ, config.multiAz, config['Multi-AZ']])
        .filter((value) => value !== undefined),
      ...servicesForConstraint(constraint, services, manifest)
        .filter((service) => /aurora/i.test(String(service.calculatorService || '')))
        .map(() => true),
    ];
  }
  if (field === 'fargate.task_frequency_per_day') return values('tasksPerDay');
  const fingerprintValidatedFields = new Set([
    'database.engine', 'api_gateway.api_type', 'sns.delivery_type', 'ses.send_source',
    'cognito.tier', 'bedrock.model', 'bedrock.tokens_per_call',
    'sagemaker.inference_configuration', 'quicksight.subscription_profile',
    'load_balancer.capacity_profile', 'waf.traffic_profile', 'memorydb.data_profile',
    'nat_gateway.configuration',
  ]);
  if (fingerprintValidatedFields.has(field)) {
    const normalizedScope = constraint.scope.filter((scope) => scope.startsWith('service:'))
      .map((scope) => scope.slice('service:'.length).toLowerCase().replace(/[^a-z0-9]/g, ''));
    const expectedEntries = manifest.expectedResources.filter((entry) => {
      const resourceScopes = constraint.scope.filter((scope) => scope.startsWith('resource:'))
        .map((scope) => scope.slice('resource:'.length));
      if (resourceScopes.length && !entry.id.split(',').some((id) => resourceScopes.includes(id))) return false;
      if (!normalizedScope.length) return true;
      const identity = `${entry.serviceCode} ${entry.calculatorService} ${entry.description}`
        .toLowerCase().replace(/[^a-z0-9]/g, '');
      return normalizedScope.some((scope) => identity.includes(scope) || scope.includes(identity));
    });
    const allFingerprintsMatch = expectedEntries.length > 0 && expectedEntries.every((entry) => {
      const saved = services.find((service) => service.group === entry.group
        && (!entry.calculatorService || service.calculatorService === entry.calculatorService));
      return Boolean(saved && Object.entries(entry.criticalFields)
        .every(([key, expected]) => same(saved.config[key], expected)));
    });
    if (allFingerprintsMatch) return constraint.expected;
  }
  return undefined;
}

function compareConstraint(constraint: RequirementConstraint, actual: unknown): RequirementCheck {
  if (actual === undefined) return {
    constraintId: constraint.id,
    expected: constraint.expected,
    actual: null,
    status: 'UNVERIFIABLE',
    message: `No saved Calculator field was available for ${constraint.field}.`,
  };
  const candidates = (Array.isArray(actual) ? actual : [actual]).map((value) => comparable(constraint.field, value));
  const expected = comparable(constraint.field, constraint.expected);
  const pass = constraint.operator === 'exists'
    ? candidates.some((value) => value !== undefined && value !== null && value !== '')
    : constraint.operator === 'eq'
      ? candidates.some((value) => same(value, expected))
      : constraint.operator === 'in'
        ? candidates.some((value) => Array.isArray(constraint.expected) && constraint.expected.some((candidate) => same(value, comparable(constraint.field, candidate))))
        : constraint.operator === 'gte'
          ? candidates.some((value) => Number(value) >= Number(constraint.expected))
          : candidates.some((value) => Number(value) <= Number(constraint.expected));
  return {
    constraintId: constraint.id,
    expected: constraint.expected,
    actual,
    status: pass ? 'PASS' : 'FAIL',
    evidencePath: `savedEstimate.${constraint.field}`,
  };
}

export function validateSavedEstimate(
  manifest: ExecutionManifest,
  snapshot: SavedEstimateSnapshot,
): { checks: RequirementCheck[]; errors: string[] } {
  const errors: string[] = [];
  if (snapshot.monthly === undefined || snapshot.upfront === undefined || snapshot.total12Months === undefined) {
    errors.push('AWS Calculator rendered totals were not read back for monthly, upfront, and 12-month cost.');
  } else if (snapshot.monthly < 0 || snapshot.upfront < 0 || snapshot.total12Months < 0) {
    errors.push('AWS Calculator returned a negative rendered total.');
  } else if (snapshot.monthly === 0 && snapshot.upfront === 0) {
    errors.push('AWS Calculator rendered a zero-cost estimate.');
  }
  const unsupported = manifest.expectedResources.filter((entry) => !entry.calculatorService);
  unsupported.forEach((entry) => errors.push(
    `${entry.description} has no supported Calculator adapter and was not silently omitted.`,
  ));

  for (const expected of manifest.expectedResources.filter((entry) => entry.calculatorService)) {
    const candidates = snapshot.services.filter((service) => service.group === expected.group
      && (!expected.calculatorService || service.calculatorService === expected.calculatorService));
    const actual = candidates.find((service) => Object.entries(expected.criticalFields)
      .every(([field, value]) => same(service.config[field], value)))
      || (candidates.length === 1 ? candidates[0] : undefined);
    if (!actual) {
      errors.push(`Saved estimate is missing ${expected.group} / ${expected.description}.`);
      continue;
    }
    for (const [field, expectedValue] of Object.entries(expected.criticalFields)) {
      if (!same(actual.config[field], expectedValue)) {
        errors.push(`${expected.description}: saved field ${field} differs from the execution manifest.`);
      }
    }
  }
  const expectedCount = manifest.expectedResources.filter((entry) => entry.calculatorService).length;
  if (snapshot.services.length !== expectedCount) {
    errors.push(`Saved estimate contains ${snapshot.services.length} service(s); the manifest expected ${expectedCount}.`);
  }

  const checks = manifest.constraints.map((constraint) => compareConstraint(
    constraint,
    actualField(constraint, snapshot.services, manifest),
  ));
  checks.filter((check) => check.status !== 'PASS').forEach((check) => {
    const constraint = manifest.constraints.find((entry) => entry.id === check.constraintId);
    if (constraint?.impact === 'critical') errors.push(
      `Critical requirement ${constraint.field} is ${check.status.toLowerCase()}.`,
    );
  });
  manifest.pricingResolution.filter((entry) => entry.status === 'UNSUPPORTED').forEach((entry) => {
    errors.push(`Requested pricing for resource ${entry.resourceId} is unsupported: ${entry.reason || entry.requested}.`);
  });
  return { checks, errors: [...new Set(errors)] };
}
