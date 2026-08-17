import { generateCalculatorPdfReport, schedulingSaving } from '../lambdas/shared/calculator-report';
import type { CalculationResult } from '../schema/calculator';

/**
 * The client-facing PDF.
 *
 * Two things matter here. First, the renderer must not throw: it is fed model output
 * via a Zod schema that permits nulls and empty arrays everywhere, and a crash means
 * a finished estimate with no downloadable document. Second, the scheduling saving
 * must be arithmetic on AWS's own figures over time-billed lines ONLY — counting a
 * usage-based service would invent a saving that does not exist, which is the same
 * class of mistake as a score derived from counting question marks.
 */

const result = (overrides: Partial<CalculationResult> = {}): CalculationResult => ({
  url: 'https://calculator.aws/#/estimate?id=abc123',
  currency: 'USD',
  monthlyTotal: 1000,
  lineItems: [],
  environments: [],
  assumptions: [],
  warnings: [],
  ...overrides,
} as CalculationResult);

const options = {
  name: 'Verbal - production baseline',
  environmentHours: [
    { name: 'Production', hoursPerDay: 24 },
    { name: 'Staging', hoursPerDay: 12 },
    { name: 'Dev', hoursPerDay: 8 },
  ],
  createdAt: Date.UTC(2026, 7, 16),
  region: 'ap-south-1',
};

describe('Scheduling saving is derived only from time-billed lines', () => {
  test('an 8h/day instance implies two thirds saved against always-on', () => {
    // Priced at 8h = $100, so 24h would be $300 and the avoided cost is $200.
    const saving = schedulingSaving(result({
      lineItems: [{ service: 'EC2', monthly: 100, hoursPerDay: 8, timeBilled: true, environment: 'Dev' }],
    }));

    expect(saving.monthly).toBeCloseTo(200, 5);
    expect(saving.lines).toHaveLength(1);
  });

  test('a usage-based line is excluded even when it carries hours', () => {
    // S3 costs the same whether the environment is up or not. Including it would
    // fabricate a saving out of storage.
    const saving = schedulingSaving(result({
      lineItems: [
        { service: 'S3', monthly: 500, hoursPerDay: 8, timeBilled: false, environment: 'Dev' },
        { service: 'EC2', monthly: 100, hoursPerDay: 8, timeBilled: true, environment: 'Dev' },
      ],
    }));

    expect(saving.lines.map((line) => line.service)).toEqual(['EC2']);
    expect(saving.monthly).toBeCloseTo(200, 5);
  });

  test('a line with no timeBilled flag is not assumed to be time-billed', () => {
    const saving = schedulingSaving(result({
      lineItems: [{ service: 'Unknown', monthly: 100, hoursPerDay: 8, environment: 'Dev' }],
    }));

    expect(saving.monthly).toBeNull();
  });

  test('24h lines contribute nothing, so an all-production estimate shows no saving', () => {
    const saving = schedulingSaving(result({
      lineItems: [
        { service: 'EC2', monthly: 300, hoursPerDay: 24, timeBilled: true, environment: 'Production' },
        { service: 'RDS', monthly: 200, hoursPerDay: 24, timeBilled: true, environment: 'Production' },
      ],
    }));

    expect(saving.lines).toEqual([]);
    expect(saving.monthly).toBeNull();
  });

  test('an unpriced line is skipped rather than counted as zero', () => {
    const saving = schedulingSaving(result({
      lineItems: [
        { service: 'EC2', monthly: null, hoursPerDay: 8, timeBilled: true, environment: 'Dev' },
        { service: 'RDS', monthly: 60, hoursPerDay: 12, timeBilled: true, environment: 'Staging' },
      ],
    }));

    expect(saving.lines).toHaveLength(1);
    expect(saving.monthly).toBeCloseTo(60, 5);
  });
});

describe('Rendering the PDF', () => {
  const isPdf = (buffer: Buffer) => buffer.subarray(0, 5).toString() === '%PDF-';

  test('a full estimate renders a multi-page PDF', async () => {
    const buffer = await generateCalculatorPdfReport(result({
      lineItems: [
        { service: 'EC2', detail: '2 x t3.large, Linux, on-demand', monthly: 120, hoursPerDay: 24, timeBilled: true, environment: 'Production' },
        { service: 'RDS PostgreSQL', detail: 'db.t3.medium Multi-AZ, 100 GB', monthly: 180, hoursPerDay: 24, timeBilled: true, environment: 'Production' },
        { service: 'S3', detail: '200 GB Standard', monthly: 5, timeBilled: false, environment: 'Production' },
        { service: 'EC2', detail: '1 x t3.medium', monthly: 20, hoursPerDay: 12, timeBilled: true, environment: 'Staging' },
        { service: 'EC2', detail: '2 x t3.small', monthly: 14, hoursPerDay: 8, timeBilled: true, environment: 'Dev' },
      ],
      environments: [
        { name: 'Production', hoursPerDay: 24, monthly: 305 },
        { name: 'Staging', hoursPerDay: 12, monthly: 20 },
        { name: 'Dev', hoursPerDay: 8, monthly: 14 },
      ],
      assumptions: ['Region defaulted to ap-south-1 (Mumbai).', 'Storage class assumed S3 Standard.'],
      warnings: ['Data transfer was not specified and is excluded.'],
      monthlyTotal: 339,
    }), options);

    expect(isPdf(buffer)).toBe(true);
    // Cover, environments, breakdown, savings and assumptions do not fit on one A4.
    expect(buffer.length).toBeGreaterThan(4000);
  });

  test('a null total and zero line items still produce a document', async () => {
    // The schema allows both, and an estimate that priced at nothing must still be
    // downloadable — otherwise the failure is invisible until someone clicks.
    const buffer = await generateCalculatorPdfReport(result({ monthlyTotal: null }), options);

    expect(isPdf(buffer)).toBe(true);
  });

  test('missing assumptions, warnings and environments do not throw', async () => {
    const buffer = await generateCalculatorPdfReport({
      url: 'https://calculator.aws/#/estimate?id=x',
      currency: 'USD',
      lineItems: [{ service: 'EC2' }],
    } as unknown as CalculationResult, { ...options, environmentHours: [], region: undefined });

    expect(isPdf(buffer)).toBe(true);
  });

  test('characters the standard PDF fonts cannot draw are sanitised, not fatal', async () => {
    // Uploaded spreadsheets are full of smart quotes and em dashes; pdf-lib throws
    // on those with a StandardFont, which would kill the whole report.
    const buffer = await generateCalculatorPdfReport(result({
      lineItems: [{ service: 'EC2 — “web” tier', detail: 'client’s spec ± 10%', monthly: 10, environment: 'Prod' }],
      assumptions: ['Region — Mumbai (ap‑south‑1)'],
    }), { ...options, name: 'Client’s “baseline” — v2' });

    expect(isPdf(buffer)).toBe(true);
  });

  test('a long breakdown paginates instead of overflowing one page', async () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      service: `Service ${index}`,
      detail: 'a deliberately long configuration summary that will wrap across more than one line in its cell',
      monthly: 10 + index,
      hoursPerDay: 8,
      timeBilled: true,
      environment: index % 2 === 0 ? 'Production' : 'Dev',
    }));

    const buffer = await generateCalculatorPdfReport(result({ lineItems: many }), options);

    expect(isPdf(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(10000);
  });
});
