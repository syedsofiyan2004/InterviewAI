import { PDFDocument, PDFFont, PDFPage, rgb } from 'pdf-lib';

/**
 * Generic pdf-lib drawing primitives for report renderers.
 *
 * These are lifted verbatim from `mom-report.ts`, where they are module-private.
 * They are copied rather than moved: the existing MOM and interview renderers are
 * under a standing "do not touch" constraint because their output is signed off,
 * and a mechanical extraction still risks shifting a pixel. So this module is the
 * home for NEW renderers, and the two existing ones keep their own copies until
 * someone has a reason to re-verify their output.
 *
 * A4 portrait, in points.
 */

export const PAGE_WIDTH = 595.28;
export const PAGE_HEIGHT = 841.89;
export const MARGIN = 38;
export const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
export const BODY_SIZE = 9.2;
export const LINE_HEIGHT = 13;

export type PdfColor = ReturnType<typeof rgb>;
export type CellStyle = { color?: PdfColor; bold?: boolean };

export type PdfContext = {
  pdf: PDFDocument;
  page: PDFPage;
  regular: PDFFont;
  bold: PDFFont;
  y: number;
};

/** Shared palette, matching the other reports so the suite looks like one product. */
export const c = {
  ink: rgb(0.10, 0.16, 0.24),
  muted: rgb(0.42, 0.48, 0.56),
  border: rgb(0.86, 0.90, 0.94),
  blue: rgb(0.12, 0.36, 0.62),
  blueSoft: rgb(0.91, 0.96, 1),
  bluePale: rgb(0.96, 0.98, 1),
  green: rgb(0.12, 0.56, 0.36),
  greenSoft: rgb(0.86, 0.97, 0.91),
  red: rgb(0.72, 0.18, 0.20),
  redSoft: rgb(1, 0.91, 0.91),
  amber: rgb(0.72, 0.43, 0.06),
  amberSoft: rgb(1, 0.96, 0.84),
  purple: rgb(0.42, 0.28, 0.64),
  purpleSoft: rgb(0.94, 0.90, 0.99),
  gray: rgb(0.42, 0.48, 0.56),
  graySoft: rgb(0.96, 0.97, 0.98),
  white: rgb(1, 1, 1),
  row: rgb(0.98, 0.99, 1),
};

/**
 * Strips anything the standard PDF fonts cannot draw.
 *
 * pdf-lib throws on characters outside WinAnsi when using a StandardFont, and an
 * uploaded spreadsheet is a rich source of smart quotes, em dashes and stray
 * non-breaking spaces. Replacing them is better than crashing a report.
 */
export function safe(text: string): string {
  return String(text || '')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export function isUsefulText(value: string | undefined | null): boolean {
  const textValue = safe(value || '').toLowerCase();
  return !!textValue && textValue !== 'not specified' && textValue !== 'n/a';
}

export function valueOr(value: string | undefined | null, fallback = 'Not specified'): string {
  return isUsefulText(value) ? safe(value!) : fallback;
}

function splitWordToFit(word: string, font: PDFFont, size: number, width: number): string[] {
  if (font.widthOfTextAtSize(word, size) <= width) return [word];
  const parts: string[] = [];
  let part = '';
  for (const char of word) {
    const candidate = part + char;
    if (part && font.widthOfTextAtSize(`${candidate}-`, size) > width) {
      parts.push(`${part}-`);
      part = char;
    } else {
      part = candidate;
    }
  }
  if (part) parts.push(part);
  return parts;
}

export function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = safe(text).split(/\s+/).filter(Boolean).flatMap(word => splitWordToFit(word, font, size, width));
  if (!words.length) return ['Not specified'];
  const lines: string[] = [];
  let line = '';
  words.forEach(word => {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  });
  if (line) lines.push(line);
  return lines;
}

export function truncateWithEllipsis(line: string, font: PDFFont, size: number, width: number): string {
  const ellipsis = '...';
  let output = line.trim();
  while (output && font.widthOfTextAtSize(`${output}${ellipsis}`, size) > width) {
    output = output.slice(0, -1).trimEnd();
  }
  return output ? `${output}${ellipsis}` : ellipsis;
}

export function visibleLines(text: string, font: PDFFont, size: number, width: number, maxLines?: number): string[] {
  const lines = wrap(text, font, size, width);
  if (!maxLines || lines.length <= maxLines) return lines;
  const clipped = lines.slice(0, maxLines);
  clipped[clipped.length - 1] = truncateWithEllipsis(clipped[clipped.length - 1], font, size, width);
  return clipped;
}

/** Starts a new page when the requested height would run past the bottom margin. */
export function ensure(ctx: PdfContext, height: number) {
  if (ctx.y - height > MARGIN + 18) return;
  ctx.page = ctx.pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  ctx.y = PAGE_HEIGHT - MARGIN;
}

/**
 * Deliberate vertical space between blocks.
 *
 * Takes `follows` — the height of whatever comes next — so a gap can never leave a
 * heading orphaned at the foot of a page with its table overleaf. Without that, adding
 * whitespace to fix crowding just moves the crowding to a page break.
 */
export function gap(ctx: PdfContext, height: number, follows = 0) {
  ctx.y -= height;
  if (follows) ensure(ctx, follows);
}

export function text(
  ctx: PdfContext,
  value: string,
  options: { size?: number; isBold?: boolean; color?: PdfColor; indent?: number; lineHeight?: number } = {},
) {
  const size = options.size || BODY_SIZE;
  const font = options.isBold ? ctx.bold : ctx.regular;
  const indent = options.indent || 0;
  const lines = wrap(valueOr(value), font, size, CONTENT_WIDTH - indent);
  lines.forEach(line => {
    ensure(ctx, (options.lineHeight || LINE_HEIGHT) + 2);
    ctx.page.drawText(line, { x: MARGIN + indent, y: ctx.y, size, font, color: options.color || c.ink });
    ctx.y -= options.lineHeight || LINE_HEIGHT;
  });
}

/** Section heading: a tinted band with an accent rule down the left edge. */
export function section(ctx: PdfContext, title: string, fill: PdfColor, accent: PdfColor, minFollowingSpace = 72) {
  const titleLines = wrap(safe(title), ctx.bold, 11.5, CONTENT_WIDTH - 24);
  const height = Math.max(28, titleLines.length * 13 + 14);
  ensure(ctx, height + minFollowingSpace);
  ctx.y -= 10;
  ctx.page.drawRectangle({ x: MARGIN, y: ctx.y - height + 3, width: CONTENT_WIDTH, height, color: fill });
  ctx.page.drawRectangle({ x: MARGIN, y: ctx.y - height + 3, width: 4, height, color: accent });
  titleLines.forEach((line, index) => {
    ctx.page.drawText(line, { x: MARGIN + 12, y: ctx.y - 15 - index * 13, size: 11.5, font: ctx.bold, color: accent });
  });
  ctx.y -= height + 13;
}

export function note(ctx: PdfContext, value: string) {
  const lines = visibleLines(value, ctx.regular, 8, CONTENT_WIDTH - 22, 6);
  const height = Math.max(26, lines.length * 11 + 13);
  ensure(ctx, height + 8);
  const top = ctx.y;
  ctx.page.drawRectangle({ x: MARGIN, y: top - height, width: CONTENT_WIDTH, height, color: c.bluePale, borderColor: c.border, borderWidth: 1 });
  lines.forEach((line, index) => {
    ctx.page.drawText(line, { x: MARGIN + 11, y: top - 15 - index * 11, size: 8, font: ctx.regular, color: c.muted });
  });
  ctx.y -= height + 7;
}

/**
 * Paginating table. Repeats the header on every page it spills onto, wraps and
 * clips cell text, and stripes alternate rows.
 */
export function table(ctx: PdfContext, options: {
  columns: Array<{ title: string; width: number }>;
  rows: string[][];
  headerColor: PdfColor;
  stripe?: boolean;
  labelColumns?: number[];
  boldFirstColumn?: boolean;
  alignRight?: number[];
  cellStyle?: (value: string, column: number, row: number) => CellStyle;
  maxLinesPerCell?: number;
}) {
  const headerHeight = 23;
  const drawHeader = () => {
    let x = MARGIN;
    options.columns.forEach(column => {
      ctx.page.drawRectangle({ x, y: ctx.y - headerHeight, width: column.width, height: headerHeight, color: options.headerColor, borderColor: options.headerColor, borderWidth: 1 });
      ctx.page.drawText(column.title, { x: x + 7, y: ctx.y - 15, size: 8.3, font: ctx.bold, color: c.white });
      x += column.width;
    });
    ctx.y -= headerHeight;
  };

  ensure(ctx, 64);
  drawHeader();

  options.rows.forEach((row, rowIndex) => {
    const wrapped = row.map((cell, index) => visibleLines(
      valueOr(cell, ''),
      ctx.regular,
      8.4,
      options.columns[index].width - 14,
      options.maxLinesPerCell || 9,
    ));
    const height = Math.max(27, Math.max(...wrapped.map(lines => lines.length)) * 11 + 14);
    if (ctx.y - height < MARGIN + 28) {
      ctx.page = ctx.pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      ctx.y = PAGE_HEIGHT - MARGIN;
      drawHeader();
    }

    let cellX = MARGIN;
    wrapped.forEach((lines, index) => {
      const isLabel = options.labelColumns?.includes(index);
      const fill = isLabel ? c.graySoft : options.stripe && rowIndex % 2 === 1 ? c.row : c.white;
      const width = options.columns[index].width;
      ctx.page.drawRectangle({ x: cellX, y: ctx.y - height, width, height, color: fill, borderColor: c.border, borderWidth: 1 });
      const style = options.cellStyle?.(row[index] || '', index, rowIndex) || {};
      const bold = style.bold || isLabel || (options.boldFirstColumn !== false && index === 0);
      const font = bold ? ctx.bold : ctx.regular;
      lines.forEach((line, lineIndex) => {
        // Money columns read far better right-aligned against each other.
        const x = options.alignRight?.includes(index)
          ? cellX + width - 7 - font.widthOfTextAtSize(line, 8.4)
          : cellX + 7;
        ctx.page.drawText(line, { x, y: ctx.y - 15 - lineIndex * 11, size: 8.4, font, color: style.color || c.ink });
      });
      cellX += width;
    });

    ctx.y -= height;
  });

  // Trailing space so the next block does not butt against the last row. 8pt read
  // as a continuous slab when several tables follow one another.
  ctx.y -= 15;
}

/** Two-column field/value table. */
export function labelValueTable(ctx: PdfContext, rows: string[][]) {
  table(ctx, {
    columns: [
      { title: 'Field', width: CONTENT_WIDTH * 0.25 },
      { title: 'Details', width: CONTENT_WIDTH * 0.75 },
    ],
    rows,
    headerColor: c.gray,
    labelColumns: [0],
    stripe: true,
  });
}

/** Numbered list rendered as a table, for assumptions and similar. */
export function numberedTable(ctx: PdfContext, title: string, items: string[]) {
  table(ctx, {
    columns: [
      { title: '#', width: 26 },
      { title, width: CONTENT_WIDTH - 26 },
    ],
    rows: items.map((item, index) => [String(index + 1), item]),
    headerColor: c.gray,
    stripe: true,
    boldFirstColumn: false,
  });
}

/** Footer with product name and page number, applied to every page at the end. */
export function drawFooter(ctx: PdfContext, productName: string, trailing?: string) {
  ctx.pdf.getPages().forEach((page, index) => {
    page.drawRectangle({ x: MARGIN, y: 32, width: CONTENT_WIDTH, height: 1, color: c.border });
    page.drawText(safe(productName), { x: MARGIN, y: 18, size: 7.5, font: ctx.regular, color: c.muted });
    if (trailing) {
      const clipped = truncateWithEllipsis(safe(trailing), ctx.regular, 7, CONTENT_WIDTH - 150);
      page.drawText(clipped, { x: MARGIN + 130, y: 18, size: 7, font: ctx.regular, color: c.muted });
    }
    page.drawText(`Page ${index + 1}`, { x: PAGE_WIDTH - MARGIN - 38, y: 18, size: 7.5, font: ctx.regular, color: c.muted });
  });
}
