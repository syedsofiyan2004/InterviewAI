import type { WorkbookIR, CellIR } from './workbook.js';
import type {
  CanonicalExclusion,
  CanonicalQuantity,
  CanonicalRow,
  CanonicalScenario,
  CanonicalWorkbook,
} from './canonical-workbook.js';
import type { CalculationResource, WorkbookInsights } from '../../schema/calculator.js';
import type { EstimatePlan } from '../../schema/estimate-plan.js';

export type SemanticSourceKind =
  | 'WORKBOOK'
  | 'WORKBOOK_POLICY'
  | 'TEMPLATE_METADATA'
  | 'DERIVED'
  | 'USER'
  | 'PROJECT_DEFAULT'
  | 'MCP_DEFAULT'
  | 'AI_ASSUMPTION'
  | 'MUST_CONFIRM';

export interface SemanticSourceRef {
  sheet?: string;
  row?: number;
  col?: number;
  a1?: string;
  label?: string;
  value?: string;
}

export interface WorkbookInstruction {
  instructionId: string;
  text: string;
  source: SemanticSourceRef[];
}

export interface SemanticPolicy {
  policyId: string;
  field: string;
  value: string | number | boolean;
  sourceType: SemanticSourceKind;
  source: SemanticSourceRef[];
  reason?: string;
}

export interface SemanticEnvironment {
  environmentId: string;
  name: string;
  source: SemanticSourceRef[];
}

export interface SemanticPeriod {
  periodId: string;
  label: string;
  source: SemanticSourceRef[];
}

export interface SemanticScenario {
  scenarioId: string;
  label: string;
  kind?: 'sizing' | 'period' | 'environment' | 'pricing';
  source: SemanticSourceRef[];
}

export interface SemanticResource {
  resourceId: string;
  label: string;
  service?: string;
  scenarioId?: string;
  environmentId?: string;
  region?: string;
  shape?: {
    size?: string;
    os?: string;
    purchaseModel?: string;
    count?: number;
    vcpu?: number;
    ramGb?: number;
  };
  quantities: SemanticQuantity[];
  attributes: Array<{ label: string; value: string; source: SemanticSourceRef[] }>;
  assumptions: string[];
  unresolved: string[];
  source: SemanticSourceRef[];
}

export interface SemanticQuantity {
  field: string;
  value: number;
  unit: string;
  original?: {
    value?: number | string;
    unit?: string;
    period?: string;
    scale?: string;
  };
  derived?: {
    value?: number | string;
    unit?: string;
    period?: string;
    scale?: string;
  };
  conversionFormula?: string;
  conversions: string[];
  resolutionType: SemanticSourceKind;
  source: SemanticSourceRef[];
}

export interface SemanticUsage {
  usageId: string;
  resourceId: string;
  field: string;
  value: number;
  unit: string;
  source: SemanticSourceRef[];
}

export interface SemanticArchitecture {
  architectureId: string;
  text: string;
  source: SemanticSourceRef[];
}

export interface SemanticAssumption {
  assumptionId: string;
  text: string;
  sourceType: SemanticSourceKind;
  source: SemanticSourceRef[];
}

export interface SemanticItem {
  itemId: string;
  label: string;
  reason?: string;
  source: SemanticSourceRef[];
}

export interface SemanticUncertainty {
  uncertaintyId: string;
  field: string;
  message: string;
  materiality: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  source: SemanticSourceRef[];
}

export interface EvidenceAccounting {
  workbookCells: number;
  canonicalRows: number;
  canonicalExclusions: number;
  canonicalBalanced: boolean;
  semanticResources: number;
  semanticUncertainties: number;
}

export interface WorkbookSemanticModel {
  version: 'workbook-semantic-model.v1';
  modelId: string;
  workbookId: string;
  template: {
    type?: string;
    version?: string;
    recognised: boolean;
    metadataSheet?: string;
    evidence: SemanticSourceRef[];
  };
  instructions: WorkbookInstruction[];
  projectPolicies: SemanticPolicy[];
  environments: SemanticEnvironment[];
  fiscalPeriods: SemanticPeriod[];
  scenarios: SemanticScenario[];
  resources: SemanticResource[];
  usage: SemanticUsage[];
  architecture: SemanticArchitecture[];
  assumptions: SemanticAssumption[];
  nonAwsItems: SemanticItem[];
  unresolved: SemanticUncertainty[];
  evidenceAccounting: EvidenceAccounting;
}

export interface ScenarioManifest {
  version: 'scenario-manifest.v1';
  workbookSemanticModelId: string;
  expectedScenarioCount: number;
  scenarios: ScenarioSpec[];
}

export interface ScenarioSpec {
  scenarioId: string;
  label: string;
  kind?: 'sizing' | 'period' | 'environment' | 'pricing';
  resourceIds: string[];
  source: SemanticSourceRef[];
}

export interface ScenarioRequirements {
  version: 'scenario-requirements.v1';
  scenarioId: string;
  label: string;
  resources: SemanticResource[];
  policies: SemanticPolicy[];
  assumptions: SemanticAssumption[];
  unresolved: SemanticUncertainty[];
}

export interface BuildWorkbookSemanticInput {
  workbookIR: WorkbookIR;
  canonicalModel: CanonicalWorkbook;
  insights?: WorkbookInsights;
  resources?: CalculationResource[];
  requestedPlan?: EstimatePlan;
}

const TEMPLATE_METADATA_SHEET = '_MIMO_METADATA';
const INSTRUCTION_SHEET_HINT = /(template\s*guide|instruction|read\s*me|guide)/i;
const ARCHITECTURE_SHEET_HINT = /(architecture|topology|design)/i;
const ASSUMPTION_SHEET_HINT = /(assumption|policy|constraint)/i;
const NON_AWS_SHEET_HINT = /(non[-\s]?aws|out\s*of\s*scope|exclusion)/i;
const PERIOD_VALUE = /\b(fy|cy|q[1-4]|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|month|year|annual|monthly|quarter)\b/i;

export function buildWorkbookSemanticArtifacts(input: BuildWorkbookSemanticInput): {
  semanticModel: WorkbookSemanticModel;
  scenarioManifest: ScenarioManifest;
  scenarioRequirements: ScenarioRequirements[];
} {
  const semanticModel = buildWorkbookSemanticModel(input);
  const scenarioManifest = buildScenarioManifest(semanticModel);
  const scenarioRequirements = scenarioManifest.scenarios.map((scenario) => buildScenarioRequirements(semanticModel, scenario));
  return { semanticModel, scenarioManifest, scenarioRequirements };
}

export function buildWorkbookSemanticModel(input: BuildWorkbookSemanticInput): WorkbookSemanticModel {
  const metadata = readTemplateMetadata(input.workbookIR);
  const resources = input.canonicalModel.rows.map((row, index) => semanticResource(row, input.canonicalModel.scenarios, index));
  const environments = semanticEnvironments(input.canonicalModel.rows, input.resources || []);
  const scenarios = semanticScenarios(input.canonicalModel.scenarios, input.requestedPlan);
  const instructions = workbookInstructions(input.workbookIR);
  const assumptions = semanticAssumptions(input);
  const unresolved = semanticUncertainties(input.canonicalModel);

  return {
    version: 'workbook-semantic-model.v1',
    modelId: `${input.workbookIR.fileHash}:semantic:v1`,
    workbookId: input.workbookIR.workbookId,
    template: {
      type: metadata.values.TemplateType,
      version: metadata.values.TemplateVersion,
      recognised: metadata.recognised,
      metadataSheet: metadata.sheet,
      evidence: metadata.evidence,
    },
    instructions,
    projectPolicies: semanticPolicies(input.workbookIR, metadata),
    environments,
    fiscalPeriods: semanticPeriods(input.workbookIR, input.canonicalModel.scenarios),
    scenarios,
    resources,
    usage: resources.flatMap((resource) => resource.quantities.map((quantity, index) => ({
      usageId: `${resource.resourceId}:usage:${index}`,
      resourceId: resource.resourceId,
      field: quantity.field,
      value: quantity.value,
      unit: quantity.unit,
      source: quantity.source,
    }))),
    architecture: semanticArchitecture(input.workbookIR),
    assumptions,
    nonAwsItems: semanticNonAwsItems(input.workbookIR, input.canonicalModel.exclusions),
    unresolved,
    evidenceAccounting: {
      workbookCells: input.workbookIR.nonEmptyCellCount,
      canonicalRows: input.canonicalModel.accounting.canonicalRows,
      canonicalExclusions: input.canonicalModel.accounting.exclusions,
      canonicalBalanced: input.canonicalModel.accounting.balanced,
      semanticResources: resources.length,
      semanticUncertainties: unresolved.length,
    },
  };
}

export function buildScenarioManifest(model: WorkbookSemanticModel): ScenarioManifest {
  const scenarios = model.scenarios.length
    ? model.scenarios.map((scenario): ScenarioSpec => ({
      scenarioId: scenario.scenarioId,
      label: scenario.label,
      kind: scenario.kind,
      resourceIds: model.resources
        .filter((resource) => !resource.scenarioId || resource.scenarioId === scenario.scenarioId)
        .map((resource) => resource.resourceId),
      source: scenario.source,
    }))
    : [{
      scenarioId: 'scenario:default',
      label: 'Default estimate',
      resourceIds: model.resources.map((resource) => resource.resourceId),
      source: [],
    }];

  return {
    version: 'scenario-manifest.v1',
    workbookSemanticModelId: model.modelId,
    expectedScenarioCount: scenarios.length,
    scenarios,
  };
}

export function buildScenarioRequirements(model: WorkbookSemanticModel, scenario: ScenarioSpec): ScenarioRequirements {
  const resourceIds = new Set(scenario.resourceIds);
  const resources = model.resources.filter((resource) => resourceIds.has(resource.resourceId));
  const unresolved = model.unresolved.filter((entry) => !entry.source.length || entry.source.some((source) => resources.some((resource) => sameSource(resource.source, source))));
  return {
    version: 'scenario-requirements.v1',
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    resources,
    policies: model.projectPolicies,
    assumptions: model.assumptions,
    unresolved,
  };
}

function readTemplateMetadata(workbookIR: WorkbookIR): { recognised: boolean; sheet?: string; values: Record<string, string>; evidence: SemanticSourceRef[] } {
  const sheet = workbookIR.sheets.find((entry) => entry.name.trim().toLowerCase() === TEMPLATE_METADATA_SHEET.toLowerCase());
  if (!sheet) return { recognised: false, values: {}, evidence: [] };
  const byRow = groupCellsByRow(sheet.cells);
  const values: Record<string, string> = {};
  const evidence: SemanticSourceRef[] = [];
  for (const cells of byRow.values()) {
    const key = cells[0]?.formatted?.trim();
    const value = cells[1]?.formatted?.trim();
    if (!key || !value) continue;
    values[key] = value;
    evidence.push(sourceOf(cells[0]), sourceOf(cells[1]));
  }
  return { recognised: Boolean(values.TemplateType || values.TemplateVersion), sheet: sheet.name, values, evidence };
}

function workbookInstructions(workbookIR: WorkbookIR): WorkbookInstruction[] {
  return workbookIR.sheets
    .filter((sheet) => INSTRUCTION_SHEET_HINT.test(sheet.name))
    .flatMap((sheet) => Array.from(groupCellsByRow(sheet.cells).entries()))
    .map(([row, cells], index): WorkbookInstruction | undefined => {
      const text = cells.map((cell) => cell.formatted).filter(Boolean).join(' — ').trim();
      if (!text || text.length < 8) return undefined;
      return {
        instructionId: `instruction:${index + 1}`,
        text: text.slice(0, 500),
        source: cells.map(sourceOf),
      };
    })
    .filter((entry): entry is WorkbookInstruction => Boolean(entry));
}

function semanticPolicies(workbookIR: WorkbookIR, metadata: ReturnType<typeof readTemplateMetadata>): SemanticPolicy[] {
  const policies: SemanticPolicy[] = [];
  const addPolicy = (field: string, value: string, source: SemanticSourceRef[], reason: string) => {
    policies.push({ policyId: `policy:${policies.length + 1}`, field, value, sourceType: 'WORKBOOK_POLICY', source, reason });
  };

  for (const [key, field] of [
    ['ScenariosSheet', 'template.scenariosSheet'],
    ['WorkloadsSheet', 'template.workloadsSheet'],
    ['UsageSheet', 'template.usageSheet'],
    ['ArchitectureSheet', 'template.architectureSheet'],
    ['AssumptionsSheet', 'template.assumptionsSheet'],
  ] as const) {
    if (metadata.values[key]) addPolicy(field, metadata.values[key], metadata.evidence, `${key} from ${TEMPLATE_METADATA_SHEET}`);
  }

  for (const sheet of workbookIR.sheets.filter((entry) => ASSUMPTION_SHEET_HINT.test(entry.name))) {
    for (const cells of groupCellsByRow(sheet.cells).values()) {
      const label = cells[0]?.formatted?.trim();
      const value = cells.slice(1).map((cell) => cell.formatted).filter(Boolean).join(' ').trim();
      if (!label || !value) continue;
      addPolicy(label, value, cells.map(sourceOf), `Workbook policy from ${sheet.name}`);
    }
  }
  return policies;
}

function semanticEnvironments(rows: CanonicalRow[], resources: CalculationResource[]): SemanticEnvironment[] {
  const seen = new Map<string, SemanticEnvironment>();
  for (const row of rows) {
    if (!row.environment) continue;
    const key = row.environment.trim().toLowerCase();
    if (!seen.has(key)) seen.set(key, {
      environmentId: `environment:${slug(row.environment)}`,
      name: row.environment,
      source: row.provenance.map(sourceOfCanonical),
    });
  }
  for (const resource of resources) {
    if (!resource.environment) continue;
    const key = resource.environment.trim().toLowerCase();
    if (!seen.has(key)) seen.set(key, {
      environmentId: `environment:${slug(resource.environment)}`,
      name: resource.environment,
      source: [{ sheet: resource.sheet, row: resource.row, label: 'environment', value: resource.environment }],
    });
  }
  return [...seen.values()];
}

function semanticPeriods(workbookIR: WorkbookIR, scenarios: CanonicalScenario[]): SemanticPeriod[] {
  const periods = new Map<string, SemanticPeriod>();
  for (const scenario of scenarios) {
    if (!PERIOD_VALUE.test(scenario.label)) continue;
    periods.set(scenario.key, { periodId: `period:${slug(scenario.key)}`, label: scenario.label, source: [] });
  }
  for (const sheet of workbookIR.sheets) {
    if (!/(scenario|period|usage)/i.test(sheet.name)) continue;
    for (const cell of sheet.cells) {
      if (!PERIOD_VALUE.test(cell.formatted)) continue;
      const key = cell.formatted.trim().toLowerCase();
      if (!periods.has(key)) periods.set(key, { periodId: `period:${slug(cell.formatted)}`, label: cell.formatted, source: [sourceOf(cell)] });
    }
  }
  return [...periods.values()];
}

function semanticScenarios(canonicalScenarios: CanonicalScenario[], requestedPlan?: EstimatePlan): SemanticScenario[] {
  const scenarios = canonicalScenarios.map((scenario): SemanticScenario => ({
    scenarioId: `scenario:${slug(scenario.key)}`,
    label: scenario.label,
    kind: scenario.kind,
    source: [],
  }));
  const requested = requestedPlan?.scenarios || [];
  for (const band of requested) {
    const id = `scenario:${slug(band.label)}`;
    if (scenarios.some((scenario) => scenario.scenarioId === id)) continue;
    scenarios.push({ scenarioId: id, label: band.label, kind: 'pricing', source: [] });
  }
  return scenarios;
}

function semanticResource(row: CanonicalRow, scenarios: CanonicalScenario[], index: number): SemanticResource {
  const scenarioId = row.scenario ? `scenario:${slug(row.scenario.key)}` : undefined;
  return {
    resourceId: row.id || `resource:${index + 1}`,
    label: row.label,
    service: row.service,
    scenarioId: scenarioId && scenarios.some((scenario) => `scenario:${slug(scenario.key)}` === scenarioId) ? scenarioId : undefined,
    environmentId: row.environment ? `environment:${slug(row.environment)}` : undefined,
    region: row.region,
    shape: row.shape ? {
      size: row.shape.size,
      os: row.shape.os,
      purchaseModel: row.shape.purchaseModel,
      count: row.shape.count,
      vcpu: row.shape.vcpu,
      ramGb: row.shape.ramGb,
    } : undefined,
    quantities: row.quantities.map((quantity) => semanticQuantity(quantity, row)),
    attributes: row.attributes.map((attribute) => ({
      label: attribute.label,
      value: attribute.value,
      source: row.provenance.filter((source) => source.label === attribute.label).map(sourceOfCanonical),
    })),
    assumptions: row.quantities.flatMap((quantity) => quantity.conversions.filter((conversion) => /default|assum/i.test(conversion))),
    unresolved: row.unpriced.map((cell) => cell.reason),
    source: row.provenance.map(sourceOfCanonical),
  };
}

function semanticQuantity(quantity: CanonicalQuantity, row: CanonicalRow): SemanticQuantity {
  return {
    field: quantity.basis,
    value: quantity.amount,
    unit: quantity.unit,
    original: {
      value: quantity.originalValue,
      unit: quantity.originalUnit,
      period: quantity.originalPeriod,
      scale: quantity.originalScale,
    },
    derived: {
      value: quantity.derivedValue,
      unit: quantity.derivedUnit,
      period: quantity.derivedPeriod,
      scale: quantity.derivedScale,
    },
    conversionFormula: quantity.conversionFormula,
    conversions: quantity.conversions,
    resolutionType: quantity.conversions.length ? 'DERIVED' : 'WORKBOOK',
    source: row.provenance.map(sourceOfCanonical),
  };
}

function semanticArchitecture(workbookIR: WorkbookIR): SemanticArchitecture[] {
  const items: SemanticArchitecture[] = [];
  for (const sheet of workbookIR.sheets.filter((entry) => ARCHITECTURE_SHEET_HINT.test(entry.name))) {
    for (const cells of groupCellsByRow(sheet.cells).values()) {
      const text = cells.map((cell) => cell.formatted).filter(Boolean).join(' — ').trim();
      if (!text || text.length < 4) continue;
      items.push({ architectureId: `architecture:${items.length + 1}`, text: text.slice(0, 500), source: cells.map(sourceOf) });
    }
  }
  return items;
}

function semanticAssumptions(input: BuildWorkbookSemanticInput): SemanticAssumption[] {
  const assumptions: SemanticAssumption[] = [];
  for (const fact of input.insights?.facts || []) {
    assumptions.push({
      assumptionId: `assumption:${assumptions.length + 1}`,
      text: `${fact.label}: ${fact.value}`.slice(0, 500),
      sourceType: 'WORKBOOK',
      source: [{ sheet: fact.sheet, label: fact.label, value: String(fact.value) }],
    });
  }
  for (const conversion of input.canonicalModel.conversions) {
    assumptions.push({
      assumptionId: `assumption:${assumptions.length + 1}`,
      text: conversion.slice(0, 500),
      sourceType: /default|assum/i.test(conversion) ? 'AI_ASSUMPTION' : 'DERIVED',
      source: [],
    });
  }
  return assumptions;
}

function semanticNonAwsItems(workbookIR: WorkbookIR, exclusions: CanonicalExclusion[]): SemanticItem[] {
  const items: SemanticItem[] = exclusions.map((entry, index) => ({
    itemId: `non-aws:${index + 1}`,
    label: entry.label,
    reason: entry.reason,
    source: entry.provenance.map(sourceOfCanonical),
  }));
  for (const sheet of workbookIR.sheets.filter((entry) => NON_AWS_SHEET_HINT.test(entry.name))) {
    for (const cells of groupCellsByRow(sheet.cells).values()) {
      const text = cells.map((cell) => cell.formatted).filter(Boolean).join(' — ').trim();
      if (!text || text.length < 4) continue;
      items.push({ itemId: `non-aws:${items.length + 1}`, label: text.slice(0, 300), source: cells.map(sourceOf) });
    }
  }
  return items;
}

function semanticUncertainties(canonicalModel: CanonicalWorkbook): SemanticUncertainty[] {
  return canonicalModel.rows.flatMap((row) => row.unpriced.map((cell, index): SemanticUncertainty => ({
    uncertaintyId: `${row.id}:unresolved:${index + 1}`,
    field: cell.provenance.label,
    message: cell.reason,
    materiality: materialityFor(row, cell.reason),
    source: [sourceOfCanonical(cell.provenance)],
  })));
}

function materialityFor(row: CanonicalRow, reason: string): SemanticUncertainty['materiality'] {
  const text = `${row.service || ''} ${row.billing} ${reason}`.toLowerCase();
  if (/count|quantity|vcpu|memory|ram|storage|duration|runtime|multi-az|region/.test(text)) return 'HIGH';
  if (/rate|price|period|usage/.test(text)) return 'MEDIUM';
  return 'LOW';
}

function groupCellsByRow(cells: CellIR[]): Map<number, CellIR[]> {
  const rows = new Map<number, CellIR[]>();
  for (const cell of cells) {
    const group = rows.get(cell.row) || [];
    group.push(cell);
    rows.set(cell.row, group);
  }
  for (const group of rows.values()) group.sort((left, right) => left.col - right.col);
  return rows;
}

function sourceOf(cell: CellIR): SemanticSourceRef {
  return {
    sheet: cell.sheet,
    row: cell.row,
    col: cell.col,
    a1: cell.a1,
    label: cell.a1,
    value: cell.formatted,
  };
}

function sourceOfCanonical(source: { sheet?: string; row?: number; label: string; value: string }): SemanticSourceRef {
  return {
    sheet: source.sheet,
    row: source.row,
    label: source.label,
    value: source.value,
  };
}

function sameSource(left: SemanticSourceRef[], right: SemanticSourceRef): boolean {
  return left.some((candidate) => (
    candidate.sheet === right.sheet
    && candidate.row === right.row
    && (!right.label || candidate.label === right.label)
  ));
}

function slug(value: string): string {
  return String(value || 'default')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'default';
}
