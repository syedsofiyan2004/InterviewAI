import ExcelJS from 'exceljs';
import {
  categoryForService,
  configSummaryFragments,
  generateCalculatorExportWorkbook,
  regionDisplayName,
  type CalculatorExportInput,
} from '../lambdas/shared/calculator-export-workbook';

/**
 * The calculator.aws-style export workbook.
 *
 * What is being protected is the layout contract, not cosmetics: this file exists so a
 * client can hold it next to the export they downloaded from their own calculator.aws
 * estimate link and find the same sections on the same rows, the same nine columns under
 * the same headings. Every assertion below is against the anchor cell or the exact
 * string, so a section that drifts down a row or a header that gains a word fails here
 * rather than in front of the client.
 *
 * Money is asserted two ways on purpose: the cell must be a NUMBER (the real export's
 * comma-padded `60.00` cells are text in CSV but numbers in xlsx, and a text cell cannot
 * be summed or diffed against the client's own export) and it must carry the 2dp format
 * so `5` reads as `5.00`.
 */

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Representative of the three shapes a priced line takes: an EC2 compute line, an RDS
 * line priced on a committed term (upfront component plus reduced monthly), and a plain
 * S3 storage line. The RDS line exercises the reserved path the input interface supports
 * even where today's stored results carry no upfront figure.
 */
const INPUT: CalculatorExportInput = {
  estimateName: 'Core BOM FINAL - On-Demand - Mumbai',
  currency: 'USD',
  region: 'ap-south-1',
  lines: [
    {
      environment: 'Sandbox',
      category: 'Compute',
      description: 'k8s-master - 1 x m6i.large - 120 GB gp3',
      // Trailing space on purpose: the real export carries `Amazon EC2 ` and the emitter
      // must trim it, so the guard is asserted rather than assumed.
      service: 'Amazon EC2 ',
      upfront: 0,
      monthly: 84.67,
      configSummary: ['Tenancy (Shared Instances)', 'Operating system (Linux)', 'EBS Storage amount (120 GB)'],
    },
    {
      environment: 'Production',
      category: 'Database',
      description: 'foundation-rds - MySQL 8 - Multi-AZ',
      service: 'Amazon RDS for MySQL',
      upfront: 320,
      monthly: 729.68,
      configSummary: ['Nodes (2)', 'Deployment option (Multi-AZ)'],
    },
    {
      environment: 'Production',
      category: 'Storage',
      description: 'application-bucket - 200 GB',
      service: 'S3 Standard',
      upfront: 0,
      monthly: 5,
      configSummary: ['S3 Standard storage (200 GB per month)'],
    },
  ],
};

function rowValues(row: ExcelJS.Row): unknown[] {
  return [1, 2, 3, 4, 5, 6, 7, 8, 9].map((index) => row.getCell(index).value);
}

describe('the calculator.aws-style export workbook', () => {
  test('stacks the three sections at the anchor cells of a real export', async () => {
    const sheet = await readSheet();

    expect(sheet.getCell('A1').value).toBe('Estimate summary');
    expect(sheet.getCell('A6').value).toBe('Detailed Estimate');
    expect(sheet.getCell('A13').value).toBe('Acknowledgement');
    // The blank rows between sections are part of the layout, not padding to be tuned:
    // one after the summary note, two after the last detailed line.
    expect(sheet.getCell('A5').value).toBeNull();
    expect(sheet.getCell('A11').value).toBeNull();
    expect(sheet.getCell('A12').value).toBeNull();
  });

  test('writes the summary header and value row exactly as the export does', async () => {
    const sheet = await readSheet();

    expect(rowValues(sheet.getRow(2))).toEqual([
      'Upfront cost', 'Monthly cost', 'Total 12 months cost', 'Currency',
      null, null, null, null, null,
    ]);

    const values = sheet.getRow(3);
    expect(values.getCell(1).value).toBe(320);
    expect(values.getCell(2).value).toBe(round2(84.67 + 729.68 + 5));
    expect(values.getCell(3).value).toBe(round2(819.35 * 12 + 320));
    expect(values.getCell(4).value).toBe('USD');
    [1, 2, 3].forEach((index) => {
      expect(typeof values.getCell(index).value).toBe('number');
      expect(values.getCell(index).numFmt).toBe('#,##0.00');
    });
  });

  test('puts the includes-upfront note in the summary note row, in the export’s column', async () => {
    const sheet = await readSheet();
    expect(sheet.getCell('C4').value).toBe('* Includes upfront cost');
    expect(sheet.getCell('A4').value).toBeNull();
    expect(sheet.getCell('B4').value).toBeNull();
  });

  test('writes the nine detailed-estimate headers verbatim', async () => {
    const sheet = await readSheet();
    expect(rowValues(sheet.getRow(7))).toEqual([
      'Group hierarchy', 'Region', 'Description', 'Service', 'Upfront', 'Monthly',
      'First 12 months total', 'Currency', 'Configuration summary',
    ]);
  });

  test('composes the group hierarchy from estimate, environment and category', async () => {
    const sheet = await readSheet();
    expect(sheet.getCell('A8').value).toBe('Core BOM FINAL - On-Demand - Mumbai > Sandbox > Compute');
    expect(sheet.getCell('A9').value).toBe('Core BOM FINAL - On-Demand - Mumbai > Production > Database');
    expect(sheet.getCell('A10').value).toBe('Core BOM FINAL - On-Demand - Mumbai > Production > Storage');
  });

  test('renders the region as its AWS display name and trims the service cell', async () => {
    const sheet = await readSheet();
    expect(sheet.getCell('B8').value).toBe('Asia Pacific (Mumbai)');
    expect(sheet.getCell('B9').value).toBe('Asia Pacific (Mumbai)');
    expect(sheet.getCell('D8').value).toBe('Amazon EC2');
    expect(sheet.getCell('D9').value).toBe('Amazon RDS for MySQL');
  });

  test('emits money as numeric cells at two decimals, with the first year carrying the upfront', async () => {
    const sheet = await readSheet();

    const expected = [
      { upfront: 0, monthly: 84.67 },
      { upfront: 320, monthly: 729.68 },
      { upfront: 0, monthly: 5 },
    ];
    expected.forEach((line, index) => {
      const row = sheet.getRow(8 + index);
      [5, 6, 7].forEach((column) => {
        expect(typeof row.getCell(column).value).toBe('number');
        expect(row.getCell(column).numFmt).toBe('#,##0.00');
      });
      expect(row.getCell(5).value).toBe(line.upfront);
      expect(row.getCell(6).value).toBe(line.monthly);
      // The reserved line's twelve months must exceed monthly x 12 by exactly its
      // upfront: that is the whole distinction the Upfront column exists to carry.
      expect(row.getCell(7).value).toBe(round2(line.monthly * 12 + line.upfront));
      expect(row.getCell(8).value).toBe('USD');
    });
  });

  test('joins the configuration summary fragments with a comma and a space', async () => {
    const sheet = await readSheet();
    expect(sheet.getCell('I8').value).toBe(
      'Tenancy (Shared Instances), Operating system (Linux), EBS Storage amount (120 GB)',
    );
    expect(sheet.getCell('I9').value).toBe('Nodes (2), Deployment option (Multi-AZ)');
    expect(sheet.getCell('I10').value).toBe('S3 Standard storage (200 GB per month)');
  });

  test('prints the acknowledgement sentence verbatim as plain text', async () => {
    const sheet = await readSheet();
    expect(sheet.getCell('A14').value).toBe(
      "* AWS Pricing Calculator provides only an estimate of your AWS fees and doesn't include "
      + 'any taxes that might apply. Your actual fees depend on a variety of factors, including '
      + 'your actual usage of AWS services.',
    );
  });
});

/** The single sheet the emitter produces, read back through exceljs. */
async function readSheet(): Promise<ExcelJS.Worksheet> {
  const buffer = await generateCalculatorExportWorkbook(INPUT);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as never);
  expect(workbook.worksheets).toHaveLength(1);
  return workbook.worksheets[0];
}

describe('classifying a service into the export’s category buckets', () => {
  test.each([
    ['Amazon EC2', 'Compute'],
    // The real export's trailing space must not defeat the match.
    ['Amazon EC2 ', 'Compute'],
    ['AWS Fargate', 'Compute'],
    ['AWS Lambda', 'Compute'],
    ['Amazon RDS for MySQL', 'Database'],
    ['Amazon Aurora', 'Database'],
    ['Amazon DynamoDB', 'Database'],
    ['Amazon ElastiCache', 'Cache'],
    ['Amazon MemoryDB', 'Cache'],
    ['Application Load Balancer', 'Network'],
    ['Network Load Balancer', 'Network'],
    ['Amazon VPC', 'Network'],
    ['S3 Standard', 'Storage'],
    ['Amazon EBS', 'Storage'],
    ['Amazon OpenSearch Service', 'Search'],
    ['Amazon MQ', 'Messaging'],
    ['Amazon SQS', 'Messaging'],
    ['Amazon SNS', 'Messaging'],
    ['AWS Web Application Firewall (WAF)', 'Security'],
    ['AWS Shield', 'Security'],
    ['Amazon Kinesis', 'Analytics'],
    // The pipeline's summarised tail line must fall through to Other, not guess a bucket.
    ['Remaining resources', 'Other'],
  ])('%s lands in %s', (service, category) => {
    expect(categoryForService(service)).toBe(category);
  });
});

describe('region display names', () => {
  test('a known code renders as the console’s display name', () => {
    expect(regionDisplayName('ap-south-1')).toBe('Asia Pacific (Mumbai)');
    expect(regionDisplayName('eu-central-1')).toBe('Europe (Frankfurt)');
  });

  test('an unknown code is passed through rather than guessed, and blank stays blank', () => {
    expect(regionDisplayName('ap-south-9')).toBe('ap-south-9');
    expect(regionDisplayName(undefined)).toBe('');
  });
});

describe('the configuration summary a stored line item can supply', () => {
  test('carries only recorded facts: schedule, billing basis and the rate workings', () => {
    expect(configSummaryFragments({
      service: 'Amazon EC2',
      detail: '2 x m6a.xlarge | Linux',
      monthly: 200,
      workings: '$0.1370/Hrs x 730 hrs/month x 2 = $200.00/mo',
      environment: 'Production',
      hoursPerDay: 24,
      timeBilled: true,
    })).toEqual([
      'Hours per day (24)',
      'Billing (only while the environment runs)',
      'Rate workings ($0.1370/Hrs x 730 hrs/month x 2 = $200.00/mo)',
    ]);
  });

  test('a storage line states that it is billed whether or not the environment runs', () => {
    expect(configSummaryFragments({
      service: 'Amazon EBS',
      detail: '400 GB attached to 2 x m6a.xlarge | Linux',
      monthly: 40,
      timeBilled: false,
    })).toEqual(['Billing (whether or not the environment runs)']);
  });

  test('a line with none of the attributes gets an empty fragment list, not invented ones', () => {
    expect(configSummaryFragments({ service: 'Amazon EC2', monthly: 0 })).toEqual([]);
  });
});
