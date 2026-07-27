/**
 * Typed opencode HTTP client.
 *
 * A thin, typed layer over `opencode serve`'s session API — the layer every later
 * milestone (M3 capture, M5+ tools, M8 delegate) builds on. Deliberately uses raw
 * `fetch` (like `lifecycle.ts` and the spike) rather than the `@opencode-ai/sdk`
 * client: the generated `SessionCreateData` type omits the `agent`/`model` body
 * fields the *running* server actually accepts (verified live in the spike), so
 * hand-rolled request bodies are the only way to encode what the server wants and
 * to let the tests assert the exact wire shapes.
 *
 * TWO LOAD-BEARING INVARIANTS, each traced to a proven finding:
 *
 *   1. THE SYNC MESSAGE RESPONSE IS NOT A CAPTURE SOURCE. `POST /session/{id}/message`
 *      returns only the final assistant message with NO tool parts (spike-proven).
 *      The final text and the full exchange are extracted EXCLUSIVELY from
 *      `GET /session/{id}/message`. `sendMessage` therefore returns only completion
 *      metadata (cost/tokens/ids/finish) — its result type has NO text/parts field,
 *      so a higher layer *cannot* reach the sync body's text through this module.
 *
 *   2. BYTE-EXACTNESS. The final text is reconstructed from the history's text parts
 *      by plain concatenation — no trimming, no newline normalization, no re-encoding.
 *      This is M3's evidence-layer input, so a lost trailing newline here is a
 *      contract violation downstream (CONTRACT.md area D, C25). JSON.parse round-trips
 *      string bytes exactly, so the value returned equals what the model produced.
 */

import type { ServeHandle } from "./lifecycle.js";

// --- HTTP timeout defaults (ms) --------------------------------------------
/** Session create/list/delete/history: fast control-plane calls. */
export const SHORT_HTTP_MS = 15_000;
/** A model turn — generous; a real call can be slow. 15 min default (raised from 3 min
 * for long-running planning/review work); override per-install with GUILD_MESSAGE_TIMEOUT_MS. */
export const MESSAGE_HTTP_MS = 900_000;

// --- Model id -------------------------------------------------------------
/** The message-send model shape: `{providerID, modelID}` (verified live). */
export interface MessageModel {
  providerID: string;
  modelID: string;
}

/** The session-create model shape: `{id, providerID}` (verified live) — note the
 * different key (`id`, not `modelID`). Encoded distinctly so the two can't be
 * accidentally swapped; the offline fixture asserts the exact keys of each. */
export interface SessionCreateModel {
  id: string;
  providerID: string;
}

/**
 * Split a `"provider/model"` spec into its parts. A bare id (no slash) defaults
 * the provider to `opencode`, matching the wrapper convention. An empty
 * spec is a caller error — callers that want "opencode's own default" omit the
 * model entirely rather than passing "".
 */
export function splitModel(spec: string): MessageModel {
  if (spec === "") {
    throw new Error("empty model spec — omit the model to use opencode's default");
  }
  const idx = spec.indexOf("/");
  if (idx === -1) return { providerID: "opencode", modelID: spec };
  return { providerID: spec.slice(0, idx), modelID: spec.slice(idx + 1) };
}

// --- Errors ---------------------------------------------------------------
/** An HTTP/transport failure carrying enough context to diagnose (C-transport). */
export class OpencodeHttpError extends Error {
  constructor(
    message: string,
    readonly detail: {
      method: string;
      path: string;
      status?: number;
      sessionId?: string;
    },
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "OpencodeHttpError";
  }
}

/** Compose the effective abort signal: a per-call timeout, plus the caller's own
 * signal if supplied (either firing aborts the request). */
function effectiveSignal(timeoutMs: number, caller?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return caller ? AbortSignal.any([caller, timeout]) : timeout;
}

interface RequestCtx {
  baseUrl: string;
  path: string;
  method: string;
  timeoutMs: number;
  sessionId?: string;
  signal?: AbortSignal;
  body?: unknown;
}

/** Issue one bounded request, throwing an `OpencodeHttpError` with context on any
 * transport failure or non-2xx status. Returns the parsed JSON body. */
async function requestJson(ctx: RequestCtx): Promise<unknown> {
  const { baseUrl, path, method, timeoutMs, sessionId } = ctx;
  const init: RequestInit = { method, signal: effectiveSignal(timeoutMs, ctx.signal) };
  if (ctx.body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(ctx.body);
  }

  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, init);
  } catch (err) {
    // Timeout aborts and connection failures both land here — annotate the DURATION only
    // when the failure was actually the timeout firing, so a too-small configured value
    // (e.g. a seconds-vs-ms typo, 600 → 600ms) is self-evident, without mislabelling a
    // connection-refused error as a timeout. `AbortSignal.timeout` rejects fetch with a
    // DOMException whose name is "TimeoutError" (verified live, Node v22: a caller abort
    // is "AbortError", a connection failure a TypeError "fetch failed"); it survives the
    // `AbortSignal.any` wrap in `effectiveSignal`.
    const timedOut = (err as Error)?.name === "TimeoutError";
    throw new OpencodeHttpError(
      `${method} ${path} failed${timedOut ? ` after ${timeoutMs}ms (timeout)` : ""}${
        sessionId ? ` (session=${sessionId})` : ""
      }: ${(err as Error).message}`,
      { method, path, sessionId },
      { cause: err },
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new OpencodeHttpError(
      `${method} ${path} → ${res.status} ${res.statusText}${
        sessionId ? ` (session=${sessionId})` : ""
      }${text ? ` ${text}` : ""}`,
      { method, path, status: res.status, sessionId },
    );
  }
  return res.json();
}

// --- createSession --------------------------------------------------------
export interface CreateSessionOpts {
  baseUrl: string;
  agent?: string;
  title?: string;
  /** Optional `"provider/model"`. When given it is encoded as the session-create
   * shape `{id, providerID}` (distinct from the message-send shape). */
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** A minimal reference to a created session — its id is all later calls need. */
export interface SessionRef {
  id: string;
}

/** `POST /session` — create a session bound to `agent`. */
export async function createSession(opts: CreateSessionOpts): Promise<SessionRef> {
  const body: {
    title?: string;
    agent?: string;
    model?: SessionCreateModel;
  } = {};
  if (opts.title !== undefined) body.title = opts.title;
  if (opts.agent !== undefined) body.agent = opts.agent;
  if (opts.model !== undefined) {
    const { providerID, modelID } = splitModel(opts.model);
    body.model = { id: modelID, providerID }; // session-create shape: {id, providerID}
  }

  const raw = (await requestJson({
    baseUrl: opts.baseUrl,
    path: "/session",
    method: "POST",
    timeoutMs: opts.timeoutMs ?? SHORT_HTTP_MS,
    signal: opts.signal,
    body,
  })) as { id?: unknown };

  if (typeof raw.id !== "string" || raw.id.length === 0) {
    throw new OpencodeHttpError(`session create returned no id: ${JSON.stringify(raw)}`, {
      method: "POST",
      path: "/session",
    });
  }
  return { id: raw.id };
}

// --- sendMessage ----------------------------------------------------------
/** An input message part. Only `text` is needed for the guild flows; the type is
 * left open for the file/agent/subtask parts opencode also accepts. */
export interface TextPartInput {
  type: "text";
  text: string;
}
export type MessagePartInput = TextPartInput;

export interface SendMessageOpts {
  baseUrl: string;
  sessionId: string;
  agent?: string;
  /** `"provider/model"`, encoded as the message-send shape `{providerID, modelID}`. */
  model?: string;
  parts: MessagePartInput[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Completion metadata from the sync message response — DELIBERATELY carries no
 * text or parts. The sync body's text is incomplete (no tool parts) and is not a
 * capture source (invariant 1); the only honest use for it is a "the turn finished"
 * signal plus cost/token/id metadata. Read the actual answer via `fetchHistory`.
 */
export interface SendResult {
  messageId?: string;
  providerID?: string;
  modelID?: string;
  cost?: number;
  tokens?: unknown;
  finish?: string;
}

/** `POST /session/{id}/message` — send a turn and block until it completes. */
export async function sendMessage(opts: SendMessageOpts): Promise<SendResult> {
  const body: {
    agent?: string;
    model?: MessageModel;
    parts: MessagePartInput[];
  } = { parts: opts.parts };
  if (opts.agent !== undefined) body.agent = opts.agent;
  if (opts.model !== undefined) {
    body.model = splitModel(opts.model); // message-send shape: {providerID, modelID}
  }

  const raw = (await requestJson({
    baseUrl: opts.baseUrl,
    path: `/session/${opts.sessionId}/message`,
    method: "POST",
    timeoutMs: opts.timeoutMs ?? MESSAGE_HTTP_MS,
    sessionId: opts.sessionId,
    signal: opts.signal,
    body,
  })) as { info?: Record<string, unknown> };

  // Read ONLY metadata off the sync envelope; the text/parts are intentionally
  // discarded here so they can never leak upward (invariant 1).
  const info = raw.info ?? {};
  return {
    messageId: typeof info.id === "string" ? info.id : undefined,
    providerID: typeof info.providerID === "string" ? info.providerID : undefined,
    modelID: typeof info.modelID === "string" ? info.modelID : undefined,
    cost: typeof info.cost === "number" ? info.cost : undefined,
    tokens: info.tokens,
    finish: typeof info.finish === "string" ? info.finish : undefined,
  };
}

// --- history + extraction -------------------------------------------------
/** Normalized tool status (the four opencode `ToolState` statuses). */
export type ToolStatus = "pending" | "running" | "completed" | "error";

/** A tool invocation from history, flattened to the shape M3 capture and M8
 * delegate consume: the tool name plus the union-collapsed state. `output` is
 * present on `completed`, `error` on `error`; both are undefined otherwise. */
export interface ToolPartView {
  tool: string;
  state: {
    status: ToolStatus;
    input?: unknown;
    error?: string;
    output?: string;
  };
}

/** One message in the ordered history, kept close to the raw envelope so nothing
 * is lost before M3 decides what to persist. */
export interface HistoryMessage {
  role: string;
  info: Record<string, unknown>;
  parts: Array<Record<string, unknown>>;
}

export interface SessionHistory {
  messages: HistoryMessage[];
}

export interface FetchHistoryOpts {
  baseUrl: string;
  sessionId: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** `GET /session/{id}/message` — the full ordered exchange, tool parts included.
 * This is the ONLY sanctioned source of the final text and the tool record. */
export async function fetchHistory(opts: FetchHistoryOpts): Promise<SessionHistory> {
  const raw = (await requestJson({
    baseUrl: opts.baseUrl,
    path: `/session/${opts.sessionId}/message`,
    method: "GET",
    timeoutMs: opts.timeoutMs ?? SHORT_HTTP_MS,
    sessionId: opts.sessionId,
    signal: opts.signal,
  })) as unknown;

  if (!Array.isArray(raw)) {
    throw new OpencodeHttpError(`history was not an array: ${JSON.stringify(raw).slice(0, 200)}`, {
      method: "GET",
      path: `/session/${opts.sessionId}/message`,
      sessionId: opts.sessionId,
    });
  }

  const messages: HistoryMessage[] = raw.map((entry) => {
    const e = (entry ?? {}) as { info?: Record<string, unknown>; parts?: unknown };
    const info = e.info ?? {};
    const parts = Array.isArray(e.parts) ? (e.parts as Array<Record<string, unknown>>) : [];
    return { role: typeof info.role === "string" ? info.role : "", info, parts };
  });
  return { messages };
}

/**
 * The final assistant text, reconstructed BYTE-EXACT from history (invariant 2).
 *
 * The "final answer" is the last assistant message that carries text parts —
 * the one the sync response also returns — so a trailing pure-tool-call assistant
 * message can't blank the answer. Text parts are concatenated verbatim in order
 * with NO separator, trim, or normalization, so newlines (including a trailing
 * one), quotes, and unicode survive intact.
 */
export function finalAssistantText(history: SessionHistory): string {
  for (let i = history.messages.length - 1; i >= 0; i--) {
    const m = history.messages[i];
    if (m.role !== "assistant") continue;
    const textParts = m.parts.filter(
      (p) => p.type === "text" && typeof p.text === "string",
    );
    if (textParts.length === 0) continue;
    return textParts.map((p) => p.text as string).join("");
  }
  return "";
}

/**
 * The agent that actually SERVED the answer, read from the answer-producing assistant
 * message's `info.agent` (opencode 1.18.2 populates it — verified live: a `guild-read`
 * call reports `info.agent === "guild-read"`). Returns `undefined` when opencode does
 * not report an agent (older/other builds), so a caller can DISTINGUISH "served a
 * different agent" (a real mismatch to fail closed on) from "opencode didn't say" (which
 * must not be treated as a mismatch — the check is only as strong as the field's
 * presence, and inventing a mismatch on absence would break on a build that drops it).
 */
export function servingAgent(history: SessionHistory): string | undefined {
  for (let i = history.messages.length - 1; i >= 0; i--) {
    const m = history.messages[i];
    if (m.role !== "assistant") continue;
    const textParts = m.parts.filter(
      (p) => p.type === "text" && typeof p.text === "string",
    );
    if (textParts.length === 0) continue;
    const agent = m.info.agent;
    return typeof agent === "string" && agent.length > 0 ? agent : undefined;
  }
  return undefined;
}

/**
 * Raised when opencode served a DIFFERENT agent than the one requested — e.g. a silent
 * fallback to the full-access built-in `build` when a hardened def didn't resolve, which
 * would be full-access output masquerading as the read-only/hardened agent's. Thrown from
 * `askViaAgent` right after the history read (`expectedAgent` set), so the session-deletion
 * matrix cleans up correctly (a mismatch is treated as a failed turn). Carries the served
 * session id so a higher layer can record which session produced the wrong-agent output.
 */
export class AgentMismatchError extends Error {
  constructor(
    readonly requested: string,
    readonly actual: string,
    readonly sessionId: string,
  ) {
    super(
      `agent mismatch: requested '${requested}' but opencode served '${actual}' — ` +
        `refusing to return the wrong agent's output as if it were the requested one ` +
        `(a silent fallback to a weaker/full-access agent is a masquerade).`,
    );
    this.name = "AgentMismatchError";
  }
}

/** Every tool invocation across the exchange, flattened to `ToolPartView`. */
export function toolParts(history: SessionHistory): ToolPartView[] {
  const out: ToolPartView[] = [];
  for (const m of history.messages) {
    for (const p of m.parts) {
      if (p.type !== "tool") continue;
      const state = (p.state ?? {}) as Record<string, unknown>;
      out.push({
        tool: typeof p.tool === "string" ? p.tool : "",
        state: {
          status: (typeof state.status === "string" ? state.status : "pending") as ToolStatus,
          input: state.input,
          error: typeof state.error === "string" ? state.error : undefined,
          output: typeof state.output === "string" ? state.output : undefined,
        },
      });
    }
  }
  return out;
}

// --- deleteSession --------------------------------------------------------
export interface DeleteSessionOpts {
  baseUrl: string;
  sessionId: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** `DELETE /session/{id}`. Throws (with context) on a non-2xx status so a caller
 * that wants best-effort cleanup can choose to swallow it; `askViaAgent` does. */
export async function deleteSession(opts: DeleteSessionOpts): Promise<void> {
  await requestJson({
    baseUrl: opts.baseUrl,
    path: `/session/${opts.sessionId}`,
    method: "DELETE",
    timeoutMs: opts.timeoutMs ?? SHORT_HTTP_MS,
    sessionId: opts.sessionId,
    signal: opts.signal,
  });
}

// --- askViaAgent (composed through the M1 lifecycle) ----------------------
/** The slice of `OpencodeLifecycle` this module needs: run a fn against a ready
 * serve. Narrowed to an interface so the offline fixture can drive `askViaAgent`
 * against a fake HTTP server without spawning opencode. */
export interface ServeProvider {
  withServe<T>(fn: (h: ServeHandle) => Promise<T>): Promise<T>;
}

export interface AskViaAgentOpts {
  agent: string;
  /** `"provider/model"`; omit to let opencode use its own default. */
  model?: string;
  /** Convenience: a single text turn. Ignored if `parts` is given. */
  prompt?: string;
  parts?: MessagePartInput[];
  title?: string;
  messageTimeoutMs?: number;
  shortTimeoutMs?: number;
  signal?: AbortSignal;
  /**
   * SESSION CONTINUATION (M7 / Option B). Continue an EXISTING opencode session
   * instead of creating a fresh one: the session already carries the peer's prior
   * turns, so the ONLY new bytes sent are `prompt`/`parts` — the driver never
   * re-transmits another model's words (the "Option B" construction guarantee).
   * When set, `createSession` is NOT called; the id is used as-is.
   */
  sessionId?: string;
  /**
   * Keep the session alive for further continuation: skip the `finally`-delete and
   * return the id in `AskResult.sessionId`. Default (unset/false) deletes the session
   * after the turn — the single-shot behaviour M5/M6 relied on. This expresses INTENT;
   * ownership (created-here vs continued) and outcome (success vs throw) also decide
   * deletion — see the matrix in `askViaAgent`.
   */
  keepSession?: boolean;
  /**
   * The agent name that MUST have served the answer. When set, `askViaAgent` reads the
   * served agent from history after the turn and throws `AgentMismatchError` if opencode
   * served a different one — closing the "silent fallback to a weaker agent" hole. Left
   * unset (e.g. low-level client tests), no check is done.
   */
  expectedAgent?: string;
}

export interface AskResult {
  /** Byte-exact final text, from history (never the sync body). */
  text: string;
  sessionId: string;
  /** Completion metadata from the sync response (cost/tokens/ids/finish). */
  metadata: SendResult;
  /** Flattened tool invocations from history (M3/M8 input). */
  toolParts: ToolPartView[];
  /** The full parsed history, for capture layers that want the raw exchange. */
  history: SessionHistory;
}

/**
 * The composed happy path: ensure a serve is up (M1 lifecycle), obtain a session on
 * `agent` (create a fresh one, OR continue `opts.sessionId` when given — M7 Option B),
 * send the turn, read the answer from history, and — UNLESS `keepSession` — delete the
 * session even when the send or history read throws. Teardown is in a `finally`; a
 * failed delete is swallowed (best-effort) so it never masks the real error.
 *
 * When continuing (`sessionId` set), `createSession` is NOT called: the peer's earlier
 * turns live in opencode's session, so only this turn's `parts` are transmitted — the
 * fidelity guarantee is by construction, not by the driver re-quoting the peer.
 */
export async function askViaAgent(serve: ServeProvider, opts: AskViaAgentOpts): Promise<AskResult> {
  const parts: MessagePartInput[] =
    opts.parts ?? [{ type: "text", text: opts.prompt ?? "" }];
  const shortMs = opts.shortTimeoutMs ?? SHORT_HTTP_MS;
  const messageMs = opts.messageTimeoutMs ?? MESSAGE_HTTP_MS;

  // Ownership: did WE create this session, or are we continuing the caller's?
  const continued = opts.sessionId !== undefined;

  return serve.withServe(async (h) => {
    // Continue an existing session (no create) or mint a fresh one.
    const sessionId =
      opts.sessionId ??
      (
        await createSession({
          baseUrl: h.baseUrl,
          agent: opts.agent,
          title: opts.title,
          model: opts.model,
          timeoutMs: shortMs,
          signal: opts.signal,
        })
      ).id;

    let succeeded = false;
    try {
      const metadata = await sendMessage({
        baseUrl: h.baseUrl,
        sessionId,
        agent: opts.agent,
        model: opts.model,
        parts,
        timeoutMs: messageMs,
        signal: opts.signal,
      });

      const history = await fetchHistory({
        baseUrl: h.baseUrl,
        sessionId,
        timeoutMs: shortMs,
        signal: opts.signal,
      });

      // Fail closed if opencode served a DIFFERENT agent than requested (a masquerade).
      // Thrown here — BEFORE `succeeded` is set — so the deletion matrix treats a
      // mismatch as a failed turn (a created-here session gets cleaned up, not orphaned).
      if (opts.expectedAgent !== undefined) {
        const actual = servingAgent(history);
        if (actual !== undefined && actual !== opts.expectedAgent) {
          throw new AgentMismatchError(opts.expectedAgent, actual, sessionId);
        }
      }

      const result: AskResult = {
        text: finalAssistantText(history),
        sessionId,
        metadata,
        toolParts: toolParts(history),
        history,
      };
      succeeded = true;
      return result;
    } finally {
      // DELETION MATRIX (ownership × outcome × intent). Deletion means "we tear this
      // session down"; a delete failure is swallowed so it never masks a real error.
      //
      //   created here + success + keepSession   → KEEP  (return the id for reuse)
      //   created here + success + !keepSession  → DELETE (single-shot default)
      //   created here + THROW   (any keep)      → DELETE (id is unreturnable — keeping
      //                                             it would be a durable on-disk orphan)
      //   continued + success + keepSession      → KEEP  (caller wants more turns)
      //   continued + success + !keepSession     → DELETE (documented final-turn behaviour)
      //   continued + THROW     (any keep)       → KEEP  (the CALLER owns the id and may
      //                                             retry; deleting destroys e.g. workshop
      //                                             round-1 state we did not create)
      const shouldDelete = continued
        ? succeeded && !opts.keepSession
        : !succeeded || !opts.keepSession;
      if (shouldDelete) {
        await deleteSession({
          baseUrl: h.baseUrl,
          sessionId,
          timeoutMs: shortMs,
        }).catch(() => {});
      }
    }
  });
}
