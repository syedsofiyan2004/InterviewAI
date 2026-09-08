/**
 * `get_workbook_evidence` — MIMO's own MCP tool, exposed to the Harness through a
 * second AgentCore Gateway target.
 *
 * This is the escape valve that makes "chunk, never truncate" true. When a workbook is
 * too large to inline, the agent receives the WorkbookEvidenceIndex and calls this tool
 * to pull the rows it still needs — by chunk, by sheet, by row range, by environment or
 * by fiscal period. Nothing cost-relevant is ever dropped for token reasons; it is
 * simply not sent *yet*.
 *
 * Paging contract: rows are returned WHOLE CHUNK BY WHOLE CHUNK. A chunk appears in
 * returnedChunks only when every selected row in it was returned; when the response
 * budget cannot hold the next complete chunk, the tool stops before it and replies with
 * nextChunkId set to that chunk, so the caller asks for it alone and receives it
 * complete. An oversized chunk (a single unusually large row) is streamed with an exact
 * nextRowsFrom cursor instead. Follow returnedChunks / moreAvailable / nextChunkId /
 * nextRowsFrom until moreAvailable is false — that is the only way to read every row,
 * and it never skips or duplicates one.
 *
 * Ownership: this tool's schema is MIMO's to define, because the evidence is MIMO's.
 * That is the opposite of the Calculator tools, whose schemas belong to the Pricing
 * Calculator MCP and must never be hand-copied into this repo.
 *
 * The Gateway invokes a Lambda target with the tool's arguments as the event and the
 * tool name in the client context. The exact envelope has varied between AgentCore
 * revisions, so `readInvocation` accepts the shapes seen in the wild rather than
 * assuming one and failing opaquely — a tool that cannot read its own arguments looks
 * to the agent like an empty workbook.
 */

import { getFileBuffer } from '../shared/aws.js';
import {
  evidenceIndexKey,
  type EvidenceRow,
  type WorkbookEvidenceIndex,
} from '../shared/workbook-evidence.js';

const BUCKET_NAME = process.env.BUCKET_NAME!;

/** Ceiling on one tool response, so a request for "everything" still returns. */
const MAX_RESPONSE_BYTES = 180_000;

interface EvidenceRequest {
  calculationId?: string;
  chunkId?: string;
  sheet?: string;
  rowsFrom?: number;
  rowsTo?: number;
  environment?: string;
  fiscalPeriod?: string;
  /** Only rows classified as billable evidence. Useful once the agent is reconciling. */
  costRelevantOnly?: boolean;
}

interface LambdaContext {
  clientContext?: { custom?: Record<string, string> };
}

/**
 * The owner id is NOT taken from the agent. It is resolved from the calculation record
 * so that a prompt-injected calculationId cannot be used to read another tenant's
 * evidence — the agent supplies the id, MIMO decides whose bucket prefix it maps to.
 */
async function resolveOwner(calculationId: string): Promise<string> {
  const { ddbDocClient } = await import('../shared/aws.js');
  const { GetCommand } = await import('@aws-sdk/lib-dynamodb');
  const result = await ddbDocClient.send(new GetCommand({
    TableName: process.env.CALCULATOR_TABLE_NAME!,
    Key: { calculation_id: calculationId },
    ProjectionExpression: 'owner_user_id',
  }));
  const owner = (result.Item as { owner_user_id?: string } | undefined)?.owner_user_id;
  if (!owner) throw new Error(`No calculation ${calculationId}`);
  return owner;
}

function readInvocation(event: unknown, context: LambdaContext): { tool: string; args: EvidenceRequest } {
  const custom = context.clientContext?.custom ?? {};
  const tool = custom.bedrockAgentCoreToolName
    || custom.toolName
    || (event as { toolName?: string })?.toolName
    || (event as { name?: string })?.name
    || 'get_workbook_evidence';

  const body = event as Record<string, unknown> | undefined;
  const args = (body?.arguments ?? body?.input ?? body?.parameters ?? body ?? {}) as Record<string, unknown>;

  const int = (value: unknown): number | undefined => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  return {
    // Gateway tool names arrive prefixed as `<target>___<tool>`.
    tool: String(tool).split('___').pop()!,
    args: {
      calculationId: typeof args.calculationId === 'string' ? args.calculationId : undefined,
      chunkId: args.chunkId !== undefined ? String(args.chunkId).padStart(4, '0') : undefined,
      sheet: typeof args.sheet === 'string' ? args.sheet : undefined,
      rowsFrom: int(args.rowsFrom),
      rowsTo: int(args.rowsTo),
      environment: typeof args.environment === 'string' ? args.environment : undefined,
      fiscalPeriod: typeof args.fiscalPeriod === 'string' ? args.fiscalPeriod : undefined,
      costRelevantOnly: args.costRelevantOnly === true || args.costRelevantOnly === 'true',
    },
  };
}

const readJson = async <T>(key: string): Promise<T> =>
  JSON.parse((await getFileBuffer(BUCKET_NAME, key)).toString('utf8')) as T;

/** Chunks matching the filters, in workbook order. */
function selectChunks(index: WorkbookEvidenceIndex, request: EvidenceRequest) {
  return index.chunks.filter((chunk) => {
    if (request.chunkId && chunk.chunkId !== request.chunkId) return false;
    if (request.sheet && chunk.sheet.toLowerCase() !== request.sheet.toLowerCase()) return false;
    // Row-range filters select any chunk that OVERLAPS the range, then rows are
    // filtered exactly below. Selecting only fully-contained chunks would silently
    // drop the partial chunk at each end of the range.
    if (request.rowsFrom !== undefined && chunk.rowsTo < request.rowsFrom) return false;
    if (request.rowsTo !== undefined && chunk.rowsFrom > request.rowsTo) return false;
    if (request.environment
      && !chunk.environmentHints.some((hint) => hint.toLowerCase().includes(request.environment!.toLowerCase()))) return false;
    if (request.fiscalPeriod
      && !chunk.fiscalPeriodHints.some((hint) => hint.toLowerCase().includes(request.fiscalPeriod!.toLowerCase()))) return false;
    return true;
  });
}

export const handler = async (event: unknown, context: LambdaContext): Promise<unknown> => {
  // Logged in full once per call: the Gateway→Lambda envelope is the one part of this
  // path not pinned by a published schema, and this is how a shape change is diagnosed.
  console.log(JSON.stringify({
    event: 'evidence_tool_invoked',
    rawEvent: JSON.stringify(event).slice(0, 2000),
    clientContext: context.clientContext ?? null,
  }));

  try {
    const { tool, args } = readInvocation(event, context);
    if (tool !== 'get_workbook_evidence') {
      return { error: `Unknown tool "${tool}".` };
    }
    if (!args.calculationId) {
      return { error: 'calculationId is required.' };
    }

    const owner = await resolveOwner(args.calculationId);
    const index = await readJson<WorkbookEvidenceIndex>(evidenceIndexKey(owner, args.calculationId));
    const selected = selectChunks(index, args);

    const rows: EvidenceRow[] = [];
    // Chunks returned IN FULL. A chunk is listed only once every selected row in it
    // has actually been returned — never because part of it happened to fit. This is
    // what keeps paging lossless: a chunk the reply does not name is a chunk the
    // caller must still ask for whole, so no row is skipped or returned twice.
    const returnedChunks: string[] = [];
    let responseBytes = 0;
    // Cursor state. `stoppedAtChunk` names the next chunk to ask for; when that chunk
    // had to be split row-by-row (an oversized chunk), `stoppedRowsFrom` is the exact
    // first unread row inside it, so a resume never re-reads or skips a row.
    let stoppedAtChunk: string | undefined;
    let stoppedRowsFrom: number | undefined;

    const { classifyRow } = await import('../shared/workbook-evidence.js');
    const rowSize = (row: EvidenceRow) => Buffer.byteLength(JSON.stringify(row), 'utf8');
    const selectedBy = (row: EvidenceRow) => {
      if (args.rowsFrom !== undefined && row.rowNumber < args.rowsFrom) return false;
      if (args.rowsTo !== undefined && row.rowNumber > args.rowsTo) return false;
      if (args.costRelevantOnly && classifyRow(row.cells) !== 'cost-relevant') return false;
      return true;
    };

    for (const ref of selected) {
      const chunk = await readJson<{ rows: EvidenceRow[] }>(ref.s3Key);
      const filtered = chunk.rows.filter(selectedBy);
      if (filtered.length === 0) continue; // nothing in this chunk matches the request

      const chunkBytes = filtered.reduce((sum, row) => sum + rowSize(row), 0);

      if (responseBytes + chunkBytes <= MAX_RESPONSE_BYTES) {
        // The COMPLETE (filtered) chunk fits — return it whole. Normal chunks are
        // bounded well under the response ceiling, so paging never splits a chunk:
        // the caller receives all of it or is told to ask for it again by chunk id.
        for (const row of filtered) {
          rows.push(row);
          responseBytes += rowSize(row);
        }
        returnedChunks.push(ref.chunkId);
        continue;
      }

      if (chunkBytes > MAX_RESPONSE_BYTES && returnedChunks.length === 0) {
        // An oversized chunk (an unusually large row is still packed into its own
        // chunk) reached the response first. It can never fit whole, but no row may
        // be discarded: stream it with an exact row cursor so a follow-up call
        // resumes at the first unread row. A single row that itself exceeds the
        // ceiling is still returned whole rather than dropped.
        for (const row of filtered) {
          const size = rowSize(row);
          if (rows.length > 0 && responseBytes + size > MAX_RESPONSE_BYTES) {
            stoppedAtChunk = ref.chunkId;
            stoppedRowsFrom = row.rowNumber;
            break;
          }
          rows.push(row);
          responseBytes += size;
        }
        if (stoppedAtChunk === undefined) returnedChunks.push(ref.chunkId);
        break;
      }

      // The whole chunk does not fit in what remains of this response after the
      // chunks already returned. Stop BEFORE consuming it and name it as the next
      // page: a request for just this chunk returns it complete. The chunk is not
      // marked returned and no row of it is read, so the next call neither skips
      // nor duplicates anything.
      stoppedAtChunk = ref.chunkId;
      break;
    }

    const payload = {
      calculationId: args.calculationId,
      fileName: index.fileName,
      matchedChunks: selected.map((ref) => ref.chunkId),
      returnedChunks,
      returnedRowCount: rows.length,
      moreAvailable: stoppedAtChunk !== undefined,
      ...(stoppedAtChunk ? { nextChunkId: stoppedAtChunk } : {}),
      ...(stoppedRowsFrom !== undefined ? { nextRowsFrom: stoppedRowsFrom } : {}),
      ...(stoppedAtChunk
        ? { note: 'Response size limit reached. Call get_workbook_evidence again with the returned nextChunkId (and nextRowsFrom when present) to receive the remaining rows. Rows are never discarded or duplicated.' }
        : {}),
      availableSheets: index.sheets.map((sheet) => ({ name: sheet.name, rowCount: sheet.rowCount })),
      detectedEnvironments: index.detectedEnvironments,
      detectedFiscalPeriods: index.detectedFiscalPeriods,
      rows,
    };

    // Returned as a plain JSON object rather than an MCP { content: [...] } envelope.
    // The Gateway wraps a Lambda target's return value itself, and a plain object stays
    // legible to the model either way; double-wrapping an envelope would not.
    return payload;
  } catch (error) {
    const message = (error as Error).message || 'Unknown error';
    console.error(JSON.stringify({ event: 'evidence_tool_error', error: message }));
    return { error: `get_workbook_evidence failed: ${message}` };
  }
};

// One definition, shared with the CDK construct that advertises it to the Gateway.
export { GET_WORKBOOK_EVIDENCE_TOOL } from './tool-schema.js';
