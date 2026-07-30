/**
 * guild_panel tests (CONTRACT.md C13/C14, C23, C43/C44 + area-F command
 * surface for exact-id attribution) — OFFLINE.
 *
 * No model is called: every member turn is served by the `node:http` fake
 * (test/fake-opencode-server.ts) behind a `ServeProvider`. The evidence layer writes to
 * a temp GUILD_LOG_DIR, and the flagship case verifies a TOOL-PRODUCED CONCURRENT run
 * (3 members, 9 lifecycle entries) with the TS `verify()` (the reference verifier; the
 * bash `log.sh verify` it was cross-checked against retired at M12).
 */

import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { panel, panelToToolResult, type PanelResult } from "../src/panel.js";
import { EvidenceLog } from "../src/log.js";
import { startFakeOpencode, type FakeOpencode } from "./fake-opencode-server.js";
import type { ServeProvider } from "../src/client.js";
import { Checker, fakeServeHandle } from "./harness.js";

/** A `ServeProvider` pointing `withServe` at an already-running fake (no opencode). */
function fakeServe(fake: FakeOpencode): ServeProvider {
  const handle = fakeServeHandle(fake.baseUrl);
  return { withServe: (fn) => fn(handle) };
}

const tmpDirs: string[] = [];
function tmp(prefix = "m6-"): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/** A guild root with the given policy body; returns its path. */
function rootWithPolicy(policy: string): string {
  const root = tmp("m6-guild-");
  writeFileSync(path.join(root, "models.policy.local"), policy);
  return root;
}

/** An agent-def dir CONTAINING a guild-read.md so the whole-panel presence gate passes.
 * Pinned via GUILD_AGENT_DIR on every gate-traversing test so the pass does NOT depend on an
 * ambient def (repo cwd `.opencode/agent/` or a container-global install) — the #24 hermeticity
 * rule (mirrors defDirWithResearch/defDirWithBuild). Note the no-models test also needs this:
 * the def gate runs BEFORE model-set resolution, so without it that test would refuse with
 * agent-def-missing instead of no-models. */
function defDirWithRead(): string {
  const dir = tmp("m6-agent-");
  writeFileSync(path.join(dir, "guild-read.md"), "---\nmode: all\n---\nfake\n");
  return dir;
}

/** A clean env: process.env minus every GUILD_* knob, then the given overrides. */
function envWith(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith("GUILD_")) delete base[k];
  return { ...base, ...overrides };
}

function readEntries(logDir: string, runId: string): Array<Record<string, unknown>> {
  const file = path.join(logDir, runId, "calls.jsonl");
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

export async function run(): Promise<number> {
  const c = new Checker();
  console.log("== panel.test (M6 guild_panel) ==");

  // -------------------------------------------------------------------------
  // 0. NO-FALLBACK def gate: a MISSING guild-read.md refuses the WHOLE panel up front
  //    (exit-5), NOTHING logged, NO model call — one check for every member (all use
  //    guild-read), mirroring research/delegate (issue #34). Refused BEFORE model-set
  //    resolution, so even a valid model list does not run any member.
  // -------------------------------------------------------------------------
  {
    const root = rootWithPolicy(""); // default-allow
    const logDir = tmp("m6-logs-");
    const emptyDefDir = tmp("m6-emptyagent-"); // no guild-read.md inside
    // HERMETICITY (issue #24): resolveAgentDefDirs also looks in the GLOBAL opencode dir
    // (`${XDG_CONFIG_HOME:-~/.config}/opencode/agent/`). On a box with a global install (e.g.
    // this dev container) that dir HAS guild-read.md, so the def would resolve globally and the
    // panel would NOT refuse. Point XDG_CONFIG_HOME at an empty temp dir so the global dir
    // resolves to an empty location; now BOTH dirs are genuinely def-free.
    const emptyXdg = tmp("m6-emptyxdg-"); // <emptyXdg>/opencode/agent does not exist
    const env = envWith({
      GUILD_ROOT: root,
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: emptyDefDir,
      XDG_CONFIG_HOME: emptyXdg,
    });
    const fake = await startFakeOpencode({ historyText: "should never be reached" });
    try {
      const r = await panel(
        { question: "q", models: ["alpha/one", "beta/two"] },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(!r.ok, "def-missing: the WHOLE panel refuses");
      if (!r.ok) {
        c.check(r.error.kind === "agent-def-missing", "def-missing: kind is agent-def-missing");
        c.check(r.error.exitAnalogue === 5, "def-missing: exit analogue is 5 (C57)");
        c.check(r.error.message.includes("guild-read"), "def-missing: message names the agent");
        c.check(r.error.message.includes(emptyDefDir), "def-missing: message names the dir searched");
        c.check(/no.*fallback/i.test(r.error.message), "def-missing: message states there is no fallback");
      }
      c.check(fake.recorded.messageBodies.length === 0, "def-missing: no member reached a model");
      c.check(readdirSync(logDir).length === 0, "def-missing: NOTHING logged (gap parity)");
      c.check(panelToToolResult(r).isError === true, "def-missing: MCP result flags isError");
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 1. Model-set resolution: precedence (param > env) + dedup + diversity warning.
  // -------------------------------------------------------------------------
  {
    // 1a. Explicit `models` param wins over $GUILD_MODELS (C13 precedence).
    const root = rootWithPolicy(""); // empty ⇒ default-allow
    const logDir = tmp("m6-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_MODELS: "env/should-not-win", GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: "voice" });
    try {
      const r = await panel(
        { question: "q", models: ["alpha/one", "beta/two"] },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(r.ok, "resolve: panel ok");
      if (r.ok) {
        c.check(
          r.results.map((m) => m.model).join(",") === "alpha/one,beta/two",
          "resolve: explicit models param wins over GUILD_MODELS env, order preserved",
        );
        c.check(r.results.every((m) => m.text === "voice"), "resolve: both allow members answered");
      }
    } finally {
      await fake.close();
    }

    // 1b. Dedup: a repeated id is dropped (first-seen order kept) + a dedup warning (C14).
    const fake2 = await startFakeOpencode({ historyText: "voice" });
    try {
      const r = await panel(
        { question: "q", models: ["alpha/one", "alpha/one", "beta/two"] },
        { serve: fakeServe(fake2), env, messageTimeoutMs: 5_000 },
      );
      c.check(r.ok, "dedup: panel ok");
      if (r.ok) {
        c.check(r.results.length === 2, "dedup: duplicate collapsed to 2 members");
        c.check(
          r.warnings.some((w) => /duplicate model 'alpha\/one'/.test(w)),
          "dedup: a duplicate-dropped warning is surfaced (never silent)",
        );
      }
    } finally {
      await fake2.close();
    }

    // 1c. Single-provider set ⇒ "diversity theater" warning surfaced (C14).
    const fake3 = await startFakeOpencode({ historyText: "voice" });
    try {
      const r = await panel(
        { question: "q", models: ["openai/m1", "openai/m2"] },
        { serve: fakeServe(fake3), env, messageTimeoutMs: 5_000 },
      );
      c.check(r.ok, "diversity: panel ok");
      if (r.ok) {
        c.check(
          r.warnings.some((w) => /diversity theater/.test(w) && /provider 'openai'/.test(w)),
          "diversity: single-provider 'diversity theater' warning surfaced",
        );
      }
    } finally {
      await fake3.close();
    }
  }

  // -------------------------------------------------------------------------
  // 2. MIXED panel: allow + deny + ask-unconfirmed. Per-member independence — the
  //    deny/ask members error while the allow member still runs (C43 per-call gating).
  // -------------------------------------------------------------------------
  {
    const root = rootWithPolicy("# mixed\ndeny beta/denied\nask gamma/ask\n");
    const logDir = tmp("m6-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_LOG_PROMPTS: "full", GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: "the allow answer" });
    try {
      const r = await panel(
        { question: "q", models: ["alpha/allow", "beta/denied", "gamma/ask"] },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(r.ok, "mixed: the panel as a whole does NOT refuse (set is non-empty)");
      if (r.ok) {
        const [allow, deny, ask] = r.results;
        // Order preserved (exact-id attribution, area-F command surface).
        c.check(allow.model === "alpha/allow" && deny.model === "beta/denied" && ask.model === "gamma/ask", "mixed: results in input order");
        // Allow member ran.
        c.check(allow.text === "the allow answer" && !allow.error && !!allow.callId, "mixed: allow member answered (text + callId, no error)");
        // Deny member: policy-deny error, NO callId (refused pre-log), NO text.
        c.check(deny.error?.kind === "policy-deny" && deny.error?.tier === "deny" && deny.error?.exitAnalogue === 3, "mixed: deny member → policy-deny (exit-3 analogue)");
        c.check(deny.callId === undefined && deny.text === undefined, "mixed: deny member logged nothing (no callId, no text)");
        c.check(!!deny.error && deny.error.message.includes("beta/denied"), "mixed: deny message names the model");
        // Ask member unconfirmed: policy-ask error, instructs the driver.
        c.check(ask.error?.kind === "policy-ask" && ask.error?.tier === "ask" && ask.error?.exitAnalogue === 4, "mixed: ask member → policy-ask (exit-4 analogue)");
        c.check(!!ask.error && /confirmed:true/.test(ask.error.message) && /ask the user/i.test(ask.error.message), "mixed: ask message tells the driver to ask the human and retry with confirmed:true");
        c.check(ask.callId === undefined, "mixed: ask member logged nothing");
        // Only ONE model call was actually made (the allow member).
        c.check(fake.recorded.messageBodies.length === 1, "mixed: exactly one model call made (deny/ask never reached the model)");
        // The run holds exactly the allow member's lifecycle and verifies clean.
        const entries = readEntries(logDir, r.runId);
        const expected = entries.filter((e) => e.type === "expected-call");
        c.check(expected.length === 1, "mixed: exactly one expected-call in the run (only the allow member)");
        c.check(new EvidenceLog({ env }).verify(r.runId).code === 0, "mixed: run verifies clean (TS)");
      }
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 3. Panel-wide confirmed:true unlocks an ask-tier member (C41 scope, documented).
  // -------------------------------------------------------------------------
  {
    const root = rootWithPolicy("ask gamma/ask\n");
    const logDir = tmp("m6-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_LOG_PROMPTS: "full", GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: "approved voice" });
    try {
      const r = await panel(
        { question: "q", models: ["alpha/allow", "gamma/ask"], confirmed: true },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(r.ok, "confirmed: panel ok");
      if (r.ok) {
        c.check(r.results.every((m) => m.text === "approved voice" && !m.error), "confirmed: one confirmed:true unlocked the ask-tier member too (panel-wide)");
        c.check(fake.recorded.messageBodies.length === 2, "confirmed: both members reached the model");
        // The ask member's entries record tier=ask, confirmed=true (the audit trail).
        const entries = readEntries(logDir, r.runId);
        const askStarted = entries.find((e) => e.type === "call" && e.status === "started" && e.model === "gamma/ask");
        c.check(askStarted?.tier === "ask" && askStarted?.confirmed === true, "confirmed: ask member started records tier=ask, confirmed=true");
        const allowStarted = entries.find((e) => e.type === "call" && e.status === "started" && e.model === "alpha/allow");
        c.check(allowStarted?.tier === "allow" && allowStarted?.confirmed === true, "confirmed: allow member records tier=allow (confirmed flag carried but tier is allow)");
        c.check(new EvidenceLog({ env }).verify(r.runId).code === 0, "confirmed: run verifies clean");
      }
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 4. Leading-dash member → per-member model-id error; others unaffected.
  // -------------------------------------------------------------------------
  {
    const root = rootWithPolicy("");
    const logDir = tmp("m6-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: "voice" });
    try {
      const r = await panel(
        { question: "q", models: ["-oh-no", "alpha/ok"] },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(r.ok, "dash: panel as a whole is not refused");
      if (r.ok) {
        c.check(r.results[0].error?.kind === "model-id" && r.results[0].error?.exitAnalogue === 2, "dash: leading-dash member → model-id error (exit-2 analogue)");
        c.check(r.results[0].callId === undefined, "dash: dash member logged nothing");
        c.check(r.results[1].text === "voice" && !r.results[1].error, "dash: the other member still ran");
      }
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 5. FLAGSHIP: 3-member CONCURRENT panel — distinct call_ids, distinct turns, ONE run,
  //    passes TS verify() with exact cardinality in both directions.
  // -------------------------------------------------------------------------
  {
    const root = rootWithPolicy(""); // default-allow
    const logDir = tmp("m6-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_LOG_PROMPTS: "full", GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: "panel voice", syncText: "SYNC-MUST-NOT-LEAK" });
    try {
      const r = await panel(
        { question: "review this\n", models: ["alpha/m1", "beta/m2", "gamma/m3"] },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(r.ok, "flagship: panel ok");
      if (r.ok) {
        c.check(r.results.length === 3, "flagship: three members");
        c.check(r.results.every((m) => m.text === "panel voice" && !m.error), "flagship: all three answered");
        const callIds = r.results.map((m) => m.callId!);
        c.check(new Set(callIds).size === 3 && callIds.every((id) => !!id), "flagship: three DISTINCT call_ids");
        c.check(r.results.map((m) => m.model).join(",") === "alpha/m1,beta/m2,gamma/m3", "flagship: exact-id attribution, input order");

        const entries = readEntries(logDir, r.runId);
        // Exactly 3 expected / 3 started / 3 completed, all in one run.
        c.check(entries.filter((e) => e.type === "expected-call").length === 3, "flagship: 3 expected-call entries");
        const started = entries.filter((e) => e.type === "call" && e.status === "started");
        const completed = entries.filter((e) => e.type === "call" && e.status === "completed");
        c.check(started.length === 3 && completed.length === 3, "flagship: 3 started + 3 completed (9 lifecycle entries)");
        // Distinct turns under the real lock (no two members claimed the same turn).
        const turns = started.map((e) => e.turn as number).sort();
        c.check(JSON.stringify(turns) === JSON.stringify([1, 2, 3]), "flagship: DISTINCT turns 1,2,3 (lock counted them, no race)");
        // Every call_id has exactly one of each lifecycle entry.
        const perCallOk = callIds.every((id) => {
          const eN = entries.filter((e) => e.type === "expected-call" && e.call_id === id).length;
          const sN = entries.filter((e) => e.type === "call" && e.status === "started" && e.call_id === id).length;
          const cN = entries.filter((e) => e.type === "call" && e.status === "completed" && e.call_id === id).length;
          return eN === 1 && sN === 1 && cN === 1;
        });
        c.check(perCallOk, "flagship: every call_id has exactly one expected/started/completed");

        // verify on the concurrent tool-produced run.
        c.check(new EvidenceLog({ env }).verify(r.runId).code === 0, "FLAGSHIP: TS verify() passes the 3-member concurrent run (code 0)");

        // The MCP wire shape carries every voice + the warnings, byte-exact through JSON.
        const wire = panelToToolResult(r);
        const round = JSON.parse(JSON.stringify(wire)) as {
          content: Array<{ text: string }>;
          structuredContent: { results: Array<{ model: string; text?: string }>; runId: string };
          isError?: boolean;
        };
        c.check(round.isError === undefined, "flagship: a successful panel is NOT an MCP error");
        c.check(round.structuredContent.results.length === 3 && round.structuredContent.runId === r.runId, "flagship: structuredContent carries 3 results + the runId");
        c.check(round.content[0].text.includes("panel voice"), "flagship: text digest carries the voices");
      }
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 6. Empty set → the WHOLE panel refuses (C14 exit-2); nothing logged.
  // -------------------------------------------------------------------------
  {
    const root = rootWithPolicy("");
    const logDir = tmp("m6-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() }); // no GUILD_MODELS
    const fake = await startFakeOpencode({ historyText: "unreached" });
    try {
      const r = await panel(
        { question: "q" }, // no models param, no env, no conf
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(!r.ok, "empty: the panel refuses when no models resolve");
      if (!r.ok) {
        c.check(r.error.kind === "no-models" && r.error.exitAnalogue === 2, "empty: no-models refusal (exit-2 analogue)");
      }
      c.check(fake.recorded.messageBodies.length === 0, "empty: no model call made");
      c.check(readdirSync(logDir).length === 0, "empty: NOTHING logged (no run minted)");
      // The MCP wire shape marks a whole-panel refusal as an error.
      const wire = panelToToolResult(r);
      c.check(wire.isError === true, "empty: MCP result is isError:true (a refusal to act on)");
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 7. runId threading: two panel calls share ONE run; distinct call_ids; verifies.
  // -------------------------------------------------------------------------
  {
    const root = rootWithPolicy("");
    const logDir = tmp("m6-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_LOG_PROMPTS: "full", GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: "voice" });
    try {
      const r1 = await panel(
        { question: "first", models: ["alpha/m1", "beta/m2"] },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(r1.ok, "thread: first panel ok");
      const runId = r1.ok ? r1.runId : "";
      const r2 = await panel(
        { question: "second", models: ["gamma/m3", "delta/m4"], runId },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(r2.ok, "thread: second panel ok");
      if (r1.ok && r2.ok) {
        c.check(r2.runId === runId, "thread: second panel reused the same run");
        const allCallIds = [...r1.results, ...r2.results].map((m) => m.callId!);
        c.check(new Set(allCallIds).size === 4, "thread: all four members have distinct call_ids");
        const entries = readEntries(logDir, runId);
        c.check(entries.filter((e) => e.type === "expected-call").length === 4, "thread: four expected-call entries in ONE run");
        c.check(new EvidenceLog({ env }).verify(runId).code === 0, "thread: the four-call run verifies (TS)");
      }
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 8. One member's model FAILURE never aborts the others (per-member call-failed).
  // -------------------------------------------------------------------------
  {
    const root = rootWithPolicy("");
    const logDir = tmp("m6-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithRead() });
    // failMessage makes EVERY model turn fail — so both members record completed/failed
    // and each surfaces a per-member call-failed, and the panel still resolves (no throw).
    const fake = await startFakeOpencode({ historyText: "x", failMessage: true });
    try {
      let threw = false;
      let r: PanelResult | undefined;
      try {
        r = await panel(
          { question: "q", models: ["alpha/m1", "beta/m2"] },
          { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
        );
      } catch {
        threw = true;
      }
      c.check(!threw, "fail: a member failure does not reject the whole panel");
      c.check(!!r && r.ok, "fail: the panel resolves ok (per-member errors are data)");
      if (r && r.ok) {
        c.check(r.results.every((m) => m.error?.kind === "call-failed" && m.error?.exitAnalogue === null), "fail: each member surfaces a call-failed (exitAnalogue null)");
        c.check(r.results.every((m) => !!m.callId), "fail: each failed member still recorded its call (gap closed)");
        c.check(r.results.every((m) => m.text === undefined), "fail: no fabricated answer on a failed member");
      }
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 9. Cross-call confirmed NON-LEAK: two sequential panels share one run. Call 1
  //    passes confirmed:true with an ask-tier member (which proceeds, recorded
  //    tier=ask/confirmed=true); call 2 re-includes that ask-tier member WITHOUT
  //    confirmed and it MUST be re-gated to policy-ask — the earlier approval does not
  //    leak across calls even though the run id is shared. (Verified by construction:
  //    `confirmed` is a per-call param, gated fresh per member; pinned here.)
  // -------------------------------------------------------------------------
  {
    const root = rootWithPolicy("ask gamma/ask\n");
    const logDir = tmp("m6-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_LOG_PROMPTS: "full", GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: "voice" });
    try {
      // Call 1: confirmed:true → the ask member proceeds.
      const r1 = await panel(
        { question: "first", models: ["gamma/ask"], confirmed: true },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(r1.ok, "non-leak: call 1 ok");
      const runId = r1.ok ? r1.runId : "";
      c.check(r1.ok && r1.results[0].text === "voice" && !r1.results[0].error, "non-leak: call 1's ask member proceeded under confirmed:true");

      // Call 2: SAME run, a fresh allow member + the SAME ask member, but NO confirmed.
      const r2 = await panel(
        { question: "second", models: ["beta/allow", "gamma/ask"], runId },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(r2.ok, "non-leak: call 2 ok (not wholesale refused)");
      if (r1.ok && r2.ok) {
        c.check(r2.runId === runId, "non-leak: call 2 reused call 1's run");
        const [beta, gamma2] = r2.results;
        c.check(beta.text === "voice" && !beta.error, "non-leak: call 2's allow member ran under the shared run");
        // THE POINT: the ask member is re-gated per call — confirmed did NOT leak.
        c.check(gamma2.error?.kind === "policy-ask" && gamma2.error?.tier === "ask", "non-leak: call 2's ask member is RE-GATED to policy-ask (no cross-call confirmed leak)");
        c.check(gamma2.callId === undefined && gamma2.text === undefined, "non-leak: call 2's ask member logged nothing (refused pre-log)");

        // The run holds exactly: gamma (call 1, confirmed=true) + beta (call 2, allow).
        const entries = readEntries(logDir, runId);
        const gammaStarted = entries.filter((e) => e.type === "call" && e.status === "started" && e.model === "gamma/ask");
        c.check(gammaStarted.length === 1, "non-leak: exactly ONE gamma/ask started (call 1 only; call 2's was refused pre-log)");
        c.check(gammaStarted[0]?.tier === "ask" && gammaStarted[0]?.confirmed === true, "non-leak: call 1's gamma entry carries tier=ask, confirmed=true");
        const betaStarted = entries.find((e) => e.type === "call" && e.status === "started" && e.model === "beta/allow");
        c.check(betaStarted?.tier === "allow" && betaStarted?.confirmed === false, "non-leak: call 2's beta entry carries tier=allow, confirmed=false");
        c.check(entries.filter((e) => e.type === "expected-call").length === 2, "non-leak: run has exactly 2 expected-calls (gamma call1 + beta call2)");
        c.check(new EvidenceLog({ env }).verify(runId).code === 0, "non-leak: the shared run verifies clean (TS)");
      }
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 10. Panel-scale corruption NEGATIVE: a clean 3-member run, then one member's
  //     `completed` entry is tampered (raw_response altered, entry_hash left STALE) —
  //     verify must go red (code 7). The positive flagship
  //     (test 5) shows a clean run passes; this proves the panel run is not passing
  //     vacuously — an altered answer is caught by both.
  // -------------------------------------------------------------------------
  {
    const root = rootWithPolicy(""); // default-allow
    const logDir = tmp("m6-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_LOG_PROMPTS: "full", GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: "honest answer" });
    try {
      const r = await panel(
        { question: "q", models: ["alpha/m1", "beta/m2", "gamma/m3"] },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(r.ok, "corrupt: panel ok");
      if (r.ok) {
        const runId = r.runId;
        const file = path.join(logDir, runId, "calls.jsonl");
        // Baseline: the clean run passes verify (so the red below is the tamper).
        c.check(new EvidenceLog({ env }).verify(runId).code === 0, "corrupt: clean run passes TS verify() first");

        // Tamper ONE member's completed entry: alter raw_response, keep entry_hash stale.
        const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);
        const idx = lines.findIndex((l) => {
          const e = JSON.parse(l) as Record<string, unknown>;
          return e.type === "call" && e.status === "completed" && e.raw_response === "honest answer";
        });
        c.check(idx >= 0, "corrupt: found a member's completed entry to tamper");
        const tampered = JSON.parse(lines[idx]) as Record<string, unknown>;
        tampered.raw_response = "FORGED ANSWER"; // entry_hash deliberately NOT recomputed
        lines[idx] = JSON.stringify(tampered);
        writeFileSync(file, lines.join("\n") + "\n");

        // verify must now fail LOUDLY.
        const ts = new EvidenceLog({ env }).verify(runId);
        c.check(ts.code === 7, "corrupt: TS verify() goes red (code 7) on the tampered answer");
      }
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 11. keepSessions (M7 / Option B — workshop round 1): each member's session is KEPT
  //     and its DISTINCT id returned per-member, so round 2 can continue each via a
  //     per-member consult loop. No deletes; each completed entry carries its member's
  //     session id; the run verifies under verify with session ids present.
  // -------------------------------------------------------------------------
  {
    const root = rootWithPolicy(""); // default-allow
    const logDir = tmp("m6-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_LOG_PROMPTS: "full", GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: "plan voice", distinctSessions: true });
    try {
      const r = await panel(
        { question: "draft a plan", models: ["alpha/m1", "beta/m2"], keepSessions: true },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(r.ok, "keepSessions: panel ok");
      if (r.ok) {
        const [a, b] = r.results;
        c.check(!!a.sessionId && !!b.sessionId, "keepSessions: both members returned a sessionId");
        c.check(a.sessionId !== b.sessionId, "keepSessions: the two members' session ids are DISTINCT");
        c.check(fake.recorded.deletes.length === 0, "keepSessions: NO sessions deleted (all kept for round 2)");
        c.check(fake.recorded.createBodies.length === 2, "keepSessions: one create per member");

        // Each member's completed entry carries that member's session id.
        const entries = readEntries(logDir, r.runId);
        for (const m of r.results) {
          const completed = entries.find((e) => e.call_id === m.callId && e.status === "completed");
          c.check(completed?.session_id === m.sessionId, `keepSessions: ${m.model} completed entry carries its session id`);
        }
        c.check(new EvidenceLog({ env }).verify(r.runId).code === 0, "keepSessions: run passes TS verify()");
      }
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 12. keepSessions with ONE FAILING member (error-path ownership): the failed member's
  //     session is cleaned up (no orphan) and it returns NO fabricated sessionId, while
  //     the succeeding sibling keeps its session and id. The failed member being
  //     sessionId-less is exactly what makes the round-2 consult loop SKIP it.
  // -------------------------------------------------------------------------
  {
    const root = rootWithPolicy(""); // default-allow
    const logDir = tmp("m6-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_LOG_PROMPTS: "full", GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({
      historyText: "ok voice",
      distinctSessions: true,
      failMessageForModel: "beta/fail",
    });
    try {
      const r = await panel(
        { question: "draft", models: ["alpha/ok", "beta/fail"], keepSessions: true },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(r.ok, "fail-member: panel itself ok (a member failure is data, not a panel abort)");
      if (r.ok) {
        const alpha = r.results.find((m) => m.model === "alpha/ok");
        const beta = r.results.find((m) => m.model === "beta/fail");
        // Sibling unaffected: succeeded, kept its session, has an id.
        c.check(!!alpha && !alpha.error && !!alpha.text, "fail-member: sibling alpha succeeded");
        c.check(!!alpha?.sessionId, "fail-member: sibling alpha kept its sessionId");
        // Failed member: error, NO text, NO fabricated sessionId.
        c.check(!!beta?.error && beta.error.kind === "call-failed", "fail-member: beta reports call-failed");
        c.check(beta?.text === undefined, "fail-member: beta returned no text");
        c.check(beta?.sessionId === undefined, "fail-member: beta has NO fabricated sessionId (round-2 skips it)");
        // No orphan: both sessions were created; the failed one was deleted, the kept one not.
        c.check(fake.recorded.createBodies.length === 2, "fail-member: both members created a session");
        c.check(fake.recorded.deletes.length === 1, "fail-member: exactly one session deleted (the failed member's, no orphan)");
        c.check(alpha?.sessionId !== undefined && !fake.recorded.deletes.includes(alpha.sessionId), "fail-member: the kept sibling session was NOT deleted");
        // beta's failed capture is a real gap: verify FLAGS the run (code 7), so the
        // witness sees the failed member rather than a false clean. (alpha's lifecycle is
        // well-formed; the flag is specifically the failed capture, not a pairing error.)
        c.check(new EvidenceLog({ env }).verify(r.runId).code === 7, "fail-member: verify FLAGS the failed member's gap (TS code 7)");
      }
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 12b. THE ISSUE-#117 CASE, AND THE ONE THAT ACTUALLY BIT: a member whose turn completes
  //      and produces NO TEXT. It used to land as `text: ""` — a blank line in the digest and
  //      a full member entry in `structuredContent` — so a 3-model panel came back with 2
  //      answers and the synthesis proceeded a voice short without saying so.
  //
  //      Now it lands in `error` with kind `empty-answer`, carries NO `text`, and — like every
  //      other failure kind — NO `sessionId` under `keepSessions`, which is what makes the
  //      round-2 consult loop skip it. The sibling is untouched, proving this is per member
  //      rather than a panel-wide abort.
  // -------------------------------------------------------------------------
  {
    const root = rootWithPolicy(""); // default-allow
    const logDir = tmp("m6-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_LOG_PROMPTS: "full", GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({
      historyText: "ok voice",
      distinctSessions: true,
      emptyAnswerForModel: "beta/silent",
    });
    try {
      const r = await panel(
        { question: "draft", models: ["alpha/ok", "beta/silent"], keepSessions: true },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(r.ok, "empty-member: panel itself ok (a silent member is data, not a panel abort)");
      if (r.ok) {
        const alpha = r.results.find((m) => m.model === "alpha/ok");
        const beta = r.results.find((m) => m.model === "beta/silent");
        c.check(!!alpha && !alpha.error && alpha.text === "ok voice", "empty-member: sibling alpha answered normally");
        c.check(!!alpha?.sessionId, "empty-member: sibling alpha kept its sessionId");
        c.check(!!beta?.error && beta.error.kind === "empty-answer", "empty-member: beta reports empty-answer");
        c.check(beta?.text === undefined, "empty-member: beta carries NO text (not text:'')");
        c.check(beta?.error?.exitAnalogue === null, "empty-member: beta's exit analogue is null");
        c.check(!!beta?.error?.message.includes("beta/silent"), "empty-member: beta's message names the model");
        c.check(beta?.sessionId === undefined, "empty-member: beta has NO sessionId under keepSessions (round-2 skips it)");
        c.check(fake.recorded.deletes.length === 1, "empty-member: exactly one session deleted (beta's; no orphan, no leak)");
        c.check(
          alpha?.sessionId !== undefined && !fake.recorded.deletes.includes(alpha.sessionId),
          "empty-member: the kept sibling session was NOT deleted",
        );
        // The DIGEST is the surface a text-only reader sees: a silent member must read as a
        // failure there, not as a blank line under its heading.
        const text = panelToToolResult(r).content[0].text;
        c.check(/ERROR \(empty-answer\)/.test(text), "empty-member: the rendered digest shows a failure, not a blank line");
        // beta's capture COMPLETED (it recorded the empty answer byte-exactly), so unlike the
        // failing-member case above this run verifies CLEAN — the failure is in exit_code,
        // which verify() does not read.
        const entries = readEntries(logDir, r.runId);
        const completed = entries.find((e) => e.call_id === beta?.callId && e.status === "completed");
        c.check(completed?.capture_state === "complete", "empty-member: beta's completed entry stays capture_state complete");
        c.check(completed?.raw_response === "", "empty-member: beta's raw_response is the empty answer");
        c.check(completed?.exit_code === 1, "empty-member: beta's exit_code is 1");
        c.check(new EvidenceLog({ env }).verify(r.runId).code === 0, "empty-member: the run still verifies clean");
      }
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // Per-call timeoutMs applies to EVERY panel member (issue #37). A small per-call
  // value wins over a large env value and aborts each delayed member. No deps seam.
  // -------------------------------------------------------------------------
  {
    const root = rootWithPolicy(""); // default-allow
    const logDir = tmp("m6-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_MESSAGE_TIMEOUT_MS: "60000", GUILD_AGENT_DIR: defDirWithRead() });
    const fake = await startFakeOpencode({ historyText: "voice", messageDelayMs: 300 });
    try {
      const r = await panel(
        { question: "q", models: ["alpha/one", "beta/two"], timeoutMs: 40 },
        { serve: fakeServe(fake), env }, // NO messageTimeoutMs seam: params.timeoutMs is the source
      );
      c.check(r.ok, "per-call: panel resolves");
      if (r.ok) {
        c.check(
          r.results.length === 2 && r.results.every((m) => m.error?.kind === "call-failed"),
          "per-call: a small timeoutMs aborts EVERY member (wins over large env value)",
        );
      }
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

  console.log(`panel.test: ${c.passes} passed, ${c.failures} failed`);
  return c.failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((f) => process.exit(f > 0 ? 1 : 0));
}
