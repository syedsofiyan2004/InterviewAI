/**
 * The calculator.aws-style export workbook.
 *
 * Exists because the deliverable a client compares ours against is the spreadsheet the
 * AWS Pricing Calculator itself exports from an estimate link -- one sheet, three stacked
 * sections, a nine-column detailed estimate. Handing them our multi-sheet TCO workbook in
 * that slot meant every conversation started with "why does this not look like the one I
 * downloaded?" before a single number was discussed. This module renders our priced
 * calculation in that exact layout, so the two files can be read side by side -- or
 * diffed -- without a translation step.
 *
 * The layout is transcribed from a real export (docs/Core BOM FINAL - On-Demand -
 * Mumbai.csv): `Estimate summary` in A1, the `Detailed Estimate` banner after one blank
 * row, `Acknowledgement` after two. Two quirks of the real export are deliberately NOT
 * copied: the trailing space on `Amazon EC2 ` (string comparisons against a service name
 * should not have to know about it) and its comma-padded `60.00` text cells (numeric
 * cells with a 2dp format carry the same display and stay summable).
 *
 * What the real export's Configuration summary column contains -- Tenancy, OS, EBS
 * amount, data transfer per line -- is calculator.aws's own per-service configuration
 * metadata. Our stored CalculationResult does not carry it: line items hold service,
 * detail, monthly, workings and a schedule. So the caller supplies the fragments it can
 * build honestly and this module only joins them; nothing here invents a configuration
 * attribute the estimate never recorded.
 */

import type { CalculationResult } from '../../schema/calculator';

/** One row of the Detailed Estimate section: a single priced line. */
export interface CalculatorExportLine {
  /** Environment band of the group hierarchy, e.g. `Sandbox`. */
  environment: string;
  /** Service bucket, e.g. `Compute`, `Database`. See categoryForService. */
  category: string;
  /** Free text naming the resource, as the estimate's own detail string describes it. */
  description: string;
  /** AWS display name for the service. Emitted trimmed. */
  service: string;
  /** Committed-term lump sum, or 0 where the stored estimate has no upfront figure. */
  upfront: number;
  monthly: number;
  /** `Label (value)` fragments, joined with `, ` into the one Configuration summary cell. */
  configSummary: string[];
}

/** Everything the emitter needs; nothing about DynamoDB or the route leaks in here. */
export interface CalculatorExportInput {
  estimateName: string;
  currency: string;
  /** Region code such as `ap-south-1`; rendered as its AWS display name. */
  region?: string;
  lines: CalculatorExportLine[];
}

const MONEY = '#,##0.00';

const SUMMARY_HEADERS = ['Upfront cost', 'Monthly cost', 'Total 12 months cost', 'Currency'];

const DETAIL_HEADERS = [
  'Group hierarchy', 'Region', 'Description', 'Service', 'Upfront', 'Monthly',
  'First 12 months total', 'Currency', 'Configuration summary',
];

/** Verbatim from the real export's acknowledgement section. */
const ACKNOWLEDGEMENT =
  "* AWS Pricing Calculator provides only an estimate of your AWS fees and doesn't include "
  + 'any taxes that might apply. Your actual fees depend on a variety of factors, including '
  + 'your actual usage of AWS services.';

/** Verbatim from the real export, where it sits under the summary's money columns. */
const SUMMARY_NOTE = '* Includes upfront cost';

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Region code to the display name the AWS console and exports use.
 *
 * A code that is not in the table is emitted as the code itself rather than looked up or
 * guessed: a Region cell reading `ap-south-1` is a fact, while a wrong display name would
 * quietly misstate where the estimate is priced.
 */
const REGION_DISPLAY_NAMES: Record<string, string> = {
  'af-south-1': 'Africa (Cape Town)',
  'ap-east-1': 'Asia Pacific (Hong Kong)',
  'ap-northeast-1': 'Asia Pacific (Tokyo)',
  'ap-northeast-2': 'Asia Pacific (Seoul)',
  'ap-northeast-3': 'Asia Pacific (Osaka)',
  'ap-south-1': 'Asia Pacific (Mumbai)',
  'ap-south-2': 'Asia Pacific (Hyderabad)',
  'ap-southeast-1': 'Asia Pacific (Singapore)',
  'ap-southeast-2': 'Asia Pacific (Sydney)',
  'ap-southeast-3': 'Asia Pacific (Jakarta)',
  'ap-southeast-4': 'Asia Pacific (Melbourne)',
  'ca-central-1': 'Canada (Central)',
  'ca-west-1': 'Canada West (Calgary)',
  'eu-central-1': 'Europe (Frankfurt)',
  'eu-central-2': 'Europe (Zurich)',
  'eu-north-1': 'Europe (Stockholm)',
  'eu-south-1': 'Europe (Milan)',
  'eu-south-2': 'Europe (Spain)',
  'eu-west-1': 'Europe (Ireland)',
  'eu-west-2': 'Europe (London)',
  'eu-west-3': 'Europe (Paris)',
  'il-central-1': 'Israel (Tel Aviv)',
  'me-central-1': 'Middle East (UAE)',
  'me-south-1': 'Middle East (Bahrain)',
  'sa-east-1': 'South America (São Paulo)',
  'us-east-1': 'US East (N. Virginia)',
  'us-east-2': 'US East (Ohio)',
  'us-west-1': 'US West (N. California)',
  'us-west-2': 'US West (Oregon)',
};

export function regionDisplayName(region: string | undefined): string {
  const code = (region || '').trim();
  return REGION_DISPLAY_NAMES[code] ?? code;
}

/**
 * The service buckets the real export groups its rows into.
 *
 * Ordered: the first pattern that matches a service name wins, so a name that could read
 * two ways (an "Elastic Load Balancing" is networking even though the word elastic also
 * prefixes storage-family names) is classified by its most specific trait first.
 */
const SERVICE_CATEGORIES: ReadonlyArray<{ match: RegExp; category: string }> = [
  { match: /elasticache|memorydb/i, category: 'Cache' },
  { match: /opensearch|elastic ?search/i, category: 'Search' },
  { match: /\brds\b|aurora|dynamo|documentdb|neptune|timestream/i, category: 'Database' },
  { match: /load balanc|\bvpc\b|transit gateway|route ?53|cloudfront|api gateway|nat gateway|direct connect|\bvpn\b/i, category: 'Network' },
  { match: /\bs3\b|\bebs\b|\befs\b|fsx|glacier|\bbackup\b/i, category: 'Storage' },
  { match: /\bmq\b|\bsqs\b|\bsns\b|\bmsk\b|eventbridge|kafka/i, category: 'Messaging' },
  { match: /\bwaf\b|shield|guardduty|secrets manager|\bkms\b|certificate/i, category: 'Security' },
  { match: /athena|glue|\bemr\b|kinesis|firehose|quicksight|redshift/i, category: 'Analytics' },
  { match: /\bec2\b|elastic compute|fargate|lambda|\becs\b|\beks\b|lightsail|\bbatch\b/i, category: 'Compute' },
];

/**
 * Which Detailed Estimate bucket a service name belongs in -- the third level of the
 * export's group hierarchy. `Other` for anything the table does not know, including the
 * pipeline's own `Remaining resources` summary line, because a wrong bucket reorders the
 * export against the client's copy while an unfamiliar one merely reads as unfamiliar.
 */
export function categoryForService(service: string): string {
  const name = (service || '').trim().toLowerCase();
  for (const rule of SERVICE_CATEGORIES) {
    if (rule.match.test(name)) return rule.category;
  }
  return 'Other';
}

/**
 * The Configuration summary fragments a stored line item can supply honestly.
 *
 * The real export's fragments are calculator.aws's own configuration metadata; ours come
 * from what the estimator recorded. That is a smaller set -- schedule, billing basis and
 * the rate arithmetic -- and every fragment in it is a stored fact. Nothing is padded to
 * look like the real export: a fragment invented to fill the column would put a
 * configuration claim in a client document that no priced line ever supported.
 */
export function configSummaryFragments(
  item: CalculationResult['lineItems'][number],
): string[] {
  const fragments: string[] = [];
  if (typeof item.hoursPerDay === 'number') {
    fragments.push(`Hours per day (${item.hoursPerDay})`);
  }
  if (item.timeBilled === true) {
    fragments.push('Billing (only while the environment runs)');
  } else if (item.timeBilled === false) {
    fragments.push('Billing (whether or not the environment runs)');
  }
  if (item.workings) {
    fragments.push(`Rate workings (${item.workings})`);
  }
  return fragments;
}

function bannerRow(sheet: import('exceljs').Worksheet, text: string): void {
  const row = sheet.addRow([text]);
  row.font = { bold: true, size: 12 };
}

function headerRow(sheet: import('exceljs').Worksheet, headers: string[]): void {
  const row = sheet.addRow(headers);
  row.font = { bold: true };
}

/**
 * Builds the calculator.aws-style export workbook.
 *
 * Layout is positional on purpose: the sections sit at fixed anchors (A1, the banner
 * after one blank row, the acknowledgement after two) so a reader holding the real
 * export and ours side by side finds each section on the rows they expect.
 */
export async function generateCalculatorExportWorkbook(
  input: CalculatorExportInput,
): Promise<Buffer> {
  // Lazy, matching tco-workbook.ts: the api-handler bundle only pays for exceljs on a
  // request that actually asks for a sheet.
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Minfy AI Cost Calculator';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Estimate');
  sheet.columns = [
    { width: 64 }, { width: 24 }, { width: 56 }, { width: 36 }, { width: 12 },
    { width: 14 }, { width: 20 }, { width: 10 }, { width: 100 },
  ];

  const currency = input.currency || 'USD';
  const region = regionDisplayName(input.region);

  // --- Estimate summary ---
  const upfrontTotal = round2(input.lines.reduce((sum, line) => sum + (line.upfront || 0), 0));
  const monthlyTotal = round2(input.lines.reduce((sum, line) => sum + (line.monthly || 0), 0));
  const total12 = round2(monthlyTotal * 12 + upfrontTotal);

  bannerRow(sheet, 'Estimate summary');
  headerRow(sheet, SUMMARY_HEADERS);
  const summaryValues = sheet.addRow([upfrontTotal, monthlyTotal, total12, currency]);
  [1, 2, 3].forEach((index) => { summaryValues.getCell(index).numFmt = MONEY; });
  // The real export puts this note in its third column; the CSV shows it there verbatim.
  sheet.addRow([undefined, undefined, SUMMARY_NOTE]);
  sheet.addRow([]);

  // --- Detailed Estimate ---
  bannerRow(sheet, 'Detailed Estimate');
  headerRow(sheet, DETAIL_HEADERS);

  for (const line of input.lines) {
    const upfront = round2(line.upfront || 0);
    const monthly = round2(line.monthly || 0);
    const row = sheet.addRow([
      [input.estimateName, line.environment, line.category].filter(Boolean).join(' > '),
      region,
      line.description,
      // Trimmed: the real export carries a trailing space on `Amazon EC2 `, and copying
      // the quirk would make every string comparison against this cell fail.
      (line.service || '').trim(),
      upfront,
      monthly,
      round2(monthly * 12 + upfront),
      currency,
      line.configSummary.join(', '),
    ]);
    [5, 6, 7].forEach((index) => { row.getCell(index).numFmt = MONEY; });
  }

  sheet.addRow([]);
  sheet.addRow([]);

  // --- Acknowledgement ---
  bannerRow(sheet, 'Acknowledgement');
  sheet.addRow([ACKNOWLEDGEMENT]);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}
