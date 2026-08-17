# Component Inventory

**Phase:** 3 - shared component baseline.

## Existing Shared Components

| Component | Responsibility | Current contract | Phase 3 change | Later work |
|---|---|---|---|---|
| `AppShell` | Auth-protected layout, sidebar/topbar, tours | Children only | No change | Responsive shell and breadcrumbs in Phase 4 |
| `Sidebar` | Module navigation, account, theme | No public props | No change | Mobile drawer and collapse behavior in Phase 4 |
| `Topbar` | Page identity and tour replay | No public props | No change | Contextual metadata/actions in Phase 4 |
| `ConfirmDialog` | Destructive/info confirmation | `isOpen`, labels, callbacks, variant | Added focus trap, Escape, focus restore, dialog semantics | Browser validation for every delete flow |
| `Toast` | Route-local transient notification | Message, type, duration, close callback | Added warning type and live-region semantics | Shared provider/queue only when justified |
| `StatusBadge` | Interview/MOM status display | Status, pill/dot variant, className | Added accessible status label and removed decorative glow | Unified Intelligence status adapter |
| `TourOverlay` | New-user education | Tour context | No public contract change | Tokenize inline styles and add small-screen fallback |

## Planned Shared Primitives

| Primitive | Needed by | Do not implement before |
|---|---|---|
| Breadcrumbs | Detail pages | Shell/navigation phase with route metadata |
| Page header | Every route | Route migration starts |
| Filter toolbar | Collections | URL-state contract is defined |
| Data table | Collections | Column/empty/error behavior is specified per collection |
| Empty state | Collections and records | Copy and primary action are known |
| Loading skeleton | Lists and details | Final page geometry is decided |
| Tabs / section navigation | Detail records | Deep-link behavior and keyboard model are decided |
| Activity log | Detail records | Real event/timestamp source is available |
| File upload field | New/detail forms | Existing presigned upload contract is test-covered |
| Tooltip | Icon-only controls | Shared positioning and mobile fallback are decided |

## Component Usage Rules

- Use a shared primitive when the same interaction appears in two or more routes.
- Keep route-specific composition close to the route until the pattern stabilizes.
- Do not convert a one-off report/evidence layout into a generic component prematurely.
- Preserve existing callback signatures and API behavior while migrating visual components.
