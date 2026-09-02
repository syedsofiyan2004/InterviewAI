const ExcelJS = require('exceljs');
(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile('D:/Interview Agent/docs/Core BOM.xlsx');
  wb.eachSheet((ws) => {
    console.log('\n=== SHEET', JSON.stringify(ws.name), 'rows', ws.rowCount, 'cols', ws.columnCount);
    const merges = ws.model.merges || [];
    console.log('MERGES', JSON.stringify(merges));
    for (let r = 1; r <= ws.rowCount; r++) {
      const out = [];
      for (let c = 1; c <= ws.columnCount; c++) {
        const cell = ws.getCell(r, c);
        let v = cell.value;
        if (v && typeof v === 'object') v = v.text ?? v.result ?? JSON.stringify(v);
        out.push(v === null || v === undefined ? '' : String(v));
      }
      console.log(String(r).padStart(3), JSON.stringify(out));
    }
  });
})();
