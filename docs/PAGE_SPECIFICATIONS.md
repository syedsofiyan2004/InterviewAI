# Page Specifications

## Shared Page Anatomy

All authenticated pages use this order:

1. Breadcrumb or collection context where applicable.
2. Page header with title, concise description, and one primary action.
3. Supporting content with a clear content width and section spacing.
4. Truthful state treatment: loading, empty, processing, success, or failure.

Pages should not create a card around every paragraph, field, or status. A card is reserved for a durable unit of work, a grouped form section, a table, a result panel, or a modal/drawer.

## Home Dashboard: `/`

**Purpose:** Direct users to actual work, not sell the platform.

**Required data:** Existing counts and list data only.

**Content order:**

1. Personal greeting/page title, without marketing language.
2. Attention strip only when real processing, failed, or approval-needed records exist.
3. Module entry cards or rows with current count and primary action.
4. Recent records only after a real, scoped recent-record source is available.

**Not allowed:** fictional usage metrics, generic capability cards, decorative visual fields, or a fourth empty module placeholder.

## Interview Evaluations Collection: `/interviews`

**Purpose:** Find evaluations needing review or action.

**Columns:** Candidate, role, status, updated, report readiness, action.

**Toolbar:** Existing status filter first. Search/sort only once implemented with safe URL state.

**States:**

- Empty: explain there are no evaluations and offer `New evaluation`.
- Processing: show current status, not a fake progress bar.
- Failed: show failure status and open the record for recovery.
- Loading: table skeleton preserving final column geometry.

## New Evaluation: `/interviews/new`

**Purpose:** Create a record and attach the required source material safely.

**Structure:**

1. Title and short explanation of required inputs.
2. Role/JD selection or upload as one logical section.
3. Candidate and transcript material as a second logical section.
4. Optional resume clearly labeled optional.
5. One primary create/continue action with an inline validation summary.

**Guardrail:** The existing partial-create cleanup and JD attachment behavior must remain intact.

## Evaluation Record: `/interviews/view?id=`

**Identity header:** Candidate, role, status, updated time where available, primary next action.

**Context navigation:** Overview, Interview guide, Analysis, Report.

**Overview:** input checklist and direct recovery action.

**Interview guide:** categorized questions, intended competency, follow-up guidance, and scoring cues.

**Analysis:** assessment summary, scores, evidence by JD requirement, candidate recommendation, and panel assessment only where returned.

**Report:** report readiness, download, and retry context when failed.

## Intelligence Collection: `/interviews/intelligence`

**Purpose:** Manage active interview kits and completed intelligence reports.

**Header:** Explains the supported intelligence workflow without mentioning Keka availability or mock states as product labels.

**Record row/card fields:** candidate, role, current state, transcript availability, assessment state, last update, next supported action.

**Integration status:** show only as a concise, contextual warning when it directly blocks a current action. It must use user-actionable language.

## New Intelligence Workspace: `/interviews/intelligence/new`

**Purpose:** Create the durable interview record before the interview.

**Required fields:** Candidate, role/JD source, panel, meeting organizer/source details required by the current backend.

**Optional field:** Resume upload or attachment according to current capability.

**Form behavior:** reveal only fields required for the chosen supported input source. Do not show future Keka controls until the integration is real.

## Intelligence Record / Interview Kit: `/interviews/intelligence/view?id=`

**Context navigation:** Overview, Interview kit, Transcript, AI assessment, Report.

**Overview:** Candidate, role, organizer, meeting source, readiness, and the one next supported action.

**Interview kit:** JD summary, candidate/resume context, questions grouped by category, instructions, signals, and rubric.

**Transcript:** Teams sync/retry state, transcript content/source when present, and next recovery action if the transcript is not ready.

**AI assessment:** Candidate assessment, coverage/evidence, panel effectiveness and calibration, and a clear distinction between AI output and human approval.

**Report:** Approval status, report download, and report history where data exists.

**Danger zone:** Delete workspace only here, after context and with a strong confirmation dialog.

## MOM Projects: `/mom`

**Purpose:** Enter a project and understand its report health.

**Project card/list information:** project title, report count, active/failure count, latest report date, and open action.

**Report list:** meeting title, date, project, status, updated time, report action.

## New MOM Project: `/mom/new`

**Purpose:** Create a durable location for meeting reports.

**Structure:** One concise form. Avoid presenting report upload behavior before the project exists.

## MOM Project: `/mom/project?id=`

**Purpose:** Add and manage meetings under a project.

**Primary action:** Add a meeting transcript.

**Secondary action:** Bulk upload up to the supported limit, with per-file outcome display only when the existing response data supports it.

**Content:** Project header, active processing notice, report list ordered by actual meeting date when available, project danger zone.

## MOM Record: `/mom/view?id=`

**Purpose:** Read, review, and share a meeting analysis.

**Context navigation:** Overview, Meeting summary, Source, Report.

**Content:** executive summary, attendees, decisions, actions, risks, next steps, source availability, report download.

**Layout rule:** Do not split a section heading from its first meaningful content block across pages in the downloadable report. PDF changes remain a later isolated report phase.

## Login: `/login`

**Purpose:** Authenticate, register, confirm, complete a temporary-password challenge, or reset a password.

**Design rule:** Improve field composition and feedback only. Do not alter Cognito challenge sequencing, API/auth behavior, or recovery logic during visual phases.

**State rule:** Each auth mode has a clear title, one sentence of instruction, field errors, a pending state, and a visible route back to sign in.
