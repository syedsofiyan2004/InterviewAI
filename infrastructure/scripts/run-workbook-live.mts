/**
 * Runs one workbook through the SAME code path the deployed orchestrator runs — lossless
 * parse, canonical model, initial plan, then `runEstimatePipeline` with the live MCP sidecar
 * and browser validator — from this machine, so a regression fixture can be exercised without
 * an upload, a Cognito session or a Lambda log dive.
 *
 *   AWS_REGION=ap-south-1 npx tsx scripts/run-workbook-live.mts <file.xlsx|csv> [pricing-model]
 *
 * `pricing-model` is one of the chat vocabulary values (e.g. compute-savings-3yr); when given,
 * one requested scenario is priced at it. Without it the sheet's own bands and cells decide.
 */
process.env.AWS_REGION = process.env.AWS_REGION || 'ap-south-1';

import fs from 'fs';
import path from 'path';

const { analyseWorkbook } = await import('../lambdas/api-handler/calculator-workbook.js');
const { buildInitialPlan } = await import('../lambdas/shared/estimate-planning.js');
const { runEstimatePipeline } = await import('../lambdas/calculator-orchestrator/pipeline.js');
const { McpSidecarClient } = await import('../lambdas/calculator-orchestrator/mcp-client.js');
const { DEFAULT_ENVIRONMENT_HOURS } = await import('../schema/calculator.js');
type CalculationRecord = import('../schema/calculator.js').CalculationRecord;
type PricingModelRequest = import('../schema/estimate-plan.js').PricingModelRequest;

const file = process.argv[2];
if (!file) throw new Error('usage: run-workbook-live.mts <workbook> [pricing-model]');
const pricingModel = process.argv[3] as PricingModelRequest | undefined;

const SIDECAR = process.env.SIDECAR_FN || 'iep-dev-calculator-mcp-sidecar-996122083346-ap-south-1';
const BROWSER = process.env.BROWSER_FN || 'iep-dev-calculator-browser-validator-996122083346-ap-south-1';

const startedAt = Date.now();
const buffer = fs.readFileSync(file);
const analysis = await analyseWorkbook(buffer, path.basename(file));
const resources = analysis.legacyResources;
console.log(`parsed ${path.basename(file)}: ${resources.length} resource row(s), ${analysis.canonicalModel.rows.length} canonical row(s), ${analysis.warnings.length} warning(s)`);
console.log(`bands: ${(analysis.insights.bands || []).map((band) => `${band.label} (${band.kind})`).join(', ') || 'none'}`);

const planV2 = buildInitialPlan({
  workbookId: analysis.workbookIR.fileHash,
  resources,
  workbook: analysis.insights,
  defaultRegion: 'ap-south-1',
  ...(pricingModel ? { requestedPlan: { scenarios: [{ label: pricingModel, pricing_model: pricingModel, environments: [] }] } } : {}),
});
console.log(`plan: ${planV2.status}, ${planV2.detectedDimensions.mappedResourceCount}/${planV2.detectedDimensions.resourceCount} mapped, ${planV2.unresolved.length} open question(s)`);
for (const question of planV2.unresolved.slice(0, 8)) console.log(`  ? [${question.impact}] ${question.prompt.slice(0, 160)}`);

const now = Date.now();
const record: CalculationRecord = {
  calculation_id: `local-${now}`,
  owner_user_id: 'local',
  name: `Local ${path.basename(file, path.extname(file))}`,
  prompt: '',
  region: 'ap-south-1',
  status: 'PROCESSING',
  environment_hours: DEFAULT_ENVIRONMENT_HOURS,
  resources,
  workbook: analysis.insights,
  workbook_hash: analysis.workbookIR.fileHash,
  plan_v2: planV2,
  ...(pricingModel ? { requested_plan: { scenarios: [{ label: pricingModel, pricing_model: pricingModel, environments: [] }] } } : {}),
  input_warnings: [],
  created_at: now,
  updated_at: now,
};

const mcp = new McpSidecarClient(SIDECAR, BROWSER);
const outcome = await runEstimatePipeline(record, resources, mcp, async (update) => {
  console.log(`  [${update.stage}] ${update.message}`);
}, analysis.canonicalModel);

const result = outcome.result;
console.log(`\n=== ${path.basename(file)}: ${outcome.status} in ${Math.round((Date.now() - startedAt) / 1000)}s ===`);
console.log('url:', result.url);
console.log('monthlyTotal (Calculator):', result.monthlyTotal, '| Price List cross-check:', (result.diagnostics as Record<string, unknown>)?.PRICE_LIST_CROSS_CHECK_MONTHLY);
console.log('line items:', result.lineItems.length, '| unpriced:', result.lineItems.filter((item) => item.monthly === null).length);
for (const scenario of result.scenarios) {
  console.log(`- ${scenario.label}: ${scenario.status} monthly=${scenario.monthly} upfront=${scenario.upfront} 12m=${scenario.total_12_months} ${scenario.url || '(no link)'}`);
  console.log(`    pricing: ${scenario.pricing_model} | scope: ${scenario.scope || '-'}`);
  for (const error of scenario.validation_errors || []) console.log(`    ! ${error.slice(0, 220)}`);
}
console.log('\nwarnings:');
for (const warning of result.warnings) console.log(`  - ${warning.slice(0, 240)}`);
const diagnostics = result.diagnostics as { MCP_VERSION?: string; scenarios?: Array<{ scenarioId: string; status: string; modelsUsed: Record<string, string>; toolCalls: number; durationMs: number; perResourceAttempts: Record<string, unknown[]> }> };
console.log('\nMCP:', diagnostics.MCP_VERSION);
for (const scenario of diagnostics.scenarios || []) {
  const tiers = Object.values(scenario.modelsUsed);
  const modelSteps = tiers.filter((tier) => tier === 'HAIKU_4_5' || tier === 'SONNET_4_6').length;
  const retried = Object.values(scenario.perResourceAttempts).filter((attempts) => attempts.length > 1).length;
  console.log(`  ${scenario.scenarioId}: ${scenario.status}, ${scenario.toolCalls} MCP calls, ${modelSteps} model step(s), ${retried} resource(s) needed a correction, ${Math.round(scenario.durationMs / 1000)}s`);
}
fs.writeFileSync(`zz-run-${path.basename(file, path.extname(file)).replace(/[^A-Za-z0-9]+/g, '-')}.json`, JSON.stringify({ outcome, planUnresolved: planV2.unresolved }, null, 2));
