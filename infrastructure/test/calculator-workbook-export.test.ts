import { analyseWorkbook, isCalculatorExportTable, isCalculatorEstimateSummary, parseConfigPairs } from '../lambdas/api-handler/calculator-workbook';

/**
 * The AWS Pricing Calculator's own export format.
 *
 * docs/Core BOM FINAL - On-Demand - Mumbai.csv is a real export downloaded from a
 * calculator.aws estimate link: one sheet, three bannered sections (Estimate summary,
 * Detailed Estimate, Acknowledgement), and every resource's entire billing shape packed
 * into a single Configuration summary cell of comma-separated `Label (value)` pairs.
 * Before the export reader existed, that table reached the generic classifier, which saw
 * Service and money columns and read the rows with no size and no count -- every one of
 * them then refused downstream as unpriceable, and the Estimate summary was filed under
 * the text of its own upfront cell, "0".
 *
 * The fixtures below are a trimmed synthetic copy of the specimen's structure (the real
 * file is 54 rows; the rows here keep its exact cell shapes, including the trailing space
 * in "Amazon EC2 " and the nested "Workload (Consistent, Number of instances: 1)" pair),
 * so the tests run without the docs directory beside them.
 */

const csv = (lines: string[]) => Buffer.from(lines.join('\n'), 'utf-8');

const EC2_CONFIG = '"Tenancy (Shared Instances), Operating system (Linux), Workload (Consistent, Number of instances: 1), '
  + 'Advance EC2 instance (m6i.large), Pricing strategy (On-Demand Utilization: 100 %Utilized/Month), '
  + 'Enable monitoring (disabled), EBS Storage amount (120 GB), DT Inbound: Internet (0 TB per month)"';

const RDS_CONFIG = '"Nodes (2), Instance type (db.m6g.large), Deployment option (Single-AZ), '
  + 'Utilization (On-Demand only) (100 %Utilized/Month), Pricing strategy (OnDemand), '
  + 'Storage for each RDS instance (General Purpose SSD (gp3)), Storage amount (200 GB)"';

const EXPORT_FIXTURE = csv([
  'Estimate summary',
  'Upfront cost,Monthly cost,Total 12 months cost,Currency',
  '0,1092.51,13110.12,USD',
  ',,* Includes upfront cost',
  '',
  '',
  'Detailed Estimate',
  'Group hierarchy,Region,Description,Service,Upfront,Monthly,First 12 months total,Currency,Configuration summary',
  // EC2, three-level hierarchy: the shape every environment row of the real export has.
  'Core BOM - On-Demand - Mumbai > Sandbox > Compute,Asia Pacific (Mumbai),k8s-master - 1 x m6i.large - 120 GB gp3,Amazon EC2 ,0,84.67,1016.04,USD,' + EC2_CONFIG,
  // RDS with the engine only in the Service display name.
  'Core BOM - On-Demand - Mumbai > Sandbox > Database,Asia Pacific (Mumbai),foundation-rds + gimo-rds - MySQL 8 - Single-AZ,Amazon RDS for MySQL,0,364.84,4378.08,USD,' + RDS_CONFIG,
  'Core BOM - On-Demand - Mumbai > Sandbox > Database,Asia Pacific (Mumbai),datamo-meta-rds - PostgreSQL 18 - Single-AZ,Amazon RDS for PostgreSQL,0,191.18,2294.16,USD,"Nodes (1), Instance Type (db.m6g.large), Deployment Option (Single-AZ), Pricing Model (OnDemand), Storage amount (200 GB)"',
  // ElastiCache: the node type only the cache. prefix identifies.
  'Core BOM - On-Demand - Mumbai > Sandbox > Cache,Asia Pacific (Mumbai),Redis 7.1 - cache.t4g.medium - 1 node,Amazon ElastiCache,0,59.13,709.56,USD,"Nodes (1), Instance type (cache.t4g.medium), Cache Engine (Redis), Cache Node Type (Standard), Pricing strategy (OnDemand)"',
  // OpenSearch, carrying the export's zeroed duplicate Nodes/Instance type artefact.
  'Core BOM - On-Demand - Mumbai > Sandbox > Search,Asia Pacific (Mumbai),opensearch-busi - 1 x r7g.large.search - 200 GB gp3,Amazon OpenSearch Service,0,119.07,1428.84,USD,"Nodes (3), Instance type (r7g.large.search), Pricing strategy (OnDemand), Nodes (0), Instance type (r5.2xlarge.search), Number of nodes (0), Number of instances (3), Storage amount per volume (gp3) (200 GB)"',
  'Core BOM - On-Demand - Mumbai > Sandbox > Messaging,Asia Pacific (Mumbai),RabbitMQ 3.13 - mq.t3.micro - single-instance - 200 GB,Amazon MQ,0,44.06,528.72,USD,"Broker type (Single-instance Broker), Number of Brokers running (1), Amazon RabbitMQ Broker Instance (mq.t3.micro), Storage per Broker (200 GB)"',
  'Core BOM - On-Demand - Mumbai > Sandbox > Storage,Asia Pacific (Mumbai),application-bucket - 200 GB,S3 Standard,0,5,60.00,USD,S3 Standard storage (200 GB per month)',
  'Core BOM - On-Demand - Mumbai > Sandbox > Security,Asia Pacific (Mumbai),AWS WAF required - 1 Web ACL; rule/request volume not supplied,AWS Web Application Firewall (WAF),0,5,60.00,USD,"Number of Web Access Control Lists (Web ACLs) utilized (1 per month), Number of Rules added per Web ACL (0 per month)"',
  'Core BOM - On-Demand - Mumbai > Sandbox > Network,Asia Pacific (Mumbai),2 Application Load Balancers - base hours; traffic volume not supplied,Application Load Balancer,0,34.89,418.68,USD,Number of Application Load Balancers (2)',
  // A four-level hierarchy: environment and category still come out of the middle.
  'Core BOM - On-Demand - Mumbai > Production > Compute > Web tier,Asia Pacific (Mumbai),web - 1 x m6i.large - 120 GB gp3,Amazon EC2 ,0,100.00,1200.00,USD,' + EC2_CONFIG,
  // A two-level hierarchy: the first segment is the environment.
  'DevOps > Compute,Asia Pacific (Mumbai),builder - 1 x m6i.large - 120 GB gp3,Amazon EC2 ,0,84.67,1016.04,USD,' + EC2_CONFIG,
  '',
  '',
  '',
  'Acknowledgement',
  '"* AWS Pricing Calculator provides only an estimate of your AWS fees and doesn\'t include any taxes that might apply."',
]);

async function analyseExport() {
  return analyseWorkbook(EXPORT_FIXTURE, 'Core BOM - On-Demand - Mumbai.csv');
}

// ---------------------------------------------------------------------------
// The signature tests
// ---------------------------------------------------------------------------

describe('The calculator export signature', () => {
  test('matches the Detailed Estimate header and nothing a hand-built sheet would have', () => {
    const detailed = ['Group hierarchy', 'Region', 'Description', 'Service', 'Upfront', 'Monthly', 'First 12 months total', 'Currency', 'Configuration summary'];
    expect(isCalculatorExportTable(detailed)).toBe(true);

    // A cost summary: description, service and money, but no hierarchy and no config cell.
    expect(isCalculatorExportTable(['Item', 'Description', 'Service', 'Monthly cost', 'Annual cost'])).toBe(false);
    // An inventory: the config column alone is not enough.
    expect(isCalculatorExportTable(['Name', 'Service', 'Instance type', 'Configuration summary', 'Monthly cost'])).toBe(false);
    // Case and padding do not matter; the export's own headings come in mixed case.
    expect(isCalculatorExportTable([' group Hierarchy ', 'DESCRIPTION', 'Service', 'Monthly', 'Configuration Summary'])).toBe(true);
  });

  test('matches the Estimate summary header and not a generic monthly cost table', () => {
    expect(isCalculatorEstimateSummary(['Upfront cost', 'Monthly cost', 'Total 12 months cost', 'Currency'])).toBe(true);
    expect(isCalculatorEstimateSummary(['Item', 'Monthly cost', 'Total'])).toBe(false);
  });

  test('splits a Configuration summary on top-level commas only, keeping nested pairs whole', () => {
    const pairs = parseConfigPairs(
      'Tenancy (Shared Instances), Operating system (Linux), Workload (Consistent, Number of instances: 1), '
      + 'Storage for each RDS instance (General Purpose SSD (gp3))',
    );
    expect(pairs).toEqual([
      { label: 'Tenancy', value: 'Shared Instances' },
      { label: 'Operating system', value: 'Linux' },
      // One pair, inner comma and all -- a naive split would shred this into two.
      { label: 'Workload', value: 'Consistent, Number of instances: 1' },
      // Inner brackets survive because the value runs to the pair's LAST closing bracket.
      { label: 'Storage for each RDS instance', value: 'General Purpose SSD (gp3)' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

describe('A calculator export workbook', () => {
  test('the Detailed Estimate table is read as resources, not as a cost summary', async () => {
    const analysis = await analyseExport();

    expect(analysis.resources).toHaveLength(11);
    // The sheet narration names the export reader; before it existed this said
    // "cost summary ... 41 resource row(s)" with rows that had nothing priceable on them.
    expect(analysis.insights.sheets[0].detail).toMatch(/AWS Pricing Calculator export: 11 resource row\(s\), 3 environment\(s\) \(Sandbox, Production, DevOps\)/);
    // No reported figure is filed under the totals row's first cell, which is the
    // upfront "0" -- the summary carries its own label.
    expect(analysis.insights.reported.every((entry) => !/^0$/.test(entry.label))).toBe(true);
    // The export's own prices are comparison figures, never rates.
    expect(analysis.insights.rate_card).toEqual([]);
  });

  test('an EC2 row becomes a machine with its size, count, disk, environment and category', async () => {
    const { resources } = await analyseExport();
    const row = resources.find((resource) => resource.name === 'k8s-master' && resource.environment === 'Sandbox')!;

    expect(row).toMatchObject({
      service: 'Amazon EC2',
      size: 'm6i.large',
      quantity: '1',
      os: 'Linux',
      disk_gb: 120,
      region: 'ap-south-1',
      purchase_model: 'On-Demand Utilization: 100 %Utilized/Month',
      notes: 'exported monthly: 84.67 USD',
    });
    expect(row.attributes).toContainEqual({ label: 'Category', value: 'Compute' });
    // The nested Workload pair survives whole, and the instance count was read out of it.
    expect(row.attributes).toContainEqual({ label: 'Workload', value: 'Consistent, Number of instances: 1' });
    expect(row.attributes).not.toContainEqual(expect.objectContaining({ label: 'Number of instances: 1' }));
  });

  test('an RDS row carries its engine on os and its count and storage from the config pairs', async () => {
    const { resources } = await analyseExport();
    const mysql = resources.find((resource) => resource.name === 'foundation-rds + gimo-rds')!;

    expect(mysql).toMatchObject({
      service: 'Amazon RDS',
      size: 'db.m6g.large',
      quantity: '2',           // "Nodes (2)"
      os: 'MySQL',             // readEngine's spelling, from the Service display name
      disk_gb: 200,            // "Storage amount (200 GB)"
    });
    // "Storage for each RDS instance (General Purpose SSD (gp3))" is a description, not a
    // size, so it survives as an attribute rather than being read as a second disk.
    expect(mysql.attributes).toContainEqual({ label: 'Storage for each RDS instance', value: 'General Purpose SSD (gp3)' });
    expect(mysql.attributes).toContainEqual({ label: 'Deployment option', value: 'Single-AZ' });

    const postgres = resources.find((resource) => resource.name === 'datamo-meta-rds')!;
    expect(postgres).toMatchObject({ service: 'Amazon RDS', os: 'PostgreSQL', quantity: '1', disk_gb: 200 });
  });

  test('an ElastiCache row keeps its cache-prefixed node type, which is what prices it', async () => {
    const { resources } = await analyseExport();
    expect(resources.find((resource) => resource.service === 'Amazon ElastiCache'))
      .toMatchObject({ size: 'cache.t4g.medium', quantity: '1' });
  });

  test('an OpenSearch row takes its first configuration and not the export\'s zeroed duplicate', async () => {
    const { resources } = await analyseExport();
    const row = resources.find((resource) => resource.name === 'opensearch-busi')!;
    // The real configuration is "Nodes (3), Instance type (r7g.large.search)"; the
    // trailing "Nodes (0), Instance type (r5.2xlarge.search)" is the calculator UI's
    // collapsed-alternate artefact, and pricing it would double the row.
    expect(row).toMatchObject({ size: 'r7g.large.search', quantity: '3', disk_gb: 200 });
    expect(row.attributes).not.toContainEqual(expect.objectContaining({ label: 'Instance type' }));
  });

  test('a service the pipeline has no plan for still surfaces as a stated exclusion', async () => {
    const analysis = await analyseExport();
    const waf = analysis.resources.find((resource) => resource.service === 'AWS WAF');

    // The row is kept -- dropping it is the one outcome this module never allows.
    expect(waf).toMatchObject({ name: 'AWS WAF required', environment: 'Sandbox' });
    // And its refusal is said out loud, naming the row.
    expect(analysis.warnings.join('\n')).toMatch(/row \d+: no billing quantity could be read from it/);
  });

  test('the Estimate summary is captured as the sheet\'s stated total, and the rows foot to it', async () => {
    const analysis = await analyseExport();

    const stated = analysis.insights.reported.find((entry) => /Estimate summary/.test(entry.label));
    expect(stated?.monthly).toBeCloseTo(1092.51, 2);
    // The rows read carry the export's per-row monthly figures as REPORTED figures, so
    // their foot is the independent check on the reader having skipped nothing.
    expect(analysis.insights.reported_monthly_total).toBeCloseTo(1092.51, 2);
    expect(analysis.resources.every((resource) => resource.reported_hourly_rate === undefined)).toBe(true);
    // And because they foot exactly, no drift warning fires.
    expect(analysis.warnings.join('\n')).not.toMatch(/Estimate summary says/);
  });

  test('a stated total the rows do not foot to is flagged, not absorbed', async () => {
    const buffer = csv([
      'Estimate summary',
      'Upfront cost,Monthly cost,Total 12 months cost,Currency',
      '0,500,6000,USD',
      '',
      '',
      'Detailed Estimate',
      'Group hierarchy,Region,Description,Service,Upfront,Monthly,First 12 months total,Currency,Configuration summary',
      'Est > Sandbox > Compute,Asia Pacific (Mumbai),k8s-master - 1 x m6i.large - 120 GB gp3,Amazon EC2 ,0,84.67,1016.04,USD,' + EC2_CONFIG,
      '',
    ]);
    const analysis = await analyseWorkbook(buffer, 'drift.csv');

    expect(analysis.resources).toHaveLength(1);
    expect(analysis.warnings.join('\n')).toMatch(/sum to 84\.67 per month but the Estimate summary says 500\.00/);
  });

  test('four-level and two-level group hierarchies still yield an environment and a category', async () => {
    const { resources } = await analyseExport();

    // Four levels: the second-to-last is the category, the remaining middle the environment.
    const four = resources.find((resource) => resource.name === 'web')!;
    expect(four.environment).toBe('Production');
    expect(four.attributes).toContainEqual({ label: 'Category', value: 'Compute' });

    // Two levels: the first segment is the environment.
    const two = resources.find((resource) => resource.name === 'builder')!;
    expect(two.environment).toBe('DevOps');
    expect(two.attributes).toContainEqual({ label: 'Category', value: 'Compute' });
  });

  test('an S3 bucket row prices on its stated storage alone', async () => {
    const { resources } = await analyseExport();
    const bucket = resources.find((resource) => resource.service === 'Amazon S3')!;
    expect(bucket.disk_gb).toBe(200);
    expect(bucket.quantities).toEqual([expect.objectContaining({ unit: 'GB/month', amount: 200 })]);
  });

  test('the currency the export states is the currency the insights report', async () => {
    const { insights } = await analyseExport();
    expect(insights.currency).toBe('USD');
    expect(insights.primary_region).toBe('ap-south-1');
  });
});
