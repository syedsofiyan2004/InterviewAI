import { generateCalculatorPdfReport, scenarioSections, schedulingSaving } from '../lambdas/shared/calculator-report';
import type { CalculationResult, CalculationScenario } from '../schema/calculator';

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

/**
 * The scenarios section, which is where a banded model gets its links.
 *
 * An uploaded capacity model is often not one workload. It may be banded by fiscal year
 * (`26-27` … `30-31`) or by lower environment (Dev, QA, UAT), each band a whole column of
 * usage figures priced into its own calculator.aws estimate. The three kinds of band are
 * NOT interchangeable, and the difference decides whether their totals may be added:
 *
 *  - `sizing`      one workload costed two ways, so only one will ever be spent. Never summed.
 *  - `period`      consecutive years, spent in sequence. A sum is multi-year, never monthly.
 *  - `environment` concurrent, so these genuinely do add up.
 *
 * Getting that wrong does not throw — it prints a confident, plausible, wrong headline
 * figure on a document a client sets a budget from, which is why the assertions below are
 * about wording as much as arithmetic. `scenarioSections` is asserted directly rather than
 * through the rendered PDF because the copy IS the safety mechanism: a table of five
 * monthly figures for five years and a table of three monthly figures for three concurrent
 * environments are visually identical, and only the sentence above them says which may be
 * added up.
 */
describe('Scenario sections', () => {
  const sizingPair = (): CalculationScenario[] => [
    { key: 'baseline', label: 'Lift and shift', kind: 'sizing', monthly: 1000, url: 'https://calculator.aws/#/estimate?id=base', detail: 'As the uploaded model specifies' },
    { key: 'rightsized', label: 'Right-sized', kind: 'sizing', monthly: 800, url: 'https://calculator.aws/#/estimate?id=right', detail: 'One instance family down where utilisation allows' },
  ];

  const years = (): CalculationScenario[] => ['26-27', '27-28', '28-29', '29-30', '30-31']
    .map((label, index) => ({
      key: label,
      label,
      kind: 'period' as const,
      monthly: 1000 + index * 250,
      url: `https://calculator.aws/#/estimate?id=year${index}`,
      detail: `Fiscal ${label} usage column`,
    }));

  const lowerEnvironments = (): CalculationScenario[] => ['Dev', 'Testing (QA)', 'UAT']
    .map((label, index) => ({
      key: label,
      label,
      kind: 'environment' as const,
      monthly: 400 + index * 100,
      url: `https://calculator.aws/#/estimate?id=env${index}`,
    }));

  test('a sizing pair keeps its own heading, its own column titles and its saving line', () => {
    // The lift-and-shift path is the common one and the regression that matters most.
    // Generalising to N bands must not have cost it the right-sizing saving, which is the
    // entire point of running the exercise.
    const [section, ...rest] = scenarioSections(result({ scenarios: sizingPair() }));

    expect(rest).toEqual([]);
    expect(section.kind).toBe('sizing');
    expect(section.title).toBe('Sizing scenarios');
    expect(section.labelColumn).toBe('Scenario');
    expect(section.basisColumn).toBe('How it was sized');
    expect(section.saving).toBe('Right-sizing saves $200.00 per month - $2,400.00 a year, or 20% of the baseline.');
  });

  test('a sizing pair is never given a total', () => {
    // $1,000 baseline plus $800 right-sized is $1,800, a figure nobody will ever be
    // billed: the two are alternatives and only one of them gets spent. A total here would
    // be arithmetically correct and completely false.
    expect(scenarioSections(result({ scenarios: sizingPair() }))[0].total).toBeNull();
  });

  test('five years each keep their own distinct link', () => {
    // The requirement the whole change exists for. One link for a five-year model is not
    // something a client can act on -- they need the year they are budgeting for.
    const [section] = scenarioSections(result({ scenarios: years() }));

    expect(section.scenarios.map((entry) => entry.label)).toEqual(['26-27', '27-28', '28-29', '29-30', '30-31']);
    const urls = section.scenarios.map((entry) => entry.url);
    expect(new Set(urls).size).toBe(5);
    expect(urls[0]).toBe('https://calculator.aws/#/estimate?id=year0');
    expect(urls[4]).toBe('https://calculator.aws/#/estimate?id=year4');
  });

  test('years are titled and worded as years, and the total is stated as multi-year', () => {
    // 1000+1250+1500+1750+2000 = 7500 monthly across the band. Reported as $90,000, the
    // sum of each year's annual cost -- NOT as $7,500 per month, which is the mistake this
    // sentence exists to prevent and would overstate the bill fivefold.
    const [section] = scenarioSections(result({ scenarios: years() }));

    expect(section.title).toBe('Cost by year');
    expect(section.labelColumn).toBe('Year');
    expect(section.prose).toContain('run one after another');
    expect(section.prose).toContain('does not give a monthly bill');
    expect(section.total).toContain('$90,000.00');
    expect(section.total).toContain('multi-year total, not a monthly figure');
    // The one thing the total must never say.
    expect(section.total).not.toMatch(/\$7,500\.00/);
  });

  test('no saving is ever computed between two years', () => {
    // 26-27 costs $1,000 and 30-31 costs $2,000. That is a rise in a capacity plan, not a
    // saving and not an overspend, and there is no pair of years whose difference belongs
    // in a "saves you" sentence.
    expect(scenarioSections(result({ scenarios: years() }))[0].saving).toBeNull();
  });

  test('a lone year band produces no saving even when keyed like a sizing pair', () => {
    // Defence in depth. `key` is a free string now, so a sheet whose columns happen to be
    // named "baseline" and "rightsized" must still not have a right-sizing saving invented
    // for it once its kind says these are years.
    const [section] = scenarioSections(result({
      scenarios: [
        { key: 'baseline', label: '26-27', kind: 'period', monthly: 1000, url: null },
        { key: 'rightsized', label: '27-28', kind: 'period', monthly: 800, url: null },
      ],
    }));

    expect(section.kind).toBe('period');
    expect(section.saving).toBeNull();
  });

  test('concurrent environments are described as adding up, and are totalled monthly', () => {
    // 400+500+600 = 1500. Dev, QA and UAT run at the same time, so unlike the years this
    // total genuinely is a monthly figure and saying so is correct rather than dangerous.
    const [section] = scenarioSections(result({ scenarios: lowerEnvironments() }));

    expect(section.labelColumn).toBe('Environment');
    expect(section.prose).toContain('at the same time');
    expect(section.prose).toContain('genuinely do add up');
    expect(section.total).toBe('All 3 environments running together: $1,500.00 per month, $18,000.00 per year.');
    expect(section.saving).toBeNull();
  });

  test('environments are not described the way years are', () => {
    // The failure this guards is a single shared blurb: concurrent environments told to
    // the reader as "spent one after another" would make them stop adding up figures that
    // do add up, and understate the landscape by two thirds. So the two kinds are compared
    // against each other rather than against a fixed string -- if anyone ever collapses
    // the copy back into one sentence, one of the two readings becomes false and this
    // fails, whichever sentence survives.
    const [environments] = scenarioSections(result({ scenarios: lowerEnvironments() }));
    const [period] = scenarioSections(result({ scenarios: years() }));

    expect(environments.prose).not.toBe(period.prose);
    expect(environments.prose).toContain('rather than one after another');
    expect(environments.prose).not.toContain('does not give a monthly bill');
    expect(environments.title).not.toBe(period.title);
    // And not the same heading as the per-environment rollup section further down the
    // document, which is a different claim about different numbers.
    expect(environments.title).not.toBe('Cost by environment');
  });

  test('a result carrying two kinds gets a section for each, in a stable order', () => {
    // Digital_Assets.xlsx is exactly this: five fiscal years in one band and three lower
    // environments in another, on one sheet. Merging them into one table would put a year
    // and an environment in the same column under one total that means neither.
    const sections = scenarioSections(result({ scenarios: [...lowerEnvironments(), ...years()] }));

    expect(sections.map((entry) => entry.kind)).toEqual(['period', 'environment']);
    expect(sections.map((entry) => entry.scenarios.length)).toEqual([5, 3]);
  });

  test('an unpriced band is counted out of its total in writing', () => {
    // A partly-priced band still gets the only figure available, but silently totalling
    // three of five years and labelling it "across all 5 years" understates the plan.
    const scenarios = years();
    scenarios[3].monthly = null;
    scenarios[4].monthly = null;
    const [section] = scenarioSections(result({ scenarios }));

    expect(section.total).toContain('2 of the 5 could not be priced and are not in this total');
  });

  test('a band with nothing priced at all gets no total rather than a zero', () => {
    // $0.00 in a client document reads as free, which is a different claim from "AWS
    // returned no rate for any of these".
    const scenarios = years().map((entry) => ({ ...entry, monthly: null }));
    expect(scenarioSections(result({ scenarios }))[0].total).toBeNull();
  });

  test('a prose estimate has no sections at all', () => {
    // Nothing was banded, so there is nothing to compare and no second link to offer.
    expect(scenarioSections(result({ scenarios: [] }))).toEqual([]);
    expect(scenarioSections(result({}))).toEqual([]);
  });

  test('an estimate stored before kind and url existed is still a sizing comparison', () => {
    // There are real records like this in DynamoDB: two scenarios, no `kind`, no `url`.
    // They must keep rendering as the baseline/right-sized pair they are -- including the
    // saving line, which is the only reason that section was ever worth printing.
    const [section] = scenarioSections(result({
      scenarios: [
        { key: 'baseline', label: 'Lift and shift', monthly: 1000 },
        { key: 'rightsized', label: 'Right-sized', monthly: 750 },
      ] as unknown as CalculationScenario[],
    }));

    expect(section.kind).toBe('sizing');
    expect(section.title).toBe('Sizing scenarios');
    expect(section.saving).toContain('Right-sizing saves $250.00 per month');
  });

  test('a scenario with no label is dropped rather than printed as a blank row', () => {
    const sections = scenarioSections(result({
      scenarios: [...sizingPair(), { key: 'ghost', label: '', kind: 'sizing', monthly: 5, url: null }],
    }));

    expect(sections[0].scenarios).toHaveLength(2);
  });
});

describe('Rendering scenario bands into the PDF', () => {
  const isPdf = (buffer: Buffer) => buffer.subarray(0, 5).toString() === '%PDF-';

  const banded = (kind: 'period' | 'environment', labels: string[], withUrls = true): CalculationResult => result({
    scenarios: labels.map((label, index) => ({
      key: label,
      label,
      kind,
      monthly: 1000 + index * 250,
      url: withUrls ? `https://calculator.aws/#/estimate?id=${kind}-${index}-0123456789abcdef0123456789abcdef` : null,
      detail: `${label} usage column from the uploaded sheet`,
    })),
    lineItems: [{ service: 'EC2', detail: '4 x m6a.xlarge', monthly: 900, hoursPerDay: 24, timeBilled: true, environment: 'Production' }],
    monthlyTotal: 1000,
  });

  test('five years with five links render a document', async () => {
    const buffer = await generateCalculatorPdfReport(banded('period', ['26-27', '27-28', '28-29', '29-30', '30-31']), options);

    expect(isPdf(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(4000);
  });

  test('three lower environments with three links render a document', async () => {
    const buffer = await generateCalculatorPdfReport(banded('environment', ['Dev', 'Testing (QA)', 'UAT']), options);

    expect(isPdf(buffer)).toBe(true);
  });

  test('a band whose estimates never exported still renders', async () => {
    // The pipeline can price a band and still fail at export_estimate. Every url is null
    // here, and the section has to say so rather than draw an empty line where a link goes.
    const buffer = await generateCalculatorPdfReport(banded('period', ['26-27', '27-28'], false), options);

    expect(isPdf(buffer)).toBe(true);
  });

  test('eight bands across two kinds render without throwing', async () => {
    // The customer sheet this was built for: five fiscal years plus three lower
    // environments, eight estimates and eight links in one document.
    const eight = result({
      scenarios: [
        ...['26-27', '27-28', '28-29', '29-30', '30-31'].map((label, index) => ({
          key: label, label, kind: 'period' as const, monthly: 1000 + index * 250,
          url: `https://calculator.aws/#/estimate?id=y${index}`,
        })),
        ...['Dev', 'Testing (QA)', 'UAT'].map((label, index) => ({
          key: label, label, kind: 'environment' as const, monthly: 400 + index * 100,
          url: `https://calculator.aws/#/estimate?id=e${index}`,
        })),
      ],
      reportedMonthlyTotal: 1200,
    });

    const buffer = await generateCalculatorPdfReport(eight, options);
    expect(isPdf(buffer)).toBe(true);
  });

  test('a record with no kind and no url on its scenarios does not crash the report', async () => {
    // The DynamoDB back-catalogue. A throw here would mean every estimate priced before
    // this change loses its downloadable PDF.
    const buffer = await generateCalculatorPdfReport(result({
      scenarios: [
        { key: 'baseline', label: 'Lift and shift', monthly: 1000 },
        { key: 'rightsized', label: 'Right-sized', monthly: 820 },
      ] as unknown as CalculationScenario[],
    }), options);

    expect(isPdf(buffer)).toBe(true);
  });

  test('a URL far longer than the page width is still drawn rather than throwing', async () => {
    // linkLine shrinks a URL to fit on one line instead of letting wrap() hyphenate it,
    // and past its floor it falls back to wrapping. Both paths have to survive.
    const buffer = await generateCalculatorPdfReport(result({
      scenarios: [
        { key: 'a', label: 'A', kind: 'period', monthly: 10, url: `https://calculator.aws/#/estimate?id=${'a'.repeat(400)}` },
        { key: 'b', label: 'B', kind: 'period', monthly: 20, url: 'https://calculator.aws/#/estimate?id=b' },
      ],
    }), options);

    expect(isPdf(buffer)).toBe(true);
  });
});
