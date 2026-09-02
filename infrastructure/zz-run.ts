import { readFileSync } from 'fs';
import { analyseWorkbook } from './lambdas/api-handler/calculator-workbook';

async function main() {
  const buf = readFileSync('D:/Interview Agent/docs/Digital_Assets.xlsx');
  const out = await analyseWorkbook(buf, 'Digital_Assets.xlsx');
  console.log('=== resources:', out.resources.length);
  out.resources.slice(0, 8).forEach(r => console.log('  ', JSON.stringify(r)));
  console.log('=== warnings:', out.warnings.length);
  out.warnings.forEach(w => console.log('  -', w));
  console.log('=== insights:', JSON.stringify(out.insights, null, 2).slice(0, 3000));
}
main().catch(e => { console.error('THREW:', e); process.exit(1); });
