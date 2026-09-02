import {
  canonicalise,
  canonicalUnitFrom,
  inferUnit,
  numberWithQualifier,
} from '../lambdas/shared/canonical-workbook';
import type {
  CanonicalRow,
  CanonicalScenario,
  CanonicalWorkbook,
  InventoryRow,
  MetricGroupRow,
} from '../lambdas/shared/canonical-workbook';
import { HOURS_PER_MONTH, reconcile } from '../lambdas/shared/unit-contract';

/**
 * The canonical workbook.
 *
 * Three layouts arrive from three readers, and until now each of them reached the pricing
 * layer as a slightly different row, so the pricer re-derived what a number meant from
 * whichever fields happened to be filled in. These tests are written against the two
 * properties that replace that guesswork, and both are properties a test can actually
 * establish rather than assert about itself:
 *
 *  - every quantity carries an explicit CanonicalUnit, so nothing reaches a rate with an
 *    implicit dimension; and
 *  - the books balance -- every input row leaves as a priced row or as a stated exclusion,
 *    and every metric cell inside a group is accounted for too.
 *
 * The fixtures are drawn from the two reference workbooks rather than invented, because the
 * failures being prevented here are all failures of shape: docs/Digital_Assets.xlsx for the
 * transposed matrix and docs/Core BOM.xlsx for the stacked sections. Where a fixture's shape
 * is load-bearing there is a comment saying so.
 */

// A five-year capacity model's bands. Two columns minimum throughout, matching the constraint
// calculator-input.test.ts documents: a sheet only two columns wide never reaches the table
// reader at all, because "Lambda invocations/yr | 24000000" is indistinguishable from a
// label/value settings pair. A banded model has more than one band by definition.
const YEARS: CanonicalScenario[] = [
  { key: '26-27', label: '26-27', kind: 'period' },
  { key: '27-28', label: '27-28', kind: 'period' },
];

const LOWER_ENVIRONMENTS: CanonicalScenario[] = [
  { key: 'dev', label: 'Dev', kind: 'environment' },
  { key: 'testing-qa', label: 'Testing (QA)', kind: 'environment' },
  { key: 'uat', label: 'UAT', kind: 'environment' },
];

/** Shape 1: a flat server inventory, one row per machine, as readInventory produces it. */
const FLAT_INVENTORY: InventoryRow[] = [
  {
    sheet: 'Resources',
    row: 2,
    name: 'web-01',
    environment: 'Production',
    service: 'Amazon EC2',
    size: 'm6a.large',
    quantity: '2',
    region: 'ap-south-1',
    os: 'Linux',
    vcpu: 2,
    ram_gb: 8,
    disk_gb: 100,
    hoursPerDay: 24,
    hoursPerMonth: 730,
    raw: 'Production | Amazon EC2 | m6a.large | 2 | ap-south-1 | 24 | web tier',
  },
  {
    // 260 hours a month is "12x5", which no whole number of hours a day expresses. It has to
    // survive as stated hours rather than be re-derived from a daily figure.
    sheet: 'Resources',
    row: 3,
    name: 'db-01',
    environment: 'Production',
    service: 'Amazon RDS',
    size: 'db.r6g.large',
    quantity: '1',
    hoursPerMonth: 260,
    disk_gb: 500,
    raw: 'Production | Amazon RDS | db.r6g.large | 1 | 12x5',
  },
  {
    // The comment row every real sheet carries. It must be accounted for, not swallowed.
    sheet: 'Resources',
    row: 4,
    environment: 'Dev',
    notes: 'the rest is next phase',
    raw: 'Dev | | | | | | the rest is next phase',
  },
];

/**
 * Shape 3: stacked sections, one sheet per environment, from docs/Core BOM.xlsx.
 *
 * The load-bearing detail is that column meanings CHANGE between sections on one sheet:
 * column C is "Cpu" in the Server section, "class" in Redis and MQ, and "Data Instance " in
 * OpenSearch. There is no single header for the sheet, so `section` has to travel with every
 * row or the row cannot be interpreted at all. The sheet also has no blank separator rows --
 * sections are delimited only by a new header row and a merged column A -- and three of its
 * nine sections state no quantity of any kind.
 */
const CORE_BOM_SANDBOX: InventoryRow[] = [
  {
    // Three separately NAMED disks in three columns, one of them "N/A" on other rows.
    // Summing them prices the right total and loses which volume is which.
    sheet: 'Sandbox',
    row: 3,
    section: 'Server',
    name: 'foundation-node',
    environment: 'Sandbox',
    service: 'Amazon EC2',
    vcpu: 4,
    ram_gb: 16,
    os: 'Linux 2023',
    disks: [
      { label: 'Os Storage', gb: 20 },
      { label: 'Data storage for /app', gb: 50 },
      { label: 'Data storage for /app/logs', gb: 80 },
    ],
    attributes: [{ label: 'Available Zone', value: 'Single' }],
    raw: 'Server | foundation-node | 4 | 16 | Linux 2023 | 20 | 50 | 80 | Single',
  },
  {
    // "3000(GP3)" is one cell holding the provisioned IOPS and the volume type. numberFrom
    // refuses it outright; discarding the parenthetical loses a different rate.
    sheet: 'Sandbox',
    row: 10,
    section: 'Database',
    name: 'foundation-rds',
    environment: 'Sandbox',
    service: 'Amazon RDS',
    vcpu: 2,
    ram_gb: 8,
    disks: [{ label: 'storage', gb: 200 }],
    attributes: [
      { label: 'engine', value: 'MySQL 8' },
      { label: 'IOPS', value: '3000(GP3)' },
      { label: 'Multi-AZ', value: 'No' },
    ],
    raw: 'Database | foundation-rds | 2 | 8 | MySQL 8 | 200 | 3000(GP3) | No',
  },
  {
    sheet: 'Sandbox',
    row: 18,
    section: 'Storage',
    name: 'application-bucket',
    environment: 'Sandbox',
    service: 'Amazon S3',
    metric: 'Storage (GB)',
    quantity: '200',
    raw: 'Storage | application-bucket | 200',
  },
  {
    // The Loadbalancer section states a class, a listener port and a target group and no
    // quantity of anything. It is a real AWS charge that this module cannot price, so it has
    // to leave as a stated exclusion -- with its columns -- rather than as nothing.
    sheet: 'Sandbox',
    row: 15,
    section: 'Loadbalancer',
    name: 'alb',
    environment: 'Sandbox',
    service: 'Elastic Load Balancing',
    attributes: [
      { label: 'class', value: 'ALB external' },
      { label: 'Listener', value: '443' },
      { label: 'target port/protocl', value: '30000/TCP' },
      { label: 'targets', value: 'foundation-node' },
    ],
    raw: 'Loadbalancer | alb | ALB external | 443 | alb-traefik | 30000/TCP | foundation-node',
  },
  {
    // The WAF section is a two-cell label/value pair stacked VERTICALLY -- "Required" on one
    // row, "Yes" on the next. "Yes" is not a quantity and must not become one.
    sheet: 'Sandbox',
    row: 29,
    section: 'WAF',
    name: 'WAF',
    environment: 'Sandbox',
    metric: 'Required',
    quantity: 'Yes',
    raw: 'WAF | Yes',
  },
];

/** Shape 2: metric groups from the transposed matrix, one group per resource per band. */
function auroraGroup(scenario: CanonicalScenario, instances: string, storage: string): MetricGroupRow {
  return {
    sheet: 'Digital Assets',
    scenario,
    service: 'Amazon Aurora',
    cells: [
      { row: 9, label: 'Aurora instance class', value: 'db.r6g.large' },
      { row: 10, label: 'Aurora instance count (Multi-AZ: writer + reader)', value: instances },
      { row: 11, label: 'Aurora storage (GB)', value: storage },
    ],
  };
}

function lambdaGroup(scenario: CanonicalScenario, invocations: string): MetricGroupRow {
  return {
    sheet: 'Digital Assets',
    scenario,
    service: 'AWS Lambda',
    cells: [{ row: 22, label: 'Lambda (BFF) invocations/yr', value: invocations }],
  };
}

const TRANSPOSED_MATRIX: MetricGroupRow[] = [
  auroraGroup(YEARS[0], '2', '100.60652732849121'),
  lambdaGroup(YEARS[0], '24000000'),
  {
    sheet: 'Digital Assets',
    scenario: YEARS[0],
    service: 'Amazon API Gateway',
    cells: [{ row: 21, label: 'API Gateway requests (millions/yr)', value: '120' }],
  },
  auroraGroup(YEARS[1], '4', '109.1'),
  lambdaGroup(YEARS[1], '36000000'),
  {
    // The block's own title row, which carries a label and no figure anywhere. Reading a
    // resource out of a subtitle is how an estimate grows a line item nobody wrote.
    sheet: 'Digital Assets',
    scenario: YEARS[1],
    cells: [{ row: 3, label: 'Peak-to-average traffic ratio (assumption)', value: '1.4' }],
  },
];

/** Everything a row could be billed on. Used to prove no row escapes with an implicit unit. */
const CANONICAL_UNITS = [
  'hours/month', 'GB/month', 'GB-transfer/month', 'requests/month', 'invocations/month',
  'GB-seconds/month', 'vCPU-hours/month', 'GB-hours/month', 'IOPS/month', 'units/month',
];

function findRow(book: CanonicalWorkbook, match: RegExp): CanonicalRow {
  const found = book.rows.find((row) => match.test(row.label));
  if (!found) throw new Error(`no canonical row matched ${match} (labels: ${book.rows.map((r) => r.label).join(', ')})`);
  return found;
}

describe('Accounting for every input row', () => {
  test('a flat server inventory balances: every row is a priced row or a stated exclusion', () => {
    const book = canonicalise({ inventory: FLAT_INVENTORY });

    expect(book.accounting.inputRows).toBe(3);
    expect(book.accounting.canonicalRows + book.accounting.exclusions).toBe(book.accounting.inputRows);
    expect(book.accounting.balanced).toBe(true);
    // The comment row is the one that had to be excluded, and it says why in words.
    expect(book.exclusions).toHaveLength(1);
    expect(book.exclusions[0].reason).toMatch(/no size, no specification, no quantity and no usage figure/);
  });

  test('a transposed metric matrix balances at the row AND at the cell level', () => {
    const book = canonicalise({ metrics: TRANSPOSED_MATRIX, scenarios: YEARS });

    expect(book.accounting.inputRows).toBe(6);
    expect(book.accounting.canonicalRows + book.accounting.exclusions).toBe(6);
    // The row-level balance cannot see a single cell going missing inside a group that
    // otherwise priced fine, which is why the cell count is checked separately.
    expect(book.accounting.metricCells).toBe(3 + 1 + 1 + 3 + 1 + 1);
    expect(book.accounting.accountedMetricCells).toBe(book.accounting.metricCells);
    expect(book.accounting.balanced).toBe(true);
  });

  test('stacked per-environment sections balance, including the sections with no quantity', () => {
    const book = canonicalise({ inventory: CORE_BOM_SANDBOX });

    expect(book.accounting.inputRows).toBe(5);
    expect(book.accounting.balanced).toBe(true);
    // Server, Database and Storage price; Loadbalancer and WAF cannot and say so.
    expect(book.rows).toHaveLength(3);
    expect(book.exclusions.map((entry) => entry.label).sort()).toEqual(['Required', 'alb']);
  });

  test('an excluded stacked-section row keeps its columns, so nothing about it is lost', () => {
    const book = canonicalise({ inventory: CORE_BOM_SANDBOX });

    const alb = book.exclusions.find((entry) => entry.label === 'alb');
    expect(alb?.attributes).toEqual(expect.arrayContaining([
      { label: 'Listener', value: '443' },
      { label: 'target port/protocl', value: '30000/TCP' },
    ]));
    expect(alb?.provenance[0]).toMatchObject({ sheet: 'Sandbox', row: 15, section: 'Loadbalancer' });
  });

  test('a quantity the author set to zero is excluded rather than priced as one', () => {
    // "MSK broker count (Optional -- excluded from baseline)" is 0 in the real sheet. Absent
    // and zero are different statements and only one of them means "price a single unit".
    const book = canonicalise({
      inventory: [{
        sheet: 'Prod ', row: 32, service: 'Amazon MSK', size: 'kafka.m5.large', quantity: '0',
        raw: 'MSK | kafka.m5.large | 0',
      }],
    });

    expect(book.rows).toHaveLength(0);
    expect(book.exclusions[0].reason).toMatch(/stated as 0/);
    expect(book.accounting.balanced).toBe(true);
  });
});

describe('Declaring a dimension instead of leaving one implied', () => {
  test('no quantity on any of the three shapes reaches a rate without a canonical unit', () => {
    const book = canonicalise({
      inventory: [...FLAT_INVENTORY, ...CORE_BOM_SANDBOX],
      metrics: TRANSPOSED_MATRIX,
      scenarios: YEARS,
    });

    expect(book.rows.length).toBeGreaterThan(0);
    for (const row of book.rows) {
      expect(row.quantities.length).toBeGreaterThan(0);
      for (const quantity of row.quantities) {
        expect(CANONICAL_UNITS).toContain(quantity.unit);
      }
    }
  });

  test('a usage row declares itself usage, and a machine declares itself an instance', () => {
    const book = canonicalise({ metrics: TRANSPOSED_MATRIX, scenarios: YEARS });

    expect(findRow(book, /Aurora instance class/).billing).toBe('instance');
    expect(findRow(book, /Lambda \(BFF\) invocations/).billing).toBe('usage');
  });

  test('the declared unit is what makes the pricer refuse a mismatched rate', () => {
    // The point of the whole exercise, checked against the contract rather than asserted.
    // pipeline.ts:701-714 has exactly two cases -- "GB-Mo" or hourly -- so an invocation
    // count arrives there and is multiplied by 730 with no way to notice.
    const book = canonicalise({ metrics: [lambdaGroup(YEARS[0], '24000000')], scenarios: YEARS });
    const [quantity] = findRow(book, /invocations/).quantities;

    expect(reconcile(quantity.unit, 'Hrs').ok).toBe(false);
    expect(reconcile(quantity.unit, 'Requests').ok).toBe(true);
  });

  test('usage_amount and usage_unit reach the pricer with a dimension instead of being dropped', () => {
    // The purest loss in the current path: metric-matrix.ts:511-512 reads these, the analyser
    // stores them (calculator-workbook.ts:897-898), and nothing in the orchestrator ever
    // reads them back. The figure was parsed perfectly and then priced as though absent.
    const book = canonicalise({
      inventory: [{
        sheet: 'Digital Assets', row: 26, scenario: '26-27', service: 'Amazon Cognito',
        metric: 'Cognito billable MAU', usage_amount: 250_000, usage_unit: 'monthly active users',
        raw: 'Cognito billable MAU | 250000',
      }],
      scenarios: YEARS,
    });

    expect(book.rows[0].quantities).toEqual([expect.objectContaining({
      unit: 'units/month', amount: 250_000,
    })]);
    // And 'units/month' is the strictest entry in the contract, so it still cannot be
    // multiplied by a runtime even now that it is priced.
    expect(reconcile('units/month', 'Hrs').ok).toBe(false);
  });

  test('a usage_unit string that names no dimension falls back to the label, not to a guess', () => {
    const book = canonicalise({
      inventory: [{
        sheet: 'Digital Assets', row: 24, service: 'Amazon CloudFront',
        metric: 'CloudFront data transfer (GB/month)', usage_amount: 4096, usage_unit: 'GB',
        raw: 'CloudFront data transfer (GB/month) | 4096',
      }],
    });

    // A bare "GB" is the storage-versus-transfer ambiguity, and those are different rates on
    // the same service. The label resolves it; the unit string never could.
    expect(book.rows[0].quantities[0].unit).toBe('GB-transfer/month');
  });
});

describe('Converting a stated figure onto a monthly basis', () => {
  test('a per-year figure is divided by twelve and the conversion is stated in prose', () => {
    const book = canonicalise({ metrics: [lambdaGroup(YEARS[0], '24000000')], scenarios: YEARS });
    const [quantity] = book.rows[0].quantities;

    expect(quantity).toMatchObject({ unit: 'invocations/month', amount: 2_000_000 });
    expect(quantity).toMatchObject({
      originalValue: 24000000,
      originalPeriod: 'year',
      derivedValue: 2_000_000,
      derivedPeriod: 'month',
      conversionFormula: 'per-year figure divided by 12 to a monthly basis',
    });
    expect(quantity.conversions.join(' ')).toMatch(/divided by 12/);
    // Republished at the workbook level, so a caller that never inspects a row still sees it.
    expect(book.conversions.join(' ')).toMatch(/divided by 12/);
  });

  test('a millions figure is expanded before it is divided, and both steps are recorded', () => {
    const book = canonicalise({
      metrics: [{
        sheet: 'Digital Assets', scenario: YEARS[0], service: 'Amazon API Gateway',
        cells: [{ row: 21, label: 'API Gateway requests (millions/yr)', value: '120' }],
      }],
      scenarios: YEARS,
    });
    const [quantity] = book.rows[0].quantities;

    // 120 million a year is 10 million a month, not 10 and not 120. Expanding after dividing
    // is the same arithmetic; doing it in one step is where a factor gets dropped.
    expect(quantity).toMatchObject({ unit: 'requests/month', amount: 10_000_000 });
    expect(quantity).toMatchObject({
      originalValue: 120,
      originalScale: 'millions',
      originalPeriod: 'year',
      derivedValue: 10_000_000,
      derivedPeriod: 'month',
    });
    expect(quantity.conversions).toEqual([
      'millions expanded to whole units (x 1,000,000)',
      'per-year figure divided by 12 to a monthly basis',
    ]);
  });

  test('a per-day Fargate count keeps its original daily meaning beside the monthly derivative', () => {
    const book = canonicalise({
      metrics: [{
        sheet: 'Operations Input',
        scenario: YEARS[0],
        service: 'Amazon ECS Fargate',
        cells: [
          { row: 4, label: 'Container task count per day', value: '10' },
          { row: 5, label: 'Container task duration hours', value: '2' },
          { row: 6, label: 'Container task vCPU', value: '1' },
          { row: 7, label: 'Container task memory GB', value: '2' },
        ],
      }],
      scenarios: YEARS,
    });
    const row = book.rows[0];

    expect(row.shape).toMatchObject({
      countOriginalValue: 10,
      countOriginalPeriod: 'day',
      countDerivedValue: 304.17,
      countDerivedPeriod: 'month',
    });
    expect(row.quantities[0].conversions.join(' ')).toMatch(/per-day count multiplied/);
  });

  test('a block size stated in the label is expanded to whole units', () => {
    // "(10,000-unit blocks/month)" is a scale in the LABEL, as opposed to a per-block AWS
    // rate, which unit-contract's blockSize handles at the other end.
    const reading = inferUnit('CloudFront requests (10,000-unit blocks/month)', 45);

    expect(reading).toMatchObject({ ok: true, unit: 'requests/month', amount: 450_000 });
  });

  test('a runtime in minutes per day becomes the runtime hours a month AWS bills', () => {
    // The user's own case, to the number: 1440 minutes where the calculator wanted 730 hours.
    const reading = inferUnit('ETL container runtime (minutes per day)', 1440);

    expect(reading).toMatchObject({ ok: true, unit: 'hours/month', amount: HOURS_PER_MONTH });
    if (!reading.ok) throw new Error('expected a reading');
    expect(reading.conversions.join(' ')).toMatch(/per-day figure multiplied by 30.42 days/);
    expect(reading.conversions.join(' ')).toMatch(/minutes divided by 60/);
  });

  test('a stated monthly figure is left alone and says nothing was converted', () => {
    const reading = inferUnit('CloudFront data transfer (GB/month)', 4096);

    expect(reading).toMatchObject({ ok: true, unit: 'GB-transfer/month', amount: 4096, conversions: [] });
  });

  test('a row that states no schedule says out loud that it was priced for the whole month', () => {
    // The commonest reason an estimate reads high, and it has to be legible on the row that
    // made the assumption rather than inferable from the total.
    const book = canonicalise({ inventory: [CORE_BOM_SANDBOX[0]] });
    const [hours] = book.rows[0].quantities;

    expect(hours).toMatchObject({ unit: 'hours/month', amount: HOURS_PER_MONTH });
    expect(hours.conversions.join(' ')).toMatch(/states no schedule/);
  });

  test('an estimate-wide schedule default is applied and named, not applied silently', () => {
    const book = canonicalise({ inventory: [CORE_BOM_SANDBOX[0]], defaultHoursPerDay: 8 });
    const [hours] = book.rows[0].quantities;

    expect(hours.amount).toBeCloseTo(HOURS_PER_MONTH / 3, 1);
    expect(hours.conversions.join(' ')).toMatch(/estimate default of 8 hours a day/);
  });
});

describe('Refusing to invent a dimension', () => {
  test('a label naming nothing AWS meters becomes an exclusion carrying that label', () => {
    // The defect being removed. metric-matrix.ts's readUnit ends `: 'units/month'`, so this
    // row came back as 1.4 billable units a month and read like a finished line item.
    const book = canonicalise({ metrics: [TRANSPOSED_MATRIX[5]], scenarios: YEARS });

    expect(book.rows).toHaveLength(0);
    expect(book.exclusions).toHaveLength(1);
    expect(book.exclusions[0].label).toBe('Peak-to-average traffic ratio (assumption)');
    expect(book.exclusions[0].reason).toMatch(/does not name anything AWS meters/);
    expect(book.exclusions[0].reason).toMatch(/guessed\s+dimension prices confidently and wrongly/);
    expect(book.accounting.balanced).toBe(true);
  });

  test('a label stating two different periods is refused rather than resolved by coin toss', () => {
    const reading = inferUnit('Backup jobs per day per year', 12);

    expect(reading.ok).toBe(false);
    if (reading.ok) throw new Error('expected a refusal');
    expect(reading.reason).toMatch(/both a per-year and a per-day basis/);
  });

  test('an undeterminable cell beside usable ones is stated on the row, not dropped from it', () => {
    // The partial case the row-level balance cannot see: the group prices fine on its storage
    // cell, and the ratio cell would vanish without a trace.
    const book = canonicalise({
      metrics: [{
        sheet: 'Digital Assets',
        scenario: YEARS[0],
        service: 'Amazon Aurora',
        cells: [
          { row: 11, label: 'Aurora storage (GB)', value: '100' },
          { row: 12, label: 'Aurora tuning factor', value: '1.4' },
        ],
      }],
      scenarios: YEARS,
    });

    expect(book.rows).toHaveLength(1);
    expect(book.rows[0].unpriced).toHaveLength(1);
    expect(book.rows[0].unpriced[0]).toMatchObject({
      provenance: expect.objectContaining({ row: 12, label: 'Aurora tuning factor' }),
    });
    expect(book.accounting.accountedMetricCells).toBe(2);
    expect(book.accounting.balanced).toBe(true);
  });

  test('a free-text unit string is only accepted when it names a dimension outright', () => {
    expect(canonicalUnitFrom('GB/month')).toBe('GB/month');
    expect(canonicalUnitFrom('vCPU-hours/month')).toBe('vCPU-hours/month');
    expect(canonicalUnitFrom('monthly active users')).toBe('units/month');
    expect(canonicalUnitFrom('vectors/month')).toBe('units/month');
    // The two a wrong guess costs the most on, so neither is guessed.
    expect(canonicalUnitFrom('GB')).toBeUndefined();
    expect(canonicalUnitFrom('hours')).toBeUndefined();
  });
});

describe('Representing ECS Fargate, which has no per-task rate', () => {
  test('a steady-state task count decomposes into vCPU-hours and GB-hours', () => {
    // planFromGroup (pipeline.ts:272-351) maps EC2 and RDS instance types and returns
    // undefined for everything else, and metric-matrix.ts:489-493 already records why it
    // cannot help: AWS publishes no rate for a task, only for a vCPU-hour and a GB-hour.
    const book = canonicalise({
      metrics: [{
        sheet: 'Digital Assets',
        scenario: YEARS[0],
        service: 'AWS Fargate',
        cells: [
          { row: 6, label: 'ECS Fargate task count (5 microservices)', value: '10' },
          { row: 7, label: 'ECS Fargate task size - vCPU (per task)', value: '1' },
          { row: 8, label: 'ECS Fargate task size - Memory GB (per task)', value: '2' },
        ],
      }],
      scenarios: YEARS,
    });
    const row = book.rows[0];

    expect(row.quantities.map((quantity) => quantity.unit))
      .toEqual(['vCPU-hours/month', 'GB-hours/month']);
    expect(row.quantities.map((quantity) => quantity.amount)).toEqual([7300, 14600]);
    // A Fargate row is deliberately NOT an instance: calling it one would re-authorise the
    // "multiply the rate by 730" shortcut this module exists to remove.
    expect(row.billing).toBe('usage');
    // Task count, per-task size and runtime all still on the row, so the arithmetic is
    // reproducible rather than a number to be taken on trust.
    expect(row.shape).toMatchObject({ count: 10, vcpu: 1, ramGb: 2, hoursPerUnit: HOURS_PER_MONTH });
    expect(reconcile(row.quantities[0].unit, 'vCPU-Hours').ok).toBe(true);
  });

  test('tasks per day with a duration in minutes is a batch workload, not a monthly count', () => {
    // Both halves of the bug the user hit by hand: ten tasks priced per month instead of per
    // day, and a runtime given in minutes where the calculator wanted hours.
    const book = canonicalise({
      metrics: [{
        sheet: 'Digital Assets',
        scenario: LOWER_ENVIRONMENTS[0],
        service: 'AWS Fargate',
        cells: [
          { row: 60, label: 'Fargate ingestion tasks per day', value: '10' },
          { row: 61, label: 'Fargate task avg duration (minutes)', value: '15' },
          { row: 62, label: 'Fargate task size - vCPU (per task)', value: '2' },
          { row: 63, label: 'Fargate task size - Memory GB (per task)', value: '4' },
        ],
      }],
      scenarios: LOWER_ENVIRONMENTS,
    });
    const row = book.rows[0];

    // 10 a day is 304.17 runs a month, each 0.25 hours long: 76.04 task-hours, not 7,300.
    expect(row.shape).toMatchObject({ count: 304.17, vcpu: 2, ramGb: 4, hoursPerUnit: 0.25 });
    expect(row.quantities.map((quantity) => [quantity.unit, quantity.amount])).toEqual([
      ['vCPU-hours/month', 152.08],
      ['GB-hours/month', 304.16],
    ]);
    const said = book.conversions.join(' ');
    expect(said).toMatch(/per-day count multiplied by 30.42 days/);
    expect(said).toMatch(/minutes divided by 60 to runtime hours/);
  });

  test('a Fargate row with no task size is excluded by name rather than priced per task', () => {
    const book = canonicalise({
      metrics: [{
        sheet: 'Digital Assets',
        scenario: YEARS[0],
        service: 'AWS Fargate',
        cells: [{ row: 48, label: 'DR: Fargate warm-standby task count', value: '5' }],
      }],
      scenarios: YEARS,
    });

    expect(book.rows).toHaveLength(0);
    expect(book.exclusions[0].reason).toMatch(/billed per vCPU-hour and per GB-hour/);
    expect(book.accounting.balanced).toBe(true);
  });
});

describe('Keeping the scenario a figure belongs to', () => {
  test('every band survives normalisation as a first-class label, in sheet order', () => {
    // A five-year model collapsed into one number is not something a client can budget
    // against: they need the year. Losing the band loses the deliverable.
    const book = canonicalise({ metrics: TRANSPOSED_MATRIX, scenarios: YEARS });

    expect(book.scenarios).toEqual([
      { key: '26-27', label: '26-27', kind: 'period' },
      { key: '27-28', label: '27-28', kind: 'period' },
    ]);
    expect(book.rows.every((row) => row.scenario !== undefined)).toBe(true);
  });

  test('the same architecture in two bands stays two rows with two different quantities', () => {
    const book = canonicalise({ metrics: TRANSPOSED_MATRIX, scenarios: YEARS });
    const aurora = book.rows.filter((row) => /Aurora instance class/.test(row.label));

    expect(aurora.map((row) => row.scenario?.label)).toEqual(['26-27', '27-28']);
    // Two instances in 26-27 and four in 27-28. Folded together they are six, which is a
    // landscape nobody described.
    expect(aurora.map((row) => row.shape?.count)).toEqual([2, 4]);
  });

  test('an environment band keeps its kind, because that decides whether totals may be added', () => {
    // Consecutive fiscal years are spent in sequence; concurrent environments genuinely add
    // up. Losing `kind` loses the difference between a monthly total and a five-year one.
    const book = canonicalise({
      metrics: [auroraGroup(LOWER_ENVIRONMENTS[1], '1', '50')],
      scenarios: LOWER_ENVIRONMENTS,
    });

    expect(book.scenarios.map((scenario) => scenario.kind)).toEqual(['environment', 'environment', 'environment']);
    expect(book.rows[0].scenario).toEqual({ key: 'testing-qa', label: 'Testing (QA)', kind: 'environment' });
  });

  test('an inventory row naming a band by key resolves to the band label', () => {
    const book = canonicalise({
      inventory: [{
        sheet: 'Digital Assets', row: 26, scenario: 'uat', service: 'Amazon Cognito',
        metric: 'Cognito billable MAU', usage_amount: 2000, usage_unit: 'monthly active users',
        raw: 'Cognito billable MAU | 2000',
      }],
      scenarios: LOWER_ENVIRONMENTS,
    });

    expect(book.rows[0].scenario).toEqual({ key: 'uat', label: 'UAT', kind: 'environment' });
  });
});

describe('Carrying the cell a figure came from', () => {
  test('every canonical row cites its sheet, its 1-based row and the label as written', () => {
    const book = canonicalise({
      inventory: [...FLAT_INVENTORY, ...CORE_BOM_SANDBOX],
      metrics: TRANSPOSED_MATRIX,
      scenarios: YEARS,
    });

    expect(book.rows.length).toBeGreaterThan(0);
    for (const row of [...book.rows, ...book.exclusions]) {
      expect(row.provenance.length).toBeGreaterThan(0);
      for (const cell of row.provenance) {
        expect(cell.sheet).toBeTruthy();
        expect(typeof cell.row).toBe('number');
        expect(cell.label.length).toBeGreaterThan(0);
      }
    }
  });

  test('the raw value is kept unconverted, so a reviewer can match it against the file', () => {
    // Once "(millions/yr)" has been expanded and divided, 10,000,000 is unrecognisable next
    // to the 120 the author typed and there is nothing left to check the estimate against.
    const book = canonicalise({
      metrics: [{
        sheet: 'Digital Assets', scenario: YEARS[0], service: 'Amazon API Gateway',
        cells: [{ row: 21, label: 'API Gateway requests (millions/yr)', value: '120' }],
      }],
      scenarios: YEARS,
    });

    expect(book.rows[0].quantities[0].amount).toBe(10_000_000);
    expect(book.rows[0].provenance[0]).toEqual({
      sheet: 'Digital Assets', row: 21, section: undefined,
      label: 'API Gateway requests (millions/yr)', value: '120',
    });
  });

  test('a stacked-section row carries its section, which is what makes its columns readable', () => {
    const book = canonicalise({ inventory: CORE_BOM_SANDBOX });

    expect(book.rows.map((row) => row.provenance[0].section))
      .toEqual(['Server', 'Database', 'Storage']);
  });

  test('separately named disks stay separate instead of being summed into one figure', () => {
    const book = canonicalise({ inventory: [CORE_BOM_SANDBOX[0]] });
    const storage = book.rows[0].quantities.filter((quantity) => quantity.unit === 'GB/month');

    expect(storage.map((quantity) => [quantity.basis, quantity.amount])).toEqual([
      ['Os Storage', 20],
      ['Data storage for /app', 50],
      ['Data storage for /app/logs', 80],
    ]);
  });

  test('a column the vocabulary has no field for survives as a labelled attribute', () => {
    const book = canonicalise({ inventory: CORE_BOM_SANDBOX });
    const database = findRow(book, /foundation-rds/);

    expect(database.attributes).toEqual(expect.arrayContaining([
      { label: 'engine', value: 'MySQL 8' },
      { label: 'IOPS', value: '3000(GP3)' },
      { label: 'Multi-AZ', value: 'No' },
    ]));
  });

  test('a number wearing a qualifier gives up both halves rather than one', () => {
    // "3000(GP3)" is the provisioned IOPS and the volume type in one cell. numberFrom refuses
    // it, which loses the 3000; parsing it and dropping the parenthetical loses a rate.
    expect(numberWithQualifier('3000(GP3)')).toEqual({ amount: 3000, qualifier: '(GP3)' });
    expect(numberWithQualifier('200')).toEqual({ amount: 200 });
    expect(numberWithQualifier('N/A')).toEqual({ qualifier: 'N/A' });
  });
});
