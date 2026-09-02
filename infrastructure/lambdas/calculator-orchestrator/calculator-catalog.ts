import type { McpToolResult } from './mcp-client';

export interface CalculatorCatalogField {
  id: string;
  type: string;
  options?: Array<{ id: string; label?: string }>;
}

export interface CalculatorServiceCatalog {
  serviceCode: string;
  serviceName: string;
  fields: CalculatorCatalogField[];
  minimalConfig?: Record<string, unknown>;
  defaultConfig?: Record<string, unknown>;
  traps?: string[];
  warnings?: string[];
  schemaVersion?: string;
  schemaHash?: string;
}

export function parseServiceCatalog(result: McpToolResult): CalculatorServiceCatalog {
  if (result.isError) throw new Error(`CATALOG_LOOKUP_FAILED: ${result.text.slice(0, 300)}`);
  const parsed = JSON.parse(result.text);
  if (!parsed?.serviceCode || !Array.isArray(parsed.fields)) throw new Error('CATALOG_RESPONSE_INVALID');
  return {
    serviceCode: String(parsed.serviceCode),
    serviceName: String(parsed.serviceName || parsed.serviceCode),
    fields: parsed.fields,
    ...(parsed.minimalConfig && typeof parsed.minimalConfig === 'object' ? { minimalConfig: parsed.minimalConfig } : {}),
    ...(parsed.defaultConfig && typeof parsed.defaultConfig === 'object' ? { defaultConfig: parsed.defaultConfig } : {}),
    ...(Array.isArray(parsed.traps) ? { traps: parsed.traps.map(String) } : {}),
    ...(Array.isArray(parsed.warnings) ? { warnings: parsed.warnings.map(String) } : {}),
    ...(parsed.schemaVersion ? { schemaVersion: String(parsed.schemaVersion) } : {}),
    ...(parsed.schemaHash ? { schemaHash: String(parsed.schemaHash) } : {}),
  };
}

function isValueUnit(value: unknown): boolean {
  return Boolean(value && typeof value === 'object'
    && 'value' in (value as Record<string, unknown>)
    && typeof (value as Record<string, unknown>).unit === 'string');
}

function optionKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Resolves semantic dropdown labels to the live opaque Calculator option IDs. */
export function resolveConfigAgainstCatalog(
  catalog: CalculatorServiceCatalog,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const resolved = { ...(catalog.defaultConfig || {}), ...(catalog.minimalConfig || {}), ...config };
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
