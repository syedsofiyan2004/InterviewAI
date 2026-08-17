# Product UX Blueprint

**Phase:** 2 - product UX blueprint  
**Product:** Minfy MiMo AI Hub  
**Scope:** UX architecture and implementation constraints. No frontend or backend behavior changes are included in this phase.

## Product Intent

Minfy MiMo AI Hub is a daily internal work product for delivery managers, recruiters, interviewers, and project teams. It must make the state of work clear without asking users to understand queues, S3, API calls, or model execution.

The product should feel like one operational workspace with three connected modules:

- **Interview Evaluator:** post-interview assessment from a JD, transcript, and optional resume.
- **Interview Intelligence:** preparation, transcript capture, AI candidate and panel assessment, approval, and report output.
- **MOM Analyzer:** project-organized meeting analysis and shareable reports.

## Design Principles

1. **Records, not screens.** An evaluation, Intelligence workspace, project, and MOM are durable work records. Every important action should be recoverable from that record.
2. **Truth before polish.** Processing status comes from the backend. The UI cannot claim a transcript, report, approval, or sync exists until it does.
3. **One primary action.** A page should make the next safe action obvious. Everything else is secondary or contextual.
4. **Progressive disclosure.** Start with the information needed now. Put source files, evidence, metadata, logs, and destructive actions in deliberate secondary areas.
5. **Data earns its place.** Metrics, cards, warnings, and badges exist only when backed by real data and a user decision.
6. **Evidence is readable.** AI conclusions must appear beside the relevant source evidence, not as unexplained scores.
7. **The same interaction means the same thing.** Status, approvals, report downloads, retry, delete, loading, and errors follow common patterns across modules.
8. **Accessibility is core product quality.** Keyboard reachability, focus visibility, semantic controls, error announcement, contrast, and reduced motion are non-negotiable.

## Primary Jobs To Be Done

| User | Job | Success condition |
|---|---|---|
| Hiring manager | Find an evaluation that needs attention and review its evidence | Can locate, understand, and act on the record without opening unrelated screens |
| Interview panel | Prepare a focused interview guide | Sees role context, candidate context, question categories, and scoring guidance in one kit |
| Reviewer | Decide whether an AI-generated report is ready | Can compare conclusion, evidence, panel assessment, and approval status in one record |
| Project manager | Add and monitor meeting reports under one project | Can see which reports are ready, running, or need a retry |
| Delivery lead | Return to work already in progress | List state, record state, and relevant actions remain easy to resume |

## Product Shell Blueprint

### Desktop shell

- A persistent navigation rail identifies the product and current module.
- A compact top bar supplies contextual breadcrumbs, current page identity, and only real page-level actions.
- Content uses a constrained work area with responsive padding and no decorative background treatment that affects readability or performance.
- The account area is anchored at the bottom of the navigation and includes profile identity, theme selection, and sign out.

### Navigation principles

- Modules remain grouped by actual application capability.
- Creation actions are retained near their collection because they are frequent, explicit tasks.
- Navigation labels use user concepts, not implementation terms.
- The current route receives a visible active treatment that remains readable in light and dark themes.
- The shell must not introduce a visible Reports, Activity, Integrations, Notifications, or Administration destination until the application has a real, authorized route and data source for it.

### Small screens

- The desktop rail becomes an accessible drawer triggered from the top bar.
- Current-page actions remain visible in the content header or a sticky action area when justified.
- Tables either become scrollable with pinned identifying columns or transform into labeled record rows. Actions may not disappear.

## Collection Blueprint

Each collection page follows this order:

1. Page header: title, one factual description, one primary creation action.
2. Optional operational summary: only metrics that come from the current list response.
3. Collection toolbar: search, filter, sort, and view controls when the API can support them truthfully.
4. Main record list: clear identity, status, relevant metadata, last activity, and one row action.
5. State region: loading skeleton, empty state, error recovery, or active processing notice.

### List state rule

When a filter, search query, sort order, selected tab, or page can be represented safely in the URL, it should be. Returning from a record should restore the list context and scroll position once the implementation has tests for this behavior.

## Record Detail Blueprint

Every detail route uses the same hierarchy:

1. **Breadcrumb:** return to the related collection with the user context preserved.
2. **Identity header:** record title, supporting identity (candidate, role, project, or meeting date), canonical status, and the primary next action.
3. **Context navigation:** tabs or a responsive segmented navigation for meaningful content areas.
4. **Focused workspace:** only the active content area, not all stages expanded on one long page.
5. **Related material:** source files, report link, audit/activity history, or metadata in a lower-priority location.
6. **Danger zone:** delete is visually isolated and always confirmed.

## Interview Evaluator Experience

### Collection

- Default to the actionable work queue.
- Show candidate, target role, status, updated time, and report state.
- Retain the ability to filter by real status values: created, processing, completed, and failed.

### Evaluation record

- **Overview:** candidate, role, input readiness, and next action.
- **Interview guide:** categorized recommended questions and scoring rubric.
- **Analysis:** candidate summary, competency scores, evidence by requirement, recommendation, and panel review where available.
- **Report:** report state and download action.
- **Activity:** record events only when an underlying timestamp/event is available.

Existing JD, transcript, resume upload, question-guide, queue, polling, retry, result, report, and delete behavior remain unchanged.

## Interview Intelligence Experience

The Intelligence record is an **Interview Kit**, not a visible engineering sequence.

| Content area | Purpose | Existing source of truth |
|---|---|---|
| Overview | Candidate, role, organizer, meeting, source readiness, next action | Intelligence record |
| Interview kit | JD summary, resume context, categorized guide, scoring signals | Existing record, resume, generated guide |
| Transcript | Teams retrieval state and source transcript | Existing Teams/manual transcript endpoints |
| AI assessment | Candidate assessment, coverage, evidence, panel effectiveness, calibration | Existing AI evaluation result |
| Report | Approval status and PDF download | Existing approval and report endpoints |

The UI must distinguish candidate assessment from panel assessment. It must never represent a panel rating as a manual action unless the backend actually requires one. Generic opening/resume questions may remain in the guide but must be identified as non-counting for panel effectiveness when the model supports that distinction.

Keka remains out of scope until all above surfaces are stable and the integration contract is separately approved.

## MOM Analyzer Experience

### Projects

- Projects are the durable parent record for meeting reports.
- The project overview makes report count, active processing, failures, and most recent activity visible.
- Adding a meeting is the primary action; bulk upload is a secondary, clearly bounded action.

### MOM record

- **Overview:** title, project, meeting date, report status, and next safe action.
- **Summary:** executive summary, attendees, decisions, risks, actions, and next steps.
- **Source:** original transcript attachment/reference where available.
- **Report:** direct PDF download and failure recovery.

## Processing and Recovery Model

The component language can normalize the presentation, but it cannot collapse distinct backend states into false success. The current states map as follows:

| Product state | Current backend evidence | UI language | Primary action |
|---|---|---|---|
| Draft / created | `CREATED` or initial record | Ready for input | Add required material |
| Ready | Required uploads / guide are confirmed | Ready to analyze | Start analysis |
| Queued / processing | `QUEUED`, `PROCESSING`, or Intelligence processing status | Analysis in progress | Leave safely; show refresh/poll context |
| Ready for review | Completed report/result or `analysis_generated` | Ready for review | Open assessment / approve |
| Approved | Intelligence `approved` | Approved | Download report |
| Failed | `FAILED` or Intelligence failed status | Needs attention | Explain failure and offer supported retry |

Rules:

- Never show a percentage unless a backend progress value exists.
- Disable duplicate submission while an action request is pending.
- Success confirmation must identify what completed, not simply say "Done".
- Failure must include the supported recovery action and retain source material already saved.
- Leaving a processing record is safe when the backend queue/worker owns the process; the UI must say this explicitly.

## Writing Rules

- Use explicit operational copy: "Transcript is ready for review", "Analysis is running", "Retry analysis", "Report approval is required".
- Do not expose environment, S3, Lambda, model, queue, mocked integration, or developer-only terminology in the standard user experience.
- Treat integration-specific details as support diagnostics only when a user can act on them.

## Out of Scope Until Later Phases

- Keka data retrieval and matching.
- New API endpoints or database schema.
- Global search, notifications, activity center, saved custom views, and administration routes without corresponding API/data/authorization support.
- Changes to Teams, Cognito, S3, Bedrock, Lambda, report generation, file-processing, or ownership logic.
