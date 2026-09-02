import {
  MAX_INLINE_CALCULATION_RESULT_BYTES,
  calculationResultKey,
  compactCalculationResult,
} from '../lambdas/shared/calculator-result-storage';
import type { CalculationResult } from '../schema/calculator';

function largeResult(): CalculationResult {
  const repeatedEvidence = 'saved configuration differs from the execution manifest '.repeat(10);
  return {
    url: 'https://calculator.aws/#/estimate?id=primary',
    currency: 'USD',
    monthlyTotal: 42_000,
    lineItems: Array.from({ length: 120 }, (_, index) => ({
      service: `AWS service ${index}`,
      detail: repeatedEvidence,
      monthly: index + 0.5,
    })),
    environments: [],
    scenarios: Array.from({ length: 18 }, (_, index) => ({
      key: `scenario-${index}`,
      label: `Scenario ${index}`,
      monthly: 40_000 + index,
      url: `https://calculator.aws/#/estimate?id=${index}`,
      status: 'PARTIAL' as const,
      validation_errors: [repeatedEvidence],
      requirement_checks: Array.from({ length: 50 }, (_, check) => ({
        constraintId: `constraint-${check}`,
        expected: repeatedEvidence,
        actual: repeatedEvidence,
        status: 'FAIL' as const,
        message: repeatedEvidence.slice(0, 600),
      })),
      manifest: {
        scenarioId: `scenario-${index}`,
        planRevisionId: 'revision-1',
        inputHash: 'input-hash',
        expectedResources: Array.from({ length: 100 }, (_, resource) => ({
          id: `resource-${resource}`,
          serviceCode: 'AmazonEC2',
          calculatorService: 'Amazon EC2',
          group: 'compute',
          description: repeatedEvidence,
          criticalFields: { description: repeatedEvidence },
        })),
        constraints: [],
        pricingResolution: [],
        manifestHash: 'manifest-hash',
      },
    })),
    assumptions: [repeatedEvidence],
    warnings: [repeatedEvidence],
    validationErrors: [repeatedEvidence],
  };
}

describe('calculator result storage', () => {
  test('uses an owner-scoped deterministic result key', () => {
    expect(calculationResultKey('owner-1', 'calc-1'))
      .toBe('users/owner-1/calculator/calc-1/result.json');
  });

  test('keeps the DynamoDB render copy bounded while preserving scenario links and totals', () => {
    const full = largeResult();
    expect(Buffer.byteLength(JSON.stringify(full), 'utf8')).toBeGreaterThan(400 * 1024);

    const compact = compactCalculationResult(full);
    expect(Buffer.byteLength(JSON.stringify(compact), 'utf8'))
      .toBeLessThanOrEqual(MAX_INLINE_CALCULATION_RESULT_BYTES);
    expect(compact.monthlyTotal).toBe(full.monthlyTotal);
    expect(compact.scenarios).toHaveLength(18);
    expect(compact.scenarios.map((scenario) => scenario.url))
      .toEqual(full.scenarios.map((scenario) => scenario.url));
    expect(compact.scenarios.every((scenario) => !scenario.manifest)).toBe(true);
    expect(compact.scenarios.every((scenario) => !scenario.requirement_checks)).toBe(true);
    expect(compact.scenarios.every((scenario) => !scenario.validation_errors)).toBe(true);
    expect(compact.servers).toBeUndefined();
  });
});
