import {
  REVIEW_CONTROL_SPECS,
  answerIsComplete,
  defaultAnswerFor,
  validateFiniteOptions,
} from '../../frontend/src/lib/calculatorReviewControls';

describe('calculator review controls', () => {
  test('composite SageMaker requirements render as separate typed controls', () => {
    expect(REVIEW_CONTROL_SPECS['sagemaker.inference_configuration'].controls.map((entry) => entry.key))
      .toEqual(['workloadType', 'instanceType']);
  });

  test('recommended high-impact defaults are visible as typed values', () => {
    expect(defaultAnswerFor('lambda.execution_profile')).toEqual({
      memoryMb: 512,
      durationMs: 250,
    });
    expect(REVIEW_CONTROL_SPECS['lambda.execution_profile'].controls.map((entry) => entry.source))
      .toEqual(['Recommended', 'Recommended']);
  });

  test('Lambda memory remains a finite memory dropdown and accepts the recommended value', () => {
    const memory = REVIEW_CONTROL_SPECS['lambda.execution_profile'].controls.find((entry) => entry.key === 'memoryMb');

    expect(memory?.options?.map((entry) => entry.value)).toContain('512');
    expect(validateFiniteOptions('lambda.execution_profile', { memoryMb: 512, durationMs: 250 })).toEqual([]);
    expect(answerIsComplete('lambda.execution_profile', { memoryMb: 512, durationMs: 250 })).toBe(true);
  });

  test('invalid finite AWS options are rejected before proposal submission', () => {
    expect(validateFiniteOptions('database.engine', 'Oracle', ['Aurora PostgreSQL', 'Aurora MySQL']))
      .toHaveLength(1);
    expect(validateFiniteOptions('database.engine', 'Aurora PostgreSQL', ['Aurora PostgreSQL', 'Aurora MySQL']))
      .toEqual([]);
  });

  test('required composite answers must include every required field', () => {
    expect(answerIsComplete('sagemaker.inference_configuration', { workloadType: 'real-time inference' }))
      .toBe(false);
    expect(answerIsComplete('sagemaker.inference_configuration', {
      workloadType: 'real-time inference',
      instanceType: 'ml.g5.xlarge',
    })).toBe(true);
  });

  test('NAT and QuickSight are not represented as comma-separated textboxes', () => {
    expect(REVIEW_CONTROL_SPECS['nat_gateway.configuration'].controls.map((entry) => entry.key))
      .toEqual(['mode', 'availabilityZoneCount']);
    expect(REVIEW_CONTROL_SPECS['quicksight.subscription_profile'].controls.map((entry) => entry.key))
      .toEqual(['annualAuthorPercent', 'monthlyAuthorPercent', 'spiceGb']);
  });
});
