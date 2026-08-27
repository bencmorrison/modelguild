/**
 * guild_research tests (CONTRACT.md C1–C7, C12, C16-deviation, C22–C25,
 * C45, C57) — OFFLINE.
 *
 * No model is called: the model turn is served by the `node:http` fake behind a
 * `ServeProvider`, exactly like the consult/panel tests. Research reuses the SAME gate +
 * lifecycle spine as consult, so these tests focus on what is NEW: the NO-FALLBACK
 * agent-def refusal (a missing guild-research.md is a structured exit-5 refusal, never a
 * silent downgrade), gate parity (deny/ask) on the research path, and that a research run
 * verifies under the TS verifier (the reference; the bash oracle retired at M12).
 */

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { research, researchToToolResult, type ResearchResult } from "../src/research.js";
import { EvidenceLog } from "../src/log.js";
import { canonicalStringify } from "../src/canonical.js";
import { startFakeOpencode, type FakeOpencode } from "./fake-opencode-server.js";
import type { ServeProvider } from "../src/client.js";
import { Checker, fakeServeHandle } from "./harness.js";

function fakeServe(fake: FakeOpencode): ServeProvider {
  const handle = fakeServeHandle(fake.baseUrl);
  return { withServe: (fn) => fn(handle) };
}

const tmpDirs: string[] = [];
function tmp(prefix = "m7r-"): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/** An agent-def dir CONTAINING a guild-research.md so the presence gate passes. The
 * content is irrelevant to the offline test — only the file's existence is checked. */
function defDirWithResearch(): string {
  const dir = tmp("m7r-agent-");
  writeFileSync(path.join(dir, "guild-research.md"), "---\nmode: all\n---\nfake\n");
  return dir;
}

/** A guild root carrying a deny/ask test policy. */
function makeGuildRoot(): string {
  const root = tmp("m7r-guild-");
  writeFileSync(
    path.join(root, "models.policy.local"),
    "# M7 research test policy\ndeny openai/denied-model\nask openai/ask-model\n",
  );
  return root;
}

function envWith(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith("GUILD_")) delete base[k];
  return { ...base, ...overrides };
}

export async function run(): Promise<number> {
  const c = new Checker();
  console.log("== research.test (M7 guild_research) ==");

  // -------------------------------------------------------------------------
  // 1. NO-FALLBACK def gate: a MISSING guild-research.md refuses (exit-5), NOTHING
  //    logged, NO model call — the deliberate deviation from bash C16 (task-directed).
  // -------------------------------------------------------------------------
  {
    const root = makeGuildRoot();
    const logDir = tmp("m7r-logs-");
    const emptyDefDir = tmp("m7r-emptyagent-"); // no guild-research.md inside
    // HERMETICITY: resolveAgentDefDirs also looks in the GLOBAL opencode dir
    // (`${XDG_CONFIG_HOME:-~/.config}/opencode/agent/`). On a box with a global install (e.g.
    // this dev container) that dir HAS guild-research.md, so the def would resolve globally and
    // the tool would NOT refuse — the def-missing path would never run. Point XDG_CONFIG_HOME at
    // an empty temp dir: non-empty, so it wins over the ~/.config fallback, making the global dir
    // resolve to an empty location. Now BOTH dirs are genuinely def-free (issue #24).
    const emptyXdg = tmp("m7r-emptyxdg-"); // <emptyXdg>/opencode/agent does not exist
    const env = envWith({
      GUILD_ROOT: root,
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: emptyDefDir,
      XDG_CONFIG_HOME: emptyXdg,
    });
    const fake = await startFakeOpencode({ historyText: "should never be reached" });
    try {
      const r = await research(
        { question: "what changed in X?", model: "openai/allowed" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(!r.ok, "def-missing: research refuses");
      if (!r.ok) {
        c.check(r.error.kind === "agent-def-missing", "def-missing: kind is agent-def-missing");
        c.check(r.error.exitAnalogue === 5, "def-missing: exit analogue is 5 (C57)");
        c.check(r.error.message.includes("guild-research"), "def-missing: message names the agent");
        c.check(r.error.message.includes(emptyDefDir), "def-missing: message names the dir searched");
        c.check(/no.*fallback/i.test(r.error.message), "def-missing: message states there is no fallback");
      }
      c.check(fake.recorded.messageBodies.length === 0, "def-missing: no model call was made");
      c.check(readdirSync(logDir).length === 0, "def-missing: NOTHING logged (gap parity)");
      const wire = researchToToolResult(r);
      c.check(wire.isError === true, "def-missing: MCP result flags isError");
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 2. gate parity — DENY: def present, model denied → policy-deny (exit-3), nothing logged.
  // -------------------------------------------------------------------------
  {
    const root = makeGuildRoot();
    const logDir = tmp("m7r-logs-");
    const env = envWith({
      GUILD_ROOT: root,
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDirWithResearch(),
    });
    const fake = await startFakeOpencode({ historyText: "unreached" });
    try {
      const r = await research(
        { question: "q", model: "openai/denied-model" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(!r.ok, "deny: research refuses");
      if (!r.ok) {
        c.check(r.error.kind === "policy-deny", "deny: kind is policy-deny");
        c.check(r.error.exitAnalogue === 3, "deny: exit analogue is 3");
        c.check(r.error.tier === "deny", "deny: tier reported as deny");
      }
      c.check(fake.recorded.messageBodies.length === 0, "deny: no model call");
      c.check(readdirSync(logDir).length === 0, "deny: NOTHING logged");
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 3. gate parity — ASK unconfirmed → policy-ask (exit-4); confirmed:true proceeds.
  // -------------------------------------------------------------------------
  {
    const root = makeGuildRoot();
    const logDir = tmp("m7r-logs-");
    const env = envWith({
      GUILD_ROOT: root,
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDirWithResearch(),
    });
    const fake = await startFakeOpencode({ historyText: "researched answer" });
    try {
      const unc = await research(
        { question: "q", model: "openai/ask-model" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(!unc.ok && unc.error.kind === "policy-ask", "ask: unconfirmed refuses as policy-ask");
      c.check(!unc.ok && unc.error.exitAnalogue === 4, "ask: exit analogue is 4");
      c.check(fake.recorded.messageBodies.length === 0, "ask: unconfirmed made no model call");
      c.check(readdirSync(logDir).length === 0, "ask: unconfirmed logged nothing");

      const ok = await research(
        { question: "q", model: "openai/ask-model", confirmed: true },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(ok.ok, "ask: confirmed:true proceeds");
      c.check(fake.recorded.messageBodies.length === 1, "ask: confirmed made exactly one model call");
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 4. SUCCESS: def present + allowed model → answer byte-exact, attribution names
  //    guild-research, the run verifies under verify (witness parity).
  // -------------------------------------------------------------------------
  {
    const ANSWER = 'Per the source: X.\n"quoted"\tcafé ☕\n';
    const root = tmp("m7r-guild-"); // no policy file ⇒ default-allow
    const logDir = tmp("m7r-logs-");
    const env = envWith({
      GUILD_ROOT: root,
      GUILD_LOG_DIR: logDir,
      GUILD_LOG_PROMPTS: "full",
      GUILD_AGENT_DIR: defDirWithResearch(),
    });
    const fake = await startFakeOpencode({ historyText: ANSWER });
    try {
      const r: ResearchResult = await research(
        { question: "cite the change in X", model: "openai/web-model" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(r.ok, "success: research ok");
      if (r.ok) {
        c.check(r.answer === ANSWER, "success: answer byte-exact through the tool");
        c.check(r.attribution.agent === "guild-research", "success: attribution names guild-research");
        c.check(r.attribution.model === "openai/web-model", "success: exact-id attribution");
        const wire = researchToToolResult(r);
        const round = JSON.parse(JSON.stringify(wire)) as { content: Array<{ text: string }> };
        c.check(round.content[0].text === ANSWER, "success: answer survives the MCP boundary byte-exact");

        const runId = r.attribution.runId;
        c.check(new EvidenceLog({ env }).verify(runId).code === 0, "success: run passes TS verify()");
      }
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 5. EMPTY ANSWER (issue #117, C74): a research turn that completes and produces no text
  //    is an ERROR here too — the same opt-in the other read paths take. A sourced report
  //    with nothing in it cites nothing, so "" is never a research answer.
  // -------------------------------------------------------------------------
  {
    const root = tmp("m7r-guild-"); // default-allow
    const logDir = tmp("m7r-logs-");
    const env = envWith({
      GUILD_ROOT: root,
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDirWithResearch(),
    });
    const fake = await startFakeOpencode({ historyText: "" });
    try {
      const r: ResearchResult = await research(
        { question: "cite X", model: "openai/web-model" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(!r.ok, "empty-answer: research refuses an empty answer");
      if (!r.ok) {
        c.check(r.error.kind === "empty-answer", "empty-answer: kind is empty-answer");
        c.check(r.error.exitAnalogue === null, "empty-answer: exit analogue is null");
        c.check(r.error.message.includes("openai/web-model"), "empty-answer: message names the model");
        c.check(researchToToolResult(r).isError === true, "empty-answer: MCP result flags isError");
      }
      c.check(fake.recorded.deletes.length === 1, "empty-answer: the session was deleted, not leaked");
      const runId = readdirSync(logDir).find((d) => d !== "latest") ?? "";
      c.check(
        new EvidenceLog({ env }).verify(runId).code === 0,
        "empty-answer: the run verifies clean (capture completed; only exit_code says no answer)",
      );
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 5b. EMPTY-ANSWER DIAGNOSTICS (issue #168). The read paths share one spine, so what is
  //     asserted exhaustively in `consult.test.ts` is asserted here as a WIRING check: the
  //     research refusal really does carry the two facts, on the structured surface and in
  //     the message. Without this, a plumbing point could quietly drop them on this path only.
  // -------------------------------------------------------------------------
  {
    const root = tmp("m7r-guild-");
    const logDir = tmp("m7r-logs-");
    const env = envWith({
      GUILD_ROOT: root,
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDirWithResearch(),
    });
    const fake = await startFakeOpencode({
      historyText: "",
      assistantTokens: { input: 777, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    try {
      const r: ResearchResult = await research(
        { question: "cite X", model: "openai/web-model" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(!r.ok && r.error.kind === "empty-answer", "#168 research: still an empty-answer refusal");
      if (!r.ok) {
        c.check(r.error.diagnostics?.toolCallCount === 1, "#168 research: the turn's tool-call count is carried");
        c.check(
          r.error.diagnostics?.completion?.tokens?.input === 777,
          "#168 research: the completion metadata is carried",
        );
        c.check(
          /1 tool call before it ended/.test(r.error.message) && /input=777/.test(r.error.message),
          "#168 research: the message carries both facts",
        );
        const err = (researchToToolResult(r).structuredContent as {
          error: { diagnostics?: { toolCallCount: number } };
        }).error;
        c.check(err.diagnostics?.toolCallCount === 1, "#168 research: diagnostics survive the MCP boundary");
        // ISSUES #188/#191 (C82) — `guild_research` never touches `log.completed`; the write
        // can only have come from the shared lifecycle spine's refusal catch. Asserted here
        // rather than assumed from consult's case, because "inherited" is exactly the kind of
        // claim that stays true right up until someone forks the path.
        c.check(r.runId !== undefined, "#188 research setup: the refusal names its run");
        if (r.runId !== undefined) {
          const entries = readFileSync(path.join(logDir, r.runId, "calls.jsonl"), "utf8")
            .split("\n")
            .filter((l) => l.length > 0)
            .map((l) => JSON.parse(l) as Record<string, unknown>);
          const done = entries.filter((e) => e.type === "call" && e.status === "completed");
          c.check(
            done.length === 1 &&
              done[0].diagnostics !== undefined &&
              r.error.diagnostics !== undefined &&
              canonicalStringify(done[0].diagnostics as never) ===
                canonicalStringify(r.error.diagnostics as never),
            "#188 research: the receipt's diagnostics DEEP-EQUAL the tool result's",
          );
          c.check(
            new EvidenceLog({ env }).verify(r.runId).code === 0,
            "#188 research: the run still verifies clean",
          );
        }
      }
    } finally {
      await fake.close();
    }
  }

  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  console.log(`research.test: ${c.passes} passed, ${c.failures} failed`);
  return c.failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((f) => process.exit(f > 0 ? 1 : 0));
}
