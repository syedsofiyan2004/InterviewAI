import { createHash, randomUUID } from 'crypto';

import type { CalculationResource, WorkbookInsights } from '../../schema/calculator';
import type {
  CreatePlanProposal,
  EstimatePlan,
  EstimatePlanRevision,
  EstimateScenarioRequest,
  EstimatePlanV2,
  PlanDecision,
  PlanProposal,
  PlanQuestion,
  RequirementConstraint,
  SourceRef,
  PricingModelRequest,
} from '../../schema/estimate-plan';

export interface InitialPlanInput {
  planId?: string;
  workbookId: string;
  resources: CalculationResource[];
  workbook?: WorkbookInsights;
  requestedPlan?: EstimatePlan;
  defaultRegion?: string;
  now?: Date;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]),
  );
}

export function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function distinct(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function refOf(resource: CalculationResource): SourceRef[] | undefined {
  if (!resource.sheet && !resource.row) return undefined;
  return [{
    sheet: resource.sheet,
    row: resource.row,
    label: resource.name || resource.service || resource.metric,
    value: resource.raw,
  }];
}

function resourceId(resource: CalculationResource, index: number): string {
  // Stable within the immutable parsed-row list. Sheet/row stays in evidence for humans.
  return String(index);
}

export function serviceFamily(resource: CalculationResource): string | undefined {
  const text = `${resource.service || ''} ${resource.name || ''} ${resource.metric || ''}`.toLowerCase();
  if (/fargate/.test(text)) return 'ECS Fargate';
  if (/aurora/.test(text)) return 'Aurora';
  if (/memory\s*db/.test(text)) return 'MemoryDB';
  if (/rds|database/.test(text) || /^db\./i.test(resource.size || '')) return 'RDS';
  if (/elasticache|redis|memcached/.test(text) || /^cache\./i.test(resource.size || '')) return 'ElastiCache';
  if (/opensearch|elastic search/.test(text)) return 'OpenSearch';
  if (/\bs3\b|simple storage/.test(text)) return 'S3';
  if (/lambda/.test(text)) return 'Lambda';
  if (/cloudfront/.test(text)) return 'CloudFront';
  if (/api gateway/.test(text)) return 'API Gateway';
  if (/nat gateway/.test(text)) return 'NAT Gateway';
  if (/redshift/.test(text)) return 'Redshift';
  if (/bedrock/.test(text)) return 'Bedrock';
  if (/sagemaker|custom model hosting/.test(text)) return 'SageMaker';
  if (/quicksight/.test(text)) return 'QuickSight';
  if (/eventbridge/.test(text)) return 'EventBridge';
  if (/\bsqs\b|simple queue/.test(text)) return 'SQS';
  if (/\bsns\b|simple notification/.test(text)) return 'SNS';
  if (/\bses\b|simple email/.test(text)) return 'SES';
  if (/step functions?/.test(text)) return 'Step Functions';
  if (/cognito/.test(text)) return 'Cognito';
  if (/amazon mq|rabbitmq|active\s*mq|\bmq\b/.test(text)) return 'Amazon MQ';
  if (/load\s*balanc|\balb\b|\bnlb\b/.test(text)) return 'Load Balancer';
  if (/\bwaf\b|web application firewall/.test(text)) return 'WAF';
  if (/ec2|server|virtual machine/.test(text) || /^[a-z][a-z0-9]*\d[a-z]*\./i.test(resource.size || '')) return 'EC2';
  return resource.service?.trim() || undefined;
}

const INSTANCE_BACKED_FAMILIES = new Set(['EC2', 'RDS', 'Aurora', 'ElastiCache', 'OpenSearch', 'MemoryDB', 'Amazon MQ']);
const COMPILER_SUPPORTED_FAMILIES = new Set([
  'EC2', 'Aurora', 'ElastiCache', 'OpenSearch', 'ECS Fargate', 'S3', 'Lambda',
  'CloudFront', 'NAT Gateway', 'Redshift', 'SQS', 'EventBridge', 'Step Functions',
  'QuickSight', 'API Gateway', 'SES', 'MemoryDB', 'Amazon MQ',
  'Cognito', 'Bedrock', 'SageMaker', 'Load Balancer', 'WAF',
]);

/**
 * Rows from a matrix-style workbook are split into one canonical resource per metric.
 * Instance class, storage and request volume therefore become sibling rows even though
 * they describe one service in one scenario. This key lets the review planner reuse an
 * unambiguous class between those siblings without depending on a workbook name/layout.
 */
function instanceContextKey(resource: CalculationResource, family: string): string {
  const context = resource.scenario || resource.environment || resource.section || 'default';
  return [family, resource.sheet || 'input', context]
    .map((value) => String(value).trim().toLowerCase())
    .join('|');
}

function contextualInstanceTypes(resources: CalculationResource[]): Map<string, Map<string, CalculationResource[]>> {
  const contexts = new Map<string, Map<string, CalculationResource[]>>();
  resources.forEach((resource) => {
    const family = serviceFamily(resource);
    const size = resource.size?.trim();
    if (!family || !INSTANCE_BACKED_FAMILIES.has(family) || !size) return;
    const key = instanceContextKey(resource, family);
    const sizes = contexts.get(key) || new Map<string, CalculationResource[]>();
    sizes.set(size, [...(sizes.get(size) || []), resource]);
    contexts.set(key, sizes);
  });
  return contexts;
}

/**
 * Carries a single unambiguous service shape onto sibling metric rows in a disposable
 * compiler inventory. Matrix workbooks commonly put instance class, storage and request
 * volume on separate rows. The immutable canonical rows remain unchanged; inheritance is
 * refused whenever a context contains more than one possible value.
 */
export function materializeContextualResourceSpecs(resources: CalculationResource[]): CalculationResource[] {
  const instanceTypes = contextualInstanceTypes(resources);
  const fargateShapes = new Map<string, { vcpu: Set<number>; ram: Set<number> }>();

  resources.forEach((resource) => {
    const family = serviceFamily(resource);
    if (family !== 'ECS Fargate') return;
    const key = instanceContextKey(resource, family);
    const shape = fargateShapes.get(key) || { vcpu: new Set<number>(), ram: new Set<number>() };
    if (resource.vcpu !== undefined) shape.vcpu.add(resource.vcpu);
    if (resource.ram_gb !== undefined) shape.ram.add(resource.ram_gb);
    fargateShapes.set(key, shape);
  });

  return resources.map((source) => {
    const family = serviceFamily(source);
    if (!family) return { ...source };
    let resource = { ...source };
    if (INSTANCE_BACKED_FAMILIES.has(family) && !resource.size) {
      const sizes = instanceTypes.get(instanceContextKey(resource, family));
      if (sizes?.size === 1) resource = { ...resource, size: [...sizes.keys()][0] };
    }
    if (family === 'ECS Fargate') {
      const shape = fargateShapes.get(instanceContextKey(resource, family));
      if (resource.vcpu === undefined && shape?.vcpu.size === 1) {
        resource = { ...resource, vcpu: [...shape.vcpu][0] };
      }
      if (resource.ram_gb === undefined && shape?.ram.size === 1) {
        resource = { ...resource, ram_gb: [...shape.ram][0] };
      }
    }
    return resource;
  });
}

function addConstraint(
  target: RequirementConstraint[],
  value: Omit<RequirementConstraint, 'id'>,
): void {
  const key = stableHash({ scope: value.scope, field: value.field, expected: value.expected }).slice(0, 20);
  if (target.some((entry) => entry.id === `req-${key}`)) return;
  target.push({ id: `req-${key}`, ...value });
}

function addQuestion(target: PlanQuestion[], question: Omit<PlanQuestion, 'id' | 'resolved'>): void {
  const key = stableHash({ field: question.field, scope: question.scope, prompt: question.prompt }).slice(0, 20);
  if (target.some((entry) => entry.id === `question-${key}`)) return;
  target.push({ id: `question-${key}`, resolved: false, ...question });
}

type NormalizedReviewAnswer =
  | { expected: unknown }
  | { error: string; options?: string[] };

function recordAnswer(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value.trim().startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function finiteNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const token = String(value).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/)?.[0];
  if (!token) return undefined;
  const parsed = Number(token);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function compactNumbers(value: unknown): number[] {
  if (typeof value !== 'string') return [];
  return value.split(/[,;]/)
    .map((part) => finiteNumber(part))
    .filter((part): part is number => part !== undefined);
}

/**
 * Converts compact review-form answers into the typed contracts consumed by service
 * adapters. Invalid or unsupported choices stay unresolved instead of being saved as
 * plausible-looking strings and failing several minutes later in Calculator validation.
 */
export function normalizeReviewAnswer(field: string, raw: unknown): NormalizedReviewAnswer {
  const profile = recordAnswer(raw);
  const text = typeof raw === 'string' ? raw.trim() : '';

  if (field === 'sagemaker.inference_configuration') {
    const workload = String(profile?.workloadType || profile?.workload || text).trim();
    const instanceType = String(profile?.instanceType || profile?.instanceClass
      || /ml\.[a-z0-9.-]+/i.exec(text)?.[0] || '').trim();
    if (!/real[\s-]?time/i.test(workload) || !/^ml\.[a-z0-9.-]+$/i.test(instanceType)) return {
      error: 'Use a supported real-time inference endpoint and an ml.* instance class, for example: real-time inference, ml.g5.xlarge.',
    };
    return { expected: { workloadType: 'real-time inference', instanceType } };
  }

  if (field === 'lambda.execution_profile') {
    const compact = compactNumbers(text);
    const memoryMb = finiteNumber(profile?.memoryMb ?? profile?.memory_mb ?? profile?.memoryMB ?? profile?.memory)
      ?? finiteNumber(/memory\D{0,20}([0-9][0-9,.]*)/i.exec(text)?.[1])
      ?? compact[0];
    const durationMs = finiteNumber(profile?.durationMs ?? profile?.duration_ms ?? profile?.durationMS ?? profile?.duration)
      ?? finiteNumber(/duration\D{0,20}([0-9][0-9,.]*)/i.exec(text)?.[1])
      ?? compact[1];
    if (!memoryMb || !durationMs || memoryMb <= 0 || durationMs <= 0) return {
      error: 'Provide Lambda memory in MB and average duration in ms, for example: memory 512, duration 250.',
    };
    return { expected: { memoryMb, durationMs } };
  }

  if (field === 'bedrock.model') {
    const provider = String(profile?.provider || '').trim();
    const suppliedModel = String(profile?.model || profile?.modelName || text).trim();
    if (!/anthropic|claude/i.test(`${provider} ${suppliedModel}`)) return {
      error: 'The validated Bedrock adapter currently supports Anthropic Claude models. Enter, for example: Anthropic: Claude Sonnet 4.',
    };
    const model = suppliedModel.replace(/^anthropic\s*:\s*/i, '').trim();
    if (!model) return { error: 'Enter the Anthropic Claude model name used by this workload.' };
    return { expected: `Anthropic: ${model}` };
  }

  if (field === 'bedrock.tokens_per_call') {
    const inputTokens = finiteNumber(profile?.inputTokens ?? profile?.averageInputTokens)
      ?? finiteNumber(/input\D{0,20}([0-9][0-9,.]*)/i.exec(text)?.[1]);
    const outputTokens = finiteNumber(profile?.outputTokens ?? profile?.averageOutputTokens)
      ?? finiteNumber(/output\D{0,20}([0-9][0-9,.]*)/i.exec(text)?.[1]);
    const compact = compactNumbers(text);
    const input = inputTokens ?? compact[0];
    const output = outputTokens ?? compact[1];
    if (!input || !output || input <= 0 || output <= 0) return {
      error: 'Provide positive average input and output tokens, for example: input 2000, output 500.',
    };
    return { expected: { inputTokens: input, outputTokens: output } };
  }

  if (field === 'cognito.tier') {
    const compact = compactNumbers(text);
    const tierText = String(profile?.tier || text.split(/[,;]/)[0] || '').trim();
    const tier = /essential/i.test(tierText) ? 'Essentials'
      : /plus/i.test(tierText) ? 'Plus' : /lite/i.test(tierText) ? 'Lite' : undefined;
    const monthlyTokenRequests = finiteNumber(profile?.monthlyTokenRequests ?? profile?.tokenRequests) ?? compact[0];
    const federatedMau = finiteNumber(profile?.federatedMau ?? profile?.samlOidcMau) ?? compact[1];
    if (!tier || monthlyTokenRequests === undefined || monthlyTokenRequests < 0) return {
      error: 'Provide Cognito tier and monthly token requests, for example: Essentials, 1000000. Add federated MAU as a third value only for SAML/OIDC.',
    };
    return { expected: {
      tier,
      monthlyTokenRequests,
      ...(federatedMau !== undefined ? { federatedMau } : {}),
    } };
  }

  if (field === 'nat_gateway.configuration') {
    const modeText = String(profile?.mode || text).trim();
    const availabilityZoneCount = finiteNumber(profile?.availabilityZoneCount ?? profile?.azCount)
      ?? compactNumbers(text)[0];
    if (!/regional/i.test(modeText) || !availabilityZoneCount
      || !Number.isInteger(availabilityZoneCount) || availabilityZoneCount < 1) return {
      error: 'Use Regional NAT Gateway and a positive whole Availability Zone count, for example: Regional NAT Gateway, 1.',
    };
    return { expected: { mode: 'Regional NAT Gateway', availabilityZoneCount } };
  }

  if (field === 'quicksight.subscription_profile') {
    const compact = compactNumbers(text);
    const annualAuthorPercent = finiteNumber(profile?.annualAuthorPercent ?? profile?.percentAnnualAuthors) ?? compact[0];
    const monthlyAuthorPercent = finiteNumber(profile?.monthlyAuthorPercent ?? profile?.percentMonthlyAuthors) ?? compact[1];
    const spiceGb = finiteNumber(profile?.spiceGb ?? profile?.spiceGBs) ?? compact[2];
    if (annualAuthorPercent === undefined || monthlyAuthorPercent === undefined
      || annualAuthorPercent < 0 || monthlyAuthorPercent < 0
      || annualAuthorPercent + monthlyAuthorPercent !== 100
      || spiceGb === undefined || !Number.isInteger(spiceGb) || spiceGb < 10) return {
      error: 'Annual and monthly author percentages must total 100, and SPICE must be a whole number of at least 10 GB. Example: 100%, 0%, 10 GB.',
    };
    return { expected: { annualAuthorPercent, monthlyAuthorPercent, spiceGb } };
  }

  if (field === 'sns.delivery_type') {
    const expected = /mobile/i.test(text) ? 'Mobile push' : /https?/i.test(text) ? 'HTTP/HTTPS'
      : /email/i.test(text) ? 'Email' : /sqs/i.test(text) ? 'SQS' : /lambda/i.test(text) ? 'Lambda' : undefined;
    return expected ? { expected } : {
      error: 'Choose one SNS delivery type.', options: ['Mobile push', 'HTTP/HTTPS', 'Email', 'SQS', 'Lambda'],
    };
  }

  if (field === 'database.engine') {
    const expected = /postgres/i.test(text) ? 'Aurora PostgreSQL' : /mysql/i.test(text) ? 'Aurora MySQL' : undefined;
    return expected ? { expected } : {
      error: 'Choose the Aurora compatibility engine.', options: ['Aurora PostgreSQL', 'Aurora MySQL'],
    };
  }

  if (field === 'api_gateway.api_type') {
    const expected = /web.?socket/i.test(text) ? 'WebSocket API' : /rest/i.test(text) ? 'REST API'
      : /http/i.test(text) ? 'HTTP API' : undefined;
    return expected ? { expected } : {
      error: 'Choose the API Gateway API type.', options: ['HTTP API', 'REST API', 'WebSocket API'],
    };
  }

  if (field === 'ses.send_source') {
    const expected = /not\s+ec2|another|email client/i.test(text) ? 'Email client' : /ec2/i.test(text) ? 'EC2' : undefined;
    return expected ? { expected } : {
      error: 'Choose where SES email is sent from.', options: ['Email client', 'EC2'],
    };
  }

  return { expected: raw };
}

/** Builds a recommended, auditable plan without saving an AWS estimate. */
export function buildInitialPlan(input: InitialPlanInput): EstimatePlanV2 {
  const planId = input.planId || randomUUID();
  const requirements: RequirementConstraint[] = [];
  const decisions: PlanDecision[] = [];
  const unresolved: PlanQuestion[] = [];
  const families: string[] = [];
  const knownInstanceTypes = contextualInstanceTypes(input.resources);
  let mapped = 0;

  const resourceRegions = distinct(input.resources.map((resource) => resource.region));
  const defaultRegion = input.defaultRegion
    || input.workbook?.primary_region
    || (resourceRegions.length === 1 ? resourceRegions[0] : undefined);
  const hasResourceWithoutRegion = input.resources.some((resource) => !resource.region?.trim());

  // Region is an estimate-level choice unless a workbook explicitly overrides it on a
  // resource. Asking inside the row loop turned one missing value into hundreds of
  // identical blockers and made a global answer unable to resolve any of them.
  if (hasResourceWithoutRegion && defaultRegion) {
    addConstraint(requirements, {
      scope: ['all-resources'],
      field: 'resource.region',
      operator: 'eq',
      expected: defaultRegion,
      impact: 'critical',
      source: input.defaultRegion ? 'user' : 'workbook',
    });
  } else if (hasResourceWithoutRegion && resourceRegions.length === 0) {
    addQuestion(unresolved, {
      prompt: 'Choose one AWS region for this estimate.',
      field: 'resource.region',
      scope: ['all-resources'],
      impact: 'high',
    });
  }

  input.resources.forEach((resource, index) => {
    const id = resourceId(resource, index);
    const scope = [`resource:${id}`];
    const family = serviceFamily(resource);
    if (family) families.push(family);
    if (family && COMPILER_SUPPORTED_FAMILIES.has(family)) mapped += 1;

    if (!family) {
      addQuestion(unresolved, {
        prompt: `Which AWS service should source row ${resource.sheet || 'input'} ${resource.row || index + 1} use?`,
        field: 'resource.service_family',
        scope,
        impact: 'high',
        evidence: refOf(resource),
      });
    }

    if (resource.region) {
      addConstraint(requirements, {
        scope,
        field: 'resource.region',
        operator: 'eq',
        expected: resource.region,
        impact: 'critical',
        source: 'workbook',
        evidence: refOf(resource),
      });
    }

    if (resource.size) {
      addConstraint(requirements, {
        scope,
        field: 'resource.instance_type',
        operator: 'eq',
        expected: resource.size,
        impact: 'critical',
        source: 'workbook',
        evidence: refOf(resource),
      });
    } else if (family && INSTANCE_BACKED_FAMILIES.has(family)) {
      const contextual = knownInstanceTypes.get(instanceContextKey(resource, family));
      if (contextual?.size === 1) {
        const [size, providers] = [...contextual.entries()][0];
        addConstraint(requirements, {
          scope,
          field: 'resource.instance_type',
          operator: 'eq',
          expected: size,
          impact: 'critical',
          source: 'workbook',
          evidence: providers.flatMap((provider) => refOf(provider) || []).slice(0, 50),
        });
      } else {
        addQuestion(unresolved, {
          prompt: `Choose an instance or node class for ${resource.name || resource.service || `source row ${index + 1}`}.`,
          field: 'resource.instance_type',
          scope,
          impact: 'high',
          evidence: refOf(resource),
        });
      }
    }

    // Quantity remains losslessly in the canonical resource and is validated through the
    // compiled service's workload fingerprint. Identical rows are grouped before saving, so
    // a per-row count cannot be read back independently without claiming evidence AWS does
    // not expose.
    if (resource.hoursPerMonth !== undefined) {
      addConstraint(requirements, {
        scope,
        field: 'resource.hours_per_month',
        operator: 'eq',
        expected: resource.hoursPerMonth,
        impact: 'critical',
        source: 'workbook',
        evidence: refOf(resource),
      });
    }
    if (resource.purchase_model) {
      addConstraint(requirements, {
        scope,
        field: 'resource.purchase_model',
        operator: 'eq',
        expected: resource.purchase_model,
        impact: 'critical',
        source: 'workbook',
        evidence: refOf(resource),
      });
    }
  });

  const uniqueFamilies = new Set(families);
  if (uniqueFamilies.has('SageMaker')) addQuestion(unresolved, {
    prompt: 'Choose the SageMaker workload type and instance class for model hosting.',
    field: 'sagemaker.inference_configuration',
    scope: ['service:SageMaker'], impact: 'high',
  });
  if (uniqueFamilies.has('Lambda')) addQuestion(unresolved, {
    prompt: 'Provide the Lambda execution profile: memory in MB and average duration in ms. Aggregate GB-seconds will not be converted into a guessed profile.',
    field: 'lambda.execution_profile',
    scope: ['service:Lambda'], impact: 'high',
  });
  if (uniqueFamilies.has('Bedrock')) {
    addQuestion(unresolved, {
      prompt: 'Choose the Bedrock model/provider used by this workload.',
      field: 'bedrock.model', scope: ['service:Bedrock'], impact: 'high',
    });
    addQuestion(unresolved, {
      prompt: 'Provide average input and output tokens per Bedrock model call.',
      field: 'bedrock.tokens_per_call', scope: ['service:Bedrock'], impact: 'high',
    });
  }
  if (uniqueFamilies.has('Cognito')) addQuestion(unresolved, {
    prompt: 'Choose the Cognito tier and provide monthly token requests; include federated MAU only when SAML/OIDC is used.',
    field: 'cognito.tier', scope: ['service:Cognito'], impact: 'high',
  });
  if (uniqueFamilies.has('SNS')) addQuestion(unresolved, {
    prompt: 'Choose the SNS delivery type represented by the notification volume.',
    field: 'sns.delivery_type', scope: ['service:SNS'], impact: 'high',
    options: ['Mobile push', 'HTTP/HTTPS', 'Email', 'SQS', 'Lambda'],
  });
  if (uniqueFamilies.has('NAT Gateway')) addQuestion(unresolved, {
    prompt: 'Choose Regional NAT Gateway and provide its Availability Zone count, or explicitly request legacy NAT Gateway.',
    field: 'nat_gateway.configuration', scope: ['service:NAT Gateway'], impact: 'high',
  });
  if (uniqueFamilies.has('Aurora')
    && input.resources.some((resource) => serviceFamily(resource) === 'Aurora'
      && !/mysql|postgres/i.test(`${resource.os || ''} ${resource.raw || ''}`))) {
    addQuestion(unresolved, {
      prompt: 'Choose the Aurora compatibility engine: MySQL or PostgreSQL.',
      field: 'database.engine', scope: ['service:Aurora'], impact: 'high',
      options: ['Aurora PostgreSQL', 'Aurora MySQL'],
    });
  }
  if (uniqueFamilies.has('Load Balancer')) addQuestion(unresolved, {
    prompt: 'Provide the load balancer capacity profile: processed GB and either connection or request/rule rates.',
    field: 'load_balancer.capacity_profile', scope: ['service:Load Balancer'], impact: 'high',
  });
  if (uniqueFamilies.has('WAF')) addQuestion(unresolved, {
    prompt: 'Provide WAF Web ACL count, rules per ACL, and monthly web requests (millions).',
    field: 'waf.traffic_profile', scope: ['service:WAF'], impact: 'high',
  });
  if (uniqueFamilies.has('MemoryDB')) addQuestion(unresolved, {
    prompt: 'Provide MemoryDB monthly data written (GB) and snapshot storage (GB); enter zero explicitly when neither is used.',
    field: 'memorydb.data_profile', scope: ['service:MemoryDB'], impact: 'high',
  });
  if (uniqueFamilies.has('QuickSight')) addQuestion(unresolved, {
    prompt: 'Provide the QuickSight author billing mix (annual and monthly percentages) and SPICE capacity in GB. Author and reader counts already present in the workbook will be preserved.',
    field: 'quicksight.subscription_profile', scope: ['service:QuickSight'], impact: 'high',
  });
  if (uniqueFamilies.has('API Gateway')) addQuestion(unresolved, {
    prompt: 'Confirm whether API Gateway traffic is HTTP API, REST API, or WebSocket API.',
    field: 'api_gateway.api_type', scope: ['service:API Gateway'], impact: 'medium',
    options: ['HTTP API', 'REST API', 'WebSocket API'],
  });
  if (uniqueFamilies.has('SES')) addQuestion(unresolved, {
    prompt: 'Confirm whether SES email is sent from EC2 or another email client.',
    field: 'ses.send_source', scope: ['service:SES'], impact: 'medium',
    options: ['Email client', 'EC2'],
  });

  const scenarios = input.requestedPlan?.scenarios?.length
    ? input.requestedPlan.scenarios
    : (input.workbook?.bands || []).length > 1
      ? (input.workbook?.bands || []).map((band) => ({
        label: band.label,
        scope: band.label,
        environments: [],
        pricing_model: 'sheet-specified' as const,
      }))
      : [{ label: 'Workbook baseline', pricing_model: 'sheet-specified' as const, environments: [] }];

  scenarios.forEach((scenario, index) => {
    if (scenario.pricing_model === 'sheet-specified') return;
    addConstraint(requirements, {
      scope: [`scenario:${index}`],
      field: 'scenario.purchase_model',
      operator: 'eq',
      expected: scenario.pricing_model,
      impact: 'critical',
      source: input.requestedPlan?.scenarios?.length ? 'user' : 'system_default',
    });
  });

  const createdAt = (input.now || new Date()).toISOString();
  const revisionBase = {
    planId,
    createdAt,
    createdBy: 'system' as const,
    scenarios,
    requirements,
    decisions,
    ...(input.requestedPlan?.deliverables ? { deliverables: input.requestedPlan.deliverables } : {}),
  };
  const revision: EstimatePlanRevision = {
    revisionId: randomUUID(),
    ...revisionBase,
    hash: stableHash(revisionBase),
  };
  const resourceCount = input.resources.length;
  const excludedCount = input.workbook?.exclusions?.length || 0;
  return {
    planId,
    workbookId: input.workbookId,
    status: unresolved.some((entry) => entry.impact === 'high') ? 'NEEDS_INPUT' : 'READY',
    currentRevisionId: revision.revisionId,
    detectedDimensions: {
      regions: distinct([
        input.defaultRegion,
        input.workbook?.primary_region,
        ...(input.workbook?.regions || []),
        ...input.resources.map((resource) => resource.region),
      ]),
      environments: distinct(input.resources.map((resource) => resource.environment)),
      scenarios: scenarios.map((scenario) => scenario.label),
      serviceFamilies: distinct(families),
      resourceCount,
      mappedResourceCount: mapped,
      excludedCount,
      coveragePct: resourceCount ? Math.round(((mapped + excludedCount) / (resourceCount + excludedCount)) * 10_000) / 100 : 0,
    },
    unresolved,
    recommendedScenarios: scenarios,
    revisions: [revision],
  };
}

function pricingModelsIn(text: string): PricingModelRequest[] {
  const models: PricingModelRequest[] = [];
  if (/\bon[ -]?demand\b/i.test(text)) models.push('on-demand');

  const commitment = (years: 1 | 3): PricingModelRequest | undefined => {
    const year = new RegExp(`\\b${years}\\s*(?:years?|yrs?|y)\\b`, 'i');
    if (!year.test(text)) return undefined;
    const savings = /\b(?:compute\s+)?savings?\s+plans?\b/i.test(text);
    const genericPlan = /\bplans?\b/i.test(text);
    if (savings && !/\b(?:reserved(?:\s+instances?)?|ri)\b/i.test(text)) {
      return years === 1 ? 'compute-savings-1yr' : 'compute-savings-3yr';
    }
    if (!/\b(?:reserved(?:\s+instances?)?|ri)\b/i.test(text)) {
      return genericPlan ? (years === 1 ? 'compute-savings-1yr' : 'compute-savings-3yr') : undefined;
    }
    const upfront = /all[ -]?upfront/i.test(text)
      ? 'all-upfront'
      : /partial[ -]?upfront/i.test(text) ? 'partial-upfront' : 'no-upfront';
    return `ri-${years}yr-${upfront}` as PricingModelRequest;
  };

  for (const years of [1, 3] as const) {
    const model = commitment(years);
    if (model) models.push(model);
  }
  return [...new Set(models)];
}

const PERIOD_SCOPE = /\b(?:19|20)\d{2}\b|\b\d{2}\s*[-\u2013/]\s*\d{2}\b|\bfy\b|\bfiscal\b|\byears?\b/i;

function pricingLabel(model: PricingModelRequest): string {
  const labels: Partial<Record<PricingModelRequest, string>> = {
    'on-demand': 'On-Demand',
    'ri-1yr-no-upfront': '1-Year Reserved, No Upfront',
    'ri-1yr-partial-upfront': '1-Year Reserved, Partial Upfront',
    'ri-1yr-all-upfront': '1-Year Reserved, All Upfront',
    'ri-3yr-no-upfront': '3-Year Reserved, No Upfront',
    'ri-3yr-partial-upfront': '3-Year Reserved, Partial Upfront',
    'ri-3yr-all-upfront': '3-Year Reserved, All Upfront',
    'compute-savings-1yr': '1-Year Compute Savings Plan',
    'compute-savings-3yr': '3-Year Compute Savings Plan',
  };
  return labels[model] || model;
}

function scenarioMatrix(
  plan: EstimatePlanV2,
  text: string,
  models: PricingModelRequest[],
): EstimateScenarioRequest[] | undefined {
  if (models.length < 2 || !/\b(?:each|every|across|for\s+the)\b/i.test(text)) return undefined;
  const current = plan.revisions.find((entry) => entry.revisionId === plan.currentRevisionId)?.scenarios
    || plan.recommendedScenarios;
  const periods = current.filter((scenario) => PERIOD_SCOPE.test(`${scenario.scope || ''} ${scenario.label}`));
  const others = current.filter((scenario) => !periods.includes(scenario));
  const bases: EstimateScenarioRequest[] = [...periods];
  const periodOnly = /\b(?:fiscal|fy|financial\s+year|years?)\b/i.test(text);
  const lowerMentioned = /\blower\s+environments?\b/i.test(text);
  const lowerExcluded = /\b(?:ignore|exclude|skip|without|except)\b[\s\S]{0,80}\blower\s+environments?\b/i.test(text)
    || /\blower\s+environments?\b[\s\S]{0,80}\b(?:ignore|exclude|skip|omit)\b/i.test(text);

  if (lowerMentioned && !lowerExcluded && others.length) {
    bases.push({
      label: 'Lower environments',
      scope: 'Lower environments',
      environments: distinct(others.flatMap((scenario) => scenario.environments.length
        ? scenario.environments
        : [scenario.scope || scenario.label])),
      pricing_model: 'sheet-specified',
    });
  } else if (!periodOnly) {
    bases.push(...others);
  }

  if (!bases.length || bases.length * models.length > 30) return undefined;
  return bases.flatMap((base) => models.map((model) => ({
    label: `${base.scope || base.label} | ${pricingLabel(model)}`,
    scope: base.scope || base.label,
    environments: base.environments,
    pricing_model: model,
  })));
}

function parseTextRequirements(text: string): {
  requirements: RequirementConstraint[];
  decisions: PlanDecision[];
  unresolved: PlanQuestion[];
} {
  const requirements: RequirementConstraint[] = [];
  const decisions: PlanDecision[] = [];
  const unresolved: PlanQuestion[] = [];
  const sourceText = text.trim();
  const region = /\b((?:af|ap|ca|eu|il|me|mx|sa|us)-(?:gov-)?(?:central|north|south|east|west|northeast|northwest|southeast|southwest)-\d)\b/i.exec(text)?.[1];
  if (region) addConstraint(requirements, {
    scope: ['all-resources'], field: 'resource.region', operator: 'eq', expected: region,
    impact: 'critical', source: 'user', sourceText,
  });

  const hours = /\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\s*(?:\/|per\s*)?(?:month|monthly)\b/i.exec(text)?.[1];
  if (hours) addConstraint(requirements, {
    scope: ['all-time-billed-resources'], field: 'resource.hours_per_month', operator: 'eq', expected: Number(hours),
    impact: 'critical', source: 'user', sourceText,
  });

  const perDay = /\b(\d+(?:\.\d+)?)\s*(?:tasks?|runs?|requests?)\s*(?:\/|per\s*)day\b/i.exec(text)?.[1];
  if (perDay) addConstraint(requirements, {
    scope: ['service:ECS Fargate'], field: 'fargate.task_frequency_per_day', operator: 'eq', expected: Number(perDay),
    impact: 'critical', source: 'user', sourceText,
  });

  if (/\bmulti[ -]?az\b/i.test(text)) addConstraint(requirements, {
    scope: ['service:RDS', 'service:Aurora'], field: 'database.multi_az', operator: 'eq', expected: true,
    impact: 'critical', source: 'user', sourceText,
  });

  const pricingModels = pricingModelsIn(text);
  if (pricingModels.length === 1 && pricingModels[0].startsWith('ri-')) {
    addConstraint(requirements, {
      scope: ['all-eligible-resources'], field: 'resource.purchase_model', operator: 'eq',
      expected: pricingModels[0], impact: 'critical', source: 'user', sourceText,
    });
  }

  if (!requirements.length) addQuestion(unresolved, {
    prompt: 'This instruction could not be converted into a deterministic resource or scenario constraint. Specify the affected resource, field and value.',
    field: 'custom.requirement', scope: [], impact: 'high',
  });
  return { requirements, decisions, unresolved };
}

export function createPlanProposal(plan: EstimatePlanV2, input: CreatePlanProposal): PlanProposal {
  const parsed = input.text ? parseTextRequirements(input.text) : { requirements: [], decisions: [], unresolved: [] };
  const parsedScenarios = input.text
    ? scenarioMatrix(plan, input.text, pricingModelsIn(input.text))
    : undefined;
  const unresolved: PlanQuestion[] = parsedScenarios ? [] : [...parsed.unresolved];
  const requirements = [...parsed.requirements];
  if (input.text && parsedScenarios) {
    const generalFargateHours = /\bfargate\b[\s\S]{0,80}?\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\b/i.exec(input.text)?.[1];
    const lowerFargateHours = /\blower\s+environments?\b[\s\S]{0,160}?\bfargate\b[\s\S]{0,80}?\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\b/i.exec(input.text)?.[1];
    const lowerIndexes = parsedScenarios
      .map((scenario, index) => (/\blower\b/i.test(`${scenario.scope || ''} ${scenario.label}`) ? index : -1))
      .filter((index) => index >= 0);
    const regularIndexes = parsedScenarios.map((_, index) => index)
      .filter((index) => !lowerIndexes.includes(index));
    const addFargateHours = (hours: string | undefined, indexes: number[]) => {
      const value = Number(hours);
      if (!Number.isFinite(value) || value <= 0 || value > 744 || !indexes.length) return;
      addConstraint(requirements, {
        scope: [...indexes.map((index) => `scenario:${index}`), 'service:ECS Fargate'],
        field: 'resource.hours_per_month', operator: 'eq', expected: value,
        impact: 'critical', source: 'user', sourceText: input.text,
      });
    };
    addFargateHours(generalFargateHours, regularIndexes);
    addFargateHours(lowerFargateHours, lowerIndexes);
  }
  for (const value of input.requirements || []) {
    const normalized = normalizeReviewAnswer(value.field, value.expected);
    if ('error' in normalized) {
      addQuestion(unresolved, {
        prompt: normalized.error,
        field: value.field,
        scope: value.scope,
        impact: value.impact === 'critical' ? 'high' : 'medium',
        ...(normalized.options ? { options: normalized.options } : {}),
        evidence: value.evidence,
      });
      continue;
    }
    addConstraint(requirements, {
      ...value,
      expected: normalized.expected,
      source: 'user',
      sourceText: input.text,
    });
  }
  const decisions: PlanDecision[] = [...parsed.decisions];
  for (const value of input.decisions || []) decisions.push({ id: randomUUID(), ...value, source: 'user' });
  const scenarios = input.scenarios || parsedScenarios;
  const changeCount = requirements.length + decisions.length + (scenarios?.length || 0);
  return {
    proposalId: randomUUID(),
    planId: plan.planId,
    baseRevisionId: plan.currentRevisionId,
    sourceText: input.text,
    summary: unresolved.length
      ? 'More information is required before this customization can be applied.'
      : `${changeCount} structured plan change${changeCount === 1 ? '' : 's'} ready for review.`,
    requirements,
    decisions,
    ...(scenarios ? { scenarios } : {}),
    unresolved,
  };
}

export function applyPlanProposal(
  plan: EstimatePlanV2,
  proposal: PlanProposal,
  createdBy: 'user' | 'chat' = 'user',
  now = new Date(),
): EstimatePlanV2 {
  if (proposal.planId !== plan.planId || proposal.baseRevisionId !== plan.currentRevisionId) {
    throw new Error('PLAN_REVISION_CONFLICT');
  }
  if (proposal.unresolved.some((entry) => entry.impact === 'high')) throw new Error('PLAN_PROPOSAL_NEEDS_INPUT');
  const parent = plan.revisions.find((entry) => entry.revisionId === plan.currentRevisionId);
  if (!parent) throw new Error('PLAN_REVISION_NOT_FOUND');
  const requirements = parent.requirements.filter((entry) => !proposal.scenarios || (
    entry.field !== 'scenario.purchase_model'
    && !(entry.field === 'resource.purchase_model' && entry.scope.some((scope) => (
      scope === 'all-resources' || scope === 'all-eligible-resources'
    )))
  ));
  proposal.requirements.forEach((entry) => {
    const at = requirements.findIndex((current) => current.field === entry.field
      && stableHash(current.scope) === stableHash(entry.scope));
    if (at >= 0) requirements[at] = entry;
    else requirements.push(entry);
  });
  proposal.scenarios?.forEach((scenario, index) => {
    if (scenario.pricing_model === 'sheet-specified') return;
    addConstraint(requirements, {
      scope: [`scenario:${index}`],
      field: 'scenario.purchase_model',
      operator: 'eq',
      expected: scenario.pricing_model,
      impact: 'critical',
      source: 'user',
      sourceText: proposal.sourceText,
    });
  });
  const revisionBase = {
    planId: plan.planId,
    parentRevisionId: parent.revisionId,
    createdAt: now.toISOString(),
    createdBy,
    scenarios: proposal.scenarios || parent.scenarios,
    requirements,
    decisions: [...parent.decisions, ...proposal.decisions],
    ...(parent.deliverables ? { deliverables: parent.deliverables } : {}),
  };
  const revision: EstimatePlanRevision = {
    revisionId: randomUUID(),
    ...revisionBase,
    hash: stableHash(revisionBase),
  };
  const resolvedQuestion = (question: PlanQuestion) => [...proposal.requirements, ...proposal.decisions].some(
    (change) => {
      if (change.field !== question.field) return false;
      if (!question.scope.length) return true;
      if (change.scope.includes('all-resources')
        && question.scope.some((scope) => scope === 'all-resources' || scope.startsWith('resource:'))) return true;
      return question.scope.some((scope) => change.scope.includes(scope));
    },
  );
  const unresolved = plan.unresolved.filter((question) => !question.resolved && !resolvedQuestion(question));
  return {
    ...plan,
    status: unresolved.some((question) => question.impact === 'high') ? 'NEEDS_INPUT' : 'READY',
    currentRevisionId: revision.revisionId,
    recommendedScenarios: revision.scenarios,
    unresolved,
    revisions: [...plan.revisions, revision],
  };
}

export function confirmPlan(plan: EstimatePlanV2, revisionId: string): EstimatePlanV2 {
  if (revisionId !== plan.currentRevisionId || !plan.revisions.some((entry) => entry.revisionId === revisionId)) {
    throw new Error('PLAN_REVISION_CONFLICT');
  }
  if (plan.unresolved.some((entry) => entry.impact === 'high' && !entry.resolved)) {
    throw new Error('PLAN_NEEDS_INPUT');
  }
  return { ...plan, status: 'CONFIRMED' };
}
