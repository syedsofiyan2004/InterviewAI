import pdf from 'pdf-parse';
import mammoth from 'mammoth';

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

  // 2. Aggressively remove markdown fences anywhere in the block
  let cleanText = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();
  cleanText = cleanText.replace(/```(?:json)?\s*([\s\S]*?)\s*```/gi, '$1').trim();
  
  // 3. Find the first '{' - but also check for any leading markdown junk that might have survived
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

/**
 * Professional-grade text extraction from binary buffers.
 * Supports: TXT, PDF, DOCX
 */
export async function extractTextFromBuffer(buffer: Buffer, fileName: string): Promise<string> {
  const extension = fileName.split('.').pop()?.toLowerCase();

  // 1. Handle Plain Text
  if (extension === 'txt') {
    return buffer.toString('utf-8');
  }

  // 2. Handle PDF (Professional Parsing)
  if (extension === 'pdf') {
    try {
      const data = await pdf(buffer);
      return data.text;
    } catch (err: any) {
      console.error('[extractTextFromBuffer] PDF Parse failed:', err.message);
      throw new Error('PDF_PARSE_FAILED');
    }
  }

  // 3. Handle DOCX (Professional Parsing)
  if (extension === 'docx') {
    try {
       const result = await mammoth.extractRawText({ buffer });
       return result.value;
    } catch (err: any) {
      console.error('[extractTextFromBuffer] DOCX Parse failed:', err.message);
      throw new Error('DOCX_PARSE_FAILED');
    }
  }

  throw new Error(`UNSUPPORTED_FORMAT: .${extension}`);
}
