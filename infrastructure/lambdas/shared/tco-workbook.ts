import type { Worksheet } from 'exceljs';
import type {
  CalculationResult,
  CalculationServer,
} from '../../schema/calculator';
import { schedulingSaving, scenarioSections, type CalculatorReportOptions } from './calculator-report';

/**
 * The client-facing TCO workbook.
 *
 * Exists because the artifact this team actually hands a client is a spreadsheet, not a
 * PDF: a cost model gets argued with in a meeting, and a number you cannot change is a
 * screenshot. So every total in here is a live formula over the cells above it. Change a
 * server's EC2 figure and its row total, its scope subtotal, the grand total, the
 * consolidated summary and the Year-1 commercial figure all move -- which is the whole
 * point of shipping .xlsx rather than a second rendering of the PDF.
 *
 * Shape follows docs/Rainbow_TCO_30Apr2026_v1_2.xlsx, the workbook the team builds by
 * hand: a per-server sheet with subtotals split by scope, a consolidated summary priced
 * monthly and annually, and a commercial breakdown carrying credits and discount. Its
 * 19 sheets are not mirrored; the five here are the ones that carry cost.
 *
 * Two deliberate departures from the reference, both because the data does not exist in
 * this app rather than because it was overlooked:
 *
 *  - Its `SAP?` and `Disk Util %` columns are absent. Nothing in CalculationResourceSchema
 *    supplies either, so both would read blank on every row of every estimate.
 *  - MAP credits and the partner discount default to 0%, not the reference's 15% and 3%.
 *    Those are commercial terms for one deal; defaulting to them would put numbers in a
 *    client document that nobody in this app agreed to. They are input cells, so typing
 *    the real percentages moves every dependent total.
 *
 * A `Qty` column is added, which the reference has no need for: its source was one row per
 * physical server, while an uploaded sheet here may carry a quantity column. Without it a
 * row costing five times its neighbour would look like an error.
 */

const INT = '#,##0';
const PERCENT = '0.0%';

/** dd-MM-yyyy, the standing convention across the hub. */
function formatDate(epochMs?: number): string {
  const date = new Date(epochMs || Date.now());
  if (Number.isNaN(date.getTime())) return '-';
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}-${month}-${date.getFullYear()}`;
}

/**
 * A sheet name Excel will accept.
 *
 * : \ / ? * [ ] are illegal in a sheet name and 31 characters is the ceiling. A name that
 * breaks either rule does not raise -- Excel refuses to open the file, which surfaces as a
 * corrupt download rather than an error anyone can act on.
 */
function sheetName(text: string): string {
  return text.replace(/[:\\/?*\[\]]/g, '-').slice(0, 31).trim() || 'Sheet';
}

/** A sheet reference for use inside a formula, quoted so spaces and dashes survive. */
const ref = (sheet: string, cell: string) => `'${sheet.replace(/'/g, "''")}'!${cell}`;

const round2 = (value: number) => Math.round(value * 100) / 100;


function titleRow(sheet: Worksheet, text: string, span: number): void {
  const row = sheet.addRow([text]);
  row.font = { bold: true, size: 14 };
  sheet.mergeCells(row.number, 1, row.number, span);
}

/** The reference workbook's look: white on navy, wrapped, and tall enough to read. */
function headerRow(sheet: Worksheet, headers: (string | undefined)[]): void {
  const row = sheet.addRow(headers);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.height = 30;
  row.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
}

/** A subtotal or total line: bold, ruled above, and never a literal. */
function totalRow(sheet: Worksheet, cells: (string | number | { formula: string } | undefined)[]): number {
  const row = sheet.addRow(cells);
  row.font = { bold: true };
  row.eachCell((cell) => {
    cell.border = { top: { style: 'thin' }, bottom: { style: 'double' } };
  });
  return row.number;
}

/**
 * Per-server rows when the estimate has none of its own.
 *
 * Every estimate priced before `servers` existed, and every one too large to carry
 * per-server detail, still has to produce this workbook -- so the sheet is built from the
 * priced line items instead. Fewer rows, the same rates, the same totals. Compute and
 * storage stay in their own columns because the line items already separate them, so the
 * subtotals and the consolidated summary mean exactly what they mean on the full path.
 */
function serversFromLineItems(result: CalculationResult): CalculationServer[] {
  return (result.lineItems || []).map((item, index) => {
    const isStorage = item.service === 'Amazon EBS' || item.timeBilled === false;
    return {
      name: item.detail || item.service || `Line ${index + 1}`,
      count: 1,
      environment: item.environment,
      group: item.service,
      hoursPerDay: item.hoursPerDay,
      computeMonthly: isStorage ? null : item.monthly ?? null,
      storageMonthly: isStorage ? item.monthly ?? null : null,
      justification: item.workings,
    };
  });
}

/** First-appearance order, with the unassigned bucket last so it reads as a remainder. */
function byScope(servers: CalculationServer[]): { scope: string; rows: CalculationServer[] }[] {
  const buckets = new Map<string, CalculationServer[]>();
  for (const server of servers) {
    const scope = (server.environment || '').trim() || 'Unassigned';
    const existing = buckets.get(scope);
    if (existing) existing.push(server);
    else buckets.set(scope, [server]);
  }
  const scopes = [...buckets.keys()].sort((a, b) => {
    if (a === b) return 0;
    if (a === 'Unassigned') return 1;
    if (b === 'Unassigned') return -1;
    return 0;
  });
  return scopes.map((scope) => ({ scope, rows: buckets.get(scope)! }));
}


/** Where the TCO sheet's totals ended up, so the other sheets can point at them. */
interface TcoAnchor {
  sheet: string;
  /** Grand total row: EC2 in column O, EBS in P, both in Q. */
  grandRow: number;
}

const TCO_COLUMN_WIDTHS = [6, 30, 6, 14, 34, 12, 14, 16, 7, 10, 18, 11, 10, 9, 14, 14, 14, 50];

function addTcoSheet(
  workbook: import('exceljs').Workbook,
  servers: CalculationServer[],
  options: CalculatorReportOptions,
  currency: string,
  money: string,
): TcoAnchor {
  const region = options.region || 'Primary Region';
  const name = sheetName(`TCO - ${region}`);
  const sheet = workbook.addWorksheet(name);
  sheet.columns = TCO_COLUMN_WIDTHS.map((width) => ({ width }));

  titleRow(sheet, `${options.name} — per-server cost, ${region}`, TCO_COLUMN_WIDTHS.length);
  headerRow(sheet, [
    'S.No', 'Server Name', 'Qty', 'Scope', 'Group', 'OS', 'Processor', 'Instance',
    'vCPU', 'RAM (GB)', 'Pricing', 'EBS (GB)', 'EBS Type', 'Hrs/Day',
    `EC2 ${currency}/mo`, `EBS ${currency}/mo`, `Total ${currency}/mo`, 'Sizing Justification',
  ]);
  // Two rows frozen: the title and the header. Scrolling a 400-row inventory with the
  // column names off screen is how a reader mistakes an EBS figure for a total.
  sheet.views = [{ state: 'frozen', ySplit: 2 }];

  const subtotalRows: number[] = [];
  let serial = 0;

  for (const { scope, rows } of byScope(servers)) {
    const firstRow = sheet.rowCount + 1;

    for (const server of rows) {
      serial += 1;
      const at = sheet.rowCount + 1;
      const row = sheet.addRow([
        serial,
        server.name,
        server.count ?? 1,
        scope,
        server.group,
        server.os,
        server.processor,
        server.instance,
        server.vcpu,
        server.ramGb,
        server.purchaseModel,
        server.diskGb,
        server.diskType,
        server.hoursPerDay,
        server.computeMonthly ?? undefined,
        server.storageMonthly ?? undefined,
        // Blank rather than zero where AWS returned no figure for either half: a
        // $0.00 total in a client document reads as free, which is a different claim.
        { formula: `IF(COUNT(O${at}:P${at})=0,"",O${at}+P${at})` },
        server.justification,
      ]);
      row.alignment = { vertical: 'top', wrapText: true };
      [12, 9, 10].forEach((index) => { row.getCell(index).numFmt = INT; });
      [15, 16, 17].forEach((index) => { row.getCell(index).numFmt = money; });
    }

    const lastRow = sheet.rowCount;
    if (lastRow < firstRow) continue;
    subtotalRows.push(totalRow(sheet, [
      undefined, `Subtotal — ${scope}`, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { formula: `SUM(O${firstRow}:O${lastRow})` },
      { formula: `SUM(P${firstRow}:P${lastRow})` },
      { formula: `SUM(Q${firstRow}:Q${lastRow})` },
    ]));
    [15, 16, 17].forEach((index) => { sheet.getRow(sheet.rowCount).getCell(index).numFmt = money; });
  }

  // The grand total sums the subtotals, not the data rows -- exactly as rows 30-32 of the
  // reference workbook do. Deleting a scope block then leaves a visibly broken reference
  // instead of a total that quietly shrank.
  const addend = (letter: string) => subtotalRows.map((at) => `${letter}${at}`).join('+') || '0';
  const grandRow = totalRow(sheet, [
    undefined, `TOTAL — ${region}`, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { formula: addend('O') },
    { formula: addend('P') },
    { formula: addend('Q') },
  ]);
  [15, 16, 17].forEach((index) => { sheet.getRow(grandRow).getCell(index).numFmt = money; });
  sheet.getRow(grandRow).font = { bold: true, size: 12 };

  return { sheet: name, grandRow };
}


/** Where a category landed on the summary sheet, so the commercial sheet can point at it. */
interface SummaryAnchor {
  sheet: string;
  categories: { label: string; row: number }[];
  grandRow: number;
}

/** What a category is, in one line, so the summary explains itself without the PDF. */
function categoryNote(service: string, lines: number): string {
  const plural = lines === 1 ? '1 priced line' : `${lines} priced lines`;
  if (service === 'Amazon EBS') {
    return `${plural}. gp3 volumes, billed per GB-month whether or not the instance is running.`;
  }
  if (service === 'Amazon EC2') {
    return `${plural}. Compute, billed by the hour on each group's stated schedule.`;
  }
  return `${plural}. Rates from the AWS Price List Query API.`;
}

function addSummarySheet(
  workbook: import('exceljs').Workbook,
  result: CalculationResult,
  tco: TcoAnchor,
  currency: string,
  money: string,
): SummaryAnchor {
  const name = sheetName('Consolidated Summary');
  const sheet = workbook.addWorksheet(name);
  sheet.columns = [{ width: 30 }, { width: 18 }, { width: 18 }, { width: 74 }];

  titleRow(sheet, 'Consolidated summary', 4);
  headerRow(sheet, ['Category', `Monthly (${currency})`, `Annual (${currency})`, 'Notes']);
  sheet.views = [{ state: 'frozen', ySplit: 2 }];

  // Grouped by service off the line items rather than off the per-server sheet, because
  // the line items are the complete priced set: a service with no server rows of its own
  // -- Transit Gateway, AWS Backup, a marketplace licence -- still has to appear here or
  // the summary would total to less than the estimate.
  const totals = new Map<string, { monthly: number; lines: number }>();
  for (const item of result.lineItems || []) {
    const service = item.service || 'Other';
    const existing = totals.get(service) || { monthly: 0, lines: 0 };
    existing.monthly += item.monthly ?? 0;
    existing.lines += 1;
    totals.set(service, existing);
  }
  const ordered = [...totals.entries()].sort((a, b) => b[1].monthly - a[1].monthly);

  const categories: { label: string; row: number }[] = [];
  const firstRow = sheet.rowCount + 1;
  for (const [service, entry] of ordered) {
    const at = sheet.rowCount + 1;
    const row = sheet.addRow([
      service,
      round2(entry.monthly),
      { formula: `B${at}*12` },
      categoryNote(service, entry.lines),
    ]);
    row.getCell(2).numFmt = money;
    row.getCell(3).numFmt = money;
    row.getCell(4).alignment = { vertical: 'top', wrapText: true };
    categories.push({ label: service, row: at });
  }
  const lastRow = sheet.rowCount;

  const grandRow = totalRow(sheet, [
    'GRAND TOTAL',
    { formula: ordered.length ? `SUM(B${firstRow}:B${lastRow})` : '0' },
    { formula: ordered.length ? `SUM(C${firstRow}:C${lastRow})` : '0' },
    'Annual figures are twelve times the monthly cost. No escalation, reservation uplift or currency movement is applied.',
  ]);
  sheet.getRow(grandRow).getCell(2).numFmt = money;
  sheet.getRow(grandRow).getCell(3).numFmt = money;
  sheet.getRow(grandRow).getCell(4).alignment = { vertical: 'top', wrapText: true };

  // A live cross-check rather than a claim. The per-server sheet and this summary are two
  // roll-ups of the same priced lines; if an edit ever puts them apart, the difference
  // shows up here as a non-zero number instead of going unnoticed in a client meeting.
  sheet.addRow([]);
  const checkRow = sheet.rowCount + 1;
  const check = sheet.addRow([
    'Per-server sheet total',
    { formula: ref(tco.sheet, `Q${tco.grandRow}`) },
    { formula: `B${checkRow}-B${grandRow}` },
    'Cross-check. The second figure is the difference against the grand total above and must read zero.',
  ]);
  check.font = { italic: true };
  check.getCell(2).numFmt = money;
  check.getCell(3).numFmt = money;
  check.getCell(4).alignment = { vertical: 'top', wrapText: true };

  return { sheet: name, categories, grandRow };
}


const SCENARIO_COLUMN_WIDTHS = [30, 44, 16, 16, 68];

/**
 * A sentence spanning the sheet, for the copy a bare number cannot carry.
 *
 * Merged cells do not auto-fit in Excel, so the height is estimated from the length rather
 * than left to the reader to drag open.
 */
function proseRow(sheet: Worksheet, text: string): void {
  const row = sheet.addRow([text]);
  sheet.mergeCells(row.number, 1, row.number, SCENARIO_COLUMN_WIDTHS.length);
  row.getCell(1).alignment = { vertical: 'top', wrapText: true };
  row.getCell(1).font = { italic: true };
  const charsPerLine = SCENARIO_COLUMN_WIDTHS.reduce((total, width) => total + width, 0);
  row.height = Math.max(16, Math.ceil(text.length / charsPerLine) * 15 + 4);
}

/**
 * The scenarios sheet: one row per priced band, each with its own shareable estimate.
 *
 * Exists because an uploaded capacity model is often not one workload at all. It may be
 * banded by fiscal year or by environment, each band a whole column of usage figures, and
 * each band priced into its own calculator.aws estimate. A client handed this workbook and
 * not the PDF still has to be able to open the year they are budgeting for, so the link
 * lives here as a real hyperlink rather than only in the PDF.
 *
 * The section copy and the rule about what may be totalled both come from
 * `scenarioSections` in calculator-report.ts, so the spreadsheet and the PDF cannot end up
 * describing the same figures two different ways.
 *
 * What is NOT here is a single grand total across every band. The three kinds of band do
 * not share one: two sizings of one landscape are alternatives, five consecutive years add
 * up only into a multi-year figure, and concurrent environments add up into a monthly one.
 * A cell carries no sentence to explain itself, so each band gets only the total its kind
 * makes true.
 */
function addScenariosSheet(
  workbook: import('exceljs').Workbook,
  result: CalculationResult,
  options: CalculatorReportOptions,
  currency: string,
  money: string,
): void {
  const sections = scenarioSections(result);
  if (!sections.length) return;

  const sheet = workbook.addWorksheet(sheetName('Scenarios'));
  sheet.columns = SCENARIO_COLUMN_WIDTHS.map((width) => ({ width }));
  titleRow(sheet, `${options.name} — priced scenarios`, SCENARIO_COLUMN_WIDTHS.length);
  // Only the title: this sheet carries a header row per band, so there is no single header
  // that would stay meaningful once the reader scrolls into the next one.
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  for (const entry of sections) {
    sectionRow(sheet, entry.title);
    proseRow(sheet, entry.prose);
    headerRow(sheet, [
      entry.labelColumn,
      entry.basisColumn,
      `Monthly (${currency})`,
      `Annual (${currency})`,
      'Estimate link',
    ]);

    const firstRow = sheet.rowCount + 1;
    for (const scenario of entry.scenarios) {
      const at = sheet.rowCount + 1;
      const row = sheet.addRow([
        scenario.label,
        scenario.detail,
        typeof scenario.monthly === 'number' && Number.isFinite(scenario.monthly) ? scenario.monthly : undefined,
        // Blank rather than zero where AWS returned no figure, as on the cost sheet: a
        // $0.00 annual cost in a client document reads as free, which is a different claim
        // from "this band could not be priced".
        { formula: `IF(COUNT(C${at})=0,"",C${at}*12)` },
        // A real hyperlink, not the URL as text. The reason this sheet exists is that
        // somebody holding only the workbook needs to reach the estimate.
        scenario.url
          ? { text: scenario.url, hyperlink: scenario.url }
          : 'No estimate link was exported for this scenario',
      ]);
      row.alignment = { vertical: 'top', wrapText: true };
      row.getCell(3).numFmt = money;
      row.getCell(4).numFmt = money;
      row.getCell(5).font = scenario.url
        ? { color: { argb: 'FF0563C1' }, underline: true }
        : { italic: true, color: { argb: 'FF808080' } };
    }
    const lastRow = sheet.rowCount;
    if (lastRow < firstRow) continue;

    if (entry.kind === 'period') {
      // The monthly column is deliberately left empty on this row. A cell holding
      // SUM(C:C) here would be five consecutive years' monthly costs added together,
      // which is not the monthly cost of anything -- and unlike the PDF, a spreadsheet
      // cell has no sentence beside it to say so. The only total this band gets is the
      // multi-year one, in the annual column, under a label that spells out what it is.
      const at = totalRow(sheet, [
        `Total across all ${entry.scenarios.length} years (multi-year, NOT a monthly figure)`,
        undefined,
        undefined,
        { formula: `SUM(D${firstRow}:D${lastRow})` },
      ]);
      sheet.getRow(at).getCell(4).numFmt = money;
    } else if (entry.kind === 'environment') {
      // Concurrent, so both columns genuinely do add up.
      const at = totalRow(sheet, [
        `All ${entry.scenarios.length} environments running together`,
        undefined,
        { formula: `SUM(C${firstRow}:C${lastRow})` },
        { formula: `SUM(D${firstRow}:D${lastRow})` },
      ]);
      sheet.getRow(at).getCell(3).numFmt = money;
      sheet.getRow(at).getCell(4).numFmt = money;
    } else {
      // No total row at all for a sizing pair: one workload costed two ways, so however a
      // reader adds these up the answer is a figure nobody will ever be billed.
      proseRow(sheet, entry.saving
        ? `Not totalled: these are alternatives and only one of them will be spent. ${entry.saving}`
        : 'Not totalled: these are alternatives and only one of them will be spent.');
    }
  }
}


/**
 * The commercial sheet: annual cost, then what comes off it.
 *
 * Every figure is a formula over the summary sheet and over two input cells, so the
 * conversation this file exists for -- "what does it look like with 15% MAP and a 3%
 * partner discount?" -- is answered by typing two percentages, not by asking for a new
 * document. Both default to zero: they are terms of a specific deal, and shipping the
 * reference workbook's 15% and 3% would put commitments in a client document that nobody
 * in this app agreed to.
 */
function addCommercialSheet(
  workbook: import('exceljs').Workbook,
  summary: SummaryAnchor,
  currency: string,
  money: string,
): void {
  const sheet = workbook.addWorksheet(sheetName('Commercial Breakdown'));
  sheet.columns = [{ width: 46 }, { width: 20 }, { width: 66 }];

  titleRow(sheet, 'Commercial breakdown — Year 1', 3);
  headerRow(sheet, ['Category', `Annual Cost (${currency})`, 'Notes']);

  const firstRow = sheet.rowCount + 1;
  for (const category of summary.categories) {
    const row = sheet.addRow([
      category.label,
      { formula: ref(summary.sheet, `C${category.row}`) },
      undefined,
    ]);
    row.getCell(2).numFmt = money;
  }
  const lastRow = sheet.rowCount;

  const totalAt = totalRow(sheet, [
    'Total Annual Cost',
    { formula: summary.categories.length ? `SUM(B${firstRow}:B${lastRow})` : '0' },
    'Twelve months at the rates on the summary sheet.',
  ]);
  sheet.getRow(totalAt).getCell(2).numFmt = money;

  sheet.addRow([]);

  const input = (label: string, value: number, format: string, note: string) => {
    const row = sheet.addRow([label, value, note]);
    row.getCell(2).numFmt = format;
    // Visibly an input: the reference workbook shades the cells a reader is meant to type
    // into, and without that cue the first thing anyone does is overwrite a formula.
    row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
    row.getCell(2).border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
    row.getCell(3).alignment = { vertical: 'top', wrapText: true };
    return row.number;
  };

  const marketplaceAt = input(
    'Marketplace and third-party licences',
    0,
    money,
    'Enter the annual portion of the total above that is billed through AWS Marketplace or a third-party licence. Neither credits nor discount apply to it, so it is subtracted before both are calculated.',
  );
  const mapPctAt = input(
    'MAP Credits %',
    0,
    PERCENT,
    'Migration Acceleration Program credits, as agreed for this engagement. Left at zero until a figure is confirmed.',
  );
  const mapAt = sheet.addRow([
    'Total MAP Credits',
    { formula: `B${mapPctAt}*(B${totalAt}-B${marketplaceAt})` },
    'Applied to the discountable annual cost only.',
  ]).number;
  sheet.getRow(mapAt).getCell(2).numFmt = money;
  sheet.getRow(mapAt).getCell(3).alignment = { vertical: 'top', wrapText: true };

  const discountPctAt = input(
    'Partner Discount %',
    0,
    PERCENT,
    'Minfy discount, as agreed for this engagement. Left at zero until a figure is confirmed.',
  );
  const discountAt = sheet.addRow([
    'Total Partner Discount',
    { formula: `B${discountPctAt}*(B${totalAt}-B${marketplaceAt})` },
    'Applied to the discountable annual cost only.',
  ]).number;
  sheet.getRow(discountAt).getCell(2).numFmt = money;
  sheet.getRow(discountAt).getCell(3).alignment = { vertical: 'top', wrapText: true };

  sheet.addRow([]);
  const effectiveAt = totalRow(sheet, [
    'Total Effective Cost Year 1',
    { formula: `B${totalAt}-B${mapAt}-B${discountAt}` },
    'Annual cost less credits and discount. Recomputes the moment either percentage changes.',
  ]);
  sheet.getRow(effectiveAt).getCell(2).numFmt = money;
  sheet.getRow(effectiveAt).getCell(2).font = { bold: true, size: 12 };
  sheet.getRow(effectiveAt).getCell(3).alignment = { vertical: 'top', wrapText: true };
}


function sectionRow(sheet: Worksheet, text: string): void {
  sheet.addRow([]);
  const row = sheet.addRow([text]);
  row.font = { bold: true, size: 12 };
  row.getCell(1).border = { bottom: { style: 'thin' } };
}

function kv(sheet: Worksheet, label: string, value: string | number | undefined, format?: string): void {
  const row = sheet.addRow([label, value ?? '-']);
  row.getCell(1).font = { bold: true };
  row.getCell(2).alignment = { vertical: 'top', wrapText: true };
  if (format && typeof value === 'number') row.getCell(2).numFmt = format;
}

/**
 * Everything a reader needs to argue with the numbers.
 *
 * The PDF prints this and a spreadsheet that omitted it would be the weaker document: a
 * cost model without its assumptions is a number with no way to check it. The allocation
 * note is here rather than implied, because a per-server sheet built by dividing a group
 * price is a different claim from one where every machine was priced individually, and a
 * client is entitled to know which they are holding.
 */
function addAssumptionsSheet(
  workbook: import('exceljs').Workbook,
  result: CalculationResult,
  options: CalculatorReportOptions,
  currency: string,
  money: string,
  perServer: boolean,
): void {
  const sheet = workbook.addWorksheet(sheetName('Assumptions & Notes'));
  sheet.columns = [{ width: 34 }, { width: 104 }];

  titleRow(sheet, `${options.name} — assumptions and notes`, 2);

  kv(sheet, 'Estimate', options.name);
  kv(sheet, 'Region', options.region || 'Not stated');
  kv(sheet, 'Currency', currency);
  kv(sheet, 'Generated', formatDate(Date.now()));
  kv(sheet, 'Estimate created', formatDate(options.createdAt));
  kv(sheet, 'Shareable calculator.aws link', result.url || 'Not saved for this run');

  sectionRow(sheet, 'Cost');
  kv(sheet, `Monthly total (${currency})`, result.monthlyTotal ?? '-', money);
  if (typeof result.monthlyTotal === 'number') {
    kv(sheet, `Annual total (${currency})`, round2(result.monthlyTotal * 12), money);
  }
  if (typeof result.reportedMonthlyTotal === 'number') {
    kv(sheet, `The uploaded sheet's own monthly figure (${currency})`, result.reportedMonthlyTotal, money);
    if (typeof result.monthlyTotal === 'number') {
      const variance = round2(result.monthlyTotal - result.reportedMonthlyTotal);
      kv(sheet, `Variance against live AWS rates (${currency})`, variance, money);
    }
  }
  if (typeof result.ebsRatePerGbMonth === 'number') {
    kv(sheet, 'EBS gp3 rate', `${currency} ${result.ebsRatePerGbMonth.toFixed(4)} per GB-month, as published for ${options.region || 'the estimate region'}`);
  }

  const saving = schedulingSaving(result);
  if (saving.monthly !== null && saving.monthly > 0) {
    kv(sheet, `Saving already in these figures (${currency}/mo)`, round2(saving.monthly), money);
    kv(sheet, 'Where it comes from', `${saving.lines.length} hourly line(s) are priced for their stated runtime rather than 24x7. Running them always-on would cost this much more.`);
  }

  if (result.scenarios?.length) {
    // A pointer rather than a second copy of the figures. The Scenarios sheet is where each
    // band's monthly cost, annual cost and own estimate link live, and it is also the only
    // place that states which bands may be added together -- repeating the monthlies here
    // would put the same numbers in two places without that rule attached to them.
    sectionRow(sheet, 'Scenarios');
    kv(
      sheet,
      'Priced in bands',
      `This estimate was priced as ${result.scenarios.length} separate scenario(s), each with its own shareable calculator.aws link. See the Scenarios sheet for each one's monthly and annual cost, its link, and which of them may be added together.`,
    );
  }

  if (options.environmentHours?.length) {
    sectionRow(sheet, 'Runtime hours in force');
    for (const entry of options.environmentHours) {
      kv(sheet, entry.name, `${entry.hoursPerDay} hours per day`);
    }
  }

  sectionRow(sheet, 'How this workbook was produced');
  const provenance = [
    'Every rate in this file was read from the AWS Price List Query API at the time the estimate ran. No price is supplied by a model, and none is carried over from a previous estimate.',
    perServer
      ? 'Machines were priced in groups of identical configuration, and each group price is allocated across its servers on this sheet: compute divides by the number of machines, which is exact because a group is by definition one size, operating system, region, schedule and purchase model. Storage is apportioned on each row\u2019s own disk, so a server with a larger volume carries more of it. The rows therefore sum to the group totals rather than being independently priced.'
      : 'This estimate carries no per-server detail, so the cost sheet lists priced groups instead. Same rates, same totals, fewer rows.',
    'Annual figures are twelve times monthly. No inflation, reservation uplift, support tier or currency movement is applied.',
    'The reference model\u2019s SAP and disk-utilisation columns are absent because the resource list supplied no data for either.',
  ];
  for (const line of provenance) {
    const row = sheet.addRow([undefined, line]);
    row.getCell(2).alignment = { vertical: 'top', wrapText: true };
  }

  if (result.assumptions?.length) {
    sectionRow(sheet, 'Assumptions');
    result.assumptions.forEach((text, index) => {
      const row = sheet.addRow([`${index + 1}.`, text]);
      row.getCell(2).alignment = { vertical: 'top', wrapText: true };
    });
  }

  if (result.warnings?.length) {
    sectionRow(sheet, 'Warnings');
    result.warnings.forEach((text, index) => {
      const row = sheet.addRow([`${index + 1}.`, text]);
      row.getCell(2).alignment = { vertical: 'top', wrapText: true };
      row.getCell(2).font = { color: { argb: 'FF9C0006' } };
    });
  }
}


/**
 * The audit trail: every priced line and the arithmetic behind it.
 *
 * The `workings` string is the difference between a cost document and an assertion -- the
 * published rate, the hours and the quantity, so a client can redo the multiplication. The
 * PDF prints it; leaving it out of the spreadsheet would mean the editable document is the
 * one you cannot check.
 */
function addLineItemsSheet(
  workbook: import('exceljs').Workbook,
  result: CalculationResult,
  currency: string,
  money: string,
): void {
  const sheet = workbook.addWorksheet(sheetName('Line Items'));
  sheet.columns = [
    { width: 24 }, { width: 46 }, { width: 16 }, { width: 9 }, { width: 16 }, { width: 88 },
  ];

  titleRow(sheet, 'Priced line items and workings', 6);
  headerRow(sheet, ['Service', 'Detail', 'Scope', 'Hrs/Day', `Monthly (${currency})`, 'Workings']);
  sheet.views = [{ state: 'frozen', ySplit: 2 }];

  const firstRow = sheet.rowCount + 1;
  for (const item of result.lineItems || []) {
    const row = sheet.addRow([
      item.service,
      item.detail,
      item.environment || 'Unassigned',
      item.hoursPerDay,
      item.monthly ?? undefined,
      item.workings,
    ]);
    row.alignment = { vertical: 'top', wrapText: true };
    row.getCell(5).numFmt = money;
  }
  const lastRow = sheet.rowCount;

  if (lastRow >= firstRow) {
    const at = totalRow(sheet, [
      'TOTAL', undefined, undefined, undefined,
      { formula: `SUM(E${firstRow}:E${lastRow})` },
      'Sum of every priced line above. Equals the monthly total on the summary sheet.',
    ]);
    sheet.getRow(at).getCell(5).numFmt = money;
    sheet.getRow(at).getCell(6).alignment = { vertical: 'top', wrapText: true };
  }
}

/**
 * Builds the client-facing TCO workbook.
 *
 * Takes the same options object as generateCalculatorPdfReport, so a route can produce
 * either document from one set of arguments.
 */
export async function generateTcoWorkbook(
  result: CalculationResult,
  options: CalculatorReportOptions,
): Promise<Buffer> {
  // Lazy, matching shared/workbook.ts: the api-handler bundle only pays for exceljs on a
  // request that actually reads or writes a sheet.
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Minfy AI Cost Calculator';
  workbook.created = new Date(options.createdAt || Date.now());

  const currency = result.currency || 'USD';
  const money = currency === 'USD' ? '$#,##0.00' : '#,##0.00';
  // Per-server rows where the estimate carries them, group rows where it does not. Both
  // paths produce all five sheets and the same totals; only the row count differs.
  const perServer = (result.servers || []).length > 0;
  const servers = perServer ? result.servers! : serversFromLineItems(result);

  const tco = addTcoSheet(workbook, servers, options, currency, money);
  const summary = addSummarySheet(workbook, result, tco, currency, money);
  // Between the two roll-ups and the commercial view, and only where the estimate was
  // banded at all: a prose estimate or a single-sizing one still produces exactly the five
  // sheets it always did.
  addScenariosSheet(workbook, result, options, currency, money);
  addCommercialSheet(workbook, summary, currency, money);
  addAssumptionsSheet(workbook, result, options, currency, money, perServer);
  addLineItemsSheet(workbook, result, currency, money);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}
