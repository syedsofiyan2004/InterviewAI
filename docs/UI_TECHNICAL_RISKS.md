# UI Technical Risks and Rollback Plan

## Current Architecture Constraints

| Area | Constraint | Why it matters for UI work |
|---|---|---|
| Authentication | Cognito session and protected routes are controlled by `AuthContext` and `AppShell`. | Shell or login changes can accidentally introduce redirect loops or expose a protected page during loading. |
| Ownership | Lambda verifies `owner_user_id` for record operations. | UI must not assume records can be shared or fetched through unscoped links. |
| Uploads | Browser uploads directly to pre-signed S3 URLs and then confirms through API Gateway. | A new upload component must preserve the two-step request and file-type validation. |
| Async analysis | Interview/MOM use SQS workers; Intelligence review is invoked then polled from the record. | A progress UI must not invent percentages or treat a request acknowledgement as completion. |
| Reports | PDFs are generated server-side and exposed through short-lived signed URLs. | UI changes may improve presentation but must retain report download actions and error recovery. |
| Teams/Careers | Integration status may be live, mocked, manual, or unavailable. | UI must expose the real backend state rather than imply that a transcript or JD has been synced. |

## Risks Found During Phase 0

| ID | Severity | File(s) | Root cause | Risk to user/workflow | Safe repair strategy |
|---|---|---|---|---|---|
| R-01 | Critical | `frontend/src/app/interviews/view/page.tsx` | Multiple responsibilities in one 1101-line client component. | Visual refactors can alter polling, analysis gating, uploads, and report behavior. | Add fixture-driven workflow tests first; extract presentational sections only, one at a time. |
| R-02 | Critical | `frontend/src/app/interviews/intelligence/view/page.tsx`, `infrastructure/lambdas/api-handler/intelligence-integrations.ts` | UI represents an integration-driven, multi-step record with distinct backend status values. | A generic stepper can expose unavailable actions or misrepresent Teams/AI state. | Preserve backend status as source of truth; map it into UI labels in one adapter. |
| R-03 | High | `frontend/src/app/interviews/new/page.tsx`, `mom/project/page.tsx`, `intelligence/view/page.tsx` | Direct browser uploads duplicate transport logic between routes. | A shared upload redesign can accidentally omit confirm calls, content type, or error handling. | Extract a transport helper only after tests cover pre-signed URL plus confirmation sequence. |
| R-04 | High | `frontend/src/components/layout/AppShell.tsx`, `Sidebar.tsx`, `TourOverlay.tsx` | Existing tours rely on concrete IDs and desktop shell layout. | Responsive/collapsible navigation can cause tours to target absent/hidden elements. | Keep IDs stable; add tour fallback behavior before mobile navigation changes. |
| R-05 | High | `frontend/src/components/ui/ConfirmDialog.tsx` | Custom dialog has no standard keyboard/focus behavior. | Accessibility regression and destructive-action risk. | Upgrade dialog primitive without changing callback signature; test Escape, focus trap, cancel, and restore. |
| R-06 | High | All list routes | No request cache and filters are local state. | Navigation refreshes lists, loses filters/scroll, and can create loading flicker. | First adopt URL state; evaluate a query cache only after measuring duplicate fetches. |
| R-07 | Medium | `frontend/src/app/globals.css` | Global CSS mixes design tokens with route-specific visual styles and hardcoded colors. | Token migration can cause light/dark regressions across every page. | Add missing semantic tokens, migrate one primitive at a time, screenshot both themes after each batch. |
| R-08 | Medium | `frontend/src/components/ui/TourOverlay.tsx` | Inline colors/shadows/motion ignore theme tokens and reduced-motion preference. | Tours may clash with the updated product theme and can be uncomfortable for motion-sensitive users. | Move visuals to tokens and add reduced-motion handling after core shell work. |
| R-09 | Medium | `frontend/src/components/layout/Topbar.tsx` | Page title mapping is duplicated pathname logic and tour reset triggers full reload. | New screens can receive an incorrect title; reset is disruptive. | Introduce declarative page metadata later; retain current reset behavior until a compatible replacement exists. |
| R-10 | Medium | `frontend/src/app/mom/project/page.tsx` | Batch upload reports only generic aggregate UI state. | Users cannot immediately identify retryable individual failures. | Do not change bulk backend behavior in UI phase; add a route-local, truthful per-file view only after observing returned data. |
| R-11 | Medium | `frontend/src/app/login/page.tsx` | Cognito sign-in, sign-up, confirmation, reset, and challenge flows are in a large bespoke component. | Layout changes can interfere with sensitive validation and state transitions. | Freeze auth behavior; refactor only field/panel presentation with direct flow tests. |
| R-12 | Medium | `frontend/src/lib/api.ts` | API client is strong central boundary but has no normalized error taxonomy or client cache. | Different routes translate the same failure inconsistently. | Add a non-breaking error mapper first; do not change endpoint signatures. |
| R-13 | High | `frontend`, `infrastructure/test`, root `tests` | No frontend unit, integration, accessibility, or visual test suite exists; infrastructure Jest test is a placeholder. | UI regressions will be caught manually after deployment. | Add narrow workflow fixtures and route/component tests before structural UI work. |

## Required Test Baseline Before UI Refactors

| Priority | Test | Scope |
|---|---|---|
| P0 | Protected/public route behavior | AppShell plus AuthContext behavior for login and authenticated routes. |
| P0 | Interview creation and upload gating | New interview route; JD/transcript/guide gate before analysis. |
| P0 | Interview processing/result/retry | Detail rendering for queued, processing, completed, failed. |
| P0 | MOM creation, upload, processing/result/retry | Project and detail routes. |
| P0 | Intelligence guide, transcript, analysis, approval | Each truthful status boundary and retry UI. |
| P0 | Delete confirmation | Interview, MOM, project, intelligence workspace. |
| P1 | Light and dark renders | Shared shell and status components. |
| P1 | URL list state | Filters/sort and list-to-detail-to-list restoration once implemented. |
| P1 | Accessibility | Dialog focus/Escape, keyboard nav, labels, live regions. |
| P1 | Visual regression | Login, dashboard, list, detail, form, empty, failed, processing in both themes. |

## Dependency Decision

### Do not add during Phase 0

- Do not add a major component library. Current Tailwind and Lucide stack can support a considered token and primitive system.
- Do not add global state merely to simplify component wiring.
- Do not add an animation library before motion needs are identified.
- Do not add a data-fetching cache before URL-state and request-duplication needs are measured.

### Candidates to justify in a later phase

- A focused test stack for React component and workflow tests, selected after confirming project conventions.
- A browser automation/visual regression tool for the required responsive and theme snapshots.
- A lightweight query cache only if the audit implementation proves repetitive list fetches are materially affecting the product.

## Rollback Plan

1. **Baseline commit:** `62e2d2d` on branch `codex/ui-redesign-baseline` contains the known working state before the redesign audit.
2. **Phase branch:** `codex/ui-redesign-phase-0` is isolated from that baseline. No UI source code has changed in this phase.
3. **Commit per phase:** Each approved phase must be committed independently, with build/test evidence in its commit message or accompanying notes.
4. **No destructive migration:** Routes, API client interfaces, DynamoDB schema, Cognito configuration, S3 prefixes, queues, Lambda handlers, and report paths remain unchanged unless separately approved.
5. **Deploy gate:** No production deploy for a visual phase until the frontend build passes and critical workflow checks for the touched area are complete.
6. **Revert:** If a phase regresses a workflow, revert that one phase commit or switch to `codex/ui-redesign-baseline`; do not reset or overwrite unrelated work.

## Phase 0 Outcome

The safest next step is **Phase 1 reference research only**. It will not alter application code. It will study specific enterprise patterns, record what can be adapted, and produce a reviewable direction before any design-system or shell implementation begins.

