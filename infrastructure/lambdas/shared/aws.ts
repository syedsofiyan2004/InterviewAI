import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { 
  DynamoDBDocumentClient, 
  PutCommand, 
  GetCommand, 
  UpdateCommand, 
  QueryCommand 
} from '@aws-sdk/lib-dynamodb';
import { 
  S3Client, 
  PutObjectCommand, 
  GetObjectCommand 
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'node:stream';
import { 
  BedrockRuntimeClient, 
  InvokeModelCommand 
} from '@aws-sdk/client-bedrock-runtime';

const region = process.env.AWS_REGION || 'ap-south-1';

const ddbClient = new DynamoDBClient({ region });
export const ddbDocClient = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: {
    // Optional integration fields are omitted before DynamoDB marshalling.
    removeUndefinedValues: true,
  },
});

export const s3Client = new S3Client({ region });
export const bedrockClient = new BedrockRuntimeClient({ region });

export function validateEnv(requiredVars: string[]) {
  for (const v of requiredVars) {
    if (!process.env[v]) {
      throw new Error(`Missing required environment variable: ${v}`);
    }
  }
}

export async function getFileContent(bucket: string, key: string): Promise<string> {
  const response = await s3Client.send(new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  }));
  return await response.Body?.transformToString() || '';
}

export async function getFileBuffer(bucket: string, key: string): Promise<Buffer> {
  const response = await s3Client.send(new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  }));
  const bytes = await response.Body?.transformToByteArray();
  if (!bytes) return Buffer.alloc(0);
  return Buffer.from(bytes);
}


export async function saveFileContent(
  bucket: string,
  key: string,
  content: string | Buffer | Readable,
  contentType: string = 'application/json',
  contentLength?: number,
): Promise<void> {
  if (content instanceof Readable) {
    await new Upload({
      client: s3Client,
      params: {
        Bucket: bucket,
        Key: key,
        Body: content,
        ContentType: contentType,
        ...(contentLength === undefined ? {} : { ContentLength: contentLength }),
      },
    }).done();
    return;
  }

  await s3Client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: content,
    ContentType: contentType,
    ContentLength: contentLength,
  }));
}

export async function getPresignedUploadUrl(bucket: string, key: string, contentType?: string) {
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  });
  
  return getSignedUrl(s3Client, command, { expiresIn: 3600 });
}
