import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { Message } from '@aws-sdk/client-bedrock-runtime';

import {
  ChatTurnRequestSchema,
  chatThreadId,
  type ChatProposal,
  type ChatStreamEvent,
} from '../../schema/chat';
import { verifyCaller } from './auth';
import { loadEntityContext } from './context';
import { runToolLoop } from './loop';
import { systemPrompt, toolsFor } from './prompt';
import { HISTORY_TURNS, loadRecentTurns, nextSeq, saveTurn } from './store';
import type { ReadOnlyTool } from './tools';
import { calculatorChatTier, calculatorModelId } from '../calculator-orchestrator/model-router';

/**
 * The context chat, as a streaming Lambda Function URL.
 *
 * Why a Function URL and not API Gateway: API Gateway buffers the entire response before
 * returning it, so a 20-second answer arrives 20 seconds late as one block. A Function
 * URL in RESPONSE_STREAM mode writes bytes to the browser as the model produces them,
 * which is the difference between a chat that feels instant and one that feels broken.
 * It costs the gateway's Cognito authorizer, so this handler verifies the token itself —
 * see auth.ts, which is the only gate on this endpoint.
 *
 * The wire format is newline-delimited JSON, one event per line. See ChatStreamEvent.
 *
 * This file is the transport and the gate. Everything about how the model is driven —
 * the bounded multi-turn tool loop, returning tool results, validating a proposal — lives in
 * loop.ts, so the parts that decide a status code stay separable from the parts that decide
 * what the model is told. That split matters here more than it usually would: a response
 * stream's status is fixed by its first byte, so every refusal has to be decided before the
 * loop is entered, and mixing the two made it easy to add a check in the wrong place.
 */

/**
 * The `awslambda` global and `HttpResponseStream` come from @types/aws-lambda, which
 * declares them ambiently.
 *
 * Note the `import type` above and the absence of a value import: `aws-lambda` is a
 * types-only package with no runtime module behind it, so a bare `import 'aws-lambda'`
 * type-checks fine and then fails the esbuild bundle with "Could not resolve". The type
 * import is erased at compile time and still pulls in the ambient declaration.
 */

const MODEL_ID = process.env.BEDROCK_SONNET_5_PROFILE_ARN || 'global.anthropic.claude-sonnet-5';

type StoredTurn = { role: 'user' | 'assistant'; content: string };

function ndjson(stream: awslambda.HttpResponseStream, event: ChatStreamEvent): void {
  stream.write(`${JSON.stringify(event)}\n`);
}

/**
 * Open the response with a status and headers.
 *
 * Called exactly once per request and before any body byte: the status of a streamed
 * response is fixed by the first chunk, so an error discovered after the first delta can
 * only ever be reported as an `error` line inside a 200.
 */
function open(stream: awslambda.HttpResponseStream, statusCode: number): awslambda.HttpResponseStream {
  return awslambda.HttpResponseStream.from(stream, {
    statusCode,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      // The stream is line-delimited and read incrementally; a sniffing proxy that
      // decides it is HTML and buffers it would defeat the whole transport.
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function fail(stream: awslambda.HttpResponseStream, statusCode: number, message: string): void {
  const out = open(stream, statusCode);
  ndjson(out, { type: 'error', message });
  out.end();
}

/** Parses the body whether the Function URL delivered it as text or base64. */
function readBody(event: APIGatewayProxyEventV2): unknown {
  if (!event.body) return {};
  const text = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  return JSON.parse(text);
}

async function handle(event: APIGatewayProxyEventV2, rawStream: awslambda.HttpResponseStream): Promise<void> {
  // The Function URL's CORS config answers the preflight itself, so an OPTIONS here
  // only happens on a direct invoke. Answer it rather than trying to parse it as a turn.
  const method = event.requestContext?.http?.method || 'POST';
  if (method === 'OPTIONS') {
    open(rawStream, 204).end();
    return;
  }
  if (method !== 'POST') {
    fail(rawStream, 405, 'Use POST');
    return;
  }

  const caller = await verifyCaller(event.headers);
  if (!caller) {
    fail(rawStream, 401, 'Not authenticated');
    return;
  }

  let request;
  try {
    request = ChatTurnRequestSchema.parse(readBody(event));
  } catch (error) {
    fail(rawStream, 400, `Invalid request: ${(error as Error).message}`);
    return;
  }

  const loaded = await loadEntityContext(request.app, request.entity_id, caller.userId)
    // A throw here — a table read that fails, a missing result object in S3, malformed
    // stored JSON — would reject the handler's promise before anything is written, and the
    // Function URL turns that into a bare 500 with no body, which tells the user nothing.
    // Null is the sentinel for it, deliberately distinct from the loader's own three
    // reasons: "this side could not read it" is not a fact about the record, and must not
    // be reported as one.
    .catch((error) => {
      console.error('[chat] could not load the entity context:', error);
      return null;
    });
  if (!loaded) {
    fail(rawStream, 500, 'That item could not be read just now. Please try again.');
    return;
  }

  // Each reason gets its own status, and all of them are decided here because this is the
  // last point at which a status *can* be decided: `open` fixes it with the first chunk,
  // and `fail` opens and ends the response itself, so nothing below the `open(rawStream,
  // 200)` further down could report any of this as anything but a 200.
  //
  // These used to be one 404 — "not found, or has no result to talk about yet" — merged so
  // that a caller could not tell a stranger's id from a nonexistent one. That reasoning
  // does not survive contact with the REST layer: GET /mom/{id} answers a non-owner with
  // 403 "You do not have access to this MOM" and resolves existence before authorization
  // by design (api-handler/index.ts, around line 889), so separating the two here
  // discloses nothing that endpoint has not disclosed all along. What the merge did cost
  // was an hour of somebody chasing a bug that did not exist, on a record that was theirs
  // and simply had not finished processing.
  if (!loaded.ok) {
    if (loaded.reason === 'not_owner') {
      fail(
        rawStream,
        403,
        'That item belongs to another user. Chat is owner-only; a reviewer can read its conversation from Admin → Conversations.',
      );
      return;
    }
    if (loaded.reason === 'no_result') {
      fail(rawStream, 404, 'That item has no result to talk about yet.');
      return;
    }
    fail(rawStream, 404, 'No item with that id exists.');
    return;
  }
  const entity = loaded.entity;

  const threadId = chatThreadId(request.app, request.entity_id, caller.userId);
  // History is a nicety, not a requirement: if the thread cannot be read the turn should
  // still answer, with no memory of the previous ones, rather than fail outright.
  const history = await loadRecentTurns(threadId, HISTORY_TURNS).catch((error) => {
    console.error('[chat] could not load thread history:', error);
    return [];
  });
  const turns: StoredTurn[] = [
    ...history.map(turn => ({ role: turn.role, content: turn.content })),
    { role: 'user' as const, content: request.message },
  ];

  // The proposal tool comes from the app; the read-only tools come from the loaded record,
  // because each one closes over the record whose ownership was just checked. Concatenated
  // rather than merged into one source, so the two categories cannot be confused: only the
  // read-only half is ever executed here, and only the proposal half can reach the user's
  // Apply button. See tools.ts.
  const readTools: ReadOnlyTool[] = entity.readTools || [];
  const toolSpecs = [...toolsFor(request.app), ...readTools.map(tool => tool.spec)];

  const stream = open(rawStream, 200);

  let answer = '';
  let proposal: ChatProposal | null = null;

  try {
    const outcome = await runToolLoop({
      modelId: request.app === 'calculator'
        ? calculatorModelId(calculatorChatTier(request.message))
        : MODEL_ID,
      system: systemPrompt(request.app, entity.context),
      messages: turns.map(turn => ({ role: turn.role, content: [{ text: turn.content }] })) as Message[],
      toolSpecs,
      readTools: new Map(readTools.map(tool => [tool.name, tool])),
      emit: text => ndjson(stream, { type: 'delta', text }),
      onProposal: value => ndjson(stream, { type: 'proposal', proposal: value }),
    });
    answer = outcome.answer;
    proposal = outcome.proposal;
    // Logged as one line per turn rather than per iteration: the loop's cost is the thing
    // worth being able to grep for once a matrix request goes long, and its two bounds are
    // only diagnosable if the reason it ended is recorded next to what it spent.
    console.log(`[chat] ${request.app} turn: ${outcome.turns} model turn(s), ${outcome.toolCalls} look-up(s), ended by ${outcome.stoppedBy}`);
  } catch (error) {
    console.error('[chat] model call failed:', error);
    // A 200 is already committed by the time this can happen, so the failure is
    // reported in-band. The client renders an `error` line as a failed turn.
    ndjson(stream, { type: 'error', message: 'The assistant could not finish that reply. Please try again.' });
    stream.end();
    return;
  }

  // Persisted after streaming, not before: a turn the user never saw should not appear
  // in the history of the next one.
  try {
    const seq = await nextSeq(threadId);
    await saveTurn({ threadId, seq, role: 'user', content: request.message });
    await saveTurn({
      threadId,
      seq: seq + 1,
      role: 'assistant',
      content: answer,
      ...(proposal ? { proposal } : {}),
    });
    ndjson(stream, { type: 'done', seq: seq + 1 });
  } catch (error) {
    // The answer is already on the screen and correct; only its history is lost.
    console.error('[chat] could not persist the turn:', error);
    ndjson(stream, { type: 'done', seq: 0 });
  }

  stream.end();
}

export const handler = awslambda.streamifyResponse(handle);
