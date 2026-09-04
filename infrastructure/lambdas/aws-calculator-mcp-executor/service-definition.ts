/**
 * AWS Pricing Calculator service definition reader — executor-local copy.
 *
 * The executor must be independently testable using only CanonicalWorkloadIR and
 * McpGateway. This module duplicates the definition-fetching logic from
 * calculator-orchestrator/calculator-definitions.ts so the executor package has
 * zero imports from MIMO parent modules.
 *
 * It exists for ONE narrow purpose: validating durationInput unit tokens.
 * The Calculator CDN publishes unit token lists (e.g. ["sec","min","hr","day"]) that
 * get_service_fields does NOT expose. Without this, 730 hours could be sent with unit
 * "hours" and silently rehydrated as "minutes" — a 60× mispricing with no error.
 *
 * Everything else (field IDs, required fields, minimalConfig) comes from the live
 * MCP via get_service_fields. This module is strictly a unit-token safety net.
 */

const CDN_BASE = process.env.CALCULATOR_CDN_BASE || 'https://d1qsjq9pzbk1k6.cloudfront.net';
const MANIFEST_PATH = '/manifest/en_US.json';
const FETCH_TIMEOUT_MS = 8_000;

export interface DefinitionComponent {
  id?: string;
  type?: string;
  subType?: string;
  label?: string;
  defaultValue?: unknown;
  dropDownDuration?: Array<{ label?: string; value?: string }>;
  defaultDuration?: string;
  dropDownSize?: Array<{ label?: string; id?: string; value?: string }>;
  defaultOption?: { size?: string; frequency?: string };
  validSizes?: string[];
  defaultUnit?: string;
  validations?: { required?: boolean; minValue?: number; maxValue?: number; allowDecimals?: boolean };
  [key: string]: unknown;
}

/** A parsed service definition — just the components that carry input constraints. */
export interface ServiceDefinition {
  serviceCode: string;
  components: DefinitionComponent[];
}

export type UnitResolution =
  | { ok: true; token: string }
  | { ok: true; token: undefined; dimensionless: true }
  | { ok: false; reason: string; validTokens: string[] };

const definitionCache = new Map<string, ServiceDefinition | undefined>();
let manifestCache: Map<string, string> | undefined;

async function getJson(url: string): Promise<unknown> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) { console.warn(`[service-definition] ${url} answered ${response.status}`); return undefined; }
    return await response.json();
  } catch (error) {
    console.warn(`[service-definition] ${url} failed: ${(error as Error).message}`);
    return undefined;
  }
}

async function getManifest(): Promise<Map<string, string>> {
  if (manifestCache) return manifestCache;
  const map = new Map<string, string>();
  const payload = await getJson(`${CDN_BASE}${MANIFEST_PATH}`);
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { for (const item of node) visit(item); return; }
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    const code = typeof record.serviceCode === 'string' ? record.serviceCode : undefined;
    const location = typeof record.serviceDefinitionLocation === 'string'
      ? record.serviceDefinitionLocation
      : typeof record.serviceDefinitionUrlPath === 'string'
        ? `${CDN_BASE}${record.serviceDefinitionUrlPath}`
        : undefined;
    if (code && location) map.set(code, location);
    for (const value of Object.values(record)) visit(value);
  };
  visit(payload);
  manifestCache = map;
  return map;
}

function flattenComponents(node: unknown, into: DefinitionComponent[] = []): DefinitionComponent[] {
  if (Array.isArray(node)) { for (const item of node) flattenComponents(item, into); return into; }
  if (!node || typeof node !== 'object') return into;
  const record = node as Record<string, unknown>;
  if (typeof record.id === 'string' && (record.type === 'input' || typeof record.subType === 'string')) {
    into.push(record as DefinitionComponent);
  }
  for (const value of Object.values(record)) flattenComponents(value, into);
  return into;
}

export function parseDefinition(serviceCode: string, payload: unknown): ServiceDefinition {
  return { serviceCode, components: flattenComponents(payload) };
}

export async function fetchServiceDefinition(serviceCode: string): Promise<ServiceDefinition | undefined> {
  if (definitionCache.has(serviceCode)) return definitionCache.get(serviceCode);
  const located = (await getManifest()).get(serviceCode);
  const url = located || `${CDN_BASE}/data/${serviceCode}/en_US.json`;
  const payload = await getJson(url);
  const definition = payload ? parseDefinition(serviceCode, payload) : undefined;
  definitionCache.set(serviceCode, definition);
  return definition;
}

/**
 * Resolves a semantic unit word to the token this durationInput field accepts.
 * Returns ok:false when the unit word is unknown so the executor can refuse rather
 * than silently default to a wrong unit.
 */
export function resolveUnitToken(
  definition: ServiceDefinition | undefined,
  fieldId: string,
  unitWord: string,
): UnitResolution {
  const component = definition?.components.find((c) => c.id === fieldId);
  if (!component) return { ok: false, reason: `field ${fieldId} not found in service definition`, validTokens: [] };

  if (component.dropDownDuration?.length) {
    const tokens = component.dropDownDuration.map((d) => d.value).filter((v): v is string => Boolean(v));
    const norm = unitWord.trim().toLowerCase().replace(/s$/, '');
    const hit = component.dropDownDuration.find(
      (d) => d.value === unitWord
        || d.label?.toLowerCase().replace(/s$/, '') === norm
        || d.value?.toLowerCase().replace(/s$/, '') === norm,
    );
    if (!hit?.value) return { ok: false, reason: `unit "${unitWord}" is not accepted by "${fieldId}"`, validTokens: tokens };
    return { ok: true, token: hit.value };
  }
  if (component.dropDownSize?.length || component.validSizes?.length) {
    return { ok: true, token: undefined, dimensionless: true };
  }
  return { ok: true, token: undefined, dimensionless: true };
}

export function validateValue(
  definition: ServiceDefinition | undefined,
  fieldId: string,
  value: number,
): { ok: true } | { ok: false; reason: string } {
  const component = definition?.components.find((c) => c.id === fieldId);
  if (!component?.validations) return { ok: true };
  const { minValue, maxValue } = component.validations;
  if (minValue !== undefined && value < minValue) return { ok: false, reason: `${fieldId} value ${value} is below minimum ${minValue}` };
  if (maxValue !== undefined && value > maxValue) return { ok: false, reason: `${fieldId} value ${value} exceeds maximum ${maxValue}` };
  return { ok: true };
}
