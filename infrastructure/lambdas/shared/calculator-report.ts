import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { CalculationResult, EnvironmentHours } from '../../schema/calculator.js';
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
  // at full width rather than being clipped into the footer.
  gap(ctx, 10, 40);
  text(ctx, 'Live estimate — open to review or edit in the AWS Pricing Calculator:', { size: 8.4, isBold: true });
  gap(ctx, 3);
  text(ctx, result.url, { size: 8, color: c.blue, lineHeight: 12 });
}

function valueOrDash(value?: string): string {
  return value && value.trim() ? safe(value) : '';
}
