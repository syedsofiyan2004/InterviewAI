# Information Architecture

**Phase:** 2 - approved target structure, constrained by current capabilities.

## Current Functional Navigation

```text
Minfy MiMo AI Hub
|- Home
|- Interview Evaluator
|  |- Evaluations
|  |- New evaluation
|  `- Intelligence mode
`- MOM Analyzer
   |- Projects
   `- New project
```

This is the navigation that may be rendered as functional during the redesign. It maps to existing routes and existing API behavior.

## Collection and Record Hierarchy

```text
Home
|- Interview Evaluator
|  |- Evaluations (collection)
|  |  `- Evaluation (record)
|  `- New evaluation (creation)
|- Interview Intelligence
|  |- Intelligence workspaces (collection)
|  |  `- Interview kit (record)
|  `- New workspace (creation)
`- MOM Analyzer
   |- Projects (collection)
   |  `- Project (record)
   |     `- MOM report (record)
   `- New project (creation)
```

## Route Compatibility

| User concept | Existing route | Target page identity | Compatibility rule |
|---|---|---|---|
| Home | `/` | Operational dashboard | Keep route unchanged |
| Evaluations | `/interviews` | Evaluation work queue | Keep route and list APIs unchanged |
| Create evaluation | `/interviews/new` | New evaluation | Keep upload/creation flow unchanged |
| Evaluation record | `/interviews/view?id=` | Evaluation record | Preserve ID query route and all actions |
| Intelligence workspaces | `/interviews/intelligence` | Interview Intelligence | Keep route and integration status request unchanged |
| Create Intelligence workspace | `/interviews/intelligence/new` | New interview workspace | Keep create request unchanged |
| Intelligence record | `/interviews/intelligence/view?id=` | Interview Kit | Preserve ID query route and existing Teams/review actions |
| MOM projects | `/mom` | MOM projects and reports | Keep project and report list requests unchanged |
| Create project | `/mom/new` | New MOM project | Keep create request unchanged |
| Project record | `/mom/project?id=` | MOM project | Preserve file upload and batch processing behavior |
| MOM report | `/mom/view?id=` | MOM record | Preserve ID query route, polling, report, and deletion |

## Context Navigation

### Evaluation record

`Overview | Interview guide | Analysis | Report`

The visible tab is selected using URL state only after the component supports safe deep links. Tabs are presentation-level groupings; they may not alter backend gating.

### Intelligence record

`Overview | Interview kit | Transcript | AI assessment | Report`

The tab labels intentionally hide implementation stages. They map the existing record state into a user-oriented presentation:

- Overview contains record readiness and the single next action.
- Interview kit contains candidate/JD/resume/question guidance.
- Transcript contains Teams/manual transcript availability and source.
- AI assessment contains candidate and panel outputs only after analysis exists.
- Report contains approval and PDF output only after the backend exposes them.

### MOM record

`Overview | Meeting summary | Source | Report`

The visible composition may be a single document for short records, but long reports should use anchored sections and preserve a fixed report action.

## Future Areas: Not Yet Functional

The product design may reserve these concepts in documentation only. They must not be shown as active navigation until supported.

| Future area | Needed before it can appear |
|---|---|
| Global search | Cross-record search endpoint, authorization rules, keyboard/a11y contract |
| Notifications | Event stream, read state, notification preference model |
| Activity | Durable cross-record event source and retention policy |
| Reports | Cross-module report index API and permission model |
| Integrations | Supported integration management API, connection health, authorized admin ownership |
| Administration | Role/permission model and secure admin endpoints |
| Saved views | Persisted user preferences or shareable view model |

## Responsive IA Rules

| Viewport | Navigation | Collection | Record |
|---|---|---|---|
| Wide desktop | Persistent rail | Full table and toolbar | Header plus horizontal contextual navigation |
| Tablet | Collapsible rail | Horizontally scrollable table or prioritized columns | Two-column metadata becomes one/two responsive columns |
| Mobile | Drawer rail | Stacked record list with explicit labels | Stacked metadata, scrollable tab bar, sticky primary action when needed |

## Naming Decisions

| Avoid | Use |
|---|---|
| Stage, gate, pipeline step | Overview, guide, transcript, assessment, report |
| Keka mock / Teams live | Integration status only when it explains a supported action |
| AI processing worker | Analysis in progress |
| Workspace when referring to a single interview output | Interview Kit or Intelligence workspace depending on context |
| Unknown candidate | Missing candidate details |
