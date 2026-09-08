import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

async function token(): Promise<string> {
  const secretId = process.env.MS_TEAMS_SECRET_ARN;
  if (!secretId) throw new Error('MS_TEAMS_SECRET_ARN is missing');
  const secret = await new SecretsManagerClient({ region: 'ap-south-1' }).send(new GetSecretValueCommand({ SecretId: secretId }));
  const credentials = JSON.parse(secret.SecretString || '{}');
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(credentials.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }).toString(),
  });
  const body = await response.json() as { access_token?: string };
  if (!response.ok || !body.access_token) throw new Error(`Graph token failed: ${response.status}`);
  return body.access_token;
}

async function main() {
  const accessToken = await token();
  const start = new Date(Date.parse('2026-09-03T06:30:00.000Z'));
  const end = new Date(Date.parse('2026-09-03T08:30:00.000Z'));
  const params = new URLSearchParams({
    startDateTime: start.toISOString(),
    endDateTime: end.toISOString(),
    '$select': 'id,subject,start,end,onlineMeeting,onlineMeetingUrl,webLink,attendees,organizer',
    '$top': '50',
  });
  const response = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent('syed.sofiyan@minfytech.com')}/calendarView?${params.toString()}`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  const body = await response.json() as { value?: any[] };
  const items = (body.value || []).map((event) => ({
    subject: event.subject,
    start: event.start,
    end: event.end,
    organizer: event.organizer?.emailAddress?.address,
    hasJoinUrl: !!(event.onlineMeeting?.joinUrl || event.onlineMeetingUrl),
    joinUrl: event.onlineMeeting?.joinUrl || event.onlineMeetingUrl || null,
    attendeeEmails: (event.attendees || []).map((attendee: any) => attendee.emailAddress?.address).filter(Boolean),
  }));
  console.log(JSON.stringify({ status: response.status, count: items.length, items }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
