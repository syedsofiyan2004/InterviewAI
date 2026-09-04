/**
 * Tier 0: a semantic resource onto the Calculator's fields, by reading the schema.
 *
 * This is deterministic code and it is the common path. A Fargate task with a count, a
 * frequency, a vCPU, a memory size and a duration reaches the Calculator with zero model
 * calls, because every one of those has an unambiguous home in `get_service_fields`: a field
 * whose label says "Number of tasks", one that says "vCPU", one that says "duration". The
 * matching is on the LABELS AND TYPES the MCP publishes, never on field ids, so a Calculator
 * release that renames `smallMemory` changes nothing here.
 *
 * What it refuses to do is guess. When a semantic key matches two fields, or none, or a unit
 * word resolves to no token the schema lists, the result is `confident: false` with the
 * ambiguity named, and the executor escalates that ONE resource to a model. A guess here is
 * the "730 hours priced as 730 minutes" bug in a new coat.
 */

import { resolveUnitToken, validateValue, type ServiceDefinition } from '../calculator-orchestrator/calculator-definitions';
import {
  fileSizeUnit,
  matchFrequency,
  matchOption,
  requiredFieldIds,
  type McpField,
  type McpFieldsPayload,
} from './mcp-schema';
import type { PricingApplication } from './pricing-intent';
import type { SemanticResource } from './types';

/**
 * The semantic vocabulary and the label wording each key is recognised by.
 *
 * Deliberately a vocabulary of INFRASTRUCTURE words, service-agnostic: `instanceCount` is the
 * same idea for EC2 ("workloads"), RDS ("Nodes") and OpenSearch ("Number of nodes"). A key
 * that is not here is not mapped by code; it goes to the model with the schema.
 */
interface SemanticFieldSpec {
  key: string;
  labels: RegExp[];
  /** Field types this key may land on. Unset means any. */
  types?: string[];
  /** The companion key holding the frequency word for a `frequency` field. */
  frequencyKey?: string;
  /** The companion key holding the unit word for a durationInput / fileSize field. */
  unitKey?: string;
  /** The unit word implied by the key's own name, when no companion is given. */
  impliedUnit?: string;
}

const QUANTITY_TYPES = new Set(['frequency', 'fileSize', 'durationInput', 'numericInput', 'workload', 'throughput', 'columnFormIPM', 'ec2InstanceSearch', 'autoSuggest', 'textInput']);

const SEMANTIC_FIELDS: SemanticFieldSpec[] = [
  { key: 'taskCount', labels: [/number of tasks/i, /tasks or pods/i], types: ['frequency', 'numericInput'], frequencyKey: 'taskFrequency' },
  { key: 'vcpuPerTask', labels: [/vcpu/i] },
  { key: 'memoryGbPerTask', labels: [/memory/i], unitKey: 'memoryUnit', impliedUnit: 'GB' },
  { key: 'duration', labels: [/duration/i], types: ['durationInput'], unitKey: 'durationUnit' },
  { key: 'instanceType', labels: [/instance type/i, /ec2 instance/i, /instance name/i, /^instance$/i, /broker instance/i], types: ['ec2InstanceSearch', 'autoSuggest', 'dropdown', 'textInput', 'columnCell'] },
  // instanceCount and nodeCount are one idea wearing two words: EC2 says "workloads", RDS
  // says "Nodes", OpenSearch says "Number of instances" for the same count. Both keys accept
  // every spelling, so a sheet's choice of word never decides whether the count lands.
  { key: 'instanceCount', labels: [/number of instances/i, /^nodes$/i, /number of nodes/i, /^advance workloads?$/i, /^workloads?$/i, /number of .*(brokers|load balancers|gateways|domains|clusters|endpoints)/i], types: ['workload', 'numericInput', 'textInput', 'columnCell'] },
  { key: 'nodeCount', labels: [/number of instances/i, /^nodes$/i, /number of nodes/i, /number of .*(brokers|domains|clusters)/i], types: ['numericInput', 'textInput', 'columnCell'] },
  // A usage figure whose dimension only the basis text names ("monthly active users",
  // "notifications", "state transitions"). No label patterns on purpose: code cannot place
  // it, so its presence sends the resource to a model with the schema and the basis.
  { key: 'usageCount', labels: [], frequencyKey: 'usageFrequency' },
  { key: 'operatingSystem', labels: [/operating system/i], types: ['dropdown', 'columnCell'] },
  { key: 'tenancy', labels: [/^tenancy$/i], types: ['dropdown'] },
  { key: 'storageGb', labels: [/storage amount/i, /storage \(gb\)/i, /^storage$/i, /storage per/i, /\bstorage$/i], types: ['fileSize', 'numericInput', 'columnCell'], unitKey: 'storageUnit', impliedUnit: 'GB' },
  { key: 'storageGbPerInstance', labels: [/storage amount/i, /storage for each/i, /^storage$/i, /storage per/i], types: ['fileSize', 'numericInput', 'columnCell'], unitKey: 'storageUnit', impliedUnit: 'GB' },
  { key: 'storageType', labels: [/storage (for|type|class|volume)/i, /volume type/i], types: ['dropdown', 'columnCell'] },
  { key: 'requestCount', labels: [/number of requests/i, /^requests$/i], types: ['frequency'], frequencyKey: 'requestFrequency' },
  { key: 'requestDurationMs', labels: [/duration of each request/i, /request duration/i], types: ['numericInput'] },
  { key: 'memoryMb', labels: [/memory allocated/i, /^memory/i], types: ['fileSize', 'numericInput'], unitKey: 'memoryUnit', impliedUnit: 'MB' },
  { key: 'architecture', labels: [/architecture/i], types: ['dropdown'] },
  { key: 'engine', labels: [/engine/i], types: ['dropdown', 'columnCell'] },
  { key: 'deployment', labels: [/deployment/i, /multi-?az/i], types: ['dropdown', 'columnCell'] },
  { key: 'dataTransferGb', labels: [/data transfer/i], types: ['fileSize', 'numericInput'], unitKey: 'dataTransferUnit', impliedUnit: 'GB' },
  { key: 'utilizationPct', labels: [/utilization/i], types: ['numericInput'] },
  // Redshift Serverless: active query hours per day (0–24). Derived from the workbook's
  // hours/month figure and carried as a semantic key so the Calculator's Query_period field
  // is populated without inventing a number the customer did not state.
  { key: 'queryHoursPerDay', labels: [/query period/i, /active query hours/i], types: ['numericInput'] },
];

/** Keys that qualify another key (its unit, period or basis) and are never mapped on their own. */
const isCompanionKey = (key: string) => /(Frequency|Unit|Period|Basis)$/.test(key);

/**
 * The instance family an instance class belongs to, in the Calculator's own wording.
 *
 * Read off the class letter, which AWS keeps consistent across services: r = memory,
 * m/t = general purpose, c = compute, i/d = storage. The OpenSearch matrix asks for it as a
 * separate cell next to the instance type, and the catalog's trap records that its labels are
 * not the ones a person would guess — so the wording is matched against the cell's own
 * selector values rather than written here.
 */
function instanceFamilyOf(instanceType: unknown, allowed: string[] | undefined): string | undefined {
  const letter = /^(?:db\.|cache\.)?([a-z])\d/i.exec(String(instanceType || ''))?.[1]?.toLowerCase();
  if (!letter || !allowed?.length) return undefined;
  const wanted = letter === 'r' || letter === 'x' || letter === 'z' ? /memory/i
    : letter === 'c' ? /compute/i
      : letter === 'i' || letter === 'd' || letter === 'h' ? /storage/i
        : letter === 'm' || letter === 't' || letter === 'a' ? /general/i
          : undefined;
  return wanted ? allowed.find((value) => wanted.test(value)) : undefined;
}

/** The minimal-config row of a column form, when the catalog publishes one. */
function minimalRow(payload: McpFieldsPayload, formId: string): Record<string, { value?: unknown }> | undefined {
  const form = (payload.catalog?.minimalConfig || {})[formId] as { value?: Array<Record<string, { value?: unknown }>> } | undefined;
  return Array.isArray(form?.value) ? form!.value[0] : undefined;
}

/** Keys the executor consumes itself rather than mapping onto the Calculator. */
const EXECUTOR_KEYS = new Set(['hoursPerDay', 'hoursPerMonth']);

const BASIS_STOP_WORDS = new Set(['number', 'of', 'the', 'per', 'a', 'an', 'and', 'or', 'in', 'for', 'to', 'total', 'count', 'requested', 'yr', 'year', 'month', 'monthly']);

/** The words in a label or basis that carry meaning, lower-cased, filler removed. */
function significantWordsOf(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1 && !BASIS_STOP_WORDS.has(word)));
}

/**
 * The semantic keys a Calculator label could stand for, by the vocabulary's own patterns.
 *
 * Used by the preflight to tell whether a plan already asks for what a Calculator input
 * needs: "Amount of memory allocated" is memory whichever key spells it.
 */
export function semanticKeysForLabel(label: string): string[] {
  return SEMANTIC_FIELDS.filter((entry) => entry.labels.some((pattern) => pattern.test(label.trim()))).map((entry) => entry.key);
}

/** Column-form selectors the pricing intent owns; never filled from the resource. */
const PRICING_SELECTORS = new Set(['TermType', 'LeaseContractLength', 'PurchaseOption']);

/**
 * Whether the service itself already states the engine, as "Amazon RDS for PostgreSQL" and
 * "Amazon Aurora MySQL-Compatible" do. Then the engine needs no field: choosing the service
 * WAS the choice, and asking the schema for an engine field would leave the key unmapped.
 */
function engineStatedByService(payload: McpFieldsPayload, engine: unknown): boolean {
  const name = `${payload.serviceName || ''} ${payload.serviceCode || ''}`.toLowerCase().replace(/[^a-z0-9]/g, '');
  const words = String(engine || '').toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2);
  return words.length > 0 && words.every((word) => name.includes(word));
}

export interface MappingResult {
  confident: boolean;
  config: Record<string, unknown>;
  /** Semantic key → field id (or `<formId>.<selectorId>` for a column-form cell). */
  claimed: Record<string, string>;
  /** Semantic keys no field could be found for. */
  unmapped: string[];
  /** Semantic keys with more than one candidate, and the candidates. */
  ambiguous: Record<string, string[]>;
  /** Required Calculator inputs that neither the resource nor a safe default supplies. */
  missingInputs: string[];
  /** Fields filled from the catalog's minimal config, labelled as AWS defaults. */
  defaultsApplied: Record<string, unknown>;
  notes: string[];
  /** The columnFormIPM field used, when the service is configured through one. */
  columnForm?: McpField;
}

const spec = (key: string) => SEMANTIC_FIELDS.find((entry) => entry.key === key);

const labelMatches = (label: string | undefined, patterns: RegExp[]) => patterns.some((pattern) => pattern.test(String(label || '').trim()));

/**
 * Candidate fields for one semantic key, narrowed by the rules that make a match unambiguous
 * without naming a field: the value must fit the field's options, and a field the catalog
 * itself uses in its minimal configuration outranks one it does not.
 */
function candidatesFor(
  entry: SemanticFieldSpec,
  value: unknown,
  fields: McpField[],
  payload: McpFieldsPayload,
  taken: Set<string>,
): McpField[] {
  let candidates = fields.filter((field) => !taken.has(field.id)
    && field.type !== 'columnFormIPM'
    && labelMatches(field.label, entry.labels)
    && (!entry.types || entry.types.includes(field.type)));
  if (candidates.length <= 1) return candidates;

  // A dropdown that cannot take the value is not a candidate for it.
  const fitting = candidates.filter((field) => field.type !== 'dropdown' || matchOption(field.options, value) !== undefined);
  if (fitting.length) candidates = fitting;
  if (candidates.length <= 1) return candidates;

  const minimal = payload.catalog?.minimalConfig || {};
  const inMinimal = candidates.filter((field) => field.id in minimal);
  if (inMinimal.length === 1) return inMinimal;

  // Dedicated-host variants of a field duplicate its label; without host tenancy they are
  // not in play. Recognised by the catalog's own naming rather than by a list of ids.
  const nonHost = candidates.filter((field) => !/DH$/.test(field.id));
  if (nonHost.length === 1) return nonHost;
  if (nonHost.length) candidates = nonHost;

  // "Storage amount" against "Storage amount per io2 volume": the plainer label is the general
  // field and the longer one is its specialisation. Unique shortest label wins; a tie stays
  // ambiguous and goes to a model.
  const shortest = Math.min(...candidates.map((field) => String(field.label || '').trim().length));
  const plainest = candidates.filter((field) => String(field.label || '').trim().length === shortest);
  if (plainest.length === 1) return plainest;
  return candidates;
}

type Rendered = { ok: true; value: unknown; note?: string } | { ok: false; reason: string };

/** One semantic value in the shape one field type wants. */
function render(
  field: McpField,
  entry: SemanticFieldSpec,
  resource: SemanticResource,
  definition: ServiceDefinition | undefined,
): Rendered {
  const value = resource.configuration[entry.key];
  const companion = (key: string | undefined) => (key ? resource.configuration[key] : undefined);

  switch (field.type) {
    case 'frequency': {
      const period = companion(entry.frequencyKey);
      if (period === undefined) return { ok: false, reason: `${entry.key} needs a period (${entry.frequencyKey}) for "${field.label}"` };
      const unit = matchFrequency(field.options, period);
      if (unit) return { ok: true, value: { value: String(value), unit } };
      // Sheets state annual volumes and the Calculator has no per-year option. Dividing by
      // twelve is representation, not a new number, and it is done here in the open — with
      // the arithmetic written into the notes — rather than left to a model.
      const monthly = matchFrequency(field.options, 'perMonth');
      if (/year|annual/i.test(String(period)) && monthly) {
        const perMonth = Math.round((Number(value) / 12) * 1_000_000) / 1_000_000;
        return {
          ok: true,
          value: { value: String(perMonth), unit: monthly },
          note: `${value} per year for "${field.label}" sent as ${perMonth} per month (÷ 12): the Calculator offers no per-year period`,
        };
      }
      return { ok: false, reason: `period "${period}" is not one "${field.label}" accepts (${(field.options || []).map((option) => option.id).join(', ')})` };
    }
    case 'durationInput': {
      const unitWord = companion(entry.unitKey) ?? entry.impliedUnit;
      if (unitWord === undefined) return { ok: false, reason: `${entry.key} needs a unit (${entry.unitKey}) for "${field.label}"` };
      // The MCP does not publish a durationInput's tokens; only the service definition does.
      // Without it the unit cannot be verified and is refused, because an unverified token
      // is exactly how 730 hours was saved and priced as 730 minutes.
      if (!definition) return { ok: false, reason: `the unit tokens for "${field.label}" could not be read from the Calculator's service definition` };
      const resolved = resolveUnitToken(definition, field.id, String(unitWord));
      if (!resolved.ok) return { ok: false, reason: `${resolved.reason} (valid: ${resolved.validTokens.join(', ')})` };
      const range = validateValue(definition, field.id, Number(value));
      if (!range.ok) return { ok: false, reason: range.reason };
      return { ok: true, value: { value: String(value), unit: resolved.token } };
    }
    case 'fileSize': {
      const unitWord = companion(entry.unitKey) ?? entry.impliedUnit;
      const unit = fileSizeUnit(field, unitWord);
      if (!unit) return { ok: false, reason: `size unit "${unitWord}" is not one "${field.label}" accepts` };
      return { ok: true, value: { value: String(value), unit } };
    }
    case 'dropdown': {
      const token = matchOption(field.options, value);
      if (token === undefined) return { ok: false, reason: `"${value}" is not an option of "${field.label}"` };
      return { ok: true, value: token };
    }
    case 'workload':
      return Number.isFinite(Number(value)) ? { ok: true, value: Number(value) } : { ok: false, reason: `${entry.key} must be a number` };
    case 'checkbox':
      return { ok: true, value: Boolean(value) };
    default:
      return { ok: true, value: String(value) };
  }
}

/**
 * The columnFormIPM field that covers the most semantic keys, or undefined when there is none
 * or the choice is a tie.
 */
function chooseColumnForm(fields: McpField[], keys: string[], payload: McpFieldsPayload): { form?: McpField; tie?: string[] } {
  const forms = fields.filter((field) => field.type === 'columnFormIPM' && field.row?.length);
  if (!forms.length) return {};
  const scored = forms.map((form) => ({
    form,
    score: keys.filter((key) => {
      const entry = spec(key);
      return entry && (form.row || []).some((cell) => labelMatches(cell.label, entry.labels));
    }).length,
  })).sort((a, b) => b.score - a.score);
  if (scored[0].score === 0) return {};
  if (scored.length > 1 && scored[1].score === scored[0].score) {
    // OpenSearch's data-instance and dedicated-master tables have identical columns, so the
    // labels alone tie. The catalog's minimal configuration breaks it: the table it fills with
    // a non-zero node count is the primary one, and the ones it zeroes are optional extras.
    const tied = scored.filter((entry) => entry.score === scored[0].score);
    const primary = tied.filter((entry) => {
      const row = minimalRow(payload, entry.form.id);
      return row && Object.entries(row).some(([key, cell]) => /nodes|number of/i.test(key) && Number(cell?.value) > 0);
    });
    if (primary.length === 1) return { form: primary[0].form };
    return { tie: tied.map((entry) => entry.form.id) };
  }
  return { form: scored[0].form };
}

/**
 * One row of a column form from the semantic keys, keyed the way the MCP's `valueShape` says:
 * by selectorId, or by label when a cell has none, with the utilization cell under the literal
 * key "undefined".
 */
function mapColumnForm(
  form: McpField,
  resource: SemanticResource,
  pricingCells: Record<string, string>,
  result: MappingResult,
  payload: McpFieldsPayload,
): void {
  const row: Record<string, { value: unknown }> = {};
  const defaults = minimalRow(payload, form.id);
  for (const cell of form.row || []) {
    const selector = cell.selectorId;
    if (selector && selector in pricingCells) {
      row[selector] = { value: pricingCells[selector] };
      continue;
    }
    // Term and purchase option belong to the pricing intent. Absent from it, they are not
    // inputs the customer owes — an On-Demand row has no term — so they are left unset.
    if (selector && PRICING_SELECTORS.has(selector)) continue;
    if (!selector && /utili[sz]ation/i.test(cell.label || '')) {
      const pct = resource.configuration.utilizationPct ?? 100;
      row.undefined = { value: { unit: String(pct), selectedId: '%Utilized/Month' } };
      continue;
    }
    const entry = SEMANTIC_FIELDS.find((candidate) => candidate.key in resource.configuration
      && labelMatches(cell.label, candidate.labels)
      && (!candidate.types || candidate.types.includes('columnCell')));
    const key = selector || cell.label || '';
    if (!key) continue;
    if (entry) {
      const raw = resource.configuration[entry.key];
      const allowed = selector ? form.selectorValues?.[selector] : undefined;
      if (allowed?.length) {
        const hit = allowed.find((option) => option.toLowerCase() === String(raw).toLowerCase());
        if (!hit) {
          result.unmapped.push(entry.key);
          result.notes.push(`"${raw}" is not a value "${cell.label}" accepts (${allowed.join(', ')})`);
          continue;
        }
        row[key] = { value: hit };
      } else {
        row[key] = { value: String(raw) };
      }
      result.claimed[entry.key] = `${form.id}.${key}`;
      continue;
    }
    // A dropdown cell with one possible value is not a choice; anything else uncovered is.
    const allowed = selector ? form.selectorValues?.[selector] : undefined;
    if (allowed?.length === 1) {
      row[key] = { value: allowed[0] };
      result.defaultsApplied[`${form.id}.${key}`] = allowed[0];
      continue;
    }
    // The instance family is a property of the instance class already stated, not a second
    // question for the customer.
    if (/instance (node )?type|instance family/i.test(cell.label || '') && allowed?.length && resource.configuration.instanceType !== undefined) {
      const family = instanceFamilyOf(resource.configuration.instanceType, allowed);
      if (family) {
        row[key] = { value: family };
        result.claimed[`${key}`] = `${form.id}.${key}`;
        result.notes.push(`${cell.label}: ${family}, read from the instance class ${resource.configuration.instanceType}`);
        continue;
      }
    }
    // A choice the catalog's own minimal configuration makes ("EBS Only") is the Calculator's
    // default, applied as such and labelled as such. A choice it does not make is a question.
    const fallback = defaults?.[key]?.value;
    if (allowed && allowed.length > 1) {
      if (fallback !== undefined && allowed.some((value) => value === fallback)) {
        row[key] = { value: fallback };
        result.defaultsApplied[`${form.id}.${key}`] = fallback;
      } else {
        result.missingInputs.push(`${cell.label || key} (one of: ${allowed.slice(0, 12).join(', ')}${allowed.length > 12 ? ', …' : ''})`);
      }
    } else if (cell.type === 'textInput' || cell.type === 'autoSuggest') {
      result.missingInputs.push(cell.label || key);
    }
  }
  result.config[form.id] = { value: [row] };
  result.columnForm = form;
}

/**
 * Maps one resource. Pure: same inputs, same output, no calls.
 *
 * `confident` is true only when every semantic key found exactly one field, every value
 * rendered in a shape the field accepts, and nothing the catalog requires is left unfilled.
 */
export function mapDeterministically(
  resource: SemanticResource,
  payload: McpFieldsPayload,
  definition: ServiceDefinition | undefined,
  pricing: PricingApplication,
): MappingResult {
  const fields = payload.fields || [];
  const result: MappingResult = {
    confident: true,
    config: {
      region: resource.region,
      description: describe(resource),
    },
    claimed: {},
    unmapped: [],
    ambiguous: {},
    missingInputs: [],
    defaultsApplied: {},
    notes: [],
  };

  const semanticKeys = Object.keys(resource.configuration)
    .filter((key) => !isCompanionKey(key) && !EXECUTOR_KEYS.has(key) && resource.configuration[key] !== undefined && resource.configuration[key] !== '');

  // Column-form services first: their cells claim keys that must not then look unmapped.
  const chosen = chooseColumnForm(fields, semanticKeys, payload);
  if (chosen.tie) {
    result.ambiguous.columnFormIPM = chosen.tie;
  } else if (chosen.form) {
    mapColumnForm(chosen.form, resource, pricing.columnCells, result, payload);
  }

  const taken = new Set<string>();
  /** Fields the resource addressed with a value the field could not take as written. */
  const refused = new Set<string>();
  for (const key of semanticKeys) {
    if (key === 'engine' && engineStatedByService(payload, resource.configuration.engine)) {
      result.claimed[key] = 'service';
      continue;
    }
    // A key a column-form cell already took may ALSO belong to a top-level field: OpenSearch
    // asks for the node count both inside its data-instance table and as "Number of
    // instances". So a claimed key is still offered to the top-level fields; it simply cannot
    // become unmapped or ambiguous on their account.
    const alreadyClaimed = Boolean(result.claimed[key]);
    const entry = spec(key);
    if (!entry) {
      if (!alreadyClaimed) result.unmapped.push(key);
      continue;
    }
    const candidates = candidatesFor(entry, resource.configuration[key], fields, payload, taken);
    if (!candidates.length) {
      // A key the chosen column form already expresses is not unmapped; a key nothing takes is.
      if (!alreadyClaimed && !(chosen.form && (chosen.form.row || []).some((cell) => labelMatches(cell.label, entry.labels)))) {
        result.unmapped.push(key);
      }
      continue;
    }
    if (candidates.length > 1) {
      if (!alreadyClaimed) result.ambiguous[key] = candidates.map((field) => field.id);
      continue;
    }
    const field = candidates[0];
    const rendered = render(field, entry, resource, definition);
    if (!rendered.ok) {
      // The resource DID state this value; the field could not take it as written. That is a
      // refusal to record, not an input to ask the customer for again.
      result.unmapped.push(key);
      result.notes.push(rendered.reason);
      refused.add(field.id);
      continue;
    }
    result.config[field.id] = rendered.value;
    if (!result.claimed[key]) result.claimed[key] = field.id;
    taken.add(field.id);
    if (rendered.note) result.notes.push(rendered.note);
  }

  // A bare usage count travels with the sheet's own words for what it counts ("monthly active
  // users (MAU)"). When exactly one numeric field's label shares those words, the sheet has
  // named the field itself, and the number lands without a model and without being asked for
  // again. Two candidates is an ambiguity, none is a question — never a guess.
  if (!result.claimed.usageCount && resource.configuration.usageCount !== undefined && resource.configuration.usageBasis) {
    const basisWords = significantWordsOf(String(resource.configuration.usageBasis));
    const scored = fields
      .filter((field) => (field.type === 'numericInput' || field.type === 'frequency') && !taken.has(field.id))
      .map((field) => ({ field, shared: [...significantWordsOf(field.label || '')].filter((word) => basisWords.has(word)).length }))
      .filter((entry) => entry.shared >= 2 || (entry.shared === 1 && basisWords.size === 1))
      .sort((a, b) => b.shared - a.shared);
    if (scored.length && (scored.length === 1 || scored[0].shared > scored[1].shared)) {
      const field = scored[0].field;
      const value = resource.configuration.usageCount;
      if (field.type === 'frequency') {
        const unit = matchFrequency(field.options, resource.configuration.usageFrequency ?? 'perMonth');
        if (unit) {
          result.config[field.id] = { value: String(value), unit };
          result.claimed.usageCount = field.id;
          taken.add(field.id);
          result.unmapped = result.unmapped.filter((key) => key !== 'usageCount');
        }
      } else {
        result.config[field.id] = String(value);
        result.claimed.usageCount = field.id;
        taken.add(field.id);
        result.unmapped = result.unmapped.filter((key) => key !== 'usageCount');
      }
      if (result.claimed.usageCount) result.notes.push(`"${resource.configuration.usageBasis}" placed in "${field.label}", the one field whose label names the same thing`);
    }
  }

  // Hours a day is a schedule; the Calculator's EC2 form takes it as a utilization percentage.
  // Derived here, in the open, with the formula recorded — the source value is untouched.
  const utilization = fields.find((field) => field.id === 'utilization' || /^utili[sz]ation/i.test(field.label || ''));
  if (utilization && !(utilization.id in result.config) && resource.configuration.utilizationPct === undefined
    && typeof resource.configuration.hoursPerDay === 'number') {
    const pct = Math.max(1, Math.min(100, Math.round((resource.configuration.hoursPerDay / 24) * 100)));
    result.config[utilization.id] = String(pct);
    result.notes.push(`utilization ${pct}% derived from ${resource.configuration.hoursPerDay} hours/day (hours ÷ 24 × 100); the source value is kept as stated`);
    taken.add(utilization.id);
  }

  Object.assign(result.config, pricing.topLevel);

  // Everything the catalog requires that nothing above supplied.
  const minimal = payload.catalog?.minimalConfig || {};
  for (const fieldId of requiredFieldIds(payload)) {
    if (fieldId in result.config) continue;
    if (fieldId === 'pricingStrategy') continue; // the pricing intent owns it
    if (refused.has(fieldId)) continue; // stated by the customer, refused above, already noted
    const field = fields.find((entry) => entry.id === fieldId);
    const type = field?.type;
    const label = field?.label || fieldId;
    // A column form the resource is not about — OpenSearch's dedicated-master and UltraWarm
    // tables beside the data-instance table it IS about — is filled from the catalog's minimal
    // configuration, which sets it to zero nodes. Left absent, the Calculator UI rehydrates it
    // with manifest defaults (three r5.2xlarge masters) and prices them in: a recorded 8.5x
    // phantom cost. The catalog's own trap says to send all tables with zero on the unwanted.
    if (type === 'columnFormIPM' && field !== result.columnForm && fieldId in minimal) {
      result.config[fieldId] = minimal[fieldId];
      result.defaultsApplied[fieldId] = minimal[fieldId];
      continue;
    }
    const isQuantity = !type || QUANTITY_TYPES.has(type);
    if (isQuantity) {
      // A number the customer did not state is a question for the customer, not a default:
      // a default count or duration is a cost that came from nowhere.
      result.missingInputs.push(label);
      continue;
    }
    if (fieldId in minimal) {
      result.config[fieldId] = minimal[fieldId];
      result.defaultsApplied[fieldId] = minimal[fieldId];
    } else if (field?.defaultValue !== undefined && (type === 'dropdown' || type === 'checkbox')) {
      const token = type === 'dropdown' ? matchOption(field.options, field.defaultValue) ?? field.defaultValue : field.defaultValue;
      result.config[fieldId] = token;
      result.defaultsApplied[fieldId] = token;
    } else {
      result.missingInputs.push(label);
    }
  }

  result.confident = result.unmapped.length === 0
    && Object.keys(result.ambiguous).length === 0
    && result.missingInputs.length === 0;
  return result;
}

/** The description written into the estimate. Carries the resource id so read-back can find it. */
export function describe(resource: SemanticResource): string {
  const base = (resource.description || resource.service).trim().slice(0, 160);
  return `${base} [${resource.resourceId}]`;
}

/** The resource id a saved description carries, or undefined. */
export function resourceIdFromDescription(description: unknown): string | undefined {
  const match = /\[([^\[\]]+)\]\s*$/.exec(String(description || ''));
  return match ? match[1] : undefined;
}
