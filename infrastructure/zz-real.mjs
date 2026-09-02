import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Replicate workbook.ts's dynamic import -- force the CJS default
const ExcelJS = (await import('exceljs')).default;
const wb = new ExcelJS.Workbook();
const buf = readFileSync('../docs/Digital_Assets.xlsx');
await wb.xlsx.load(buf);

const sheets = wb.worksheets.filter(s => s.state !== 'hidden');
console.log('sheets:', sheets.map(s => s.name));

const ws = sheets[0];
const rows = [];
for (let r = 1; r <= ws.rowCount; r++) {
  const row = ws.getRow(r);
  const cells = [];
  for (let c = 1; c <= ws.columnCount; c++) {
    const v = row.getCell(c).value;
    cells.push(v === null || v === undefined ? '' : (typeof v === 'object' && v.result !== undefined ? String(v.result) : String(v)));
  }
  rows.push(cells);
}

// Find headers
const headers = rows.filter((row, i) => row[0].toLowerCase().includes('metric') || (row[0] !== '' && rows[i+1] && rows[i+1][0] !== '' && row.slice(1).some(c => c !== '')));
// Print bands
const headerRows = [];
for (let i = 0; i < rows.length; i++) {
  if (rows[i][0].toLowerCase().trim() === 'metric') headerRows.push({ idx: i+1, header: rows[i] });
}
console.log('header rows:', headerRows.map(h => `r${h.idx}: ${JSON.stringify(h.header)}`));
