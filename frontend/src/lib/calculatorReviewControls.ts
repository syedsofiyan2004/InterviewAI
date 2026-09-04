export type ReviewValue = string | number | Record<string, string | number>;

export type ReviewSource = 'Detected from workbook' | 'Recommended' | 'Default' | 'Required by AWS Calculator';

export interface ReviewControlOption {
  value: string;
  label: string;
}

export interface ReviewControlField {
  key: string;
  label: string;
  kind: 'searchable-select' | 'number' | 'text';
  options?: ReviewControlOption[];
  min?: number;
  max?: number;
  step?: number;
  source: ReviewSource;
  recommended?: string | number;
  required?: boolean;
}

export interface ReviewControlSpec {
  field: string;
  controls: ReviewControlField[];
}

const option = (value: string, label = value): ReviewControlOption => ({ value, label });

export const REVIEW_CONTROL_SPECS: Record<string, ReviewControlSpec> = {
  'resource.region': {
    field: 'resource.region',
    controls: [{
      key: 'value',
      label: 'Region',
      kind: 'searchable-select',
      source: 'Default',
      recommended: 'ap-south-1',
      required: true,
      options: [
        option('ap-south-1', 'Asia Pacific (Mumbai) - ap-south-1'),
        option('ap-southeast-1', 'Asia Pacific (Singapore) - ap-southeast-1'),
        option('ap-southeast-2', 'Asia Pacific (Sydney) - ap-southeast-2'),
        option('ap-northeast-1', 'Asia Pacific (Tokyo) - ap-northeast-1'),
        option('me-central-1', 'Middle East (UAE) - me-central-1'),
        option('eu-central-1', 'Europe (Frankfurt) - eu-central-1'),
        option('eu-west-1', 'Europe (Ireland) - eu-west-1'),
        option('eu-west-2', 'Europe (London) - eu-west-2'),
        option('eu-west-3', 'Europe (Paris) - eu-west-3'),
        option('eu-north-1', 'Europe (Stockholm) - eu-north-1'),
        option('us-east-1', 'US East (N. Virginia) - us-east-1'),
        option('us-east-2', 'US East (Ohio) - us-east-2'),
        option('us-west-2', 'US West (Oregon) - us-west-2'),
        option('ca-central-1', 'Canada (Central) - ca-central-1'),
        option('sa-east-1', 'South America (Sao Paulo) - sa-east-1'),
      ],
    }],
  },
  'sagemaker.inference_configuration': {
    field: 'sagemaker.inference_configuration',
    controls: [
      {
        key: 'workloadType',
        label: 'Workload type',
        kind: 'searchable-select',
        source: 'Recommended',
        recommended: 'real-time inference',
        required: true,
        options: [option('real-time inference', 'Real-time inference')],
      },
      {
        key: 'instanceType',
        label: 'Instance type',
        kind: 'searchable-select',
        source: 'Recommended',
        recommended: 'ml.g5.xlarge',
        required: true,
        options: ['ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.g6.xlarge', 'ml.c7i.xlarge', 'ml.m7i.xlarge']
          .map((value) => option(value)),
      },
    ],
  },
  'lambda.execution_profile': {
    field: 'lambda.execution_profile',
    controls: [
      {
        key: 'memoryMb',
        label: 'Memory',
        kind: 'searchable-select',
        source: 'Recommended',
        recommended: 512,
        required: true,
        options: [128, 256, 512, 1024, 2048, 3008, 4096, 8192, 10240]
          .map((value) => option(String(value), `${value} MB`)),
      },
      {
        key: 'durationMs',
        label: 'Average duration',
        kind: 'number',
        source: 'Recommended',
        recommended: 250,
        min: 1,
        step: 1,
        required: true,
      },
    ],
  },
  'bedrock.model': {
    field: 'bedrock.model',
    controls: [
      {
        key: 'provider',
        label: 'Provider',
        kind: 'searchable-select',
        source: 'Recommended',
        recommended: 'Anthropic',
        required: true,
        options: [option('Anthropic')],
      },
      {
        key: 'model',
        label: 'Model',
        kind: 'searchable-select',
        source: 'Recommended',
        recommended: 'Claude Sonnet 4',
        required: true,
        options: ['Claude Sonnet 4', 'Claude Opus 4', 'Claude Haiku 3.5'].map((value) => option(value)),
      },
    ],
  },
  'bedrock.tokens_per_call': {
    field: 'bedrock.tokens_per_call',
    controls: [
      { key: 'inputTokens', label: 'Input tokens/call', kind: 'number', source: 'Recommended', recommended: 2000, min: 1, step: 1, required: true },
      { key: 'outputTokens', label: 'Output tokens/call', kind: 'number', source: 'Recommended', recommended: 500, min: 1, step: 1, required: true },
    ],
  },
  'cognito.tier': {
    field: 'cognito.tier',
    controls: [
      { key: 'tier', label: 'Tier', kind: 'searchable-select', source: 'Recommended', recommended: 'Essentials', required: true, options: ['Lite', 'Essentials', 'Plus'].map((value) => option(value)) },
      { key: 'monthlyTokenRequests', label: 'Monthly token requests', kind: 'number', source: 'Recommended', recommended: 1000000, min: 0, step: 1, required: true },
      { key: 'federatedMau', label: 'Federated MAU', kind: 'number', source: 'Default', recommended: 0, min: 0, step: 1 },
    ],
  },
  'nat_gateway.configuration': {
    field: 'nat_gateway.configuration',
    controls: [
      { key: 'mode', label: 'Mode', kind: 'searchable-select', source: 'Recommended', recommended: 'Regional NAT Gateway', required: true, options: [option('Regional NAT Gateway')] },
      { key: 'availabilityZoneCount', label: 'Availability Zones', kind: 'number', source: 'Recommended', recommended: 1, min: 1, step: 1, required: true },
    ],
  },
  'quicksight.subscription_profile': {
    field: 'quicksight.subscription_profile',
    controls: [
      { key: 'annualAuthorPercent', label: 'Annual authors', kind: 'number', source: 'Recommended', recommended: 100, min: 0, max: 100, step: 1, required: true },
      { key: 'monthlyAuthorPercent', label: 'Monthly authors', kind: 'number', source: 'Recommended', recommended: 0, min: 0, max: 100, step: 1, required: true },
      { key: 'spiceGb', label: 'SPICE capacity', kind: 'number', source: 'Default', recommended: 10, min: 10, step: 1, required: true },
    ],
  },
};

function scalarDefault(field: string, options?: string[]): ReviewValue {
  if (field === 'database.engine') return options?.[0] || 'Aurora PostgreSQL';
  if (field === 'sns.delivery_type') return options?.[0] || 'Mobile push';
  if (field === 'api_gateway.api_type') return options?.[0] || 'HTTP API';
  if (field === 'ses.send_source') return options?.[0] || 'Email client';
  return options?.[0] || '';
}

export function defaultAnswerFor(field: string, options?: string[]): ReviewValue {
  const spec = REVIEW_CONTROL_SPECS[field];
  if (!spec) return scalarDefault(field, options);
  if (spec.controls.length === 1 && spec.controls[0].key === 'value') {
    return spec.controls[0].recommended ?? scalarDefault(field, options);
  }
  return Object.fromEntries(spec.controls
    .filter((control) => control.recommended !== undefined)
    .map((control) => [control.key, control.recommended])) as Record<string, string | number>;
}

export function answerIsComplete(field: string, value: ReviewValue | undefined, options?: string[]): boolean {
  if (value === undefined || value === null) return false;
  const spec = REVIEW_CONTROL_SPECS[field];
  if (!spec) return typeof value === 'string' ? value.trim().length > 0 : true;
  if (spec.controls.length === 1 && spec.controls[0].key === 'value') {
    return typeof value === 'string' ? value.trim().length > 0 : true;
  }
  if (typeof value !== 'object') return false;
  return spec.controls.every((control) => {
    if (!control.required) return true;
    const raw = value[control.key];
    return raw !== undefined && raw !== null && String(raw).trim() !== '';
  }) && validateFiniteOptions(field, value, options).length === 0;
}

export function validateFiniteOptions(field: string, value: ReviewValue, options?: string[]): string[] {
  const failures: string[] = [];
  const spec = REVIEW_CONTROL_SPECS[field];
  if (!spec) {
    if (options?.length && typeof value === 'string' && !options.includes(value)) failures.push(`${field} must be one of the supported AWS options.`);
    return failures;
  }
  const record = typeof value === 'object' ? value as Record<string, string | number> : { value };
  for (const control of spec.controls) {
    if (!control.options?.length) continue;
    const raw = record[control.key];
    if (raw === undefined || raw === null || raw === '') continue;
    const allowed = new Set(control.options.map((entry) => entry.value));
    if (!allowed.has(String(raw))) failures.push(`${control.label} must be selected from the AWS-supported options.`);
  }
  return failures;
}

export function formatReviewAnswer(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `${key}: ${String(entry)}`)
      .join(', ');
  }
  return String(value ?? '');
}
