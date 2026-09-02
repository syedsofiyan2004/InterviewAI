import { readFileSync } from 'node:fs';
import { analyseWorkbook } from './lambdas/api-handler/calculator-workbook';

async function main() {
  const bytes = readFileSync('../docs/Digital_Assets.xlsx');
  const out = await analyseWorkbook(bytes, 'Digital_Assets.xlsx');
  const o = out as any;
  const res = o.resources as any[];
  const ins = o.insights as any;
  console.log('resources:', res.length);
  console.log('bands:', JSON.stringify(ins.bands, null, 1));
  const byScenario = new Map<string, number>();
  const priceable = res.filter((r) => r.service || r.size || r.vcpu !== undefined);
  for (const r of res) byScenario.set(r.scenario ?? '(none)', (byScenario.get(r.scenario ?? '(none)') ?? 0) + 1);
  console.log('per scenario:', JSON.stringify([...byScenario]));
  console.log('priceable by pipeline filter:', priceable.length, 'of', res.length);
  console.log('server_count:', ins.server_count, 'total_disk_gb:', ins.total_disk_gb);
  console.log('conversions:', JSON.stringify(ins.conversions, null, 1));
  console.log('exclusions:', JSON.stringify(ins.exclusions, null, 1));
  console.log('warnings:'); (o.warnings as string[]).forEach((w) => console.log('  -', w));
  console.log('sample rows:');
  for (const r of res.slice(0, 6)) console.log('  ', JSON.stringify({ sc: r.scenario, s: r.service, size: r.size, q: r.quantity, vcpu: r.vcpu, ram: r.ram_gb, disk: r.disk_gb, use: r.usage_amount, unit: r.usage_unit, m: r.metric }));
}
main().catch((e) => { console.error(e); process.exit(1); });
