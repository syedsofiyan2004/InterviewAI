/**
 * Purges dangling linked_records from candidate workspaces.
 *
 * Records deleted before the delete-time unlink fix left their workspaces
 * holding links to rows that no longer exist. Those ghosts still rendered as
 * "IN PROGRESS" rounds with a dead "Open report" button, and — worse — a
 * workspace whose rounds were all deleted was still matched by
 * lookupCandidateWorkspace, so re-adding the candidate silently reused it.
 *
 * For each CANDIDATE_WORKSPACE this script:
 *   1. checks every linked record against its source table,
 *   2. drops the links whose source row is gone (or soft-deleted),
 *   3. marks the workspace deleted_at only when NO live rounds remain.
 *
 * A workspace that still has at least one live round is only trimmed, never
 * closed — nothing disappears that still has real content behind it.
 *
 * DRY RUN BY DEFAULT. Set APPLY=true to write changes.
 *
 *   # preview
 *   ADMIN_TABLE_NAME=... TABLE_NAME=... MOM_TABLE_NAME=... INTELLIGENCE_TABLE_NAME=... \
 *     npx tsx scripts/purge-ghost-workspaces.ts
 *
 *   # apply
 *   APPLY=true ADMIN_TABLE_NAME=... ... npx tsx scripts/purge-ghost-workspaces.ts
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

const region = process.env.AWS_REGION || 'ap-south-1';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
});

const ADMIN_TABLE = process.env.ADMIN_TABLE_NAME!;
const INTERVIEW_TABLE = process.env.TABLE_NAME!;
const MOM_TABLE = process.env.MOM_TABLE_NAME!;
const INTELLIGENCE_TABLE = process.env.INTELLIGENCE_TABLE_NAME!;

const APPLY = process.env.APPLY === 'true';

/** True when the source row still exists and is not soft-deleted. */
async function recordIsAlive(recordType: string, recordId: string): Promise<boolean> {
  try {
    if (recordType === 'interview') {
      const r = await ddb.send(new GetCommand({
        TableName: INTERVIEW_TABLE,
        Key: { PK: `INTERVIEW#${recordId}`, SK: 'METADATA' },
      }));
      return Boolean(r.Item) && !r.Item!.deleted_at;
    }
    if (recordType === 'mom') {
      const r = await ddb.send(new GetCommand({
        TableName: MOM_TABLE,
        Key: { mom_id: recordId },
      }));
      return Boolean(r.Item) && !r.Item!.deleted_at;
    }
    if (recordType === 'intelligence') {
      const r = await ddb.send(new GetCommand({
        TableName: INTELLIGENCE_TABLE,
        Key: { intelligence_id: recordId },
      }));
      return Boolean(r.Item) && !r.Item!.deleted_at;
    }
  } catch (err) {
    // On a lookup error, keep the link. Losing a real round is worse than
    // leaving one stale row for the next run to catch.
    console.warn(`  ! lookup failed for ${recordType} ${recordId}, keeping link:`, err);
    return true;
  }
  return true;
}

async function run() {
  for (const [name, value] of Object.entries({
    ADMIN_TABLE_NAME: ADMIN_TABLE,
    TABLE_NAME: INTERVIEW_TABLE,
    MOM_TABLE_NAME: MOM_TABLE,
    INTELLIGENCE_TABLE_NAME: INTELLIGENCE_TABLE,
  })) {
    if (!value) throw new Error(`Missing environment variable: ${name}`);
  }

  console.log(APPLY ? '=== APPLYING CHANGES ===' : '=== DRY RUN (set APPLY=true to write) ===');

  // Collect every workspace row (paginated).
  const workspaces: any[] = [];
  let lastKey: Record<string, any> | undefined;
  do {
    const page: any = await ddb.send(new ScanCommand({
      TableName: ADMIN_TABLE,
      FilterExpression: 'entity_type = :t',
      ExpressionAttributeValues: { ':t': 'CANDIDATE_WORKSPACE' },
      ExclusiveStartKey: lastKey,
    }));
    workspaces.push(...(page.Items || []));
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);

  console.log(`Found ${workspaces.length} candidate workspace(s).\n`);

  let trimmed = 0;
  let closed = 0;
  let untouched = 0;

  for (const ws of workspaces) {
    const label = `${ws.candidate_name || ws.title || ws.workspace_id}`;

    if (ws.deleted_at) {
      untouched++;
      continue;
    }

    const current: any[] = ws.linked_records || [];
    const alive: any[] = [];
    const dead: any[] = [];
    for (const link of current) {
      if (await recordIsAlive(link.record_type, link.record_id)) alive.push(link);
      else dead.push(link);
    }

    if (dead.length === 0) {
      untouched++;
      continue;
    }

    const willClose = alive.length === 0;
    console.log(
      `${willClose ? 'CLOSE ' : 'TRIM  '} ${label} — ` +
      `${dead.length} dead link(s), ${alive.length} live round(s) remaining`,
    );
    for (const d of dead) console.log(`         dropped ${d.record_type} ${d.record_id}`);

    if (APPLY) {
      const now = Date.now();
      await ddb.send(new UpdateCommand({
        TableName: ADMIN_TABLE,
        Key: { PK: ws.PK, SK: ws.SK },
        UpdateExpression: willClose
          ? 'SET linked_records = :lr, deleted_at = :ts, updated_at = :ts, gsi1_sk = :ts'
          : 'SET linked_records = :lr, updated_at = :ts, gsi1_sk = :ts',
        ExpressionAttributeValues: { ':lr': alive, ':ts': now },
      }));
    }

    if (willClose) closed++;
    else trimmed++;
  }

  console.log('\n--- Summary ---');
  console.log(`  trimmed (dead links removed, workspace kept): ${trimmed}`);
  console.log(`  closed  (no live rounds left):                ${closed}`);
  console.log(`  untouched:                                    ${untouched}`);
  if (!APPLY) console.log('\nDry run only — nothing was written. Re-run with APPLY=true to apply.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
