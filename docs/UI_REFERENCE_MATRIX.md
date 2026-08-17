# UI Reference Matrix

This matrix converts external product research into constrained decisions for Minfy MiMo AI Hub. It is not a component library shopping list.

| Reference | Pattern observed | MiMo use case | Adopt in redesign | Explicit guardrail |
|---|---|---|---|---|
| Linear | Saved and shareable filtered views; focused records | Interview, Intelligence, MOM lists | URL-backed temporary filters and durable detail routes | Do not add custom saved views or keyboard commands before API/accessibility support |
| Notion | One data set can support filter/sort and multiple views | Work queues | Consistent toolbar and responsive table/list composition | Do not expose arbitrary editable data views |
| Attio | Records combine identity, related data, files, and activity | Evaluation, workspace, MOM detail | Compact identity header, related artifacts, activity/history | Avoid CRM density and irrelevant fields |
| Vercel | Project-scoped jobs with factual status, logs, errors, retry | Queued analysis and report generation | Truthful lifecycle panels and visible recovery actions | Never invent percentages or success before backend confirmation |
| Greenhouse | Interview kit joins role, resume, questions, instructions, scorecard | Intelligence detail | Content-led Interview Kit and distinct candidate/panel assessments | Do not expose an internal technical stepper as the primary interface |
| GitHub | Review decisions, status checks, activity timeline, evidence | Approval and report review | Status + evidence + decision in one record | Do not use developer terminology for hiring decisions |
| Raycast | Searchable actions, pinned shortcuts, safe destructive confirmations | Secondary actions later | Contextual action menus; future command search | No command palette before navigation and a11y foundation |
| Retool | Practical table-first scanning and operational density | Daily work lists | Stable rows, concise columns, compact filters | Avoid builder-like surfaces and excessive dashboard panels |

## Prioritized Screen Patterns

| Priority | Screen pattern | Target routes | Primary user outcome | Phase |
|---|---|---|---|---|
| P0 | Reliable shell and shared feedback | All authenticated routes | Navigation and status feel stable and accessible | 2 |
| P0 | Dense, filterable collection list | `/interviews`, `/interviews/intelligence`, `/mom` | Find active work and resume it quickly | 3 |
| P0 | Record header and content navigation | All detail routes | Understand the record and the next action without scrolling a long form | 4 |
| P0 | Intelligence Interview Kit | `/interviews/intelligence/view` | Prepare, review, approve, and export without exposing backend stages | 5 |
| P1 | Interview and MOM form/upload refinement | New and project routes | Complete uploads and processing safely with fewer errors | 6 |
| P1 | Login/auth presentation refinement | `/login` | Make authentication clearer without changing Cognito behavior | 7 |
| P1 | Report-view alignment | Detail and download entry points | Keep on-screen and PDF review concepts aligned | 8 |
| P2 | Keka integration UX | Intelligence flows | Add data retrieval only after the stable core UX is approved | Final isolated phase |

## Evidence Requirements Before Implementation

| Change category | Evidence required | Failure condition |
|---|---|---|
| Shell or sidebar | Keyboard navigation, small viewport screenshot, tour replay check | Existing route/tour target breaks |
| Collection redesign | Empty, loading, error, populated, and processing fixtures | Filter/action changes record state or hides recoverable errors |
| Detail redesign | Completed, failed, queued/processing, and retry fixtures | Visual code changes upload, poll, analyze, approve, or delete behavior |
| Intelligence redesign | Teams unavailable, transcript ready, analysis failed, analysis complete fixtures | UI claims a transcript/review/report exists when backend does not say it does |
| Any animation | Reduced-motion and interaction responsiveness check | Input, scrolling, or focus becomes delayed |
| Any Keka work | Approved endpoint list, mapping rules, auth/secret handling, error contracts | UI is built around guessed provider behavior |

## Phase 1 Exit Criteria

- At least eight external product references are documented with direct rationale.
- Every adopted pattern has a MiMo-specific use case and guardrail.
- Keka work is explicitly sequenced after core UX work.
- No frontend, backend, infrastructure, auth, integration, or deployment behavior changes in this phase.
