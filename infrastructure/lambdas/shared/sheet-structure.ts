/**
 * Structure detection for sheets nobody designed for us.
 *
 * The premise of the whole upload feature is that a client sends the sheet they
 * already have, not a filled-in template. That sheet does not put its header on row
 * 1, does not use one table per tab, and mixes tables, label/value pairs and prose
 * notes on the same tab. docs/COSEC_AWS_TCO_Model.xlsx is the worked example:
 *
 *   Server Inventory   rows 1-2 title + note, row 3 blank, row 4 HEADER, 5-115 data
 *   Assumptions        alternating one-cell section banners and label|value pairs
 *   Pricing Inputs     TWO tables (headers on rows 4 and 15) plus a label|value
 *                      block (19-29) plus free-text notes, all on one tab
 *
 * So "row 0 is the header" is wrong three different ways on one file. This module
 * finds the structure instead of assuming it, and reports what it found so the
 * caller can say so rather than silently guessing.
 */

/** A run of related rows within one sheet. */
export interface SheetBlock {
  kind: 'table' | 'keyvalue' | 'prose';
  /** Inclusive 0-based row indices into the sheet grid. */
  start: number;
  end: number;
  /** 0-based index of the header row, for `table` blocks only. */
  headerRow?: number;
}

/** Blank means every cell is empty after trimming. */
const isBlankRow = (row: string[]) => row.every((cell) => cell.trim() === '');

const nonEmpty = (row: string[]) => row.filter((cell) => cell.trim() !== '');

/** Purely a number, possibly with currency/percent/thousands decoration. */
const looksNumeric = (cell: string): boolean => {
  const cleaned = cell.replace(/[\s,$€£%]/g, '');
  return cleaned !== '' && Number.isFinite(Number(cleaned));
};

/**
 * Splits a sheet into blocks and classifies each one.
 *
 * Blank rows are the separator, which is what Excel authors actually use. A single
 * blank row inside a long table would otherwise cut it in two and leave the second
 * half's first data row misread as a header, so a segment that does not look like a
 * header of its own is absorbed into the table above it when the widths agree.
 */
export function findBlocks(rows: string[][]): SheetBlock[] {
  const segments: Array<{ start: number; end: number }> = [];
  let cursor: { start: number; end: number } | null = null;

  rows.forEach((row, index) => {
    if (isBlankRow(row)) {
      if (cursor) { segments.push(cursor); cursor = null; }
      return;
    }
    if (!cursor) cursor = { start: index, end: index };
    else cursor.end = index;
  });
  if (cursor) segments.push(cursor);

  const blocks: SheetBlock[] = [];
  for (const segment of segments) {
    const height = segment.end - segment.start + 1;
    const segmentRows = rows.slice(segment.start, segment.end + 1);

    // A single row with one populated cell is a title or a section banner. Calling
    // it a one-column table would invent a header for the rows that follow it.
    if (height === 1 && nonEmpty(segmentRows[0]).length <= 1) {
      blocks.push({ kind: 'prose', start: segment.start, end: segment.end });
      continue;
    }

    const headerRow = detectHeaderRow(segmentRows);
    if (headerRow !== -1) {
      const firstHeader = segment.start + headerRow;
      const repeatedHeaders = [firstHeader];
      for (let row = firstHeader + 1; row < segment.end; row++) {
        const candidate = rows[row] || [];
        const populated = nonEmpty(candidate);
        if (populated.length < 2) continue;
        const second = populated[1] || '';
        // Repeated section tables conventionally restart with an identifying column
        // (Name/Identifier). Requiring that structural signal prevents a transposed
        // metric row with many textual labels from being mistaken for another header.
        if (!/\b(?:name|identifier|required)\b/i.test(second)) continue;
        const following = rows.slice(row + 1, Math.min(segment.end + 1, row + 8));
        if (!following.length || headerScore(candidate, following) < 6) continue;
        repeatedHeaders.push(row);
      }
      repeatedHeaders.forEach((at, index) => {
        blocks.push({
          kind: 'table',
          start: index === 0 ? segment.start : at,
          end: repeatedHeaders[index + 1] === undefined ? segment.end : repeatedHeaders[index + 1] - 1,
          headerRow: at,
        });
      });
      continue;
    }

    // Continuation of the table above, separated only by a spacer row: same width,
    // no header of its own.
    const previous = blocks[blocks.length - 1];
    if (previous?.kind === 'table' && sameShape(rows, previous, segmentRows)) {
      previous.end = segment.end;
      continue;
    }

    if (isKeyValueBlock(segmentRows)) {
      blocks.push({ kind: 'keyvalue', start: segment.start, end: segment.end });
      continue;
    }

    blocks.push({ kind: 'prose', start: segment.start, end: segment.end });
  }

  return blocks;
}

/** True when a headerless segment has the same populated width as an existing table. */
function sameShape(rows: string[][], table: SheetBlock, segmentRows: string[][]): boolean {
  const widthOf = (row: string[]) => {
    let last = 0;
    row.forEach((cell, at) => { if (cell.trim() !== '') last = at + 1; });
    return last;
  };
  const tableWidth = widthOf(rows[table.headerRow ?? table.start]);
  if (tableWidth < 3) return false;
  const widths = segmentRows.map(widthOf).filter((w) => w > 0);
  if (!widths.length) return false;
  // Within one column of the table's width; ragged trailing columns are normal.
  return widths.every((w) => Math.abs(w - tableWidth) <= 1);
}

/**
 * Finds the header row inside one segment, or -1 if the segment is not a table.
 *
 * Only the first few rows are candidates: a header further down means the rows above
 * it belong to a different block, which segmentation has already handled. The test
 * is comparative rather than absolute — a header is text where the rows beneath it
 * are not. That distinguishes a real header from the first row of a text-only table.
 */
export function detectHeaderRow(segmentRows: string[][]): number {
  const limit = Math.min(3, segmentRows.length - 1);
  let best = -1;
  let bestScore = 0;

  for (let candidate = 0; candidate < limit; candidate++) {
    const dataRows = segmentRows.slice(candidate + 1);
    if (!dataRows.length) break;

    // A header below the first row of the block implies the rows above it are titles
    // or banners rather than data — so they must be narrower than it is. Without this
    // the scoring picks whichever row happens to sit above the most numeric rows,
    // which on a short text-heavy grid is the LAST row: a three-row disk list was
    // read with its third row as the header and its first two rows discarded.
    if (candidate > 0) {
      const populated = (row: string[]) => nonEmpty(row).length;
      const width = populated(segmentRows[candidate]);
      const above = segmentRows.slice(0, candidate);
      if (!above.every((row) => populated(row) < width)) continue;
    }

    const score = headerScore(segmentRows[candidate], dataRows);
    if (score > bestScore) { bestScore = score; best = candidate; }
  }

  // 6 is two clean text headers over numeric data, or three over mixed. Below that
  // the evidence is too thin to relabel someone's first data row as a header.
  return bestScore >= 6 ? best : -1;
}

/**
 * What shape a cell's value has, for telling a heading apart from a value.
 *
 * Three kinds is enough, because the question is only ever "does this cell look like
 * the ones beneath it": a number, a code (anything with a digit in it — `app01`,
 * `m6a.large`, `eu-west-1`, `Dec-2025`, `2 TB`), or a word.
 */
function cellKind(cell: string): 'number' | 'code' | 'word' {
  const text = cell.trim();
  if (looksNumeric(text)) return 'number';
  return /\d/.test(text) ? 'code' : 'word';
}

/**
 * True when a candidate row holds the same KIND of value as every column beneath it.
 *
 * The case this exists for is a sheet with no heading row at all:
 *
 *     app01 | Prod | m6i.large | Windows
 *     app02 | Prod | m6i.xlarge | Linux
 *
 * Every row here is text, so "the top row is text" — which is most of what the score
 * measures — is true of all of them, and the first machine gets relabelled as a
 * heading and dropped. A real heading is recognisable precisely because it does NOT
 * resemble its column: `Name` over `app01`, `vCPU` over `8`. Requiring every single
 * column to resemble its own keeps this conservative — one dissimilar column is
 * enough to accept the row as a header.
 */
function looksLikeItsOwnColumn(candidate: string[], dataRows: string[][]): boolean {
  const sample = dataRows.slice(0, 20);
  let compared = 0;

  for (let at = 0; at < candidate.length; at++) {
    const cell = candidate[at]?.trim();
    if (!cell) continue;
    const below = sample.map((row) => (row[at] ?? '').trim()).filter(Boolean);
    if (!below.length) continue;

    compared++;
    const kind = cellKind(cell);
    const matching = below.filter((value) => cellKind(value) === kind).length;
    // Majority, not unanimity: one stray blank-as-text or note in a column does not
    // make the row above it a heading.
    if (matching / below.length < 0.5) return false;
  }

  // Nothing comparable means no evidence either way, so do not veto.
  return compared >= 2;
}

function headerScore(candidate: string[], dataRows: string[][]): number {
  const cells = nonEmpty(candidate);
  // Two columns is a label/value pair, not a table header.
  if (cells.length < 3) return 0;

  // A row indistinguishable from the rows below it is one of them.
  if (looksLikeItsOwnColumn(candidate, dataRows)) return 0;

  let score = 0;
  for (const cell of cells) {
    if (looksNumeric(cell)) score -= 3;          // headers are not numbers
    else if (cell.length <= 60) score += 2;      // short text: header-shaped
    else score -= 2;                             // a sentence is a note, not a header
  }

  // The comparative half: a header sits above rows that are measurably more numeric
  // than it is. Without this a text table's first data row scores as well as a
  // header, and a numeric-looking header row would be rejected outright.
  const candidateNumeric = cells.filter(looksNumeric).length / cells.length;
  const sample = dataRows.slice(0, 20);
  const dataCells = sample.flatMap(nonEmpty);
  if (dataCells.length) {
    const dataNumeric = dataCells.filter(looksNumeric).length / dataCells.length;
    if (dataNumeric > candidateNumeric + 0.2) score += 4;
  }

  // Duplicate headers happen (two "Notes" columns) but a row of mostly identical
  // cells is a merged banner that survived deduplication.
  const distinct = new Set(cells.map((c) => c.toLowerCase())).size;
  if (distinct < Math.ceil(cells.length / 2)) score -= 6;

  return score;
}

/**
 * A label/value block: most rows populate exactly two cells, and the labels differ.
 *
 * This is how assumptions, rates and settings are written in practice — "Primary
 * region | eu-central-1" — and reading them is how the region, purchasing model and
 * FX rate in the example workbook become available at all. They appear in no table.
 */
export function isKeyValueBlock(segmentRows: string[][]): boolean {
  const populated = segmentRows.filter((row) => nonEmpty(row).length > 0);
  if (populated.length < 2) return false;

  const pairs = populated.filter((row) => {
    const cells = nonEmpty(row);
    if (cells.length !== 2) return false;
    // The label must be the leftmost populated cell; a value-then-label row is not
    // a key/value pair.
    const firstAt = row.findIndex((cell) => cell.trim() !== '');
    return firstAt <= 1 && cells[0].length <= 200;
  });

  return pairs.length / populated.length >= 0.6;
}

/** Extracts label/value pairs from a keyvalue block, in sheet order. */
export function readKeyValues(rows: string[][], block: SheetBlock): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  for (let r = block.start; r <= block.end; r++) {
    const cells = nonEmpty(rows[r] || []);
    if (cells.length === 2) out.push({ label: cells[0].trim(), value: cells[1].trim() });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Column matching
// ---------------------------------------------------------------------------

/** One logical field and the header text that indicates it. */
export interface FieldSpec {
  field: string;
  aliases: string[];
  /**
   * Header words that disqualify a column for this field. Essential where one sheet
   * carries several variants of the same measure: the example workbook has "Azure
   * vCPU" (source) and "Right-Sized vCPU" (recommendation) side by side, and without
   * exclusions whichever matched first would claim both meanings.
   */
  exclude?: string[];
}

/** Lowercase, punctuation to spaces, collapsed — so "Azure vCPU (source)" tokenises cleanly. */
export function normaliseHeader(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_/\\|,;:()\[\]{}."'`*#]+/g, ' ')
    .replace(/\s*-\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const tokens = (value: string) => normaliseHeader(value).split(' ').filter(Boolean);

/**
 * Scores one header cell against one alias. 0 means no match.
 *
 * Ordered strongest to weakest so an exact hit always beats a substring hit on a
 * longer header, which is what stops "Instance" from claiming "Right-Sized Instance
 * (Moderate)" when a plain "Instance" column also exists.
 */
export function scoreHeaderAlias(header: string, alias: string): number {
  const h = normaliseHeader(header);
  const a = normaliseHeader(alias);
  if (!h || !a) return 0;

  if (h === a) return 100;

  // Same words in a different order, or with a trailing unit: "disk gb" ~ "gb disk".
  const hTokens = tokens(h);
  const aTokens = tokens(a);
  if (hTokens.length === aTokens.length && aTokens.every((t) => hTokens.includes(t))) return 90;

  if (h.startsWith(`${a} `)) return 70;
  if (h.endsWith(` ${a}`)) return 65;

  // Every alias word present somewhere in the header. Longer aliases score higher so
  // a two-word alias beats a one-word alias that also fits.
  if (aTokens.every((t) => hTokens.includes(t))) return 50 + Math.min(aTokens.length, 4) * 2;

  if (h.includes(a) && a.length >= 4) return 30;
  return 0;
}

/**
 * A header match that scored at least this well is trustworthy enough to decide what
 * a whole table is FOR, not merely to fill a field.
 *
 * The boundary sits just above the substring tier (30). "Managed Services (€)" on a
 * monthly Azure spend table contains the word "services", so it matches the `service`
 * alias at 30 — enough to keep the value, nowhere near enough to conclude that each
 * row of that table is a resource to be priced.
 */
export const CONFIDENT_SCORE = 50;

/** What `matchColumnsScored` found: the assignment, plus how well each field matched. */
export interface ColumnMatch {
  columns: Record<string, number>;
  /** Alias score per assigned field. Compare against CONFIDENT_SCORE. */
  scores: Record<string, number>;
}

/**
 * Assigns header columns to fields, best match first.
 *
 * Greedy over the whole score matrix rather than per-field, so each column is
 * claimed once and each field claims once. Iterating fields in declaration order
 * instead would let an early field take a column that a later field matches far
 * better, which is precisely the "Azure vCPU"/"Right-Sized vCPU" collision.
 */
export function matchColumnsScored(header: string[], specs: FieldSpec[]): ColumnMatch {
  type Candidate = { field: string; column: number; score: number };
  const candidates: Candidate[] = [];

  header.forEach((cell, column) => {
    const text = cell.trim();
    if (!text) return;
    const normalised = normaliseHeader(text);
    for (const spec of specs) {
      if (spec.exclude?.some((word) => normalised.includes(normaliseHeader(word)))) continue;
      let best = 0;
      for (const alias of spec.aliases) best = Math.max(best, scoreHeaderAlias(text, alias));
      if (best > 0) candidates.push({ field: spec.field, column, score: best });
    }
  });

  // Deterministic: score desc, then column asc, then field name. Two columns with
  // equal claim resolve to the leftmost, and the result never depends on Map order.
  candidates.sort((a, b) => b.score - a.score || a.column - b.column || a.field.localeCompare(b.field));

  const assigned: Record<string, number> = {};
  const scores: Record<string, number> = {};
  const takenColumns = new Set<number>();
  for (const candidate of candidates) {
    if (assigned[candidate.field] !== undefined) continue;
    if (takenColumns.has(candidate.column)) continue;
    assigned[candidate.field] = candidate.column;
    scores[candidate.field] = candidate.score;
    takenColumns.add(candidate.column);
  }
  return { columns: assigned, scores };
}

/** The assignment alone, for callers that do not weigh confidence. */
export function matchColumns(header: string[], specs: FieldSpec[]): Record<string, number> {
  return matchColumnsScored(header, specs).columns;
}
