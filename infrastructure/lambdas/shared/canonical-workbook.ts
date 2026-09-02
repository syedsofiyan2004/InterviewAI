/**
 * The canonical workbook: the ONE shape every uploaded spreadsheet becomes before anything
 * tries to price it.
 *
 * Why this exists. The upload path had been growing a branch per customer layout — a flat
 * server inventory here, a transposed capacity model there, and a third reader waiting to be
 * written for stacked per-environment sections. Each branch produced a slightly different
 * row, so the pricing layer had to re-derive what a number meant from whatever fields
 * happened to be filled in. That is where the information went missing, and it went missing
 * in three specific, verifiable places:
 *
 *  - `usage_amount` and `usage_unit` are read off a metric matrix (shared/metric-matrix.ts
 *    :511-512), stored on the row (schema/calculator.ts :132-134), written through by the
 *    analyser (api-handler/calculator-workbook.ts :897-898) — and then read by nothing. Grep
 *    `usage_amount` across `lambdas/` and the orchestrator does not appear. Every managed
 *    service in a capacity model is parsed perfectly and then priced as though it were not
 *    there. Parsed and dropped is the purest form of loss, because the file looks understood.
 *  - `calculator-orchestrator/pipeline.ts` :699-714 is a two-way branch: if the AWS unit
 *    contains `gb-mo`, treat the quantity as gigabytes, OTHERWISE multiply the rate by
 *    `billedHours` and the machine count. There is no third case, so a per-request or
 *    per-invocation rate becomes "rate x 730 hrs/month" and prints a workings line that
 *    reads as arithmetic.
 *  - Fargate has no model at all. `planFromGroup` (pipeline.ts :272-351) recognises an RDS
 *    instance type and an EC2 instance type and returns `undefined` for everything else, and
 *    metric-matrix.ts :489-493 already records the reason it cannot help: Fargate has no rate
 *    for a task, only for a vCPU-hour and a GB-hour. A Fargate row cannot survive that path
 *    intact no matter how well it was parsed.
 *
 * So the fix is not another reader. It is a single row shape in which **every quantity
 * carries an explicit CanonicalUnit**, and the two properties that make that trustworthy:
 *
 *  1. Refusal instead of guessing. A label whose dimension cannot be read becomes a stated
 *     exclusion carrying the label and a reason. It never becomes a plausible unit. The old
 *     `readUnit` ends in `: 'units/month'` — a default — and a default is a guess with no
 *     one to notice it.
 *  2. Losslessness that can be proved rather than claimed. Every canonical row carries the
 *     sheet, the 1-based row, the section heading, the label and the raw value exactly as
 *     they appeared; every input row leaves as a canonical row or as an exclusion; and
 *     `accounting` exposes the counts so a caller — or a test — can assert the books balance
 *     instead of trusting that they do. A row that is neither priced nor excluded is a
 *     dropped row, and this module is built so that dropping one is a failed assertion.
 *
 * Two deliberate non-goals, matching unit-contract.ts:
 *
 *  - It is pure. No filesystem, no AWS SDK, no ExcelJS. It takes rows a reader already
 *    produced and returns rows, so the whole of it is testable by arithmetic.
 *  - It does not read spreadsheets and it does not group metric rows into resources. Those
 *    are the readers' jobs and they already do them. This module's only subject is meaning:
 *    what the number counts, and what was done to it to get it onto a monthly basis.
 */

import type { BillingKind, CanonicalUnit } from './unit-contract.js';
import {
  HOURS_PER_MONTH,
  INSTANCE_UNIT,
  hoursFromPerDay,
  perYearToPerMonth,
} from './unit-contract.js';
import { numberFrom, roleFor } from './metric-matrix.js';

/** Collapses newlines and runs of whitespace; sheet cells routinely contain both. */
const clean = (text: string) => String(text ?? '').replace(/\s+/g, ' ').trim();

/** Lowercased, punctuation-free, collapsed — the form every label match below is written against. */
const normalise = (text: string) => clean(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Two decimals. A converted annual figure otherwise carries the sheet's float noise forward. */
const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Days in a billing month, DERIVED from the contract's month rather than stated as 30.
 *
 * A per-day count and a runtime in hours end up multiplied together on a Fargate row, so if
 * this said 30 while `HOURS_PER_MONTH` said 730 the two halves of the same month would
 * disagree by 1.4% and no test would say which was wrong.
 */
const DAYS_PER_MONTH = HOURS_PER_MONTH / 24;

const MINUTES_PER_HOUR = 60;

// ---------------------------------------------------------------------------
// What comes out
// ---------------------------------------------------------------------------

/**
 * Where a figure came from, in the terms the person who typed it would recognise.
 *
 * The whole of the losslessness claim rests on this being present and untransformed. `value`
 * is the cell text BEFORE any conversion on purpose: once a "(millions/yr)" figure has been
 * expanded and divided, 10,000,000 is unrecognisable next to the 120 the author typed, and a
 * reviewer checking the estimate against the file has nothing to match on.
 */
export interface CellProvenance {
  sheet?: string;
  /** 1-based sheet row, matching what the user sees in Excel. */
  row?: number;
  /**
   * The stacked-section heading this row sat under.
   *
   * Load-bearing for the third layout and meaningless for the other two. docs/Core BOM.xlsx
   * puts "Server", "Database", "Loadbalancer", "OpenSearch", "Redis", "MQ", "MemoryDB" and
   * "WAF" in a merged column A and gives each section its OWN header row, so column C is
   * "Cpu" in one section and "class" in the next. Without the section name a row's columns
   * cannot be interpreted at all, and there is nowhere else in the vocabulary to put it.
   */
  section?: string;
  /** The label exactly as the sheet wrote it, units and typos included. */
  label: string;
  /** The value exactly as the sheet wrote it, before any conversion. */
  value: string;
}

/**
 * One monthly quantity with its dimension declared.
 *
 * A row holds an array of these rather than a single number because several real resources
 * are billed on more than one dimension at once and collapsing them loses the shape: a
 * Fargate task is vCPU-hours AND GB-hours, a machine is runtime hours AND a gp3 volume, and
 * a Core BOM server row states three separately named disks in three columns.
 */
export interface CanonicalQuantity {
  /** The dimension. Not optional, not inferable downstream — this is the point of the module. */
  unit: CanonicalUnit;
  /** The amount, already on a monthly basis and already scaled for `count` where one applies. */
  amount: number;
  originalValue?: number | string;
  originalUnit?: string;
  originalScale?: string;
  originalPeriod?: string;
  derivedValue?: number | string;
  derivedUnit?: string;
  derivedScale?: string;
  derivedPeriod?: string;
  conversionFormula?: string;
  /** What this dimension buys, for the report's workings line: "task vCPU", "Os Storage". */
  basis: string;
  /**
   * Every conversion applied, one prose line each, in the order applied.
   *
   * Empty when the sheet's number was already a monthly figure in the right dimension. Never
   * silently non-empty: the surrounding `CanonicalWorkbook.conversions` republishes these so
   * a caller that never looks at a row still sees that a divide-by-twelve happened.
   */
  conversions: string[];
}

/** Which scenario a row belongs to, keyed to CalculationScenario.key. */
export interface CanonicalScenario {
  key: string;
  label: string;
  /** Absent when the reader could not tell. See CalculationScenarioSchema.kind for why it matters. */
  kind?: 'sizing' | 'period' | 'environment';
}

/**
 * The physical shape a priced row was sized from.
 *
 * `count` x `hoursPerUnit` is deliberately one idea covering two things that look different:
 * for an EC2 row it is machines x their monthly runtime, and for a Fargate batch row it is
 * task-RUNS a month x the length of a run. Keeping them one expression is what lets a
 * per-day count and a duration in minutes reach the vCPU-hour dimension without a second
 * code path, which is exactly where the "10 tasks per day priced as 10 a month" bug lived.
 */
export interface CanonicalShape {
  /** The instance/node class as the sheet wrote it, untouched — "r7g.large.search(2c16g)" and all. */
  size?: string;
  os?: string;
  purchaseModel?: string;
  /** Machines, nodes or task-runs this row stands for. Never 0; a stated 0 is an exclusion. */
  count: number;
  countOriginalValue?: number | string;
  countOriginalUnit?: string;
  countOriginalPeriod?: string;
  countDerivedValue?: number | string;
  countDerivedUnit?: string;
  countDerivedPeriod?: string;
  countConversionFormula?: string;
  durationOriginalValue?: number | string;
  durationOriginalUnit?: string;
  durationOriginalPeriod?: string;
  durationDerivedValue?: number | string;
  durationDerivedUnit?: string;
  durationConversionFormula?: string;
  vcpu?: number;
  ramGb?: number;
  /** Runtime hours a month for ONE unit of `count`. */
  hoursPerUnit: number;
}

/** A single figure on an otherwise usable row that could not be given a dimension. */
export interface UnpricedCell {
  provenance: CellProvenance;
  reason: string;
}

/**
 * One canonical resource row.
 *
 * Strictly an EXTENSION of CalculationResourceSchema's vocabulary, not a rival to it: every
 * field here either exists there under the same name or is one of the three things that
 * schema has no room for (an explicit unit per quantity, a section heading, and free
 * label/value attributes). Nothing is renamed, so a reader can keep emitting what it emits.
 */
export interface CanonicalRow {
  /** Stable citation handle: sheet, row and ordinal, so two bands of one row differ. */
  id: string;
  /**
   * What this row is billed on. Never 'excluded' — an excluded row is not a row, it is an
   * entry in `exclusions`, and giving it a seat here is how an omission becomes invisible.
   */
  billing: Exclude<BillingKind, 'excluded'>;
  /** The AWS service name as the reader identified it, or undefined when it could not. */
  service?: string;
  /** The sheet's own wording for this row, so a line item can be traced back to it. */
  label: string;
  scenario?: CanonicalScenario;
  environment?: string;
  region?: string;
  shape?: CanonicalShape;
  /** At least one. A row with none is an exclusion, by construction. */
  quantities: CanonicalQuantity[];
  /**
   * Everything the sheet said that no dimension and no shape field claimed.
   *
   * The lossless bucket for the third layout, where the columns are per-section and there is
   * no fixed vocabulary to map them onto: "Available Zone", "Multi-AZ", "Listener", "target
   * port/protocl" (the sheet's typo, kept), "number of replicas", "Dedicated master". Today
   * those survive only inside a joined `raw` string, which is unreadable and unqueryable.
   */
  attributes: Array<{ label: string; value: string }>;
  provenance: CellProvenance[];
  /** Figures on this row that could not be given a dimension. Stated, never dropped. */
  unpriced: UnpricedCell[];
  notes?: string;
}

/**
 * A row deliberately not priced, and why. A superset of WorkbookExclusionSchema's fields.
 *
 * Carries the provenance and the attributes as well as the reason, because an exclusion is
 * the half of the output someone has to ACT on: "the row states no quantity" is only
 * actionable next to the sheet, the row number and the columns that were there.
 */
export interface CanonicalExclusion {
  /** The sheet's own label, so the row is findable in the file. */
  label: string;
  scenario?: string;
  reason: string;
  attributes: Array<{ label: string; value: string }>;
  provenance: CellProvenance[];
}

/**
 * The books. Exposed so losslessness is an assertion a caller makes, not a promise this
 * module makes about itself.
 */
export interface CanonicalAccounting {
  /** Rows handed in, across every input shape. */
  inputRows: number;
  canonicalRows: number;
  exclusions: number;
  /**
   * Metric cells handed in on `metrics` groups, and how many were accounted for — as a
   * canonical quantity, as a shape field, as an attribute, or as a stated `unpriced` note.
   *
   * Counted separately from rows because a metric group is MANY cells collapsed into one
   * row, so the row-level balance below cannot see a single cell going missing inside a
   * group that otherwise priced fine. A flat inventory row is one row and no cells, so these
   * are both 0 for the flat and stacked-section layouts.
   */
  metricCells: number;
  accountedMetricCells: number;
  /** Every input row and every input cell is accounted for. */
  balanced: boolean;
}

export interface CanonicalWorkbook {
  rows: CanonicalRow[];
  exclusions: CanonicalExclusion[];
  /** Every conversion applied anywhere, deduplicated, one prose line each. */
  conversions: string[];
  /** Every scenario seen, in first-appearance order, so a band is never lost to grouping. */
  scenarios: CanonicalScenario[];
  accounting: CanonicalAccounting;
}

// ---------------------------------------------------------------------------
// What goes in
// ---------------------------------------------------------------------------

/**
 * One already-assembled resource row.
 *
 * Structurally a subset of CalculationResource, so whatever api-handler/
 * calculator-workbook.ts already pushes assigns to this with no change at either end. Three
 * fields are additions the existing readers do not fill yet: see `section`, `disks` and
 * `attributes`.
 */
export interface InventoryRow {
  sheet?: string;
  row?: number;
  name?: string;
  environment?: string;
  service?: string;
  size?: string;
  /** As text, because the sheet's column is text — "2", "2 x", "N/A". */
  quantity?: string;
  region?: string;
  os?: string;
  vcpu?: number;
  ram_gb?: number;
  disk_gb?: number;
  purchase_model?: string;
  hoursPerDay?: number;
  hoursPerMonth?: number;
  notes?: string;
  raw: string;
  /** The band key, resolved against `CanonicalInput.scenarios`. */
  scenario?: string;
  usage_amount?: number;
  usage_unit?: string;
  metric?: string;

  /** The stacked-section heading. Needs adding to CalculationResourceSchema; see the module docstring. */
  section?: string;
  /**
   * Separately named disks, when the sheet gave several.
   *
   * A Core BOM server row has "Os Storage", "Data storage for /app" and "Data storage for
   * /app/logs" as three columns with three different values and one of them frequently
   * "N/A". Summing them into `disk_gb` prices the right total and loses which volume is
   * which, which is the difference between an estimate a client can check and one they
   * cannot.
   */
  disks?: Array<{ label: string; gb: number }>;
  /** Section-specific columns with no home in the fixed vocabulary. */
  attributes?: Array<{ label: string; value: string }>;
}

/** One labelled cell of a transposed matrix, in one band. */
export interface MetricCell {
  /** 1-based sheet row. */
  row?: number;
  /** The metric label exactly as the sheet wrote it, units and all. */
  label: string;
  /** The cell value exactly as the sheet wrote it, UNCONVERTED. */
  value: string;
}

/**
 * The metric cells a reader attributed to one resource in one band.
 *
 * Grouping is metric-matrix.ts's job and it already does it well — "Aurora instance class",
 * "Aurora instance count" and "Aurora storage (GB)" are one database, not three. What it
 * does not do is hand the cells on: `MatrixResource` keeps only a joined `raw` string and an
 * already-converted `usage_amount`, so the unconverted value and the per-cell row number are
 * gone by the time anything could use them. This is the shape that reader should emit; see
 * the report for the change.
 */
export interface MetricGroupRow {
  sheet?: string;
  section?: string;
  scenario?: CanonicalScenario;
  /** The AWS service the reader identified from the labels, or undefined. */
  service?: string;
  environment?: string;
  region?: string;
  cells: MetricCell[];
  notes?: string;
}

export interface CanonicalInput {
  /** Flat server inventory and stacked-section sheets: one row, one resource. */
  inventory?: InventoryRow[];
  /** Transposed metric matrix: many labelled cells, one resource, one band. */
  metrics?: MetricGroupRow[];
  /** The bands a reader detected, so an inventory row's `scenario` key resolves to a label. */
  scenarios?: CanonicalScenario[];
  /**
   * Runtime to assume for an hours-billed row that states none.
   *
   * Defaults to the whole month. Whatever it is, the assumption is written into the row's
   * conversions rather than applied quietly, because "we assumed 24x7" is the single
   * likeliest reason an estimate reads high and it must be visible on the row that made it.
   */
  defaultHoursPerDay?: number;
}

// ---------------------------------------------------------------------------
// Reading a dimension out of a label
// ---------------------------------------------------------------------------

export type UnitInference =
  | { ok: true; unit: CanonicalUnit; amount: number; conversions: string[]; measurement: {
    originalValue: number;
    originalUnit: string;
    originalScale?: string;
    originalPeriod: 'month' | 'year' | 'day' | 'unspecified';
    derivedValue: number;
    derivedUnit: CanonicalUnit;
    derivedScale: 'whole';
    derivedPeriod: 'month';
    conversionFormula?: string;
  } }
  | { ok: false; reason: string };

/**
 * The canonical dimensions a label's noun can name, longest and most specific first.
 *
 * Order is the whole correctness argument, so each entry says what it is protecting itself
 * from. Anything not matched here is a refusal, not a fallback.
 */
const DIMENSIONS: Array<[CanonicalUnit, RegExp]> = [
  // Before every gb rule: "Lambda (BFF) GB-seconds/yr" normalises to "gb seconds" and would
  // otherwise read as storage and be priced per GB-month.
  ['GB-seconds/month', /\bgb sec(ond)?s?\b|\bgigabyte seconds?\b/],
  ['vCPU-hours/month', /\bv?cpu (hours?|hrs?)\b/],
  ['GB-hours/month', /\bgb (hours?|hrs?)\b/],
  // Bare "iops" only. "Aurora I/O requests (millions/yr)" is a request count billed per
  // million, not provisioned IOPS, and it normalises to "i o requests" — which this misses
  // on purpose and the requests rule below catches.
  ['IOPS/month', /\biops\b|\bprovisioned io\b/],
  // Transfer BEFORE storage. They are different rates on the same service, and a transfer
  // figure priced as storage is wrong every month while looking entirely plausible. Written
  // as two anchored lookaheads rather than one sequence because the two words appear in
  // either order — "CloudFront data transfer (GB/month)" and "NAT Gateway data processed
  // (GB/yr)" — and an order-sensitive pattern silently priced the second one as storage.
  ['GB-transfer/month', /^(?=.*\b(gb|gib|gigabytes?|tb|terabytes?)\b)(?=.*\b(transfer|transferred|egress|ingress|outbound|inbound|data out|bandwidth|processed|replicated|replication|cdn)\b)/],
  ['GB/month', /\b(gb|gib|gigabytes?|tb|terabytes?)\b/],
  ['invocations/month', /\binvocations?\b/],
  // Deliberately no "query"/"queries" here. "Redshift active query hours/yr" is measured in
  // hours, and claiming it as requests took the row away from the rule below it; a bare
  // query count is a countable and lands in 'units/month' instead.
  ['requests/month', /\b(requests?|api calls?|calls?)\b/],
  ['hours/month', /\b(hours?|hrs?)\b/],
  // Minutes resolve to hours, converted below. The user's own case: a runtime written as
  // 1440 minutes where the calculator wanted 730 hours.
  ['hours/month', /\b(minutes?|mins?)\b/],
  // The escape hatch, and reached only by NAMING a countable. unit-contract.ts makes
  // 'units/month' refuse against every hour spelling, so nothing that lands here can be
  // multiplied by a runtime even if this rule fired on the wrong noun.
  ['units/month', /\b(mau|monthly active users?|users?|readers?|authors?|seats?|subscriptions?|licen[cs]es?|units?|blocks?|events?|transitions?|transactions?|interactions?|notifications?|messages?|emails?|documents?|docs?|vectors?|records?|objects?|queries|query|rpu|streams?|shards?|endpoints?|certificates?|secrets?|keys?)\b/],
];

/** Whether the label states minutes, which is the only dimension needing a sub-hour divide. */
const MINUTES = /\b(minutes?|mins?)\b/;

/**
 * Reads a dimension out of a metric label and puts the value on a monthly basis.
 *
 * Everything AWS bills is monthly and a capacity model is written annually, so a conversion
 * is the normal case rather than the exception — and every one of them is returned in prose
 * beside the number. That is not politeness. A silent divide by twelve is indistinguishable
 * from a reader that never saw the "/yr", and those two have opposite fixes.
 *
 * The refusal branch is the reason the function exists. `readUnit` in metric-matrix.ts ends
 * `: 'units/month'`, so "Peak-to-average traffic ratio (assumption)" comes back as 1.4
 * billable units a month and looks like a finished line item. Here it comes back as a
 * sentence saying no dimension could be read, which someone fixes.
 */
export function inferUnit(label: string, value: number): UnitInference {
  const text = normalise(label);
  if (!text) {
    return { ok: false, reason: 'The figure carried no label, so there was nothing to read a dimension from.' };
  }

  const perYear = /\b(yr|yrs|year|years|yearly|annual|annually|pa|per annum)\b/.test(text);
  const perDay = /\b(day|days|daily|diem)\b/.test(text);
  const perMonth = /\b(month|months|monthly|mo|mth)\b/.test(text);

  // Two periods on one label is a contradiction the sheet has to resolve, not us. Picking
  // either one is a 365x decision made on a coin toss.
  if (perYear && perDay) {
    return {
      ok: false,
      reason: `The label "${clean(label)}" states both a per-year and a per-day basis, so the period it `
        + 'is measured over is ambiguous. The figure is left unpriced rather than converted on a guess.',
    };
  }

  let unit: CanonicalUnit | undefined;
  for (const [candidate, pattern] of DIMENSIONS) {
    if (pattern.test(text)) { unit = candidate; break; }
  }
  if (!unit) {
    return {
      ok: false,
      reason: `The label "${clean(label)}" does not name anything AWS meters, so no unit could be read from `
        + 'it. The figure is recorded as an exclusion rather than given a plausible unit, because a guessed '
        + 'dimension prices confidently and wrongly.',
    };
  }

  let amount = value;
  const conversions: string[] = [];
  const originalPeriod = perYear ? 'year' : perDay ? 'day' : perMonth ? 'month' : 'unspecified';
  const originalUnit = MINUTES.test(text) ? 'minutes'
    : unit === INSTANCE_UNIT ? 'hours'
      : unit.replace(/\/month$/, '');
  let originalScale: string | undefined;

  // Scale expansions first, because "(millions/yr)" has to become units before it becomes
  // units a month: 120 -> 120,000,000 -> 10,000,000. Doing it the other way round is the
  // same arithmetic, but doing it in one step is where a factor gets dropped.
  if (/\bmillions?\b|\bmn\b/.test(text)) {
    amount *= 1_000_000;
    originalScale = 'millions';
    conversions.push('millions expanded to whole units (x 1,000,000)');
  } else if (/\bbillions?\b/.test(text)) {
    amount *= 1_000_000_000;
    originalScale = 'billions';
    conversions.push('billions expanded to whole units (x 1,000,000,000)');
  } else if (/\bthousands?\b/.test(text)) {
    amount *= 1_000;
    originalScale = 'thousands';
    conversions.push('thousands expanded to whole units (x 1,000)');
  }
  // "CloudFront requests (10,000-unit blocks/month)" — a block size stated in the LABEL, as
  // opposed to one stated in the AWS unit, which unit-contract's blockSize handles.
  const blocks = /\b(\d+) (\d{3}) unit blocks?\b/.exec(text) ?? /\b(\d{3,}) unit blocks?\b/.exec(text);
  if (blocks) {
    const size = Number(blocks.slice(1).filter(Boolean).join(''));
    amount *= size;
    originalScale = `${size}-unit blocks`;
    conversions.push(`${size.toLocaleString('en-US')}-unit blocks expanded to whole units`);
  }

  if (perYear && !perMonth) {
    const converted = perYearToPerMonth(amount);
    amount = converted.amount;
    conversions.push(converted.conversion);
  } else if (perDay && !perMonth) {
    amount *= DAYS_PER_MONTH;
    conversions.push(`per-day figure multiplied by ${round2(DAYS_PER_MONTH)} days to a monthly basis`);
  }

  if (MINUTES.test(text)) {
    amount /= MINUTES_PER_HOUR;
    conversions.push('minutes divided by 60 to runtime hours');
  }

  const derived = round2(amount);
  return {
    ok: true,
    unit,
    amount: derived,
    conversions,
    measurement: {
      originalValue: value,
      originalUnit,
      ...(originalScale ? { originalScale } : {}),
      originalPeriod,
      derivedValue: derived,
      derivedUnit: unit,
      derivedScale: 'whole',
      derivedPeriod: 'month',
      ...(conversions.length ? { conversionFormula: conversions.join('; ') } : {}),
    },
  };
}

/**
 * A CanonicalUnit named by a free-text unit string, or undefined.
 *
 * Exists to rescue the `usage_unit` strings metric-matrix.ts already produces, which are
 * prose rather than vocabulary: it emits "monthly active users", "vectors/month" and a bare
 * "GB". Anything this does not recognise falls back to re-reading the label, and if that
 * fails too the row is excluded — a `usage_unit` we cannot place is not evidence of a
 * dimension, and a bare "GB" in particular is the storage/transfer ambiguity that must not
 * be resolved by coin toss.
 */
export function canonicalUnitFrom(unitText: string): CanonicalUnit | undefined {
  const text = normalise(unitText);
  if (!text) return undefined;
  const exact: Record<string, CanonicalUnit> = {
    'hours month': 'hours/month',
    'gb month': 'GB/month',
    'gb transfer month': 'GB-transfer/month',
    'requests month': 'requests/month',
    'invocations month': 'invocations/month',
    'gb seconds month': 'GB-seconds/month',
    'vcpu hours month': 'vCPU-hours/month',
    'gb hours month': 'GB-hours/month',
    'iops month': 'IOPS/month',
    'units month': 'units/month',
    // The one piece of prose worth an alias: it is unambiguous, and Cognito MAU is in every
    // capacity model this feature has seen.
    'monthly active users': 'units/month',
  };
  if (exact[text]) return exact[text];
  // "vectors/month", "emails/month", "events/month" — a named countable per month is a bare
  // count and nothing else, so it maps. Deliberately does NOT accept "gb/..." or "hours/...":
  // those two are the pairs a wrong guess costs the most on.
  const counted = /^(vectors?|emails?|events?|transitions?|transactions?|notifications?|messages?|documents?|text units?|units?|calls?|users?) month$/;
  if (counted.test(text)) return 'units/month';
  return undefined;
}

// ---------------------------------------------------------------------------
// Numbers that arrive wearing a qualifier
// ---------------------------------------------------------------------------

/**
 * A number and whatever the author wrote next to it.
 *
 * `numberFrom` correctly refuses "3000(GP3)", and docs/Core BOM.xlsx puts exactly that in
 * its IOPS column — the provisioned IOPS and the volume type in one cell. Refusing loses the
 * 3000; parsing it and discarding "(GP3)" loses the volume type, which is a different rate.
 * So both come back and the qualifier becomes an attribute on the row.
 */
export function numberWithQualifier(text: string): { amount?: number; qualifier?: string } {
  const cleaned = clean(text);
  if (!cleaned) return {};
  const direct = numberFrom(cleaned);
  if (direct !== undefined) return { amount: direct };
  const leading = /^[^0-9.+-]*(-?\d+(?:[.,]\d+)?)\s*(.*)$/.exec(cleaned);
  if (!leading) return { qualifier: cleaned };
  const amount = Number(leading[1].replace(/,/g, ''));
  if (!Number.isFinite(amount)) return { qualifier: cleaned };
  return { amount, qualifier: clean(leading[2]) || undefined };
}

// ---------------------------------------------------------------------------
// Cell roles, for a metric group
// ---------------------------------------------------------------------------

type CellRole = 'class' | 'duration' | 'vcpu' | 'memory' | 'storage' | 'count' | 'usage';

/**
 * Wording that identifies a cell whose number is a LENGTH of time rather than an amount of it.
 *
 * The one role metric-matrix.ts's vocabulary does not carry, because that reader has no use
 * for one: it reads a duration as usage and nothing downstream ever asked it not to. Tested
 * BEFORE the shared patterns rather than after, because "avg runtime hours per task" contains
 * "task" and `roleFor` therefore calls it a count -- and a run LENGTH read as a number of runs
 * is the "10 tasks per day priced as 10 a month" bug with its two operands swapped, failing
 * the same way, silently and low.
 */
const DURATION = /\b(duration|runtime|run time|execution time|elapsed|time per)\b/;

/**
 * Wording metric-matrix.ts reads as a count and this file must not.
 *
 * "capacity" reaches that reader's `count` pattern only after `storage` has had its chance, so
 * what is left of it is the DynamoDB and FSx sense: "read capacity units", "throughput
 * capacity (MB/s)". Those are amounts billed BY the unit, not numbers of machines, and a
 * number in `shape.count` is multiplied by a month of runtime -- 2,000,000 read capacity units
 * would leave here as 1.46 billion vCPU-hours.
 */
const NOT_A_COUNT = /\bcapacity\b/;

/**
 * The role a label states, ignoring anything in parentheses.
 *
 * The parenthetical is commentary, and reading a role out of it inverts the row: metric-
 * matrix.ts :253-261 records the actual failure -- "ECS Fargate task count (1 vCPU/2GB each)"
 * is a COUNT of tasks, and matching `vcpu` in the aside turned 5 tasks into a 5-vCPU machine.
 * Units still come from the FULL label, because the aside is the only place a unit is ever
 * written.
 *
 * The vocabulary is metric-matrix.ts's, shared rather than restated. The two readers have to
 * agree about what "Aurora instance class" is -- one groups the cells and the other prices
 * them -- and two copies of six regular expressions agree only until someone edits one of
 * them. Sharing also fixes the precedence for free: `class` still outranks `count` there, for
 * the same "Aurora instance class contains instance" reason it did here.
 */
function roleOf(label: string): CellRole {
  const text = normalise(label.replace(/\([^)]*\)/g, ' '));
  const shared = roleFor(text);
  // A class cell holds a name, not a number, so there is nothing in it for a duration to be
  // read out of and nothing gained by looking: "r7g.large" is a size whatever else is said.
  if (shared === 'class') return 'class';
  if (DURATION.test(text)) return 'duration';
  if (shared === 'count') return NOT_A_COUNT.test(text) ? 'usage' : 'count';
  // Two names for one role. This file's is the one CanonicalShape's field uses.
  return shared === 'ram' ? 'memory' : shared;
}

/** A vCPU/RAM aside out of a label: "(1 vCPU/2GB each)", "(2 vCPU, 4 GiB per task)". */
function specFromAside(label: string): { vcpu?: number; ramGb?: number } {
  const asides = label.match(/\(([^)]*)\)/g);
  if (!asides) return {};
  const text = asides.join(' ');
  const vcpu = /(\d+(?:\.\d+)?)\s*v?cpus?\b/i.exec(text);
  const ram = /(\d+(?:\.\d+)?)\s*(gb|gib)\b/i.exec(text);
  return { vcpu: vcpu ? Number(vcpu[1]) : undefined, ramGb: ram ? Number(ram[1]) : undefined };
}

/** True when this row is Fargate, which has no per-task rate and so needs decomposing. */
function isFargate(...text: Array<string | undefined>): boolean {
  return /\bfargate\b/i.test(text.filter(Boolean).join(' '));
}

// ---------------------------------------------------------------------------
// Normalising
// ---------------------------------------------------------------------------

/**
 * Runtime hours a month for one unit, and the sentence explaining where they came from.
 *
 * Stated even when nothing was converted, because the interesting case is the LAST one: a
 * row that said nothing about its schedule and was therefore priced 24x7 is the commonest
 * reason an estimate reads high, and it has to be legible on the row that assumed it.
 */
function runtimeFor(
  row: { hoursPerMonth?: number; hoursPerDay?: number },
  defaultHoursPerDay: number | undefined,
): { hours: number; conversions: string[] } {
  if (row.hoursPerMonth !== undefined && row.hoursPerMonth > 0) {
    return { hours: round2(row.hoursPerMonth), conversions: [] };
  }
  if (row.hoursPerDay !== undefined && row.hoursPerDay > 0) {
    const hours = hoursFromPerDay(row.hoursPerDay);
    return {
      hours,
      conversions: [`${row.hoursPerDay} hours a day scheduled as ${hours} runtime hours a month`],
    };
  }
  if (defaultHoursPerDay !== undefined && defaultHoursPerDay > 0 && defaultHoursPerDay < 24) {
    const hours = hoursFromPerDay(defaultHoursPerDay);
    return {
      hours,
      conversions: [`the row states no schedule, so the estimate default of ${defaultHoursPerDay} hours a day (${hours} hours a month) was applied`],
    };
  }
  return {
    hours: HOURS_PER_MONTH,
    conversions: [`the row states no schedule, so it is priced for the whole month (${HOURS_PER_MONTH} hours)`],
  };
}

/**
 * The two dimensions a Fargate task is actually billed on.
 *
 * The whole reason a Fargate row cannot survive the existing path: there is no rate for a
 * task. `planFromGroup` recognises an EC2 or RDS instance type and nothing else, so a task
 * count reaches the pricer as an opaque quantity and either fails to price or gets multiplied
 * by an hourly rate that belongs to something else. Decomposed here into the two dimensions
 * unit-contract.ts already names, with the task count, the per-task size and the runtime all
 * still on the row so a reviewer can redo the arithmetic.
 */
function fargateQuantities(shape: CanonicalShape, conversions: string[]): CanonicalQuantity[] {
  const taskHours = round2(shape.count * shape.hoursPerUnit);
  const scale = `${shape.count} task(s) x ${shape.hoursPerUnit} runtime hours = ${taskHours} task-hours a month`;
  const quantities: CanonicalQuantity[] = [];
  if (shape.vcpu !== undefined && shape.vcpu > 0) {
    quantities.push({
      unit: 'vCPU-hours/month',
      amount: round2(taskHours * shape.vcpu),
      basis: 'task vCPU',
      conversions: [...conversions, `${scale}, x ${shape.vcpu} vCPU per task`],
    });
  }
  if (shape.ramGb !== undefined && shape.ramGb > 0) {
    quantities.push({
      unit: 'GB-hours/month',
      amount: round2(taskHours * shape.ramGb),
      basis: 'task memory',
      conversions: [...conversions, `${scale}, x ${shape.ramGb} GB memory per task`],
    });
  }
  return quantities;
}

/** Disk columns as GB-month quantities, one per named volume so none of them merge. */
function diskQuantities(
  disks: Array<{ label: string; gb: number }>,
  count: number,
): CanonicalQuantity[] {
  return disks
    .filter((disk) => Number.isFinite(disk.gb) && disk.gb > 0)
    .map((disk) => ({
      unit: 'GB/month' as CanonicalUnit,
      amount: round2(disk.gb * count),
      basis: disk.label,
      // Storage is billed whether the machine is running or not, so the runtime hours the
      // compute dimension carries must never appear here. pipeline.ts :720-722 makes the
      // same point in the same words; this keeps it true by construction rather than by a
      // string check on a workings line.
      conversions: count > 1 ? [`${disk.gb} GB x ${count} = ${round2(disk.gb * count)} GB a month`] : [],
    }));
}

interface Sink {
  rows: CanonicalRow[];
  exclusions: CanonicalExclusion[];
  conversions: Set<string>;
  scenarios: Map<string, CanonicalScenario>;
  metricCells: number;
  accountedMetricCells: number;
}

function recordScenario(sink: Sink, scenario: CanonicalScenario | undefined): CanonicalScenario | undefined {
  if (!scenario) return undefined;
  if (!sink.scenarios.has(scenario.key)) sink.scenarios.set(scenario.key, scenario);
  return sink.scenarios.get(scenario.key);
}

function publish(sink: Sink, label: string, quantities: CanonicalQuantity[]): void {
  for (const quantity of quantities) {
    for (const conversion of quantity.conversions) sink.conversions.add(`${label}: ${conversion}`);
  }
}

/**
 * The billing kind a set of dimensions adds up to.
 *
 * `instance` only when the row is billed on runtime hours, because that is the one dimension
 * unit-contract.ts lets the pricer assume (INSTANCE_UNIT). Notably a Fargate row is NOT an
 * instance: its dimensions are vCPU-hours and GB-hours, and calling it an instance would
 * re-authorise exactly the "multiply by 730" shortcut this module exists to remove.
 */
function billingFor(quantities: CanonicalQuantity[]): Exclude<BillingKind, 'excluded'> {
  if (quantities.some((quantity) => quantity.unit === INSTANCE_UNIT)) return 'instance';
  if (quantities.every((quantity) => quantity.unit === 'GB/month')) return 'storage';
  return 'usage';
}

function normaliseInventoryRow(
  row: InventoryRow,
  index: number,
  input: CanonicalInput,
  byKey: Map<string, CanonicalScenario>,
  sink: Sink,
): void {
  const label = clean(row.metric || row.name || [row.service, row.size].filter(Boolean).join(' ') || row.raw)
    .slice(0, 300);
  const provenance: CellProvenance = {
    sheet: row.sheet,
    row: row.row,
    section: row.section,
    label,
    value: clean(row.raw).slice(0, 600),
  };
  const scenario = recordScenario(
    sink,
    row.scenario ? byKey.get(row.scenario) ?? { key: row.scenario, label: row.scenario } : undefined,
  );
  const attributes = [...(row.attributes ?? [])];
  const unpriced: UnpricedCell[] = [];

  const counted = numberWithQualifier(row.quantity ?? '');
  if (counted.qualifier) attributes.push({ label: 'quantity note', value: counted.qualifier });
  // A stated 0 is the author saying "not this scenario", and metric-matrix.ts :516-522
  // documents what pricing it anyway did: a Kafka cluster the author had ruled out appeared
  // in all eight scenarios. Absent is different from zero and is treated as one.
  if (counted.amount === 0) {
    sink.exclusions.push({
      label,
      scenario: scenario?.key,
      reason: 'its quantity is stated as 0, so the sheet is saying this resource is not in scope here',
      attributes,
      provenance: [provenance],
    });
    return;
  }
  const count = counted.amount !== undefined && counted.amount > 0 ? counted.amount : 1;

  const disks = row.disks ?? (row.disk_gb !== undefined && row.disk_gb > 0
    ? [{ label: 'disk', gb: row.disk_gb }]
    : []);

  const emit = (billing: Exclude<BillingKind, 'excluded'>, quantities: CanonicalQuantity[], shape?: CanonicalShape) => {
    publish(sink, label, quantities);
    sink.rows.push({
      id: `${row.sheet ?? 'sheet'}!${row.row ?? index + 1}#${index}`,
      billing,
      service: row.service,
      label,
      scenario,
      environment: row.environment,
      region: row.region,
      shape,
      quantities,
      attributes,
      provenance: [provenance],
      unpriced,
      notes: row.notes,
    });
  };

  const runtime = runtimeFor(row, input.defaultHoursPerDay);
  const machineLike = Boolean(row.size) || row.vcpu !== undefined || row.ram_gb !== undefined;

  if (isFargate(row.service, row.name, row.metric, row.section) && machineLike) {
    const shape: CanonicalShape = {
      size: row.size,
      os: row.os,
      purchaseModel: row.purchase_model,
      count,
      countOriginalValue: count,
      countOriginalUnit: 'units',
      countOriginalPeriod: 'unspecified',
      countDerivedValue: count,
      countDerivedUnit: 'units',
      countDerivedPeriod: 'month',
      vcpu: row.vcpu,
      ramGb: row.ram_gb,
      hoursPerUnit: runtime.hours,
    };
    const quantities = [...fargateQuantities(shape, runtime.conversions), ...diskQuantities(disks, count)];
    if (quantities.length) { emit('usage', quantities, shape); return; }
    sink.exclusions.push({
      label,
      scenario: scenario?.key,
      reason: 'Fargate is billed per vCPU-hour and per GB-hour, and the row states neither a task vCPU '
        + 'size nor a task memory size, so there is nothing to decompose it into',
      attributes,
      provenance: [provenance],
    });
    return;
  }

  if (machineLike) {
    const shape: CanonicalShape = {
      size: row.size,
      os: row.os,
      purchaseModel: row.purchase_model,
      count,
      countOriginalValue: count,
      countOriginalUnit: 'units',
      countOriginalPeriod: 'unspecified',
      countDerivedValue: count,
      countDerivedUnit: 'units',
      countDerivedPeriod: 'month',
      vcpu: row.vcpu,
      ramGb: row.ram_gb,
      hoursPerUnit: runtime.hours,
    };
    const hours: CanonicalQuantity = {
      unit: INSTANCE_UNIT,
      amount: round2(count * runtime.hours),
      basis: 'compute runtime',
      conversions: [
        ...runtime.conversions,
        ...(count > 1 ? [`${count} x ${runtime.hours} hours = ${round2(count * runtime.hours)} hours a month`] : []),
      ],
    };
    emit('instance', [hours, ...diskQuantities(disks, count)], shape);
    return;
  }

  // The loss this module was written for. usage_amount arrives already converted, which is
  // why the label is re-read when the unit string cannot be placed: the amount is usable and
  // only its dimension is missing.
  if (row.usage_amount !== undefined) {
    const unit = canonicalUnitFrom(row.usage_unit ?? '');
    if (unit) {
      emit('usage', [{ unit, amount: round2(row.usage_amount), basis: label, conversions: [] }]);
      return;
    }
    const inferred = inferUnit(row.metric || row.name || label, row.usage_amount);
    if (inferred.ok) {
      // The label is re-read for its DIMENSION only. Re-applying its conversions would
      // divide an already-divided figure by twelve a second time.
      emit('usage', [{
        unit: inferred.unit,
        amount: round2(row.usage_amount),
        originalValue: inferred.measurement.originalValue,
        originalUnit: inferred.measurement.originalUnit,
        originalScale: inferred.measurement.originalScale,
        originalPeriod: inferred.measurement.originalPeriod,
        derivedValue: round2(row.usage_amount),
        derivedUnit: inferred.measurement.derivedUnit,
        derivedScale: inferred.measurement.derivedScale,
        derivedPeriod: inferred.measurement.derivedPeriod,
        conversionFormula: inferred.measurement.conversionFormula,
        basis: label,
        conversions: [],
      }]);
      return;
    }
    sink.exclusions.push({
      label,
      scenario: scenario?.key,
      reason: `${inferred.reason} The sheet's own unit was recorded as "${clean(row.usage_unit ?? '')}", `
        + 'which does not name a dimension AWS meters either.',
      attributes,
      provenance: [provenance],
    });
    return;
  }

  if (disks.length) {
    emit('storage', diskQuantities(disks, count));
    return;
  }

  // Last resort: the row's own label plus its quantity column. This is how a stacked-section
  // sheet's "Buket Name | 200" storage row prices without a bespoke reader.
  const fallback = counted.amount !== undefined ? inferUnit(label, counted.amount) : undefined;
  if (fallback?.ok) {
    const quantity: CanonicalQuantity = {
      unit: fallback.unit,
      amount: fallback.amount,
      originalValue: fallback.measurement.originalValue,
      originalUnit: fallback.measurement.originalUnit,
      originalScale: fallback.measurement.originalScale,
      originalPeriod: fallback.measurement.originalPeriod,
      derivedValue: fallback.measurement.derivedValue,
      derivedUnit: fallback.measurement.derivedUnit,
      derivedScale: fallback.measurement.derivedScale,
      derivedPeriod: fallback.measurement.derivedPeriod,
      conversionFormula: fallback.measurement.conversionFormula,
      basis: label,
      conversions: fallback.conversions,
    };
    emit(billingFor([quantity]), [quantity]);
    return;
  }

  sink.exclusions.push({
    label,
    scenario: scenario?.key,
    reason: fallback && !fallback.ok
      ? fallback.reason
      : 'the row states no size, no specification, no quantity and no usage figure, so there is no '
        + 'dimension to price it on',
    attributes,
    provenance: [provenance],
  });
}

function normaliseMetricGroup(group: MetricGroupRow, index: number, input: CanonicalInput, sink: Sink): void {
  const label = group.cells.map((cell) => clean(cell.label)).filter(Boolean).join(' + ').slice(0, 300);
  const provenance: CellProvenance[] = group.cells.map((cell) => ({
    sheet: group.sheet,
    row: cell.row,
    section: group.section,
    label: clean(cell.label),
    value: clean(cell.value),
  }));
  const scenario = recordScenario(sink, group.scenario);
  const attributes: Array<{ label: string; value: string }> = [];
  const unpriced: UnpricedCell[] = [];
  const quantities: CanonicalQuantity[] = [];

  let size: string | undefined;
  let vcpu: number | undefined;
  let ramGb: number | undefined;
  let count: number | undefined;
  let countOriginalValue: number | string | undefined;
  let countOriginalPeriod: string | undefined;
  let countDerivedValue: number | string | undefined;
  let countConversionFormula: string | undefined;
  let countConversions: string[] = [];
  let runtimePerUnit: number | undefined;
  let runtimeOriginalValue: number | string | undefined;
  let runtimeOriginalUnit: string | undefined;
  let runtimeOriginalPeriod: string | undefined;
  let runtimeConversionFormula: string | undefined;
  let runtimeConversions: string[] = [];
  let countRows = 0;
  let countZeros = 0;

  group.cells.forEach((cell, cellIndex) => {
    sink.metricCells++;
    const text = clean(cell.value);
    const cellLabel = clean(cell.label);
    const at = provenance[cellIndex];
    // An empty cell is the sheet declining to state a figure for this band, not a figure
    // going missing, so it is accounted for and nothing is said about it.
    if (!text) { sink.accountedMetricCells++; return; }

    const role = roleOf(cellLabel);
    if (role === 'class') {
      size = text;
      sink.accountedMetricCells++;
      return;
    }

    const parsed = numberWithQualifier(text);
    if (parsed.qualifier) attributes.push({ label: cellLabel, value: parsed.qualifier });
    if (parsed.amount === undefined) {
      // Words on a numeric role. Kept verbatim as an attribute rather than coerced: "Yes",
      // "Single", "3node-cluster Broker" and "N/A" are all real values in Core BOM.xlsx and
      // none of them is a quantity.
      attributes.push({ label: cellLabel, value: text });
      sink.accountedMetricCells++;
      return;
    }

    switch (role) {
      case 'vcpu':
        vcpu = parsed.amount;
        sink.accountedMetricCells++;
        return;
      case 'memory':
        ramGb = parsed.amount;
        sink.accountedMetricCells++;
        return;
      case 'duration': {
        const reading = inferUnit(cellLabel, parsed.amount);
        if (reading.ok && reading.unit === INSTANCE_UNIT) {
          runtimePerUnit = reading.amount;
          runtimeOriginalValue = reading.measurement.originalValue;
          runtimeOriginalUnit = reading.measurement.originalUnit;
          runtimeOriginalPeriod = reading.measurement.originalPeriod;
          runtimeConversionFormula = reading.measurement.conversionFormula;
          runtimeConversions = reading.conversions;
          sink.accountedMetricCells++;
          return;
        }
        unpriced.push({
          provenance: at,
          reason: `"${cellLabel}" reads as a duration but no runtime unit could be taken from it, so the `
            + 'row is priced on its stated or default schedule instead.',
        });
        sink.accountedMetricCells++;
        return;
      }
      case 'count': {
        countRows++;
        if (parsed.amount === 0) { countZeros++; sink.accountedMetricCells++; return; }
        // A per-day count is the user's own bug: ten tasks a day read as ten a month. The
        // conversion travels with the count so it reaches the workings line of whichever
        // dimension the count ends up feeding, rather than being applied here and forgotten.
        countOriginalValue = parsed.amount;
        countOriginalPeriod = /\b(day|days|daily)\b/.test(normalise(cellLabel)) ? 'day'
          : /\b(yr|yrs|year|years|yearly|annual|annually)\b/.test(normalise(cellLabel)) ? 'year'
            : /\b(month|months|monthly|mo|mth)\b/.test(normalise(cellLabel)) ? 'month'
              : 'unspecified';
        if (/\b(day|days|daily)\b/.test(normalise(cellLabel))) {
          count = round2(parsed.amount * DAYS_PER_MONTH);
          countConversions = [`per-day count multiplied by ${round2(DAYS_PER_MONTH)} days to ${count} a month`];
          countConversionFormula = countConversions[0];
        } else {
          count = parsed.amount;
          countConversions = [];
          countConversionFormula = undefined;
        }
        countDerivedValue = count;
        const aside = specFromAside(cellLabel);
        if (aside.vcpu !== undefined && vcpu === undefined) vcpu = aside.vcpu;
        if (aside.ramGb !== undefined && ramGb === undefined) ramGb = aside.ramGb;
        sink.accountedMetricCells++;
        return;
      }
      case 'storage': {
        const reading = inferUnit(cellLabel, parsed.amount);
        if (reading.ok) {
          quantities.push({
            unit: reading.unit,
            amount: reading.amount,
            originalValue: reading.measurement.originalValue,
            originalUnit: reading.measurement.originalUnit,
            originalScale: reading.measurement.originalScale,
            originalPeriod: reading.measurement.originalPeriod,
            derivedValue: reading.measurement.derivedValue,
            derivedUnit: reading.measurement.derivedUnit,
            derivedScale: reading.measurement.derivedScale,
            derivedPeriod: reading.measurement.derivedPeriod,
            conversionFormula: reading.measurement.conversionFormula,
            basis: cellLabel,
            conversions: reading.conversions,
          });
        } else {
          unpriced.push({ provenance: at, reason: reading.reason });
        }
        sink.accountedMetricCells++;
        return;
      }
      default: {
        const reading = inferUnit(cellLabel, parsed.amount);
        if (reading.ok) {
          quantities.push({
            unit: reading.unit,
            amount: reading.amount,
            originalValue: reading.measurement.originalValue,
            originalUnit: reading.measurement.originalUnit,
            originalScale: reading.measurement.originalScale,
            originalPeriod: reading.measurement.originalPeriod,
            derivedValue: reading.measurement.derivedValue,
            derivedUnit: reading.measurement.derivedUnit,
            derivedScale: reading.measurement.derivedScale,
            derivedPeriod: reading.measurement.derivedPeriod,
            conversionFormula: reading.measurement.conversionFormula,
            basis: cellLabel,
            conversions: reading.conversions,
          });
        } else {
          unpriced.push({ provenance: at, reason: reading.reason });
        }
        sink.accountedMetricCells++;
      }
    }
  });

  const exclude = (reason: string) => {
    sink.exclusions.push({ label, scenario: scenario?.key, reason, attributes, provenance });
  };

  // A stated count of zero vetoes the whole group even when a class and a storage figure sit
  // beside it. metric-matrix.ts :516-522 records what happens otherwise: those rows describe
  // what the fleet WOULD be, not what it is.
  if (countRows > 0 && countZeros === countRows) {
    exclude(`its count is 0 in ${scenario?.label ?? 'this scenario'}, so it is not priced there`);
    return;
  }

  const runtime = runtimePerUnit !== undefined
    ? { hours: runtimePerUnit, conversions: runtimeConversions }
    : runtimeFor({}, input.defaultHoursPerDay);
  const units = count ?? 1;
  const shape: CanonicalShape = {
    size,
    count: units,
    ...(countOriginalValue !== undefined ? {
      countOriginalValue,
      countOriginalUnit: 'units',
      countOriginalPeriod,
      countDerivedValue,
      countDerivedUnit: 'units',
      countDerivedPeriod: 'month',
      ...(countConversionFormula ? { countConversionFormula } : {}),
    } : {}),
    durationOriginalValue: runtimeOriginalValue ?? runtime.hours,
    durationOriginalUnit: runtimeOriginalUnit ?? 'hours',
    durationOriginalPeriod: runtimeOriginalPeriod ?? 'month',
    durationDerivedValue: runtime.hours,
    durationDerivedUnit: 'hours',
    ...(runtimeConversionFormula ? { durationConversionFormula: runtimeConversionFormula } : {}),
    vcpu,
    ramGb,
    hoursPerUnit: runtime.hours,
  };

  if (isFargate(group.service, label, group.section)) {
    const decomposed = fargateQuantities(shape, [...countConversions, ...runtime.conversions]);
    if (!decomposed.length) {
      exclude('Fargate is billed per vCPU-hour and per GB-hour, and neither a task vCPU size nor a task '
        + 'memory size was stated, so there is nothing to decompose the task count into');
      return;
    }
    quantities.unshift(...decomposed);
    publish(sink, label, quantities);
    sink.rows.push({
      id: `${group.sheet ?? 'sheet'}!${provenance[0]?.row ?? index + 1}#${scenario?.key ?? index}`,
      billing: 'usage',
      service: group.service,
      label,
      scenario,
      environment: group.environment,
      region: group.region,
      shape,
      quantities,
      attributes,
      provenance,
      unpriced,
      notes: group.notes,
    });
    return;
  }

  // A class or a spec with no usage dimension is a machine, and a machine is billed on
  // runtime. Stated as the row's own claim via INSTANCE_UNIT rather than assumed by the
  // pricer, which is the whole difference this module makes.
  if (size !== undefined || vcpu !== undefined || ramGb !== undefined) {
    quantities.unshift({
      unit: INSTANCE_UNIT,
      amount: round2(units * runtime.hours),
      basis: 'compute runtime',
      conversions: [
        ...countConversions,
        ...runtime.conversions,
        ...(units > 1 ? [`${units} x ${runtime.hours} hours = ${round2(units * runtime.hours)} hours a month`] : []),
      ],
    });
  }

  if (!quantities.length) {
    if (count !== undefined && group.service) {
      sink.rows.push({
        id: `${group.sheet ?? 'sheet'}!${provenance[0]?.row ?? index + 1}#${scenario?.key ?? index}`,
        billing: 'usage',
        service: group.service,
        label,
        scenario,
        environment: group.environment,
        region: group.region,
        shape,
        quantities,
        attributes,
        provenance,
        unpriced,
        notes: [
          group.notes,
          'Count was preserved, but no direct billable unit or complete Calculator shape was present in the workbook.',
        ].filter(Boolean).join(' '),
      });
      return;
    }
    exclude(unpriced.length
      ? unpriced[0].reason
      : 'no size, count, specification or usage figure could be read from the group, so there is no '
        + 'dimension to price it on');
    return;
  }

  publish(sink, label, quantities);
  sink.rows.push({
    id: `${group.sheet ?? 'sheet'}!${provenance[0]?.row ?? index + 1}#${scenario?.key ?? index}`,
    billing: billingFor(quantities),
    service: group.service,
    label,
    scenario,
    environment: group.environment,
    region: group.region,
    shape: size !== undefined || vcpu !== undefined || ramGb !== undefined || count !== undefined
      ? shape
      : undefined,
    quantities,
    attributes,
    provenance,
    unpriced,
    notes: group.notes,
  });
}

/**
 * Turns whatever a reader produced into canonical rows, and accounts for every one of them.
 *
 * The post-condition is the reason to call this rather than normalising ad hoc at the point
 * of use: `accounting.balanced` is false the moment an input row leaves without becoming
 * either a priced row or a stated exclusion. That makes "nothing was silently dropped" a
 * thing a test asserts about a real file, instead of a claim in a comment.
 */
export function canonicalise(input: CanonicalInput): CanonicalWorkbook {
  const sink: Sink = {
    rows: [],
    exclusions: [],
    conversions: new Set<string>(),
    scenarios: new Map<string, CanonicalScenario>(),
    metricCells: 0,
    accountedMetricCells: 0,
  };
  // Seeded from the reader's own band list so first-appearance order is the SHEET's order,
  // left to right, rather than whichever band happened to have a priceable row first.
  const byKey = new Map<string, CanonicalScenario>();
  for (const scenario of input.scenarios ?? []) {
    byKey.set(scenario.key, scenario);
    recordScenario(sink, scenario);
  }

  (input.inventory ?? []).forEach((row, index) => {
    normaliseInventoryRow(row, index, input, byKey, sink);
  });
  (input.metrics ?? []).forEach((group, index) => {
    normaliseMetricGroup(group, index, input, sink);
  });

  const inputRows = (input.inventory ?? []).length + (input.metrics ?? []).length;
  return {
    rows: sink.rows,
    exclusions: sink.exclusions,
    conversions: [...sink.conversions],
    scenarios: [...sink.scenarios.values()],
    accounting: {
      inputRows,
      canonicalRows: sink.rows.length,
      exclusions: sink.exclusions.length,
      metricCells: sink.metricCells,
      accountedMetricCells: sink.accountedMetricCells,
      balanced: inputRows === sink.rows.length + sink.exclusions.length
        && sink.metricCells === sink.accountedMetricCells,
    },
  };
}
