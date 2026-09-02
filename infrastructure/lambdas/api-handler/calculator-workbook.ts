import { readWorkbookDocument, type SheetGrid, type WorkbookIR } from '../shared/workbook';
import {
  CONFIDENT_SCORE,
  findBlocks,
  matchColumnsScored,
  normaliseHeader,
  readKeyValues,
  type FieldSpec,
  type SheetBlock,
} from '../shared/sheet-structure';
import {
  looksLikeMetricMatrix,
  readMetricMatrix,
  type MetricBand,
} from '../shared/metric-matrix';
import { canonicalise } from '../shared/canonical-workbook';
import type {
  CanonicalExclusion,
  CanonicalInput,
  CanonicalRow,
  CanonicalScenario,
  CanonicalWorkbook,
  InventoryRow,
} from '../shared/canonical-workbook';
import { sqlLicenceSuffix } from '../shared/sql-licence';
import type { CalculationResource, WorkbookInsights } from '../../schema/calculator';

/**
 * Turns an arbitrary customer workbook into priceable AWS resources.
 *
 * Layer 3 of the upload path. Layer 1 (shared/workbook.ts) reads every sheet into a
 * rectangular grid; layer 2 (shared/sheet-structure.ts) finds where the tables,
 * label/value blocks and prose live; this layer decides what any of it MEANS in AWS
 * terms. It replaces normaliseResourceTable for uploads, which assumed one sheet, a
 * header on row 1, and exact-match column names -- three assumptions that all fail
 * on docs/COSEC_AWS_TCO_Model.xlsx, a real Azure-to-AWS TCO model whose 110-server
 * inventory sits on sheet 2 with its header on row 4 and columns named "Target AWS
 * Instance" and "Right-Sized Instance (Moderate)".
 *
 * Design rules, all of them learned from that file:
 *
 *  - Nothing is dropped silently. A sheet this module cannot classify still reaches
 *    the model as a bounded text excerpt, and every skipped row produces a warning.
 *  - A column is claimed by the field that matches it BEST, globally, never by
 *    whichever field was declared first. "Azure vCPU", "Right-Sized vCPU" and a
 *    plain "vCPU" have to end up in three different places.
 *  - Figures the sheet already computed are captured as REPORTED values and never
 *    used as the answer. The estimate is priced from live AWS rates; the sheet's own
 *    numbers exist so the report can show a variance against them.
 *  - A "TOTAL" footer row is a total, not a 111th server.
 */

// ---------------------------------------------------------------------------
// AWS vocabulary
// ---------------------------------------------------------------------------

/**
 * An EC2/RDS/ElastiCache instance type: family letter, generation digit, optional
 * capability suffix, then a size. Matches m6a.large, m7a.2xlarge, c7gn.16xlarge,
 * x2iedn.32xlarge, r5b.metal, db.r6g.large, cache.t4g.micro.
 */
const INSTANCE_TYPE = /^(db\.|cache\.)?[a-z][0-9][a-z]*\.[a-z0-9]+$/;

/** A literal AWS region code anywhere in a string. */
const REGION_CODE = /\b(af|ap|ca|cn|eu|il|me|mx|sa|us)-(gov-)?(central|north|south|east|west|northeast|northwest|southeast|southwest)-[0-9]\b/i;

/**
 * Location names to region codes.
 *
 * Needed because the example workbook never writes a bare region code in a column --
 * it says "AWS Frankfurt (eu-central-1)" in a label/value block on the assumptions
 * tab. Sheets that name only the city ("Ireland DR") are common enough to be worth
 * resolving too, and the AWS Pricing Calculator's own exports carry the console's
 * display names ("Asia Pacific (Mumbai)", "Canada (Central)"), whose city or bracket
 * text has to resolve as well. Longest key wins so "n virginia" is not read as
 * "virginia".
 */
const REGION_BY_LOCATION: Record<string, string> = {
  'n virginia': 'us-east-1', 'north virginia': 'us-east-1', virginia: 'us-east-1',
  ohio: 'us-east-2', 'n california': 'us-west-1', 'north california': 'us-west-1',
  california: 'us-west-1', oregon: 'us-west-2',
  frankfurt: 'eu-central-1', zurich: 'eu-central-2', ireland: 'eu-west-1', dublin: 'eu-west-1',
  london: 'eu-west-2', paris: 'eu-west-3', milan: 'eu-south-1', spain: 'eu-south-2',
  stockholm: 'eu-north-1',
  mumbai: 'ap-south-1', hyderabad: 'ap-south-2', singapore: 'ap-southeast-1',
  sydney: 'ap-southeast-2', melbourne: 'ap-southeast-4', jakarta: 'ap-southeast-3',
  tokyo: 'ap-northeast-1', seoul: 'ap-northeast-2', osaka: 'ap-northeast-3',
  'hong kong': 'ap-east-1',
  'canada central': 'ca-central-1', montreal: 'ca-central-1',
  'canada west': 'ca-west-1', calgary: 'ca-west-1', 'mexico central': 'mx-central-1',
  'sao paulo': 'sa-east-1', bahrain: 'me-south-1', uae: 'me-central-1',
  'cape town': 'af-south-1', 'tel aviv': 'il-central-1',
};

/** Extracts a region code from free text, by code first and then by location name. */
export function findRegion(text: string): string | undefined {
  const direct = REGION_CODE.exec(text);
  if (direct) return direct[0].toLowerCase();

  const haystack = normaliseHeader(text);
  let best: { region: string; length: number } | undefined;
  for (const [location, region] of Object.entries(REGION_BY_LOCATION)) {
    if (!haystack.includes(location)) continue;
    if (!best || location.length > best.length) best = { region, length: location.length };
  }
  return best?.region;
}

/** A number out of a decorated cell: "$0.05383", "1,024 GB", "12.5%", "(3.2)". */
export function toNumber(text: string): number | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  const negative = /^\(.*\)$/.test(trimmed);
  // Strip currency, grouping and percent decoration, then require what remains to
  // be a bare number -- "m6a.large" and "2 x 500" must NOT read as numbers.
  const cleaned = trimmed.replace(/[\s,%]/g, '').replace(/[()]/g, '').replace(/^[^0-9.\-+]+/, '');
  if (cleaned === '' || !/^[-+]?[0-9]*\.?[0-9]+$/.test(cleaned)) return undefined;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return undefined;
  return negative ? -Math.abs(value) : value;
}

/** A footer row: "TOTAL", "Grand Total", "Subtotal", "Average". */
const TOTAL_LABEL = /^(grand\s+total|total|totals|sum|sub\s*-?\s*total|average|avg|overall)\b/i;

/**
 * Normalises an OS name to what AWS pricing calls it.
 *
 * The sheet says "Linux" or "Windows"; RHEL and SUSE are priced differently and are
 * therefore kept distinct rather than folded into Linux.
 */
export function normaliseOs(text: string): string | undefined {
  const value = normaliseHeader(text);
  if (!value) return undefined;
  if (/(rhel|red hat)/.test(value)) return 'RHEL';
  if (/(sles|suse)/.test(value)) return 'SUSE';
  if (/win/.test(value)) return 'Windows';
  if (/(linux|ubuntu|amazon linux|centos|debian|rocky|alma)/.test(value)) return 'Linux';
  return text.trim().slice(0, 40);
}

/**
 * The OS string a row is priced on, licence included.
 *
 * normaliseOs folds "Windows 2019 with SQL Server Standard" down to "Windows" so that it
 * matches an AWS rate at all, and that fold is where a bundled database licence used to be
 * lost -- priced as plain Windows, such a machine is understated by roughly half, silently,
 * because plain Windows is a real rate. Carrying the licence on the OS string is both what
 * lets the pricing pipeline see it and what keeps licensed and unlicensed machines in
 * separate groups, which they have to be in order to price at all.
 *
 * The edition is taken from the OS and service columns only; notes are read for BYOL wording
 * alone. See shared/sql-licence.ts for why that asymmetry is deliberate.
 */
function osWithLicence(osText: string, service: string, notes?: string): string | undefined {
  const os = normaliseOs(osText);
  const licence = sqlLicenceSuffix(`${osText} ${service}`, notes);
  if (!licence) return os;
  // The OS cell already names the database, so the suffix would only repeat it; all the
  // suffix still has to contribute in that case is the BYOL marker.
  if (os && /\bsql\b|\bmssql\b/i.test(os)) {
    return licence.includes('(BYOL)') && !/byol/i.test(os) ? `${os} (BYOL)` : os;
  }
  // No OS column at all: the licence is still worth stating, and pricing defaults the OS
  // exactly as it did before -- SQL Server runs on Linux as well as Windows, so guessing
  // Windows here would invent the larger of the two rates.
  return os ? `${os}${licence}` : licence.replace(/^ \+ /, '');
}

/**
 * Every column this module knows how to read.
 *
 * `exclude` carries the real weight here. One inventory sheet routinely holds three
 * variants of the same measure -- the source platform's spec, the lift-and-shift
 * target, and a right-sized recommendation -- and a field matching on "vcpu" alone
 * would claim whichever appeared leftmost and quietly price the wrong machine.
 */
const SOURCE_WORDS = ['azure', 'source', 'current', 'existing', 'on prem', 'onprem', 'gcp', 'oci', 'vmware'];
const RIGHTSIZE_WORDS = ['right sized', 'rightsized', 'right size', 'rightsize', 'optimised', 'optimized', 'recommended'];
const MONEY_WORDS = ['cost', 'rate', 'price', 'monthly', 'annual', 'yearly', 'usd', 'eur', 'inr'];

const INVENTORY_FIELDS: FieldSpec[] = [
  { field: 'name', aliases: ['vm name', 'server name', 'host name', 'hostname', 'instance name', 'resource name', 'machine name', 'workload name', 'application', 'server', 'host', 'vm', 'name'], exclude: MONEY_WORDS },
  { field: 'environment', aliases: ['environment', 'env', 'stage', 'tier', 'environment type', 'landscape'] },
  { field: 'region', aliases: ['region', 'aws region', 'target region', 'location', 'aws location', 'data center', 'datacenter', 'site'] },
  // The simple case: a sheet built from the downloadable template leads with a
  // Service column and never mentions an instance type at all. It has to work just
  // as well as a 26-column migration model, so `service` is matched first-class and
  // a row that names one is priceable even with no spec beside it.
  { field: 'service', aliases: ['aws service', 'service', 'service name', 'resource type', 'resource', 'component', 'product', 'offering', 'workload'], exclude: MONEY_WORDS },

  // The lift-and-shift target.
  { field: 'instance_type', aliases: ['target aws instance', 'aws instance', 'target instance', 'ec2 instance', 'aws instance type', 'instance type', 'target sku', 'instance size', 'instance', 'size', 'sku', 'shape', 'machine type', 'class', 'data instance'], exclude: [...SOURCE_WORDS, ...RIGHTSIZE_WORDS, ...MONEY_WORDS] },
  { field: 'vcpu', aliases: ['vcpu', 'vcpus', 'v cpu', 'cpu', 'cpus', 'cores', 'cpu cores', 'core count'], exclude: [...SOURCE_WORDS, ...RIGHTSIZE_WORDS, ...MONEY_WORDS] },
  { field: 'ram_gb', aliases: ['ram gb', 'memory gb', 'ram gib', 'memory gib', 'ram', 'memory', 'mem'], exclude: [...SOURCE_WORDS, ...RIGHTSIZE_WORDS, ...MONEY_WORDS] },

  // What the workload runs on today. Used as the fallback when no AWS target is
  // named, so a plain Azure or on-prem inventory still prices.
  { field: 'source_sku', aliases: ['azure sku', 'source sku', 'current sku', 'existing sku', 'azure vm size', 'vm size', 'azure instance', 'current instance', 'existing instance', 'source instance', 'current spec'] },
  { field: 'source_vcpu', aliases: ['azure vcpu', 'source vcpu', 'current vcpu', 'existing vcpu', 'azure cpu', 'current cpu', 'on prem vcpu'] },
  { field: 'source_ram_gb', aliases: ['azure ram gb', 'azure ram', 'source ram', 'current ram', 'existing ram', 'azure memory', 'current memory'] },

  // The right-sized recommendation, priced as the second scenario.
  { field: 'right_sized_instance', aliases: ['right sized instance', 'rightsized instance', 'right size instance', 'optimised instance', 'optimized instance', 'recommended instance', 'right sized sku', 'right sized aws instance'] },
  { field: 'right_sized_vcpu', aliases: ['right sized vcpu', 'rightsized vcpu', 'optimised vcpu', 'recommended vcpu'] },
  { field: 'right_sized_ram_gb', aliases: ['right sized ram gb', 'right sized ram', 'rightsized ram', 'optimised ram', 'recommended ram'] },
  { field: 'right_sizing_note', aliases: ['right sizing note', 'rightsizing note', 'right size note', 'right sized note', 'optimisation note'] },

  { field: 'os', aliases: ['os type', 'operating system', 'os platform', 'guest os', 'platform', 'image', 'os'], exclude: ['disk', 'storage', 'volume', 'drive', ...MONEY_WORDS] },
  { field: 'disk_gb', aliases: ['total disk gb', 'total disk', 'total storage gb', 'total storage', 'disk size gb', 'disk size', 'volume size', 'ebs gb', 'ebs size', 'disk gb', 'storage gb', 'disk', 'storage'], exclude: ['os disk', 'data disk', 'log disk', 'temp disk', ...MONEY_WORDS] },
  { field: 'os_disk_gb', aliases: ['os disk gb', 'os disk', 'system disk', 'root disk', 'boot disk', 'root volume'] },
  { field: 'data_disk_gb', aliases: ['data disk gb', 'data disk', 'data volume', 'additional disk'] },

  { field: 'purchase_model', aliases: ['purchase model', 'pricing model', 'purchase option', 'purchasing option', 'payment option', 'commitment term', 'commitment', 'reserved instance term', 'savings plan', 'ri term', 'term'] },
  { field: 'monthly_hours', aliases: ['monthly hours', 'hours per month', 'hours month', 'monthly runtime hours', 'run hours per month', 'hours mo'] },
  { field: 'hours_per_day', aliases: ['hours per day', 'hours day', 'hrs per day', 'hrs day', 'daily hours', 'uptime hours', 'uptime', 'runtime hours', 'hours'], exclude: ['month'] },
  { field: 'quantity', aliases: ['qty', 'quantity', 'count', 'nos', 'number of instances', 'no of instances', 'instances', 'units', 'node count', 'nodes', 'node', 'brokers', 'number of brokers'] },

  // Reported figures: captured for the variance comparison, never used as prices.
  { field: 'hourly_rate', aliases: ['hourly rate', 'rate per hour', 'rate hr', 'price per hour', 'price hr', 'hourly price', 'effective hourly rate', 'unit price', 'unit rate'], exclude: ['month', 'annual', 'yearly'] },
  { field: 'monthly_compute', aliases: ['monthly compute', 'compute cost', 'compute monthly', 'monthly compute cost', 'monthly ec2'] },
  { field: 'monthly_storage', aliases: ['monthly storage', 'storage cost', 'storage monthly', 'monthly storage cost', 'monthly ebs'] },
  { field: 'monthly_backup', aliases: ['monthly backup', 'backup cost', 'backup monthly', 'monthly backup cost'] },
  { field: 'monthly_dr', aliases: ['monthly drs', 'monthly dr', 'drs cost', 'dr cost', 'monthly drs cost', 'disaster recovery cost'] },
  { field: 'monthly_total', aliases: ['total monthly', 'monthly total', 'total monthly cost', 'monthly cost', 'total cost', 'cost per month', 'cost month', 'monthly usd', 'total usd', 'grand total'] },

  { field: 'dr_eligible', aliases: ['drs eligible', 'dr eligible', 'disaster recovery eligible', 'dr required', 'drs'] },
  { field: 'utilization_source', aliases: ['utilization data source', 'utilisation data source', 'utilization source', 'utilisation source', 'data source'] },
  { field: 'notes', aliases: ['notes', 'note', 'comments', 'comment', 'remarks', 'description', 'details'] },
];

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Ceilings, every one of them reported rather than applied silently: a truncated
 * inventory that looks complete is the worst possible outcome for a cost document.
 */
const MAX_RESOURCES = 2_000;
const MAX_FACTS = 80;
const MAX_RATES = 150;
const MAX_REPORTED = 60;
const MAX_EXCERPTS = 16;
const EXCERPT_CHARS = 1_400;
const MAX_WARNINGS = 25;
/** A billing month, matching HOURS_PER_MONTH in the orchestrator's tool loop. */
const HOURS_PER_MONTH = 730;
/**
 * The declared arrays' ceilings, matching CalculationResourceSchema's own.
 *
 * Restated here rather than read off the Zod schema because nothing on the write path parses
 * a resource through it -- calculator-routes.ts stores what this module returns as it is -- so
 * an over-long row would fail at whatever finally validates it, by which point there is
 * nothing left to say which sheet and row it came from.
 */
const MAX_QUANTITIES = 12;
const MAX_ATTRIBUTES = 40;
/** Conversion lines one quantity may carry, again matching the schema. */
const MAX_QUANTITY_CONVERSIONS = 8;

export interface WorkbookAnalysis {
  resources: CalculationResource[];
  legacyResources: CalculationResource[];
  canonicalModel: CanonicalWorkbook;
  insights: WorkbookInsights;
  warnings: string[];
  workbookIR: WorkbookIR;
}

type TableKind = 'inventory' | 'rates' | 'costs' | 'other' | 'matrix';

/** Collapses newlines and runs of whitespace; sheet cells routinely contain both. */
const clean = (text: string) => text.replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// Unit-aware value reading
// ---------------------------------------------------------------------------

/**
 * Binary throughout, including the decimal-looking units.
 *
 * "2 TB" in one of these sheets is copied from a hypervisor, a Windows drive listing
 * or an Azure disk SKU, and every one of those labels a binary size with a decimal
 * unit: a 2 TiB Azure P40 disk is written "2 TB" everywhere it is quoted. Reading it
 * as 2000 GB would under-provision every disk on the sheet by 2.4%, and for a cost
 * document the direction of an unavoidable rounding matters — this one never quotes
 * less capacity than the client actually has.
 */
const SIZE_MULTIPLIER: Record<string, number> = {
  kb: 1 / 1_048_576, kib: 1 / 1_048_576,
  mb: 1 / 1_024, mib: 1 / 1_024,
  gb: 1, gib: 1,
  tb: 1_024, tib: 1_024,
  pb: 1_048_576, pib: 1_048_576,
};

/**
 * A capacity in GB, honouring a unit written into the value.
 *
 * A disk column headed "(GB)" whose cells say "2 TB" is not a contradiction to
 * resolve later -- it is a 2048 GB disk, and reading it as 2 would understate the
 * storage line by three orders of magnitude. The value's own unit always wins; a
 * bare number is taken as GB, which is what such a header means.
 *
 * Three forms, tried in order, and nothing else is a capacity:
 *
 *   "2 x 500 GB"    a count times a size, as hand-typed inventories write RAID pairs
 *   "~500 GB", "900"  a number leading the cell, unit optional
 *   "OS disk 100 GB"  a number anywhere, but only with an explicit unit beside it
 *
 * The last form needs the unit because without it any stray digit qualifies: an
 * instance type landing in a disk column used to be read as a 6 GB disk off the "6"
 * in "m6i.large". Returning nothing there is right -- the row's text is passed
 * through regardless, so a real figure is never lost, only an invented one.
 */
export function toGigabytes(text: string): number | undefined {
  if (!text) return undefined;
  const value = clean(text);

  const product = /^[^0-9A-Za-z]*([0-9]+)\s*[x×*]\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*([kmgtp]i?b)?/i.exec(value);
  if (product) {
    return scaleToGigabytes(Number(product[1]) * toDecimal(product[2]), product[3]);
  }

  const match = /^[^0-9A-Za-z]*([0-9][0-9,]*(?:\.[0-9]+)?)\s*([kmgtp]i?b)?/i.exec(value)
    ?? /([0-9][0-9,]*(?:\.[0-9]+)?)\s*([kmgtp]i?b)\b/i.exec(value);
  if (!match) return undefined;
  return scaleToGigabytes(toDecimal(match[1]), match[2]);
}

const toDecimal = (digits: string) => Number(digits.replace(/,/g, ''));

function scaleToGigabytes(value: number, unit?: string): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const scaled = value * (unit ? SIZE_MULTIPLIER[unit.toLowerCase()] ?? 1 : 1);
  return Math.round(scaled * 100) / 100;
}

/**
 * A count out of a decorated cell: "3", "3 nos", "x3", "3 x", "3 units".
 * Anything below 1 or unreadable returns undefined so the caller can default to 1.
 */
export function toCount(text: string): number | undefined {
  if (!text) return undefined;
  const match = /(?:^|[^0-9.])?([0-9]+(?:\.[0-9]+)?)/.exec(clean(text).replace(/^x\s*/i, ''));
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 1) return undefined;
  return Math.round(value);
}

// ---------------------------------------------------------------------------
// Header composition and content-based inference
// ---------------------------------------------------------------------------

/**
 * Combines a stacked two-tier header into one row of full column names.
 *
 * Grouped headers are extremely common in hand-built models:
 *
 *     row 4:  |        Azure       |         AWS        |
 *     row 5:  | vCPU | RAM | Disk  | vCPU | RAM | Disk  |
 *
 * After merged cells are reduced to their anchor (layer 1), the upper tier holds
 * "Azure" in one cell and "AWS" in another. Forward-filling that tier and prefixing
 * gives "azure vcpu" and "aws vcpu", which the alias table already distinguishes.
 * Without this both tiers read as three ambiguous "vCPU" columns and the source spec
 * and the target spec become indistinguishable.
 *
 * Guarded tightly, because the row above a header is more often a title. Composition
 * happens only when that row is a SPARSE tier: at least two populated cells (one is
 * a banner, not a tier) and clearly fewer than the header row itself.
 */
export function composeHeader(rows: string[][], headerRow: number): string[] {
  const header = (rows[headerRow] || []).map(clean);
  if (headerRow === 0) return header;

  const above = (rows[headerRow - 1] || []).map(clean);
  const abovePopulated = above.filter(Boolean).length;
  const headerPopulated = header.filter(Boolean).length;
  if (abovePopulated < 2 || headerPopulated < 2) return header;
  if (abovePopulated > headerPopulated * 0.7) return header;

  // Forward-fill the tier across the columns it spans.
  const filled: string[] = [];
  let carried = '';
  above.forEach((cell, at) => {
    if (cell) carried = cell;
    filled[at] = carried;
  });

  return header.map((cell, at) => {
    const group = filled[at] || '';
    if (!cell || !group) return cell;
    // Do not restate a group already named in the cell ("Azure" + "Azure vCPU").
    if (normaliseHeader(cell).includes(normaliseHeader(group))) return cell;
    return `${group} ${cell}`;
  });
}

/** Fraction of a sample of cells satisfying a test, ignoring blanks. */
function share(cells: string[], test: (value: string) => boolean): number {
  const populated = cells.filter((cell) => cell.trim() !== '');
  if (!populated.length) return 0;
  return populated.filter(test).length / populated.length;
}

const ENVIRONMENT_VALUE = /^(prod(uction)?|non[- ]?prod|dev(elopment)?|test|qa|uat|sit|stag(e|ing)?|pre[- ]?prod|dr|sandbox|poc|training|perf)\b/i;
const OS_VALUE = /(windows|win\s?(server|20)|linux|rhel|red\s?hat|ubuntu|centos|suse|sles|debian|amazon\s?linux)/i;
const YES_NO_VALUE = /^(yes|no|y|n|true|false|n\/?a)$/i;

/**
 * Claims columns by what their DATA looks like, for headers that matched nothing.
 *
 * This is what makes a genuinely clumsy sheet usable. A column headed "Target",
 * "Proposed", "Rec." or nothing at all is unmatchable by name, but a column where
 * most cells read "m6a.large" or "r5.2xlarge" can only be an instance type, and a
 * column of "Prod"/"UAT"/"Dev" can only be an environment. Header matching runs
 * first and always wins; this only fills what it left empty, and only on evidence
 * strong enough that the alternative reading is implausible.
 */
export function inferColumnsFromData(
  columns: Record<string, number>,
  dataRows: string[][],
  width: number,
): { columns: Record<string, number>; inferred: Array<{ field: string; column: number }> } {
  const result = { ...columns };
  const inferred: Array<{ field: string; column: number }> = [];
  const taken = new Set(Object.values(result));
  const sample = dataRows.slice(0, 60);
  if (!sample.length) return { columns: result, inferred };

  const columnCells = (at: number) => sample.map((row) => clean(String(row[at] ?? '')));

  // Ordered strongest-evidence-first, so a column that could satisfy two tests goes
  // to the more specific one.
  const tests: Array<{ field: string; threshold: number; test: (value: string) => boolean }> = [
    { field: 'instance_type', threshold: 0.5, test: (v) => INSTANCE_TYPE.test(v.toLowerCase()) },
    { field: 'region', threshold: 0.5, test: (v) => REGION_CODE.test(v) },
    { field: 'os', threshold: 0.6, test: (v) => OS_VALUE.test(v) },
    { field: 'environment', threshold: 0.6, test: (v) => ENVIRONMENT_VALUE.test(v) && !OS_VALUE.test(v) },
    { field: 'dr_eligible', threshold: 0.8, test: (v) => YES_NO_VALUE.test(v) },
  ];

  for (const { field, threshold, test } of tests) {
    if (result[field] !== undefined) continue;
    let best: { column: number; score: number } | undefined;
    for (let at = 0; at < width; at++) {
      if (taken.has(at)) continue;
      const score = share(columnCells(at), test);
      if (score >= threshold && (!best || score > best.score)) best = { column: at, score };
    }
    if (best) {
      result[field] = best.column;
      taken.add(best.column);
      inferred.push({ field, column: best.column });
    }
  }

  return { columns: result, inferred };
}

// ---------------------------------------------------------------------------
// Table classification
// ---------------------------------------------------------------------------

/**
 * A period label: a month, a quarter, a financial year, an ISO date.
 *
 * Decisive on its own. A table whose rows are consecutive periods is a spend history
 * or a forecast, never an inventory — the example workbook's "Azure Baseline" tab is
 * twelve months of invoices, and reading its rows as twelve servers would add a
 * quarter of a million dollars a month of imaginary infrastructure to the estimate.
 */
const PERIOD_VALUE =
  /^((jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*[\s\-/,]*(\d{2,4})?|\d{4}[-/]\d{1,2}([-/]\d{1,2})?([t ].*)?|q[1-4]([\s\-/]*(fy|cy)?\s?\d{2,4})?|(fy|cy|h[12])\s?[-/]?\s?\d{2,4}|(month|year|week|day|period)\s?\d{1,3}|\d{1,2}[-/]\d{4})$/i;

/** Fields that hold a number which is emphatically not money. */
const NON_MONEY_NUMERIC = [
  'vcpu', 'ram_gb', 'source_vcpu', 'source_ram_gb', 'right_sized_vcpu', 'right_sized_ram_gb',
  'disk_gb', 'os_disk_gb', 'data_disk_gb', 'monthly_hours', 'hours_per_day', 'quantity',
];

/** Money-shaped columns, split by magnitude: a unit rate behaves nothing like a total. */
interface MoneyColumns {
  /** Numbers below 100 carrying a fraction — the shape of an hourly or per-GB rate. */
  unit: number[];
  /** Numbers of 100 or more — the shape of a monthly, annual or 3-year total. */
  aggregate: number[];
}

function findMoneyColumns(
  header: string[],
  dataRows: string[][],
  columns: Record<string, number>,
  width: number,
): MoneyColumns {
  const reserved = new Set<number>();
  for (const field of NON_MONEY_NUMERIC) {
    if (columns[field] !== undefined) reserved.add(columns[field]);
  }
  const sample = dataRows.slice(0, 60);
  const unit: number[] = [];
  const aggregate: number[] = [];

  for (let at = 0; at < width; at++) {
    if (reserved.has(at)) continue;
    const cells = sample.map((row) => clean(String(row[at] ?? ''))).filter((cell) => cell !== '');
    if (cells.length < 1) continue;
    const numbers = cells.map(toNumber).filter((value): value is number => value !== undefined);
    if (numbers.length / cells.length < 0.6) continue;

    const fractionalSmall = numbers.filter((value) => Math.abs(value) < 100 && !Number.isInteger(value));
    const large = numbers.filter((value) => Math.abs(value) >= 100);
    // A money header settles it either way; magnitude decides when the heading is bare.
    const labelled = MONEY_WORDS.some((word) => normaliseHeader(header[at] || '').includes(word));
    if (fractionalSmall.length / numbers.length >= 0.6) unit.push(at);
    else if (large.length / numbers.length >= 0.6) aggregate.push(at);
    else if (labelled) aggregate.push(at);
  }
  return { unit, aggregate };
}

/** What the DATA says about a table, over and above which columns were identified. */
export interface TableEvidence {
  /** Fields matched by heading well enough to define the table's purpose. */
  strong: Set<string>;
  /** Highest share of any one column's cells holding an instance type. */
  instanceShare: number;
  /** Share of the label column holding a period rather than a thing. */
  periodShare: number;
  money: MoneyColumns;
}

export function buildEvidence(
  header: string[],
  dataRows: string[][],
  columns: Record<string, number>,
  scores: Record<string, number>,
  width: number,
): TableEvidence {
  const strong = new Set(
    Object.keys(columns).filter((field) => (scores[field] ?? 0) >= CONFIDENT_SCORE),
  );
  const sample = dataRows.slice(0, 60);

  let instanceShare = 0;
  for (let at = 0; at < width; at++) {
    const cells = sample.map((row) => clean(String(row[at] ?? '')));
    instanceShare = Math.max(instanceShare, share(cells, (v) => INSTANCE_TYPE.test(v.toLowerCase())));
  }

  const labels = sample.map((row) => firstText(row)).filter(Boolean);
  const periodShare = labels.length
    ? labels.filter((value) => PERIOD_VALUE.test(value)).length / labels.length
    : 0;

  return { strong, instanceShare, periodShare, money: findMoneyColumns(header, dataRows, columns, width) };
}

/**
 * Decides what one table is for.
 *
 * Column headings alone are not enough, which is the lesson of the example workbook:
 * three of its tabs were read as server inventories on the strength of a heading, and
 * between them they inflated a 110-machine landscape to 146 machines and its disk
 * footprint from 22TB to 64TB. So the question asked here is what each ROW is — a
 * machine, a rate, a period, or a category — and the answer comes from the values.
 *
 * Ordered most decisive first. Each rule states the reading it rules out.
 */
export function classifyTable(
  columns: Record<string, number>,
  dataRowCount: number,
  evidence: TableEvidence,
): TableKind {
  const has = (field: string) => columns[field] !== undefined;
  const strong = (field: string) => evidence.strong.has(field);
  const sizedByValue = evidence.instanceShare >= 0.5;
  const named = strong('name');

  // A machine's size can be stated for the source, for the lift-and-shift target or
  // for a right-sizing recommendation, and plenty of sheets state only one of the
  // three. Any of them is evidence that the row is a machine.
  const hasTarget = has('instance_type') || has('source_sku') || has('right_sized_instance');
  const specPair = (has('vcpu') && has('ram_gb'))
    || (has('source_vcpu') && has('source_ram_gb'))
    || (has('right_sized_vcpu') && has('right_sized_ram_gb'));
  const hasSpec = specPair
    || has('vcpu') || has('ram_gb') || has('source_vcpu') || has('source_ram_gb')
    || has('right_sized_vcpu') || has('right_sized_ram_gb')
    || has('disk_gb') || has('os_disk_gb') || has('data_disk_gb');

  // A table of months or quarters is a time series. No inventory is keyed by date.
  if (evidence.periodShare >= 0.6 && dataRowCount >= 2) return 'costs';

  // A rate card: unit prices against items, identifying no machine and counting none.
  // This is the pair that headings cannot separate, because a rate card and an
  // inventory both carry an instance type and a spec. What a rate card never carries
  // is a name, a quantity, a disk size or a monthly total.
  const rateShaped = evidence.money.unit.length >= 1
    && !named
    && !has('quantity')
    && !has('disk_gb')
    && !has('monthly_total')
    && !has('monthly_compute');
  if (rateShaped && (sizedByValue || has('instance_type') || has('service') || dataRowCount >= 2)) {
    return 'rates';
  }
  if (has('hourly_rate') && !named && !has('quantity') && !has('monthly_total')) return 'rates';

  // Named machines with any sizing at all.
  //
  // "Any sizing" deliberately includes a spec that is only stated for the SOURCE, or
  // only as a right-sizing recommendation. The most common pre-migration inventory of
  // all is a list of machines with their current vCPU and RAM and no AWS target chosen
  // yet — that is the sheet a client sends when the question is "what would this cost
  // on AWS", and requiring an instance type before believing it is an inventory would
  // reject exactly that file.
  if (named && (sizedByValue || hasTarget || hasSpec || has('service') || has('quantity'))) return 'inventory';

  // A confidently-headed Service column is the simple template, and enough on its own:
  // "Amazon S3" with a size in the notes is a resource the model can price.
  if (strong('service')) return 'inventory';

  // Values that can only be instance types, whatever the heading said or failed to say.
  if (sizedByValue) return 'inventory';

  // Specs without prices: a sizing worksheet.
  if (specPair || (has('disk_gb') && (has('environment') || has('os')))) {
    if (evidence.money.aggregate.length === 0 && dataRowCount >= 2) return 'inventory';
  }

  if (has('monthly_total') || has('monthly_compute') || evidence.money.aggregate.length) return 'costs';
  return 'other';
}

/** The row's own identity cell, used to tell a data row from a footer. */
function firstText(row: string[]): string {
  for (const cell of row) {
    const text = clean(cell);
    if (text) return text;
  }
  return '';
}

const isTotalRow = (row: string[]) => TOTAL_LABEL.test(firstText(row));

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

interface AnalysisContext {
  resources: CalculationResource[];
  insights: WorkbookInsights;
  warnings: string[];
  truncated: boolean;
  /** Currency codes seen, by number of mentions. Settled by resolveCurrency. */
  currencyHits: Map<string, number>;
  /** Every FX rate the workbook states, with where it said so. */
  fxCandidates: Array<{ sheet: string; rate: number; tier: number }>;
  /**
   * Excerpt candidates with a priority, selected at the end rather than first-come.
   *
   * Taking the first N as they arrive spends the budget on whatever sits at the front
   * of the workbook: on the example file three notes from a seven-row DRS tab crowded
   * out the entire TCO Summary, which is the one tab a reviewer would check first. An
   * unclassified table is the most valuable thing to pass through verbatim, because
   * it is the only content nothing else captured.
   */
  excerptCandidates: Array<{ sheet: string; order: number; priority: number; text: string }>;
  /** Per-sheet totals from inventory rows, cross-checked against the sheet's own footer. */
  sheetTotals: Map<string, number>;
  canonicalRows: CanonicalRow[];
  canonicalExclusions: CanonicalExclusion[];
  canonicalConversions: Set<string>;
  canonicalScenarios: Map<string, CanonicalScenario>;
  canonicalInputRows: number;
  canonicalMetricCells: number;
  canonicalAccountedMetricCells: number;
}

const warn = (context: AnalysisContext, message: string) => {
  if (context.warnings.length < MAX_WARNINGS) context.warnings.push(message);
};

/**
 * A warning worth saying once however many rows trip it.
 *
 * The ceilings above can be hit by every row of a 2,000-row inventory, and twenty-five copies
 * of one sentence would spend the entire warning budget saying nothing new while pushing out
 * the warnings that name a particular row.
 */
const warnOnce = (context: AnalysisContext, message: string) => {
  if (!context.warnings.includes(message)) warn(context, message);
};

function rememberCanonical(context: AnalysisContext, book: CanonicalWorkbook): void {
  context.canonicalRows.push(...book.rows);
  context.canonicalExclusions.push(...book.exclusions);
  for (const conversion of book.conversions) context.canonicalConversions.add(conversion);
  for (const scenario of book.scenarios) {
    if (!context.canonicalScenarios.has(scenario.key)) context.canonicalScenarios.set(scenario.key, scenario);
  }
  context.canonicalInputRows += book.accounting.inputRows;
  context.canonicalMetricCells += book.accounting.metricCells;
  context.canonicalAccountedMetricCells += book.accounting.accountedMetricCells;
}

function canonicalModelOf(context: AnalysisContext): CanonicalWorkbook {
  return {
    rows: context.canonicalRows,
    exclusions: context.canonicalExclusions,
    conversions: [...context.canonicalConversions],
    scenarios: [...context.canonicalScenarios.values()],
    accounting: {
      inputRows: context.canonicalInputRows,
      canonicalRows: context.canonicalRows.length,
      exclusions: context.canonicalExclusions.length,
      metricCells: context.canonicalMetricCells,
      accountedMetricCells: context.canonicalAccountedMetricCells,
      balanced: context.canonicalInputRows === context.canonicalRows.length + context.canonicalExclusions.length
        && context.canonicalMetricCells === context.canonicalAccountedMetricCells,
    },
  };
}

// ---------------------------------------------------------------------------
// Declaring what a row is billed on
// ---------------------------------------------------------------------------

/**
 * A one-cell table row that heads the rows beneath it rather than commenting on them.
 *
 * Short, unpunctuated, and starting with neither a footnote marker nor a bracket. Deliberately
 * strict: a false positive gives every machine below it a section reading "* Excludes SQL
 * Server licences, which are BYOL", with nothing left in the record for a reader to tell that
 * back out from, while a false negative only leaves `section` unset on rows that price exactly
 * as they did before.
 */
const SECTION_BANNER = /^(?![-*(#†‡])(?=.*[a-z])[^.!?;:|]{1,60}$/i;

/** AWS vocabulary inferred from a section heading, independent of workbook identity. */
function serviceFromSection(section?: string): string | undefined {
  const text = String(section || '').trim().toLowerCase();
  if (!text) return undefined;
  if (/open\s*search|elasticsearch/.test(text)) return 'Amazon OpenSearch Service';
  if (/load\s*balanc/.test(text)) return 'Elastic Load Balancing';
  if (/memory\s*db/.test(text)) return 'Amazon MemoryDB';
  if (/\b(?:redis|elasticache)\b/.test(text)) return 'Amazon ElastiCache';
  if (/\b(?:database|rds)\b/.test(text)) return 'Amazon RDS';
  if (/\b(?:storage|s3)\b/.test(text)) return 'Amazon S3';
  if (/\b(?:mq|message broker)\b/.test(text)) return 'Amazon MQ';
  if (/\bwaf\b|web application firewall/.test(text)) return 'AWS WAF';
  if (/\b(?:server|compute|virtual machine)\b/.test(text)) return 'Amazon EC2';
  return undefined;
}

/**
 * The fields the canonical normaliser is the authority on, ready to spread onto a resource.
 *
 * Only the fields it decides. `section` and `disks` are the reader's, because only the reader
 * can see the sheet's headings, and they are set where they are read.
 *
 * Keys are absent rather than undefined where there is nothing to say, so spreading this over
 * a half-built resource can never blank a field the reader had already filled.
 */
interface Declaration {
  quantities?: CalculationResource['quantities'];
  attributes?: CalculationResource['attributes'];
  configuration?: CalculationResource['configuration'];
}

/**
 * A quantity's conversion lines within the schema's cap, saying so in the list when it bites.
 *
 * In the list rather than in a warning, following blockExcerpt: the only reader who needs to
 * know a conversion is missing is one working through this row's arithmetic, and a note filed
 * in a warning list on another page is not where that reader is looking.
 */
function boundedConversions(lines: string[]): string[] {
  const trimmed = lines.map((line) => line.slice(0, 300));
  if (trimmed.length <= MAX_QUANTITY_CONVERSIONS) return trimmed;
  const kept = trimmed.slice(0, MAX_QUANTITY_CONVERSIONS - 1);
  return [...kept, `... and ${trimmed.length - kept.length} further conversion(s) applied but not listed`];
}

/**
 * Files everything the normaliser would not put a unit on, as warnings.
 *
 * Two kinds, and the second is the dangerous one. A row refused whole leaves a gap a reader
 * can see: there is no line item where they expected one. A single CELL refused on a row that
 * priced anyway leaves no gap at all -- the row is there, the total looks finished, and a
 * Fargate group whose duration cell could not be read is quietly priced for a whole month of
 * running instead of the twenty-four minutes a day it stated. That is the estimate this
 * normalisation exists to stop producing, so an unread cell is filed as loudly as an unread
 * row.
 *
 * Not into `insights.exclusions`, even though that list is uncapped and the warnings are not.
 * That list means "not priced" and is rendered in exactly those words (chat/context/
 * calculator-tools.ts :390-392), whereas a row here is still stored and still priced from its
 * instance class or its disk -- refusing to METER a row is not the same as leaving it out.
 * Filing it there would put an omission in the record that never happened, which misleads a
 * reviewer just as effectively as hiding one that did.
 */
function noteRefusals(context: AnalysisContext, book: CanonicalWorkbook, cite: string): void {
  for (const exclusion of book.exclusions) {
    warn(context, `${cite}: no billing quantity could be read from it -- ${exclusion.reason}.`);
  }
  for (const row of book.rows) {
    for (const cell of row.unpriced) {
      warn(context, `${cite}: "${cell.provenance.label.slice(0, 70)}" states "${cell.provenance.value.slice(0, 40)}" and was not priced -- ${cell.reason}.`);
    }
  }
}

/**
 * Reads one row's billing dimensions out of what its cells actually say.
 *
 * Called once per row rather than once per table. `canonicalise` returns its priced rows and
 * its refusals in two arrays with no index back into what it was handed, so a batched call
 * would have to match a canonical row to the sheet row it came from by label -- and a row may
 * only ever carry ITS OWN dimensions, never those of a row that happens to read like it. With
 * one row in, the answer is exactly one canonical row or exactly one refusal, so the mapping
 * cannot be got wrong.
 *
 * The amounts come back UNCHANGED. Every one of them is already a monthly figure and already
 * scaled for its own row's count -- `count x hours`, `gb x count` -- so scaling them here by
 * the quantity column a second time is precisely the arithmetic that priced ten Fargate tasks
 * a day as ten tasks a month. The only edits made below are the schema's length caps.
 */
function declareBilling(input: CanonicalInput, cite: string, context: AnalysisContext): Declaration {
  const book = canonicalise(input);
  rememberCanonical(context, book);
  noteRefusals(context, book, cite);

  const declaration: Declaration = {};
  const row = book.rows[0];
  // No row means every dimension was refused, and noteRefusals has just said why. The resource
  // is still stored with everything the reader made of it: "nothing here can be metered" is a
  // narrower statement than "this row is not real".
  if (!row) return declaration;

  // A non-finite amount is not a quantity, and DynamoDB will not store one either. Dropped
  // rather than repaired, because a dimension the pipeline prices from the instance class is a
  // better answer than a dimension carrying a guessed number.
  const priced = row.quantities.filter((quantity) => Number.isFinite(quantity.amount));
  if (priced.length > MAX_QUANTITIES) {
    const dropped = priced.slice(MAX_QUANTITIES).map((quantity) => quantity.unit).join(', ');
    warn(context, `${cite}: it is billed on ${priced.length} dimensions and only ${MAX_QUANTITIES} are kept, so ${dropped} is not priced.`);
  }
  if (priced.length) {
    declaration.quantities = priced.slice(0, MAX_QUANTITIES).map((quantity) => ({
      unit: quantity.unit,
      amount: quantity.amount,
      originalValue: quantity.originalValue,
      originalUnit: quantity.originalUnit,
      originalScale: quantity.originalScale,
      originalPeriod: quantity.originalPeriod,
      derivedValue: quantity.derivedValue,
      derivedUnit: quantity.derivedUnit,
      derivedScale: quantity.derivedScale,
      derivedPeriod: quantity.derivedPeriod,
      conversionFormula: quantity.conversionFormula,
      // Trimmed to the schema's lengths rather than trusted to be short: a basis and a
      // conversion line are both assembled out of column headings, and a heading is as long as
      // whoever typed it felt like making it.
      basis: quantity.basis.slice(0, 120),
      conversions: boundedConversions(quantity.conversions),
    }));
  }

  const attributes = row.attributes.map((attribute) => ({
    label: attribute.label.slice(0, 120),
    value: attribute.value.slice(0, 300),
  }));
  if (attributes.length > MAX_ATTRIBUTES) {
    // Said once and without the row, because more than forty values with no column of their own
    // is a property of the TABLE; naming one of its rows would send a reader to the wrong place.
    warnOnce(context, `Some rows state more than ${MAX_ATTRIBUTES} values with no column of their own, and only the first ${MAX_ATTRIBUTES} of them are kept per row. The full row text is stored regardless.`);
  }
  if (attributes.length) declaration.attributes = attributes.slice(0, MAX_ATTRIBUTES);

  if (/fargate/i.test(row.service || '') && row.shape) {
    declaration.configuration = {
      ...(declaration.configuration || {}),
      fargateTask: {
        taskCount: {
          originalValue: row.shape.countOriginalValue ?? row.shape.count,
          originalUnit: row.shape.countOriginalUnit ?? 'tasks',
          originalPeriod: row.shape.countOriginalPeriod ?? 'month',
          derived: row.shape.countDerivedValue !== undefined ? {
            value: row.shape.countDerivedValue,
            unit: row.shape.countDerivedUnit ?? 'tasks',
            formula: row.shape.countConversionFormula ?? 'no count conversion',
          } : undefined,
        },
        taskFrequency: row.shape.countOriginalPeriod === 'day' ? 'perDay' : 'perMonth',
        vcpuPerTask: { originalValue: row.shape.vcpu },
        memoryGbPerTask: { originalValue: row.shape.ramGb },
        taskDuration: {
          originalValue: row.shape.durationOriginalValue ?? row.shape.hoursPerUnit,
          originalUnit: row.shape.durationOriginalUnit ?? 'hours',
          originalPeriod: row.shape.durationOriginalPeriod ?? 'month',
          derived: row.shape.durationDerivedValue !== undefined ? {
            value: row.shape.durationDerivedValue,
            unit: row.shape.durationDerivedUnit ?? 'hours',
            formula: row.shape.durationConversionFormula ?? 'no duration conversion',
          } : undefined,
        },
      },
    };
  }

  return declaration;
}

/**
 * Reads one inventory table into resources.
 *
 * Each machine becomes exactly ONE resource carrying both its compute and its
 * storage, rather than an EC2 row plus an EBS row. That halves the row count on a
 * large landscape and keeps every figure for a machine in one place; the prompt
 * builder expands each group into separate compute and storage line items, which is
 * where that split actually belongs.
 */
function readInventory(
  sheet: SheetGrid,
  block: SheetBlock,
  columns: Record<string, number>,
  context: AnalysisContext,
): number {
  const headerRow = block.headerRow!;
  /** Populated width of the heading row, for telling a note row from a data row. */
  const width = (sheet.rows[headerRow] ?? []).filter((value) => clean(value) !== '').length;
  const cell = (row: string[], field: string): string => {
    const at = columns[field];
    return at === undefined ? '' : clean(String(row[at] ?? ''));
  };
  const num = (row: string[], field: string) => toNumber(cell(row, field));
  const gb = (row: string[], field: string) => toGigabytes(cell(row, field));
  /**
   * A money cell's own decoration names the currency the sheet is written in.
   *
   * Read from the values rather than the headings because that is where it usually
   * is: a column headed "Total Monthly Cost" over cells reading "$1,234.56" states
   * USD perfectly clearly, and defaulting to USD without checking would mislabel an
   * INR or EUR sheet in the report.
   */
  const money = (row: string[], field: string) => {
    const text = cell(row, field);
    if (text) noteCurrencies(context, text);
    return toNumber(text);
  };

  let count = 0;
  /**
   * The last section heading seen, carried onto every machine beneath it.
   *
   * A one-cell row inside a table is either a heading for the rows below it or a footnote
   * about the rows above it, and only the first of those describes a machine. A footnote is
   * never cleared once a heading has been set, because a footnote does not end a section --
   * "* Excludes SQL Server licences" sits under the production block it qualifies.
   */
  const headerCells = sheet.rows[headerRow] || [];
  const firstHeaderAt = headerCells.findIndex((value) => clean(value) !== '');
  const firstHeader = firstHeaderAt >= 0 ? clean(String(headerCells[firstHeaderAt])) : '';
  const followingHeaders = headerCells
    .slice(firstHeaderAt + 1)
    .map((value) => clean(String(value)))
    .filter(Boolean);
  const claimedColumns = new Set(Object.values(columns));
  const sectionService = serviceFromSection(firstHeader);
  // Some inventories put the section name in the first heading cell and repeat the
  // metered dimension later: "Storage | Bucket Name | Storage". The first cell is then
  // legitimately claimed as a data column, but it still owns the table when the next
  // heading identifies the resource rather than another metric.
  const sectionStyleHeader = Boolean(sectionService)
    && followingHeaders.some((value) => /\b(name|identifier|resource|required)\b/i.test(value));
  let section: string | undefined = firstHeader
    && (!claimedColumns.has(firstHeaderAt) || sectionStyleHeader)
    && SECTION_BANNER.test(firstHeader)
    ? firstHeader.slice(0, 80)
    : undefined;

  for (let r = headerRow + 1; r <= block.end; r++) {
    const row = sheet.rows[r];
    if (!row) continue;
    const raw = row.map(clean).filter(Boolean).join(' | ');
    if (!raw) continue;
    const populatedCells = row.map((value) => clean(String(value))).filter(Boolean);
    const rowPairService = populatedCells.length === 2
      ? serviceFromSection(populatedCells[0])
      : undefined;

    // A single populated cell in a table three or more columns wide is a note or a
    // section banner that happens to sit inside the table's rows — "* Excludes SQL
    // Server licences, which are BYOL", "Production servers". It cannot be a machine
    // (there is no size, spec or service beside it) and reading it as one produces a
    // server named after a sentence. It is kept as a fact, because a footnote that
    // says what the estimate excludes is exactly the kind of thing not to lose.
    if (width >= 3 && row.filter((value) => clean(value) !== '').length === 1) {
      if (SECTION_BANNER.test(raw)) section = raw.slice(0, 80);
      if (context.insights.facts.length < MAX_FACTS) {
        context.insights.facts.push({
          sheet: sheet.name,
          label: `Note in the table at row ${r + 1}`,
          value: raw.slice(0, 300),
        });
      }
      continue;
    }

    // A footer is a total, not a machine. Its figures are kept as the sheet's own
    // reported total, which is what the variance is measured against.
    if (isTotalRow(row)) {
      const monthly = num(row, 'monthly_total') ?? num(row, 'monthly_compute');
      if (monthly !== undefined && context.insights.reported.length < MAX_REPORTED) {
        context.insights.reported.push({
          sheet: sheet.name,
          label: `${firstText(row)} of ${sheet.name}, as calculated in the sheet`,
          monthly,
        });
      }
      continue;
    }

    if (context.resources.length >= MAX_RESOURCES) {
      context.truncated = true;
      continue;
    }

    // Baseline sizing: the sheet's AWS target, else its right-sized recommendation,
    // else the source platform's SKU for the model to translate.
    const target = rowPairService ? '' : cell(row, 'instance_type');
    const rightSized = cell(row, 'right_sized_instance');
    const sourceSku = cell(row, 'source_sku');
    const size = target || rightSized || sourceSku;

    const vcpu = num(row, 'vcpu') ?? num(row, 'source_vcpu');
    const ramGb = gb(row, 'ram_gb') ?? gb(row, 'source_ram_gb');
    const namedDisks: Array<{ label: string; gb: number }> =
      ([['OS disk', 'os_disk_gb'], ['Data disk', 'data_disk_gb']] as const).flatMap(([label, field]) => {
        const value = gb(row, field);
        // A blank or "N/A" volume column is a volume the row does not have, not a volume of
        // zero gigabytes, and naming it would put an empty line in the storage breakdown.
        return value !== undefined && value > 0 ? [{ label, gb: value }] : [];
      });
    const sectionOwnedStorage = serviceFromSection(section) === 'Amazon S3'
      ? headerCells.map((heading, at) => (
        at !== firstHeaderAt && /\b(storage|capacity|size)\b/i.test(clean(String(heading)))
          ? toGigabytes(clean(String(row[at] ?? '')))
          : undefined
      )).find((value): value is number => value !== undefined)
      : undefined;
    const statedDisk = gb(row, 'disk_gb') ?? sectionOwnedStorage;
    const disk = statedDisk ?? (namedDisks.length
      ? namedDisks.reduce((total, entry) => total + entry.gb, 0)
      : undefined);
    /**
     * The named volumes, published only where they ARE the total.
     *
     * A footed "Total Disk (GB)" is the author's own figure and need not equal its parts: a
     * sheet rounds, or lists a volume it has no column for. The normaliser reads `disks` IN
     * PLACE OF `disk_gb` when both arrive rather than alongside it, so a breakdown that came
     * to less than the stated total would quietly meter less storage than the sheet asked
     * for -- which is why the parts stay out of the record wherever a total was stated. At
     * most two of them exist here in any case, well inside the schema's twenty.
     */
    const disks = statedDisk === undefined && namedDisks.length ? namedDisks : undefined;

    const name = rowPairService ? populatedCells[0] : cell(row, 'name');
    // A sheet built from the template names a service and nothing else; a migration
    // model names a machine and never says "EC2". Either is enough.
    const service = cell(row, 'service') || rowPairService || serviceFromSection(section) || '';
    // Nothing to price and nothing to identify: a spacer or a stray note.
    if (!service && !size && vcpu === undefined && ramGb === undefined && disk === undefined && !name) {
      warn(context, `${sheet.name} row ${r + 1}: no service, size, spec or name, so it was not priced ("${raw.slice(0, 70)}").`);
      continue;
    }

    // Monthly hours are authoritative when present: "On-Demand 12x5" is 260
    // hrs/month, which no whole number of hours per day expresses. hoursPerDay is
    // derived from it so the existing 1-24 pricing path keeps working.
    const monthlyHoursText = cell(row, 'monthly_hours');
    const monthlyHours = toNumber(monthlyHoursText);
    const dailyHours = num(row, 'hours_per_day');
    const hoursPerMonth = monthlyHours !== undefined && monthlyHours > 0 && monthlyHours <= HOURS_PER_MONTH
      ? monthlyHours
      : dailyHours !== undefined && dailyHours >= 1 && dailyHours <= 24
        ? Math.round(dailyHours * (HOURS_PER_MONTH / 24) * 100) / 100
        : undefined;
    const hoursPerDay = hoursPerMonth !== undefined
      ? Math.min(24, Math.max(1, Math.round((hoursPerMonth / HOURS_PER_MONTH) * 24 * 100) / 100))
      : undefined;
    if (monthlyHoursText && monthlyHours !== undefined && hoursPerMonth === undefined) {
      warn(context, `${sheet.name} row ${r + 1}: monthly hours "${monthlyHoursText}" is outside 1-${HOURS_PER_MONTH}, so the environment default applies.`);
    }
    // Said out loud for the same reason: a schedule the sheet stated and we could not
    // use means this row is priced at its environment's default hours, and a client
    // reading "24/7" against a row they wrote "12" on deserves to know why.
    const dailyHoursText = cell(row, 'hours_per_day');
    if (dailyHoursText && !monthlyHoursText && dailyHours === undefined) {
      warn(context, `${sheet.name} row ${r + 1}: hours per day "${dailyHoursText}" could not be read, so the environment default applies.`);
    } else if (dailyHoursText && !monthlyHoursText && dailyHours !== undefined && (dailyHours < 1 || dailyHours > 24)) {
      warn(context, `${sheet.name} row ${r + 1}: hours per day "${dailyHoursText}" is outside 1-24, so the environment default applies.`);
    }

    const quantityText = cell(row, 'quantity');
    const quantity = toCount(quantityText);
    const drEligible = /^(y|yes|true|1|required|eligible)/i.test(cell(row, 'dr_eligible'));

    const notes = [cell(row, 'notes'), cell(row, 'right_sizing_note')]
      .filter(Boolean).join(' - ').slice(0, 400) || undefined;

    /**
     * Columns this module recognises but has no field of its own for.
     *
     * A backup or DR figure the sheet already costed is not an AWS rate and must never be
     * priced as one, but dropping it loses the fact that the client's own model budgeted for
     * it, which is half of any variance a reviewer wants to check.
     */
    const attributes: Array<{ label: string; value: string }> = ([
      ['Backup cost stated in the sheet', 'monthly_backup'],
      ['DR cost stated in the sheet', 'monthly_dr'],
      ['Utilisation source', 'utilization_source'],
    ] as const)
      // Trimmed to the schema's length here, not only where the normaliser hands them back: a
      // zeroed row is refused outright and keeps the attributes read at this point instead.
      .map(([label, field]) => ({ label, value: cell(row, field).slice(0, 300) }))
      .filter((entry) => entry.value !== '');
    const fullHeader = composeHeader(sheet.rows, headerRow);
    fullHeader.forEach((label, at) => {
      const value = clean(String(row[at] ?? ''));
      if (!label || !value || claimedColumns.has(at)) return;
      attributes.push({ label: label.slice(0, 120), value: value.slice(0, 300) });
    });

    /**
     * The row as read, in the shape the normaliser and the stored resource both accept.
     *
     * One object handed to both rather than two lists of fields written twice, so a value can
     * never be metered as one thing and reported as another -- and so a column added to the
     * vocabulary reaches the pricing layer by being read, without a second edit to remember.
     */
    const parsed: InventoryRow = {
      sheet: sheet.name,
      row: r + 1,
      section,
      name: name || undefined,
      environment: cell(row, 'environment') || undefined,
      // Default to EC2 only when the row clearly describes a machine. A sheet that
      // names its own services is always believed over that default.
      service: service || (size || vcpu !== undefined || ramGb !== undefined ? 'Amazon EC2' : undefined),
      size: size || undefined,
      quantity: quantityText || undefined,
      region: findRegion(cell(row, 'region')),
      os: osWithLicence(cell(row, 'os'), service, notes),
      vcpu,
      ram_gb: ramGb,
      disk_gb: disk,
      disks,
      attributes: attributes.length ? attributes : undefined,
      purchase_model: cell(row, 'purchase_model') || undefined,
      hoursPerDay,
      hoursPerMonth,
      notes,
      raw: raw.slice(0, 600),
    };

    context.resources.push({
      ...parsed,
      right_sized_size: rightSized && rightSized !== target ? rightSized : undefined,
      right_sized_vcpu: num(row, 'right_sized_vcpu'),
      right_sized_ram_gb: gb(row, 'right_sized_ram_gb'),
      source_size: sourceSku && sourceSku !== size ? sourceSku : undefined,
      dr_eligible: drEligible || undefined,
      reported_monthly: money(row, 'monthly_total'),
      reported_compute_monthly: money(row, 'monthly_compute'),
      reported_storage_monthly: money(row, 'monthly_storage'),
      reported_hourly_rate: money(row, 'hourly_rate'),
      // Last, so the fields the normaliser is the authority on win over anything above. It is
      // given `parsed` and nothing else, so what comes back describes this row and no other.
      ...declareBilling({ inventory: [parsed] }, `${sheet.name} row ${r + 1}`, context),
    });

    count++;
    context.insights.server_count += quantity ?? 1;
    if (disk) context.insights.total_disk_gb += disk * (quantity ?? 1);
    if (drEligible) context.insights.dr_eligible_count += quantity ?? 1;
  }

  if (!count) {
    warn(context, `${sheet.name}: a table was found at row ${headerRow + 1} but none of its rows could be priced.`);
  }
  return count;
}

// ---------------------------------------------------------------------------
// AWS Pricing Calculator exports
// ---------------------------------------------------------------------------

/**
 * The export's header for its Detailed Estimate table, matched on the columns that only
 * that format carries together.
 *
 * A calculator.aws export (CSV or xlsx, same shape) is one sheet in three bannered
 * sections. The Detailed Estimate table looks dangerously like a cost summary to the
 * generic classifier -- it has Description, Service and three money columns -- and its
 * resource shape lives entirely in one cell, the Configuration summary, which is a
 * comma-separated list of `Label (value)` pairs. Nothing else writes a "Group hierarchy"
 * column next to a "Configuration summary" one, so requiring both (plus Description,
 * Service and a money column) is what keeps a hand-built cost sheet out of this reader:
 * a false positive here would price a client's spend history as an inventory.
 */
export function isCalculatorExportTable(header: string[]): boolean {
  const cells = header.map((cell) => normaliseHeader(clean(cell))).filter(Boolean);
  const has = (test: (text: string) => boolean) => cells.some(test);
  return has((text) => text.includes('group') && text.includes('hierarchy'))
    && has((text) => text.includes('configuration') && text.includes('summary'))
    && has((text) => text.includes('description'))
    && has((text) => text.includes('service'))
    && has((text) => /(upfront|monthly|cost|total|price|rate)/.test(text));
}

/**
 * The export's Estimate summary banner table: upfront + monthly + currency headings and
 * nothing else.
 *
 * Recognised separately from a generic cost summary because a calculator export states
 * its grand total exactly once, in this block, and the number belongs on the sheet as a
 * STATED total to cross-check the rows against -- never as a 42nd resource, and never
 * left to readCostTable, which files it under whatever text happens to sit in the first
 * cell of the totals row (on the real export that is the upfront figure "0").
 */
export function isCalculatorEstimateSummary(header: string[]): boolean {
  const cells = header.map((cell) => normaliseHeader(clean(cell))).filter(Boolean);
  const has = (test: (text: string) => boolean) => cells.some(test);
  return has((text) => text.includes('upfront cost'))
    && has((text) => text.includes('monthly cost'))
    && has((text) => text.includes('currency'));
}

/**
 * Splits a Configuration summary cell into its `Label (value)` pairs.
 *
 * A plain split on ", " shreds the export's own nesting: "Workload (Consistent, Number of
 * instances: 1)" becomes a pair "Workload" and a bogus pair "Number of instances: 1)" --
 * and since the instance count of an EC2 row lives INSIDE that value, a shredded parse
 * both loses the count and invents an attribute nobody wrote. So a comma ends a pair only
 * at bracket depth zero AND when what follows starts a fresh `Label (` run; a value keeps
 * everything up to the LAST closing bracket of its pair, so "General Purpose SSD (gp3)"
 * survives intact inside a storage description.
 */
export function parseConfigPairs(text: string): Array<{ label: string; value: string }> {
  const pairs: Array<{ label: string; value: string }> = [];
  let depth = 0;
  let start = 0;

  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char === '(') depth++;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (char === ',' && depth === 0) {
      const rest = text.slice(at + 1).replace(/^[,\s]+/, '');
      if (/^[^,()]{1,80}\(/.test(rest)) {
        pairs.push(configPair(text.slice(start, at)));
        start = at + 1;
      }
    }
  }
  pairs.push(configPair(text.slice(start)));
  return pairs.filter((pair) => pair.label !== '' || pair.value !== '');
}

/** One chunk of the cell as a label and the text inside its brackets. */
function configPair(chunk: string): { label: string; value: string } {
  const text = clean(chunk);
  const open = text.indexOf('(');
  if (open === -1) return { label: text, value: '' };
  const close = text.lastIndexOf(')');
  return {
    label: clean(text.slice(0, open)).replace(/[,:]+$/, ''),
    value: clean(text.slice(open + 1, close >= open ? close : undefined)),
  };
}

/** Pair labels that name an instance, node or broker class. */
const CONFIG_INSTANCE = /instance\s*(type|class)|broker instance|ec2 instance/i;
/** Pair labels that state how many of something the row stands for. */
const CONFIG_COUNT = /^(nodes|number of (nodes|instances|clustered brokers|brokers running|application load balancers|network load balancers))$/;
/** Pair labels that state the purchase terms. */
const CONFIG_PRICING = /pricing strateg|pricing model/i;
/** The EC2 operating-system pair. RDS engines never arrive as an "operating system". */
const CONFIG_OS = /^operating system$/i;
/** An instance type in a value rather than a label, allowing the .search and mq. forms. */
const LOOSE_INSTANCE_TYPE = /^(db\.|cache\.)?[a-z][0-9][a-z0-9]*(?:\.[a-z0-9]+){1,2}$/;
/** The instance count of an EC2 row, nested inside the Workload pair's value. */
const NESTED_COUNT = /number of instances:\s*([0-9]+)/i;

/**
 * The export's Service display name to the service string the pricing pipeline expects.
 *
 * planFromGroup (calculator-orchestrator/pipeline.ts) reads the engine out of
 * `service + os`, so the engine travels on `os` in exactly the spellings readEngine
 * regexes -- 'MySQL', 'PostgreSQL', 'Aurora MySQL' -- and never as the display name's
 * 'RDS for MySQL'. A service with no plan in the pipeline keeps a plain name of its own:
 * the row still reaches the model, where it surfaces as a stated exclusion rather than
 * silently vanishing from the estimate.
 */
function mapExportService(display: string, description: string): { service: string; os?: string } {
  const text = clean(display);
  const key = normaliseHeader(text);
  // The description names the engine when the service cell does not ("... - MySQL 8 - ...").
  const about = `${key} ${normaliseHeader(description)}`;

  if (/\bec2\b/.test(key)) return { service: 'Amazon EC2' };
  if (/aurora/.test(key)) {
    return /mysql/.test(key)
      ? { service: 'Amazon Aurora', os: 'Aurora MySQL' }
      : { service: 'Amazon Aurora', os: 'Aurora PostgreSQL' };
  }
  if (/\brds\b/.test(key)) {
    if (/postgres/.test(about)) return { service: 'Amazon RDS', os: 'PostgreSQL' };
    if (/mysql/.test(about)) return { service: 'Amazon RDS', os: 'MySQL' };
    if (/maria/.test(about)) return { service: 'Amazon RDS', os: 'MariaDB' };
    if (/oracle/.test(about)) return { service: 'Amazon RDS', os: 'Oracle' };
    if (/sql server/.test(about)) return { service: 'Amazon RDS', os: 'SQL Server' };
    return { service: 'Amazon RDS' };
  }
  if (/elasticache/.test(key)) return { service: 'Amazon ElastiCache' };
  if (/memorydb/.test(key)) return { service: 'Amazon MemoryDB' };
  if (/\bmq\b/.test(key)) return { service: 'Amazon MQ' };
  if (/opensearch/.test(key)) return { service: 'Amazon OpenSearch Service' };
  if (/application load balancer/.test(key)) return { service: 'Application Load Balancer' };
  if (/network load balancer/.test(key)) return { service: 'Network Load Balancer' };
  if (/\bs3\b/.test(key)) return { service: 'Amazon S3' };
  if (/\bwaf\b|web application firewall/.test(key)) return { service: 'AWS WAF' };
  return { service: text };
}

/**
 * The environment and category out of a group-hierarchy path.
 *
 * The export writes `Estimate > Environment > Category`, but the depth is counted rather
 * than the names assumed: a hierarchy a user typed by hand in the calculator's group box
 * can be two levels or four, and hardcoding "the middle is Sandbox/Production/DevOps"
 * would silently blank the environment of every export that does not use those words.
 * Four or more levels degrade the middle-and-last reading to second-to-last-as-category
 * with the remaining middles joined as the environment; two levels treat the first as the
 * environment, which is what a path with no estimate name in front of it means.
 */
function splitGroupHierarchy(hierarchy: string): { environment?: string; category?: string } {
  const segments = hierarchy.split(/\s*>\s*/).map(clean).filter(Boolean);
  if (segments.length >= 4) {
    return {
      environment: segments.slice(1, segments.length - 2).join(' > ') || undefined,
      category: segments[segments.length - 2],
    };
  }
  if (segments.length === 3) return { environment: segments[1], category: segments[2] };
  if (segments.length === 2) return { environment: segments[0], category: segments[1] };
  if (segments.length === 1) return { category: segments[0] };
  return {};
}

/**
 * Reads one Detailed Estimate table into resources, one resource per export row.
 *
 * Everything the row is billed on sits in the Configuration summary cell, so the cell is
 * parsed into pairs and the pairs are claimed by field: instance type, count, storage,
 * purchase terms, operating system. A pair that names a size AWS recognises never also
 * becomes an attribute (the export's OpenSearch rows repeat "Nodes (0), Instance type
 * (r5.2xlarge.search)" as a zeroed artefact of its own UI, and pricing the second
 * instance type would double the row), while a pair nothing claims -- Tenancy, Deployment
 * option, Workload -- is kept verbatim as an attribute, which is the lossless bucket the
 * canonical vocabulary already has.
 *
 * The export's own Monthly figure is recorded as the row's REPORTED figure and never as a
 * rate: the estimate is priced from live AWS rates, and the export's number exists so the
 * report can show a variance against it.
 */
function readCalculatorExport(
  sheet: SheetGrid,
  block: SheetBlock,
  header: string[],
  context: AnalysisContext,
): { count: number; monthlySum: number; environments: string[] } {
  const col = (test: (text: string) => boolean) =>
    header.findIndex((cell) => test(normaliseHeader(clean(cell))));
  const groupCol = col((text) => text.includes('group') && text.includes('hierarchy'));
  const regionCol = col((text) => text.includes('region'));
  const descriptionCol = col((text) => text.includes('description'));
  const serviceCol = col((text) => text.includes('service'));
  const monthlyCol = col((text) => text.includes('monthly'));
  const currencyCol = col((text) => text.includes('currency'));
  const configCol = col((text) => text.includes('configuration') && text.includes('summary'));
  const cell = (row: string[], at: number) => (at === -1 ? '' : clean(String(row[at] ?? '')));

  const environments: string[] = [];
  let count = 0;
  let monthlySum = 0;

  for (let r = block.headerRow! + 1; r <= block.end; r++) {
    const row = sheet.rows[r];
    if (!row) continue;
    const raw = row.map(clean).filter(Boolean).join(' | ');
    if (!raw) continue;

    // Every data row of a Detailed Estimate carries its group path. A populated row
    // without one is a footnote wedged into the table, and reading it as a resource
    // invents a machine named after a sentence.
    const hierarchy = cell(row, groupCol);
    if (!hierarchy) {
      warn(context, `${sheet.name} row ${r + 1}: no group hierarchy, so it was not read as a resource ("${raw.slice(0, 70)}").`);
      continue;
    }

    const description = cell(row, descriptionCol);
    const monthlyText = cell(row, monthlyCol);
    const currency = cell(row, currencyCol);
    const monthly = toNumber(monthlyText);
    noteCurrencies(context, `${monthlyText} ${currency}`);

    const notes = monthly !== undefined ? `exported monthly: ${monthlyText} ${currency}`.trim() : undefined;

    const pairs = parseConfigPairs(cell(row, configCol));
    let size: string | undefined;
    let quantity: string | undefined;
    let disk: number | undefined;
    let purchaseModel: string | undefined;
    let osText: string | undefined;
    const attributes: Array<{ label: string; value: string }> = [];

    for (const pair of pairs) {
      const key = normaliseHeader(pair.label);
      const value = clean(pair.value);

      // Claimed whole: a second instance-type pair is the export's zeroed artefact, not a
      // second machine, and an attribute repeating an instance type would read as one.
      if (CONFIG_INSTANCE.test(pair.label) || LOOSE_INSTANCE_TYPE.test(value.toLowerCase())) {
        if (size === undefined) size = value;
        continue;
      }
      if (CONFIG_COUNT.test(key)) {
        const parsed = toCount(value);
        // A count of 0 is the export declining to state one, not a fleet of none: the
        // first positive count wins, which on the real rows is the real configuration.
        if (quantity === undefined && parsed !== undefined && parsed > 0) quantity = String(parsed);
        continue;
      }
      if (CONFIG_PRICING.test(key)) {
        if (purchaseModel === undefined) purchaseModel = value;
        continue;
      }
      if (CONFIG_OS.test(key)) {
        if (osText === undefined) osText = value;
        continue;
      }
      if (key.includes('storage')) {
        const gb = toGigabytes(value);
        if (gb !== undefined) {
          if (disk === undefined && gb > 0) disk = gb;
          // Claimed when the pair states a size; a storage DESCRIPTION ("Storage Type
          // (EBS Only)", "Storage for each RDS instance (General Purpose SSD (gp3))")
          // parses to nothing and falls through as an attribute instead.
          continue;
        }
      }
      attributes.push({ label: pair.label.slice(0, 120), value: value.slice(0, 300) });
    }

    // The instance count of an EC2 row is nested inside the Workload pair's value, so it
    // is read from the pairs' text rather than their labels.
    if (quantity === undefined) {
      for (const pair of pairs) {
        const nested = NESTED_COUNT.exec(pair.value);
        if (nested && Number(nested[1]) > 0) { quantity = nested[1]; break; }
      }
    }

    const mapped = mapExportService(cell(row, serviceCol), description);
    const os = mapped.os ?? (osText ? osWithLicence(osText, mapped.service, notes) : undefined);
    const { environment, category } = splitGroupHierarchy(hierarchy);
    const region = findRegion(cell(row, regionCol));
    // The export states its region on every row -- the one place a workbook of this shape
    // states it -- so it is recorded for the insights the way the prose path records a
    // region stated once on an assumptions tab.
    if (region && !context.insights.regions.includes(region)) context.insights.regions.push(region);
    const rowAttributes = [
      ...(category ? [{ label: 'Category', value: category }] : []),
      ...attributes,
    ].slice(0, MAX_ATTRIBUTES);

    if (context.resources.length >= MAX_RESOURCES) {
      context.truncated = true;
      continue;
    }

    // The description names the resource before its spec ("k8s-master - 1 x m6i.large -
    // 120 GB gp3"); the whole text stays on `raw` either way.
    const name = description.split(/\s+-\s+/)[0] || undefined;
    const parsed: InventoryRow = {
      sheet: sheet.name,
      row: r + 1,
      name: name || undefined,
      environment,
      service: mapped.service,
      size,
      quantity,
      region,
      os,
      disk_gb: disk,
      purchase_model: purchaseModel,
      notes,
      raw: raw.slice(0, 600),
      attributes: rowAttributes.length ? rowAttributes : undefined,
    };

    context.resources.push({
      ...parsed,
      reported_monthly: monthly,
      ...declareBilling({ inventory: [parsed] }, `${sheet.name} row ${r + 1}`, context),
    });

    count++;
    const units = toCount(quantity ?? '') ?? 1;
    // Only a row with a size is a machine; an S3 bucket or a Web ACL counted here would
    // inflate "Machines listed" with things nobody would call one.
    if (size) context.insights.server_count += units;
    if (disk) context.insights.total_disk_gb += disk * units;
    if (environment && !environments.includes(environment)) environments.push(environment);
    if (monthly !== undefined) monthlySum += monthly;
  }

  if (!count) {
    warn(context, `${sheet.name}: a Detailed Estimate table was found at row ${block.headerRow! + 1} but none of its rows could be read as resources.`);
  }
  return { count, monthlySum, environments };
}

/**
 * Reads the Estimate summary block as the export's own stated monthly total.
 *
 * Only the first row whose monthly figure parses is taken -- the block also carries a
 * ",,* Includes upfront cost" note row -- and the figure is filed under `reported` with a
 * label a reader can act on, rather than under whatever text sits in the row's first cell
 * (the upfront "0"). The caller cross-checks it against the rows that were read.
 */
function readEstimateSummary(
  sheet: SheetGrid,
  block: SheetBlock,
  header: string[],
  context: AnalysisContext,
): number | undefined {
  const monthlyCol = header.findIndex((cell) => normaliseHeader(clean(cell)).includes('monthly'));
  if (monthlyCol === -1) return undefined;

  for (let r = block.headerRow! + 1; r <= block.end; r++) {
    const row = sheet.rows[r];
    if (!row) continue;
    const monthly = toNumber(clean(String(row[monthlyCol] ?? '')));
    if (monthly === undefined) continue;
    noteCurrencies(context, row.map(clean).filter(Boolean).join(' '));
    if (context.insights.reported.length < MAX_REPORTED) {
      context.insights.reported.push({
        sheet: sheet.name,
        label: `Estimate summary of ${sheet.name}, as calculated in the sheet`,
        monthly,
      });
    }
    return monthly;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Transposed inventories
// ---------------------------------------------------------------------------

/**
 * Reads one TRANSPOSED inventory: metrics down the first column, scenarios across it.
 *
 * The shape readInventory cannot see. docs/Digital_Assets.xlsx states one metric per row
 * ("Aurora instance class", "Aurora instance count", "Aurora storage (GB)") and one
 * scenario per column ("26-27" ... "30-31", then "Dev", "Testing (QA)", "UAT"), which
 * reaches column matching with nothing to match -- "26-27" is not a field name -- and so
 * produced rows carrying only raw text. The pipeline requires a service, a size or a vCPU
 * count to price a row, so every one of them was filtered out and the run died on
 * NO_PRICEABLE_ROWS. shared/metric-matrix.ts does the reading; this function is where its
 * result becomes resources, warnings and stated inferences.
 *
 * Three things it deliberately does NOT do:
 *
 *  - It does not sum the bands. Eight scenarios of the same landscape are eight ways to
 *    describe one estate, not eight estates, so server_count and total_disk_gb come from
 *    the first band only and a warning says which one.
 *  - It does not drop what it cannot price. A non-AWS vendor, a metric with no service and
 *    a count the author set to zero all come back as exclusions with a reason, because
 *    "Pinecone was not included" is a fact a reviewer must be able to see.
 *  - It does not hide the conversions. A row labelled "/yr" priced as a monthly figure is a
 *    silent 12x error, so every normalisation is recorded verbatim.
 */
function readMatrix(
  sheet: SheetGrid,
  header: string[],
  dataRows: string[][],
  firstDataRow: number,
  context: AnalysisContext,
): { bands: MetricBand[]; count: number } {
  const reading = readMetricMatrix(header, dataRows, firstDataRow);
  const insights = context.insights;

  let count = 0;
  const perBand = new Map<string, number>();
  for (const resource of reading.resources) {
    if (context.resources.length >= MAX_RESOURCES) {
      context.truncated = true;
      break;
    }
    const band = reading.bands.find((entry) => entry.key === resource.scenario);
    // The band is the environment for an environment matrix and a fiscal year otherwise.
    // Either way it is what separates one scenario's groups from another's downstream,
    // so it is carried on the row rather than inferred again later.
    const environment = band?.kind === 'environment' ? band.label : undefined;

    /**
     * The group's own cells, handed on exactly as the sheet wrote them.
     *
     * `usage_amount` below is these same cells already converted, and re-reading THAT would
     * apply a conversion a second time -- a per-year figure divided by twelve and then divided
     * by twelve again. The cells still carry their labels, which is the whole point: "avg
     * runtime (minutes)" reaches the unit contract as a duration in minutes, where a bare
     * 1440 arriving with the word "minutes" already discarded was read as a monthly runtime
     * and priced ten Fargate tasks a day as ten a month.
     */
    const declared = declareBilling(
      {
        metrics: [{
          sheet: sheet.name,
          scenario: band && { key: band.key, label: band.label, kind: band.kind },
          service: resource.service,
          environment,
          cells: resource.cells,
          notes: resource.notes,
        }],
      },
      `${sheet.name}: ${resource.metric}${resource.scenario ? ` (${resource.scenario})` : ''}`,
      context,
    );

    context.resources.push({
      sheet: sheet.name,
      row: resource.rows[0],
      name: resource.metric.slice(0, 120),
      scenario: resource.scenario,
      environment,
      service: resource.service,
      size: resource.size,
      quantity: resource.quantity,
      vcpu: resource.vcpu,
      ram_gb: resource.ram_gb,
      disk_gb: resource.disk_gb,
      usage_amount: resource.usage_amount,
      usage_unit: resource.usage_unit,
      metric: resource.metric,
      notes: resource.notes,
      raw: resource.raw.slice(0, 600),
      ...declared,
    });
    count++;
    perBand.set(resource.scenario, (perBand.get(resource.scenario) ?? 0) + 1);
  }

  const bands = reading.bands.map((band) => ({
    key: band.key,
    label: band.label,
    kind: band.kind,
    sheet: sheet.name,
    resource_count: perBand.get(band.key) ?? 0,
  }));
  insights.bands = [...(insights.bands ?? []), ...bands];
  insights.exclusions = [...(insights.exclusions ?? []), ...reading.exclusions];
  insights.conversions = [...(insights.conversions ?? []), ...reading.conversions];

  // Machine and disk counts describe ONE configuration. The first band is the one the
  // sheet leads with, and saying which it is costs a sentence and saves a reader from
  // reading an 8x estate.
  const first = reading.bands[0];
  if (first) {
    for (const resource of reading.resources.filter((entry) => entry.scenario === first.key)) {
      const quantity = toNumber(resource.quantity ?? '') ?? 1;
      insights.server_count += quantity;
      if (resource.disk_gb) insights.total_disk_gb += resource.disk_gb;
    }
  }

  if (!count) {
    warn(context, `${sheet.name}: the table at row ${firstDataRow} states metrics down the first column, but none of them could be priced.`);
    return { bands: reading.bands, count };
  }

  const kinds = new Set(reading.bands.map((band) => band.kind));
  const shape = kinds.has('period')
    ? 'consecutive periods, so their totals run one after another and must never be added together'
    : 'concurrent environments, so their totals do add up to the estate';
  warn(context, `${sheet.name}: read as ${reading.bands.length} scenario(s) (${reading.bands.map((band) => `${band.label}: ${perBand.get(band.key) ?? 0} row(s)`).join('; ')}) -- ${shape}.`);
  if (first) {
    warn(context, `${sheet.name}: the machine and storage totals describe "${first.label}" only, because the scenarios restate one estate rather than adding to it.`);
  }
  for (const line of reading.conversions.slice(0, 6)) {
    warn(context, `${sheet.name}: ${line}`);
  }
  for (const exclusion of reading.exclusions.slice(0, 6)) {
    warn(context, `${sheet.name}: ${exclusion.metric}${exclusion.scenario ? ` (${exclusion.scenario})` : ''} was not priced -- ${exclusion.reason}.`);
  }
  if (reading.exclusions.length > 6) {
    warn(context, `${sheet.name}: ${reading.exclusions.length - 6} further metric(s) were not priced; the full list is in the estimate's exclusions.`);
  }

  return { bands: reading.bands, count };
}

// ---------------------------------------------------------------------------
// Rates, reported costs and excerpts
// ---------------------------------------------------------------------------

/**
 * Renders a block as bounded text.
 *
 * The safety net behind every heuristic in this file. A rate card, a summary tab or a
 * page of assumptions that this module does not model structurally still reaches the
 * model verbatim, so "we could not classify it" never becomes "it was dropped". The
 * model reads a pipe-delimited table perfectly well; what it cannot do is read a
 * sheet nobody sent it.
 */
function blockExcerpt(sheet: SheetGrid, block: SheetBlock): string {
  const lines: string[] = [];
  let characters = 0;
  let shown = 0;
  const total = block.end - block.start + 1;

  for (let r = block.start; r <= block.end; r++) {
    const text = clean((sheet.rows[r] || []).map(clean).filter(Boolean).join(' | '));
    if (!text) continue;
    if (characters + text.length > EXCERPT_CHARS) {
      lines.push(`... ${total - shown} further row(s) not shown`);
      break;
    }
    lines.push(text);
    characters += text.length;
    shown++;
  }
  return lines.join('\n');
}

/**
 * Reads a rate table into rate-card entries, one per item PER PRICE COLUMN.
 *
 * These are the client's OWN assumed rates. They are never used to price anything --
 * the estimate comes from live AWS prices via the pricing tools -- but capturing them
 * is what makes the variance in the report possible: "the sheet assumed $0.05383/hr
 * for m6a.large; AWS currently publishes X". A rate that has drifted is the single
 * most common reason a client model disagrees with a real bill.
 *
 * One entry per column, not one per row, because a real rate card is a matrix: the
 * example workbook prices every instance type four ways (On-Demand and 3-Yr, Linux
 * and Windows). Keeping only one number per row would silently record m6a.large at
 * $0.14583 — the 3-year Windows rate — for a fleet that is 3-year Linux at $0.05383,
 * and a variance computed against the wrong rate is worse than no variance at all.
 */
function readRateTable(
  sheet: SheetGrid,
  block: SheetBlock,
  columns: Record<string, number>,
  header: string[],
  evidence: TableEvidence,
  context: AnalysisContext,
): number {
  // Every money column, each carrying its own heading as the unit. Falls back to a
  // single identified rate column, then to the last numeric cell in the row.
  const priceColumns = evidence.money.unit.length
    ? evidence.money.unit
    : [columns.hourly_rate, columns.monthly_total].filter((at): at is number => at !== undefined);

  const labelColumn = columns.instance_type ?? columns.service ?? columns.name;
  let added = 0;

  for (let r = block.headerRow! + 1; r <= block.end; r++) {
    const row = sheet.rows[r];
    if (!row) continue;
    if (context.insights.rate_card.length >= MAX_RATES) {
      warn(context, `Only the first ${MAX_RATES} rates on "${sheet.name}" were captured for comparison against live AWS prices.`);
      break;
    }

    const item = labelColumn !== undefined ? clean(String(row[labelColumn] ?? '')) : firstText(row);
    if (!item || isTotalRow(row)) continue;

    if (priceColumns.length) {
      for (const at of priceColumns) {
        const rate = toNumber(clean(String(row[at] ?? '')));
        if (rate === undefined) continue;
        const unit = clean(header[at] || '') || undefined;
        context.insights.rate_card.push({ sheet: sheet.name, item: item.slice(0, 120), unit, rate });
        added++;
      }
      continue;
    }

    // No column was identifiable as money: the rate is almost always the last number.
    for (let at = row.length - 1; at >= 0; at--) {
      const value = toNumber(clean(String(row[at] ?? '')));
      if (value === undefined) continue;
      context.insights.rate_card.push({
        sheet: sheet.name,
        item: item.slice(0, 120),
        unit: clean(header[at] || '') || undefined,
        rate: value,
      });
      added++;
      break;
    }
  }
  return added;
}

/**
 * Reads a cost summary table into reported monthly figures.
 *
 * Deliberately narrow: only a column the heading identifies as MONTHLY is recorded as
 * a monthly figure. A table of annual and 3-year totals is left to the verbatim
 * excerpt instead, because filing an annual number under `monthly` would understate a
 * comparison by a factor of twelve — a silent error of exactly the kind this whole
 * module exists to avoid. The excerpt keeps the headings, so the model reads
 * "Annualized (€) 414938" as what it is.
 */
function readCostTable(
  sheet: SheetGrid,
  block: SheetBlock,
  columns: Record<string, number>,
  context: AnalysisContext,
): number {
  const costColumn = columns.monthly_total ?? columns.monthly_compute;
  if (costColumn === undefined) return 0;
  let added = 0;

  for (let r = block.headerRow! + 1; r <= block.end; r++) {
    const row = sheet.rows[r];
    if (!row || context.insights.reported.length >= MAX_REPORTED) break;
    const label = firstText(row);
    const monthly = toNumber(clean(String(row[costColumn] ?? '')));
    if (!label || monthly === undefined) continue;
    context.insights.reported.push({ sheet: sheet.name, label: label.slice(0, 140), monthly });
    added++;
  }
  return added;
}

// ---------------------------------------------------------------------------
// Label/value blocks
// ---------------------------------------------------------------------------

const DR_LABEL = /\b(dr|disaster|secondary|failover|standby)\b/;
const PRIMARY_LABEL = /\b(primary|main|home|target|production|prod)\b/;
const PLACE_LABEL = /\b(region|location|site|zone|datacenter|data center|geography)\b/;
const RATE_LABEL = /\b(rate|price|cost per|per hour|per hr|per gb|hourly|unit)\b/;
const MONTHLY_LABEL = /\b(monthly|per month|month)\b/;

/**
 * Reads a label/value block for facts, and for the settings that govern pricing.
 *
 * This is where the region actually comes from on a real workbook. The example file
 * has no region column anywhere in its 110-row inventory -- it states the region once,
 * as "Primary region | AWS Frankfurt (eu-central-1)" on the assumptions tab. A parser
 * that only reads tables prices the whole landscape in the wrong region.
 */
function readFacts(sheet: SheetGrid, block: SheetBlock, context: AnalysisContext): number {
  const pairs = readKeyValues(sheet.rows, block);
  const insights = context.insights;

  for (const { label, value } of pairs) {
    if (!label || !value) continue;
    const key = normaliseHeader(label);
    const joined = `${label} ${value}`;
    const region = findRegion(joined);

    if (region) {
      if (!insights.regions.includes(region)) insights.regions.push(region);
      if (PLACE_LABEL.test(key) || region) {
        if (DR_LABEL.test(key)) insights.dr_region = insights.dr_region || region;
        else if (PRIMARY_LABEL.test(key) || !insights.primary_region) {
          insights.primary_region = insights.primary_region || region;
        }
      }
    }

    noteCurrencies(context, joined);
    noteFxPair(context, sheet.name, label, value);
    noteFxCandidate(context, sheet.name, joined);

    const numeric = toNumber(value);
    if (numeric !== undefined) {
      // An FX rate turns the sheet's reported figures into the currency the client
      // reads; without it a EUR total and a USD estimate look wildly different.
      if (FX_LABEL_HINT.test(label)) {
        // Already recorded by noteFxPair. Never filed as a rate or a cost: an exchange
        // rate is neither, and 1.14 sitting in the rate card would be read as a price.
      } else if (MONTHLY_LABEL.test(key) && /\b(cost|total|spend|charge)\b/.test(key)) {
        if (insights.reported.length < MAX_REPORTED) {
          insights.reported.push({ sheet: sheet.name, label: label.slice(0, 140), monthly: numeric });
        }
      } else if (RATE_LABEL.test(key)) {
        if (insights.rate_card.length < MAX_RATES) {
          insights.rate_card.push({ sheet: sheet.name, item: label.slice(0, 120), rate: numeric });
        }
      }
    }

    if (insights.facts.length < MAX_FACTS) {
      insights.facts.push({ sheet: sheet.name, label: label.slice(0, 140), value: value.slice(0, 300) });
    }
  }

  return pairs.length;
}

/**
 * Promotes a label/value block that describes one machine into a resource.
 *
 * Some sheets are written one server per block -- "Hostname: app01 / vCPU: 8 / RAM:
 * 32 GB / Instance: m6i.2xlarge" -- rather than one server per row. Treating those as
 * assumptions would lose the entire inventory. The block is turned into a synthetic
 * two-row table (labels as the header, values as the single data row) and put through
 * exactly the same column matching and row reading as a real table, so there is one
 * implementation of what a machine means rather than two.
 *
 * Gated hard, because the cost of a false positive here is a fabricated server. A
 * block qualifies only if its VALUES describe a machine: an instance type, or a vCPU
 * and RAM pair. Neither an assumptions list nor a rate card can satisfy that, and both
 * previously did — the example workbook's storage-rate block was promoted into a
 * "server" named 0.028 with a 1.5GB disk, and a scope paragraph became a server whose
 * name was a 200-character sentence.
 */
function promoteKeyValueBlock(sheet: SheetGrid, block: SheetBlock, context: AnalysisContext): number {
  const pairs = readKeyValues(sheet.rows, block);
  if (pairs.length < 2) return 0;

  // A machine is described in a handful of short labels. Prose and rate cards are not.
  if (pairs.length > 25) return 0;
  if (pairs.some((pair) => pair.label.length > 60)) return 0;

  const header = pairs.map((pair) => pair.label);
  const values = pairs.map((pair) => pair.value);
  const { columns, scores } = matchColumnsScored(header, INVENTORY_FIELDS);

  const namesAnInstance = values.some((value) => INSTANCE_TYPE.test(clean(value).toLowerCase()));
  const specced = columns.vcpu !== undefined && columns.ram_gb !== undefined
    && toNumber(values[columns.vcpu]) !== undefined && toNumber(values[columns.ram_gb]) !== undefined;
  if (!namesAnInstance && !specced) return 0;

  const evidence = buildEvidence(header, [values], columns, scores, header.length);
  if (classifyTable(columns, 1, evidence) !== 'inventory') return 0;

  const synthetic: SheetGrid = { name: sheet.name, index: sheet.index, rows: [header, values] };
  return readInventory(synthetic, { kind: 'table', start: 0, end: 1, headerRow: 0 }, columns, context);
}

// ---------------------------------------------------------------------------
// Currency and FX
// ---------------------------------------------------------------------------

const CURRENCY_BY_SYMBOL: Record<string, string> = {
  '$': 'USD', '€': 'EUR', '£': 'GBP', '₹': 'INR', '¥': 'JPY', 'A$': 'AUD', 'S$': 'SGD',
};
const CURRENCY_CODE = /\b(usd|eur|gbp|inr|aud|sgd|aed|jpy|cad|chf|zar|brl|sek)\b/gi;

/**
 * An FX quote stating both currencies and the number: "1 EUR = 1.14 USD".
 *
 * The only form that is unambiguous, so it outranks everything else.
 */
const FX_EXPLICIT = /\b1\s*([a-z]{3})\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*([a-z]{3})/i;

/**
 * A labelled rate: "FX rate: 1.14", "Exchange rate | 1.14".
 *
 * The number must not be glued to a letter, which is what stops "see Pricing
 * Inputs!B31" from being read as an exchange rate of 31 — a real misread from this
 * workbook that would have converted every reported figure by a factor of 27.
 */
const FX_LABELLED = /\b(fx|exchange|conversion)\b[^0-9]{0,40}(?:^|[^0-9A-Za-z.])([0-9]+(?:\.[0-9]+)?)/i;

/**
 * A label whose VALUE lives in the next cell: "EUR to USD rate (1 EUR = X USD)".
 *
 * The commonest spreadsheet idiom for an input cell, and unreadable from the label
 * alone — the X is a placeholder. Both the Pricing Inputs and TCO Summary tabs of the
 * example workbook write it this way, with different numbers beside them.
 */
const FX_LABEL_HINT = /\b(fx|exchange|conversion)\b|\b1\s*[a-z]{3}\s*=\s*x\s*[a-z]{3}\b|\b[a-z]{3}\s*(?:to|per|\/)\s*[a-z]{3}\s+rate\b/i;

/** Records every currency mentioned, so the dominant one can be reported at the end. */
function noteCurrencies(context: AnalysisContext, text: string): void {
  for (const [symbol, code] of Object.entries(CURRENCY_BY_SYMBOL)) {
    if (text.includes(symbol)) bump(context.currencyHits, code);
  }
  for (const match of text.matchAll(CURRENCY_CODE)) bump(context.currencyHits, match[0].toUpperCase());
}

const bump = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);

/** An FX rate has to be a conversion. Exactly 1 is the identity, i.e. nothing was said. */
const plausibleFx = (rate: number) =>
  Number.isFinite(rate) && rate > 0 && rate !== 1 && rate <= 1_000;

/**
 * Records an FX candidate rather than committing to it, with how firmly it was stated.
 *
 * A workbook that has been revised carries more than one: the example file states 1.14
 * on its Pricing Inputs tab, both in prose and as a label/value pair, and 1.5 on the
 * TCO Summary tab which claims to reference the first. Picking one silently would
 * convert a reported total wrongly by a third, so every candidate is kept with its
 * tier, the firmest statement wins, and a genuine disagreement produces a warning the
 * reader can act on -- "your summary tab is using a stale rate" is worth knowing.
 */
function noteFxCandidate(context: AnalysisContext, sheet: string, text: string, tier = 1): void {
  const explicit = FX_EXPLICIT.exec(text);
  if (explicit && explicit[1].toUpperCase() !== explicit[3].toUpperCase()) {
    const rate = Number(explicit[2]);
    if (plausibleFx(rate)) context.fxCandidates.push({ sheet, rate, tier: 0 });
    return;
  }
  const labelled = FX_LABELLED.exec(text);
  if (labelled) {
    const rate = Number(labelled[2]);
    if (plausibleFx(rate)) context.fxCandidates.push({ sheet, rate, tier });
  }
}

/** Handles a label/value pair whose label announces an FX rate the value supplies. */
function noteFxPair(context: AnalysisContext, sheet: string, label: string, value: string): void {
  if (!FX_LABEL_HINT.test(label)) return;
  const rate = toNumber(value);
  if (rate !== undefined && plausibleFx(rate)) context.fxCandidates.push({ sheet, rate, tier: 1 });
}

/** Settles the currency and FX rate once every sheet has been seen. */
function resolveCurrency(context: AnalysisContext): void {
  const insights = context.insights;

  if (!insights.currency && context.currencyHits.size) {
    const ranked = [...context.currencyHits.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    insights.currency = ranked[0][0];
    if (ranked.length > 1 && insights.facts.length < MAX_FACTS) {
      insights.facts.push({
        sheet: insights.file_name ?? 'workbook',
        label: 'Currencies used in this workbook',
        value: ranked.map(([code, hits]) => `${code} (${hits} mention(s))`).join(', '),
      });
    }
  }

  if (!context.fxCandidates.length) return;

  const byRate = new Map<number, { rate: number; tier: number; sheets: string[] }>();
  for (const candidate of context.fxCandidates) {
    const entry = byRate.get(candidate.rate) ?? { rate: candidate.rate, tier: candidate.tier, sheets: [] };
    entry.tier = Math.min(entry.tier, candidate.tier);
    if (!entry.sheets.includes(candidate.sheet)) entry.sheets.push(candidate.sheet);
    byRate.set(candidate.rate, entry);
  }
  // Firmest statement first, then most corroborated, then lowest for determinism.
  const ranked = [...byRate.values()].sort(
    (a, b) => a.tier - b.tier || b.sheets.length - a.sheets.length || a.rate - b.rate,
  );
  insights.fx_rate = insights.fx_rate ?? ranked[0].rate;

  if (ranked.length > 1) {
    warn(
      context,
      `The workbook states more than one exchange rate: ${ranked.map((entry) => `${entry.rate} (${entry.sheets.join(', ')})`).join('; ')}. ${ranked[0].rate} was used to interpret the figures the sheet reports, being the most explicitly stated. Live AWS pricing is quoted in USD and is unaffected.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function emptyInsights(fileName?: string): WorkbookInsights {
  return {
    file_name: fileName,
    sheets: [],
    regions: [],
    facts: [],
    rate_card: [],
    reported: [],
    excerpts: [],
    server_count: 0,
    total_disk_gb: 0,
    dr_eligible_count: 0,
  };
}

/**
 * Reads a whole workbook into resources plus everything else worth knowing.
 *
 * The order is deliberate: structure first (layers 1 and 2), then meaning. Every
 * sheet is visited, every block within it is classified, and anything not turned into
 * a resource is still carried forward as a fact, a rate, a reported figure or an
 * excerpt. If no sheet yields a single resource, the largest table is passed through
 * as raw text rather than the upload being rejected -- a sheet we cannot structure is
 * still a sheet the model can read.
 */
export async function analyseWorkbook(buffer: Buffer, fileName: string): Promise<WorkbookAnalysis> {
  const document = await readWorkbookDocument(buffer, fileName);
  const sheets = document.sheets;
  const context: AnalysisContext = {
    resources: [],
    insights: emptyInsights(fileName),
    warnings: [],
    truncated: false,
    currencyHits: new Map(),
    fxCandidates: [],
    excerptCandidates: [],
    sheetTotals: new Map(),
    canonicalRows: [],
    canonicalExclusions: [],
    canonicalConversions: new Set(),
    canonicalScenarios: new Map(),
    canonicalInputRows: 0,
    canonicalMetricCells: 0,
    canonicalAccountedMetricCells: 0,
  };

  if (!sheets.length) {
    context.warnings.push('The workbook contained no readable sheets.');
    return {
      ...context,
      legacyResources: context.resources,
      canonicalModel: canonicalModelOf(context),
      workbookIR: document.ir,
    };
  }

  const tables: Array<{ sheet: SheetGrid; block: SheetBlock; rows: number; kind: TableKind }> = [];
  let order = 0;

  for (const sheet of sheets) {
    const blocks = findBlocks(sheet.rows);
    const detail: string[] = [];
    /** The export rows this sheet yielded, to cross-check against its stated total. */
    let exportRowCount = 0;
    let exportMonthlySum = 0;
    const exportEnvironments: string[] = [];
    /** The Estimate summary's own monthly figure, when this sheet is a calculator export. */
    let statedMonthly: number | undefined;

    for (const block of blocks) {
      order++;

      // A table block, or a prose block that is really a grid nobody put a heading on.
      // Positional headings ("column 1", "column 2") match no alias by design: every
      // field then has to be claimed from the VALUES, which is the only thing there is
      // to go on. This is the difference between reading a hand-typed export and
      // rejecting it.
      const headerless = block.kind === 'prose' && looksLikeGrid(sheet.rows, block);
      if ((block.kind === 'table' && block.headerRow !== undefined) || headerless) {
        const headerRow = headerless ? undefined : block.headerRow!;
        const dataStart = headerRow === undefined ? block.start : headerRow + 1;
        const dataRows = sheet.rows.slice(dataStart, block.end + 1);
        const dataRowCount = dataRows.length;
        const width = Math.max(...dataRows.map((row) => row.length), 1);
        const header = headerRow === undefined
          ? Array.from({ length: width }, (_, at) => `column ${at + 1}`)
          : composeHeader(sheet.rows, headerRow);

        // An AWS Pricing Calculator export, BEFORE the generic classification. Its
        // Detailed Estimate table carries Service and money columns like a cost summary,
        // so left to classifyTable it reads as one and its rows reach the pipeline with
        // no size and no count -- every one of them then refused as unpriceable. The
        // export's whole resource shape lives in the Configuration summary cell, which
        // only this reader knows how to open. A headerless grid can never match: the
        // signature is made of the headings themselves.
        if (headerRow !== undefined && isCalculatorExportTable(header)) {
          const read = readCalculatorExport(sheet, block, header, context);
          exportRowCount += read.count;
          exportMonthlySum += read.monthlySum;
          for (const environment of read.environments) {
            if (!exportEnvironments.includes(environment)) exportEnvironments.push(environment);
          }
          detail.push(read.count
            ? `AWS Pricing Calculator export: ${read.count} resource row(s)`
              + (read.environments.length
                ? `, ${read.environments.length} environment(s) (${read.environments.slice(0, 6).join(', ')}${read.environments.length > 6 ? ' and more' : ''})`
                : '')
            : `AWS Pricing Calculator export at row ${headerRow + 1}: no resource rows could be read`);
          tables.push({ sheet, block, rows: dataRowCount, kind: 'inventory' });
          continue;
        }

        // The export's Estimate summary: one stated total, kept as a reported figure and
        // cross-checked after the sheet's blocks are read, rather than run through
        // readCostTable where its totals row is filed under whatever sits in its first
        // cell -- on the real export, the upfront figure "0".
        if (headerRow !== undefined && isCalculatorEstimateSummary(header)) {
          statedMonthly = readEstimateSummary(sheet, block, header, context);
          detail.push(statedMonthly !== undefined
            ? `estimate summary at row ${headerRow + 1}: the export's own total of ${statedMonthly} per month, kept as a reported figure`
            : `estimate summary at row ${headerRow + 1}: no monthly total could be read`);
          tables.push({ sheet, block, rows: dataRowCount, kind: 'costs' });
          continue;
        }

        const { columns: matched, scores } = matchColumnsScored(header, INVENTORY_FIELDS);
        const { columns, inferred } = inferColumnsFromData(matched, dataRows, header.length);
        const evidence = buildEvidence(header, dataRows, columns, scores, header.length);
        const kind = classifyTable(columns, dataRowCount, evidence);

        // A synthetic block, so readInventory/readRateTable can share one code path
        // whether or not the sheet supplied a heading row.
        const readable: SheetBlock = headerRow === undefined
          ? { kind: 'table', start: block.start, end: block.end, headerRow: block.start - 1 }
          : block;

        header.forEach((cell) => noteCurrencies(context, cell));
        if (inferred.length && (kind === 'inventory' || kind === 'rates')) {
          detail.push(`columns read from their values: ${inferred.map((entry) => entry.field).join(', ')}`);
        }
        if (headerless) detail.push(`table with no heading row at row ${block.start + 1}, columns identified from their values`);

        if (kind === 'inventory') {
          const count = readInventory(sheet, readable, columns, context);
          detail.push(`${count} resource row(s) from the table at row ${(headerRow ?? block.start) + 1}`);
          tables.push({ sheet, block, rows: dataRowCount, kind });
          crossCheckTotal(sheet, readable, columns, context);
          continue;
        }

        // Not an inventory. Before writing it off as a rate card, a cost summary or text,
        // check whether it is an inventory TRANSPOSED: metrics down the first column,
        // scenario bands across the top. That shape reaches column matching with nothing
        // to match -- "26-27" is not a field name -- so it lands here every time, and
        // until this branch existed it fell through to the free-text path and produced
        // rows with no service, no size and no spec, which is precisely the input the
        // pipeline throws NO_PRICEABLE_ROWS on.
        //
        // Guarded on the headings carrying no money word, because "Item | Monthly Cost |
        // Annual Cost" has the same silhouette and readCostTable below reads it correctly.
        const banded = headerRow !== undefined
          && !header.some((cell) => MONEY_WORDS.some((word) => normaliseHeader(cell).includes(word)))
          && looksLikeMetricMatrix(header, dataRows);
        if (banded) {
          const added = readMatrix(sheet, header, dataRows, dataStart, context);
          detail.push(added.bands.length > 1
            ? `${added.bands.length} scenario bands (${added.bands.map((band) => band.label).join(', ')}) at row ${headerRow! + 1}, ${added.count} resource row(s) in total`
            : `one scenario band at row ${headerRow! + 1}, ${added.count} resource row(s)`);
          tables.push({ sheet, block, rows: dataRowCount, kind: 'matrix' });
          // Offered at inventory priority: the excerpt is how the model sees the metric
          // wording for anything the roles above could not classify.
          offerExcerpt(sheet, block, context, 1, order);
          continue;
        }

        if (kind === 'rates') {
          const added = readRateTable(sheet, readable, columns, header, evidence, context);
          detail.push(`rate card at row ${(headerRow ?? block.start) + 1}: ${added} rate(s) captured for comparison`);
        } else if (kind === 'costs') {
          const added = readCostTable(sheet, readable, columns, context);
          detail.push(added
            ? `cost summary at row ${(headerRow ?? block.start) + 1}: ${added} monthly figure(s) the sheet reports`
            : `cost summary at row ${(headerRow ?? block.start) + 1}, not stated monthly; passed through as text`);
        } else {
          detail.push(`unclassified table at row ${(headerRow ?? block.start) + 1}, passed through as text`);
        }

        tables.push({ sheet, block, rows: dataRowCount, kind });
        offerExcerpt(sheet, block, context, kind === 'other' ? 0 : 1, order);
        continue;
      }

      if (block.kind === 'keyvalue') {
        const promoted = promoteKeyValueBlock(sheet, block, context);
        if (promoted) {
          detail.push(`${promoted} resource(s) described as label/value pairs at row ${block.start + 1}`);
          continue;
        }
        const count = readFacts(sheet, block, context);
        if (count) detail.push(`${count} setting(s) at row ${block.start + 1}`);
        continue;
      }

      // Prose: a title, a banner or a note. Short ones are noise; anything with a
      // sentence in it may carry a constraint nothing else records -- on the example
      // workbook the FX rate and both regions are stated only in prose.
      const text = blockExcerpt(sheet, block);
      const region = findRegion(text);
      if (region && !context.insights.regions.includes(region)) context.insights.regions.push(region);
      noteCurrencies(context, text);
      noteFxCandidate(context, sheet.name, text);
      // A stray "FX rate used (1 EUR = X USD): | 1.5" row inside a note block: the
      // label announces the rate and the cell beside it holds the number. Scanned row
      // by row because the joined text loses which cell was the label.
      for (let r = block.start; r <= block.end; r++) {
        const cells = (sheet.rows[r] || []).map(clean).filter(Boolean);
        if (cells.length === 2) noteFxPair(context, sheet.name, cells[0], cells[1]);
      }
      if (text.length > 40) offerExcerpt(sheet, block, context, 2, order);
    }

    // The export's Estimate summary is an independent check on the rows just read, in
    // exactly the role a footer total plays for an inventory sheet: if the rows sum to
    // something else, either a row was skipped or a group was collapsed in the export,
    // and an estimate built on that is wrong in a way nobody would notice otherwise.
    if (statedMonthly !== undefined && statedMonthly !== 0 && exportRowCount > 0) {
      context.sheetTotals.set(sheet.name, Math.round(exportMonthlySum * 100) / 100);
      const drift = Math.abs(exportMonthlySum - statedMonthly) / Math.abs(statedMonthly);
      if (drift > 0.01) {
        warn(
          context,
          `On "${sheet.name}" the ${exportRowCount} export row(s) read sum to ${exportMonthlySum.toFixed(2)} per month but the Estimate summary says ${statedMonthly.toFixed(2)} (${(drift * 100).toFixed(1)}% apart). The rows were used; check the export for groups that were collapsed or filtered out.`,
        );
      }
    }

    context.insights.sheets.push({
      name: sheet.name,
      rows: sheet.rows.length,
      detail: detail.join('; ') || 'nothing priceable found; passed through as text',
    });
  }

  // Last resort: nothing on this workbook read as a resource, so hand the most
  // substantial thing on it over as text. Rejecting the upload is the one outcome the
  // user cannot work around, and the model can interpret a pipe-delimited table.
  //
  // Deliberately NOT done when an inventory table was recognised and read: rows that
  // an understood table declined genuinely have nothing priceable in them, the per-row
  // warnings say which ones and why, and re-admitting them as raw text would both
  // contradict those warnings and invent machines out of comment lines.
  if (!context.resources.length && !tables.some((entry) => entry.kind === 'inventory' || entry.kind === 'matrix')) {
    const table = tables.length
      ? tables.reduce((best, entry) => (entry.rows > best.rows ? entry : best), tables[0])
      : undefined;

    let sheetName = '';
    let rows: string[][] = [];
    let firstRow = 0;
    let structured = false;

    if (table) {
      structured = true;
      sheetName = table.sheet.name;
      // Skip a heading row only if there was one. A grid nobody put headings on starts
      // at its first row, and taking that row for a header would silently drop a machine.
      firstRow = table.block.headerRow !== undefined ? table.block.headerRow + 1 : table.block.start;
      rows = table.sheet.rows.slice(firstRow, table.block.end + 1);
    } else {
      // No table anywhere. This is the sheet somebody typed their landscape into as
      // prose or as label/value pairs -- "two web servers, medium sized | mumbai" --
      // which segments as anything but a table and would otherwise vanish entirely.
      const populated = (sheet: SheetGrid) => sheet.rows.filter((row) => row.some((cell) => clean(cell) !== '')).length;
      // Two rows minimum: a single row is a title or an orphaned heading, and pricing
      // that as a resource would invent a machine out of a label.
      const biggest = sheets
        .filter((sheet) => populated(sheet) >= 2)
        .reduce<SheetGrid | undefined>((best, sheet) => (!best || populated(sheet) > populated(best) ? sheet : best), undefined);
      if (biggest) { sheetName = biggest.name; rows = biggest.rows; }
    }

    rows.forEach((row, offset) => {
      if (context.resources.length >= MAX_RESOURCES) return;
      const raw = row.map(clean).filter(Boolean).join(' | ');
      if (raw) context.resources.push({ sheet: sheetName, row: firstRow + offset + 1, raw: raw.slice(0, 600) });
    });

    if (context.resources.length) {
      context.warnings.unshift(structured
        ? `No column headings on "${sheetName}" could be matched to a resource, so its ${context.resources.length} row(s) were passed through as text for interpretation. Prices will be less precise than with a recognisable Service, Instance or Size column.`
        : `Nothing on "${sheetName}" is laid out as a table, so its ${context.resources.length} row(s) were passed through as text for interpretation. Prices will be less precise than with a sheet that has Service, Instance or Size columns.`);
    }
  }

  if (context.truncated) {
    context.warnings.unshift(`Only the first ${MAX_RESOURCES} resource rows were read; the rest were skipped. Split the workbook if it needs to be priced in full.`);
  }

  // A region stated once anywhere governs everything, so fall back to any code seen.
  if (!context.insights.primary_region && context.insights.regions.length) {
    context.insights.primary_region = context.insights.regions[0];
  }
  resolveCurrency(context);
  selectExcerpts(context);
  context.insights.total_disk_gb = Math.round(context.insights.total_disk_gb * 100) / 100;

  // What the sheet itself says its inventory costs per month. Computed from the rows
  // rather than lifted from a footer, so it corresponds exactly to the rows that were
  // read -- crossCheckTotal has already warned if those two disagree.
  const reportedRows = context.resources.filter((resource) => resource.reported_monthly !== undefined);
  if (reportedRows.length) {
    const total = reportedRows.reduce((sum, resource) => sum + (resource.reported_monthly ?? 0), 0);
    context.insights.reported_monthly_total = Math.round(total * 100) / 100;
  }

  return {
    ...context,
    legacyResources: context.resources,
    canonicalModel: canonicalModelOf(context),
    workbookIR: document.ir,
  };
}

/**
 * True for a heading-less block that is nonetheless tabular.
 *
 * Requires real width and more than one row, so a two-cell "Region | eu-central-1"
 * note is not mistaken for a table. Segmentation has already routed genuine
 * label/value blocks elsewhere, so what reaches here is either a grid or a paragraph.
 */
function looksLikeGrid(rows: string[][], block: SheetBlock): boolean {
  const populated: number[] = [];
  for (let r = block.start; r <= block.end; r++) {
    const count = (rows[r] || []).filter((cell) => cell.trim() !== '').length;
    if (count) populated.push(count);
  }
  if (populated.length < 2) return false;
  const widest = Math.max(...populated);
  if (widest < 3) return false;
  // Most rows share the widest shape: a paragraph wrapped across cells does not.
  return populated.filter((count) => count >= widest - 1).length / populated.length >= 0.6;
}

/**
 * Checks the rows just read against the total the sheet itself footed.
 *
 * Not decoration. If a footer says 33042.56 and the rows sum to something else, either
 * a row was skipped or a column was misread, and an estimate built on that is wrong in
 * a way nobody would notice. The sheet's own arithmetic is the only independent check
 * available, so it is used as one.
 */
function crossCheckTotal(
  sheet: SheetGrid,
  block: SheetBlock,
  columns: Record<string, number>,
  context: AnalysisContext,
): void {
  const at = columns.monthly_total;
  if (at === undefined) return;

  let footer: number | undefined;
  let sum = 0;
  let counted = 0;
  for (let r = block.headerRow! + 1; r <= block.end; r++) {
    const row = sheet.rows[r];
    if (!row) continue;
    const value = toNumber(clean(String(row[at] ?? '')));
    if (value === undefined) continue;
    if (isTotalRow(row)) footer = footer ?? value;
    else { sum += value; counted++; }
  }
  if (footer === undefined || !counted || footer === 0) return;

  context.sheetTotals.set(sheet.name, sum);
  const drift = Math.abs(sum - footer) / Math.abs(footer);
  if (drift > 0.01) {
    warn(
      context,
      `On "${sheet.name}" the ${counted} rows read sum to ${sum.toFixed(2)} but the sheet's own total row says ${footer.toFixed(2)} (${(drift * 100).toFixed(1)}% apart). The rows were used; check that sheet for hidden or filtered lines.`,
    );
  }
}

/** Records an excerpt candidate. Which ones survive is decided by selectExcerpts. */
function offerExcerpt(
  sheet: SheetGrid,
  block: SheetBlock,
  context: AnalysisContext,
  priority: number,
  order: number,
): void {
  const text = blockExcerpt(sheet, block);
  if (!text) return;
  context.excerptCandidates.push({ sheet: sheet.name, order, priority, text });
}

/** Keeps the most informative excerpts within the cap, in sheet order. */
function selectExcerpts(context: AnalysisContext): void {
  const seen = new Set<string>();
  const chosen = context.excerptCandidates
    .slice()
    .sort((a, b) => a.priority - b.priority || a.order - b.order)
    .filter((candidate) => {
      // Drop a note already quoted inside a larger excerpt from the same sheet.
      const key = `${candidate.sheet}::${candidate.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_EXCERPTS)
    .sort((a, b) => a.order - b.order);

  context.insights.excerpts = chosen.map(({ sheet, text }) => ({ sheet, text }));

  // Only worth a warning when something UNSTRUCTURED was dropped. A note beside a cost
  // table whose figures were already read is not a loss, and a warning the reader
  // cannot act on only teaches them to ignore the ones that matter.
  const kept = new Set(chosen);
  const lost = context.excerptCandidates.filter((entry) => entry.priority === 0 && !kept.has(entry));
  if (lost.length) {
    warn(context, `${lost.length} table(s) that could not be classified were not passed through in full: ${[...new Set(lost.map((entry) => entry.sheet))].join(', ')}. Check those sheets if a figure looks missing.`);
  }
}
