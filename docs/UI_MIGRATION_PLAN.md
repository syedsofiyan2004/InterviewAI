# UI Migration Plan

## Rollback Baseline

- **Protected source snapshot:** branch `codex/ui-redesign-baseline`
- **Snapshot commit:** `62e2d2d chore: snapshot working UI before redesign`
- **Working redesign branch:** `codex/ui-redesign-phase-0`

No phase may rewrite or delete the working workflow path before a small replacement has passed its documented checks.

## Phase Sequence

| Phase | Scope | Code change type | Workflow risk | Exit criteria |
|---|---|---|---|---|
| 0 | Audit and workflow inventory | Documentation only | None | Build baseline recorded; risks and rollback path documented |
| 1 | Reference research | Documentation only | None | Eight or more references mapped to MiMo-specific patterns |
| 2 | UX blueprint and IA | Documentation only | None | Shell, lists, records, and processing states specified |
| 3 | Design foundations | Shared CSS tokens and primitive hardening | Medium | Light/dark renders, focus states, dialog behavior, and build pass |
| 4 | Shell and navigation | App shell, sidebar, top bar, breadcrumbs | High | Auth redirects, tours, desktop/mobile navigation, theme, and build pass |
| 5 | Collection patterns | Interview, Intelligence, MOM list presentation and URL state | High | List filters, record navigation, empty/loading/error states pass |
| 6 | Evaluation detail | Presentational extraction and detail composition | Critical | Upload, guide, analysis, retry, result, report, and delete checks pass |
| 7 | Intelligence Interview Kit | Detail composition around existing state/API behavior | Critical | Teams/manual transcript, review, approval, report, retry checks pass |
| 8 | MOM projects and details | Project/report composition and upload feedback | Critical | Single and bulk upload, polling, result, download, delete checks pass |
| 9 | Forms, onboarding, and accessibility | New/create forms, tours, dialogs, keyboard/mobile work | High | Input validation, focus, reduced motion, 360/768/1024/1440 views pass |
| 10 | Report presentation | Separate PDF review and layout hardening | High | Long-content samples, no overflow, stable report download pass |
| 11 | Keka integration UX | Isolated integration scope only after core UX approval | Critical | Approved APIs/mappings/auth contract and integration tests pass |

## Phase 3 Implementation Boundaries

Phase 3 may:

- centralize semantic CSS tokens;
- establish spacing, typography, surface, border, focus, and status conventions;
- improve shared UI primitives without changing their public behavior;
- make `ConfirmDialog`, toasts, and focus states accessible while preserving callback contracts.

Phase 3 may not:

- change API calls, upload mechanics, queueing, polling, auth redirects, Teams behavior, Keka behavior, report generation, or database/infrastructure;
- add a major component library;
- replace pages wholesale.

## Test Strategy Before Structural Changes

The current repository has no frontend test runner. Before extracting or materially restructuring a high-risk page, add a focused test stack only after confirming the existing Next.js tooling and developer workflow.

Minimum coverage target before detail-page work:

| Priority | Scenario |
|---|---|
| P0 | Protected route redirects and public login access |
| P0 | Evaluation upload/guide/analysis gate and retry states |
| P0 | MOM create/upload/processing/result/report path |
| P0 | Intelligence guide/transcript/review/approval/report path |
| P0 | Delete confirmation for all record types |
| P1 | Light/dark theme rendering and focus visibility |
| P1 | List context retained from list to detail and back |
| P1 | 360px, 768px, 1024px, and 1440px visual checks |
| P1 | Keyboard navigation, dialog Escape/focus behavior, reduced motion |

## Verification Commands

| Command | Current use | Status at Phase 2 |
|---|---|---|
| `npm run build` in `frontend` | Production frontend build | Passed during Phase 0 baseline |
| `npm run build` in `infrastructure` | Infrastructure TypeScript build | Passed during Phase 0 baseline |
| `git diff --check` | Whitespace integrity | Passed for documentation changes |
| Frontend unit/integration tests | Workflow regression coverage | Not configured |
| Browser accessibility/visual checks | Interaction and viewport quality | Not configured |

## Change Discipline

For each implementation pull/commit-sized change:

1. Identify the owning route/component and API behavior it depends on.
2. Make the smallest compatible change.
3. Run the relevant build/type checks.
4. Validate failed, loading, and successful UI state, not just the happy path.
5. Check both themes and at least one narrow viewport before combining with the next route.
6. Keep unrelated formatting, refactors, and infrastructure changes out of the same change.

## Rollback Procedure

If a UI phase causes workflow regression:

1. Stop edits in the affected phase.
2. Capture the exact route, action, visible failure, and console/network behavior.
3. Compare against `codex/ui-redesign-baseline` at commit `62e2d2d`.
4. Revert only the affected, newly introduced commit or restore the affected file from the baseline after understanding unrelated changes.
5. Re-run the workflow check and production build before resuming.

Do not reset, redeploy, alter data, or modify infrastructure as a response to a frontend UI regression.

## Dependency Decision

### Do not add now

- A full UI component library: Tailwind, Lucide, and existing components can support the intended system.
- Global state management: current route-local state should be stabilized with URL context before considering a new store.
- A query cache: measure duplicate fetching after list-state work; do not add it solely to modernize the stack.
- An animation library: CSS and reduced-motion-aware transitions cover the current requirements.

### Candidate additions later, only with approval

- A focused test library appropriate to the Next.js version and repository conventions.
- Browser automation for workflow and visual/accessibility regression checks.
- A light query/data cache only if measurements show meaningful duplicate requests or navigation flicker.
