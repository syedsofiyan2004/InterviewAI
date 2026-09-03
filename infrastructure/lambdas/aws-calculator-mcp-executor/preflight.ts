/**
 * Semantic preflight against the live Calculator schema, before anything is executed.
 *
 * The executor's mapper already knows, for every resource, which Calculator inputs the
 * resource does not supply. Preflight runs that mapping WITHOUT touching an estimate and turns
 * each gap into a typed question a Review page can render: a dropdown when the schema lists
 * the choices, a searchable list when it lists many (instance classes), a number with a unit
 * when the field is a quantity. Every option offered comes from `get_service_fields` for the
 * service the resource resolved to — never from a list kept in MIMO — and a safe recommendation
 * is labelled with where it came from.
 *
 * What it will not do is guess a quantity. A count, a duration or a size the customer did not
 * state is asked for; the only values pre-filled are the Calculator's own defaults for choices
 * (labelled "AWS default") and values the workbook stated (labelled "Detected from workbook").
 */

import { fetchServiceDefinition, type ServiceDefinition } from '../calculator-orchestrator/calculator-definitions';
import { mapDeterministically } from './field-mapping';
import type { McpField, McpFieldsPayload } from './mcp-schema';
import { resolvePricing } from './pricing-intent';
import { resolveService, type ResolutionContext } from './service-resolution';
import { discoverTools, missingEssentialTools } from './tool-discovery';
import type { ExecutorInput, McpGateway, SemanticResource } from './types';

export type PreflightControl = 'dropdown' | 'searchable' | 'number' | 'toggle' | 'text';

export interface PreflightQuestion {
  resourceId: string;
  service: string;
  serviceCode?: string;
  /** The Calculator's own label for the input, as the customer will see it. */
  label: string;
  /** The Calculator field or column-form cell the answer will populate. */
  target: string;
  control: PreflightControl;
  /** For dropdown/searchable: the choices the schema lists. */
  options?: Array<{ id: string; label: string }>;
  /** For number: the unit choices the schema lists (frequency periods, size units). */
  units?: Array<{ id: string; label: string }>;
  minValue?: number;
  maxValue?: number;
  /** A value it is safe to preselect, and where it came from. */
  recommended?: { value: unknown; source: 'Detected from workbook' | 'Recommended' | 'AWS default' };
  impact: 'high' | 'medium';
}

export interface PreflightResourceReport {
  resourceId: string;
  service: string;
  serviceCode?: string;
  ready: boolean;
  /** How the resource would be mapped: by code alone, or needing a model. */
  mapping: 'deterministic' | 'needs-model' | 'blocked';
  questions: PreflightQuestion[];
  notes: string[];
}

export interface PreflightReport {
  mcpVersion?: string;
  resources: PreflightResourceReport[];
  /** Every question across resources, high impact first. */
  questions: PreflightQuestion[];
  ready: boolean;
}

export interface PreflightOptions {
  fetchDefinition?: (serviceCode: string) => Promise<ServiceDefinition | undefined>;
  /** Wall-clock budget; resources not reached in time are reported as unchecked. */
  budgetMs?: number;
}

const optionList = (options: McpField['options']) => (options || [])
  .map((option) => ({ id: String(option.id ?? option.value ?? ''), label: String(option.label ?? option.id ?? option.value ?? '') }))
  .filter((option) => option.id);

/** The control a Calculator field type calls for. */
function controlFor(field: McpField | undefined, cellAllowed?: string[]): Pick<PreflightQuestion, 'control' | 'options' | 'units' | 'minValue' | 'maxValue'> {
  if (cellAllowed?.length) {
    const options = cellAllowed.map((value) => ({ id: value, label: value }));
    return { control: options.length > 12 ? 'searchable' : 'dropdown', options };
  }
  if (!field) return { control: 'text' };
  switch (field.type) {
    case 'dropdown': {
      const options = optionList(field.options);
      return { control: options.length > 12 ? 'searchable' : 'dropdown', options };
    }
    case 'checkbox': return { control: 'toggle' };
    case 'frequency': return { control: 'number', units: optionList(field.options), minValue: field.minValue, maxValue: field.maxValue };
    case 'fileSize': return { control: 'number', units: (field.validSizes || []).map((size) => ({ id: size, label: size.toUpperCase() })), minValue: field.minValue, maxValue: field.maxValue };
    case 'durationInput': return { control: 'number', units: ['sec', 'min', 'hr', 'day'].map((unit) => ({ id: unit, label: unit })), minValue: field.minValue, maxValue: field.maxValue };
    case 'ec2InstanceSearch':
    case 'autoSuggest': return { control: 'searchable' };
    case 'numericInput':
    case 'workload':
    case 'throughput': return { control: 'number', minValue: field.minValue, maxValue: field.maxValue };
    default: return { control: 'text' };
  }
}

/**
 * The field (or column-form cell) behind a missing-input label the mapper produced.
 *
 * Labels are what the mapper reports because they are what a person reads; the schema is
 * searched for the field carrying that label so the question can offer that field's choices.
 */
function locate(payload: McpFieldsPayload, label: string): { field?: McpField; target: string; cellAllowed?: string[] } {
  const plainLabel = label.replace(/\s*\(one of:.*\)$/, '').trim();
  const field = (payload.fields || []).find((entry) => (entry.label || '').trim() === plainLabel || entry.id === plainLabel);
  if (field) return { field, target: field.id };
  for (const form of (payload.fields || []).filter((entry) => entry.type === 'columnFormIPM')) {
    const cell = (form.row || []).find((entry) => (entry.label || '').trim() === plainLabel || entry.selectorId === plainLabel);
    if (cell) {
      const key = cell.selectorId || cell.label || '';
      return { target: `${form.id}.${key}`, cellAllowed: cell.selectorId ? form.selectorValues?.[cell.selectorId] : undefined };
    }
  }
  return { target: plainLabel };
}

export async function preflightScenario(input: ExecutorInput, gateway: McpGateway, options: PreflightOptions = {}): Promise<PreflightReport> {
  const startedAt = Date.now();
  const budget = options.budgetMs ?? 20_000;
  const fetchDefinition = options.fetchDefinition ?? fetchServiceDefinition;
  const tools = await discoverTools(gateway);
  const missingTools = missingEssentialTools(tools);
  const reports: PreflightResourceReport[] = [];
  if (missingTools.length) {
    return { mcpVersion: tools.mcpVersion, resources: [], questions: [], ready: false };
  }
  const ctx: ResolutionContext = {
    gateway, tools, record: () => undefined, searchCache: new Map(), fieldsCache: new Map(),
  };
  const definitions = new Map<string, Promise<ServiceDefinition | undefined>>();

  for (const resource of input.resources) {
    if (Date.now() - startedAt > budget) {
      reports.push({ resourceId: resource.resourceId, service: resource.service, ready: false, mapping: 'blocked', questions: [], notes: ['not checked: preflight time budget exhausted'] });
      continue;
    }
    const resolved = await resolveService(ctx, resource).catch((error: Error) => ({ error: error.message }));
    if ('error' in resolved) {
      reports.push({ resourceId: resource.resourceId, service: resource.service, ready: false, mapping: 'blocked', questions: [], notes: [resolved.error] });
      continue;
    }
    if (!definitions.has(resolved.serviceCode)) definitions.set(resolved.serviceCode, fetchDefinition(resolved.serviceCode).catch(() => undefined));
    const definition = await definitions.get(resolved.serviceCode);
    const intent = resource.pricing ?? input.pricing;
    const first = mapDeterministically(resource, resolved.payload, definition, resolvePricing(resolved.payload, resource, intent));
    const mapping = mapDeterministically(resource, resolved.payload, definition, resolvePricing(resolved.payload, resource, intent, first.columnForm));
    const questions = mapping.missingInputs.map((label): PreflightQuestion => {
      const where = locate(resolved.payload, label);
      const control = controlFor(where.field, where.cellAllowed);
      const minimal = resolved.payload.catalog?.minimalConfig || {};
      const awsDefault = where.field && where.field.id in minimal && (where.field.type === 'dropdown' || where.field.type === 'checkbox')
        ? minimal[where.field.id]
        : undefined;
      return {
        resourceId: resource.resourceId,
        service: resource.service,
        serviceCode: resolved.serviceCode,
        label: label.replace(/\s*\(one of:.*\)$/, '').trim(),
        target: where.target,
        ...control,
        ...(awsDefault !== undefined ? { recommended: { value: awsDefault, source: 'AWS default' } } : {}),
        impact: 'high',
      };
    });
    reports.push({
      resourceId: resource.resourceId,
      service: resource.service,
      serviceCode: resolved.serviceCode,
      ready: mapping.missingInputs.length === 0,
      mapping: mapping.confident ? 'deterministic' : mapping.missingInputs.length ? 'blocked' : 'needs-model',
      questions,
      notes: [...resolved.notes, ...mapping.notes, ...(mapping.unmapped.length ? [`a model will place: ${mapping.unmapped.join(', ')}`] : [])],
    });
  }
  const questions = reports.flatMap((report) => report.questions);
  return { mcpVersion: tools.mcpVersion, resources: reports, questions, ready: reports.every((report) => report.ready) };
}

/** Semantic resources from any caller, for a preflight that has no scenario yet. */
export const preflightResources = (resources: SemanticResource[], gateway: McpGateway, options?: PreflightOptions) => preflightScenario(
  { scenarioId: 'preflight', estimateName: 'preflight', pricing: { kind: 'on-demand', upfrontPayment: 'None' }, resources },
  gateway,
  options,
);
