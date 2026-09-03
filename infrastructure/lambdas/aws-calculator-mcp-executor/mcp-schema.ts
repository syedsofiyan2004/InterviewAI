/**
 * The shape of what `get_service_fields` returns, and small readers over it.
 *
 * Typed loosely on purpose. This is the MCP's contract, not MIMO's, and it has grown fields
 * between versions (`catalog`, `selectorValues`, `valueShape`, `redirect_to_parent`). A strict
 * type here would reject a newer server for adding information; an open one lets the readers
 * below take what they recognise and ignore the rest.
 */

export interface McpFieldOption {
  id?: string;
  value?: string;
  label?: string;
}

export interface McpColumnFormCell {
  label?: string;
  selectorId?: string;
  type?: string;
  exportValueAs?: string;
  mappingValue?: Record<string, string>;
}

export interface McpField {
  id: string;
  type: string;
  label?: string;
  options?: McpFieldOption[];
  defaultValue?: unknown;
  minValue?: number;
  maxValue?: number;
  allowDecimals?: boolean;
  /** fileSize: the accepted size tokens and the "<size>|<freq>" default. */
  validSizes?: string[];
  defaultUnit?: string;
  unitFormat?: string;
  /** columnFormIPM: the columns of one row, and the accepted value per dropdown column. */
  row?: McpColumnFormCell[];
  selectorValues?: Record<string, string[]>;
  valueShape?: string;
  helpText?: string;
  _synthetic?: boolean;
  [key: string]: unknown;
}

export interface McpCatalogRequired {
  field: string;
  hint?: string;
  example?: unknown;
  shape?: string;
  enum?: string[];
  default?: unknown;
}

export interface McpFieldsPayload {
  serviceCode: string;
  serviceName?: string;
  fields?: McpField[];
  /** Present when the service is a deprecated parent envelope with real children. */
  status?: string;
  redirect_to?: string;
  child_service_codes?: string[];
  next_step?: string;
  catalog?: {
    status?: string;
    templateId?: string;
    required?: McpCatalogRequired[];
    traps?: string[];
    minimalConfig?: Record<string, unknown>;
    subServices?: Array<{ serviceCode: string; estimateFor?: string; required?: McpCatalogRequired[] }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export function parseFieldsPayload(text: string): McpFieldsPayload {
  const start = text.indexOf('{');
  if (start < 0) throw new Error(`get_service_fields returned no JSON: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(text.slice(start));
  if (!parsed?.serviceCode) throw new Error(`get_service_fields returned no serviceCode: ${text.slice(0, 200)}`);
  return parsed as McpFieldsPayload;
}

/** The field ids the catalog marks required, plus every key its minimal config sets. */
export function requiredFieldIds(payload: McpFieldsPayload): string[] {
  const ids = new Set<string>();
  for (const entry of payload.catalog?.required || []) if (entry.field) ids.add(entry.field);
  for (const key of Object.keys(payload.catalog?.minimalConfig || {})) {
    if (key !== 'region' && key !== 'description') ids.add(key);
  }
  return [...ids];
}

/** Option token for a value: by id, by value, by label, numerically, case-insensitively. */
export function matchOption(options: McpFieldOption[] | undefined, value: unknown): string | undefined {
  if (!options?.length) return undefined;
  const wanted = String(value).trim().toLowerCase();
  const wantedNumber = Number(value);
  for (const option of options) {
    const token = option.id ?? option.value;
    if (token === undefined) continue;
    if (String(token).toLowerCase() === wanted) return String(token);
  }
  for (const option of options) {
    const token = option.id ?? option.value;
    if (token === undefined) continue;
    const label = String(option.label ?? '').trim().toLowerCase();
    if (label && label === wanted) return String(token);
    // "2 GB" labels a token "2": a numeric value matches the number the label leads with.
    if (Number.isFinite(wantedNumber) && label) {
      const leading = /^-?\d+(?:\.\d+)?/.exec(label);
      if (leading && Number(leading[0]) === wantedNumber && !/\d/.test(label.slice(leading[0].length).replace(/\s*(gb|mb|tb|vcpu|hours?|hr|min).*$/i, ''))) {
        return String(token);
      }
    }
  }
  // "gp3" against "Storage General Purpose gp3 GB Mo": a value that appears as a whole word in
  // exactly one option's id or label names that option. Two hits is an ambiguity, not a match.
  if (wanted && !Number.isFinite(wantedNumber)) {
    const word = new RegExp(`(^|[^a-z0-9])${wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
    const containing = options.filter((option) => word.test(String(option.label ?? '')) || word.test(String(option.id ?? option.value ?? '')));
    if (containing.length === 1) return String(containing[0].id ?? containing[0].value);
  }
  return matchOptionByWords(options, wanted);
}

/** Spellings that mean the same thing in an option id and in a sheet. */
const WORD_SYNONYMS: Record<string, string> = {
  std: 'standard', ent: 'enterprise', rhel: 'rhel', 'red': 'rhel', hat: 'rhel', suse: 'suse', win: 'windows',
};
const STOP_WORDS = new Set(['server', 'with', 'edition', 'and', 'the', 'of', 'on', 'for', 'os', 'sql']);

/** The significant words of a phrase, synonyms folded, version numbers and filler dropped. */
function significantWords(text: string): Set<string> {
  const words = String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    .filter((word) => !/^\d+$/.test(word) && !STOP_WORDS.has(word))
    .map((word) => WORD_SYNONYMS[word] || word);
  return new Set(words);
}

/**
 * "Windows Server 2019 with SQL Server Standard" against ids like `windows-std`: the option
 * whose words cover the most of the value's words wins, ties broken by fewest extra words,
 * and a tie that survives both is no match. The value's OS family word must be among the
 * covered words, so "Standard" alone never picks a Windows licence.
 */
export function matchOptionByWords(options: McpFieldOption[] | undefined, value: string): string | undefined {
  if (!options?.length) return undefined;
  const wanted = significantWords(value);
  if (!wanted.size) return undefined;
  const scored = options.map((option) => {
    const token = String(option.id ?? option.value ?? '');
    const own = new Set([...significantWords(token), ...significantWords(String(option.label ?? ''))]);
    const covered = [...wanted].filter((word) => own.has(word)).length;
    const extra = [...own].filter((word) => !wanted.has(word)).length;
    return { token, covered, extra };
  }).filter((entry) => entry.covered > 0 && entry.token);
  if (!scored.length) return undefined;
  scored.sort((a, b) => b.covered - a.covered || a.extra - b.extra);
  const [best, next] = scored;
  if (next && next.covered === best.covered && next.extra === best.extra) return undefined;
  return best.token;
}

/**
 * The frequency token a field accepts for a semantic period word.
 *
 * "perDay", "per day", "daily" and "/day" all mean the same option; the match is against the
 * option's id AND label so the caller can pass whichever the source wrote.
 */
export function matchFrequency(options: McpFieldOption[] | undefined, period: unknown): string | undefined {
  if (period === undefined || period === null) return undefined;
  const direct = matchOption(options, period);
  if (direct) return direct;
  const text = String(period).toLowerCase().replace(/[^a-z]/g, '');
  const aliases: Record<string, string[]> = {
    persecond: ['persecond', 'second', 'sec', 's'],
    perminute: ['perminute', 'minute', 'min'],
    perhour: ['perhour', 'hour', 'hourly', 'hr', 'h'],
    perday: ['perday', 'day', 'daily', 'd'],
    permonth: ['permonth', 'month', 'monthly', 'mo', 'm'],
    millionpermonth: ['millionpermonth', 'millionsmonth', 'mpermonth', 'millionmonthly'],
  };
  for (const option of options || []) {
    const token = option.id ?? option.value;
    if (!token) continue;
    const key = String(token).toLowerCase().replace(/[^a-z]/g, '');
    if ((aliases[key] || [key]).includes(text)) return String(token);
  }
  return undefined;
}

/** The "<size>|<freq>" unit a fileSize field wants for a semantic size word. */
export function fileSizeUnit(field: McpField, semanticUnit: unknown): string | undefined {
  const sizes = field.validSizes?.length
    ? field.validSizes
    : (() => {
      // "{value}|{size}|{frequency} — sizes: [gb, tb], default: ..." as get_service_fields writes it.
      const listed = /sizes:\s*\[([^\]]*)\]/i.exec(field.unitFormat || '')?.[1];
      return listed ? listed.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean) : [];
    })();
  const frequency = (field.defaultUnit || 'gb|NA').split('|')[1] || 'NA';
  const wanted = String(semanticUnit ?? '').trim().toLowerCase();
  const size = sizes.find((entry) => entry.toLowerCase() === wanted)
    // A field with exactly one accepted size cannot be misread, whatever the source wrote.
    ?? (sizes.length === 1 && !wanted ? sizes[0] : undefined);
  return size ? `${size}|${frequency}` : undefined;
}
