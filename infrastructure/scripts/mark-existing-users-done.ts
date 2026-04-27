import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { CognitoIdentityProviderClient, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-south-1' });
const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || 'ap-south-1' });

async function run() {
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  const tableName = process.env.DYNAMODB_TABLE_NAME;

  if (!userPoolId || !tableName) {
    throw new Error('Missing environment variables: COGNITO_USER_POOL_ID or DYNAMODB_TABLE_NAME');
  }

  console.log(`Starting migration for User Pool: ${userPoolId} and Table: ${tableName}`);

  // List all existing Cognito users
  const users = await cognito.send(new ListUsersCommand({
    UserPoolId: userPoolId,
  }));

  for (const user of users.Users ?? []) {
    const userId = user.Username!;
    await dynamo.send(new PutItemCommand({
      TableName: tableName,
      Item: {
        PK: { S: `USER#${userId}` },
        SK: { S: 'PREFERENCES' },
        tour_completed: { BOOL: true },
        updated_at: { N: String(Date.now()) },
      },
    }));
    console.log(`Marked user ${userId} as tour_completed = true`);
  }
  
  console.log('Migration complete!');
}

run().catch(console.error);
