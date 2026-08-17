# Cost Calculator — Handoff

**Date:** 2026-08-16 · **Status:** code complete for the isolated slice, **nothing runtime-verified**

This session added a third app to the Minfy MiMo AI Hub: **AWS Cost Calculator**, built on
[`aws-samples/sample-aws-pricing-calculator-mcp`](https://github.com/aws-samples/sample-aws-pricing-calculator-mcp)
(MIT-0, Node.js, v1.2.9). All work is isolated so it does not collide with the concurrent
`interviewer-centric-question-bank` work happening in the main working tree.

---

## 1. Where the work lives

| | |
|---|---|
| **Worktree** | `D:\Interview Agent\.claude\worktrees\calculator-app` |
| **Branch** | `feature/cost-calculator` |
| **Based on** | **HEAD (`ae93bf9`)**, *not* `main` |
| **Plan file** | `C:\Users\syed.sofiyan\.claude\plans\floofy-percolating-hennessy.md` |

**Why not `main`:** `main` is **15 commits behind** HEAD and is missing the entire design system plus
`workspace-routes.ts`, `authz.ts`, `LiveProgressBanner`, `Skeleton`, `BackButton`. Never baseline new
hub work on `main`.

**Baseline caveat:** the worktree is off *committed* HEAD, so it does **not** contain the live tree's
uncommitted work (28 modified + 18 untracked files). Notably absent from the worktree:
`admin-routes.ts`, `authz.ts`, `audit.ts`, `workspace-routes.ts`, `question-bank-store.ts`,
`schema/admin.ts`, and the newer `ui/` components. The calculator deliberately depends on none of them.

`/.claude` is gitignored, so the worktree adds no untracked noise to the live tree.

---

## 2. Hard constraints — read before doing anything

1. **Do NOT `cdk deploy` from this worktree.** The whole hub is **one CloudFormation stack**.
   Deploying from here would revert whatever the other session has deployed (the worktree lacks their
   uncommitted question-bank/admin/workspace work). Wait until their branch merges.
2. **No shared-file edits have been made, and they should stay deferred** until the question-bank
   branch merges — then rebase and land them (see §6).
3. Upstream talks to **undocumented `calculator.aws` CloudFront endpoints** that can change without
   notice. Treat the feature as best-effort; the version is pinned exactly (`1.2.9`, not `^`).

---

## 3. What the app is, and where the "AI" is

The upstream repo is **an MCP server, not an app** — 9 tools that build an AWS Pricing Calculator
estimate and return a shareable `calculator.aws` URL. **It contains no AI.** The hub supplies it:

> **Natural language → estimate.** The user describes a workload in plain English. Claude
> (`claude-sonnet-5` on Bedrock) runs a **multi-turn tool-use loop** against the MCP tools, builds the
> estimate, and returns the shareable link plus a cost breakdown.
> Hub card proof line: `Output: Estimate / Breakdown / calculator.aws link`.

This is the **first tool-use code in the repo** — every existing Bedrock call is single-shot
`InvokeModelCommand`, and `anthropicRequestBody` (api-handler/index.ts ~131) emits exactly one user
message and cannot carry tools. The loop, the messages+tools body builder, and the `tool_use`-aware
response reader are all new.

### Architecture (all serverless, additive)

```
Frontend /calculator/new
  │ calculatorApi.createCalculation({name, prompt, region})
  ▼
POST /calculator  (api-handler → calculator-routes.ts)
  │  write row {status:'PROCESSING'} to CalculatorTable
  │  async InvokeCommand('Event') → orchestrator, return {calculation_id}
  ▼
calculator-orchestrator   (NodejsFunction, esbuild — matches existing pattern)
  │  tools/list → map 9 MCP tools to Anthropic tool schema
  │  InvokeModel(messages+tools); while stop_reason==='tool_use':
  │      call tools on sidecar → append tool_result → re-invoke
  │  final tagged JSON <calculation_json>{url,lineItems,monthlyTotal,assumptions,warnings}
  │  write result + status COMPLETED|FAILED
  │      │ SigV4-signed HTTPS
  │      ▼
  │  calculator-mcp-sidecar  (Lambda CONTAINER IMAGE + Lambda Web Adapter, Function URL AWS_IAM)
  │      MCP_TRANSPORT=http, ESTIMATES_STORE=dynamodb
  │          ├── calculator.aws CloudFront (public, no creds, no VPC)
  │          └── CalculatorEstimatesTable (in-flight estimate snapshots, TTL)
  ▼
Frontend /calculator/view?id=  → polls GET /calculator/{id}/result every 3s → renders
```

Async + poll because the loop is N sequential Bedrock round-trips and exceeds API Gateway's 29s
ceiling. Mirrors the existing intelligence-analysis handshake (`api-handler/index.ts` ~3968-4010).

---

## 4. Verified protocol facts (research — the load-bearing findings)

Established by reading upstream `mcp-server.js` and its pinned `@modelcontextprotocol/sdk@1.30.0`.
These drove the design; do not re-litigate without re-reading the source.

| Finding | Consequence |
|---|---|
| **Stateless HTTP mode** — `sessionIdGenerator: undefined`; SDK docs say "no session validation is performed" | Plain Lambda is safe. **No sticky routing, no Fargate**, scales to zero. |
| **No `initialize` gate** — the SDK's `Server` never gates dispatch on initialization | A cold container answers `tools/list` on the first request. |
| **Responses are SSE-framed, not JSON** — upstream never passes `enableJsonResponse` | Client MUST unframe `data:` lines. Handled in `mcp-client.ts`. |
| **`Accept` must offer BOTH** `application/json` and `text/event-stream` | Otherwise 406 before reaching any tool. |
| **`GET`/`DELETE /mcp` return 405** | LWA readiness check must be **TCP**, not an HTTP probe on `/mcp`. |
| **Package ships only a running server** (`main: mcp-server.js`, no `exports`, `files` = just the bundle) | Confirms the HTTP-sidecar choice; vendoring would mean forking `lib/*.js`. |
| Cross-request estimate state needs `ESTIMATES_STORE=dynamodb` + `ESTIMATES_TABLE` | Default memory store cannot survive between Lambda invokes. |

Estimates table schema (from upstream): PK `id` (S), `snapshot` (S), optional TTL attr `expiresAt` (N).
IAM needed: `dynamodb:GetItem`, `PutItem`, `DeleteItem`.

---

## 5. Files created — 11, all new, **zero shared-file edits**

### Backend
| File | Purpose |
|---|---|
| `infrastructure/lambdas/calculator-mcp-sidecar/package.json` | pins `sample-aws-pricing-calculator-mcp@1.2.9` + the two `@aws-sdk` DynamoDB peer deps |
| `infrastructure/lambdas/calculator-mcp-sidecar/Dockerfile` | Lambda Web Adapter (`0.9.1`) + `node:20-slim`, TCP readiness probe, `MCP_TRANSPORT=http` |
| `infrastructure/lambdas/calculator-orchestrator/mcp-client.ts` | SigV4 MCP client; SSE unframing; dual `Accept`; tool errors returned not thrown |
| `infrastructure/lambdas/calculator-orchestrator/tool-loop.ts` | the Bedrock tool-use loop |
| `infrastructure/lambdas/calculator-orchestrator/index.ts` | async worker: run loop → parse tagged JSON → write result/failure |
| `infrastructure/lambdas/api-handler/calculator-routes.ts` | `createCalculation`, `listCalculations`, `getCalculation`, `getCalculationResult` |
| `infrastructure/schema/calculator.ts` | Zod: `CreateCalculationSchema`, result/record/summary, `CalculationStatus` |

### Frontend
| File | Purpose |
|---|---|
| `frontend/src/lib/calculatorApi.ts` | self-contained API client + `formatMonthly` |
| `frontend/src/app/calculator/page.tsx` | estimates list, empty state, dd-MM-yyyy dates |
| `frontend/src/app/calculator/new/page.tsx` | name + prompt + region form, "Use example" filler |
| `frontend/src/app/calculator/view/page.tsx` | 3s poll → cost hero, breakdown table, assumptions, warnings, external link |

### Design decisions baked in (don't undo without reason)
- **`schema/calculator.ts` is a new file** and **reuses the existing `ErrorCode` enum** — `schema/index.ts`
  and `schema/admin.ts` are being edited concurrently, so the feature adds no codes there.
- **`calculatorApi.ts` is separate from `lib/api.ts`** because `authFetch` is module-local (not exported)
  and `api.ts` is a hot-conflict file. It replicates the important detail: API Gateway's
  `CognitoUserPoolsAuthorizer` validates the **ID token**, sent as a bare `Authorization` header with
  **no `Bearer` prefix**.
- **Ownership misses return 404, not 403**, so the endpoint can't be used to probe for other users' rows.
- **Tool errors are fed back to the model** rather than aborting — upstream writes actionable
  `next_step` text, so Claude can self-correct after a lint refusal.
- **Tools run sequentially** — they mutate one shared in-flight estimate, so `add_service` ordering is
  observable and racing them is unsafe.
- Loop guards: `MAX_ITERATIONS = 24`, `LOOP_DEADLINE_MS = 8min`, per-call 120s AbortController,
  `max_tokens` mid-loop treated as a hard error.
- Copied from existing convention: `anthropic_version: 'bedrock-2023-05-31'`, the
  `if (!modelId.includes('claude-sonnet-5'))` temperature guard, `BEDROCK_SONNET_5_PROFILE_ARN ||
  'global.anthropic.claude-sonnet-5'` resolution, tagged-JSON output parsing.
- `BackButton` was imported then removed — **it does not exist at this baseline**. Used `StatusBadge`
  (which does) and an inline `Link`. Verified `.card`/`.btn-primary`/`.premium-input`/`.page-kicker`
  and the `warning`/`danger`/`accent`/`surface-*` tokens all exist in `globals.css`.
- Followed `frontend/AGENTS.md` (read the bundled Next docs): `useSearchParams` is unchanged in this
  version — client hook, read-only `URLSearchParams`, requires a Suspense boundary. The view page does.

---

## 6. NOT done — remaining work

### 6a. CDK stack wiring — `infrastructure/lib/infrastructure-stack.ts` (all additive)
Line numbers are from the pre-merge live tree; re-locate after rebasing.

1. **Two DynamoDB tables** (insert after the last `GSI_Workspace` block, ~line 139). Mirror `momTable`
   (~76-82): `CalculatorTable` PK `calculation_id` (S); `CalculatorEstimatesTable` PK `id` (S) with TTL
   attribute `expiresAt`.
2. **Orchestrator Lambda** (`NodejsFunction`, after the `momProcessor` block ~line 325). Copy
   `momProcessor`'s shape (~300-317) + the Bedrock env block (~202-206); attach the shared
   `bedrockPolicy` const (~256-265) — reuse it, don't redeclare. Timeout ≥10 min.
3. **Sidecar Lambda** — `DockerImageFunction` from `infrastructure/lambdas/calculator-mcp-sidecar`, plus
   `.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM })`. **This is the one construct
   type with no existing template in the stack** (there is no container image or Function URL today).
   Grant it RW on `CalculatorEstimatesTable`; env: `ESTIMATES_STORE=dynamodb`,
   `ESTIMATES_TABLE`, `ESTIMATES_TTL_SECONDS` (e.g. `86400`).
4. **Env + grants**: `CALCULATOR_TABLE_NAME`, `CALCULATOR_ORCHESTRATOR_FUNCTION_NAME` on api-handler;
   `CALCULATOR_TABLE_NAME`, `CALCULATOR_SIDECAR_URL` on the orchestrator.
   `calculatorTable.grantReadWriteData(...)` for both. The api-handler's existing wildcard
   `lambda:InvokeFunction` grant (~226-229) already permits invoking the orchestrator.
   Orchestrator needs `lambda:InvokeFunctionUrl` on the sidecar.
5. **Routes** (before the `// Outputs` comment, ~line 624), mirroring the `interviews` tree (~427-461):
   `/calculator` GET+POST; `/calculator/{id}` GET (with the CORS preflight block);
   `/calculator/{id}/result` GET. All use `apiHandlerIntegration` + `authMethodOptions`.
6. **CfnOutput**: `CalculatorTableName` (near ~625-632).

### 6b. api-handler dispatch — `infrastructure/lambdas/api-handler/index.ts`
Add a **small** additive block alongside the other `resource ===` checks (~line 77+), routing
`/calculator*` to `calculator-routes.ts`. Keep it minimal — this is the hottest conflict file.

### 6c. Hub registration — 3 frontend files, one additive entry each
- `frontend/src/app/page.tsx` — append to the `apps` array (~44-65). Optional live stat via
  `calculatorApi.getCalculations()` in `loadStats` + a third overview count.
- `frontend/src/components/layout/Sidebar.tsx` — new `NavSection` in `BASE_SECTIONS` (~49-71); import a
  lucide icon (`Calculator`).
- `frontend/src/components/layout/pageMetadata.ts` — add branches; **put `/calculator/new` and
  `/calculator/view` BEFORE the bare `/calculator`** (longest-prefix-first, as the file already does).
- Add a logo PNG to `frontend/public/` for the hub card.

### 6d. Dependencies — `infrastructure/package.json` (4 additive lines)
Needed by `mcp-client.ts` for SigV4: `@smithy/signature-v4`, `@smithy/protocol-http`,
`@aws-crypto/sha256-js`, `@aws-sdk/credential-provider-node`.

> **Alternative worth considering:** drop the Function URL + SigV4 entirely and invoke the sidecar via
> `@aws-sdk/client-lambda` (**already a dependency**) with a Function-URL-shaped payload that LWA
> translates. That removes all 4 deps **and** the public endpoint, and reuses the existing invoke grant.
> One-file change to `mcp-client.ts`. Kept SigV4 for now as the documented, lower-risk path.

---

## 7. Verification — NONE of this has been run

Blocked all session: `npm install` was denied ~8× by the Claude Code auto-mode permission classifier
(alternating `Stage 2 classifier error` and classifier-model timeouts). `docker build` and a PowerShell
junction were blocked the same way. It is a flaky safety-check service, **not** a settings problem —
though an explicit allow rule bypasses the classifier, so adding one fixes it. Note the worktree has its
own `.claude/settings.local.json`, which is what this session reads — **not** the main project's file.

Also: the worktree has **no `node_modules`** (they are not shared with the main tree), so nothing has
been typechecked.

### Steps to run, in order
```bash
# 0. deps — the blocker. Either of:
cd .claude/worktrees/calculator-app/infrastructure/lambdas/calculator-mcp-sidecar && npm install
# and, to typecheck without a second full install, reuse the main tree's modules:
powershell -Command "New-Item -ItemType Junction -Path 'D:\Interview Agent\.claude\worktrees\calculator-app\infrastructure\node_modules' -Target 'D:\Interview Agent\infrastructure\node_modules'"

# 1. typecheck the 11 new files
cd .claude/worktrees/calculator-app/infrastructure && npx tsc --noEmit

# 2. sidecar in isolation, locally
cd lambdas/calculator-mcp-sidecar && MCP_TRANSPORT=http PORT=8931 HOST=127.0.0.1 npm start
#    then POST /mcp with Accept: application/json, text/event-stream
#    assert: tools/list returns 9 tools; SSE framing; no initialize needed
#    then create_estimate → add_service (a catalog minimalConfig, e.g. Lambda) → export_estimate
#    assert: returns a calculator.aws URL that renders non-zero cost

# 3. the tool-use loop against real Bedrock (creds work: acct 996122083346, ap-south-1)
#    assert: ≥2 tool calls, valid <calculation_json>, max-iteration guard trips on a hard prompt

# 4. docker build the sidecar image (verifies LWA layering + npm install inside the image)
```
Then, **only after the question-bank branch merges**: land §6, `cdk diff` (expect additive-only),
`npm test` in `infrastructure/` stays green, deploy, and exercise `/calculator/new` end to end.

---

## 8. Open risks

- **LWA + Express in Lambda is new to this stack.** Unverified: whether the SSE response closes cleanly
  under LWA's buffered invoke mode. If a request hangs, look at `AWS_LWA_INVOKE_MODE` first.
- **Orchestrator esbuild bundling** — watch the known stale-`.js`-shadow deploy issue (`*.js` and
  `*.d.ts` are gitignored repo-wide; `noEmit` must stay on).
- **`monthlyTotal` is nullable by design** — AWS recomputes price when the link is opened and upstream
  has no local pricing engine, so a total is not always derivable. UI renders `—`.
- The list endpoint uses `Scan` + owner filter, consistent with the other list endpoints. Fine at
  per-user volume; revisit with a GSI if it grows.

## 9. Session memory written
- `calculator-app-planned.md` — worktree/baseline/no-deploy rules
- `mcp-http-sidecar-protocol-facts.md` — the §4 protocol findings
