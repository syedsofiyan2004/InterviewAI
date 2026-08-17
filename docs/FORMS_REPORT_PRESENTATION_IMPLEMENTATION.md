# Forms And Report Presentation

## Scope

This milestone improves completion guidance and report handoff across the
existing interview and MOM workflows. It does not change API contracts,
uploads, validation rules, saved record data, Bedrock prompts, or PDF
generation.

## Form Improvements

- The standard interview creation flow now clearly explains the selected
  Minfy Careers role and announces that its official description will be
  attached to the evaluation.
- The MOM project form now groups its project information, gives title
  guidance, and surfaces validation failures with accessible alerts.
- The Teams-backed intelligence workspace form now exposes its expanded
  state to assistive technology and labels the role selectors directly.
- Availability and creation failures in Intelligence Mode use live status and
  alert semantics so a screen reader receives the same feedback as a visual
  user.

## Report Presentation

- The intelligence final recommendation is presented as a review summary
  rather than a preformatted log block.
- The existing PDF download is placed in a clear delivery panel and reports
  its preparation state while the download is being requested.
- The report text, approval behavior, download handler, and generated PDF
  remain unchanged.

## Deliberate Non-Changes

- `infrastructure/lambdas/shared/intelligence-report.ts` and
  `infrastructure/lambdas/shared/mom-report.ts` are not changed.
- No backend, API, Cognito, Teams, Keka, Bedrock, storage, or workflow logic
  is modified.
- Normal interview and MOM report content remains intact.

## Verification

Run from `frontend`:

```powershell
npm run build
```

## Rollback

The prior verified milestone is commit `9e2d440`. This milestone is isolated
to frontend presentation and this document, so it can be reverted without
affecting the existing integration or report-generation logic.
