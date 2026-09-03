/**
 * Tests for the calculator definition client.
 *
 * The fixture is a trimmed copy of the REAL awsFargate definition, taken from
 * https://d1qsjq9pzbk1k6.cloudfront.net/data/awsFargate/en_US.json, including the exact
 * `taskDuration` component whose missing token list caused a saved estimate to price 730 hours
 * as 730 minutes. Kept verbatim rather than simplified: a simplified fixture would not have
 * reproduced the bug, since the bug was in what the shape does NOT contain.
 */

import {
  fieldConstraints,
  flattenComponents,
  parseDefinition,
  resolveUnitToken,
  validateValue,
} from '../lambdas/calculator-orchestrator/calculator-definitions';

/** The nesting is real: templates -> cards -> inputSection -> components. */
const FARGATE_PAYLOAD = {
  templates: [{
    cards: [{
      inputSection: {
        components: [
          {
            type: 'input',
            subType: 'dropdown',
            id: 'operatingSystem',
            label: 'Operating system',
            dropDownOptions: [
              { label: 'Linux', value: 'linux' },
              { label: 'Windows', value: 'windows' },
            ],
            defaultValue: 'linux',
          },
          {
            type: 'input',
            subType: 'durationInput',
            id: 'taskDuration',
            label: 'Average duration',
            dropDownDuration: [
              { label: 'seconds', value: 'sec' },
              { label: 'minutes', value: 'min' },
              { label: 'hours', value: 'hr' },
              { label: 'days', value: 'day' },
            ],
            defaultDuration: 'min',
            outputDurationUnit: 'hr',
            defaultValue: 1,
            validations: { required: true, allowDecimals: true, minValue: 0.0166, maxValue: 730 },
            delegate: [{
              '==': [{ id: 'operatingSystem', type: 'component' }, 'windows'],
              validations: { allowDecimals: true, minValue: 0.083, maxValue: 730 },
            }],
          },
          {
            type: 'input',
            subType: 'fileSize',
            id: 'memoryStandardFargateOnDemand',
            label: 'Amount of memory allocated',
            validSizes: ['gb'],
            defaultUnit: 'gb|NA',
            validations: { minValue: 0.5, maxValue: 30, allowDecimals: false },
          },
          {
            type: 'input',
            subType: 'numericInput',
            id: 'vcpuPerTask',
            label: 'Amount of vCPU allocated',
            validations: { required: true },
          },
        ],
      },
    }],
  }],
};

const definition = parseDefinition('awsFargate', FARGATE_PAYLOAD);

describe('finding the input components inside a definition', () => {
  it('finds components nested several levels below the root', () => {
    const ids = definition.components.map((component) => component.id);
    expect(ids).toEqual([
      'operatingSystem',
      'taskDuration',
      'memoryStandardFargateOnDemand',
      'vcpuPerTask',
    ]);
  });

  it('does not mistake a container that merely has an id for an input field', () => {
    const found = flattenComponents({ id: 'someCard', cards: [{ id: 'inner', title: 'not an input' }] });
    expect(found).toEqual([]);
  });
});

describe('resolving a semantic unit word against the tokens a field accepts', () => {
  it('resolves "hours" to the token hr, which is the pair that was missing when 730 hours priced as 730 minutes', () => {
    expect(resolveUnitToken(definition, 'taskDuration', 'hours')).toEqual({ ok: true, token: 'hr' });
  });

  it('resolves the other duration labels the definition lists', () => {
    expect(resolveUnitToken(definition, 'taskDuration', 'seconds')).toEqual({ ok: true, token: 'sec' });
    expect(resolveUnitToken(definition, 'taskDuration', 'minutes')).toEqual({ ok: true, token: 'min' });
    expect(resolveUnitToken(definition, 'taskDuration', 'days')).toEqual({ ok: true, token: 'day' });
  });

  it('resolves a unit whatever case and plurality the source wrote it in', () => {
    expect(resolveUnitToken(definition, 'taskDuration', 'HOURS')).toEqual({ ok: true, token: 'hr' });
    expect(resolveUnitToken(definition, 'taskDuration', 'Hour')).toEqual({ ok: true, token: 'hr' });
    expect(resolveUnitToken(definition, 'taskDuration', 'hrs')).toEqual({ ok: true, token: 'hr' });
    expect(resolveUnitToken(definition, 'taskDuration', '  hr  ')).toEqual({ ok: true, token: 'hr' });
  });

  it('refuses an unrecognised unit and lists the valid tokens instead of defaulting to one', () => {
    const result = resolveUnitToken(definition, 'taskDuration', 'fortnights');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.validTokens).toEqual(['sec', 'min', 'hr', 'day']);
    // The whole point: the field's own defaultDuration must never be handed back as a result.
    expect(JSON.stringify(result)).not.toContain('"token"');
  });

  it('refuses a value that states no unit at all', () => {
    const result = resolveUnitToken(definition, 'taskDuration', '');
    expect(result.ok).toBe(false);
  });

  it('reports a field with no unit dimension as dimensionless rather than as a failure', () => {
    const result = resolveUnitToken(definition, 'vcpuPerTask', 'vCPU');
    expect(result).toEqual({ ok: true, token: undefined, dimensionless: true });
  });

  it('resolves a fileSize size token', () => {
    expect(resolveUnitToken(definition, 'memoryStandardFargateOnDemand', 'GB'))
      .toEqual({ ok: true, token: 'gb' });
  });

  it('refuses a field the definition does not contain, rather than implying it is unconstrained', () => {
    const result = resolveUnitToken(definition, 'noSuchField', 'hours');
    expect(result.ok).toBe(false);
  });

  it('refuses every unit when the definition could not be read', () => {
    const result = resolveUnitToken(undefined, 'taskDuration', 'hours');
    expect(result.ok).toBe(false);
  });
});

describe('reading a field&apos;s constraints', () => {
  it('reports required from the definition&apos;s own validations block', () => {
    expect(fieldConstraints(definition, 'taskDuration')?.required).toBe(true);
    expect(fieldConstraints(definition, 'memoryStandardFargateOnDemand')?.required).toBe(false);
  });

  it('carries the range and the decimal rule', () => {
    const constraints = fieldConstraints(definition, 'taskDuration');
    expect(constraints?.minValue).toBe(0.0166);
    expect(constraints?.maxValue).toBe(730);
    expect(constraints?.allowDecimals).toBe(true);
  });

  it('marks a field carrying delegate entries as conditional, so the caller verifies it rather than trusting one branch', () => {
    expect(fieldConstraints(definition, 'taskDuration')?.conditional).toBe(true);
    expect(fieldConstraints(definition, 'operatingSystem')?.conditional).toBe(false);
  });

  it('reports the dropdown tokens for a dropdown field', () => {
    expect(fieldConstraints(definition, 'operatingSystem')?.options).toEqual(['linux', 'windows']);
  });

  it('returns undefined for an unknown field, which is not the same answer as no constraints', () => {
    expect(fieldConstraints(definition, 'noSuchField')).toBeUndefined();
  });
});

describe('checking a value against the range the definition states', () => {
  it('accepts a duration at the maximum', () => {
    expect(validateValue(definition, 'taskDuration', 730)).toEqual({ ok: true });
  });

  it('rejects a duration past the maximum, which the calculator would otherwise clamp silently', () => {
    const result = validateValue(definition, 'taskDuration', 731);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('730');
  });

  it('rejects a value below the minimum', () => {
    expect(validateValue(definition, 'taskDuration', 0.001).ok).toBe(false);
  });

  it('rejects a fraction where the field forbids decimals', () => {
    expect(validateValue(definition, 'memoryStandardFargateOnDemand', 2.5).ok).toBe(false);
    expect(validateValue(definition, 'memoryStandardFargateOnDemand', 2)).toEqual({ ok: true });
  });

  it('rejects a non-finite number', () => {
    expect(validateValue(definition, 'taskDuration', Number.NaN).ok).toBe(false);
  });
});
