/**
 * Reads a TRANSPOSED capacity model: metrics down the first column, scenario bands
 * across the top.
 *
 * Layer 2.5 of the upload path, between sheet-structure.ts (where the blocks are) and
 * calculator-workbook.ts (what they mean in AWS terms). It exists because the shape it
 * reads is not an inventory, and every other layer assumes one.
 *
 * The file that forced it is docs/Digital_Assets.xlsx, a five-year capacity model:
 *
 *     Metric                                    | 26-27 | 27-28 | 28-29 | 29-30 | 30-31
 *     ECS Fargate task count (5 microservices)  |    10 |    15 |    25 |    30 |    40
 *     Aurora instance class                     | db.r6g.large | db.r6g.xlarge | ...
 *     Aurora storage (GB)                       | 100.6 | 109.1 | 130.3 | 145.5 | 160.7
 *
 * Read as an inventory it is 50 servers named "Aurora storage (GB)" with no size; read as
 * free text it is 50 unpriceable strings, which is what the pipeline threw
 * NO_PRICEABLE_ROWS on. Read correctly it is ONE architecture costed five ways, and each
 * of those five is a separate estimate with its own total and its own link -- a client
 * budgeting FY28-29 cannot spend a number that averaged five years together.
 *
 * Three rules, all learned from that file:
 *
 *  - A band is a scenario, never a column of a resource. Summing across `26-27` .. `30-31`
 *    produces a five-year figure presented as a monthly one; summing across `Dev, QA, UAT`
 *    is legitimate because those run at the same time. `kind` records which, so nothing
 *    downstream has to guess.
 *  - Several metric rows describe ONE resource. "Aurora instance class", "Aurora instance
 *    count" and "Aurora storage (GB)" are a size, a quantity and a disk on a single line
 *    item; emitting three would price the class three times and the storage never.
 *  - A unit in the label is the only unit there is. "(millions/yr)" and "(GB/month)" are
 *    not decoration: reading 127.2 as 127 requests instead of 10.6 million a month is a
 *    six-order-of-magnitude error, so every conversion is recorded and reported.
 */

/** Collapses newlines and runs of whitespace; sheet cells routinely contain both. */
const clean = (text: string) => String(text ?? '').replace(/\s+/g, ' ').trim();

/** Lowercased, punctuation-free, collapsed -- the form both sides of a match use. */
const normalise = (text: string) => clean(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** An EC2/RDS/ElastiCache/OpenSearch/MSK instance type, as a whole cell. */
const INSTANCE_VALUE = /^(db\.|cache\.|kafka\.)?[a-z][0-9][a-z]*\.[a-z0-9]+(\.search)?$/;

/** Purely a number, possibly decorated with a currency symbol, percent or thousands. */
export function numberFrom(text: string): number | undefined {
  const cleaned = clean(text).replace(/[,%\s]/g, '').replace(/^[^0-9.+-]+/, '');
  if (!cleaned || !/[0-9]/.test(cleaned)) return undefined;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// Band headings
// ---------------------------------------------------------------------------

/** `26-27`, `2026-27`, `FY26`, `FY 2026-27`, `Year 1`, `Y3`. */
const PERIOD_HEADING = /^(fy\s*)?(y(ea)?r\s*)?(\d{2,4})\s*([-/]\s*(\d{2,4}))?$/i;

/** `Dev`, `Testing (QA)`, `UAT`, `Pre-Prod`, `Production`. */
const ENVIRONMENT_WORDS = /\b(dev|development|test|testing|qa|uat|sit|stage|staging|preprod|pre-prod|prod|production|sandbox|training|lower)\b/i;

export type BandKind = 'period' | 'environment' | 'sizing';

export interface MetricBand {
  /** Stable identifier, derived from the heading the author wrote. */
  key: string;
  label: string;
  kind: BandKind;
  /** 0-based column index this band occupies. */
  column: number;
}

/**
 * Which kind of band a set of headings describes.
 *
 * Decided across the whole set rather than per heading: `Dev | Testing (QA) | UAT` is
 * unambiguous together and `UAT` alone is not, and one misread heading must not split a
 * single banding into two kinds -- `kind` governs whether the totals may be added up, so
 * a mixed answer is worse than a wrong one.
 */
function bandKind(labels: string[]): BandKind {
  if (!labels.length) return 'sizing';
  const periods = labels.filter((label) => PERIOD_HEADING.test(clean(label))).length;
  if (periods >= Math.max(2, Math.ceil(labels.length * 0.6))) return 'period';
  const environments = labels.filter((label) => ENVIRONMENT_WORDS.test(label)).length;
  if (environments >= Math.max(1, Math.ceil(labels.length * 0.5))) return 'environment';
  return 'sizing';
}

/**
 * True when this block is metrics-down-the-side rather than resources-down-the-side.
 *
 * Deliberately conservative, because a false positive costs far more than a false
 * negative: a real inventory misread as a matrix would emit one resource per COLUMN and
 * lose every machine on the sheet. So the caller only asks after column matching has
 * already failed to find an inventory, and this still demands that the first column read
 * as labels and the rest read as values.
 */
export function looksLikeMetricMatrix(header: string[], dataRows: string[][]): boolean {
  // One label column plus at least one band. Fewer than three metric rows is a stub or a
  // label/value pair, both of which other layers read better.
  if (header.length < 2 || dataRows.length < 3) return false;

  // The first column has to read as prose labels. Numbers there mean the rows are
  // records, and this is an inventory whose headings simply went unrecognised.
  const labels = dataRows.map((row) => clean(row[0] ?? '')).filter(Boolean);
  if (labels.length < 3) return false;
  const labelish = labels.filter((label) => numberFrom(label) === undefined && /[a-z]{3}/i.test(label)).length;
  if (labelish < labels.length * 0.8) return false;

  // ...and everything to the right has to read as values. Instance types count as values:
  // half the rows of a capacity model are "db.r6g.large" repeated across five years.
  let valueCells = 0;
  let filledCells = 0;
  for (const row of dataRows) {
    for (let c = 1; c < header.length; c++) {
      const cell = clean(row[c] ?? '');
      if (!cell) continue;
      filledCells++;
      if (numberFrom(cell) !== undefined || INSTANCE_VALUE.test(cell.toLowerCase())) valueCells++;
    }
  }
  if (filledCells < 3 || valueCells < filledCells * 0.7) return false;

  const bandLabels = header.slice(1).map(clean).filter(Boolean);
  if (!bandLabels.length) return false;

  // The headings must read as fiscal periods or as environment names. A label column plus
  // columns of numbers is ALSO the shape of a cost summary -- "Item | Monthly Cost |
  // Annual Cost" -- and claiming those here would read dollars as capacity and take the
  // table away from readCostTable, which reads it correctly. Requiring a recognisable
  // banding is what separates the two, and it is why a `sizing` verdict is refused: that
  // is the value bandKind returns when it recognised nothing in particular.
  return bandKind(bandLabels) !== 'sizing';
}

/** The bands a matrix header declares, left to right. */
export function readBands(header: string[]): MetricBand[] {
  const found: Array<{ label: string; column: number }> = [];
  for (let c = 1; c < header.length; c++) {
    const label = clean(header[c] ?? '');
    if (label) found.push({ label, column: c });
  }
  const kind = bandKind(found.map((entry) => entry.label));
  const seen = new Set<string>();
  return found.map(({ label, column }) => {
    // The heading becomes the key so a report line and a link can be traced back to the
    // column the author typed. Deduplicated because two columns headed "Dev" would
    // otherwise collapse into one scenario and silently drop the second.
    let key = normalise(label).replace(/ /g, '-').slice(0, 56) || `band-${column}`;
    if (seen.has(key)) key = `${key}-${column}`;
    seen.add(key);
    return { key, label, kind, column };
  });
}

// ---------------------------------------------------------------------------
// AWS vocabulary
// ---------------------------------------------------------------------------

/**
 * Metric-label fragments to AWS service names.
 *
 * Longest key wins, so "custom model hosting" is not read as "model" and "opensearch" is
 * not read as "search". The value is the name AWS itself uses, because that string is
 * what the pricing tools are asked for downstream.
 */
const AWS_SERVICES: Array<[string, string]> = [
  ['ecs fargate', 'AWS Fargate'], ['fargate', 'AWS Fargate'], ['ecs', 'Amazon ECS'],
  ['eks', 'Amazon EKS'], ['ecr', 'Amazon ECR'],
  ['aurora', 'Amazon Aurora'], ['rds', 'Amazon RDS'],
  ['dynamodb', 'Amazon DynamoDB'], ['documentdb', 'Amazon DocumentDB'],
  ['neptune', 'Amazon Neptune'], ['memorydb', 'Amazon MemoryDB'],
  ['timestream', 'Amazon Timestream'], ['keyspaces', 'Amazon Keyspaces'],
  ['elasticache', 'Amazon ElastiCache'],
  ['opensearch', 'Amazon OpenSearch Service'], ['elasticsearch', 'Amazon OpenSearch Service'],
  ['redshift', 'Amazon Redshift'], ['quicksight', 'Amazon QuickSight'],
  ['athena', 'Amazon Athena'], ['glue', 'AWS Glue'], ['emr', 'Amazon EMR'],
  ['kinesis', 'Amazon Kinesis'], ['msk', 'Amazon MSK'], ['kafka', 'Amazon MSK'],
  ['api gateway', 'Amazon API Gateway'], ['appsync', 'AWS AppSync'],
  ['lambda', 'AWS Lambda'], ['step functions', 'AWS Step Functions'],
  ['eventbridge', 'Amazon EventBridge'], ['sqs', 'Amazon SQS'], ['sns', 'Amazon SNS'],
  ['ses', 'Amazon SES'],
  ['cloudfront', 'Amazon CloudFront'], ['route 53', 'Amazon Route 53'],
  ['nat gateway', 'Amazon VPC NAT Gateway'], ['transit gateway', 'AWS Transit Gateway'],
  ['direct connect', 'AWS Direct Connect'], ['load balancer', 'Elastic Load Balancing'],
  ['cognito', 'Amazon Cognito'], ['secrets manager', 'AWS Secrets Manager'],
  ['kms', 'AWS KMS'], ['waf', 'AWS WAF'], ['guardduty', 'Amazon GuardDuty'],
  ['cloudwatch', 'Amazon CloudWatch'], ['cloudtrail', 'AWS CloudTrail'],
  ['bedrock', 'Amazon Bedrock'],
  ['custom model hosting', 'Amazon SageMaker'], ['sagemaker', 'Amazon SageMaker'],
  ['textract', 'Amazon Textract'], ['comprehend', 'Amazon Comprehend'],
  ['rekognition', 'Amazon Rekognition'], ['transcribe', 'Amazon Transcribe'],
  ['kendra', 'Amazon Kendra'],
  ['s3', 'Amazon S3'], ['efs', 'Amazon EFS'], ['fsx', 'Amazon FSx'],
  ['ebs', 'Amazon EBS'], ['backup', 'AWS Backup'], ['datasync', 'AWS DataSync'],
  ['workspaces', 'Amazon WorkSpaces'], ['ec2', 'Amazon EC2'],
];

/**
 * Third-party services that appear in an AWS capacity model and are not AWS bills.
 *
 * Excluded rather than priced, and reported rather than dropped: docs/Digital_Assets.xlsx
 * budgets five Pinecone rows totalling 42TB of vector storage, and pricing those against
 * the AWS Price List would invent an AWS charge that will never appear on the invoice --
 * while silently discarding them would understate the client's real spend with no trace.
 */
const NON_AWS = [
  'pinecone', 'snowflake', 'databricks', 'mongodb atlas', 'confluent', 'datadog',
  'elastic cloud', 'openai', 'anthropic', 'azure', 'google cloud', 'gcp', 'oracle cloud',
  'new relic', 'splunk', 'weaviate', 'qdrant', 'milvus',
];

/** The AWS service a metric label names, and whether it is AWS at all. */
function serviceFor(label: string): { service?: string; nonAws?: string } {
  const text = normalise(label);
  for (const vendor of NON_AWS) {
    if (text.includes(vendor)) return { nonAws: vendor };
  }
  let best: { key: string; service: string } | undefined;
  for (const [key, service] of AWS_SERVICES) {
    // Word-boundary match, so "ses" does not fire inside "uses" and "s3" does not fire
    // inside "s3x". Longest match wins.
    const pattern = new RegExp(`(^| )${key.replace(/ /g, ' ')}( |$)`);
    if (pattern.test(text) && (!best || key.length > best.key.length)) best = { key, service };
  }
  return { service: best?.service };
}

// ---------------------------------------------------------------------------
// Metric roles and units
// ---------------------------------------------------------------------------

/** What the number on a metric row actually is. */
export type Role = 'class' | 'count' | 'storage' | 'vcpu' | 'ram' | 'usage';

/**
 * Wording that identifies the role, checked in this order.
 *
 * `class` is tested before `count` because "Aurora instance class" contains "instance"
 * and so does "Aurora instance count"; storage before count because "MSK storage per
 * broker" contains neither a class nor a count but does contain "broker".
 */
const ROLE_PATTERNS: Array<[Role, RegExp]> = [
  ['class', /\b(class|instance type|node type|broker type|sku|shape|tier size)\b/],
  ['vcpu', /\b(vcpu|vcpus|cpu|cpus|core|cores)\b/],
  ['ram', /\b(ram|memory|mem)\b/],
  ['storage', /\b(storage|disk|volume|ebs)\b/],
  ['count', /\b(count|instances|nodes|brokers|tasks|replicas|number of|qty|quantity|capacity)\b/],
];

/**
 * The role a label states, ignoring anything in parentheses.
 *
 * The parenthetical is commentary, and reading a role out of it inverts the row: "ECS
 * Fargate task count (1 vCPU/2GB each)" is a COUNT of tasks that happen to be 1 vCPU
 * each, and matching `vcpu` there turned 5 Dev tasks into a 5-vCPU machine. Units still
 * come from the full label -- readUnit is given that -- because "(GB/month)" is the only
 * place the unit is ever written.
 */
export function roleFor(label: string): Role {
  const text = normalise(label.replace(/\([^)]*\)/g, ' '));
  for (const [role, pattern] of ROLE_PATTERNS) {
    if (pattern.test(text)) return role;
  }
  return 'usage';
}

export interface UnitReading {
  /** The value converted to a per-month basis where the label stated a rate. */
  amount: number;
  /** What `amount` counts, after conversion. */
  unit: string;
  /** Stated when a conversion was applied, for the inference report. */
  conversion?: string;
}

/** A billing month, matching HOURS_PER_MONTH in the orchestrator's tool loop. */
const MONTHS_PER_YEAR = 12;

/**
 * Reads the unit out of a metric label and converts the value onto a monthly basis.
 *
 * Everything AWS bills is monthly, and a capacity model is written annually. The
 * conversion is arithmetic and is always reported, because the alternative -- handing the
 * model "127.200008" from a row headed "(millions/yr)" -- is how an estimate ends up
 * wrong by six orders of magnitude with nothing on the page to show it.
 */
export function readUnit(label: string, value: number): UnitReading {
  const text = normalise(label);
  const millions = /\bmillions?\b/.test(text);
  const blocks = /\b10 000 unit blocks\b|\b10000 unit blocks\b/.test(text);
  const perYear = /\b(yr|year|years|yearly|annual|annually|pa)\b/.test(text);
  const perMonth = /\b(month|monthly|mo)\b/.test(text);

  let amount = value;
  const conversions: string[] = [];

  if (millions) { amount *= 1_000_000; conversions.push('millions expanded'); }
  if (blocks) { amount *= 10_000; conversions.push('10,000-unit blocks expanded'); }
  if (perYear && !perMonth) {
    amount /= MONTHS_PER_YEAR;
    conversions.push(`per-year divided by ${MONTHS_PER_YEAR}`);
  }

  // The noun being counted, so the figure is never a bare number downstream.
  const unit = /\bgb seconds\b/.test(text) ? 'GB-seconds/month'
    : /\b(gb|gib|gigabytes?)\b/.test(text) ? (perMonth || perYear ? 'GB/month' : 'GB')
      : /\bmau\b/.test(text) ? 'monthly active users'
        : /\brequests?\b/.test(text) ? 'requests/month'
          : /\binvocations?\b/.test(text) ? 'invocations/month'
            : /\bhours?\b/.test(text) ? 'hours/month'
              : /\b(emails?|notifications?|events?|transitions?|calls?|transactions?|text units?|documents?|vectors?|units?)\b/.test(text)
                ? `${(text.match(/\b(emails?|notifications?|events?|transitions?|calls?|transactions?|text units?|documents?|vectors?|units?)\b/) || [])[0]}/month`
                : 'units/month';

  // Rounded to cents-of-a-unit: a converted annual figure otherwise carries the source
  // sheet's binary-float noise into the estimate and reads as false precision.
  amount = Math.round(amount * 100) / 100;
  return { amount, unit, conversion: conversions.length ? conversions.join(', ') : undefined };
}

// ---------------------------------------------------------------------------
// Reading the matrix
// ---------------------------------------------------------------------------

/**
 * Wording that describes HOW a metric was measured rather than WHAT it measures.
 *
 * Stripped before grouping, so "MSK storage per broker (GB)" and "MSK broker count" land
 * on the same line item instead of two, and "Aurora instance count (Multi-AZ: writer +
 * reader)" is not a different resource from "Aurora instance class".
 */
const QUALIFIER_NOISE = /\b(instance|node|broker|task|pod|db|class|type|count|storage|disk|volume|size|per|each|total|capacity|vcpu|cpu|core|cores|ram|memory|gb|gib|amazon|aws)\b/g;
const FARGATE_QUALIFIER_NOISE = /\b(ecs|fargate|number|task|tasks|pod|pods|count|frequency|runs?|duration|runtime|run|time|average|avg|minutes?|mins?|hours?|hrs?|seconds?|secs?|per|each|daily|day|days|monthly|month|months|vcpu|cpu|cpus|memory|ram|gb|gib|size|allocated)\b/g;

/**
 * A vCPU/RAM aside out of a label: "(1 vCPU/2GB each)", "(2 vCPU, 4 GiB per task)".
 *
 * Read from the parenthetical only, which is exactly the text roleFor throws away -- a
 * label that says "count" is a count no matter what its aside mentions, but the aside is
 * still the only place the shape is written down.
 */
function specFromLabel(label: string): { vcpu?: number; ramGb?: number } {
  const asides = label.match(/\(([^)]*)\)/g);
  if (!asides) return {};
  const text = asides.join(' ');
  const vcpu = /(\d+(?:\.\d+)?)\s*v?cpus?\b/i.exec(text);
  const ram = /(\d+(?:\.\d+)?)\s*(gb|gib)\b/i.exec(text);
  return {
    vcpu: vcpu ? Number(vcpu[1]) : undefined,
    ramGb: ram ? Number(ram[1]) : undefined,
  };
}

/** One resource assembled from one or more metric rows of a single band. */
export interface MatrixResource {
  scenario: string;
  /** 1-based sheet rows this resource was assembled from, for citation. */
  rows: number[];
  service?: string;
  size?: string;
  quantity?: string;
  vcpu?: number;
  ram_gb?: number;
  disk_gb?: number;
  usage_amount?: number;
  usage_unit?: string;
  /** The sheet's own metric wording, so a line item can be traced back. */
  metric: string;
  notes?: string;
  raw: string;
  /**
   * The metric cells this resource was assembled from, UNCONVERTED and unparsed.
   *
   * The lossless half of the output, and the reason it exists is a shipped bug: a Fargate row
   * reading "10 tasks per day" was priced as 10 tasks a MONTH, and a task duration of 1440
   * minutes was billed as 1440 hours. Neither is diagnosable from what the rest of this
   * interface keeps -- `raw` is prose a human reads and code cannot, `usage_amount` has already
   * had readUnit's conversions applied so the cell text is gone, and `rows` is a list of numbers
   * with no label attached to any of them. By the time anything downstream sees a group, what
   * the sheet actually said has been destroyed.
   *
   * So `value` is the cell text with whitespace collapsed and NOTHING else done to it: no unit
   * conversion, no number parsing, no rounding. `row` and `label` are the sheet's own, so a
   * reader can find the cell in Excel and check it. This is exactly canonical-workbook.ts's
   * `MetricCell`, which is what consumes it.
   *
   * Includes cells whose value is blank or non-numeric in this band. A blank cell is
   * information: it says the sheet was SILENT here, which is a different claim from the sheet
   * saying zero -- a stated 0 vetoes a group (see the countZeros branch below) and an absent
   * figure does not. `rows`, `metric` and `raw` continue to describe only the cells that
   * carried a value in this band, so nothing that already reads this interface changes.
   */
  cells: Array<{ row: number; label: string; value: string }>;
}

export interface MatrixExclusion {
  metric: string;
  scenario?: string;
  reason: string;
}

export interface MatrixReading {
  bands: MetricBand[];
  resources: MatrixResource[];
  exclusions: MatrixExclusion[];
  /** Unit conversions applied, one line each, for the inference report. */
  conversions: string[];
}

interface MetricRow {
  /** 1-based sheet row. */
  row: number;
  label: string;
  role: Role;
  service?: string;
  nonAws?: string;
  /** Grouping key: the label with service words and role words taken out. */
  qualifier: string;
  cells: string[];
}

/**
 * Turns a metric matrix into per-band resources.
 *
 * `firstDataRow` is the 0-based grid index of the first metric row, so every resource can
 * cite the 1-based row the user sees in Excel.
 */
export function readMetricMatrix(header: string[], dataRows: string[][], firstDataRow: number): MatrixReading {
  const bands = readBands(header);
  const exclusions: MatrixExclusion[] = [];
  const conversions = new Set<string>();

  const metrics: MetricRow[] = [];
  dataRows.forEach((row, offset) => {
    const label = clean(row[0] ?? '');
    if (!label) return;
    // A row with a label and no values anywhere is a section heading inside the block,
    // not a metric. Pricing it would invent a resource out of a subtitle.
    if (!bands.some((band) => clean(row[band.column] ?? '') !== '')) {
      exclusions.push({ metric: label, reason: 'no value in any band, so it reads as a heading rather than a metric' });
      return;
    }
    const { service, nonAws } = serviceFor(label);
    metrics.push({
      row: firstDataRow + offset + 1,
      label,
      role: roleFor(label),
      service,
      nonAws,
      // Parentheticals are commentary ("(5 microservices)", "(per task)"), never identity.
      qualifier: normalise(label.replace(/\([^)]*\)/g, '')).replace(QUALIFIER_NOISE, '').replace(/\s+/g, ' ').trim(),
      cells: row,
    });
  });

  const resources: MatrixResource[] = [];

  // A key built from service AND qualifier: "SageMaker VLM/OCR instance count" and "SageMaker
  // reasoning-model instance count" are two different fleets, and folding them together would
  // price one of them twice and the other never.
  const workloadQualifier = (metric: MetricRow): string => {
    if (/\bfargate\b/i.test(metric.service || '')) {
      return normalise(metric.label.replace(/\([^)]*\)/g, ' '))
        .replace(FARGATE_QUALIFIER_NOISE, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    return metric.qualifier;
  };
  const groupKey = (metric: MetricRow) => `${metric.service ?? workloadQualifier(metric)}||${workloadQualifier(metric)}`;

  // Every metric row belonging to each key, WITHOUT the per-band emptiness filter below.
  // Grouping has to drop a blank cell -- a resource must not be invented in a band where the
  // sheet put no figure -- but `cells` must still carry it, because "the sheet said nothing
  // here" and "the sheet said 0 here" are different claims with different prices. Built once
  // for the whole sheet since the key does not depend on the band.
  const siblings = new Map<string, MetricRow[]>();
  for (const metric of metrics) {
    if (metric.nonAws) continue;
    const key = groupKey(metric);
    const bucket = siblings.get(key);
    if (bucket) bucket.push(metric); else siblings.set(key, [metric]);
  }

  for (const band of bands) {
    // Grouped per band, so a service present in one band and absent in another produces a
    // resource only where the sheet actually put a figure.
    const groups = new Map<string, MetricRow[]>();
    for (const metric of metrics) {
      if (metric.nonAws) continue;
      const value = clean(metric.cells[band.column] ?? '');
      if (!value) continue;
      const key = groupKey(metric);
      const bucket = groups.get(key);
      if (bucket) bucket.push(metric); else groups.set(key, [metric]);
    }

    for (const [key, group] of groups) {
      const draft: MatrixResource = {
        scenario: band.key,
        rows: group.map((metric) => metric.row),
        service: group.find((metric) => metric.service)?.service,
        metric: group.map((metric) => metric.label).join(' + ').slice(0, 300),
        raw: group
          .map((metric) => `${metric.label} | ${clean(metric.cells[band.column] ?? '')}`)
          .join(' ; ')
          .slice(0, 600),
        // Read straight off the row: the sheet's row number, the sheet's label, and the sheet's
        // text for THIS band. Deliberately built before the reading loop below touches anything,
        // so no conversion this function performs can reach it.
        cells: (siblings.get(key) ?? group).map((metric) => ({
          row: metric.row,
          label: metric.label,
          value: clean(metric.cells[band.column] ?? ''),
        })),
      };

      let stated = false;
      let countRows = 0;
      let countZeros = 0;
      let usageRows = 0;
      let usageZeros = 0;

      for (const metric of group) {
        const text = clean(metric.cells[band.column] ?? '');
        const value = numberFrom(text);

        if (metric.role === 'class') {
          draft.size = text;
          continue;
        }
        if (value === undefined) {
          // A non-numeric cell on a numeric role: keep the words, price nothing off them.
          draft.notes = [draft.notes, `${metric.label}: ${text}`].filter(Boolean).join(' - ').slice(0, 400);
          continue;
        }
        if (metric.role === 'count') {
          countRows++;
          if (value === 0) { countZeros++; continue; }
          draft.quantity = String(value);
          // A count row often states the size of the thing counted in its own aside, and
          // for a per-unit-priced service that aside is the whole price. "ECS Fargate task
          // count (1 vCPU/2GB each)" is 5 tasks of a known shape; read as a bare count of
          // 5 it prices as nothing at all, because Fargate has no rate for a task -- only
          // for a vCPU-hour and a GB-hour. Only filled when the sizing rows did not
          // already say it, so an explicit row always wins over a parenthetical.
          const aside = specFromLabel(metric.label);
          if (aside.vcpu !== undefined && draft.vcpu === undefined) draft.vcpu = aside.vcpu;
          if (aside.ramGb !== undefined && draft.ram_gb === undefined) draft.ram_gb = aside.ramGb;
          stated = true;
        } else if (metric.role === 'vcpu') {
          draft.vcpu = value; stated = true;
        } else if (metric.role === 'ram') {
          draft.ram_gb = value; stated = true;
        } else if (metric.role === 'storage') {
          const reading = readUnit(metric.label, value);
          if (reading.conversion) conversions.add(`${metric.label}: ${reading.conversion}`);
          draft.disk_gb = reading.amount; stated = true;
        } else {
          usageRows++;
          const reading = readUnit(metric.label, value);
          if (reading.conversion) conversions.add(`${metric.label}: ${reading.conversion}`);
          if (value === 0) { usageZeros++; continue; }
          draft.usage_amount = reading.amount;
          draft.usage_unit = reading.unit;
          stated = true;
        }
      }

      // A stated count of zero vetoes the whole group, even when a class and a storage
      // figure sit beside it. The sheet says so in words on the row that forced this --
      // "MSK broker count (Optional -- excluded from baseline)" is 0 in every band, and
      // the class and per-broker storage rows next to it are what that fleet WOULD be,
      // not what it is. Pricing them anyway put a Kafka cluster the author had ruled out
      // into every one of the eight scenarios.
      if (countRows > 0 && countZeros === countRows) {
        exclusions.push({
          metric: draft.metric,
          scenario: band.key,
          reason: `its count is 0 in ${band.label}, so it is not priced in that scenario`,
        });
        continue;
      }
      if (!stated && usageRows > 0 && usageZeros === usageRows) {
        exclusions.push({
          metric: draft.metric,
          scenario: band.key,
          reason: `stated as 0 in ${band.label}, so it is not priced in that scenario`,
        });
        continue;
      }
      if (!stated && draft.size === undefined) {
        exclusions.push({
          metric: draft.metric,
          scenario: band.key,
          reason: 'no size, count, spec or usage figure could be read from the row',
        });
        continue;
      }
      // Nothing downstream can price a figure it cannot attribute to a service: the
      // pipeline's priceable filter wants a service, a size or a vCPU count, and a bare
      // "400 GB" satisfies none of them. Reported by name rather than dropped, because
      // these are real rows a client wrote and an estimate that omits them in silence
      // reads as complete when it is not.
      if (!draft.service && !draft.size) {
        exclusions.push({
          metric: draft.metric,
          scenario: band.key,
          reason: 'no AWS service could be identified from the label, so there is nothing to price it against',
        });
        continue;
      }
      resources.push(draft);
    }
  }

  // Non-AWS rows are excluded once for the whole sheet rather than once per band: the
  // reason is the same in every band and 5 vendors x 5 bands would bury the AWS warnings.
  const vendors = new Map<string, string[]>();
  for (const metric of metrics) {
    if (!metric.nonAws) continue;
    const bucket = vendors.get(metric.nonAws);
    if (bucket) bucket.push(metric.label); else vendors.set(metric.nonAws, [metric.label]);
  }
  for (const [vendor, labels] of vendors) {
    exclusions.push({
      metric: labels.join('; ').slice(0, 300),
      reason: `${vendor} is not an AWS service, so its ${labels.length} row(s) are not in the AWS estimate`,
    });
  }

  return { bands, resources, exclusions, conversions: [...conversions] };
}
