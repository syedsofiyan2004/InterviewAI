# UI Reference Research

**Phase:** 1 - reference research only  
**Product:** Minfy MiMo AI Hub  
**Decision:** Keka integration is deliberately deferred until the core product UX is stable, validated, and separately approved.

## Research Objective

The redesign should make recurring work easier to scan, resume, and review. It should not imitate another product's appearance or import patterns that the current product cannot support truthfully.

The relevant unit of work in MiMo is a durable record:

- an interview evaluation;
- an Intelligence workspace;
- a MOM project or meeting report.

The redesign will therefore treat list pages as work queues and detail pages as reviewable records, rather than marketing dashboards or long single-page wizards.

## Product References

### Linear: saved work views and focused record work

Linear's custom views are durable, shareable filtered views that belong in the sidebar, while the browser URL can also carry temporary filters. It also preserves incomplete issue drafts when people navigate away. [Linear custom views](https://linear.app/docs/custom-views) and [Linear issue creation](https://linear.app/docs/creating-issues) provide the relevant behavior.

**Use for MiMo**

- Add practical, URL-backed filters to Interview, Intelligence, and MOM lists: status, owner, date, and project where the API already provides data.
- Make a list item open a durable record detail route, with a clear return to the filtered list.
- Preserve unsaved form values locally only where the current flow already permits a safe retry.

**Do not copy**

- Dense keyboard-first interactions before the product has a command model and accessibility coverage.
- A generic issue-like status vocabulary that hides the real AI, upload, and report states.

### Notion: one data set, several useful views

Notion allows the same data set to be filtered, sorted, grouped, and opened in a side peek, centered view, or full page. [Notion views, filters, and sorts](https://www.notion.com/help/views-filters-and-sorts) explains this model.

**Use for MiMo**

- Keep one source of truth for each collection and layer list controls above it instead of maintaining unrelated dashboard cards and tables.
- Use a responsive table/list as the primary collection view; introduce compact cards only where a table cannot show a key status well.
- On wide screens, consider a detail preview later only if it is keyboard-accessible and preserves a full-page route.

**Do not copy**

- Let users create arbitrary saved views until ownership, sharing, and API query support are intentionally designed.
- Turn every field into an editable database property; reports and AI evidence need stronger review boundaries.

### Attio: record pages with related context

Attio treats a record as a page with related activity, files, and data while its table views support filters, sorts, and exports. [Attio records](https://attio.com/help/reference/managing-your-data/records/create-and-view-records) and [Attio filters and sorts](https://attio.com/help/reference/managing-your-data/views/filter-and-sort-views) describe the pattern.

**Use for MiMo**

- Organize detail pages around a compact identity header, current status, primary action, and related artifacts.
- Surface original source material, generated guide, transcript, AI result, report, and activity in a predictable place.
- Put destructive actions in an overflow menu or a clearly isolated danger zone, never beside the primary next action.

**Do not copy**

- CRM-style data density where most fields are not actionable for a delivery manager.

### Vercel: factual asynchronous status and inspectable history

Vercel groups many deployments under a project and shows status, deployment trigger, URLs, resources, logs, and errors in a project context. [Vercel projects](https://vercel.com/docs/projects) and [Vercel deployments](https://vercel.com/docs/deployments/overview) show this approach.

**Use for MiMo**

- Make queued, processing, completed, failed, and retry states factual and prominent.
- Give users a concise activity/history feed containing only real events: uploaded, queued, guide prepared, transcript synced, review completed, approved, and report downloaded.
- Show a useful error explanation and the safe recovery action in the same state panel.

**Do not copy**

- Fake percentage progress or animated stage completion when the backend has only a status transition.

### Greenhouse: an interview kit, not an exposed workflow engine

Greenhouse's interview kit combines job details, candidate resume, interviewer instructions, questions, and scorecard into the place where an interviewer needs them. Its structured scorecards collect job-specific criteria and recommendations. [Greenhouse interviewer guide](https://support.greenhouse.io/hc/en-us/articles/115002226826-Interviewer-guide-How-to-use-interview-kits) and [scorecard overview](https://support.greenhouse.io/hc/en-us/articles/4414777492891-Scorecard-overview) are especially relevant.

**Use for MiMo**

- Reframe Intelligence detail as an Interview Kit with clear content areas: candidate context, role context, resume, question guide, transcript, AI assessment, panel assessment, approval, and report.
- Keep question categories and evidence grouped by purpose, rather than revealing an engineering sequence of six stages.
- Present candidate assessment and panel assessment as distinct, clearly labeled review outputs.

**Do not copy**

- Manual interviewer scorecard completion as the default for the Intelligence flow. The current product requirement is AI-led review after the transcript is available.

### GitHub: review status, evidence, and decisions belong together

GitHub makes review state explicit, keeps comments and approvals in a timeline, and shows checks as pending, passing, or failing with inspectable detail. [GitHub pull request reviews](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/about-pull-request-reviews) and [GitHub status checks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/about-status-checks) describe the model.

**Use for MiMo**

- Build report approval as a clear review decision with status, reviewer, time, and reversible next action where the backend permits it.
- Keep evidence next to the conclusion it supports, including exact transcript excerpts where they are available.
- Make failures actionable: what failed, whether retry is possible, and what has already completed safely.

**Do not copy**

- Code review metaphors such as diffs, checks, or merge language for candidate and meeting reports.

### Raycast: command surfaces only when tasks are mature

Raycast keeps frequently used actions searchable and makes destructive actions require confirmation. [Raycast quicklinks](https://manual.raycast.com/quicklinks) is a useful model for discoverability and safe actions.

**Use for MiMo**

- Later, add a small command/search surface only after the list and record taxonomy is stable.
- Use a concise action menu for secondary record actions: download, retry, duplicate where supported, and delete.

**Do not copy yet**

- Global keyboard commands or a command palette before labels, focus management, and role permissions are consistently implemented.

### Retool: operational density, selectively applied

Retool is a useful conceptual reference for operational tools: table-first scanning, clear filters, and action-driven records. The MiMo redesign should borrow its practical density, but not its builder-oriented visual language.

**Use for MiMo**

- Tables must remain dense enough to scan routine work: title/candidate, owner, source, status, updated time, and one clear action.
- Filters must not displace the result list below the fold.

**Do not copy**

- Builder controls, dashboard chrome, or multiple panels competing for attention.

## MiMo Design Direction

### 1. Application shell

- Keep the existing module navigation, authentication logic, tours, and route structure.
- Replace decorative pointer/glow treatments with restrained responsive feedback only if it does not cause paint or input lag.
- The page header must answer: where am I, what record or collection is this, and what is the one primary action?
- The help control must only remain if it starts a working tour or opens a real help surface.

### 2. Collections

Use a predictable layout:

1. Page title and one-line truthful summary.
2. Primary creation action.
3. Compact metrics only when they answer a decision-making question.
4. Search and filters in a single toolbar.
5. Responsive table/list with stable row height, status, timestamp, and row action.
6. Honest empty, error, and loading states.

### 3. Record details

Use a predictable layout:

1. Breadcrumb back to the collection.
2. Identity header: title, role/project, current status, and primary action.
3. Context navigation that uses content concepts, not implementation stages.
4. A focused content panel that makes the next necessary action obvious.
5. Related artifacts and status history lower on the page or in a secondary tab.
6. A dedicated danger zone for delete.

### 4. Intelligence interview kit

The preferred content sequence is:

1. **Overview**: candidate, role, meeting, source availability, and one next action.
2. **Interview kit**: JD summary, resume insights, question sets by category, interviewer guidance, scoring rubric.
3. **Transcript**: Teams sync status, captured transcript, and source metadata.
4. **AI assessment**: candidate assessment, coverage, evidence, and panel effectiveness score.
5. **Report**: approval state, final decision, PDF download, and activity history.

This is an information architecture target only. The current backend statuses remain the source of truth and must be mapped into these sections without inventing a completion state.

### 5. Motion and feedback

- Use short, non-blocking transitions only for a direct user action: row hover, menu opening, section transition, submit pending state.
- Respect reduced motion.
- Do not continuously track the pointer on broad page surfaces until browser performance is measured.
- Every async action needs an immediate pending state, a completion confirmation, and a recovery path on failure.

## Keka Deferral

Keka remains a final separate integration phase. No Keka retrieval, syncing, candidate mapping, API contract, or credential behavior will be changed while the product shell, collection views, record details, accessibility, and review experience are being redesigned.
