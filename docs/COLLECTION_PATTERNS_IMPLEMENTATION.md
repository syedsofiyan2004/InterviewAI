# Phase 5: Collection Patterns Implementation

## Scope

Phase 5 updates the three authenticated collection routes only:

- `/interviews`
- `/interviews/intelligence`
- `/mom`

No API endpoint, upload mechanism, analysis request, polling interval, record
detail page, report action, or delete operation was changed.

## Delivered behavior

- Interview and MOM status filters are represented by the `status` URL query
  parameter. Returning to either collection retains its filter context.
- Created and processing records are grouped as in-progress work when the user
  selects the processing filter.
- Intelligence workspaces expose a compact status selector with its selection
  retained in the URL.
- All three collections distinguish loading, empty, filtered-empty, and request
  failure states.
- List failures provide a recovery action and do not imply that user data was
  removed or modified.
- Evaluation summary cards are semantic buttons instead of click handlers on
  generic containers.

## Intentional limits

- Search, sorting, pagination, activity history, and cross-record bulk actions
  are not introduced because the current APIs do not expose a stable contract
  for them.
- Detail pages, forms, intelligence workflow stages, MOM project upload, and
  report rendering remain for later isolated phases.

## Validation

- Focused ESLint check passed for the three collection routes.
- The frontend production build passed with TypeScript validation.
