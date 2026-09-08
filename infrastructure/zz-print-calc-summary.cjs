const fs = require('fs');
const data = JSON.parse(fs.readFileSync('zz-calc-0b1157-summary.json','utf8'));
console.log(JSON.stringify({
  topMonthly: data.monthly_total,
  rendered: data.renderedTotals,
  scenarios: data.scenarios,
  resultScenarioCount: data.resultScenarioCount,
}, null, 2));
