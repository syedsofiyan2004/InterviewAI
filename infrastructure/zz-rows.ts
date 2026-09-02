import { readFileSync } from 'fs';
import { analyseWorkbook } from './lambdas/api-handler/calculator-workbook';
async function main() {
  const out = await analyseWorkbook(readFileSync('D:/Interview Agent/docs/Digital_Assets.xlsx'), 'Digital_Assets.xlsx');
  const rows = out.resources.map(r => r.row).sort((a,b)=>(a??0)-(b??0));
  console.log('count=', out.resources.length, 'rowNums=', rows.join(','));
  console.log('rows>=59 present?', rows.filter(r => (r??0) >= 59).length);
  console.log('excerpt count:', out.insights.excerpts?.length);
  console.log('excerpt2 line count:', out.insights.excerpts?.[2]?.text.split('\n').length);
  console.log('any resource with service/size?', out.resources.filter(r=>r.service||r.size).length);
}
main().catch(e=>{console.error(e);process.exit(1);});
