import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ROLE_QUESTION_BANK, RoleQuestionBankEntry } from '../lambdas/api-handler/minfy-role-question-bank';
import { keys, roleKeyFromTitle } from '../schema/admin';

/**
 * Seeds the editable question bank from the shipped static array
 * (ROLE_QUESTION_BANK, 247 questions across 43 Keka roles) into the admin table
 * as QuestionBankRole (META) + QuestionBankItem rows, so admins can curate them.
 *
 * Design guarantees:
 *   - Question IDs are preserved verbatim (e.g. "125873-Q1") — that file's header
 *     requires stable IDs for auditability, and Part B/the admin routes key off
 *     them.
 *   - Idempotent and non-destructive: every write is conditional on the row not
 *     already existing, so a re-run adds only what is missing and NEVER clobbers
 *     an admin edit (an edited question, or a role whose competencies were set).
 *   - Rows opt into the sparse GSI1 partitions the store queries: META rows use
 *     QBANK_ROLE, item rows use QBANK_ITEM. (Kept in sync with
 *     question-bank-store.ts QBANK_GSI1_ROLE / QBANK_GSI1_ITEM.)
 *
 * The generic cross-role QUESTION_BANK is intentionally NOT seeded: the selector
 * only accepts the role pool as an override (rolePool), so generic entries would
 * become rows nothing reads. They stay as the shipped static fallback.
 *
 * Dry run by default — prints what it would write. Set APPLY=true to commit.
 *
 *   AWS_REGION=ap-south-1 \
 *   ADMIN_TABLE_NAME=iep-dev-admin-996122083346-ap-south-1 \
 *   npx ts-node scripts/seed-question-bank.ts            # dry run
 *
 *   APPLY=true AWS_REGION=... ADMIN_TABLE_NAME=... npx ts-node scripts/seed-question-bank.ts
 *
 * NOTE: the two local imports above are deliberately extensionless, unlike the
 * `.js`-suffixed imports in lambdas/. Lambda code is bundled by esbuild, which
 * remaps `.js` -> `.ts`; this script is run directly by ts-node in CommonJS mode
 * (the package has no "type": "module"), where a literal `.js` specifier fails to
 * resolve at runtime. Do not "fix" these to `.js`.
 */

// Must match question-bank-store.ts. Duplicated (two literals) so this one-off
// script does not import the store and drag in the DynamoDB/Bedrock client chain.
const QBANK_GSI1_ROLE = 'QBANK_ROLE';
const QBANK_GSI1_ITEM = 'QBANK_ITEM';

const region = process.env.AWS_REGION || 'ap-south-1';
const APPLY = process.env.APPLY === 'true';
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
});

/** Same rule as question-bank-store.roleKeyForJob: Keka jobId, else title slug. */
function roleKeyForEntry(entry: RoleQuestionBankEntry): string {
  const jobId = String(entry.jobId || '').trim();
  return jobId || roleKeyFromTitle(entry.jobTitle);
}

/**
 * Writes an item only if it does not already exist. Returns true if written,
 * false if a row was already there (an admin edit or a prior seed run).
 */
async function putIfAbsent(tableName: string, item: Record<string, any>): Promise<boolean> {
  if (!APPLY) return true; // dry run: report as "would write"
  try {
    await dynamo.send(new PutCommand({
      TableName: tableName,
      Item: item,
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
    return true;
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

async function run() {
  const tableName = process.env.ADMIN_TABLE_NAME;
  if (!tableName) throw new Error('Missing env: ADMIN_TABLE_NAME is required');

  console.log(`${APPLY ? 'SEEDING' : 'DRY RUN'} question bank -> table ${tableName} (${region})`);
  console.log(`Source: ${ROLE_QUESTION_BANK.length} static role questions`);

  // Group questions by roleKey. First entry of each group defines the META.
  const byRole = new Map<string, RoleQuestionBankEntry[]>();
  for (const entry of ROLE_QUESTION_BANK) {
    const roleKey = roleKeyForEntry(entry);
    const group = byRole.get(roleKey) || [];
    group.push(entry);
    byRole.set(roleKey, group);
  }
  console.log(`Grouped into ${byRole.size} role(s)\n`);

  const now = Date.now();
  let rolesCreated = 0, rolesSkipped = 0, itemsCreated = 0, itemsSkipped = 0;

  for (const [roleKey, entries] of byRole) {
    const first = entries[0];

    const roleWritten = await putIfAbsent(tableName, {
      PK: keys.qbankPk(roleKey),
      SK: keys.qbankMetaSk(),
      entity_type: 'QUESTION_BANK_ROLE',
      role_key: roleKey,
      role_title: first.jobTitle,
      department: first.department || undefined,
      experience: first.experience || undefined,
      keka_job_id: String(first.jobId || '').trim() || undefined,
      // Empty = "fall back to AI extraction". Admins/Part B fill this in later.
      competencies: [],
      created_at: now,
      updated_at: now,
      updated_by: 'SYSTEM_SEED',
      gsi1_pk: QBANK_GSI1_ROLE,
      gsi1_sk: now,
    });
    roleWritten ? rolesCreated++ : rolesSkipped++;

    for (const entry of entries) {
      const itemWritten = await putIfAbsent(tableName, {
        PK: keys.qbankPk(roleKey),
        SK: keys.qbankItemSk(entry.id),
        entity_type: 'QUESTION_BANK_ITEM',
        role_key: roleKey,
        role_title: first.jobTitle,
        keka_job_id: String(first.jobId || '').trim() || undefined,
        question_id: entry.id,
        category: entry.category || 'Core Technical/Functional Skills',
        topic_tag: entry.topicTag || undefined,
        // The static bank has no per-question competency/signals; admins add
        // those through the editor. Empty arrays keep the selector's generic
        // fallbacks in play, so a seeded guide reads exactly as today.
        question: entry.question,
        follow_ups: [],
        strong_signals: [],
        red_flags: [],
        active: true,
        source: 'SEED',
        created_at: now,
        updated_at: now,
        updated_by: 'SYSTEM_SEED',
        gsi1_pk: QBANK_GSI1_ITEM,
        gsi1_sk: now,
      });
      itemWritten ? itemsCreated++ : itemsSkipped++;
    }

    console.log(`  ${roleKey.padEnd(14)} ${first.jobTitle} — ${entries.length} question(s)`);
  }

  console.log(`\n${APPLY ? 'Done' : 'Dry run complete'}.`);
  console.log(`Roles: ${rolesCreated} ${APPLY ? 'created' : 'to create'}, ${rolesSkipped} already present`);
  console.log(`Questions: ${itemsCreated} ${APPLY ? 'created' : 'to create'}, ${itemsSkipped} already present`);
  if (!APPLY) console.log('\nNo writes were made. Re-run with APPLY=true to commit.');
}

run().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
