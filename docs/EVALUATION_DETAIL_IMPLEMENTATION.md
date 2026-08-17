# Phase 6: Evaluation Detail Workflow

## Goal

Make the normal Interview Evaluation record easier to navigate without changing
its operational workflow.

## Implemented

- Added four focused views to `/interviews/view`:
  - Overview: document upload, readiness, and start-assessment controls.
  - Interview guide: approved question-bank prompts and follow-up cues.
  - Analysis: processing, retry, scorecard, evidence, and recommendation.
  - Report: a dedicated, truthful PDF download state.
- Kept the candidate and role context visible above the view switcher.
- Added informative empty states so incomplete records, running analyses, and
  unavailable reports never render as a blank page.
- Retained the existing workflow rail on the setup view.

## Explicitly Preserved

- Existing API calls and data contracts.
- Document upload and presigned-upload behavior.
- Question-guide generation and its recovery check.
- Background polling, retry, deletion, analysis start, and report download.
- Existing tour identifiers, including the setup, processing, result, evidence,
  recommendation, and PDF-download targets.

## Verification

- `npm run build` passed from `frontend`.
- The scoped ESLint run still reports pre-existing `any` and unused-state
  findings in this legacy page. This phase did not add new instances.

## Rollback

The working baseline remains available at `codex/ui-redesign-baseline` and the
Phase 5 collection-work-queue commit remains available immediately before this
phase.
