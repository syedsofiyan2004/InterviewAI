# Keka Hire Integration

The Interview Intelligence workspace reads Keka Hire data server-side. Browser code never receives a Keka client secret or API key.

## Required Keka privileges

- Job Read
- JobField Read
- CandidateDetails Read
- CandidateInterview Read
- CandidateResume Read
- CandidateScorecard Read

Candidate note, assessment, and candidate update privileges are not needed for the read-only workspace flow. They can be added later only when report write-back is approved.

## Runtime configuration

Set `KEKA_INTEGRATION_MODE=live` and provide one of the following:

1. Recommended: `KEKA_SECRET_ARN`, pointing to an AWS Secrets Manager JSON secret:

```json
{
  "baseUrl": "https://your-company.keka.com",
  "clientId": "Keka OAuth client ID",
  "clientSecret": "Keka OAuth client secret",
  "apiKey": "Keka API key",
  "scope": "kekaapi"
}
```

2. Local development only: `KEKA_BASE_URL`, `KEKA_CLIENT_ID`, `KEKA_CLIENT_SECRET`, `KEKA_API_KEY`, and optional `KEKA_SCOPE`.

The application requests the Keka token with `grant_type=kekaapi` and uses the scope `kekaapi` by default.

## User flow

1. Select a Keka role.
2. Select a candidate for that role.
3. Select the scheduled interview.
4. The application creates an owner-scoped workspace with the Keka job description, candidate metadata, panel details when Keka supplies them, and Teams meeting details when present.

The Teams transcript remains unavailable until the meeting ends and Microsoft Teams finishes transcription.

## Data handling

Keka API credentials are used only by the API Lambda. The application stores the selected IDs and the data required for the interview workspace. It does not expose access tokens, client secrets, or API keys through the frontend or API responses.
