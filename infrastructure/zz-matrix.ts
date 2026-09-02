import { readFileSync } from 'fs';
import { readWorkbook } from './lambdas/shared/workbook';
import { findBlocks } from './lambdas/shared/sheet-structure';
import { looksLikeMetricMatrix, readMetricMatrix } from './lambdas/shared/metric-matrix';

async function main() {
  const sheets = await readWorkbook(readFileSync('D:/Interview Agent/docs/Digital_Assets.xlsx'), 'Digital_Assets.xlsx');
  for (const sheet of sheets) {
    for (const block of findBlocks(sheet.rows)) {
      if (block.kind !== 'table' || block.headerRow === undefined) { console.log(`block ${block.kind} rows ${block.start+1}-${block.end+1} (skip)`); continue; }
      const header = sheet.rows[block.headerRow];
      const dataRows = sheet.rows.slice(block.headerRow + 1, block.end + 1);
      const isMatrix = looksLikeMetricMatrix(header, dataRows);
      console.log(`\n### block header r${block.headerRow+1} data ${dataRows.length} rows -> matrix=${isMatrix}`);
      console.log('   header:', JSON.stringify(header));
      if (!isMatrix) continue;
      const r = readMetricMatrix(header, dataRows, block.headerRow + 1);
      console.log('   bands:', r.bands.map(b => `${b.key}[${b.kind}]`).join(', '));
      console.log('   resources:', r.resources.length, ' exclusions:', r.exclusions.length, ' conversions:', r.conversions.length);
      const first = r.bands[0].key;
      console.log(`   --- resources in band ${first}:`);
      r.resources.filter(x => x.scenario === first).forEach(x => console.log('     ', JSON.stringify({s:x.service,size:x.size,q:x.quantity,vcpu:x.vcpu,ram:x.ram_gb,disk:x.disk_gb,ua:x.usage_amount,uu:x.usage_unit,m:x.metric.slice(0,50)})));
      console.log('   --- exclusions:');
      r.exclusions.slice(0,12).forEach(e => console.log('     ', e.scenario ?? '(all)', '|', e.metric.slice(0,60), '=>', e.reason));
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
