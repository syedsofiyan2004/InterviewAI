import {
  createExecutionManifest,
  parseSavedEstimateSnapshot,
  validateSavedEstimate,
} from '../lambdas/calculator-orchestrator/calculator-validation';
import type { RequirementConstraint } from '../schema/estimate-plan';

function requirement(field: string, expected: unknown): RequirementConstraint {
  return {
    id: `req-${field}`, scope: ['resource:0'], field, operator: 'eq', expected,
    impact: 'critical', source: 'user',
  };
}

function fixture(constraints: RequirementConstraint[] = []) {
  const config = {
    region: 'eu-west-1', instanceType: 'm7i.large', workload: 2,
    utilization: '100', numberOfTasks: { value: '10', unit: 'perDay' }, pricingStrategy: 'ondemand', description: '2 x m7i.large',
  };
  const manifest = createExecutionManifest({
    scenarioId: 'baseline', planRevisionId: 'revision-1', inputHash: 'input-hash', constraints,
    services: [{
      resourceIds: ['0'], serviceCode: 'AmazonEC2', calculatorService: 'ec2Enhancement',
      group: 'Production', description: config.description, config,
      requestedPricing: 'on-demand', resolvedPricing: 'on-demand', pricingStatus: 'EXACT',
    }],
  });
  const snapshot = parseSavedEstimateSnapshot(JSON.stringify({
    groups: { Production: { name: 'Production', services: { ec2: { service: 'ec2Enhancement', config } } } },
    monthly: 250, upfront: 0, total12Months: 3000,
  }));
  return { manifest, snapshot };
}

describe('saved AWS Calculator validation', () => {
  test('distinguishes monthly hours from per-day counts', () => {
    const { manifest, snapshot } = fixture([
      requirement('resource.hours_per_month', 730),
      requirement('fargate.task_frequency_per_day', 24),
    ]);
    const result = validateSavedEstimate(manifest, snapshot);
    expect(result.checks[0].status).toBe('PASS');
    expect(result.checks[1].status).toBe('FAIL');
    expect(result.errors.join(' ')).toMatch(/task_frequency_per_day/);
  });

  test('rejects an RI request resolved as a Savings Plan or unsupported model', () => {
    const { manifest, snapshot } = fixture([]);
    manifest.pricingResolution[0] = {
      resourceId: '0', requested: 'ri-3yr-no-upfront', resolved: 'instance-savings-3yr',
      status: 'UNSUPPORTED', reason: 'No exact Calculator RI contract',
    };
    expect(validateSavedEstimate(manifest, snapshot).errors.join(' ')).toMatch(/unsupported.*exact Calculator RI/i);
  });

  test('detects a saved Aurora configuration change and a silently omitted service', () => {
    const { manifest, snapshot } = fixture([]);
    (manifest.expectedResources[0].criticalFields as any).columnFormIPM = {
      value: [{ PurchaseOption: { value: 'Partial Upfront' } }],
    };
    expect(validateSavedEstimate(manifest, snapshot).errors.join(' ')).toMatch(/columnFormIPM differs/);

    snapshot.services = [];
    const missing = validateSavedEstimate(manifest, snapshot).errors.join(' ');
    expect(missing).toMatch(/missing Production/);
    expect(missing).toMatch(/contains 0 service/);
  });

  test('reads Calculator import payloads from calculationComponents', () => {
    const components = {
      region: 'ap-south-1',
      description: 'Aurora cluster',
      columnFormIPM: {
        value: [{ 'Instance Type': { value: 'db.r7g.large' }, PurchaseOption: { value: 'No Upfront' } }],
      },
    };
    const snapshot = parseSavedEstimateSnapshot(JSON.stringify({
      groups: {
        Databases: {
          name: 'Databases',
          services: {
            aurora: {
              serviceCode: 'amazonAuroraMySQLCompatible',
              calculationComponents: components,
            },
          },
        },
      },
    }));

    expect(snapshot.services).toEqual([{
      group: 'Databases',
      description: 'Aurora cluster',
      calculatorService: 'amazonAuroraMySQLCompatible',
      config: components,
    }]);
  });

  test('flattens parent services and normalizes scalar component wrappers', () => {
    const snapshot = parseSavedEstimateSnapshot(JSON.stringify({
      groups: { Models: { name: 'Models', services: { parent: {
        serviceCode: 'amazonSageMaker', region: 'ap-south-1', description: 'SageMaker parent',
        subServices: [{
          serviceCode: 'sageMakerRealTimeInference', description: 'Inference',
          calculationComponents: {
            modelsDeployed: { value: '2' },
            columnFormIPM: { value: [{ 'Instance Name': { value: 'ml.g5.xlarge' } }] },
          },
        }],
      } } } },
    }));
    expect(snapshot.services).toEqual([expect.objectContaining({
      group: 'Models', calculatorService: 'sageMakerRealTimeInference',
      config: expect.objectContaining({
        modelsDeployed: '2',
        columnFormIPM: { value: [{ 'Instance Name': { value: 'ml.g5.xlarge' } }] },
      }),
    })]);
  });

  test('structured requirements pass only after their compiled fingerprint is read back', () => {
    const constraint = requirement('sagemaker.inference_configuration', {
      workloadType: 'real-time inference', instanceType: 'ml.g5.xlarge',
    });
    const config = {
      modelsDeployed: '2', instancesPerEndPoint: '2',
      columnFormIPM: { value: [{ 'Instance Name': { value: 'ml.g5.xlarge' } }] },
    };
    const manifest = createExecutionManifest({
      scenarioId: 'baseline', planRevisionId: 'revision-1', inputHash: 'hash', constraints: [constraint],
      services: [{
        resourceIds: ['0'], serviceCode: 'AmazonSageMaker', calculatorService: 'sageMakerRealTimeInference',
        group: 'Models', description: 'Inference', config,
        fingerprintFields: Object.keys(config),
        requestedPricing: 'on-demand', resolvedPricing: 'on-demand', pricingStatus: 'EXACT',
      }],
    });
    const snapshot = parseSavedEstimateSnapshot(JSON.stringify({
      groups: { Models: { name: 'Models', services: { parent: {
        serviceCode: 'amazonSageMaker', subServices: [{
          serviceCode: 'sageMakerRealTimeInference', description: 'Inference',
          calculationComponents: Object.fromEntries(Object.entries(config).map(([key, value]) => [
            key, key === 'columnFormIPM' ? value : { value },
          ])),
        }],
      } } } }, monthly: 1, upfront: 0, total12Months: 12,
    }));
    expect(validateSavedEstimate(manifest, snapshot).checks[0].status).toBe('PASS');
    (snapshot.services[0].config as any).columnFormIPM.value[0]['Instance Name'].value = 'ml.g5.2xlarge';
    expect(validateSavedEstimate(manifest, snapshot).checks[0].status).toBe('FAIL');
  });

  test('unverifiable structured requirements require review without masquerading as partial omissions', () => {
    const constraint = requirement('sagemaker.inference_configuration', {
      workloadType: 'real-time inference', instanceType: 'ml.g5.xlarge',
    });
    const config = {
      modelsDeployed: '2',
      instancesPerEndPoint: '2',
    };
    const manifest = createExecutionManifest({
      scenarioId: 'baseline', planRevisionId: 'revision-1', inputHash: 'hash', constraints: [constraint],
      services: [{
        resourceIds: ['0'], serviceCode: 'AmazonSageMaker', calculatorService: 'sageMakerRealTimeInference',
        group: 'Models', description: 'Inference', config,
        requestedPricing: 'on-demand', resolvedPricing: 'on-demand', pricingStatus: 'EXACT',
      }],
    });
    const snapshot = parseSavedEstimateSnapshot(JSON.stringify({
      groups: { Models: { name: 'Models', services: { parent: {
        serviceCode: 'amazonSageMaker', subServices: [{
          serviceCode: 'sageMakerRealTimeInference', description: 'Inference',
          calculationComponents: config,
        }],
      } } } }, monthly: 1, upfront: 0, total12Months: 12,
    }));

    const validation = validateSavedEstimate(manifest, snapshot);

    expect(validation.errors).toEqual([]);
    expect(validation.reviewRequired).toHaveLength(1);
    expect(validation.reviewRequired[0]).toEqual(expect.objectContaining({
      constraintId: constraint.id,
      status: 'UNVERIFIABLE',
    }));
  });

  test('validates Aurora multi-AZ from the saved Aurora service contract', () => {
    const constraint = requirement('database.multi_az', true);
    const components = {
      region: 'ap-south-1', description: 'Aurora cluster',
      columnFormIPM: { value: [{ 'Instance Type': { value: 'db.r7g.large' } }] },
    };
    const manifest = createExecutionManifest({
      scenarioId: 'baseline', planRevisionId: 'revision-1', inputHash: 'hash', constraints: [constraint],
      services: [{
        resourceIds: ['0'], serviceCode: 'AmazonRDS', calculatorService: 'amazonAuroraMySQLCompatible',
        group: 'Databases', description: 'Aurora cluster', config: components,
        requestedPricing: 'on-demand', resolvedPricing: 'on-demand', pricingStatus: 'EXACT',
      }],
    });
    const snapshot = parseSavedEstimateSnapshot(JSON.stringify({
      groups: { Databases: { name: 'Databases', services: { aurora: {
        serviceCode: 'amazonAuroraMySQLCompatible', calculationComponents: components,
      } } } },
    }));

    expect(validateSavedEstimate(manifest, snapshot).checks).toContainEqual(expect.objectContaining({
      constraintId: constraint.id, status: 'PASS',
    }));
  });
});
