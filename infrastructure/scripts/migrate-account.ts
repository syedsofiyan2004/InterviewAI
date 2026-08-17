import { readFile, readdir, writeFile } from 'fs/promises';
import { readdirSync, statSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  ListUserPoolsCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PutCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

type DynamoAttribute =
  | { S: string }
  | { N: string }
  | { BOOL: boolean }
  | { NULL: true }
  | { M: Record<string, DynamoAttribute> }
  | { L: DynamoAttribute[] }
  | { SS: string[] }
  | { NS: string[] }
  | { BS: string[] };

type SourceUser = {
  Username?: string;
  Attributes?: Array<{ Name?: string; Value?: string }>;
  Enabled?: boolean;
  UserStatus?: string;
};

type SourceUsersPayload = {
  Users?: SourceUser[];
};

type SourceTablePayload = {
  Items?: Record<string, DynamoAttribute>[];
};

const region = process.env.AWS_REGION || 'ap-south-1';
const envName = process.env.NODE_ENV || 'dev';
const targetAccountId = process.env.TARGET_ACCOUNT_ID?.trim();

if (!targetAccountId) {
  throw new Error('Missing environment variable: TARGET_ACCOUNT_ID');
}

const sourceBackupDir = resolveBackupDir();
const cognito = new CognitoIdentityProviderClient({ region });
const s3 = new S3Client({ region });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

const prefix = 'iep';
const uniqueName = (resource: string, accountId: string) =>
  `${prefix}-${envName}-${resource}-${accountId}-${region}`;

const targetUserPoolName = uniqueName('user-pool', targetAccountId);
const targetBucketName = uniqueName('files', targetAccountId);
const targetInterviewTable = uniqueName('interviews-v2', targetAccountId);
const targetMomTable = uniqueName('moms', targetAccountId);
const targetIntelligenceTable = uniqueName('interview-intelligence', targetAccountId);

async function run() {
  console.log(`Using backup folder: ${sourceBackupDir}`);
  console.log(`Target account: ${targetAccountId}`);
  console.log(`Target region: ${region}`);

  const sourceUsers = await readJson<SourceUsersPayload>(path.join(sourceBackupDir, 'cognito', 'users.json'));
  const sourceUserList = sourceUsers.Users ?? [];
  console.log(`Source Cognito users: ${sourceUserList.length}`);

  const targetUserPoolId = await findUserPoolId(targetUserPoolName);
  console.log(`Target user pool: ${targetUserPoolName} (${targetUserPoolId})`);

  const sourceToTargetUserId = await migrateCognitoUsers(targetUserPoolId, sourceUserList);
  console.log(`Migrated/linked Cognito users: ${Object.keys(sourceToTargetUserId).length}`);

  await migrateTable(
    path.join(sourceBackupDir, 'dynamodb', 'interviews.json'),
    targetInterviewTable,
    sourceToTargetUserId,
    'interviews',
  );

  await migrateTable(
    path.join(sourceBackupDir, 'dynamodb', 'moms.json'),
    targetMomTable,
    sourceToTargetUserId,
    'moms',
  );

  await migrateTable(
    path.join(sourceBackupDir, 'dynamodb', 'intelligence.json'),
    targetIntelligenceTable,
    sourceToTargetUserId,
    'interview intelligence',
  );

  await migrateS3Objects(
    path.join(sourceBackupDir, 's3'),
    targetBucketName,
    sourceToTargetUserId,
  );

  console.log('Migration finished successfully.');
}

async function migrateCognitoUsers(
  userPoolId: string,
  users: SourceUser[],
): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  const handoff: Array<{ email: string; temporaryPassword: string }> = [];

  for (const sourceUser of users) {
    const email = getAttribute(sourceUser, 'email');
    const oldSub = getAttribute(sourceUser, 'sub') || sourceUser.Username;

    if (!email || !oldSub) {
      console.log('Skipping a user record without email or sub.');
      continue;
    }

    const existing = await findUserByEmail(userPoolId, email);
    if (!existing) {
      const tempPassword = generateTemporaryPassword(email);
      await cognito.send(new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: email,
        MessageAction: 'SUPPRESS',
        TemporaryPassword: tempPassword,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
        ],
      }));
      console.log(`Created Cognito user for ${email}`);
    } else {
      console.log(`Reusing existing Cognito user for ${email}`);
    }

    const refreshedTarget = await findUserByEmail(userPoolId, email);
    const targetUsername = refreshedTarget?.Username;
    const targetUser = targetUsername ? await getCognitoUser(userPoolId, targetUsername) : null;
    const newSub = targetUser ? getAttribute(targetUser, 'sub') : null;
    if (!newSub) {
      throw new Error(`Could not resolve target sub for ${email}`);
    }

    map[oldSub] = newSub;
    console.log(`Mapped ${email}: ${oldSub} -> ${newSub}`);

    if (!targetUsername) {
      throw new Error(`Could not resolve target username for ${email}`);
    }

    const temporaryPassword = generateTemporaryPassword(email);
    await cognito.send(new AdminSetUserPasswordCommand({
      UserPoolId: userPoolId,
      Username: targetUsername,
      Password: temporaryPassword,
      Permanent: false,
    }));
    handoff.push({ email, temporaryPassword });
  }

  const handoffPath = path.join(sourceBackupDir, 'cognito', 'imported-user-passwords.json');
  await writeFile(handoffPath, JSON.stringify(handoff, null, 2), 'utf8');
  console.log(`Wrote temporary password handoff file: ${handoffPath}`);

  return map;
}

async function migrateTable(
  sourcePath: string,
  tableName: string,
  userIdMap: Record<string, string>,
  label: string,
) {
  const payload = await readJson<SourceTablePayload>(sourcePath);
  const items = payload.Items ?? [];
  console.log(`Migrating ${items.length} ${label} records into ${tableName}`);

  for (const rawItem of items) {
    const item = remapValues(fromDynamoItem(rawItem), userIdMap);
    await ddb.send(new PutCommand({
      TableName: tableName,
      Item: item,
    }));
  }

  console.log(`Completed ${label} table migration.`);
}

async function migrateS3Objects(
  sourceRoot: string,
  bucketName: string,
  userIdMap: Record<string, string>,
) {
  const files = await listFilesRecursive(sourceRoot);
  console.log(`Migrating ${files.length} S3 objects into ${bucketName}`);

  for (const filePath of files) {
    const relativeKey = normalizeKey(path.relative(sourceRoot, filePath));
    const remappedKey = remapS3Key(relativeKey, userIdMap);
    const body = await readFile(filePath);
    await s3.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: remappedKey,
      Body: body,
      ContentType: guessContentType(remappedKey),
    }));
  }

  console.log('Completed S3 object migration.');
}

async function findUserPoolId(poolName: string): Promise<string> {
  const response = await cognito.send(new ListUserPoolsCommand({ MaxResults: 60 }));
  const pool = response.UserPools?.find((userPool) => userPool.Name === poolName);
  if (!pool?.Id) {
    throw new Error(`Could not find target user pool named ${poolName}`);
  }
  return pool.Id;
}

async function findUserByEmail(userPoolId: string, email: string) {
  const response = await cognito.send(new ListUsersCommand({
    UserPoolId: userPoolId,
    Filter: `email = "${email}"`,
    Limit: 1,
  }));
  return response.Users?.[0] ?? null;
}

async function getCognitoUser(userPoolId: string, username: string) {
  try {
    const response = await cognito.send(new AdminGetUserCommand({
      UserPoolId: userPoolId,
      Username: username,
    }));
    return {
      Username: response.Username,
      UserAttributes: response.UserAttributes?.map((attr) => ({
        Name: attr.Name,
        Value: attr.Value,
      })) ?? [],
    } as SourceUser;
  } catch {
    return null;
  }
}

function getAttribute(user: SourceUser, name: string): string | null {
  const sourceAttrs = user.Attributes ?? [];
  const targetAttrs = (user as SourceUser & { UserAttributes?: Array<{ Name?: string; Value?: string }> }).UserAttributes ?? [];
  return (
    sourceAttrs.find((attr) => attr.Name === name)?.Value ??
    targetAttrs.find((attr) => attr.Name === name)?.Value ??
    null
  );
}

function generateTemporaryPassword(seed: string): string {
  const local = seed.split('@')[0]?.replace(/[^a-zA-Z0-9]/g, '') || 'User';
  return `${local.slice(0, 6)}!Minfy2026${Math.floor(Math.random() * 9000 + 1000)}`;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

function fromDynamoItem(item: Record<string, DynamoAttribute>): any {
  const obj: Record<string, any> = {};
  for (const [key, value] of Object.entries(item)) {
    obj[key] = fromDynamoAttribute(value);
  }
  return obj;
}

function fromDynamoAttribute(attr: DynamoAttribute): any {
  if ('S' in attr) return attr.S;
  if ('N' in attr) return Number(attr.N);
  if ('BOOL' in attr) return attr.BOOL;
  if ('NULL' in attr) return null;
  if ('M' in attr) {
    const obj: Record<string, any> = {};
    for (const [key, value] of Object.entries(attr.M)) {
      obj[key] = fromDynamoAttribute(value);
    }
    return obj;
  }
  if ('L' in attr) return attr.L.map((entry) => fromDynamoAttribute(entry));
  if ('SS' in attr) return [...attr.SS];
  if ('NS' in attr) return attr.NS.map((num) => Number(num));
  if ('BS' in attr) return [...attr.BS];
  return undefined;
}

function remapValues(value: any, userIdMap: Record<string, string>): any {
  if (typeof value === 'string') {
    let next = value;
    for (const [oldSub, newSub] of Object.entries(userIdMap)) {
      next = next.replaceAll(`users/${oldSub}/`, `users/${newSub}/`);
      next = next.replaceAll(`USER#${oldSub}`, `USER#${newSub}`);
      if (next === oldSub) {
        next = newSub;
      }
    }
    return next;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => remapValues(entry, userIdMap));
  }

  if (value && typeof value === 'object') {
    const obj: Record<string, any> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      obj[key] = remapValues(entry, userIdMap);
    }
    return obj;
  }

  return value;
}

function remapS3Key(key: string, userIdMap: Record<string, string>): string {
  let next = key;
  for (const [oldSub, newSub] of Object.entries(userIdMap)) {
    next = next.replaceAll(`users/${oldSub}/`, `users/${newSub}/`);
  }
  return next;
}

function normalizeKey(key: string): string {
  return key.split(path.sep).join('/');
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const results: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

function guessContentType(key: string): string {
  const lower = key.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.docx')) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  if (lower.endsWith('.doc')) return 'application/msword';
  if (lower.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

function resolveBackupDir(): string {
  const configured = process.env.MIGRATION_BACKUP_DIR?.trim();
  if (configured) {
    return configured;
  }

  const temp = os.tmpdir();
  const candidates = readdirSync(temp, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('minfy-migration-'))
    .map((entry) => path.join(temp, entry.name))
    .sort((a: string, b: string) => {
      const aTime = statSync(a).mtimeMs;
      const bTime = statSync(b).mtimeMs;
      return bTime - aTime;
    });

  if (candidates.length > 0) {
    return candidates[0];
  }

  throw new Error('Missing MIGRATION_BACKUP_DIR and no minfy-migration-* backup folder found in the temp directory.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
