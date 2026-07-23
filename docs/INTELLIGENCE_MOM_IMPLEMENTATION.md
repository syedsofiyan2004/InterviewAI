# Combined Milestone: Intelligence Mode and MOM

## Scope

This milestone combines the original Phase 7 and Phase 8 UI work. It improves
how users move through the existing Intelligence Mode and MOM workflows without
changing their data flow or integrations.

## Intelligence Mode

- Replaced the long progressive panel experience with four focused workspace
  views: Overview, Interview guide, Transcript, and Review & report.
- Kept the lifecycle contextual: the transcript view leads into review once a
  transcript exists, and the review view directs users back to the transcript
  when one is still required.
- Preserved Teams synchronization, manual/demo transcript entry, resume upload,
  guide generation, automatic review, polling, approval, PDF download, and
  workspace deletion behavior.
- Replaced implementation-facing status language in the header with clearer
  workspace and connection status.

## MOM

- Split each project into focused Project reports, Add a meeting, and Bulk
  upload contexts while keeping the same upload and background-analysis flow.
- Split a completed MOM detail record into Summary, Discussion, Actions & risks,
  and Report contexts.
- Retained single and bulk uploads, folder selection, parallel queueing,
  polling, report download, and project/report navigation.

## Verification

- `npm run build` passed from `frontend` after all changes.
- Scoped ESLint continues to report legacy issues in these pages (existing
  `any` types and hydration effects); no new API or business-logic changes were
  introduced by this milestone.

## Rollback

The protected baseline remains `codex/ui-redesign-baseline` at `62e2d2d`.
The immediately preceding focused Evaluation UI commit is `89e00ea`.
