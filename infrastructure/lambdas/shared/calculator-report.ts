import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { CalculationResult, CalculationScenario, EnvironmentHours } from '../../schema/calculator.js';
import {
  CONTENT_WIDTH,
  MARGIN,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  c,
  drawFooter,
  ensure,
  gap,
  note,
  numberedTable,
  safe,
  section,
  table,
  text,
  visibleLines,
  type PdfContext,
} from './pdf-kit.js';

/**
 * Client-facing PDF for an AWS cost estimate.
 *
 * The estimate already exists as a shareable calculator.aws link, so this document
 * exists for the conversation around it: what it costs per environment, what a year
 * looks like, what running non-production on a schedule saves, and which choices
 * were assumed rather than specified.
 *
 * Every currency figure traces back to AWS's own pricing engine via the stored
 * result. The two derived figures — the annual projection and the scheduling saving
 * — are arithmetic on those numbers and are labelled as projections wherever they
 * appear. Nothing here is a number the model invented.
 */

const MONTHS_PER_YEAR = 12;

export interface CalculatorReportOptions {
  name: string;
  environmentHours: EnvironmentHours[];
  createdAt?: number;
  region?: string;
}

/** dd-MM-yyyy, the standing convention across the hub. */
function formatDate(epochMs?: number): string {
  const date = new Date(epochMs || Date.now());
  if (Number.isNaN(date.getTime())) return '-';
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}-${month}-${date.getFullYear()}`;
}

/**
 * Money, or an em dash.
 *
 * A null total is meaningful rather than missing: AWS did not return a figure for
 * that line, and printing 0 would read as free.
 */
function money(value: number | null | undefined, currency: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  const formatted = value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${currency === 'USD' ? '$' : `${currency} `}${formatted}`;
}

const annual = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value * MONTHS_PER_YEAR : null;

/** Sums only the figures AWS actually returned. */
function sum(values: Array<number | null | undefined>): number | null {
  const numbers = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return numbers.length ? numbers.reduce((total, value) => total + value, 0) : null;
}

/**
 * What running non-production on a schedule saves against always-on.
 *
 * Counted over time-billed lines only. A usage-based service costs the same whether
 * the environment is up or not — including S3 or per-request Lambda here would
 * manufacture a saving that does not exist. `timeBilled` is set by the loop only
 * where it actually applied a utilization field, which is what makes this
 * defensible rather than a guess.
 */
export function schedulingSaving(result: CalculationResult): {
  monthly: number | null;
  lines: Array<{ service: string; environment: string; hoursPerDay: number; monthly: number; saved: number }>;
} {
  const lines = (result.lineItems || [])
    .filter((item) => item.timeBilled
      && typeof item.monthly === 'number'
      && Number.isFinite(item.monthly)
      && typeof item.hoursPerDay === 'number'
      && item.hoursPerDay > 0
      && item.hoursPerDay < 24)
    .map((item) => ({
      service: item.service,
      environment: item.environment || 'Unassigned',
      hoursPerDay: item.hoursPerDay as number,
      monthly: item.monthly as number,
      // Priced cost is for hoursPerDay; always-on would be 24/hours times that.
      saved: (item.monthly as number) * (24 / (item.hoursPerDay as number) - 1),
    }));

  return { monthly: sum(lines.map((line) => line.saved)), lines };
}

export async function generateCalculatorPdfReport(
  result: CalculationResult,
  options: CalculatorReportOptions,
): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ctx: PdfContext = {
    pdf,
    page: pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]),
    regular,
    bold,
    y: PAGE_HEIGHT - MARGIN,
  };

  const currency = result.currency || 'USD';

  drawCover(ctx, result, options, currency);
  drawScenarios(ctx, result, currency);
  drawEnvironments(ctx, result, options, currency);
  drawLineItems(ctx, result, currency);
  drawSavings(ctx, result, currency);
  drawAssumptions(ctx, result);

  drawFooter(ctx, 'Minfy AI Cost Calculator');
  return Buffer.from(await pdf.save());
}

function drawCover(ctx: PdfContext, result: CalculationResult, options: CalculatorReportOptions, currency: string) {
  ctx.page.drawRectangle({ x: MARGIN, y: ctx.y - 74, width: CONTENT_WIDTH, height: 74, color: c.blue });
  ctx.page.drawText('AWS COST ESTIMATE', { x: MARGIN + 16, y: ctx.y - 26, size: 9, font: ctx.bold, color: c.white });
  ctx.page.drawText(safe(options.name).slice(0, 58) || 'Untitled estimate', {
    x: MARGIN + 16, y: ctx.y - 50, size: 17, font: ctx.bold, color: c.white,
  });
  const scope = [
    valueOrDash(options.region) || 'Region per resource',
    `${(result.lineItems || []).length} resources`,
    `Prepared ${formatDate(options.createdAt)}`,
  ].join('   ·   ');
  ctx.page.drawText(scope, { x: MARGIN + 16, y: ctx.y - 65, size: 8, font: ctx.regular, color: c.white });
  ctx.y -= 86;

  const monthly = typeof result.monthlyTotal === 'number'
    ? result.monthlyTotal
    : sum((result.lineItems || []).map((item) => item.monthly));
  const priced = typeof monthly === 'number';

  // When nothing could be priced, say so in the space the numbers would have
  // occupied. A pair of em dashes under "ESTIMATED MONTHLY" reads as a broken
  // document; a sentence explaining that the link holds the pricing does not.
  if (!priced) {
    ensure(ctx, 64);
    const top = ctx.y;
    ctx.page.drawRectangle({ x: MARGIN, y: top - 58, width: CONTENT_WIDTH, height: 58, color: c.amberSoft, borderColor: c.amber, borderWidth: 0.8 });
    ctx.page.drawText('COST NOT AVAILABLE', { x: MARGIN + 14, y: top - 20, size: 8, font: ctx.bold, color: c.amber });
    visibleLines(
      'Published rates could not be retrieved for this estimate, so no monthly figure is shown. The configuration below is complete — open the live estimate link to see AWS calculate the price.',
      ctx.regular, 8.4, CONTENT_WIDTH - 28, 3,
    ).forEach((line, index) => {
      ctx.page.drawText(line, { x: MARGIN + 14, y: top - 34 - index * 11, size: 8.4, font: ctx.regular, color: c.ink });
    });
    ctx.y -= 68;
    return;
  }

  // Three tiles: the monthly figure AWS's rates give, the annual projection, and
  // what scheduling saves. The third is the reason this document exists.
  const saving = schedulingSaving(result).monthly;
  const tiles = [
    { label: 'MONTHLY', value: money(monthly, currency), fill: c.blueSoft, accent: c.blue, foot: 'at the hours below' },
    { label: 'ANNUAL (x12)', value: money(annual(monthly), currency), fill: c.graySoft, accent: c.gray, foot: 'projection' },
    ...(typeof saving === 'number' && saving > 0
      ? [{ label: 'SAVED BY SCHEDULING', value: money(saving, currency), fill: c.greenSoft, accent: c.green, foot: 'per month vs 24/7' }]
      : []),
  ];

  const gap = 10;
  const tileWidth = (CONTENT_WIDTH - gap * (tiles.length - 1)) / tiles.length;
  ensure(ctx, 78);
  const top = ctx.y;
  tiles.forEach((tile, index) => {
    const x = MARGIN + index * (tileWidth + gap);
    ctx.page.drawRectangle({ x, y: top - 66, width: tileWidth, height: 66, color: tile.fill, borderColor: tile.accent, borderWidth: 0.8 });
    ctx.page.drawText(tile.label, { x: x + 12, y: top - 19, size: 7, font: ctx.bold, color: tile.accent });
    // Shrink the figure rather than let it run past the tile edge.
    let size = 18;
    while (size > 10 && ctx.bold.widthOfTextAtSize(tile.value, size) > tileWidth - 24) size -= 1;
    ctx.page.drawText(tile.value, { x: x + 12, y: top - 44, size, font: ctx.bold, color: c.ink });
    ctx.page.drawText(tile.foot, { x: x + 12, y: top - 57, size: 7, font: ctx.regular, color: c.muted });
  });
  ctx.y -= 78;
}

/** The kinds of scenario, in the order their sections appear in the document. */
const SCENARIO_KIND_ORDER = ['sizing', 'period', 'environment'] as const;
export type ScenarioKind = (typeof SCENARIO_KIND_ORDER)[number];

/**
 * The kind a scenario is rendered as.
 *
 * Defaults to `sizing` rather than to a fourth "unknown" bucket because every scenario
 * stored before `kind` existed was half of a baseline/right-sized pair - that was the only
 * thing the pipeline could emit. An estimate read back out of DynamoDB from before this
 * change therefore renders exactly as it always did, saving line included.
 */
export function scenarioKind(scenario: CalculationScenario): ScenarioKind {
  return scenario.kind || 'sizing';
}

/** One heading's worth of scenarios, with the copy that makes its figures readable. */
export interface ScenarioSection {
  kind: ScenarioKind;
  title: string;
  /** Column heading over the labels, which are years or environments and not always "scenarios". */
  labelColumn: string;
  /** Column heading over `detail`, which means something different for each kind. */
  basisColumn: string;
  /**
   * What the reader may and may not do with these figures.
   *
   * Kind-specific by necessity rather than by preference: five monthly figures for five
   * consecutive years and three monthly figures for three concurrent environments look
   * identical in a table, and only one of the two may be added up.
   */
  prose: string;
  scenarios: CalculationScenario[];
  /**
   * A combined figure, only where the kind permits one, worded so it cannot be misread.
   * Null for `sizing`: two ways of costing one workload are alternatives, not a sum.
   */
  total: string | null;
  /** Baseline against right-sized, and nothing else. Null for every other kind. */
  saving: string | null;
  /** Heading over the per-scenario link list. */
  linksHeading: string;
}

const isPriced = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * "2 of the 5 could not be priced...", or nothing.
 *
 * A total over a partly-priced band is still worth printing - it is the only figure the
 * document can offer - but printing it unqualified would understate the band by however
 * many scenarios AWS returned no rate for.
 */
function unpricedCaveat(scenarios: CalculationScenario[]): string {
  const missing = scenarios.filter((entry) => !isPriced(entry.monthly)).length;
  if (!missing) return '';
  return ` ${missing} of the ${scenarios.length} could not be priced and ${missing === 1 ? 'is' : 'are'} not in this total.`;
}

function buildSection(kind: ScenarioKind, scenarios: CalculationScenario[], currency: string): ScenarioSection {
  const count = scenarios.length;
  const monthlyTotal = sum(scenarios.map((entry) => entry.monthly));
  const caveat = unpricedCaveat(scenarios);

  if (kind === 'period') {
    return {
      kind,
      title: 'Cost by year',
      labelColumn: 'Year',
      basisColumn: 'What the year assumes',
      // The sentence that stops a reader adding the column up and quoting the result as a
      // monthly bill. Five years of monthly costs in one table invites exactly that, and
      // the mistake overstates the bill fivefold on a document budgets are set from.
      prose: `Each of these ${count} years is priced from the same published AWS rates. Every figure is the monthly cost of that year's configuration, and the years run one after another - so adding the monthly figures together does not give a monthly bill. Each year carries its own shareable estimate, listed below the table.`,
      scenarios,
      total: isPriced(monthlyTotal)
        ? `Across all ${count} years: ${money(annual(monthlyTotal), currency)} in total - the sum of each year's annual cost (monthly x 12). That is a multi-year total, not a monthly figure.${caveat}`
        : null,
      saving: null,
      linksHeading: 'Shareable estimates - one AWS Pricing Calculator link per year:',
    };
  }

  if (kind === 'environment') {
    return {
      kind,
      // Not "Cost by environment": the estimate already carries a section under that exact
      // heading, rolling one priced landscape up by environment. These are separate
      // estimates with their own links, and two identical headings would read as a fault.
      title: 'Cost by environment, priced separately',
      labelColumn: 'Environment',
      basisColumn: 'What the environment covers',
      prose: `These ${count} environments run at the same time rather than one after another, so their monthly costs genuinely do add up. Each is priced from the same published AWS rates and carries its own shareable estimate, listed below the table.`,
      scenarios,
      total: isPriced(monthlyTotal)
        ? `All ${count} environments running together: ${money(monthlyTotal, currency)} per month, ${money(annual(monthlyTotal), currency)} per year.${caveat}`
        : null,
      saving: null,
      linksHeading: 'Shareable estimates - one AWS Pricing Calculator link per environment:',
    };
  }

  // Stated only when right-sizing is genuinely the cheaper of the two. Labelling an
  // increase as a "saving" would be worse than showing nothing, and an unpriced scenario
  // has no difference to report at all. Keyed on baseline/rightsized because that pair is
  // the only comparison in which a difference IS a saving - the gap between two fiscal
  // years or two concurrent environments is not one, and must never be dressed up as one.
  const baseline = scenarios.find((entry) => entry.key === 'baseline')?.monthly;
  const rightsized = scenarios.find((entry) => entry.key === 'rightsized')?.monthly;
  let saving: string | null = null;
  if (isPriced(baseline) && isPriced(rightsized) && baseline > 0 && rightsized < baseline) {
    const saved = baseline - rightsized;
    saving = `Right-sizing saves ${money(saved, currency)} per month - ${money(annual(saved), currency)} a year, or ${Math.round((saved / baseline) * 100)}% of the baseline.`;
  }

  return {
    kind,
    title: 'Sizing scenarios',
    labelColumn: 'Scenario',
    basisColumn: 'How it was sized',
    prose: `${count === 2 ? 'Both sizings price' : 'Each sizing prices'} the same landscape from the same published AWS rates, so only one of them will ever be spent - these are alternatives, not costs that add together. Each carries its own shareable estimate, listed below the table.`,
    scenarios,
    // Deliberately never a total, for the reason the prose above it gives.
    total: null,
    saving,
    linksHeading: 'Shareable estimates - one AWS Pricing Calculator link per sizing:',
  };
}

/**
 * The scenarios on a result, grouped into the sections that can honestly describe them.
 *
 * Exported because it holds all of the judgement in this file that is not drawing: what a
 * band of scenarios may be totalled into, and what a reader has to be told before they see
 * the figures. Testing it directly is the only way to assert on that wording without
 * extracting text back out of a rendered PDF.
 */
export function scenarioSections(result: CalculationResult): ScenarioSection[] {
  const currency = result.currency || 'USD';
  const scenarios = (result.scenarios || []).filter((entry) => entry && entry.label);
  return SCENARIO_KIND_ORDER
    .map((kind) => ({ kind, group: scenarios.filter((entry) => scenarioKind(entry) === kind) }))
    .filter((entry) => entry.group.length > 0)
    .map(({ kind, group }) => buildSection(kind, group, currency));
}

/**
 * A URL on one line, shrunk to fit rather than wrapped.
 *
 * `wrap()` breaks an over-long word by inserting a hyphen at each break - correct for prose
 * and ruinous for a link, because the hyphens land inside the URL and a reader who copies
 * it out of the PDF gets a 404. So the size comes down until the whole thing fits across the
 * content width, which for a calculator.aws estimate it does at full size.
 */
function linkLine(ctx: PdfContext, url: string, indent: number) {
  const value = safe(url);
  const width = CONTENT_WIDTH - indent;
  let size = 8;
  while (size > 6 && ctx.regular.widthOfTextAtSize(value, size) > width) size -= 0.25;

  // Past the floor there is nothing left but to wrap and accept the hyphens: a link running
  // off the edge of the page is worse than one that has to be retyped.
  if (ctx.regular.widthOfTextAtSize(value, size) > width) {
    text(ctx, value, { size, color: c.blue, indent, lineHeight: 10 });
    return;
  }
  ensure(ctx, 12);
  ctx.page.drawText(value, { x: MARGIN + indent, y: ctx.y, size, font: ctx.regular, color: c.blue });
  ctx.y -= 11;
}

/**
 * The bands a model was priced in, each with its own estimate, and how the client's own
 * figure compares.
 *
 * Both halves are omitted for a prose estimate, which has one sizing and no figure of the
 * client's to compare against. Where an uploaded model is the input this is the section the
 * meeting is about - whether the bands are two sizings of one landscape, five consecutive
 * fiscal years, or three lower environments running side by side.
 *
 * The links sit under each table rather than in a column of it. A calculator.aws URL is
 * around a hundred characters; in a cell a quarter of the page wide it wraps to five
 * hyphenated fragments, and those hyphens are indistinguishable from part of the estimate
 * id. Below the table every link gets the full content width, stays copyable, and carries
 * the scenario label directly above it.
 */
function drawScenarios(ctx: PdfContext, result: CalculationResult, currency: string) {
  const sections = scenarioSections(result);
  const counted = sections.reduce((total, entry) => total + entry.scenarios.length, 0);
  const reported = typeof result.reportedMonthlyTotal === 'number' ? result.reportedMonthlyTotal : null;
  // One scenario is not a comparison, and alone it says nothing the cover has not already
  // said. Unchanged from when sizing pairs were the only scenarios that existed.
  if (counted < 2 && reported === null) return;

  if (counted > 1) sections.forEach((entry, index) => {
    section(ctx, entry.title, c.blueSoft, c.blue);
    text(ctx, entry.prose, { size: 8.4, color: c.muted, lineHeight: 12 });
    gap(ctx, 6);

    table(ctx, {
      columns: [
        { title: entry.labelColumn, width: CONTENT_WIDTH * 0.24 },
        { title: entry.basisColumn, width: CONTENT_WIDTH * 0.36 },
        { title: 'Monthly', width: CONTENT_WIDTH * 0.2 },
        { title: 'Annual (x12)', width: CONTENT_WIDTH * 0.2 },
      ],
      rows: entry.scenarios.map((scenario) => [
        scenario.label,
        safe(scenario.detail || '') || '-',
        money(scenario.monthly, currency),
        money(annual(scenario.monthly), currency),
      ]),
      headerColor: c.blue,
      stripe: true,
      alignRight: [2, 3],
      cellStyle: (_value, column) => (column === 2 ? { bold: true } : {}),
    });

    if (entry.total) {
      gap(ctx, 2);
      text(ctx, entry.total, { size: 8.8, isBold: true, lineHeight: 12 });
    }
    if (entry.saving) {
      gap(ctx, 2);
      text(ctx, entry.saving, { size: 8.8, isBold: true });
    }

    // Follows-height enough that the heading, the first label and its URL cannot be split
    // from one another by a page break.
    gap(ctx, 9, 56);
    text(ctx, entry.linksHeading, { size: 8.4, isBold: true });
    gap(ctx, 4);
    entry.scenarios.forEach((scenario) => {
      ensure(ctx, 26);
      text(ctx, scenario.label, { size: 8.4, isBold: true, indent: 10, lineHeight: 11 });
      // A priced scenario whose estimate never exported is a real outcome rather than a bug
      // to paper over: the run reached export_estimate and that call failed. Saying so is
      // the only way a reader can tell it from a link that failed to print.
      if (scenario.url) linkLine(ctx, scenario.url, 20);
      else text(ctx, 'No estimate link was exported for this scenario.', { size: 8, indent: 20, color: c.muted, lineHeight: 11 });
    });

    if (index < sections.length - 1) gap(ctx, 4);
  });

  if (reported !== null) {
    const ours = typeof result.monthlyTotal === 'number'
      ? result.monthlyTotal
      : sum((result.lineItems || []).map((item) => item.monthly));

    let sentence = `The uploaded model states ${money(reported, currency)} per month for the same landscape.`;
    if (typeof ours === 'number' && reported > 0) {
      const delta = ours - reported;
      sentence += Math.abs(delta) < 0.005
        ? ' This estimate agrees with it.'
        : ` This estimate is ${money(Math.abs(delta), currency)} (${Math.abs(Math.round((delta / reported) * 100))}%) ${delta > 0 ? 'higher' : 'lower'}.`
          + ' Published rates move, committed terms differ, and a model built earlier may omit resources - the notes below record what was assumed here.';
    }

    // Its own heading only where there are no scenarios to sit under. "Sizing scenarios"
    // over a lone sentence about the client's own spreadsheet, on an estimate that has no
    // sizings in it at all, was always the wrong label for this.
    if (counted < 2) section(ctx, 'Against your uploaded model', c.blueSoft, c.blue);
    else gap(ctx, 8);
    text(ctx, sentence, { size: 8.4, color: c.muted, lineHeight: 12 });
  }
}

function drawEnvironments(
  ctx: PdfContext,
  result: CalculationResult,
  options: CalculatorReportOptions,
  currency: string,
) {
  // Prefer the loop's own per-environment rollup; fall back to summing line items,
  // so an older estimate without the rollup still gets this section.
  const fromResult = (result.environments || []).filter((entry) => entry.name);
  const grouped = fromResult.length ? fromResult : deriveEnvironments(result, options);
  if (grouped.length < 1) return;

  const total = sum(grouped.map((entry) => entry.monthly));
  section(ctx, 'Cost by environment', c.blueSoft, c.blue);

  text(ctx, 'Each environment is priced for the hours it actually runs. Non-production shut down outside working hours costs proportionally less.', {
    size: 8.4, color: c.muted, lineHeight: 12,
  });
  gap(ctx, 6);

  table(ctx, {
    columns: [
      { title: 'Environment', width: CONTENT_WIDTH * 0.26 },
      { title: 'Runs', width: CONTENT_WIDTH * 0.18 },
      { title: 'Monthly', width: CONTENT_WIDTH * 0.2 },
      { title: 'Annual (x12)', width: CONTENT_WIDTH * 0.2 },
      { title: 'Share', width: CONTENT_WIDTH * 0.16 },
    ],
    rows: grouped.map((entry) => [
      entry.name,
      entry.hoursPerDay >= 24 ? '24h/day' : `${entry.hoursPerDay}h of 24h/day`,
      money(entry.monthly, currency),
      money(annual(entry.monthly), currency),
      typeof entry.monthly === 'number' && typeof total === 'number' && total > 0
        ? `${Math.round((entry.monthly / total) * 100)}%`
        : '-',
    ]),
    headerColor: c.blue,
    stripe: true,
    alignRight: [2, 3, 4],
    cellStyle: (_value, column) => (column === 2 ? { bold: true } : {}),
  });

  if (typeof total === 'number') {
    gap(ctx, 2);
    text(ctx, `Total across environments: ${money(total, currency)} per month, ${money(annual(total), currency)} per year.`, {
      size: 8.8, isBold: true,
    });
  }
}

/** Rolls line items up per environment when the loop did not report a summary. */
function deriveEnvironments(result: CalculationResult, options: CalculatorReportOptions) {
  const hoursFor = new Map(options.environmentHours.map((entry) => [entry.name.toLowerCase(), entry.hoursPerDay]));
  const buckets = new Map<string, { name: string; hoursPerDay: number; monthly: number | null }>();

  for (const item of result.lineItems || []) {
    const name = item.environment || 'Unassigned';
    const existing = buckets.get(name);
    const hours = item.hoursPerDay || hoursFor.get(name.toLowerCase()) || 24;
    const monthly = sum([existing?.monthly, item.monthly]);
    buckets.set(name, { name, hoursPerDay: hours, monthly });
  }
  return [...buckets.values()];
}

function drawLineItems(ctx: PdfContext, result: CalculationResult, currency: string) {
  const items = result.lineItems || [];
  if (!items.length) return;

  section(ctx, 'Detailed breakdown', c.purpleSoft, c.purple);

  // Grouped by environment so the document reads in the same order as the folders
  // on the calculator.aws link.
  const order = [...new Set(items.map((item) => item.environment || 'Unassigned'))];
  order.forEach((environment, index) => {
    const group = items.filter((item) => (item.environment || 'Unassigned') === environment);
    const groupTotal = sum(group.map((item) => item.monthly));

    if (order.length > 1) {
      // Space above each heading, more between groups than before the first, so the
      // environments read as separate blocks rather than one continuous table. The
      // follows-height keeps a heading from stranding itself above a page break.
      gap(ctx, index === 0 ? 2 : 12, 90);
      text(
        ctx,
        typeof groupTotal === 'number'
          ? `${environment}  —  ${money(groupTotal, currency)}/mo`
          : environment,
        { size: 10.2, isBold: true, color: c.purple },
      );
      gap(ctx, 5);
    }

    // "How it was calculated" replaces a bare Hours column: the workings already
    // state the rate, the hours and the quantity, which is what a client needs to
    // check a figure rather than trust it. Five columns is the most an A4 page can
    // carry without the configuration text shredding into single words.
    table(ctx, {
      columns: [
        { title: 'Service', width: CONTENT_WIDTH * 0.20 },
        { title: 'Configuration', width: CONTENT_WIDTH * 0.29 },
        { title: 'How it was calculated', width: CONTENT_WIDTH * 0.28 },
        { title: 'Monthly', width: CONTENT_WIDTH * 0.115 },
        { title: 'Annual', width: CONTENT_WIDTH * 0.115 },
      ],
      rows: group.map((item) => [
        item.service,
        item.detail || '-',
        item.workings || (item.timeBilled && item.hoursPerDay ? `${item.hoursPerDay}h/day` : 'usage-based'),
        money(item.monthly, currency),
        money(annual(item.monthly), currency),
      ]),
      headerColor: c.purple,
      stripe: true,
      alignRight: [3, 4],
      maxLinesPerCell: 4,
      cellStyle: (_value, column) => (column === 3 ? { bold: true } : column === 2 ? { color: c.muted } : {}),
    });
  });

  gap(ctx, 4);
  note(ctx, 'Monthly figures use AWS published on-demand rates for the stated region, multiplied by the hours each resource runs. Annual is the monthly cost x 12 — a projection for budgeting, not a quoted annual price, and it assumes the configuration does not change.');
}

function drawSavings(ctx: PdfContext, result: CalculationResult, currency: string) {
  const saving = schedulingSaving(result);
  // Nothing to say when everything runs 24/7 — the section would be a row of zeros.
  if (!saving.lines.length || typeof saving.monthly !== 'number' || saving.monthly <= 0) return;

  section(ctx, 'Saving from scheduled shutdown', c.greenSoft, c.green);

  text(ctx, `Running non-production on a schedule instead of 24/7 avoids about ${money(saving.monthly, currency)} per month, or ${money(annual(saving.monthly), currency)} per year.`, {
    size: 9.4, isBold: true, lineHeight: 14,
  });
  gap(ctx, 7);

  table(ctx, {
    columns: [
      { title: 'Service', width: CONTENT_WIDTH * 0.26 },
      { title: 'Environment', width: CONTENT_WIDTH * 0.2 },
      { title: 'Hours/day', width: CONTENT_WIDTH * 0.14 },
      { title: 'Billed monthly', width: CONTENT_WIDTH * 0.2 },
      { title: 'Avoided', width: CONTENT_WIDTH * 0.2 },
    ],
    rows: saving.lines.map((line) => [
      line.service,
      line.environment,
      `${line.hoursPerDay}h of 24h`,
      money(line.monthly, currency),
      money(line.saved, currency),
    ]),
    headerColor: c.green,
    stripe: true,
    alignRight: [3, 4],
    cellStyle: (_value, column) => (column === 4 ? { color: c.green, bold: true } : {}),
  });

  note(ctx, 'Projected saving against always-on, derived from the priced monthly cost and the configured hours per day. It is not a separate AWS quote. Only time-billed resources are counted: usage-based services such as S3 storage or per-request charges cost the same whether the environment is running or not.');
}

function drawAssumptions(ctx: PdfContext, result: CalculationResult) {
  const assumptions = (result.assumptions || []).filter(Boolean);
  const warnings = (result.warnings || []).filter(Boolean);

  section(ctx, 'Assumptions and exclusions', c.amberSoft, c.amber);

  if (assumptions.length) {
    text(ctx, 'Chosen on your behalf where the requirement did not say:', { size: 8.8, color: c.muted });
    gap(ctx, 5);
    numberedTable(ctx, 'Assumption', assumptions);
  } else {
    text(ctx, 'No defaults were assumed: every value in this estimate was specified.', { size: 8.8, color: c.muted });
    gap(ctx, 8);
  }

  if (warnings.length) {
    gap(ctx, 6, 80);
    text(ctx, 'Raised while building the estimate:', { size: 8.8, isBold: true, color: c.amber });
    gap(ctx, 5);
    numberedTable(ctx, 'Warning', warnings);
  }

  // The exclusions are their own thought, not a continuation of the table above it —
  // so it gets a clear break, and enough follows-height that the heading and its
  // four bullets never split across a page.
  gap(ctx, 10, 108);
  text(ctx, 'This estimate excludes:', { size: 9, isBold: true });
  gap(ctx, 4);
  [
    'Data transfer beyond what was specified above, including inter-region and internet egress.',
    'AWS Support plans, Marketplace software, and third-party licensing.',
    'Taxes, and any private pricing or Enterprise Discount Program terms on your account.',
    'One-off migration, professional services, and engineering effort.',
  ].forEach((line) => text(ctx, `-  ${line}`, { size: 8.6, indent: 10, color: c.muted, lineHeight: 14 }));

  gap(ctx, 12);
  note(ctx, `AWS recalculates live pricing when the estimate link is opened, so the figures here are correct as at ${formatDate(Date.now())} and may move with published price changes.`);

  // The link is the one thing a reader may need to act on, so it gets its own line
  // at full width rather than being clipped into the footer. Omitted entirely where no
  // estimate was saved — a heading over a blank line reads as a rendering fault.
  if (result.url) {
    // Named where it is one of several. On a five-year model this URL is one band out of
    // five, and calling it "the live estimate" unqualified would invite a reader to treat
    // the whole document as costing whatever that one link recalculates to.
    const named = (result.scenarios || []).find((entry) => entry.url && entry.url === result.url);
    gap(ctx, 10, 40);
    text(
      ctx,
      named
        ? `Live estimate for ${safe(named.label)} — open to review or edit in the AWS Pricing Calculator. The other links are listed with the scenarios above:`
        : 'Live estimate — open to review or edit in the AWS Pricing Calculator:',
      { size: 8.4, isBold: true },
    );
    gap(ctx, 3);
    linkLine(ctx, result.url, 0);
  }
}

function valueOrDash(value?: string): string {
  return value && value.trim() ? safe(value) : '';
}
