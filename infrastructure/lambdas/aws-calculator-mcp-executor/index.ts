/**
 * The AWS MCP Estimate Executor.
 *
 * One entry point, `executeScenario`, that every estimate goes through. It is handed semantic
 * resources and one pricing intent and it drives the AWS Pricing Calculator MCP through the
 * tools that MCP actually exposes: discover → resolve each service → read its schema → map
 * (code first, a model only when code cannot) → prove each resource in a scratch estimate →
 * add the proven configurations to the scenario estimate → validate → export → read back →
 * render totals → verify. Every step leaves a record in the diagnostics.
 *
 * Why a scratch estimate per resource. `add_service` appends and there is no tool to remove or
 * replace a service, so a resource whose configuration the linter refuses cannot be fixed in
 * place once it is in the scenario estimate. Proving it alone first costs two extra invokes
 * and buys the guarantee that the scenario estimate only ever receives configurations that
 * have already passed validation — no orphaned half-estimates, no ordering for a retry to get
 * wrong.
 *
 * Why the corrections are bounded at two per resource. The old agent loop sent the whole
 * workbook around a model until a clock ran out; four consecutive live runs died that way. A
 * resource here gets at most three attempts, each targeted by the MCP's own refusal, and a
 * resource that still fails is reported by name so the next step is a decision, not a retry.
 */

import { createHash } from 'crypto';

import { fetchServiceDefinition, type ServiceDefinition } from '../calculator-orchestrator/calculator-definitions';
import { mapDeterministically } from './field-mapping';
import { bedrockModelCaller, type ModelCaller } from './model-calls';
import { mixedPricingScope, resolvePricing } from './pricing-intent';
import { applyStructuredHint, modelMap } from './repair';
import { resolveService, serviceFields, type ResolutionContext } from './service-resolution';
import { discoverTools, missingEssentialTools } from './tool-discovery';
import type {
  DiscoveredTools,
  ExecutorInput,
  ExecutorProgress,
  ExecutorResult,
  ExecutorTier,
  McpGateway,
  PricingResolution,
  RenderedTotals,
  ResourceAttempt,
  ResourceOutcome,
  SemanticResource,
} from './types';
import { verifyEstimate } from './verification';

export type {
  ExecutorInput,
  ExecutorResult,
  ExecutorStatus,
  McpGateway,
  PricingIntent,
  PricingResolution,
  ResourceOutcome,
  SemanticResource,
} from './types';

export interface ExecutorOptions {
  onProgress?: ExecutorProgress;
  /** Model caller. Defaults to Bedrock; tests pass a fake. Unset models means no model tier. */
  models?: ModelCaller | null;
  /** Definition reader. Defaults to the live Calculator CDN; tests pass fixtures. */
  fetchDefinition?: (serviceCode: string) => Promise<ServiceDefinition | undefined>;
  buildSha?: string;
  /** Resources proven in parallel. */
  concurrency?: number;
  /** Corrections after the first attempt, per resource. */
  maxCorrections?: number;
}

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

/** A group name calculator.aws keeps: no slashes, bounded, never empty. */
const groupNameFor = (resource: SemanticResource) => (resource.environment || resource.scenario || 'Resources')
  .replace(/\//g, '-').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Resources';

/** JSON if the text is JSON, else undefined. Tool replies are sometimes wrapped in prose. */
const jsonOf = (text: string): Record<string, unknown> | undefined => {
  const start = text.search(/[[{]/);
  if (start < 0) return undefined;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return undefined;
  }
};

/** add_service reports per-service failures inside a success envelope; both are read. */
function addServiceError(result: { text: string; isError: boolean }): string | undefined {
  if (result.isError) return result.text;
  const parsed = jsonOf(result.text);
  const entries: unknown[] = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { results?: unknown[] })?.results) ? (parsed as { results: unknown[] }).results : parsed ? [parsed] : [];
  for (const entry of entries) {
    const record = entry as { error?: unknown; success?: boolean } | undefined;
    if (record && (record.error || record.success === false)) return typeof record.error === 'string' ? record.error : JSON.stringify(record);
  }
  return undefined;
}

/** Field types whose value is a number the customer must state; never defaulted, never invented. */
const QUANTITY_FIELD_TYPES = new Set(['frequency', 'fileSize', 'durationInput', 'numericInput', 'workload', 'throughput']);

async function withConcurrency<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  }));
  return results;
}

export async function executeScenario(input: ExecutorInput, gateway: McpGateway, options: ExecutorOptions = {}): Promise<ExecutorResult> {
  const startedAt = Date.now();
  const toolCalls: Array<{ tool: string; isError: boolean; durationMs: number }> = [];
  const modelsUsed: Record<string, string> = {};
  const models: ModelCaller | undefined = options.models === null ? undefined : (options.models ?? bedrockModelCaller());
  const fetchDefinition = options.fetchDefinition ?? fetchServiceDefinition;
  const maxCorrections = options.maxCorrections ?? 2;
  const progress = async (stage: string, message: string) => { await options.onProgress?.({ stage, message }); };

  const call = async (tool: string, args: Record<string, unknown>, timeoutMs = 90_000) => {
    const began = Date.now();
    const result = await gateway.callTool(tool, args, timeoutMs);
    toolCalls.push({ tool, isError: result.isError, durationMs: Date.now() - began });
    return result;
  };

  const canonicalInputHash = createHash('sha256').update(stableStringify(input)).digest('hex');
  const finish = (partial: Omit<ExecutorResult, 'diagnostics'>, tools: DiscoveredTools | undefined, extra: { estimateId?: string; validation?: unknown; totals: RenderedTotals }): ExecutorResult => ({
    ...partial,
    diagnostics: {
      MIMO_BUILD_SHA: options.buildSha || process.env.BUILD_SHA || process.env.CODEBUILD_RESOLVED_SOURCE_VERSION || 'unknown',
      MCP_VERSION: tools?.mcpVersion,
      MCP_TOOL_LIST_HASH: tools?.toolListHash || '',
      MCP_TOOLS: tools?.all || [],
      canonicalInputHash,
      scenarioId: input.scenarioId,
      modelsUsed,
      modelIds: models?.used() || {},
      perResourceAttempts: Object.fromEntries(partial.resources.map((outcome) => [outcome.resourceId, outcome.attempts])),
      mcpValidationOutput: extra.validation,
      estimateId: extra.estimateId,
      calculatorUrl: partial.calculatorUrl,
      totals: extra.totals,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      toolCalls,
    },
  });
  const noTotals: RenderedTotals = { source: 'none' };

  // --- 1. Discover the tool surface. ------------------------------------------------
  await progress('connecting', 'Discovering AWS Pricing Calculator MCP tools');
  const tools = await discoverTools(gateway);
  const missingTools = missingEssentialTools(tools);
  if (missingTools.length) {
    return finish({
      status: 'FAILED', scenarioId: input.scenarioId, totals: noTotals, resources: [], pricing: [], findings: [{ check: 'mcp-validation', severity: 'critical', message: `The installed MCP exposes no tool for: ${missingTools.join(', ')}.` }],
      summary: 'The MCP server does not expose the tools needed to build an estimate.',
    }, tools, { totals: noTotals });
  }

  const ctx: ResolutionContext = {
    gateway,
    tools,
    models,
    record: (tool, isError, durationMs) => toolCalls.push({ tool, isError, durationMs }),
    searchCache: new Map(),
    fieldsCache: new Map(),
  };
  const definitions = new Map<string, Promise<ServiceDefinition | undefined>>();
  const definitionFor = (code: string) => {
    if (!definitions.has(code)) definitions.set(code, fetchDefinition(code).catch(() => undefined));
    return definitions.get(code)!;
  };

  // --- 2. Prove every resource on its own. -------------------------------------------
  await progress('mapping', `Configuring ${input.resources.length} resource(s) against the Calculator schema`);
  const partition = input.partition || 'aws';

  const proveOne = async (resource: SemanticResource): Promise<ResourceOutcome> => {
    const outcome: ResourceOutcome = { resourceId: resource.resourceId, service: resource.service, status: 'FAILED', attempts: [], tiers: [], notes: [] };
    const step = (name: string, tier: ExecutorTier | 'STRUCTURED_HINT') => { modelsUsed[`${name}:${resource.resourceId}`] = tier; };

    // A transport fault while resolving one service is that resource's failure, not the run's:
    // the other resources still deserve their estimate.
    const resolved = await resolveService(ctx, resource).catch((error: Error) => ({ error: `service resolution failed: ${error.message.slice(0, 300)}` }));
    if ('error' in resolved) {
      outcome.notes.push(resolved.error);
      outcome.attempts.push({ attempt: 1, producedBy: 'CODE', config: {}, error: resolved.error });
      return outcome;
    }
    outcome.serviceCode = resolved.serviceCode;
    outcome.notes.push(...resolved.notes);
    step('service', resolved.tier);
    if (resolved.tier !== 'CODE') outcome.tiers.push(resolved.tier);

    const payload = resolved.payload;
    const definition = await definitionFor(resolved.serviceCode);
    const intent = resource.pricing ?? input.pricing;
    const mapping0 = mapDeterministically(resource, payload, definition, resolvePricing(payload, resource, intent));
    // Pricing is resolved once the column form (if any) is known, so the TermType cells land
    // in the form the resource is actually configured through.
    const pricing = resolvePricing(payload, resource, intent, mapping0.columnForm);
    const mapping = mapDeterministically(resource, payload, definition, pricing);
    outcome.pricing = pricing.resolution;
    if (Object.keys(mapping.defaultsApplied).length) outcome.notes.push(`AWS defaults applied: ${JSON.stringify(mapping.defaultsApplied)}`);
    outcome.notes.push(...mapping.notes);

    let config: Record<string, unknown>;
    if (mapping.confident) {
      config = mapping.config;
      step('map', 'CODE');
    } else if (mapping.missingInputs.length && !models) {
      outcome.status = 'MISSING_INPUT';
      outcome.missingInputs = mapping.missingInputs;
      return outcome;
    } else {
      // A required quantity code could not place is only MISSING when the resource carries
      // nothing a model could place there either. "50,000 monthly active users" is a usage
      // figure code cannot assign to a field, but a model reading the schema can; only if it
      // still cannot is the customer asked.
      const modelMightPlace = mapping.unmapped.length > 0 || Object.keys(mapping.ambiguous).length > 0;
      if (mapping.missingInputs.length && !modelMightPlace) {
        outcome.status = 'MISSING_INPUT';
        outcome.missingInputs = mapping.missingInputs;
        return outcome;
      }
      if (!models) {
        outcome.notes.push(`deterministic mapping was not confident (unmapped: ${mapping.unmapped.join(', ') || 'none'}; ambiguous: ${JSON.stringify(mapping.ambiguous)}) and no model tier is configured`);
        outcome.attempts.push({ attempt: 1, producedBy: 'CODE', config: mapping.config, error: 'not confident and no model available' });
        return outcome;
      }
      let mapped: { config: Record<string, unknown>; unresolved: string[] } | undefined;
      for (const tier of ['HAIKU_4_5', 'SONNET_4_6'] as const) {
        try {
          mapped = await modelMap(models, { tier, resource, intent, payload, definition, pricing });
          if (mapped.unresolved.length && tier === 'HAIKU_4_5') { mapped = undefined; continue; }
          step('map', tier);
          outcome.tiers.push(tier);
          break;
        } catch (error) {
          outcome.notes.push(`${tier} mapping rejected: ${(error as Error).message}`);
        }
      }
      if (!mapped) {
        if (mapping.missingInputs.length) {
          outcome.status = 'MISSING_INPUT';
          outcome.missingInputs = mapping.missingInputs;
          return outcome;
        }
        outcome.attempts.push({ attempt: 1, producedBy: 'SONNET_4_6', config: mapping.config, error: 'no model produced a schema-valid configuration' });
        return outcome;
      }
      if (mapped.unresolved.length) outcome.notes.push(`unresolved by the model: ${mapped.unresolved.join('; ')}`);
      // Whatever the model placed, a required quantity still absent is the customer's to state.
      const stillMissing = mapping.missingInputs.filter((label) => {
        const field = (payload.fields || []).find((entry) => entry.label === label || entry.id === label);
        return field ? !(field.id in mapped!.config) : true;
      });
      if (stillMissing.length) {
        outcome.status = 'MISSING_INPUT';
        outcome.missingInputs = stillMissing;
        return outcome;
      }
      config = mapped.config;
    }

    // Prove it: scratch estimate → add → validate. Repeat with corrections, bounded.
    let producedBy: ResourceAttempt['producedBy'] = mapping.confident ? 'CODE' : outcome.tiers[outcome.tiers.length - 1] || 'CODE';
    for (let attempt = 1; attempt <= maxCorrections + 1; attempt++) {
      const record: ResourceAttempt = { attempt, producedBy, config };
      outcome.attempts.push(record);
      const created = await call(tools.create!, { name: `MIMO probe ${resource.resourceId}`, partition }, 60_000);
      const probeId = jsonOf(created.text)?.estimate_id as string | undefined;
      if (created.isError || !probeId) {
        record.error = `create_estimate failed: ${created.text.slice(0, 300)}`;
        record.failedAt = 'add';
        return outcome;
      }
      const added = await call(tools.add!, { estimate_id: probeId, services: JSON.stringify([{ service: resolved.serviceCode, group: groupNameFor(resource), config }]) }, 120_000);
      let error = addServiceError(added);
      let failedAt: ResourceAttempt['failedAt'] = error ? 'add' : undefined;
      if (!error) {
        const validated = await call(tools.validate!, { estimate_id: probeId }, 120_000);
        const verdict = jsonOf(validated.text);
        if (validated.isError || (verdict?.lint_verdict && verdict.lint_verdict !== 'editable')) {
          error = String(verdict?.next_step || validated.text).slice(0, 2000);
          failedAt = 'validate';
        }
      }
      if (!error) {
        outcome.status = 'ADDED';
        outcome.finalConfig = config;
        return outcome;
      }
      record.error = error;
      record.failedAt = failedAt;

      // "missing required field X" for a quantity the customer never stated is not a
      // configuration error to keep retrying: no model may invent it, so it is a question.
      const requiredMissing = [...error.matchAll(/"([A-Za-z0-9_]+)"/g)]
        .map((match) => match[1])
        .filter((fieldId) => /missing (\d+ )?required field/i.test(error) && !(fieldId in config)
          && (payload.fields || []).some((field) => field.id === fieldId && QUANTITY_FIELD_TYPES.has(field.type)));
      if (requiredMissing.length) {
        outcome.status = 'MISSING_INPUT';
        outcome.missingInputs = requiredMissing.map((fieldId) => (payload.fields || []).find((field) => field.id === fieldId)?.label || fieldId);
        outcome.notes.push(`the Calculator requires ${outcome.missingInputs.join(', ')} and the source states no value for it`);
        return outcome;
      }
      if (attempt > maxCorrections) break;

      const hint = applyStructuredHint(config, error, payload);
      if (hint) {
        config = hint.config;
        producedBy = 'STRUCTURED_HINT';
        outcome.tiers.push('STRUCTURED_HINT');
        outcome.notes.push(hint.note);
        step(`repair${attempt}`, 'STRUCTURED_HINT');
        continue;
      }
      if (!models) break;
      try {
        const repaired = await modelMap(models, { tier: 'SONNET_4_6', resource, intent, payload, definition, pricing, previousConfig: config, error });
        config = repaired.config;
        producedBy = 'SONNET_4_6';
        outcome.tiers.push('SONNET_4_6');
        step(`repair${attempt}`, 'SONNET_4_6');
        if (repaired.unresolved.length) outcome.notes.push(`unresolved by the model: ${repaired.unresolved.join('; ')}`);
      } catch (repairError) {
        outcome.notes.push(`Sonnet repair rejected: ${(repairError as Error).message}`);
        break;
      }
    }
    return outcome;
  };

  const outcomes = await withConcurrency(input.resources, options.concurrency ?? 3, proveOne);
  const pricing: PricingResolution[] = outcomes.map((outcome) => outcome.pricing).filter((entry): entry is PricingResolution => Boolean(entry));
  const proven = outcomes.filter((outcome) => outcome.status === 'ADDED');

  if (!proven.length) {
    return finish({
      status: 'FAILED', scenarioId: input.scenarioId, totals: noTotals, resources: outcomes, pricing,
      pricingScope: mixedPricingScope(pricing, input.pricing),
      findings: verifyEstimate({ resources: input.resources, outcomes, pricing, mcpValidation: { ran: false, passed: false }, totals: noTotals }).findings,
      summary: 'No resource could be configured in the AWS Pricing Calculator.',
    }, tools, { totals: noTotals });
  }

  // --- 3. The scenario estimate, from proven configurations only. -------------------
  await progress('saving', `Building the AWS Calculator estimate from ${proven.length} proven resource(s)`);
  const created = await call(tools.create!, { name: input.estimateName, partition }, 60_000);
  const estimateId = jsonOf(created.text)?.estimate_id as string | undefined;
  if (created.isError || !estimateId) {
    return finish({
      status: 'FAILED', scenarioId: input.scenarioId, totals: noTotals, resources: outcomes, pricing, pricingScope: mixedPricingScope(pricing, input.pricing),
      findings: [{ check: 'mcp-validation', severity: 'critical', message: `create_estimate failed: ${created.text.slice(0, 300)}` }],
      summary: 'The scenario estimate could not be created.',
    }, tools, { totals: noTotals });
  }

  for (const outcome of proven) {
    const resource = input.resources.find((entry) => entry.resourceId === outcome.resourceId)!;
    const added = await call(tools.add!, { estimate_id: estimateId, services: JSON.stringify([{ service: outcome.serviceCode, group: groupNameFor(resource), config: outcome.finalConfig }]) }, 120_000);
    const error = addServiceError(added);
    if (error) {
      // Proven alone, refused in company: recorded as a failed attempt so the reader sees both.
      outcome.status = 'FAILED';
      outcome.attempts.push({ attempt: outcome.attempts.length + 1, producedBy: 'CODE', config: outcome.finalConfig!, error: `add_service to the scenario estimate failed: ${error.slice(0, 500)}`, failedAt: 'add' });
    }
  }

  const validated = await call(tools.validate!, { estimate_id: estimateId }, 120_000);
  const verdict = jsonOf(validated.text);
  const mcpValidation = {
    ran: true,
    passed: !validated.isError && (!verdict?.lint_verdict || verdict.lint_verdict === 'editable'),
    detail: validated.isError ? validated.text : String(verdict?.next_step || ''),
  };

  await progress('exporting', 'Saving the estimate to calculator.aws');
  const exported = await call(tools.export!, { estimate_id: estimateId }, 180_000);
  const exportedJson = jsonOf(exported.text);
  const url = /https:\/\/[^\s"'\\]*calculator\.aws[^\s"'\\]*/.exec(exported.text)?.[0]
    ?? (typeof exportedJson?.sharable_url === 'string' ? exportedJson.sharable_url : undefined);
  const awsEstimateId = typeof exportedJson?.aws_estimate_id === 'string' ? exportedJson.aws_estimate_id : estimateId;
  if (exported.isError || !url) {
    return finish({
      status: 'FAILED', scenarioId: input.scenarioId, totals: noTotals, resources: outcomes, pricing, pricingScope: mixedPricingScope(pricing, input.pricing),
      findings: [{ check: 'url', severity: 'critical', message: `export_estimate produced no calculator.aws URL: ${exported.text.slice(0, 400)}` }],
      summary: 'The estimate could not be saved to calculator.aws.',
    }, tools, { estimateId, validation: verdict, totals: noTotals });
  }

  // --- 4. Read back, render, verify. -------------------------------------------------
  await progress('validating', 'Reading the saved estimate back and rendering its totals');
  let savedEstimate: unknown;
  let readBackError: string | undefined;
  if (tools.import) {
    const imported = await call(tools.import, { estimate_id: url, format: 'json' }, 180_000);
    if (imported.isError) readBackError = imported.text.slice(0, 300);
    else savedEstimate = jsonOf(imported.text);
    if (!savedEstimate && !readBackError) readBackError = 'import_estimate returned no JSON.';
  } else {
    readBackError = 'The installed MCP exposes no import tool.';
  }

  let totals: RenderedTotals = noTotals;
  if (gateway.validateLink) {
    try {
      const rendered = await gateway.validateLink(url);
      if (rendered.validUrl && rendered.monthly !== undefined) {
        totals = { source: 'browser', monthly: rendered.monthly, upfront: rendered.upfront, total12Months: rendered.total12Months };
      }
    } catch (error) {
      console.warn(`Calculator page render failed: ${(error as Error).message}`);
    }
  }

  const verdictOut = verifyEstimate({
    resources: input.resources, outcomes, pricing, mcpValidation, url, savedEstimate, readBackError, totals,
  });
  return finish({
    status: verdictOut.status,
    scenarioId: input.scenarioId,
    estimateId: awsEstimateId,
    calculatorUrl: url,
    totals,
    resources: outcomes,
    pricing,
    pricingScope: mixedPricingScope(pricing, input.pricing),
    findings: verdictOut.findings,
    summary: verdictOut.summary,
    savedEstimate,
  }, tools, { estimateId: awsEstimateId, validation: verdict, totals });
}
