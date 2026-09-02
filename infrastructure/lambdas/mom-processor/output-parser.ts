import { jsonrepair } from 'jsonrepair';
import { MomResult, MomResultSchema } from '../../schema/mom.js';
import { extractJson } from '../shared/utils.js';

export type MomOutputErrorKind = 'empty' | 'syntax' | 'validation' | 'truncated';

export class MomOutputError extends Error {
  constructor(
    public readonly kind: MomOutputErrorKind,
    public readonly diagnostics: {
      stopReason: string;
      contentTypes: string;
      outputChars: number;
      issuePaths?: string[];
    },
  ) {
    super(`MOM model output was ${kind}.`);
    this.name = 'MomOutputError';
  }
}

type BedrockTextBlock = { type?: string; text?: unknown };

type BedrockPayload = {
  content?: BedrockTextBlock[];
  stop_reason?: unknown;
};

export function parseMomModelOutput(payload: BedrockPayload): {
  value: MomResult;
  repaired: boolean;
} {
  const content = Array.isArray(payload.content) ? payload.content : [];
  const text = content
    .filter((block): block is BedrockTextBlock & { text: string } => (
      block.type === 'text' && typeof block.text === 'string'
    ))
    .map(block => block.text)
    .join('\n');
  const diagnostics = {
    stopReason: String(payload.stop_reason || 'unknown'),
    contentTypes: content.map(block => block.type || 'unknown').join(',') || 'none',
    outputChars: text.length,
  };
  if (diagnostics.stopReason.toLowerCase() === 'max_tokens') {
    throw new MomOutputError('truncated', diagnostics);
  }
  const tagged = text.match(/<mom_json>([\s\S]*?)<\/mom_json>/i)?.[1]?.trim();
  const jsonText = tagged || extractJson(text);

  if (!jsonText) {
    throw new MomOutputError('empty', diagnostics);
  }

  let parsed: unknown;
  let repaired = false;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    try {
      parsed = JSON.parse(jsonrepair(jsonText));
      repaired = true;
    } catch {
      throw new MomOutputError('syntax', diagnostics);
    }
  }

  const validation = MomResultSchema.safeParse(parsed);
  if (!validation.success) {
    throw new MomOutputError('validation', {
      ...diagnostics,
      issuePaths: validation.error.issues
        .slice(0, 20)
        .map(issue => issue.path.join('.') || 'root'),
    });
  }

  return { value: validation.data, repaired };
}
