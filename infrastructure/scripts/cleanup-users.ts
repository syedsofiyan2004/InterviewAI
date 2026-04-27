import { CognitoIdentityProviderClient, ListUsersCommand, AdminDeleteUserCommand } from '@aws-sdk/client-cognito-identity-provider';

const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || 'ap-south-1' });

async function run() {
  const userPoolId = process.env.COGNITO_USER_POOL_ID;

  if (!userPoolId) {
    throw new Error('Missing environment variable: COGNITO_USER_POOL_ID');
  }

  const protectedEmail = "sofiyangladiator@gmail.com";
  console.log(`Starting cleanup for User Pool: ${userPoolId}`);
  console.log(`Protected user: ${protectedEmail}`);

  // 1. List all users
  const users = await cognito.send(new ListUsersCommand({
    UserPoolId: userPoolId,
  }));

  let deletedCount = 0;

  for (const user of users.Users ?? []) {
    const username = user.Username!;
    const emailAttr = user.Attributes?.find(attr => attr.Name === 'email');
    const email = emailAttr?.Value;

    if (email === protectedEmail) {
      console.log(`Skipping protected user: ${email} (${username})`);
      continue;
    }

    // 2. Delete user
    console.log(`Deleting user: ${email || 'No Email'} (${username})...`);
    await cognito.send(new AdminDeleteUserCommand({
      UserPoolId: userPoolId,
      Username: username,
    }));
    deletedCount++;
  }

  console.log(`Cleanup complete! Deleted ${deletedCount} users.`);
}

run().catch(console.error);
