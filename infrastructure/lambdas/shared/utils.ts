import pdf from 'pdf-parse';
import mammoth from 'mammoth';

/**
 * Robust JSON extraction for AI responses.
 * Handles:
 * 1. Markdown fences (```json ... ```)
 * 2. Conversational preambles/post-scripts
 * 3. Thinking blocks (<thinking>...</thinking>)
 * 4. Nested objects via brace counting
 */
export function extractJson(text: string): string {
  if (!text) return '';

  // 2. Aggressively remove markdown fences anywhere in the block
  let cleanText = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();
  cleanText = cleanText.replace(/```(?:json)?\s*([\s\S]*?)\s*```/gi, '$1').trim();
  
  // 3. Find the first '{' - but also check for any leading markdown junk that might have survived
  const firstBrace = cleanText.indexOf('{');
  if (firstBrace === -1) {
    console.warn('[extractJson] No opening brace found in text');
    return '';
  }

  // 4. Trace the matching closing brace
  let braceCount = 0;
  let inString = false;
  let escapeNext = false;
  
  for (let i = firstBrace; i < cleanText.length; i++) {
    const char = cleanText[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{') braceCount++;
      if (char === '}') braceCount--;

      if (braceCount === 0) {
        // Found the matching end brace
        return cleanText.substring(firstBrace, i + 1);
      }
    }
  }

  console.warn('[extractJson] No matching closing brace found');
  return '';
}

/**
 * Professional-grade text extraction from binary buffers.
 * Supports: TXT, PDF, DOCX
 */
export async function extractTextFromBuffer(buffer: Buffer, fileName: string): Promise<string> {
  const extension = fileName.split('.').pop()?.toLowerCase();

  // 1. Handle Plain Text
  if (extension === 'txt') {
    return buffer.toString('utf-8');
  }

  // 2. Handle PDF (Professional Parsing)
  if (extension === 'pdf') {
    try {
      const data = await pdf(buffer);
      return data.text;
    } catch (err: any) {
      console.error('[extractTextFromBuffer] PDF Parse failed:', err.message);
      throw new Error('PDF_PARSE_FAILED');
    }
  }

  // 3. Handle DOCX (Professional Parsing)
  if (extension === 'docx') {
    try {
       const result = await mammoth.extractRawText({ buffer });
       return result.value;
    } catch (err: any) {
      console.error('[extractTextFromBuffer] DOCX Parse failed:', err.message);
      throw new Error('DOCX_PARSE_FAILED');
    }
  }

  throw new Error(`UNSUPPORTED_FORMAT: .${extension}`);
}

/**
 * Splits one CSV line, honouring quoted fields.
 *
 * Worth doing properly rather than `line.split(',')`: the Notes column is free
 * text and "off at weekends, on-call only" is exactly the sort of value a person
 * types. A naive split turns that single cell into two columns and silently
 * shifts every field after it.
 */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      // "" inside a quoted field is an escaped quote, not the end of it.
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

/**
 * Reads a spreadsheet into rows of cell text.
 *
 * Companion to extractTextFromBuffer for tabular input: a resource list arrives as
 * a sheet, and flattening it to prose would throw away the column structure that
 * makes it worth uploading. Returns raw rows — interpreting the columns is the
 * caller's job, because a hand-made sheet may not use the expected headers.
 *
 * Trailing empty rows and columns are dropped: Excel readily reports a used range
 * far larger than the typed data, and empty trailing rows would otherwise arrive
 * as resources with no service.
 */
export async function extractTableFromBuffer(buffer: Buffer, fileName: string): Promise<string[][]> {
  const extension = fileName.split('.').pop()?.toLowerCase();

  if (extension === 'csv' || extension === 'txt') {
    const rows = buffer.toString('utf-8')
      // Strip a BOM: Excel writes one when saving as CSV, and it would otherwise
      // become part of the first header cell and break header matching.
      .replace(/^﻿/, '')
      .split(/\r?\n/)
      .map(splitCsvLine);
    return trimTable(rows);
  }

  if (extension === 'xlsx') {
    try {
      // Imported lazily so the api-handler bundle only pays for exceljs on a
      // request that actually uploads a sheet.
      const ExcelJS = await import('exceljs');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as any);

      // First sheet with anything in it — a template often carries an empty
      // "Instructions" or "Sheet2" tab, and the first tab is not always the data.
      for (const sheet of workbook.worksheets) {
        const rows: string[][] = [];
        sheet.eachRow({ includeEmpty: true }, (row) => {
          const cells: string[] = [];
          row.eachCell({ includeEmpty: true }, (cell) => {
            cells.push(cellText(cell.value));
          });
          rows.push(cells);
        });
        const trimmed = trimTable(rows);
        if (trimmed.length) return trimmed;
      }
      return [];
    } catch (err: any) {
      console.error('[extractTableFromBuffer] XLSX parse failed:', err?.message);
      throw new Error('XLSX_PARSE_FAILED');
    }
  }

  if (extension === 'xls') {
    // The legacy binary format is a different container entirely; exceljs cannot
    // read it. Say so precisely rather than failing as a corrupt xlsx.
    throw new Error('LEGACY_XLS_UNSUPPORTED');
  }

  throw new Error(`UNSUPPORTED_TABLE_FORMAT: .${extension}`);
}

/** Flattens one exceljs cell to text, including formula results and dates. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const candidate = value as Record<string, unknown>;
    // Formula cells carry {formula, result}; hyperlinks {text, hyperlink};
    // rich text {richText:[{text}]}. Report what a reader would see.
    if ('result' in candidate) return cellText(candidate.result);
    if ('text' in candidate) return cellText(candidate.text);
    if (Array.isArray(candidate.richText)) {
      return candidate.richText.map((part: any) => String(part?.text ?? '')).join('');
    }
    return '';
  }
  return String(value).trim();
}

/** Drops trailing empty rows and columns from a parsed sheet. */
function trimTable(rows: string[][]): string[][] {
  const nonEmpty = rows.filter((row) => row.some((cell) => cell !== ''));
  if (!nonEmpty.length) return [];
  const width = Math.max(...nonEmpty.map((row) => {
    let last = 0;
    row.forEach((cell, index) => { if (cell !== '') last = index + 1; });
    return last;
  }));
  return nonEmpty.map((row) => {
    const padded = row.slice(0, width);
    while (padded.length < width) padded.push('');
    return padded;
  });
}
