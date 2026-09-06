/**
 * Lossless workbook evidence for the AgentCore calculator agent.
 *
 * This is the ONLY representation of a customer workbook that reaches Claude, and
 * it is deliberately semantic-free: sheets, rows, cell addresses, headers, raw and
 * formatted values, formulas. No Calculator service codes, no Calculator field IDs,
 * no adapter output. What any of it *means* for AWS Pricing Calculator is decided by
 * Claude talking to the Pricing Calculator MCP, never here.
 *
 * Two things this file is careful NOT to be:
 *
 *  1. A second workbook parser. `WorkbookIR` (shared/workbook.ts) already captures
 *     every non-empty cell with its a1 address, raw value, formatted value, formula,
 *     data type and merge anchor, and the route already persists it to S3. This
 *     module is a *projection* of that IR, so there is exactly one place where a
 *     spreadsheet becomes data.
 *
 *  2. A truncator. The predecessor built evidence with `sheets.slice(0, 300)` and
 *     then rendered it with `EVIDENCE_ROW_LIMIT = 200`, so a workbook with a
 *     thousand billable rows reached Claude as a few hundred. Claude then quite
 *     correctly asked for values whose evidence had been thrown away before it ever
 *     looked, which is where the "missing fields" and dash-filled results came from.
 *     Context pressure is solved by chunking to S3 and letting the agent fetch more,
 *     never by dropping rows. There is no row cap in this file.
 */

import type { CellIR, WorkbookIR } from './workbook.js';

// ─── Evidence shape ───────────────────────────────────────────────────────────

export interface EvidenceCell {
  /** A1-style address, e.g. "C14". The citation the agent quotes back. */
  address: string;
  column?: number;
  /** Column header for this cell, where a header row could be identified. */
  header?: string;
  raw: unknown;
  formatted: string;
  /** Present only where the cell is a formula, for audit of derived quantities. */
  formula?: string;
  /**
   * Value inherited from an enclosing merged range — a section banner or a
   * spanned column group. Without this a row under a merged "Production / FY27"
   * banner reads as having no environment at all.
   */
  inheritedHeader?: string;
}

export interface EvidenceRow {
  rowNumber: number;
  /** Stable citation id, e.g. "Inventory!14". Used by evidence accounting. */
  rowId: string;
  cells: EvidenceCell[];
}

export interface WorkbookEvidenceSheet {
  name: string;
  rowCount: number;
  /** Rows identified as header rows, so the agent can orient itself in the sheet. */
  headerRows: number[];
  rows: EvidenceRow[];
}

export interface WorkbookEvidence {
  version: '1.0';
  fileName: string;
  fileHash: string;
  sheets: WorkbookEvidenceSheet[];
  userInstructions: string[];
  accounting: {
    totalSheets: number;
    totalRows: number;
    totalNonEmptyCells: number;
    evidenceChunkCount: number;
  };
}

// ─── Index and chunks ─────────────────────────────────────────────────────────

export interface EvidenceChunkRef {
  chunkId: string;
  sheet: string;
  rowsFrom: number;
  rowsTo: number;
  environmentHints: string[];
  fiscalPeriodHints: string[];
  serviceHints: string[];
  s3Key: string;
  /** Rows in this chunk that look like billable evidence (see classifyRow). */
  costRelevantRowCount: number;
}

export interface WorkbookEvidenceIndex {
  version: '1.0';
  fileName: string;
  fileHash: string;
  sheets: Array<{
    name: string;
    rowCount: number;
    nonEmptyCellCount: number;
    /** Header row numbers detected in this sheet, for orientation. */
    headerRows: number[];
  }>;
  detectedEnvironments: string[];
  detectedFiscalPeriods: string[];
  serviceHints: string[];
  userInstructions: string[];
  accounting: {
    totalRows: number;
    totalNonEmptyCells: number;
    totalChunks: number;
    costRelevantRows: number;
  };
  chunks: EvidenceChunkRef[];
}

// ─── Hint vocabularies ────────────────────────────────────────────────────────
//
// Everything below is a ROUTING hint: it decides which chunk the agent is offered
// first and how chunks are labelled. None of it is authoritative and none of it is
// allowed to change what the agent configures. Getting a hint wrong costs an extra
// get_workbook_evidence call; it can never silently mis-price anything.

const ENVIRONMENT_PATTERNS: Array<[RegExp, string]> = [
  [/\bprod(uction)?\b/i, 'Production'],
  [/\bnon[- ]?prod(uction)?\b/i, 'Non-Production'],
  [/\bdev(elopment)?\b/i, 'Development'],
  [/\b(test|testing)\b/i, 'Test'],
  [/\buat\b/i, 'UAT'],
  [/\bqa\b/i, 'QA'],
  [/\bstag(e|ing)\b/i, 'Staging'],
  [/\bpre[- ]?prod\b/i, 'Pre-Production'],
  [/\b(dr|disaster recovery)\b/i, 'DR'],
  [/\bsandbox\b/i, 'Sandbox'],
];

const FISCAL_PATTERNS: RegExp[] = [
  /\bFY\s?'?\d{2,4}(?:\s?[-/]\s?\d{2,4})?\b/i,
  /\b20\d{2}\s?[-/]\s?(?:20)?\d{2}\b/,
  /\bQ[1-4]\s?(?:FY)?\s?'?\d{2,4}\b/i,
  /\b(?:year|yr)\s?[1-5]\b/i,
];

/**
 * Coarse "this row mentions an AWS service" signal. Intentionally a short list of
 * families rather than a service catalogue: the authoritative service resolution is
 * `search_services` / `get_service_fields` on the MCP. Adding names here must never
 * become a substitute for asking the MCP.
 */
const SERVICE_HINT_PATTERNS: Array<[RegExp, string]> = [
  [/\bec2\b|\belastic compute\b/i, 'EC2'],
  [/\bs3\b|\bsimple storage\b/i, 'S3'],
  [/\brds\b|\baurora\b/i, 'RDS'],
  [/\bdynamo\s?db\b/i, 'DynamoDB'],
  [/\blambda\b/i, 'Lambda'],
  [/\bfargate\b|\becs\b|\beks\b/i, 'Containers'],
  [/\bsage\s?maker\b/i, 'SageMaker'],
  [/\bbedrock\b/i, 'Bedrock'],
  [/\bmemory\s?db\b/i, 'MemoryDB'],
  [/\belasti\s?cache\b|\bredis\b/i, 'ElastiCache'],
  [/\bevent\s?bridge\b/i, 'EventBridge'],
  [/\bcloud\s?front\b/i, 'CloudFront'],
  [/\bebs\b|\bgp[23]\b|\bio[12]\b/i, 'EBS'],
  [/\befs\b|\bfsx\b/i, 'File storage'],
  [/\bvpc\b|\bnat gateway\b|\btransit gateway\b/i, 'Networking'],
  [/\bload balanc|\balb\b|\bnlb\b|\belb\b/i, 'Load balancing'],
  [/\bamazon\s?mq\b|\bsqs\b|\bsns\b|\bkafka\b|\bmsk\b/i, 'Messaging'],
  [/\bredshift\b|\bathena\b|\bglue\b|\bemr\b/i, 'Analytics'],
  [/\bcloud\s?watch\b|\bx-?ray\b/i, 'Observability'],
  [/\bbackup\b/i, 'Backup'],
  [/\bdata\s?transfer\b|\begress\b/i, 'Data transfer'],
];

const matchAll = <T>(text: string, table: Array<[RegExp, T]>): T[] =>
  table.filter(([pattern]) => pattern.test(text)).map(([, value]) => value);

// ─── Header detection ─────────────────────────────────────────────────────────

const NUMERIC = /^-?[\d,]+(?:\.\d+)?%?$/;

/**
 * Best-effort header rows for a sheet.
 *
 * A row is a header when it has at least two non-empty cells, ALL of them
 * non-numeric, and the next non-empty row carries at least one number.
 *
 * The "all non-numeric" part is load-bearing rather than fussy. A first attempt used
 * "mostly non-numeric" (≥60%), which classifies a perfectly ordinary inventory row —
 * `Amazon EC2 | m5.xlarge | 1`, two text cells and one number, 67% — as a header, and
 * then attributes no header to it at all. Requiring the following row to contain a
 * number is what separates `Service | Instance type | Quantity` from the data beneath it.
 *
 * A sheet where nothing qualifies simply yields cells without `header`; the agent
 * still has the address, the raw value and any merged banner. The header is context
 * for Claude, never a schema, so a miss costs clarity and never correctness.
 */
function detectHeaderRows(rowsByNumber: Map<number, CellIR[]>): Set<number> {
  const ordered = [...rowsByNumber.keys()].sort((a, b) => a - b);
  const filledOf = (rowNumber: number) =>
    (rowsByNumber.get(rowNumber) ?? []).filter((cell) => cell.formatted.trim() !== '');

  const headers = new Set<number>();
  for (let index = 0; index < ordered.length; index++) {
    const filled = filledOf(ordered[index]);
    if (filled.length < 2) continue;
    if (filled.some((cell) => NUMERIC.test(cell.formatted.trim()))) continue;

    const next = ordered[index + 1];
    if (next === undefined) continue;
    if (!filledOf(next).some((cell) => NUMERIC.test(cell.formatted.trim()))) continue;

    headers.add(ordered[index]);
  }
  return headers;
}

/** The nearest header row at or above `rowNumber`, if any. */
function headerRowFor(rowNumber: number, headerRows: number[]): number | undefined {
  let best: number | undefined;
  for (const candidate of headerRows) {
    if (candidate < rowNumber && (best === undefined || candidate > best)) best = candidate;
  }
  return best;
}

// ─── Row classification for evidence accounting ───────────────────────────────

export type RowClass = 'cost-relevant' | 'context' | 'decorative';

/**
 * Classifies a row for Phase 3 accounting.
 *
 * `cost-relevant` — carries a quantity next to a label, or names an AWS service.
 *   These are the rows that must each end up configured, excluded, unsupported or
 *   unresolved, with no silent remainder.
 * `context`       — text only, no quantity: section titles, notes, assumptions.
 *   Real evidence the agent may well use, but not itself a billable line.
 * `decorative`    — nothing but a single spanned/merged label, or an empty shell.
 *   Formatting, not evidence, and explicitly not counted as cost evidence.
 */
export function classifyRow(cells: EvidenceCell[]): RowClass {
  const filled = cells.filter((cell) => cell.formatted.trim() !== '');
  if (filled.length === 0) return 'decorative';

  const text = filled.map((cell) => cell.formatted).join(' ');
  const numeric = filled.filter((cell) => NUMERIC.test(cell.formatted.trim()));
  const textual = filled.filter((cell) => !NUMERIC.test(cell.formatted.trim()));

  if (numeric.length > 0 && textual.length > 0) return 'cost-relevant';
  if (SERVICE_HINT_PATTERNS.some(([pattern]) => pattern.test(text))) return 'cost-relevant';
  // A lone merged banner spanning a row is layout, not evidence.
  if (filled.length === 1 && filled[0].inheritedHeader !== undefined) return 'decorative';
  if (textual.length > 0) return 'context';
  return 'decorative';
}

// ─── Build evidence from the workbook IR ─────────────────────────────────────

export interface BuildEvidenceInput {
  ir: WorkbookIR;
  userInstructions?: string[];
}

/**
 * Projects the lossless `WorkbookIR` into agent-facing evidence.
 *
 * Every non-empty cell in the IR appears in the output exactly once. There is no
 * row limit, no sheet limit and no cell limit — if a workbook is too large for one
 * model message it gets chunked (see `chunkEvidence`), never trimmed.
 */
export function buildWorkbookEvidence(input: BuildEvidenceInput): WorkbookEvidence {
  const { ir } = input;

  // Merged ranges: a cell inside a range that is not the anchor inherits the
  // anchor's text. The IR already records mergedRange/mergeAnchor per cell, and
  // records the value only on the anchor (see readWorkbookDocument), so the anchor's
  // formatted value has to be looked up rather than read off the cell itself.
  const anchorValues = new Map<string, string>();
  for (const sheet of ir.sheets) {
    for (const cell of sheet.cells) {
      if (cell.mergeAnchor && cell.a1 === cell.mergeAnchor) {
        anchorValues.set(`${sheet.name}!${cell.a1}`, cell.formatted);
      }
    }
  }

  const sheets: WorkbookEvidenceSheet[] = ir.sheets.map((sheetIr) => {
    const rowsByNumber = new Map<number, CellIR[]>();
    for (const cell of sheetIr.cells) {
      const bucket = rowsByNumber.get(cell.row);
      if (bucket) bucket.push(cell);
      else rowsByNumber.set(cell.row, [cell]);
    }

    const headerRows = detectHeaderRows(rowsByNumber);
    const headerRowList = [...headerRows];

    const headerTextAt = (rowNumber: number, column: number): string | undefined => {
      const value = rowsByNumber.get(rowNumber)?.find((cell) => cell.col === column)?.formatted;
      return value && value.trim() !== '' ? value : undefined;
    };

    const rows: EvidenceRow[] = [...rowsByNumber.keys()]
      .sort((a, b) => a - b)
      .map((rowNumber) => {
        const headerRow = headerRows.has(rowNumber) ? undefined : headerRowFor(rowNumber, headerRowList);
        const cells: EvidenceCell[] = rowsByNumber.get(rowNumber)!
          .sort((a, b) => a.col - b.col)
          .map((cell) => {
            const inherited = cell.mergeAnchor && cell.a1 !== cell.mergeAnchor
              ? anchorValues.get(`${sheetIr.name}!${cell.mergeAnchor}`)
              : undefined;
            return {
              address: cell.a1,
              column: cell.col,
              ...(headerRow !== undefined ? { header: headerTextAt(headerRow, cell.col) } : {}),
              raw: cell.raw,
              formatted: cell.formatted,
              ...(cell.formula ? { formula: cell.formula } : {}),
              ...(inherited ? { inheritedHeader: inherited } : {}),
            } as EvidenceCell;
          });
        return { rowNumber, rowId: `${sheetIr.name}!${rowNumber}`, cells };
      });

    return {
      name: sheetIr.name,
      rowCount: sheetIr.rowCount,
      headerRows: headerRowList.sort((a, b) => a - b),
      rows,
    };
  });

  const totalRows = sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0);

  return {
    version: '1.0',
    fileName: ir.fileName,
    fileHash: ir.fileHash,
    sheets,
    userInstructions: input.userInstructions ?? [],
    accounting: {
      totalSheets: sheets.length,
      totalRows,
      totalNonEmptyCells: ir.nonEmptyCellCount,
      // Filled in by chunkEvidence, which is what decides the count.
      evidenceChunkCount: 0,
    },
  };
}

// ─── Chunking ─────────────────────────────────────────────────────────────────

/**
 * Serialized byte budget for one chunk.
 *
 * Sized so a whole chunk can be returned by `get_workbook_evidence` in a single
 * tool result without the agent having to page within a chunk. It is a *packing*
 * bound: rows never span chunks and are never dropped when a sheet exceeds it — the
 * sheet simply produces more chunks.
 */
export const CHUNK_BYTE_BUDGET = 120_000;

/**
 * Inline budget: below this, the whole evidence object goes straight into the
 * agent's first message and no chunk fetching is needed. Above it, the agent gets
 * the index and pulls chunks on demand.
 */
export const INLINE_EVIDENCE_BYTE_BUDGET = 200_000;

export interface EvidenceChunk {
  chunkId: string;
  sheet: string;
  rowsFrom: number;
  rowsTo: number;
  rows: EvidenceRow[];
}

export interface ChunkedEvidence {
  chunks: EvidenceChunk[];
  refs: Omit<EvidenceChunkRef, 's3Key'>[];
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * Splits evidence into per-sheet, byte-bounded chunks.
 *
 * Chunks never cross a sheet boundary, so "give me the rest of the Inventory sheet"
 * maps onto whole chunks. A single row larger than the budget still gets its own
 * chunk rather than being cut: exceeding the budget is preferable to losing data,
 * and the budget exists to keep tool results readable, not to enforce a hard limit.
 */
export function chunkEvidence(evidence: WorkbookEvidence): ChunkedEvidence {
  const chunks: EvidenceChunk[] = [];
  const refs: Omit<EvidenceChunkRef, 's3Key'>[] = [];
  let sequence = 0;

  for (const sheet of evidence.sheets) {
    let current: EvidenceRow[] = [];
    let currentBytes = 0;

    const flush = () => {
      if (current.length === 0) return;
      sequence += 1;
      const chunkId = String(sequence).padStart(4, '0');
      chunks.push({
        chunkId,
        sheet: sheet.name,
        rowsFrom: current[0].rowNumber,
        rowsTo: current[current.length - 1].rowNumber,
        rows: current,
      });
      const text = current
        .flatMap((row) => row.cells.map((cell) => `${cell.header ?? ''} ${cell.inheritedHeader ?? ''} ${cell.formatted}`))
        .join(' \n');
      refs.push({
        chunkId,
        sheet: sheet.name,
        rowsFrom: current[0].rowNumber,
        rowsTo: current[current.length - 1].rowNumber,
        environmentHints: [...new Set(matchAll(text, ENVIRONMENT_PATTERNS))],
        fiscalPeriodHints: [...new Set(FISCAL_PATTERNS.flatMap((p) => text.match(new RegExp(p, 'gi')) ?? []).map((s) => s.trim()))],
        serviceHints: [...new Set(matchAll(text, SERVICE_HINT_PATTERNS))],
        costRelevantRowCount: current.filter((row) => classifyRow(row.cells) === 'cost-relevant').length,
      });
      current = [];
      currentBytes = 0;
    };

    for (const row of sheet.rows) {
      const rowBytes = bytes(row);
      if (current.length > 0 && currentBytes + rowBytes > CHUNK_BYTE_BUDGET) flush();
      current.push(row);
      currentBytes += rowBytes;
    }
    flush();
  }

  evidence.accounting.evidenceChunkCount = chunks.length;
  return { chunks, refs };
}

// ─── S3 layout ────────────────────────────────────────────────────────────────

export const evidencePrefix = (owner: string, calculationId: string) =>
  `users/${owner}/calculator/${calculationId}/evidence`;

export const evidenceIndexKey = (owner: string, calculationId: string) =>
  `${evidencePrefix(owner, calculationId)}/index.json`;

export const evidenceChunkKey = (owner: string, calculationId: string, chunkId: string) =>
  `${evidencePrefix(owner, calculationId)}/chunks/${chunkId}.json`;

export const evidenceFullKey = (owner: string, calculationId: string) =>
  `${evidencePrefix(owner, calculationId)}/evidence.json`;

export const evidenceAccountingKey = (owner: string, calculationId: string) =>
  `${evidencePrefix(owner, calculationId)}/evidence-accounting.json`;

// ─── Index assembly ───────────────────────────────────────────────────────────

export function buildEvidenceIndex(
  evidence: WorkbookEvidence,
  chunked: ChunkedEvidence,
  owner: string,
  calculationId: string,
): WorkbookEvidenceIndex {
  const chunks: EvidenceChunkRef[] = chunked.refs.map((ref) => ({
    ...ref,
    s3Key: evidenceChunkKey(owner, calculationId, ref.chunkId),
  }));

  return {
    version: '1.0',
    fileName: evidence.fileName,
    fileHash: evidence.fileHash,
    sheets: evidence.sheets.map((sheet) => ({
      name: sheet.name,
      rowCount: sheet.rows.length,
      nonEmptyCellCount: sheet.rows.reduce((sum, row) => sum + row.cells.length, 0),
      headerRows: sheet.headerRows,
    })),
    detectedEnvironments: [...new Set(chunks.flatMap((chunk) => chunk.environmentHints))],
    detectedFiscalPeriods: [...new Set(chunks.flatMap((chunk) => chunk.fiscalPeriodHints))],
    serviceHints: [...new Set(chunks.flatMap((chunk) => chunk.serviceHints))],
    userInstructions: evidence.userInstructions,
    accounting: {
      totalRows: evidence.accounting.totalRows,
      totalNonEmptyCells: evidence.accounting.totalNonEmptyCells,
      totalChunks: chunks.length,
      costRelevantRows: chunks.reduce((sum, chunk) => sum + chunk.costRelevantRowCount, 0),
    },
    chunks,
  };
}

/** True when the whole evidence object is small enough to inline in one message. */
export function fitsInline(evidence: WorkbookEvidence): boolean {
  return bytes(evidence) <= INLINE_EVIDENCE_BYTE_BUDGET;
}

// ─── Evidence accounting ──────────────────────────────────────────────────────

export interface EvidenceAccounting {
  version: '1.0';
  calculationId: string;
  /** Every row classified cost-relevant. The set that must be fully accounted for. */
  costRelevantRows: string[];
  consumedByAgent: string[];
  explicitlyIgnored: string[];
  unsupported: string[];
  unresolved: string[];
  /** Must always be empty: a non-empty remainder is the bug this file exists to catch. */
  silentRemainder: string[];
  counts: {
    costRelevant: number;
    consumed: number;
    ignored: number;
    unsupported: number;
    unresolved: number;
    remainder: number;
  };
}

/**
 * Reconciles what the agent said it did against what the workbook contained.
 *
 * The invariant is
 *   costRelevantEvidence = consumedByAgent + explicitlyIgnored + unsupported + unresolved
 * with zero silent remainder. Anything the agent never mentioned lands in
 * `unresolved` rather than disappearing, which is the whole point: a row that
 * nobody priced and nobody explained is a visible warning, not a rounding error.
 */
export function reconcileEvidence(input: {
  calculationId: string;
  costRelevantRows: string[];
  consumedByAgent?: string[];
  explicitlyIgnored?: string[];
  unsupported?: string[];
  unresolved?: string[];
}): EvidenceAccounting {
  const costRelevant = new Set(input.costRelevantRows);
  const only = (ids: string[] | undefined) => (ids ?? []).filter((id) => costRelevant.has(id));

  const consumed = new Set(only(input.consumedByAgent));
  const ignored = new Set(only(input.explicitlyIgnored).filter((id) => !consumed.has(id)));
  const unsupported = new Set(only(input.unsupported).filter((id) => !consumed.has(id) && !ignored.has(id)));
  const declaredUnresolved = new Set(
    only(input.unresolved).filter((id) => !consumed.has(id) && !ignored.has(id) && !unsupported.has(id)),
  );

  // Rows the agent never mentioned at all are unresolved, not gone.
  const accountedFor = new Set([...consumed, ...ignored, ...unsupported, ...declaredUnresolved]);
  for (const id of costRelevant) if (!accountedFor.has(id)) declaredUnresolved.add(id);

  const unresolved = [...declaredUnresolved];

  return {
    version: '1.0',
    calculationId: input.calculationId,
    costRelevantRows: [...costRelevant],
    consumedByAgent: [...consumed],
    explicitlyIgnored: [...ignored],
    unsupported: [...unsupported],
    unresolved,
    silentRemainder: [],
    counts: {
      costRelevant: costRelevant.size,
      consumed: consumed.size,
      ignored: ignored.size,
      unsupported: unsupported.size,
      unresolved: unresolved.length,
      remainder: costRelevant.size - (consumed.size + ignored.size + unsupported.size + unresolved.length),
    },
  };
}

/** Row ids classified cost-relevant across the whole workbook. */
export function costRelevantRowIds(evidence: WorkbookEvidence): string[] {
  return evidence.sheets.flatMap((sheet) =>
    sheet.rows.filter((row) => classifyRow(row.cells) === 'cost-relevant').map((row) => row.rowId));
}
