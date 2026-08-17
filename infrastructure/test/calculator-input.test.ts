import ExcelJS from 'exceljs';
import { extractTableFromBuffer } from '../lambdas/shared/utils';
import { normaliseResourceTable } from '../lambdas/api-handler/calculator-routes';

/**
 * Spreadsheet input for the Cost Calculator.
 *
 * The promise made to the user was that the template parses reliably AND that a
 * sheet which is not the template still works. Both halves are load-bearing: a
 * client's own resource list is exactly what someone will upload first, and
 * rejecting it would send them back to retyping into a textarea. So these tests
 * cover the happy path, the messy path, and the cases where a row must survive
 * without being understood.
 */

async function xlsxBuffer(rows: string[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Resources');
  rows.forEach((row) => sheet.addRow(row));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const TEMPLATE_HEADER = ['Environment', 'Service', 'Instance / Size', 'Qty', 'Region', 'Hours/Day', 'Notes'];

describe('Reading a spreadsheet', () => {
  test('an xlsx round-trips to rows of cell text', async () => {
    const buffer = await xlsxBuffer([
      TEMPLATE_HEADER,
      ['Production', 'EC2', 't3.large', '2', 'ap-south-1', '24', 'web tier'],
    ]);

    const table = await extractTableFromBuffer(buffer, 'resources.xlsx');

    expect(table[0]).toEqual(TEMPLATE_HEADER);
    expect(table[1]).toEqual(['Production', 'EC2', 't3.large', '2', 'ap-south-1', '24', 'web tier']);
  });

  test('a csv comma inside quotes stays in one cell', () => {
    // The Notes column is free text, and "off at weekends, on-call only" is exactly
    // what someone types. A naive split would shift every column after it.
    const csv = 'Environment,Service,Notes\nDev,EC2,"off at weekends, on-call only"';

    return extractTableFromBuffer(Buffer.from(csv), 'list.csv').then((table) => {
      expect(table[1]).toEqual(['Dev', 'EC2', 'off at weekends, on-call only']);
    });
  });

  test('a doubled quote inside a quoted cell is one literal quote', async () => {
    const csv = 'Service,Notes\nEC2,"the ""web"" tier"';

    const table = await extractTableFromBuffer(Buffer.from(csv), 'list.csv');

    expect(table[1][1]).toBe('the "web" tier');
  });

  test('the BOM Excel writes does not contaminate the first header', async () => {
    // Without stripping it the first header becomes "﻿Environment" and every
    // header match against it fails — the sheet silently degrades to free text.
    const table = await extractTableFromBuffer(Buffer.from('﻿Environment,Service\nDev,EC2'), 'list.csv');

    expect(table[0][0]).toBe('Environment');
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

    const table = await extractTableFromBuffer(buffer, 'padded.xlsx');

    expect(table).toHaveLength(2);
    expect(table[0]).toHaveLength(2);
  });

  test('the first sheet with content wins over an empty instructions tab', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Instructions');
    const data = workbook.addWorksheet('Resources');
    data.addRow(['Service', 'Qty']);
    data.addRow(['EC2', '3']);

    const table = await extractTableFromBuffer(Buffer.from(await workbook.xlsx.writeBuffer()), 'two-tabs.xlsx');

    expect(table[1]).toEqual(['EC2', '3']);
  });

  test('legacy .xls is named precisely rather than failing as a corrupt xlsx', async () => {
    await expect(extractTableFromBuffer(Buffer.from('not really a workbook'), 'old.xls'))
      .rejects.toThrow('LEGACY_XLS_UNSUPPORTED');
  });

  test('an unreadable xlsx reports a parse failure, not a crash', async () => {
    await expect(extractTableFromBuffer(Buffer.from('definitely not a zip'), 'broken.xlsx'))
      .rejects.toThrow('XLSX_PARSE_FAILED');
  });
});

describe('Mapping a sheet onto resources', () => {
  test('the template columns map straight through', () => {
    const { resources, warnings } = normaliseResourceTable([
      TEMPLATE_HEADER,
      ['Production', 'EC2', 't3.large', '2', 'ap-south-1', '24', 'web tier'],
      ['Dev', 'EC2', 't3.small', '2', 'ap-south-1', '8', 'off at weekends'],
    ]);

    expect(warnings).toEqual([]);
    expect(resources).toHaveLength(2);
    expect(resources[0]).toEqual(expect.objectContaining({
      environment: 'Production', service: 'EC2', size: 't3.large', quantity: '2',
      region: 'ap-south-1', hoursPerDay: 24, notes: 'web tier',
    }));
    expect(resources[1].hoursPerDay).toBe(8);
  });

  test('headers match despite capitalisation, spacing and synonyms', () => {
    const { resources } = normaliseResourceTable([
      ['  ENV ', 'aws service', 'Instance Type', 'Count', 'AWS Region', 'Hours Per Day', 'Remarks'],
      ['Staging', 'RDS', 'db.t3.medium', '1', 'ap-south-1', '12', 'Multi-AZ'],
    ]);

    expect(resources[0]).toEqual(expect.objectContaining({
      environment: 'Staging', service: 'RDS', size: 'db.t3.medium',
      quantity: '1', region: 'ap-south-1', hoursPerDay: 12, notes: 'Multi-AZ',
    }));
  });

  test('a blank Hours/Day is left undefined so the environment default applies', () => {
    const { resources } = normaliseResourceTable([
      TEMPLATE_HEADER,
      ['Production', 'S3', '200 GB Standard', '', 'ap-south-1', '', 'usage-based'],
    ]);

    expect(resources[0].hoursPerDay).toBeUndefined();
  });

  test('an unreadable Hours/Day falls back and says so instead of pricing at 24', () => {
    const { resources, warnings } = normaliseResourceTable([
      TEMPLATE_HEADER,
      ['Dev', 'EC2', 't3.small', '1', 'ap-south-1', 'business hours', ''],
    ]);

    expect(resources[0].hoursPerDay).toBeUndefined();
    expect(warnings.join(' ')).toContain('business hours');
  });

  test('hours outside 1-24 are rejected rather than clamped silently', () => {
    const { resources } = normaliseResourceTable([
      TEMPLATE_HEADER,
      ['Dev', 'EC2', 't3.small', '1', 'ap-south-1', '48', ''],
    ]);

    // 48 is not a day; treating it as 24 would hide a mistake in the sheet.
    expect(resources[0].hoursPerDay).toBeUndefined();
  });

  test('a sheet with no recognisable headers is kept as free text, not rejected', () => {
    // The whole point of tolerating freeform: a client's own list still produces an
    // estimate, just with less structure.
    const { resources, warnings } = normaliseResourceTable([
      ['Our AWS kit', '', ''],
      ['two web servers, medium sized', 'mumbai', ''],
      ['one postgres database', 'mumbai', ''],
    ]);

    expect(resources).toHaveLength(3);
    expect(resources.every((row) => row.raw.length > 0)).toBe(true);
    expect(resources[1].raw).toContain('two web servers');
    expect(warnings.join(' ')).toContain('free text');
  });

  test('every row keeps its raw text even when fully mapped', () => {
    // buildPrompt falls back to raw for anything the columns missed, so losing it
    // would lose information the user typed.
    const { resources } = normaliseResourceTable([
      TEMPLATE_HEADER,
      ['Production', 'EC2', 't3.large', '2', 'ap-south-1', '24', 'web tier'],
    ]);

    expect(resources[0].raw).toContain('t3.large');
    expect(resources[0].raw).toContain('web tier');
  });

  test('a row with no service is skipped and reported, not priced', () => {
    const { resources, warnings } = normaliseResourceTable([
      TEMPLATE_HEADER,
      ['', '', '', '', '', '', 'everything below is next phase'],
      ['Production', 'EC2', 't3.large', '1', 'ap-south-1', '24', ''],
    ]);

    expect(resources).toHaveLength(1);
    expect(warnings.join(' ')).toContain('no service');
  });

  test('an empty sheet is reported rather than returning silently', () => {
    expect(normaliseResourceTable([]).warnings.join(' ')).toContain('no rows');
  });

  test('headers with no rows beneath them are reported', () => {
    const { resources, warnings } = normaliseResourceTable([TEMPLATE_HEADER]);

    expect(resources).toEqual([]);
    expect(warnings.join(' ')).toContain('no resource rows');
  });

  test('warnings are capped so one bad sheet cannot bloat the record', () => {
    const rows = [TEMPLATE_HEADER];
    for (let i = 0; i < 40; i++) rows.push(['Dev', '', '', '', '', '', `comment ${i}`]);

    expect(normaliseResourceTable(rows).warnings.length).toBeLessThanOrEqual(12);
  });
});
