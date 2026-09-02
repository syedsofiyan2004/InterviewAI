import { readFileSync } from 'node:fs';
import { analyseWorkbook } from '../lambdas/api-handler/calculator-workbook';

jest.setTimeout(60_000);

it('parses the real Digital_Assets.xlsx', async () => {
  const bytes = readFileSync(`${__dirname}/../../docs/Digital_Assets.xlsx`);
  const out: any = await analyseWorkbook(bytes, 'Digital_Assets.xlsx');
  const res: any[] = out.resources;
  const ins: any = out.insights;
  const priceable = res.filter((r) => r.service || r.size || r.vcpu !== undefined);
  const per = new Map<string, number>();
  for (const r of res) per.set(r.scenario ?? '(none)', (per.get(r.scenario ?? '(none)') ?? 0) + 1);

  const lines: string[] = [];
  lines.push(`resources: ${res.length}   priceable by pipeline filter: ${priceable.length}`);
  lines.push(`bands: ${JSON.stringify(ins.bands)}`);
  lines.push(`per scenario: ${JSON.stringify([...per])}`);
  lines.push(`server_count=${ins.server_count} total_disk_gb=${ins.total_disk_gb}`);
  lines.push(`conversions (${(ins.conversions ?? []).length}):`);
  for (const c of ins.conversions ?? []) lines.push(`   ${c}`);
  lines.push(`exclusions (${(ins.exclusions ?? []).length}):`);
  for (const e of ins.exclusions ?? []) lines.push(`   [${e.scenario ?? 'all'}] ${e.metric} -- ${e.reason}`);
  lines.push(`warnings (${out.warnings.length}):`);
  for (const w of out.warnings) lines.push(`   ${w}`);
  lines.push('first 10 rows:');
  for (const r of res.slice(0, 10)) {
    lines.push(`   ${JSON.stringify({
      sc: r.scenario, env: r.environment, s: r.service, size: r.size, q: r.quantity,
      vcpu: r.vcpu, ram: r.ram_gb, disk: r.disk_gb, use: r.usage_amount, unit: r.usage_unit, m: r.metric,
    })}`);
  }
  lines.push('band-2 (dev) rows:');
  for (const r of res.filter((x) => x.scenario === 'dev').slice(0, 8)) {
    lines.push(`   ${JSON.stringify({
      sc: r.scenario, s: r.service, size: r.size, q: r.quantity,
      vcpu: r.vcpu, ram: r.ram_gb, disk: r.disk_gb, use: r.usage_amount, unit: r.usage_unit, m: r.metric,
    })}`);
  }
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
  expect(priceable.length).toBeGreaterThan(0);
});
