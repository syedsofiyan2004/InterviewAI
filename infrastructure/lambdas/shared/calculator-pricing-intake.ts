import type { CalculationResource, WorkbookInsights } from '../../schema/calculator';
import type { EstimatePlanV2, PlanQuestion } from '../../schema/estimate-plan';

export const PRICING_INTAKE_VERSION = '2.0';

export type PricingIntakeStatus = 'READY' | 'NEEDS_INPUT';

export interface PricingIntakeGap {
  field: string;
  column: string;
  scope: string;
  affectedCount: number;
  reason: string;
  sourceRefs: string[];
}

export interface PricingIntakeSummary {
  version: typeof PRICING_INTAKE_VERSION;
  status: PricingIntakeStatus;
  normalizedResourceCount: number;
  scenarioSheets: string[];
  missing: PricingIntakeGap[];
  safeAssumptions: string[];
}

export interface PricingIntakeArtifact {
  workbook: Buffer;
  summary: PricingIntakeSummary;
}

interface IntakeRow {
  sourceRef: string;
  sourceSheet: string;
  sourceRow: number | '';
  resourceName: string;
  scenario: string;
  environment: string;
  service: string;
  region: string;
  size: string;
  quantity: string;
  vcpu: number | '';
  memoryGiB: number | '';
  operatingSystem: string;
  monthlyHours: number | '';
  usageAmount: number | '';
  usageUnit: string;
  storageGiB: number | '';
  storageType: string;
  availability: string;
  engine: string;
  dataTransferGbMonth: number | '';
  configuration: string;
  notes: string;
  rawSource: string;
  requiredColumns: Set<string>;
}

interface RowGap {
  resourceIndex: number;
  field: string;
  column: string;
  reason: string;
  scope: string;
}

export const PRICING_INTAKE_COLUMNS = [
  'Source Reference',
  'Resource Name',
  'Scenario / Year',
  'Environment',
  'AWS Service',
  'Region',
  'Instance / Size',
  'Quantity',
  'vCPU',
  'Memory GiB',
  'Operating System',
  'Monthly Hours',
  'Usage Amount',
  'Usage Unit',
  'Storage GiB',
  'Storage Type',
  'Availability',
  'Engine',
  'Data Transfer GB/Month',
  'Configuration',
  'Notes',
  'Input Status',
] as const;

const TIME_BILLED = /\b(ec2|fargate|ecs|lambda|rds|aurora|sagemaker|opensearch|elasticache|memorydb|redshift|emr|msk|amazon mq)\b/i;
const INSTANCE_BACKED = /\b(ec2|rds|aurora|sagemaker|opensearch|elasticache|memorydb|redshift|emr|msk|amazon mq)\b/i;
const DATABASE = /\b(rds|aurora)\b/i;
const EXPLICIT_STORAGE = /\b(ebs|elastic block store)\b/i;
const GLOBAL_SERVICE = /\b(cloudfront|route\s*53|iam)\b/i;

const clean = (value: unknown): string => String(value ?? '').replace(/\s+/g, ' ').trim();

function sourceRef(resource: CalculationResource, index: number): string {
  const sheet = clean(resource.sheet) || 'Input';
  const row = resource.row || index + 1;
  return `${sheet}!${row}`;
}

function valueFrom(resource: CalculationResource, labels: RegExp): string {
  const attribute = resource.attributes?.find((entry) => labels.test(clean(entry.label)) && clean(entry.value));
  if (attribute) return clean(attribute.value);
  const configuration = resource.configuration || {};
  const key = Object.keys(configuration).find((candidate) => labels.test(candidate) && clean(configuration[candidate]));
  return key ? clean(configuration[key]) : '';
}

function numberValue(value: unknown): number | '' {
  if (value === null || value === undefined || value === '') return '';
  const token = clean(value).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/)?.[0];
  const parsed = token === undefined ? Number.NaN : Number(token);
  return Number.isFinite(parsed) ? parsed : '';
}

function serviceText(resource: CalculationResource): string {
  return clean(resource.service || resource.role || resource.metric);
}

function normalizeEnvironment(value: string): string {
  if (!value) return '';
  if (/\bprod(?:uction)?\b/i.test(value) && !/non.?prod|pre.?prod/i.test(value)) return 'Production';
  if (/\bdr\b|disaster recovery/i.test(value)) return 'DR';
  if (/\buat\b/i.test(value)) return 'UAT';
  if (/\bqa\b|test/i.test(value)) return 'Test';
  if (/sandbox/i.test(value)) return 'Sandbox';
  if (/stage|staging|pre.?prod/i.test(value)) return 'Staging';
  if (/dev|development/i.test(value)) return 'Development';
  if (/non.?prod/i.test(value)) return 'Non-Production';
  return value;
}

function scenarioName(resource: CalculationResource, workbook?: WorkbookInsights): string {
  if (clean(resource.scenario)) return clean(resource.scenario);
  const bands = workbook?.bands || [];
  if (bands.length === 1) return clean(bands[0].label);
  return 'Baseline';
}

function rowFromResource(
  resource: CalculationResource,
  index: number,
  workbook: WorkbookInsights | undefined,
  defaultRegion: string | undefined,
): IntakeRow {
  const service = serviceText(resource);
  const quantityDimension = resource.quantities?.find((entry) => entry.unit === 'hours/month');
  const storageDimension = resource.quantities?.find((entry) => entry.unit === 'GB/month');
  const transferDimension = resource.quantities?.find((entry) => entry.unit === 'GB-transfer/month');
  const usageDimension = resource.quantities?.find((entry) => !['hours/month', 'GB/month', 'GB-transfer/month'].includes(entry.unit));
  const row: IntakeRow = {
    sourceRef: sourceRef(resource, index),
    sourceSheet: clean(resource.sheet) || 'Input',
    sourceRow: resource.row || '',
    resourceName: clean(resource.name || resource.resourceId || resource.metric) || sourceRef(resource, index),
    scenario: scenarioName(resource, workbook),
    environment: normalizeEnvironment(clean(resource.environment)),
    service,
    region: clean(resource.region || defaultRegion || workbook?.primary_region),
    // A source SKU may be Azure, VMware or an on-prem hardware label. Carrying it as
    // an AWS instance size would turn source evidence into a target-sizing decision.
    // The original value remains available in Source Lineage for Claude to inspect.
    size: clean(resource.size),
    quantity: clean(resource.quantity) || '1',
    vcpu: numberValue(resource.vcpu),
    memoryGiB: numberValue(resource.ram_gb),
    operatingSystem: clean(resource.os),
    monthlyHours: numberValue(resource.hoursPerMonth ?? quantityDimension?.amount),
    usageAmount: numberValue(resource.usage_amount ?? usageDimension?.amount),
    usageUnit: clean(resource.usage_unit || usageDimension?.unit),
    storageGiB: numberValue(resource.disk_gb ?? storageDimension?.amount),
    storageType: valueFrom(resource, /storage\s*(type|class)|volume\s*type|ebs\s*type/i),
    availability: valueFrom(resource, /availability|multi.?az|deployment/i)
      || (/multi.?az/i.test(clean(resource.notes || resource.raw)) ? 'Multi-AZ' : ''),
    engine: valueFrom(resource, /engine|database\s*type|compatibility/i),
    dataTransferGbMonth: numberValue(transferDimension?.amount || valueFrom(resource, /data\s*transfer/i)),
    configuration: resource.configuration
      ? JSON.stringify(resource.configuration)
      : valueFrom(resource, /^configuration(?:\s*summary)?$/i),
    notes: clean(resource.notes),
    rawSource: clean(resource.raw),
    requiredColumns: new Set<string>(),
  };
  return row;
}

function gap(
  gaps: RowGap[],
  row: IntakeRow,
  resourceIndex: number,
  field: string,
  column: string,
  reason: string,
  scope?: string,
): void {
  row.requiredColumns.add(column);
  gaps.push({ resourceIndex, field, column, reason, scope: scope || row.environment || row.service || 'All resources' });
}

function planGaps(plan: EstimatePlanV2 | undefined, rows: IntakeRow[]): RowGap[] {
  if (!plan) return [];
  const columnFor: Record<string, string> = {
    'resource.region': 'Region',
    'resource.service_family': 'AWS Service',
    'resource.instance_type': 'Instance / Size',
    'lambda.execution_profile': 'Configuration',
  };
  const gaps: RowGap[] = [];
  for (const question of plan.unresolved.filter((entry) => entry.impact === 'high' && !entry.resolved)) {
    const column = columnFor[question.field];
    if (!column) continue;
    const indexes = question.scope
      .filter((scope) => scope.startsWith('resource:'))
      .map((scope) => Number(scope.slice('resource:'.length)))
      .filter((index) => Number.isInteger(index) && rows[index]);
    const targets = indexes.length ? indexes : rows.map((_, index) => index);
    for (const index of targets) {
      gap(gaps, rows[index], index, question.field, column, question.prompt, question.scope.join(', ') || 'All resources');
    }
  }
  return gaps;
}

function technicalGaps(rows: IntakeRow[]): RowGap[] {
  const gaps: RowGap[] = [];
  rows.forEach((row, index) => {
    const scope = row.environment || row.scenario || row.service || 'All resources';
    if (!row.service) gap(gaps, row, index, 'resource.service_family', 'AWS Service', 'Identify the AWS service that this source row should use.', scope);
    if (!row.region && !GLOBAL_SERVICE.test(row.service)) {
      gap(gaps, row, index, 'resource.region', 'Region', 'Region materially changes AWS price and service availability.', 'All regional resources');
    }
    if (INSTANCE_BACKED.test(row.service) && !row.size && row.vcpu === '' && row.memoryGiB === '') {
      gap(gaps, row, index, 'resource.instance_type', 'Instance / Size', 'Provide an instance class, or both vCPU and memory, so the workload can be sized.', scope);
    }
    if (TIME_BILLED.test(row.service) && row.monthlyHours === '' && !/requests|invocations|gb.?seconds/i.test(row.usageUnit)) {
      gap(gaps, row, index, 'resource.monthly_hours', 'Monthly Hours', 'Operating time materially changes compute cost.', row.environment || row.scenario || row.service);
    }
    if (/\bec2\b/i.test(row.service) && !row.operatingSystem) {
      gap(gaps, row, index, 'resource.operating_system', 'Operating System', 'Linux and licensed operating systems have materially different prices.', scope);
    }
    if (/fargate|\becs\b/i.test(row.service)) {
      if (row.vcpu === '') gap(gaps, row, index, 'fargate.vcpu', 'vCPU', 'Provide vCPU per task.', scope);
      if (row.memoryGiB === '') gap(gaps, row, index, 'fargate.memory', 'Memory GiB', 'Provide memory per task.', scope);
    }
    if (/\blambda\b/i.test(row.service) && !row.configuration && !/gb.?seconds/i.test(row.usageUnit)) {
      gap(gaps, row, index, 'lambda.execution_profile', 'Configuration', 'Provide memory MB and average duration ms.', scope);
    }
    if (DATABASE.test(row.service) && !row.availability) {
      gap(gaps, row, index, 'database.availability', 'Availability', 'Specify Single-AZ or Multi-AZ because availability materially changes cost.', scope);
    }
    if (EXPLICIT_STORAGE.test(row.service) && row.storageGiB === '') {
      gap(gaps, row, index, 'storage.capacity', 'Storage GiB', 'Provide the billable storage capacity.', scope);
    }
    if (EXPLICIT_STORAGE.test(row.service) && !row.storageType) {
      gap(gaps, row, index, 'storage.type', 'Storage Type', 'Specify the EBS volume type because price and performance differ.', scope);
    }
  });
  return gaps;
}

function dedupeGaps(gaps: RowGap[]): RowGap[] {
  const seen = new Set<string>();
  return gaps.filter((entry) => {
    const key = `${entry.resourceIndex}|${entry.field}|${entry.column}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summarizeGaps(gaps: RowGap[], rows: IntakeRow[]): PricingIntakeGap[] {
  const groups = new Map<string, RowGap[]>();
  gaps.forEach((entry) => {
    // Group by the missing fact, not by every resource/environment scope. The workbook
    // still highlights each affected cell, while Inputs Needed stays a short checklist.
    const key = `${entry.field}|${entry.column}|${entry.reason}`;
    groups.set(key, [...(groups.get(key) || []), entry]);
  });
  return [...groups.values()].map((entries) => {
    const scopes = [...new Set(entries.map((entry) => entry.scope))];
    return {
      field: entries[0].field,
      column: entries[0].column,
      scope: scopes.length <= 3 ? scopes.join(', ') : `${scopes.slice(0, 3).join(', ')} + ${scopes.length - 3} more`,
      affectedCount: new Set(entries.map((entry) => entry.resourceIndex)).size,
      reason: entries[0].reason,
      sourceRefs: [...new Set(entries.map((entry) => rows[entry.resourceIndex].sourceRef))].slice(0, 20),
    };
  });
}

function safeAssumptions(rows: IntakeRow[]): string[] {
  const assumptions = [
    'A source row that identifies one independent resource and has no quantity is represented with Quantity = 1.',
    'Calculator field IDs, selector values and minimalConfig scaffolding are resolved from the official MCP.',
    'Blank low-impact Calculator implementation fields may use MCP structural defaults and must be disclosed in the final result.',
  ];
  if (rows.some((row) => !row.environment)) {
    assumptions.push('A blank Environment remains Unspecified; it is not automatically treated as Production or Non-Production.');
  }
  return assumptions;
}

function safeSheetName(value: string, used: Set<string>): string {
  const base = (clean(value) || 'Baseline').replace(/[\\/*?:\[\]]/g, '-').slice(0, 25) || 'Baseline';
  let name = base;
  let suffix = 2;
  while (used.has(name.toLowerCase())) name = `${base.slice(0, 21)}-${suffix++}`;
  used.add(name.toLowerCase());
  return name;
}

function rowValues(row: IntakeRow): Array<string | number> {
  return [
    row.sourceRef,
    row.resourceName,
    row.scenario,
    row.environment,
    row.service,
    row.region,
    row.size,
    row.quantity,
    row.vcpu,
    row.memoryGiB,
    row.operatingSystem,
    row.monthlyHours,
    row.usageAmount,
    row.usageUnit,
    row.storageGiB,
    row.storageType,
    row.availability,
    row.engine,
    row.dataTransferGbMonth,
    row.configuration,
    row.notes,
    row.requiredColumns.size ? 'FILL REQUIRED CELLS' : 'READY',
  ];
}

function addIntakeSheet(
  workbook: import('exceljs').Workbook,
  name: string,
  rows: IntakeRow[],
): void {
  const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1, xSplit: 2 }] });
  sheet.addRow([...PRICING_INTAKE_COLUMNS]);
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF16324F' } };
  header.alignment = { vertical: 'middle', wrapText: true };
  header.height = 30;
  rows.forEach((row) => {
    const excelRow = sheet.addRow(rowValues(row));
    excelRow.alignment = { vertical: 'top', wrapText: true };
    for (const column of row.requiredColumns) {
      const columnIndex = PRICING_INTAKE_COLUMNS.indexOf(column as typeof PRICING_INTAKE_COLUMNS[number]) + 1;
      if (columnIndex > 0) {
        excelRow.getCell(columnIndex).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE699' } };
        excelRow.getCell(columnIndex).font = { color: { argb: 'FF9C5700' }, bold: true };
      }
    }
  });
  sheet.autoFilter = { from: 'A1', to: `V${Math.max(1, rows.length + 1)}` };
  sheet.columns.forEach((column, index) => {
    const widths = [20, 28, 18, 18, 22, 16, 20, 10, 10, 12, 18, 15, 15, 18, 14, 16, 16, 18, 22, 34, 34, 20];
    column.width = widths[index] || 16;
  });
}

export async function generatePricingIntakeWorkbook(input: {
  resources: CalculationResource[];
  workbook?: WorkbookInsights;
  plan?: EstimatePlanV2;
  sourceFileName?: string;
  defaultRegion?: string;
}): Promise<PricingIntakeArtifact> {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'MIMO AWS Cost Calculator';
  workbook.created = new Date();
  workbook.subject = `Pricing Intake ${PRICING_INTAKE_VERSION}`;

  const rows = input.resources.map((resource, index) => rowFromResource(
    resource,
    index,
    input.workbook,
    input.defaultRegion,
  ));
  const gaps = dedupeGaps([...planGaps(input.plan, rows), ...technicalGaps(rows)]);
  const missing = rows.length
    ? summarizeGaps(gaps, rows)
    : [{
      field: 'workbook.resources',
      column: 'Pricing Intake',
      scope: 'Uploaded workbook',
      affectedCount: 0,
      reason: 'No billable resource rows could be identified. Add the material workloads to the Pricing Intake sheet.',
      sourceRefs: [],
    }];
  const assumptions = safeAssumptions(rows);

  const instructions = workbook.addWorksheet('Instructions', { views: [{ state: 'frozen', ySplit: 1 }] });
  instructions.columns = [{ width: 28 }, { width: 110 }];
  instructions.addRows([
    ['MIMO Pricing Intake', `Version ${PRICING_INTAKE_VERSION}`],
    ['Purpose', 'A normalized, source-linked workbook for the Claude AWS Cost Estimation agent and the official AWS Pricing Calculator MCP.'],
    ['What to do', missing.length
      ? (rows.length
        ? 'Fill only the yellow cells on the scenario sheets, save this workbook as .xlsx, and upload it again. Use Excel fill-down for values shared by many resources.'
        : 'Add the billable workload rows to the Pricing Intake sheet, save this workbook as .xlsx, and upload it again.')
      : 'No material technical cells are missing. Upload this workbook directly or continue with the current estimate.'],
    ['Runtime questions', 'The pricing run asks only for commercial pricing strategy and whether separate Calculator links are required for selected scenarios.'],
    ['Accuracy rule', 'Do not replace a blank yellow cell with a guess. Low-impact MCP structural defaults are listed on Safe Assumptions and disclosed in the final estimate.'],
    ['Source workbook', clean(input.sourceFileName || input.workbook?.file_name) || 'Uploaded workbook'],
  ]);
  instructions.getRow(1).font = { bold: true, size: 16, color: { argb: 'FF16324F' } };
  instructions.eachRow((row) => { row.alignment = { vertical: 'top', wrapText: true }; });

  const required = workbook.addWorksheet('Inputs Needed', { views: [{ state: 'frozen', ySplit: 1 }] });
  required.columns = [
    { header: 'Importance', key: 'importance', width: 16 },
    { header: 'Scope', key: 'scope', width: 28 },
    { header: 'Column to fill', key: 'column', width: 24 },
    { header: 'Affected resources', key: 'count', width: 20 },
    { header: 'Why it is needed', key: 'reason', width: 70 },
    { header: 'Example source references', key: 'refs', width: 55 },
  ];
  if (missing.length) {
    missing.forEach((entry) => required.addRow({
      importance: 'Required for accuracy',
      scope: entry.scope,
      column: entry.column,
      count: entry.affectedCount,
      reason: entry.reason,
      refs: entry.sourceRefs.join(', '),
    }));
  } else {
    required.addRow({ importance: 'Ready', scope: 'All resources', reason: 'No material technical input is missing.' });
  }
  required.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  required.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF9C6500' } };
  required.eachRow((row, number) => {
    row.alignment = { vertical: 'top', wrapText: true };
    if (number > 1 && missing.length) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
  });

  const safe = workbook.addWorksheet('Safe Assumptions');
  safe.columns = [{ header: 'Assumption policy', width: 110 }];
  assumptions.forEach((assumption) => safe.addRow([assumption]));
  safe.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  safe.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF375623' } };
  safe.eachRow((row) => { row.alignment = { vertical: 'top', wrapText: true }; });

  const scenarios = rows.length ? [...new Set(rows.map((row) => row.scenario || 'Baseline'))] : ['Baseline'];
  const usedNames = new Set(['instructions', 'inputs needed', 'safe assumptions', 'source context', 'source lineage']);
  const scenarioSheets: string[] = [];
  for (const scenario of scenarios) {
    const sheetName = safeSheetName(scenarios.length > 1 ? `Scenario ${scenario}` : 'Pricing Intake', usedNames);
    scenarioSheets.push(sheetName);
    addIntakeSheet(workbook, sheetName, rows.filter((row) => (row.scenario || 'Baseline') === scenario));
  }

  const sourceContext = workbook.addWorksheet('Source Context', { views: [{ state: 'frozen', ySplit: 1 }] });
  sourceContext.columns = [
    { header: 'Context type', width: 22 },
    { header: 'Source', width: 32 },
    { header: 'Content', width: 120 },
  ];
  for (const fact of input.workbook?.facts || []) {
    sourceContext.addRow(['Workbook fact', clean((fact as { label?: string }).label), clean((fact as { value?: unknown }).value)]);
  }
  for (const excerpt of input.workbook?.excerpts || []) {
    sourceContext.addRow([
      'Workbook excerpt',
      clean((excerpt as { sheet?: string }).sheet),
      clean((excerpt as { text?: string; content?: string }).text || (excerpt as { content?: string }).content || JSON.stringify(excerpt)),
    ]);
  }
  for (const conversion of input.workbook?.conversions || []) sourceContext.addRow(['Source conversion', '', clean(conversion)]);
  for (const exclusion of input.workbook?.exclusions || []) {
    sourceContext.addRow(['Source exclusion', clean(exclusion.metric), `${clean(exclusion.reason)}${exclusion.scenario ? ` (scenario: ${clean(exclusion.scenario)})` : ''}`]);
  }
  if (sourceContext.rowCount === 1) sourceContext.addRow(['Source context', '', 'No separate instruction or context facts were detected.']);
  sourceContext.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sourceContext.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF44546A' } };
  sourceContext.eachRow((row) => { row.alignment = { vertical: 'top', wrapText: true }; });

  const lineage = workbook.addWorksheet('Source Lineage', { views: [{ state: 'frozen', ySplit: 1 }] });
  lineage.columns = [
    { header: 'Source Reference', width: 22 },
    { header: 'Source Sheet', width: 25 },
    { header: 'Source Row', width: 12 },
    { header: 'Normalized Resource', width: 30 },
    { header: 'Raw Source Content', width: 120 },
  ];
  rows.forEach((row) => lineage.addRow([row.sourceRef, row.sourceSheet, row.sourceRow, row.resourceName, row.rawSource]));
  lineage.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  lineage.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF44546A' } };
  lineage.eachRow((row) => { row.alignment = { vertical: 'top', wrapText: true }; });

  const binary = await workbook.xlsx.writeBuffer();
  const summary: PricingIntakeSummary = {
    version: PRICING_INTAKE_VERSION,
    status: missing.length ? 'NEEDS_INPUT' : 'READY',
    normalizedResourceCount: rows.length,
    scenarioSheets,
    missing,
    safeAssumptions: assumptions,
  };
  return { workbook: Buffer.from(binary), summary };
}
