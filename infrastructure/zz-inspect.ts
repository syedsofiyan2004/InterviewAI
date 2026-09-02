import ExcelJS from 'exceljs';

async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile('D:/Interview Agent/docs/Digital_Assets.xlsx');
  console.log('SHEETS:', wb.worksheets.map(w => `${w.name} (state=${w.state}, rows=${w.rowCount}, cols=${w.columnCount})`).join(' | '));
  for (const ws of wb.worksheets) {
    console.log('\n================ SHEET:', JSON.stringify(ws.name), 'dim=', JSON.stringify((ws as any).dimensions?.$ref ?? null));
    console.log('merges:', JSON.stringify((ws as any).model?.merges ?? []));
    const max = ws.rowCount;
    for (let r = 1; r <= max; r++) {
      const row = ws.getRow(r);
      const vals: string[] = [];
      for (let c = 1; c <= Math.min(ws.columnCount, 20); c++) {
        const v = row.getCell(c).value;
        let s: string;
        if (v === null || v === undefined) s = '';
        else if (typeof v === 'object' && 'richText' in (v as any)) s = (v as any).richText.map((t: any) => t.text).join('');
        else if (typeof v === 'object' && 'text' in (v as any)) s = String((v as any).text);
        else if (typeof v === 'object' && 'result' in (v as any)) s = `=${(v as any).formula}->${(v as any).result}`;
        else if (v instanceof Date) s = `DATE:${v.toISOString()}`;
        else s = String(v);
        vals.push(s);
      }
      while (vals.length && vals[vals.length-1] === '') vals.pop();
      console.log(`r${String(r).padStart(3)}: [${vals.map(v => JSON.stringify(v)).join(', ')}]`);
    }
    if (ws.rowCount > max) console.log(`... (${ws.rowCount - max} more rows)`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
