/**
 * Stacked sections: several logical tables stacked vertically inside ONE sheet.
 *
 * sheet-structure.ts already splits a sheet on BLANK rows, which is what an Excel author
 * uses to separate a title block from its header row and one key/value block from the next.
 * It cannot see the layout this module exists for, because that layout has no blank rows to
 * split on. docs/Rainbow_TCO_30Apr2026_v1_2.xlsx, sheet "Consolidated Master View", is the
 * worked example - 140 rows, one header, and seven group headings buried inside the data:
 *
 *     4   S.No | Server / Service | Hosting Env | Category | Region | Instance | Monthly ...
 *     5   CtrlS PRODUCTION (PDF Validated)
 *     6   1 | RAINDC03 | CtrlS -> AWS | EC2 - Prod | Hyderabad | m6i.xlarge | 226.67 | ...
 *     ..
 *     20  CtrlS NON-PRODUCTION (PDF Validated)
 *     21  15 | RCHECCDEC | CtrlS -> AWS | EC2 - Non-Prod (SAP) | Hyderabad | m6a.xlarge | ...
 *     ..
 *     31  DR - MUMBAI (PDF Validated)
 *
 * findBlocks returns ONE table block for rows 4-140 and detectHeaderRow correctly reports
 * row 4, after which every consumer treats rows 5-140 as data. Two things then go wrong, and
 * the second is the expensive one:
 *
 *  - Rows 5, 20, 31, 42, 73, 99, 114 and 126 are parsed as machines. A row whose only
 *    populated cell is "CtrlS NON-PRODUCTION (PDF Validated)" becomes a server with no size
 *    and no quantity, so it lands in the exclusions list as noise the reader has to explain.
 *  - Every non-production row is filed as production. Rows 21-30 are the QA/Dev/UAT estate
 *    and rows 32-41 are the Mumbai DR estate, and with the heading rows discarded there is
 *    nothing left to tell them apart from rows 6-19. Attributing a test estate and a
 *    warm-standby estate to production moves the figure the client budgets against, in the
 *    direction that loses the deal, which is why this is worth a module of its own.
 *
 * The same shape appears with a header PER section rather than one shared header: sheet
 * "HIS BOM - KareXpert" of the same workbook puts an EKS worker-node table at rows 4-9 and
 * then "Additional AWS Services (from KareXpert BOM)" at row 11 with its OWN header at row
 * 12, in which column I means "Est $/mo" where the first table's column I meant "Total
 * $/mo". So a section's header row is per-section when the sheet gives it one and inherited
 * from above when the sheet does not, and getting that backwards reads a total as a rate.
 *
 * Two deliberate limits on scope, both to keep this composable rather than clever:
 *
 *  - It runs BEFORE column mapping and knows nothing about AWS. Its input is the raw grid
 *    that shared/workbook.ts already produces, so it can be called from a reader that has
 *    not decided what any column means yet - which is the only point at which the section a
 *    row belongs to is still recoverable.
 *  - It returns TABLE sections only. A run of one-cell prose rows is not a section: sheet
 *    "AD & PACS Infrastructure" rows 41-50 are a numbered list of architecture decisions,
 *    one sentence per row, and calling each of them a section would hand a caller nine
 *    sections with one prose row each. Those rows are findBlocks' `prose` blocks and stay
 *    its business.
 *
 * Row indices in and out are 0-BASED indices into the array handed in, never the 1-based
 * row Excel shows. Mixing the two is a silent off-by-one that reads a header as data, so the
 * conversion is left to the caller that already does it for CellProvenance.row.
 */

/** A cell as any of the readers hand it over: text, a number, or nothing at all. */
export type SheetCell = string | number | null | undefined;

/**
 * The raw grid.
 *
 * Deliberately wider than shared/workbook.ts's `string[][]`, and deliberately not a parsed
 * row type. A caller holding a literal grid, a CSV split, or an exceljs row that still has
 * numbers and nulls in it can pass what it has; requiring `string[][]` would push a
 * conversion onto every caller and requiring a parsed row would defeat the purpose, since
 * the section a row belongs to has to be known before its columns can be interpreted.
 */
export type SheetRows = ReadonlyArray<ReadonlyArray<SheetCell>>;

/**
 * One logical table found inside a sheet.
 *
 * Both a range and an explicit row list are reported because the two callers want different
 * things. A reader written as `for (let r = headerRow + 1; r <= end; r++)` - which is how
 * readInventory and readMatrix are written today - wants the range. Anything that has to
 * account for every row it was given wants `dataRows`, because the range spans blank rows
 * and heading rows that are NOT data and must not be counted as skipped.
 */
export interface SheetSection {
  /**
   * The heading the sheet gave this section, or undefined when it named none.
   *
   * Undefined is the normal case and not a failure: a plain single-table sheet has one
   * unnamed section covering all of it.
   */
  label?: string;
  /** 0-based index of the row the label was read from, when there was one. */
  labelRow?: number;
  /**
   * 0-based index of this section's column-name row, or undefined when it has none.
   *
   * May sit ABOVE `labelRow`, and may be shared with earlier sections: "Consolidated Master
   * View" states its header once at row 4 and then names seven groups beneath it. May also
   * be absent entirely - "AD & PACS Infrastructure" rows 53-61 are label/value pairs under a
   * heading with no column names anywhere.
   */
  headerRow?: number;
  /** 0-based, inclusive. Always a populated row, never a blank or a heading. */
  firstDataRow: number;
  /** 0-based, inclusive. The LAST populated row, so trailing blanks are not claimed. */
  lastDataRow: number;
  /**
   * Every data row index in sheet order.
   *
   * Excludes blank rows, heading rows and header rows by construction. That exclusion is the
   * whole point: it is what stops "CtrlS NON-PRODUCTION (PDF Validated)" from reaching a
   * pricing loop as a machine.
   */
  dataRows: number[];
}

/** Collapses newlines and runs of whitespace; sheet cells routinely contain both. */
const cellText = (cell: SheetCell): string => {
  if (cell === null || cell === undefined) return '';
  return String(cell).replace(/\s+/g, ' ').trim();
};

/**
 * Purely a number, possibly with currency/percent/thousands decoration.
 *
 * Copied from sheet-structure.ts rather than imported because that copy takes `string` and
 * this module's cells are not strings yet. Whole-cell only, on purpose: "3-Yr No Upfront
 * (CSP) - always-on, 730 hrs/month" contains a number and is prose, and treating any cell
 * with a digit in it as numeric would classify most of a real assumptions tab as data.
 */
const looksNumeric = (text: string): boolean => {
  // Only symbols go in the class, never currency LETTERS. Spelling out EUR or USD here would
  // strip E, U, R, S and D out of every cell, so "USD" cleans to the empty string and "Dev" to
  // "ev" - and a section heading that cleans down to a bare number stops reading as a heading.
  // The rupee sign earns its place alongside the dollar: these are Indian client workbooks.
  const cleaned = text.replace(/[\s,$%€£₹]/g, '');
  return cleaned !== '' && Number.isFinite(Number(cleaned));
};

/**
 * The longest a cell can be and still read as a column name.
 *
 * Same 60 as sheet-structure.ts's headerScore, for the same reason: a column name has to fit
 * a column, and a sentence is a note. It is what keeps "Assumptions & Scope" row 5 of
 * docs/COSEC_AWS_TCO_Model.xlsx - a region name against 95 characters of explanation - from
 * being promoted to the header of the section beneath it.
 */
const HEADER_CELL_MAX = 60;

/** The least a header row can be: three columns. See headerShaped for why not two. */
const HEADER_MIN_COLUMNS = 3;

interface RowFacts {
  /** Non-empty cells anywhere in the row. Not a contiguous width: real header rows have gaps. */
  populated: number;
  /** Index of the first non-empty cell, or -1 for a blank row. */
  leftmost: number;
  /** Last non-empty index + 1, i.e. how far across the sheet this row reaches. */
  span: number;
  /** True when ANY populated cell is purely a number. */
  numeric: boolean;
  /** The populated cells' text, cleaned, in column order. */
  texts: string[];
}

function factsFor(row: ReadonlyArray<SheetCell> | undefined): RowFacts {
  const facts: RowFacts = { populated: 0, leftmost: -1, span: 0, numeric: false, texts: [] };
  // Length is read off the row itself rather than a sheet width, because a ragged grid is
  // normal: a CSV line with fewer commas and an exceljs row that ends early both arrive
  // short, and indexing past the end must read as empty rather than throw.
  const width = row?.length ?? 0;
  for (let column = 0; column < width; column++) {
    const text = cellText(row?.[column]);
    if (text === '') continue;
    facts.populated++;
    if (facts.leftmost === -1) facts.leftmost = column;
    facts.span = column + 1;
    facts.texts.push(text);
    if (looksNumeric(text)) facts.numeric = true;
  }
  return facts;
}

/**
 * The column the sheet's tables start in.
 *
 * Needed because a heading is written flush with the table it introduces, and "flush" is not
 * always column A: "Consolidated Summary" of the Rainbow workbook leaves column A empty
 * throughout and starts both its headings and its data in column B. Taken as the minimum
 * over rows with more than one populated cell, so the data rows define the edge and a
 * stray value cannot move it.
 */
function tableLeftEdge(facts: RowFacts[]): number {
  let edge = Number.POSITIVE_INFINITY;
  for (const row of facts) {
    if (row.populated > 1) edge = Math.min(edge, row.leftmost);
  }
  if (Number.isFinite(edge)) return edge;
  // No multi-cell row anywhere. Fall back to the leftmost populated column of any row so a
  // sheet of nothing but headings still classifies them as headings rather than as data.
  for (const row of facts) {
    if (row.populated > 0) edge = Math.min(edge, row.leftmost);
  }
  return Number.isFinite(edge) ? edge : 0;
}

/**
 * True when this row's lone populated cell reads as a section heading.
 *
 * Three tests, each guarding a different way a lone cell gets there:
 *
 *  1. Exactly one populated cell. sheet-structure.ts makes the same call in the same words -
 *     "a single row with one populated cell is a title or a section banner" - and the merged
 *     banners in the real files are exactly this shape, because shared/workbook.ts blanks
 *     every non-anchor cell of a merged range, so A5:J5 arrives as one cell and nine empties.
 *  2. That cell is at or left of the table's own first column. A merged range running DOWN a
 *     column leaves its slave rows with the label column blank and a value stranded further
 *     right, and requirement is that such a row does not cut a data block in two. A heading
 *     indented past the data it introduces has never been written by anyone.
 *  3. The cell is not itself a number. A stranded "3000" or "730" is a measurement that lost
 *     its neighbours, and believing it names a section files every row beneath it under the
 *     heading "3000".
 */
function bannerShaped(facts: RowFacts, leftEdge: number): boolean {
  return facts.populated === 1 && facts.leftmost <= leftEdge && !facts.numeric;
}

/**
 * True when this row reads as a row of column names.
 *
 * Written as four independent vetoes rather than a score because the question here is only
 * ever "could this be a header", with position deciding whether it IS one. The scoring in
 * sheet-structure.ts's headerScore answers a harder question - which of the first three rows
 * of a block is the header - and reusing it would import a >= 3-column-wide comparison
 * against the rows beneath, which is unavailable at the point a repeated header has to be
 * recognised from its text alone.
 */
function headerShaped(facts: RowFacts): boolean {
  // Two populated cells is a label/value pair, not a table header. Without this, "AD & PACS
  // Infrastructure" row 53 - "Total AD Objects | 3,374 (users + computers)" - becomes the
  // header of the label/value block it is the first line of, and that block loses a row.
  if (facts.populated < HEADER_MIN_COLUMNS) return false;
  // A number in the row means the row states a measurement. Column names do not.
  if (facts.numeric) return false;
  // A sentence is a note or a value, not a column name.
  if (facts.texts.some((text) => text.length > HEADER_CELL_MAX)) return false;
  // Mostly identical cells are a merged banner that survived blanking - which happens when
  // exceljs cannot classify a sparse cell and shared/workbook.ts falls through to keeping
  // its value. Same guard, and same halfway threshold, as headerScore: genuinely duplicated
  // column names do occur (two "Notes" columns), a row of one repeated string does not.
  const distinct = new Set(facts.texts.map((text) => text.toLowerCase())).size;
  return distinct >= Math.ceil(facts.populated / 2);
}

/** A header row's identity, for recognising the same header repeated further down. */
const headerSignature = (facts: RowFacts): string => facts.texts.join(' ').toLowerCase();

type RowKind = 'blank' | 'banner' | 'header' | 'data';

/**
 * What each row is, decided before any section is built.
 *
 * Separated from the scan below because both banners and headers have to be recognised as
 * part of a RUN, and a row-at-a-time decision gets each of them wrong:
 *
 *  - A heading followed by its own subtitle is two one-cell rows and ONE heading. Deciding
 *    row by row makes the subtitle a second section, and "Server Inventory" row 2 - 95
 *    characters describing the export - becomes a section name. It is also why the label is
 *    taken from the FIRST row of a run: "AWS Pricing Inputs" over "eu-central-1 (Frankfurt)
 *    unless noted...", heading first and explanation second, the order everyone writes in.
 *  - Only the first row of a run of header-shaped rows can be a header, because a table does
 *    not state its column names twice in succession. Without this a table with no numbers in
 *    it anywhere - Server | Environment | Region | Notes over "web-01 | Prod | Hyderabad | AD
 *    replica" - has EVERY row pass the header tests, every row is taken for a header, no row
 *    is left to be data, and the sheet comes back with no sections at all. A genuine
 *    two-row header is the cost: its second row reads as data here, which is the caller's
 *    composeHeader problem and not this module's.
 */
function classify(facts: RowFacts[], leftEdge: number): RowKind[] {
  // Shape alone, ignoring position: a banner can never be header-shaped, because one populated
  // cell cannot meet the three-column minimum.
  const shaped = facts.map((row) => headerShaped(row));
  return facts.map((row, index) => {
    if (row.populated === 0) return 'blank';
    if (bannerShaped(row, leftEdge)) return 'banner';
    // Tested against the row above's SHAPE rather than its decided kind, so that in a run of
    // four such rows the second, third and fourth are all data rather than alternating.
    if (shaped[index] && !shaped[index - 1]) return 'header';
    return 'data';
  });
}

/** A section being accumulated; its header is resolved at close time. See closeSection. */
interface OpenSection {
  label?: string;
  labelRow?: number;
  headerRow?: number;
  dataRows: number[];
  /** Populated width of the widest data row, for the header-fit test in closeSection. */
  span: number;
}

/**
 * Whether a header row from further up the sheet can be reused for this section.
 *
 * The case it must allow: "Consolidated Master View" states its ten columns once at row 4
 * and every one of its seven groups is read against them, including the totals group at rows
 * 127-132, whose figures sit in the "Monthly (USD)" and "Annual (USD)" columns exactly as
 * the machines' do.
 *
 * The case it must refuse: "Pricing Inputs" of the COSEC workbook puts a seven-column
 * instance rate table at rows 17-18 and then "STORAGE, BACKUP, DRS, NETWORK RATES" at row 21
 * over eleven two-cell label/value rows. Handing those rows the rate table's header maps
 * "EBS gp3 storage rate ($/GB-month)" onto the column named "Instance Type" and its 0.0952
 * onto "vCPU", which is a plausible-looking read of a rate as a core count.
 *
 * A section reaching less than half as far across the sheet as the header is answering a
 * different set of columns, so the header is dropped and the section reports none. Half
 * rather than exact, because a totals row legitimately fills only its money columns.
 */
function headerFits(sectionSpan: number, headerSpan: number): boolean {
  return sectionSpan * 2 > headerSpan;
}

/**
 * Reads the stacked sections out of a raw sheet grid, in sheet order.
 *
 * A sheet that names no sections comes back as exactly ONE section with no label covering
 * every data row, because that is the overwhelmingly common case and a reader that split it
 * would be unusable. An empty sheet, and a sheet of nothing but headings, come back as no
 * sections at all - there is no data row for one to cover, and inventing a section with an
 * empty range only pushes the same emptiness onto the caller.
 */
export function readSectionStack(rows: SheetRows): SheetSection[] {
  const facts = rows.map(factsFor);
  const leftEdge = tableLeftEdge(facts);
  const kinds = classify(facts, leftEdge);

  const sections: SheetSection[] = [];
  /** Signatures of header rows already accepted, so the same header repeated is recognised. */
  const seenHeaders = new Set<string>();
  /** The header row in force, which later sections inherit unless they state their own. */
  let currentHeader: number | undefined;
  /** A heading read but not yet claimed by any data row. */
  let pendingLabel: { text: string; row: number } | undefined;
  let open: OpenSection | undefined;

  /**
   * Publishes the open section, or discards it when no data row ever arrived.
   *
   * Discarding is the answer to a heading with nothing under it, and that is not a corner
   * case: "Consolidated Master View" row 114 reads "REMOVED - PACS & AD out of scope" with
   * eleven blank rows after it, "Pricing Inputs" row 19 is a footnote inside a section, and
   * "Azure Baseline" row 23 is a footnote at the end of one. Emitting them as sections with
   * no rows makes every caller handle an empty range to gain nothing, and the guarantee that
   * actually matters is elsewhere: a heading row is never a data row of its neighbour.
   */
  const closeSection = (): void => {
    if (!open) return;
    const closing = open;
    open = undefined;
    if (!closing.dataRows.length) return;
    const headerRow = closing.headerRow !== undefined
      && headerFits(closing.span, facts[closing.headerRow]?.span ?? 0)
      ? closing.headerRow
      : undefined;
    sections.push({
      label: closing.label,
      labelRow: closing.labelRow,
      headerRow,
      firstDataRow: closing.dataRows[0],
      lastDataRow: closing.dataRows[closing.dataRows.length - 1],
      dataRows: closing.dataRows,
    });
  };

  for (let index = 0; index < kinds.length; index++) {
    const kind = kinds[index];

    // A blank row is a separator, never a boundary. "Consolidated Master View" puts three
    // blank rows inside its totals group and eleven before it; ending a section on a blank
    // would file the grand total as a section of its own with no heading to explain it.
    if (kind === 'blank') continue;

    if (kind === 'banner') {
      // Only the first row of a run of headings names the section; the rest are its subtitle.
      if (kinds[index - 1] !== 'banner') {
        closeSection();
        pendingLabel = { text: facts[index].texts[0], row: index };
      }
      continue;
    }

    if (kind === 'header') {
      const signature = headerSignature(facts[index]);
      const repeated = seenHeaders.has(signature);
      // Position decides, and only a REPEAT overrides it. A header-shaped row arriving while a
      // section already has data rows is usually not a header at all: `["", "TOTAL", "-", "-"]`
      // is three short non-numeric cells and passes every shape test, and promoting it would
      // cut a table in half and hand the rows below it no header. So a mid-table row is taken
      // as a header only when the sheet has already used that exact row of names above - which
      // is the restated-header case, where a sheet repeats "Server Name | vCPU | RAM | Disk"
      // partway down and reading it as data invents a machine called "Server Name".
      //
      // The other way a section legitimately states its own header is announced by a banner,
      // which has already closed the previous section by the time the header row is reached, so
      // "AD & PACS Infrastructure" rows 64 and 91 and "HIS BOM - KareXpert" rows 4 and 12 all
      // arrive here with nothing open and are accepted on position alone.
      if (!open?.dataRows.length || repeated) {
        if (repeated) closeSection();
        seenHeaders.add(signature);
        currentHeader = index;
        continue;
      }
      // Falls through and is recorded as data.
    }

    if (!open) {
      open = {
        label: pendingLabel?.text,
        labelRow: pendingLabel?.row,
        headerRow: currentHeader,
        dataRows: [],
        span: 0,
      };
      // Consumed: the next section starts unlabelled unless the sheet names it. Leaving it
      // set would carry "CtrlS PRODUCTION" onto the non-production group beneath it, which is
      // the exact misattribution this module exists to prevent.
      pendingLabel = undefined;
    }
    open.dataRows.push(index);
    open.span = Math.max(open.span, facts[index].span);
  }

  closeSection();
  return sections;
}
