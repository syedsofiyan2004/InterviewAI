/**
 * The AWS Pricing Calculator's own service definitions — the authority `get_service_fields`
 * only partly exposes.
 *
 * Why this exists, concretely. The MCP's `get_service_fields` is the documented way to learn a
 * service's input schema, and for most field types it is enough. For a `durationInput` it is
 * not: it reports the field, its label, its default and its numeric range, and it omits the
 * list of unit tokens the field will accept. The calculator's definition carries them:
 *
 *   "dropDownDuration": [ {"label":"seconds","value":"sec"}, {"label":"minutes","value":"min"},
 *                         {"label":"hours","value":"hr"},    {"label":"days","value":"day"} ],
 *   "defaultDuration": "min"
 *
 * With that list invisible, a semantically correct `{value: "730", unit: "hours"}` was sent for
 * a Fargate task duration. Nothing rejected it. `add_service` accepted it, the static linter
 * passed it, the save API stored it verbatim, and the calculator rehydrated the field at its
 * own `defaultDuration` — so 730 hours was displayed and priced as 730 MINUTES. A month of
 * runtime became twelve hours: sixtyfold low, in a saved estimate that looked correct, with no
 * error raised at any layer. That is the failure this module exists to make impossible.
 *
 * The rule it enforces is therefore narrow and absolute: a unit is either resolved against the
 * definition's own token list, or it is refused. There is no default, no nearest match and no
 * pass-through. A default here is indistinguishable from the bug.
 *
 * Deliberate non-goals:
 *
 *  - It does not price and it does not save. It reads schema.
 *  - It does not replace `get_service_fields`. That tool carries the curated catalog hints and
 *    traps this one has no view of; the two are complementary and the operator uses both.
 *  - It does not evaluate `delegate` conditions. A delegate re-states validations when another
 *    field takes a particular value ("if operatingSystem is windows, minValue becomes 0.083"),
 *    and deciding which branch applies means re-implementing the calculator's own conditional
 *    engine. They are surfaced instead, so a caller can mark the field as needing verification
 *    rather than silently trusting the unconditional constraint.
 */

/** Where the calculator publishes its manifest and per-service definitions. */
const CDN_BASE = process.env.CALCULATOR_CDN_BASE || 'https://d1qsjq9pzbk1k6.cloudfront.net';
const MANIFEST_PATH = '/manifest/en_US.json';

/**
 * Timeout per fetch. Short on purpose: a definition that cannot be read must degrade to
 * "unknown" quickly rather than spend an estimate's whole budget on one service's schema.
 */
const FETCH_TIMEOUT_MS = 8_000;

/** One input component of a service definition, as the calculator publishes it. */
export interface DefinitionComponent {
  id?: string;
  type?: string;
  subType?: string;
  label?: string;
  defaultValue?: unknown;
  /** durationInput: the accepted unit tokens, each with the label the UI shows. */
  dropDownDuration?: Array<{ label?: string; value?: string }>;
  /** durationInput: the token the calculator falls back to. The cause of the 730 bug. */
  defaultDuration?: string;
  outputDurationUnit?: string;
  /** dropdown/radio: the selectable values. */
  dropDownOptions?: Array<{ label?: string; value?: string; id?: string }>;
  options?: Array<{ label?: string; value?: string; id?: string }>;
  /** fileSize: the size tokens it accepts, keyed by `id`. The definition's own field name. */
  dropDownSize?: Array<{ label?: string; id?: string; value?: string }>;
  /** fileSize: `{size, frequency}`, which compose into the "gb|NA" unit the API expects. */
  defaultOption?: { size?: string; frequency?: string };
  outputSize?: string;
  /** As `get_service_fields` normalises it. Present on MCP payloads, not on definitions. */
  validSizes?: string[];
  unitFormat?: string;
  defaultUnit?: string;
  validations?: {
    required?: boolean;
    minValue?: number;
    maxValue?: number;
    allowDecimals?: boolean;
  };
  /** Conditional re-statements of validations/defaults. Surfaced, never evaluated. */
  delegate?: unknown[];
  [key: string]: unknown;
}

/** A parsed service definition, flattened to the components that take input. */
export interface ServiceDefinition {
  serviceCode: string;
  components: DefinitionComponent[];
}

/** What is known about one field. `unknownField` distinguishes "no constraints" from "no data". */
export interface FieldConstraints {
  id: string;
  subType?: string;
  label?: string;
  required: boolean;
  /** Present only for fields that carry a unit dimension. */
  unitTokens?: string[];
  /** The token the calculator uses when none is given — never used as a fallback by us. */
  unitDefault?: string;
  /**
   * The frequency half of a fileSize unit. The API wants "<size>|<frequency>" as one string,
   * so a caller composing "gb" alone is refused at add time; this supplies the "NA".
   */
  unitFrequency?: string;
  /** Selectable values for a dropdown, as tokens. */
  options?: string[];
  minValue?: number;
  maxValue?: number;
  allowDecimals?: boolean;
  /**
   * True when the field carries `delegate` entries, so its effective constraint depends on
   * another field's value. The caller must treat such a field as needing verification rather
   * than assume the unconditional numbers above apply.
   */
  conditional: boolean;
}

/** Resolution of a semantic unit word against a field's accepted tokens. */
export type UnitResolution =
  | { ok: true; token: string }
  /** The field has no unit dimension at all, so there is nothing to send. */
  | { ok: true; token: undefined; dimensionless: true }
  | { ok: false; reason: string; validTokens: string[] };

const definitionCache = new Map<string, ServiceDefinition | undefined>();
let manifestCache: Map<string, string> | undefined;

/** One fetch with a timeout, returning undefined rather than throwing on any failure. */
async function getJson(url: string): Promise<unknown> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) {
      console.warn(`[calculator-definitions] ${url} answered ${response.status}`);
      return undefined;
    }
    return await response.json();
  } catch (error) {
    console.warn(`[calculator-definitions] ${url} failed: ${(error as Error).message}`);
    return undefined;
  }
}

/** Every string value under a key, at any depth. The manifest's nesting is not contractual. */
function collectStrings(node: unknown, key: string, into: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectStrings(item, key, into);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [name, value] of Object.entries(node as Record<string, unknown>)) {
      if (name === key && typeof value === 'string') into.push(value);
      else collectStrings(value, key, into);
    }
  }
}

/**
 * serviceCode to definition URL, read from the manifest.
 *
 * Built by walking rather than by a fixed path because the manifest groups services by
 * category and the grouping has changed shape before. A walk cannot be broken by re-nesting.
 */
async function manifest(): Promise<Map<string, string>> {
  if (manifestCache) return manifestCache;
  const map = new Map<string, string>();
  const payload = await getJson(`${CDN_BASE}${MANIFEST_PATH}`);
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
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

/**
 * Every input component of a definition, flattened.
 *
 * Recursive because components nest: the Fargate definition puts them at
 * `templates[].cards[].inputSection.components[]`, and other services add another level for
 * sub-services. Hard-coding the path would silently return nothing for the nested ones, and
 * "no components" reads exactly like "no constraints", which is the mistake this file exists
 * to prevent.
 */
export function flattenComponents(node: unknown, into: DefinitionComponent[] = []): DefinitionComponent[] {
  if (Array.isArray(node)) {
    for (const item of node) flattenComponents(item, into);
    return into;
  }
  if (!node || typeof node !== 'object') return into;
  const record = node as Record<string, unknown>;
  // A component is anything carrying an id and declaring itself an input. Both are required:
  // cards and sections also carry ids, and treating one as a field would invent constraints.
  if (typeof record.id === 'string' && (record.type === 'input' || typeof record.subType === 'string')) {
    into.push(record as DefinitionComponent);
  }
  for (const value of Object.values(record)) flattenComponents(value, into);
  return into;
}

/** Parses a raw definition payload. Exported so tests need no network. */
export function parseDefinition(serviceCode: string, payload: unknown): ServiceDefinition {
  return { serviceCode, components: flattenComponents(payload) };
}

/**
 * The definition for one service, cached for the life of the container.
 *
 * Returns undefined when it cannot be read. Callers must treat that as "constraints unknown"
 * and escalate to verification, never as "no constraints to check".
 */
export async function fetchServiceDefinition(serviceCode: string): Promise<ServiceDefinition | undefined> {
  if (definitionCache.has(serviceCode)) return definitionCache.get(serviceCode);
  const located = (await manifest()).get(serviceCode);
  const url = located || `${CDN_BASE}/data/${serviceCode}/en_US.json`;
  const payload = await getJson(url);
  const definition = payload ? parseDefinition(serviceCode, payload) : undefined;
  definitionCache.set(serviceCode, definition);
  return definition;
}

/**
 * Token list for a field's unit dimension, or undefined when it has none.
 *
 * Three shapes, because the definition and the MCP's normalisation of it disagree on names:
 * a durationInput lists `dropDownDuration` with `value` tokens; a fileSize lists
 * `dropDownSize` with `id` tokens and composes the unit as "<size>|<frequency>" out of
 * `defaultOption`; and `get_service_fields` re-publishes that same fileSize as `validSizes`.
 * Reading only one of the three is how a field that genuinely needs a unit was reported
 * dimensionless — after which a bare value is sent and the add is refused.
 */
function unitTokensOf(component: DefinitionComponent): {
  tokens: string[];
  fallback?: string;
  /** The frequency half of a fileSize unit, e.g. "NA" in "gb|NA". */
  frequency?: string;
} | undefined {
  if (component.dropDownDuration?.length) {
    return {
      tokens: component.dropDownDuration.map((entry) => entry.value).filter((v): v is string => Boolean(v)),
      fallback: component.defaultDuration,
    };
  }
  if (component.dropDownSize?.length) {
    return {
      tokens: component.dropDownSize
        .map((entry) => entry.id ?? entry.value)
        .filter((v): v is string => Boolean(v)),
      fallback: component.defaultOption?.size,
      frequency: component.defaultOption?.frequency,
    };
  }
  if (component.validSizes?.length) {
    return { tokens: [...component.validSizes], fallback: component.defaultUnit };
  }
  return undefined;
}

const optionTokens = (component: DefinitionComponent): string[] | undefined => {
  const list = component.dropDownOptions || component.options;
  if (!list?.length) return undefined;
  return list.map((entry) => entry.value ?? entry.id).filter((v): v is string => Boolean(v));
};

/**
 * What the definition says about one field, or undefined when the field is not in it.
 *
 * Undefined is meaningful and must not be smoothed over: it means this module cannot speak for
 * the field, which is a different statement from "the field is unconstrained".
 */
export function fieldConstraints(
  definition: ServiceDefinition | undefined,
  fieldId: string,
): FieldConstraints | undefined {
  const component = definition?.components.find((entry) => entry.id === fieldId);
  if (!component) return undefined;
  const units = unitTokensOf(component);
  return {
    id: fieldId,
    subType: component.subType,
    label: component.label,
    required: component.validations?.required === true,
    ...(units ? {
      unitTokens: units.tokens,
      unitDefault: units.fallback,
      ...(units.frequency ? { unitFrequency: units.frequency } : {}),
    } : {}),
    ...(optionTokens(component) ? { options: optionTokens(component) } : {}),
    minValue: component.validations?.minValue,
    maxValue: component.validations?.maxValue,
    allowDecimals: component.validations?.allowDecimals,
    conditional: Array.isArray(component.delegate) && component.delegate.length > 0,
  };
}

/**
 * A semantic unit word to the token this field accepts.
 *
 * Matched against the definition's own `value` AND `label` — "hours" is the label whose value
 * is "hr", so deriving the pair from the definition means AWS renaming a token cannot leave a
 * stale mapping behind. A small set of common spellings is folded in ("hrs", "hour") because a
 * spreadsheet writes units however it likes, but every candidate still has to LAND on a token
 * the definition lists.
 *
 * Never returns a default. An unresolved unit is an error the caller must surface, because the
 * alternative — quietly sending the field's default — is precisely how 730 hours became 730
 * minutes in a saved estimate that nothing complained about.
 */
export function resolveUnitToken(
  definition: ServiceDefinition | undefined,
  fieldId: string,
  semanticUnit: string,
): UnitResolution {
  const constraints = fieldConstraints(definition, fieldId);
  if (!constraints) {
    return { ok: false, reason: `field "${fieldId}" is not in the service definition`, validTokens: [] };
  }
  if (!constraints.unitTokens?.length) {
    return { ok: true, token: undefined, dimensionless: true };
  }
  const tokens = constraints.unitTokens;
  const wanted = String(semanticUnit || '').trim().toLowerCase();
  if (!wanted) {
    return { ok: false, reason: 'no unit was stated on the value', validTokens: tokens };
  }

  const component = definition!.components.find((entry) => entry.id === fieldId)!;
  /** Every spelling that identifies a token: its own value, its UI label, and the label's stem. */
  const spellings = new Map<string, string>();
  const remember = (spelling: string | undefined, token: string) => {
    const key = String(spelling || '').trim().toLowerCase();
    if (key) spellings.set(key, token);
  };
  for (const entry of component.dropDownDuration || []) {
    if (!entry.value) continue;
    remember(entry.value, entry.value);
    remember(entry.label, entry.value);
    // "hours" -> "hour", so a source writing the singular still resolves.
    if (entry.label?.endsWith('s')) remember(entry.label.slice(0, -1), entry.value);
  }
  // A fileSize's own labels: "GB" labelling the token "gb", which a sheet writes either way.
  for (const entry of component.dropDownSize || []) {
    const token = entry.id ?? entry.value;
    if (!token) continue;
    remember(token, token);
    remember(entry.label, token);
  }
  for (const size of constraints.unitTokens) {
    remember(size, size);
    // fileSize tokens are written as "gb" and sources write "GB"; the lowercase key covers it.
  }
  // Abbreviations a sheet uses that no definition lists as a label.
  const ABBREVIATIONS: Record<string, string[]> = {
    hr: ['hrs', 'h'],
    min: ['mins', 'm'],
    sec: ['secs', 's'],
    day: ['days', 'd'],
  };
  for (const [token, aliases] of Object.entries(ABBREVIATIONS)) {
    if (!tokens.includes(token)) continue;
    for (const alias of aliases) remember(alias, token);
  }

  const resolved = spellings.get(wanted);
  if (resolved) return { ok: true, token: resolved };
  return {
    ok: false,
    reason: `unit "${semanticUnit}" is not one this field accepts`,
    validTokens: tokens,
  };
}

/** A numeric value against the field's stated range. */
export type ValueCheck = { ok: true } | { ok: false; reason: string };

/**
 * Range and decimal check, before anything is sent.
 *
 * Worth doing locally even though the calculator validates too: `taskDuration` maxes at 730,
 * and a figure past a maximum is the other half of the same silent-default family — the
 * calculator clamps or defaults rather than refusing, so the estimate saves and reads wrong.
 */
export function validateValue(
  definition: ServiceDefinition | undefined,
  fieldId: string,
  value: number,
): ValueCheck {
  const constraints = fieldConstraints(definition, fieldId);
  if (!constraints) return { ok: true };
  if (!Number.isFinite(value)) return { ok: false, reason: `${fieldId} is not a finite number` };
  if (constraints.minValue !== undefined && value < constraints.minValue) {
    return { ok: false, reason: `${fieldId} ${value} is below the minimum ${constraints.minValue}` };
  }
  if (constraints.maxValue !== undefined && value > constraints.maxValue) {
    return { ok: false, reason: `${fieldId} ${value} is above the maximum ${constraints.maxValue}` };
  }
  if (constraints.allowDecimals === false && !Number.isInteger(value)) {
    return { ok: false, reason: `${fieldId} must be a whole number` };
  }
  return { ok: true };
}

/** Clears the caches. Tests only; a Lambda container wants them warm. */
export function resetDefinitionCache(): void {
  definitionCache.clear();
  manifestCache = undefined;
}
