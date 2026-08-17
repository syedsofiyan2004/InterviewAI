import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

type Mode = 'dry-run' | 'execute';

type UserMapEntry = {
  email: string;
  folder: string;
};

type FieldMove = {
  field: string;
  oldKey: string;
  newKey: string;
};

type RecordMove = {
  label: string;
  tableName: string;
  key: Record<string, unknown>;
  ownerUserId: string;
  ownerEmail: string;
  moves: FieldMove[];
};

const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-south-1';
const bucketName = requiredEnv('BUCKET_NAME');
const userPoolId = requiredEnv('USER_POOL_ID');
const interviewTableName = requiredEnv('TABLE_NAME');
const momTableName = requiredEnv('MOM_TABLE_NAME');
const mode = (process.env.MIGRATION_MODE || 'dry-run') as Mode;

if (!['dry-run', 'execute'].includes(mode)) {
  throw new Error('MIGRATION_MODE must be "dry-run" or "execute".');
}

const cognito = new CognitoIdentityProviderClient({ region });
const s3 = new S3Client({ region });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

const interviewFields = [
  'transcript_s3_key',
  'jd_s3_key',
  'resume_s3_key',
  'result_s3_key',
  'report_s3_key',
];

const momFields = [
  'transcript_s3_key',
  'result_s3_key',
  'report_s3_key',
];

async function run() {
  console.log(`S3 user-folder migration: ${mode}`);
  console.log(`Bucket: ${bucketName}`);
  console.log(`Region: ${region}`);

  const usersBySub = await loadUsersBySub();
  console.log(`Loaded ${usersBySub.size} Cognito users with sub + email.`);

  const interviewMoves = await collectInterviewMoves(usersBySub);
  const momMoves = await collectMomMoves(usersBySub);
  const records = [...interviewMoves, ...momMoves];
  const objectCount = records.reduce((count, record) => count + record.moves.length, 0);

  console.log(`Records needing updates: ${records.length}`);
  console.log(`Objects needing moves: ${objectCount}`);

  if (objectCount === 0) {
    console.log('Nothing to migrate.');
    return;
  }

  for (const record of records) {
    console.log(`${mode === 'dry-run' ? '[DRY RUN]' : '[EXECUTE]'} ${record.label}: ${record.moves.length} object(s)`);
    for (const move of record.moves) {
      console.log(`  ${move.field}: ${move.oldKey} -> ${move.newKey}`);
    }

    if (mode === 'execute') {
      await executeRecordMove(record);
    }
  }

  console.log(mode === 'dry-run'
    ? 'Dry run complete. Re-run with MIGRATION_MODE=execute to apply.'
    : 'Migration complete. Referenced S3 objects and DynamoDB keys are now aligned.');
}

async function loadUsersBySub(): Promise<Map<string, UserMapEntry>> {
  const users = new Map<string, UserMapEntry>();
  let paginationToken: string | undefined;

  do {
    const response = await cognito.send(new ListUsersCommand({
      UserPoolId: userPoolId,
      PaginationToken: paginationToken,
      Limit: 60,
    }));

    for (const user of response.Users || []) {
      const sub = user.Attributes?.find((attr) => attr.Name === 'sub')?.Value;
      const email = user.Attributes?.find((attr) => attr.Name === 'email')?.Value?.toLowerCase();
      if (sub && email) {
        users.set(sub, {
          email,
          folder: normalizeUserFolder(email),
        });
      }
    }

    paginationToken = response.PaginationToken;
  } while (paginationToken);

  return users;
}

async function collectInterviewMoves(usersBySub: Map<string, UserMapEntry>): Promise<RecordMove[]> {
  const records: RecordMove[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const response = await ddb.send(new ScanCommand({
      TableName: interviewTableName,
      ExclusiveStartKey: lastEvaluatedKey,
    }));

    for (const item of response.Items || []) {
      if (item.SK !== 'METADATA') continue;
      const ownerUserId = stringValue(item.owner_user_id);
      const interviewId = stringValue(item.interview_id) || stringValue(item.PK).replace(/^INTERVIEW#/, '');
      if (!ownerUserId || !interviewId) continue;

      const user = usersBySub.get(ownerUserId);
      if (!user) {
        console.warn(`Skipping interview ${interviewId}: no Cognito email for owner ${ownerUserId}`);
        continue;
      }

      const moves = collectFieldMoves(item, interviewFields, ownerUserId, user.folder, 'interviews', interviewId);
      if (moves.length) {
        records.push({
          label: `Interview ${interviewId}`,
          tableName: interviewTableName,
          key: { PK: item.PK, SK: item.SK },
          ownerUserId,
          ownerEmail: user.email,
          moves,
        });
      } else if (!item.owner_email) {
        records.push({
          label: `Interview ${interviewId}`,
          tableName: interviewTableName,
          key: { PK: item.PK, SK: item.SK },
          ownerUserId,
          ownerEmail: user.email,
          moves: [],
        });
      }
    }

    lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return records;
}

async function collectMomMoves(usersBySub: Map<string, UserMapEntry>): Promise<RecordMove[]> {
  const records: RecordMove[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const response = await ddb.send(new ScanCommand({
      TableName: momTableName,
      ExclusiveStartKey: lastEvaluatedKey,
    }));

    for (const item of response.Items || []) {
      if (item.item_type === 'PROJECT' || stringValue(item.mom_id).startsWith('PROJECT#')) continue;
      const ownerUserId = stringValue(item.owner_user_id);
      const momId = stringValue(item.mom_id);
      if (!ownerUserId || !momId) continue;

      const user = usersBySub.get(ownerUserId);
      if (!user) {
        console.warn(`Skipping MOM ${momId}: no Cognito email for owner ${ownerUserId}`);
        continue;
      }

      const moves = collectFieldMoves(item, momFields, ownerUserId, user.folder, 'moms', momId);
      if (moves.length) {
        records.push({
          label: `MOM ${momId}`,
          tableName: momTableName,
          key: { mom_id: item.mom_id },
          ownerUserId,
          ownerEmail: user.email,
          moves,
        });
      } else if (!item.owner_email) {
        records.push({
          label: `MOM ${momId}`,
          tableName: momTableName,
          key: { mom_id: item.mom_id },
          ownerUserId,
          ownerEmail: user.email,
          moves: [],
        });
      }
    }

    lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return records;
}

function collectFieldMoves(
  item: Record<string, unknown>,
  fields: string[],
  oldOwnerFolder: string,
  newOwnerFolder: string,
  appFolder: 'interviews' | 'moms',
  recordId: string,
): FieldMove[] {
  const oldPrefix = `users/${oldOwnerFolder}/${appFolder}/${recordId}/`;
  const newPrefix = `users/${newOwnerFolder}/${appFolder}/${recordId}/`;

  return fields
    .map((field) => {
      const oldKey = stringValue(item[field]);
      if (!oldKey || !oldKey.startsWith(oldPrefix)) return null;
      const newKey = `${newPrefix}${oldKey.slice(oldPrefix.length)}`;
      if (oldKey === newKey) return null;
      return { field, oldKey, newKey };
    })
    .filter((move): move is FieldMove => Boolean(move));
}

async function executeRecordMove(record: RecordMove) {
  for (const move of record.moves) {
    await copyAndVerify(move.oldKey, move.newKey);
  }

  await updateRecord(record);

  for (const move of record.moves) {
    await s3.send(new DeleteObjectCommand({
      Bucket: bucketName,
      Key: move.oldKey,
    }));
  }
}

async function copyAndVerify(oldKey: string, newKey: string) {
  const destinationExists = await objectExists(newKey);
  if (!destinationExists) {
    await s3.send(new CopyObjectCommand({
      Bucket: bucketName,
      Key: newKey,
      CopySource: `${bucketName}/${encodeS3CopySourceKey(oldKey)}`,
      MetadataDirective: 'COPY',
    }));
  }

  const copied = await objectExists(newKey);
  if (!copied) {
    throw new Error(`Copy verification failed for ${oldKey} -> ${newKey}`);
  }
}

async function updateRecord(record: RecordMove) {
  const updates = ['owner_email = :owner_email'];
  const values: Record<string, unknown> = {
    ':owner_email': record.ownerEmail,
  };

  record.moves.forEach((move, index) => {
    const token = `:key${index}`;
    updates.push(`${move.field} = ${token}`);
    values[token] = move.newKey;
  });

  await ddb.send(new UpdateCommand({
    TableName: record.tableName,
    Key: record.key,
    UpdateExpression: `SET ${updates.join(', ')}`,
    ExpressionAttributeValues: values,
  }));
}

async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({
      Bucket: bucketName,
      Key: key,
    }));
    return true;
  } catch {
    return false;
  }
}

function encodeS3CopySourceKey(key: string): string {
  return encodeURIComponent(key).replace(/%2F/g, '/');
}

function normalizeUserFolder(email: string): string {
  const localPart = email.split('@')[0] || email;
  return localPart
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'user';
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
