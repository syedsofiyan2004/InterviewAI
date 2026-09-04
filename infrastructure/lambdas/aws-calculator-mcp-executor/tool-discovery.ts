/**
 * Discovers which MCP tools the installed server actually exposes.
 *
 * The executor never assumes a tool name. The upstream package has renamed and added tools
 * between minor versions, and a pinned version is only pinned until somebody bumps it; a
 * hard-coded `'add_service'` is then a runtime error with no diagnostic value. Reading
 * `tools/list` at the start of every run costs one invoke and gives two things back: the
 * names to call, and a hash of the whole list that goes into the run's diagnostics so a
 * failure can be tied to the exact tool surface it ran against.
 */

import { createHash } from 'crypto';

import type { DiscoveredTools, McpGateway } from './types';

/**
 * Role → patterns, most specific first.
 *
 * `update` is listed even though no released version exposes one: the executor asks for the
 * role and routes around its absence (validate in a scratch estimate, then add). When a
 * version ships it, discovery picks it up with no code change.
 */
const ROLE_PATTERNS: Array<[keyof Omit<DiscoveredTools, 'all' | 'toolListHash' | 'mcpVersion'>, RegExp[]]> = [
  ['serverInfo', [/^get_server_info$/, /server[_-]?info/, /^version$/]],
  ['search', [/^search_services$/, /search.*service/, /find.*service/]],
  ['fields', [/^get_service_fields$/, /service.*fields?/, /service.*schema/]],
  ['create', [/^create_estimate$/, /create.*estimate/, /new.*estimate/]],
  ['add', [/^add_service$/, /add.*service/]],
  ['update', [/^update_service$/, /update.*service/, /replace.*service/, /remove.*service/]],
  ['validate', [/^validate_estimate$/, /validate.*estimate/, /lint/]],
  ['export', [/^export_estimate$/, /export.*estimate/, /save.*estimate/]],
  ['import', [/^import_estimate$/, /import.*estimate/, /read.*estimate/, /^get_estimate$/]],
];

/** Picks one tool for a role: first pattern that matches any tool wins. */
function pick(names: string[], patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const hit = names.find((name) => pattern.test(name));
    if (hit) return hit;
  }
  return undefined;
}

export function assignRoles(names: string[]): Omit<DiscoveredTools, 'mcpVersion'> {
  const roles: Partial<DiscoveredTools> = {};
  for (const [role, patterns] of ROLE_PATTERNS) {
    const name = pick(names, patterns);
    if (name) (roles as Record<string, string>)[role] = name;
  }
  return {
    ...roles,
    all: [...names],
    toolListHash: createHash('sha256').update([...names].sort().join('\n')).digest('hex'),
  };
}

/** Reads the server's own version out of its info tool, or undefined when it has none. */
async function readVersion(gateway: McpGateway, tool: string | undefined): Promise<string | undefined> {
  if (!tool) return undefined;
  try {
    const result = await gateway.callTool(tool, {}, 30_000);
    if (result.isError) return undefined;
    const parsed = JSON.parse(result.text);
    const version = parsed?.version;
    const name = parsed?.name;
    return version ? (name ? `${name}@${version}` : String(version)) : undefined;
  } catch {
    return undefined;
  }
}

export async function discoverTools(gateway: McpGateway): Promise<DiscoveredTools> {
  const listed = await gateway.listTools();
  const names = listed.map((tool) => tool.name);
  const roles = assignRoles(names);
  const mcpVersion = await readVersion(gateway, roles.serverInfo);
  return { ...roles, ...(mcpVersion ? { mcpVersion } : {}) };
}

/**
 * The roles a run cannot proceed without. `update` is deliberately absent; `import` is
 * optional too, because a saved estimate without a read-back is still an estimate — it just
 * cannot be verified, which the verifier reports as NEEDS_REVIEW rather than as a failure.
 */
export function missingEssentialTools(tools: DiscoveredTools): string[] {
  const essential: Array<keyof DiscoveredTools> = ['search', 'fields', 'create', 'add', 'validate', 'export'];
  return essential.filter((role) => !tools[role]).map(String);
}
