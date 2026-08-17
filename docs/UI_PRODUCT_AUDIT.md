# UI Product Audit

**Product:** Minfy MiMo AI Hub  
**Audit scope:** Frontend UI, client state, workflow affordances, and integration boundaries.  
**Excluded from this phase:** Changes to product behavior, API contracts, data models, AWS resources, authentication, ownership checks, AI processing, and PDF generation.

## Repository and Product Understanding

Minfy MiMo AI Hub is a static Next.js application served through CloudFront and backed by Cognito, API Gateway, Lambda, DynamoDB, S3, SQS, and Bedrock. The frontend is a single authenticated workspace with three product capabilities:

1. **Interview Evaluator** for creating an evaluation, uploading a JD, transcript, and optional resume, preparing a question guide, starting asynchronous analysis, viewing evidence, and downloading a report.
2. **Interview Intelligence** for setting up an interview workspace, preparing a panel guide, optionally syncing a Teams transcript, running the AI review, approving the result, and downloading the report.
3. **MOM Analyzer** for creating projects, creating or bulk-uploading meeting transcripts, monitoring asynchronous analysis, viewing results, and downloading a PDF.

The application is functionally connected. Its UI is composed from route-local pages plus a small shared shell and UI layer; it is not yet a system of reusable product primitives.

## Route Inventory

| Route | Screen type | Current responsibility |
|---|---|---|
| `/login` | Authentication | Sign-in, registration, confirmation, temporary-password completion, password reset. |
| `/` | Hub dashboard | Shows the two module entry points and live counts. |
| `/interviews` | List/dashboard | Evaluation metrics, status filter, evaluation table, delete action. |
| `/interviews/new` | Form/upload | Creates an evaluation, selects a Careers JD or uploads documents. |
| `/interviews/view?id=` | Detail/workflow | Uploads, guide preparation, analysis processing, results, report download, delete. |
| `/interviews/intelligence` | List/dashboard | Intelligence records, integration status, high-level metrics. |
| `/interviews/intelligence/new` | Form | Creates an intelligence workspace from candidate, role, panel, and meeting details. |
| `/interviews/intelligence/view?id=` | Detail/workflow | Workspace details, resume, panel guide, transcript, AI review, approval, report download, delete. |
| `/mom` | Projects/list dashboard | Project cards, MOM table, status filter, project and MOM deletion. |
| `/mom/new` | Form | Creates a MOM project. |
| `/mom/project?id=` | Project detail/upload | Adds one meeting or a supported group of files, polls active analyses, links to reports. |
| `/mom/view?id=` | Result/detail | Polls processing, renders meeting result, downloads report. |

## Current Shell, Navigation, and Theme

### Shell

- `frontend/src/app/layout.tsx` supplies the root AuthProvider and AppShell.
- `frontend/src/components/layout/AppShell.tsx` protects all routes except `/login`, renders the sidebar and top bar, mounts tours, and tracks pointer position for a radial visual treatment.
- `frontend/src/components/layout/Sidebar.tsx` is a fixed 220px desktop navigation. It contains home, module navigation, account, sign-out, and theme toggle.
- `frontend/src/components/layout/Topbar.tsx` uses pathname matching to derive one page title and exposes a tour replay button.

### Theme

- Semantic variables live in `frontend/src/app/globals.css` for light and dark values.
- Theme selection is stored in `localStorage`; the initial layout script defaults to dark mode.
- The CSS file also contains page-specific classes for the hub, login, intelligence workflow, metrics, uploads, buttons, and pointer-driven backgrounds.

### State and data access

- The frontend uses React `useState` and `useEffect` only. There is no shared query cache, request deduplication, mutation invalidation, or route-level data loader.
- `frontend/src/lib/api.ts` is the single API client and owns Cognito-authorized fetch calls and TypeScript response types.
- List data is fetched per route mount. Filters and selections are mostly local component state, rather than URL state.
- Long-running analysis uses page-local polling: 3 seconds for Interview and MOM details, 4 seconds for Intelligence review.

## Shared UI Inventory

| Component | Current use | Audit finding |
|---|---|---|
| `AppShell` | Authenticated shell and tours | Correct ownership boundary, but also owns visual pointer state and has no mobile shell mode. |
| `Sidebar` | Primary navigation, identity, theme | Clear module grouping, but fixed-width and not responsive/collapsible. |
| `Topbar` | Page label and tour replay | Minimal but not yet a product top bar: no breadcrumbs, page actions, search, notifications, or user menu. |
| `StatusBadge` | Interview and MOM status | Useful baseline, but it only knows the classic workflow state model. |
| `Toast` | Route-local feedback | UI feedback exists, but lacks a shared provider, warning state, live-region semantics, and queueing. |
| `ConfirmDialog` | Delete confirmations | Supports destructive confirmation but lacks dialog semantics, focus trapping, Escape behavior, and focus restoration. |
| `TourOverlay` | New-user guidance | Valuable onboarding system; its visuals and tokens are hardcoded inline rather than theme-driven. |

## Existing Loading, Empty, Error, and Processing States

- **Loading:** Each major list and detail page has a local spinner or skeleton. The implementation is inconsistent: some pages use dedicated skeleton components while others show a blank/centered spinner.
- **Empty:** Interview, intelligence, and MOM lists each implement their own empty state composition and action copy.
- **Error:** Failures are displayed through a mix of inline alert boxes, local toast messages, route-level error pages, and raw backend messages.
- **Processing:** Classic Interview and MOM detail routes poll asynchronously and use `StatusBadge`. Intelligence has its own state model and a separate rail/tabs design.

## Product-Level UI Weaknesses

| Severity | File / component | Finding | User impact | Recommended correction | Change risk |
|---|---|---|---|---|---|
| High | `frontend/src/app/interviews/view/page.tsx` | At 1101 lines, data loading, polling, uploads, guide preparation, results, delete behavior, and all sublayouts coexist in one file. | Small UI changes can break analysis, report, or upload behavior. | Extract presentation-only sections behind stable props after workflow tests are added. | High - preserve side effects and API call timing. |
| High | `frontend/src/app/interviews/intelligence/view/page.tsx` | At 646 lines, workspace setup, transcript sync, polling, review, approval, tabs, and sections are coupled. | The progressive workflow is harder to reason about and easy to render in an incomplete state. | Keep the route and API calls, but separate record loading/action orchestration from visual sections. | High - Teams sync and review status must remain exact. |
| High | `frontend/src/components/ui/ConfirmDialog.tsx` | The dialog has no `role="dialog"`, `aria-modal`, focus trap, Escape close, or focus restoration. | Keyboard and assistive-technology users can lose context or activate background controls. | Standardize an accessible dialog primitive before changing destructive flows. | Medium - do not change confirmation callbacks. |
| High | `frontend/src/components/layout/Sidebar.tsx` and `AppShell.tsx` | Shell is permanently 220px wide with `height: 100vh` and no drawer/collapse pattern. | Tablet and mobile users lose usable content width; controls can fall below the viewport. | Introduce a responsive shell with desktop collapse and mobile drawer while preserving paths. | Medium - tours target sidebar IDs. |
| High | `frontend/src/app/interviews/page.tsx`, `mom/page.tsx` | List filters are local-only state; returning from details restarts the route fetch and loses filter/scroll context. | Daily users must repeat filtering and scanning work. | Move shareable filter/sort/tab state to search parameters and add a route-context restoration pattern. | Medium - URL compatibility must be retained. |
| High | `frontend/src/app/globals.css` | The global stylesheet mixes tokens, shared primitives, page-specific Intelligence styles, pointer effects, login animation, and raw shadows/colors. | A redesign becomes harder to apply consistently, and dark/light behavior is difficult to verify. | Keep variables, split foundation/component/page styles conceptually, then migrate to semantic tokens incrementally. | Medium - broad visual blast radius. |
| Medium | `frontend/src/components/layout/Topbar.tsx` | Page title is hardcoded from pathname; the only action clears local tour keys then reloads the browser. | No consistent page context, breadcrumbs, support, recent items, or contextual action model. | Replace with a page-header contract and retain tour replay as a labeled secondary action. | Medium - tour behavior should remain available. |
| Medium | `frontend/src/components/ui/StatusBadge.tsx` | Classic status mapping does not cover Intelligence states such as `questions_generated`, `transcript_ready`, `analysis_generated`, and `approved`. | Similar records communicate state differently across modules. | Define one normalized UI status model mapped from each backend workflow. | Low - mapping only, no API change. |
| Medium | `frontend/src/app/interviews/page.tsx` | Avatar/stat colors are literal hex values in the route. | Light/dark palette changes create inconsistent semantic meaning. | Replace route colors with semantic token variants during Phase 3. | Low. |
| Medium | `frontend/src/components/ui/TourOverlay.tsx` | Theme colors, sizing, shadows, and transitions are inline constants. | Theme adjustments require editing behavior-heavy code; tour can visually diverge from product. | Move visual constants to CSS variables while preserving DOM IDs and timing. | Medium - onboarding behavior is production-facing. |
| Medium | `frontend/src/app/interviews/new/page.tsx`, `mom/project/page.tsx`, `intelligence/new/page.tsx` | Forms use page-specific card and validation arrangements; no common form section, error summary, or unsaved-change protection exists. | Form behavior and affordances differ between otherwise similar workflows. | Establish a small form primitive set before changing individual forms. | Medium - file upload and creation actions are critical. |
| Medium | `frontend/src/app/mom/project/page.tsx` | Bulk upload performs sequential route-local upload and queue actions with only generic progress copy. | Multi-file operations can feel stalled and individual failures are difficult to recover. | Add a presentation-level batch status model once API output is understood; do not fabricate progress. | Medium - backend only returns current outcomes. |
| Medium | `frontend/src/app/login/page.tsx` | The login screen is a 700+ line multi-state route using bespoke presentation styles. | Authentication is harder to regression-test and is not aligned with a reusable form system. | Leave auth behavior unchanged; later extract field/panel presentation only. | High - Cognito challenge/reset flows are sensitive. |
| Medium | `frontend/src/components/layout/AppShell.tsx` and `globals.css` | Pointer tracking updates React state on every mouse move to render radial decoration. | Can cause avoidable re-render work and gives non-essential motion a central place in the shell. | Measure first; replace with CSS-only or remove only after visual review. | Low to medium. |
| Low | `frontend/src/components/ui/Toast.tsx` | Toast has no `role="status"`/`role="alert"`, no warning variant, and no shared queue. | Feedback can be missed by screen-reader users; messages may overlap. | Standardize a toast provider in a later shared-primitives phase. | Low. |
| Low | `frontend/README.md`, `infrastructure/README.md` | Both are starter templates, unlike the root README. | New reviewers do not get accurate local run/test/deploy guidance. | Replace only after the UI audit documents are accepted. | Low. |

## Accessibility and Responsive Audit

### Confirmed risks

- The shell has no mobile navigation mechanism.
- ConfirmDialog lacks expected keyboard-dialog behavior.
- TourOverlay is visually rich but uses inline styles and no explicit reduced-motion preference handling.
- Several controls rely on `title` for meaning rather than visible labels or assistive text.
- No automated accessibility tool or visual regression test is configured.
- Status is primarily color plus text, which is better than color alone, but the status grammar differs by module.

### Verification still required

- Keyboard traversal through sign-in, upload, dialog, and report actions.
- 360px, 768px, 1024px, 1440px, and wide desktop layouts.
- Light/dark contrast at each token and component state.
- Zoom and long-name/long-file-name overflow checks.

## Audit Conclusion

The product should not be replaced with a new template. The safest direction is an incremental design-system migration: establish a truthful status vocabulary and shared page/form/feedback primitives first, improve the shell next, then migrate one workflow at a time behind existing routes and API contracts.

