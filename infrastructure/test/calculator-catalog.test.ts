import {
  parseServiceCatalog,
  resolveConfigAgainstCatalog,
  validateConfigAgainstCatalog,
  selectMinimalConfig,
  requiredForSubService,
} from '../lambdas/calculator-orchestrator/calculator-catalog';

/**
 * Tests asserting the catalog parser reads from parsed.catalog.* (not top level).
 *
 * The real upstream get_service_fields response shape is:
 *   { serviceCode, serviceName, fields, catalog: { status, templateId, required,
 *     traps, subServices, minimalConfig, lastVerifiedAt } }
 *
 * The previous parser silently discarded every catalog hint by reading the wrong
 * level. These tests pin the correct behaviour.
 */

/** A trimmed real MCP get_service_fields response for Amazon MQ (RabbitMQ). */
const AMAZON_MQ_RESPONSE = {
  serviceCode: 'amazonMQ',
  serviceName: 'Amazon MQ',
  fields: [
    {
      id: 'rabbitmqInstanceType',
      type: 'dropdown',
      label: 'RabbitMQ instance type',
      options: [{ id: 'opaque-current-id', label: 'mq.t3.micro' }],
    },
    {
      id: 'rabbitmqNumberOfBrokers',
      type: 'workload',
      label: 'Number of brokers',
    },
  ],
  catalog: {
    status: 'verified',
    templateId: 'amazonMQ-v2',
    required: [
      { field: 'rabbitmqInstanceType', hint: 'Choose from the live dropdown options.' },
    ],
    traps: [
      'RabbitMQ and ActiveMQ share this service code but use different field prefixes.',
    ],
    subServices: [],
    minimalConfig: {
      region: 'ap-south-1',
      rabbitmqInstanceType: 'opaque-current-id',
      rabbitmqNumberOfBrokers: 1,
    },
    lastVerifiedAt: '2026-08-01T00:00:00Z',
  },
};

/**
 * A parent service with sub-services (mirrors the SageMaker pattern).
 * The MCP nests per-child minimalConfig under catalog.minimalConfig[childServiceCode].
 */
const PARENT_WITH_SUB_SERVICES_RESPONSE = {
  serviceCode: 'amazonSageMaker',
  serviceName: 'Amazon SageMaker',
  fields: [],
  catalog: {
    status: 'verified',
    required: [
      { field: 'instanceType', hint: 'Required for all SageMaker sub-services.' },
    ],
    traps: [
      'Select the sub-service that matches your workload type.',
    ],
    subServices: [
      {
        serviceCode: 'sageMakerRealTimeInference',
        estimateFor: 'Real-time inference endpoints',
        required: [
          { field: 'modelsDeployed', hint: 'Number of deployed models.' },
          { field: 'instanceType', hint: 'ml.* instance class.' },
        ],
      },
    ],
    minimalConfig: {
      sageMakerRealTimeInference: {
        region: 'ap-south-1',
        modelsDeployed: '1',
        modelsPerEndPoint: '1',
        instancesPerEndPoint: '1',
        endpointHrsPerDay: '24',
        EndPointDaysPerMonth: '30',
      },
    },
    lastVerifiedAt: '2026-08-15T00:00:00Z',
  },
};

function makeResult(obj: unknown) {
  return { isError: false, text: JSON.stringify(obj) };
}

describe('catalog parser reads from parsed.catalog.* not the top level', () => {
  test('reads minimalConfig from catalog.minimalConfig (not parsed.minimalConfig)', () => {
    const catalog = parseServiceCatalog(makeResult(AMAZON_MQ_RESPONSE));
    expect(catalog.minimalConfig).toEqual({
      region: 'ap-south-1',
      rabbitmqInstanceType: 'opaque-current-id',
      rabbitmqNumberOfBrokers: 1,
    });
  });

  test('reads traps from catalog.traps (not parsed.traps)', () => {
    const catalog = parseServiceCatalog(makeResult(AMAZON_MQ_RESPONSE));
    expect(catalog.traps).toEqual([
      'RabbitMQ and ActiveMQ share this service code but use different field prefixes.',
    ]);
  });

  test('reads required from catalog.required (not parsed.required)', () => {
    const catalog = parseServiceCatalog(makeResult(AMAZON_MQ_RESPONSE));
    expect(catalog.required).toEqual([
      { field: 'rabbitmqInstanceType', hint: 'Choose from the live dropdown options.' },
    ]);
  });

  test('preserves catalogStatus, templateId, lastVerifiedAt', () => {
    const catalog = parseServiceCatalog(makeResult(AMAZON_MQ_RESPONSE));
    expect(catalog.catalogStatus).toBe('verified');
    expect(catalog.templateId).toBe('amazonMQ-v2');
    expect(catalog.lastVerifiedAt).toBe('2026-08-01T00:00:00Z');
  });

  test('silently ignores any top-level minimalConfig or traps that are NOT inside catalog', () => {
    // A response with top-level minimalConfig must not be treated as the catalog.
    const withTopLevelNoise = {
      ...AMAZON_MQ_RESPONSE,
      minimalConfig: { wrongLevel: true },
      traps: ['wrong level trap'],
    };
    const catalog = parseServiceCatalog(makeResult(withTopLevelNoise));
    // catalog block wins; top-level is ignored.
    expect(catalog.minimalConfig).not.toHaveProperty('wrongLevel');
    expect(catalog.traps).not.toContain('wrong level trap');
  });

  test('handles missing catalog block gracefully (older MCP versions)', () => {
    const noCatalog = {
      serviceCode: 'legacyService',
      serviceName: 'Legacy',
      fields: [{ id: 'f1', type: 'textInput' }],
    };
    const catalog = parseServiceCatalog(makeResult(noCatalog));
    expect(catalog.minimalConfig).toBeUndefined();
    expect(catalog.traps).toBeUndefined();
    expect(catalog.required).toBeUndefined();
    expect(catalog.fields).toHaveLength(1);
  });
});

describe('resolveConfigAgainstCatalog uses catalog minimalConfig as base', () => {
  test('starts from minimalConfig then overlays user values', () => {
    const catalog = parseServiceCatalog(makeResult(AMAZON_MQ_RESPONSE));
    const config = resolveConfigAgainstCatalog(catalog, { rabbitmqNumberOfBrokers: 3 });
    // minimalConfig provides the instance type default; user value overrides broker count.
    expect(config.rabbitmqInstanceType).toBe('opaque-current-id');
    expect(config.rabbitmqNumberOfBrokers).toBe(3);
  });

  test('resolves semantic dropdown labels to opaque Calculator option IDs', () => {
    const catalog = parseServiceCatalog(makeResult(AMAZON_MQ_RESPONSE));
    const config = resolveConfigAgainstCatalog(catalog, { rabbitmqInstanceType: 'mq.t3.micro' });
    expect(config.rabbitmqInstanceType).toBe('opaque-current-id');
  });

  test('does not accept an unknown dropdown label', () => {
    const catalog = parseServiceCatalog(makeResult(AMAZON_MQ_RESPONSE));
    const config = resolveConfigAgainstCatalog(catalog, { rabbitmqInstanceType: 'invented' });
    expect(validateConfigAgainstCatalog(catalog, config))
      .toEqual(expect.arrayContaining([expect.stringContaining('is not a current catalog option')]));
  });
});

describe('parent/sub-service catalog resolution', () => {
  test('selectMinimalConfig picks the sub-service config when child serviceCode is given', () => {
    const catalog = parseServiceCatalog(makeResult(PARENT_WITH_SUB_SERVICES_RESPONSE));
    const childConfig = selectMinimalConfig(catalog, 'sageMakerRealTimeInference');
    expect(childConfig).toEqual({
      region: 'ap-south-1',
      modelsDeployed: '1',
      modelsPerEndPoint: '1',
      instancesPerEndPoint: '1',
      endpointHrsPerDay: '24',
      EndPointDaysPerMonth: '30',
    });
  });

  test('selectMinimalConfig returns the whole minimalConfig when no child code given', () => {
    const catalog = parseServiceCatalog(makeResult(PARENT_WITH_SUB_SERVICES_RESPONSE));
    const allConfig = selectMinimalConfig(catalog);
    expect(allConfig).toHaveProperty('sageMakerRealTimeInference');
  });

  test('requiredForSubService returns child-specific required fields', () => {
    const catalog = parseServiceCatalog(makeResult(PARENT_WITH_SUB_SERVICES_RESPONSE));
    const required = requiredForSubService(catalog, 'sageMakerRealTimeInference');
    expect(required.map((r) => r.field)).toContain('modelsDeployed');
    expect(required.map((r) => r.field)).toContain('instanceType');
  });

  test('requiredForSubService falls back to parent required when child has none', () => {
    const catalog = parseServiceCatalog(makeResult(PARENT_WITH_SUB_SERVICES_RESPONSE));
    const required = requiredForSubService(catalog, 'unknownChild');
    // Falls back to parent required: [{ field: 'instanceType' }]
    expect(required.map((r) => r.field)).toContain('instanceType');
  });
});

describe('validateConfigAgainstCatalog', () => {
  test('rejects fields not in the live catalog', () => {
    const catalog = parseServiceCatalog(makeResult(AMAZON_MQ_RESPONSE));
    const errors = validateConfigAgainstCatalog(catalog, { inventedField: 'value' });
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining('inventedField')]));
  });

  test('passes a complete valid configuration', () => {
    const catalog = parseServiceCatalog(makeResult(AMAZON_MQ_RESPONSE));
    const config = resolveConfigAgainstCatalog(catalog, { rabbitmqInstanceType: 'mq.t3.micro', rabbitmqNumberOfBrokers: 2 });
    expect(validateConfigAgainstCatalog(catalog, config)).toEqual([]);
  });
});
