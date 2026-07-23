# Navigation Specification

## Intent

Navigation should establish location, preserve context, and surface only supported actions. It is not a container for future product ideas.

## Sidebar

### Required behavior

- Full-height desktop navigation, fixed at 220px until a collapse interaction is implemented and tested.
- Product identity links to `/`.
- Home and module groups remain route-backed links.
- Active state is determined by route matching, including the Intelligence collection and detail routes.
- Account footer contains the signed-in identity, theme control, and sign out.
- The footer remains visible within the viewport and should not push sign out below the fold.

### Target interaction

| Interaction | Desktop | Mobile / tablet | Accessibility |
|---|---|---|---|
| Open a module | Link | Link inside drawer | Native link semantics, clear active state |
| Collapse rail | Icon button, optional later | Not applicable | Tooltip, `aria-label`, focus visible |
| Open navigation | N/A | Menu button opens drawer | Focus moves into drawer, Escape closes, focus restores |
| Toggle theme | Footer icon button | Footer/icon menu action | Announces current mode and toggle result |
| Sign out | Footer action | Footer/drawer action | Explicit action; no accidental sign out |

### Visual rules

- Solid surface. No opacity/translucency or blur treatment.
- Active item uses one accent-tinted surface and accessible text contrast.
- Hover feedback is low-cost and limited to color/border changes, not layout shifts.
- Section labels are compact navigation landmarks, not decorative typography.

## Top Bar

### Current safe scope

The top bar may contain:

- mobile navigation trigger once implemented;
- breadcrumb and page identity;
- contextual page actions supplied by the current route;
- a working guide/help control.

It may not pretend to offer global search, notifications, or profile settings until those actions have real behavior and access controls.

### Breadcrumb rules

| Record type | Breadcrumb |
|---|---|
| Evaluation | `Evaluations / [Candidate or role]` |
| Intelligence | `Intelligence / [Candidate or role]` |
| MOM project | `MOM projects / [Project]` |
| MOM report | `MOM projects / [Project] / [Meeting]` when project data is present |

- The collection crumb returns to the prior collection context where URL state is available.
- The current item is text, not a link.
- Never use a breadcrumb as the only back route on small screens; retain a visible back action when the user is within a deep record.

## Contextual Page Actions

| Screen type | Primary action | Secondary actions |
|---|---|---|
| Collection | Create evaluation / workspace / project | Filter, sort when supported |
| New record | Continue / create | Cancel or back |
| Draft record | Upload required input / prepare guide | Download source where available |
| Processing record | View status | Refresh or leave safely |
| Ready record | Review assessment / download report | Retry only when supported |
| Approved Intelligence record | Download approved report | View assessment, delete in danger zone |
| Project | Add meeting | Bulk upload, project delete in danger zone |

No more than one filled primary button should be visible in the page header. If there is no supported action, omit the action region.

## Context Preservation

The planned sequence for list context is:

1. Add URL state for status filter first.
2. Add search and sort only when the list and API behavior support them without client-side ambiguity.
3. Preserve the full query string when opening a record and returning through a collection breadcrumb/back action.
4. Restore scroll position only after collection data loading is stable and covered by browser tests.

## Tours and Help

- Help only remains visible when it restarts a working contextual tour.
- Tours use stable target IDs and must work with the final navigation behavior.
- On small screens, tours target visible controls only; missing targets must safely skip.
- Tour overlays respect dark/light tokens and reduced motion.
