import ExcelJS from 'exceljs';
import { generateTcoWorkbook } from '../lambdas/shared/tco-workbook';
import { processorOf, toServers, type PricedGroup } from '../lambdas/calculator-orchestrator/pipeline';
import { groupResources } from '../lambdas/calculator-orchestrator/prompt';
import type {
  CalculationResource,
  CalculationResult,
  CalculationServer,
} from '../schema/calculator';

/**
 * The client-facing Excel workbook.
 *
 * Two things are being protected here, and neither is cosmetic:
 *
 *  1. **The totals tie out.** The estimate is priced by GROUP and the workbook shows one
 *     row per SERVER, so every row on the cost sheet is an allocation. If that allocation
 *     drifts, the workbook foots to a different number than the PDF for the same estimate
 *     and the discrepancy surfaces in front of a client. So the tests sum the cells the
 *     generator actually wrote and compare them against monthlyTotal.
 *  2. **The totals are formulas.** The whole reason for shipping .xlsx rather than a second
 *     PDF is that a client meeting changes a number and expects everything downstream to
 *     move. A baked literal in a total cell looks identical on screen and silently kills
 *     that. So the tests assert on `cell.formula`, not on displayed values.
 *
 * exceljs does not evaluate formulas, which is why a formula's *shape* is asserted (that
 * the grand total references its subtotal rows) alongside a numeric check derived from the
 * data cells.
 */

const OPTIONS = {
  name: 'Rainbow migration',
  environmentHours: [
    { name: 'Production', hoursPerDay: 24 },
    { name: 'Non-Prod', hoursPerDay: 10 },
  ],
  createdAt: Date.UTC(2026, 3, 30),
  region: 'ap-south-1',
};

function server(overrides: Partial<CalculationServer> = {}): CalculationServer {
  return {
    name: 'APP01',
    count: 1,
    environment: 'Production',
    group: '2 x m6a.xlarge | Linux',
    os: 'Linux',
    processor: 'AMD EPYC',
    instance: 'm6a.xlarge',
    vcpu: 4,
    ramGb: 16,
    purchaseModel: '3-Yr No Upfront',
    diskGb: 200,
    diskType: 'gp3',
    hoursPerDay: 24,
    computeMonthly: 100,
    storageMonthly: 20,
    justification: 'Source: Standard_D4s_v5',
    ...overrides,
  };
}

function result(overrides: Partial<CalculationResult> = {}): CalculationResult {
  return {
    url: 'https://calculator.aws/#/estimate?id=abc',
    currency: 'USD',
    monthlyTotal: 360,
    lineItems: [
      {
        service: 'Amazon EC2',
        detail: '2 x m6a.xlarge | Linux',
        monthly: 200,
        workings: '$0.1370/Hrs (3 yr No Upfront) x 730 hrs/month x 2 = $200.00/mo',
        environment: 'Production',
        hoursPerDay: 24,
        timeBilled: true,
      },
      {
        service: 'Amazon EBS',
        detail: '400 GB attached to 2 x m6a.xlarge | Linux',
        monthly: 40,
        workings: '$0.1000/GB-month x 400 GB = $40.00/mo',
        environment: 'Production',
        timeBilled: false,
      },
      {
        service: 'Amazon RDS',
        detail: 'db.m6g.large | PostgreSQL',
        monthly: 120,
        workings: '$0.1644/Hrs x 730 hrs/month = $120.00/mo',
        environment: 'Non-Prod',
        hoursPerDay: 10,
        timeBilled: true,
      },
    ],
    environments: [
      { name: 'Production', hoursPerDay: 24, monthly: 240 },
      { name: 'Non-Prod', hoursPerDay: 10, monthly: 120 },
    ],
    scenarios: [],
    reportedMonthlyTotal: 400,
    assumptions: ['Storage priced as gp3 in ap-south-1.'],
    warnings: [],
    ebsRatePerGbMonth: 0.1,
    servers: [
      server({ name: 'APP01', computeMonthly: 100, storageMonthly: 20, diskGb: 200 }),
      server({ name: 'APP02', computeMonthly: 100, storageMonthly: 20, diskGb: 200 }),
      server({
        name: 'DB01',
        environment: 'Non-Prod',
        group: 'db.m6g.large | PostgreSQL',
        instance: 'db.m6g.large',
        processor: 'AWS Graviton',
        hoursPerDay: 10,
        computeMonthly: 120,
        storageMonthly: null,
        diskGb: undefined,
        diskType: undefined,
      }),
    ],
    ...overrides,
  };
}

async function read(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as never);
  return workbook;
}

/** Every numeric cell in a column, ignoring the formula rows. */
function numbers(sheet: ExcelJS.Worksheet, column: number): number[] {
  const values: number[] = [];
  sheet.eachRow((row) => {
    const value = row.getCell(column).value;
    if (typeof value === 'number') values.push(value);
  });
  return values;
}

function formulaOf(sheet: ExcelJS.Worksheet, address: string): string | undefined {
  const value = sheet.getCell(address).value as { formula?: string } | null;
  return value && typeof value === 'object' ? value.formula : undefined;
}

/** The row whose first or second cell reads as this label. */
function rowWithLabel(sheet: ExcelJS.Worksheet, label: string): ExcelJS.Row | undefined {
  let found: ExcelJS.Row | undefined;
  sheet.eachRow((row) => {
    if (found) return;
    const first = String(row.getCell(1).value ?? '');
    const second = String(row.getCell(2).value ?? '');
    if (first.startsWith(label) || second.startsWith(label)) found = row;
  });
  return found;
}

const EM = '\u2014';
const TCO_SHEET = 'TCO - ap-south-1';

describe('the workbook a client is handed', () => {
  test('carries the five sheets that hold cost', async () => {
    const workbook = await read(await generateTcoWorkbook(result(), OPTIONS));
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      TCO_SHEET,
      'Consolidated Summary',
      'Commercial Breakdown',
      'Assumptions & Notes',
      'Line Items',
    ]);
  });

  test('one row per server, with the machine names the sheet gave', async () => {
    const workbook = await read(await generateTcoWorkbook(result(), OPTIONS));
    const sheet = workbook.getWorksheet(TCO_SHEET)!;
    const names: string[] = [];
    sheet.eachRow((row) => {
      if (typeof row.getCell(1).value === 'number') names.push(String(row.getCell(2).value));
    });
    expect(names).toEqual(['APP01', 'APP02', 'DB01']);
  });

  /**
   * The invariant that matters most. Per-server rows are an allocation of group prices, so
   * if the allocation drifts the workbook foots to a different number than the PDF for the
   * same estimate -- in front of a client, with no way to tell which is right.
   */
  test('the per-server rows sum to the estimate monthly total', async () => {
    const estimate = result();
    const workbook = await read(await generateTcoWorkbook(estimate, OPTIONS));
    const sheet = workbook.getWorksheet(TCO_SHEET)!;
    const compute = numbers(sheet, 15).reduce((a, b) => a + b, 0);
    const storage = numbers(sheet, 16).reduce((a, b) => a + b, 0);
    expect(Math.round((compute + storage) * 100) / 100).toBe(estimate.monthlyTotal);
  });

  test('row totals, subtotals and the grand total are formulas, never literals', async () => {
    const workbook = await read(await generateTcoWorkbook(result(), OPTIONS));
    const sheet = workbook.getWorksheet(TCO_SHEET)!;

    // Data rows start at 3: title, then header.
    expect(formulaOf(sheet, 'Q3')).toBe('IF(COUNT(O3:P3)=0,"",O3+P3)');

    const subtotals: number[] = [];
    sheet.eachRow((row) => {
      if (String(row.getCell(2).value ?? '').startsWith('Subtotal')) subtotals.push(row.number);
    });
    // One per scope: Production and Non-Prod.
    expect(subtotals).toHaveLength(2);
    expect(formulaOf(sheet, `Q${subtotals[0]}`)).toMatch(/^SUM\(Q\d+:Q\d+\)$/);

    const grand = rowWithLabel(sheet, `TOTAL ${EM} ap-south-1`);
    expect(grand).toBeDefined();
    // Sums the subtotals, as rows 30-32 of the reference workbook do -- so deleting a
    // scope block breaks the reference visibly instead of shrinking the total quietly.
    expect(formulaOf(sheet, `Q${grand!.number}`))
      .toBe(subtotals.map((at) => `Q${at}`).join('+'));
    expect(formulaOf(sheet, `O${grand!.number}`))
      .toBe(subtotals.map((at) => `O${at}`).join('+'));
  });

  test('the header stays on screen on a long inventory', async () => {
    const workbook = await read(await generateTcoWorkbook(result(), OPTIONS));
    const sheet = workbook.getWorksheet(TCO_SHEET)!;
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 2 });
  });
});

describe('consolidated summary', () => {
  test('annual is twelve times monthly, as a formula on every row', async () => {
    const workbook = await read(await generateTcoWorkbook(result(), OPTIONS));
    const sheet = workbook.getWorksheet('Consolidated Summary')!;
    // Three services priced: EC2, RDS, EBS.
    expect(formulaOf(sheet, 'C3')).toBe('B3*12');
    expect(formulaOf(sheet, 'C4')).toBe('B4*12');
    expect(formulaOf(sheet, 'C5')).toBe('B5*12');
  });

  test('categories cover every priced service and total to the estimate', async () => {
    const estimate = result();
    const workbook = await read(await generateTcoWorkbook(estimate, OPTIONS));
    const sheet = workbook.getWorksheet('Consolidated Summary')!;
    const labels: string[] = [];
    sheet.eachRow((row) => {
      if (typeof row.getCell(2).value === 'number') labels.push(String(row.getCell(1).value));
    });
    expect(labels).toEqual(['Amazon EC2', 'Amazon RDS', 'Amazon EBS']);
    const monthly = numbers(sheet, 2).reduce((a, b) => a + b, 0);
    expect(monthly).toBe(estimate.monthlyTotal);

    const grand = rowWithLabel(sheet, 'GRAND TOTAL')!;
    expect(formulaOf(sheet, `B${grand.number}`)).toMatch(/^SUM\(B\d+:B\d+\)$/);
  });

  test('cross-checks itself against the per-server sheet, live', async () => {
    const workbook = await read(await generateTcoWorkbook(result(), OPTIONS));
    const sheet = workbook.getWorksheet('Consolidated Summary')!;
    const check = rowWithLabel(sheet, 'Per-server sheet total')!;
    expect(formulaOf(sheet, `B${check.number}`)).toBe(`'${TCO_SHEET}'!Q${
      rowWithLabel(workbook.getWorksheet(TCO_SHEET)!, `TOTAL ${EM} ap-south-1`)!.number
    }`);
    // The difference against the grand total, which must read zero.
    expect(formulaOf(sheet, `C${check.number}`)).toMatch(/^B\d+-B\d+$/);
  });
});

describe('commercial breakdown', () => {
  test('credits and discount default to zero and drive the Year-1 figure', async () => {
    const workbook = await read(await generateTcoWorkbook(result(), OPTIONS));
    const sheet = workbook.getWorksheet('Commercial Breakdown')!;

    const mapPct = rowWithLabel(sheet, 'MAP Credits %')!;
    const discountPct = rowWithLabel(sheet, 'Partner Discount %')!;
    // Zero, deliberately: these are terms of a specific deal, not a default.
    expect(mapPct.getCell(2).value).toBe(0);
    expect(discountPct.getCell(2).value).toBe(0);

    const total = rowWithLabel(sheet, 'Total Annual Cost')!;
    const marketplace = rowWithLabel(sheet, 'Marketplace and third-party licences')!;
    const credits = rowWithLabel(sheet, 'Total MAP Credits')!;
    const discount = rowWithLabel(sheet, 'Total Partner Discount')!;
    const effective = rowWithLabel(sheet, 'Total Effective Cost Year 1')!;

    // Marketplace spend is excluded before either is calculated, as the reference notes.
    expect(formulaOf(sheet, `B${credits.number}`))
      .toBe(`B${mapPct.number}*(B${total.number}-B${marketplace.number})`);
    expect(formulaOf(sheet, `B${discount.number}`))
      .toBe(`B${discountPct.number}*(B${total.number}-B${marketplace.number})`);
    expect(formulaOf(sheet, `B${effective.number}`))
      .toBe(`B${total.number}-B${credits.number}-B${discount.number}`);
  });

  test('annual cost by category is read from the summary sheet, not copied', async () => {
    const workbook = await read(await generateTcoWorkbook(result(), OPTIONS));
    const sheet = workbook.getWorksheet('Commercial Breakdown')!;
    expect(formulaOf(sheet, 'B3')).toMatch(/^'Consolidated Summary'!C\d+$/);
  });
});

describe('assumptions and workings', () => {
  test('states the gp3 rate and the provenance of every price', async () => {
    const workbook = await read(await generateTcoWorkbook(result(), OPTIONS));
    const sheet = workbook.getWorksheet('Assumptions & Notes')!;
    const text = JSON.stringify(sheet.getSheetValues());
    expect(text).toContain('0.1000 per GB-month');
    expect(text).toContain('AWS Price List Query API');
    expect(text).toContain('Storage priced as gp3 in ap-south-1.');
    // dd-MM-yyyy, the standing convention.
    expect(text).toContain('30-04-2026');
  });

  test('says the per-server rows are an allocation, not individual pricing', async () => {
    const workbook = await read(await generateTcoWorkbook(result(), OPTIONS));
    const text = JSON.stringify(workbook.getWorksheet('Assumptions & Notes')!.getSheetValues());
    expect(text).toContain('allocated across its servers');
  });

  test('the line items sheet carries the arithmetic behind every figure', async () => {
    const workbook = await read(await generateTcoWorkbook(result(), OPTIONS));
    const sheet = workbook.getWorksheet('Line Items')!;
    const text = JSON.stringify(sheet.getSheetValues());
    expect(text).toContain('$0.1370/Hrs (3 yr No Upfront) x 730 hrs/month x 2 = $200.00/mo');
    const total = rowWithLabel(sheet, 'TOTAL')!;
    expect(formulaOf(sheet, `E${total.number}`)).toMatch(/^SUM\(E\d+:E\d+\)$/);
  });
});

/**
 * The path every estimate already stored in DynamoDB takes.
 *
 * `servers` was added after the calculator shipped, so an estimate priced before this
 * change has none -- and so does one too large to carry per-server detail. Neither may
 * fail to download, and neither may produce a workbook that foots to a different number.
 */
describe('an estimate with no per-server rows', () => {
  const legacy = () => {
    const estimate = result();
    delete estimate.servers;
    delete estimate.ebsRatePerGbMonth;
    return estimate;
  };

  test('still produces all five sheets', async () => {
    const workbook = await read(await generateTcoWorkbook(legacy(), OPTIONS));
    expect(workbook.worksheets).toHaveLength(5);
    expect(workbook.getWorksheet(TCO_SHEET)).toBeDefined();
  });

  test('still foots to the same monthly total', async () => {
    const estimate = legacy();
    const workbook = await read(await generateTcoWorkbook(estimate, OPTIONS));
    const sheet = workbook.getWorksheet(TCO_SHEET)!;
    const compute = numbers(sheet, 15).reduce((a, b) => a + b, 0);
    const storage = numbers(sheet, 16).reduce((a, b) => a + b, 0);
    expect(Math.round((compute + storage) * 100) / 100).toBe(estimate.monthlyTotal);
  });

  test('keeps storage in the storage column, so the summary still means what it says', async () => {
    const workbook = await read(await generateTcoWorkbook(legacy(), OPTIONS));
    const sheet = workbook.getWorksheet(TCO_SHEET)!;
    expect(numbers(sheet, 16)).toEqual([40]);
  });

  test('says in writing that it lists groups rather than servers', async () => {
    const workbook = await read(await generateTcoWorkbook(legacy(), OPTIONS));
    const text = JSON.stringify(workbook.getWorksheet('Assumptions & Notes')!.getSheetValues());
    expect(text).toContain('lists priced groups instead');
  });
});

describe('an estimate with nothing priced', () => {
  test('produces a readable workbook rather than throwing', async () => {
    const empty: CalculationResult = {
      url: null,
      currency: 'USD',
      monthlyTotal: null,
      lineItems: [],
      environments: [],
      scenarios: [],
      assumptions: [],
      warnings: ['Nothing in the uploaded sheet could be priced.'],
    };
    const workbook = await read(await generateTcoWorkbook(empty, OPTIONS));
    expect(workbook.worksheets).toHaveLength(5);
    const text = JSON.stringify(workbook.getWorksheet('Assumptions & Notes')!.getSheetValues());
    expect(text).toContain('Nothing in the uploaded sheet could be priced.');
  });
});

/**
 * Allocating a group price across the machines inside it.
 *
 * The estimate prices groups because pricing 400 identical machines 400 times is 400 API
 * calls for one answer. The workbook needs servers. Dividing is exact for compute -- a
 * group is one size, OS, region, schedule and purchase model by construction -- but
 * storage is not: two machines in the same group can carry very different volumes, and
 * charging both the group mean would misstate every row. So storage is apportioned on each
 * row's own disk, which keeps the rows truthful AND keeps them summing to the figure that
 * was actually priced.
 */
describe('allocating a group across its servers', () => {
  const resource = (overrides: Partial<CalculationResource> = {}): CalculationResource => ({
    raw: 'row',
    name: 'APP01',
    size: 'm6a.xlarge',
    os: 'Linux',
    environment: 'Production',
    ...overrides,
  });

  const priceGroup = (
    resources: CalculationResource[],
    money: Partial<PricedGroup> = {},
  ): PricedGroup[] => {
    const groups = groupResources(resources, new Map<string, number>(), 'baseline');
    expect(groups).toHaveLength(1);
    return [{
      group: groups[0],
      plan: { serviceCode: 'AmazonEC2', filters: {} } as PricedGroup['plan'],
      computeMonthly: 200,
      storageMonthly: 40,
      ...money,
    }];
  };

  test('compute divides by machine count, exactly', () => {
    const resources = [resource({ name: 'APP01' }), resource({ name: 'APP02' })];
    const servers = toServers(priceGroup(resources), resources);
    expect(servers.map((row) => row.computeMonthly)).toEqual([100, 100]);
    expect(servers.reduce((sum, row) => sum + (row.computeMonthly ?? 0), 0)).toBe(200);
  });

  test('storage follows each machine own disk, and still sums to the group figure', () => {
    const resources = [
      resource({ name: 'APP01', disk_gb: 100 }),
      resource({ name: 'APP02', disk_gb: 300 }),
    ];
    const servers = toServers(priceGroup(resources), resources);
    expect(servers.map((row) => row.storageMonthly)).toEqual([10, 30]);
    expect(servers.reduce((sum, row) => sum + (row.storageMonthly ?? 0), 0)).toBe(40);
    expect(servers.map((row) => row.diskGb)).toEqual([100, 300]);
  });

  test('a quantity column stays one row, priced for the machines it stands for', () => {
    const resources = [resource({ name: 'Web tier', quantity: '4' })];
    const servers = toServers(priceGroup(resources, { computeMonthly: 400 }), resources);
    expect(servers).toHaveLength(1);
    expect(servers[0].count).toBe(4);
    expect(servers[0].computeMonthly).toBe(400);
  });

  test('an unpriced group produces unpriced rows, never zeroes', () => {
    const resources = [resource({ name: 'APP01', disk_gb: 100 })];
    const servers = toServers(
      priceGroup(resources, { computeMonthly: null, storageMonthly: null, miss: 'no published rate matched' }),
      resources,
    );
    expect(servers[0].computeMonthly).toBeNull();
    expect(servers[0].storageMonthly).toBeNull();
  });

  test('carries the sizing justification the sheet supplied', () => {
    const resources = [resource({
      name: 'APP01',
      source_size: 'Standard_D4s_v5',
      right_sized_size: 'm6a.large',
      notes: 'Owner asked for headroom.',
    })];
    const servers = toServers(priceGroup(resources), resources);
    expect(servers[0].justification)
      .toBe('Source: Standard_D4s_v5. Right-sizing recommends m6a.large. Owner asked for headroom.');
  });

  test('a row with no name still gets a findable label', () => {
    const resources = [resource({ name: undefined, sheet: 'Inventory', row: 12 })];
    const servers = toServers(priceGroup(resources), resources);
    expect(servers[0].name).toBe('Amazon EC2 row 12');
    expect(servers[0].sheet).toBe('Inventory');
  });
});

/**
 * The reference workbook carries a Processor column and no uploaded sheet supplies one.
 * The instance family already encodes it, so it is read from there rather than left blank
 * or guessed at.
 */
describe('reading the processor out of an instance type', () => {
  test.each([
    ['m6a.xlarge', 'AMD EPYC'],
    ['hpc7a.48xlarge', 'AMD EPYC'],
    ['m6i.large', 'Intel Xeon'],
    ['m5.large', 'Intel Xeon'],
    ['x2iedn.xlarge', 'Intel Xeon'],
    ['t4g.small', 'AWS Graviton'],
    ['c7gn.4xlarge', 'AWS Graviton'],
    ['a1.medium', 'AWS Graviton'],
  ])('%s runs on %s', (size, expected) => {
    expect(processorOf(size)).toBe(expected);
  });

  test('an unparseable family prints nothing rather than a guess', () => {
    expect(processorOf('u-6tb1.metal')).toBeUndefined();
    expect(processorOf('')).toBeUndefined();
    expect(processorOf(undefined)).toBeUndefined();
  });
});

/**
 * The Scenarios sheet: one row per priced band, each with its own shareable estimate.
 *
 * A client handed the workbook and not the PDF still has to be able to open the year they
 * are budgeting for, so the link lives here as a real hyperlink rather than only in the PDF.
 *
 * The sharper requirement is what this sheet must NOT compute. A spreadsheet cell carries
 * no sentence beside it to explain itself, so a SUM in the wrong column is a wrong number
 * with nothing to qualify it -- and the three kinds of band do not share one total. Five
 * consecutive fiscal years add up only into a multi-year figure; three concurrent
 * environments add up into a monthly one; two sizings of one landscape do not add up at all,
 * because only one of them will ever be spent. So each band gets exactly the total its kind
 * makes true, and the tests below assert on the cells that are deliberately left empty as
 * much as on the ones that are filled.
 */
describe('the scenarios sheet', () => {
  const link = (id: string) => `https://calculator.aws/#/estimate?id=${id}`;

  const years = () => ['26-27', '27-28', '28-29', '29-30', '30-31'].map((label, index) => ({
    key: label,
    label,
    kind: 'period' as const,
    monthly: 1000 + index * 250,
    url: link(`year${index}`),
    detail: `Fiscal ${label} usage column`,
  }));

  const lowerEnvironments = () => ['Dev', 'Testing (QA)', 'UAT'].map((label, index) => ({
    key: label,
    label,
    kind: 'environment' as const,
    monthly: 400 + index * 100,
    url: link(`env${index}`),
  }));

  const sizingPair = () => [
    { key: 'baseline', label: 'Lift and shift', kind: 'sizing' as const, monthly: 1000, url: link('base') },
    { key: 'rightsized', label: 'Right-sized', kind: 'sizing' as const, monthly: 800, url: link('right') },
  ];

  const sheetOf = async (scenarios: CalculationResult['scenarios']) => {
    const workbook = await read(await generateTcoWorkbook(result({ scenarios }), OPTIONS));
    return workbook.getWorksheet('Scenarios')!;
  };

  test('appears only when the estimate was banded', async () => {
    // A prose estimate or a single-sizing one still produces exactly the five sheets it
    // always did, so nothing about the common path changes shape.
    const plain = await read(await generateTcoWorkbook(result(), OPTIONS));
    expect(plain.getWorksheet('Scenarios')).toBeUndefined();
    expect(plain.worksheets).toHaveLength(5);

    const banded = await read(await generateTcoWorkbook(result({ scenarios: years() }), OPTIONS));
    expect(banded.worksheets.map((sheet) => sheet.name)).toEqual([
      TCO_SHEET,
      'Consolidated Summary',
      'Scenarios',
      'Commercial Breakdown',
      'Assumptions & Notes',
      'Line Items',
    ]);
  });

  test('every year carries its own hyperlink, not one link for the sheet', async () => {
    // The requirement the change exists for. Five years behind one link is not something a
    // client can act on, and a URL as plain text is not something they can click.
    const sheet = await sheetOf(years());
    const links: string[] = [];
    sheet.eachRow((row) => {
      const cell = row.getCell(5).value as { hyperlink?: string } | null;
      if (cell && typeof cell === 'object' && cell.hyperlink) links.push(cell.hyperlink);
    });

    expect(links).toEqual([link('year0'), link('year1'), link('year2'), link('year3'), link('year4')]);
    expect(new Set(links).size).toBe(5);
  });

  test('a band whose estimate never exported says so instead of leaving the cell blank', async () => {
    // The pipeline can price a band and still fail at export_estimate. An empty cell there
    // is indistinguishable from a bug in this generator.
    const sheet = await sheetOf(years().map((entry) => ({ ...entry, url: null })));
    const text = JSON.stringify(sheet.getSheetValues());

    expect(text).toContain('No estimate link was exported for this scenario');
    expect(text).not.toContain('calculator.aws');
  });

  test('consecutive years are totalled as multi-year, and never as a monthly figure', async () => {
    // The single most dangerous cell in this workbook. 1000+1250+1500+1750+2000 = 7500, and
    // a SUM in the monthly column would present that as a monthly bill -- five times the
    // real one, in a cell with nothing beside it to say otherwise. So the monthly cell on
    // this row must stay empty, and only the annual column may be summed.
    const sheet = await sheetOf(years());
    const total = rowWithLabel(sheet, 'Total across all 5 years')!;

    expect(String(total.getCell(1).value)).toContain('NOT a monthly figure');
    expect(total.getCell(3).value).toBeNull();
    expect(formulaOf(sheet, `D${total.number}`)).toMatch(/^SUM\(D\d+:D\d+\)$/);
  });

  test('concurrent environments are totalled in both columns, because they do add up', async () => {
    // The mirror image of the year case: Dev, QA and UAT run at the same time, so a monthly
    // sum here is correct and withholding it would understate the landscape.
    const sheet = await sheetOf(lowerEnvironments());
    const total = rowWithLabel(sheet, 'All 3 environments running together')!;

    expect(formulaOf(sheet, `C${total.number}`)).toMatch(/^SUM\(C\d+:C\d+\)$/);
    expect(formulaOf(sheet, `D${total.number}`)).toMatch(/^SUM\(D\d+:D\d+\)$/);
  });

  test('a sizing pair gets no total row at all, and says why in writing', async () => {
    // $1,000 lift-and-shift plus $800 right-sized is $1,800, a figure nobody will ever be
    // billed. There is no column in which these two may be added, so there is no total row
    // -- and the sheet says so, because a reader who cannot see one will otherwise reach for
    // AutoSum themselves.
    const sheet = await sheetOf(sizingPair());
    const text = JSON.stringify(sheet.getSheetValues());

    expect(text).toContain('Not totalled: these are alternatives and only one of them will be spent.');
    expect(text).toContain('Right-sizing saves $200.00 per month');
    let sums = 0;
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        const value = cell.value as { formula?: string } | null;
        if (value && typeof value === 'object' && value.formula?.startsWith('SUM(')) sums += 1;
      });
    });
    expect(sums).toBe(0);
  });

  test('annual is a formula over the monthly cell, and blank where nothing was priced', async () => {
    // The whole reason for shipping .xlsx: change a band's monthly figure in a review and
    // its annual cost moves with it. And a $0.00 annual cost in a client document reads as
    // free, which is a different claim from "this band could not be priced".
    const sheet = await sheetOf([
      { key: '26-27', label: '26-27', kind: 'period' as const, monthly: 1000, url: link('a') },
      { key: '27-28', label: '27-28', kind: 'period' as const, monthly: null, url: link('b') },
    ]);
    const priced = rowWithLabel(sheet, '26-27')!;
    const unpriced = rowWithLabel(sheet, '27-28')!;

    expect(formulaOf(sheet, `D${priced.number}`)).toBe(`IF(COUNT(C${priced.number})=0,"",C${priced.number}*12)`);
    expect(priced.getCell(3).value).toBe(1000);
    expect(unpriced.getCell(3).value).toBeNull();
  });

  test('two kinds on one sheet get a block each, with their own headers and rules', async () => {
    // Digital_Assets.xlsx is exactly this: five fiscal years in one band and three lower
    // environments in another. One shared table would put a year and an environment in the
    // same column under a total that means neither.
    const sheet = await sheetOf([...years(), ...lowerEnvironments()]);
    const text = JSON.stringify(sheet.getSheetValues());

    expect(text).toContain('Cost by year');
    expect(text).toContain('Cost by environment, priced separately');
    expect(rowWithLabel(sheet, 'Total across all 5 years')).toBeDefined();
    expect(rowWithLabel(sheet, 'All 3 environments running together')).toBeDefined();
  });

  test('an estimate stored before kind and url existed still produces the sheet', async () => {
    // There are real records like this in DynamoDB: two scenarios, no `kind`, no `url`.
    // Neither may fail to download, and both must still read as the sizing pair they are.
    const sheet = await sheetOf([
      { key: 'baseline', label: 'Lift and shift', monthly: 1000 },
      { key: 'rightsized', label: 'Right-sized', monthly: 750 },
    ] as unknown as CalculationResult['scenarios']);
    const text = JSON.stringify(sheet.getSheetValues());

    expect(text).toContain('Sizing scenarios');
    expect(text).toContain('No estimate link was exported for this scenario');
    expect(text).toContain('Right-sizing saves $250.00 per month');
  });

  test('the assumptions sheet points at it rather than repeating its figures', async () => {
    // The monthly total on the assumptions sheet describes one band. Naming the sheet that
    // holds the rest -- and the rule about which of them add up -- is the difference between
    // a reader finding the other seven links and assuming there is only one.
    const workbook = await read(await generateTcoWorkbook(result({ scenarios: years() }), OPTIONS));
    const text = JSON.stringify(workbook.getWorksheet('Assumptions & Notes')!.getSheetValues());

    expect(text).toContain('5 separate scenario(s)');
    expect(text).toContain('See the Scenarios sheet');
    expect(text).toContain('which of them may be added together');
  });
});
