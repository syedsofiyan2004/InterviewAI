import * as fs from 'fs';
import * as path from 'path';
import { analyseWorkbook } from '../lambdas/api-handler/calculator-workbook';
import { buildPrompt } from '../lambdas/calculator-orchestrator/prompt';
import {
  DEFAULT_ENVIRONMENT_HOURS,
  type CalculationRecord,
  type CalculationResource,
} from '../schema/calculator';

/**
 * What the estimator is actually asked to price.
 *
 * This is the last place information can be lost. The analyser can read a workbook
 * perfectly and the loop can price flawlessly, and the estimate is still wrong if the
 * prompt in between drops the purchase model, converts a monthly schedule to a daily
 * one, or folds two differently-configured machines onto one line. None of those
 * failures raise an error -- they produce a plausible number that is wrong -- so they
 * are asserted here rather than left to inspection.
 *
 * The grouping is the part most worth testing. Folding 110 rows into ~40 lines is what
 * makes a real inventory fit in a prompt at all, but a fold that loses a distinction
 * prices machines at the wrong rate, and a fold that loses a machine under-counts the
 * bill. So every test below checks both directions: what must merge, and what must not.
 */

const REAL_WORKBOOK = path.join(__dirname, '..', '..', 'docs', 'COSEC_AWS_TCO_Model.xlsx');
const hasRealWorkbook = fs.existsSync(REAL_WORKBOOK);

/** A record with the parts buildPrompt reads, and nothing it does not. */
function record(overrides: Partial<CalculationRecord> = {}): CalculationRecord {
  return {
    calculation_id: 'calc-1',
    owner_user_id: 'user-1',
    name: 'Estimate',
    prompt: '',
    status: 'PROCESSING',
    environment_hours: DEFAULT_ENVIRONMENT_HOURS,
    resources: [],
    input_warnings: [],
    created_at: 1,
    updated_at: 1,
    ...overrides,
  } as CalculationRecord;
}

/** One inventory row. `raw` is the only required field on the schema. */
function row(fields: Partial<CalculationResource> = {}): CalculationResource {
  return { raw: 'row', ...fields };
}

/** The numbered scenario lines, so a test can count groups without matching prose. */
function groupLines(prompt: string, heading: 'SCENARIO 1' | 'SCENARIO 2'): string[] {
  const from = prompt.indexOf(heading);
  if (from === -1) return [];
  const rest = prompt.slice(from).split('\n').slice(1);
  const lines: string[] = [];
  for (const line of rest) {
    if (/^\s*$/.test(line)) continue;
    if (/^\d+\. /.test(line)) { lines.push(line); continue; }
    // Any other non-blank line after the group list has started ends the table.
    if (lines.length) break;
  }
  return lines;
}

/** Total machines the scenario table claims, read back out of "N x ..." . */
function machinesIn(lines: string[]): number {
  return lines.reduce((sum, line) => {
    const match = /^\d+\.\s+(\d+) x /.exec(line);
    return sum + (match ? Number(match[1]) : 0);
  }, 0);
}

describe('Folding rows into groups', () => {
  test('identical machines become one line carrying the count', () => {
    const rows = Array.from({ length: 12 }, (_, index) => row({
      environment: 'Production', service: 'Amazon EC2', size: 'm6a.xlarge',
      os: 'Windows', name: `APPSRV${index}`,
    }));

    const lines = groupLines(buildPrompt(record(), rows), 'SCENARIO 1');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('12 x m6a.xlarge');
    expect(machinesIn(lines)).toBe(12);
  });

  test('a quantity column multiplies into the count rather than being ignored', () => {
    // The simple template's Qty column. Counting rows instead of quantities here would
    // price 2 machines as 1 and under-bill by half.
    const lines = groupLines(buildPrompt(record(), [
      row({ service: 'EC2', size: 't3.large', quantity: '4' }),
      row({ service: 'EC2', size: 't3.large', quantity: '2' }),
    ]), 'SCENARIO 1');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('6 x t3.large');
  });

  test('a missing or unusable quantity counts as one machine, never as zero', () => {
    const lines = groupLines(buildPrompt(record(), [
      row({ service: 'EC2', size: 't3.large' }),
      row({ service: 'EC2', size: 't3.large', quantity: 'two' }),
      row({ service: 'EC2', size: 't3.large', quantity: '0' }),
    ]), 'SCENARIO 1');

    // Dropping an unreadable quantity to 0 would silently delete a machine from the
    // estimate; the row exists, so it is at least one.
    expect(lines[0]).toContain('3 x t3.large');
  });

  test.each([
    ['operating system', { os: 'Windows' }, { os: 'Linux' }],
    ['purchase model', { purchase_model: 'On-Demand' }, { purchase_model: '3-Yr No Upfront' }],
    ['region', { region: 'eu-central-1' }, { region: 'ap-south-1' }],
    ['environment', { environment: 'Production' }, { environment: 'Dev' }],
    ['monthly schedule', { hoursPerMonth: 730 }, { hoursPerMonth: 260 }],
    ['daily schedule', { hoursPerDay: 24 }, { hoursPerDay: 8 }],
    ['spec', { vcpu: 4, ram_gb: 16 }, { vcpu: 8, ram_gb: 32 }],
  ])('machines differing only by %s stay on separate lines', (_label, a, b) => {
    // Each of these changes the rate, the term or the hours. Merging them would price
    // one of the two at the other's cost and report no error at all.
    const lines = groupLines(buildPrompt(record(), [
      row({ service: 'EC2', size: 'm6a.large', ...a }),
      row({ service: 'EC2', size: 'm6a.large', ...b }),
    ]), 'SCENARIO 1');

    expect(lines).toHaveLength(2);
    expect(machinesIn(lines)).toBe(2);
  });

  test('disk is summed across the group instead of splitting it', () => {
    // Two identical machines with different data volumes are one compute line. GB-month
    // prices linearly, so the total is exact -- and keying groups on disk instead would
    // shatter a 110-row inventory into 110 lines and defeat the whole fold.
    const lines = groupLines(buildPrompt(record(), [
      row({ service: 'EC2', size: 'm6a.large', disk_gb: 100 }),
      row({ service: 'EC2', size: 'm6a.large', disk_gb: 250 }),
    ]), 'SCENARIO 1');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('2 x m6a.large');
    expect(lines[0]).toContain('disk=350 GB total');
  });

  test('a quantity multiplies its disk too', () => {
    const lines = groupLines(buildPrompt(record(), [
      row({ service: 'EC2', size: 'm6a.large', disk_gb: 100, quantity: '3' }),
    ]), 'SCENARIO 1');

    expect(lines[0]).toContain('disk=300 GB total');
  });

  test('machine names are carried, bounded, so a reader can find the group in their sheet', () => {
    const rows = Array.from({ length: 30 }, (_, index) => row({
      service: 'EC2', size: 'm6a.large', name: `SRV${index}`,
    }));

    const lines = groupLines(buildPrompt(record(), rows), 'SCENARIO 1');

    expect(lines[0]).toContain('e.g. SRV0, SRV1, SRV2');
    // Three examples, not thirty: the point of grouping is that the names do not all fit.
    expect(lines[0]).not.toContain('SRV3,');
  });

  test('biggest groups come first, so a truncation cap drops the least money', () => {
    const rows = [
      row({ service: 'EC2', size: 'small.one' }),
      ...Array.from({ length: 5 }, () => row({ service: 'EC2', size: 'big.one' })),
    ];

    const lines = groupLines(buildPrompt(record(), rows), 'SCENARIO 1');

    expect(lines[0]).toContain('5 x big.one');
    expect(lines[1]).toContain('1 x small.one');
  });
});

describe('Carrying the schedule', () => {
  test('a stated monthly figure is passed as hrs/month, never converted', () => {
    // "On-Demand 12x5" is exactly 260 hours a month. Converting it to hours per day
    // gives 8.55 -- not a whole number -- so a prompt that only speaks in hours/day
    // has to round, and rounding to 9 over-bills every such row by 5%.
    const lines = groupLines(buildPrompt(record(), [
      row({ service: 'EC2', size: 'm6a.large', hoursPerMonth: 260, hoursPerDay: 8.55 }),
    ]), 'SCENARIO 1');

    expect(lines[0]).toContain('260 hrs/month');
    expect(lines[0]).not.toContain('hrs/day');
  });

  test("a row's own hours beat its environment's default", () => {
    const lines = groupLines(buildPrompt(record(), [
      row({ service: 'EC2', size: 'm6a.large', environment: 'Dev', hoursPerDay: 20 }),
    ]), 'SCENARIO 1');

    expect(lines[0]).toContain('20 hrs/day');
  });

  test("an environment's default applies when the row states nothing", () => {
    // Dev is 8h/day in DEFAULT_ENVIRONMENT_HOURS. Falling through to 24 here would
    // triple the cost of every dev machine, which is the exact error this feature exists
    // to avoid.
    const lines = groupLines(buildPrompt(record(), [
      row({ service: 'EC2', size: 'm6a.large', environment: 'Dev' }),
    ]), 'SCENARIO 1');

    expect(lines[0]).toContain('8 hrs/day');
  });

  test('an environment nobody configured falls back to always-on', () => {
    // Over-stating is the safe direction: a surprise on the invoice is worse than a
    // conservative estimate, and the environment table is shown alongside the result.
    const lines = groupLines(buildPrompt(record(), [
      row({ service: 'EC2', size: 'm6a.large', environment: 'QA-sandbox' }),
    ]), 'SCENARIO 1');

    expect(lines[0]).toContain('24 hrs/day');
  });

  test('environment names match their defaults regardless of case and padding', () => {
    const lines = groupLines(buildPrompt(record(), [
      row({ service: 'EC2', size: 'm6a.large', environment: '  dev ' }),
    ]), 'SCENARIO 1');

    expect(lines[0]).toContain('8 hrs/day');
  });
});

describe('The right-sized scenario', () => {
  test('a second table appears only when the sheet recommended something different', () => {
    const withoutRecommendation = buildPrompt(record(), [
      row({ service: 'EC2', size: 'm6a.large' }),
    ]);
    expect(withoutRecommendation).not.toContain('SCENARIO 2');
    // With one sizing there is nothing to compare, so the first table is not labelled
    // as a scenario the reader has to choose between either.
    expect(groupLines(withoutRecommendation, 'SCENARIO 1')).toHaveLength(1);

    const withRecommendation = buildPrompt(record(), [
      row({ service: 'EC2', size: 'm6a.xlarge', right_sized_size: 'm6a.large' }),
    ]);
    expect(withRecommendation).toContain('SCENARIO 2');
  });

  test('the second table is grouped by the recommendation, the first by the target', () => {
    const rows = [
      row({ service: 'EC2', size: 'm6a.xlarge', right_sized_size: 'm6a.large' }),
      row({ service: 'EC2', size: 'm6a.2xlarge', right_sized_size: 'm6a.large' }),
    ];

    const prompt = buildPrompt(record(), rows);

    // Two distinct targets, one shared recommendation: 2 baseline lines, 1 right-sized.
    expect(groupLines(prompt, 'SCENARIO 1')).toHaveLength(2);
    const rightsized = groupLines(prompt, 'SCENARIO 2');
    expect(rightsized).toHaveLength(1);
    expect(rightsized[0]).toContain('2 x m6a.large');
  });

  test('rows with no recommendation keep their baseline size in the second table', () => {
    // The real workbook right-sizes only a minority of its rows. Dropping the rest from
    // scenario 2 would make it look far cheaper than it is by simply pricing fewer
    // machines, which is the most dangerous possible error in a savings comparison.
    const rows = [
      row({ service: 'EC2', size: 'm6a.xlarge', right_sized_size: 'm6a.large' }),
      row({ service: 'EC2', size: 'r6i.4xlarge' }),
    ];

    const prompt = buildPrompt(record(), rows);
    const baseline = groupLines(prompt, 'SCENARIO 1');
    const rightsized = groupLines(prompt, 'SCENARIO 2');

    expect(machinesIn(rightsized)).toBe(machinesIn(baseline));
    expect(rightsized.join('\n')).toContain('r6i.4xlarge');
  });

  test('a recommended size is never shown beside the spec it is moving away from', () => {
    // The baseline vCPU/RAM describe the machine being replaced. Printed next to the
    // recommendation they contradict it -- "r6a.large, 16 vCPU / 128 GB RAM" -- and
    // invite the model to size from the spec instead of the instance type it was given.
    const prompt = buildPrompt(record(), [
      row({ service: 'EC2', size: 'r6a.4xlarge', vcpu: 16, ram_gb: 128, right_sized_size: 'r6a.large' }),
    ]);

    const baseline = groupLines(prompt, 'SCENARIO 1')[0];
    const rightsized = groupLines(prompt, 'SCENARIO 2')[0];

    expect(baseline).toContain('16 vCPU / 128 GB RAM');
    expect(rightsized).toContain('r6a.large');
    expect(rightsized).not.toContain('128 GB RAM');
  });

  test('a stated right-sized spec is used, and an unchanged size keeps its own', () => {
    const withSpec = groupLines(buildPrompt(record(), [
      row({ service: 'EC2', size: 'r6a.4xlarge', vcpu: 16, ram_gb: 128, right_sized_size: 'r6a.large', right_sized_vcpu: 2, right_sized_ram_gb: 16 }),
    ]), 'SCENARIO 2')[0];
    expect(withSpec).toContain('2 vCPU / 16 GB RAM');

    // No recommendation, so nothing changed and the spec is still the machine's own.
    const unchanged = groupLines(buildPrompt(record(), [
      row({ service: 'EC2', size: 'r6a.4xlarge', vcpu: 16, ram_gb: 128, right_sized_size: 'r6a.4xlarge' }),
    ]), 'SCENARIO 2')[0];
    expect(unchanged).toContain('16 vCPU / 128 GB RAM');
  });

  test('the shareable link is pinned to the baseline', () => {
    const prompt = buildPrompt(record(), [
      row({ service: 'EC2', size: 'm6a.xlarge', right_sized_size: 'm6a.large' }),
    ]);

    expect(prompt).toMatch(/do NOT build a second calculator\.aws estimate/i);
  });
});

describe('Carrying what the workbook said', () => {
  const insights = {
    file_name: 'client.xlsx',
    sheets: [{ name: 'Server Inventory', rows: 115, detail: '110 servers read' }],
    primary_region: 'eu-central-1',
    dr_region: 'eu-west-1',
    regions: ['eu-central-1', 'eu-west-1'],
    currency: 'EUR',
    fx_rate: 1.08,
    reported_monthly_total: 33042.56,
    facts: [{ sheet: 'Assumptions', label: 'Licensing', value: 'SQL Server is BYOL' }],
    rate_card: [{ sheet: 'Pricing Inputs', item: 'm6a.large 3-Yr No Upfront', unit: 'Hourly Rate ($)', rate: 0.05383 }],
    reported: [
      { sheet: 'AWS Compute Cost', label: 'TOTAL', monthly: 19871.19 },
      { sheet: 'Azure Baseline', label: 'Jan-2025', monthly: 24310 },
    ],
    excerpts: [{ sheet: 'Notes', text: 'Migration window is Q3' }],
    server_count: 110,
    total_disk_gb: 6269.4,
    dr_eligible_count: 64,
  };

  const prompt = buildPrompt(record({ workbook: insights, region: 'eu-central-1' }), [
    row({ service: 'EC2', size: 'm6a.large' }),
  ]);

  test('the region, DR region, currency and FX rate all survive', () => {
    // None of these appear in any column of the example workbook -- they are stated once
    // on an assumptions tab. Losing them prices 110 servers in the wrong region and
    // reports nothing wrong.
    expect(prompt).toContain('eu-central-1');
    expect(prompt).toContain('eu-west-1');
    expect(prompt).toContain('EUR');
    expect(prompt).toContain('1.08');
  });

  test('the inventory totals survive as a cross-check', () => {
    expect(prompt).toContain('110');
    expect(prompt).toContain('6269.4 GB');
    expect(prompt).toContain('64 marked DR-eligible');
  });

  test("the client's own assumptions are passed as binding", () => {
    expect(prompt).toContain('SQL Server is BYOL');
  });

  test("the client's rate card is fenced off as comparison-only", () => {
    const at = prompt.indexOf('m6a.large 3-Yr No Upfront');
    expect(at).toBeGreaterThan(-1);
    // The rates are included so the report can show a variance. A model built months
    // ago is priced at rates that have moved, so pricing FROM them would hide exactly
    // the discrepancy the estimate exists to find.
    const heading = prompt.slice(0, at);
    expect(heading).toMatch(/COMPARISON ONLY/);
    expect(heading).toMatch(/never price anything from these/i);
  });

  test('per-sheet totals are labelled by sheet and marked as not addable', () => {
    // "Azure Baseline" is the CURRENT platform's spend, not the AWS target. Adding it to
    // the AWS compute total would roughly double the answer.
    expect(prompt).toContain('[AWS Compute Cost] TOTAL');
    expect(prompt).toContain('[Azure Baseline] Jan-2025');
    expect(prompt).toMatch(/Do NOT add these together/);
  });

  test("the workbook's own total is asked for verbatim, as a comparison and not a price", () => {
    expect(prompt).toContain('33042.56');
    expect(prompt).toContain('reportedMonthlyTotal');
    expect(prompt).toMatch(/not an answer/);
  });

  test('unstructured blocks are passed through', () => {
    expect(prompt).toContain('Migration window is Q3');
  });

  test('parse warnings reach the model so they can reach the client', () => {
    const withWarnings = buildPrompt(
      record({ input_warnings: ['Row 44 states 48 hours per day, outside 1-24; the environment default was used.'] }),
      [row({ service: 'EC2', size: 'm6a.large' })],
    );

    expect(withWarnings).toContain('outside 1-24');
    expect(withWarnings).toMatch(/carry any that affect the estimate into warnings/i);
  });
});

describe('Rows that were never structured', () => {
  test('free text is passed verbatim rather than dropped', () => {
    const prompt = buildPrompt(record(), [
      row({ raw: 'two web servers, medium sized | mumbai' }),
      row({ raw: 'one postgres database | mumbai' }),
    ]);

    expect(prompt).toContain('two web servers, medium sized | mumbai');
    expect(prompt).toContain('one postgres database | mumbai');
    // Nothing was structured, so there is no group table to price.
    expect(prompt).not.toContain('SCENARIO 1');
  });

  test('a spec with no instance type is priceable, not free text', () => {
    // "8 vCPU / 32 GB, no SKU" is a sizing request, and the model can pick an instance
    // for it. Treating it as prose would lose the environment and the hours.
    const prompt = buildPrompt(record(), [row({ vcpu: 8, ram_gb: 32, environment: 'Dev' })]);
    const lines = groupLines(prompt, 'SCENARIO 1');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('8 vCPU / 32 GB RAM');
    expect(prompt).toMatch(/smallest current-generation instance that meets its vCPU and RAM/);
  });

  test('structured and unstructured rows coexist without either being lost', () => {
    const prompt = buildPrompt(record(), [
      row({ service: 'EC2', size: 'm6a.large' }),
      row({ raw: 'plus whatever the analytics team needs' }),
    ]);

    expect(machinesIn(groupLines(prompt, 'SCENARIO 1'))).toBe(1);
    expect(prompt).toContain('plus whatever the analytics team needs');
  });
});

describe('Bounds', () => {
  test('a huge landscape still folds into a prompt of workable size', () => {
    // 4000 machines across 40 configurations: exactly the shape of a data-centre exit.
    // Sent verbatim this is megabytes of near-identical lines; folded it is 40.
    const rows = Array.from({ length: 4000 }, (_, index) => row({
      service: 'Amazon EC2', size: `m6a.size${index % 40}`, os: 'Linux',
      environment: 'Production', disk_gb: 100, name: `SRV${index}`,
    }));

    const prompt = buildPrompt(record(), rows);
    const lines = groupLines(prompt, 'SCENARIO 1');

    expect(lines).toHaveLength(40);
    expect(machinesIn(lines)).toBe(4000);
    expect(prompt.length).toBeLessThan(40_000);
  });

  test('groups past the cap are announced, never silently dropped', () => {
    // 200 distinct configurations against a cap of 120. Whatever does not fit has to be
    // declared: an estimate that quietly prices 60% of a landscape is worse than one
    // that admits it, because nobody can tell from the total.
    const rows = Array.from({ length: 200 }, (_, index) => row({
      service: 'Amazon EC2', size: `m6a.size${index}`,
    }));

    const prompt = buildPrompt(record(), rows);
    const lines = groupLines(prompt, 'SCENARIO 1');

    expect(lines).toHaveLength(120);
    expect(prompt).toMatch(/80 smaller group\(s\) covering 80 machine\(s\) are not listed/);
    expect(prompt).toMatch(/do not silently omit them/i);
  });

  test('a wall of free text is capped and the remainder counted', () => {
    const rows = Array.from({ length: 100 }, (_, index) => row({ raw: `unreadable line ${index}` }));

    const prompt = buildPrompt(record(), rows);

    expect(prompt).toContain('unreadable line 0');
    expect(prompt).not.toContain('unreadable line 99');
    expect(prompt).toMatch(/40 further unstructured row\(s\) not shown/);
  });
});

describe('A prose-only estimate', () => {
  test('the prompt is the description and the environment table, with no empty sections', () => {
    const prompt = buildPrompt(record({
      prompt: 'A small Django app: two web servers and a Postgres database.',
      region: 'ap-south-1',
    }), []);

    expect(prompt).toContain('A small Django app');
    expect(prompt).toContain('Production: 24 hours/day');
    expect(prompt).toContain('Default region where a row does not state one: ap-south-1.');
    // No sheet was uploaded, so nothing about a workbook, a scenario or a rate card
    // should appear -- an empty heading invites the model to invent content for it.
    expect(prompt).not.toContain('SCENARIO');
    expect(prompt).not.toContain('UPLOADED WORKBOOK');
    expect(prompt).not.toContain('rate');
  });

  test("the workbook's region is used when the form left it blank", () => {
    const prompt = buildPrompt(
      record({ workbook: { sheets: [], regions: [], facts: [], rate_card: [], reported: [], excerpts: [], server_count: 0, total_disk_gb: 0, dr_eligible_count: 0, primary_region: 'eu-central-1' } }),
      [row({ service: 'EC2', size: 'm6a.large' })],
    );

    expect(prompt).toMatch(/No region was chosen on the form, so use the one the workbook states \(eu-central-1\)/);
  });
});

// ---------------------------------------------------------------------------
// End to end, on the real thing
// ---------------------------------------------------------------------------

const describeReal = hasRealWorkbook ? describe : describe.skip;

describeReal('The COSEC model, from file to prompt', () => {
  let prompt: string;
  let analysis: Awaited<ReturnType<typeof analyseWorkbook>>;

  beforeAll(async () => {
    analysis = await analyseWorkbook(fs.readFileSync(REAL_WORKBOOK), 'COSEC_AWS_TCO_Model.xlsx');
    prompt = buildPrompt(
      record({
        name: 'COSEC migration',
        prompt: 'Price the attached Azure-to-AWS migration model.',
        workbook: analysis.insights,
        input_warnings: analysis.warnings.slice(0, 16),
        region: 'eu-central-1',
      }),
      analysis.resources,
    );
  }, 120_000);

  test('every one of the 110 servers reaches the prompt', () => {
    // The single most important assertion here. Folding must be lossless: 110 rows in,
    // 110 machines out, however many lines they occupy.
    const lines = groupLines(prompt, 'SCENARIO 1');
    expect(machinesIn(lines)).toBe(110);
    // And it must actually fold. 110 rows across 10 sheets of context reduce to 25
    // configurations; a regression that keyed groups on something per-machine (a disk
    // size, a hostname) would pass the count check above and fail here.
    expect(lines.length).toBeLessThan(60);
  });

  test('both scenarios are present and cover the same machines', () => {
    // The workbook right-sizes a minority of its rows, so the two tables differ in
    // shape but must describe the same fleet.
    expect(machinesIn(groupLines(prompt, 'SCENARIO 2'))).toBe(110);
  });

  test('the right-sized table is genuinely different from the baseline', () => {
    const baseline = groupLines(prompt, 'SCENARIO 1').join('\n');
    const rightsized = groupLines(prompt, 'SCENARIO 2').join('\n');
    expect(rightsized).not.toBe(baseline);
  });

  test('the workbook facts that govern the estimate are all in the prompt', () => {
    // Region and DR region are stated in prose on sheet 1 and appear in no column.
    expect(prompt).toContain('eu-central-1');
    expect(prompt).toMatch(/Machines listed: 110/);
  });

  test('the prompt is small enough to leave the model room to work', () => {
    // ~33k chars, about 8k tokens: 4% of the window, so the remaining 96% is available
    // for eight minutes of tool results (a single get_service_fields catalogue is large).
    // A verbatim 110-row dump plus ten sheets of context does not leave that room.
    expect(prompt.length).toBeLessThan(60_000);
  });

  test('nothing important was silently truncated', () => {
    // 63 facts and 45 rates, all of them through. The first cut of the prompt builder
    // capped facts at 40 and quietly dropped the Transit Gateway DR attachment, the
    // separate AWS Backup line and the domain-controller sizing -- all cost-bearing.
    // This is the assertion that catches a cap set below what a real client model holds.
    expect(prompt).not.toMatch(/not listed/);
    expect(prompt).not.toMatch(/not shown/);
    expect(prompt).toContain('Transit Gateway');
  });
});
