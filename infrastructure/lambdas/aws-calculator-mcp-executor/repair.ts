/**
 * Correcting one resource's Calculator configuration after the MCP refused it.
 *
 * Two layers, cheapest first. The MCP's refusals are structured: "gating field X requires
 * variant Y", "unit must be <size>|<freq>", "missing required field F ... Example: V". When
 * the message names the fix, code applies it and no model is called. Only when the message
 * does not name a fix — or the fix did not work — does the resource go to Sonnet, and Sonnet
 * receives exactly four things: the semantic resource, the requested pricing, the service's
 * field schema, and the MCP's exact words. Not the workbook, not the other resources.
 *
 * The model is asked to change the REPRESENTATION, never the requirement. Its output is
 * checked against the schema before it is sent: unknown fields are rejected, a duration unit
 * must be a token the service definition lists, and the pricing fields are overwritten with
 * the ones the executor resolved. A model that "fixes" a lint error by changing 730 hours to
 * 730 minutes has changed the customer's infrastructure, and that is caught here rather than
 * discovered on the invoice.
 */

import { resolveUnitToken, type ServiceDefinition } from './service-definition.js';
import { describe } from './field-mapping';
import { fileSizeUnit, matchOption, type McpField, type McpFieldsPayload } from './mcp-schema';
import { parseJsonObject, type ModelCaller, type ModelTier } from './model-calls';
import type { PricingApplication } from './pricing-intent';
import type { PricingIntent, SemanticResource } from './types';

/** Unescapes the quotes a JSON-wrapped lint message still carries. */
const plain = (text: string) => String(text || '').replace(/\\"/g, '"');

const numberOf = (value: unknown): number | undefined => {
  if (value && typeof value === 'object' && 'value' in (value as Record<string, unknown>)) {
    return numberOf((value as Record<string, unknown>).value);
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** The first words of a label, for recognising two fields as one family. */
const family = (label: string | undefined) => String(label || '').toLowerCase().replace(/[^a-z ]/g, '').trim().split(/\s+/).slice(0, 3).join(' ');

/**
 * A value re-rendered for a different field of the same family, or undefined.
 *
 * Used when the lint says the vCPU tier gates a different memory field than the one chosen:
 * the number is the customer's, the field is the Calculator's, and only the latter moves.
 */
function renderFor(target: McpField, value: unknown): unknown {
  const n = numberOf(value);
  switch (target.type) {
    case 'fileSize':
      return { value: String(n ?? value), unit: fileSizeUnit(target, undefined) ?? target.defaultUnit ?? 'gb|NA' };
    case 'dropdown':
      return matchOption(target.options, n ?? value) ?? String(n ?? value);
    case 'workload':
      return n ?? value;
    default:
      return String(n ?? value);
  }
}

/**
 * Applies a fix the MCP's message states outright, or returns undefined when it states none.
 */
export function applyStructuredHint(
  config: Record<string, unknown>,
  errorText: string,
  payload: McpFieldsPayload,
): { config: Record<string, unknown>; note: string } | undefined {
  const text = plain(errorText);
  const fields = payload.fields || [];
  const byId = new Map(fields.map((field) => [field.id, field]));

  const variant = /requires variant "([^"]+)"/.exec(text);
  if (variant) {
    const target = byId.get(variant[1]);
    if (target && !(target.id in config)) {
      const donorKey = Object.keys(config).find((key) => key !== target.id
        && byId.has(key) && family(byId.get(key)!.label) === family(target.label));
      if (donorKey) {
        const next = { ...config, [target.id]: renderFor(target, config[donorKey]) };
        delete next[donorKey];
        return { config: next, note: `moved the value from ${donorKey} to ${target.id}, the variant the MCP named` };
      }
    }
  }

  const unit = /Field "([^"]+)": unit "([^"]+)" must be "<size>\|<freq>"/.exec(text);
  if (unit) {
    const [, fieldId, size] = unit;
    const current = config[fieldId];
    if (current && typeof current === 'object') {
      const frequency = (byId.get(fieldId)?.defaultUnit || 'gb|NA').split('|')[1] || 'NA';
      return {
        config: { ...config, [fieldId]: { ...(current as Record<string, unknown>), unit: `${size}|${frequency}` } },
        note: `rewrote the unit of ${fieldId} as "${size}|${frequency}", the shape the MCP asked for`,
      };
    }
  }

  const missing = /missing required field "([^"]+)"[\s\S]*?Example: "([^"]+)"/.exec(text);
  if (missing) {
    const [, fieldId, example] = missing;
    const field = byId.get(fieldId);
    // Only a choice may be filled from an example. A quantity the customer did not state is
    // not a lint problem to paper over; it is a missing input.
    const isChoice = !field || ['dropdown', 'checkbox', 'radioTiles'].includes(field.type) || /^select/i.test(fieldId);
    if (isChoice && !(fieldId in config)) {
      return { config: { ...config, [fieldId]: example }, note: `set ${fieldId} to the MCP's example value "${example}"` };
    }
  }
  return undefined;
}

const SYSTEM_RULES = `You configure one AWS service inside the AWS Pricing Calculator through its MCP. You will be given the customer's requirement for ONE resource, the pricing model already resolved for it, the service's live field schema as get_service_fields returned it, and (when retrying) the MCP's exact refusal.

Return ONLY a JSON object: the "config" for add_service. It must contain "region" and "description" and one entry per field you set, keyed by the field id exactly as the schema lists it.

Rules that are not negotiable:
- The customer's requirement is fixed. Never change a count, a size, a duration, a period or a unit to make the estimate save. If a value cannot be expressed, leave the field out and add a top-level "_unresolved": ["<why>"] entry instead.
- Preserve periods exactly: a count "per day" is sent with the per-day unit token, not converted to a month.
- Use only field ids that appear in the schema (plus region, description, and any field the schema's catalog.required or traps tell you to pass at top level).
- For frequency fields send {"value": "<n>", "unit": "<option id>"}. For fileSize fields send {"value": "<n>", "unit": "<size>|<freq>"} using the sizes the schema lists. For durationInput fields send {"value": "<n>", "unit": "<token>"}; the valid tokens are given to you — never invent one.
- For a columnFormIPM field follow its valueShape exactly: {"value": [ { "<selectorId or label>": {"value": ...}, ... } ]}, using only values listed in selectorValues where a list is given.
- Do not set pricingStrategy or any TermType/LeaseContractLength/PurchaseOption cell; the caller sets those.
- No prose, no markdown, only the JSON object.`;

export interface ModelMappingRequest {
  tier: ModelTier;
  resource: SemanticResource;
  intent: PricingIntent;
  payload: McpFieldsPayload;
  definition: ServiceDefinition | undefined;
  pricing: PricingApplication;
  /** The configuration that was refused, when this is a repair. */
  previousConfig?: Record<string, unknown>;
  /** The MCP's exact words, when this is a repair. */
  error?: string;
}

/** The duration tokens per durationInput field, so the model is told rather than left to guess. */
function durationTokens(payload: McpFieldsPayload, definition: ServiceDefinition | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const field of payload.fields || []) {
    if (field.type !== 'durationInput') continue;
    const probe = resolveUnitToken(definition, field.id, 'hours');
    out[field.id] = probe.ok ? (definition?.components.find((c) => c.id === field.id)?.dropDownDuration || []).map((d) => String(d.value)) : (probe as { validTokens: string[] }).validTokens;
  }
  return out;
}

/**
 * Asks a model for the configuration, then checks it before trusting it.
 *
 * Throws with a reason when the reply cannot be used; the caller treats that as one failed
 * attempt and escalates or stops, it never sends an unchecked reply to the Calculator.
 */
export async function modelMap(models: ModelCaller, request: ModelMappingRequest): Promise<{ config: Record<string, unknown>; unresolved: string[] }> {
  const { resource, payload, definition, pricing } = request;
  const tokens = durationTokens(payload, definition);
  const schemaBlock = JSON.stringify({
    serviceCode: payload.serviceCode,
    serviceName: payload.serviceName,
    fields: payload.fields,
    catalog: payload.catalog,
    durationUnitTokens: tokens,
  });
  const user = [
    `Resource requirement (semantic, fixed):\n${JSON.stringify({ ...resource, description: describe(resource) }, null, 2)}`,
    `Pricing already resolved by the caller (do not set these fields yourself): ${JSON.stringify({ ...pricing.topLevel, ...pricing.columnCells })}`,
    request.previousConfig ? `Configuration the MCP refused:\n${JSON.stringify(request.previousConfig, null, 2)}` : '',
    request.error ? `MCP refusal, verbatim:\n${plain(request.error).slice(0, 3000)}` : '',
    'Return the corrected config JSON object only.',
  ].filter(Boolean).join('\n\n');

  const reply = await models.ask({
    tier: request.tier,
    system: [
      { text: SYSTEM_RULES, cache: true },
      // The schema is per service and shared by every resource of that service in a run, so
      // it is the block worth caching.
      { text: `Service field schema (get_service_fields):\n${schemaBlock}`, cache: true },
    ],
    user,
    maxTokens: 4000,
  });
  const parsed = parseJsonObject(reply);
  const raw = (parsed.config && typeof parsed.config === 'object' ? parsed.config : parsed) as Record<string, unknown>;
  const unresolved = Array.isArray(raw._unresolved) ? raw._unresolved.map(String) : [];
  delete raw._unresolved;
  return { config: sanitize(raw, request), unresolved };
}

const QUANTITY_FIELD_TYPES = new Set(['frequency', 'fileSize', 'durationInput', 'numericInput', 'workload', 'throughput']);

/**
 * The numbers the customer actually stated, plus their period conversions.
 *
 * A model is allowed to move a stated figure between periods (177,426,000 a year is 14,785,500
 * a month; 10 a day is 304 a month) because that is representation. It is not allowed to
 * produce a number that traces to nothing the customer said — 200 ms, 128 MB, 1 gateway —
 * because that is a cost that came from nowhere, however plausible.
 */
function statedNumbers(resource: SemanticResource): number[] {
  const stated = Object.entries(resource.configuration)
    .filter(([key]) => !/(Frequency|Unit|Period|Basis)$/.test(key))
    .map(([, value]) => Number(value))
    .filter((value) => Number.isFinite(value));
  const derived: number[] = [];
  for (const value of stated) {
    // Periods (year↔month↔day↔hour), binary sizes (GB↔MB) and decimal scales (millions,
    // thousands): the Calculator states some counts "per million per month".
    derived.push(value / 12, value * 12, value * 365 / 12, value * 30, value * 730, value / 730, value * 24, value / 1024, value * 1024,
      value / 1000, value * 1000, value / 1_000_000, value * 1_000_000, value / 12_000_000, value / 12_000);
  }
  if (typeof resource.configuration.hoursPerDay === 'number') derived.push(Math.round((resource.configuration.hoursPerDay / 24) * 100));
  return [...stated, ...derived, 0, 100];
}

const numericOf = (value: unknown): number | undefined => {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? (value as { value?: unknown }).value : value;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && String(raw).trim() !== '' ? parsed : undefined;
};

const traceable = (value: number, allowed: number[]) => allowed.some((candidate) => candidate === value
  || (candidate !== 0 && Math.abs(candidate - value) / Math.abs(candidate) < 0.005));

/**
 * The model's config with anything the schema does not vouch for removed, every quantity it
 * set checked against what the customer stated, and the pricing fields set to what the
 * executor resolved.
 */
function sanitize(config: Record<string, unknown>, request: ModelMappingRequest): Record<string, unknown> {
  const { payload, definition, pricing, resource } = request;
  const fields = new Map((payload.fields || []).map((field) => [field.id, field]));
  const allowedNumbers = statedNumbers(resource);
  const invented: string[] = [];
  const allowed = new Set<string>(['region', 'description', ...fields.keys()]);
  for (const entry of payload.catalog?.required || []) allowed.add(entry.field);
  for (const key of Object.keys(payload.catalog?.minimalConfig || {})) allowed.add(key);
  // Fields the EC2 transform accepts at top level and documents in its traps rather than its
  // field list. Read from the traps text so a new one is picked up without a code change.
  for (const trap of payload.catalog?.traps || []) {
    for (const match of trap.matchAll(/\b([a-z][A-Za-z0-9]{2,})\b(?= is HIDDEN| \(string| must be| at the top level)/g)) allowed.add(match[1]);
  }

  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (!allowed.has(key)) continue;
    const field = fields.get(key);
    if (field?.type === 'durationInput') {
      const unit = (value as { unit?: unknown } | undefined)?.unit;
      const resolved = resolveUnitToken(definition, key, String(unit ?? ''));
      if (!resolved.ok || !resolved.token) {
        throw new Error(`the model sent duration unit "${unit}" for ${key}, which the service definition does not list`);
      }
    }
    if (field && QUANTITY_FIELD_TYPES.has(field.type)) {
      const number = numericOf(value);
      if (number !== undefined && !traceable(number, allowedNumbers)) {
        // Dropped, not corrected: the field is then missing, and a missing required quantity
        // becomes a question for the customer rather than a figure invented for them.
        invented.push(`${key}=${number}`);
        continue;
      }
    }
    if (field?.type === 'columnFormIPM' && value && typeof value === 'object') {
      const rows = (value as { value?: Array<Record<string, { value?: unknown }>> }).value;
      for (const row of Array.isArray(rows) ? rows : []) {
        for (const [cellKey, cell] of Object.entries(row)) {
          if (cellKey === 'undefined' || ['TermType', 'LeaseContractLength', 'PurchaseOption'].includes(cellKey)) continue;
          const number = numericOf(cell);
          if (number !== undefined && !traceable(number, allowedNumbers)) {
            invented.push(`${key}.${cellKey}=${number}`);
            delete row[cellKey];
          }
        }
      }
    }
    clean[key] = value;
  }
  if (invented.length) console.log(JSON.stringify({ event: 'mcp_executor_model_invented_quantities', resourceId: resource.resourceId, dropped: invented }));
  clean.region = resource.region;
  clean.description = describe(resource);
  Object.assign(clean, pricing.topLevel);
  // A "repair" that drops a required field is not a repair: it would save a line the
  // Calculator fills with its own default, which is the silent-mispricing family again.
  for (const entry of payload.catalog?.required || []) {
    if (entry.field === 'pricingStrategy' || entry.field in clean) continue;
    if (request.previousConfig && !(entry.field in request.previousConfig)) continue;
    throw new Error(`the model's configuration omits the required field ${entry.field}`);
  }
  // Pricing cells inside a column form are re-asserted, whatever the model wrote there.
  for (const [fieldId, value] of Object.entries(clean)) {
    if (fields.get(fieldId)?.type !== 'columnFormIPM') continue;
    const rows = (value as { value?: Array<Record<string, unknown>> })?.value;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) for (const [selector, cell] of Object.entries(pricing.columnCells)) row[selector] = { value: cell };
  }
  return clean;
}
