import ExcelJS from 'exceljs';

import { readWorkbookDocument } from '../lambdas/shared/workbook';

describe('lossless WorkbookIR', () => {
  test('retains formulas, cached results, merges, raw types, named sheets and file identity', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Arbitrary Customer Layout');
    sheet.mergeCells('A1:C1');
    sheet.getCell('A1').value = 'Capacity model';
    sheet.getCell('A2').value = 7;
    sheet.getCell('B2').value = { formula: 'A2*2', result: 14 };
    sheet.getCell('C2').value = new Date(Date.UTC(2026, 7, 30));
    sheet.mergeCells('D2:D3');
    sheet.getCell('D2').value = 'Network Load Balancer';
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const document = await readWorkbookDocument(buffer, 'unfamiliar-input.xlsx');

    expect(document.ir.fileHash).toMatch(/^[a-f0-9]{64}$/);
    expect(document.ir.workbookId).toBe(document.ir.fileHash);
    expect(document.ir.sheets.map((entry) => entry.name)).toEqual(['Arbitrary Customer Layout']);
    expect(document.ir.mergedRanges).toContainEqual({
      sheet: 'Arbitrary Customer Layout', range: 'A1:C1', anchor: 'A1',
    });
    const cells = document.ir.sheets[0].cells;
    expect(cells.find((cell) => cell.a1 === 'A2')?.raw).toBe(7);
    expect(cells.find((cell) => cell.a1 === 'B2')).toMatchObject({
      formula: 'A2*2', calculatedValue: 14, formatted: '14',
    });
    expect(cells.find((cell) => cell.a1 === 'C2')?.raw).toBe('2026-08-30T00:00:00.000Z');
    expect(cells.find((cell) => cell.a1 === 'B1')).toMatchObject({
      mergedRange: 'A1:C1', mergeAnchor: 'A1',
    });
    expect(document.sheets[0].rows[0].slice(0, 3)).toEqual(['Capacity model', '', '']);
    expect(document.sheets[0].rows[1][3]).toBe('Network Load Balancer');
    expect(document.sheets[0].rows[2][3]).toBe('Network Load Balancer');
  });
});
