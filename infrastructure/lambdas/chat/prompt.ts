import type { ChatApp } from '../../schema/chat';
import { PricingModelRequestSchema } from '../../schema/chat';

/**
 * System prompt and tool definitions for the context chat.
 *
 * Two rules here are doing real work and should not be softened:
 *
 *  - **Never invent a price.** The estimate's rates come from the AWS Price List Query
 *    API through the pricing pipeline. The model may quote a figure that is in its
 *    context and may do arithmetic on those figures, but it must not produce a rate of
 *    its own — a plausible invented rate in a client conversation is worse than "I do
 *    not have that number".
 *  - **Explain before proposing.** A proposal still ends the turn — the chat never applies
 *    anything, so there is nothing to feed back after one — and without this instruction the
 *    model calls the tool with no preamble and the drawer shows a diff with no explanation of
 *    why.
 *
 * What changed when the tool loop arrived (see loop.ts), because three rules here were
 * written for a single-shot handler and became false or harmful:
 *
 *  - "The tool call ends your turn, so text after it never arrives" was true of every tool
 *    and is now true only of the two PROPOSAL tools. Left in, it stopped the model explaining
 *    itself after a read-only look-up, which is the one place an explanation is most wanted.
 *  - "Do not call the tool to answer a question" forbade exactly the exploratory work the
 *    loop exists for. The intent it protected — do not push a change proposal at somebody who
 *    only asked a question — is kept, and narrowed to the proposal tools.
 *  - The brevity and no-tables rules are relaxed for the calculator only. Eighteen priced
 *    scenarios are a legitimate answer and cannot be given in two sentences. The relaxation
 *    is about LENGTH and line structure, not markup: the transcript is still rendered as
 *    plain text, so markdown pipes and asterisks still come out literally.
 */

const SHARED_RULES = `
You are the assistant built into this workspace. You are talking to the person who owns
the artifact described below — a colleague, not a customer.

How to answer:
- Answer from the CONTEXT block only. It is the whole truth you have about this artifact.
- If something is not in the context, say plainly that you cannot see it. Never fill a
  gap with a plausible guess, and never invent a number, a name, a date or a price.
- Be brief. Two or three sentences answers most questions. Use a short list when the
  answer really is a list.
- Plain prose. No markdown headings, no bold, no tables — the transcript is rendered as
  text, so those come out as literal asterisks and hashes.
- Dates are dd-MM-yyyy.
- Money keeps the currency the artifact uses.
`.trim();

/**
 * The pricing-model names, taken from the schema rather than retyped.
 *
 * Retyping them here would let the prompt and `PricingModelRequestSchema` drift, and the
 * failure mode of that drift is silent: the model emits a spelling the prompt taught it, zod
 * rejects the whole proposal, and the user is told the change could not be put together.
 */
const PRICING_MODELS = PricingModelRequestSchema.options.join(', ');

const CALCULATOR_RULES = `
This artifact is an AWS cost estimate.

Where its numbers come from, because it changes what you may say:
- Every rate was fetched from the AWS Price List Query API by the pricing pipeline. The
  "workings" line on each item is the arithmetic that produced it.
- You may add, subtract and multiply the figures you can see, and you may explain them.
- You may NOT produce a rate that is not in your context. If asked what an instance type
  would cost and you cannot see that rate, say so and offer to propose the change so the
  estimate can be re-priced properly. This holds however reasonable your own figure feels:
  a plausible invented rate in a client conversation is worse than "I do not have that".
- The same rule covers stages and times. If asked whether the run has finished or how much
  longer it will take, use the sentence in the "Where this run is" section or call
  pipeline_progress, and use its wording. Never estimate a duration yourself.

Looking things up, which you should do freely:
- For this artifact the CONTEXT block is not the whole truth you have: the read-only tools
  below are part of it, and they read this same estimate. Everything they return is as
  trustworthy as the block itself.
- The context block is a summary under a size limit, so long lists in it are cut off and say
  so. When a question needs something past a cut-off, call the read-only tool for it:
  list_inventory_rows, summarise_inventory, list_priced_line_items, list_server_allocation,
  read_workbook_detail, pipeline_progress.
- These change nothing, cost the user nothing and do not end your turn. Prefer looking
  something up over answering "I cannot see that". Keep explaining after the result comes
  back — the user is reading your answer as you write it.
- Use summarise_inventory rather than paging through rows when the question is "how many" or
  "how much" across the whole inventory.

Proposing a change:
- For semantic calculator changes, include typed requirement_patches. The instruction field
  is audit text only and is never re-parsed when the user presses Apply.
- Use semantic patch targets such as serviceFamily, environment, scenarioIds or resourceIds.
  Row numbers are only for legacy resource_edits.
- Supported semantic patch fields include fargate.taskFrequency, fargate.taskDuration,
  database.engine, database.multiAz, lambda.memoryMb, lambda.durationMs,
  sagemaker.workloadType, sagemaker.instanceType, nat.mode, nat.azCount, bedrock.model,
  bedrock.inputTokens, bedrock.outputTokens, pricing.model and resource.exclude.
- When the user asks for a change — a different instance type, a different purchase model,
  more or fewer machines, a different region, or a set of scenarios to price — first say in
  one or two sentences what you are about to propose and what you expect it to do to the
  cost, THEN call propose_estimate_change. Say it first: a proposal ends your turn.
- propose_estimate_change changes nothing by itself. It shows the user a proposal with Apply
  and Discard. Applying it creates a NEW revision and re-prices it through the normal
  pipeline; the estimate they already have is left untouched, so a PDF already sent to a
  client cannot change under them.
- Do not propose a change to answer a question. "What would happen if we moved to
  3-year reserved?" is a question: answer it from what you can see and from the read-only
  tools, and offer to propose the change. Propose only when the user has actually asked for
  one — including when what they asked for is a matrix of scenarios to be priced, which IS a
  request and should be proposed as one call carrying every scenario.

Scenarios, and the vocabulary you must use for them:
- A scenario is one priced estimate with its own shareable link. A request like "five fiscal
  years on three purchase models, then the lower environments on the same terms" is a set of
  scenarios, and it goes into ONE propose_estimate_change call with one entry per scenario.
- Every scenario's pricing_model must be exactly one of: ${PRICING_MODELS}. Do not invent a
  spelling, do not write "1yr RI" or "three year reserved", and do not leave it out.
- The upfront variants are different prices, not different wording. If the user says "3-year
  reserved" without saying which upfront, ask or state which one you used.
- scope is the heading a reader sees, e.g. "FY26-27" or "Lower environments". environments
  selects which parsed rows get priced; leave it empty to price every row, which is the
  normal case.
- Some services have no reserved-instance purchase model at all — ECS Fargate is the standing
  example, and Savings Plans are the only commitment it accepts. In a scenario that is
  otherwise reserved, those services stay On-Demand. STATE that mix plainly in the summary
  and in the note: "the EC2 fleet on 3-year all-upfront reserved, Fargate on-demand because
  it has no RI". Never let a scenario labelled reserved imply that every line in it is.
- Only add scenario totals together when adding them means something. Scenarios that are one
  workload costed two ways are alternatives; scenarios that are consecutive years are spent
  in sequence; scenarios that are separate environments run at the same time and do add up.
  The context block says which kind it is holding.

Length and layout, for this artifact only — these supersede the brevity and no-tables rules
above, because a comparison of eighteen priced scenarios cannot be given in two sentences:
- Short questions still get short answers. Two or three sentences remains the default.
- A comparison of several scenarios may be as long as it needs to be, laid out one scenario
  per line with its label, its pricing model, its monthly total and its link.
- Still no markdown. The transcript is rendered as plain text, so pipe-and-dash tables,
  headings, bold and asterisks come out as literal characters. Use plain lines and spaces.
`.trim();

const MOM_RULES = `
This artifact is a set of minutes from a meeting.

Editing them:
- The reason this feature exists is that minutes usually need trimming before they go to
  a client. When the user asks for a change — cut a section, drop an internal risk,
  shorten the summary, fix a name, reword an action — first say in one sentence what you
  are changing, THEN call propose_mom_edit. The tool call ends your turn.
- Send only the fields that change. Send each one WHOLE: to remove one risk, send the
  complete risks array without it, not a description of the removal.
- The tool does not change anything. The user sees the proposal and applies or discards
  it. Applying rewrites the stored minutes and regenerates both the PDF and the Word file.
- Never invent content. You may cut, merge, reword and reorder what is there. You may not
  add a decision, an attendee, a date or an action that the meeting did not produce.
`.trim();

const EVALUATION_RULES = `
This artifact is a candidate evaluation.

You can explain it, and you cannot change it. There is no tool here and that is
deliberate: a score is a judgement recorded against a rubric at a point in time, and a
conversation that could rewrite it would make the record worthless as evidence.

So: explain how a score was reached, which evidence supports it, what was not covered,
and what a follow-up round should probe. If the user wants a score changed, tell them it
has to be done through a re-run of the evaluation, not here.
`.trim();

export function systemPrompt(app: ChatApp, entityContext: string): string {
  const appRules = app === 'calculator'
    ? CALCULATOR_RULES
    : app === 'mom'
      ? MOM_RULES
      : EVALUATION_RULES;

  return `${SHARED_RULES}\n\n${appRules}\n\n--- CONTEXT ---\n${entityContext}\n--- END CONTEXT ---`;
}

/**
 * Tool specs, in Bedrock Converse shape.
 *
 * The input schemas are hand-written rather than generated from the zod schemas in
 * schema/chat.ts: those carry preprocessors and defaults that have no JSON Schema
 * equivalent, and the model needs prose descriptions that a validator has no use for.
 * The zod schemas still validate whatever comes back, so the two cannot drift into
 * accepting something the apply route would reject.
 */
export const ESTIMATE_CHANGE_TOOL = {
  toolSpec: {
    name: 'propose_estimate_change',
    description:
      'Propose a change to this cost estimate. Shows the user a proposal they can apply or discard. '
      + 'Applying creates a new revision and re-prices it from live AWS rates. Nothing changes until they apply.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'One or two sentences the user will read above the Apply button. What changes, and why.',
          },
          instruction: {
            type: 'string',
            description:
              'Audit text describing the user request. The pricing pipeline does not execute from this prose, so '
              + 'semantic calculator changes must also be represented in requirement_patches.',
          },
          requirement_patches: {
            type: 'array',
            description:
              'Typed semantic requirement changes that become authoritative calculator state. Use these for all '
              + 'service requirements, purchase models, durations, frequencies, engines, profiles and exclusions.',
            items: {
              type: 'object',
              properties: {
                target: {
                  type: 'object',
                  description:
                    'Semantic target selector. Prefer resourceIds when known; otherwise use serviceFamily, '
                    + 'scenarioIds and/or environment. Do not use row numbers for semantic requirements.',
                  properties: {
                    resourceIds: { type: 'array', items: { type: 'string' } },
                    serviceFamily: { type: 'string' },
                    scenarioIds: { type: 'array', items: { type: 'string' } },
                    environment: { type: 'string' },
                  },
                },
                field: {
                  type: 'string',
                  description:
                    'Semantic field, e.g. fargate.taskFrequency, fargate.taskDuration, database.engine, '
                    + 'database.multiAz, lambda.memoryMb, lambda.durationMs, sagemaker.workloadType, '
                    + 'sagemaker.instanceType, nat.mode, nat.azCount, bedrock.model, bedrock.inputTokens, '
                    + 'bedrock.outputTokens, pricing.model or resource.exclude.',
                },
                operation: { type: 'string', enum: ['set', 'unset', 'exclude', 'include'] },
                value: {
                  description:
                    'The typed value. For duration use an object such as {"value":730,"unit":"hours"}. '
                    + 'For composite fields send one patch per field, not comma-separated text.',
                },
                source: { type: 'string', enum: ['user', 'workbook', 'recommended'] },
                reason: { type: 'string' },
                sourceInstruction: { type: 'string', description: 'The original user sentence this patch came from.' },
              },
              required: ['target', 'field', 'operation', 'source'],
            },
          },
          resource_edits: {
            type: 'array',
            description:
              'Optional direct edits to inventory rows, when the change is a straightforward field change. '
              + 'Use the row index shown in the context.',
            items: {
              type: 'object',
              properties: {
                row: { type: 'number', description: 'Row index from the inventory listing in the context.' },
                field: {
                  type: 'string',
                  enum: ['size', 'quantity', 'os', 'purchase_model', 'region', 'vcpu', 'ram_gb', 'disk_gb', 'hoursPerMonth', 'notes'],
                },
                value: { type: 'string', description: 'The new value, as text.' },
                reason: { type: 'string', description: 'Why this row changes.' },
              },
              required: ['row', 'field', 'value'],
            },
          },
          /**
           * The matrix half of the tool.
           *
           * Enumerated here rather than left to `instruction` prose because each entry becomes
           * its own priced run and its own link, and "price this five ways" written as a
           * sentence gave the pipeline nothing to iterate over. The pricing_model enum is
           * generated from PricingModelRequestSchema so the spec and the validator cannot
           * disagree about a spelling.
           */
          scenarios: {
            type: 'array',
            description:
              'One entry per estimate to be priced, each becoming its own line and its own shareable link. Use this '
              + 'when the user asked for a comparison or a matrix — fiscal years, purchase models, environment sets. '
              + 'Leave it out for a single change to this estimate.',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'What this scenario is called in the report, e.g. "FY26-27 3-year all-upfront".' },
                pricing_model: {
                  type: 'string',
                  enum: [...PricingModelRequestSchema.options],
                  description: 'Exactly one of these names. A service with no reserved option stays on-demand within the scenario; say so in the note.',
                },
                scope: { type: 'string', description: 'The grouping heading a reader sees, e.g. a fiscal year or "Lower environments".' },
                environments: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Which environments to price. Omit or leave empty to price every row, which is the usual case.',
                },
                note: { type: 'string', description: 'Anything a reader would otherwise have to infer — notably which services could not be committed and stayed on-demand.' },
              },
              required: ['label', 'pricing_model'],
            },
          },
          deliverables: {
            type: 'array',
            description:
              'Which documents to produce. A matrix of links belongs in docx; the workbook (xlsx) exists to be '
              + 'pivoted rather than read. Omit to leave the existing outputs alone.',
            items: { type: 'string', enum: ['pdf', 'xlsx', 'docx'] },
          },
        },
        required: ['summary', 'instruction'],
      },
    },
  },
} as const;

export const MOM_EDIT_TOOL = {
  toolSpec: {
    name: 'propose_mom_edit',
    description:
      'Propose an edit to these minutes. Shows the user a proposal they can apply or discard. '
      + 'Applying rewrites the stored minutes and regenerates the PDF and Word documents. Nothing changes until they apply.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'One or two sentences the user will read above the Apply button. What changes, and why.',
          },
          patch: {
            type: 'object',
            description:
              'Only the top-level fields that change, each one complete. Arrays replace the stored array wholesale, '
              + 'so send every element you want to keep. Available fields: title, date, overall_summary, attendees, '
              + 'agenda_items, discussion_points, risks, next_steps, next_meeting, previous_actions, distribution, '
              + 'facilitator, scribe, workstream, duration, platform, report_type, reference_no, issued_date.',
            properties: {
              title: { type: 'string' },
              date: { type: 'string' },
              overall_summary: { type: 'string' },
              attendees: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    role: { type: 'string' },
                    organisation: { type: 'string' },
                  },
                  required: ['name'],
                },
              },
              agenda_items: { type: 'array', items: { type: 'string' } },
              discussion_points: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    topic: { type: 'string' },
                    raised_by: { type: 'string' },
                    summary: { type: 'string' },
                    decisions: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          decision: { type: 'string' },
                          rationale: { type: 'string' },
                          decided_by: { type: 'string' },
                        },
                        required: ['decision'],
                      },
                    },
                    action_items: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          owner: { type: 'string' },
                          task: { type: 'string' },
                          due_date: { type: 'string' },
                          priority: { type: 'string', enum: ['High', 'Medium', 'Low'] },
                        },
                        required: ['owner', 'task', 'due_date'],
                      },
                    },
                  },
                  required: ['topic', 'summary'],
                },
              },
              risks: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    description: { type: 'string' },
                    likelihood: { type: 'string', enum: ['H', 'M', 'L'] },
                    impact: { type: 'string', enum: ['H', 'M', 'L'] },
                    owner: { type: 'string' },
                    mitigation: { type: 'string' },
                    category: { type: 'string' },
                  },
                  required: ['description'],
                },
              },
              next_steps: { type: 'array', items: { type: 'string' } },
              next_meeting: {
                type: 'object',
                properties: {
                  date: { type: 'string' },
                  purpose: { type: 'string' },
                  proposed_agenda: { type: 'string' },
                  prep_required: { type: 'string' },
                },
              },
              previous_actions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    ref: { type: 'string' },
                    action: { type: 'string' },
                    owner: { type: 'string' },
                    status: { type: 'string' },
                  },
                  required: ['action'],
                },
              },
              distribution: { type: 'string' },
              facilitator: { type: 'string' },
              scribe: { type: 'string' },
              workstream: { type: 'string' },
              duration: { type: 'string' },
              platform: { type: 'string' },
              report_type: { type: 'string' },
              reference_no: { type: 'string' },
              issued_date: { type: 'string' },
            },
          },
        },
        required: ['summary', 'patch'],
      },
    },
  },
} as const;

/**
 * The PROPOSAL tools for an app. Read-only tools do not come from here.
 *
 * They cannot: a read-only tool is bound to the loaded record, not to an app name, and that
 * binding is what stops an argument reaching another user's estimate. They arrive on the
 * loaded `EntityContext` instead, and the handler concatenates the two lists.
 *
 * Evaluations get neither kind — see EVALUATION_RULES.
 */
export function toolsFor(app: ChatApp): unknown[] {
  if (app === 'calculator') return [ESTIMATE_CHANGE_TOOL];
  if (app === 'mom') return [MOM_EDIT_TOOL];
  return [];
}
