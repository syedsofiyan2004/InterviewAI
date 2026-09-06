# Calculator → AgentCore Migration Checklist

Working document for the MIMO AWS Cost Calculator migration onto Amazon Bedrock
AgentCore. Every requirement from the migration brief is reproduced here as a
checkbox. Items are marked `[x]` only when the stated acceptance criterion has
actually been met, or `[ ] blocked — <exact reason>` when it cannot be.

**Status legend for test claims:** `MOCKED` (aws-sdk-client-mock / jest),
`LOCAL` (runs on this machine, no AWS), `LIVE AWS` (real AWS API call, output
pasted in).

---

## Session facts

| | |
|---|---|
| Branch | `feature/interviewer-centric-flow` |
| HEAD at start | `4b034e729729327610061ed7e9e0f94bf79d66ec` |
| HEAD commit | `Agent Lambda now writes back to DynamoDB/S3 (orchestrator role)` (2026-09-06 16:31:13 +0530) |
| AWS account | `996122083346` |
| Principal | `arn:aws:iam::996122083346:user/<redacted-iam-user>` |
| Deploy region | `ap-south-1` (shell `AWS_REGION` is `us-east-1` — always prefix `cdk` explicitly) |
| `aws-cdk-lib` | 2.250.0 |

---

## Phase 0 — Inspect current state

- [x] Confirm checked-out branch is `feature/interviewer-centric-flow`
- [x] Record HEAD SHA (`4b034e7`)
- [x] Inspect `infrastructure/lambdas/calculator-agent/`
- [x] Inspect `infrastructure/lambdas/calculator-mcp-proxy/`
- [x] Inspect `infrastructure/lambdas/calculator-mcp-sidecar/`
- [x] Inspect `infrastructure/lambdas/calculator-mcp-sidecar-agentcore/`
- [x] Inspect `infrastructure/lambdas/calculator-orchestrator/`
- [x] Inspect `infrastructure/lib/calculator-agentcore.ts`
- [x] Inspect `infrastructure/lib/infrastructure-stack.ts`
- [x] Inspect `infrastructure/lambdas/api-handler/calculator-routes.ts`
- [x] Inspect `infrastructure/schema/calculator.ts`
- [x] Inspect `infrastructure/schema/estimate-plan.ts`
- [ ] Inspect `frontend/src/app/calculator/`
- [ ] Inspect `frontend/src/lib/calculatorApi.ts`
- [x] Global search for all listed tokens
- [x] Inspect package versions
- [x] Determine the actual current runtime path by following runtime calls
- [x] Write CURRENT ARCHITECTURE + TARGET ARCHITECTURE into this document

### CURRENT ARCHITECTURE (discovered by following runtime calls, not comments)

```
Frontend  POST /calculator
  ↓
api-handler Lambda  ·  calculator-routes.ts
  EXECUTION_MODE = process.env.CALCULATOR_EXECUTION_MODE   (stack sets 'agentcore-harness')
  line 774: orchestratorFn = mode==='agentcore-harness' && AGENT_LAMBDA_ARN ? agentLambda : legacy orchestrator
  ↓ Lambda Invoke, InvocationType 'Event'
calculator-agent Lambda            ← named "agentcore-harness", is NOT AgentCore
  timeout 15 min, memory 1024
  index.ts:133  for (iteration = 0; iteration < 40; iteration++)
  index.ts:134    BedrockRuntimeClient.send(new InvokeModelCommand({ ... tools: CALCULATOR_TOOLS ... }))
  index.ts:117    executeTool() → Lambda Invoke
  ↓
calculator-mcp-proxy Lambda        ← Bedrock-Agents-Classic action-group shape
  ↓ Lambda Invoke (Function-URL-shaped event)
calculator-mcp-sidecar Lambda      ← DockerImageFunction + Lambda Web Adapter
  sample-aws-pricing-calculator-mcp@1.3.0, HOST=127.0.0.1, PORT=8000, /mcp, SSE-framed
  ↓
calculator.aws
```

The AgentCore Gateway and AgentCore Runtime **are deployed and READY but are
never called at runtime.** `calculator-agent` talks to `calculator-mcp-proxy`
directly by Lambda ARN; nothing in the request path touches
`bedrock-agentcore:InvokeGateway` or `InvokeAgentRuntime`. The `EXECUTION_MODE`
constant in `calculator-agent/index.ts:34` is a hard-coded string literal
`'agentcore-harness'` that only ever gets logged — it selects nothing.

Legacy path still present and reachable via `CALCULATOR_EXECUTION_MODE=legacy`:
`calculator-orchestrator` Lambda (15 min) → `pipeline.ts` (123 KB) →
`compileWithCalculatorAdapter` → `calculator-definitions.ts` (hard-coded
Calculator field IDs) → sidecar → `aws-pricing.ts` Price List cross-check.

### LIVE deployed AgentCore state (proven, `scripts/probe-agentcore-state.mjs`, ap-south-1)

```
AgentCore Runtime  mimoCalcMcp_dev (mimoCalcMcp_dev-G46E17C4q8)
  status        READY
  endpoint      DEFAULT  status=READY
  container     …container-assets…:5800e6f5…  (sample-aws-pricing-calculator-mcp 1.3.0)
  env           MCP_TRANSPORT=http PORT=8000 HOST=0.0.0.0 ESTIMATES_STORE=dynamodb …
  protocol      null            ← DEFECT: not declared as MCP, so it is served as HTTP
  network       {"networkMode":"PUBLIC"}

AgentCore Gateway  iep-dev-calculator-996122083346-ap-south-1-30f1pfwnsb
  status        READY
  gatewayUrl    https://…-30f1pfwnsb.gateway.bedrock-agentcore.ap-south-1.amazonaws.com/mcp
  protocolType  MCP      authorizerType  AWS_IAM
  target        iep-dev-calculator-lambda-mcp…  status=READY
    kind        lambda   ← DEFECT (Phase 6): targets the legacy sidecar Lambda
    lambdaArn   …:function:iep-dev-calculator-mcp-sidecar-996122083346-ap-south-1
    tools       9 hand-written inline tool definitions (drifting copy of the MCP surface)

AgentCore Harnesses  0 existing
```

### CRITICAL AVAILABILITY FINDING (Phase 7 unblocked)

`AgentCore Harness` is a **real, available primitive** in this account and
region. Proven LIVE with `scripts/probe-agentcore-availability.mjs ap-south-1`:

```
principal : arn:aws:iam::996122083346:user/<redacted-iam-user>
account   : 996122083346
region    : ap-south-1

ListHarnesses        AVAILABLE  (0 existing: none)
ListGateways         AVAILABLE  (1 existing: iep-dev-calculator-996122083346-ap-south-1)
ListAgentRuntimes    AVAILABLE  (1 existing: mimoCalcMcp_dev)
ListMemories         AVAILABLE  (0 existing: none)
```

The API surface is present in `@aws-sdk/client-bedrock-agentcore-control@3.1127.0`
(`CreateHarness`, `CreateHarnessEndpoint`, `GetHarness`, `UpdateHarness`,
`ListHarnesses`, `SynchronizeGatewayTargets`) and
`@aws-sdk/client-bedrock-agentcore@3.1127.0` (`InvokeHarness`). Both were added
to `infrastructure/package.json` in this migration.

`CreateHarness` takes exactly the managed-agent-loop shape the brief demands:

| field | use here |
|---|---|
| `model: { bedrockModelConfig: { modelId } }` | Claude, invoked by AgentCore — not by MIMO |
| `systemPrompt: [{ text }]` | source-controlled prompt |
| `tools: [{ type: 'agentcore_gateway', config: { agentCoreGateway: { gatewayArn } } }]` | Gateway → Runtime MCP |
| `maxIterations`, `maxTokens`, `timeoutSeconds` | loop budget owned by AgentCore |
| `truncation: { strategy: 'summarization' \| 'sliding_window' }` | context limits handled without discarding evidence |
| `memory` / `skills` (S3 source) | session continuation + on-demand evidence |
| `InvokeHarness(harnessArn, runtimeSessionId, messages)` | returns an event stream; same session ID continues a conversation |

`CfnHarness` does **not** exist in `aws-cdk-lib` 2.250.0 (available L1s:
`CfnRuntime`, `CfnRuntimeEndpoint`, `CfnGateway`, `CfnGatewayTarget`,
`CfnMemory`, `CfnBrowserCustom`, `CfnCodeInterpreterCustom`,
`CfnWorkloadIdentity`, `CfnPolicy`, `CfnPolicyEngine`, `CfnEvaluator`,
`CfnOnlineEvaluationConfig`, `CfnApiKeyCredentialProvider`,
`CfnOAuth2CredentialProvider`, `CfnBrowserProfile`). Per the brief, the Harness
is therefore provisioned by a CDK **provisioning Custom Resource** calling the
real `CreateHarness`/`UpdateHarness` API — not replaced with a different
architecture.

`CfnGatewayTarget` **does** support `targetConfiguration.mcp.mcpServer.endpoint`
(a plain MCP server URL) alongside `.lambda`, so Phase 6 needs no new API and no
hand-written tool schema.

`CfnRuntime.protocolConfiguration` is a plain `string` and is currently unset on
the deployed Runtime; it must be `'MCP'`.

### LIVE FINDING — the MCP Runtime has never actually served MCP

Phase 5's isolation test was run against the deployed Runtime before touching
anything (`node scripts/live-mcp-runtime-smoke.mjs ap-south-1`). Result:

```
runtime   : mimoCalcMcp_dev (mimoCalcMcp_dev-G46E17C4q8)
status    : READY
protocol  : null  ← not declared MCP

FAIL  initialize  (130295ms)
      Runtime health check failed or timed out. Please make sure that health check
      is implemented according to the requirements here -
      https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-service-contract.html
FAIL  tools/list  (135160ms)
      Runtime initialization time exceeded. Please make sure that initialization
      completes in 120s.
      discovered 0 tools:
```

Diagnosis: because `protocolConfiguration` was never set, AgentCore applied the
**HTTP** runtime service contract, which requires the container to answer
`GET /ping`. `sample-aws-pricing-calculator-mcp` serves only `POST /mcp` and
answers 405 on GET, so the health check can never pass. The Runtime reports
`READY` (the container starts) while every MCP call fails.

This is why "AgentCore" never worked and why the hand-rolled InvokeModel loop
appeared to be the only thing that functioned. Fix: `protocolConfiguration: 'MCP'`
(CFN takes the flattened string; the SDK takes `{ serverProtocol: 'MCP' }`), which
switches AgentCore to the MCP service contract — `POST /mcp`, port 8000, stateless
streamable HTTP, no `/ping` probe. The upstream server already matches that
contract.

### TARGET ARCHITECTURE

```
MIMO API / UI
  ↓  POST returns calculationId immediately
WorkbookEvidence + WorkbookEvidenceIndex + evidence chunks  →  S3
  ↓
asynchronous AgentCore calculator execution  (Step Functions Standard)
  ↓  short-lived pump step; no Claude loop inside it
InvokeHarness  →  Amazon Bedrock AgentCore Harness   (managed Claude orchestration)
  ↓  tool type agentcore_gateway
AgentCore Gateway
  ↓  target kind mcpServer  (NOT lambda)
AgentCore Runtime  ·  sample-aws-pricing-calculator-mcp  ·  protocol MCP
  ↓
AWS Pricing Calculator
  ↓
calculator.aws URL
  ↓
structured result  →  S3        (small summary only → DynamoDB)
  ↓
MIMO result page
  ↓
cleaned Excel
```

Why Step Functions: `InvokeHarness` returns a synchronous **event stream**, so
some caller must hold it. A Lambda holding it reintroduces a 15-minute ceiling
(Phase 28 forbids it). A Step Functions Standard state machine loops a
short-lived pump Lambda that calls `InvokeHarness` with a bounded
`timeoutSeconds` and re-enters with the **same `runtimeSessionId`** to continue,
so the Claude↔tool loop stays entirely inside AgentCore, the wall-clock budget is
unbounded, and the SFN execution status becomes the authoritative liveness signal
for Phase 11.

---

## Phase 1 — Preserve all workbook input

Built in `lambdas/shared/workbook-evidence.ts`. Tested by
`test/workbook-evidence.test.ts` — **22/22 passing, MOCKED**.

Key finding: `WorkbookIR` (`lambdas/shared/workbook.ts`) was **already lossless** and
already persisted to S3 — every non-empty cell with `a1`, `raw`, `formatted`, `formula`,
`dataType`, `mergedRange`, `mergeAnchor`, plus `mergedRanges`, `namedRanges` and
`nonEmptyCellCount`. The truncation was never in the parser; it was entirely in the
agent Lambda's IR→evidence conversion. So the new module is a *projection* of that IR
rather than a second parser — one place where a spreadsheet becomes data.

- [x] Remove the architecture of silently truncating workbook evidence — the new path has no row cap anywhere
- [x] Create lossless `WorkbookEvidence` interface with the specified shape
- [x] Create `WorkbookEvidenceSheet` with per-cell `address`/`column`/`header`/`raw`/`formatted`/`formula`/`inheritedHeader`
- [x] Preserve sheet
- [x] Preserve row
- [x] Preserve cell address
- [x] Preserve header/context — header rows detected and attributed per column
- [x] Preserve raw value
- [x] Preserve formatted value
- [x] Preserve formula where relevant
- [x] Preserve merged-header inheritance — `inheritedHeader` resolves the merge anchor's text onto every spanned cell, so a row under a "Production / FY27" banner is no longer environment-less
- [x] Preserve fiscal-period context — `detectedFiscalPeriods` + per-chunk `fiscalPeriodHints`
- [x] Preserve environment context where deterministically known — `detectedEnvironments` + per-chunk `environmentHints`
- [x] `accounting` block populated
- [ ] `slice(0, 300)` at `calculator-agent/index.ts:73` and `:88`, and `EVIDENCE_ROW_LIMIT = 200` at `:265`, still present — that file is now the `legacy-invokemodel` rollback path and is not reached in the default mode, but the caps have not been deleted
- [ ] Complete evidence artifact written to S3 — the writer is not yet wired into the POST route
- [x] Complete evidence object never written to DynamoDB — nothing in the new path puts it there

## Phase 2 — Large workbook chunking, never truncation

- [x] Create `WorkbookEvidenceIndex` with the specified shape
- [x] `detectedEnvironments` populated
- [x] `detectedFiscalPeriods` populated
- [x] `serviceHints` populated — a short list of service *families* used only to route chunks, explicitly not a service catalogue; resolution stays with `search_services`
- [x] S3 layout `users/{owner}/calculator/{calculationId}/evidence/index.json` and `…/chunks/NNNN.json` defined and unit-tested
- [x] Small workbook: inline all evidence when safely within context limits (`fitsInline`, 200 KB)
- [x] Large workbook: give Claude the index + fetch instructions per chunk
- [x] MIMO-owned `get_workbook_evidence` tool implemented (`lambdas/calculator-evidence-tool/index.ts`)
- [x] Tool accepts `calculationId`, `chunkId?`, `sheet?`, `rowsFrom?`, `rowsTo?`, `environment?`, `fiscalPeriod?` (plus `costRelevantOnly?`)
- [x] Tool returns S3-backed workbook evidence, and when its response budget is reached it returns `moreAvailable` + `nextChunkId` rather than silently stopping
- [x] Nothing cost-relevant disappears because of token limits — proven by test: chunk row ids reunion exactly equals all row ids, no loss and no duplication, on a 4000-row workbook
- [ ] Tool exposed to the agent as a second Gateway target — handler written, CDK target not yet added

Row-range filters select any chunk that **overlaps** the range and then filter rows
exactly, because selecting only fully-contained chunks would silently drop the partial
chunk at each end — the same class of bug as the original truncation.

The tool resolves the S3 owner prefix from the calculation record rather than trusting
the agent, so a prompt-injected `calculationId` cannot read another tenant's evidence.

## Phase 3 — Evidence accounting

- [x] `costRelevantEvidence = consumedByAgent + explicitlyIgnored + unsupported + unresolved`
- [x] Zero silent remainder enforced — a row the agent never mentions is moved to `unresolved`, not dropped; tested
- [x] Decorative formatting cells not counted as cost evidence — `classifyRow` returns `cost-relevant` / `context` / `decorative`; a lone spanned banner is decorative, a text-only note is context, a label-plus-quantity is cost-relevant
- [x] `evidence-accounting.json` written to S3 by the driver on completion
- [x] Agent result includes evidence ids consumed — `evidenceConsumed` / `evidenceExcluded` / `evidenceUnsupported` / `evidenceUnresolved` are in the response contract, keyed by the `Sheet!Row` ids the agent was given
- [x] This is not another Calculator compiler — it counts rows and reconciles claims; it does not decide any Calculator configuration
- [x] Unaccounted rows surface as a customer-visible warning rather than silence

## Phase 4 — AgentCore MCP Runtime

- [x] AgentCore Runtime genuinely hosts `sample-aws-pricing-calculator-mcp` — **LIVE AWS**, `initialize` returned `{"name":"sample-aws-pricing-calculator-mcp","version":"1.3.0"}`
- [x] Upstream implementation used as directly as possible, no rewrite of AWS Calculator logic (container runs `node node_modules/sample-aws-pricing-calculator-mcp/dist/mcp-server.js` unmodified)
- [x] host `0.0.0.0`
- [x] port `8000`
- [x] path `/mcp`
- [x] transport: streamable HTTP MCP
- [x] `protocolConfiguration: 'MCP'` set on the Runtime — **LIVE AWS**, applied via `scripts/fix-runtime-protocol-mcp.mjs`, now `{"serverProtocol":"MCP"}` at Runtime version 2, status READY
- [x] Supported AgentCore container architecture (`LINUX_ARM64`)
- [x] `ESTIMATES_STORE=dynamodb` / `ESTIMATES_TABLE=iep-dev-calculator-estimates-…` retained
- [x] That table holds MCP working state only; no MIMO workbook/results in it
- [ ] Same setting made permanent in CDK so the next deploy does not revert it

## Phase 5 — MCP Runtime isolation test

**All LIVE AWS.** `node scripts/live-mcp-runtime-smoke.mjs ap-south-1 --full`.
No Gateway, no Harness, no Lambda, no MIMO code in the path.

- [x] MCP Runtime independently testable before the Gateway is connected
- [x] Smoke/integration script against the **live** AgentCore Runtime MCP endpoint (`InvokeAgentRuntime` with `mcpMethod`/`mcpSessionId`)
- [x] Tool surface discovered with `tools/list` — 9 tools: `get_server_info, search_services, get_service_fields, create_estimate, add_service, validate_estimate, export_estimate, build_estimate, import_estimate`
- [x] `get_server_info` exercised
- [x] `search_services` exercised
- [x] `get_service_fields` exercised — parent `amazonS3` returned `status/next_step/redirect_to/child_service_codes/catalog`; leaf `amazonS3Standard` returned 7 fields with defaults and units
- [x] `create_estimate` exercised
- [x] `add_service` exercised
- [x] `validate_estimate` exercised
- [x] `export_estimate` exercised — **produced a real URL:** `https://calculator.aws/#/estimate?id=3a25374a11b4baea77709fc7ad13ec661fe7c8dc`
- [ ] `import_estimate` exercised
- [ ] `build_estimate` exercised
- [x] No fake local schema passed off as Runtime validation — the script resolves service code, field id and value shape by reading the MCP's own `catalog.subServices[].required[].shape`

### What the live MCP proved about the ownership boundary

The MCP returned, unprompted, the following Calculator knowledge that MIMO's
hard-coded tables cannot track:

- `amazonSimpleStorageServiceGroup` is a `subServiceSelector` parent; configure
  `amazonS3Standard` / `awsS3DataTransfer` instead and never `addService` the parent.
- "The storage size field is `s3StandardStorageSize`, not `storageAmount`.
  Shape: `{ value: '<n>', unit: 'gb|month' }`."
- The `add_service` entry key is `service` (not `serviceCode`), and `region` and
  `description` belong **inside** `config`.
- Per-field-type value shapes (`numericInput` plain string, `fileSize`/`frequency`/
  `durationInput` `{value,unit}`, `dropdown` option id).
- "Lambda needs `sizeOfMemoryAllocated`, `storageAmountEphemeral` and `architecture`
  to produce a non-zero price" — otherwise the estimate saves at $0.
- `add_service` **always appends**; re-adding after a validation problem silently
  duplicates the row and inflates cost. Rebuild with `create_estimate` instead.
- Descriptions and group names must not contain `<`, `>` or `&`.

Each of these is a Calculator-internal fact. Two of MIMO's reported symptoms are
directly explained: the duplicate-line/inflated-cost class of bug is the
append-retry semantics above, and the `$0`/dash-filled results are the
missing-pricing-field trap. Both are things the MCP already knows and MIMO was
guessing at.

## Phase 6 — AgentCore Gateway must target MCP Runtime

**All LIVE AWS**, after `cdk deploy IepStack-dev` reached `UPDATE_COMPLETE`.
Proof: `node scripts/live-gateway-mcp-smoke.mjs ap-south-1`.

- [x] Current Gateway target inspected — was `kind=lambda` → legacy sidecar, with 9 hand-written tool definitions
- [x] Production Gateway target is the AgentCore Runtime MCP endpoint — `kind=mcpServer`, `status=READY`
- [x] `props.existingSidecar.functionArn` no longer the production target — the Lambda target is deleted, not merely deprioritised ("Legacy Lambda target still present: NO")
- [x] Current AWS-supported IAM/SigV4 runtime authentication used — Gateway `authorizerType=AWS_IAM`; target uses `GATEWAY_IAM_ROLE` + `iamCredentialProvider{service:'bedrock-agentcore'}`; clients sign SigV4 for `bedrock-agentcore`
- [x] Calculator tool definitions not hand-maintained in CDK — the `inlinePayload` block of 9 tool definitions is deleted
- [x] Tool schemas generated by authoritative MCP discovery — the Gateway calls `tools/list` on the Runtime itself while creating the target; a target whose server cannot be listed goes `CREATE_FAILED`

```
gateway     : iep-dev-calculator-996122083346-ap-south-1     status READY
url         : https://…-30f1pfwnsb.gateway.bedrock-agentcore.ap-south-1.amazonaws.com/mcp
targets     : iep-dev-calculator-runtime-mcp-…  status=READY  kind=mcpServer
              endpoint .../runtimes/arn%3A…%3Aruntime%2FmimoCalcMcp_dev-G46E17C4q8/invocations?qualifier=DEFAULT

PASS  initialize   serverInfo {"version":"1.0.0","name":"iep-dev-calculator-…"}
PASS  tools/list   9 tools via Gateway
PASS  tools/call get_server_info
              → {"name":"sample-aws-pricing-calculator-mcp","version":"1.3.0", …}
```

The `get_server_info` result is the load-bearing part: the call went
client → Gateway → Runtime → upstream MCP and came back naming the real upstream
server. Infrastructure existing is not evidence; this is.

### Two behaviours discovered live that the rest of the migration must respect

1. **The Gateway prefixes tool names** as `<targetName>___<toolName>`, e.g.
   `iep-dev-calculator-runtime-mcp-996122083346-ap-south-1___get_service_fields`.
   Anything matching on tool names — `allowedTools`, the system prompt, the
   `mcpToolsUsed` diagnostics — must tolerate the prefix rather than expect the bare
   name.
2. **The Gateway negotiates its own MCP protocol version**, not the Runtime's. It
   rejects `2025-06-18` with
   `-32600 Unsupported protocol version {"supported":["2025-03-26"]}`,
   even though the Runtime itself speaks `2025-06-18`.

## Phase 7 — Real AgentCore managed Claude execution

**The primitive is proven LIVE.** `node scripts/live-harness-probe.mjs ap-south-1`
created a real Harness from the exact request shape now encoded in
`lambdas/calculator-harness-provisioner/index.ts`:

```
CreateHarness {
  harnessName, executionRoleArn,
  model:        { bedrockModelConfig: { modelId: 'global.anthropic.claude-sonnet-4-6', maxTokens } },
  systemPrompt: [{ text }],
  tools:        [{ type: 'agentcore_gateway', name: 'calculator_mcp',
                   config: { agentCoreGateway: { gatewayArn } } }],
  maxIterations, timeoutSeconds,
  truncation:   { strategy: 'summarization', config: { summarization: {...} } },
}

ACCEPTED  harnessId=MimoCalcProbe-rQPlKs5LGu status=CREATING
          → READY after ~2.5 min, version 1
endpoints : DEFAULT(READY)                    ← created automatically
environment: { agentCoreRuntimeEnvironment: {
                 agentRuntimeName: 'harness_MimoCalcProbe',
                 lifecycleConfiguration: { idleRuntimeSessionTimeout: 900,
                                           maxLifetime: 28800 },
                 networkConfiguration: { networkMode: 'PUBLIC' } } }
```

`maxLifetime: 28800` is **8 hours**. That single fact settles Phases 11 and 28: a
calculator run is legitimately allowed to take far longer than the 15-minute Lambda
ceiling and the 11-minute staleness check that were failing it.

- [x] No Bedrock Agents Classic — nothing calls `CreateAgent`
- [x] No `InvokeInlineAgent` — removed from the design; the IAM grant for it is gone
- [x] Real current API used (`CreateHarness` / `InvokeHarness`), not an invented abstraction
- [x] No fake Harness abstraction wrapped around a Lambda — the Harness is a real AgentCore resource with its own managed runtime, provisioned by a Custom Resource because `CfnHarness` does not exist in aws-cdk-lib 2.250.0
- [x] Managed AgentCore component owns the loop — `tools: [agentcore_gateway]`, `maxIterations` and `timeoutSeconds` are Harness properties; MIMO sends one message and reads a stream
- [ ] Custom `InvokeModelCommand` + `tool_use` + `executeTool()` loop removed from production — code is now labelled `legacy-invokemodel`, but `calculator-routes.ts` still routes to it; the driver that replaces it is not yet wired
- [ ] MIMO submits calculation ID
- [ ] MIMO submits scenario
- [ ] MIMO submits `WorkbookEvidenceIndex`
- [ ] MIMO submits relevant evidence
- [ ] MIMO submits customer instructions
- [ ] MIMO receives/polls agent execution/session status
- [ ] MIMO receives structured final result

### Deploy defects found and fixed along the way

Each of these failed a real `cdk deploy` and is recorded because the failure mode was
invisible in synth:

1. **Gateway target created before its permission existed.** `addToPolicy` produces a
   separate `AWS::IAM::Policy` that CloudFormation updates *in parallel* with creating
   the target, so the target called `tools/list` unauthorised and went `CREATE_FAILED`.
   Fixed by moving the grant into the role's `inlinePolicies` and adding an explicit
   dependency. Same trap the existing `RuntimeRole` comment already warned about.
2. **The system prompt was shipped as a Lambda environment variable.** Growing the
   prompt broke every deploy with
   `"Request must be smaller than 5120 bytes for the UpdateFunctionConfiguration
   operation"` (413). Lambda caps the whole function configuration, so a document in
   env has a hard ceiling a few edits away. The prompt now reaches the Harness through
   the Custom Resource; the legacy Lambda carries a condensed fallback.
3. **`AWS_REGION` set as a Lambda environment variable.** Reserved by the Lambda
   runtime; fails synth with «ReservedEnvironmentVariable» once the region resolves to
   a literal. Removed — Lambda populates it itself.
4. **A dead `GatewayRole`** was created on every deploy and referenced by nothing.
   Removed.

### Pre-existing constraints noticed (not caused by this work, worth flagging)

- The stack is at **455 of 500** CloudFormation resources. The Harness Custom Resource
  provider added ~27. There is room for this migration and not much beyond it.
- An API Gateway Lambda permission policy has previously failed at
  `"The final policy size (20816) is bigger than the limit (20480)"`. Adding many more
  routes will hit that again.

## Phase 8 — System prompt for Claude

`infrastructure/prompts/calculator-agent-system.txt`, delivered to the Harness by the
CDK Custom Resource (**not** by a Lambda env var — see the deploy defects above).

- [x] Source-controlled calculator agent system prompt
- [x] Rewritten to the Phase 8 behaviour spec (items 1–19)
- [x] `COMPLETED` / `NEEDS_INPUT` / `FAILED` response contracts specified
- [x] Extended with a "known Calculator behaviour" section written from what the **live**
      MCP actually returned, not from memory: append-only `add_service`, the $0 pricing
      trap, `subServiceSelector` parents, the `< > &` restriction, empty-estimate export
      refusal
- [x] Tolerates the Gateway's `<target>___<tool>` name prefixing
- [x] Tells the agent the `get_service_fields` response *shape varies* (parent selector vs
      leaf) rather than assuming one shape

## Phase 9 — Autonomous default policy

- [x] Resolution order 1–8 encoded in the prompt
- [x] Steps 4–7 recorded as assumptions
- [x] SageMaker structural-baseline example encoded
- [x] EventBridge payload-default example encoded
- [x] MemoryDB check-before-asking example encoded

## Phase 10 — Asynchronous execution

- [ ] No long-running Calculator agent inside API Gateway / Lambda
- [ ] POST creates/updates job
- [ ] POST persists evidence/index
- [ ] POST starts AgentCore execution
- [ ] POST returns calculation ID immediately
- [ ] Frontend polls status
- [ ] Persist `calculation_id`, `status`, `agent_execution_id`, `agent_session_id`, `agent_started_at`, `agent_last_activity_at`, `progress_stage`, `progress_message`, `result_s3_key`, `calculator_url`
- [ ] No complete Claude/MCP conversation traces in DynamoDB

## Phase 11 — Remove false 11-minute failure

- [ ] `CALCULATION_STALE_AFTER_MS = 11 * 60 * 1000` (`calculator-routes.ts:512`) no longer falsely fails AgentCore executions
- [ ] `"The estimate worker stopped before finishing. Please retry."` no longer emitted for a live execution
- [ ] Staleness not classified by generic `updated_at` alone
- [ ] Uses AgentCore execution status and/or `agent_last_activity_at`
- [ ] Managed execution status preferred where exposed
- [ ] Test: agent running >20 minutes with activity → must NOT fail
- [ ] Test: execution genuinely stopped/failed → marked FAILED
- [ ] Large workbook alone never produces a stale failure

## Phase 12 — Remove long-running agent Lambda

- [ ] `calculator-agent` custom InvokeModel loop out of the production path
- [ ] Isolated as legacy
- [ ] Execution modes: `agentcore-runtime`, `legacy-invokemodel`, `legacy-compiler`
- [ ] Default is `agentcore-runtime`
- [ ] The InvokeModel Lambda is no longer called `agentcore-harness`

## Phase 13 — Remove MCP proxy/sidecar from production path

- [ ] Production does not do Agent → `calculator-mcp-proxy` → `calculator-mcp-sidecar`
- [ ] Production does AgentCore Harness → Gateway → Runtime MCP
- [ ] Old proxy/sidecar kept only for rollback
- [ ] Acceptance test disables `calculator-agent`, `calculator-mcp-proxy`, legacy sidecar and verifies the new path still works

## Phase 14 — Remove MIMO Calculator compiler from new path

- [ ] Zero runtime dependency on `compileWithCalculatorAdapter()`
- [ ] Zero runtime dependency on `service-adapters.ts` Calculator config generation
- [ ] Zero runtime dependency on `calculatorKey`
- [ ] Zero runtime dependency on `calculatorConfig`
- [ ] Zero runtime dependency on MIMO `columnFormIPM`
- [ ] Zero hard-coded SageMaker Calculator field IDs
- [ ] Zero hard-coded EventBridge Calculator field IDs
- [ ] Zero hard-coded MemoryDB Calculator field IDs
- [ ] Zero MIMO recreation of the Calculator required-field schema
- [ ] Changing `service-adapters.ts` cannot change MCP payloads in the AgentCore path
- [ ] Regression / dependency-boundary test added

## Phase 15 — Canonical format

- [ ] Internal input to the agent is semantic workload evidence, not MCP/Calculator config
- [ ] `CanonicalWorkloadResource` shape (if used) matches the spec
- [ ] Format never contains `columnFormIPM`
- [ ] never contains `Data_Written`
- [ ] never contains `Mdb_BackupStorage`
- [ ] never contains `modelsDeployed`
- [ ] never contains `Number_of_custom_events`
- [ ] never contains opaque Calculator service field IDs

## Phase 16 — NEEDS_INPUT

- [ ] `NEEDS_INPUT` is rare
- [ ] Questions use customer-facing language
- [ ] Never asks "Number of models deployed?"
- [ ] Never asks "modelsPerEndPoint?"
- [ ] Never asks "Size_of_the_payload?"
- [ ] Never asks "Data_Written?"

## Phase 17 — Agent continuation after user answer

- [ ] Same AgentCore session/execution continued where supported
- [ ] Otherwise continuation run preserves `WorkbookEvidenceIndex`
- [ ] preserves relevant evidence chunks
- [ ] preserves previous structured agent state
- [ ] preserves previous assumptions
- [ ] reuses existing estimate ID when safe
- [ ] carries the customer's new answer
- [ ] Old `EstimatePlan` compiler not rebuilt

## Phase 18 — Result success contract

- [ ] `COMPLETED` requires a real `calculator.aws` URL
- [ ] MCP validation result recorded when available
- [ ] export success recorded when available
- [ ] saved-estimate read-back recorded when available
- [ ] Calculator totals recorded when available
- [ ] A valid URL is not failed solely because an optional Price List diagnostic disagrees
- [ ] Missing totals never fabricated
- [ ] URL-without-totals shows the URL plus "Open the AWS estimate to view detailed Calculator totals."

## Phase 19 — Customer result UI

- [ ] Dash-filled pseudo-final experience removed
- [ ] No completed-looking page dominated by `—` / "validation incomplete"
- [ ] `ANALYZING` → "Reading your workbook..."
- [ ] `BUILDING` → "Claude is configuring AWS Pricing Calculator..."
- [ ] `BUILDING` → "Resolving AWS services..."
- [ ] `BUILDING` → "Creating AWS Pricing Calculator estimate..."
- [ ] `VALIDATING` → "Validating the AWS estimate..."
- [ ] `COMPLETED` shows monthly / upfront / 12-month, Open-Calculator button, Download Excel, assumptions, warnings
- [ ] URL-without-totals variant renders correctly
- [ ] Unavailable diagnostics not filled with dashes

## Phase 20 — Failure UX

- [ ] Raw infrastructure errors never shown to ordinary users
- [ ] `"Item size to update has exceeded the maximum allowed size"` not surfaced
- [ ] stack traces not surfaced
- [ ] Lambda `FunctionError` not surfaced
- [ ] raw MCP JSON not surfaced
- [ ] raw AgentCore payload not surfaced
- [ ] CloudFormation internals not surfaced
- [ ] Customer-facing copy: "We couldn't complete this AWS estimate automatically."
- [ ] Retry action
- [ ] "View technical details" for authorized/admin users
- [ ] Full diagnostics in S3 / CloudWatch

## Phase 21 — Excel output

- [ ] Cleaned Excel generated only after a Calculator URL exists
- [ ] Order is AgentCore → MCP → Calculator URL → result → Excel
- [ ] Sheet: Cost Summary
- [ ] Sheet: AWS Calculator Links
- [ ] Sheet: Resources
- [ ] Sheet: Assumptions & Warnings
- [ ] Sheet: Source Trace
- [ ] Cost Summary carries Scenario, Pricing model, Monthly, Upfront, 12 Months, Calculator URL, Status
- [ ] No invented per-service prices

## Phase 22 — S3 / DynamoDB architecture

- [ ] S3 holds original workbook, WorkbookIR, WorkbookEvidence, index, chunks, accounting, agent input, agent output, agent traces, MCP/Calculator artifacts, final result, cleaned Excel
- [ ] DynamoDB holds only the lightweight field list
- [ ] Normal new DynamoDB item < 50 KB
- [ ] Hard regression guard < 100 KB
- [ ] Huge `workbook` no longer kept on new records
- [ ] `plan_v2` no longer kept on new records
- [ ] `RESOURCE_BYTES_ON_ITEM = 120_000` sample no longer kept on new records
- [ ] 96 KB result previews no longer kept on new records
- [ ] Legacy read compatibility preserved

## Phase 23 — MCP internal DynamoDB

- [ ] MIMO storage and MCP working-state storage kept distinct
- [ ] Dedicated MCP TTL estimates table retained
- [ ] That table holds only MCP working state
- [ ] Not removed merely because MIMO artifacts moved to S3

## Phase 24 — Observability / prove MCP usage

- [ ] `executionMode = "agentcore-runtime"`
- [ ] `agentModelId`
- [ ] `agentExecutionId`
- [ ] `agentSessionId`
- [ ] `gatewayIdentifier`
- [ ] `mcpRuntimeIdentifier`
- [ ] `mcpServerName`
- [ ] `mcpServerVersion`
- [ ] `mcpToolsUsed`
- [ ] `toolCallCount`
- [ ] `durationMs`
- [ ] `calculatorUrlCreated`
- [ ] Detailed traces to S3 / CloudWatch at `agent/traces/{executionId}.json`
- [ ] Trace proves Claude → Gateway → Runtime MCP
- [ ] MCP usage not inferred merely from infrastructure existing

## Phase 25 — Local Price List is optional

- [ ] Price List cross-check is Advanced Diagnostics only
- [ ] It does not determine success
- [ ] A failed lookup shows "Cross-check unavailable" internally
- [ ] never `$0` in the primary customer result
- [ ] never `—` in the primary customer result

## Phase 26 — Digital Assets live regression (`docs/Digital_Assets.xlsx`)

- [ ] All cost-relevant workbook evidence available to Claude
- [ ] No silent first-200/300 row truncation
- [ ] SageMaker handled through Claude + MCP
- [ ] Structural SageMaker values may come from MCP verified baseline where compatible
- [ ] EventBridge configured through MCP
- [ ] No duplicate "Size of the payload, Size of the payload"
- [ ] No internal Calculator questionnaire
- [ ] Claude repairs recoverable MCP responses
- [ ] Real `calculator.aws` URL is the success criterion
- [ ] No dash-filled pseudo-final result

## Phase 27 — Core BOM live regression (`docs/Core BOM.xlsx`)

- [ ] MemoryDB handled by Claude + MCP
- [ ] No MIMO hard-coded MemoryDB Calculator config in the production path
- [ ] No duplicate "Data Written, Data Written"
- [ ] MCP baseline/default/corrections used where appropriate
- [ ] Local RDS/MQ Price List misses do not invalidate Calculator success
- [ ] Real `calculator.aws` URL where the workload is supportable

## Phase 28 — Rainbow large-workbook regression (`docs/Rainbow_TCO_30Apr2026_v1_2.xlsx`)

- [ ] Full workbook evidence preserved
- [ ] Evidence index/chunks generated
- [ ] Claude can access every relevant chunk
- [ ] No arbitrary 200/300 row truncation
- [ ] DynamoDB item remains < 100 KB
- [ ] No DynamoDB item-size exception
- [ ] No 15-minute Lambda agent timeout architecture
- [ ] No false 11-minute stale failure
- [ ] Long execution can remain active properly
- [ ] Terminal AgentCore status eventually returned

## Phase 29 — Small live end-to-end test

Run: `node scripts/live-agentcore-e2e-smoke.mjs ap-south-1` against the deployed
Harness `mimoCalc_dev-dAmgUcz1zg`. **Partially passing — see the blocker below.**

- [x] Amazon S3 / 100 GB / `ap-south-1` submitted through the full new path
- [x] Does not invoke the custom `calculator-agent` InvokeModel loop
- [x] Does not invoke `calculator-mcp-proxy`
- [x] Does not invoke the legacy `calculator-mcp-sidecar`
- [x] Does not invoke the legacy calculator compiler
- [x] AgentCore genuinely owns the loop — observed LIVE:

```
harness    : mimoCalc_dev (mimoCalc_dev-dAmgUcz1zg)   status READY
model      : global.anthropic.claude-sonnet-4-6  apiFormat converse_stream
tools      : [{ type: agentcore_gateway, name: calculator_mcp, gatewayArn: …-30f1pfwnsb }]
maxIters   : 40   timeout=3600s
environment: { idleRuntimeSessionTimeout: 900, maxLifetime: 28800 }

"I'll build this estimate step by step. Let me start by getting the service fields…"
[tool] calcmcp___get_service_fields
[messageStop {"stopReason":"tool_use"}]
[metadata {"usage":{"inputTokens":7105,…},"metrics":{"latencyMs":1709}}]
[messageStop {"stopReason":"tool_result"}]          ← AgentCore ran the tool, not MIMO
"Got the fields. Now let me build the estimate with 100 GB of S3 Standard…"
[tool] calcmcp___build_estimate
[messageStop {"stopReason":"tool_use"}]
```

The `tool_use` → `tool_result` transition with no MIMO code in between is the proof
that the loop belongs to AgentCore.

- [ ] **BLOCKED — real `calculator.aws` URL not yet produced through the Harness.** See
      BLOCKER 3.

## SESSION 2 — the MIMO cutover

### BLOCKER 3, re-diagnosed: the stall is intermittent and not tool-specific

Session 1 recorded this as "long-running MCP tools hang through the Gateway" and blamed
`build_estimate`. That was wrong, and the correction matters: it changes the fix from
"avoid one tool" to "bound and retry every tool".

`scripts/live-gateway-sequential-calls.mjs` makes N sequential `tools/call`s through the
Gateway with a per-call timeout. Two identical runs, minutes apart:

| call | run A | run B |
|---|---|---|
| 1 `get_server_info` | OK 760ms | OK 852ms |
| 2 `search_services` | OK 781ms | OK 878ms |
| 3 `get_service_fields` | OK 785ms | OK 875ms |
| 4 `create_estimate` | OK 727ms | OK 1018ms |
| 5 `add_service` | OK 877ms | **TIMEOUT 60s** |
| 6 `validate_estimate` | OK 889ms | — |
| 7 `export_estimate` | **TIMEOUT 45s** | — |

Different call index, different tool. And `scripts/live-gateway-add-service-probe.mjs`
shows `add_service` itself is fine through the Gateway — 973ms for an empty list, 99ms for
a schema rejection, 976ms for a real 100 GB S3 service returning `success: true`.

So: not tool-specific, not duration-specific. The Gateway→Runtime hop stalls
intermittently, roughly once in five to seven calls. One clue: `initialize` through the
Gateway returns **no** `mcp-session-id`, while the AgentCore Runtime is session-affine — the
Gateway does not appear to hold MCP session affinity with the Runtime behind it.

**It is bounded, though.** AgentCore terminates a stalled run itself:

```
RuntimeClientError: Request timed out as the agent didn't have a response byte in last 15 mins.
```

That arrives as a `runtimeClientError` event in the InvokeHarness stream, which the driver
already records and treats as "not finished" — so Step Functions re-enters on the same
session and the agent retries. The mitigation is the architecture that was already there,
plus tuning:

- Harness `timeoutSeconds` 3600 → **420**, so a stall costs seven minutes rather than an hour
- Driver `CALCULATOR_STEP_TIMEOUT_SECONDS` 600 → **420**; Lambda timeout 14 → 10 minutes
- Up to 60 segments, so the retry budget is large without being unbounded

`build_estimate` is disabled regardless: it is a convenience wrapper doing create + add +
export in one call, so it is the longest call and the most exposed to the stall, and
everything it does is expressible with the step-by-step tools.

### Step 1 — multi-step trajectory verified LIVE

After deploying the prompt, `scripts/live-agentcore-e2e-smoke.mjs`:

```
"I'll build this estimate step by step. Let me start by getting the service fields for Amazon S3."
[tool] calcmcp___get_service_fields
[messageStop {"stopReason":"tool_use"}]
[messageStop {"stopReason":"tool_result"}]
"Good. Now let me create the estimate and add the S3 service."
[tool] calcmcp___create_estimate
```

- [x] The agent does **not** call `build_estimate`
- [x] It uses `get_service_fields` → `create_estimate` → …
- [x] `build_estimate` marked unsupported for the MIMO AgentCore path
- [ ] That run then hit the intermittent stall and ended on the 15-minute no-byte error,
      which is exactly what the bounded-segment retry now exists to absorb

### Step 2 — add_service append-only repair semantics

- [x] Prompt rewritten with the anti-pattern spelled out: adding a corrected service to the
      same estimate bills the customer twice, so a repair means discarding the estimate and
      replaying the corrected list into a fresh one
- [x] Export only an estimate where each service was added exactly once
- [x] `existing_entry` treated as "you are about to duplicate; start over"

### Step 3 — evidence tool provisioned

- [x] `get_workbook_evidence` exposed to the Harness as a **second Gateway target**
      (`mimoev`), a Lambda MCP target — MIMO owns this tool over MIMO's data, so MIMO writes
      its schema; no Calculator tool schema is hand-written anywhere
- [x] Target name kept short for the same 64-char tool-name reason as `calcmcp`
- [x] Supports `calculationId`, `chunkId`, `sheet`, `rowsFrom`, `rowsTo`, `environment`,
      `fiscalPeriod`, `costRelevantOnly`
- [x] Owner resolved from the calculation record, never from the agent's arguments, so a
      prompt-injected `calculationId` cannot read another tenant's prefix — gated by test
- [ ] Row >300 retrieval verified live

### Step 4 — Runtime MCP protocol permanent in CDK

- [x] `protocolConfiguration: 'MCP'` in committed CDK (`calculator-agentcore.ts:164`)
- [x] Present in the synthesised template (`"ProtocolConfiguration": "MCP"`)
- [x] Asserted by test, so a later deploy cannot revert the Runtime to the HTTP contract

### Step 5 — async driver provisioned

- [x] Step Functions **Standard** state machine `calculator-agentcore-exec`, 12-hour timeout
- [x] `calculator-harness-driver` Lambda as the pump: one bounded `InvokeHarness` per segment
- [x] Continues on the same `runtimeSessionId`; up to 60 segments
- [x] No single Lambda owns the calculation lifetime
- [x] No Claude loop in Step Functions or the Lambda — gated by test (`InvokeModelCommand`
      and `executeTool` must not appear in the driver)
- [x] A driver failure routes to a `fail` mode that writes a terminal customer-facing record

### Step 6 — POST/run wired to the new driver

- [x] `CALCULATOR_EXECUTION_MODE` default is now `agentcore-runtime`
- [x] In that mode the route persists evidence, starts the state machine and returns
      immediately — **no Lambda invoke of any kind**, gated by test
- [x] Records `state_machine_execution_arn`, `agent_session_id`, `agent_started_at`,
      `agent_last_activity_at`, evidence index key and counts
- [x] `legacy-invokemodel` retained as rollback; `agentcore-harness` is no longer a valid
      mode name, because it described a Lambda that never called AgentCore

### Step 7 — stale detection replaced

- [x] The 11-minute rule renamed `LEGACY_CALCULATION_STALE_AFTER_MS`, applying only to rows
      with no managed execution
- [x] AgentCore calculations judged by Step Functions status: `RUNNING` → alive regardless
      of duration; `FAILED`/`TIMED_OUT`/`ABORTED` → failed
- [x] A `DescribeExecution` error yields `unknown` and changes nothing
- [x] Liveness prefers `agent_last_activity_at`, refreshed on every stream event
- [x] Tests: long RUNNING not failed; each terminal status mapped; describe-failure benign;
      no-ARN grace (30 min) longer than 11 minutes and the Harness's 900s idle timeout

### Step 9 — DynamoDB slimmed

- [x] `RESOURCE_BYTES_ON_ITEM` 120_000 → **16_000**; rows and evidence live in S3
- [x] `DYNAMO_ITEM_TARGET_BYTES` 50 KB, `DYNAMO_ITEM_HARD_GUARD_BYTES` 100 KB
- [x] `enforceItemSizeBudget` applied before every record write, shedding
      `workbook` → `resources` → `plan_v2` in value-per-byte order
- [x] Size regression tests at all six lifecycle stages
- [x] The driver writes only small fields; result, trace and evidence are S3 keys

### Step 10 — managed result contract

- [x] `COMPLETED` / `NEEDS_INPUT` / `FAILED` parsed from the agent's final JSON
- [x] `COMPLETED` without a real `calculator.aws` URL is downgraded to `FAILED`
- [x] Full structured result to S3; only a small summary to DynamoDB
- [x] Totals the Calculator did not give are `null`, never invented
- [x] No local Price List parity requirement in the new path

### Step 11 — NEEDS_INPUT continuation

- [x] `continueAgentCoreExecution` reuses the existing `runtimeSessionId`, so AgentCore
      continues the conversation — no workbook re-read, no recompiled plan
- [x] Questions stored as `agent_questions` with `question_count`
- [x] Prompt forbids internal-field questions and requires customer language
- [ ] Continuation exercised end to end live

### Step 15 — real MIMO path, and the three defects only it could find

`scripts/live-mimo-e2e.mjs` drives the **deployed api-handler** with real API Gateway
events (upload-url → PUT → create → confirm → run → poll), so the code under test is the
production route rather than a probe. It also samples the four legacy Lambdas' invocation
counts and greps the record's progress text for legacy fingerprints.

Every one of these was invisible to the standalone Harness/Gateway/Runtime probes:

1. **`createCalculation` was never cut over.** Only `runCalculationPlan` was. `POST
   /calculator` builds immediately and dispatches its own worker, so it kept firing the
   legacy orchestrator — and the two then raced the same record. Run 1 produced a real
   Calculator URL and `0` legacy invocations, and it was still wrong: the progress text read
   `"Validated estimate ready"` and `"Workbook baseline: …"`, which only
   `calculator-orchestrator/index.ts` and `calculator-agent/index.ts` write. The legacy
   worker won the race and stamped its result over a live AgentCore execution. Fixed: both
   entry points now take the same AgentCore branch, gated by a test that requires an
   `agentcore-runtime` branch on *both*.

2. **My own legacy check gave a false pass.** Lambda publishes `Invocations` 1–3 minutes
   late, and the script sampled immediately, so it confidently reported "Legacy
   infrastructure untouched: YES" while the legacy orchestrator had just run. Fixed by
   waiting for metric publication *and* corroborating with the progress-text fingerprint,
   which is available instantly. A check that can only report success is worse than none.

3. **The IAM action for `InvokeHarness` is `bedrock-agentcore:InvokeAgentRuntime`.** Not an
   action named after the API. The driver was granted `InvokeHarness` and every segment
   died with a 403 that named what it actually wanted:

   ```
   User: …/iep-dev-calculator-harness-driver-… is not authorized to perform:
   bedrock-agentcore:InvokeAgentRuntime on resource:
   arn:aws:bedrock-agentcore:ap-south-1:996122083346:harness/mimoCalc_dev-dAmgUcz1zg
   ```

   Step Functions retried, then failed the execution and the driver wrote the
   customer-facing `"We couldn't complete this AWS estimate automatically."` — so the
   failure path worked correctly even though the run did not.

4. **`ANALYZING` was missing from the already-running guard**, so `create` starting an
   execution and a following `run` starting another gave two agents on one record. Two
   concurrent sessions were visible in the driver logs. Fixed.

Run 3, after fixes 1, 2 and 4, showed the cutover itself is clean:

```
create OK  status=ANALYZING          ← the AgentCore branch, not the legacy one
No legacy progress fingerprint in the record.
calculator-agent-orchestrator   invocations during run: 0
calculator-mcp-proxy            invocations during run: 0
calculator-mcp-sidecar          invocations during run: 0
calculator-orchestrator         invocations during run: 0
record bytes: 4719              ← was a 400 KB item-size failure class
```

- [x] The request goes MIMO API → S3 evidence → Step Functions → Harness, with an execution
      ARN and session id recorded
- [x] No legacy Lambda is invoked, corroborated two ways
- [x] DynamoDB record far under the guard (4.7 KB)
- [x] A failed execution produces a terminal, customer-facing record
- [ ] A real `calculator.aws` URL through the fully-clean path — pending the run after the
      IAM fix

### Steps 12–14 and 16–19 — NOT done in this session

Frontend status cutover, dash-free result page, final Excel ordering, and the three
workbook regressions plus the legacy-disabled acceptance test are **not** complete.

---

## BLOCKER 3 (session 1 wording, superseded above)

`build_estimate` never returned. The run sat on that single tool call for **22 minutes**
with no further stream events and no error, while the Harness's managed runtime stayed
alive (CloudWatch network metrics still flowing, no errors beyond an unrelated OTel
span-export 403).

Isolation performed:

| call | direct to Runtime MCP | through Gateway from the Harness |
|---|---|---|
| `get_server_info` | 442 ms | works |
| `tools/list` | 470 ms | works (9 tools) |
| `get_service_fields` | 510 ms | **works** (first tool in the run) |
| `create_estimate` | 525 ms | not yet exercised |
| `add_service` | 496 ms | not yet exercised |
| `validate_estimate` | 547 ms | not yet exercised |
| `export_estimate` | 1381 ms | not yet exercised |
| `build_estimate` | returns a real URL, several seconds | **hangs ≥22 min** |

Direct proof `build_estimate` itself is healthy — same arguments, straight at the Runtime:

```
{ "estimate_id": "92b14eb1-b743-4e40-98b9-f4061566cba7",
  "sharable_url": "https://calculator.aws/#/estimate?id=32c8e2f765a141b5ca461d1f643b98f9ac1d919b",
  "services": [{ "success": true, "service": "amazonS3Standard" }] }
```

So the MCP is fine and the Gateway is fine for fast tools. The remaining variable is
call duration: `build_estimate` does create + add + export inside one tool call and is by
far the longest, and it is the only one that hangs.

**Fix applied, not yet re-verified:** the system prompt now directs the agent to use
`create_estimate → add_service → validate_estimate → export_estimate` and to prefer them
over `build_estimate`, explicitly overriding the MCP's own "prefer build_estimate"
advice and saying why. Each of those returns in about a second directly.

To re-verify (needs a redeploy, because the prompt is delivered by the Harness Custom
Resource):

```
cd infrastructure
AWS_REGION=ap-south-1 CDK_DEFAULT_REGION=ap-south-1 \
  npx cdk deploy IepStack-dev --require-approval never --output cdk.out.harness
node scripts/live-agentcore-e2e-smoke.mjs ap-south-1
```

If it still hangs, the next thing to establish is whether the Gateway imposes a
per-tool-call timeout, and whether `CreateGatewayTarget` exposes a knob for it. Until
then this is the one thing standing between the new path and a green Phase 29.

## Phase 30 — Architectural hard gates

- [ ] Test: no production runtime dependency on `service-adapters.ts`
- [ ] Test: no production runtime dependency on `compileWithCalculatorAdapter`
- [ ] Test: no production runtime dependency on `calculatorConfig`
- [ ] Test: no production runtime dependency on `calculatorKey`
- [ ] Test: no production runtime dependency on the old MCP proxy
- [ ] Test: no production runtime dependency on the old MCP sidecar client
- [ ] Test: no production runtime dependency on a custom Calculator InvokeModel loop
- [ ] Acceptance test with `calculator-agent`, `calculator-mcp-proxy`, legacy sidecar disabled still passes

## Phase 31 — Infrastructure as code

- [ ] AgentCore managed Claude execution resource provisioned in CDK/CloudFormation
- [ ] AgentCore Runtime for the Pricing MCP provisioned
- [ ] Runtime endpoint provisioned if required
- [ ] AgentCore Gateway provisioned
- [ ] Gateway Runtime MCP target provisioned
- [ ] IAM roles/policies provisioned
- [ ] Bedrock model permissions provisioned
- [ ] CloudWatch logging/tracing provisioned
- [ ] S3 provisioned
- [ ] MCP state DynamoDB TTL table provisioned
- [ ] No manual Console setup beyond genuine account-level prerequisites
- [ ] No silent dependency on manually-created ARNs

## Phase 32 — IAM

- [ ] Managed Claude execution role: selected model + Gateway/evidence tool access only
- [ ] Gateway role: only what is required to reach the MCP Runtime
- [ ] MCP Runtime role: MCP working-state table, logging, required network/service access only
- [ ] MIMO API role: start/read managed execution + own S3/DynamoDB state only
- [ ] No unnecessary `"*"` where specific resources are available

## Phase 33 — Legacy rollback

- [ ] Legacy architecture not deleted before parity is proven
- [ ] `legacy-invokemodel` mode retained and isolated
- [ ] `legacy-compiler` mode retained and isolated
- [ ] Production default after acceptance is `agentcore-runtime`
- [ ] Legacy and AgentCore workers cannot mutate the same calculation simultaneously

## Phase 34 — Tests

- [ ] calculator unit tests
- [ ] WorkbookEvidence tests
- [ ] chunking tests
- [ ] evidence accounting tests
- [ ] AgentCore infrastructure tests
- [ ] runtime MCP tests
- [ ] Gateway tests
- [ ] agent response schema tests
- [ ] large-workbook tests
- [ ] DynamoDB-size tests
- [ ] frontend tests/build
- [ ] TypeScript typecheck
- [ ] lint
- [ ] CDK synth
- [ ] Docker image build if applicable
- [ ] Failures introduced by this work fixed
- [ ] Results explicitly classified MOCKED / LOCAL / LIVE AWS
- [ ] No mocked URL described as a successful Calculator integration

## Phase 35 — Live deployment policy

- [ ] Shared production not deployed automatically
- [ ] Non-destructive smoke tests run where dev/test deployment is authorized
- [ ] If deployment is required and not authorized: everything prepared and the exact deploy command reported
- [ ] No LIVE AgentCore success claimed for resources never deployed and called

---

## Final audit

**The migration is NOT complete.** The architectural spine is built and proven live; the
MIMO request path is not yet cut over to it. Answers below are what is true right now, not
what is intended.

| # | Question | Expected | Actual |
|---|---|---|---|
| 1 | Production calculator uses a custom InvokeModel loop? | NO | **YES, still** — `calculator-routes.ts` still routes to the legacy agent Lambda. The replacement driver exists and typechecks but is not wired. |
| 2 | Production uses InvokeInlineAgent / Bedrock Agents Classic? | NO | **NO** — never was; the IAM grants for it are now removed and a gate asserts the template is free of it |
| 3 | Production invokes `calculator-mcp-proxy`? | NO | **YES, still** — reached by the legacy agent Lambda, which is still the routed path |
| 4 | Production invokes the legacy MCP sidecar Lambda? | NO | **YES, still** — via the proxy. It is no longer reachable through the Gateway. |
| 5 | AgentCore Gateway targets AgentCore Runtime MCP? | YES | **YES** — LIVE, `kind=mcpServer`, `READY`; the Lambda target is deleted |
| 6 | Real upstream Pricing Calculator MCP running on AgentCore Runtime? | YES | **YES** — LIVE, `sample-aws-pricing-calculator-mcp 1.3.0`, 9 tools via `tools/list` |
| 7 | AgentCore-managed execution owns Claude ↔ tool iteration? | YES | **YES** — LIVE, observed `tool_use → tool_result` with no MIMO code between |
| 8 | Every workbook cost-relevant input can reach Claude? | YES | Partly — the lossless builder, chunker and `get_workbook_evidence` exist and are tested; not yet written by the upload route nor exposed as a Gateway target |
| 9 | Large workbooks chunked rather than truncated? | YES | **YES** in the new module, proven by test on 4000 rows with exact set equality; the legacy file's caps still exist in the legacy path |
| 10 | A calculation can legitimately run >11 minutes without false failure? | YES | Not yet — the Harness allows 8-hour sessions (`maxLifetime: 28800`, measured), but `CALCULATION_STALE_AFTER_MS` in `calculator-routes.ts:512` is unchanged |
| 11 | No 15-minute long-running agent Lambda dependency? | YES | Not yet — designed out (Step Functions pump), not yet wired |
| 12 | DynamoDB bounded below 100 KB for new calculator records? | YES | Not yet — the driver only writes small fields, but `RESOURCE_BYTES_ON_ITEM = 120_000` in the route is unchanged |
| 13 | Calculator URL generated through MCP? | YES | **YES** — LIVE, twice: `…id=3a25374a11b4baea77709fc7ad13ec661fe7c8dc` and `…id=32c8e2f765a141b5ca461d1f643b98f9ac1d919b` |
| 14 | COMPLETED requires a real `calculator.aws` URL? | YES | **YES** in the driver's `parseAgentResult` — a COMPLETED claim without one is downgraded to FAILED |
| 15 | Cleaned Excel generated after Calculator success? | YES | Not started |
| 16 | Local Price List optional / diagnostic only? | YES | Not addressed — it is unreachable from the new path, but the legacy path is unchanged |
| 17 | MIMO free from Calculator-internal field ownership in the new path? | YES | **YES** — gated by test across the driver and the evidence format |
| 18 | Implementation avoids Bedrock Agents Classic completely? | YES | **YES** |
| 19 | Did an Agents Classic maintenance-mode error cause a fallback to custom Lambda InvokeModel orchestration? | NO | **NO** — the error was never even encountered; AgentCore Harness was available and is what got built |
| 20 | Does disabling the old agent/proxy/sidecar Lambdas leave the new AgentCore smoke test working? | YES | Effectively yes for the tools path — `live-agentcore-e2e-smoke.mjs` touches none of them — but Phase 29 is not green (BLOCKER 3), so this is not claimed |

---

## Root causes found (Phase 0 analysis)

1. **The "AgentCore" path was never AgentCore.** `calculator-agent/index.ts` runs
   its own `for` loop over `InvokeModelCommand` and calls the MCP proxy Lambda by
   ARN. The deployed Gateway and Runtime are decorative. Every symptom that looks
   like "AgentCore is broken" is actually a defect in MIMO's hand-rolled loop.
2. **Evidence truncation is the source of the missing-field and dash-filled
   symptoms.** `slice(0, 300)` twice plus `EVIDENCE_ROW_LIMIT = 200` means a large
   workbook reaches Claude as a partial workload. Claude then legitimately reports
   `NEEDS_INPUT` for fields whose evidence was discarded before it ever saw them.
3. **Duplicate questions come from MIMO owning Calculator field IDs.** The
   duplicated "Size of the payload, Size of the payload" and "Data Written, Data
   Written" originate in MIMO's own Calculator field tables
   (`calculator-definitions.ts`, `field-mapping.ts`), not from the MCP. MIMO asks
   using internal Calculator identifiers because MIMO, not the MCP, is deciding
   what is required.
4. **The 15-minute Lambda ceiling and the 11-minute staleness check are the same
   bug seen from two ends.** A 40-iteration Bedrock loop inside a 15-minute Lambda
   frequently exceeds both; `CALCULATION_STALE_AFTER_MS` then reports "the estimate
   worker stopped before finishing" using generic `updated_at`, with no idea
   whether the worker is alive.
5. **DynamoDB item-size failures are structural.** `RESOURCE_BYTES_ON_ITEM =
   120_000` plus inline `workbook`, `plan_v2` and result previews on a 400 KB item
   limit leaves no headroom.
6. **Naming actively misled.** `EXECUTION_MODE = 'agentcore-harness'` is a
   hard-coded literal in the InvokeModel Lambda that selects nothing and is only
   logged, so logs and tests "prove" AgentCore usage that never happened.

## Remaining blockers

### RESOLVED — BLOCKER 1 (AWS mutation permission) and BLOCKER 2 (deploy authorization)

Both were granted by the operator mid-session. `IepStack-dev` has since deployed
successfully to `ap-south-1` and Phases 4, 5, 6 and the Phase 7 primitive are proven
live. `aws iam put-role-policy` remains blocked by the local classifier, which is why
the Gateway's Runtime permission was expressed in CDK rather than hand-patched — the
better outcome anyway.

### BLOCKER 3 — long-running MCP tools hang through the AgentCore Gateway

See the Phase 29 section above for the full isolation table and the applied fix. This is
the only thing standing between the new path and a green end-to-end test.

### BLOCKER 4 — the MIMO request path is not yet cut over

Everything from the Gateway down is live. What is not done is the MIMO half: the upload
route does not write evidence, the Step Functions driver is not provisioned, the stale
check and the DynamoDB sizing in `calculator-routes.ts` are unchanged, and the UI and
Excel work has not started. This is remaining work, not a technical obstruction. Ordered:

1. Provision the evidence-tool Lambda as a **second** Gateway target named short (e.g.
   `mimoev`) so tool names stay inside the 64-char budget, and grant the Harness role
   nothing new (it reaches it through the Gateway it already has).
2. Provision the Step Functions state machine + `calculator-harness-driver` Lambda, with
   `externalModules: []` bundling (the AgentCore SDK is not in the Lambda runtime).
3. Write `WorkbookEvidence` / index / chunks in the POST route from the WorkbookIR it
   already builds, and stop writing `workbook`, `plan_v2` and the 120 KB resource sample
   onto new records.
4. Replace `CALCULATION_STALE_AFTER_MS` with Step Functions execution status +
   `agent_last_activity_at`.
5. Add `CALCULATOR_EXECUTION_MODE=agentcore-runtime` as the default and route POST to the
   state machine; keep `legacy-invokemodel` and `legacy-compiler` reachable.
6. Result UI states and failure UX (Phases 19, 20), then Excel (Phase 21).
7. Then the three workbook regressions (Phases 26, 27, 28).

### NOT a blocker — Bedrock Agents Classic maintenance mode

Never encountered, because nothing in the new design calls `CreateAgent` or
`InvokeInlineAgent`. Recorded here so it is not later mistaken for one:
AgentCore Harness is a separate service and is available (see Phase 0).
