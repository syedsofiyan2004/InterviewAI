import * as fs from 'fs';
import * as path from 'path';
import ExcelJS from 'exceljs';
import { analyseWorkbook, classifyTable, buildEvidence, toGigabytes, findRegion, composeHeader, inferColumnsFromData } from '../lambdas/api-handler/calculator-workbook';
import { matchColumnsScored } from '../lambdas/shared/sheet-structure';

/**
 * Reading an arbitrary customer workbook.
 *
 * Two halves, and both are the requirement rather than a nicety:
 *
 *  - The real thing. docs/COSEC_AWS_TCO_Model.xlsx is a 10-sheet Azure-to-AWS
 *    migration model whose inventory starts on row 4 of sheet 2, whose region is
 *    stated only in prose on sheet 1, and whose rate card, spend history and cost
 *    summaries all carry instance types and money columns without being inventory.
 *    Every figure asserted below was checked against the file by hand.
 *  - The simple and the clumsy. A five-column template typed by hand, a sheet with no
 *    heading row at all, headings stacked over two rows, capacities in TB and GiB. A
 *    parser that only handles the complex file is no more useful than one that only
 *    handles the simple one.
 *
 * The strongest assertion in the file is that the 110 rows read from the real workbook
 * sum to EXACTLY the total that workbook foots for itself. That is an independent check
 * on every column mapping at once: get the wrong column, skip a row, or double-count
 * the footer, and the sum stops matching.
 */

const REAL_WORKBOOK = path.join(__dirname, '..', '..', 'docs', 'COSEC_AWS_TCO_Model.xlsx');
const hasRealWorkbook = fs.existsSync(REAL_WORKBOOK);

async function xlsx(sheets: Record<string, unknown[][]>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const sheet = workbook.addWorksheet(name);
    rows.forEach((row) => sheet.addRow(row as ExcelJS.CellValue[]));
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

// ---------------------------------------------------------------------------
// The real workbook
// ---------------------------------------------------------------------------

const describeReal = hasRealWorkbook ? describe : describe.skip;

describeReal('The COSEC Azure-to-AWS TCO model', () => {
  let analysis: Awaited<ReturnType<typeof analyseWorkbook>>;

  beforeAll(async () => {
    analysis = await analyseWorkbook(fs.readFileSync(REAL_WORKBOOK), 'COSEC_AWS_TCO_Model.xlsx');
  }, 120_000);

  test('reads exactly the 110 servers on the inventory sheet, and nothing else', () => {
    expect(analysis.resources).toHaveLength(110);
    // Every resource came from the inventory sheet. The rate card, the three cost
    // summaries, the Azure spend history and the assumptions tab between them once
    // contributed 36 fabricated "servers" -- this is the assertion that catches that
    // class of regression, whatever new shape causes it.
    expect([...new Set(analysis.resources.map((resource) => resource.sheet))]).toEqual(['Server Inventory']);
    expect(analysis.insights.server_count).toBe(110);
  });

  test('the rows read sum to the total the sheet foots for itself', () => {
    const sum = analysis.resources.reduce((total, resource) => total + (resource.reported_monthly ?? 0), 0);
    expect(sum).toBeCloseTo(33042.5605, 3);
    expect(analysis.insights.reported_monthly_total).toBeCloseTo(33042.56, 2);

    // And the TOTAL footer row was captured as a total, not read as a 111th server.
    const footer = analysis.insights.reported.find((entry) => entry.sheet === 'Server Inventory');
    expect(footer?.monthly).toBeCloseTo(33042.5605, 3);
    expect(analysis.resources.some((resource) => /^total/i.test(resource.name ?? ''))).toBe(false);
  });

  test('the disk total agrees with the storage cost the sheet calculated', () => {
    // 6269.396 $/month of gp3 at 0.0952 $/GB-month is 65,855 GB. An independent check
    // on the disk column: the sheet never states this figure, it falls out of two
    // others, so it can only match if the right column was read.
    expect(analysis.insights.total_disk_gb).toBeCloseTo(6269.396 / 0.0952, 0);
  });

  test('finds both regions, stated only in prose on the assumptions tab', () => {
    expect(analysis.insights.primary_region).toBe('eu-central-1');
    expect(analysis.insights.dr_region).toBe('eu-west-1');
  });

  test('carries both runtime schedules, including the one no whole number of hours fits', () => {
    const always = analysis.resources.filter((resource) => resource.hoursPerMonth === 730);
    const office = analysis.resources.filter((resource) => resource.hoursPerMonth === 260);
    expect(always).toHaveLength(84);
    expect(office).toHaveLength(26);
    // 12h x 5 days is 260 hours a month, which is 8.55 hours a day and no whole number
    // at all. hoursPerMonth is the authoritative field; hoursPerDay is derived for the
    // existing pricing path.
    expect(office[0].hoursPerDay).toBeCloseTo(8.55, 2);
    expect(office.every((resource) => resource.purchase_model === 'On-Demand 12x5')).toBe(true);
  });

  test('reads the source SKU, the target and the right-sizing recommendation separately', () => {
    const row = analysis.resources.find((resource) => resource.name === 'INTRANET')!;
    expect(row).toMatchObject({
      environment: 'Prod',
      source_size: 'Standard_D4s_v4',   // what it runs on in Azure today
      size: 'm6a.xlarge',               // the lift-and-shift target
      right_sized_size: 'm6a.large',    // the recommendation, priced as scenario two
      os: 'Windows',
      vcpu: 4,
      ram_gb: 16,
      disk_gb: 159,
      dr_eligible: true,
    });
  });

  test('counts the DR-eligible servers the assumptions tab says there are', () => {
    expect(analysis.insights.dr_eligible_count).toBe(64);
  });

  test('reads the rate card as rates, one entry per purchase model and OS', () => {
    const rates = analysis.insights.rate_card.filter((entry) => entry.item === 'm6a.large');
    // Four ways of pricing one instance type. Collapsing them to one number would have
    // recorded m6a.large at the 3-year WINDOWS rate for a fleet that is 3-year Linux.
    expect(rates).toHaveLength(4);
    expect(rates.find((entry) => entry.unit === '3-Yr No Upfront Linux')?.rate).toBeCloseTo(0.05383, 5);
    expect(rates.find((entry) => entry.unit === 'On-Demand Linux')?.rate).toBeCloseTo(0.1035, 4);

    // The storage/backup/DRS rates are stated as label/value pairs, not in a table.
    const gp3 = analysis.insights.rate_card.find((entry) => /gp3.*eu-central-1/.test(entry.item));
    expect(gp3?.rate).toBeCloseTo(0.0952, 4);
  });

  test('files the cost summaries as figures the sheet reports, never as resources', () => {
    const byLabel = (sheet: string, label: string) =>
      analysis.insights.reported.find((entry) => entry.sheet === sheet && entry.label === label)?.monthly;

    expect(byLabel('AWS Compute Cost', 'TOTAL')).toBeCloseTo(19871.1891, 3);
    expect(byLabel('AWS Storage Cost', 'TOTAL')).toBeCloseTo(6269.396, 3);
    expect(byLabel('AWS Backup Cost', 'TOTAL')).toBeCloseTo(4748.505, 3);
    // Compute + storage + backup + DRS is what the inventory sheet foots.
    const drs = analysis.insights.reported.find((entry) => entry.sheet === 'AWS DRS Cost')!;
    expect(19871.1891 + 6269.396 + 4748.505 + drs.monthly).toBeCloseTo(33042.5605, 2);
  });

  test('reads twelve months of Azure spend as a cost history, not twelve servers', () => {
    const azure = analysis.insights.reported.filter((entry) => entry.sheet === 'Azure Baseline');
    expect(azure.length).toBeGreaterThanOrEqual(12);
    expect(analysis.resources.some((resource) => resource.sheet === 'Azure Baseline')).toBe(false);
  });

  test('keeps the assumptions that govern the estimate', () => {
    const facts = analysis.insights.facts;
    const find = (pattern: RegExp) => facts.find((fact) => pattern.test(`${fact.label} ${fact.value}`));

    expect(find(/BYOL/)).toBeDefined();                       // no SQL/RHEL licence cost
    expect(find(/260 hrs\/month/)).toBeDefined();             // the Dev/UAT schedule
    expect(find(/consolidat/i)).toBeDefined();                // 6 SQL VMs into 4 targets
    expect(facts.length).toBeGreaterThan(30);
  });

  test('resolves the exchange rate to the one the workbook verifies, and flags the other', () => {
    // Pricing Inputs states "1 EUR = 1.14 USD" outright; TCO Summary carries a stale
    // 1.5 while claiming to reference Pricing Inputs. Silently taking the wrong one
    // would misstate every reported figure by a third.
    expect(analysis.insights.fx_rate).toBeCloseTo(1.14, 4);
    expect(analysis.insights.currency).toBe('USD');
    expect(analysis.warnings.join(' ')).toMatch(/more than one exchange rate/);
  });

  test('reads every stated schedule, so no row silently falls back to a default', () => {
    // The hours columns are the easiest thing on this sheet to misread -- "260" is a
    // MONTHLY figure sitting under a heading a per-day parser would claim. Either
    // warning appearing here means a row was priced at its environment's default
    // instead of the schedule its own author wrote, which is a quiet 3x error.
    const fallbacks = analysis.warnings.filter((line) => line.includes('hours per day') || line.includes('monthly hours'));
    expect(fallbacks).toEqual([]);
  });

  test('every sheet is accounted for, and the summary tab survives as text', () => {
    expect(analysis.insights.sheets).toHaveLength(10);
    expect(analysis.insights.sheets.every((sheet) => sheet.detail.length > 0)).toBe(true);
    expect(analysis.insights.excerpts.some((excerpt) => excerpt.sheet === 'TCO Summary')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The simple case
// ---------------------------------------------------------------------------

describe('A simple sheet', () => {
  test('the five-column template parses', async () => {
    const buffer = await xlsx({
      Resources: [
        ['Environment', 'Service', 'Instance / Size', 'Qty', 'Region', 'Hours/Day', 'Notes'],
        ['Production', 'Amazon EC2', 'm6i.large', '4', 'ap-south-1', '24', 'web tier'],
        ['Dev', 'Amazon RDS', 'db.t3.medium', '1', 'ap-south-1', '8', 'off overnight'],
      ],
    });

    const { resources } = await analyseWorkbook(buffer, 'simple.xlsx');

    expect(resources).toHaveLength(2);
    expect(resources[0]).toMatchObject({
      environment: 'Production', service: 'Amazon EC2', size: 'm6i.large', quantity: '4',
      region: 'ap-south-1', hoursPerDay: 24,
    });
    expect(resources[1]).toMatchObject({ service: 'Amazon RDS', size: 'db.t3.medium', hoursPerDay: 8 });
  });

  test('a service with no instance type beside it is still a resource', async () => {
    // "Amazon S3, 40 TB" has no size in the EC2 sense. It must not be dropped for it.
    const buffer = await xlsx({
      Sheet1: [
        ['Service', 'Size', 'Quantity'],
        ['Amazon S3', '40 TB Standard', '1'],
        ['Application Load Balancer', '', '2'],
      ],
    });

    const { resources } = await analyseWorkbook(buffer, 'services.xlsx');

    expect(resources).toHaveLength(2);
    expect(resources.map((resource) => resource.service)).toEqual(['Amazon S3', 'Application Load Balancer']);
  });

  test('a csv is read the same way as a workbook', async () => {
    const csv = 'Environment,Service,Size,Qty\nProd,Amazon EC2,c6i.xlarge,3\nDev,Amazon EC2,t3.medium,1';
    const { resources } = await analyseWorkbook(Buffer.from(csv), 'list.csv');

    expect(resources).toHaveLength(2);
    expect(resources[0]).toMatchObject({ environment: 'Prod', size: 'c6i.xlarge', quantity: '3' });
  });
});

// ---------------------------------------------------------------------------
// The clumsy case
// ---------------------------------------------------------------------------

describe('A clumsy sheet', () => {
  test('a title, a blank row and a heading on row 4 are all handled', async () => {
    const buffer = await xlsx({
      Sheet1: [
        ['Server list for migration'],
        ['prepared 12-08-2026'],
        [],
        ['Host', 'Env', 'Target', 'CPUs', 'Memory (GB)', 'Storage'],
        ['app01', 'Prod', 'm6i.large', 2, 8, '500 GB'],
        ['app02', 'Prod', 'm6i.large', 2, 8, '500 GB'],
      ],
    });

    const { resources } = await analyseWorkbook(buffer, 'clumsy.xlsx');

    expect(resources).toHaveLength(2);
    expect(resources[0]).toMatchObject({ name: 'app01', size: 'm6i.large', vcpu: 2, ram_gb: 8, disk_gb: 500 });
  });

  test('a sheet with no heading row at all is read from its values', async () => {
    // Nothing to match a column name against, because there are no column names. The
    // instance types, the environments and the OS have to be recognised by shape.
    const buffer = await xlsx({
      Sheet1: [
        ['app01', 'Prod', 'm6i.large', 'Windows'],
        ['app02', 'Prod', 'm6i.xlarge', 'Linux'],
        ['db01', 'Dev', 'r6i.large', 'Linux'],
      ],
    });

    const { resources } = await analyseWorkbook(buffer, 'headerless.xlsx');

    expect(resources).toHaveLength(3);
    expect(resources.map((resource) => resource.size)).toEqual(['m6i.large', 'm6i.xlarge', 'r6i.large']);
    expect(resources.map((resource) => resource.environment)).toEqual(['Prod', 'Prod', 'Dev']);
    expect(resources[0].os).toBe('Windows');
    // Nothing is lost even where nothing was named: the row survives verbatim.
    expect(resources[0].raw).toContain('app01');
  });

  test('headings stacked over two rows are composed, not halved', async () => {
    const buffer = await xlsx({
      Sheet1: [
        ['', '', 'Azure', '', 'Right-Sized', ''],
        ['Name', 'Env', 'vCPU', 'RAM (GB)', 'vCPU', 'RAM (GB)'],
        ['app01', 'Prod', 8, 32, 4, 16],
        ['app02', 'Prod', 16, 64, 8, 32],
      ],
    });

    const { resources } = await analyseWorkbook(buffer, 'stacked.xlsx');

    expect(resources).toHaveLength(2);
    // Without composition both tiers read as an identical "vCPU" column and one
    // silently wins, so the recommendation and the current spec become the same number.
    // The current spec is folded into vcpu/ram_gb because it is the only spec stated;
    // the recommendation stays separate, as the second scenario to price.
    expect(resources[0]).toMatchObject({
      name: 'app01', vcpu: 8, ram_gb: 32, right_sized_vcpu: 4, right_sized_ram_gb: 16,
    });
    expect(resources[1]).toMatchObject({ name: 'app02', vcpu: 16, right_sized_vcpu: 8 });
  });

  test('capacities keep their own units', async () => {
    const buffer = await xlsx({
      Sheet1: [
        ['Server', 'Instance', 'Disk'],
        ['app01', 'm6i.large', '2 TB'],
        ['app02', 'm6i.large', '512 GiB'],
        ['app03', 'm6i.large', '900'],
      ],
    });

    const { resources } = await analyseWorkbook(buffer, 'units.xlsx');

    expect(resources[0].disk_gb).toBeCloseTo(2048, 0);
    expect(resources[1].disk_gb).toBeCloseTo(512, 0);
    expect(resources[2].disk_gb).toBe(900);   // a bare number is GB
  });

  test('a total row is a total, on any sheet', async () => {
    const buffer = await xlsx({
      Sheet1: [
        ['Name', 'Instance', 'Monthly Cost ($)'],
        ['app01', 'm6i.large', 62.05],
        ['app02', 'm6i.large', 62.05],
        ['TOTAL', '', 124.1],
      ],
    });

    const { resources, insights } = await analyseWorkbook(buffer, 'totals.xlsx');

    expect(resources).toHaveLength(2);
    expect(insights.reported.some((entry) => entry.monthly === 124.1)).toBe(true);
  });

  test('one machine per label/value block is still an inventory', async () => {
    const buffer = await xlsx({
      Sheet1: [
        ['Hostname', 'app01'],
        ['Instance', 'm6i.2xlarge'],
        ['vCPU', 8],
        ['RAM (GB)', 32],
        [],
        ['Hostname', 'app02'],
        ['Instance', 'r6i.xlarge'],
        ['vCPU', 4],
        ['RAM (GB)', 32],
      ],
    });

    const { resources } = await analyseWorkbook(buffer, 'blocks.xlsx');

    expect(resources).toHaveLength(2);
    expect(resources.map((resource) => resource.size)).toEqual(['m6i.2xlarge', 'r6i.xlarge']);
  });

  test('an assumptions block is not a machine', async () => {
    // The failure this replaces: a scope paragraph became a "server" whose name was a
    // 200-character sentence and whose instance type was "m6a / r6a / c6a".
    const buffer = await xlsx({
      Assumptions: [
        ['Approach', 'Lift-and-shift for all servers, EXCEPT SQL Server consolidation (see below)'],
        ['Instance family', 'AMD-based instance families throughout: m6a / r6a / c6a for general workloads'],
        ['Support plan', 'None modeled'],
        [],
        ['Name', 'Instance', 'Env'],
        ['app01', 'm6i.large', 'Prod'],
      ],
    });

    const { resources, insights } = await analyseWorkbook(buffer, 'assumptions.xlsx');

    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({ name: 'app01', size: 'm6i.large', environment: 'Prod' });
    expect(insights.facts.some((fact) => fact.label === 'Support plan')).toBe(true);
    // The prose-shaped pairs stayed facts, and the sentence never became a name.
    expect(insights.facts.some((fact) => /AMD-based/.test(fact.value))).toBe(true);
  });

  test('every sheet with content is read, not just the first', async () => {
    const buffer = await xlsx({
      Notes: [['Target region', 'AWS Frankfurt (eu-central-1)']],
      Empty: [],
      Servers: [
        ['Name', 'Instance'],
        ['app01', 'm6i.large'],
      ],
    });

    const { resources, insights } = await analyseWorkbook(buffer, 'multi.xlsx');

    expect(resources).toHaveLength(1);
    // The region was on a different tab from the only machine.
    expect(insights.primary_region).toBe('eu-central-1');
    // An empty tab is skipped rather than reported as an empty sheet.
    expect(insights.sheets.map((sheet) => sheet.name)).toEqual(['Notes', 'Servers']);
  });

  test('a sheet that cannot be structured is passed through rather than rejected', async () => {
    const buffer = await xlsx({
      Sheet1: [
        ['widget', 'blue', 'large', 'yes'],
        ['widget', 'red', 'small', 'no'],
        ['gadget', 'green', 'large', 'yes'],
      ],
    });

    const { resources, warnings } = await analyseWorkbook(buffer, 'opaque.xlsx');

    // Nothing here is priceable, so the rows are handed over verbatim and the user is
    // told why the estimate will be rough. Rejecting the upload is the one outcome
    // they could not work around.
    expect(resources).toHaveLength(3);
    expect(resources.every((resource) => resource.raw.length > 0)).toBe(true);
    expect(resources[0].raw).toContain('widget');
    expect(warnings.join(' ')).toMatch(/passed through as text/);
  });

  test('a merged banner over the table does not shift the columns', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Sheet1');
    sheet.addRow(['Server inventory — Q3 migration wave']);
    sheet.mergeCells('A1:E1');
    sheet.addRow([]);
    sheet.addRow(['Name', 'Env', 'Instance', 'vCPU', 'Disk']);
    sheet.addRow(['app01', 'Prod', 'm6i.large', 2, '500 GB']);
    sheet.addRow(['app02', 'Dev', 't3.medium', 2, '100 GB']);

    const { resources } = await analyseWorkbook(
      Buffer.from(await workbook.xlsx.writeBuffer()), 'merged.xlsx',
    );

    expect(resources).toHaveLength(2);
    expect(resources[0]).toMatchObject({ name: 'app01', size: 'm6i.large', vcpu: 2, disk_gb: 500 });
  });

  test('money written with symbols and separators is still a number', async () => {
    const buffer = await xlsx({
      Sheet1: [
        ['Name', 'Instance', 'Total Monthly Cost'],
        ['app01', 'm6i.large', '$1,234.56'],
        ['app02', 'm6i.large', '$2,000'],
      ],
    });

    const { resources, insights } = await analyseWorkbook(buffer, 'money.xlsx');

    expect(resources[0].reported_monthly).toBeCloseTo(1234.56, 2);
    expect(resources[1].reported_monthly).toBeCloseTo(2000, 2);
    expect(insights.reported_monthly_total).toBeCloseTo(3234.56, 2);
    expect(insights.currency).toBe('USD');
  });

  test('a quantity column multiplies the machine count', async () => {
    const buffer = await xlsx({
      Sheet1: [
        ['Service', 'Size', 'Qty', 'Total Disk'],
        ['Amazon EC2', 'm6i.large', '4', '100 GB'],
        ['Amazon EC2', 'r6i.large', '2', '200 GB'],
      ],
    });

    const { resources, insights } = await analyseWorkbook(buffer, 'qty.xlsx');

    expect(resources).toHaveLength(2);
    // Two rows, six machines. Counting rows would understate the estimate threefold.
    expect(insights.server_count).toBe(6);
  });

  test('two tables on one sheet are both read', async () => {
    const buffer = await xlsx({
      Sheet1: [
        ['Production servers'],
        ['Name', 'Instance', 'Env'],
        ['app01', 'm6i.large', 'Prod'],
        ['app02', 'm6i.large', 'Prod'],
        [],
        ['Non-production servers'],
        ['Name', 'Instance', 'Env'],
        ['dev01', 't3.medium', 'Dev'],
      ],
    });

    const { resources } = await analyseWorkbook(buffer, 'two-tables.xlsx');

    expect(resources.map((resource) => resource.name)).toEqual(['app01', 'app02', 'dev01']);
    expect(resources[2].environment).toBe('Dev');
  });

  test('a footnote under the table is not a machine', async () => {
    const buffer = await xlsx({
      Sheet1: [
        ['Name', 'Instance', 'Env'],
        ['app01', 'm6i.large', 'Prod'],
        ['* Excludes SQL Server licences, which are BYOL', '', ''],
      ],
    });

    const { resources, insights } = await analyseWorkbook(buffer, 'footnote.xlsx');

    expect(resources).toHaveLength(1);
    expect(resources[0].name).toBe('app01');
    // And the footnote survives, because it changes what the estimate covers.
    const text = [...insights.excerpts.map((e) => e.text), ...insights.facts.map((f) => f.value)].join(' ');
    expect(text).toMatch(/BYOL/);
  });

  test('decorated headings still match', async () => {
    const buffer = await xlsx({
      Sheet1: [
        ['Server-Name', 'Instance-Type', "vCPU's", 'RAM(GiB)', 'Disk (GB)', 'Hrs/Day'],
        ['app01', 'm6i.large', 2, 8, 500, 12],
      ],
    });

    const { resources } = await analyseWorkbook(buffer, 'decorated.xlsx');

    expect(resources[0]).toMatchObject({
      name: 'app01', size: 'm6i.large', vcpu: 2, ram_gb: 8, disk_gb: 500, hoursPerDay: 12,
    });
  });

  test('runtime hours stated per month are kept as stated', async () => {
    const buffer = await xlsx({
      Sheet1: [
        ['Name', 'Instance', 'Monthly Hours'],
        ['app01', 'm6i.large', 730],
        ['dev01', 't3.medium', 260],
      ],
    });

    const { resources } = await analyseWorkbook(buffer, 'hours.xlsx');

    expect(resources[0].hoursPerMonth).toBe(730);
    expect(resources[1].hoursPerMonth).toBe(260);
    // 260 h/month is 8.55 h/day, which hoursPerDay alone cannot express.
    expect(resources[1].hoursPerDay).toBeCloseTo(8.55, 2);
  });

  test('a file we cannot open says so by name', async () => {
    await expect(analyseWorkbook(Buffer.from('not a workbook'), 'old.xls'))
      .rejects.toThrow('LEGACY_XLS_UNSUPPORTED');
    await expect(analyseWorkbook(Buffer.from('%PDF-1.4'), 'plan.pdf'))
      .rejects.toThrow('UNSUPPORTED_TABLE_FORMAT: .pdf');
    await expect(analyseWorkbook(Buffer.from('PKbroken'), 'broken.xlsx'))
      .rejects.toThrow('XLSX_PARSE_FAILED');
  });
});

// ---------------------------------------------------------------------------
// Classification, in isolation
// ---------------------------------------------------------------------------

describe('Telling one kind of table from another', () => {
  const classify = (header: string[], rows: string[][]) => {
    const { columns: matched, scores } = matchColumnsScored(header, INVENTORY_FIELDS_FOR_TEST);
    const { columns } = inferColumnsFromData(matched, rows, header.length);
    return classifyTable(columns, rows.length, buildEvidence(header, rows, columns, scores, header.length));
  };

  test('a rate card is not an inventory', () => {
    expect(classify(
      ['Instance Type', 'vCPU', 'RAM (GiB)', 'On-Demand Linux', '3-Yr No Upfront Linux'],
      [['m6a.large', '2', '8', '0.1035', '0.05383'], ['m6a.xlarge', '4', '16', '0.207', '0.10767']],
    )).toBe('rates');
  });

  test('an inventory carrying an hourly rate is still an inventory', () => {
    expect(classify(
      ['VM Name', 'Environment', 'Target AWS Instance', 'Hourly Rate ($)', 'Total Monthly ($)'],
      [['app01', 'Prod', 'm6a.large', '0.05383', '131.85'], ['app02', 'Dev', 'm6a.large', '0.05383', '131.85']],
    )).toBe('inventory');
  });

  test('a segment cost summary is not an inventory', () => {
    expect(classify(
      ['Segment', 'Instance Count', 'Monthly Cost ($)', 'Annual Cost ($)'],
      [['Production (3-Yr No Upfront)', '84', '17301.63', '207619.62'], ['UAT + Dev', '26', '2569.55', '30834.65']],
    )).toBe('costs');
  });

  test('a month-by-month spend history is not an inventory', () => {
    expect(classify(
      ['Month', 'Managed Services (EUR)', 'Azure Tenant (EUR)', 'Source', 'Total (USD)'],
      [
        ['Dec-2025', '12046.83', '30911.06', 'Actual invoice', '35238.61'],
        ['Jan-2026', '12046.83', '32925.61', 'Actual invoice', '37535.20'],
        ['Feb-2026', '12046.83', '31918.34', 'ASSUMPTION', '36386.90'],
      ],
    )).toBe('costs');
  });
});

// The field list is not exported (it is an implementation detail of the analyser), so
// the classification tests above reconstruct the part they exercise. Keeping this in
// step with INVENTORY_FIELDS is the point of the end-to-end tests further up: if the
// two drift, the real-workbook assertions fail first and loudest.
const INVENTORY_FIELDS_FOR_TEST = [
  { field: 'name', aliases: ['vm name', 'server name', 'hostname', 'name', 'server', 'vm'], exclude: ['cost', 'rate', 'price', 'monthly', 'annual'] },
  { field: 'environment', aliases: ['environment', 'env', 'stage', 'tier'] },
  { field: 'service', aliases: ['aws service', 'service', 'resource type', 'component', 'workload'], exclude: ['cost', 'rate', 'price', 'monthly', 'annual'] },
  { field: 'instance_type', aliases: ['target aws instance', 'aws instance', 'instance type', 'instance', 'size'], exclude: ['right sized', 'source', 'azure', 'count'] },
  { field: 'vcpu', aliases: ['vcpu', 'vcpus', 'cpu', 'cores'], exclude: ['right sized', 'source', 'azure'] },
  { field: 'ram_gb', aliases: ['ram gb', 'ram gib', 'ram', 'memory gb', 'memory'], exclude: ['right sized', 'source', 'azure'] },
  { field: 'quantity', aliases: ['quantity', 'qty', 'count', 'instance count', 'servers'] },
  { field: 'hourly_rate', aliases: ['hourly rate', 'rate hr', 'price hr'] },
  { field: 'monthly_total', aliases: ['total monthly', 'monthly total', 'monthly cost', 'monthly', 'total'] },
];

// ---------------------------------------------------------------------------
// Units and regions
// ---------------------------------------------------------------------------

describe('Reading a value', () => {
  test('capacity is converted by the unit the cell itself carries', () => {
    expect(toGigabytes('2 TB')).toBeCloseTo(2048, 0);
    expect(toGigabytes('1,024 GB')).toBe(1024);
    expect(toGigabytes('512 GiB')).toBeCloseTo(512, 0);
    expect(toGigabytes('500000 MB')).toBeCloseTo(488.28, 1);
    expect(toGigabytes('900')).toBe(900);
    expect(toGigabytes('m6i.large')).toBeUndefined();
  });

  test('a region is found by code or by the city it names', () => {
    expect(findRegion('Primary region = AWS Frankfurt (eu-central-1)')).toBe('eu-central-1');
    expect(findRegion('DR site: Ireland')).toBe('eu-west-1');
    expect(findRegion('N Virginia')).toBe('us-east-1');
    expect(findRegion('somewhere else entirely')).toBeUndefined();
  });

  test('a stacked heading is prefixed with the tier above it', () => {
    const rows = [
      ['', '', 'Azure', '', 'Right-Sized', ''],
      ['Name', 'Env', 'vCPU', 'RAM (GB)', 'vCPU', 'RAM (GB)'],
    ];
    expect(composeHeader(rows, 1)).toEqual([
      'Name', 'Env', 'Azure vCPU', 'Azure RAM (GB)', 'Right-Sized vCPU', 'Right-Sized RAM (GB)',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Software licensing
// ---------------------------------------------------------------------------

/**
 * A database licence stated in a spreadsheet has to survive the parse.
 *
 * The OS column is normalised on the way in -- "Windows Server 2019 Datacenter" has to
 * become "Windows" to match an AWS rate at all -- and that fold is where a bundled SQL
 * Server licence used to be lost. It is billed per vCPU, so a Standard licence roughly
 * doubles the machine's rate: dropping it understates the row by about half, and silently,
 * because plain Windows is a real rate. The rules themselves are tested in
 * calculator-sql-licence.test.ts; what is pinned here is that a parsed row carries them.
 */
describe('A licence stated on the row', () => {
  test('an edition in the OS column reaches the parsed row', async () => {
    const buffer = await xlsx({
      Sheet1: [
        ['Host', 'Env', 'Target', 'Operating System', 'Storage'],
        ['db01', 'Prod', 'r6i.2xlarge', 'Windows Server 2019 + SQL Server Standard', '500 GB'],
      ],
    });

    const { resources } = await analyseWorkbook(buffer, 'licensed.xlsx');
    expect(resources[0].os).toBe('Windows + SQL Server Standard');
  });

  test('a remarks column waives a licence the columns named', async () => {
    const buffer = await xlsx({
      Sheet1: [
        ['Host', 'Env', 'Target', 'OS', 'Storage', 'Remarks'],
        ['db01', 'Prod', 'r6i.2xlarge', 'Windows + SQL Server Enterprise', '500 GB', 'BYOL - client owns the licences'],
      ],
    });

    const { resources } = await analyseWorkbook(buffer, 'byol.xlsx');
    expect(resources[0].os).toBe('Windows + SQL Server Enterprise (BYOL)');
  });

  test('free text mentioning SQL Server does not buy a licence', async () => {
    // This note is in the real COSEC model against machines whose OS column says only
    // "Windows". Reading it as a purchase would add a per-vCPU licence to servers that
    // never asked for one -- an overstatement of roughly their whole compute cost.
    const buffer = await xlsx({
      Sheet1: [
        ['Host', 'Env', 'Target', 'OS', 'Storage', 'Remarks'],
        ['db01', 'Prod', 'r6i.2xlarge', 'Windows', '500 GB', 'SQL Server consolidation sizing (6 VMs to 4 instances)'],
      ],
    });

    const { resources } = await analyseWorkbook(buffer, 'note.xlsx');
    expect(resources[0].os).toBe('Windows');
  });

  test('another database whose name contains "sql" is left alone', async () => {
    const buffer = await xlsx({
      Sheet1: [
        ['Host', 'Env', 'Service', 'Target', 'OS', 'Storage'],
        ['db01', 'Prod', 'Amazon RDS for MySQL', 'db.r6g.large', 'Linux', '500 GB'],
      ],
    });

    const { resources } = await analyseWorkbook(buffer, 'mysql.xlsx');
    expect(resources[0].os).toBe('Linux');
  });
});

// ---------------------------------------------------------------------------
// What a row is billed on
// ---------------------------------------------------------------------------

/**
 * Every stored row has to say what its numbers MEAN, in units AWS meters.
 *
 * The bug that forced this: a workbook stating "ECS Fargate, 10 tasks, 1440 minutes" was
 * priced as ten tasks a MONTH rather than ten a day, with 1440 read as a monthly runtime
 * rather than converted out of minutes. Both halves are arithmetic on a number whose
 * dimension nobody wrote down, and neither shows up as an error -- the estimate simply comes
 * out low and looks finished. shared/canonical-workbook.ts does the reading and is tested on
 * its own; what is pinned here is that the readers actually call it, that the amounts reach
 * the stored row unaltered, and that nothing the sheet said goes missing on the way.
 */
describe('The billing quantities on a parsed row', () => {
  test('a machine states its runtime and its storage as monthly quantities, not as bare numbers', async () => {
    const buffer = await xlsx({
      Servers: [
        ['Host', 'Env', 'Target AWS Instance', 'Qty', 'Disk (GB)', 'Hours/Day'],
        ['web01', 'Prod', 'm6i.large', '2', '500', '24'],
      ],
    });

    const { resources } = await analyseWorkbook(buffer, 'flat.xlsx');

    expect(resources[0].quantities).toEqual([
      { unit: 'hours/month', amount: 1460, basis: 'compute runtime', conversions: ['2 x 730 hours = 1460 hours a month'] },
      { unit: 'GB/month', amount: 1000, basis: 'disk', conversions: ['500 GB x 2 = 1000 GB a month'] },
    ]);
  });

  test('the amounts are already scaled for the row\'s own count, and the count is left on the row unmultiplied', async () => {
    // The invariant the Fargate bug broke. 1460 is 2 x 730 and 1000 is 2 x 500, both scaled
    // exactly once; the quantity column and the per-machine disk are still on the row for the
    // prompt builder to group by, and anything that multiplies an amount by `quantity` a
    // second time produces 2,920 hours and 2,000 GB for two m6i.larges with a 500 GB disk.
    const buffer = await xlsx({
      Servers: [
        ['Host', 'Env', 'Target AWS Instance', 'Qty', 'Disk (GB)', 'Hours/Day'],
        ['web01', 'Prod', 'm6i.large', '2', '500', '24'],
      ],
    });

    const { resources } = await analyseWorkbook(buffer, 'flat.xlsx');
    const [row] = resources;

    expect(row.quantity).toBe('2');
    expect(row.disk_gb).toBe(500);
    expect(row.quantities?.map((quantity) => quantity.amount)).toEqual([1460, 1000]);
  });

  test('a part-time machine is metered on the hours it stated rather than a whole month', async () => {
    const buffer = await xlsx({
      Servers: [
        ['Host', 'Env', 'Target AWS Instance', 'Qty', 'Disk (GB)', 'Hours/Day'],
        ['dev01', 'Dev', 't3.medium', '1', '100', '8'],
      ],
    });

    const { resources } = await analyseWorkbook(buffer, 'flat.xlsx');

    // 8 hours a day is 243.33 hours a month, and 730 would be three times the compute bill.
    expect(resources[0].quantities?.[0]).toMatchObject({ unit: 'hours/month', amount: 243.33 });
    // Storage is billed whether the machine is running or not, so its own amount ignores them.
    expect(resources[0].quantities?.[1]).toMatchObject({ unit: 'GB/month', amount: 100 });
  });

  test('separately named volumes are metered one by one, so a reader can see which is which', async () => {
    const buffer = await xlsx({
      Servers: [
        ['Host', 'Env', 'Target AWS Instance', 'Qty', 'OS Disk (GB)', 'Data Disk (GB)'],
        ['app01', 'Prod', 'm6i.large', '2', '100', '400'],
      ],
    });

    const { resources } = await analyseWorkbook(buffer, 'volumes.xlsx');

    expect(resources[0].disks).toEqual([{ label: 'OS disk', gb: 100 }, { label: 'Data disk', gb: 400 }]);
    expect(resources[0].disk_gb).toBe(500);
    expect(resources[0].quantities?.filter((quantity) => quantity.unit === 'GB/month')).toEqual([
      { unit: 'GB/month', amount: 200, basis: 'OS disk', conversions: ['100 GB x 2 = 200 GB a month'] },
      { unit: 'GB/month', amount: 800, basis: 'Data disk', conversions: ['400 GB x 2 = 800 GB a month'] },
    ]);
  });

  test('a disk total the sheet footed is metered whole, and its parts are not published beside it', async () => {
    // The parts here come to 500 against a stated 600, which is normal in a real model: a
    // sheet rounds, or lists a volume it has no column for. The normaliser reads a breakdown
    // IN PLACE OF the total, so publishing this one would meter 100 GB less than the author
    // asked for -- quietly, because both figures are plausible.
    const buffer = await xlsx({
      Servers: [
        ['Host', 'Env', 'Target AWS Instance', 'Qty', 'Total Disk (GB)', 'OS Disk (GB)', 'Data Disk (GB)'],
        ['app01', 'Prod', 'm6i.large', '1', '600', '100', '400'],
      ],
    });

    const { resources } = await analyseWorkbook(buffer, 'footed.xlsx');

    expect(resources[0].disk_gb).toBe(600);
    expect(resources[0].disks).toBeUndefined();
    expect(resources[0].quantities?.filter((quantity) => quantity.unit === 'GB/month'))
      .toEqual([{ unit: 'GB/month', amount: 600, basis: 'disk', conversions: [] }]);
  });

  test('columns with no field of their own are kept as labelled attributes rather than dropped', async () => {
    // A backup line the client already costed is not an AWS rate and must never be priced as
    // one, but it is half of any variance a reviewer wants to check against their own model.
    const buffer = await xlsx({
      Servers: [
        ['Host', 'Env', 'Target AWS Instance', 'Qty', 'Monthly Backup Cost', 'Utilization Data Source'],
        ['web01', 'Prod', 'm6i.large', '1', '$40.00', 'Azure Monitor, 90 days'],
      ],
    });

    const { resources } = await analyseWorkbook(buffer, 'extras.xlsx');

    expect(resources[0].attributes).toEqual([
      { label: 'Backup cost stated in the sheet', value: '$40.00' },
      { label: 'Utilisation source', value: 'Azure Monitor, 90 days' },
    ]);
  });

  test('a heading inside the table names the rows beneath it, and a footnote beside them does not', async () => {
    // Both are one populated cell in a six-column table and both are kept as facts. Only the
    // heading is attached to machines: labelling three servers "Excludes SQL Server licences"
    // is not something a reader can tell back out of the record afterwards.
    const buffer = await xlsx({
      Servers: [
        ['Host', 'Env', 'Target AWS Instance', 'Qty', 'Disk (GB)', 'Hours/Day'],
        ['web01', 'Prod', 'm6i.large', '2', '500', '24'],
        ['Non-production servers'],
        ['dev01', 'Dev', 't3.medium', '1', '100', '8'],
        ['* Excludes SQL Server licences, which are BYOL.'],
        ['dev02', 'Dev', 't3.small', '1', '50', '8'],
      ],
    });

    const { resources, insights } = await analyseWorkbook(buffer, 'sections.xlsx');

    expect(resources.map((resource) => resource.section))
      .toEqual([undefined, 'Non-production servers', 'Non-production servers']);
    expect(insights.facts.map((fact) => fact.value)).toEqual([
      'Non-production servers',
      '* Excludes SQL Server licences, which are BYOL.',
    ]);
  });

  test('a row the sheet zeroed says so out loud instead of being metered as one machine', async () => {
    // metric-matrix.ts records what pricing a zeroed row anyway did once: a Kafka cluster the
    // author had ruled out appeared in all eight scenarios. The row is still stored, because
    // the sheet listed it and a reviewer may want to ask about it.
    const buffer = await xlsx({
      Servers: [
        ['Host', 'Env', 'Target AWS Instance', 'Qty', 'Disk (GB)', 'Hours/Day'],
        ['web02', 'Prod', 'm6i.large', '0', '100', '24'],
      ],
    });

    const { resources, warnings } = await analyseWorkbook(buffer, 'zeroed.xlsx');

    expect(resources).toHaveLength(1);
    expect(resources[0].quantities).toBeUndefined();
    expect(warnings.join(' ')).toMatch(/row 2: no billing quantity could be read from it -- its quantity is stated as 0/);
  });

  test('a sheet of prose declares nothing at all, rather than declaring a guess', async () => {
    // The path an estimate written as a brief takes. There is no table here to meter, so no row
    // reaches the normaliser and none comes back carrying a dimension -- a fabricated quantity
    // on a sentence would outrank what the model reads in the text itself, which is the only
    // thing on this sheet that means anything.
    const buffer = await xlsx({
      Brief: [
        ['We need a landing zone in Mumbai for a Django application.'],
        ['Traffic is around 40 requests a second at peak.'],
      ],
    });

    const { resources, warnings } = await analyseWorkbook(buffer, 'brief.xlsx');

    expect(resources.every((resource) => resource.quantities === undefined)).toBe(true);
    expect(warnings.join(' ')).toMatch(/passed through as text for interpretation/);
  });
});

// ---------------------------------------------------------------------------
// A transposed sheet's billing quantities
// ---------------------------------------------------------------------------

/**
 * The same requirement on the matrix path, where the loss was worst.
 *
 * `usage_amount` and `usage_unit` were read off a metric matrix, stored on the row and then
 * consumed by nothing at all: every managed service in a capacity model was parsed perfectly
 * and priced as though it were absent. The cells are now handed on UNCONVERTED, labels and
 * all, so the amount and its dimension arrive together.
 */
describe('The billing quantities on a transposed sheet', () => {
  const CAPACITY = {
    Capacity: [
      ['Metric', 'Dev', 'UAT'],
      ['ECS Fargate task count', '10', '20'],
      ['ECS Fargate task vCPU', '2', '2'],
      ['ECS Fargate task memory GB', '4', '4'],
      ['Lambda invocations per month (millions)', '5', '9'],
      ['Aurora instance class', 'db.r6g.large', 'db.r6g.xlarge'],
      ['Aurora instance count', '2', '3'],
      ['Aurora storage (GB)', '500', '900'],
      ['Pinecone vector index pods', '2', '2'],
    ],
  };

  test('a Fargate task count becomes the vCPU-hours and GB-hours AWS actually bills for', async () => {
    // AWS publishes no rate for a task, which is why this row priced as nothing before: ten
    // tasks of 2 vCPU each, running the month, is 14,600 vCPU-hours and 29,200 GB-hours.
    const { resources } = await analyseWorkbook(await xlsx(CAPACITY), 'capacity.xlsx');
    const fargate = resources.find((resource) => resource.scenario === 'dev' && /Fargate/.test(resource.name ?? ''));

    expect(fargate?.quantities?.map((quantity) => [quantity.unit, quantity.amount])).toEqual([
      ['vCPU-hours/month', 14600],
      ['GB-hours/month', 29200],
    ]);
    // The arithmetic travels with the number, so a reader can check it without the sheet.
    expect(fargate?.quantities?.[0].conversions.join(' ')).toMatch(/10 task\(s\) x 730 runtime hours/);
  });

  test('a figure the sheet wrote in millions is metered in whole units', async () => {
    // Five million invocations priced as five is not a rounding error, it is a rounding error
    // of a millionfold, and the label is the only place the sheet said which it meant.
    const { resources } = await analyseWorkbook(await xlsx(CAPACITY), 'capacity.xlsx');
    const lambda = resources.find((resource) => resource.scenario === 'dev' && /Lambda/.test(resource.name ?? ''));

    expect(lambda?.quantities).toEqual([{
      unit: 'invocations/month',
      amount: 5_000_000,
      originalValue: 5,
      originalUnit: 'invocations',
      originalScale: 'millions',
      originalPeriod: 'month',
      derivedValue: 5_000_000,
      derivedUnit: 'invocations/month',
      derivedScale: 'whole',
      derivedPeriod: 'month',
      conversionFormula: 'millions expanded to whole units (x 1,000,000)',
      basis: 'Lambda invocations per month (millions)',
      conversions: ['millions expanded to whole units (x 1,000,000)'],
    }]);
  });

  test('a cluster\'s storage is metered once, not once per instance in it', async () => {
    // "Aurora storage (GB) 500" against "Aurora instance count 2" is 500 GB for the cluster.
    // Scaling it by the instance count is the same double-multiplication as the Fargate bug,
    // and 1,000 GB of Aurora storage is as plausible-looking as 500.
    const { resources } = await analyseWorkbook(await xlsx(CAPACITY), 'capacity.xlsx');
    const aurora = resources.find((resource) => resource.scenario === 'dev' && /Aurora/.test(resource.name ?? ''));

    expect(aurora?.quantities?.map((quantity) => [quantity.unit, quantity.amount])).toEqual([
      ['hours/month', 1460],
      ['GB/month', 500],
    ]);
  });

  test('the reader\'s own exclusions and conversions are left as they were, not restated', async () => {
    // The normaliser describes the same cells in its own words, so publishing its account
    // beside the reader's would show a reviewer every conversion twice under two labels and
    // every refusal twice with two reasons. Its wording travels on the row's quantities
    // instead, which is where anyone checking that row's arithmetic is already looking.
    const { insights } = await analyseWorkbook(await xlsx(CAPACITY), 'capacity.xlsx');

    expect(insights.exclusions).toEqual([{
      metric: 'Pinecone vector index pods',
      reason: 'pinecone is not an AWS service, so its 1 row(s) are not in the AWS estimate',
    }]);
    expect(insights.conversions).toEqual(['Lambda invocations per month (millions): millions expanded']);
  });

  test('a Fargate row with no task size states why it could not be metered and is still stored', async () => {
    // Refusing to meter a row is not the same as leaving it out of the estimate: it is still
    // priced from whatever else it says. What must never happen is the refusal being silent,
    // because a Fargate line that vanishes from the workings leaves a total that looks whole.
    const buffer = await xlsx({
      Capacity: [
        ['Metric', 'Dev', 'UAT'],
        ['DR Fargate warm-standby task count', '5', '5'],
        ['Aurora instance class', 'db.r6g.large', 'db.r6g.xlarge'],
        ['Aurora instance count', '2', '3'],
      ],
    });

    const { resources, warnings } = await analyseWorkbook(buffer, 'standby.xlsx');
    const standby = resources.find((resource) => /warm-standby/.test(resource.name ?? ''));

    expect(standby).toBeDefined();
    expect(standby?.quantities).toBeUndefined();
    expect(warnings.join(' ')).toMatch(/warm-standby task count \(dev\): no billing quantity could be read from it -- Fargate is billed per vCPU-hour/);
  });
});
