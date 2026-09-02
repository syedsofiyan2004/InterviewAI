import * as fs from 'fs';
import * as path from 'path';
import { analyseWorkbook } from './lambdas/api-handler/calculator-workbook';
import { buildPrompt } from './lambdas/calculator-orchestrator/prompt';

(async () => {
  const file = path.join(__dirname, '..', 'docs', 'COSEC_AWS_TCO_Model.xlsx');
  const a = await analyseWorkbook(fs.readFileSync(file), 'COSEC_AWS_TCO_Model.xlsx');
  const i = a.insights;
  console.log('facts', i.facts.length, 'rates', i.rate_card.length, 'reported', i.reported.length, 'excerpts', i.excerpts.length);
  const p = buildPrompt({
    calculation_id: 'c', owner_user_id: 'u', name: 'n', prompt: 'p', status: 'PROCESSING',
    environment_hours: [], resources: [], input_warnings: a.warnings.slice(0, 16),
    created_at: 1, updated_at: 1, workbook: i, region: 'eu-central-1',
  } as any, a.resources);
  console.log('prompt chars', p.length);
  p.split('\n').forEach((line, n) => { if (/not shown|not listed/.test(line)) console.log('TRUNC line', n, JSON.stringify(line)); });
})();
