const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { unmarshall } = require('@aws-sdk/util-dynamodb');
const fs = require('fs');
const c = new DynamoDBClient({ region: 'ap-south-1' });
(async () => {
  const r = await c.send(new GetItemCommand({
    TableName: 'iep-dev-calculations-996122083346-ap-south-1',
    Key: { calculation_id: { S: '0b1157a9-7160-4e53-97dc-8409992de225' } },
  }));
  const item = unmarshall(r.Item || {});
  const out = {
    status: item.status,
    monthly_total: item.monthly_total,
    calculator_url: item.calculator_url,
    input_file_name: item.input_file_name,
    evidence_row_count: item.evidence_row_count,
    workbook_semantic_model_s3_key: item.workbook_semantic_model_s3_key,
    scenario_manifest_s3_key: item.scenario_manifest_s3_key,
    scenario_requirements_s3_key: item.scenario_requirements_s3_key,
    resources_s3_key: item.resources_s3_key,
    result_s3_key: item.result_s3_key,
    plan_status: item.plan_v2?.status,
    scenarios: item.plan_v2?.recommendedScenarios,
    unresolved: item.plan_v2?.unresolved?.map(q => ({ id:q.id, field:q.field, impact:q.impact, prompt:q.prompt, scope:q.scope, resolved:q.resolved })),
    warnings: item.result?.warnings,
    assumptions: item.result?.assumptions,
    renderedTotals: item.result?.diagnostics?.renderedTotals,
    servicesConfigured: item.result?.diagnostics?.SERVICES_CONFIGURED,
    inputWarnings: item.input_warnings,
    tracePath: item.result?.diagnostics?.tracePath,
  };
  fs.writeFileSync('zz-calc-0b1157-summary.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify({status: out.status, monthly_total: out.monthly_total, scenarioCount: out.scenarios?.length, unresolvedCount: out.unresolved?.length, warnings: out.warnings?.length, assumptions: out.assumptions?.length, services: out.servicesConfigured?.length, file: 'zz-calc-0b1157-summary.json'}, null, 2));
})();
