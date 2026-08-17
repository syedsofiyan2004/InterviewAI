/**
 * Backfills owner_email on records that only carry an opaque Cognito sub.
 *
 * Records created before owner_email was stamped show the raw sub in the UI
 * (e.g. "4133edaa-c071-70c5-af75-bf1aed50f351" instead of the interviewer's
 * address), because every owner label renders `owner_email || owner_user_id`.
 * This resolves each distinct sub through Cognito once and writes the email
 * back, so the fallback is never reached.
 *
 * Only ever ADDS owner_email where it is missing. Never overwrites an existing
 * value and never touches any other attribute.
 *
 * DRY RUN BY DEFAULT. Set APPLY=true to write.
 *
 *   TABLE_NAME=... MOM_TABLE_NAME=... INTELLIGENCE_TABLE_NAME=... \
 *   USER_POOL_ID=... npx tsx scripts/backfill-owner-email.ts
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';

const region = process.env.AWS_REGION || 'ap-south-1';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
});
const cognito = new CognitoIdentityProviderClient({ region });

const USER_POOL_ID = process.env.USER_POOL_ID!;
const APPLY = process.env.APPLY === 'true';

/** Each table keyed differently, so the key builder is per-table. */
const TABLES = [
  {
    name: process.env.TABLE_NAME!,
    label: 'interviews',
    key: (i: any) => ({ PK: i.PK, SK: i.SK }),
    id: (i: any) => i.PK,
  },
  {
    name: process.env.MOM_TABLE_NAME!,
    label: 'moms',
    key: (i: any) => ({ mom_id: i.mom_id }),
    id: (i: any) => i.mom_id,
  },
  {
    name: process.env.INTELLIGENCE_TABLE_NAME!,
    label: 'intelligence',
    key: (i: any) => ({ intelligence_id: i.intelligence_id }),
    id: (i: any) => i.intelligence_id,
  },
];

const emailCache = new Map<string, string | null>();

async function emailForSub(sub: string): Promise<string | null> {
  if (emailCache.has(sub)) return emailCache.get(sub)!;
  let email: string | null = null;
  try {
    const found = await cognito.send(new ListUsersCommand({
      UserPoolId: USER_POOL_ID,
      Filter: `sub = "${sub}"`,
      Limit: 1,
    }));
    email = found.Users?.[0]?.Attributes?.find((a) => a.Name === 'email')?.Value ?? null;
  } catch (err) {
    console.warn(`  ! Cognito lookup failed for ${sub}:`, err);
  }
  emailCache.set(sub, email);
  return email;
}

async function run() {
  if (!USER_POOL_ID) throw new Error('Missing environment variable: USER_POOL_ID');
  console.log(APPLY ? '=== APPLYING CHANGES ===' : '=== DRY RUN (set APPLY=true to write) ===');

  let updated = 0;
  let unresolved = 0;
  let alreadyFine = 0;

  for (const table of TABLES) {
    if (!table.name) {
      console.warn(`Skipping ${table.label}: table name env var not set`);
      continue;
    }
    console.log(`\n--- ${table.label} (${table.name}) ---`);

    const items: any[] = [];
    let lastKey: Record<string, any> | undefined;
    do {
      const page: any = await ddb.send(new ScanCommand({
        TableName: table.name,
        ExclusiveStartKey: lastKey,
      }));
      items.push(...(page.Items || []));
      lastKey = page.LastEvaluatedKey;
    } while (lastKey);

    for (const item of items) {
      if (item.owner_email) { alreadyFine++; continue; }
      const sub = item.owner_user_id;
      if (!sub) { unresolved++; continue; }

      const email = await emailForSub(sub);
      if (!email) {
        console.log(`  UNRESOLVED ${table.id(item)} — sub ${sub} not found in pool`);
        unresolved++;
        continue;
      }

      console.log(`  SET ${table.id(item)} -> ${email}`);
      if (APPLY) {
        await ddb.send(new UpdateCommand({
          TableName: table.name,
          Key: table.key(item),
          UpdateExpression: 'SET owner_email = :e',
          // Guard against a concurrent write having filled it in already.
          ConditionExpression: 'attribute_not_exists(owner_email)',
          ExpressionAttributeValues: { ':e': email },
        })).catch((err: any) => {
          if (err.name === 'ConditionalCheckFailedException') return;
          throw err;
        });
      }
      updated++;
    }
  }

  console.log('\n--- Summary ---');
  console.log(`  backfilled:              ${updated}`);
  console.log(`  already had owner_email: ${alreadyFine}`);
  console.log(`  unresolved:              ${unresolved}`);
  if (!APPLY) console.log('\nDry run only — nothing was written. Re-run with APPLY=true to apply.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
