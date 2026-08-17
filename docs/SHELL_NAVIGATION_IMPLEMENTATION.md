# Phase 4: Shell And Navigation Implementation

## Scope

Phase 4 changes only the shared application shell. It does not alter any API
call, authentication flow, upload workflow, analysis workflow, approval state,
report generation, or delete behavior.

## Delivered behavior

- The top bar derives the current page title, supporting description, and
  breadcrumbs from the route.
- The desktop navigation can collapse to a 76px icon rail without removing any
  route or tour target.
- A mobile menu opens as a modal drawer, closes through its close control,
  backdrop, Escape, or a navigation selection, and prevents background scroll
  while open.
- All existing sidebar destinations and labels remain unchanged.
- The existing pointer-light effect remains available, but pointer updates are
  batched with `requestAnimationFrame` and written directly to CSS custom
  properties. This avoids a React render for every pointer movement.

## Interaction rules

- The menu button appears only below the desktop breakpoint.
- The desktop rail state is local to the current browser session; it does not
  change product data or user settings.
- The icon rail keeps accessible names and native hover titles for every action.
- The header only exposes working controls: navigation and the existing guide
  replay action.

## Validation

The shared shell is verified through the frontend production build and targeted
linting. Page-level workflow verification remains part of subsequent phases,
because this phase intentionally does not change page behavior.
