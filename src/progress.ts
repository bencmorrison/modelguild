/**
 * MCP progress notifications (issue #20, slice 3) — the live channel INTO the client.
 *
 * PROBED, not assumed (Slice 0 probe P1, 2026-07-27, Claude Code 2.1.220 / protocol
 * 2025-11-25): Claude Code sends a `progressToken` in the tool-call `_meta` on every call,
 * accepts server-initiated `notifications/progress`, and renders them as ephemeral
 * developer-facing tool progress (`mcp_progress`). They are NOT injected into the model's
 * context — this is a DEVELOPER channel, which is what issue #20 asked for. It is also why
 * `modelguild watch` (slice 2) remains the primary channel: it depends on nothing but a
 * file and a terminal.
 *
 * BONUS, and load-bearing for the 15-minute delegate default: progress notifications feed
 * Claude Code's MCP idle watchdog (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`), so emitting them
 * during a long turn is what keeps a legitimately slow model from being aborted as idle.
 * That is why the emitter also HEARTBEATS through a quiet stretch: a model spending ten
 * minutes inside one `bash` call produces no activity events at all, and silence is exactly
 * the case the watchdog would kill.
 *
 * NO TOKEN, NO NOTIFICATIONS. A client that sent no `progressToken` gets nothing (the spec
 * forbids unsolicited progress), and the tool result is unchanged either way — this channel
 * is strictly additive to `activity.jsonl` and `structuredContent.activity`.
 *
 * THIS LIVES IN ITS OWN MODULE so it can be TESTED. `src/server.ts` constructs the MCP
 * server and connects the stdio transport at module top level, so importing it from a test
 * would start a real server; importing this file starts nothing.
 *
 * NOTHING HERE MAY THROW INTO A TOOL CALL. Every send is wrapped: `sendNotification` can
 * reject (a client that went away) *and* can throw synchronously (a closed transport), and
 * two of the call sites are lethal if it does — the pre-`try` "started" send would turn a
 * notification failure into a tool failure, and a throw inside the heartbeat's `setInterval`
 * would be an unhandled exception that takes the whole server process down.
 */

import type { ActivityEvent } from "./activity.js";

/** Minimum gap between progress notifications: enough to keep a fast tool loop from
 * flooding the client, small enough that the developer sees a live trace. */
export const PROGRESS_MIN_INTERVAL_MS = 1_000;
/** Emit a "still working" tick when nothing else has been sent for this long. */
export const PROGRESS_HEARTBEAT_MS = 60_000;

export interface ProgressEmitter {
  onActivity: (e: ActivityEvent) => void;
  close: () => void;
}

/** The slice of the MCP handler's `extra` this needs — narrowed so the shape is explicit
 * and a test can drive it without a transport. */
export interface ProgressCapableExtra {
  _meta?: { progressToken?: string | number | null } | undefined;
  sendNotification: (n: {
    method: "notifications/progress";
    params: { progressToken: string | number; progress: number; message?: string };
  }) => Promise<void>;
}

/** Test seam: shorten the intervals without waiting a minute for a heartbeat. */
export interface ProgressTuning {
  minIntervalMs?: number;
  heartbeatMs?: number;
}

/** `openai/gpt-5.5` → `gpt-5.5`. Progress lines are narrow; the provider prefix is the
 * least informative half and the model name is what distinguishes panel members. */
function shortModel(model: string): string {
  const i = model.lastIndexOf("/");
  return i === -1 ? model : model.slice(i + 1);
}

/**
 * Build the per-call progress emitter, or `undefined` when the client sent no usable token.
 *
 * THROTTLING, precisely: the first event sends immediately; afterwards at most one
 * notification per `minIntervalMs`. An event arriving inside a window replaces whatever was
 * being held, and the HELD one is flushed when the window closes — so the developer always
 * sees the most recent thing that happened rather than a stale one, and a burst of 40 tool
 * updates collapses to a readable trickle. Intermediate events inside a window are NOT sent
 * on this channel; every one of them is in `activity.jsonl`, which is the complete record.
 */
export function makeProgressEmitter(
  extra: ProgressCapableExtra,
  label: string,
  tuning: ProgressTuning = {},
): ProgressEmitter | undefined {
  const token = extra?._meta?.progressToken;
  // `== null` in explicit form: a client that sends `progressToken: null` must be treated as
  // "no token", not as a token — emitting `progressToken: null` is a protocol violation.
  if (token === undefined || token === null) return undefined;

  const minIntervalMs = tuning.minIntervalMs ?? PROGRESS_MIN_INTERVAL_MS;
  const heartbeatMs = tuning.heartbeatMs ?? PROGRESS_HEARTBEAT_MS;

  let progress = 0;
  let lastSentAt = 0;
  let pending: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  const send = (message: string): void => {
    if (closed) return;
    // The whole body is guarded, not just the promise: `sendNotification` may throw
    // SYNCHRONOUSLY on a closed transport, and this is called from a `setInterval` callback
    // and from before the tool's own try — either would be fatal unguarded.
    try {
      lastSentAt = Date.now();
      progress += 1;
      void extra
        .sendNotification({
          method: "notifications/progress",
          params: { progressToken: token, progress, message },
        })
        .catch(() => {});
    } catch {
      /* a notification failure is never a tool failure */
    }
  };

  const flush = (): void => {
    timer = undefined;
    if (closed || pending === undefined) return;
    const msg = pending;
    pending = undefined;
    send(msg);
  };

  const heartbeat = setInterval(() => {
    if (closed) return;
    if (Date.now() - lastSentAt >= heartbeatMs) send(`${label}: still working…`);
  }, heartbeatMs);
  // Never let the heartbeat alone hold the process open.
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  send(`${label}: started`);

  return {
    onActivity: (e: ActivityEvent) => {
      if (closed) return;
      // Name the model when the recorder supplied one: a `guild_panel` call shares ONE
      // progress token across every member, so an unlabelled line is an anonymous blur.
      const who = e.model !== undefined && e.model.length > 0 ? ` [${shortModel(e.model)}]` : "";
      const message = `${label}${who}: ${e.summary}`;
      const since = Date.now() - lastSentAt;
      if (since >= minIntervalMs) {
        send(message);
        return;
      }
      pending = message;
      if (timer === undefined) {
        timer = setTimeout(flush, minIntervalMs - since);
        if (typeof timer.unref === "function") timer.unref();
      }
    },
    close: () => {
      if (closed) return;
      // Flush whatever the last window was holding, then stop.
      if (pending !== undefined) {
        const msg = pending;
        pending = undefined;
        send(msg);
      }
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      clearInterval(heartbeat);
    },
  };
}

/** Run a tool call with a progress emitter attached, closing it on every path. */
export async function withProgress<T>(
  extra: ProgressCapableExtra,
  label: string,
  fn: (onActivity?: (e: ActivityEvent) => void) => Promise<T>,
  tuning?: ProgressTuning,
): Promise<T> {
  const emitter = makeProgressEmitter(extra, label, tuning);
  try {
    return await fn(emitter?.onActivity);
  } finally {
    try {
      emitter?.close();
    } catch {
      /* closing the visibility channel must not mask the tool's own outcome */
    }
  }
}
