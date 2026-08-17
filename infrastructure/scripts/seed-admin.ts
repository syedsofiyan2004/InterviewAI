import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminAddUserToGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';

/**
 * Admin Portal seed / backfill. Idempotent — safe to re-run.
 *
 *   1. Every Cognito pool user gets a Membership row (base_role MEMBER) if it
 *      doesn't already have one. Existing rows are never downgraded.
 *   2. The user whose email matches SEED_ADMIN_EMAIL is promoted to base_role
 *      ADMIN and, only if they have no active AdminGrant, given ONE OWNER grant
 *      (granted_by = SYSTEM_SEED). Being ADMIN never implicitly creates a grant
 *      anywhere else — this bootstrap is the single deliberate exception.
 *   3. Users are added to their Cognito group (MEMBER / ADMIN) for console
 *      legibility. Group membership alone grants nothing at runtime.
 *
 * Env: AWS_REGION, COGNITO_USER_POOL_ID, ADMIN_TABLE_NAME, SEED_ADMIN_EMAIL.
 */

const region = process.env.AWS_REGION || 'ap-south-1';
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
});
const cognito = new CognitoIdentityProviderClient({ region });

const DEFAULT_ORG_ID = 'minfy';
const membershipPk = () => `ORG#${DEFAULT_ORG_ID}`;
const membershipSk = (userId: string) => `MEMBER#${userId}`;
const grantPk = (userId: string) => `USER#${userId}`;
const grantSk = (ts: number) => `GRANT#${ts}`;

function emailOf(user: { Attributes?: { Name?: string; Value?: string }[] }): string {
  const attr = (user.Attributes || []).find((a) => a.Name === 'email');
  return (attr?.Value || '').toLowerCase();
}

async function listAllUsers(userPoolId: string) {
  const users: { Username: string; email: string }[] = [];
  let paginationToken: string | undefined;
  do {
    const page = await cognito.send(new ListUsersCommand({
      UserPoolId: userPoolId,
      PaginationToken: paginationToken,
    }));
    for (const u of page.Users || []) {
      if (u.Username) users.push({ Username: u.Username, email: emailOf(u) });
    }
    paginationToken = page.PaginationToken;
  } while (paginationToken);
  return users;
}

async function hasActiveGrant(userId: string): Promise<boolean> {
  const res = await dynamo.send(new QueryCommand({
    TableName: process.env.ADMIN_TABLE_NAME!,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': grantPk(userId), ':prefix': 'GRANT#' },
    ScanIndexForward: false,
    Limit: 1,
  }));
  const newest = res.Items?.[0];
  return !!newest && !newest.revoked_at;
}

async function addToGroup(userPoolId: string, username: string, group: 'MEMBER' | 'ADMIN') {
  try {
    await cognito.send(new AdminAddUserToGroupCommand({
      UserPoolId: userPoolId,
      Username: username,
      GroupName: group,
    }));
  } catch (err: any) {
    // Non-fatal: the DynamoDB Membership row is the source of truth.
    console.warn(`  ! could not add ${username} to group ${group}: ${err.message}`);
  }
}

async function run() {
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  const tableName = process.env.ADMIN_TABLE_NAME;
  const seedEmail = (process.env.SEED_ADMIN_EMAIL || '').toLowerCase();

  if (!userPoolId || !tableName) {
    throw new Error('Missing env: COGNITO_USER_POOL_ID and ADMIN_TABLE_NAME are required');
  }

  console.log(`Seeding admin model — pool ${userPoolId}, table ${tableName}`);
  console.log(seedEmail ? `Seed admin email: ${seedEmail}` : 'No SEED_ADMIN_EMAIL — backfilling memberships only');

  const users = await listAllUsers(userPoolId);
  console.log(`Found ${users.length} Cognito user(s)`);

  let created = 0;
  let promoted = 0;
  let granted = 0;

  for (const { Username: userId, email } of users) {
    const isSeedAdmin = !!seedEmail && email === seedEmail;
    const now = Date.now();

    const existing = await dynamo.send(new GetCommand({
      TableName: tableName,
      Key: { PK: membershipPk(), SK: membershipSk(userId) },
    }));

    const currentRole = existing.Item?.base_role;
    // Never downgrade an existing ADMIN; promote to ADMIN only for the seed user.
    const nextRole = currentRole === 'ADMIN' || isSeedAdmin ? 'ADMIN' : (currentRole || 'MEMBER');

    if (!existing.Item || currentRole !== nextRole) {
      await dynamo.send(new PutCommand({
        TableName: tableName,
        Item: {
          PK: membershipPk(),
          SK: membershipSk(userId),
          entity_type: 'MEMBERSHIP',
          org_id: DEFAULT_ORG_ID,
          user_id: userId,
          email,
          base_role: nextRole,
          created_at: existing.Item?.created_at || now,
          updated_at: now,
          gsi4_pk: email || undefined,
        },
      }));
      if (!existing.Item) created++;
      if (isSeedAdmin && currentRole !== 'ADMIN') promoted++;
      console.log(`  ${existing.Item ? 'updated' : 'created'} membership ${email || userId} -> ${nextRole}`);
    }

    await addToGroup(userPoolId, userId, nextRole);

    // Bootstrap OWNER grant for the seed admin only, and only if none active.
    if (isSeedAdmin && !(await hasActiveGrant(userId))) {
      const ts = Date.now();
      await dynamo.send(new PutCommand({
        TableName: tableName,
        Item: {
          PK: grantPk(userId),
          SK: grantSk(ts),
          entity_type: 'ADMIN_GRANT',
          user_id: userId,
          email,
          tier: 'OWNER',
          granted_by: 'SYSTEM_SEED',
          granted_at: ts,
          note: 'Initial OWNER grant from seed-admin script',
        },
      }));
      granted++;
      console.log(`  granted OWNER tier to ${email}`);
    }
  }

  console.log(`\nDone. memberships created: ${created}, promoted to ADMIN: ${promoted}, OWNER grants: ${granted}`);
  if (seedEmail && !users.some((u) => u.email === seedEmail)) {
    console.warn(`\nWARNING: SEED_ADMIN_EMAIL "${seedEmail}" did not match any Cognito user. No admin was seeded.`);
  }
}

run().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
