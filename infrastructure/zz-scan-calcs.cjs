const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { ScanCommand } = require('@aws-sdk/lib-dynamodb');
const c = new DynamoDBClient({ region: 'ap-south-1' });
(async () => {
  let ExclusiveStartKey;
  const rows = [];
  do {
    const r = await c.send(new ScanCommand({
      TableName: 'iep-dev-calculations-996122083346-ap-south-1',
      ProjectionExpression: 'calculation_id, #nm, #status, owner_user_id, created_at, updated_at, monthly_total, input_file_name',
      ExpressionAttributeNames: { '#status': 'status', '#nm': 'name' },
      ExclusiveStartKey,
    }));
    rows.push(...(r.Items || []));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  rows.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  console.log(`TOTAL ${rows.length}`);
  for (const r of rows) {
    console.log([String(r.calculation_id).slice(0, 8), String(r.status || '').padEnd(16), String(r.owner_user_id || '').padEnd(40), String(r.name || '').slice(0, 50).padEnd(50), new Date(r.created_at || 0).toISOString()].join('  '));
  }
})().catch((e) => { console.error(e); process.exit(1); });
