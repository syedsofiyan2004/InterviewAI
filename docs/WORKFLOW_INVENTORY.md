# Workflow Inventory

This inventory records the current production workflows that UI work must preserve. Route names and API paths are current as of the Phase 0 audit.

## Cross-Cutting Rules

- Every API request goes through `frontend/src/lib/api.ts` and authenticated `authFetch`, except direct browser uploads to pre-signed S3 URLs.
- Cognito protects API routes. The API handler verifies ownership before record access, upload confirmation, analysis, download, and deletion.
- S3 upload keys are scoped under the authenticated user prefix.
- Do not replace polling, queue submission, or report generation during UI-only phases.

## Authentication

| Workflow | Entry and action | APIs / state | Success | Failure / recovery | Navigation |
|---|---|---|---|---|---|
| Sign in | `/login`, submit email and password | Cognito through `AuthContext` / `auth.ts` | Auth user becomes available | Inline error; supports Cognito challenges | `next` search param or `/` |
| Sign up and confirm | `/login`, select registration flow | Cognito sign-up and confirmation | Account confirmed | Field validation and inline error | Returns to sign in |
| Temporary password | `/login`, complete challenge | Cognito new-password-required challenge | Password changed, session established | Inline error | `next` or `/` |
| Forgot password | `/login`, start and confirm reset | Cognito reset and confirmation | Password reset | Inline error | Returns to sign in |
| Sign out | Sidebar footer | `AuthContext.signOut` | Session cleared | N/A | Full navigation to `/login` |

## Interview Evaluator

| Workflow | Entry and action | APIs / state | Success | Failure / recovery | Output / navigation |
|---|---|---|---|---|---|
| List evaluations | `/interviews` | `GET /interviews`; local status filter | Metrics and rows render | Console plus local state fallback | Row opens `/interviews/view?id=` |
| Create evaluation | `/interviews/new`; select Career JD or complete metadata | `POST /interviews`, optional `POST /interviews/{id}/minfy-jd` | Record created; selected JD attached | Deletes partially created record when setup fails | Moves to upload/setup route |
| Upload JD, transcript, resume | New or detail route file inputs | Pre-signed URL, browser `PUT`, then `POST /interviews/{id}/confirm-upload` | Upload state becomes `FILES_UPLOADED` when JD and transcript exist | Error callout/toast; can retry upload | Remains on evaluation detail |
| Prepare guide | Evaluation detail | `POST /interviews/{id}/question-guide` | Stored guide is visible | Toast retains request error | Remains in setup |
| Start analysis | Evaluation detail after transcript, JD, and guide | `POST /interviews/{id}/analyze`; record set to `QUEUED` | SQS worker processes; UI polls every 3 seconds | Failed record shows error and restart action | Remains on detail until result |
| View result | Evaluation detail | `GET /interviews/{id}`, then `GET /interviews/{id}/result` after completed | Evidence, scores, and recommendation render | Route error state or retry analysis | Detail remains canonical record |
| Download report | Evaluation detail | `GET /interviews/{id}/report` | Browser opens signed PDF URL | Toast with download failure | Same detail route |
| Delete evaluation | List or detail confirmation | `DELETE /interviews/{id}` | Record and scoped S3 prefix removed | Toast failure | List after detail deletion |

## Interview Intelligence

| Workflow | Entry and action | APIs / state | Success | Failure / recovery | Output / navigation |
|---|---|---|---|---|---|
| List workspaces | `/interviews/intelligence` | `GET /intelligence-interviews`, `GET /integrations/status` | Cards and integration indicators render | Current UI has limited explicit list failure feedback | Opens workspace detail |
| Create workspace | `/interviews/intelligence/new` | `POST /intelligence-interviews` | Workspace record stored | Local inline error | Pushes to detail |
| Save details | Detail setup section | `PATCH /intelligence-interviews/{id}` | Candidate/organizer data stored | Inline action error | Same route |
| Upload resume | Detail setup section | Resume pre-signed URL, browser `PUT`, `POST /confirm-resume` | Resume state stored | Inline action error | Same route |
| Prepare panel guide | Detail setup section | `POST /generate-questions` | Status progresses to `questions_generated` | Inline action error | Same route |
| Add transcript | Detail transcript section | Manual `POST /transcript` or Teams `POST /sync-teams-transcript` | Status progresses to `transcript_ready` | Action error explains Teams/Graph availability | Same route |
| Run AI review | Detail review section | `POST /analyze`; detail polls `GET /intelligence-interviews/{id}` every 4 seconds | `analysis_generated`; AI candidate/panel assessment stored | `analysis_failed` retains error and retry | Same route |
| Approve report | Detail approval section | `POST /approve` | Status becomes `approved` | Action error and retry | Report becomes final |
| Download intelligence report | Detail approval/report section | `GET /report` | Browser opens signed PDF | Action error | Same route |
| Delete workspace | Detail confirmation | `DELETE /intelligence-interviews/{id}` | Record and user-scoped workspace S3 prefix removed | Inline error | Back to intelligence list |

## MOM Analyzer

| Workflow | Entry and action | APIs / state | Success | Failure / recovery | Output / navigation |
|---|---|---|---|---|---|
| Project list | `/mom` | `GET /mom-projects`, `GET /moms` | Project cards and report table render | Toast reports fetch issue | Projects open `/mom/project?id=` |
| Create project | `/mom/new` | `POST /mom-projects` | Project stored | Inline error | Pushes to project detail |
| Create one meeting | Project detail | `POST /moms`, pre-signed URL, browser `PUT`, `POST /confirm-upload`, `POST /analyze` | Record queued for processing | Inline error | Pushes to MOM detail |
| Bulk upload | Project detail | Repeats create/upload/confirm/analyze per supported file | Multiple MOM records queued | Errors currently logged per file with generic completion message | Project view lists reports |
| Poll active MOMs | MOM list and project detail | Re-fetches `GET /moms` every 4 seconds if active statuses exist | Status updates to completed/failed | No per-record retry from the list | Opens MOM detail |
| View MOM result | `/mom/view?id=` | `GET /moms/{id}`, then `GET /result` after completed; polls every 3 seconds | Meeting result renders | Failure panel advises upload/retry | Detail remains canonical record |
| Download MOM report | MOM detail | `GET /moms/{id}/report` | Browser opens signed PDF | Inline download error | Same route |
| Delete MOM | MOM list confirmation | `DELETE /moms/{id}` | Record and associated files removed | Toast failure | Updated list |
| Delete project | MOM list confirmation | `DELETE /mom-projects/{id}` | Project and owned MOMs removed | Toast failure | Updated list |

## Navigation and Current State Behavior

- List-to-detail navigation uses query-string IDs. This preserves record identity and direct linking.
- Filters, sorting, selected views, cursor/page, and scroll position are not stored in the URL or route state today.
- Back navigation is mostly a static link to the unfiltered module list, not a restored previous list context.
- Existing tours identify targets by DOM IDs in the sidebar and major workflows. Any shell redesign must preserve or intentionally migrate these IDs.

## Workflow Protection Checklist for Later Phases

1. Verify direct pre-signed S3 uploads still use the same content type, key, and confirm API.
2. Verify no UI state change submits analysis twice.
3. Verify polling continues after navigation/reload only where backend status requires it.
4. Verify report endpoints remain unchanged and signed URLs open correctly.
5. Verify delete confirmation calls the same endpoints and still returns to a valid route.
6. Verify Teams and Careers integrations never show a false success state when their backend reports unavailable.
7. Verify owner-scoped list/detail/delete behavior with more than one Cognito user.

