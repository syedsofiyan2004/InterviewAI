import ExcelJS from 'exceljs';
import { readWorkbook, valueToText } from '../lambdas/shared/workbook';
import { analyseWorkbook } from '../lambdas/api-handler/calculator-workbook';

/**
 * Spreadsheet input for the Cost Calculator.
 *
 * The promise made to the user was that the template parses reliably AND that a sheet
 * which is not the template still works. Both halves are load-bearing: a client's own
 * resource list is exactly what someone will upload first, and rejecting it would send
 * them back to retyping into a textarea.
 *
 * These tests cover the two layers a simple upload passes through -- readWorkbook
 * turning bytes into cell text, and analyseWorkbook turning cell text into resources.
 * The messy end of the range (ten tabs, a header on row 4, rates and assumptions in
 * label/value blocks, a real customer model) lives in calculator-workbook.test.ts.
 */

async function xlsxBuffer(rows: unknown[][], sheetName = 'Resources'): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  rows.forEach((row) => sheet.addRow(row as ExcelJS.CellValue[]));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const TEMPLATE_HEADER = ['Environment', 'Service', 'Instance / Size', 'Qty', 'Region', 'Hours/Day', 'Notes'];

describe('Reading a spreadsheet', () => {
  test('an xlsx round-trips to rows of cell text', async () => {
    const buffer = await xlsxBuffer([
      TEMPLATE_HEADER,
      ['Production', 'EC2', 't3.large', '2', 'ap-south-1', '24', 'web tier'],
    ]);

    const [sheet] = await readWorkbook(buffer, 'resources.xlsx');

    expect(sheet.name).toBe('Resources');
    expect(sheet.rows[0]).toEqual(TEMPLATE_HEADER);
    expect(sheet.rows[1]).toEqual(['Production', 'EC2', 't3.large', '2', 'ap-south-1', '24', 'web tier']);
  });

  test('a csv comma inside quotes stays in one cell', async () => {
    // The Notes column is free text, and "off at weekends, on-call only" is exactly
    // what someone types. A naive split would shift every column after it.
    const csv = 'Environment,Service,Notes\nDev,EC2,"off at weekends, on-call only"';

    const [sheet] = await readWorkbook(Buffer.from(csv), 'list.csv');

    expect(sheet.rows[1]).toEqual(['Dev', 'EC2', 'off at weekends, on-call only']);
  });

  test('a doubled quote inside a quoted cell is one literal quote', async () => {
    const csv = 'Service,Notes\nEC2,"the ""web"" tier"';

    const [sheet] = await readWorkbook(Buffer.from(csv), 'list.csv');

    expect(sheet.rows[1][1]).toBe('the "web" tier');
  });

  test('the BOM Excel writes does not contaminate the first header', async () => {
    // Without stripping it the first header becomes "﻿Environment" and every header
    // match against it fails -- the sheet silently degrades to free text.
    const [sheet] = await readWorkbook(Buffer.from('﻿Environment,Service\nDev,EC2'), 'list.csv');

    expect(sheet.rows[0][0]).toBe('Environment');
  });

  test('trailing empty rows and columns are dropped', async () => {
    // Excel readily reports a used range far past the typed data; those blank rows
    // would otherwise arrive as resources with no service.
    const buffer = await xlsxBuffer([
      ['Service', 'Qty', '', ''],
      ['EC2', '1', '', ''],
      ['', '', '', ''],
      ['', '', '', ''],
    ]);

    const [sheet] = await readWorkbook(buffer, 'padded.xlsx');

    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[0]).toHaveLength(2);
  });

  test('a blank row INSIDE the data is kept, because it separates one block from the next', async () => {
    // The opposite of the rule above, and the reason the two are not one rule: a blank
    // row is how an Excel author ends a title and starts a table. Dropping it would
    // glue "Server inventory" onto the header row beneath it.
    const buffer = await xlsxBuffer([
      ['Server inventory'],
      [],
      ['Service', 'Qty'],
      ['EC2', '1'],
    ]);

    const [sheet] = await readWorkbook(buffer, 'titled.xlsx');

    expect(sheet.rows).toHaveLength(4);
    expect(sheet.rows[1].join('')).toBe('');
  });

  test('an empty instructions tab is not returned as a sheet', async () => {
    // A template often carries an empty "Instructions" or "Sheet2" tab. Every sheet
    // with content is read -- see calculator-workbook.test.ts -- but an empty one
    // would otherwise be reported to the user as a sheet we found nothing on.
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Instructions');
    const data = workbook.addWorksheet('Resources');
    data.addRow(['Service', 'Qty']);
    data.addRow(['EC2', '3']);

    const sheets = await readWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()), 'two-tabs.xlsx');

    expect(sheets.map((sheet) => sheet.name)).toEqual(['Resources']);
    expect(sheets[0].rows[1]).toEqual(['EC2', '3']);
  });

  test('legacy .xls is named precisely rather than failing as a corrupt xlsx', async () => {
    await expect(readWorkbook(Buffer.from('not really a workbook'), 'old.xls'))
      .rejects.toThrow('LEGACY_XLS_UNSUPPORTED');
  });

  test('an unreadable xlsx reports a parse failure, not a crash', async () => {
    await expect(readWorkbook(Buffer.from('definitely not a zip'), 'broken.xlsx'))
      .rejects.toThrow('XLSX_PARSE_FAILED');
  });
});

describe('Flattening one cell', () => {
  // A client model is full of formulas, and what a person sees in the cell is the
  // cached result. Reading the formula text instead -- or an [object Object] -- would
  // put nonsense into the estimate at every computed column.
  test('a formula reads as its cached result', () => {
    expect(valueToText({ formula: 'B2*C2', result: 1234.5 })).toBe('1234.5');
  });

  test('a formula whose cached result is an error reads as empty', () => {
    expect(valueToText({ formula: 'VLOOKUP(A1,X,2)', result: { error: '#REF!' } })).toBe('');
  });

  test('binary-float noise from the sheet own formulas is not carried through', () => {
    expect(valueToText(28.800000000000004)).toBe('28.8');
  });

  test('a date reads dd-MM-yyyy, the format used everywhere else here', () => {
    expect(valueToText(new Date(Date.UTC(2026, 7, 19)))).toBe('19-08-2026');
  });

  test('rich text and hyperlinks read as the words a person sees', () => {
    expect(valueToText({ richText: [{ text: 'm6a.' }, { text: 'large' }] })).toBe('m6a.large');
    expect(valueToText({ text: 'Frankfurt', hyperlink: 'https://example.invalid' })).toBe('Frankfurt');
  });
});

describe('Mapping a sheet onto resources', () => {
  test('the template columns map straight through', async () => {
    const { resources, warnings } = await analyseWorkbook(await xlsxBuffer([
      TEMPLATE_HEADER,
      ['Production', 'EC2', 't3.large', '2', 'ap-south-1', '24', 'web tier'],
      ['Dev', 'EC2', 't3.small', '2', 'ap-south-1', '8', 'off at weekends'],
    ]), 'resources.xlsx');

    expect(warnings).toEqual([]);
    expect(resources).toHaveLength(2);
    expect(resources[0]).toEqual(expect.objectContaining({
      environment: 'Production', service: 'EC2', size: 't3.large', quantity: '2',
      region: 'ap-south-1', hoursPerDay: 24, notes: 'web tier',
    }));
    expect(resources[1].hoursPerDay).toBe(8);
    // Cited back to the sheet and the row number the user sees in Excel.
    expect(resources[0]).toEqual(expect.objectContaining({ sheet: 'Resources', row: 2 }));
  });

  test('headers match despite capitalisation, spacing and synonyms', async () => {
    const { resources } = await analyseWorkbook(await xlsxBuffer([
      ['  ENV ', 'aws service', 'Instance Type', 'Count', 'AWS Region', 'Hours Per Day', 'Remarks'],
      ['Staging', 'RDS', 'db.t3.medium', '1', 'ap-south-1', '12', 'Multi-AZ'],
      ['Staging', 'RDS', 'db.t3.large', '1', 'ap-south-1', '12', 'read replica'],
    ]), 'synonyms.xlsx');

    expect(resources).toHaveLength(2);
    expect(resources[0]).toEqual(expect.objectContaining({
      environment: 'Staging', service: 'RDS', size: 'db.t3.medium',
      quantity: '1', region: 'ap-south-1', hoursPerDay: 12, notes: 'Multi-AZ',
    }));
  });

  test('a blank Hours/Day is left undefined so the environment default applies', async () => {
    const { resources, warnings } = await analyseWorkbook(await xlsxBuffer([
      TEMPLATE_HEADER,
      ['Production', 'S3', '200 GB Standard', '', 'ap-south-1', '', 'usage-based'],
    ]), 'blank-hours.xlsx');

    expect(resources[0].hoursPerDay).toBeUndefined();
    // Nothing was stated, so there is nothing to warn about.
    expect(warnings).toEqual([]);
  });

  test('an unreadable Hours/Day falls back and says so instead of pricing at 24', async () => {
    const { resources, warnings } = await analyseWorkbook(await xlsxBuffer([
      TEMPLATE_HEADER,
      ['Dev', 'EC2', 't3.small', '1', 'ap-south-1', 'business hours', ''],
    ]), 'unreadable-hours.xlsx');

    expect(resources[0].hoursPerDay).toBeUndefined();
    expect(warnings.join(' ')).toContain('business hours');
  });

  test('hours outside 1-24 are rejected rather than clamped silently, and reported', async () => {
    const { resources, warnings } = await analyseWorkbook(await xlsxBuffer([
      TEMPLATE_HEADER,
      ['Dev', 'EC2', 't3.small', '1', 'ap-south-1', '48', ''],
    ]), 'wide-hours.xlsx');

    // 48 is not a day. Treating it as 24 would hide a mistake in the sheet, and
    // treating it silently as the default would hide it just as well.
    expect(resources[0].hoursPerDay).toBeUndefined();
    expect(warnings.join(' ')).toMatch(/outside 1-24/);
  });

  test('a sheet with no recognisable headers is kept as free text, not rejected', async () => {
    // The whole point of tolerating freeform: a client's own list still produces an
    // estimate, just with less structure. Nothing here is a table at all -- two of the
    // three rows read as a label/value pair -- and all three rows must still survive,
    // because the alternative is the route rejecting the upload outright.
    const { resources, warnings } = await analyseWorkbook(await xlsxBuffer([
      ['Our AWS kit', '', ''],
      ['two web servers, medium sized', 'mumbai', ''],
      ['one postgres database', 'mumbai', ''],
    ], 'Kit'), 'freeform.xlsx');

    expect(resources).toHaveLength(3);
    expect(resources.every((row) => row.raw.length > 0)).toBe(true);
    expect(resources[1].raw).toContain('two web servers');
    expect(warnings.join(' ')).toMatch(/passed through as text/);
  });

  test('every row keeps its raw text even when fully mapped', async () => {
    // The prompt falls back to raw for anything the columns missed, so losing it
    // would lose information the user typed.
    const { resources } = await analyseWorkbook(await xlsxBuffer([
      TEMPLATE_HEADER,
      ['Production', 'EC2', 't3.large', '2', 'ap-south-1', '24', 'web tier'],
    ]), 'raw.xlsx');

    expect(resources[0].raw).toContain('t3.large');
    expect(resources[0].raw).toContain('web tier');
  });

  test('a row with nothing priceable on it is reported, not priced', async () => {
    const { resources, warnings, insights } = await analyseWorkbook(await xlsxBuffer([
      TEMPLATE_HEADER,
      ['Dev', '', '', '', '', '', 'the rest is next phase'],
      ['Production', 'EC2', 't3.large', '1', 'ap-south-1', '24', ''],
    ]), 'comment-row.xlsx');

    expect(resources).toHaveLength(1);
    expect(resources[0].service).toBe('EC2');
    expect(warnings.join(' ')).toMatch(/not priced/);
    // Reported, but not lost: what the row said is kept as a fact about the sheet.
    expect(JSON.stringify(insights.facts) + warnings.join(' ')).toContain('next phase');
  });

  test('a workbook with nothing in it says so', async () => {
    const { resources, warnings } = await analyseWorkbook(await xlsxBuffer([]), 'empty.xlsx');

    expect(resources).toEqual([]);
    expect(warnings.join(' ')).toMatch(/no readable sheets/);
  });

  test('a template with headers and no rows yields nothing to price', async () => {
    // The route turns this into "No resource rows were found in that file. Download the
    // template...", which is the actionable message. What must NOT happen is the
    // heading row being passed through as a resource and priced as a machine.
    const { resources } = await analyseWorkbook(await xlsxBuffer([TEMPLATE_HEADER]), 'headers-only.xlsx');

    expect(resources).toEqual([]);
  });

  test('rows an understood table declined are reported, never re-admitted as text', async () => {
    // 40 rows carrying an environment and a comment and nothing else. The table was
    // read, so the per-row warnings are the truth about it; passing the same rows back
    // through the free-text fallback would contradict them and price 40 comment lines.
    const rows: unknown[][] = [TEMPLATE_HEADER];
    for (let i = 0; i < 40; i++) rows.push(['Dev', '', '', '', '', '', `comment ${i}`]);

    const { resources, warnings } = await analyseWorkbook(await xlsxBuffer(rows), 'comments.xlsx');

    expect(resources).toEqual([]);
    expect(warnings.join(' ')).toMatch(/not priced/);
    // Capped, so one bad sheet cannot bloat the record with forty near-identical lines.
    expect(warnings.length).toBeLessThanOrEqual(25);
  });
});

/**
 * A sheet written sideways: one metric per row, one scenario per column.
 *
 * The shape a real customer uploaded (docs/Digital_Assets.xlsx) and the shape that broke.
 * Nothing in it looks like a column name -- "26-27" is a fiscal year, not a field -- so
 * column matching claimed nothing, every row came back carrying only its raw text, and the
 * pipeline's own filter (a row needs a service, a size or a vCPU count to be priceable)
 * discarded all of them and threw NO_PRICEABLE_ROWS. The user saw "column missing".
 *
 * Read correctly it is not one inventory but several: each column is a whole configuration
 * of the same estate, and the difference between "consecutive years" and "concurrent
 * environments" decides whether adding two of them together is a total or a fiction.
 */
describe('Reading a sheet written sideways', () => {
  const YEARS = ['Metric', '26-27', '27-28', '28-29'];
  const ENVIRONMENTS = ['Metric', 'Dev', 'Testing (QA)', 'UAT'];

  // Every fixture here carries at least three metric rows on purpose. `looksLikeMetricMatrix`
  // refuses anything shorter, because a label column beside numeric columns is also the
  // silhouette of a two-line cost card, and claiming one of those would read dollars as
  // capacity. Nothing is lost by the floor: a capacity model banded across five fiscal
  // years never describes an estate in one metric. Trim a fixture to two rows and the
  // reader stops recognising it, which reads as a bug in the reader rather than the test.
  //
  // They also all carry at least two band columns, for a separate reason with the same
  // shape. A sheet only two columns wide never reaches the table reader at all: the block
  // classifier reads it as a settings list, because "Lambda invocations/yr | 24000000" is
  // exactly what a label/value config pair looks like and there is nothing in the geometry
  // to tell them apart. That is the right call for a two-column sheet, and it costs nothing
  // here — a banded model has more than one band by definition, since the bands are the
  // point. Drop a fixture to one band and it becomes a facts block, not a matrix.

  test('each column becomes its own scenario', async () => {
    const { resources, insights } = await analyseWorkbook(await xlsxBuffer([
      YEARS,
      ['Aurora instance class', 'db.r6g.large', 'db.r6g.large', 'db.r6g.xlarge'],
      ['Aurora instance count', '2', '2', '4'],
      ['Aurora storage (GB)', '100', '100', '200'],
    ]), 'sideways.xlsx');

    expect(insights.bands?.map((band) => band.key)).toEqual(['26-27', '27-28', '28-29']);
    // Three configurations of one database, not one database and two spare columns.
    expect(resources).toHaveLength(3);
    expect(resources.map((row) => row.scenario)).toEqual(['26-27', '27-28', '28-29']);
    expect(resources[2]).toMatchObject({ service: 'Amazon Aurora', size: 'db.r6g.xlarge', quantity: '4' });
  });

  test('every row of the sideways sheet is priceable by the pipeline filter', async () => {
    // The assertion the bug report reduces to. Before the transposed reader existed each
    // of these rows carried a raw string and nothing else, so this count was zero and the
    // run died before it priced anything.
    const { resources } = await analyseWorkbook(await xlsxBuffer([
      YEARS,
      ['ElastiCache node class', 'cache.t4g.micro', 'cache.t4g.small', 'cache.t4g.small'],
      ['ElastiCache node count', '1', '2', '2'],
      ['S3 storage (GB)', '50', '100', '150'],
    ]), 'sideways.xlsx');

    const priceable = resources.filter((row) => row.service || row.size || row.vcpu !== undefined);
    expect(priceable).toHaveLength(resources.length);
    expect(priceable.length).toBeGreaterThan(0);
  });

  test('a triplet of metric rows assembles into one resource, not three', async () => {
    // "class", "count" and "storage (GB)" describe one cluster. Read as three rows they
    // become three line items, two of which cannot be priced at all.
    const { resources } = await analyseWorkbook(await xlsxBuffer([
      ['Metric', 'Dev', 'UAT'],
      ['OpenSearch node class', 't3.small.search', 'r6g.large.search'],
      ['OpenSearch node count', '1', '2'],
      ['OpenSearch storage (GB)', '20', '100'],
    ]), 'sideways.xlsx');

    expect(resources).toHaveLength(2);
    expect(resources[0]).toMatchObject({
      service: 'Amazon OpenSearch Service', size: 't3.small.search', quantity: '1', disk_gb: 20,
    });
  });

  test('fiscal years are marked consecutive and environments concurrent', async () => {
    // The one distinction that changes the arithmetic. Five fiscal years added together
    // overstate the estate fivefold; three environments added together are the estate.
    const years = await analyseWorkbook(await xlsxBuffer([
      YEARS,
      ['Aurora instance class', 'db.t4g.medium', 'db.t4g.medium', 'db.r6g.large'],
      ['Aurora instance count', '1', '1', '2'],
      ['Aurora storage (GB)', '50', '50', '100'],
    ]), 'years.xlsx');
    const environments = await analyseWorkbook(await xlsxBuffer([
      ENVIRONMENTS,
      ['Aurora instance class', 'db.t4g.medium', 'db.t4g.medium', 'db.r6g.large'],
      ['Aurora instance count', '1', '1', '2'],
      ['Aurora storage (GB)', '50', '50', '100'],
    ]), 'environments.xlsx');

    expect(years.insights.bands?.every((band) => band.kind === 'period')).toBe(true);
    expect(environments.insights.bands?.every((band) => band.kind === 'environment')).toBe(true);
    // Stated in words too, because the scenario table alone does not stop a reader adding
    // two columns together.
    expect(years.warnings.join(' ')).toMatch(/must never be added together/);
    expect(environments.warnings.join(' ')).toMatch(/do add up/);
  });

  test('a per-year figure is converted onto a monthly basis and the conversion is stated', async () => {
    // The silent 12x. The unit lives in the label, not in a column, so a row labelled
    // "/yr" priced as a monthly figure overstates by twelve with nothing to show for it.
    const { resources, insights } = await analyseWorkbook(await xlsxBuffer([
      ['Metric', 'Dev', 'UAT'],
      ['Lambda invocations/yr', '24000000', '36000000'],
      ['S3 storage (GB)', '500', '600'],
      ['Cognito billable MAU', '1000', '2000'],
    ]), 'units.xlsx');

    // Located by service rather than by index: the two rows beside it exist only to clear
    // the reader's three-row floor, and must not be what decides this assertion. `find`
    // takes the first band, Dev, which is the one the arithmetic below is written against.
    expect(resources.find((row) => row.service === 'AWS Lambda'))
      .toMatchObject({ service: 'AWS Lambda', usage_amount: 2_000_000 });
    expect(insights.conversions?.join(' ')).toMatch(/divided by 12/);
  });

  test('a millions-of-requests row is expanded before it is divided', async () => {
    const { resources } = await analyseWorkbook(await xlsxBuffer([
      ['Metric', 'Dev', 'UAT'],
      ['API Gateway requests (millions/yr)', '120', '240'],
      ['S3 storage (GB)', '500', '600'],
      ['Cognito billable MAU', '1000', '2000'],
    ]), 'units.xlsx');

    // 120 million a year is 10 million a month, not 10. Read off the first band, Dev.
    expect(resources.find((row) => row.service === 'Amazon API Gateway')?.usage_amount).toBe(10_000_000);
  });

  test('a non-AWS vendor is excluded by name, never silently dropped', async () => {
    // Pinecone is five rows of the real sheet. Dropping them quietly leaves a reviewer
    // unable to tell whether the vector database was costed elsewhere or forgotten.
    const { resources, insights } = await analyseWorkbook(await xlsxBuffer([
      ['Metric', 'Dev', 'UAT'],
      ['Aurora instance class', 'db.t4g.medium', 'db.t4g.medium'],
      ['Aurora instance count', '1', '1'],
      ['Pinecone: vectors', '1000000', '2000000'],
      ['Pinecone: storage (GB)', '20', '40'],
    ]), 'vendors.xlsx');

    expect(resources.some((row) => /pinecone/i.test(row.raw ?? ''))).toBe(false);
    const excluded = (insights.exclusions ?? []).filter((entry) => /pinecone/i.test(entry.metric));
    expect(excluded).toHaveLength(1);
    expect(excluded[0].reason).toMatch(/not an AWS service/);
  });

  test('a count the author set to zero is excluded for that scenario only', async () => {
    // "MSK broker count (Optional -- excluded from baseline)" is 0 in the real sheet while
    // the class and storage rows beside it still say what that cluster WOULD be. Pricing
    // them anyway put a Kafka cluster the author had ruled out into every scenario.
    const { resources, insights } = await analyseWorkbook(await xlsxBuffer([
      ['Metric', 'Dev', 'UAT'],
      ['MSK broker class', 'kafka.m5.large', 'kafka.m5.large'],
      ['MSK broker count', '0', '3'],
      ['MSK storage per broker (GB)', '100', '100'],
    ]), 'zero.xlsx');

    expect(resources.map((row) => row.scenario)).toEqual(['uat']);
    expect((insights.exclusions ?? []).some((entry) => entry.scenario === 'dev' && /count is 0/.test(entry.reason)))
      .toBe(true);
  });

  test('the machine count describes one scenario, not all of them added up', async () => {
    // Eight columns of the same estate are eight ways to describe it. Summing them
    // reports an eightfold landscape, which is the kind of figure that reaches a client.
    const { insights } = await analyseWorkbook(await xlsxBuffer([
      YEARS,
      ['ElastiCache node class', 'cache.t4g.micro', 'cache.t4g.micro', 'cache.t4g.micro'],
      ['ElastiCache node count', '2', '2', '2'],
      ['ElastiCache storage (GB)', '10', '10', '10'],
    ]), 'counts.xlsx');

    expect(insights.server_count).toBe(2);
    expect(insights.bands).toHaveLength(3);
  });

  test('a cost summary with money headings is still read as costs, not capacity', async () => {
    // The trap the transposed reader has to avoid: a label column beside numeric columns
    // has the same silhouette as a capacity matrix. Claiming it would turn a summary of
    // money into a fleet of resources.
    const { resources } = await analyseWorkbook(await xlsxBuffer([
      ['Item', 'Monthly Cost', 'Annual Cost'],
      ['Compute', '1200', '14400'],
      ['Storage', '300', '3600'],
    ]), 'costs.xlsx');

    expect(resources.filter((row) => row.service)).toHaveLength(0);
  });
});
