/**
 * The executor's two model tiers, behind one function.
 *
 * Every model call the executor makes goes through `askModel`, which is what makes three
 * properties enforceable in one place: the model id comes from the environment through
 * `calculatorModelId` and is never written into a prompt site; the schema/system context is
 * marked for prompt caching so the same `get_service_fields` payload is not re-billed on every
 * resource that shares a service; and each call records which tier and id it used, so a run's
 * diagnostics can show that a clean resource needed no model at all.
 */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

import { calculatorModelId } from '../calculator-orchestrator/model-router';
import type { ExecutorTier } from './types';

export type ModelTier = Exclude<ExecutorTier, 'CODE'>;

export interface ModelRequest {
  tier: ModelTier;
  /** System blocks. `cache: true` marks a block as a prompt-cache breakpoint. */
  system: Array<{ text: string; cache?: boolean }>;
  user: string;
  maxTokens: number;
  timeoutMs?: number;
}

export interface ModelCaller {
  ask(request: ModelRequest): Promise<string>;
  /** Bedrock model ids used so far, by tier, for the diagnostics record. */
  used(): Partial<Record<ModelTier, string>>;
}

const DEFAULT_TIMEOUT_MS = 90_000;
const REGION = process.env.AWS_REGION || 'ap-south-1';

export function bedrockModelCaller(client = new BedrockRuntimeClient({ region: REGION })): ModelCaller {
  const used: Partial<Record<ModelTier, string>> = {};
  return {
    used: () => ({ ...used }),
    async ask(request) {
      const modelId = calculatorModelId(request.tier);
      used[request.tier] = modelId;
      const body: Record<string, unknown> = {
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: request.maxTokens,
        system: request.system.map((block) => ({
          type: 'text',
          text: block.text,
          ...(block.cache ? { cache_control: { type: 'ephemeral' } } : {}),
        })),
        messages: [{ role: 'user', content: [{ type: 'text', text: request.user }] }],
      };
      // Sonnet 5 rejects an explicit temperature; the guard is the same one every other
      // Bedrock call site in this repo uses.
      if (!modelId.includes('claude-sonnet-5')) body.temperature = 0;

      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const startedAt = Date.now();
      try {
        const response = await client.send(new InvokeModelCommand({
          modelId,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify(body),
        }), { abortSignal: abort.signal });
        const payload = JSON.parse(new TextDecoder().decode(response.body));
        const text = (payload?.content ?? [])
          .filter((block: { type?: string }) => block?.type === 'text')
          .map((block: { text?: string }) => block.text || '')
          .join('\n')
          .trim();
        console.log(JSON.stringify({
          event: 'mcp_executor_model_call',
          tier: request.tier,
          modelId,
          latencyMs: Date.now() - startedAt,
          inputTokens: payload?.usage?.input_tokens,
          cacheReadTokens: payload?.usage?.cache_read_input_tokens,
          cacheWriteTokens: payload?.usage?.cache_creation_input_tokens,
          outputTokens: payload?.usage?.output_tokens,
        }));
        return text;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Pulls the first balanced JSON object out of a model reply, fenced or not. */
export function parseJsonObject(text: string): Record<string, unknown> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('the model reply contained no JSON object');
  const parsed = JSON.parse(candidate.slice(start, end + 1));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('the model reply was not a JSON object');
  return parsed as Record<string, unknown>;
}
