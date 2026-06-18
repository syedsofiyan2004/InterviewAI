# Interview Intelligence V2

Interview Intelligence V2 adds a separate workflow beside the existing Classic Interview Evaluation. It is designed for interview preparation, Teams transcript intake, interviewer scoring, panel calibration, and AI-assisted final review.

## What Was Added

- New frontend routes under `/interviews/intelligence`.
- New backend route group under `/intelligence-interviews`.
- Separate DynamoDB table for Interview Intelligence records.
- Mock/manual Keka and Teams integration adapters.
- Pre-interview question generation based on JD, resume, candidate context, and dynamic interview panel.
- Post-interview analysis for candidate evaluation, interviewer coverage, JD coverage, panel calibration, and final AI-assisted report.

## Classic Mode Protection

Classic Interview Evaluation remains on:

- `/interviews`
- `/interviews/new`
- `/interviews/view`
- Existing `/interviews` backend APIs

The classic flow, upload behavior, SQS processor, and PDF report generation are not replaced by V2.

## Mock Mode

The current implementation works without real Keka or Microsoft Teams credentials.

- `MockKekaIntegration` returns sample JD, candidate, panel, and Teams link.
- `MockTeamsIntegration` returns a sample transcript.
- Manual mode lets users paste JD, resume text, panel members, Teams URL, transcript, and human scores.

The UI clearly shows Keka and Teams integration modes.

## Environment Variables

Current mock defaults:

```env
KEKA_INTEGRATION_MODE=mock
TEAMS_INTEGRATION_MODE=mock
NEXT_PUBLIC_ENABLE_INTERVIEW_INTELLIGENCE=true
```

Future live credentials:

```env
KEKA_BASE_URL=
KEKA_CLIENT_ID=
KEKA_CLIENT_SECRET=
KEKA_API_KEY=
KEKA_SCOPE=

MS_TENANT_ID=
MS_CLIENT_ID=
MS_CLIENT_SECRET=
MS_GRAPH_SCOPES=
```

Do not expose real Keka or Microsoft credentials in the frontend. All live integration calls must remain server-side.

## Switching To Live Later

To switch Keka or Teams from mock to live:

1. Implement the live adapter behind the existing `KekaIntegration` or `TeamsIntegration` interface.
2. Store credentials as backend environment variables or secrets.
3. Set `KEKA_INTEGRATION_MODE=live` and/or `TEAMS_INTEGRATION_MODE=live`.
4. Keep manual fallback enabled for integration outages.

## Current Limitations

- No real Keka API calls are made yet.
- No Microsoft Graph calls are made yet.
- Question generation and analysis use deterministic logic so the workflow is testable without Bedrock.
- Final recommendation is AI-assisted only. Human approval remains required.
- Panel calibration only runs when more than one interviewer score is available.
