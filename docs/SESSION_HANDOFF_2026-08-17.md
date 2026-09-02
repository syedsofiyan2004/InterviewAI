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

---

## 7. Continued — 2026-08-20: the estimate pipeline, and licence accuracy

Everything below happened after §6 was written. Where it contradicts §1–§6, this section is right;
see §7.5 for the specific lines above that are now stale.

### 7.1 The agentic tool-use loop is gone. A pipeline does the work.

`calculator-orchestrator/tool-loop.ts` used to drive the estimate: the model chose each price lookup,
one turn at a time, under a turn ceiling. On the real COSEC workbook that ran out of turns before it
ran out of servers, so the estimate was whatever it had priced when the music stopped.

It is now `calculator-orchestrator/pipeline.ts`, with `calculator-orchestrator/prompt.ts` holding the
grouping and the prompt text. Code decides the order of work; the model is asked only the questions
that need judgement.

| | tool-loop (old) | pipeline (new) |
|---|---|---|
| Who picks the next lookup | the model, one per turn | code, all of them up front |
| Ceiling | a turn count | the Lambda's own time budget |
| Price lookups | serial | in parallel, batched |
| Service mapping | a model call per group | rule first, model only for what no rule matches |
| `build_estimate` | the model calls it, maybe | code calls it once, with everything |

On the real file: **52 groups mapped by rule, 0 by model**, one model call in the whole run, 106 price
lookups, 44 seconds. The model call that remains is the narrative.

### 7.2 Two silent data losses in `build_estimate`, both now closed

The shareable calculator.aws link was quietly dropping services. Not erroring — dropping.

1. **Group names.** calculator.aws rejects a group whose name contains `/`, and silently strips `&`.
   A group named `Web / App Tier` was refused outright. `calculatorGroupName()` now sanitises:
   `/` and `&` are removed, and `( ) _ . , : + #` plus spaces are kept, because they are safe and
   they are what makes a name readable in the shared estimate.
2. **Duplicate descriptions.** Two services with the same description collapsed into one. Every
   service now carries a distinct description (`distinctDescription()`), which is what stops the
   collapse.

Neither failure announced itself, so the third change is the one that matters most: `verifySaved()`
reads the saved estimate back and compares it, by count and by dollars, against what was sent. A run
that loses anything now says so in the log instead of producing a smaller number in silence. The
previous run had lost **4 of 25 services, worth $4,601.75/month**, and nothing in the output said so.

### 7.3 SQL Server licensing was wrong five different ways

A bundled SQL Server licence is the largest single per-machine figure a sheet can state. AWS bills it
**per vCPU**, so Standard roughly doubles an EC2 rate and Enterprise more than trebles it. That makes
it the one field where a wording mistake moves the total by more than any sizing decision, and there
were five of them — four overstating, one understating.

| # | What happened | Effect on the estimate |
|---|---|---|
| 1 | `SQL Server Standard (BYOL)` was priced with a bundled licence | machine roughly **doubled**, for a licence the client already owns |
| 2 | SQL Express was priced as Standard | Express is free from Microsoft; the whole licence was **invented** |
| 3 | A plain substring match on `sql` also matched **My**SQL, Postgre**SQL**, **NoSQL** | a Linux MySQL box charged a **Windows SQL Server** licence |
| 4 | A match on `ent(erprise)` also matched Red Hat **Enterprise** Linux | Standard read as Enterprise, roughly **trebling** the rate |
| 5 | `normaliseOs()` folded `Windows 2019 with SQL Server Standard` to `Windows` before pricing | licence **lost**; machine understated by about half |

All five now live in one module, `lambdas/shared/sql-licence.ts`, imported by **both** sides:

- `api-handler/calculator-workbook.ts` (the upload parser) — decides what licence wording survives
  onto a row, via `osWithLicence()`, which appends e.g. ` + SQL Server Standard` to the folded OS
  string. That suffix is also what keeps licensed and unlicensed machines in **separate priced
  groups**: the grouping key includes `os`, so without it they merge and get one rate.
- `calculator-orchestrator/pipeline.ts` (pricing) — decides what AWS is billed, via `sqlLicensing()`,
  whose `billed` value is exactly a Price List `preInstalledSw`: `NA | SQL Std | SQL Web | SQL Ent`.

One module rather than two copies, because these two halves drifting apart is a silent mispricing with
nothing to see. There is a test that round-trips it: whatever the parser writes onto the OS string, the
pipeline must read back as the same licence.

Three rules inside it that look arbitrary and are not:

- **Word boundaries on `sql` / `mssql`**, never a bare substring. Mispricing #3.
- **The edition is read from a 60-character window that starts at the SQL mention**, not from the whole
  cell. `Red Hat Enterprise Linux 9 + SQL Server` is Standard; `SQL Server Enterprise on Red Hat
  Enterprise Linux` is Enterprise. Mispricing #4.
- **Structured columns may buy a licence; free-text notes may only waive one.** The OS and service
  cells naming SQL Server means the machine runs it. A remarks column can say BYOL and be believed,
  but it can never add a licence — the real COSEC model carries the note
  `SQL Server consolidation sizing (6 VMs to 4 instances)` against machines whose OS column says only
  `Windows`, and reading that as a purchase would have put a per-vCPU licence on six servers that
  never asked for one.

When a licence is named but not billed, the report says so in its assumptions — that the rate is the
plain operating-system one, and that a reader comparing it against a licence-inclusive quote will find
it low. Silence there would look like an error.

**None of this is fitted to one workbook.** It is wording, and the tests are wording: MySQL,
PostgreSQL, Aurora MySQL, NoSQL, plain Windows, Red Hat Enterprise Linux, Express, eight BYOL
phrasings (`(BYOL)`, `bring your own licence`, `customer own licence`, `licence not included`,
`licenses excluded`, `no SQL licence`, `existing license reused`, …), an edition in the OS column, an
edition in the service column, and no edition at all (which is read as Standard — the common licence
and the mid price, and the report states the assumption). The one case taken from the real file is
there as a **guard against** over-fitting, not as a special case for it.

### 7.4 Verified live, on the real workbook

The deployed build was re-run against the existing COSEC calculation
(`1e82bcce-6866-451e-8958-9a5a69e0df1a`) by invoking the orchestrator directly, which re-prices a record
in place:

```powershell
aws lambda invoke --function-name iep-dev-calculator-orchestrator-996122083346-ap-south-1 `
  --invocation-type Event --payload '{"calculationId":"1e82bcce-6866-451e-8958-9a5a69e0df1a"}' `
  --cli-binary-format raw-in-base64-out --region ap-south-1 out.json
```

CloudWatch, in order:

```
Pipeline: 110 priceable row(s) -> 25 baseline group(s), 27 right-sized group(s)
52 group(s) mapped by rule, 0 by model
priced 25/25 baseline group(s), $26772.57/mo, 658s budget left
Pipeline: link verified, 25 service(s) saved for 25 sent.
Pipeline complete in 44s: 1 model call(s), 106 lookup(s), url=yes
Duration: 44814.80 ms
```

`25 service(s) saved for 25 sent` is the line that matters: the PDF and the shareable calculator.aws
link now describe the same estimate. That was the divergence the user reported, and it is closed.

One residual, cosmetic: `Narrative call failed (no JSON object in the reply); using derived notes only.`
The designed graceful degradation fired, so the prose came from derived notes. **Figures unaffected** —
they never come from that call.

Gates: `npx tsc --noEmit` clean; `npx jest` → **29 suites / 540 tests** passed; shadow-file guard 0;
`npx cdk deploy --require-approval never` → `IepStack-dev` in 68.25s.

### 7.5 Corrections to the sections above

| Where | Says | Should say |
|---|---|---|
| Preamble, §6 | 20 suites / 339 tests | **29 suites / 540 tests** |
| §2 file list | `tool-loop.ts` drives the estimate | `pipeline.ts` + `prompt.ts` do; see §7.1 |
| §2 | the model chooses each lookup in a turn loop | code plans all lookups; the model is asked only what needs judgement |
| §4 open items | "**First real estimate** — has never run end to end in production" | **done**; see §7.4 |

New files since §2 was written: `lambdas/calculator-orchestrator/pipeline.ts`,
`lambdas/calculator-orchestrator/prompt.ts`, `lambdas/shared/sql-licence.ts`,
`lambdas/shared/workbook.ts`, `lambdas/shared/sheet-structure.ts`,
`lambdas/api-handler/calculator-workbook.ts`.

### 7.6 Open items, as of 2026-08-20

| Item | Note |
|---|---|
| Nothing is committed | Still true, and now larger. Branch `feature/interviewer-centric-flow`. Commit only when asked. |
| Scratch files must go before any commit | `infrastructure/calcres.json`, `probe-out.txt`, `probe-sidecar.js`, `zz-probe.ts`, `zz-stack.py`, and every `zz-*.json` / `zz-*.txt` |
| `tool-loop.ts` is dead code | `index.ts` no longer imports it, so esbuild does not ship it. It plus its 27 tests can be deleted — a decision for the user, not a silent one |
| `Narrative call failed` on the live run | Prose only. Worth finding, not urgent |
| Sidecar needs Docker | Only when the sidecar's own files change (unchanged since §6) |
