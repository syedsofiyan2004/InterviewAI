/**
 * A semantic service name to the Calculator service key it is configured under.
 *
 * "AWS Fargate" → `awsFargate` is a search and an exact name match: code, no model. The cases
 * that need more are the Calculator's own quirks, read from its answers rather than remembered:
 * a parent envelope that redirects to its children (`amazonS3` → `amazonS3Standard`,
 * `awsS3DataTransfer`), or a catalog trap that says a service must be configured under a
 * different key than the one search returns. When the answer is still ambiguous — several
 * candidates, none an exact match — Haiku chooses from the list, and only from the list.
 */

import type { DiscoveredTools, ExecutorTier, McpGateway, SemanticResource } from './types';
import { parseFieldsPayload, type McpFieldsPayload } from './mcp-schema';
import { parseJsonObject, type ModelCaller } from './model-calls';

export interface ServiceCandidate {
  key: string;
  name: string;
}

export interface ResolvedService {
  serviceCode: string;
  serviceName: string;
  payload: McpFieldsPayload;
  tier: ExecutorTier;
  notes: string[];
}

export interface ResolutionContext {
  gateway: McpGateway;
  tools: DiscoveredTools;
  models?: ModelCaller;
  /** Records one tool call for the diagnostics trail. */
  record: (tool: string, isError: boolean, durationMs: number) => void;
  searchCache: Map<string, ServiceCandidate[]>;
  fieldsCache: Map<string, McpFieldsPayload>;
}

const normalize = (text: string) => text.toLowerCase()
  .replace(/\b(amazon|aws)\b/g, '')
  .replace(/[^a-z0-9]/g, '');

/** "Amazon S3" as the Calculator would key it: `amazonS3`. A guess, checked before it is used. */
const camelKeyGuess = (name: string) => {
  const words = name.trim().split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!words.length) return undefined;
  return words.map((word, index) => (index === 0 ? word.toLowerCase() : word)).join('');
};

/** True when the payload describes a real service or a redirect to real children. */
const usablePayload = (payload: McpFieldsPayload) => Boolean(payload.fields?.length)
  || payload.status === 'redirect_to_parent'
  || Boolean(payload.child_service_codes?.length);

/** Both shapes search_services returns: a flat list, or a map of term → list. */
function candidatesFrom(text: string): ServiceCandidate[] {
  const start = text.search(/[[{]/);
  if (start < 0) return [];
  const parsed = JSON.parse(text.slice(start));
  const lists: unknown[] = Array.isArray(parsed) ? [parsed] : Object.values(parsed || {});
  const seen = new Map<string, ServiceCandidate>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const key = (entry as { key?: string })?.key;
      const name = (entry as { name?: string })?.name;
      if (key && !seen.has(key)) seen.set(key, { key, name: name || key });
    }
  }
  return [...seen.values()];
}

async function callRecorded(ctx: ResolutionContext, tool: string, args: Record<string, unknown>, timeoutMs = 60_000) {
  const startedAt = Date.now();
  const result = await ctx.gateway.callTool(tool, args, timeoutMs);
  ctx.record(tool, result.isError, Date.now() - startedAt);
  return result;
}

export async function searchServices(ctx: ResolutionContext, query: string): Promise<ServiceCandidate[]> {
  const cached = ctx.searchCache.get(query);
  if (cached) return cached;
  const result = await callRecorded(ctx, ctx.tools.search!, { query });
  const candidates = result.isError ? [] : candidatesFrom(result.text);
  ctx.searchCache.set(query, candidates);
  return candidates;
}

export async function serviceFields(ctx: ResolutionContext, serviceCode: string): Promise<McpFieldsPayload> {
  const cached = ctx.fieldsCache.get(serviceCode);
  if (cached) return cached;
  const result = await callRecorded(ctx, ctx.tools.fields!, { service: serviceCode }, 90_000);
  if (result.isError) throw new Error(`get_service_fields(${serviceCode}) failed: ${result.text.slice(0, 300)}`);
  const payload = parseFieldsPayload(result.text);
  ctx.fieldsCache.set(serviceCode, payload);
  return payload;
}

/** The service key a catalog trap tells callers to use instead, if any trap says so. */
function trapRedirect(payload: McpFieldsPayload): string | undefined {
  for (const trap of payload.catalog?.traps || []) {
    const match = /use servicecode ['"`]([A-Za-z0-9]+)['"`]/i.exec(trap);
    if (match && match[1] !== payload.serviceCode) return match[1];
  }
  return undefined;
}

/** A child of a parent envelope chosen from what the resource is about, or undefined. */
function pickChildDeterministically(children: string[], resource: SemanticResource): string | undefined {
  if (children.length === 1) return children[0];
  const keys = Object.keys(resource.configuration).join(' ').toLowerCase();
  const wantsTransfer = /transfer/.test(keys);
  const wantsStorage = /storage/.test(keys);
  const transfer = children.filter((child) => /transfer/i.test(child));
  const storage = children.filter((child) => !/transfer/i.test(child));
  if (wantsTransfer && !wantsStorage && transfer.length === 1) return transfer[0];
  if (wantsStorage && !wantsTransfer && storage.length === 1) return storage[0];
  return undefined;
}

/** Haiku picks one key from a list; anything not in the list is rejected. */
async function modelPick(
  ctx: ResolutionContext,
  resource: SemanticResource,
  candidates: ServiceCandidate[],
  question: string,
): Promise<{ key: string; tier: ExecutorTier } | undefined> {
  if (!ctx.models || !candidates.length) return undefined;
  const user = `${question}\n\nResource:\n${JSON.stringify(resource, null, 2)}\n\nCandidates (choose exactly one "key"):\n${JSON.stringify(candidates.slice(0, 40))}\n\nReturn ONLY {"key": "<one of the candidate keys>", "why": "<one sentence>"}.`;
  for (const tier of ['HAIKU_4_5', 'SONNET_4_6'] as const) {
    try {
      const reply = await ctx.models.ask({
        tier,
        system: [{ text: 'You choose which AWS Pricing Calculator service key represents a described resource. You may only answer with a key from the candidate list. If none fits, answer {"key": null}.', cache: true }],
        user,
        maxTokens: 200,
      });
      const parsed = parseJsonObject(reply);
      const key = typeof parsed.key === 'string' ? parsed.key : undefined;
      if (key && candidates.some((candidate) => candidate.key === key)) return { key, tier };
    } catch {
      // Fall through to the next tier; an unparseable reply is not a service choice.
    }
  }
  return undefined;
}

/**
 * Resolves one resource's service. Cached per (service name, configuration keys) by the caller.
 */
export async function resolveService(ctx: ResolutionContext, resource: SemanticResource): Promise<ResolvedService | { error: string }> {
  const notes: string[] = [];
  let tier: ExecutorTier = 'CODE';
  const wanted = normalize(resource.service);

  // The Calculator's own key for the name, when it has one. "Amazon S3" is not in search
  // results at all (its parent envelope is deprecated) but get_service_fields("amazonS3")
  // answers with the children to use — the Calculator saying it, not a list of ours.
  let key: string | undefined;
  const guess = camelKeyGuess(resource.service);
  if (guess) {
    try {
      const probe = await serviceFields(ctx, guess);
      if (usablePayload(probe)) key = guess;
    } catch {
      // Not a key the Calculator knows; search decides.
    }
  }

  let candidates = key ? [] : await searchServices(ctx, resource.service);
  const literal = resource.service.trim().toLowerCase();
  // A candidate whose full name IS the service name, vendor word and all, beats one that
  // merely shares its stem: "S3" is not "Amazon S3" when "S3" is what S3 Backup calls itself.
  // A stem match must hold on the key as well as the name: S3 Backup calls itself "S3" but is
  // keyed `amazonS3Backup`, and the key is the half that cannot lie.
  const keyStem = (key: string) => key.toLowerCase().replace(/^(amazon|aws)/, '').replace(/[^a-z0-9]/g, '');
  const exactly = (list: typeof candidates) => {
    const full = list.filter((candidate) => candidate.name.trim().toLowerCase() === literal);
    return full.length ? full : list.filter((candidate) => normalize(candidate.name) === wanted && keyStem(candidate.key) === wanted);
  };
  let exact = exactly(candidates);
  if (!key && !exact.length) {
    // "Amazon EC2" finds nothing but "EC2" does: retry with the vendor prefix stripped.
    const short = resource.service.replace(/\b(Amazon|AWS)\b/gi, '').trim();
    if (short && short !== resource.service) {
      candidates = [...candidates, ...await searchServices(ctx, short)];
      exact = exactly(candidates);
    }
  }
  if (!key && !candidates.length) {
    // "Amazon VPC NAT Gateway" as one phrase finds nothing; "NAT Gateway" does. Each
    // significant word is tried so a model has candidates to choose from rather than none.
    const words = resource.service.replace(/\b(Amazon|AWS)\b/gi, '').split(/[^A-Za-z0-9]+/).filter((word) => word.length > 2);
    for (const word of words) candidates = [...candidates, ...await searchServices(ctx, word)];
    exact = exactly(candidates);
  }
  const unique = [...new Map(candidates.map((candidate) => [candidate.key, candidate])).values()];

  if (!key && exact.length === 1) key = exact[0].key;
  if (!key) {
    if (!unique.length) return { error: `The AWS Pricing Calculator lists no service matching "${resource.service}".` };
    const picked = await modelPick(ctx, resource, unique,
      `Which Calculator service key represents this resource's service "${resource.service}"?`);
    if (!picked) return { error: `"${resource.service}" matched ${unique.length} Calculator services and none exactly: ${unique.slice(0, 8).map((candidate) => candidate.name).join(', ')}.` };
    key = picked.key;
    tier = picked.tier;
    notes.push(`service key ${key} chosen by ${tier} from ${unique.length} candidates`);
  }

  // Follow the Calculator's own redirections, at most a few hops.
  for (let hop = 0; hop < 3; hop++) {
    const payload = await serviceFields(ctx, key);
    const children = payload.child_service_codes || [];
    if (payload.status === 'redirect_to_parent' || children.length) {
      let child = pickChildDeterministically(children, resource);
      if (!child) {
        const picked = await modelPick(ctx, resource, children.map((code) => ({ key: code, name: code })),
          `"${key}" is a parent envelope. Which child service represents this resource?`);
        if (!picked) return { error: `${key} is a parent envelope with children ${children.join(', ')} and none could be chosen for this resource.` };
        child = picked.key;
        tier = picked.tier;
      }
      notes.push(`${key} redirected to child service ${child}`);
      key = child;
      continue;
    }
    const redirect = trapRedirect(payload);
    if (redirect) {
      notes.push(`${key} configured under ${redirect}, as the catalog's own trap instructs`);
      key = redirect;
      continue;
    }
    // The MCP resolves keys case-insensitively but the Calculator's definition CDN does not,
    // so the code the payload states (`aWSLambda`) is the one carried forward, not the guess.
    const serviceCode = payload.serviceCode || key;
    if (serviceCode !== key) ctx.fieldsCache.set(serviceCode, payload);
    return { serviceCode, serviceName: payload.serviceName || serviceCode, payload, tier, notes };
  }
  return { error: `Service resolution for "${resource.service}" did not settle after following the Calculator's redirects.` };
}
