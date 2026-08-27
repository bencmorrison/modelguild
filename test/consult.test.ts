/**
 * guild_consult tests (CONTRACT.md C1–C7, C12, C22–C25, C31, C41, C45)
 * — OFFLINE.
 *
 * No model is called: the model turn is served by the `node:http` fake
 * (test/fake-opencode-server.ts) behind a `ServeProvider`, exactly like the M2 client
 * tests. The evidence layer writes to a temp GUILD_LOG_DIR, and the flagship case
 * verifies a TOOL-PRODUCED run with the TS `verify()` (the reference verifier; the bash
 * `log.sh verify` it was cross-checked against retired at M12).
 */

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  consult,
  consultToToolResult,
  guildDoctorSeed,
  type ConsultResult,
} from "../src/consult.js";
import { EvidenceLog } from "../src/log.js";
import { startFakeOpencode, COMPACTION_TOOL_CALLS, type FakeOpencode } from "./fake-opencode-server.js";
import type { ServeProvider } from "../src/client.js";
import { Checker, fakeServeHandle } from "./harness.js";

const SHA256_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** A `ServeProvider` pointing `withServe` at an already-running fake (no opencode). */
function fakeServe(fake: FakeOpencode): ServeProvider {
  const handle = fakeServeHandle(fake.baseUrl);
  return { withServe: (fn) => fn(handle) };
}

const tmpDirs: string[] = [];
function tmp(prefix = "m5-"): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/** A guild root carrying a deny/ask test policy; returns its path. */
function makeGuildRoot(): string {
  const root = tmp("m5-guild-");
  writeFileSync(
    path.join(root, "models.policy.local"),
    "# M5 test policy\ndeny openai/denied-model\nask openai/ask-model\n",
  );
  return root;
}

/** An agent-def dir CONTAINING a guild-read.md so the presence gate passes. Pinned via
 * GUILD_AGENT_DIR on every gate-traversing test so the pass does NOT depend on an ambient
 * def (repo cwd `.opencode/agent/` or a container-global install) — the #24 hermeticity rule
 * (mirrors defDirWithResearch/defDirWithBuild). The content is irrelevant offline — only the
 * file's existence is checked. */
function defDirWithRead(): string {
  const dir = tmp("m5-agent-");
  writeFileSync(path.join(dir, "guild-read.md"), "---\nmode: all\n---\nfake\n");
  return dir;
}

/** A clean env: process.env minus every GUILD_* knob, then the given overrides. */
function envWith(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith("GUILD_")) delete base[k];
  return { ...base, ...overrides };
}

/** An awkward answer that exposes every classic capture bug (from client.test). */
const AWKWARD =
  'line one\n"quoted" value\ttab\ncafé ☕ — naïve façade\n{"json":true}\ntrailing-newline-follows\n';

function readEntries(logDir: string, runId: string): Array<Record<string, unknown>> {
  const file = path.join(logDir, runId, "calls.jsonl");
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

export async function run(): Promise<number> {
  const c = new Checker();
  console.log("== consult.test (M5 guild_consult) ==");

  // -------------------------------------------------------------------------
  // 0. NO-FALLBACK def gate: a MISSING guild-read.md refuses (exit-5), NOTHING logged, NO
  //    model call — the deliberate deviation from bash C16, mirroring research/delegate
  //    (issue #34). Phase-1 probe: opencode 1.18.4 hard-errors (HTTP 500) on a message
  //    naming a nonexistent agent rather than falling back, so the post-hoc agent-mismatch
  //    check never fires on this path — this pre-flight guard is the version-independent,
  //    fail-closed refusal.
  // -------------------------------------------------------------------------
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const emptyDefDir = tmp("m5-emptyagent-"); // no guild-read.md inside
    // HERMETICITY (issue #24): resolveAgentDefDirs also looks in the GLOBAL opencode dir
    // (`${XDG_CONFIG_HOME:-~/.config}/opencode/agent/`). On a box with a global install (e.g.
    // this dev container) that dir HAS guild-read.md, so the def would resolve globally and the
    // tool would NOT refuse. Point XDG_CONFIG_HOME at an empty temp dir: non-empty, so it wins
    // over the ~/.config fallback, making the global dir resolve to an empty location. Now BOTH
    // dirs are genuinely def-free.
    const emptyXdg = tmp("m5-emptyxdg-"); // <emptyXdg>/opencode/agent does not exist
    const env = envWith({
      GUILD_ROOT: root,
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: emptyDefDir,
      XDG_CONFIG_HOME: emptyXdg,
    });
    const fake = await startFakeOpencode({ historyText: "should never be reached" });
    try {
      const r = await consult(
        { question: "hi", model: "openai/allow-model" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(!r.ok, "def-missing: consult refuses");
      if (!r.ok) {
        c.check(r.error.kind === "agent-def-missing", "def-missing: kind is agent-def-missing");
        c.check(r.error.exitAnalogue === 5, "def-missing: exit analogue is 5 (C57)");
        c.check(r.error.message.includes("guild-read"), "def-missing: message names the agent");
        c.check(r.error.message.includes(emptyDefDir), "def-missing: message names the dir searched");
        c.check(/no.*fallback/i.test(r.error.message), "def-missing: message states there is no fallback");
      }
      c.check(fake.recorded.messageBodies.length === 0, "def-missing: no model call was made");
      c.check(readdirSync(logDir).length === 0, "def-missing: NOTHING logged (gap parity)");
      c.check(consultToToolResult(r).isError === true, "def-missing: MCP result flags isError");
    } finally {
      await fake.close();
    }
  }

  // Def-missing STILL refuses on a sessionId continuation (the def governs the agent
  // regardless of session reuse) — a continuation must not slip past the guard.
  {
    const root = tmp("m5-guild-");
    const logDir = tmp("m5-logs-");
    const emptyDefDir = tmp("m5-emptyagent-");
    const emptyXdg = tmp("m5-emptyxdg-");
    const env = envWith({
      GUILD_ROOT: root,
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: emptyDefDir,
      XDG_CONFIG_HOME: emptyXdg,
    });
    const fake = await startFakeOpencode({ historyText: "unreached" });
    try {
      const r = await consult(
        { question: "continue", model: "openai/allow-model", sessionId: "ses_prior", keepSession: true },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(!r.ok && r.error.kind === "agent-def-missing", "def-missing (continuation): refuses with agent-def-missing");
      c.check(fake.recorded.messageBodies.length === 0, "def-missing (continuation): no model call (session not continued)");
      c.check(readdirSync(logDir).length === 0, "def-missing (continuation): NOTHING logged");
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 1. Policy DENY → structured error (exit-3 analogue); NOTHING logged (C7/C24).
  // -------------------------------------------------------------------------
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: "should never be reached" });
    try {
      const r = await consult(
        { question: "hi", model: "openai/denied-model" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(!r.ok, "deny: consult refuses");
      if (!r.ok) {
        c.check(r.error.kind === "policy-deny", "deny: error kind is policy-deny");
        c.check(r.error.exitAnalogue === 3, "deny: exit analogue is 3");
        c.check(r.error.tier === "deny", "deny: tier reported as deny");
        c.check(r.error.message.includes("openai/denied-model"), "deny: message names the model");
      }
      c.check(fake.recorded.messageBodies.length === 0, "deny: no model call was made");
      c.check(readdirSync(logDir).length === 0, "deny: NOTHING logged (no run dir created)");
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 2. ASK unconfirmed → structured ask error (exit-4 analogue); NOTHING logged.
  //    The error text must instruct the DRIVER to ask the human and retry with
  //    confirmed:true (C41 two-layer defense).
  // -------------------------------------------------------------------------
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: "unreached" });
    try {
      const r = await consult(
        { question: "hi", model: "openai/ask-model" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(!r.ok, "ask: consult refuses when not confirmed");
      if (!r.ok) {
        c.check(r.error.kind === "policy-ask", "ask: error kind is policy-ask");
        c.check(r.error.exitAnalogue === 4, "ask: exit analogue is 4");
        c.check(
          /confirmed:true/.test(r.error.message) && /ask the user/i.test(r.error.message),
          "ask: message tells the DRIVER to ask the human and retry with confirmed:true",
        );
        c.check(
          /not set confirmed yourself|approval, not yours/i.test(r.error.message),
          "ask: message forbids the assistant self-confirming",
        );
      }
      c.check(fake.recorded.messageBodies.length === 0, "ask: no model call was made");
      c.check(readdirSync(logDir).length === 0, "ask: NOTHING logged");
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 3. ASK + confirmed:true → proceeds (the user-approval analogue of GUILD_CONFIRMED).
  // -------------------------------------------------------------------------
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_LOG_PROMPTS: "full", GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: "approved answer" });
    try {
      const r = await consult(
        { question: "hi", model: "openai/ask-model", confirmed: true },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(r.ok, "ask+confirmed: consult proceeds");
      if (r.ok) {
        c.check(r.answer === "approved answer", "ask+confirmed: answer returned");
        c.check(fake.recorded.messageBodies.length === 1, "ask+confirmed: the model was called");
        c.check(new EvidenceLog({ env }).verify(r.attribution.runId).code === 0, "ask+confirmed: run verifies clean");
        // fix 2: the ask-tier + approval audit trail is recorded on started AND completed.
        const entries = readEntries(logDir, r.attribution.runId);
        const started = entries.find((e) => e.type === "call" && e.status === "started");
        const completed = entries.find((e) => e.type === "call" && e.status === "completed");
        c.check(started?.tier === "ask" && started?.confirmed === true, "ask+confirmed: started records tier=ask, confirmed=true");
        c.check(completed?.tier === "ask" && completed?.confirmed === true, "ask+confirmed: completed records tier=ask, confirmed=true");
        c.check(new EvidenceLog({ env }).verify(r.attribution.runId).code === 0, "ask+confirmed: verify accepts entries carrying the tier/confirmed fields");
      }
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 4. FLAGSHIP: allow → full lifecycle logged; a TOOL-PRODUCED run passes TS verify().
  //    This is the receipts guarantee — every real call leaves a verifiable record.
  // -------------------------------------------------------------------------
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_LOG_PROMPTS: "full", GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: "the second opinion", syncText: "SYNC-MUST-NOT-LEAK" });
    try {
      const r = await consult(
        { question: "review my plan\n", model: "openai/allow-model" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(r.ok, "allow: consult proceeds");
      if (r.ok) {
        const runId = r.attribution.runId;
        c.check(runId.length > 0, "allow: a run id was minted");
        c.check(r.answer === "the second opinion", "allow: answer is the history text (not the sync body)");
        c.check(r.attribution.agent === "guild-read", "allow: attribution names the UNMODIFIED guild-read agent");
        c.check(r.attribution.model === "openai/allow-model", "allow: exact-id attribution (C45)");
        c.check(r.attribution.callId.length > 0, "allow: a call id is attributed");

        // Entry lifecycle: exactly expected → started → completed for one call_id.
        const entries = readEntries(logDir, runId);
        const cid = r.attribution.callId;
        const forCall = entries.filter((e) => e.call_id === cid);
        c.check(forCall.length === 3, "allow: three lifecycle entries for the call");
        c.check(entries.some((e) => e.type === "expected-call" && e.call_id === cid), "allow: expected-call written");
        c.check(entries.some((e) => e.type === "call" && e.status === "started" && e.call_id === cid), "allow: started written");
        const completed = entries.find((e) => e.type === "call" && e.status === "completed" && e.call_id === cid);
        c.check(!!completed && completed.capture_state === "complete", "allow: completed with capture_state complete");
        c.check(!!completed && completed.raw_response === "the second opinion", "allow: byte-exact raw_response recorded");
        // fix 2: allow-tier entries carry tier="allow", confirmed=false (present, not omitted).
        const startedEntry = entries.find((e) => e.type === "call" && e.status === "started" && e.call_id === cid);
        c.check(startedEntry?.tier === "allow" && startedEntry?.confirmed === false, "allow: started records tier=allow, confirmed=false");
        c.check(completed?.tier === "allow" && completed?.confirmed === false, "allow: completed records tier=allow, confirmed=false");

        // verify on the tool-produced run.
        const tsCode = new EvidenceLog({ env }).verify(runId).code;
        c.check(tsCode === 0, "FLAGSHIP: TS verify() passes the tool-produced run (code 0)");
      }
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 5. Byte-exact answer round-trip THROUGH THE TOOL BOUNDARY (MCP serialization).
  // -------------------------------------------------------------------------
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: AWKWARD });
    try {
      const r = await consult(
        { question: "q", model: "openai/allow-model" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(r.ok && r.answer === AWKWARD, "boundary: consult answer is byte-exact");
      // Translate to the MCP wire shape and round-trip it through JSON (what stdio does).
      const wire = consultToToolResult(r);
      const roundTripped = JSON.parse(JSON.stringify(wire)) as {
        content: Array<{ text: string }>;
        structuredContent: { answer: string };
      };
      const textOut = roundTripped.content[0].text;
      const structOut = roundTripped.structuredContent.answer;
      c.check(textOut === AWKWARD, "boundary: content text survives JSON round-trip byte-exact");
      c.check(structOut === AWKWARD, "boundary: structuredContent.answer survives byte-exact");
      c.check(
        Buffer.from(textOut, "utf8").equals(Buffer.from(AWKWARD, "utf8")),
        "boundary: utf8 buffer identical (newlines/quotes/unicode/trailing-newline)",
      );
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 6. EMPTY ANSWER (issue #117, C74) — a turn that produced nothing is an ERROR on the read
  //    paths, and the capture that recorded the nothing stays COMPLETE.
  //
  //    THIS CASE USED TO ASSERT THE OPPOSITE (`r.ok && r.answer === ""`). That was the
  //    defect, pinned: a provider that rejects the model ends the turn with an empty final
  //    text, and the tool reported a clean success carrying "" — which on a panel is a member
  //    silently dropping out. The evidence half of the old case is KEPT verbatim below,
  //    because it is still correct and is the half that must not move: capture genuinely
  //    completed, so `capture_state` stays `complete` with the byte-exact empty response.
  // -------------------------------------------------------------------------
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: "" });
    try {
      const r = await consult(
        { question: "q", model: "openai/allow-model" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(!r.ok, "empty-answer: a present-but-empty answer is a FAILURE, not an ok:'' ");
      if (!r.ok) {
        c.check(r.error.kind === "empty-answer", "empty-answer: kind is empty-answer");
        c.check(r.error.exitAnalogue === null, "empty-answer: exit analogue is null (no bash counterpart)");
        c.check(
          r.error.message.includes("openai/allow-model"),
          "empty-answer: message names the model",
        );
        c.check(
          /no answer/i.test(r.error.message),
          "empty-answer: message states that no answer was returned",
        );
        c.check(consultToToolResult(r).isError === true, "empty-answer: MCP result flags isError");
      }
      // The model WAS called — this is not a pre-flight refusal, it is a completed turn.
      c.check(fake.recorded.messageBodies.length === 1, "empty-answer: the turn actually ran");
      // NO LEAKED SESSION: the throw happens before `succeeded` is set, so `askViaAgent`'s
      // existing ownership × outcome matrix deletes the session it created. No second
      // cleanup path exists, so this assertion is what proves the first one is reached.
      c.check(
        fake.recorded.deletes.length === 1,
        "empty-answer: the created session was DELETED, not leaked",
      );
      const runId = readdirSync(logDir).find((d) => d !== "latest") ?? "";
      const entries = readEntries(logDir, runId);
      const completed = entries.find((e) => e.type === "call" && e.status === "completed");
      c.check(entries.length === 3, "empty-answer: the full expect→started→completed lifecycle is written");
      c.check(!!completed && completed.capture_state === "complete", "empty-answer: capture_state stays complete (capture SUCCEEDED; the model said nothing)");
      c.check(!!completed && completed.raw_response === "", "empty-answer: raw_response is the byte-exact empty answer");
      c.check(!!completed && completed.response_hash === SHA256_EMPTY, "empty-answer: response_hash is sha256(\"\")");
      c.check(!!completed && completed.exit_code === 1, "empty-answer: exit_code is 1 (the call produced no answer)");
      c.check(
        new EvidenceLog({ env }).verify(runId).code === 0,
        "empty-answer: verify() ACCEPTS exit 1 + capture_state complete (it reads capture/hashes, never exit_code)",
      );
    } finally {
      await fake.close();
    }
  }

  // 6b. The OTHER empty shape: a final assistant message with NO text part at all (the shape
  //     a provider-rejected turn takes). Same outcome — the predicate is on the reconstructed
  //     text, not on the part's presence.
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: "unused", turnShapes: ["rejected"] });
    try {
      const r = await consult(
        { question: "q", model: "openai/allow-model" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(!r.ok && r.error.kind === "empty-answer", "empty-answer (no text part): refuses with empty-answer");
      c.check(fake.recorded.deletes.length === 1, "empty-answer (no text part): session deleted");
    } finally {
      await fake.close();
    }
  }

  // 6c. WHITESPACE-ONLY is still no answer — and the record keeps the BYTES. The predicate is
  //     trimmed-empty (a newline is not an answer), but `raw_response` is what came back, not
  //     a normalized "": C25's byte-exact rule does not get a hole cut in it here.
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: "\n  \t\n" });
    try {
      const r = await consult(
        { question: "q", model: "openai/allow-model" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(!r.ok && r.error.kind === "empty-answer", "empty-answer (whitespace only): refuses with empty-answer");
      const runId = readdirSync(logDir).find((d) => d !== "latest") ?? "";
      const completed = readEntries(logDir, runId).find(
        (e) => e.type === "call" && e.status === "completed",
      );
      c.check(!!completed && completed.raw_response === "\n  \t\n", "empty-answer (whitespace only): raw_response keeps the exact bytes");
      c.check(!!completed && completed.capture_state === "complete", "empty-answer (whitespace only): capture_state stays complete");
      c.check(new EvidenceLog({ env }).verify(runId).code === 0, "empty-answer (whitespace only): run verifies clean");
    } finally {
      await fake.close();
    }
  }

  // 6d. THE CROSS-TURN DEFECT (issue #117 review, defect 1). A CONTINUATION whose new turn
  //     answers nothing must fail — it must NOT inherit the previous turn's answer.
  //
  //     THIS IS THE CASE THE FIRST CUT COULD NOT SEE. The old fixture served one canned,
  //     turn-INDEPENDENT history, so "a continuation that answers nothing" and "a fresh call
  //     that answers nothing" were the same payload and the test passed while the product was
  //     broken. Here the fake serves a REAL two-turn history: turn 1 answered `BANANA`, turn 2
  //     is the captured provider-rejection shape. Against the unbounded backward walk, turn 2
  //     returns `BANANA` with `ok:true` — reproduced live on 2026-07-30 with
  //     `deepseek-v4-flash-free` then a quota-exhausted `gpt-5.6-terra`.
  //
  //     The caller owns the session, so the deletion matrix KEEPS it (continued + throw ⇒ keep)
  //     — including under `keepSession:false`, which is the one behaviour #117 shifted.
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({
      historyText: "BANANA",
      turnShapes: ["text", "rejected"],
      sessionId: "ses_prior",
    });
    try {
      const deps = { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 };
      const first = await consult(
        { question: "Reply with exactly: BANANA", model: "openai/allow-model", keepSession: true },
        deps,
      );
      c.check(first.ok && first.answer === "BANANA", "cross-turn: turn 1 answers normally");
      const runId = first.ok ? first.attribution.runId : "";
      const sid = first.ok ? (first.sessionId ?? "") : "";
      c.check(sid === "ses_prior", "cross-turn: turn 1 returns the session to continue");

      const r = await consult(
        {
          question: "Reply with exactly: KIWI",
          model: "openai/allow-model",
          sessionId: sid,
          runId,
          keepSession: true,
        },
        deps,
      );
      c.check(!r.ok && r.error.kind === "empty-answer", "cross-turn: the silent SECOND turn is empty-answer");
      // The load-bearing negative: nothing anywhere in the result carries turn 1's answer.
      c.check(!JSON.stringify(r).includes("BANANA"), "cross-turn: the PRIOR turn's answer is not returned as this call's answer");
      c.check(fake.recorded.deletes.length === 0, "cross-turn: the CALLER's session is not deleted");

      const entries = readEntries(logDir, runId);
      const completed = entries.filter((e) => e.type === "call" && e.status === "completed");
      c.check(completed.length === 2, "cross-turn: both turns wrote a completed entry into the one run");
      c.check(completed[0]?.raw_response === "BANANA", "cross-turn: turn 1's receipt is its own answer");
      c.check(
        completed[1]?.raw_response === "",
        "cross-turn: turn 2's receipt is the EMPTY answer, not turn 1's text",
      );
      c.check(completed[1]?.session_id === "ses_prior", "cross-turn: the failed continuation records its session");
      c.check(new EvidenceLog({ env }).verify(runId).code === 0, "cross-turn: the two-turn run verifies clean");
    } finally {
      await fake.close();
    }
  }

  // 6e. THE PROVIDER'S OWN DIAGNOSIS reaches the refusal message (issue #117 review). The old
  //     message sent the reader to `activity.errors`, a channel that is EMPTY under
  //     `GUILD_ACTIVITY=off` — so it could point at nothing. The turn's own `info.error` is
  //     read from history instead, whitelisted to name/message/statusCode.
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({
      GUILD_ROOT: root,
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDirWithRead(),
      GUILD_ACTIVITY: "off",
    });
    const fake = await startFakeOpencode({
      historyText: "unused",
      turnShapes: ["rejected"],
      rejectionError: { name: "APIError", message: "You have exceeded your monthly quota", statusCode: 402 },
    });
    try {
      const r = await consult(
        { question: "q", model: "openai/allow-model" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(!r.ok && r.error.kind === "empty-answer", "provider error: still an empty-answer refusal");
      if (!r.ok) {
        c.check(
          r.error.message.includes("You have exceeded your monthly quota"),
          "provider error: the provider's own message is quoted in the refusal",
        );
        c.check(r.error.message.includes("402"), "provider error: the status code is quoted");
        c.check(
          !/activity errors/.test(r.error.message),
          "provider error: with a real diagnosis it does NOT send the reader to the (here empty) activity trace",
        );
      }
    } finally {
      await fake.close();
    }
  }

  // 6f. NO diagnosis available: the message must stay useful rather than assert a cause it
  //     does not have. `historyText: ""` is a turn that answered with an empty text part and
  //     carries no `info.error` at all.
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: "" });
    try {
      const r = await consult(
        { question: "q", model: "openai/allow-model" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(!r.ok && r.error.kind === "empty-answer", "no diagnosis: still refuses");
      if (!r.ok) {
        c.check(
          !/The provider reported/.test(r.error.message),
          "no diagnosis: no provider text is invented",
        );
        c.check(
          /model id/.test(r.error.message),
          "no diagnosis: the message still says what to check",
        );
        c.check(!!r.runId && !!r.callId, "no diagnosis: the failure names the receipt (runId + callId)");
      }
    } finally {
      await fake.close();
    }
  }

  // 6g. A NON-STRING text part on a continuation. The part is present, so nothing is missing —
  //     but its `text` is not a string, the product's type guard correctly rejects it, and the
  //     walk must then stop at the turn boundary rather than reaching back to turn 1.
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({
      historyText: "BANANA",
      turnShapes: ["text", "non-string-text"],
      sessionId: "ses_prior",
    });
    try {
      const deps = { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 };
      const first = await consult(
        { question: "q1", model: "openai/allow-model", keepSession: true },
        deps,
      );
      c.check(first.ok && first.answer === "BANANA", "non-string: turn 1 answers normally");
      const r = await consult(
        { question: "q2", model: "openai/allow-model", sessionId: "ses_prior", keepSession: true },
        deps,
      );
      c.check(!r.ok && r.error.kind === "empty-answer", "non-string: a non-string text part is no answer");
      c.check(!JSON.stringify(r).includes("BANANA"), "non-string: turn 1's answer is not borrowed");
    } finally {
      await fake.close();
    }
  }

  // 6h. C74's BOUND, fixtured in both directions. A preamble followed by a dead final message
  //     INSIDE ONE TURN still passes, returning the preamble — judging content is deliberately
  //     not attempted. On a FRESH session that is the whole story; on a CONTINUATION the
  //     returned preamble must be THIS turn's, never the previous turn's answer.
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({
      historyText: "I'll start by checking the",
      turnShapes: ["preamble-then-textless"],
    });
    try {
      const r = await consult(
        { question: "q", model: "openai/allow-model" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(
        r.ok && r.answer === "I'll start by checking the",
        "bound: a preamble inside the turn is an answer (C74 catches a WHOLLY empty turn, not a useless one)",
      );
    } finally {
      await fake.close();
    }
  }
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({
      historyText: "unused",
      turnTexts: ["TURN-ONE-ANSWER", "TURN-TWO-PREAMBLE"],
      turnShapes: ["text", "preamble-then-textless"],
      sessionId: "ses_prior",
    });
    try {
      const deps = { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 };
      await consult({ question: "q1", model: "openai/allow-model", keepSession: true }, deps);
      const r = await consult(
        { question: "q2", model: "openai/allow-model", sessionId: "ses_prior", keepSession: true },
        deps,
      );
      // Distinct per-turn texts, so this really does say WHICH turn the walk landed on.
      c.check(r.ok && r.answer === "TURN-TWO-PREAMBLE", "bound: a continuation returns THIS turn's preamble, not turn 1's answer");
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 6i. EMPTY-ANSWER DIAGNOSTICS (issue #168). The reported failure was a member that made five
  //     successful `read` calls and then said nothing, and the refusal it produced was
  //     indistinguishable from one for a model that never reached for a tool at all. Both facts
  //     the issue asked for are asserted here, structurally AND in the message the reporter
  //     actually reads: the turn's tool-call count, and opencode's own completion metadata.
  //
  //     The token numbers are set BY THE FIXTURE and asserted verbatim, which is what makes this
  //     a test of an extraction rather than of a constant.
  // -------------------------------------------------------------------------
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({
      // The `text` shape is the reported one: a tool-call assistant message, then a
      // text-bearing one whose text is empty. Tool calls happened; the answer did not.
      historyText: "",
      assistantTokens: { input: 4321, output: 0, reasoning: 12, cache: { read: 7, write: 3 } },
    });
    try {
      const r = await consult(
        { question: "q", model: "openai/allow-model" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(!r.ok && r.error.kind === "empty-answer", "#168: still an empty-answer refusal (C74 unchanged)");
      if (!r.ok) {
        const d = r.error.diagnostics;
        c.check(!!d, "#168: the refusal carries structured diagnostics");
        c.check(!!d && d.toolCallCount === 1, "#168: the turn's tool-call count is reported (1 read, then silence)");
        c.check(!!d?.completion && d.completion.finish === "stop", "#168: opencode's finish reason is reported");
        c.check(
          !!d?.completion?.tokens &&
            d.completion.tokens.input === 4321 &&
            d.completion.tokens.output === 0 &&
            d.completion.tokens.reasoning === 12 &&
            d.completion.tokens.cacheRead === 7 &&
            d.completion.tokens.cacheWrite === 3,
          "#168: the token counts are the payload's, not a constant",
        );
        c.check(!!d?.completion && d.completion.cost === 0.0042, "#168: cost is reported");
        // The MESSAGE is the surface the issue's reporter read, so it carries them too.
        c.check(
          /1 tool call before it ended/.test(r.error.message),
          "#168: the message says the turn DID make tool calls before going quiet",
        );
        c.check(
          /output=0/.test(r.error.message) && /input=4321/.test(r.error.message),
          "#168: the message quotes the token counts",
        );
        c.check(
          /finish="stop"/.test(r.error.message),
          "#168: the message quotes the finish reason verbatim",
        );
        // …and through the MCP boundary, where a driver would actually read it.
        const wire = consultToToolResult(r);
        const err = (wire.structuredContent as { error: { diagnostics?: { toolCallCount: number } } }).error;
        c.check(
          err.diagnostics?.toolCallCount === 1,
          "#168: diagnostics survive the MCP boundary on structuredContent.error",
        );
      }
    } finally {
      await fake.close();
    }
  }

  // 6j. THE OTHER SIDE OF THE DISTINCTION: a turn that said nothing AND reached for no tool.
  //     Same refusal kind, different diagnostics — which is the entire point of #168.
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: "unused", turnShapes: ["rejected"] });
    try {
      const r = await consult(
        { question: "q", model: "openai/allow-model" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(!r.ok && r.error.kind === "empty-answer", "#168 (no tools): still empty-answer");
      if (!r.ok) {
        c.check(r.error.diagnostics?.toolCallCount === 0, "#168 (no tools): zero tool calls reported");
        c.check(
          /made NO tool calls/.test(r.error.message),
          "#168 (no tools): the message distinguishes 'said nothing at all' from 'did work then went quiet'",
        );
        // The probed rejection shape carries `finish: null`; an absent finish must read as
        // "not recorded" rather than being invented.
        c.check(
          r.error.diagnostics?.completion?.finish === undefined &&
            /finish=\(not recorded\)/.test(r.error.message),
          "#168 (no tools): a finish opencode did not record is reported as not recorded, never guessed",
        );
        // The provider's own words still lead the message — #117's behaviour is not displaced.
        c.check(
          /exceeded your monthly quota/.test(r.error.message),
          "#168 (no tools): the provider error still leads the message (C74 unchanged)",
        );
      }
    } finally {
      await fake.close();
    }
  }

  // 6k. OPENCODE RECORDED NOTHING. Absent metadata must be reported as absent — a fabricated
  //     `output=0` here would assert a zero-token completion that was never observed, which is
  //     exactly the confusion #168 exists to remove.
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: "", omitCompletionMetadata: true });
    try {
      const r = await consult(
        { question: "q", model: "openai/allow-model" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(!r.ok && r.error.kind === "empty-answer", "#168 (no metadata): still empty-answer");
      if (!r.ok) {
        c.check(
          r.error.diagnostics !== undefined && r.error.diagnostics.completion === undefined,
          "#168 (no metadata): completion is ABSENT, not a zero-filled object",
        );
        c.check(
          /recorded no completion metadata/.test(r.error.message),
          "#168 (no metadata): the message says opencode recorded none",
        );
        c.check(
          r.error.diagnostics?.toolCallCount === 1,
          "#168 (no metadata): the tool-call count is still reported — it comes from the parts, not the metadata",
        );
      }
    } finally {
      await fake.close();
    }
  }

  // 6l. TURN-SCOPED, like every other extractor (the BANANA bound). On a continuation the
  //     diagnostics must describe THIS turn: turn 1 made a tool call and finished `stop`, turn 2
  //     made none and opencode recorded no finish. Inheriting turn 1's would make a silent turn
  //     look busy — the same fail-OPEN shape `turnToolCallCount`'s comment warns about.
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({
      historyText: "unused",
      turnTexts: ["TURN-ONE-ANSWER", "unused"],
      turnShapes: ["text", "rejected"],
      sessionId: "ses_prior",
    });
    try {
      const deps = { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 };
      const first = await consult(
        { question: "q1", model: "openai/allow-model", keepSession: true },
        deps,
      );
      c.check(first.ok, "#168 (turn scope): turn 1 answered");
      const r = await consult(
        { question: "q2", model: "openai/allow-model", sessionId: "ses_prior", keepSession: true },
        deps,
      );
      c.check(!r.ok && r.error.kind === "empty-answer", "#168 (turn scope): the silent second turn is refused");
      if (!r.ok) {
        c.check(
          r.error.diagnostics?.toolCallCount === 0,
          "#168 (turn scope): turn 2's count is 0 — turn 1's tool call is NOT inherited",
        );
        c.check(
          r.error.diagnostics?.completion?.finish === undefined,
          "#168 (turn scope): turn 2's completion is turn 2's — turn 1's finish='stop' is NOT inherited",
        );
      }
    } finally {
      await fake.close();
    }
  }

  // 6m. THE REPORTED FAILURE (issue #168): a turn whose only text-bearing part is `reasoning`.
  //     `finalAssistantText` read `type === "text"` alone, so this reconstructed to "" and was
  //     refused as `empty-answer` — while opencode's own TUI renders that reasoning as a full
  //     answer, which is the contrast the issue reports (same model, same prompt, same repo,
  //     answered fully through opencode directly). The fallback returns it instead, and the
  //     RECEIPT is the assertion that matters: `raw_response` must be the reasoning text
  //     byte-exact, not "" and not a paraphrase.
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() });
    const REASONED = "a long and confident answer that lives in a reasoning part\n";
    const fake = await startFakeOpencode({
      historyText: REASONED,
      turnShapes: ["reasoning-only"],
      assistantTokens: { input: 500, output: 320, reasoning: 300, cache: { read: 0, write: 0 } },
    });
    try {
      const r = await consult(
        { question: "q", model: "openai/allow-model" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(r.ok, "#168 (reasoning): a reasoning-only turn is ANSWERED, not refused as empty-answer");
      c.check(r.ok && r.answer === REASONED, "#168 (reasoning): the answer is the reasoning text, byte-exact");
      if (r.ok) {
        const entries = readEntries(logDir, r.attribution.runId);
        const completed = entries.filter((e) => e.type === "call" && e.status === "completed");
        c.check(
          completed.length === 1 && completed[0].raw_response === REASONED,
          "#168 (reasoning): the receipt records the reasoning text byte-exact, not the empty string",
        );
        c.check(
          completed.length === 1 && completed[0].exit_code === 0,
          "#168 (reasoning): the call is recorded as a success, not exit_code 1",
        );
        // THE PROMOTION IS ON THE RECORD. Without this the receipt renders "the model's
        // answer" and "the model's chain-of-thought, promoted because there was no answer"
        // identically, and the evidence log exists so a claim can be checked.
        c.check(
          completed.length === 1 && completed[0].answer_channel === "reasoning",
          "#168 (reasoning): the receipt names the channel the answer was promoted off",
        );
      }
    } finally {
      await fake.close();
    }
  }

  // 6m-a. THE ARRANGEMENT THE FIRST CUT MISSED: reasoning BESIDE an empty text part. That is
  //     `tools-then-silent` — this repo's own model of the reported turn — with reasoning
  //     added, and a fallback gated on "a text PART exists" is satisfied by the empty one and
  //     never fires. End-to-end, because the unit assertions cannot show the refusal it caused.
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() });
    const REASONED = "the answer, beside an empty text part";
    const fake = await startFakeOpencode({
      historyText: REASONED,
      turnShapes: ["reasoning-and-empty-text"],
    });
    try {
      const r = await consult(
        { question: "q", model: "openai/allow-model" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(r.ok, "#168 (empty text part): an empty text part does not re-block the fallback");
      c.check(r.ok && r.answer === REASONED, "#168 (empty text part): the reasoning is still the answer");
      if (r.ok) {
        const completed = readEntries(logDir, r.attribution.runId).filter(
          (e) => e.type === "call" && e.status === "completed",
        );
        c.check(
          completed.length === 1 && completed[0].answer_channel === "reasoning",
          "#168 (empty text part): the receipt still names the promotion",
        );
      }
    } finally {
      await fake.close();
    }
  }

  // 6m-bis. THE FALLBACK IS A FALLBACK, NOT A MERGE. A turn whose final message carries BOTH a
  //     reasoning part and a text part returns the TEXT alone — chain-of-thought must never
  //     land beside an answer the model also wrote, and `raw_response` for every turn that
  //     already worked has to stay byte-identical to what it was before the fallback existed.
  //     This is the assertion that would go red on fix shape (a), "include reasoning always".
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({
      historyText: "THE ANSWER",
      turnShapes: ["reasoning-then-text"],
    });
    try {
      const r = await consult(
        { question: "q", model: "openai/allow-model" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(r.ok && r.answer === "THE ANSWER", "#168 (no merge): text wins outright over a reasoning part in the same message");
      if (r.ok) {
        const completed = readEntries(logDir, r.attribution.runId).filter(
          (e) => e.type === "call" && e.status === "completed",
        );
        c.check(
          completed.length === 1 && completed[0].raw_response === "THE ANSWER",
          "#168 (no merge): the receipt carries the answer alone — no chain-of-thought in raw_response",
        );
        // C29's optional-field rule: an ordinary answer adds NO field, even though a reasoning
        // part was present in the very same message.
        c.check(
          completed.length === 1 && !("answer_channel" in completed[0]),
          "#168 (no merge): an ordinary answer's entry carries no answer_channel at all",
        );
      }
    } finally {
      await fake.close();
    }
  }

  // 6m-quater. ISSUE #185, END-TO-END: a real answer followed by a trailing WHITESPACE-ONLY
  //     assistant message in the same turn. #168's `length > 0` gate took the trailing message,
  //     `requireAnswer` trimmed it to "" and the whole call was REFUSED while the model had
  //     answered — so the unit assertion on the extractor cannot show what this costs. The
  //     receipt is the other half: `raw_response` must be the answer, not the whitespace.
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() });
    const ANSWER = "the real answer, emitted before the model fell silent";
    const fake = await startFakeOpencode({
      historyText: ANSWER,
      turnShapes: ["text-then-whitespace"],
    });
    try {
      const r = await consult(
        { question: "q", model: "openai/allow-model" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(r.ok, "#185: a trailing whitespace-only message no longer refuses a turn that answered");
      c.check(r.ok && r.answer === ANSWER, "#185: the answer is the real text, byte-exact");
      if (r.ok) {
        const completed = readEntries(logDir, r.attribution.runId).filter(
          (e) => e.type === "call" && e.status === "completed",
        );
        c.check(
          completed.length === 1 && completed[0].raw_response === ANSWER,
          "#185: the receipt records the answer, not the trailing whitespace",
        );
        c.check(
          completed.length === 1 && !("answer_channel" in completed[0]),
          "#185: it came off `text`, so the entry carries no answer_channel (C29)",
        );
      }
    } finally {
      await fake.close();
    }
  }

  // 6m-ter. A turn that said nothing on EITHER channel is still refused, with the issue-#173
  //     diagnostics intact. The fallback narrows what counts as empty; it does not remove the
  //     refusal, and the part-type census still reports the shape it found.
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({
      historyText: "unused",
      turnShapes: ["tools-then-silent"],
      assistantTokens: { input: 500, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    try {
      const r = await consult(
        { question: "q", model: "openai/allow-model" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(!r.ok && r.error.kind === "empty-answer", "#168 (still refused): no text AND no reasoning is still empty-answer");
      if (!r.ok) {
        const d = r.error.diagnostics;
        c.check(
          d?.partTypes?.reasoning === undefined,
          "#168 (still refused): the census reports no reasoning part — nothing for the fallback to find",
        );
        // PR #173's CENSUS, ASSERTED POSITIVELY. Every other surviving partTypes assertion is
        // a negative one, so without these the whole census could return {} and stay green.
        c.check(d?.partTypes?.text === 1, "#173 census: the empty text part IS counted, positively");
        c.check(d?.partTypes?.tool === 1, "#173 census: the turn's tool part is counted");
        c.check(
          d?.partTypes?.["step-start"] === 2 && d?.partTypes?.["step-finish"] === 2,
          "#173 census: the structural parts are counted across BOTH assistant messages",
        );
        c.check(
          /Parts this turn:/.test(r.error.message) && /text=1/.test(r.error.message) && /tool=1/.test(r.error.message),
          "#173 census: it reaches the message a human reads",
        );
        // #168's own discriminator, asserted positively on both sides of the pair.
        c.check(
          d?.completion?.tokens?.input === 500 && d?.completion?.tokens?.output === 0,
          "#173 tokens: zero output BESIDE a nonzero input — the provider emitted nothing",
        );
        c.check(d?.toolCallCount === 1, "#173: the turn's tool-call count rides out");
      }
    } finally {
      await fake.close();
    }
  }

  // 6m-ter-quater. ISSUE #189: opencode auto-compacted MID-TURN and the turn then said nothing.
  //     The refusal is CORRECT — nothing was answered on either channel — but the diagnostics
  //     attached to it were read through a boundary that took opencode's own compaction-appended
  //     `user` messages as the start of the turn, so `toolCallCount` reported 0 and the receipt
  //     said "the turn made NO tool calls" about a turn that had made two. #173's headline
  //     diagnostic, silently wrong and only ever in the under-reporting direction.
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({
      historyText: "unused",
      turnShapes: ["compaction-then-silent"],
      assistantTokens: { input: 500, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    try {
      const r = await consult(
        { question: "q", model: "openai/allow-model" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(!r.ok && r.error.kind === "empty-answer", "#189: a compacted turn that answered nothing is still empty-answer");
      if (!r.ok) {
        const d = r.error.diagnostics;
        c.check(
          d?.toolCallCount === COMPACTION_TOOL_CALLS,
          `#189: toolCallCount counts the PRE-compaction calls (got ${String(d?.toolCallCount)}, want ${COMPACTION_TOOL_CALLS})`,
        );
        c.check(
          d?.partTypes?.tool === COMPACTION_TOOL_CALLS,
          `#189: the part-type census reaches back past the compaction (got ${String(d?.partTypes?.tool)})`,
        );
        c.check(
          r.error.message.includes(`the turn made ${COMPACTION_TOOL_CALLS} tool calls before it ended`),
          `#189: the corrected count reaches the message a human reads: ${r.error.message}`,
        );
      }
    } finally {
      await fake.close();
    }
  }

  // 6m-ter-bis. THE DISCRIMINATOR THE ISSUE ASKED FOR, in the direction that accuses THIS code:
  //     nonzero output tokens beside an empty answer means the provider emitted and nothing
  //     here read it. The reasoning fallback closed the one known route to that state, so the
  //     case is now a turn whose output went somewhere the extractor still does not read — and
  //     that is exactly the state the census plus the token counts exist to make legible.
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({
      historyText: "unused",
      turnShapes: ["tools-then-silent"],
      assistantTokens: { input: 500, output: 320, reasoning: 300, cache: { read: 0, write: 0 } },
    });
    try {
      const r = await consult(
        { question: "q", model: "openai/allow-model" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(!r.ok && r.error.kind === "empty-answer", "#173 discriminator: still refused");
      if (!r.ok) {
        c.check(
          r.error.diagnostics?.completion?.tokens?.output === 320,
          "#173 discriminator: NONZERO output beside an empty answer — the provider produced something",
        );
        c.check(
          r.error.diagnostics?.completion?.tokens?.reasoning === 300,
          "#173 discriminator: the reasoning token count is reported too",
        );
        c.check(
          r.error.diagnostics?.completion?.finish === "stop",
          "#173 discriminator: finish is carried opaque and verbatim",
        );
      }
    } finally {
      await fake.close();
    }
  }

  // 6m-quater. WHITESPACE-ONLY REASONING IS NOT AN ANSWER. The refusal predicate is untouched
  //     (`text.trim() === ""`), so the fallback cannot smuggle a blank turn past it by finding
  //     a reasoning part that says nothing.
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({
      historyText: "   \n\t ",
      turnShapes: ["reasoning-only"],
    });
    try {
      const r = await consult(
        { question: "q", model: "openai/allow-model" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(
        !r.ok && r.error.kind === "empty-answer",
        "#168 (whitespace): a whitespace-only reasoning part is still refused as empty-answer",
      );
    } finally {
      await fake.close();
    }
  }

  // 6m-quinquies. ISSUE #195, END-TO-END, BOTH HALVES. A real answer followed by a trailing
  //     message of one U+200B. This was the SILENT half of the defect: `Cf` is outside ECMA-262's
  //     `WhiteSpace`, so the trailing message won the walk AND passed `requireAnswer`, and the
  //     call returned ok with `answer` holding one invisible character — no marker on any
  //     surface, `raw_response` recording the same invisible character. Only an end-to-end case
  //     shows that; the extractor unit test cannot, because there the loss looks like a refusal.
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() });
    const ANSWER = "the real answer, emitted before one invisible character followed it";
    const fake = await startFakeOpencode({
      historyText: ANSWER,
      turnShapes: ["text-then-format-char"],
    });
    try {
      const r = await consult(
        { question: "q", model: "openai/allow-model" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(r.ok, "#195: a trailing U+200B no longer replaces the answer");
      c.check(r.ok && r.answer === ANSWER, "#195: the answer is the real text, byte-exact");
      if (r.ok) {
        const completed = readEntries(logDir, r.attribution.runId).filter(
          (e) => e.type === "call" && e.status === "completed",
        );
        c.check(
          completed.length === 1 && completed[0].raw_response === ANSWER,
          "#195: the receipt records the answer, not the zero-width character",
        );
      }
    } finally {
      await fake.close();
    }
  }

  // 6m-sexies. ISSUE #195, the other half: a turn whose WHOLE output is one U+200B. It must be
  //     REFUSED (the gate widened) while `raw_response` keeps those exact bytes (the
  //     byte-preserving passes). Asserting both together is the #204 invariant end-to-end:
  //     widening only `answerSource` would return the character as an answer instead.
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: "\u200b" });
    try {
      const r = await consult(
        { question: "q", model: "openai/allow-model" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(!r.ok && r.error.kind === "empty-answer", "#195 (zero-width only): refuses with empty-answer");
      const runId = readdirSync(logDir).find((d) => d !== "latest") ?? "";
      const completed = readEntries(logDir, runId).find(
        (e) => e.type === "call" && e.status === "completed",
      );
      c.check(
        !!completed && completed.raw_response === "\u200b",
        "#195 (zero-width only): raw_response keeps the exact bytes — nothing is stripped",
      );
      c.check(!!completed && completed.capture_state === "complete", "#195 (zero-width only): capture_state stays complete");
      c.check(new EvidenceLog({ env }).verify(runId).code === 0, "#195 (zero-width only): run verifies clean");
    } finally {
      await fake.close();
    }
  }

  // 6m-septies. ISSUE #195, the `Cc` arm END-TO-END: a turn whose whole output is one NUL.
  //     `Cc` is a second category outside ECMA-262's `WhiteSpace` — U+0085 NEL is the one that
  //     breaks the "it is all format characters" framing, since Unicode's own White_Space
  //     property DOES include it. NUL is chosen for the end-to-end case because it is one of the
  //     two characters `src/canonical.ts` / `src/log.ts` model as special, so this is also the
  //     proof that widening the GATE did not disturb how the receipt WRITES those bytes.
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: "\u0000" });
    try {
      const r = await consult(
        { question: "q", model: "openai/allow-model" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(!r.ok && r.error.kind === "empty-answer", "#195 (NUL only): refuses with empty-answer");
      const runId = readdirSync(logDir).find((d) => d !== "latest") ?? "";
      const completed = readEntries(logDir, runId).find(
        (e) => e.type === "call" && e.status === "completed",
      );
      c.check(
        !!completed && completed.raw_response === "\u0000",
        "#195 (NUL only): raw_response keeps the exact byte — the gate strips nothing",
      );
      c.check(!!completed && completed.capture_state === "complete", "#195 (NUL only): capture_state stays complete");
      c.check(new EvidenceLog({ env }).verify(runId).code === 0, "#195 (NUL only): run verifies clean");
    } finally {
      await fake.close();
    }
  }

  // 6m-octies. ISSUE #195, the `Cs` arm END-TO-END: a turn whose whole output is one LONE
  //     surrogate. The other character the evidence layer models specially — `src/log.ts`
  //     deliberately treats a line carrying a lone surrogate as UNCLEAN so TS `verify` and jq
  //     cannot disagree — so this case pins BOTH that the bytes reach the receipt intact and
  //     that the pre-existing uncleanliness rule is unchanged by the widened gate. `verify()`
  //     therefore reports the integrity code here, and that is the CORRECT pre-existing
  //     behaviour, asserted rather than papered over.
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: "\ud800" });
    try {
      const r = await consult(
        { question: "q", model: "openai/allow-model" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(
        !r.ok && r.error.kind === "empty-answer",
        "#195 (lone surrogate only): refuses with empty-answer",
      );
      const runId = readdirSync(logDir).find((d) => d !== "latest") ?? "";
      const completed = readEntries(logDir, runId).find(
        (e) => e.type === "call" && e.status === "completed",
      );
      c.check(
        !!completed && completed.raw_response === "\ud800",
        "#195 (lone surrogate only): raw_response keeps the exact bytes — the gate strips nothing",
      );
      c.check(
        !!completed && completed.capture_state === "complete",
        "#195 (lone surrogate only): capture_state stays complete",
      );
      // PRE-EXISTING, and asserted rather than left silent: `src/log.ts` treats a line carrying
      // a lone surrogate as UNCLEAN on purpose (jq rejects the escape, so TS verify and bash
      // verify must not disagree), so this run reports the integrity code. That was equally
      // true before #195 — the same bytes reached the same receipt, the turn was merely called
      // a success — so the widened gate changed the VERDICT on the turn, not the log's rule.
      c.check(
        new EvidenceLog({ env }).verify(runId).code === 7,
        "#195 (lone surrogate only): verify still reports the pre-existing unclean-line code (7)",
      );
    } finally {
      await fake.close();
    }
  }

  // 6n. The census counts the turn's ASSISTANT parts only, and is turn-scoped like the rest.
  //     A user message's parts are the caller's own prompt and say nothing about the model.
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({
      historyText: "unused",
      turnTexts: ["TURN-ONE-ANSWER", "unused"],
      turnShapes: ["text", "rejected"],
      sessionId: "ses_prior",
    });
    try {
      const deps = { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 };
      await consult({ question: "q1", model: "openai/allow-model", keepSession: true }, deps);
      const r = await consult(
        { question: "q2", model: "openai/allow-model", sessionId: "ses_prior", keepSession: true },
        deps,
      );
      c.check(!r.ok && r.error.kind === "empty-answer", "#168 (census scope): the silent second turn is refused");
      if (!r.ok) {
        // Turn 2 (the `rejected` shape) contributes ONE assistant message with zero parts, so
        // the census is empty. Turn 1's step-start/tool/text parts must not appear.
        c.check(
          r.error.diagnostics?.partTypes === undefined,
          "#168 (census scope): turn 2 carried no assistant parts — turn 1's are NOT inherited",
        );
        c.check(
          !/Parts this turn:/.test(r.error.message),
          "#168 (census scope): an empty census is omitted rather than rendered as a bare label",
        );
      }
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 7. Model-call failure → completed/failed logged + tool error (no fabricated answer).
  //    The expected-call gap stays closed (started+completed present); capture_state
  //    failed makes verify() fail LOUDLY (code 7), as designed (C25/C40).
  // -------------------------------------------------------------------------
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: "x", failMessage: true });
    try {
      const r = await consult(
        { question: "q", model: "openai/allow-model" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(!r.ok, "fail: consult returns a tool error");
      if (!r.ok) {
        c.check(r.error.kind === "call-failed", "fail: error kind is call-failed");
        // fix 1: exitAnalogue must be null, NEVER 0 (0 collides with C53 success).
        c.check(r.error.exitAnalogue === null, "fail: call-failed exitAnalogue is null (never 0)");
        c.check(!/answer/i.test(r.error.message) || /No answer was produced/.test(r.error.message), "fail: no fabricated answer");
        // The run still has exactly one started + one completed (gap closed).
        const runId = new EvidenceLog({ env }).latest();
        c.check(!!runId, "fail: a run was created (newRun before the call)");
        if (runId) {
          const entries = readEntries(logDir, runId);
          const started = entries.filter((e) => e.type === "call" && e.status === "started");
          const completed = entries.filter((e) => e.type === "call" && e.status === "completed");
          c.check(started.length === 1 && completed.length === 1, "fail: expected-call gap closed (1 started, 1 completed)");
          c.check(completed[0]?.capture_state === "failed", "fail: completed records capture_state failed");
          c.check(new EvidenceLog({ env }).verify(runId).code === 7, "fail: verify fails LOUDLY on the failed capture (code 7)");
        }
      }
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 8. runId threading: two calls, one run, DISTINCT call_ids, cardinality verifies.
  // -------------------------------------------------------------------------
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_LOG_PROMPTS: "full", GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: "answer" });
    try {
      const r1 = await consult(
        { question: "first", model: "openai/allow-model" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(r1.ok, "thread: first call ok");
      const runId = r1.ok ? r1.attribution.runId : "";
      const r2 = await consult(
        { question: "second", model: "openai/allow-model", runId },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(r2.ok, "thread: second call ok");
      if (r1.ok && r2.ok) {
        c.check(r2.attribution.runId === runId, "thread: second call reused the same run");
        c.check(r1.attribution.callId !== r2.attribution.callId, "thread: the two calls have distinct call_ids");
        const entries = readEntries(logDir, runId);
        const expected = entries.filter((e) => e.type === "expected-call");
        c.check(expected.length === 2, "thread: two expected-call entries in one run");
        c.check(new EvidenceLog({ env }).verify(runId).code === 0, "thread: the two-call run verifies (cardinality both directions)");
      }
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 9. LAYERED roots surface in guild_status's doctor seed (issue #19).
  //    Pre-#19 this asserted a "multiple roots — one SHADOWS the others" warning. Roots are
  //    now LAYERED (project over global baseline), so both bind and there is nothing to warn
  //    about; what the seed must report instead is the whole chain.
  // -------------------------------------------------------------------------
  {
    // Two roots on disk: <cwd>/modelguild and <home>/.claude/modelguild, no GUILD_ROOT.
    const cwd = tmp("m5-proj-");
    mkdirSync(path.join(cwd, "modelguild"), { recursive: true });
    const home = tmp("m5-home-");
    mkdirSync(path.join(home, ".claude", "modelguild"), { recursive: true });
    const projectRoot = path.join(cwd, "modelguild");
    const globalRoot = path.join(home, ".claude", "modelguild");
    const env = envWith({}); // no GUILD_ROOT

    const seed = guildDoctorSeed(env, cwd, home);
    c.check(seed.guildRoot.source === "project", "layers: the project root is PRIMARY (writes/logs)");
    c.check(seed.guildRoot.conflict === null,
      "layers: project + global on disk is NOT a conflict any more — it is the layering");
    c.check(
      seed.guildRoot.layers.length === 2 &&
        seed.guildRoot.layers[0].root === projectRoot &&
        seed.guildRoot.layers[1].root === globalRoot,
      "layers: the seed reports BOTH read layers, most-specific first",
    );
    c.check(
      seed.policy.layers.some((l) => l.root === projectRoot) &&
        seed.policy.layers.some((l) => l.root === globalRoot),
      "layers: the policy chain reports a layer from EACH root (project + global)",
    );
    c.check(seed.policy.layers.every((l) => typeof l.exists === "boolean"),
      "layers: each policy layer reports whether its file is present");
    c.check(typeof seed.policy.file === "string" && seed.policy.file.length > 0, "layers: policy file + source reported");
    c.check(typeof seed.logging.enabled === "boolean" && typeof seed.logging.logDir === "string", "layers: logging on/off + log dir reported");

    // $GUILD_ROOT is a SINGLE-ROOT override: exactly one layer, and — because a real global
    // root exists on disk that is NOT layered under it — the note fires.
    const single = guildDoctorSeed(envWith({ GUILD_ROOT: projectRoot }), cwd, home);
    c.check(single.guildRoot.layers.length === 1 && single.guildRoot.layers[0].root === projectRoot,
      "layers: $GUILD_ROOT yields exactly one layer (single-root override)");
    c.check(
      typeof single.guildRoot.conflict === "string" &&
        single.guildRoot.conflict.includes(globalRoot) &&
        /NOT layered/i.test(single.guildRoot.conflict),
      "layers: $GUILD_ROOT names the roots on disk it is leaving UNLAYERED",
    );

    // $GUILD_ROOT with nothing else on disk → nothing is being dropped, so no note.
    const clean = guildDoctorSeed(envWith({ GUILD_ROOT: projectRoot }), tmp("m5-noproj-"), tmp("m5-nohome-"));
    c.check(clean.guildRoot.conflict === null,
      "layers: $GUILD_ROOT with no other root on disk reports no note (nothing dropped)");

    // PAYLOAD (issue #94) — `guild_status` is the third surface on the ONE detection, and the
    // tool description names `structuredContent.payload`, so the seed must actually carry it.
    // (The wire-level `structuredContent` assertion lives in mcp-client.test, which needs the
    // real opencode binary; this offline check is the one CI runs.)
    c.check(
      typeof seed.payload.serverVersion === "string" &&
        Array.isArray(seed.payload.skewed) &&
        Array.isArray(seed.payload.drifted) &&
        Array.isArray(seed.payload.unknown),
      "payload: the doctor seed classifies the installed payload (skewed / drifted / unknown)",
    );
    c.check(
      typeof seed.payload.noticeEnabled === "boolean" && typeof seed.payload.noticeStatePath === "string",
      "payload: the seed reports the notice knob AND where its suppression state lives",
    );
    // The knob governs the START-UP notice only: guild_status was asked for, so it answers
    // either way (issue #23's `logs clean`-under-`GUILD_LOG=off` precedent).
    const offSeed = guildDoctorSeed(envWith({ GUILD_PAYLOAD_NOTICE: "off" }), cwd, home);
    c.check(
      offSeed.payload.noticeEnabled === false && Array.isArray(offSeed.payload.skewed),
      "payload: GUILD_PAYLOAD_NOTICE=off is REPORTED but does not stop guild_status classifying",
    );
  }

  // -------------------------------------------------------------------------
  // 10. Leading-dash model PARAM → model-id error (exit-2 analogue); zero log entries.
  //     Refused before any log write, exactly like a policy refusal (C12/C24).
  // -------------------------------------------------------------------------
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: "unreached" });
    try {
      const r = await consult(
        { question: "q", model: "-oh-no" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(!r.ok, "dash-param: consult refuses a leading-dash model id");
      if (!r.ok) {
        c.check(r.error.kind === "model-id", "dash-param: error kind is model-id");
        c.check(r.error.exitAnalogue === 2, "dash-param: exit analogue is 2");
      }
      c.check(fake.recorded.messageBodies.length === 0, "dash-param: no model call made");
      c.check(readdirSync(logDir).length === 0, "dash-param: ZERO log entries");
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 11. GUILD_LOG=off + a THROWING serve → no crash; call-failed returned; nothing
  //     logged (logging disabled means every log hook short-circuits, C31 posture).
  // -------------------------------------------------------------------------
  {
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_LOG: "off", GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: "x", failMessage: true });
    try {
      let threw = false;
      let r: ConsultResult | undefined;
      try {
        r = await consult(
          { question: "q", model: "openai/allow-model" },
          { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
        );
      } catch {
        threw = true;
      }
      c.check(!threw, "log-off: consult does not crash when logging is off and the serve throws");
      c.check(!!r && !r.ok && r.error.kind === "call-failed", "log-off: call-failed returned");
      c.check(!!r && !r.ok && r.error.exitAnalogue === null, "log-off: exitAnalogue null");
      c.check(readdirSync(logDir).length === 0, "log-off: nothing written (logging disabled)");
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 12. Double refusal (leading-dash AND deny-tier) → model-id wins DETERMINISTICALLY.
  //     The model-id check runs before the policy gate, so a dash-leading id is refused
  //     as model-id even when a `deny -*` rule would also match it.
  // -------------------------------------------------------------------------
  {
    const root = tmp("m5-guild-");
    // `deny -*` would ALSO deny the dash-leading id — but model-id is checked first.
    writeFileSync(path.join(root, "models.policy.local"), "# double-refusal\ndeny -*\n");
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: "unreached" });
    try {
      const r = await consult(
        { question: "q", model: "-denied-and-dashed" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(!r.ok, "double: consult refuses");
      if (!r.ok) {
        c.check(r.error.kind === "model-id", "double: model-id wins (checked before policy), NOT policy-deny");
        c.check(r.error.exitAnalogue === 2, "double: exit analogue is 2 (model-id), deterministically");
      }
      c.check(readdirSync(logDir).length === 0, "double: nothing logged");
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // Session continuation (M7 / Option B): consult keepSession → id returned + session
  // KEPT; a follow-up consult threads that sessionId (no re-transmitting the peer's
  // words) and carries the session id on BOTH its started and completed entries; the
  // one threaded run verifies under verify with session ids present.
  // -------------------------------------------------------------------------
  {
    const root = tmp("m5-guild-"); // no policy ⇒ default-allow
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_LOG_PROMPTS: "full", GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: "turn answer" });
    try {
      // Round 1: keepSession → session id returned, session NOT deleted yet.
      const r1 = await consult(
        { question: "round 1 question", model: "openai/gpt-fake", keepSession: true },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(r1.ok, "session: round-1 consult ok");
      const runId = r1.ok ? r1.attribution.runId : "";
      const sid = r1.ok ? r1.sessionId : undefined;
      c.check(!!sid && sid === "ses_fake", "session: keepSession returned the session id");
      c.check(fake.recorded.deletes.length === 0, "session: round-1 kept the session (no delete)");
      const wire1 = consultToToolResult(r1);
      c.check(
        (wire1.structuredContent as Record<string, unknown>)?.sessionId === "ses_fake",
        "session: MCP result surfaces the kept sessionId",
      );

      // Round 2: CONTINUE that session (sessionId only — the peer's prior turn is NOT
      // re-sent), threaded into the same run.
      const r2 = await consult(
        { question: "round 2 — my new turn only", model: "openai/gpt-fake", runId, sessionId: sid },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(r2.ok, "session: round-2 continuation ok");
      c.check(fake.recorded.createBodies.length === 1, "session: continuation made NO new create (still just round-1's)");
      c.check(fake.recorded.messageBodies.length === 2, "session: two turns total went to the session");
      c.check(fake.recorded.deletes.length === 1 && fake.recorded.deletes[0] === "ses_fake", "session: round-2 (keepSession off) deleted the continued session once");

      // The continuation's started AND completed both carry the session id.
      const call2Id = r2.ok ? r2.attribution.callId : "";
      const entries = readEntries(logDir, runId);
      const started2 = entries.find((e) => e.call_id === call2Id && e.status === "started");
      const completed2 = entries.find((e) => e.call_id === call2Id && e.status === "completed");
      c.check(started2?.session_id === "ses_fake", "session: round-2 STARTED entry carries session_id");
      c.check(completed2?.session_id === "ses_fake", "session: round-2 COMPLETED entry carries session_id");

      // The single threaded run verifies under verify, session ids present.
      c.check(new EvidenceLog({ env }).verify(runId).code === 0, "session: threaded run passes TS verify()");
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // Agent MISMATCH (positive-direction over bash C16): opencode serves a DIFFERENT
  // agent than requested → fail closed. No answer returned; completed recorded as
  // capture_state:failed; the run is still well-formed (verify passes — a failed
  // capture is legitimate, an unpaired entry is not).
  // -------------------------------------------------------------------------
  {
    const root = tmp("m5-guild-"); // default-allow
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_LOG_PROMPTS: "full", GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: "FULL-ACCESS ANSWER", servedAgent: "build" });
    try {
      const r = await consult(
        { question: "q", model: "openai/gpt-fake" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(!r.ok, "mismatch: consult fails closed");
      if (!r.ok) {
        c.check(r.error.kind === "agent-mismatch", "mismatch: kind is agent-mismatch");
        c.check(r.error.message.includes("guild-read") && r.error.message.includes("build"), "mismatch: message names requested (guild-read) and served (build)");
        c.check(!("answer" in r), "mismatch: NO answer field on the failure result");
      }
      const wire = consultToToolResult(r);
      c.check(wire.isError === true, "mismatch: MCP result flags isError");
      c.check(!wire.content[0].text.includes("FULL-ACCESS ANSWER"), "mismatch: the wrong-agent answer is NOT surfaced");

      // The run recorded exactly one started + one completed(failed). A failed capture is
      // a real evidence GAP: verify must FLAG it (code 7), not report clean — the witness
      // has to see the wrong-agent call failed, never a false all-good. (The `latest`
      // symlink also lives in logDir, so filter it out to find the single run dir.)
      const dirs = readdirSync(logDir).filter((d) => d !== "latest");
      c.check(dirs.length === 1, "mismatch: exactly one run dir was written (call gated-open, then failed closed)");
      const rid = dirs[0];
      const entries = readEntries(logDir, rid);
      const completed = entries.find((e) => e.type === "call" && e.status === "completed");
      c.check(completed?.capture_state === "failed", "mismatch: completed entry is capture_state:failed");
      c.check(completed?.raw_response === "", "mismatch: NO wrong-agent response captured");
      c.check(new EvidenceLog({ env }).verify(rid).code === 7, "mismatch: verify FLAGS the failed capture (code 7) — the gap is visible");
    } finally {
      await fake.close();
    }
  }

  // MATCH: served agent equals requested → normal success (the check is not a false trip).
  {
    const root = tmp("m5-guild-");
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: "read-only answer", servedAgent: "guild-read" });
    try {
      const r = await consult(
        { question: "q", model: "openai/gpt-fake" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(r.ok, "match: consult succeeds when the served agent matches");
      c.check(r.ok && r.answer === "read-only answer", "match: the answer is returned");
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // N. Per-call timeoutMs precedence + wiring (issue #37 per-call override).
  //    Observed behaviourally: the fake delays its response, so a small effective
  //    timeout ABORTS (ok:false) and a large one does not. No deps.messageTimeoutMs
  //    here — so the effective timeout is exactly params.timeoutMs ?? env/conf/default.
  // -------------------------------------------------------------------------
  {
    // (a) A small per-call timeoutMs WINS over a large env GUILD_MESSAGE_TIMEOUT_MS:
    //     the call aborts despite env allowing it — proving the param reached the turn.
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_MESSAGE_TIMEOUT_MS: "60000", GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: "late answer", messageDelayMs: 300 });
    try {
      const r = await consult(
        { question: "hi", model: "openai/allowed-model", timeoutMs: 100 },
        { serve: fakeServe(fake), env }, // NO messageTimeoutMs seam: params.timeoutMs is the source
      );
      c.check(!r.ok, "per-call: a small timeoutMs aborts the turn (wins over large env value)");
      c.check(!r.ok && r.error.kind === "call-failed", "per-call: abort surfaces as call-failed");
      c.check(fake.recorded.messageBodies.length === 1, "per-call: the model call was actually attempted");
    } finally {
      await fake.close();
    }
  }
  {
    // (b) Absent a per-call param, the env GUILD_MESSAGE_TIMEOUT_MS is what binds: a small
    //     env value aborts the same delayed response — proving the resolver fallback path.
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_MESSAGE_TIMEOUT_MS: "100", GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: "late answer", messageDelayMs: 300 });
    try {
      const r = await consult(
        { question: "hi", model: "openai/allowed-model" }, // no timeoutMs
        { serve: fakeServe(fake), env },
      );
      c.check(!r.ok, "no per-call: the env GUILD_MESSAGE_TIMEOUT_MS binds (small env value aborts)");
    } finally {
      await fake.close();
    }
  }
  {
    // (c) A large per-call timeoutMs lets the same delayed response THROUGH — the positive
    //     control for (a), proving the abort in (a) was the timeout, not something else.
    const root = makeGuildRoot();
    const logDir = tmp("m5-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_MESSAGE_TIMEOUT_MS: "40", GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: "late answer", messageDelayMs: 200 });
    try {
      const r = await consult(
        { question: "hi", model: "openai/allowed-model", timeoutMs: 30000 },
        { serve: fakeServe(fake), env }, // per-call 30s wins over the tiny env 40ms
      );
      c.check(r.ok, "per-call: a large timeoutMs lets a slow response through (wins over tiny env value)");
      c.check(r.ok && r.answer === "late answer", "per-call: the delayed answer is returned intact");
    } finally {
      await fake.close();
    }
  }

  // cleanup
  for (const d of tmpDirs) {
    try {
      if (existsSync(d)) rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  console.log(`consult.test: ${c.passes} passed, ${c.failures} failed`);
  return c.failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((f) => process.exit(f > 0 ? 1 : 0));
}
