---
name: map-tco-eligibility
description: Determine AWS MAP / MAP Lite eligibility and produce a MAP eligibility & funding estimate workbook from an AWS Pricing Calculator / TCO Calculator export (PDF). Use this skill whenever the user provides a TCO calculator PDF and asks to check MAP eligibility, qualify a deal for MAP or MAP Lite, "run this through the MAP calculator", "check if this TCO qualifies for MAP funding", "is this deal MAP eligible", or wants to know which services/spend in a TCO estimate are MAP-tagged/qualified spend. Also trigger on brief requests like "check MAP eligibility for this" or "is this MAP qualified" whenever a TCO calculator PDF is attached or referenced. Always use this skill for MAP/MAP Lite eligibility or funding-estimate requests — even if the user doesn't use the word "skill" or spell out every step.
---

# AWS MAP TCO Eligibility Checker

Given an AWS TCO/Pricing Calculator PDF export, determine:
1. Whether the deal qualifies for **MAP** or **MAP Lite** (and which sub-tier), based on ARR.
2. Which line-item services in the estimate are **MAP-eligible spend** (fully, partially, or not
   eligible), per the AWS Included Services List.
3. An **estimated** partner cash / credits breakdown across Assess, Mobilize, and Migrate &
   Modernize phases, applying the funding-modifier rules — using inputs the user supplies for
   anything not derivable from the PDF (Greenfield status, % VMware, % modernization scope).
4. An Excel workbook with an eligibility checklist tab and a calculation tab.

This is a partner-facing **funding estimate**, not a binding eligibility determination — the
output should say so.

## Reference files

- `references/included-services.md` — which AWS services count as MAP-tagged spend, with
  notes on partial exclusions, plus the DB&A and SAP/Oracle included-service subsets and a
  name-matching table for translating TCO Calculator display names to this list.
- `references/map-funding-construct.md` — ARR tiers, phase-by-phase percentages, caps, and
  modifier conditions (Modernization, Greenfield, VMware, DB&A, SAP/Oracle).

Read both before starting — the numbers should come from these files, not from memory.

## Workflow

### 1. Extract data from the TCO Calculator PDF

Use the pdf-reading skill's approach (or `pdftotext`/`pdfplumber`) to pull:
- **Total 12 months cost** (or **Total 12-month cost**) from the Estimate Summary — this is the
  ARR figure used for tier determination, unless the user says the deal has different terms
  (ramp-up, multi-year, etc. — ask if the PDF and the user's description seem to disagree).
- Every row in the **Detailed Estimate** section: Name (service), Group, Region, Monthly cost.
  Sum monthly cost by unique service **Name** (a service like Amazon EC2 typically has dozens of
  line items — one per resource/config — that all roll up to a single service-level total).

If the PDF has a **Group summary** section (Storage/Compute/Database/etc. with monthly totals),
use it as a cross-check against your own per-service sums — they should reconcile.

### 2. Determine MAP tier

Compare ARR (12-month total) against `references/map-funding-construct.md`'s tier table:
MAP ($500K–$10M), MAP Lite ($100K–$500K), MAP Lite small ($1–$100K), or not eligible.

### 3. Match each service against the Included Services List

For each unique service name from step 1, look it up in
`references/included-services.md` (use its name-matching table for known aliases like
"Amazon Elastic Block Store (EBS)" → EC2, "AWS Fargate" → ECS/EKS ambiguous, etc.). Classify as:

- **Eligible** — service and cost type match a table row with no disqualifying exclusion.
- **Partially eligible** — the service is eligible but part of its cost isn't (e.g. data transfer
  is never eligible on any service; a specific sub-feature is called out as excluded). Note what's
  excluded even though the TCO PDF may not break the dollar amount out separately — flag it as a
  qualitative caveat rather than inventing a split you can't support from the data.
- **Not eligible** — explicitly excluded (e.g. EKS Fargate) or a cost type this program never
  covers (data transfer, 3rd-party license).
- **Needs manual review** — service name doesn't clearly match anything in the reference (don't
  guess).

Also tag which services fall under the DB&A subset and/or SAP&Oracle subset, since those drive
Migrate & Modernize modifiers.

### 4. Get modifier inputs from the user

Ask directly in chat (don't infer or default):
- Is the customer AWS Greenfield-designated?
- What % of workloads are VMware-based? (needed for the 75% VMware threshold)
- What % of migration scope is "modern services" per AWS modernization pathways? (needed for the
  40% modernization threshold)
- If VMware modifier applies: how many VMs are being migrated? (for the $200/VM calculation)

If the user doesn't know a number, treat that modifier as not claimed and say so in the output —
don't guess a figure that flatters the estimate.

### 5. Calculate the estimated funding

Apply `references/map-funding-construct.md`'s formulas and caps:
- Assess: 5% of ARR, capped at $75K (MAP and MAP Lite $100K–$500K only).
- Mobilize: sum of applicable modifiers (Modernization, Greenfield, VMware %, VMware per-VM),
  each capped individually, total capped at 20% of ARR (MAP and MAP Lite $100K–$500K only).
- Migrate & Modernize: tier base credit (25% MAP / 15% MAP Lite) plus DB&A/SAP&Oracle/VMware
  modifiers where applicable, using **eligible ARR** (sum of Eligible + Partially-eligible
  service spend from step 3) rather than total ARR where the reference file specifies "of ARR
  in credits" tied to tagged spend — if ambiguous, use total ARR and note the assumption.

Flag the $200/VM VMware cash line as internal-only (not for customer visibility) per the
reference file.

### 6. Generate the Excel workbook

Two tabs, per `references/xlsx-output-spec.md` if present, otherwise:

**Tab 1 — "Eligibility Checklist"**: Service | Product Code | Category (General/DB&A/SAP&Oracle)
| Monthly Cost | Annual Cost | Eligibility (Eligible/Partial/Not Eligible/Needs Review) |
Notes/Exclusions

**Tab 2 — "MAP Calculation"**: ARR, tier determination, Assess/Mobilize/Migrate&Modernize
breakdown with each modifier as its own labeled row and formula (not hardcoded numbers — see
below), total estimated partner cash, total estimated credits, and a visible list of the
modifier assumptions/inputs used (including anything the user said they didn't know).

Follow the xlsx skill's conventions: use formulas referencing labeled input cells (not
hardcoded results), professional font, currency/percentage number formats, blue text for
hardcoded inputs vs black for formulas, and a clear note wherever a figure depends on an
assumption. Run `recalc.py` on the output before presenting it.

Include a header note on both tabs: "Estimate only — not a binding MAP/MAP Lite funding
determination. Confirm against current AWS Partner Central terms."

### 7. Present the result

Summarize in chat: ARR, tier, headline eligible-vs-excluded service split, total estimated
funding, and any "needs manual review" items or unclaimed modifiers — then share the workbook.
