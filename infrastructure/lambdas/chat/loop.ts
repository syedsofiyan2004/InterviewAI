import { ConverseStreamCommand, type ContentBlock, type Message } from '@aws-sdk/client-bedrock-runtime';

import { bedrockClient } from '../shared/aws';
import { ChatProposalSchema, type ChatProposal } from '../../schema/chat';
import { proposalKindFor, runReadTool, type ReadOnlyTool } from './tools';

/**
 * The multi-turn tool loop — what turns the chat from a one-shot answerer into something
 * that can look things up before it answers.
 *
 * What this replaces, and why it had to change. There was exactly one `ConverseStream` call
 * per request and no loop, so a tool call ended the turn: the model's arguments were parsed
 * into a proposal and the conversation stopped, and NO tool result was ever returned to the
 * model. That is fine for the one thing the chat could do — propose a change for the user to
 * apply — and useless for everything else. The context block is a bounded summary, so
 * "which of the 412 rows are still on-demand" was unanswerable, and the system prompt had to
 * carry the line "the tool call ends your turn, so text after it never arrives". With a loop,
 * a read-only look-up comes back as a `toolResult` and the model carries on talking.
 *
 * Three properties of this loop are load-bearing:
 *
 *  - **It is bounded twice**, by iterations and by wall clock. See the constants below.
 *  - **Text streams throughout**, not only on the last turn. The loop is only worth having
 *    if the user watches it work; a loop that buffered until the end would take the one
 *    thing a Function URL in RESPONSE_STREAM mode was chosen for and throw it away.
 *  - **A proposal still ends the turn.** The chat never applies anything: the change reaches
 *    the estimate only when the user presses Apply, which calls the revise route. So there
 *    is nothing to feed back to the model after a proposal, and continuing past one would
 *    let a single turn stack up several competing diffs behind one Apply button.
 */

/**
 * How many model turns one user message may cost.
 *
 * Six, because of what the real requests need. A scenario matrix takes a look at the
 * inventory, usually a summary across the rows that were not listed, sometimes the priced
 * lines to sanity-check a figure, and then the write-up — four turns with two spare for a
 * retry or a filter that came back empty. Below four the model runs out of turns mid-
 * investigation and has to answer from a partial picture, which is worse than not looking.
 *
 * The cap is a cost and patience bound, not a correctness one. Six turns at
 * MAX_OUTPUT_TOKENS is the worst case, and the whole context block is re-sent on every one
 * of them, so this number multiplies the price of a turn directly.
 */
export const MAX_MODEL_TURNS = 6;

/**
 * How long the loop may keep starting new turns.
 *
 * 150 seconds against the Lambda's 5-minute timeout (see ChatFunction in
 * infrastructure-stack.ts). Checked before a turn STARTS, never mid-turn, because a stream
 * cannot be abandoned halfway without leaving the user a half-sentence — so the real
 * worst case is this budget plus one full turn, and the headroom to 300 seconds is sized
 * for exactly that plus the two DynamoDB writes that persist the turn afterwards.
 *
 * The user-facing half of the number matters as much as the arithmetic: someone is watching
 * this stream. Two and a half minutes of visible progress is a long wait but a legible one;
 * four minutes ending in a Lambda timeout is a broken feature, because a timeout kills the
 * response stream and the answer is lost along with the turn that would have persisted it.
 */
export const LOOP_WALL_CLOCK_MS = 150_000;

/**
 * Output tokens per turn.
 *
 * Raised from 2,000. Not because answers should be longer in general — most should still be
 * two or three sentences — but because a scenario matrix is one legitimate answer that
 * cannot be, and because the proposal that carries it is counted in this budget too. Thirty
 * `EstimateScenarioRequest` entries plus a 2,000-character instruction is roughly 2,000
 * tokens of JSON on its own, so the old cap did not merely shorten such a proposal: it cut
 * the tool call off mid-JSON, `toProposal` failed to parse it, and the user got "I could not
 * put that change together properly" with no way to tell that the model had got it right.
 *
 * Still a hard ceiling rather than a generous one, and multiplied by MAX_MODEL_TURNS for the
 * worst case of a single request.
 */
export const MAX_OUTPUT_TOKENS = 4000;

/**
 * Applied only when the resolved model accepts it — see the guard in `converse`.
 *
 * Low, not zero: the same question twice should read the same way, but not identically.
 */
const TEMPERATURE = 0.2;

/**
 * How many times a proposal that fails validation may be handed back to be fixed.
 *
 * One. The loop makes a retry possible for the first time — the validation errors can be
 * returned as a tool result — and a single retry converts the common failure, a missing
 * required field, into a working proposal. More than one is not worth the turns: a model
 * that got it wrong twice is not converging, and the user is better served by being asked
 * which value they meant than by watching the budget drain.
 */
const PROPOSAL_RETRIES = 1;

/** The message shown when a proposal could not be built. Unchanged wording, deliberately. */
const PROPOSAL_FAILED_MESSAGE =
  'I could not put that change together properly. Could you say which item and which value you want changed?';

export interface ToolLoopOptions {
  modelId: string;
  /** The system prompt, including the context block. Re-sent on every iteration. */
  system: string;
  /** The conversation so far, oldest first, ending with the user's new message. */
  messages: Message[];
  /** Every tool spec the model may call, proposal tools and read-only tools together. */
  toolSpecs: unknown[];
  /** Read-only tools by name, each already bound to the authorised record. */
  readTools: Map<string, ReadOnlyTool>;
  /** Writes a chunk of assistant text to the browser. Called as the model produces it. */
  emit(text: string): void;
  /** Publishes a validated proposal to the browser. Called at most once. */
  onProposal(proposal: ChatProposal): void;
  /** Injected so the wall-clock bound is testable without waiting for it. */
  now?: () => number;
}

export interface ToolLoopOutcome {
  /** Everything the user saw, for persistence. Includes any bound notice. */
  answer: string;
  proposal: ChatProposal | null;
  /** Model turns actually spent. 1 means it answered without a tool call. */
  turns: number;
  /** Read-only tool calls executed, for the log line. */
  toolCalls: number;
  /** Which bound ended the loop, when one did. */
  stoppedBy: 'model' | 'proposal' | 'iterations' | 'time' | 'output_length' | 'proposal_failed';
}

/** One tool call, reassembled from the stream's partial-JSON deltas. */
interface ToolCall {
  toolUseId: string;
  name: string;
  /** Accumulated argument JSON, still a string. */
  input: string;
}

interface TurnResult {
  text: string;
  toolCalls: ToolCall[];
  /** The assistant message exactly as the model produced it, for the next request. */
  content: ContentBlock[];
  stopReason: string;
}

/**
 * Turn accumulated tool input into a validated proposal, or the reasons it failed.
 *
 * A result rather than a bare null, because the loop can now do something useful with the
 * reasons: they go back to the model as a tool result and it gets one attempt to fix them.
 * Previously a malformed proposal could only be reported to the user.
 */
export function toProposal(
  toolName: string,
  rawInput: string,
): { ok: true; proposal: ChatProposal } | { ok: false; why: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawInput || '{}');
  } catch {
    console.warn('[chat] tool input was not valid JSON');
    return { ok: false, why: 'the arguments were not valid JSON, and may have been cut off part-way' };
  }

  const kind = proposalKindFor(toolName);
  if (!kind) {
    console.warn(`[chat] unknown tool ${toolName}`);
    return { ok: false, why: `there is no proposal tool called ${toolName}` };
  }

  const result = ChatProposalSchema.safeParse({ ...(parsed as object), kind });
  if (!result.success) {
    const issues = result.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    console.warn('[chat] tool input failed validation:', issues);
    return { ok: false, why: issues };
  }
  return { ok: true, proposal: result.data };
}

/**
 * One model turn, streamed.
 *
 * Content blocks are keyed by `contentBlockIndex` rather than appended in arrival order.
 * The order is in practice sequential, but a tool call's arguments arrive as partial JSON
 * across many deltas and the index is the only thing that says which call a fragment belongs
 * to — assuming "the most recent one" is what breaks the moment a model emits two tool
 * calls in one turn, which is exactly what a scenario matrix plus a progress check looks
 * like.
 */
async function converse(options: ToolLoopOptions, messages: Message[], onText: (text: string) => void): Promise<TurnResult> {
  const response = await bedrockClient.send(new ConverseStreamCommand({
    modelId: options.modelId,
    system: [{ text: options.system }],
    messages,
    // Sonnet 5 rejects an explicit temperature — it answers with a 400
    // ValidationException, "`temperature` is deprecated for this model", which failed every
    // turn before a single token reached the browser. Guarded on the resolved id rather than
    // dropped outright, as every other builder in this repo does, so repointing
    // BEDROCK_SONNET_5_PROFILE_ARN at an older model restores the setting with it.
    inferenceConfig: {
      maxTokens: MAX_OUTPUT_TOKENS,
      ...(options.modelId.includes('claude-sonnet-5') ? {} : { temperature: TEMPERATURE }),
    },
    ...(options.toolSpecs.length ? { toolConfig: { tools: options.toolSpecs as any } } : {}),
  }));

  const blocks = new Map<number, { text: string; tool?: ToolCall }>();
  let stopReason = 'end_turn';

  for await (const chunk of response.stream || []) {
    // The stream carries its errors as members rather than rejecting the promise, so an
    // unhandled one would look like a turn that simply stopped talking. Thrown, so the
    // handler reports it in-band as a failed turn.
    const streamError = chunk.internalServerException
      || chunk.modelStreamErrorException
      || chunk.throttlingException
      || chunk.validationException
      || chunk.serviceUnavailableException;
    if (streamError) {
      throw new Error(`Bedrock stream error: ${streamError.message || 'no detail'}`);
    }

    if (chunk.messageStop?.stopReason) stopReason = chunk.messageStop.stopReason;

    // Only a start or a delta owns a content block. Resolving an index for every chunk —
    // messageStart, contentBlockStop, the metadata frame — would conjure an empty block 0 on
    // any stream whose real content begins elsewhere.
    if (!chunk.contentBlockStart && !chunk.contentBlockDelta) continue;
    const index = chunk.contentBlockStart?.contentBlockIndex ?? chunk.contentBlockDelta?.contentBlockIndex ?? 0;
    const block = blocks.get(index) || { text: '' };
    if (!blocks.has(index)) blocks.set(index, block);

    const startedTool = chunk.contentBlockStart?.start?.toolUse;
    if (startedTool?.name) {
      block.tool = { toolUseId: startedTool.toolUseId || '', name: startedTool.name, input: '' };
      continue;
    }

    const delta = chunk.contentBlockDelta?.delta;
    if (delta?.text) {
      block.text += delta.text;
      onText(delta.text);
      continue;
    }
    // Tool arguments arrive as partial JSON across several deltas, so they are concatenated
    // and parsed once the block is complete rather than per chunk.
    if (delta?.toolUse?.input && block.tool) {
      block.tool.input += delta.toolUse.input;
    }
  }

  const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block);
  const content: ContentBlock[] = [];
  const toolCalls: ToolCall[] = [];
  let text = '';
  for (const block of ordered) {
    if (block.tool) {
      toolCalls.push(block.tool);
      let input: unknown = {};
      try {
        input = JSON.parse(block.tool.input || '{}');
      } catch {
        // Left as an empty object: the call is re-sent to the model verbatim in its own
        // message history, and Bedrock rejects a toolUse block whose input is not an object.
        // The tool's own runner reports the unparseable arguments in the result.
        input = {};
      }
      content.push({ toolUse: { toolUseId: block.tool.toolUseId, name: block.tool.name, input: input as any } });
      continue;
    }
    if (block.text) {
      text += block.text;
      content.push({ text: block.text });
    }
  }

  return { text, toolCalls, content, stopReason };
}

/**
 * Run the conversation until the model stops calling tools, or a bound stops it.
 *
 * The bounds are checked between turns, and hitting one is always SAID. A loop that ran out
 * of turns and fell silent is indistinguishable from a model that finished, so the user
 * would read a half-finished investigation as a complete answer — which for a cost estimate
 * means quoting a figure the model was still in the middle of checking.
 */
export async function runToolLoop(options: ToolLoopOptions): Promise<ToolLoopOutcome> {
  const now = options.now || Date.now;
  const startedAt = now();
  const messages: Message[] = [...options.messages];

  let answer = '';
  let proposal: ChatProposal | null = null;
  let turns = 0;
  let toolCalls = 0;
  let retriesLeft = PROPOSAL_RETRIES;
  let stoppedBy: ToolLoopOutcome['stoppedBy'] = 'model';

  /** Streams text and records it, so what is persisted is exactly what was shown. */
  const say = (text: string) => {
    answer += text;
    options.emit(text);
  };

  for (;;) {
    turns += 1;

    // A continuation that runs straight on from the previous turn's last word reads as one
    // mangled sentence, because the model has no way to know its own text was interrupted
    // by a tool result. A paragraph break, and only when there is something to break from.
    let firstTextOfTurn = turns > 1 && answer.trim().length > 0;
    const turn = await converse(options, messages, (text) => {
      if (firstTextOfTurn) {
        firstTextOfTurn = false;
        say('\n\n');
      }
      say(text);
    });

    if (turn.stopReason !== 'tool_use') {
      if (turn.stopReason === 'max_tokens') {
        // Truncated mid-sentence by the token cap. Said out loud for the same reason the
        // other bounds are: an answer that stops mid-figure looks finished.
        stoppedBy = 'output_length';
        say('\n\nThat answer ran into the length limit and is cut off. Ask for a narrower slice of it and I will '
          + 'finish the part you need.');
      }
      break;
    }

    // Results for EVERY tool call in the turn, in order. Bedrock rejects a continuation that
    // leaves one unanswered, so a proposal call is answered too even though it ends the loop.
    const results: ContentBlock[] = [];
    let proposalAccepted = false;
    let proposalGaveUp = false;

    for (const call of turn.toolCalls) {
      const readTool = options.readTools.get(call.name);
      if (readTool) {
        toolCalls += 1;
        results.push({ toolResult: { toolUseId: call.toolUseId, content: [{ text: runReadTool(readTool, call.input) }] } });
        continue;
      }

      if (!proposalKindFor(call.name)) {
        // A name in neither registry is the model inventing a tool. Reported as its own
        // outcome rather than as a broken proposal, because the recovery is different and
        // because telling the user "I could not put that change together" when they never
        // asked for a change was the old dispatch's most confusing failure.
        console.warn(`[chat] model called an unknown tool ${call.name}`);
        results.push({
          toolResult: {
            toolUseId: call.toolUseId,
            content: [{ text: `There is no tool called ${call.name}. Answer from the context and the tools you were given.` }],
            status: 'error',
          },
        });
        continue;
      }

      if (proposal) {
        results.push({
          toolResult: {
            toolUseId: call.toolUseId,
            content: [{ text: 'A proposal has already been shown to the user for this turn. Do not propose a second one.' }],
            status: 'error',
          },
        });
        continue;
      }

      const built = toProposal(call.name, call.input);
      if (built.ok) {
        proposal = built.proposal;
        options.onProposal(built.proposal);
        proposalAccepted = true;
        results.push({
          toolResult: { toolUseId: call.toolUseId, content: [{ text: 'Shown to the user with Apply and Discard.' }] },
        });
        continue;
      }
      if (retriesLeft > 0) {
        retriesLeft -= 1;
        results.push({
          toolResult: {
            toolUseId: call.toolUseId,
            content: [{ text: `That proposal was rejected before the user saw it — ${built.why}. Fix those fields and call the tool once more.` }],
            status: 'error',
          },
        });
        continue;
      }
      proposalGaveUp = true;
    }

    if (proposalAccepted) {
      stoppedBy = 'proposal';
      // The model may have proposed with no preamble, in which case there is no prose above
      // the diff. The proposal's own summary stands in rather than showing a change with no
      // explanation of why.
      if (!answer.trim() && proposal) say(proposal.summary);
      break;
    }

    if (proposalGaveUp) {
      stoppedBy = 'proposal_failed';
      say(answer.trim() ? `\n\n${PROPOSAL_FAILED_MESSAGE}` : PROPOSAL_FAILED_MESSAGE);
      break;
    }

    messages.push({ role: 'assistant', content: turn.content });
    messages.push({ role: 'user', content: results });

    if (turns >= MAX_MODEL_TURNS) {
      stoppedBy = 'iterations';
      say(`\n\nI stopped after ${MAX_MODEL_TURNS} rounds of looking things up, so this may be incomplete. `
        + 'Ask me about one part of it and I will go further into that.');
      break;
    }
    if (now() - startedAt > LOOP_WALL_CLOCK_MS) {
      stoppedBy = 'time';
      say('\n\nI ran out of time working through that, so this may be incomplete. Ask about a narrower part of it '
        + 'and I will get further.');
      break;
    }
  }

  return { answer, proposal, turns, toolCalls, stoppedBy };
}
