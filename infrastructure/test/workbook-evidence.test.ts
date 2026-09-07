/**
 * Phase 1 / 2 / 3 tests: the workbook evidence projection must be lossless,
 * chunked rather than truncated, and reconcile to zero silent remainder.
 *
 * These are the regression tests for the defect that produced "missing SageMaker
 * fields" and dash-filled results: evidence was being cut to the first 200-300 rows
 * before Claude ever saw it, so Claude asked for values whose evidence had already
 * been discarded. A row cap reappearing anywhere in this path should fail here.
 *
 * Classification: MOCKED (pure functions, no AWS).
 */

import {
  buildWorkbookEvidence,
  chunkEvidence,
  buildEvidenceIndex,
  reconcileEvidence,
  costRelevantRowIds,
  classifyRow,
  fitsInline,
  evidenceIndexKey,
  evidenceChunkKey,
  CHUNK_BYTE_BUDGET,
  type EvidenceCell,
} from '../lambdas/shared/workbook-evidence.js';
import type { CellIR, WorkbookIR } from '../lambdas/shared/workbook.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const columnLetter = (col: number) => String.fromCharCode(64 + col);

function cell(
  sheet: string,
  row: number,
  col: number,
  formatted: string,
  extra: Partial<CellIR> = {},
): CellIR {
  return {
    sheet,
    row,
    col,
    a1: `${columnLetter(col)}${row}`,
    raw: formatted,
    formatted,
    ...extra,
  };
}

/**
 * A workbook shaped like the real ones: a merged section banner, a header row, then
 * `dataRows` inventory rows carrying a label and a quantity.
 */
function inventoryWorkbook(dataRows: number, sheetName = 'Inventory'): WorkbookIR {
  const cells: CellIR[] = [
    // Merged banner across A1:C1 — only the anchor carries the value.
    cell(sheetName, 1, 1, 'Production / FY27', { mergedRange: 'A1:C1', mergeAnchor: 'A1' }),
    cell(sheetName, 1, 2, '', { mergedRange: 'A1:C1', mergeAnchor: 'A1' }),
    cell(sheetName, 1, 3, '', { mergedRange: 'A1:C1', mergeAnchor: 'A1' }),
    // Header row.
    cell(sheetName, 2, 1, 'Service'),
    cell(sheetName, 2, 2, 'Instance type'),
    cell(sheetName, 2, 3, 'Quantity'),
  ];
  for (let index = 0; index < dataRows; index++) {
    const row = 3 + index;
    cells.push(cell(sheetName, row, 1, 'Amazon EC2'));
    cells.push(cell(sheetName, row, 2, 'm5.xlarge'));
    cells.push(cell(sheetName, row, 3, String(index + 1), { raw: index + 1 }));
  }
  return {
    workbookId: 'hash',
    fileHash: 'hash',
    fileName: 'inventory.xlsx',
    sheets: [{
      name: sheetName,
      index: 1,
      rowCount: 2 + dataRows,
      columnCount: 3,
      cells,
    }],
    mergedRanges: [{ sheet: sheetName, range: 'A1:C1', anchor: 'A1' }],
    namedRanges: [],
    nonEmptyCellCount: cells.filter((c) => c.formatted !== '').length,
  };
}

// ─── Phase 1: losslessness ────────────────────────────────────────────────────

describe('buildWorkbookEvidence — Phase 1 losslessness', () => {
  it('keeps every row of a workbook far larger than the old 200/300 caps', () => {
    const evidence = buildWorkbookEvidence({ ir: inventoryWorkbook(1500) });

    // 1500 data rows + banner row + header row.
    expect(evidence.sheets[0].rows).toHaveLength(1502);
    expect(evidence.accounting.totalRows).toBe(1502);

    // The rows that used to vanish.
    const rowNumbers = evidence.sheets[0].rows.map((row) => row.rowNumber);
    expect(rowNumbers).toContain(203);
    expect(rowNumbers).toContain(303);
    expect(rowNumbers).toContain(1502);
  });

  it('preserves every non-empty cell from the IR exactly once', () => {
    const ir = inventoryWorkbook(40);
    const evidence = buildWorkbookEvidence({ ir });

    const emitted = evidence.sheets.flatMap((sheet) => sheet.rows.flatMap((row) => row.cells));
    const irCells = ir.sheets.flatMap((sheet) => sheet.cells);
    expect(emitted).toHaveLength(irCells.length);

    const addresses = emitted.map((c) => c.address);
    expect(new Set(addresses).size).toBe(addresses.length);
    for (const source of irCells) expect(addresses).toContain(source.a1);
  });

  it('preserves cell address, raw value, formatted value and formula', () => {
    const ir = inventoryWorkbook(1);
    ir.sheets[0].cells.push(cell('Inventory', 4, 3, '120', { raw: 120, formula: 'C3*2' }));
    ir.nonEmptyCellCount += 1;

    const evidence = buildWorkbookEvidence({ ir });
    const derived = evidence.sheets[0].rows
      .flatMap((row) => row.cells)
      .find((c) => c.address === 'C4');

    expect(derived).toMatchObject({ address: 'C4', raw: 120, formatted: '120', formula: 'C3*2' });
  });

  it('attributes column headers to the data cells underneath them', () => {
    const evidence = buildWorkbookEvidence({ ir: inventoryWorkbook(3) });
    const firstDataRow = evidence.sheets[0].rows.find((row) => row.rowNumber === 3)!;

    expect(firstDataRow.cells.map((c) => c.header)).toEqual(['Service', 'Instance type', 'Quantity']);
  });

  it('inherits a merged section banner onto the cells it spans', () => {
    const evidence = buildWorkbookEvidence({ ir: inventoryWorkbook(2) });
    const bannerRow = evidence.sheets[0].rows.find((row) => row.rowNumber === 1)!;

    // B1 and C1 are inside A1:C1 but are not the anchor, so they inherit its text.
    // Without this a row under "Production / FY27" would carry no environment at all.
    expect(bannerRow.cells.find((c) => c.address === 'B1')?.inheritedHeader).toBe('Production / FY27');
    expect(bannerRow.cells.find((c) => c.address === 'A1')?.inheritedHeader).toBeUndefined();
  });

  it('records instructions and accounting totals', () => {
    const evidence = buildWorkbookEvidence({
      ir: inventoryWorkbook(10),
      userInstructions: ['Price for ap-south-1', 'Use 3-year RIs'],
    });

    expect(evidence.userInstructions).toEqual(['Price for ap-south-1', 'Use 3-year RIs']);
    expect(evidence.accounting.totalSheets).toBe(1);
    expect(evidence.accounting.totalNonEmptyCells).toBeGreaterThan(0);
  });
});

// ─── Phase 2: chunking, never truncation ──────────────────────────────────────

describe('chunkEvidence — Phase 2 chunking', () => {
  it('splits a large workbook into chunks that between them hold every row', () => {
    const evidence = buildWorkbookEvidence({ ir: inventoryWorkbook(4000) });
    const { chunks } = chunkEvidence(evidence);

    expect(chunks.length).toBeGreaterThan(1);

    const chunkedRowIds = chunks.flatMap((chunk) => chunk.rows.map((row) => row.rowId));
    const allRowIds = evidence.sheets.flatMap((sheet) => sheet.rows.map((row) => row.rowId));

    // Nothing lost and nothing duplicated: this is the anti-truncation invariant.
    expect(chunkedRowIds.sort()).toEqual(allRowIds.sort());
  });

  it('keeps chunks within the byte budget without dropping rows', () => {
    const evidence = buildWorkbookEvidence({ ir: inventoryWorkbook(4000) });
    const { chunks } = chunkEvidence(evidence);

    for (const chunk of chunks) {
      // A chunk may exceed the budget only when a single row does.
      const size = Buffer.byteLength(JSON.stringify(chunk.rows), 'utf8');
      if (chunk.rows.length > 1) expect(size).toBeLessThanOrEqual(CHUNK_BYTE_BUDGET * 1.05);
    }
  });

  it('never lets a chunk span two sheets, so "rest of sheet X" maps to whole chunks', () => {
    const first = inventoryWorkbook(300, 'Prod');
    const second = inventoryWorkbook(300, 'Dev');
    const ir: WorkbookIR = {
      ...first,
      sheets: [first.sheets[0], { ...second.sheets[0], index: 2 }],
      nonEmptyCellCount: first.nonEmptyCellCount + second.nonEmptyCellCount,
    };

    const { chunks } = chunkEvidence(buildWorkbookEvidence({ ir }));
    for (const chunk of chunks) {
      expect(new Set(chunk.rows.map((row) => row.rowId.split('!')[0])).size).toBe(1);
    }
    expect(new Set(chunks.map((c) => c.sheet))).toEqual(new Set(['Prod', 'Dev']));
  });

  it('inlines a small workbook and does not inline a large one', () => {
    expect(fitsInline(buildWorkbookEvidence({ ir: inventoryWorkbook(5) }))).toBe(true);
    expect(fitsInline(buildWorkbookEvidence({ ir: inventoryWorkbook(6000) }))).toBe(false);
  });
});

describe('buildEvidenceIndex — Phase 2 index', () => {
  it('records chunk refs with S3 keys, row ranges and routing hints', () => {
    const evidence = buildWorkbookEvidence({ ir: inventoryWorkbook(2000) });
    const chunked = chunkEvidence(evidence);
    const index = buildEvidenceIndex(evidence, chunked, 'owner-1', 'calc-1');

    expect(index.chunks).toHaveLength(chunked.chunks.length);
    expect(index.accounting.totalChunks).toBe(chunked.chunks.length);
    expect(index.accounting.totalRows).toBe(evidence.accounting.totalRows);

    for (const ref of index.chunks) {
      expect(ref.s3Key).toBe(evidenceChunkKey('owner-1', 'calc-1', ref.chunkId));
      expect(ref.rowsFrom).toBeLessThanOrEqual(ref.rowsTo);
    }

    // Hints come from the banner and the service column.
    expect(index.detectedEnvironments).toContain('Production');
    expect(index.detectedFiscalPeriods.join(' ')).toMatch(/FY27/i);
    expect(index.serviceHints).toContain('EC2');
  });

  it('uses the documented S3 layout', () => {
    expect(evidenceIndexKey('o', 'c')).toBe('users/o/calculator/c/evidence/index.json');
    expect(evidenceChunkKey('o', 'c', '0007')).toBe('users/o/calculator/c/evidence/chunks/0007.json');
  });

  it('reports the header rows it identified', () => {
    const evidence = buildWorkbookEvidence({ ir: inventoryWorkbook(5) });
    const index = buildEvidenceIndex(evidence, chunkEvidence(evidence), 'o', 'c');

    // Row 2 is the Service/Instance type/Quantity header.
    expect(index.sheets[0].headerRows).toContain(2);
  });
});

// ─── Phase 3: evidence accounting ─────────────────────────────────────────────

describe('classifyRow — Phase 3 classification', () => {
  const make = (values: Array<Partial<EvidenceCell> & { formatted: string }>): EvidenceCell[] =>
    values.map((value, index) => ({
      address: `${columnLetter(index + 1)}1`,
      column: index + 1,
      raw: value.formatted,
      ...value,
    }));

  it('treats a label plus a quantity as cost-relevant', () => {
    expect(classifyRow(make([{ formatted: 'Amazon EC2' }, { formatted: '12' }]))).toBe('cost-relevant');
  });

  it('treats a named AWS service with no quantity as cost-relevant', () => {
    expect(classifyRow(make([{ formatted: 'MemoryDB cluster for sessions' }]))).toBe('cost-relevant');
  });

  it('treats a text-only note as context, not as a billable line', () => {
    expect(classifyRow(make([{ formatted: 'Assumptions and exclusions' }]))).toBe('context');
  });

  it('does not count a spanned formatting banner as cost evidence', () => {
    expect(classifyRow(make([{ formatted: '', inheritedHeader: 'Section' }]))).toBe('decorative');
    expect(classifyRow([])).toBe('decorative');
  });
});

describe('reconcileEvidence — Phase 3 zero silent remainder', () => {
  it('balances consumed + ignored + unsupported + unresolved with no remainder', () => {
    const accounting = reconcileEvidence({
      calculationId: 'calc-1',
      costRelevantRows: ['S!3', 'S!4', 'S!5', 'S!6'],
      consumedByAgent: ['S!3', 'S!4'],
      explicitlyIgnored: ['S!5'],
      unsupported: ['S!6'],
    });

    expect(accounting.counts.remainder).toBe(0);
    expect(accounting.silentRemainder).toEqual([]);
    expect(accounting.counts.consumed + accounting.counts.ignored
      + accounting.counts.unsupported + accounting.counts.unresolved)
      .toBe(accounting.counts.costRelevant);
  });

  it('files a row the agent never mentioned as unresolved rather than losing it', () => {
    const accounting = reconcileEvidence({
      calculationId: 'calc-1',
      costRelevantRows: ['S!3', 'S!4', 'S!5'],
      consumedByAgent: ['S!3'],
    });

    expect(accounting.unresolved.sort()).toEqual(['S!4', 'S!5']);
    expect(accounting.counts.remainder).toBe(0);
  });

  it('ignores ids the agent invented that are not cost-relevant workbook rows', () => {
    const accounting = reconcileEvidence({
      calculationId: 'calc-1',
      costRelevantRows: ['S!3'],
      consumedByAgent: ['S!3', 'S!999', 'not-a-row'],
    });

    expect(accounting.consumedByAgent).toEqual(['S!3']);
    expect(accounting.counts.remainder).toBe(0);
  });

  it('counts a row once even when the agent reports it in two buckets', () => {
    const accounting = reconcileEvidence({
      calculationId: 'calc-1',
      costRelevantRows: ['S!3', 'S!4'],
      consumedByAgent: ['S!3'],
      explicitlyIgnored: ['S!3', 'S!4'],
    });

    expect(accounting.consumedByAgent).toEqual(['S!3']);
    expect(accounting.explicitlyIgnored).toEqual(['S!4']);
    expect(accounting.counts.remainder).toBe(0);
  });

  it('derives cost-relevant row ids from real evidence', () => {
    const ids = costRelevantRowIds(buildWorkbookEvidence({ ir: inventoryWorkbook(25) }));

    // The 25 inventory rows; the banner and header rows are not billable lines.
    expect(ids).toHaveLength(25);
    expect(ids).toContain('Inventory!3');
    expect(ids).not.toContain('Inventory!1');
  });
});
