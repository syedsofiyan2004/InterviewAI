/**
 * A many-link cost estimate as a real Word document.
 *
 * Why this exists. A finished estimate for a real landscape is not one AWS Pricing Calculator
 * link, it is a grid of them: every fiscal year of the plan, priced at every pricing model
 * under discussion, for production and again for the lower environments. The reference
 * deliverable this reproduces carries eighteen. `calculator-report.ts` cannot carry that shape
 * — a PDF prints a URL as ink, so eighteen of them are eighteen strings a reader has to retype,
 * and a table five columns wide with a raw calculator.aws URL in one of them has no readable
 * column widths left. OOXML has real hyperlink relationships, so the link cell can read "Open
 * AWS Pricing Calculator estimate" and still be one click.
 *
 * Three failures this module is built to prevent, in order of how expensive they are:
 *
 *  - **Reading a committed-rate estimate as fully committed.** If some services are reserved
 *    and the rest stay On-Demand, and the document does not say which, the reader budgets for a
 *    discount that most of the bill never receives. So the pricing-model statement is
 *    mandatory: when the caller supplies none for a committed-rate row, this document states
 *    the gap instead of staying silent (see `pricingModelStatement`).
 *  - **Adding up figures that must not be added.** Fifteen monthly figures in one table invite
 *    a sum. Across fiscal years that sum is not a monthly bill; across pricing models it is a
 *    total of alternatives, only one of which will ever be spent. Each table therefore carries
 *    prose saying which of its axes may be added, before the numbers.
 *  - **A financial figure with an unstated basis.** MRR and ARR are both printed and both
 *    defined in the document, including the case where ARR had to be derived as MRR x 12
 *    rather than read from a recorded twelve-month total.
 *
 * Nothing about a particular client is hardcoded. Fiscal years, environments, pricing models,
 * services and every currency figure arrive as data on `CalculationRecord`; the assumption and
 * per-service prose arrives as plain strings from the caller, deliberately not imported from a
 * pricing-model module, so this renderer stays usable before one exists.
 */
import type { CalculationRecord, CalculationScenario } from '../../schema/calculator.js';
import { MONTHS_PER_YEAR } from './unit-contract.js';

/**
 * docx is ~2 MB on disk and most routes in the api-handler bundle will never render a
 * document. Loaded on first use and cached for the life of the container, exactly as
 * `shared/mom-docx.ts` treats the same dependency.
 */
const importDocx = () => import('docx');

/**
 * Derived from the import expression rather than written as `typeof import('docx')`: the
 * package ships separate ESM and CJS declaration files, and naming the module in a type
 * position picks the CJS one, whose classes are structurally incompatible with the ESM classes
 * the dynamic import actually returns. Same reasoning as `mom-docx.ts`.
 */
type Docx = Awaited<ReturnType<typeof importDocx>>;
type Block = InstanceType<Docx['Paragraph']> | InstanceType<Docx['Table']>;
type Run = InstanceType<Docx['TextRun']> | InstanceType<Docx['ExternalHyperlink']>;

let cachedDocx: Docx | undefined;
async function loadDocx(): Promise<Docx> {
  const docx = cachedDocx ?? await importDocx();
  cachedDocx = docx;
  return docx;
}

/** The subset of `mom-docx.ts`'s palette this document needs, so the two look like one suite. */
const C = {
  ink: '1A293D',
  muted: '6B7A8F',
  border: 'DBE6F0',
  blue: '1F5C9E',
  bluePale: 'F5F9FF',
  amber: 'B86E0F',
  white: 'FFFFFF',
  /** Word's own hyperlink blue. Set on the run rather than via a named style, because the
   *  style only exists in a document that already declares it and a missing style renders as
   *  body text — a link nobody can see is a link nobody clicks. */
  link: '0563C1',
};

/**
 * Strips only what OOXML cannot carry — the C0 controls other than tab, newline and carriage
 * return. Everything printable survives, including non-Latin scripts: this is UTF-8, unlike the
 * WinAnsi standard fonts the PDF renderer is limited to.
 */
function clean(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** dd-MM-yyyy, the standing convention across the hub (see `calculator-report.ts:46`). */
function formatDate(epochMs?: number): string {
  const date = new Date(epochMs || Date.now());
  if (Number.isNaN(date.getTime())) return '-';
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}-${month}-${date.getFullYear()}`;
}

const isPriced = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * Money, or a stated gap.
 *
 * Never `0.00` for a missing figure: zero in a client document reads as free, which is a
 * different claim from "AWS returned no figure for this row".
 */
function money(value: number | null | undefined, currency: string): string {
  if (!isPriced(value)) return NOT_PRICED;
  const formatted = value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${currency === 'USD' ? '$' : `${currency} `}${formatted}`;
}

/**
 * The visible text of every estimate link.
 *
 * Prose rather than the URL, for two reasons that both matter: a 90-character calculator.aws
 * URL in a five-column table leaves the other four columns unreadable, and the URL is not
 * information a reader can use with their eyes anyway. Exported so a test can find the link
 * cells without restating the wording.
 */
export const LINK_TEXT = 'Open AWS Pricing Calculator estimate';

/** What a link cell says when the pipeline priced a scenario but never exported an estimate. */
export const NO_LINK_TEXT = 'No link was produced for this scenario';

/** What a money cell says when AWS returned no figure. Never a blank, never a zero. */
export const NOT_PRICED = 'Not priced';

/**
 * The tables, in the order they appear in the document.
 *
 * `period` first because the fiscal-year plan for the production landscape is what the estimate
 * is read for; the lower environments qualify it. `sizing` last: it is the legacy
 * baseline/right-sized pair, which predates this document and is never the headline of one.
 */
const TABLE_ORDER = ['period', 'environment', 'sizing'] as const;
export type EstimateTableKind = (typeof TABLE_ORDER)[number];

/**
 * One priced cell of the grid: a scope, the pricing model it was priced at, and its link.
 *
 * `scope` and `pricingModel` are the two axes the reference deliverable tabulates, and neither
 * exists on `CalculationScenario` as a field — see `facetsOf` for how they are recovered, and
 * the module report for the schema fields that would make the recovery unnecessary.
 */
export interface EstimateRow {
  /** `CalculationScenario.key`, carried so a caller can key an override onto the row. */
  key: string;
  /** The fiscal year, environment or sizing this row prices. Never empty. */
  scope: string;
  /** Null when nothing in the data said which pricing model produced this figure. */
  pricingModel: string | null;
  /** True when the pricing model commits to a rate, which is what makes the mixed-model statement mandatory. */
  committed: boolean;
  monthly: number | null;
  annual: number | null;
  /** True when `annual` is MRR x 12 rather than a recorded twelve-month total. */
  annualDerived: boolean;
  url: string | null;
  detail?: string;
}

/** One heading's worth of rows, with the copy that stops its figures being misread. */
export interface EstimateTable {
  kind: EstimateTableKind;
  title: string;
  /** The scopes this table covers, when naming them adds something the title does not. */
  subtitle: string | null;
  /** Heading over the scope column, which is years in one table and environments in another. */
  scopeColumn: string;
  /** What the reader may and may not add up. Kind-specific by necessity, not by preference. */
  prose: string;
  rows: EstimateRow[];
  /** Set when a row is missing its link or its price, so the gap is stated and not just shown. */
  gaps: string | null;
}

export interface CalculatorDocxOptions {
  /** Overrides `record.name` on the title. */
  title?: string;
  /** Overrides the derived "which pricing models this document covers" subtitle. */
  subtitle?: string;
  /**
   * The assumptions that govern every row, as the caller words them.
   *
   * Defaults to `record.result.assumptions`. Plain strings on purpose: the tasks-per-day,
   * average-duration and Multi-AZ statements in the reference deliverable are conclusions about
   * how a workload was modelled, and this renderer has no way to re-derive them.
   */
  assumptions?: string[];
  /**
   * The sentence naming which services are priced at a committed rate and which stay On-Demand.
   *
   * The single most important string a caller can supply. Omitting it does not omit the
   * statement — see `pricingModelStatement`, which then states the gap instead.
   */
  mixedPricingStatement?: string;
  /**
   * The closing per-model notes: which term uses which upfront option and why, which services
   * have no committed purchase model at all. One paragraph each, in the caller's own words.
   */
  pricingModelNotes?: string[];
  /**
   * A recorded twelve-month total per scenario key, where one exists.
   *
   * The escape hatch that keeps ARR honest. A committed plan with an upfront charge bills more
   * in its first twelve months than twelve monthly bills come to, so MRR x 12 understates it —
   * and `CalculationScenario` has nowhere to put the calculator's own twelve-month total. Until
   * it does, a caller that has the figure passes it here and the document stops deriving.
   */
  annualByScenarioKey?: Record<string, number | null | undefined>;
  /**
   * Overrides how a pricing-model string is judged to be a rate commitment.
   *
   * The default reads AWS's own vocabulary out of the string. A caller that knows its own
   * naming replaces the guess with knowledge.
   */
  isCommittedPricingModel?: (pricingModel: string) => boolean;
  /** Overrides a table heading, for a caller whose scopes are not what the default reads them as. */
  tableTitles?: Partial<Record<EstimateTableKind, string>>;
  /**
   * Resolves a scenario onto the (scope, pricing model) grid directly.
   *
   * Supplied by a caller that keeps the two axes somewhere this module cannot see. Returning
   * null for a scenario falls back to the derivation below for that scenario alone.
   */
  facetOf?: (scenario: CalculationScenario) => { scope?: string; pricingModel?: string | null } | null;
}

/**
 * The separators a label uses between its scope and its pricing model, most explicit first.
 *
 * A closed list, because the failure of a wrong guess is a fiscal year silently split in half.
 * Notably absent: a bare "/" and a bare "-", which appear INSIDE the values themselves —
 * "FY26-27" and "Dev / QA / UAT" would both be cut in the middle of a scope.
 */
const FACET_SEPARATORS = [' | ', '|', ' — ', ' – ', ' :: ', '::', ' - '];

/** Splits at the LAST separator, so a scope containing one survives intact. */
function splitFacet(label: string): { scope: string; pricingModel: string } | null {
  for (const separator of FACET_SEPARATORS) {
    const at = label.lastIndexOf(separator);
    if (at <= 0) continue;
    const scope = label.slice(0, at).trim();
    const pricingModel = label.slice(at + separator.length).trim();
    if (scope && pricingModel) return { scope, pricingModel };
  }
  return null;
}

/**
 * The (scope, pricing model) pair behind each scenario, or nulls where the data does not say.
 *
 * The grid is not a field on `CalculationScenario`, so it is recovered from the labels — and
 * recovered only when the labels actually look like a grid. Two guards, because inventing an
 * axis is worse than not having one:
 *
 *  - Every scenario must split, or none is treated as split. A half-recovered grid would put a
 *    fiscal year and a pricing model in the same column.
 *  - The split must repeat along at least one axis. Five scenarios with five distinct scopes AND
 *    five distinct models are not a grid, they are five labels that happen to contain a dash —
 *    "Lift and shift - as the sheet specifies" is a description, not a pricing model.
 */
function facetsOf(
  scenarios: CalculationScenario[],
  options: CalculatorDocxOptions,
): Array<{ scope: string; pricingModel: string | null }> {
  const supplied = scenarios.map((scenario) => (options.facetOf ? options.facetOf(scenario) : null));
  const derived = scenarios.map((scenario) => splitFacet(clean(scenario.label)));

  const useDerived = derived.every(Boolean) && (() => {
    const scopes = new Set(derived.map((facet) => facet!.scope));
    const models = new Set(derived.map((facet) => facet!.pricingModel));
    return scopes.size < scenarios.length || models.size < scenarios.length;
  })();

  return scenarios.map((scenario, index) => {
    const override = supplied[index];
    const fallback = useDerived ? derived[index] : null;
    const scope = clean(override?.scope) || fallback?.scope || clean(scenario.label);
    const model = override && 'pricingModel' in override
      ? clean(override.pricingModel) || null
      : fallback?.pricingModel ?? null;
    return { scope, pricingModel: model };
  });
}

/**
 * Does this pricing model commit to a rate?
 *
 * Matched on AWS's own vocabulary — Reserved Instances, Savings Plans, upfront terms — rather
 * than on any client's naming, so it stays data-independent. A false positive costs a redundant
 * honest sentence; a false negative costs the reader the one warning that stops them budgeting
 * a discount the whole estimate does not have. The asymmetry is why the match is broad.
 */
function looksCommitted(pricingModel: string): boolean {
  return /reserv|savings\s*plan|commit|upfront|\bri\b|\bris\b|\bsp\b|\bcud\b/i.test(pricingModel);
}

/**
 * The kind a scenario is tabulated as.
 *
 * Defaults to `sizing` for the same reason `calculator-report.ts:212` does: every scenario
 * stored before `kind` existed was half of a baseline/right-sized pair, because that was the
 * only thing the pipeline could emit. Duplicated rather than imported, so this module does not
 * drag pdf-lib into a bundle that only needs to write OOXML.
 */
function tableKind(scenario: CalculationScenario): EstimateTableKind {
  const kind = scenario.kind;
  return kind === 'period' || kind === 'environment' ? kind : 'sizing';
}

const SCOPE_COLUMN: Record<EstimateTableKind, string> = {
  period: 'Fiscal Year / Scope',
  environment: 'Environment / Scope',
  sizing: 'Sizing / Scope',
};

/**
 * The heading for a table.
 *
 * `period` becomes "Production Estimates" only when there is an environment table to contrast
 * it with, which is the shape of every banded capacity model this was built for: the years plan
 * production and the environment band is the non-production landscape. Alone, nothing in the
 * data says a fiscal-year band is production, so the neutral heading is used rather than a claim
 * the record cannot support. Either way a caller who knows better overrides it.
 */
function tableTitle(kind: EstimateTableKind, kinds: Set<EstimateTableKind>, options: CalculatorDocxOptions): string {
  const override = clean(options.tableTitles?.[kind]);
  if (override) return override;
  if (kind === 'period') return kinds.has('environment') ? 'Production Estimates' : 'Estimates by Fiscal Year';
  if (kind === 'environment') return kinds.has('period') ? 'Lower Environments' : 'Estimates by Environment';
  return 'Sizing Estimates';
}

/**
 * What may be added together in this table, and what may not.
 *
 * Two independent traps, so two sentences. Down the scope axis the answer depends on the kind:
 * consecutive years are spent in sequence and do not sum to a monthly bill, concurrent
 * environments genuinely do add up, and two sizings of one workload are alternatives. Across the
 * pricing-model axis the answer is always the same and always needs saying — the same workload
 * appears once per model, so summing the column totals alternatives and multiplies the estimate
 * by the number of models on offer.
 */
function tableProse(kind: EstimateTableKind, rows: EstimateRow[]): string {
  const scopes = new Set(rows.map((row) => row.scope)).size;
  const models = new Set(rows.filter((row) => row.pricingModel).map((row) => row.pricingModel)).size;

  const axis = kind === 'period'
    ? `The ${scopes} fiscal years below run one after another, so adding their MRR figures together does not give a monthly bill.`
    : kind === 'environment'
      ? `The ${scopes} environment ${scopes === 1 ? 'scope' : 'scopes'} below ${scopes === 1 ? 'runs' : 'run'} at the same time rather than one after another, so ${scopes === 1 ? 'its' : 'their'} MRR figures do add up.`
      : `The ${scopes} ${scopes === 1 ? 'sizing' : 'sizings'} below cost the same landscape more than one way, so only one of them will ever be spent — they are alternatives, not costs that add together.`;

  const alternatives = models > 1
    ? ` Each scope appears once per pricing model: those ${models} rows are alternative ways of buying the same capacity, so only one of them is ever spent and the column must not be summed across them.`
    : '';

  return `${axis}${alternatives} Every row carries its own AWS Pricing Calculator estimate, opened from the link in its row.`;
}

/**
 * "3 of these 15 rows have no shareable link", or nothing.
 *
 * The cells already say so individually, but a reader scanning a fifteen-row table for a total
 * will not audit fifteen cells. Stating the count above the table is what makes an incomplete
 * document legible as incomplete.
 */
function tableGaps(rows: EstimateRow[]): string | null {
  const unlinked = rows.filter((row) => !row.url).length;
  const unpriced = rows.filter((row) => !isPriced(row.monthly)).length;
  if (!unlinked && !unpriced) return null;

  const parts: string[] = [];
  if (unlinked) parts.push(`${unlinked} of these ${rows.length} rows ${unlinked === 1 ? 'has' : 'have'} no shareable estimate link, because the pricing run finished without exporting one`);
  if (unpriced) parts.push(`${unpriced} ${unpriced === 1 ? 'row' : 'rows'} ${unpriced === 1 ? 'carries' : 'carry'} no figure, because AWS returned no price for it`);
  return `${parts.join('; ')}. Those cells say so rather than showing a blank or a zero.`;
}

function buildRow(
  scenario: CalculationScenario,
  facet: { scope: string; pricingModel: string | null },
  options: CalculatorDocxOptions,
): EstimateRow {
  const monthly = isPriced(scenario.monthly) ? scenario.monthly : null;
  const recorded = options.annualByScenarioKey?.[scenario.key];
  const annualDerived = !isPriced(recorded) && isPriced(monthly);
  const committedOf = options.isCommittedPricingModel ?? looksCommitted;

  return {
    key: scenario.key,
    scope: facet.scope || 'Not stated',
    pricingModel: facet.pricingModel,
    committed: facet.pricingModel ? committedOf(facet.pricingModel) : false,
    monthly,
    // MRR x 12 rather than a recorded twelve-month total, and flagged as derived so the
    // definitions section can say which of the two the reader is looking at.
    annual: isPriced(recorded) ? recorded : (isPriced(monthly) ? monthly * MONTHS_PER_YEAR : null),
    annualDerived,
    url: clean(scenario.url) || null,
    detail: clean(scenario.detail) || undefined,
  };
}

/**
 * The scenarios of a record, grouped into the tables that can honestly describe them.
 *
 * Exported for the same reason `scenarioSections` is in `calculator-report.ts`: everything in
 * this file that is judgement rather than drawing lives here, and asserting on the wording of a
 * warning is far more direct than extracting text back out of a rendered document.
 *
 * Grouping is by `CalculationScenario.kind`, which is the only thing in the record that
 * distinguishes a fiscal-year band from a concurrently-running environment band. Where every
 * scenario shares one kind — or carries none — that yields one table, which is the intended
 * degradation: a single table of everything is honest, whereas a split invented from a label
 * would put two different things in one column under one heading.
 */
export function estimateTables(record: CalculationRecord, options: CalculatorDocxOptions = {}): EstimateTable[] {
  const result = record.result;
  const scenarios = (result?.scenarios || []).filter((scenario) => scenario && clean(scenario.label));

  if (!scenarios.length) {
    // No bands were priced. The record may still carry one estimate at the top level, and one
    // row naming it is more use than a heading over nothing; where it carries neither, the
    // document says so in prose instead of drawing an empty table.
    if (!result || (!clean(result.url) && !isPriced(result.monthlyTotal))) return [];
    const single: CalculationScenario = {
      key: 'estimate',
      label: clean(record.name) || 'This estimate',
      monthly: isPriced(result.monthlyTotal) ? result.monthlyTotal : null,
      url: clean(result.url) || null,
    };
    const rows = [buildRow(single, { scope: single.label, pricingModel: null }, options)];
    return [{
      kind: 'sizing',
      title: clean(options.tableTitles?.sizing) || 'Estimate',
      subtitle: null,
      scopeColumn: 'Scope',
      prose: 'This estimate was priced as a single scenario: no fiscal-year or environment bands '
        + 'were priced from it, so there is one row and one link.',
      rows,
      gaps: tableGaps(rows),
    }];
  }

  const facets = facetsOf(scenarios, options);
  const kinds = new Set(scenarios.map(tableKind));

  return TABLE_ORDER
    .filter((kind) => kinds.has(kind))
    .map((kind) => {
      const rows = scenarios
        .map((scenario, index) => ({ scenario, facet: facets[index] }))
        .filter((entry) => tableKind(entry.scenario) === kind)
        .map((entry) => buildRow(entry.scenario, entry.facet, options));
      const scopes = [...new Set(rows.map((row) => row.scope))];
      return {
        kind,
        title: tableTitle(kind, kinds, options),
        subtitle: scopes.length && scopes.length <= 4 ? scopes.join(' + ') : null,
        scopeColumn: SCOPE_COLUMN[kind],
        prose: tableProse(kind, rows),
        rows,
        gaps: tableGaps(rows),
      };
    });
}

/** The distinct pricing models a document covers, in the order they first appear. */
export function pricingModelsCovered(tables: EstimateTable[]): string[] {
  const seen: string[] = [];
  for (const table of tables) {
    for (const row of table.rows) {
      if (row.pricingModel && !seen.includes(row.pricingModel)) seen.push(row.pricingModel);
    }
  }
  return seen;
}

/**
 * The mandatory statement about which rates are committed and which are not.
 *
 * Mandatory in the strict sense: this function has no empty return. An estimate that prices
 * Aurora at a reserved rate while ECS Fargate stays On-Demand, presented without saying so,
 * reads as a fully committed estimate and under-budgets everything the commitment does not
 * cover — which is the majority of most bills. So when the caller supplies nothing for a
 * committed-rate row, the document states the gap in the caller's place. An admission that the
 * scope was not recorded is recoverable, because a reader asks; silence is not, because it looks
 * finished.
 */
export function pricingModelStatement(tables: EstimateTable[], supplied?: string): string {
  const statement = clean(supplied);
  if (statement) return statement;

  const rows = tables.flatMap((table) => table.rows);
  if (rows.some((row) => row.committed)) {
    return 'Committed-rate scope was not recorded for this estimate. Some rows above are priced '
      + 'at a committed rate, but which services that commitment covers was not stated, so this '
      + 'document cannot claim it covers all of them. Any service that is not reserved remains '
      + 'On-Demand at the full published rate, and reading these totals as fully committed would '
      + 'understate the bill.';
  }

  if (rows.every((row) => !row.pricingModel)) {
    return 'The pricing model behind these figures was not recorded per scenario, so this '
      + 'document cannot state which rates are committed and which are On-Demand. Treat every '
      + 'figure as On-Demand unless the estimate link itself shows otherwise.';
  }

  return 'No row above uses a committed-rate purchase model, so nothing in this estimate assumes '
    + 'a Reserved Instance or Savings Plan discount. Every figure is at the published On-Demand '
    + 'or list rate for its service.';
}

/**
 * How MRR and ARR were arrived at, stated in the document rather than assumed of the reader.
 *
 * The second sentence only appears when it is true, and it is the one that matters: an upfront
 * charge makes the first twelve months cost more than twelve monthly bills, so an ARR derived as
 * MRR x 12 on a committed row is understated by exactly the upfront amount. Printing that figure
 * without the caveat is the same class of error as printing a zero for a missing price.
 */
function mrrArrDefinitions(tables: EstimateTable[], currency: string): string[] {
  const rows = tables.flatMap((table) => table.rows);
  const derived = rows.filter((row) => row.annualDerived);
  const lines = [
    `MRR is the monthly recurring cost in ${currency} — the "Monthly cost" the AWS Pricing `
      + 'Calculator reports for that row\'s estimate. ARR is the annual recurring cost for the '
      + 'same estimate: the calculator\'s "Total 12 months" figure, covering twelve months of the '
      + 'configuration in that row and nothing beyond it.',
  ];

  if (derived.length) {
    lines.push(`ARR was calculated here as MRR x ${MONTHS_PER_YEAR} for ${derived.length === rows.length ? 'every row' : `${derived.length} of the ${rows.length} rows`}, because no twelve-month total was recorded against ${derived.length === 1 ? 'it' : 'them'}.`);
    if (derived.some((row) => row.committed)) {
      lines.push('Where a committed-rate row carries an upfront charge, the calculator\'s own '
        + 'twelve-month total is higher than twelve monthly bills, so the ARR shown for those rows '
        + 'understates the first year by that upfront amount. Take the figure from the estimate '
        + 'link before committing a budget to it.');
    }
  }

  return lines;
}

// --- Rendering ---------------------------------------------------------------------------

function heading(d: Docx, text: string): Block {
  return new d.Paragraph({
    heading: d.HeadingLevel.HEADING_1,
    spacing: { before: 320, after: 140 },
    border: { bottom: { style: d.BorderStyle.SINGLE, size: 8, color: C.blue, space: 4 } },
    children: [new d.TextRun({ text: clean(text), bold: true, color: C.blue, size: 24 })],
  });
}

function body(
  d: Docx,
  text: string,
  options: { size?: number; color?: string; bold?: boolean; italics?: boolean; before?: number; after?: number } = {},
): Block {
  return new d.Paragraph({
    spacing: { before: options.before ?? 0, after: options.after ?? 120 },
    children: [new d.TextRun({
      text: clean(text),
      size: options.size ?? 19,
      color: options.color ?? C.ink,
      bold: options.bold,
      italics: options.italics,
    })],
  });
}

/** A bulleted assumption or note, on its own list reference so it restarts at the bullet. */
function bullet(d: Docx, text: string, reference: string): Block {
  return new d.Paragraph({
    numbering: { reference, level: 0 },
    spacing: { after: 60 },
    children: [new d.TextRun({ text: clean(text), size: 19, color: C.ink })],
  });
}

/**
 * A cell built from runs rather than from a string.
 *
 * The one place this renderer has to diverge from `mom-docx.ts`'s `tableCell`: a link cell is a
 * hyperlink wrapping a run, not text with a colour, and a signature that only takes a string
 * cannot express it.
 */
function cell(d: Docx, children: Run[], width: number, fill?: string) {
  return new d.TableCell({
    width: { size: width, type: d.WidthType.PERCENTAGE },
    shading: fill ? { type: d.ShadingType.CLEAR, fill, color: 'auto' } : undefined,
    margins: { top: 60, bottom: 60, left: 90, right: 90 },
    children: [new d.Paragraph({ spacing: { before: 0, after: 0 }, children })],
  });
}

function textCell(
  d: Docx,
  text: string,
  width: number,
  options: { bold?: boolean; color?: string; italics?: boolean; fill?: string } = {},
) {
  return cell(
    d,
    [new d.TextRun({ text: clean(text), bold: options.bold, italics: options.italics, color: options.color ?? C.ink, size: 18 })],
    width,
    options.fill,
  );
}

/**
 * The estimate link as a real OOXML hyperlink relationship.
 *
 * `ExternalHyperlink` is what puts a `TargetMode="External"` entry in
 * `word/_rels/document.xml.rels` and an `r:id` on the run in the body. Text styled to look like
 * a link would not be clickable, which for a document whose entire purpose is eighteen links is
 * not a cosmetic difference. Where no estimate was exported the cell states that instead —
 * an underlined phrase that goes nowhere is worse than an honest sentence.
 */
function linkCell(d: Docx, url: string | null, width: number, fill?: string) {
  if (!url) {
    return textCell(d, NO_LINK_TEXT, width, { italics: true, color: C.muted, fill });
  }
  return cell(
    d,
    [new d.ExternalHyperlink({
      link: url,
      children: [new d.TextRun({
        text: LINK_TEXT,
        color: C.link,
        underline: { type: d.UnderlineType.SINGLE },
        size: 18,
      })],
    })],
    width,
    fill,
  );
}

/** Percentage widths, summing to 100. The link column is prose, so it does not need the URL's width. */
const COLUMN_WIDTHS = { scope: 20, model: 22, link: 24, mrr: 17, arr: 17 };

function renderTable(d: Docx, table: EstimateTable, currency: string): Block {
  const border = { style: d.BorderStyle.SINGLE, size: 4, color: C.border };
  const titles = [
    { text: table.scopeColumn, width: COLUMN_WIDTHS.scope },
    { text: 'Pricing Model', width: COLUMN_WIDTHS.model },
    { text: 'AWS Estimate Link', width: COLUMN_WIDTHS.link },
    { text: `MRR (${currency})`, width: COLUMN_WIDTHS.mrr },
    { text: `ARR (${currency})`, width: COLUMN_WIDTHS.arr },
  ];

  return new d.Table({
    width: { size: 100, type: d.WidthType.PERCENTAGE },
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    rows: [
      // `tableHeader` is what makes Word repeat these titles when a fifteen-row table breaks
      // across pages; without it page two is five columns of unlabelled figures.
      new d.TableRow({
        tableHeader: true,
        children: titles.map((column) => textCell(d, column.text, column.width, { bold: true, color: C.white, fill: C.blue })),
      }),
      ...table.rows.map((row, index) => {
        const fill = index % 2 === 1 ? C.bluePale : undefined;
        return new d.TableRow({
          children: [
            textCell(d, row.scope, COLUMN_WIDTHS.scope, { bold: true, fill }),
            row.pricingModel
              ? textCell(d, row.pricingModel, COLUMN_WIDTHS.model, { fill })
              // Not blank and not "On-Demand": the record did not say, and guessing the model is
              // how an estimate acquires a discount nobody purchased.
              : textCell(d, 'Not recorded', COLUMN_WIDTHS.model, { italics: true, color: C.muted, fill }),
            linkCell(d, row.url, COLUMN_WIDTHS.link, fill),
            textCell(d, money(row.monthly, currency), COLUMN_WIDTHS.mrr, {
              italics: !isPriced(row.monthly),
              color: isPriced(row.monthly) ? C.ink : C.muted,
              fill,
            }),
            textCell(d, money(row.annual, currency), COLUMN_WIDTHS.arr, {
              italics: !isPriced(row.annual),
              color: isPriced(row.annual) ? C.ink : C.muted,
              fill,
            }),
          ],
        });
      }),
    ],
  });
}

/**
 * Builds the Word version of a multi-link cost estimate.
 *
 * Takes the stored record rather than its `result` alone — the title, the region and the created
 * date are all on the record, and a document that has to state when it was priced should not
 * need the caller to remember to pass that. Async because `Packer.toBuffer` is, and because docx
 * itself is imported lazily.
 */
export async function generateCalculatorDocxReport(
  record: CalculationRecord,
  options: CalculatorDocxOptions = {},
): Promise<Buffer> {
  const d = await loadDocx();
  const result = record.result;
  const currency = clean(result?.currency) || 'USD';
  const tables = estimateTables(record, options);
  const models = pricingModelsCovered(tables);
  const title = clean(options.title) || clean(record.name) || 'AWS Cost Estimate';
  const children: Block[] = [];

  // --- Title, and the subtitle that names which pricing models the document covers, so the
  //     scope of the comparison is readable before any figure is.
  children.push(new d.Paragraph({
    heading: d.HeadingLevel.TITLE,
    spacing: { after: 60 },
    border: { bottom: { style: d.BorderStyle.SINGLE, size: 18, color: C.blue, space: 6 } },
    children: [new d.TextRun({ text: title, bold: true, color: C.blue, size: 40 })],
  }));
  children.push(body(
    d,
    clean(options.subtitle) || [...models, 'MRR & ARR'].join(' | '),
    { size: 21, color: C.muted, before: 160, after: 40 },
  ));
  children.push(body(d, [
    `Region: ${clean(record.region) || 'Per resource'}`,
    `Estimate created ${formatDate(record.created_at)}`,
    `Document generated ${formatDate(Date.now())}`,
    `Currency: ${currency}`,
  ].join('  |  '), { size: 17, color: C.muted, after: 200 }));

  // --- Assumptions that govern every row, up front where they can still change how the tables
  //     are read. The pricing-model statement is last and bold: it is the one sentence whose
  //     absence changes what the numbers mean.
  children.push(heading(d, 'Assumptions'));
  const assumptions = (options.assumptions ?? result?.assumptions ?? []).map(clean).filter(Boolean);
  if (assumptions.length) {
    assumptions.forEach((line) => children.push(bullet(d, line, 'assumptions')));
  } else {
    children.push(body(d, 'No workload assumptions were recorded with this estimate, so nothing '
      + 'here qualifies the quantities behind the figures below.', { italics: true, color: C.muted }));
  }
  children.push(body(d, pricingModelStatement(tables, options.mixedPricingStatement), {
    bold: true,
    before: 80,
  }));

  // --- One table per group of scenarios, each behind the prose that says what may be summed.
  if (tables.length) {
    tables.forEach((table) => {
      children.push(heading(d, table.title));
      if (table.subtitle) children.push(body(d, table.subtitle, { size: 18, italics: true, color: C.muted, after: 80 }));
      children.push(body(d, table.prose, { after: 140 }));
      if (table.gaps) children.push(body(d, table.gaps, { size: 17, italics: true, color: C.amber, after: 140 }));
      children.push(renderTable(d, table, currency));
    });
  } else {
    // An estimate can reach this renderer having priced nothing at all — a run that failed, or
    // one still in progress. A document that says so is useful; a document that looks complete
    // and contains no figures is not.
    children.push(heading(d, 'Estimates'));
    children.push(body(d, 'No scenarios were priced for this estimate, so there are no estimate '
      + 'links, no MRR figures and no ARR figures to show. This document records that gap rather '
      + 'than presenting an empty table as a result.'));
    if (record.status !== 'COMPLETED') {
      children.push(body(d, `The estimate is ${record.status.toLowerCase()} as at ${formatDate(Date.now())}${clean(record.error_message) ? `: ${clean(record.error_message)}` : '.'}`));
    }
  }

  // --- Closing notes: the caller's per-model prose, then the definitions that keep MRR and ARR
  //     from being read as figures they are not.
  children.push(heading(d, 'Pricing Model Configuration'));
  const notes = (options.pricingModelNotes ?? []).map(clean).filter(Boolean);
  if (notes.length) {
    notes.forEach((note) => children.push(bullet(d, note, 'notes')));
  } else if (models.length) {
    children.push(body(d, `This document covers ${models.length === 1 ? 'one pricing model' : `${models.length} pricing models`}: ${models.join(', ')}. No per-service notes were supplied, so which services each model actually applies to is not stated here — read it from the estimate links themselves before quoting a figure.`, { italics: true, color: C.muted }));
  }
  mrrArrDefinitions(tables, currency).forEach((line) => children.push(body(d, line)));
  // True of every commitment and easy to forget: the discount changes the bill, not the
  // architecture, so nothing in the tables above describes a different workload.
  children.push(body(d, 'A committed-rate purchase — a Reserved Instance, a Savings Plan or any '
    + 'other term commitment — is a billing arrangement for supported capacity. It does not change '
    + 'the underlying workload configuration, so every row above describes the same architecture '
    + 'bought on different terms.'));

  const warnings = (result?.warnings || []).map(clean).filter(Boolean);
  if (warnings.length) {
    children.push(heading(d, 'Warnings'));
    warnings.forEach((warning) => children.push(bullet(d, warning, 'warnings')));
  }

  const doc = new d.Document({
    title: `AWS Cost Estimate - ${title}`,
    description: `AWS Pricing Calculator estimates for ${title}`,
    creator: 'Minfy AI Cost Calculator',
    styles: { default: { document: { run: { font: 'Calibri', size: 19, color: C.ink } } } },
    // One reference per list, so notes do not continue the assumptions' numbering.
    numbering: {
      config: ['assumptions', 'notes', 'warnings'].map((reference) => ({
        reference,
        levels: [{
          level: 0,
          format: d.LevelFormat.BULLET,
          text: '•',
          alignment: d.AlignmentType.START,
          style: { paragraph: { indent: { left: 420, hanging: 240 } } },
        }],
      })),
    },
    sections: [{
      properties: { page: { margin: { top: 800, bottom: 800, left: 800, right: 800 } } },
      footers: {
        default: new d.Footer({
          children: [new d.Paragraph({
            alignment: d.AlignmentType.CENTER,
            children: [
              new d.TextRun({ text: `${title}  |  ${formatDate(record.created_at)}  |  Page `, size: 15, color: C.muted }),
              new d.TextRun({ children: [d.PageNumber.CURRENT], size: 15, color: C.muted }),
              new d.TextRun({ text: ' of ', size: 15, color: C.muted }),
              new d.TextRun({ children: [d.PageNumber.TOTAL_PAGES], size: 15, color: C.muted }),
            ],
          })],
        }),
      },
      children,
    }],
  });

  return await d.Packer.toBuffer(doc);
}
