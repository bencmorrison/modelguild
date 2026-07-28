/**
 * Live-activity layer (issue #20, slice 1 of DESIGN-live-visibility.md).
 *
 * WHAT PROBLEM THIS SOLVES. Everything an external model does happens inside one
 * blocking `POST /session/{id}/message` (`src/client.ts` `sendMessage`), and nothing
 * escapes it until `fetchHistory()` reconstructs the turn afterwards. A `guild_delegate`
 * on a slow model is therefore a 15-minute black box that ends with a diff. The evidence
 * log (`src/log.ts`) records the RECEIPTS — the model's actual words, byte-exact — but it
 * is a post-hoc record. This layer adds the missing LIVENESS: opencode's own event stream,
 * normalized, written to `<runDir>/activity.jsonl` as it happens, surfaced as a bounded
 * `structuredContent.activity` on every tool result, tailed by `modelguild watch`, and (when
 * the MCP client sent a `progressToken`) relayed as `notifications/progress`.
 *
 * IT IS NOT THE EVIDENCE LOG, AND IT DELIBERATELY DOES NOT TOUCH IT.
 *   - `activity.jsonl` is a SEPARATE file in the run dir. No `calls.jsonl` entry shape
 *     changes, no entry references it, and `EvidenceLog.verify()` never reads it — verify
 *     validates the three-entry cardinality and the artifacts entries REFERENCE, so an
 *     unreferenced sibling file is inert to it by construction.
 *   - Honesty about what these lines ARE: opencode's report of the model's tool calls,
 *     captured by this server as they stream past. They are evidence of ACTIONS at
 *     opencode's fidelity — NOT receipts of the model's words (that is `raw_response` in
 *     `calls.jsonl`), and not a containment or confidentiality mechanism. Watching a
 *     `bash` call scroll past does not gate it; `guild-build` allows `bash` by design and
 *     the human diff review remains the review point (AGENTS.md, SECURITY.md).
 *
 * A STREAM FAILURE IS NEVER A CALL FAILURE. The bus reconnects with backoff; if it cannot
 * attach at all, the call proceeds with no activity and the result says so
 * (`activity.degraded`), so a quiet activity list is never mistaken for a quiet model.
 * This mirrors the evidence layer's "best-effort, never fails the call it records" rule.
 *
 * EVENT SOURCE — PROBED, NOT ASSUMED (Slice 0, 2026-07-27, opencode 1.18.5; re-validated on
 * 1.18.7). The design's §2 table listed `session.next.tool.called/.success/.failed` and
 * `session.next.text.delta`. Those names exist in opencode's event union but NEVER fired
 * across ~6 observed turns. The events that actually carry tool activity are
 * `message.part.updated` with `part.type === "tool"`, whose `state.status` walks
 * pending → running → completed|error and carries `tool`, `callID`, `input`, `output`, and
 * `metadata.exit`. The normalizer is built on the OBSERVED set, still understands the
 * `session.next.*` names (cheap forward/backward compatibility), and drops every unknown
 * type SILENTLY so an opencode bump that adds an event can never break a call.
 *
 * TWO PROBED SHAPE FACTS THAT COST REAL BEHAVIOUR, both found by review on 1.18.7 and both
 * fixed here rather than papered over in the fixtures:
 *   - A `pending` tool part carries `input: {}`; only `running` carries the real input. So
 *     `pending` is DROPPED (see `kindForToolStatus`) — mapping both to `tool-called` made
 *     the dedupe keep the inputless one, and the watcher could not see a shell command
 *     until after it had run.
 *   - `file.edited` carries `properties = {file}` with NO `sessionID`. So session-less
 *     events are BROADCAST and flagged `unattributed` (see `#dispatch`) — routing them by
 *     session dropped every one, leaving `filesEdited` permanently empty in production
 *     while the offline fixture, which had invented a `sessionID`, stayed green.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { SHORT_HTTP_MS } from "./client.js";
import type { ActivityDetail } from "./config.js";

export type { ActivityDetail };

/** The name of the per-run activity file, so `modelguild watch` and the tools agree. */
export const ACTIVITY_FILE = "activity.jsonl";

// ---------------------------------------------------------------------------
// The normalized event
// ---------------------------------------------------------------------------

export type ActivityKind =
  | "tool-called"
  | "tool-succeeded"
  | "tool-failed"
  | "file-edited"
  | "text-delta"
  | "permission-asked"
  | "permission-replied"
  | "session-idle"
  | "session-error";

/** One normalized, opencode-version-tolerant activity event. */
export interface ActivityEvent {
  /** Wall-clock ms when this server normalized the event. */
  ts: number;
  /** opencode session id — the routing key for concurrent calls on one serve child. */
  sessionId: string;
  kind: ActivityKind;
  /** The opencode tool name (`read`, `bash`, `edit`, …) when the event is a tool event. */
  tool?: string;
  /** opencode's own tool-invocation id (`callID`). NOT the ModelGuild `call_id`. */
  toolCallId?: string;
  /** One line of human-readable text — what `modelguild watch` and progress messages show. */
  summary: string;
  /**
   * The raw event `properties`. The bus attaches it to every delivered event; the RECORDER
   * is the only thing that reads the detail knob, and writes it to `activity.jsonl` only at
   * `GUILD_ACTIVITY_DETAIL=full`. Keeping the knob in one place is why the normalizer and
   * the bus can stay pure — no second reader to drift from `resolveActivitySettings`.
   */
  detail?: unknown;
  /**
   * TRUE when the raw event carried NO `sessionID` and could therefore not be routed to
   * one call — it was broadcast to every subscriber of the serve child instead.
   *
   * This is not hypothetical tidiness: `file.edited` on opencode 1.18.5–1.18.7 carries
   * `properties = {file}` and nothing else (probed). Dropping those (the original
   * behaviour) made `filesEdited` permanently EMPTY against a real opencode. Broadcasting
   * is the honest degradation — for the overwhelmingly common single-call case it is
   * exactly right, and for a concurrent panel it is ambiguous, which is what this flag and
   * the `filesEdited` doc say out loud rather than quietly mis-attributing.
   */
  unattributed?: boolean;
  /** The MODEL this call is running (recorder context, not from the raw event) — attached
   * on the way out to the live sink so a panel's progress lines stay attributable. */
  model?: string;
  /** The MODELGUILD call id (recorder context). Distinct from `toolCallId`, which is
   * opencode's per-tool-invocation id. */
  callId?: string;
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

/** Truncate to `max` chars on a single line, marking the cut. */
function oneLine(s: string, max = 160): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** The input keys worth showing first, in the order a human would want them. */
const INPUT_KEYS = [
  "command",
  "filePath",
  "path",
  "file",
  "pattern",
  "url",
  "query",
  "description",
  "prompt",
];

/** A short, human-readable rendering of a tool's input (`bash` → its command, `read` →
 * its path, …). Falls back to a truncated JSON dump so an unknown tool still says
 * something. Truncation is why `summary` detail is the safe default: it shows the SHAPE
 * of what the model did without spilling whole file contents into the record. */
export function summarizeToolInput(input: unknown, max = 160): string {
  if (input === undefined || input === null) return "";
  if (typeof input === "string") return oneLine(input, max);
  if (typeof input !== "object") return oneLine(String(input), max);
  const obj = input as Record<string, unknown>;
  // An EMPTY object is "no input", not the literal text `{}`. opencode's `pending` tool
  // parts carry `input: {}` (probed 1.18.7), and the JSON fallback below would otherwise
  // render that as the truthy string "{}" — so the clean no-input branch in `toolSummary`
  // could never fire and every such line read `bash: {}`.
  if (Object.keys(obj).length === 0) return "";
  for (const k of INPUT_KEYS) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return oneLine(v, max);
  }
  try {
    return oneLine(JSON.stringify(obj), max);
  } catch {
    return "";
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** Pull the session id out of whatever shape the event uses. Every observed event carries
 * `properties.sessionID`; a tool part carries it on the part. An event with none is
 * unroutable and the bus drops it (no subscriber key can be ""). */
function sessionIdOf(props: Record<string, unknown>): string {
  return (
    str(props.sessionID) ??
    str(asRecord(props.part).sessionID) ??
    str(asRecord(props.info).sessionID) ??
    ""
  );
}

/**
 * Map an opencode tool `state.status` to a normalized kind.
 *
 * `pending` IS DELIBERATELY DROPPED (fix for the "every live line reads `bash: {}`" defect,
 * probed on 1.18.7). A `pending` tool part carries `input: {}` — the real input only
 * arrives on `running`. Since both statuses meant `tool-called`, the recorder's dedupe kept
 * the FIRST (pending, inputless) and discarded the informative one, so the watcher could
 * not see which shell command was running until after it had finished.
 *
 * The trade-off, stated: a tool that sits queued in `pending` is now invisible until it
 * starts. That costs nothing real — a `pending` line could never show the command anyway —
 * and it degrades safely: on a build that somehow emits `pending` → `completed` with no
 * `running`, the terminal event still lands and still carries the input.
 */
function kindForToolStatus(status: string): ActivityKind | undefined {
  if (status === "running") return "tool-called";
  if (status === "completed") return "tool-succeeded";
  if (status === "error") return "tool-failed";
  return undefined;
}

function toolSummary(kind: ActivityKind, tool: string, state: Record<string, unknown>): string {
  const input = summarizeToolInput(state.input);
  if (kind === "tool-called") return input ? `${tool}: ${input}` : tool;
  if (kind === "tool-failed") {
    const err = str(state.error) ?? "failed";
    return `${tool} FAILED: ${oneLine(err, 200)}`;
  }
  // Succeeded: prefer the exit code opencode reports for `bash`; else the output size.
  const meta = asRecord(state.metadata);
  const parts: string[] = [];
  if (typeof meta.exit === "number") parts.push(`exit ${meta.exit}`);
  const out = state.output;
  if (typeof out === "string") parts.push(`${out.length} bytes`);
  const tail = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return input ? `${tool} ok: ${input}${tail}` : `${tool} ok${tail}`;
}

/**
 * Normalize one raw `GET /event` payload to an `ActivityEvent`, or `undefined` when the
 * event carries no activity worth recording.
 *
 * DROPPING IS THE DEFAULT. `message.updated`, `session.status`, `session.updated`,
 * `session.diff`, `session.created`, `session.deleted`, `server.heartbeat` and anything a
 * future opencode adds all return `undefined`. That is the forward-compatibility rule:
 * an unknown event must never break a call, and a missing expected event degrades
 * visibility only.
 */
export function normalizeServeEvent(raw: unknown): ActivityEvent | undefined {
  const ev = asRecord(raw);
  const type = str(ev.type);
  if (type === undefined) return undefined;
  const props = asRecord(ev.properties);
  const sessionId = sessionIdOf(props);
  const ts = Date.now();

  switch (type) {
    // --- The PRIMARY source (probed): a tool part walking its state machine. ---
    case "message.part.updated": {
      const part = asRecord(props.part);
      if (str(part.type) !== "tool") return undefined;
      const state = asRecord(part.state);
      const status = str(state.status) ?? "";
      const kind = kindForToolStatus(status);
      if (kind === undefined) return undefined;
      const tool = str(part.tool) ?? "tool";
      return {
        ts,
        sessionId: sessionId || (str(part.sessionID) ?? ""),
        kind,
        tool,
        toolCallId: str(part.callID),
        summary: toolSummary(kind, tool, state),
      };
    }

    // --- Streaming assistant text/reasoning. High volume (261 in ~6 turns), so it is
    //     recorded ONLY at `full` detail — see ActivityRecorder#handle. ---
    case "message.part.delta":
    case "session.next.text.delta":
    case "session.next.reasoning.delta": {
      const text = str(props.delta) ?? str(props.text) ?? str(asRecord(props.part).text) ?? "";
      if (text === "") return undefined;
      return { ts, sessionId, kind: "text-delta", summary: oneLine(text, 120) };
    }

    // --- The `session.next.tool.*` names: present in opencode's union, never observed
    //     firing on 1.18.5. Kept so a build that DOES emit them is understood. ---
    case "session.next.tool.called": {
      const tool = str(props.tool) ?? "tool";
      return {
        ts,
        sessionId,
        kind: "tool-called",
        tool,
        toolCallId: str(props.callID),
        summary: toolSummary("tool-called", tool, { input: props.input }),
      };
    }
    case "session.next.tool.success":
    case "session.next.tool.failed": {
      const tool = str(props.tool) ?? "tool";
      const kind: ActivityKind =
        type === "session.next.tool.success" ? "tool-succeeded" : "tool-failed";
      return {
        ts,
        sessionId,
        kind,
        tool,
        toolCallId: str(props.callID),
        summary: toolSummary(kind, tool, {
          input: props.input,
          output: props.content,
          error: props.error,
        }),
      };
    }

    case "file.edited": {
      const file = str(props.file) ?? str(props.path) ?? "";
      if (file === "") return undefined;
      return { ts, sessionId, kind: "file-edited", summary: `edited ${file}` };
    }

    case "permission.asked":
    case "permission.v2.asked": {
      const what =
        str(props.permission) ??
        str(asRecord(props.metadata).title) ??
        str(props.action) ??
        "permission";
      return { ts, sessionId, kind: "permission-asked", summary: `permission asked: ${oneLine(what)}` };
    }
    case "permission.replied":
    case "permission.v2.replied": {
      const reply = str(props.reply) ?? str(props.response) ?? "?";
      return { ts, sessionId, kind: "permission-replied", summary: `permission ${reply}` };
    }

    case "session.idle":
      return { ts, sessionId, kind: "session-idle", summary: "turn finished (session idle)" };

    case "session.error": {
      const err = props.error;
      const text =
        str(err) ??
        str(asRecord(err).message) ??
        str(asRecord(asRecord(err).data).message) ??
        (() => {
          try {
            return JSON.stringify(err);
          } catch {
            return "unknown error";
          }
        })();
      return { ts, sessionId, kind: "session-error", summary: `session error: ${oneLine(text ?? "unknown error", 200)}` };
    }

    default:
      // Unknown / uninteresting: dropped silently, by design.
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// ServeEventBus — one SSE subscription per serve child, refcounted, routed by sessionID
// ---------------------------------------------------------------------------

export interface BusHandlers {
  onEvent: (e: ActivityEvent) => void;
  /** Called when the stream is not (or is no longer) attached, with a short reason. */
  onDegraded?: (reason: string) => void;
}

const RECONNECT_BACKOFF_MS = [250, 500, 1000, 2000];
/**
 * Deadline for the HEADERS phase of `GET /event`. A serve that accepts the TCP connection
 * but never answers would otherwise leave the fetch pending forever — and since a recorder
 * awaits attachment before the turn is sent, that hung the CALL, outside
 * `GUILD_MESSAGE_TIMEOUT_MS` and before the `finally` that deletes the session. Cleared the
 * moment headers arrive, so a long-lived idle stream is never cut.
 */
const EVENT_HEADERS_TIMEOUT_MS = SHORT_HTTP_MS;
/**
 * Hard cap on the un-framed SSE read buffer. A stream that never emits a frame boundary
 * (a wedged or hostile peer) would otherwise grow it without bound. On breach the buffer is
 * dropped and the subscription degrades with a named reason; reading continues, re-syncing
 * at the next frame boundary.
 */
const MAX_FRAME_BUFFER_BYTES = 4 * 1024 * 1024;

/** Every live bus, keyed by the serve child's baseUrl. Module-level so `lifecycle.ts`
 * can close a dying child's bus without either module owning the other. */
const buses = new Map<string, ServeEventBus>();

/**
 * A single `GET /event` subscription per `opencode serve` child, fanned out to the calls
 * running against it by `sessionID`.
 *
 * WHY ONE SHARED BUS (design §3.1, option C). A `guild_panel` runs 2–3 sessions on the SAME
 * serve child. Subscribing per call would open three full-serve streams, each receiving and
 * discarding the other two's events. Refcounting one stream and routing by session id costs
 * one subscription per serve child regardless of concurrency.
 */
export class ServeEventBus {
  readonly #baseUrl: string;
  #refs = 0;
  #subs = new Map<string, Set<BusHandlers>>();
  #controller: AbortController | undefined;
  #closed = false;
  #connected = false;
  #running = false;
  /** The CURRENT connect attempt — replaced on every reconnect, not once-only. `ready()`
   * reads it, so a recorder attaching to an already-live bus whose stream has since dropped
   * learns the truth instead of a stale first-attempt `true`. */
  #currentAttempt: Promise<boolean> | undefined;
  #resolveAttempt: ((ok: boolean) => void) | undefined;

  private constructor(baseUrl: string) {
    this.#baseUrl = baseUrl;
  }

  /** Get (or create) the bus for `baseUrl` and take a reference on it. */
  static acquire(baseUrl: string): ServeEventBus {
    let bus = buses.get(baseUrl);
    if (bus === undefined || bus.#closed) {
      bus = new ServeEventBus(baseUrl);
      buses.set(baseUrl, bus);
    }
    bus.#refs += 1;
    bus.#ensureRunning();
    return bus;
  }

  get connected(): boolean {
    return this.#connected;
  }
  get baseUrl(): string {
    return this.#baseUrl;
  }
  /** Test/diagnostic: live reference count. */
  get refs(): number {
    return this.#refs;
  }

  /**
   * Resolve to whether the stream is attached RIGHT NOW: `true` immediately when connected,
   * otherwise the in-flight connect attempt's outcome (and `false` when there is none —
   * e.g. mid-backoff after a drop). Callers await this before sending the turn so early
   * events are not missed.
   *
   * IT MUST NOT BE THE FIRST ATTEMPT'S RESULT. It used to be, and that meant a second
   * recorder acquiring an already-live bus whose stream had since dropped got a stale
   * `true` and never marked itself degraded — producing exactly the "quiet list read as a
   * quiet model" this layer exists to prevent.
   */
  ready(): Promise<boolean> {
    if (this.#closed) return Promise.resolve(false);
    if (this.#connected) return Promise.resolve(true);
    return this.#currentAttempt ?? Promise.resolve(false);
  }

  /** Route `sessionId`'s events to `handlers`. Returns the unsubscribe function. */
  subscribe(sessionId: string, handlers: BusHandlers): () => void {
    let set = this.#subs.get(sessionId);
    if (set === undefined) {
      set = new Set();
      this.#subs.set(sessionId, set);
    }
    set.add(handlers);
    // Subscribing to a bus that is already known dead tells the truth at once, rather than
    // leaving the new subscriber to infer silence from an empty trace.
    if (this.#closed) {
      try {
        handlers.onDegraded?.("the event stream for this serve child is already closed");
      } catch {
        /* a subscriber's handler must never break the bus */
      }
    }
    return () => {
      const s = this.#subs.get(sessionId);
      if (s === undefined) return;
      s.delete(handlers);
      if (s.size === 0) this.#subs.delete(sessionId);
    };
  }

  /** Drop one reference; the stream closes when the last holder releases. */
  release(): void {
    this.#refs -= 1;
    if (this.#refs <= 0) this.close();
  }

  /** Close the stream and forget this bus. Idempotent. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#connected = false;
    this.#refs = 0;
    this.#subs.clear();
    try {
      this.#controller?.abort();
    } catch {
      /* best-effort */
    }
    if (buses.get(this.#baseUrl) === this) buses.delete(this.#baseUrl);
    this.#settleAttempt(false);
    this.#currentAttempt = Promise.resolve(false);
  }

  // --- internals ----------------------------------------------------------
  #ensureRunning(): void {
    if (this.#closed || this.#running) return;
    this.#running = true;
    // Created SYNCHRONOUSLY so a `ready()` issued immediately after `acquire()` awaits the
    // real first attempt rather than seeing "no attempt in flight" and reporting false.
    this.#newAttempt();
    // Fire-and-forget: the loop owns its own errors and can never reject into a caller.
    void this.#run();
  }

  /** Start a fresh connect-attempt deferred, failing any prior unsettled one. */
  #newAttempt(): void {
    this.#settleAttempt(false);
    let resolve!: (ok: boolean) => void;
    this.#currentAttempt = new Promise<boolean>((r) => {
      resolve = r;
    });
    this.#resolveAttempt = resolve;
  }

  #settleAttempt(ok: boolean): void {
    const r = this.#resolveAttempt;
    this.#resolveAttempt = undefined;
    r?.(ok);
  }

  #degrade(reason: string): void {
    this.#connected = false;
    for (const set of this.#subs.values()) {
      for (const h of set) {
        try {
          h.onDegraded?.(reason);
        } catch {
          /* a subscriber's handler must never break the bus */
        }
      }
    }
  }

  #deliver(set: Iterable<BusHandlers>, e: ActivityEvent): void {
    for (const h of set) {
      try {
        h.onEvent(e);
      } catch {
        /* a subscriber's handler must never break the bus */
      }
    }
  }

  #dispatch(raw: unknown): void {
    const e = normalizeServeEvent(raw);
    if (e === undefined) return;
    // At `full` detail the recorder wants the raw properties; carry them and let the
    // recorder decide (it is the only place the detail knob is read).
    const props = asRecord(raw).properties;

    // SESSION-LESS EVENTS ARE BROADCAST, NOT DROPPED (probed defect, 1.18.5–1.18.7):
    // `file.edited` carries `properties = {file}` with NO sessionID, so routing it by
    // session dropped every one of them and `filesEdited` was permanently empty against a
    // real opencode. Broadcasting to the serve child's subscribers is right for the normal
    // single-call case and ambiguous for a concurrent panel — so it is FLAGGED
    // `unattributed` rather than silently attributed to whichever member happens to match.
    if (e.sessionId === "") {
      const marked: ActivityEvent = { ...e, detail: props, unattributed: true };
      for (const set of this.#subs.values()) this.#deliver(set, marked);
      return;
    }

    const set = this.#subs.get(e.sessionId);
    if (set === undefined) return;
    this.#deliver(set, { ...e, detail: props });
  }

  async #run(): Promise<void> {
    let attempt = 0;
    let first = true;
    while (!this.#closed) {
      // The first iteration uses the deferred `#ensureRunning` already published; every
      // reconnect publishes a fresh one so `ready()` always describes the CURRENT attempt.
      if (!first) this.#newAttempt();
      first = false;
      const controller = new AbortController();
      this.#controller = controller;
      let attached = false;
      // HEADERS-PHASE DEADLINE: abort if the server accepts the connection but never
      // answers. Cleared as soon as headers arrive, so a healthy idle stream is never cut.
      const headerTimer = setTimeout(() => {
        if (!attached) {
          try {
            controller.abort();
          } catch {
            /* best-effort */
          }
        }
      }, EVENT_HEADERS_TIMEOUT_MS);
      if (typeof headerTimer.unref === "function") headerTimer.unref();
      try {
        const res = await fetch(`${this.#baseUrl}/event`, {
          signal: controller.signal,
          headers: { accept: "text/event-stream" },
        });
        if (!res.ok || res.body === null) {
          throw new Error(`GET /event → ${res.status} ${res.statusText}`);
        }
        attached = true;
        clearTimeout(headerTimer);
        this.#connected = true;
        attempt = 0;
        this.#settleAttempt(true);
        await this.#readStream(res.body);
        // A clean end of stream is still a disconnect (serve restarted, idle-killed, …).
        this.#degrade("event stream ended");
        this.#settleAttempt(false);
      } catch (err) {
        clearTimeout(headerTimer);
        if (this.#closed) break;
        this.#degrade(
          attached
            ? `event stream dropped: ${(err as Error).message}`
            : `could not subscribe to the opencode event stream: ${(err as Error).message}`,
        );
        this.#settleAttempt(false);
      } finally {
        clearTimeout(headerTimer);
      }
      if (this.#closed) break;
      const wait = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)];
      attempt += 1;
      await new Promise((r) => {
        const t = setTimeout(r, wait);
        // Never let a reconnect backoff keep the process alive on its own.
        if (typeof t.unref === "function") t.unref();
      });
    }
    this.#running = false;
    this.#settleAttempt(false);
  }

  /** Parse the `text/event-stream` frames and dispatch each `data:` payload. */
  async #readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      // A peer that never emits a frame boundary must not grow this without bound.
      if (buf.length > MAX_FRAME_BUFFER_BYTES) {
        buf = "";
        this.#degrade(
          `event stream sent over ${MAX_FRAME_BUFFER_BYTES} bytes with no frame boundary — buffer dropped`,
        );
      }
      // SSE frames are separated by a blank line; tolerate CRLF.
      for (;;) {
        const m = /\r?\n\r?\n/.exec(buf);
        if (m === null) break;
        const frame = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const data = frame
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data === "") continue;
        try {
          this.#dispatch(JSON.parse(data));
        } catch {
          /* a malformed frame is dropped, never fatal */
        }
      }
    }
  }
}

/** Close the bus (if any) for a serve child that is going away. Called from
 * `OpencodeLifecycle.shutdown()` — without it, an idle-timeout kill leaves a fetch
 * stream dangling on a dead port. */
export function closeBusesFor(baseUrl: string): void {
  buses.get(baseUrl)?.close();
}

/** Close every live bus. Test/teardown helper. */
export function closeAllBuses(): void {
  for (const bus of [...buses.values()]) bus.close();
}

/** Test/diagnostic: how many buses are live. */
export function liveBusCount(): number {
  return buses.size;
}

/** Resolve `p`, or the sentinel `"timeout"` if it has not settled within `ms`. The timer is
 * unref'd and cleared, so it can neither hold the process open nor fire late. */
async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), ms);
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Recorder — per model call: writes activity.jsonl, keeps the bounded summary
// ---------------------------------------------------------------------------

/** One line of the bounded `structuredContent.activity.first` list. */
export interface ActivityLine {
  ts: number;
  kind: ActivityKind;
  tool?: string;
  summary: string;
}

/** The bounded activity summary attached to a tool result (design §3.2, channel 2). */
export interface ActivitySummary {
  /** Total normalized events observed for this call. */
  events: number;
  /** Tool invocations started (deduped by opencode `callID`). */
  toolCalls: number;
  /** Invocation counts by tool name. */
  byTool: Record<string, number>;
  /**
   * Every distinct path opencode reported edited (capped).
   *
   * PANEL CAVEAT (probed): opencode's `file.edited` event carries no `sessionID`, so it
   * cannot be routed to one member of a concurrent panel. Such events are broadcast to
   * every call on that serve child, which is exact for the normal single-call case and
   * AMBIGUOUS for a panel — a path here may have been edited by a sibling member. (In
   * practice a panel runs the read-only agent and edits nothing; the ambiguity is real
   * whenever two write-capable calls share one serve child.) The per-line record in
   * `activity.jsonl` marks these `unattributed: true`.
   */
  filesEdited: string[];
  /** Failed tool calls and session errors (capped). */
  errors: string[];
  /** The first N action lines, inputs truncated. */
  first: ActivityLine[];
  /** True when more happened than `first`/`filesEdited`/`errors` could hold. */
  truncated: boolean;
  /**
   * The stream was not attached, or dropped mid-turn — so a QUIET activity list here is
   * "we could not see", not "the model did nothing". Never mistake one for the other.
   */
  degraded: boolean;
  degradedReason: string | null;
  /** Where the full line-by-line record was written — null when nothing was written, which
   * covers both "no run dir was available" (`GUILD_LOG=off` mints no run) and "the stream
   * never delivered anything" (see `degraded`). A non-null path always exists on disk. */
  file: string | null;
  detail: ActivityDetail;
}

export interface ActivityContext {
  runId: string;
  callId: string;
  model: string;
  agent: string;
  command: string;
}

const MAX_FIRST_LINES = 20;
const MAX_FILES = 50;
const MAX_ERRORS = 10;
/** Cap on the serialized `detail` blob at `full`, so one enormous tool output cannot
 * turn a line into a multi-megabyte record. */
const MAX_DETAIL_BYTES = 8192;

/**
 * Per-call activity collector. Attaches to the shared bus for one opencode session,
 * appends normalized lines to `<runDir>/activity.jsonl`, keeps the bounded summary, and
 * (optionally) forwards each event to a live sink — the MCP progress notifications.
 *
 * EVERY method is best-effort: a failure here must never surface as a call failure.
 */
export class ActivityRecorder {
  readonly #detail: ActivityDetail;
  readonly #file: string | undefined;
  readonly #ctx: ActivityContext;
  readonly #onEvent: ((e: ActivityEvent) => void) | undefined;

  #bus: ServeEventBus | undefined;
  #unsubscribe: (() => void) | undefined;
  #closed = false;
  /** True once at least one line has actually been appended — `summary().file` reports the
   * path only then, so a path in the result always means "there is a record here". */
  #wrote = false;

  // Summary state.
  #events = 0;
  #toolCalls = 0;
  #byTool: Record<string, number> = {};
  #files: string[] = [];
  #errors: string[] = [];
  #first: ActivityLine[] = [];
  #truncated = false;
  #degraded = false;
  #degradedReason: string | null = null;
  /** Last emitted kind per tool-invocation key, so the repeated `message.part.updated`
   * bursts of one tool call yield ONE `tool-called` and ONE terminal line. */
  #toolState = new Map<string, ActivityKind>();
  /** Keys already counted into `toolCalls`/`byTool`, so a re-emitted `tool-called` can
   * never double-count an invocation. */
  #countedTools = new Set<string>();

  readonly #attachTimeoutMs: number;

  constructor(opts: {
    detail: ActivityDetail;
    file?: string;
    context: ActivityContext;
    onEvent?: (e: ActivityEvent) => void;
    /** Bound on the attach wait. Defaults to `EVENT_HEADERS_TIMEOUT_MS`; overridden only by
     * tests, which cannot afford to spend the real deadline proving it exists. */
    attachTimeoutMs?: number;
  }) {
    this.#detail = opts.detail;
    this.#file = opts.file;
    this.#ctx = opts.context;
    this.#onEvent = opts.onEvent;
    this.#attachTimeoutMs = opts.attachTimeoutMs ?? EVENT_HEADERS_TIMEOUT_MS;
  }

  /**
   * Attach to `sessionId`'s events on the serve child at `baseUrl`. Resolves once the
   * stream is attached (or has definitively failed) so the caller can start the turn
   * knowing early events are not being missed. NEVER throws and never rejects.
   */
  async attach(baseUrl: string, sessionId: string): Promise<() => void> {
    if (this.#closed) return () => {};
    try {
      const bus = ServeEventBus.acquire(baseUrl);
      this.#bus = bus;
      this.#unsubscribe = bus.subscribe(sessionId, {
        onEvent: (e) => this.#handle(e),
        onDegraded: (reason) => this.#markDegraded(reason),
      });
      // BOUNDED WAIT — this is the one await between the caller's session creation and the
      // turn being sent, so it MUST NOT be able to hang. An unbounded `ready()` on a serve
      // that accepts TCP but never answers blocked the whole call forever: outside
      // `GUILD_MESSAGE_TIMEOUT_MS` (which only covers the message POST) and BEFORE the
      // `finally` that deletes the session, so it leaked the session too. Losing visibility
      // is the correct outcome here; losing the call is not.
      const ok = await withDeadline(bus.ready(), this.#attachTimeoutMs);
      if (ok === "timeout") {
        this.#markDegraded(
          `the opencode event stream did not attach within ${this.#attachTimeoutMs}ms — proceeding without live activity`,
        );
      } else if (!ok) {
        this.#markDegraded("the opencode event stream could not be subscribed");
      }
    } catch (err) {
      this.#markDegraded(`activity subscription failed: ${(err as Error).message}`);
    }
    return () => this.close();
  }

  /** Detach from the bus. Idempotent; safe to call from a `finally`. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#unsubscribe?.();
    } catch {
      /* best-effort */
    }
    try {
      this.#bus?.release();
    } catch {
      /* best-effort */
    }
    this.#unsubscribe = undefined;
    this.#bus = undefined;
  }

  /** The bounded summary for `structuredContent.activity`. */
  summary(): ActivitySummary {
    return {
      events: this.#events,
      toolCalls: this.#toolCalls,
      byTool: { ...this.#byTool },
      filesEdited: [...this.#files],
      errors: [...this.#errors],
      first: [...this.#first],
      truncated: this.#truncated,
      degraded: this.#degraded,
      degradedReason: this.#degradedReason,
      // Only once something was actually appended: a path here always means "there is a
      // record at this path", never "this is where a record would have gone".
      file: this.#wrote ? (this.#file ?? null) : null,
      detail: this.#detail,
    };
  }

  // --- internals ----------------------------------------------------------
  #markDegraded(reason: string): void {
    if (this.#closed) return;
    this.#degraded = true;
    // Keep the FIRST reason: it names why visibility was lost, not the latest retry.
    if (this.#degradedReason === null) this.#degradedReason = reason;
  }

  #handle(e: ActivityEvent): void {
    if (this.#closed) return;

    // Text deltas are the stream's bulk (261 of 564 events in the Slice 0 probe) and are
    // not ACTIONS — they are recorded only at `full` detail, where the caller has asked
    // for the raw stream. Dropping them keeps `activity.jsonl` readable at the default.
    if (e.kind === "text-delta" && this.#detail !== "full") return;

    // Dedupe the tool state machine: opencode re-emits `message.part.updated` many times
    // per invocation. The key is opencode's `callID` when present; when it is ABSENT the
    // key falls back to session+tool rather than skipping dedupe entirely — skipping it let
    // repeated updates of one invocation each count as a separate tool call. The fallback's
    // cost, stated: two concurrent invocations of the SAME tool in one session with no
    // callID would collapse into one. `callID` is present on every probed path, so this is
    // the degenerate branch, and under-counting there beats inflating every count.
    let toolKey: string | undefined;
    if (e.kind.startsWith("tool-")) {
      toolKey = e.toolCallId ?? `${e.sessionId}:${e.tool ?? ""}`;
      const last = this.#toolState.get(toolKey);
      if (last === e.kind) return;
      this.#toolState.set(toolKey, e.kind);
    }

    this.#events += 1;
    if (e.kind === "tool-called" && toolKey !== undefined && !this.#countedTools.has(toolKey)) {
      this.#countedTools.add(toolKey);
      this.#toolCalls += 1;
      const tool = e.tool ?? "tool";
      this.#byTool[tool] = (this.#byTool[tool] ?? 0) + 1;
    }
    if (e.kind === "file-edited") {
      const file = e.summary.replace(/^edited /, "");
      if (!this.#files.includes(file)) {
        if (this.#files.length < MAX_FILES) this.#files.push(file);
        else this.#truncated = true;
      }
    }
    if (e.kind === "tool-failed" || e.kind === "session-error") {
      if (this.#errors.length < MAX_ERRORS) this.#errors.push(e.summary);
      else this.#truncated = true;
    }
    if (e.kind !== "text-delta") {
      if (this.#first.length < MAX_FIRST_LINES) {
        const line: ActivityLine = { ts: e.ts, kind: e.kind, summary: e.summary };
        if (e.tool !== undefined) line.tool = e.tool;
        this.#first.push(line);
      } else {
        this.#truncated = true;
      }
    }

    this.#write(e);
    try {
      // Stamp the call's identity on the way OUT to the live sink: the MCP progress channel
      // is shared by a whole panel call, and an event carrying only a session id renders as
      // an anonymous blur. The recorder is the only layer that knows which model this is.
      this.#onEvent?.({ ...e, model: this.#ctx.model, callId: this.#ctx.callId });
    } catch {
      /* a sink failure must never break the recorder */
    }
  }

  /** Append one JSON line. Best-effort by construction: no lock, no throw.
   *
   * WHY NO LOCK (unlike `calls.jsonl`): a panel's members share one run dir, so several
   * recorders append to one `activity.jsonl` concurrently. Each append is a single
   * `O_APPEND` write of one short line, which POSIX serializes between writers — good
   * enough for a best-effort visibility file, and it deliberately avoids contending for
   * the evidence log's lock, where a dropped entry is a reported gap in the AUDIT record.
   */
  #write(e: ActivityEvent): void {
    if (this.#file === undefined) return;
    const line: Record<string, unknown> = {
      ts: new Date(e.ts).toISOString(),
      run_id: this.#ctx.runId,
      call_id: this.#ctx.callId,
      session_id: e.sessionId,
      command: this.#ctx.command,
      model: this.#ctx.model,
      agent: this.#ctx.agent,
      kind: e.kind,
      summary: e.summary,
    };
    if (e.tool !== undefined) line.tool = e.tool;
    if (e.toolCallId !== undefined) line.tool_call_id = e.toolCallId;
    if (e.unattributed === true) line.unattributed = true;
    if (this.#detail === "full" && e.detail !== undefined) {
      line.detail = this.#boundDetail(e.detail);
    }
    try {
      // Create the run dir LAZILY, on the first line that actually exists. Doing it at
      // construction created a directory for every call whether or not anything was ever
      // recorded — including on a fully degraded run, where it left an empty dir and a
      // summary naming a file that was never written.
      if (!this.#wrote) mkdirSync(path.dirname(this.#file), { recursive: true });
      appendFileSync(this.#file, `${JSON.stringify(line)}\n`);
      this.#wrote = true;
    } catch {
      /* the record is best-effort; a write failure never fails the call */
    }
  }

  #boundDetail(detail: unknown): unknown {
    try {
      const json = JSON.stringify(detail);
      if (json === undefined) return null;
      if (json.length <= MAX_DETAIL_BYTES) return detail;
      return { truncated: true, bytes: json.length };
    } catch {
      return { truncated: true, unserializable: true };
    }
  }
}

// ---------------------------------------------------------------------------
// The layer the tools construct once per call
// ---------------------------------------------------------------------------

export interface ActivityLayer {
  readonly enabled: boolean;
  readonly detail: ActivityDetail;
  /** A recorder for one model call, or `undefined` when the layer is off. */
  recorder(ctx: ActivityContext): ActivityRecorder | undefined;
}

export interface ActivityLayerOptions {
  enabled: boolean;
  detail: ActivityDetail;
  /**
   * Resolve the run directory for a run id — normally `EvidenceLog.dir(runId)`. Return
   * `undefined` (or leave unset) to keep the whole layer in memory and write no file.
   * The tools pass `undefined` for an EMPTY run id, which is what `GUILD_LOG=off` yields:
   * a user who turned the record off must not get a different record written instead.
   */
  runDir?: (runId: string) => string | undefined;
  /** Live sink for each normalized event — the MCP progress channel wires this. */
  onEvent?: (e: ActivityEvent) => void;
  /** Test seam: shorten the bounded attach wait. Production uses the default. */
  attachTimeoutMs?: number;
}

export function createActivityLayer(opts: ActivityLayerOptions): ActivityLayer {
  return {
    enabled: opts.enabled,
    detail: opts.detail,
    recorder(ctx: ActivityContext): ActivityRecorder | undefined {
      if (!opts.enabled) return undefined;
      let file: string | undefined;
      // The dir is NOT created here — `ActivityRecorder` mkdirs on its first actual write,
      // so a call that records nothing leaves nothing behind.
      const dir = ctx.runId.length > 0 ? opts.runDir?.(ctx.runId) : undefined;
      if (dir !== undefined && dir.length > 0) file = path.join(dir, ACTIVITY_FILE);
      const recorderOpts: ConstructorParameters<typeof ActivityRecorder>[0] = {
        detail: opts.detail,
        context: ctx,
      };
      if (file !== undefined) recorderOpts.file = file;
      if (opts.onEvent !== undefined) recorderOpts.onEvent = opts.onEvent;
      if (opts.attachTimeoutMs !== undefined) recorderOpts.attachTimeoutMs = opts.attachTimeoutMs;
      return new ActivityRecorder(recorderOpts);
    },
  };
}

