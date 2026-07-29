/**
 * agentfloor.test — the RESOLVED-AGENT check (issue #111, CONTRACT.md C73). OFFLINE.
 *
 * The defect: an agent def whose frontmatter opencode cannot parse has none of it applied, so
 * the agent resolves on opencode's built-in `"*": allow` with NO default-deny floor, silently,
 * while the file on disk still reads as hardened. The product's answer is to ask opencode what
 * it actually resolved (`GET /agent`) and refuse when the floor is absent.
 *
 * The fake serves that endpoint (`hardenedAgent()` / `voidedAgent()` in
 * `test/fake-opencode-server.ts`, whose voided shape is the one PROBED on opencode 1.18.7 —
 * the built-ins alone, `description: null`, `mode: "all"`). Every case here therefore fixtures
 * a RESOLUTION, not a def file: what the source says is exactly what this feature proves is
 * not the question.
 *
 * Every `AgentFloorChecker` is constructed per case. The production one is a process singleton
 * because its per-serve-child cache is the point; sharing it across cases would let one
 * assertion be decided by another's evidence.
 */

import { mkdtempSync, writeFileSync, readdirSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { consult } from "../src/consult.js";
import { panel } from "../src/panel.js";
import { research } from "../src/research.js";
import { delegate } from "../src/delegate.js";
import {
  AgentFloorChecker,
  FLOOR_PROBE,
  effectiveAction,
  parseResolvedPermissions,
  type ResolvedRule,
} from "../src/agentfloor.js";
import {
  startFakeOpencode,
  hardenedAgent,
  voidedAgent,
  defaultResolvedAgents,
  type FakeOpencode,
} from "./fake-opencode-server.js";
import type { ServeProvider } from "../src/client.js";
import { Checker, fixtureGitEnv, fakeServeHandle } from "./harness.js";

const tmpDirs: string[] = [];
function tmp(prefix = "m111-"): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function fakeServe(fake: FakeOpencode): ServeProvider {
  const handle = fakeServeHandle(fake.baseUrl);
  return { withServe: (fn) => fn(handle) };
}

/** A serve provider on an arbitrary base url — used to prove the cache is keyed per CHILD. */
function serveAt(baseUrl: string): ServeProvider {
  const handle = fakeServeHandle(baseUrl);
  return { withServe: (fn) => fn(handle) };
}

/** An agent-def dir holding `<agent>.md`, so the FILESYSTEM presence pre-check passes and the
 * case actually reaches the resolved-agent check. Content is irrelevant — that is the point. */
function defDir(...agents: string[]): string {
  const dir = tmp("m111-agent-");
  for (const a of agents) {
    writeFileSync(path.join(dir, `${a}.md`), "---\nmode: all\n---\nfake\n");
  }
  return dir;
}

/** A clean env: process.env minus every GUILD_* knob, then the given overrides. The XDG
 * redirect is the #24 hermeticity rule — without it a container-global install would satisfy
 * the presence pre-check from outside the fixture. */
function envWith(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith("GUILD_")) delete base[k];
  return { ...base, XDG_CONFIG_HOME: tmp("m111-xdg-"), ...overrides };
}

/** A real git repo with one commit — `guild_delegate` snapshots a worktree, so this has to be
 * one. Routed through `fixtureGitEnv()` (issue #98): a fixture's commit is nobody's signed
 * commit, and a signing box hangs the suite silently otherwise. */
function initRepo(files: Record<string, string>): string {
  const dir = tmp("m111-repo-");
  const env = fixtureGitEnv();
  const git = (args: string[]): { status: number } => {
    const r = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
    return { status: r.status ?? 1 };
  };
  git(["init", "-q", "-b", "main"]);
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  git(["add", "-A"]);
  const committed = git(["commit", "-q", "-m", "init"]);
  if (committed.status !== 0) throw new Error(`initRepo: fixture commit failed in ${dir}`);
  return dir;
}

/** Collect the checker's stderr instead of printing it, so a case can assert it was warned. */
function collectingChecker(): { checker: AgentFloorChecker; lines: string[] } {
  const lines: string[] = [];
  return { checker: new AgentFloorChecker({ warn: (l) => lines.push(l) }), lines };
}

export async function run(): Promise<number> {
  const c = new Checker();
  console.log("== agentfloor.test (issue #111 — the resolved-agent floor) ==");

  // =========================================================================
  // 1. THE EFFECTIVE-ACTION TEST ITSELF. #100's lesson is that a PRESENCE test lies, so
  //    these pin last-match-wins rather than "a deny entry exists somewhere".
  // =========================================================================
  {
    const r = (permission: string, pattern: string, action: string): ResolvedRule => ({
      permission,
      pattern,
      action,
    });

    const hardened = [r("*", "*", "allow"), r("*", "*", "deny"), r("read", "*", "allow")];
    c.check(
      effectiveAction(hardened, FLOOR_PROBE) === "deny",
      "effective: a floor after opencode's built-in catch-all resolves the probe to deny",
    );
    c.check(
      effectiveAction(hardened, "read") === "allow",
      "effective: a named rule AFTER the floor still resolves allow (the allow-set works)",
    );

    // The voided shape: the built-ins alone.
    const voided = [r("*", "*", "allow"), r("read", "*", "allow")];
    c.check(
      effectiveAction(voided, FLOOR_PROBE) === "allow",
      "effective: with no floor the probe resolves to opencode's built-in allow",
    );

    // THE CASE A PRESENCE TEST WOULD PASS: a floor followed by a later `"*": allow`.
    const reopened = [r("*", "*", "deny"), r("read", "*", "allow"), r("*", "*", "allow")];
    c.check(
      effectiveAction(reopened, FLOOR_PROBE) === "allow",
      "effective: a LATER '*': allow re-opens everything — a presence test would have passed this",
    );

    // A pattern-scoped rule cannot decide what happens for an arbitrary invocation.
    const scoped = [r("*", "*", "allow"), r("*", "src/**", "deny")];
    c.check(
      effectiveAction(scoped, FLOOR_PROBE) === "allow",
      "effective: a '*' rule with a NARROW pattern is not a floor and does not answer for the probe",
    );

    c.check(
      effectiveAction([], FLOOR_PROBE) === undefined,
      "effective: nothing matched at all is undefined, never a guessed action",
    );
  }

  // =========================================================================
  // 2. PARSING THE RESOLVED ARRAY — strict in the "I cannot tell" direction. ONE entry we do
  //    not understand fails the whole array, because the entry dropped could be the floor.
  // =========================================================================
  {
    const good = parseResolvedPermissions([
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "read", pattern: "*", action: "allow" },
    ]);
    c.check(good.ok, "parse: a well-formed array parses");

    // A MISSING PATTERN IS UNREADABLE (review, low finding). The first cut coerced it to `"*"`,
    // i.e. treated a patternless rule as a universal one — the only place this parser's
    // strictness ran toward ACCEPTING, and it accepted toward "this is a floor". Nothing on
    // 1.18.7 exercises it; the change is about which way an unknown shape falls.
    const patternless = parseResolvedPermissions([{ permission: "*", action: "deny" }]);
    c.check(
      !patternless.ok,
      "parse: a rule with NO pattern is unreadable, not silently promoted to the universal one",
    );

    c.check(!parseResolvedPermissions(undefined).ok, "parse: an ABSENT permission field is unreadable");
    c.check(!parseResolvedPermissions({ a: 1 }).ok, "parse: a non-array permission field is unreadable");
    const partial = parseResolvedPermissions([
      { permission: "*", pattern: "*", action: "deny" },
      { nonsense: true },
    ]);
    c.check(
      !partial.ok,
      "parse: ONE unreadable entry fails the WHOLE array — a dropped entry could be the floor",
    );
    if (!partial.ok) {
      c.check(partial.reason.includes("#1"), "parse: the reason names which entry it could not read");
    }
  }

  // =========================================================================
  // 3. THE CACHE IS KEYED PER SERVE CHILD, and getting that wrong would be worse than not
  //    caching: opencode resolves agents from the serve's CWD, so two children genuinely
  //    have two answers (issue #96).
  // =========================================================================
  {
    const hardenedFake = await startFakeOpencode({
      historyText: "unused",
      agents: [hardenedAgent("guild-read", ["read"])],
    });
    const voidedFake = await startFakeOpencode({
      historyText: "unused",
      agents: [voidedAgent("guild-read")],
    });
    try {
      const { checker } = collectingChecker();
      // ONE provider per fake, taken once — a real child is one handle for its whole life, and
      // `fakeServe` mints a fresh instance id per call precisely so it cannot pretend otherwise.
      const hardenedServe = fakeServe(hardenedFake);
      const voidedServe = fakeServe(voidedFake);
      const a1 = await checker.verify(hardenedServe, "guild-read");
      const b1 = await checker.verify(voidedServe, "guild-read");
      c.check(a1.state === "verified", "cache: the hardened child verifies");
      c.check(
        b1.state === "unhardened",
        "cache: the OTHER child's voided answer is NOT satisfied by the first child's verdict",
      );
      // And the reverse order, on the same checker, to prove neither direction leaks.
      const b2 = await checker.verify(voidedServe, "guild-read");
      const a2 = await checker.verify(hardenedServe, "guild-read");
      c.check(b2.state === "unhardened" && a2.state === "verified", "cache: no leak in either direction");
      // The two counts differ ON PURPOSE, and the difference is C1: a `verified` verdict is
      // retained (one GET for two verifies), an `unhardened` one is not (two GETs for two),
      // so a def fixed between calls is picked up.
      c.check(
        hardenedFake.recorded.agentGets === 1,
        `cache: the VERIFIED child was asked once across two verifies (got ${hardenedFake.recorded.agentGets})`,
      );
      c.check(
        voidedFake.recorded.agentGets === 2,
        `cache: the UNHARDENED child was RE-asked on the second verify (got ${voidedFake.recorded.agentGets})`,
      );
    } finally {
      await hardenedFake.close();
      await voidedFake.close();
    }
  }

  // A checker never throws: an unreachable child is an `unverified` verdict, not a rejection.
  {
    const { checker, lines } = collectingChecker();
    // Port 1 on loopback: nothing listens, and the connection is refused immediately.
    const v = await checker.verify(serveAt("http://127.0.0.1:1"), "guild-read");
    c.check(v.state === "unverified", "unreachable: an unreachable child is 'unverified', never a throw");
    c.check(lines.length === 1, "unreachable: and it is announced on stderr exactly once");
  }

  // =========================================================================
  // 3a. ONLY `verified` IS RETAINED (review C1). The first cut cached every verdict forever,
  //     which turned a transient failure into permanent silent non-verification and left a
  //     user who FIXED their def refused until the server restarted. Both directions here.
  // =========================================================================
  {
    // A TRANSIENT `GET /agent` failure must be RE-TRIED on the next call — and must keep
    // warning while it persists, because the warning is the whole of "never silently".
    let fail = true;
    const lines: string[] = [];
    const checker = new AgentFloorChecker({
      warn: (l) => lines.push(l),
      list: async () => {
        if (fail) throw new Error("transient control-plane failure");
        return [hardenedAgent("guild-read", ["read"])];
      },
    });
    const serve = serveAt("http://127.0.0.1:9/a");
    const v1 = await checker.verify(serve, "guild-read");
    const v2 = await checker.verify(serve, "guild-read");
    c.check(v1.state === "unverified" && v2.state === "unverified", "C1: an unverified verdict is not sticky by luck — it repeats while the failure does");
    c.check(
      lines.length === 2,
      `C1: and it warns on EVERY such call, not once (got ${lines.length}) — a cached failure warned once and then proceeded unverified in silence`,
    );
    fail = false;
    const v3 = await checker.verify(serve, "guild-read");
    c.check(
      v3.state === "verified",
      "C1: once opencode ANSWERS again the check recovers — the failure was not cached",
    );
    c.check(lines.length === 2, "C1: and a recovered check adds no further warning");
    // ...and the now-`verified` verdict IS retained: a fourth call must not re-ask.
    let listCalls = 0;
    const counting = new AgentFloorChecker({
      warn: () => {},
      list: async () => {
        listCalls += 1;
        return [hardenedAgent("guild-read", ["read"])];
      },
    });
    await counting.verify(serve, "guild-read");
    await counting.verify(serve, "guild-read");
    c.check(listCalls === 1, "C1: a VERIFIED verdict is still cached — the cache did not become a no-op");
  }

  {
    // A FIXED def must be accepted on the very next call. This is the user-facing half of C1:
    // add a duplicate key, get refused, fix the file — and stay refused forever was the bug.
    let voided = true;
    const checker = new AgentFloorChecker({
      warn: () => {},
      list: async () => [voided ? voidedAgent("guild-read") : hardenedAgent("guild-read", ["read"])],
    });
    const serve = serveAt("http://127.0.0.1:9/b");
    const before = await checker.verify(serve, "guild-read");
    c.check(before.state === "unhardened", "C1: a voided def refuses");
    voided = false;
    const after = await checker.verify(serve, "guild-read");
    c.check(
      after.state === "verified",
      "C1: FIXING the def is accepted on the NEXT call — a cached refusal outlived the defect it described",
    );
  }

  // =========================================================================
  // 3b. THE KEY IS A CHILD INSTANCE, NOT A URL (review C2). A loopback port is reusable:
  //     lifecycle.ts negotiates it by bind-and-close without reserving it, and children are
  //     retired by the idle timer and by GUILD_SERVE_PER_CALL=1. So a LATER child at a
  //     DIFFERENT root can arrive on a dead one's port. Two live fakes cannot model that —
  //     this is the sequence that actually bites, and C1 does not close it, because a stale
  //     `verified` is exactly the direction that is retained.
  // =========================================================================
  {
    const first = await startFakeOpencode({
      historyText: "unused",
      agents: [hardenedAgent("guild-read", ["read"])],
    });
    const reusedPort = Number(new URL(first.baseUrl).port);
    const { checker } = collectingChecker();
    const handleA = fakeServeHandle(first.baseUrl);
    const v1 = await checker.verify({ withServe: (fn) => fn(handleA) }, "guild-read");
    c.check(v1.state === "verified", "C2: the first child verifies");
    await first.close();

    // A DIFFERENT child — different root, voided def — binds the very same port.
    const second = await startFakeOpencode({
      historyText: "unused",
      port: reusedPort,
      agents: [voidedAgent("guild-read")],
    });
    try {
      c.check(second.baseUrl === first.baseUrl, "C2: fixture — the second child really did reuse the URL");
      const handleB = fakeServeHandle(second.baseUrl);
      c.check(handleB.instanceId !== handleA.instanceId, "C2: fixture — and it is a different child instance");
      const v2 = await checker.verify({ withServe: (fn) => fn(handleB) }, "guild-read");
      c.check(
        v2.state === "unhardened",
        "C2: the new child is CHECKED — it does not inherit the dead child's verified verdict off a reused port",
      );
    } finally {
      await second.close();
    }
  }

  // The same child asked twice is still one GET — the instance id did not turn the cache off.
  {
    const fake = await startFakeOpencode({
      historyText: "unused",
      agents: [hardenedAgent("guild-read", ["read"])],
    });
    try {
      const { checker } = collectingChecker();
      const handle = fakeServeHandle(fake.baseUrl);
      const serve = { withServe: (fn: (h: typeof handle) => Promise<unknown>) => fn(handle) };
      await checker.verify(serve as never, "guild-read");
      await checker.verify(serve as never, "guild-read");
      c.check(fake.recorded.agentGets === 1, "C2: one CHILD, one GET — the same handle still hits the cache");
    } finally {
      await fake.close();
    }
  }

  // =========================================================================
  // 4. guild_consult — the refusal fires, names the agent, routes NOTHING, logs NOTHING.
  // =========================================================================
  {
    const logDir = tmp("m111-logs-");
    const env = envWith({
      GUILD_ROOT: tmp("m111-guild-"),
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDir("guild-read"),
    });
    const fake = await startFakeOpencode({
      historyText: "MUST NOT BE REACHED",
      agents: [voidedAgent("guild-read")],
    });
    try {
      const { checker, lines } = collectingChecker();
      const r = await consult(
        { question: "q", model: "openai/m" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000, agentFloor: checker },
      );
      c.check(!r.ok, "consult: a voided guild-read REFUSES");
      if (!r.ok) {
        c.check(r.error.kind === "agent-unhardened", "consult: kind is agent-unhardened");
        c.check(
          r.error.exitAnalogue === null,
          "consult: exit analogue is null — no bash counterpart, and NOT a reuse of C57's 5",
        );
        c.check(r.error.message.includes("guild-read"), "consult: the message NAMES the agent");
        c.check(
          r.error.message.includes(FLOOR_PROBE) && r.error.message.includes("'allow'"),
          "consult: the message says what was RESOLVED, not just that something is wrong",
        );
        c.check(
          /duplicate/i.test(r.error.message) && /tab/i.test(r.error.message),
          "consult: the message names the likely cause (unparseable frontmatter)",
        );
      }
      c.check(fake.recorded.messageBodies.length === 0, "consult: NO model call was routed");
      c.check(fake.recorded.createBodies.length === 0, "consult: not even a session was created");
      c.check(readdirSync(logDir).length === 0, "consult: NO evidence run was written (gap parity, C24)");
      c.check(lines.length === 0, "consult: a refusal is the result, not a stderr warning");
    } finally {
      await fake.close();
    }
  }

  // The control: the SAME def dir, the SAME call, a hardened resolution — unchanged behaviour,
  // and no `agentUnverified` field, so a normal result is shape-identical to a pre-#111 one.
  {
    const logDir = tmp("m111-logs-");
    const env = envWith({
      GUILD_ROOT: tmp("m111-guild-"),
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDir("guild-read"),
    });
    const fake = await startFakeOpencode({ historyText: "the answer" });
    try {
      const { checker } = collectingChecker();
      const r = await consult(
        { question: "q", model: "openai/m" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000, agentFloor: checker },
      );
      c.check(r.ok, "control: a hardened resolution proceeds");
      if (r.ok) {
        c.check(r.answer === "the answer", "control: the answer is unchanged");
        c.check(
          r.agentUnverified === undefined,
          "control: no agentUnverified field on a verified call (shape-identical to pre-#111)",
        );
      }
      c.check(fake.recorded.agentGets === 1, "control: the check costs exactly one control-plane GET");
    } finally {
      await fake.close();
    }
  }

  // An agent the def-presence check found on disk but opencode did not resolve AT ALL. It
  // would answer HTTP 500 mid-turn, so it refuses up front.
  {
    const logDir = tmp("m111-logs-");
    const env = envWith({
      GUILD_ROOT: tmp("m111-guild-"),
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDir("guild-read"),
    });
    const fake = await startFakeOpencode({
      historyText: "MUST NOT BE REACHED",
      agents: [hardenedAgent("build", [])],
    });
    try {
      const { checker } = collectingChecker();
      const r = await consult(
        { question: "q", model: "openai/m" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000, agentFloor: checker },
      );
      c.check(!r.ok, "unresolved: an agent opencode does not list at all REFUSES");
      if (!r.ok) {
        c.check(r.error.kind === "agent-unhardened", "unresolved: same kind (the def is not in force)");
        c.check(r.error.message.includes("guild-read"), "unresolved: names the agent asked for");
        c.check(r.error.message.includes("build"), "unresolved: names what opencode DID resolve");
      }
      c.check(readdirSync(logDir).length === 0, "unresolved: NOTHING logged");
    } finally {
      await fake.close();
    }
  }

  // =========================================================================
  // 5. THE CANNOT-ASK DIRECTION: PROCEED, BUT NEVER SILENTLY. Two shapes — opencode
  //    unreachable/erroring, and opencode answering in a shape this cannot read.
  // =========================================================================
  for (const [label, opts] of [
    ["a non-2xx", { failAgentList: true as const }],
    ["a body that is not an array", { agentListGarbage: true as const }],
  ] as const) {
    const logDir = tmp("m111-logs-");
    const env = envWith({
      GUILD_ROOT: tmp("m111-guild-"),
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDir("guild-read"),
    });
    const fake = await startFakeOpencode({ historyText: "the answer", ...opts });
    try {
      const { checker, lines } = collectingChecker();
      const r = await consult(
        { question: "q", model: "openai/m" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000, agentFloor: checker },
      );
      c.check(r.ok, `cannot-ask (${label}): the call PROCEEDS — a control-plane hiccup is not an outage`);
      if (r.ok) {
        c.check(r.answer === "the answer", `cannot-ask (${label}): and the answer is unaffected`);
        c.check(
          r.agentUnverified !== undefined && r.agentUnverified.includes("guild-read"),
          `cannot-ask (${label}): the result SAYS the floor was not verified, naming the agent`,
        );
      }
      c.check(lines.length === 1, `cannot-ask (${label}): announced on stderr too — never silently`);
      c.check(
        lines[0]?.includes("PROCEEDING"),
        `cannot-ask (${label}): the stderr line states the direction taken, not just the failure`,
      );
    } finally {
      await fake.close();
    }
  }

  // The garbage shape also proves the `permission` field itself can be the unreadable part:
  // opencode answers fine, the agent is listed, but its rule array is not one we can resolve.
  {
    const logDir = tmp("m111-logs-");
    const env = envWith({
      GUILD_ROOT: tmp("m111-guild-"),
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDir("guild-read"),
    });
    const fake = await startFakeOpencode({
      historyText: "the answer",
      agents: [{ name: "guild-read", mode: "all", permission: { bash: "deny" } }],
    });
    try {
      const { checker, lines } = collectingChecker();
      const r = await consult(
        { question: "q", model: "openai/m" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000, agentFloor: checker },
      );
      c.check(r.ok, "shape: an unreadable permission SHAPE proceeds, it does not refuse");
      if (r.ok) c.check(r.agentUnverified !== undefined, "shape: and it is surfaced on the result");
      c.check(lines.length === 1, "shape: and on stderr");
    } finally {
      await fake.close();
    }
  }

  // =========================================================================
  // 6. guild_panel — ONE check up front for the whole panel (like the presence check), and
  //    the whole panel refuses. The count is the assertion that matters: three members must
  //    not cost three identical control-plane calls.
  // =========================================================================
  {
    const logDir = tmp("m111-logs-");
    const env = envWith({
      GUILD_ROOT: tmp("m111-guild-"),
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDir("guild-read"),
    });
    const fake = await startFakeOpencode({
      historyText: "MUST NOT BE REACHED",
      agents: [voidedAgent("guild-read")],
    });
    try {
      const { checker } = collectingChecker();
      const r = await panel(
        { question: "q", models: ["alpha/one", "beta/two", "gamma/three"] },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000, agentFloor: checker },
      );
      c.check(!r.ok, "panel: a voided guild-read refuses the WHOLE panel");
      if (!r.ok) {
        c.check(r.error.kind === "agent-unhardened", "panel: kind is agent-unhardened");
        c.check(r.error.exitAnalogue === null, "panel: exit analogue is null");
        c.check(r.error.message.includes("guild-read"), "panel: the message names the agent");
      }
      c.check(fake.recorded.messageBodies.length === 0, "panel: no member reached a model");
      c.check(readdirSync(logDir).length === 0, "panel: NOTHING logged");
      c.check(fake.recorded.agentGets === 1, "panel: ONE check for the whole panel, not one per member");
    } finally {
      await fake.close();
    }
  }

  {
    const logDir = tmp("m111-logs-");
    const env = envWith({
      GUILD_ROOT: tmp("m111-guild-"),
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDir("guild-read"),
    });
    const fake = await startFakeOpencode({ historyText: "voice", distinctSessions: true });
    try {
      const { checker } = collectingChecker();
      const r = await panel(
        { question: "q", models: ["alpha/one", "beta/two", "gamma/three"] },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000, agentFloor: checker },
      );
      c.check(r.ok, "panel control: a hardened resolution runs the panel");
      if (r.ok) {
        c.check(r.results.length === 3, "panel control: all three members ran");
        c.check(r.agentUnverified === undefined, "panel control: no agentUnverified on a verified panel");
      }
      c.check(
        fake.recorded.agentGets === 1,
        "panel control: still ONE control-plane GET for three concurrent members",
      );
    } finally {
      await fake.close();
    }
  }

  // =========================================================================
  // 7. guild_research.
  // =========================================================================
  {
    const logDir = tmp("m111-logs-");
    const env = envWith({
      GUILD_ROOT: tmp("m111-guild-"),
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDir("guild-research"),
    });
    const fake = await startFakeOpencode({
      historyText: "MUST NOT BE REACHED",
      agents: [voidedAgent("guild-research")],
    });
    try {
      const { checker } = collectingChecker();
      const r = await research(
        { question: "q", model: "openai/m" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000, agentFloor: checker },
      );
      c.check(!r.ok, "research: a voided guild-research REFUSES");
      if (!r.ok) {
        c.check(r.error.kind === "agent-unhardened", "research: kind is agent-unhardened");
        c.check(r.error.message.includes("guild-research"), "research: the message names the agent");
      }
      c.check(fake.recorded.messageBodies.length === 0, "research: no model call");
      c.check(readdirSync(logDir).length === 0, "research: NOTHING logged");
    } finally {
      await fake.close();
    }
  }

  // =========================================================================
  // 8. guild_delegate — the highest-stakes copy: without the floor, `guild-build` resolves on
  //    opencode's built-in `"*": allow`, i.e. the UNRESTRICTED tool set. The refusal must land
  //    before any log write AND before the worktree snapshot.
  // =========================================================================
  {
    const repo = initRepo({ "a.txt": "A\n" });
    const logDir = tmp("m111-logs-");
    const env = envWith({
      GUILD_ROOT: tmp("m111-guild-"),
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDir("guild-build"),
    });
    const fake = await startFakeOpencode({
      historyText: "MUST NOT BE REACHED",
      agents: [voidedAgent("guild-build")],
    });
    try {
      const { checker } = collectingChecker();
      // The mutation is hooked to the message POST, so if it ever fires the model "edited" —
      // which is exactly what must not happen on a refusal.
      fake.setOnMessage(() => writeFileSync(path.join(repo, "SHOULD-NOT-EXIST.txt"), "x\n"));
      const r = await delegate(
        { task: "t", model: "openai/m" },
        { serve: fakeServe(fake), env, repoDir: repo, messageTimeoutMs: 5_000, agentFloor: checker },
      );
      c.check(!r.ok, "delegate: a voided guild-build REFUSES");
      if (!r.ok) {
        c.check(r.error.kind === "agent-unhardened", "delegate: kind is agent-unhardened");
        c.check(r.error.exitAnalogue === null, "delegate: exit analogue is null");
        c.check(r.error.message.includes("guild-build"), "delegate: the message names the agent");
        c.check(r.capture === undefined, "delegate: NO capture — the snapshot was never taken");
      }
      c.check(fake.recorded.messageBodies.length === 0, "delegate: the model never ran");
      c.check(
        !existsSync(path.join(repo, "SHOULD-NOT-EXIST.txt")),
        "delegate: nothing was written into the repo",
      );
      c.check(readdirSync(logDir).length === 0, "delegate: NO evidence run (gap parity)");
    } finally {
      await fake.close();
    }
  }

  // The control, on the write path: a hardened resolution still captures the model's patch.
  {
    const repo = initRepo({ "a.txt": "A\n" });
    const logDir = tmp("m111-logs-");
    const env = envWith({
      GUILD_ROOT: tmp("m111-guild-"),
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDir("guild-build"),
    });
    const fake = await startFakeOpencode({ historyText: "made new.txt" });
    try {
      const { checker } = collectingChecker();
      fake.setOnMessage(() => writeFileSync(path.join(repo, "new.txt"), "NEW\n"));
      const r = await delegate(
        { task: "t", model: "openai/m" },
        { serve: fakeServe(fake), env, repoDir: repo, messageTimeoutMs: 5_000, agentFloor: checker },
      );
      c.check(r.ok, "delegate control: a hardened resolution delegates");
      if (r.ok) {
        // THE ORDERING ASSERTION. The check reads `GET /agent` off the same child BEFORE the
        // baseline snapshot; if the snapshot had moved after the turn (or the check after the
        // snapshot) this patch would be empty.
        c.check(r.capture.filesChanged === 1, "delegate control: the model's change is still captured");
        c.check(r.capture.captureComplete === true, "delegate control: capture complete");
        c.check(r.agentUnverified === undefined, "delegate control: no agentUnverified on a verified call");
      }
    } finally {
      await fake.close();
    }
  }

  // =========================================================================
  // 9. ORDERING vs THE APPROVAL BRIDGE — issue #111's first consequence. The bridge computes
  //    its never-widen intersection from the def SOURCE, so on a voided def it would arm
  //    against a map that is not in force. The floor check must decide FIRST.
  // =========================================================================
  {
    const repo = initRepo({ "a.txt": "A\n" });
    const logDir = tmp("m111-logs-");
    const env = envWith({
      GUILD_ROOT: tmp("m111-guild-"),
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDir("guild-build"),
      // An unrecognized tier: `approvalFor` refuses on it (C65). If the approval pre-flight
      // ran first, THAT refusal would be the answer.
      GUILD_APPROVE: "nonsense-tier",
    });
    const fake = await startFakeOpencode({
      historyText: "MUST NOT BE REACHED",
      agents: [voidedAgent("guild-build")],
    });
    try {
      const { checker } = collectingChecker();
      const r = await delegate(
        { task: "t", model: "openai/m" },
        { serve: fakeServe(fake), env, repoDir: repo, messageTimeoutMs: 5_000, agentFloor: checker },
      );
      c.check(!r.ok, "ordering: refused");
      if (!r.ok) {
        c.check(
          r.error.kind === "agent-unhardened",
          "ordering: the FLOOR refusal wins over the approval-knob refusal — the bridge must never arm against a def that is not in force",
        );
      }
    } finally {
      await fake.close();
    }
  }

  // =========================================================================
  // 10. THE FIXTURE ITSELF: the default `GET /agent` payload really is hardened, so every
  //     other suite's silence about this feature means "verified", not "never asked".
  // =========================================================================
  {
    for (const a of defaultResolvedAgents()) {
      if (a.name === "build") continue; // opencode's own unrestricted agent, deliberately not
      const parsed = parseResolvedPermissions(a.permission);
      const ok = parsed.ok && effectiveAction(parsed.rules, FLOOR_PROBE) === "deny";
      c.check(ok, `fixture: the default resolution of '${a.name}' carries the floor`);
    }
    const parsedBuild = parseResolvedPermissions(voidedAgent("guild-build").permission);
    c.check(
      parsedBuild.ok && effectiveAction(parsedBuild.rules, FLOOR_PROBE) === "allow",
      "fixture: the voided resolution does NOT — otherwise every refusal case here is vacuous",
    );
  }

  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  console.log(`agentfloor.test: ${c.passes} passed, ${c.failures} failed`);
  return c.failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((f) => process.exit(f > 0 ? 1 : 0));
}
