/**
 * Context chat client.
 *
 * Two transports live here, and they are deliberately different:
 *
 *  - The turn itself streams from a Lambda Function URL, NOT API Gateway, because the
 *    gateway buffers a whole response and a 20-second answer would arrive as one block.
 *    So `streamChatTurn` reads a `ReadableStream` by hand rather than going through
 *    `authFetch`/`handleResponse`, and parses newline-delimited JSON as it arrives.
 *  - Everything else — the URL discovery, the two apply calls — is ordinary REST on the
 *    gateway, behind the Cognito authorizer, and applying a change never goes through the
 *    Function URL.
 *
 * The ID token is sent bare in Authorization, matching authFetch in lib/api.ts and the
 * chat Lambda's own auth.ts, which accepts both the bare token and a Bearer prefix.
 */

const API_URL = process.env.NEXT_PUBLIC_API_BASE_URL || '';

export type ChatApp = 'calculator' | 'mom' | 'interview' | 'intelligence';

export interface EstimateResourceEdit {
  row: number;
  field: 'size' | 'quantity' | 'os' | 'purchase_model' | 'region' | 'vcpu' | 'ram_gb' | 'disk_gb' | 'hoursPerMonth' | 'notes';
  value: string;
  reason?: string;
}

export interface RequirementPatch {
  target: {
    resourceIds?: string[];
    serviceFamily?: string;
    scenarioIds?: string[];
    environment?: string;
  };
  field: string;
  operation: 'set' | 'unset' | 'exclude' | 'include';
  value?: unknown;
  source: 'user' | 'workbook' | 'recommended';
  reason?: string;
  sourceInstruction?: string;
}

/**
 * One estimate of a requested matrix, mirroring EstimateScenarioRequestSchema. The enum is
 * spelled out rather than `string` so a typo'd pricing model is a compile error here, the
 * same way it is a validation error on the server.
 */
export interface EstimateScenario {
  label: string;
  pricing_model:
    | 'on-demand'
    | 'ri-1yr-no-upfront' | 'ri-1yr-partial-upfront' | 'ri-1yr-all-upfront'
    | 'ri-3yr-no-upfront' | 'ri-3yr-partial-upfront' | 'ri-3yr-all-upfront'
    | 'compute-savings-1yr' | 'compute-savings-3yr';
  scope?: string;
  environments?: string[];
  note?: string;
}

export interface EstimateChangeProposal {
  kind: 'estimate_change';
  summary: string;
  instruction: string;
  requirement_patches?: RequirementPatch[];
  resource_edits: EstimateResourceEdit[];
  scenarios?: EstimateScenario[];
  deliverables?: ('pdf' | 'xlsx' | 'docx')[];
}

export interface MomEditProposal {
  kind: 'mom_edit';
  summary: string;
  patch: Record<string, unknown>;
}

export type ChatProposal = EstimateChangeProposal | MomEditProposal;

/** One event off the wire. Mirrors ChatStreamEventSchema in the backend. */
export type ChatStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'proposal'; proposal: ChatProposal }
  | { type: 'done'; seq: number }
  | { type: 'error'; message: string };

async function idToken(): Promise<string> {
  const { getCurrentSession } = await import('./auth');
  const session = await getCurrentSession();
  if (!session) throw new Error('Not authenticated');
  return session.getIdToken().getJwtToken();
}

let cachedChatUrl: string | null = null;

/**
 * The chat Function URL, fetched once and cached.
 *
 * An empty string is a valid answer — it means the chat is not deployed in this
 * environment — so callers hide the launcher rather than treating it as an error.
 */
export async function getChatUrl(): Promise<string> {
  if (cachedChatUrl !== null) return cachedChatUrl;
  const token = await idToken();
  const res = await fetch(`${API_URL}/chat/config`, { headers: { Authorization: token } });
  if (!res.ok) {
    cachedChatUrl = '';
    return '';
  }
  const body = await res.json().catch(() => ({}));
  const url = typeof body?.chat_url === 'string' ? body.chat_url : '';
  cachedChatUrl = url;
  return url;
}

export interface ChatTurnHandlers {
  onDelta: (text: string) => void;
  onProposal: (proposal: ChatProposal) => void;
  onDone: (seq: number) => void;
  onError: (message: string) => void;
}

/**
 * The reason the handler gave for a failed turn, if it gave one.
 *
 * A rejected turn still arrives as NDJSON: the Lambda writes `{"type":"error",...}`
 * alongside its status, so the specific diagnosis — "that item was not found", "invalid
 * request" — is in the body. Reading it means the user sees the real reason instead of a
 * generic one. Returns null when the body is empty or is not our envelope, which is what
 * a platform-level 500 or a proxy error page looks like.
 */
async function serverErrorMessage(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = JSON.parse(trimmed) as ChatStreamEvent;
      if (parsed?.type === 'error' && typeof parsed.message === 'string') return parsed.message;
    }
  } catch {
    /* not our envelope — fall back to the status-based message */
  }
  return null;
}

/**
 * Send one turn and stream the reply.
 *
 * Resolves when the stream ends, having called the handlers as events arrived. The
 * caller renders `onDelta` text as it comes, so the first token paints without waiting
 * for the whole answer — which is the entire reason this is a Function URL.
 */
export async function streamChatTurn(
  chatUrl: string,
  body: { app: ChatApp; entity_id: string; message: string },
  handlers: ChatTurnHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const token = await idToken();
  let response: Response;
  try {
    response = await fetch(chatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') return;
    handlers.onError('Could not reach the assistant. Check your connection and try again.');
    return;
  }

  if (!response.ok || !response.body) {
    // 401 keeps the client's own wording: "Not authenticated" is accurate but does not
    // tell the user what to do about it, and reloading is the fix.
    if (response.status === 401) {
      handlers.onError('Your session has expired. Reload the page and sign in again.');
      return;
    }
    const served = await serverErrorMessage(response);
    handlers.onError(served || 'The assistant is unavailable right now. Please try again.');
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatch = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: ChatStreamEvent;
    try {
      event = JSON.parse(trimmed) as ChatStreamEvent;
    } catch {
      return; // A partial line that is not yet valid JSON; the next read completes it.
    }
    if (event.type === 'delta') handlers.onDelta(event.text);
    else if (event.type === 'proposal') handlers.onProposal(event.proposal);
    else if (event.type === 'done') handlers.onDone(event.seq);
    else if (event.type === 'error') handlers.onError(event.message);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // NDJSON: split on newlines, keep the trailing partial in the buffer.
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        dispatch(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    }
  } catch (error) {
    if ((error as Error).name !== 'AbortError') {
      handlers.onError('The reply was cut off. Please try again.');
    }
    return;
  }
  if (buffer.trim()) dispatch(buffer);
}

/**
 * The `chat_seq` fragment of an apply body, present only when the number is usable.
 *
 * The chat Lambda emits `done` with `seq: 0` on one specific path: the answer streamed
 * correctly but persisting the turn threw, so there is no stored row to mark. The gateway
 * validates `chat_seq` as `min(1)`, so forwarding that 0 would 400 the entire apply —
 * trading a missing "applied" badge for a change that never lands, which is the opposite
 * of what this marker is worth. Turns are 1-based, so `>= 1` is the whole test.
 */
function chatSeqField(chatSeq?: number): { chat_seq?: number } {
  return chatSeq !== undefined && chatSeq >= 1 ? { chat_seq: chatSeq } : {};
}

/**
 * Apply a chat-proposed estimate change. Creates a new revision on the gateway.
 *
 * `chatSeq` is the turn number of the assistant message that made the proposal, and it
 * is what lets the stored transcript show that this proposal was actually applied rather
 * than merely offered — the single most useful thing an oversight reader wants from a
 * conversation. Optional because a reply whose stream never delivered a usable `done`
 * event has no number to send, and applying is still worth doing without the marker.
 */
export async function applyEstimateChange(
  entityId: string,
  proposal: EstimateChangeProposal,
  chatSeq?: number,
): Promise<{ calculation_id: string; revision_number: number }> {
  const token = await idToken();
  const res = await fetch(`${API_URL}/calculator/${entityId}/revise`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({
      instruction: proposal.instruction,
      requirement_patches: proposal.requirement_patches || [],
      resource_edits: proposal.resource_edits,
      // Forwarded only when present, because the server reads an absent matrix as
      // "inherit the parent's" and an empty one would drop the parent's bands instead.
      scenarios: proposal.scenarios,
      deliverables: proposal.deliverables,
      ...chatSeqField(chatSeq),
    }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.error?.message || 'Could not apply the change.');
  }
  return res.json();
}

/** Apply a chat-proposed MOM edit. Rewrites the stored minutes and both documents. */
export async function applyMomEdit(
  entityId: string,
  proposal: MomEditProposal,
  chatSeq?: number,
): Promise<{ mom_id: string; updated_fields: string[] }> {
  const token = await idToken();
  const res = await fetch(`${API_URL}/moms/${entityId}/revise`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({
      patch: proposal.patch,
      ...chatSeqField(chatSeq),
    }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.error?.message || 'Could not apply the edit.');
  }
  return res.json();
}
