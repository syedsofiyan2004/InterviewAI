# Mission Final Report — Cost Calculator as an intelligent Claude + AWS Pricing Calculator MCP workflow

Date: 2026-09-08 · Branch `feature/interviewer-centric-flow` · Repo `syedsofiyan2004/InterviewAI`
Scope: Parts 1–42 of the mission spec, the DoD checklist, and this mandatory report. **Nothing was deployed.**

---

## 1. HEAD before this work

`751f395` — "Keep WAITING_FOR_INPUT until InvokeHarness accepts the resume" (fetched latest remote first; work starts from there).

## 2. Commits created (in order)

| Commit | Summary |
|---|---|
| `e239b1c` | Make get_workbook_evidence paging lossless (Parts 15–18) |
| `e52aa2f` | Generalize request_user_input to an option-based question schema (Part 1 + prompt coverage) |
| `ea474f1` | Reconcile calculator coverage against actual evidence with one bounded repair (Parts 32–36, 38–39) |
| `f73f865` | Pin the Part 37 final-import readback in the agent prompt |
| `480d996` | Add Part 42 REQUIRED TESTS A–J; fix two latent multi-scenario bugs they exposed |

## 3. Files changed (source, excluding build/scratch)

- `infrastructure/lambdas/calculator-evidence-tool/index.ts` + `tool-schema.ts` — lossless paging
- `infrastructure/lambdas/calculator-harness-provisioner/index.ts` — generic request_user_input tool schema
- `infrastructure/lambdas/calculator-harness-driver/index.ts` — question projection/resume, coverage repair, telemetry, scenario keying, top-level JSON parse
- `infrastructure/lambdas/shared/workbook-evidence.ts` — authoritative `cost-relevant-rows.json` key
- `infrastructure/lambdas/api-handler/calculator-agentcore-dispatch.ts`, `calculator-routes.ts` — persist authoritative rows; expose questions on GET /result
- `infrastructure/schema/calculator.ts` — generic agent_questions + telemetry + coverage-repair fields
- `infrastructure/prompts/calculator-agent-system.txt` — the agent contract (read-all, batching, coverage, statuses-not-rules, final read-back)
- `infrastructure/test/calculator-evidence-tool-paging.test.ts` (new)
- `infrastructure/test/calculator-agentcore-interrupt.test.ts` (new)
- `infrastructure/test/calculator-agentcore-coverage.test.ts` (new — 17 tests: Parts 32–39 + A–J)
- `infrastructure/test/agentcore-calculator.test.ts` — prompt-lock tests
- `frontend/src/app/calculator/view/page.tsx`, `frontend/src/lib/calculatorApi.ts` — generic question rendering (options / Other / multiple / apply-to-similar)

## 4. request_user_input final schema (generic)

Required: `questionId`, `title`, `question`, `reason`. Legacy `type` (CHOICE/NUMBER/BOOLEAN/TEXT) is no longer required and remains accepted for backward compatibility.

```ts
{
  questionId: string, title: string, question: string, reason: string,   // required
  scope?: string,                                  // broadest useful scope
  selectionMode?: 'single' | 'multiple',
  options?: [{ value: string, label: string, description?: string }],    // 2–4, Claude-authored
  customInput?: { enabled: boolean, label?: string, inputType?: 'text'|'number',
                  unit?: string, placeholder?: string },                 // "Other / give your own"
  allowApplyToSimilarResources?: boolean,
  // legacy, optional, backward-compatible:
  resource?, semanticField?, type?, choices?: [{ value, label }], unit?
}
```

Driver projects it to the persisted `agent_questions` shape (frontend renders options/multiple/Other/apply-to-similar; a bare question renders as free text).

## 5. Example questions (from tests + the prompt contract)

- Commercial pricing missing → **q-commitment** "Which commitment should apply to the EC2 fleet?" (On-Demand / 1-yr SP no upfront / 3-yr SP all upfront), `customInput` Other.
- Ambiguous frequency/runtime → **q-hours** "What hours should the EC2 fleet run?" `selectionMode: multiple`, numeric Other in hours/day.
- Sizing contradiction → **q-db-size** names the two conflicting instance types.
- OS family/version conflict → **q-os** Linux vs Windows.
- Follow-ups: when a term/payment option is chosen but term/payment is not yet known, a single follow-up is asked.

## 6. toolUse/toolResult continuation preserved (Part 16)

A pause is the Harness inline-function `request_user_input`; the stream ends `stopReason: 'tool_use'`. Resume replays the **original assistant toolUse message** and supplies the customer's **toolResult** `{value, applyToSimilarResources}` **on the same runtimeSessionId** (`buildResumeMessages`). Pending state is cleared only after `InvokeHarness` accepts the send, so a throw leaves the wait state intact for retry. `calculator-agentcore-interrupt.test.ts` pins the projection, the continuation messages, and the no-clear-before-accept ordering.

## 7. Evidence paging bug: cause, fix, zero-loss result (Parts 15–18)

Cause — `calculator-evidence-tool` could partially return chunk 0002, mark it included, and set `nextChunkId=0003`, so the unread remainder of 0002 was never served: rows silently dropped.

Fix — a chunk is returned whole or not at all; when adding the next whole chunk would exceed the response ceiling the tool stops **before** it and reports `nextChunkId` = the chunk it stopped before; an oversized chunk is streamed row-by-row with an exact `nextRowsFrom` cursor; `returnedChunks` lists only fully-returned chunks and `moreAvailable=false` means the read is complete.

Zero-loss result — `calculator-evidence-tool-paging.test.ts` (2 tests): chunk 0001 whole, then the complete chunk 0002, every rowId exactly once; and an oversized chunk resumed at `nextRowsFrom` with no skipped or duplicated rows. The Part 42 "I" gate keeps the `returnedChunks / moreAvailable / nextChunkId / nextRowsFrom` surface intact.

## 8. Resource granularity — batched add_service sample (G/H, Parts 19–31)

The prompt instructs: each source workload is an independent, individually identifiable Calculator entry (identity = resource name, else `SheetName-RowNumber`); a row that explicitly defines one counted fleet stays a single entry with that count; discovery per service runs once and is reused; a large workbook uses `create_estimate → batched add_service → one validate_estimate → export_estimate → import_estimate`.

Batched request shape (one call, many independent entries — the executor seam that proves each batch config becomes its own entry):

```jsonc
// add_service
{
  "estimate_id": "est-1",
  "services": "[
    {\"service\":\"Amazon EC2\",   \"group\":\"prod-web\",  \"config\":{\"instanceType\":\"m6i.large\", ...}},
    {\"service\":\"Amazon EC2\",   \"group\":\"prod-web\",  \"config\":{\"instanceType\":\"m6a.large\", ...}},
    {\"service\":\"AWS Fargate\",  \"group\":\"svc-api\",   \"config\":{\"cpu\":\"1 vCPU\", \"memory\":\"4 GB\", ...}}
  ]"
}
// each element becomes its own Calculator entry:
//   {success:true, service:"Amazon EC2",  group:"prod-web"}
//   {success:true, service:"Amazon EC2",  group:"prod-web"}
//   {success:true, service:"AWS Fargate", group:"svc-api"}
```

Part 42 G: three independent rows stay three individually-accounted source rows (3 priced / 0 unresolved). H: an explicit counted fleet row stays a single entry and still passes coverage (1 priced / 0 unresolved).

## 9. Coverage counts (Parts 32–36)

- The authoritative cost-relevant row set is classified **once** at evidence-build time and persisted (`cost-relevant-rows.json`); completion reconciles against **those rows**, never the agent's self-report.
- Invariant: every cost-relevant row is PRICED (`evidenceConsumed`) / EXPLICITLY EXCLUDED (`evidenceExcluded`) / UNSUPPORTED (`evidenceUnsupported`) / awaiting the customer (`evidenceUnresolved` → paused, not finished).
- A COMPLETED claim that leaves rows uncovered triggers **one bounded coverage-repair continuation** naming the rows (price/exclude/unsupported each; never a MIMO nearest-fit). Still-uncovered after that single repair → terminal `NEEDS_REVIEW`, never a second repair.
- Tested numbers: 4-row workbook, agent priced 2 + excluded 1 → the 1 truly-missing row is `unresolved` (not silently done). J: 120-row workbook priced 40 → all **80** remainder rows unresolved, exact set match, one repair requested. Fully-covered runs reach COMPLETED with `coverageUnresolvedRows: 0`.

## 10. Performance counts (Parts 38–39)

Record + result diagnostics carry, for the whole run:
- `agent_duration_ms` — wall clock from the run's first step to the terminal write (via `agent_started_at`)
- `agent_iterations` — driver step count (message rounds, including the coverage repair)
- `tool_call_counts` — cumulative per-tool histogram, merged once per step end (never in heartbeats, so nothing double counts)

Sample (telemetry test): `agent_iterations: 6`, `toolCallCounts: { add_service: 2, validate_estimate: 1 }`, `toolCallCount: 3`, `agentTotalDurationMs` numeric. The prompt drives the *goal* of fewer calls: schema discovery once + batched add_service + one final validate/export/import.

## 11. Part 42 REQUIRED TESTS A–J (all pass, in `calculator-agentcore-coverage.test.ts` + paging suite)

A commercial pricing missing → persisted question, not COMPLETED · B comparison → every calculator.aws URL kept, one per scenario · C frequency ambiguous → question · D frequency known → no question, COMPLETED · E sizing contradiction → question · F OS contradiction → question · G three independent resources → three identifiable source rows · H explicit fleet → one entry acceptable · I evidence paging exact (source gate + dedicated zero-loss suite) · J large workbook → zero silent remainder.

While writing B, two latent production bugs were found and fixed in the same commit: `lastJsonObject` returned the innermost tail object (so a terminal JSON ending in nested scenario objects was never parsed as finished), and the persisted scenario mapping omitted the schema-required `key` (so a real multi-scenario estimate would crash result assembly).

## 12. Definition of Done — verification (all green, **no deploy**)

| Check | Result |
|---|---|
| Infrastructure TypeScript `tsc --noEmit` | PASS |
| Infrastructure Jest (full suite) | 71 suites · 1465 passed · 8 skipped |
| CDK `synth` (ap-south-1) | PASS |
| Frontend `tsc --noEmit` | PASS |
| Frontend `eslint` (changed files) | PASS |
| Frontend `next build` | PASS (static pages generated) |
| Deploy | **NOT performed** (mission constraint) |

Remaining (explicitly live-environment, gated on the user deploying): task #22/#27 live granularity + batched add_service proof against the real Calculator MCP, and #23 cleanup of earlier test estimates from the admin tab. These cannot run without a deploy the user has not requested.
