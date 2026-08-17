# Design System

**Phase:** 3 - shared foundation  
**Status:** Initial semantic tokens and shared primitive behavior implemented. Route-level migration is intentionally deferred.

## Design Character

Minfy MiMo AI Hub uses a restrained operational interface: clear hierarchy, solid surfaces, real status language, and one teal brand action. The system avoids glass treatments, decorative gradients, glow effects, and competing accent colors.

## Foundations

### Typography

| Use | Value |
|---|---|
| Font family | Geist Sans, system fallback |
| Monospace | Geist Mono |
| Base text | 15px / 1.6 |
| Page title | 20px / 600 |
| Section title | 16px / 600 |
| Small body | 13px / 1.5 |
| Caption / label | 11px / 1.4 |
| Eyebrow | 10px / 600 / uppercase / 0.16em tracking |

### Spacing and shape

| Use | Value |
|---|---|
| Compact internal gap | 8px |
| Standard control gap | 12px |
| Card padding | 20px to 24px |
| Major section gap | 32px |
| Desktop content padding | 28px to 32px |
| Controls | 8px to 12px radius |
| Panels/tables | 12px radius, subtle shadow |
| Dialogs | 16px radius, elevated shadow |

## Semantic Tokens

Tokens are defined in `frontend/src/app/globals.css` with dedicated light and dark values.

| Token family | Intended use |
|---|---|
| `background`, `surface`, `surface-elevated`, `surface-subtle`, `surface-interactive` | Canvas and layered solid surfaces |
| `text-primary`, `text-secondary`, `text-muted` | Content hierarchy |
| `border`, `border-strong` | Structural and emphasized boundaries |
| `accent`, `accent-hover`, `accent-foreground`, `ring` | Primary action and focus treatment |
| `success`, `warning`, `danger`, `info` | Semantic feedback only |
| `draft`, `processing`, `approved`, `failed`, `disabled` | Product state mapping |

Page components should not add raw colors for ordinary UI. Existing raw page colors will be migrated only with their owning page.

## Motion and Icons

- Motion is limited to direct feedback: dialog/menu opening, action pending state, and small hover feedback.
- Standard timing is 160ms to 200ms.
- The application honors `prefers-reduced-motion: reduce`.
- Lucide outline icons remain the standard: 16px in compact controls, 18px in navigation, 20px in section markers.
- Icon-only controls require a name, tooltip when unfamiliar, and visible focus treatment.

## Accessibility Rules

- Interactive controls are keyboard reachable and visibly focused.
- Dialogs trap focus, close with Escape, restore focus, and use modal semantics.
- Error notifications use assertive alert semantics; other notifications use polite status semantics.
- Color is never the only status signal.

## Component States

| Component | Phase 3 behavior | Later work |
|---|---|---|
| Buttons | Semantic primary/secondary styling, disabled and focus state | Migrate route-local raw buttons |
| Inputs | Shared font/focus convention | Build field/validation composition in form phase |
| Status badge | Accessible label, dot/pill variants, no decorative glow | Add Intelligence mapping through one state adapter |
| Toast | Success, error, info, warning; live-region semantics | Add shared provider/queue only when justified |
| Confirmation dialog | Focus trap, Escape, focus restore, modal semantics | Browser validation for every delete flow |
| Panels | `ui-panel`, card, table surface conventions | Migrate route-local panels incrementally |
| Tour | Existing behavior retained | Tokenize inline presentation in a later accessibility phase |

## Not Added

- No external component library.
- No global state library.
- No data cache/query library.
- No animation library.

These decisions will be revisited only when an implementation phase demonstrates a concrete unmet need.
