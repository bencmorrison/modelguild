/**
 * Live-activity layer tests (issue #20, slices 1–2) — OFFLINE.
 *
 * No model is called and no `opencode` binary is spawned: the `GET /event` stream is
 * served by the in-process `node:http` fake (`test/fake-opencode-server.ts`), scripted
 * with RAW opencode-shaped `{type, properties}` frames. That is deliberate — the frames
 * below are the shapes the Slice 0 probe actually observed on opencode 1.18.5
 * (`message.part.updated` with `part.type === "tool"` walking pending → running →
 * completed, `file.edited`, `session.idle`, and the high-volume `message.part.delta`),
 * NOT a convenience shape of our own invention. A normalizer that only passes against
 * shapes we made up proves nothing about the product.
 *
 * What is pinned here:
 *   1. the normalizer's event mapping, including that UNKNOWN types are dropped silently;
 *   2. knob resolution (env > conf > default; default ON / `summary`);
 *   3. bus routing by `sessionID` + refcounted single subscription per serve child;
 *   4. end-to-end through `askViaAgent`: `activity.jsonl` written, summary bounded,
 *      pending→running→completed deduped to one `tool-called` + one terminal line;
 *   5. `GUILD_ACTIVITY=off` opens NO subscription and attaches NO summary;
 *   6. a stream that cannot attach degrades (`activity.degraded`) and the call still
 *      SUCCEEDS — a visibility failure is never a call failure;
 *   7. the evidence log is untouched: `calls.jsonl` still verifies, and `activity.jsonl`
 *      is an unreferenced sibling `verify()` never reads;
 *   8. `modelguild watch --no-follow` renders a run's activity.
 */

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  normalizeServeEvent,
  summarizeToolInput,
  createActivityLayer,
  ServeEventBus,
  closeBusesFor,
  closeAllBuses,
  liveBusCount,
  type ActivityEvent,
} from "../src/activity.js";
import { makeProgressEmitter, withProgress, type ProgressCapableExtra } from "../src/progress.js";
import { panel } from "../src/panel.js";
import { resolveActivitySettings } from "../src/config.js";
import { askViaAgent, type ServeProvider } from "../src/client.js";
import { consult } from "../src/consult.js";
import { delegate } from "../src/delegate.js";
import { EvidenceLog } from "../src/log.js";
import { runWatch, formatActivityLine } from "../src/cli.js";
import { startFakeOpencode, type FakeOpencode } from "./fake-opencode-server.js";
import type { ServeHandle } from "../src/lifecycle.js";
import { Checker, withTimeout } from "./harness.js";

function fakeServe(fake: FakeOpencode): ServeProvider {
  const handle: ServeHandle = { baseUrl: fake.baseUrl, port: 0, pid: 0 };
  return { withServe: (fn) => fn(handle) };
}

const tmpDirs: string[] = [];
function tmp(prefix = "act-"): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function envWith(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith("GUILD_")) delete base[k];
  return { ...base, ...overrides };
}

/** An agent-def dir containing the named hardened defs so the presence gate passes. */
function defDirWith(...agents: string[]): string {
  const dir = tmp("act-agent-");
  for (const a of agents) writeFileSync(path.join(dir, `${a}.md`), "---\nmode: all\n---\nfake\n");
  return dir;
}

/** One tool part frame, exactly as `message.part.updated` carries it (probed shape). */
function toolPart(
  sessionID: string,
  callID: string,
  tool: string,
  state: Record<string, unknown>,
): unknown {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: `prt_${callID}`,
        sessionID,
        messageID: "msg_1",
        type: "tool",
        callID,
        tool,
        state,
      },
    },
  };
}

/**
 * The scripted turn used by the end-to-end cases — written from the PROBED payloads, not
 * from the design's event table. Two details here are load-bearing and were both wrong in
 * the first version of this fixture, which is exactly why the production defects they model
 * shipped green:
 *   - `pending` carries `input: {}` (the real input only arrives on `running`);
 *   - `file.edited` carries `{file}` and NO `sessionID`.
 */
function scriptFor(sessionID: string): unknown[] {
  return [
    // Probed: pending has an EMPTY input object, not the real one.
    toolPart(sessionID, "c1", "read", { status: "pending", input: {} }),
    toolPart(sessionID, "c1", "read", { status: "running", input: { filePath: "src/foo.ts" } }),
    toolPart(sessionID, "c1", "read", {
      status: "completed",
      input: { filePath: "src/foo.ts" },
      output: "FILE BODY",
    }),
    { type: "message.part.delta", properties: { sessionID, delta: "thinking…" } },
    toolPart(sessionID, "c2", "bash", { status: "pending", input: {} }),
    toolPart(sessionID, "c2", "bash", { status: "running", input: { command: "npm test" } }),
    // opencode re-emits a running part as input streams; the recorder must not double-count.
    toolPart(sessionID, "c2", "bash", { status: "running", input: { command: "npm test" } }),
    toolPart(sessionID, "c2", "bash", {
      status: "completed",
      input: { command: "npm test" },
      output: "ok",
      metadata: { exit: 0 },
    }),
    // Probed: NO sessionID on file.edited. Routing this by session dropped it entirely.
    { type: "file.edited", properties: { file: "src/foo.ts" } },
    // Unknown / uninteresting types the normalizer must drop silently.
    { type: "server.heartbeat", properties: { sessionID } },
    { type: "session.status", properties: { sessionID, status: "busy" } },
    { type: "some.future.event.opencode.adds", properties: { sessionID, whatever: true } },
    { type: "session.idle", properties: { sessionID } },
  ];
}

function readActivity(file: string): Array<Record<string, unknown>> {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

export async function run(): Promise<number> {
  const c = new Checker();
  console.log("== activity.test (issue #20 live visibility) ==");

  // -------------------------------------------------------------------------
  // 1. The normalizer — built on the PROBED event set.
  // -------------------------------------------------------------------------
  {
    // PROBED (1.18.7): `pending` carries `input: {}`, so it can never show the command.
    // It is dropped; `running` is the tool-called event.
    c.check(
      normalizeServeEvent(toolPart("ses_1", "c1", "read", { status: "pending", input: {} })) ===
        undefined,
      "normalize: tool pending is DROPPED (it carries input:{} and would hide the command)",
    );

    const running = normalizeServeEvent(
      toolPart("ses_1", "c1", "bash", { status: "running", input: { command: "npm test" } }),
    );
    c.check(running?.kind === "tool-called", "normalize: tool running → tool-called");
    c.check(running?.sessionId === "ses_1", "normalize: routes on part.sessionID");
    c.check(running?.toolCallId === "c1", "normalize: carries opencode's callID");
    c.check(
      running?.summary === "bash: npm test",
      `normalize: summary renders the command (got '${running?.summary}')`,
    );

    const done = normalizeServeEvent(
      toolPart("ses_1", "c1", "bash", {
        status: "completed",
        input: { command: "npm test" },
        output: "ok",
        metadata: { exit: 0 },
      }),
    );
    c.check(done?.kind === "tool-succeeded", "normalize: completed → tool-succeeded");
    c.check(
      (done?.summary ?? "").includes("exit 0"),
      `normalize: success summary carries metadata.exit (got '${done?.summary}')`,
    );

    const failed = normalizeServeEvent(
      toolPart("ses_1", "c1", "edit", { status: "error", error: "permission denied" }),
    );
    c.check(failed?.kind === "tool-failed", "normalize: error → tool-failed");
    c.check(
      (failed?.summary ?? "").includes("permission denied"),
      "normalize: failure summary carries the error",
    );

    // A NON-tool part of message.part.updated is not activity.
    c.check(
      normalizeServeEvent({
        type: "message.part.updated",
        properties: { part: { sessionID: "ses_1", type: "text", text: "hi" } },
      }) === undefined,
      "normalize: a text part of message.part.updated is dropped",
    );

    // PROBED: file.edited carries {file} ONLY — no sessionID. It must still normalize (the
    // BUS is what decides how to route a session-less event), or filesEdited is always empty.
    const edited = normalizeServeEvent({ type: "file.edited", properties: { file: "a.ts" } });
    c.check(edited?.kind === "file-edited", "normalize: file.edited (no sessionID) → file-edited");
    c.check(edited?.sessionId === "", "normalize: a session-less event normalizes with sessionId ''");
    c.check(
      normalizeServeEvent({ type: "session.idle", properties: { sessionID: "s" } })?.kind ===
        "session-idle",
      "normalize: session.idle → session-idle",
    );
    c.check(
      normalizeServeEvent({
        type: "session.error",
        properties: { sessionID: "s", error: { message: "boom" } },
      })?.kind === "session-error",
      "normalize: session.error → session-error",
    );
    c.check(
      normalizeServeEvent({
        type: "permission.asked",
        properties: { sessionID: "s", permission: "bash" },
      })?.kind === "permission-asked",
      "normalize: permission.asked → permission-asked",
    );
    c.check(
      normalizeServeEvent({ type: "message.part.delta", properties: { sessionID: "s", delta: "x" } })
        ?.kind === "text-delta",
      "normalize: message.part.delta → text-delta",
    );
    // The design's §2 names, which never fired on 1.18.5 but exist in opencode's union.
    c.check(
      normalizeServeEvent({
        type: "session.next.tool.called",
        properties: { sessionID: "s", callID: "z", tool: "grep", input: { pattern: "foo" } },
      })?.kind === "tool-called",
      "normalize: still understands the unobserved session.next.tool.called name",
    );

    // FORWARD COMPATIBILITY: unknown types are dropped, never thrown on.
    for (const junk of [
      { type: "server.heartbeat", properties: {} },
      { type: "session.updated", properties: { sessionID: "s" } },
      { type: "totally.new.event", properties: { sessionID: "s" } },
      { notAnEvent: true },
      null,
      "a string",
      42,
    ]) {
      if (normalizeServeEvent(junk) !== undefined) {
        c.check(false, `normalize: unknown payload ${JSON.stringify(junk)} should be dropped`);
      }
    }
    c.check(true, "normalize: unknown/malformed payloads are dropped silently (no throw)");

    c.check(
      summarizeToolInput({ command: "a".repeat(500) }, 40).endsWith("…"),
      "normalize: tool input is truncated at the summary tier",
    );
    c.check(
      summarizeToolInput({ command: "line one\nline two" }) === "line one line two",
      "normalize: tool input is flattened to one line",
    );
    c.check(
      summarizeToolInput({}) === "",
      "normalize: an EMPTY input object renders as no input, not the literal '{}'",
    );
    c.check(
      normalizeServeEvent(
        toolPart("s", "c", "bash", { status: "completed", input: {}, metadata: { exit: 0 } }),
      )?.summary === "bash ok (exit 0)",
      "normalize: the clean no-input branch fires for an empty input object",
    );
  }

  // -------------------------------------------------------------------------
  // 2. Knobs: default ON / `summary`; env > conf > default; only literal `off`/`full` bite.
  // -------------------------------------------------------------------------
  {
    const d = resolveActivitySettings({ env: envWith({}), confContents: "" });
    c.check(d.enabled === true, "knobs: GUILD_ACTIVITY defaults ON");
    c.check(d.detail === "summary", "knobs: GUILD_ACTIVITY_DETAIL defaults to summary");

    c.check(
      resolveActivitySettings({ env: envWith({ GUILD_ACTIVITY: "off" }) }).enabled === false,
      "knobs: GUILD_ACTIVITY=off disables",
    );
    c.check(
      resolveActivitySettings({ env: envWith({ GUILD_ACTIVITY: "OFF" }) }).enabled === false,
      "knobs: the off test is case-insensitive",
    );
    c.check(
      resolveActivitySettings({ env: envWith({ GUILD_ACTIVITY: "nonsense" }) }).enabled === true,
      "knobs: a typo fails toward recording, not toward silence",
    );
    c.check(
      resolveActivitySettings({ env: envWith({}), confContents: "GUILD_ACTIVITY=off\n" }).enabled ===
        false,
      "knobs: conf can disable",
    );
    c.check(
      resolveActivitySettings({
        env: envWith({ GUILD_ACTIVITY: "on" }),
        confContents: "GUILD_ACTIVITY=off\n",
      }).enabled === true,
      "knobs: env OVERRIDES conf (C35 order)",
    );
    c.check(
      resolveActivitySettings({ env: envWith({}), confContents: "GUILD_ACTIVITY_DETAIL=full\n" })
        .detail === "full",
      "knobs: conf GUILD_ACTIVITY_DETAIL=full binds",
    );
    c.check(
      resolveActivitySettings({ env: envWith({ GUILD_ACTIVITY_DETAIL: "verbose" }) }).detail ===
        "summary",
      "knobs: an unrecognized detail resolves to summary",
    );
  }

  // -------------------------------------------------------------------------
  // 3. Bus: ONE subscription per serve child, routed by sessionID, refcounted.
  // -------------------------------------------------------------------------
  {
    const fake = await startFakeOpencode({ historyText: "unused" });
    try {
      const a: ActivityEvent[] = [];
      const b: ActivityEvent[] = [];
      const bus1 = ServeEventBus.acquire(fake.baseUrl);
      const bus2 = ServeEventBus.acquire(fake.baseUrl);
      c.check(bus1 === bus2, "bus: acquire returns ONE bus per baseUrl");
      c.check(bus1.refs === 2, "bus: references are counted");
      const off1 = bus1.subscribe("ses_a", { onEvent: (e) => a.push(e) });
      const off2 = bus2.subscribe("ses_b", { onEvent: (e) => b.push(e) });
      c.check((await bus1.ready()) === true, "bus: the stream attaches");
      c.check(fake.recorded.eventSubscribes === 1, "bus: exactly ONE GET /event for two holders");

      fake.emit(toolPart("ses_a", "x1", "read", { status: "running", input: { filePath: "a.ts" } }));
      fake.emit(toolPart("ses_b", "y1", "bash", { status: "running", input: { command: "ls" } }));
      fake.emit(toolPart("ses_c", "z1", "grep", { status: "running", input: { pattern: "q" } }));
      // Give the stream a beat to deliver.
      await new Promise((r) => setTimeout(r, 150));

      c.check(a.length === 1 && a[0].tool === "read", "bus: session A saw only its own event");
      c.check(b.length === 1 && b[0].tool === "bash", "bus: session B saw only its own event");
      c.check(
        a.every((e) => e.sessionId === "ses_a") && b.every((e) => e.sessionId === "ses_b"),
        "bus: an unsubscribed session's events reach nobody",
      );

      off1();
      bus1.release();
      c.check(liveBusCount() === 1, "bus: still live while one holder remains");
      off2();
      bus2.release();
      c.check(liveBusCount() === 0, "bus: the LAST release closes and forgets the bus");
    } finally {
      closeAllBuses();
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 4. End to end through askViaAgent: the file, the dedupe, the bounded summary.
  // -------------------------------------------------------------------------
  {
    const runDir = tmp("act-run-");
    const fake = await startFakeOpencode({
      historyText: "the answer",
      sessionId: "ses_e2e",
      eventScript: scriptFor("ses_e2e"),
    });
    try {
      const layer = createActivityLayer({
        enabled: true,
        detail: "summary",
        runDir: () => runDir,
      });
      const rec = layer.recorder({
        runId: "run-1",
        callId: "call-abc123",
        model: "openai/gpt-fake",
        agent: "guild-read",
        command: "/guild:consult",
      });
      c.check(rec !== undefined, "e2e: an enabled layer mints a recorder");
      const res = await askViaAgent(fakeServe(fake), {
        agent: "guild-read",
        prompt: "q",
        activity: rec!,
      });
      c.check(res.text === "the answer", "e2e: the turn is unaffected by the activity layer");

      const s = rec!.summary();
      c.check(s.degraded === false, "e2e: not degraded — the stream attached");
      c.check(s.toolCalls === 2, `e2e: two tool calls counted (got ${s.toolCalls})`);
      c.check(
        s.byTool.read === 1 && s.byTool.bash === 1,
        `e2e: counts by tool (${JSON.stringify(s.byTool)})`,
      );
      c.check(
        s.filesEdited.length === 1 && s.filesEdited[0] === "src/foo.ts",
        "e2e: every file.edited path is surfaced",
      );
      c.check(s.errors.length === 0, "e2e: no errors on a clean turn");
      c.check(s.file === path.join(runDir, "activity.jsonl"), "e2e: the summary names the file");

      const lines = readActivity(path.join(runDir, "activity.jsonl"));
      const kinds = lines.map((l) => l.kind);
      c.check(
        kinds.filter((k) => k === "tool-called").length === 2,
        `e2e: repeated part updates dedupe to ONE tool-called per callID (got ${JSON.stringify(kinds)})`,
      );
      const called = lines.filter((l) => l.kind === "tool-called");
      c.check(
        called.some((l) => l.summary === "bash: npm test"),
        `e2e: the LIVE tool-called line carries the command, not '{}' (got ${JSON.stringify(called.map((l) => l.summary))})`,
      );
      c.check(
        !called.some((l) => String(l.summary).includes("{}")),
        "e2e: no line renders an empty input as '{}'",
      );
      c.check(
        lines.some((l) => l.kind === "file-edited" && l.unattributed === true),
        "e2e: the session-less file.edited event is recorded and FLAGGED unattributed",
      );
      c.check(
        kinds.filter((k) => k === "tool-succeeded").length === 2,
        "e2e: one terminal line per tool call",
      );
      c.check(!kinds.includes("text-delta"), "e2e: text deltas are NOT recorded at summary detail");
      c.check(kinds.includes("session-idle"), "e2e: session.idle is recorded");
      c.check(
        lines.every(
          (l) =>
            l.run_id === "run-1" &&
            l.call_id === "call-abc123" &&
            l.model === "openai/gpt-fake" &&
            l.agent === "guild-read",
        ),
        "e2e: every line carries run/call/model/agent attribution",
      );
      c.check(
        lines.every((l) => l.detail === undefined),
        "e2e: summary detail records NO raw properties",
      );
      c.check(
        typeof lines[0].ts === "string" && !Number.isNaN(new Date(lines[0].ts as string).getTime()),
        "e2e: lines carry an ISO timestamp",
      );
      rec!.close();
      c.check(liveBusCount() === 0, "e2e: closing the recorder releases the bus");
    } finally {
      closeAllBuses();
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 5. `full` detail: raw properties are recorded, text deltas included.
  // -------------------------------------------------------------------------
  {
    const runDir = tmp("act-full-");
    const fake = await startFakeOpencode({
      historyText: "x",
      sessionId: "ses_full",
      eventScript: scriptFor("ses_full"),
    });
    try {
      const layer = createActivityLayer({ enabled: true, detail: "full", runDir: () => runDir });
      const rec = layer.recorder({
        runId: "run-2",
        callId: "call-full",
        model: "m",
        agent: "guild-read",
        command: "/guild:consult",
      });
      await askViaAgent(fakeServe(fake), { agent: "guild-read", prompt: "q", activity: rec! });
      const lines = readActivity(path.join(runDir, "activity.jsonl"));
      c.check(
        lines.some((l) => l.kind === "text-delta"),
        "full: text deltas ARE recorded at full detail",
      );
      c.check(
        lines.some((l) => l.detail !== undefined),
        "full: raw event properties are recorded",
      );
      rec!.close();
    } finally {
      closeAllBuses();
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 6. Degraded: an unreachable event stream never fails the call.
  // -------------------------------------------------------------------------
  {
    const runDir = tmp("act-degraded-");
    const fake = await startFakeOpencode({
      historyText: "answered anyway",
      sessionId: "ses_deg",
      failEvents: true,
    });
    try {
      const layer = createActivityLayer({
        enabled: true,
        detail: "summary",
        runDir: () => runDir,
      });
      const rec = layer.recorder({
        runId: "run-3",
        callId: "call-deg",
        model: "m",
        agent: "guild-read",
        command: "/guild:consult",
      });
      const res = await askViaAgent(fakeServe(fake), {
        agent: "guild-read",
        prompt: "q",
        activity: rec!,
      });
      c.check(res.text === "answered anyway", "degraded: the call SUCCEEDS despite no stream");
      const s = rec!.summary();
      c.check(s.degraded === true, "degraded: the summary says visibility was lost");
      c.check(
        typeof s.degradedReason === "string" && s.degradedReason.length > 0,
        "degraded: a reason is named, so a quiet list is not read as a quiet model",
      );
      c.check(s.events === 0, "degraded: no events were observed");
      rec!.close();
    } finally {
      closeAllBuses();
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 7. Through guild_consult: structuredContent.activity, evidence log untouched,
  //    and the run still VERIFIES with activity.jsonl sitting beside calls.jsonl.
  // -------------------------------------------------------------------------
  {
    const root = tmp("act-guild-");
    const logDir = tmp("act-logs-");
    const env = envWith({
      GUILD_ROOT: root,
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDirWith("guild-read"),
    });
    const fake = await startFakeOpencode({
      historyText: "consulted answer",
      sessionId: "ses_consult",
      eventScript: scriptFor("ses_consult"),
    });
    try {
      const r = await consult(
        { question: "q", model: "openai/allowed" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(r.ok, "consult: the call succeeded");
      if (r.ok) {
        c.check(r.activity !== undefined, "consult: an activity summary is attached");
        c.check(r.activity?.toolCalls === 2, "consult: the summary counted the tool calls");
        const runId = r.attribution.runId;
        const dir = path.join(logDir, runId);
        c.check(
          existsSync(path.join(dir, "activity.jsonl")),
          "consult: activity.jsonl lands in the run dir",
        );
        const verdict = new EvidenceLog({ env }).verify(runId);
        c.check(
          verdict.code === 0,
          `consult: the run still VERIFIES with activity.jsonl beside it (${verdict.code})`,
        );
        const calls = readFileSync(path.join(dir, "calls.jsonl"), "utf8");
        c.check(
          !calls.includes("activity"),
          "consult: no calls.jsonl entry references or embeds activity (no entry-shape change)",
        );
      }
    } finally {
      closeAllBuses();
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 8. GUILD_ACTIVITY=off: NO subscription is opened, no file, no summary.
  // -------------------------------------------------------------------------
  {
    const root = tmp("act-off-");
    const logDir = tmp("act-offlogs-");
    const env = envWith({
      GUILD_ROOT: root,
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDirWith("guild-read"),
      GUILD_ACTIVITY: "off",
    });
    const fake = await startFakeOpencode({
      historyText: "quiet answer",
      sessionId: "ses_off",
      eventScript: scriptFor("ses_off"),
    });
    try {
      const r = await consult(
        { question: "q", model: "openai/allowed" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(r.ok, "off: the call succeeded");
      if (r.ok) {
        c.check(r.activity === undefined, "off: no activity summary is attached");
        c.check(
          !existsSync(path.join(logDir, r.attribution.runId, "activity.jsonl")),
          "off: no activity.jsonl is written",
        );
      }
      c.check(
        fake.recorded.eventSubscribes === 0,
        "off: NO GET /event subscription was opened at all",
      );
    } finally {
      closeAllBuses();
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 9. The delegate path — the black box issue #20 was filed about — carries activity on
  //    its result, and a delegate's edits show up as actions.
  // -------------------------------------------------------------------------
  {
    const root = tmp("act-del-");
    const logDir = tmp("act-dellogs-");
    const repo = tmp("act-delrepo-");
    const env = envWith({
      GUILD_ROOT: root,
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDirWith("guild-build"),
    });
    const fake = await startFakeOpencode({
      historyText: "I edited src/foo.ts",
      sessionId: "ses_del",
      eventScript: scriptFor("ses_del"),
    });
    try {
      const r = await delegate(
        { task: "edit foo", model: "openai/allowed" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000, repoDir: repo },
      );
      c.check(r.ok, "delegate: the call succeeded");
      if (r.ok) {
        c.check(r.activity !== undefined, "delegate: activity is attached to the result");
        c.check(
          (r.activity?.first ?? []).some((l) => l.tool === "bash"),
          "delegate: the shell command the model ran is visible in the trace",
        );
        c.check(
          r.activity?.filesEdited.includes("src/foo.ts") === true,
          "delegate: the edited path is visible in the trace",
        );
      }
    } finally {
      closeAllBuses();
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 10. `modelguild watch` renders a run (slice 2).
  // -------------------------------------------------------------------------
  {
    const guildRoot = tmp("act-watch-");
    const logDir = path.join(guildRoot, "logs");
    const runId = "20260727T000000Z-abcdef";
    mkdirSync(path.join(logDir, runId), { recursive: true });
    writeFileSync(
      path.join(logDir, runId, "activity.jsonl"),
      [
        JSON.stringify({
          ts: "2026-07-27T01:02:03Z",
          run_id: runId,
          call_id: "call-deadbeef",
          command: "/guild:delegate",
          model: "openai/gpt-fake",
          agent: "guild-build",
          kind: "tool-called",
          tool: "bash",
          summary: "bash: npm test",
        }),
        JSON.stringify({
          ts: "2026-07-27T01:02:05Z",
          run_id: runId,
          call_id: "call-deadbeef",
          kind: "file-edited",
          summary: "edited src/foo.ts",
        }),
        "{ this is not json",
      ].join("\n") + "\n",
    );
    const env = envWith({ GUILD_ROOT: guildRoot, GUILD_LOG_DIR: logDir });
    const printed: string[] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]) => {
      printed.push(a.map(String).join(" "));
    };
    let code: number;
    try {
      code = await runWatch(["--run", runId, "--no-follow"], { env });
    } finally {
      console.log = realLog;
    }
    const out = printed.join("\n");
    c.check(code === 0, "watch: --no-follow exits 0");
    c.check(out.includes(runId), "watch: names the run it is tailing");
    c.check(out.includes("bash: npm test"), "watch: renders the tool call");
    c.check(out.includes("edited src/foo.ts"), "watch: renders the edit");
    c.check(
      out.includes("/guild:delegate") && out.includes("openai/gpt-fake"),
      "watch: banners the call's command/model so a panel's members stay attributable",
    );
    c.check(
      out.includes("{ this is not json"),
      "watch: shows an unparseable line verbatim rather than hiding it",
    );

    // A bad argument is a usage error, not a silent default.
    const realErr = console.error;
    console.error = () => {};
    let badCode: number;
    try {
      badCode = await runWatch(["--nonsense"], { env });
    } finally {
      console.error = realErr;
    }
    c.check(badCode === 2, "watch: an unknown argument exits 2");

    // Issue #73: `--run` is the ONE run id a human types by hand, and it is joined onto
    // the logs root to build the file this tails — so it goes through the same grammar
    // the evidence layer enforces, and a traversal is a usage error rather than a tail
    // of some path outside the root.
    const errs: string[] = [];
    console.error = (...a: unknown[]) => {
      errs.push(a.map(String).join(" "));
    };
    let traversalCode: number;
    try {
      traversalCode = await runWatch(["--run", "../../../etc", "--no-follow"], { env });
    } finally {
      console.error = realErr;
    }
    c.check(
      traversalCode === 2 && errs.join("\n").includes("single path segment"),
      "#73 watch: --run with a traversing run id exits 2 and states the rule",
    );

    // F8: this is the surface a run id gets PASTED into, so surrounding whitespace off a
    // copied log line is trimmed rather than rejected as an invisible charset error.
    const pastedOut: string[] = [];
    console.log = (...a: unknown[]) => {
      pastedOut.push(a.map(String).join(" "));
    };
    let pastedCode: number;
    try {
      pastedCode = await runWatch(["--run", `  ${runId}\n`, "--no-follow"], { env });
    } finally {
      console.log = realLog;
    }
    c.check(
      pastedCode === 0 && pastedOut.join("\n").includes(runId),
      "#73 watch: a PASTED run id with surrounding whitespace is trimmed, not rejected",
    );

    // The banner is emitted once per call id.
    const seen = new Set<string>();
    const line = JSON.stringify({ ts: "2026-07-27T01:02:03Z", call_id: "call-x", kind: "tool-called", summary: "s" });
    c.check(formatActivityLine(line, seen).length === 2, "watch: first line of a call banners it");
    c.check(formatActivityLine(line, seen).length === 1, "watch: later lines of the same call do not");
  }

  // -------------------------------------------------------------------------
  // 11. BLOCKER: attach() must never hang the call. A serve that accepts the connection
  //     and never answers used to wedge the turn forever — outside GUILD_MESSAGE_TIMEOUT_MS
  //     (which only bounds the message POST) and BEFORE the finally that deletes the
  //     session, so it leaked the session too.
  // -------------------------------------------------------------------------
  {
    const fake = await startFakeOpencode({
      historyText: "answered despite the black hole",
      sessionId: "ses_hang",
      hangEvents: true,
    });
    try {
      const layer = createActivityLayer({
        enabled: true,
        detail: "summary",
        attachTimeoutMs: 200,
      });
      const rec = layer.recorder({
        runId: "run-hang",
        callId: "call-hang",
        model: "m",
        agent: "guild-read",
        command: "/guild:consult",
      });
      const t0 = Date.now();
      const res = await withTimeout(
        askViaAgent(fakeServe(fake), { agent: "guild-read", prompt: "q", activity: rec! }),
        8_000,
        "black-hole attach",
      );
      const elapsed = Date.now() - t0;
      c.check(res.text === "answered despite the black hole", "hang: the call COMPLETES");
      c.check(elapsed < 5_000, `hang: it is not blocked on the stream (took ${elapsed}ms)`);
      const s = rec!.summary();
      c.check(s.degraded === true, "hang: the summary reports degraded");
      c.check(
        (s.degradedReason ?? "").includes("did not attach"),
        `hang: the reason names the attach deadline (got '${s.degradedReason}')`,
      );
      c.check(fake.recorded.deletes.length === 1, "hang: the session was still deleted (no leak)");
      rec!.close();
    } finally {
      closeAllBuses();
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 12. BLOCKER: ready() must reflect CURRENT state. A second recorder acquiring an
  //     already-live bus whose stream has since dropped used to get the stale first-attempt
  //     `true` and never degrade — the exact "quiet list read as a quiet model" this layer
  //     exists to prevent.
  // -------------------------------------------------------------------------
  {
    const fake = await startFakeOpencode({ historyText: "unused", sessionId: "ses_stale" });
    try {
      const first = ServeEventBus.acquire(fake.baseUrl);
      const off = first.subscribe("ses_a", { onEvent: () => {} });
      c.check((await first.ready()) === true, "stale: the first attach succeeds");

      // Kill the server out from under the live bus, then wait past its reconnect backoff
      // so the bus is genuinely disconnected.
      await fake.close();
      await new Promise((r) => setTimeout(r, 600));
      c.check(first.connected === false, "stale: the bus knows the stream is gone");
      c.check((await first.ready()) === false, "stale: ready() reports the CURRENT state, not the first attempt");

      // A recorder attaching now must degrade rather than believe the stale success.
      const layer = createActivityLayer({ enabled: true, detail: "summary", attachTimeoutMs: 300 });
      const rec = layer.recorder({
        runId: "r",
        callId: "c",
        model: "m",
        agent: "guild-read",
        command: "/guild:consult",
      });
      await rec!.attach(fake.baseUrl, "ses_b");
      c.check(rec!.summary().degraded === true, "stale: a recorder attaching to a dead bus DEGRADES");
      rec!.close();
      off();
      first.release();
    } finally {
      closeAllBuses();
    }
  }

  // -------------------------------------------------------------------------
  // 13. Attach, then the stream DROPS mid-turn: degraded latches, the call still succeeds.
  // -------------------------------------------------------------------------
  {
    const fake = await startFakeOpencode({
      historyText: "finished anyway",
      sessionId: "ses_drop",
      messageDelayMs: 400,
    });
    try {
      const layer = createActivityLayer({ enabled: true, detail: "summary" });
      const rec = layer.recorder({
        runId: "r",
        callId: "c",
        model: "m",
        agent: "guild-read",
        command: "/guild:consult",
      });
      const turn = askViaAgent(fakeServe(fake), { agent: "guild-read", prompt: "q", activity: rec! });
      // Drop the attached stream while the turn is still in flight.
      await new Promise((r) => setTimeout(r, 120));
      fake.dropEventClients();
      const res = await turn;
      c.check(res.text === "finished anyway", "drop: the call still SUCCEEDS");
      const s = rec!.summary();
      c.check(s.degraded === true, "drop: a mid-turn drop marks the summary degraded");
      c.check(
        (s.degradedReason ?? "").length > 0,
        "drop: the FIRST reason is kept, so it names what was lost",
      );
      rec!.close();
    } finally {
      closeAllBuses();
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 14. BLOCKER: GUILD_LOG=off with a caller-supplied runId must write NOTHING. runId is a
  //     documented tool input, so gating the activity file on "is there a run id" instead of
  //     "is logging on" produced a run dir holding activity.jsonl and no calls.jsonl — which
  //     verify() then fails as a broken run.
  // -------------------------------------------------------------------------
  {
    const root = tmp("act-logoff-");
    const logDir = tmp("act-logofflogs-");
    const env = envWith({
      GUILD_ROOT: root,
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDirWith("guild-read"),
      GUILD_LOG: "off",
      GUILD_ACTIVITY: "on",
    });
    const fake = await startFakeOpencode({
      historyText: "logged nowhere",
      sessionId: "ses_logoff",
      eventScript: scriptFor("ses_logoff"),
    });
    try {
      const r = await consult(
        { question: "q", model: "openai/allowed", runId: "20260727T000000Z-threaded" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(r.ok, "log-off: the call succeeded");
      c.check(
        readdirSync(logDir).length === 0,
        `log-off: NOTHING was written under the log dir (found ${JSON.stringify(readdirSync(logDir))})`,
      );
      if (r.ok) {
        c.check(
          r.activity !== undefined && r.activity.file === null,
          "log-off: the in-memory summary still exists but names no file",
        );
        c.check(
          (r.activity?.toolCalls ?? 0) > 0,
          "log-off: activity is still OBSERVED — only the file is suppressed",
        );
      }
    } finally {
      closeAllBuses();
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 15. Bounds: first-lines / files / errors caps and the truncated flag; the detail cap.
  // -------------------------------------------------------------------------
  {
    const runDir = tmp("act-bounds-");
    const fake = await startFakeOpencode({ historyText: "unused", sessionId: "ses_b" });
    try {
      const layer = createActivityLayer({ enabled: true, detail: "full", runDir: () => runDir });
      const rec = layer.recorder({
        runId: "run-b",
        callId: "call-b",
        model: "m",
        agent: "guild-build",
        command: "/guild:delegate",
      });
      await rec!.attach(fake.baseUrl, "ses_b");
      // 60 distinct edits (cap 50), 15 failures (cap 10), 30 tool calls (first-lines cap 20).
      for (let i = 0; i < 60; i++) fake.emit({ type: "file.edited", properties: { file: `f${i}.ts` } });
      for (let i = 0; i < 15; i++) {
        fake.emit(toolPart("ses_b", `e${i}`, "edit", { status: "error", error: `boom ${i}` }));
      }
      for (let i = 0; i < 30; i++) {
        fake.emit(toolPart("ses_b", `t${i}`, "bash", { status: "running", input: { command: `c${i}` } }));
      }
      // One enormous payload to trip the per-line detail cap.
      fake.emit(
        toolPart("ses_b", "huge", "read", {
          status: "completed",
          input: { filePath: "big.bin" },
          output: "x".repeat(200_000),
        }),
      );
      await new Promise((r) => setTimeout(r, 400));
      const s = rec!.summary();
      c.check(s.filesEdited.length === 50, `bounds: filesEdited capped at 50 (got ${s.filesEdited.length})`);
      c.check(s.errors.length === 10, `bounds: errors capped at 10 (got ${s.errors.length})`);
      c.check(s.first.length === 20, `bounds: first-lines capped at 20 (got ${s.first.length})`);
      c.check(s.truncated === true, "bounds: the truncated flag is set when a cap bites");
      c.check(s.toolCalls === 30, `bounds: every tool call is still COUNTED past the line cap (got ${s.toolCalls})`);

      const lines = readActivity(path.join(runDir, "activity.jsonl"));
      const big = lines.find((l) => l.tool_call_id === "huge");
      c.check(big !== undefined, "bounds: the oversized event is still recorded");
      const det = (big?.detail ?? {}) as Record<string, unknown>;
      c.check(det.truncated === true, "bounds: an oversized detail is replaced by a truncation marker");
      c.check(typeof det.bytes === "number", "bounds: the marker states the original size");
      const longest = Math.max(...readFileSync(path.join(runDir, "activity.jsonl"), "utf8").split("\n").map((l) => l.length));
      c.check(longest < 50_000, `bounds: no line is unbounded (longest ${longest})`);
      rec!.close();
    } finally {
      closeAllBuses();
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 16. close()/release() interleavings must never throw or strand a bus.
  // -------------------------------------------------------------------------
  {
    const fake = await startFakeOpencode({ historyText: "unused" });
    try {
      // (a) close() while ready() is still pending.
      const layer = createActivityLayer({ enabled: true, detail: "summary", attachTimeoutMs: 2_000 });
      const rec = layer.recorder({ runId: "r", callId: "c", model: "m", agent: "a", command: "x" });
      const attaching = rec!.attach(fake.baseUrl, "ses_x");
      rec!.close();
      const detach = await attaching;
      c.check(typeof detach === "function", "interleave: attach still resolves after an early close");
      detach();
      detach();
      c.check(true, "interleave: double-close is a no-op, not a throw");

      // (b) release() AFTER closeBusesFor already closed the bus.
      const bus = ServeEventBus.acquire(fake.baseUrl);
      c.check((await bus.ready()) === true, "interleave: bus attached");
      closeBusesFor(fake.baseUrl);
      c.check(liveBusCount() === 0, "interleave: closeBusesFor drops the bus from the registry");
      bus.release();
      bus.close();
      c.check(liveBusCount() === 0, "interleave: a late release/close after closeBusesFor is harmless");

      // (c) subscribing to an already-closed bus reports degraded at once.
      let told = "";
      bus.subscribe("ses_y", { onEvent: () => {}, onDegraded: (why) => (told = why) });
      c.check(told.length > 0, "interleave: subscribing to a closed bus degrades immediately");

      // (d) acquire after close mints a FRESH bus rather than handing back the dead one.
      const fresh = ServeEventBus.acquire(fake.baseUrl);
      c.check(fresh !== bus, "interleave: acquire after close returns a fresh bus");
      c.check((await fresh.ready()) === true, "interleave: the fresh bus attaches");
      fresh.release();
    } finally {
      closeAllBuses();
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 17. The MCP progress emitter (slice 3). Its own module precisely so it is testable —
  //     importing src/server.ts would construct a real MCP server.
  // -------------------------------------------------------------------------
  {
    type Sent = { progressToken: string | number; progress: number; message?: string };
    const spy = (meta?: { progressToken?: string | number | null }) => {
      const sent: Sent[] = [];
      const extra: ProgressCapableExtra = {
        sendNotification: async (n) => {
          sent.push(n.params);
        },
      };
      if (meta !== undefined) extra._meta = meta;
      return { sent, extra };
    };
    const ev = (summary: string, model?: string): ActivityEvent => {
      const e: ActivityEvent = { ts: Date.now(), sessionId: "s", kind: "tool-called", summary };
      if (model !== undefined) e.model = model;
      return e;
    };

    // Token gate: absent, and the null a client may legitimately send.
    c.check(makeProgressEmitter(spy().extra, "t") === undefined, "progress: no _meta ⇒ no emitter");
    c.check(
      makeProgressEmitter(spy({}).extra, "t") === undefined,
      "progress: _meta without a token ⇒ no emitter",
    );
    c.check(
      makeProgressEmitter(spy({ progressToken: null }).extra, "t") === undefined,
      "progress: a NULL token ⇒ no emitter (never send progressToken:null)",
    );

    // Throttle: first sends, the rest of the window is held, the LATEST is flushed.
    {
      const { sent, extra } = spy({ progressToken: 7 });
      const em = makeProgressEmitter(extra, "guild_delegate", { minIntervalMs: 60, heartbeatMs: 10_000 })!;
      c.check(sent.length === 1 && sent[0].message === "guild_delegate: started", "progress: opens with a started line");
      em.onActivity(ev("one"));
      em.onActivity(ev("two"));
      em.onActivity(ev("three"));
      const during = sent.length;
      c.check(during === 1, `progress: a burst inside the window sends nothing more (got ${during})`);
      await new Promise((r) => setTimeout(r, 120));
      c.check(sent.length === 2, `progress: exactly one flush per window (got ${sent.length})`);
      c.check(
        sent[1].message === "guild_delegate: three",
        `progress: the flush carries the LATEST event, not a stale one (got '${sent[1].message}')`,
      );
      c.check(
        sent.every((p, i) => i === 0 || p.progress > sent[i - 1].progress),
        "progress: the progress counter strictly increases",
      );
      c.check(sent.every((p) => p.progressToken === 7), "progress: every notification carries the token");
      em.close();
    }

    // Heartbeat: a quiet stretch still emits, which is what feeds the client idle watchdog.
    {
      const { sent, extra } = spy({ progressToken: "tok" });
      const em = makeProgressEmitter(extra, "guild_delegate", { minIntervalMs: 5, heartbeatMs: 40 })!;
      await new Promise((r) => setTimeout(r, 150));
      c.check(sent.length >= 2, `progress: the heartbeat ticks through silence (got ${sent.length})`);
      c.check(
        sent.slice(1).some((p) => (p.message ?? "").includes("still working")),
        "progress: the heartbeat message says it is still working",
      );
      em.close();
      const after = sent.length;
      await new Promise((r) => setTimeout(r, 100));
      c.check(sent.length === after, "progress: close() stops the heartbeat");
    }

    // Panel attribution: the model rides on the event, so members are distinguishable.
    {
      const { sent, extra } = spy({ progressToken: 1 });
      const em = makeProgressEmitter(extra, "guild_panel", { minIntervalMs: 0, heartbeatMs: 10_000 })!;
      em.onActivity(ev("read: a.ts", "openai/gpt-5.5"));
      em.onActivity(ev("read: b.ts", "google/gemini-2.5-pro"));
      const msgs = sent.map((p) => p.message ?? "");
      c.check(
        msgs.some((m) => m.includes("[gpt-5.5]")) && msgs.some((m) => m.includes("[gemini-2.5-pro]")),
        `progress: panel members are labelled by model (got ${JSON.stringify(msgs)})`,
      );
      em.close();
    }

    // A sendNotification that throws SYNCHRONOUSLY must not escape — the heartbeat calls
    // this from a timer callback, where an escape would kill the process.
    {
      const extra: ProgressCapableExtra = {
        _meta: { progressToken: 1 },
        sendNotification: () => {
          throw new Error("transport closed");
        },
      };
      let threw = false;
      try {
        const em = makeProgressEmitter(extra, "t", { minIntervalMs: 0, heartbeatMs: 10_000 })!;
        em.onActivity(ev("x"));
        em.close();
      } catch {
        threw = true;
      }
      c.check(!threw, "progress: a synchronous sendNotification throw is swallowed");
    }

    // A rejecting sendNotification is likewise never a tool failure, and withProgress
    // returns the tool's own result.
    {
      const extra: ProgressCapableExtra = {
        _meta: { progressToken: 1 },
        sendNotification: async () => {
          throw new Error("client went away");
        },
      };
      const out = await withProgress(extra, "t", async (onActivity) => {
        onActivity?.(ev("y"));
        return "the tool result";
      }, { minIntervalMs: 0, heartbeatMs: 10_000 });
      c.check(out === "the tool result", "progress: a rejecting notification never fails the tool");
    }

    // No token ⇒ the tool still runs and simply gets no sink.
    {
      const out = await withProgress(spy().extra, "t", async (onActivity) => {
        c.check(onActivity === undefined, "progress: no token ⇒ the tool gets no activity sink");
        return 42;
      });
      c.check(out === 42, "progress: withProgress returns the tool result with no token");
    }
  }

  // -------------------------------------------------------------------------
  // 18. Panel: per-member summaries must not cross-contaminate.
  // -------------------------------------------------------------------------
  {
    const root = tmp("act-panel-");
    const logDir = tmp("act-panellogs-");
    const env = envWith({
      GUILD_ROOT: root,
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDirWith("guild-read"),
    });
    // Each member gets its OWN session id, and a script keyed to it: member 1 greps,
    // member 2 runs bash. A leak across members shows up as the wrong tool in a summary.
    const fake = await startFakeOpencode({
      historyText: "panel answer",
      sessionId: "ses_p",
      distinctSessions: true,
      // Hold both turns open together: the ONE-bus guarantee is about CONCURRENT calls, and
      // with an instant fake the first member can finish (and release the bus) before the
      // second attaches, which would legitimately open a second stream.
      messageDelayMs: 200,
      eventScript: (sessionId: string) =>
        sessionId.endsWith("-1")
          ? [toolPart(sessionId, "m1", "grep", { status: "running", input: { pattern: "alpha" } })]
          : [toolPart(sessionId, "m2", "bash", { status: "running", input: { command: "beta" } })],
    });
    try {
      const r = await panel(
        { question: "q", models: ["openai/one", "google/two"] },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(r.ok, "panel: the call succeeded");
      if (r.ok) {
        c.check(r.results.length === 2, "panel: two members ran");
        const a = r.results[0].activity;
        const b = r.results[1].activity;
        c.check(a !== undefined && b !== undefined, "panel: EACH member carries its own activity summary");
        const aTools = Object.keys(a?.byTool ?? {});
        const bTools = Object.keys(b?.byTool ?? {});
        c.check(
          aTools.length === 1 && bTools.length === 1 && aTools[0] !== bTools[0],
          `panel: members see only their own session's tools (a=${JSON.stringify(aTools)} b=${JSON.stringify(bTools)})`,
        );
        c.check(
          fake.recorded.eventSubscribes === 1,
          `panel: ONE /event subscription served both members (got ${fake.recorded.eventSubscribes})`,
        );
      }
    } finally {
      closeAllBuses();
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 19. watch --follow: partial lines across polls, rotation with NO tail loss, truncation.
  // -------------------------------------------------------------------------
  {
    const guildRoot = tmp("act-follow-");
    const logDir = path.join(guildRoot, "logs");
    const runA = "20260727T110000Z-aaaaaa";
    const runB = "20260727T120000Z-bbbbbb";
    mkdirSync(path.join(logDir, runA), { recursive: true });
    const fileA = path.join(logDir, runA, "activity.jsonl");
    const line = (summary: string, call = "call-aaa") =>
      JSON.stringify({ ts: "2026-07-27T11:00:00Z", call_id: call, kind: "tool-called", summary });
    writeFileSync(fileA, "");
    symlinkSync(runA, path.join(logDir, "latest"));

    const env = envWith({ GUILD_ROOT: guildRoot, GUILD_LOG_DIR: logDir });
    const printed: string[] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]) => {
      printed.push(a.map(String).join(" "));
    };
    const watching = runWatch([], { env, maxPolls: 40, pollMs: 20 });
    try {
      // A line written in HALVES across polls must not be printed torn.
      appendFileSync(fileA, line("first event").slice(0, 20));
      await new Promise((r) => setTimeout(r, 60));
      const tornSeen = printed.some((l) => l.includes("{\"ts\"") && !l.includes("first event"));
      appendFileSync(fileA, `${line("first event").slice(20)}\n`);
      await new Promise((r) => setTimeout(r, 60));

      // Append to run A and rotate to run B inside the SAME window: A's tail must survive.
      appendFileSync(fileA, `${line("A tail event")}\n`);
      mkdirSync(path.join(logDir, runB), { recursive: true });
      writeFileSync(path.join(logDir, runB, "activity.jsonl"), `${line("B first event", "call-bbb")}\n`);
      rmSync(path.join(logDir, "latest"));
      symlinkSync(runB, path.join(logDir, "latest"));
      await new Promise((r) => setTimeout(r, 120));

      const out = printed.join("\n");
      c.check(!tornSeen, "follow: a half-written line is never printed torn");
      c.check(out.includes("first event"), "follow: a line split across polls prints once whole");
      c.check(out.includes("A tail event"), "follow: the outgoing run's TAIL is drained before rotation");
      c.check(out.includes("B first event"), "follow: the new run is picked up");
      c.check(
        out.indexOf("A tail event") < out.indexOf("B first event"),
        "follow: the tail prints before the new run's events, in order",
      );
      c.check(out.includes(runA) && out.includes(runB), "follow: both runs are announced");

      // Truncation/replacement resets the offset instead of reading past the end.
      const before = printed.length;
      // Deliberately SHORTER than what was there: a replaced file must be re-read from the
      // start, not from a stale offset that would now point past its end.
      writeFileSync(
        path.join(logDir, runB, "activity.jsonl"),
        `${JSON.stringify({ kind: "tool-called", summary: "after truncate" })}\n`,
      );
      await new Promise((r) => setTimeout(r, 80));
      c.check(
        printed.slice(before).some((l) => l.includes("after truncate")),
        "follow: a truncated/replaced file is re-read from the start",
      );
    } finally {
      await watching;
      console.log = realLog;
    }
  }

  closeAllBuses();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  console.log(`activity.test: ${c.passes} passed, ${c.failures} failed`);
  return c.failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((f) => process.exit(f > 0 ? 1 : 0));
}
