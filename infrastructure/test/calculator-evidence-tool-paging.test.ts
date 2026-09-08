/**
 * get_workbook_evidence paging regression (mission Parts 15-18): the tool must never
 * partially consume a normal chunk and never tell the caller to skip unread rows.
 *
 * The bug it guards against: the old loop pushed a chunk id into `returnedChunks` before
 * any of its rows were read, then broke mid-chunk when the response budget ran out, and
 * answered with `nextChunkId` = the chunk AFTER the partially-returned one. Rows at the
 * tail of the current chunk were therefore skipped on the next page — and if the caller
 * re-asked for the "returned" chunk, the already-sent rows were returned a second time.
 *
 * Contract under test:
 *   - A chunk is returned whole or not at all; `returnedChunks` lists only complete chunks.
 *   - When the next complete chunk would overflow, the tool stops BEFORE it and sets
 *     nextChunkId to THAT chunk (not the one after), so a follow-up call returns it whole.
 *   - An oversized chunk is streamed with an exact nextRowsFrom cursor; a follow-up call
 *     passes it as rowsFrom, so the union of pages equals the source exactly.
 *
 * Classification: MOCKED.
 */

import * as awsShared from '../lambdas/shared/aws';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { GetCommand } from '@aws-sdk/lib-dynamodb';

const ddbMock = mockClient(awsShared.ddbDocClient);

// Env must be set before the tool module is required (BUCKET_NAME is read at import).
const originalEnv = { ...process.env };
process.env.BUCKET_NAME = 'test-bucket';
process.env.CALCULATOR_TABLE_NAME = 'test-calculations';

// Required lazily so the module-level env read above is honoured.
const load = () => require('../lambdas/calculator-evidence-tool');

const EVENT = {
  calculationId: 'calc-1',
};

const CONTEXT = {
  clientContext: { custom: { bedrockAgentCoreToolName: 'get_workbook_evidence' } },
} as never;

/** One evidence row whose serialized size is large but bounded. */
function makeRows(from: number, to: number, repeat = 20) {
  const rows: Array<{ rowNumber: number; rowId: string; cells: Array<{ address: string; header: string; raw: string; formatted: string }> }> = [];
  for (let n = from; n <= to; n += 1) {
    rows.push({
      rowNumber: n,
      rowId: `Inv!${n}`,
      cells: [{ address: `A${n}`, header: 'Service', raw: 'Amazon EC2', formatted: `m6i.large pricing estimate row ${n} `.repeat(repeat) }],
    });
  }
  return rows;
}

const chunkRows = (from: number, to: number, repeat = 20) => ({ rows: makeRows(from, to, repeat) });

beforeEach(() => {
  ddbMock.reset();
  jest.restoreAllMocks();
  ddbMock.on(GetCommand).resolves({ Item: { owner_user_id: 'owner-1' } });
});

afterAll(() => {
  process.env = originalEnv;
});

/** Stub getFileBuffer with an index plus a chunk map keyed by suffix. */
function stubS3(index: unknown, chunks: Record<string, unknown>) {
  jest.spyOn(awsShared, 'getFileBuffer').mockImplementation(async (_bucket: string, key: string) => {
    const body = key.endsWith('/evidence/index.json')
      ? index
      : chunks[Object.keys(chunks).find((id) => key.endsWith(`/chunks/${id}.json`)) ?? ''];
    if (body === undefined) throw new Error(`unexpected key ${key}`);
    return Buffer.from(JSON.stringify(body), 'utf8');
  });
}

const rowIds = (payload: { rows: Array<{ rowId: string }> }) => payload.rows.map((row) => row.rowId);

describe('get_workbook_evidence paging: two normal chunks over one response ceiling', () => {
  it('returns chunk 0001 whole, then the complete chunk 0002, with every rowId exactly once', async () => {
    // chunk 0001 and 0002 each ~100 KB of rows; the response ceiling is 180 KB, so the
    // two together cannot share one response (repeat=20: ~96 KB + ~98 KB = ~194 KB).
    const c1 = chunkRows(1, 120);
    const c2 = chunkRows(121, 240);

    stubS3({
      fileName: 'fleet.xlsx',
      sheets: [{ name: 'Inv', rowCount: 240 }],
      chunks: [
        { chunkId: '0001', sheet: 'Inv', rowsFrom: 1, rowsTo: 120, environmentHints: [], fiscalPeriodHints: [], serviceHints: [], s3Key: 'u/evidence/chunks/0001.json', costRelevantRowCount: 120 },
        { chunkId: '0002', sheet: 'Inv', rowsFrom: 121, rowsTo: 240, environmentHints: [], fiscalPeriodHints: [], serviceHints: [], s3Key: 'u/evidence/chunks/0002.json', costRelevantRowCount: 120 },
      ],
      detectedEnvironments: [],
      detectedFiscalPeriods: [],
      accounting: { totalRows: 240, totalChunks: 2 },
    }, { '0001': c1, '0002': c2 });

    const { handler } = load();

    // First page: the complete first chunk only. nextChunkId names the SECOND chunk,
    // never a half-read one, and chunk 0002 is NOT in returnedChunks.
    const first = await handler(EVENT, CONTEXT);
    expect(first.returnedChunks).toEqual(['0001']);
    expect(first.moreAvailable).toBe(true);
    expect(first.nextChunkId).toBe('0002');
    expect(first.nextRowsFrom).toBeUndefined();
    expect(rowIds(first)).toHaveLength(120);
    expect(first.rows.every((r: { rowId: string }) => Number(r.rowId.split('!')[1]) <= 120)).toBe(true);

    // Second page: the complete second chunk, no third page.
    const second = await handler({ ...EVENT, chunkId: '0002' }, CONTEXT);
    expect(second.returnedChunks).toEqual(['0002']);
    expect(second.moreAvailable).toBe(false);
    expect(second.nextChunkId).toBeUndefined();
    expect(rowIds(second)).toHaveLength(120);

    // Lossless: the union over pages equals the source, with no skips and no duplicates.
    const all = [...rowIds(first), ...rowIds(second)];
    expect(all).toHaveLength(240);
    expect(new Set(all).size).toBe(240);
    const source = makeRows(1, 240).map((row) => row.rowId);
    expect(all.sort()).toEqual(source.sort());
  });
});

describe('get_workbook_evidence paging: an oversized chunk uses an exact row cursor', () => {
  it('streams an oversized chunk and resumes at nextRowsFrom with no skipped or duplicated rows', async () => {
    // A single chunk whose rows exceed the response ceiling (only possible when one row
    // is abnormally large and was packed into its own chunk). The tool must not discard
    // the tail; it streams what fits and hands back an exact cursor.
    const big = chunkRows(1, 260, 24); // ~240 KB of rows > 180 KB ceiling

    stubS3({
      fileName: 'giant.xlsx',
      sheets: [{ name: 'Inv', rowCount: 260 }],
      chunks: [
        { chunkId: '0001', sheet: 'Inv', rowsFrom: 1, rowsTo: 260, environmentHints: [], fiscalPeriodHints: [], serviceHints: [], s3Key: 'u/evidence/chunks/0001.json', costRelevantRowCount: 260 },
      ],
      detectedEnvironments: [],
      detectedFiscalPeriods: [],
      accounting: { totalRows: 260, totalChunks: 1 },
    }, { '0001': big });

    const { handler } = load();

    const first = await handler(EVENT, CONTEXT);
    expect(first.returnedChunks).toEqual([]); // chunk not fully returned yet
    expect(first.moreAvailable).toBe(true);
    expect(first.nextChunkId).toBe('0001');
    expect(typeof first.nextRowsFrom).toBe('number');

    const seen = new Set<string>(rowIds(first));
    expect(seen.size).toBe(first.returnedRowCount);

    // Resume from the exact first unread row.
    const second = await handler({ ...EVENT, chunkId: '0001', rowsFrom: first.nextRowsFrom }, CONTEXT);
    expect(second.moreAvailable).toBe(false);
    expect(second.nextChunkId).toBeUndefined();

    const allIds = [...rowIds(first), ...rowIds(second)];
    expect(allIds).toHaveLength(260);
    expect(new Set(allIds).size).toBe(260); // no duplicates
    const source = big.rows.map((row) => row.rowId).sort();
    expect(allIds.sort()).toEqual(source); // no skips
  });
});
