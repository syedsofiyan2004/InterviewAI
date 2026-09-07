import { createHash } from 'crypto';

import type { Cell, Worksheet } from 'exceljs';

export interface CellIR {
  sheet: string;
  row: number;
  col: number;
  a1: string;
  raw: unknown;
  formatted: string;
  formula?: string;
  calculatedValue?: unknown;
  dataType?: string;
  mergedRange?: string;
  mergeAnchor?: string;
}

export interface MergedRangeIR {
  sheet: string;
  range: string;
  anchor: string;
}

export interface SheetIR {
  name: string;
  index: number;
  state?: string;
  rowCount: number;
  columnCount: number;
  cells: CellIR[];
}

export interface WorkbookIR {
  workbookId: string;
  fileHash: string;
  fileName: string;
  sheets: SheetIR[];
  mergedRanges: MergedRangeIR[];
  namedRanges: Array<{ name: string; ranges: string[] }>;
  nonEmptyCellCount: number;
}

export interface WorkbookDocument {
  ir: WorkbookIR;
  sheets: SheetGrid[];
}

/**
 * Format-agnostic workbook reader.
 *
 * Replaces the extractTableFromBuffer that used to live in utils.ts, which returned
 * "the first sheet with anything in it". The difference matters: on a real customer
 * workbook that first sheet is the cover or assumptions tab, and the inventory of
 * servers sitting on tab 2 is never read at all. Nothing about the failure is
 * visible — the upload succeeds and the estimate is built from a title page.
 *
 * Three exceljs behaviours are load-bearing here and were each verified against
 * docs/COSEC_AWS_TCO_Model.xlsx rather than assumed:
 *
 *  1. row.eachCell({includeEmpty:true}) yields NOTHING for a row that exists but
 *     holds no defined cells, and its length varies row to row. Building a grid
 *     from it silently misaligns columns. Every cell here is addressed explicitly
 *     by index so the grid is always rectangular.
 *  2. A merged range reports the master's value from EVERY cell in the range, so a
 *     banner merged across B:F reads as five identical cells — enough to look like
 *     a header row to any scoring heuristic. Only the anchor keeps the value.
 *  3. Blank rows are structural. They separate a title block from its header row
 *     and one key-value section from the next, so they are preserved rather than
 *     filtered; block detection needs them.
 */

/** One sheet, as a rectangular grid of cell text. Blank rows are retained. */
export interface SheetGrid {
  name: string;
  rows: string[][];
  /** Sheet position in the workbook, 1-based, for messages that cite a location. */
  index: number;
}

/**
 * Ceilings that stop a malicious or corrupt file from exhausting Lambda memory.
 * Excel's own maxima are 1,048,576 rows x 16,384 columns; a real resource list is
 * orders of magnitude smaller, so these are generous rather than restrictive.
 */
const MAX_ROWS_PER_SHEET = 50_000;
const MAX_COLUMNS_PER_SHEET = 256;
const MAX_SHEETS = 50;

/**
 * Reads every sheet in a workbook.
 *
 * Throws the same sentinel error codes as extractTableFromBuffer so callers can
 * keep one message table: LEGACY_XLS_UNSUPPORTED, XLSX_PARSE_FAILED, and
 * UNSUPPORTED_TABLE_FORMAT.
 */
export async function readWorkbook(buffer: Buffer, fileName: string): Promise<SheetGrid[]> {
  return (await readWorkbookDocument(buffer, fileName)).sheets;
}

/**
 * Captures the file before semantic interpretation and builds the parser grids in the
 * same pass. This is the audit boundary: formulas, cached results, merges and original
 * cell values are retained even when the later layout detector cannot classify them.
 */
export async function readWorkbookDocument(buffer: Buffer, fileName: string): Promise<WorkbookDocument> {
  const extension = fileName.split('.').pop()?.toLowerCase();
  const fileHash = createHash('sha256').update(buffer).digest('hex');

  if (extension === 'csv' || extension === 'txt') {
    const text = buffer.toString('utf-8').replace(/^﻿/, '');
    const rows = text.split(/\r?\n/).map(splitCsvLine);
    const trimmed = trimGrid(rows);
    const name = fileName.replace(/\.[^.]+$/, '');
    const cells: CellIR[] = [];
    trimmed.forEach((row, rowIndex) => row.forEach((formatted, colIndex) => {
      if (formatted === '') return;
      cells.push({
        sheet: name,
        row: rowIndex + 1,
        col: colIndex + 1,
        a1: a1(rowIndex + 1, colIndex + 1),
        raw: formatted,
        formatted,
        dataType: 'string',
      });
    }));
    const sheets = trimmed.length ? [{ name, rows: trimmed, index: 1 }] : [];
    return {
      sheets,
      ir: {
        workbookId: fileHash,
        fileHash,
        fileName,
        sheets: trimmed.length ? [{
          name,
          index: 1,
          rowCount: trimmed.length,
          columnCount: trimmed[0]?.length ?? 0,
          cells,
        }] : [],
        mergedRanges: [],
        namedRanges: [],
        nonEmptyCellCount: cells.length,
      },
    };
  }

  if (extension === 'xls') throw new Error('LEGACY_XLS_UNSUPPORTED');
  if (extension !== 'xlsx' && extension !== 'xlsm') {
    throw new Error(`UNSUPPORTED_TABLE_FORMAT: .${extension}`);
  }

  try {
    // Lazy so the api-handler bundle only pays for exceljs on a request that
    // actually uploads a sheet.
    // exceljs is a CommonJS package: bundled by esbuild the namespace IS the module, but under
    // a native ESM loader (the local tsx runners) its classes sit on `default`. Both are read.
    const loaded = await import('exceljs') as typeof import('exceljs') & { default?: typeof import('exceljs') };
    const ExcelJS = loaded.default?.Workbook ? loaded.default : loaded;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);

    const sheets: SheetGrid[] = [];
    const sheetIrs: SheetIR[] = [];
    const mergedRanges: MergedRangeIR[] = [];
    workbook.worksheets.slice(0, MAX_SHEETS).forEach((sheet, position) => {
      // A hidden sheet is usually a scratch or lookup tab the author did not intend
      // as input, but it is still read: hiding a rate table is common and the data
      // is legitimate. Only genuinely empty sheets are dropped.
      const rows = gridFromSheet(sheet);
      if (!rows.length) return;
      const name = sheet.name || `Sheet${position + 1}`;
      const ranges = Array.isArray((sheet.model as any)?.merges)
        ? ((sheet.model as any).merges as string[])
        : [];
      const rangeByAddress = mergedAddressMap(ranges);
      const cells: CellIR[] = [];
      const rowCount = Math.min(sheet.rowCount || 0, MAX_ROWS_PER_SHEET);
      const columnCount = Math.min(sheet.columnCount || 0, MAX_COLUMNS_PER_SHEET);
      for (let row = 1; row <= rowCount; row++) {
        for (let col = 1; col <= columnCount; col++) {
          const cell = sheet.getRow(row).getCell(col);
          const captured = cellIr(cell, name, row, col, rangeByAddress.get(cell.address));
          if (captured) cells.push(captured);
        }
      }
      ranges.forEach((range) => mergedRanges.push({ sheet: name, range, anchor: range.split(':')[0] }));
      sheets.push({ name, rows, index: position + 1 });
      sheetIrs.push({
        name,
        index: position + 1,
        state: String((sheet as any).state || 'visible'),
        rowCount,
        columnCount,
        cells,
      });
    });
    const ir: WorkbookIR = {
      workbookId: fileHash,
      fileHash,
      fileName,
      sheets: sheetIrs,
      mergedRanges,
      namedRanges: readNamedRanges(workbook as any),
      nonEmptyCellCount: sheetIrs.reduce((total, sheet) => total + sheet.cells.length, 0),
    };
    return { ir, sheets };
  } catch (error) {
    // Rethrow our own sentinels untouched; wrap anything from exceljs.
    const message = (error as Error).message || '';
    if (message.startsWith('LEGACY_XLS') || message.startsWith('UNSUPPORTED_TABLE_FORMAT')) throw error;
    try {
      return await readWorkbookDocumentFromOpenXml(buffer, fileName, fileHash);
    } catch (fallbackError) {
      const fallbackMessage = (fallbackError as Error).message || '';
      console.error('[readWorkbook] openxml fallback failed:', fallbackMessage);
    }
    console.error('[readWorkbook] parse failed:', message);
    throw new Error('XLSX_PARSE_FAILED');
  }
}

function a1(row: number, col: number): string {
  let letters = '';
  for (let value = col; value > 0; value = Math.floor((value - 1) / 26)) {
    letters = String.fromCharCode(65 + ((value - 1) % 26)) + letters;
  }
  return `${letters}${row}`;
}

function serialisableRaw(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); }
}

function cellIr(
  cell: Cell,
  sheet: string,
  row: number,
  col: number,
  mergedRange?: string,
): CellIR | undefined {
  const value = cell.value as any;
  const formula = value && typeof value === 'object'
    ? String(value.formula ?? value.sharedFormula ?? '').trim() || undefined
    : undefined;
  const calculatedValue = formula ? serialisableRaw(value.result) : undefined;
  // exceljs's text getter calls toString() on some formula results; a workbook with a
  // deliberately blank cached result therefore throws even though the cell is valid.
  let formatted: string;
  try {
    formatted = String((cell as any).text ?? valueToText(cell.value)).trim();
  } catch {
    formatted = valueToText(cell.value).trim();
  }
  const raw = formula ? calculatedValue : serialisableRaw(cell.value);
  if ((raw === null || raw === undefined || raw === '') && !formula && formatted === '') return undefined;
  const mergeAnchor = mergedRange?.split(':')[0];
  return {
    sheet,
    row,
    col,
    a1: cell.address || a1(row, col),
    raw,
    formatted,
    ...(formula ? { formula } : {}),
    ...(calculatedValue === undefined ? {} : { calculatedValue }),
    dataType: String((cell as any).type ?? ''),
    ...(mergedRange ? { mergedRange, mergeAnchor } : {}),
  };
}

function mergedAddressMap(ranges: string[]): Map<string, string> {
  const map = new Map<string, string>();
  const toCol = (letters: string) => letters.toUpperCase().split('').reduce(
    (total, char) => total * 26 + char.charCodeAt(0) - 64,
    0,
  );
  for (const range of ranges) {
    const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i.exec(range);
    if (!match) continue;
    for (let row = Number(match[2]); row <= Number(match[4]); row++) {
      for (let col = toCol(match[1]); col <= toCol(match[3]); col++) map.set(a1(row, col), range);
    }
  }
  return map;
}

function readNamedRanges(workbook: any): Array<{ name: string; ranges: string[] }> {
  try {
    const names = workbook?.definedNames?.model;
    if (!Array.isArray(names)) return [];
    return names.flatMap((entry: any) => {
      const name = String(entry?.name ?? '').trim();
      const ranges = Array.isArray(entry?.ranges)
        ? entry.ranges.map(String)
        : entry?.range ? [String(entry.range)] : [];
      return name ? [{ name, ranges }] : [];
    });
  } catch {
    return [];
  }
}

/**
 * Fallback for valid OOXML workbooks whose XML uses legal namespace prefixes that
 * exceljs 4.4 cannot parse. It reads the zipped workbook parts directly and returns
 * the same document shape as the normal ExcelJS path. The fallback intentionally
 * stays conservative: cell text, sheet names and formulas are preserved; styling,
 * tables and workbook metadata are ignored because they are not needed for pricing.
 */
async function readWorkbookDocumentFromOpenXml(buffer: Buffer, fileName: string, fileHash: string): Promise<WorkbookDocument> {
  const loaded = await import('jszip') as typeof import('jszip') & { default?: typeof import('jszip') };
  const JSZip = loaded.default || loaded;
  const zip = await JSZip.loadAsync(buffer);
  const workbookXml = await readZipText(zip, 'xl/workbook.xml');
  const relationshipXml = await readZipText(zip, 'xl/_rels/workbook.xml.rels').catch(() => '');
  const sharedStringXml = await readZipText(zip, 'xl/sharedStrings.xml').catch(() => '');
  const sharedStrings = parseSharedStrings(sharedStringXml);
  const relationships = parseRelationships(relationshipXml);
  const workbookSheets = parseWorkbookSheets(workbookXml);

  const sheets: SheetGrid[] = [];
  const sheetIrs: SheetIR[] = [];
  const mergedRanges: MergedRangeIR[] = [];
  const fallbackSheetCounts: string[] = [];

  for (const [position, workbookSheet] of workbookSheets.slice(0, MAX_SHEETS).entries()) {
    const target = relationships.get(workbookSheet.relationshipId);
    const sheetPath = normaliseWorkbookPartPath(target || `worksheets/sheet${position + 1}.xml`);
    const sheetXml = await readZipText(zip, sheetPath).catch(() => '');
    if (!sheetXml) continue;
    const parsed = parseWorksheetXml(sheetXml, workbookSheet.name, position + 1, sharedStrings);
    fallbackSheetCounts.push(`${workbookSheet.name}:${parsed.rows.length}x${parsed.columnCount}`);
    if (!parsed.rows.length) continue;
    sheets.push({ name: workbookSheet.name, rows: parsed.rows, index: position + 1 });
    sheetIrs.push({
      name: workbookSheet.name,
      index: position + 1,
      state: workbookSheet.state,
      rowCount: parsed.rowCount,
      columnCount: parsed.columnCount,
      cells: parsed.cells,
    });
    parsed.mergedRanges.forEach((range) => mergedRanges.push({ sheet: workbookSheet.name, range, anchor: range.split(':')[0] }));
  }

  if (!sheets.length) throw new Error(`OPENXML_NO_READABLE_SHEETS: workbookSheets=${workbookSheets.length}, relationships=${relationships.size}, parsed=${fallbackSheetCounts.join(', ')}`);

  return {
    sheets,
    ir: {
      workbookId: fileHash,
      fileHash,
      fileName,
      sheets: sheetIrs,
      mergedRanges,
      namedRanges: [],
      nonEmptyCellCount: sheetIrs.reduce((total, sheet) => total + sheet.cells.length, 0),
    },
  };
}

async function readZipText(zip: any, path: string): Promise<string> {
  const file = zip.file(path.replace(/^\/+/, ''));
  if (!file) throw new Error(`OPENXML_PART_MISSING: ${path}`);
  const text = await file.async('string');
  return stripBom(text);
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

function parseWorkbookSheets(xml: string): Array<{ name: string; relationshipId: string; state?: string }> {
  const sheets: Array<{ name: string; relationshipId: string; state?: string }> = [];
  for (const match of xml.matchAll(/<(?:\w+:)?sheet\b([^>]*)\/?>/gi)) {
    const attributes = parseXmlAttributes(match[1]);
    const name = attributes.name?.trim();
    const relationshipId = attributes['r:id'] || attributes.id;
    if (!name || !relationshipId) continue;
    sheets.push({ name, relationshipId, state: attributes.state || 'visible' });
  }
  return sheets;
}

function parseRelationships(xml: string): Map<string, string> {
  const relationships = new Map<string, string>();
  for (const match of xml.matchAll(/<(?:\w+:)?Relationship\b([^>]*)\/?>/gi)) {
    const attributes = parseXmlAttributes(match[1]);
    if (attributes.Id && attributes.Target) relationships.set(attributes.Id, attributes.Target);
  }
  return relationships;
}

function normaliseWorkbookPartPath(target: string): string {
  const withoutRoot = target.replace(/^\/+/, '');
  return withoutRoot.startsWith('xl/') ? withoutRoot : `xl/${withoutRoot}`;
}

function parseSharedStrings(xml: string): string[] {
  if (!xml) return [];
  const strings: string[] = [];
  for (const match of xml.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/gi)) {
    const parts = Array.from(match[1].matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/gi));
    strings.push(parts.map((part) => decodeXmlText(part[1])).join(''));
  }
  return strings;
}

function parseWorksheetXml(
  xml: string,
  sheetName: string,
  sheetIndex: number,
  sharedStrings: string[],
): { rows: string[][]; cells: CellIR[]; mergedRanges: string[]; rowCount: number; columnCount: number } {
  const rowMap = new Map<number, Map<number, string>>();
  const cells: CellIR[] = [];
  let maxRow = 0;
  let maxCol = 0;

  for (const rowMatch of xml.matchAll(/<(?:\w+:)?row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?row>/gi)) {
    const rowAttributes = parseXmlAttributes(rowMatch[1]);
    const rowNumber = Number(rowAttributes.r) || maxRow + 1;
    const rowCells = rowMap.get(rowNumber) || new Map<number, string>();
    rowMap.set(rowNumber, rowCells);
    maxRow = Math.max(maxRow, rowNumber);

    for (const cellMatch of rowMatch[2].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/gi)) {
      const attributes = parseXmlAttributes(cellMatch[1]);
      const reference = attributes.r || a1(rowNumber, rowCells.size + 1);
      const location = parseA1(reference);
      const row = location?.row || rowNumber;
      const col = location?.col || rowCells.size + 1;
      const inner = cellMatch[2] || '';
      const formula = firstXmlText(inner, 'f');
      const rawValue = firstXmlText(inner, 'v');
      const inlineText = firstXmlText(inner, 't');
      const text = openXmlCellText(attributes.t, rawValue, inlineText, sharedStrings);
      rowCells.set(col, text);
      maxRow = Math.max(maxRow, row);
      maxCol = Math.max(maxCol, col);
      if (text === '' && !formula) continue;
      cells.push({
        sheet: sheetName,
        row,
        col,
        a1: reference,
        raw: openXmlRawValue(attributes.t, rawValue, inlineText, sharedStrings),
        formatted: text,
        ...(formula ? { formula } : {}),
        ...(formula && rawValue !== undefined ? { calculatedValue: openXmlRawValue(attributes.t, rawValue, inlineText, sharedStrings) } : {}),
        dataType: attributes.t || '',
      });
    }
  }

  const rows: string[][] = [];
  for (let row = 1; row <= Math.min(maxRow, MAX_ROWS_PER_SHEET); row++) {
    const rowCells = rowMap.get(row);
    const values: string[] = [];
    for (let col = 1; col <= Math.min(maxCol, MAX_COLUMNS_PER_SHEET); col++) {
      values.push(rowCells?.get(col) || '');
    }
    rows.push(values);
  }

  const mergedRanges = Array.from(xml.matchAll(/<(?:\w+:)?mergeCell\b[^>]*\bref="([^"]+)"/gi))
    .map((match) => decodeXmlText(match[1]));
  const trimmed = trimGrid(rows);
  return {
    rows: trimmed,
    cells,
    mergedRanges,
    rowCount: Math.min(maxRow, MAX_ROWS_PER_SHEET),
    columnCount: Math.min(maxCol, MAX_COLUMNS_PER_SHEET),
  };
}

function parseXmlAttributes(text: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of text.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) attributes[match[1]] = decodeXmlText(match[2]);
  return attributes;
}

function firstXmlText(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, 'i').exec(xml);
  return match ? decodeXmlText(match[1]) : undefined;
}

function openXmlCellText(type: string | undefined, rawValue: string | undefined, inlineText: string | undefined, sharedStrings: string[]): string {
  const raw = openXmlRawValue(type, rawValue, inlineText, sharedStrings);
  return raw === null || raw === undefined ? '' : valueToText(raw);
}

function openXmlRawValue(type: string | undefined, rawValue: string | undefined, inlineText: string | undefined, sharedStrings: string[]): unknown {
  if (type === 's') return sharedStrings[Number(rawValue)] ?? '';
  if (type === 'inlineStr') return inlineText ?? '';
  if (type === 'b') return rawValue === '1';
  if (rawValue === undefined) return inlineText ?? '';
  const numeric = Number(rawValue);
  return Number.isFinite(numeric) && rawValue.trim() !== '' ? numeric : rawValue;
}

function parseA1(reference: string): { row: number; col: number } | undefined {
  const match = /^([A-Z]+)(\d+)$/i.exec(reference);
  if (!match) return undefined;
  const col = match[1].toUpperCase().split('').reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0);
  return { row: Number(match[2]), col };
}

function decodeXmlText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_, value) => String.fromCharCode(parseInt(value, 16)))
    .replace(/&#([0-9]+);/g, (_, value) => String.fromCharCode(parseInt(value, 10)));
}

/** Builds a rectangular grid by explicit addressing. See note 1 in the file header. */
function gridFromSheet(sheet: Worksheet): string[][] {
  const rowCount = Math.min(sheet.rowCount || 0, MAX_ROWS_PER_SHEET);
  const columnCount = Math.min(sheet.columnCount || 0, MAX_COLUMNS_PER_SHEET);
  if (!rowCount || !columnCount) return [];

  const rows: string[][] = [];
  for (let r = 1; r <= rowCount; r++) {
    const row = sheet.getRow(r);
    const cells: string[] = [];
    for (let c = 1; c <= columnCount; c++) {
      cells.push(cellToText(row.getCell(c)));
    }
    rows.push(cells);
  }
  return trimGrid(rows);
}

/**
 * One cell to text. Horizontal merged-banner copies stay blank, while a value
 * merged vertically down one column is repeated for semantic parsing.
 *
 * See note 2 in the file header: without this a banner merged across five columns
 * arrives as five copies of the same string.
 */
function cellToText(cell: Cell): string {
  try {
    if (cell.isMerged && cell.master && cell.master.address !== cell.address) {
      return cell.master.col === cell.col ? valueToText(cell.master.value) : '';
    }
  } catch {
    // isMerged/master can throw on a sparse cell in some exceljs versions; a cell
    // we cannot classify is treated as its own value, which is the safe direction
    // (worst case a banner repeats, which block detection tolerates).
  }
  return valueToText(cell.value);
}

/** Flattens an exceljs cell value, including formula results, dates and rich text. */
export function valueToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return numberToText(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) {
    // Dates are rendered dd-MM-yyyy to match the format used everywhere else in
    // this application rather than ISO.
    const dd = String(value.getUTCDate()).padStart(2, '0');
    const mm = String(value.getUTCMonth() + 1).padStart(2, '0');
    return `${dd}-${mm}-${value.getUTCFullYear()}`;
  }
  if (typeof value === 'object') {
    const candidate = value as Record<string, unknown>;
    // Formula cells carry {formula, result}. A formula whose cached result is an
    // error object ({error:'#REF!'}) reads as empty rather than as the word
    // [object Object] leaking into the model prompt.
    if ('error' in candidate) return '';
    if ('result' in candidate) return valueToText(candidate.result);
    if ('text' in candidate) return valueToText(candidate.text);
    if ('hyperlink' in candidate) return valueToText(candidate.hyperlink);
    if (Array.isArray(candidate.richText)) {
      return candidate.richText.map((part) => valueToText((part as Record<string, unknown>)?.text)).join('');
    }
    return '';
  }
  return String(value).trim();
}

/**
 * Renders a number without binary-float artefacts.
 *
 * The workbook's own formulas produce values like 28.800000000000004; passed
 * through String() that noise reaches the model prompt and the stored record.
 * Rounding at 10 decimal places removes the artefact while preserving every real
 * rate in the file (the smallest, an hourly EC2 rate, has 5 decimals).
 */
function numberToText(value: number): string {
  if (!Number.isFinite(value)) return '';
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(10)));
}

/**
 * Drops trailing empty rows and columns but keeps interior blank rows, which carry
 * structure. See note 3 in the file header.
 */
function trimGrid(rows: string[][]): string[][] {
  let lastRow = -1;
  let width = 0;
  rows.forEach((row, index) => {
    let lastCell = 0;
    row.forEach((cell, at) => { if (cell !== '') lastCell = at + 1; });
    if (lastCell > 0) {
      lastRow = index;
      width = Math.max(width, lastCell);
    }
  });
  if (lastRow < 0 || width === 0) return [];

  return rows.slice(0, lastRow + 1).map((row) => {
    const padded = row.slice(0, width);
    while (padded.length < width) padded.push('');
    return padded;
  });
}

/**
 * Splits one CSV line, honouring quoted fields and escaped quotes.
 *
 * Lives here rather than in utils.ts, which is where the CSV reading used to be:
 * that module pulls in pdf-parse and mammoth at import time, and this one is meant
 * to stay cheap enough for the api-handler to import unconditionally.
 */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      cells.push(cell.trim());
      cell = '';
    } else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}
