# Session Handoff — 2026-08-17

**Read this first, then `docs/PROJECT_HANDOFF.md` §17 for deploy mechanics.**

Everything described here is **deployed and working** on `IepStack-dev` (ap-south-1, account
996122083346) and **entirely uncommitted**. Last commit is `ae93bf9`; the working tree has ~126
changed/staged paths and ~43 untracked. Branch: `feature/interviewer-centric-flow`.

Verification at time of writing: `infrastructure` → 20 suites / **339 tests** green,
`npx tsc --noEmit` clean in both packages, `frontend && npm run build` static-exports all 32 pages,
shadow-file guard 0.

---

## 1. What is live

Three apps on one CloudFormation stack, one CloudFront URL (`https://d2itpe2tuxdkli.cloudfront.net`),
one Cognito pool, one API Gateway (`https://1t6ztx9pma.execute-api.ap-south-1.amazonaws.com/dev/`).

| App | State |
|---|---|
| Interview Evaluator + Interview Intelligence | shipped earlier, plus the interviewer-centric work below |
| MOM Analyzer | untouched this session |
| **AWS Cost Calculator** | new this session — built, wired, deployed |

### Delivered this session

1. **Elapsed timers made accurate.** `apiResponse()` stamps `X-Server-Time` on every response
   (`Access-Control-Expose-Headers` set, or CORS hides it). The frontend learns its clock skew once in
   `authFetch` and exposes `getServerNow()`. `LiveProgressBanner` derives elapsed as a pure function of
   (server start, server now) — no mount-time anchor — so it survives tab switches and navigation.
2. **Append-only progress log.** Each worker stage appends `{at, stage, message}` to `progress_events`
   via `list_append`; the banner renders it as a timestamped terminal-style panel. Reset when a run is
   queued, so it stays bounded to one run. All four writers covered.
3. **Fallback provenance.** Stopped `normalizeInterviewExecution` synthesising a panel score from
   counting `?` characters. Surfaced `optimization_status: 'bank_only'` as a badge. Case interviews
   carry `source: 'ai' | 'template'`.
4. **Keka sweep window is configurable** — `KEKA_SYNC_LOOKBACK_DAYS` / `KEKA_SYNC_LOOKAHEAD_DAYS`.
5. **HRIS denial degrades** instead of killing the whole sweep.
6. **Teams 403 now reaches AWS Transcribe** (see §3).
7. **Cost Calculator**, end to end: spreadsheet input, per-environment runtime hours, real AWS pricing,
   client-facing PDF, delete, admin list.

---

## 2. Cost Calculator — how it actually works

```
/calculator/new  → optional .xlsx/.csv upload + prose + editable environment hours
  POST /calculator/upload-url → presigned PUT straight to S3
  POST /calculator  → parses the sheet NOW (fails fast with a usable message),
                      writes a PROCESSING row, async-invokes the orchestrator
calculator-orchestrator (NodejsFunction, 15 min)
  → MCP sidecar tools build the estimate on calculator.aws  (grouped by environment)
  → get_aws_price (OUR tool, AWS Price List API) prices every line
  → writes result + COMPLETED
/calculator/view?id=  → polls every 3s → cost hero, env table, breakdown, savings, Download PDF
```

Files: `lambdas/calculator-orchestrator/{index,tool-loop,mcp-client,aws-pricing}.ts`,
`lambdas/api-handler/calculator-routes.ts`, `lambdas/shared/{pdf-kit,calculator-report}.ts`,
`schema/calculator.ts`, `frontend/src/app/calculator/**`, `frontend/src/lib/calculatorApi.ts`,
`frontend/src/app/admin/calculator/page.tsx`.

### The five non-obvious facts. Do not re-litigate these.

1. **A saved calculator.aws estimate contains NO money.** Verified against a real estimate:
   `import_estimate` returns configuration with `"groupSubtotal": {}`. AWS computes pricing *in the
   browser* when a human opens the link. This is why `get_aws_price` (AWS Price List Query API,
   `pricing:GetProducts`, global endpoint answers only in **us-east-1**) exists. Any future attempt to
   read prices back out of the MCP server will fail.
2. **A billing month is exactly 730 hours**, not 24 × 30.44 (= 730.56). AWS and the Pricing Calculator
   both use 730; partial days are that share of it. Using days put our figures 0.08% above the estimate
   link's — small, but a client comparing the two would spot it. Pinned in `HOURS_PER_MONTH`.
3. **The MCP sidecar is a container image and needs Docker at DEPLOY time only.** Users never need it.
   The upstream npm package publishes a *running Express server* with no library exports, so esbuild
   cannot bundle it — Lambda Web Adapter fronts it instead. A `.dockerignore` now excludes
   `node_modules`: without it, any local `npm install` in that directory changes the asset hash and
   silently forces a full image rebuild + ECR push on the next deploy.
4. **The orchestrator invokes the sidecar via `@aws-sdk/client-lambda`, not a Function URL.** The
   earlier SigV4 design used four packages that were never declared in `package.json` (they only
   resolved as hoisted AWS SDK transitives — a phantom dependency). The invoke also removes a public
   endpoint and an unguarded SSE body read that could hang until the Lambda died.
5. **`timeBilled` is load-bearing.** The scheduling-savings figure is derived only from lines where a
   utilization field was actually applied. Marking storage as time-billed would invent a saving that
   does not exist.

### Money discipline

Every currency figure traces to an AWS published rate. The two derived numbers — annual (`×12`) and the
scheduling saving (`monthly × (24/hours − 1)`) — are arithmetic on those rates and are **labelled as
projections wherever they appear**. The system prompt explicitly forbids the model filling a price from
memory; an unpriced line stays `null` with a warning. Keep it that way.

---

## 3. Corrections made this session — believe these, not older notes

- **`import_estimate` does NOT return prices.** An earlier claim in this project's history said it did.
  It doesn't. See §2.1.
- **Teams: a 403 on the transcript endpoints now permits the recording → AWS Transcribe fallback.**
  `graphGet` previously passed the fallback flag only on the **404** branch, so a tenant missing the
  transcript permission never reached Transcribe at all. Five completed Transcribe jobs prove the
  fallback works; that record simply took the 403 path, which was never wired.
- **The api-handler's `lambda:InvokeFunction` grant is scoped to its own ARN**, not a wildcard.
  `COST_CALCULATOR_HANDOFF.md` claimed otherwise. The calculator orchestrator needed an explicit
  `grantInvoke`.
- **AWS Transcribe was *added* in this uncommitted work, not removed** — `git show HEAD` has zero
  occurrences of it.

---

## 4. Open items

| Item | Detail |
|---|---|
| **Nothing is committed** | Six features' worth. Suggest one commit per feature. Never commit `.env`, `outputs.json`, `cdk.out/`, `*.pem`. |
| **`KEKA_SYNC_LOOKBACK_DAYS` unset** | So My Interviews only sees the last 7 days and the tenant's past rounds stay invisible. `echo "KEKA_SYNC_LOOKBACK_DAYS=180" >> infrastructure/.env` then deploy. |
| **Keka HRIS → Employees Read not granted** | The hard gate on panel emails resolving at all. Hire returns interviewer `{id, name}`; the email lives in HRIS. A sync run now *reports* this rather than failing: check `panelEmailLookupError` and `interviewsWithoutPanelEmail` in the `POST /admin/keka-sync` response. |
| **Calculator worktree** | Removed from use but `git worktree remove --force .claude/worktrees/calculator-app` may still be pending — destructive git commands were blocked by the permission classifier all session. |
| **Sidecar lockfile** | Deliberately absent to keep the image hash stable. Adding one makes the image build reproducible — one-line change, needs Docker up. |
| **First real estimate** | The tool-use loop against live Bedrock plus `get_aws_price` has never run end to end in production. `preview-estimate.pdf` in the project root shows the intended output. |

---

## 5. Standing constraints — carried from earlier sessions

- **dd-MM-yyyy dates everywhere** (India format).
- **No changes** to the evaluation prompt, scoring rubric, model IDs, or the **existing** PDF renderers
  (`shared/intelligence-report.ts`, `shared/mom-report.ts`). New renderers use `shared/pdf-kit.ts`,
  which is a *copy* of their private primitives for exactly this reason.
- **MOM untouched.**
- Per-record ownership gates (`getOwned*`) untouched.
- Never commit `.env*`, `infrastructure/outputs.json`, `cdk.out/**`, `*.pem`, credentials. Never
  reproduce `ANTHROPIC_AUTH_TOKEN` or live Keka credential values.
- `settings.local.json` uses a local relay + allow rule — do NOT revert.
- **`infrastructure/package.json` `build` is `tsc --noEmit`. Never restore a bare `tsc`** — it emits
  `.js` shadows beside sources and esbuild bundles them instead of the real code, silently shipping old
  Lambdas. Guard before every deploy: no `.js`/`.d.ts` under `infrastructure/{bin,lib,schema,scripts,test,lambdas}`.
- Commit or push **only when asked**.

---

## 6. Deploy and verify

```powershell
cd "D:\Interview Agent\infrastructure"; npx tsc --noEmit; npx jest      # 339 tests
cd "D:\Interview Agent\frontend"; npm run build                          # 32 static pages
cd "D:\Interview Agent\infrastructure"; npx cdk deploy --all --require-approval never
aws cloudfront create-invalidation --distribution-id E35Z8A2JJHWE91 --paths "/*" --region ap-south-1
```

Docker Desktop must be running **only** if the sidecar's own files changed. Otherwise CDK reuses the
published image and the deploy needs no Docker.

### Environment note for a new session

The permission classifier in this environment fails intermittently ("Stage 2 classifier error"). Retry
once or twice; it usually passes. It consistently blocks destructive git and backgrounded shell
processes — use `run_in_background: true` rather than `&`, and hand destructive git to the user. On Git
Bash, prefix AWS CLI calls that pass a path-like argument (log group names, S3 keys, `--paths "/*"`)
with `MSYS_NO_PATHCONV=1`, or MSYS rewrites them into Windows paths and the call fails validation.
