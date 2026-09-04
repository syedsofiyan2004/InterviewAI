import type { McpToolResult } from './mcp-client';

export interface CalculatorCatalogField {
  id: string;
  type: string;
  label?: string;
  options?: Array<{ id: string; label?: string; value?: string }>;
  /** Accepted unit tokens for fileSize / durationInput fields. */
  validSizes?: string[];
  defaultUnit?: string;
  /** Column cells for columnFormIPM fields. */
  row?: Array<{ label?: string; selectorId?: string; type?: string }>;
  selectorValues?: Record<string, string[]>;
  defaultValue?: unknown;
  minValue?: number;
  maxValue?: number;
  helpText?: string;
  _synthetic?: boolean;
  [key: string]: unknown;
}

export interface CatalogRequiredField {
  field: string;
  hint?: string;
  example?: unknown;
  shape?: string;
  enum?: string[];
  default?: unknown;
}

export interface CatalogSubService {
  serviceCode: string;
  estimateFor?: string;
  required?: CatalogRequiredField[];
}

/**
 * The parsed representation of a get_service_fields response.
 *
 * The upstream MCP returns:
 *   { serviceCode, serviceName, fields, catalog: { status, templateId,
 *     required, traps, subServices, minimalConfig, lastVerifiedAt } }
 *
 * The catalog block is what MIMO must use as the authoritative source for
 * Calculator configuration shapes, defaults and required-field rules.
 * Do NOT read minimalConfig / traps / required from the top level —
 * they are only present under catalog.
 */
export interface CalculatorServiceCatalog {
  serviceCode: string;
  serviceName: string;
  fields: CalculatorCatalogField[];

  // ---------------------------------------------------------------------------
  // Catalog intelligence — all sourced from parsed.catalog.* (not top level).
  // ---------------------------------------------------------------------------

  /** MCP verification status, e.g. "verified". */
  catalogStatus?: string;
  /** The Calculator-internal template this service maps to. */
  templateId?: string;
  /**
   * Fields the Calculator requires to accept the estimate.
   * These must be supplied; missing them causes lint/grounding errors.
   */
  required?: CatalogRequiredField[];
  /**
   * Known Calculator traps: undocumented constraints, required-but-hidden fields,
   * widget behaviours that deviate from the documented schema.
   */
  traps?: string[];
  /**
   * Sub-services within a parent service (e.g. SageMaker sub-services).
   * Each has its own required fields and minimalConfig key.
   */
  subServices?: CatalogSubService[];
  /**
   * A working minimal configuration the Calculator accepts.
   * Use this as the baseline, then overlay workbook/user values.
   * Critically: for sub-services (e.g. SageMaker real-time inference),
   * the parent's minimalConfig is keyed by child serviceCode.
   */
  minimalConfig?: Record<string, unknown>;
  /** When the MCP catalog was last verified against the live Calculator. */
  lastVerifiedAt?: string;
}

/**
 * Parse a get_service_fields MCP response into a usable catalog.
 *
 * Reads catalog intelligence from parsed.catalog.*, NOT from the top-level
 * object. This was the source of a critical bug where every Calculator
 * configuration hint was silently discarded.
 */
export function parseServiceCatalog(result: McpToolResult): CalculatorServiceCatalog {
  if (result.isError) throw new Error(`CATALOG_LOOKUP_FAILED: ${result.text.slice(0, 300)}`);
  const parsed = JSON.parse(result.text);
  if (!parsed?.serviceCode || !Array.isArray(parsed.fields)) throw new Error('CATALOG_RESPONSE_INVALID');

  // The catalog block is where all MCP intelligence lives.
  const catalog: Record<string, unknown> = (parsed.catalog && typeof parsed.catalog === 'object')
    ? parsed.catalog as Record<string, unknown>
    : {};

  return {
    serviceCode: String(parsed.serviceCode),
    serviceName: String(parsed.serviceName || parsed.serviceCode),
    fields: parsed.fields as CalculatorCatalogField[],

    // Catalog intelligence — sourced from parsed.catalog.* only.
    ...(catalog.status ? { catalogStatus: String(catalog.status) } : {}),
    ...(catalog.templateId ? { templateId: String(catalog.templateId) } : {}),
    ...(Array.isArray(catalog.required) ? { required: catalog.required as CatalogRequiredField[] } : {}),
    ...(Array.isArray(catalog.traps) ? { traps: (catalog.traps as unknown[]).map(String) } : {}),
    ...(Array.isArray(catalog.subServices) ? { subServices: catalog.subServices as CatalogSubService[] } : {}),
    ...(catalog.minimalConfig && typeof catalog.minimalConfig === 'object'
      ? { minimalConfig: catalog.minimalConfig as Record<string, unknown> }
      : {}),
    ...(catalog.lastVerifiedAt ? { lastVerifiedAt: String(catalog.lastVerifiedAt) } : {}),
  };
}

/**
 * Selects the minimal configuration for a specific service or sub-service.
 *
 * For parent services (e.g. amazonSageMaker), minimalConfig is keyed by child
 * serviceCode (e.g. "sageMakerRealTimeInference"). For simple services the whole
 * minimalConfig is the working config.
 *
 * This pattern must handle any future MCP parent/sub-service relationship —
 * do not hardcode service names here.
 */
export function selectMinimalConfig(
  catalog: CalculatorServiceCatalog,
  serviceCode?: string,
): Record<string, unknown> {
  const mc = catalog.minimalConfig || {};
  if (!serviceCode) return mc;
  // If minimalConfig has a key matching the child serviceCode, it is the
  // sub-service config. Otherwise the whole minimalConfig is for this service.
  const sub = mc[serviceCode];
  if (sub && typeof sub === 'object' && !Array.isArray(sub)) {
    return sub as Record<string, unknown>;
  }
  return mc;
}

/**
 * Returns the required fields for a child service within a parent catalog.
 *
 * SageMaker proves why this is needed: the parent catalog lists sub-services,
 * each with their own required fields. Without reading them, MIMO cannot know
 * what fields sageMakerRealTimeInference needs.
 */
export function requiredForSubService(
  catalog: CalculatorServiceCatalog,
  childServiceCode: string,
): CatalogRequiredField[] {
  const sub = (catalog.subServices || []).find((s) => s.serviceCode === childServiceCode);
  if (sub?.required?.length) return sub.required;
  return catalog.required || [];
}

function isValueUnit(value: unknown): boolean {
  return Boolean(value && typeof value === 'object'
    && 'value' in (value as Record<string, unknown>)
    && typeof (value as Record<string, unknown>).unit === 'string');
}

function optionKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Merges minimalConfig defaults with user config, resolving semantic dropdown labels
 * to the live opaque Calculator option IDs.
 *
 * Order: minimalConfig (base) → user config (overrides).
 * The "defaultConfig" concept is removed — minimalConfig is the canonical source.
 */
export function resolveConfigAgainstCatalog(
  catalog: CalculatorServiceCatalog,
  config: Record<string, unknown>,
  childServiceCode?: string,
): Record<string, unknown> {
  const base = selectMinimalConfig(catalog, childServiceCode);
  const resolved = { ...base, ...config };
  for (const field of catalog.fields) {
    if (field.type !== 'dropdown' || !field.options?.length || resolved[field.id] === undefined) continue;
    const current = resolved[field.id];
    const direct = field.options.find((option) => String(option.id) === String(current));
    if (direct) continue;
    const byLabel = field.options.find((option) => optionKey(option.label) === optionKey(current));
    if (byLabel) resolved[field.id] = byLabel.id;
  }
  return resolved;
}

/** Rejects compiler drift before any estimate is sent to AWS Calculator. */
export function validateConfigAgainstCatalog(
  catalog: CalculatorServiceCatalog,
  config: Record<string, unknown>,
): string[] {
  const byId = new Map(catalog.fields.map((field) => [field.id, field]));
  const hiddenCompilerFields = new Set(['pricingStrategy', 'utilization']);
  const errors: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (key === 'region' || key === 'description' || hiddenCompilerFields.has(key)) continue;
    const field = byId.get(key);
    if (!field) {
      errors.push(`${catalog.serviceCode}: field ${key} is not present in the live Calculator catalog.`);
      continue;
    }
    if (['fileSize', 'frequency', 'durationInput', 'throughput'].includes(field.type) && !isValueUnit(value)) {
      errors.push(`${catalog.serviceCode}.${key} must use the live catalog's { value, unit } shape.`);
    }
    if (field.type === 'columnFormIPM'
      && (!value || typeof value !== 'object' || !Array.isArray((value as any).value))) {
      errors.push(`${catalog.serviceCode}.${key} must use { value: [row] }.`);
    }
    if (field.type === 'dropdown' && field.options?.length) {
      const allowed = new Set(field.options.map((entry) => String(entry.id)));
      if (!allowed.has(String(value))) errors.push(`${catalog.serviceCode}.${key} is not a current catalog option.`);
    }
  }
  return errors;
}
