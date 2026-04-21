/**
 * Robust JSON extraction for AI responses.
 * Handles:
 * 1. Markdown fences (```json ... ```)
 * 2. Conversational preambles/post-scripts
 * 3. Thinking blocks (<thinking>...</thinking>)
 * 4. Nested objects via brace counting
 */
export function extractJson(text: string): string {
  if (!text) return '';

  // 1. Remove XML-style thinking blocks if present
  let cleanText = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();
  
  // 2. Remove markdown fences if present
  cleanText = cleanText.replace(/```(?:json)?\s*([\s\S]*?)\s*```/gi, '$1').trim();

  // 3. Find the first '{'
  const firstBrace = cleanText.indexOf('{');
  if (firstBrace === -1) {
    console.warn('[extractJson] No opening brace found in text');
    return '';
  }

  // 4. Trace the matching closing brace
  let braceCount = 0;
  let inString = false;
  let escapeNext = false;
  
  for (let i = firstBrace; i < cleanText.length; i++) {
    const char = cleanText[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{') braceCount++;
      if (char === '}') braceCount--;

      if (braceCount === 0) {
        // Found the matching end brace
        return cleanText.substring(firstBrace, i + 1);
      }
    }
  }

  console.warn('[extractJson] No matching closing brace found');
  return '';
}
