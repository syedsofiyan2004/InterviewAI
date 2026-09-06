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
      return { isError: true, content: [{ type: 'text', text: `Unknown tool "${tool}".` }] };
    }
    if (!args.calculationId) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'calculationId is required.' }],
      };
    }

    const owner = await resolveOwner(args.calculationId);
    const index = await readJson<WorkbookEvidenceIndex>(evidenceIndexKey(owner, args.calculationId));
    const selected = selectChunks(index, args);

    const rows: EvidenceRow[] = [];
    const includedChunks: string[] = [];
    let truncatedForSize = false;
    let responseBytes = 0;

    const { classifyRow } = await import('../shared/workbook-evidence.js');

    for (const ref of selected) {
      const chunk = await readJson<{ rows: EvidenceRow[] }>(ref.s3Key);
      includedChunks.push(ref.chunkId);
      for (const row of chunk.rows) {
        if (args.rowsFrom !== undefined && row.rowNumber < args.rowsFrom) continue;
        if (args.rowsTo !== undefined && row.rowNumber > args.rowsTo) continue;
        if (args.costRelevantOnly && classifyRow(row.cells) !== 'cost-relevant') continue;

        const size = Buffer.byteLength(JSON.stringify(row), 'utf8');
        if (responseBytes + size > MAX_RESPONSE_BYTES) {
          // Response budget reached. This is NOT data loss: the reply names the exact
          // next chunk to ask for, and the rows stay in S3 until requested.
          truncatedForSize = true;
          break;
        }
        rows.push(row);
        responseBytes += size;
      }
      if (truncatedForSize) break;
    }

    const returnedChunks = new Set(includedChunks);
    const remaining = selected.filter((ref) => !returnedChunks.has(ref.chunkId)).map((ref) => ref.chunkId);
    const nextChunkId = truncatedForSize
      ? (remaining[0] ?? includedChunks[includedChunks.length - 1])
      : undefined;

    const payload = {
      calculationId: args.calculationId,
      fileName: index.fileName,
      matchedChunks: selected.map((ref) => ref.chunkId),
      returnedChunks: includedChunks,
      returnedRowCount: rows.length,
      moreAvailable: truncatedForSize || remaining.length > 0,
      ...(nextChunkId ? { nextChunkId } : {}),
      ...(truncatedForSize
        ? { note: 'Response size limit reached. Call get_workbook_evidence again with nextChunkId, or narrow by sheet/rowsFrom/rowsTo, to receive the rest. No rows have been discarded.' }
        : {}),
      availableSheets: index.sheets.map((sheet) => ({ name: sheet.name, rowCount: sheet.rowCount })),
      detectedEnvironments: index.detectedEnvironments,
      detectedFiscalPeriods: index.detectedFiscalPeriods,
      rows,
    };

    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  } catch (error) {
    const message = (error as Error).message || 'Unknown error';
    console.error(JSON.stringify({ event: 'evidence_tool_error', error: message }));
    return { isError: true, content: [{ type: 'text', text: `get_workbook_evidence failed: ${message}` }] };
  }
};

/**
 * The tool schema advertised to the Gateway.
 *
 * Exported so the CDK construct and the tests read the same definition instead of two
 * copies drifting apart.
 */
export const GET_WORKBOOK_EVIDENCE_TOOL = {
  name: 'get_workbook_evidence',
  description: [
    'Fetch customer workbook evidence for this calculation from MIMO.',
    'Use this whenever the evidence you hold may be incomplete: you were given an index',
    'rather than full evidence, a sheet is referenced but not present, or a total does not',
    'reconcile with the rows you can see.',
    'Filter by chunkId, sheet, row range, environment or fiscal period.',
    'If the reply says moreAvailable, call again with nextChunkId until it does not.',
    'Rows are never discarded — anything not returned is still retrievable.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      calculationId: { type: 'string', description: 'The calculation id given to you in the task.' },
      chunkId: { type: 'string', description: 'A chunkId from the evidence index, e.g. "0003".' },
      sheet: { type: 'string', description: 'Restrict to one sheet name.' },
      rowsFrom: { type: 'integer', description: 'First workbook row number to return, inclusive.' },
      rowsTo: { type: 'integer', description: 'Last workbook row number to return, inclusive.' },
      environment: { type: 'string', description: 'Restrict to an environment hint, e.g. "Production".' },
      fiscalPeriod: { type: 'string', description: 'Restrict to a fiscal period hint, e.g. "FY27".' },
      costRelevantOnly: { type: 'boolean', description: 'Return only rows that look like billable lines.' },
    },
    required: ['calculationId'],
  },
} as const;
