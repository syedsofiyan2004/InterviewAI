import { isLikelyCompetency, validateCompetencies } from '../lambdas/api-handler/competencies';

/**
 * The reported defect: question-bank `topicTag` labels reached the focus-area
 * chips, the interviewer guide, the coverage matrix and the PDF report verbatim,
 * so a panel was told to assess "1500+ VM Migrations". The AI extraction is asked
 * to normalise such labels; this module is the deterministic backstop that runs
 * on every path. It is tested here with no handler load and no model call.
 */

describe('isLikelyCompetency rejects the labels that caused the defect', () => {
  test.each([
    ['1500+ VM Migrations', 'leading quantity — the exact reported string'],
    ['3000 users', 'headcount'],
    ['Terraform 1.5', 'tool version'],
    ['500 servers', 'volume'],
    ['10 + Data Centers', 'spaced plus quantity'],
    ['OAuth 2.0', 'protocol version, not a capability'],
    ['Migration of 40 projects', 'embedded count'],
    ['200', 'no letters at all'],
    ['AI', 'too short to be assessable'],
    ['', 'empty'],
  ])('%s is not a competency (%s)', (label) => {
    expect(isLikelyCompetency(label)).toBe(false);
  });
});

describe('isLikelyCompetency keeps real capabilities', () => {
  test.each([
    'Large-scale VM migration',
    'Cloud provider program & funding',
    'Terraform module design',
    'Stakeholder communication',
    'Incident response and on-call ownership',
    'Cost optimisation on AWS',
    'Kubernetes operations',
  ])('%s survives', (label) => {
    expect(isLikelyCompetency(label)).toBe(true);
  });
});

describe('validateCompetencies — the list that reaches the chips, guide and report', () => {
  test('drops the bad labels and keeps the good ones, in order', () => {
    expect(validateCompetencies([
      '1500+ VM Migrations',
      'Large-scale VM migration',
      '3000 users',
      'Stakeholder communication',
      'Terraform 1.5',
    ])).toEqual(['Large-scale VM migration', 'Stakeholder communication']);
  });

  test('trims, collapses inner whitespace, and de-duplicates case-insensitively', () => {
    expect(validateCompetencies([
      '  Cost   optimisation on AWS ',
      'cost optimisation on aws',
      'COST OPTIMISATION ON AWS',
    ])).toEqual(['Cost optimisation on AWS']);
  });

  test('caps the list at 12 so a runaway extraction cannot flood the guide', () => {
    const many = Array.from({ length: 30 }, (_, i) => `Competency number ${'a'.repeat(i + 1)}`);
    expect(validateCompetencies(many)).toHaveLength(12);
  });

  test('an all-bad list yields an empty list rather than passing anything through', () => {
    expect(validateCompetencies(['1500+ VM Migrations', '3000 users', 'Terraform 1.5'])).toEqual([]);
  });

  test('tolerates a missing list (the inferred/AI paths may return nothing)', () => {
    expect(validateCompetencies(undefined as unknown as string[])).toEqual([]);
  });
});
