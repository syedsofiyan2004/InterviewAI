# 2024 MAP Partner Cash Construct

Source: partner-provided "2024 MAP partner cash construct" slide (AWS, p.7). Transcribed from a
funnel chart. Percentages are always **% of ARR** (the customer's projected annual AWS run-rate —
use the TCO Calculator's "Total 12 months cost" figure as ARR unless the user says otherwise).

**Reminder (per user preference): these percentages/thresholds are not expected to change often,
so this file is the source of truth for calculations rather than something to re-derive per run.**

## ARR tiers

| Tier | ARR range |
|---|---|
| MAP | $500K – $10M |
| MAP Lite | $100K – $500K |
| MAP Lite (small) | $1 – $100K |
| Not MAP-eligible | Below $1K ARR, or above $10M (needs a different program — flag for manual review) |

## Phase 1 — Assess (MAP and MAP Lite $100K–$500K only)

- Up to **5% of ARR** in partner cash, **capped at $75,000**.
- Not available to MAP Lite ($1–$100K) tier.

## Phase 2 — Mobilize (MAP and MAP Lite $100K–$500K only)

Up to **+20% of ARR** in partner cash total, made up of these stackable modifiers:

| Modifier | Amount | Cap | Condition |
|---|---|---|---|
| Modernization services | +10% of ARR | $100K | **ARR must be $500K+ (MAP tier only)**. 40% of migration scope must be "modern services" per AWS modernization pathways. |
| Greenfield | +10% of ARR | $100K | Customer must have AWS Greenfield account designation. |
| VMware (% of ARR) | +10% of ARR | $200K | 75% of migrated workloads must be from VMware. |
| VMware (per-VM) | +$200 per migrated VM | $1,000,000 | Paid to partner only after migration is completed. **Not intended for customer visibility** — keep this line internal-only in any customer-facing output. |

Footnote: payable starting at cumulative tagged revenue of $50K (Large MAP only).

Not available to MAP Lite ($1–$100K) tier.

## Phase 3 — Migrate and Modernize (all tiers)

| Tier | Base credit |
|---|---|
| MAP ($500K–$10M) | +25% of ARR in credits |
| MAP Lite ($100K–$500K) | +15% of ARR in credits |
| MAP Lite ($1–$100K) | 15% of ARR in credits (this is the ONLY benefit available at this tier) |

Plus these stackable modifiers (confirmed applicable to MAP and MAP Lite $100K–$500K tiers;
**unconfirmed whether they extend to the $1–$100K MAP Lite tier — flag as an assumption when used**):

| Modifier | Amount | Applies when |
|---|---|---|
| Database & analytics | +10% of ARR in credits | Workload includes DB&A-included services (see included-services.md) |
| SAP & Oracle apps | +50% of ARR in credits | Workload includes SAP/Oracle-included services (see included-services.md) |
| VMware | +10% of ARR in credits | **MAP Lite only** (per chart annotation) — 75% VMware workload condition likely still applies; confirm with AWS partner terms if this modifier is actually being claimed. |

## Inputs that CANNOT be derived from a TCO Calculator export

These must be asked of the user directly, per engagement — do not infer or default them:

1. **Greenfield designation** — is the customer AWS Greenfield-designated? (Y/N)
2. **% of workloads that are VMware** — needed to check the 75% VMware threshold for both the
   Mobilize VMware modifier and (if applicable) the Migrate&Modernize VMware credit.
3. **% of migration scope that is "modern services"** — needed to check the 40% threshold for the
   Modernization services modifier.
4. **Number of migrated VMs** (if VMware modifier is being claimed) — needed for the $200/VM
   calculation.

If the user doesn't know a figure, treat that specific modifier as "not claimed" rather than
guessing, and note it as such in the output.

## Assumptions worth flagging to the user

- Which ARR figure to use: this reference assumes the TCO Calculator's stated 12-month total
  is the ARR. If the deal has ramp-up, multi-year, or non-standard terms, confirm with the user.
- Whether Assess/Mobilize cash applies to MAP Lite ($100K–$500K): the source chart's layout
  suggests yes (shared boxes span both rows), but this should be confirmed against current AWS
  partner terms before being relied on for an actual funding commitment — this skill produces an
  *estimate*, not a binding funding calculation.
