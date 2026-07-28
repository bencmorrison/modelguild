/**
 * Approval-bridge tests (issue #20, slice 4) — OFFLINE.
 *
 * No model is called and no `opencode` binary is spawned. The gating behaviour is served by
 * the in-process `node:http` fake, which reproduces the three facts probe P2/P3 established
 * about `opencode serve` and which were RE-VERIFIED against opencode 1.18.7 while building
 * this slice (a live `/doc` read plus a real `POST /session`):
 *
 *   1. `POST /session` accepts `permission: PermissionRule[]` (`{permission, pattern,
 *      action}`, action ∈ allow|deny|ask) and ECHOES the stored ruleset back — which is the
 *      only evidence a caller has that the ruleset actually took;
 *   2. an `ask`-tier tool emits `permission.asked` and then WAITS for an HTTP reply. It does
 *      NOT auto-reject on a non-TTY. The fake BLOCKS the turn on the reply for the same
 *      reason: otherwise a test could only prove a reply was sent, never that the tool
 *      waited for it;
 *   3. a reply to an unknown or already-settled permission id is a 404 — which is what makes
 *      "first reply wins, opencode is the arbiter" an observable property rather than a hope.
 *
 * The two invariants this suite exists to hold, because getting either wrong turns a safety
 * feature into an escalation:
 *   - NEVER EMIT `allow` (probe P2 proved one such line hands a working shell to the
 *     read-only agent) — asserted at construction AND at the wire boundary, under every tier;
 *   - NEVER GATE A TOOL THE AGENT DOES NOT ALREADY ALLOW (an `ask` on a DENIED tool converts
 *     it into an approvable one) — asserted for every tier × every hardened agent.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  APPROVALS_FILE,
  ApprovalRulesetError,
  armApproval,
  buildApprovalRuleset,
  DEFAULT_APPROVE_TIMEOUT_MS,
  ApprovalBridge,
  gatedToolsFor,
  liveApprovalWatchers,
  approvalDoctorInfo,
  checkStoredRuleset,
  effectiveGatedFamily,
  elicitationMessage,
  makeElicitationRequester,
  parseAgentPermissions,
  resolveAgentAllowSet,
  resolveApprovalSettings,
  sanitizeForDisplay,
  summarizePermission,
  startWatcherHeartbeat,
  watcherDirFor,
  WATCHER_STALE_MS,
  type ApprovalSettings,
  type ApprovalTier,
  type ElicitationRequester,
} from "../src/approve.js";
import {
  assertAskOnlyRuleset,
  createSession,
  listPendingPermissions,
  type ServeProvider,
} from "../src/client.js";
import { closeAllBuses } from "../src/activity.js";
import { consult } from "../src/consult.js";
import { delegate } from "../src/delegate.js";
import { research } from "../src/research.js";
import { EvidenceLog } from "../src/log.js";
import {
  runWatch,
  formatApprovalPrompt,
  formatApprovalNotice,
} from "../src/cli.js";
import { startFakeOpencode, type FakeOpencode } from "./fake-opencode-server.js";
import type { ServeHandle } from "../src/lifecycle.js";
import { Checker, waitFor } from "./harness.js";

function fakeServe(fake: FakeOpencode): ServeProvider {
  const handle: ServeHandle = { baseUrl: fake.baseUrl, port: 0, pid: 0 };
  return { withServe: (fn) => fn(handle) };
}

const tmpDirs: string[] = [];
function tmp(prefix = "apr-"): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function envWith(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith("GUILD_")) delete base[k];
  return { ...base, ...overrides };
}

/**
 * An agent-def dir holding the REAL shipped defs.
 *
 * This fixture copies `.opencode/agent/<name>.md` verbatim rather than inventing a stub,
 * because since review finding H3 the bridge READS the def to decide what it may gate. A
 * stub would let the fixture and the product disagree about the very thing under test — the
 * class of bug that let the `pending`/`file.edited` defects ship green in slice 1.
 */
function defDirWith(...agents: string[]): string {
  const dir = tmp("apr-agent-");
  for (const a of agents) {
    const src = new URL(`../.opencode/agent/${a}.md`, import.meta.url);
    writeFileSync(path.join(dir, `${a}.md`), readFileSync(src, "utf8"));
  }
  return dir;
}

/** A def dir whose `<agent>.md` carries a HAND-EDITED permission map — the "the user
 * hardened it further" case invariant 2 must respect. */
function defDirWithPermissions(agent: string, permissionBlock: string): string {
  const dir = tmp("apr-agent-custom-");
  writeFileSync(
    path.join(dir, `${agent}.md`),
    `---\ndescription: custom\nmode: all\npermission:\n${permissionBlock}---\nbody\n`,
  );
  return dir;
}

/** The shipped defs' own allow-sets, read the way the product reads them. */
function shippedAllowSet(agent: string): Set<string> {
  const r = resolveAgentAllowSet(agent, [
    path.dirname(new URL(`../.opencode/agent/${agent}.md`, import.meta.url).pathname),
  ]);
  if (!r.ok) throw new Error(`fixture: ${r.reason}`);
  return r.set.allow;
}

/** Plant a LIVE approval-watcher presence file, the way `modelguild watch --approve` would.
 * `ageMs` back-dates it so the staleness rule can be exercised without sleeping. */
function plantWatcher(logDir: string, opts: { mode?: string; ageMs?: number } = {}): string {
  const dir = watcherDirFor(logDir);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${process.pid}-test.watcher`);
  writeFileSync(
    file,
    `${JSON.stringify({ pid: process.pid, mode: opts.mode ?? "approve", started: new Date().toISOString() })}\n`,
  );
  if (opts.ageMs !== undefined) {
    const when = (Date.now() - opts.ageMs) / 1000;
    utimesSync(file, when, when);
  }
  return file;
}

/** `resolveApprovalSettings(...).settings`, or undefined on a refusal — a narrowing helper so
 * the knob assertions below read as assertions rather than as type gymnastics. */
function settingsOf(r: ReturnType<typeof resolveApprovalSettings>): ApprovalSettings | undefined {
  return r.ok ? r.settings : undefined;
}

/** A stub elicitation channel that always answers the same way. */
function stubElicitation(
  action: "accept" | "decline" | "cancel",
  seen?: string[],
): ElicitationRequester {
  return {
    available: true,
    async ask({ message }) {
      seen?.push(message);
      return action;
    },
  };
}

function readApprovals(dir: string): Array<Record<string, unknown>> {
  const file = path.join(dir, APPROVALS_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const SETTINGS = (tier: ApprovalTier, egress: "off" | "ask" = "off"): ApprovalSettings => ({
  tier,
  egress,
  timeoutMs: 1000,
});

export async function run(): Promise<number> {
  const c = new Checker();
  console.log("== approve.test (issue #20 slice 4 — the approval bridge) ==");

  // -------------------------------------------------------------------------
  // 1. Knob resolution: env > conf > default; default OFF; a typo REFUSES.
  // -------------------------------------------------------------------------
  {
    const d = resolveApprovalSettings({ env: envWith({}), confContents: "" });
    c.check(d.ok && d.settings.tier === "off", "knobs: GUILD_APPROVE defaults OFF");
    c.check(d.ok && d.settings.egress === "off", "knobs: GUILD_APPROVE_EGRESS defaults OFF (Q8 is opt-in)");
    c.check(
      d.ok && d.settings.timeoutMs === DEFAULT_APPROVE_TIMEOUT_MS,
      "knobs: the approval timeout has a sane default",
    );

    for (const tier of ["write", "all"]) {
      const r = resolveApprovalSettings({ env: envWith({ GUILD_APPROVE: tier }) });
      c.check(r.ok && r.settings.tier === tier, `knobs: GUILD_APPROVE=${tier} resolves`);
    }
    c.check(
      resolveApprovalSettings({ env: envWith({ GUILD_APPROVE: "ALL" }) }).ok,
      "knobs: the tier test is case-insensitive",
    );
    c.check(
      settingsOf(resolveApprovalSettings({ env: envWith({}), confContents: "GUILD_APPROVE=all\n" }))
        ?.tier === "all",
      "knobs: conf can arm the bridge",
    );
    const overridden = resolveApprovalSettings({
      env: envWith({ GUILD_APPROVE: "off" }),
      confContents: "GUILD_APPROVE=all\n",
    });
    c.check(
      overridden.ok && overridden.settings.tier === "off",
      "knobs: env OVERRIDES conf (C35 order)",
    );

    // A TYPO IS AN ERROR, not a silent `off` — the opposite of GUILD_ACTIVITY, because here
    // failing quiet would leave the developer believing edits are gated when they are not.
    const typo = resolveApprovalSettings({ env: envWith({ GUILD_APPROVE: "writ" }) });
    c.check(!typo.ok, "knobs: an unrecognized GUILD_APPROVE is an ERROR, never a silent 'off'");
    c.check(
      !typo.ok && typo.error.includes("writ") && typo.error.includes("off | write | all"),
      "knobs: the error names the bad value and the accepted set",
    );
    const egressTypo = resolveApprovalSettings({ env: envWith({ GUILD_APPROVE_EGRESS: "yes" }) });
    c.check(!egressTypo.ok, "knobs: an unrecognized GUILD_APPROVE_EGRESS is likewise an error");
    c.check(
      settingsOf(resolveApprovalSettings({ env: envWith({ GUILD_APPROVE_EGRESS: "ask" }) }))?.egress ===
        "ask",
      "knobs: Q8's GUILD_APPROVE_EGRESS=ask resolves",
    );

    // The timeout is LENIENT (a bad value can only change how long you have to answer; the
    // outcome is fail-closed either way).
    c.check(
      settingsOf(resolveApprovalSettings({ env: envWith({ GUILD_APPROVE_TIMEOUT_MS: "5000" }) }))
        ?.timeoutMs === 5000,
      "knobs: GUILD_APPROVE_TIMEOUT_MS is honoured",
    );
    c.check(
      settingsOf(resolveApprovalSettings({ env: envWith({ GUILD_APPROVE_TIMEOUT_MS: "nonsense" }) }))
        ?.timeoutMs === DEFAULT_APPROVE_TIMEOUT_MS,
      "knobs: an unusable timeout falls back to the default (still fail-closed)",
    );
    c.check(
      settingsOf(resolveApprovalSettings({ env: envWith({ GUILD_APPROVE_TIMEOUT_MS: "0" }) }))
        ?.timeoutMs === DEFAULT_APPROVE_TIMEOUT_MS,
      "knobs: 0 is not 'no timeout' — it falls back, because there is no ungated wait",
    );
  }

  // -------------------------------------------------------------------------
  // 2. The ruleset builder: per-tier tool sets, never-widen, never-allow.
  // -------------------------------------------------------------------------
  {
    const buildSet = shippedAllowSet("guild-build");
    const readSet = shippedAllowSet("guild-read");
    const researchSet = shippedAllowSet("guild-research");

    c.check(
      JSON.stringify(gatedToolsFor(buildSet, SETTINGS("write"))) ===
        JSON.stringify(["edit", "write", "patch"]),
      `tiers: write gates the file-mutation tools (got ${JSON.stringify(gatedToolsFor(buildSet, SETTINGS("write")))})`,
    );
    c.check(
      JSON.stringify(gatedToolsFor(buildSet, SETTINGS("all"))) ===
        JSON.stringify(["edit", "write", "patch", "bash"]),
      "tiers: all additionally gates bash — the tier the honest bound is about",
    );
    c.check(
      gatedToolsFor(buildSet, SETTINGS("off")).length === 0,
      "tiers: off gates nothing",
    );

    // NEVER WIDEN: the read agents hold none of the write tools, so GUILD_APPROVE alone
    // must gate NOTHING there. An `ask` on a DENIED tool would make it approvable.
    for (const [agent, set] of [["guild-read", readSet], ["guild-research", researchSet]] as const) {
      for (const tier of ["write", "all"] as ApprovalTier[]) {
        c.check(
          gatedToolsFor(set, SETTINGS(tier)).length === 0,
          `never-widen: GUILD_APPROVE=${tier} gates nothing on ${agent} (its def DENIES those tools)`,
        );
      }
    }
    // Q8's knob gates exactly the web tools, and only where they are allowed.
    for (const [agent, set] of [["guild-read", readSet], ["guild-research", researchSet]] as const) {
      c.check(
        JSON.stringify(gatedToolsFor(set, SETTINGS("off", "ask"))) ===
          JSON.stringify(["webfetch", "websearch"]),
        `egress: GUILD_APPROVE_EGRESS=ask gates webfetch/websearch on ${agent}`,
      );
    }
    c.check(
      gatedToolsFor(buildSet, SETTINGS("off", "ask")).length === 0,
      "egress: the write agent has no web tools, so the egress knob gates nothing there",
    );
    c.check(
      gatedToolsFor(new Set<string>(), SETTINGS("all", "ask")).length === 0,
      "never-widen: an EMPTY allow-set gates nothing — fail-safe by construction",
    );

    // NEVER EMIT allow, under every tier × every agent.
    for (const [agent, allowSet] of [
      ["guild-build", buildSet],
      ["guild-read", readSet],
      ["guild-research", researchSet],
    ] as const) {
      for (const tier of ["off", "write", "all"] as ApprovalTier[]) {
        for (const egress of ["off", "ask"] as const) {
          const rules = buildApprovalRuleset({ agent, settings: SETTINGS(tier, egress), allowSet });
          if (rules.some((r) => (r.action as string) !== "ask")) {
            c.check(false, `never-allow: ${agent}/${tier}/${egress} emitted a non-ask rule`);
          }
          if (rules.some((r) => r.pattern !== "*")) {
            c.check(false, `never-allow: ${agent}/${tier}/${egress} emitted an odd pattern`);
          }
        }
      }
    }
    c.check(true, "never-allow: every tier × agent × egress combination emits ONLY 'ask' rules");

    // The assertion bites when a caller constructs something illegal by hand.
    let threw = false;
    try {
      assertAskOnlyRuleset([{ permission: "bash", action: "allow" }]);
    } catch (err) {
      threw = err instanceof Error && err.name === "SessionPermissionError";
    }
    c.check(threw, "never-allow: the WIRE-boundary assertion rejects an 'allow' rule");

    let threw2 = false;
    try {
      buildApprovalRuleset({ agent: "guild-read", settings: SETTINGS("all"), allowSet: readSet });
      // (empty ruleset — no throw expected here; the widening guard is proven below)
    } catch {
      threw2 = true;
    }
    c.check(!threw2, "never-widen: an empty intersection is a no-op, not an error");

    // `edit` is what actually gates file mutation on 1.18.7 (the `write` key is INERT —
    // probed during review), so a tier that lost it would look armed and gate nothing.
    for (const tier of ["write", "all"] as ApprovalTier[]) {
      c.check(
        gatedToolsFor(buildSet, SETTINGS(tier)).includes("edit"),
        `tiers: '${tier}' contains 'edit' — the key that actually gates the write/patch family`,
      );
    }
    c.check(
      effectiveGatedFamily(["edit"]).includes("write") &&
        effectiveGatedFamily(["edit"]).includes("patch"),
      "tiers: the reported effective family says one `edit` approval covers write/patch",
    );

    const required = [{ permission: "bash", pattern: "*", action: "ask" as const }];
    c.check(
      checkStoredRuleset(
        [
          { permission: "bash", pattern: "*", action: "ask" },
          { permission: "edit", pattern: "*", action: "ask" },
        ],
        required,
        buildSet,
      ).ok,
      "verify: a stored ruleset carrying the required rule satisfies it",
    );
    c.check(
      !checkStoredRuleset([{ permission: "edit", pattern: "*", action: "ask" }], required, buildSet)
        .ok,
      "verify: a stored ruleset MISSING a required rule does not satisfy it",
    );
    c.check(
      !checkStoredRuleset(undefined, required, buildSet).ok,
      "verify: no stored ruleset at all does not satisfy a requirement",
    );
    // REVIEW FINDING M7 (probed): a subset check alone passed a session that ALSO carried a
    // widening rule, so the turn ran on a widened session while reporting itself armed.
    const widened = checkStoredRuleset(
      [
        { permission: "bash", pattern: "*", action: "ask" },
        { permission: "webfetch", pattern: "*", action: "allow" },
      ],
      required,
      buildSet,
    );
    c.check(
      !widened.ok,
      "verify: a stored ruleset that WIDENS the agent (allow on a denied tool) is REFUSED",
    );
    c.check(
      !widened.ok && widened.reason.includes("WIDENED"),
      "verify: and the reason says the session was widened, not merely 'missing a rule'",
    );
    c.check(
      checkStoredRuleset(
        [
          { permission: "bash", pattern: "*", action: "ask" },
          { permission: "edit", pattern: "*", action: "allow" },
        ],
        required,
        buildSet,
      ).ok,
      "verify: a non-ask rule for a tool the def ALREADY allows is not a widening",
    );
    c.check(
      ApprovalRulesetError.name === "ApprovalRulesetError",
      "never-allow: the construction-time error type is distinct",
    );
  }

  // -------------------------------------------------------------------------
  // 3. The wire boundary: `createSession` refuses anything but `ask`.
  // -------------------------------------------------------------------------
  {
    const fake = await startFakeOpencode({ historyText: "unused" });
    try {
      let threw = "";
      try {
        await createSession({
          baseUrl: fake.baseUrl,
          agent: "guild-read",
          // A caller casting around the type — exactly the route the second check exists for.
          permission: [{ permission: "bash", pattern: "*", action: "allow" }] as never,
          allowedTools: ["edit"],
        });
      } catch (err) {
        threw = (err as Error).name;
      }
      c.check(threw === "SessionPermissionError", "wire: createSession refuses a non-ask ruleset");
      c.check(
        fake.recorded.createBodies.length === 0,
        "wire: nothing was SENT — the refusal happens before the request is built",
      );

      // REVIEW FINDING M4: the wire used to check invariant 1 only, and accepted an `ask`
      // for a tool the agent def DENIES — a widening. It must refuse that too.
      let widenThrew = "";
      try {
        await createSession({
          baseUrl: fake.baseUrl,
          agent: "guild-read",
          permission: [{ permission: "bash", pattern: "*", action: "ask" }],
          allowedTools: ["read", "grep", "glob", "webfetch", "websearch"],
        });
      } catch (err) {
        widenThrew = (err as Error).name;
      }
      c.check(
        widenThrew === "SessionPermissionError",
        "wire: an 'ask' for a tool OUTSIDE the agent's allow-set is refused (invariant 2 at the wire)",
      );
      let noSetThrew = "";
      try {
        await createSession({
          baseUrl: fake.baseUrl,
          agent: "guild-build",
          permission: [{ permission: "bash", pattern: "*", action: "ask" }],
        });
      } catch (err) {
        noSetThrew = (err as Error).name;
      }
      c.check(
        noSetThrew === "SessionPermissionError",
        "wire: a ruleset with NO allow-set to check against is refused — it cannot be verified",
      );
      c.check(
        fake.recorded.createBodies.length === 0,
        "wire: none of the refused rulesets reached the server",
      );

      const ok = await createSession({
        baseUrl: fake.baseUrl,
        agent: "guild-build",
        permission: [{ permission: "bash", pattern: "*", action: "ask" }],
        allowedTools: ["edit", "write", "patch", "bash"],
      });
      c.check(
        JSON.stringify(fake.recorded.createBodies[0].permission) ===
          JSON.stringify([{ permission: "bash", pattern: "*", action: "ask" }]),
        "wire: an ask ruleset is sent verbatim as `permission`",
      );
      c.check(
        checkStoredRuleset(
          ok.permission,
          [{ permission: "bash", pattern: "*", action: "ask" }],
          new Set(["edit", "write", "patch", "bash"]),
        ).ok,
        "wire: the echoed ruleset is surfaced so a caller can prove it took",
      );
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 4. Watcher presence: mode, staleness, heartbeat lifecycle.
  // -------------------------------------------------------------------------
  {
    const logDir = tmp("apr-watchers-");
    c.check(liveApprovalWatchers(logDir).length === 0, "presence: no watcher dir ⇒ no watchers");

    plantWatcher(logDir);
    c.check(liveApprovalWatchers(logDir).length === 1, "presence: a fresh approve watcher counts");

    rmSync(watcherDirFor(logDir), { recursive: true, force: true });
    plantWatcher(logDir, { mode: "watch" });
    c.check(
      liveApprovalWatchers(logDir).length === 0,
      "presence: a PLAIN watcher does not count — it cannot prompt, so arming would deadlock",
    );

    rmSync(watcherDirFor(logDir), { recursive: true, force: true });
    plantWatcher(logDir, { ageMs: WATCHER_STALE_MS + 5_000 });
    c.check(
      liveApprovalWatchers(logDir).length === 0,
      "presence: a STALE heartbeat is ignored (a SIGKILLed watcher disappears on its own)",
    );

    rmSync(watcherDirFor(logDir), { recursive: true, force: true });
    const sigintBefore = process.listenerCount("SIGINT");
    const hb = startWatcherHeartbeat(logDir, { intervalMs: 10_000 });
    c.check(existsSync(hb.file), "presence: startWatcherHeartbeat announces immediately");
    c.check(liveApprovalWatchers(logDir).length === 1, "presence: and the server sees it");
    // L8: `process.once("exit")` does NOT fire on signal death, and the CLI's `finally` does
    // not run either — a Ctrl-C'd watcher used to leave its presence file behind, and the
    // server would arm believing a terminal was listening. Explicit signal handlers fix it;
    // they cannot be exercised in-process without killing the suite, so pin that they exist.
    c.check(
      process.listenerCount("SIGINT") > sigintBefore,
      "L8: a SIGINT handler is installed so Ctrl-C retracts the presence file",
    );
    c.check(
      process.listenerCount("SIGTERM") > 0 && process.listenerCount("SIGHUP") > 0,
      "L8: SIGTERM and SIGHUP are covered too",
    );
    hb.stop();
    c.check(!existsSync(hb.file), "presence: stop() retracts the file at once");
    hb.stop();
    c.check(true, "presence: a double stop is a no-op");
  }

  // -------------------------------------------------------------------------
  // 5. armApproval: not-armed, bad knob, and armed-with-no-channel.
  // -------------------------------------------------------------------------
  {
    const logDir = tmp("apr-arm-");
    const log = new EvidenceLog({ env: envWith({ GUILD_LOG_DIR: logDir }) });
    const defs = defDirWith("guild-build", "guild-read");

    const off = armApproval({
      agent: "guild-build",
      env: envWith({}),
      confContents: "",
      agentDefDirs: [defs],
      log,
    });
    c.check(off.ok && off.arming === undefined, "arm: default OFF ⇒ nothing armed, nothing refused");

    const readPath = armApproval({
      agent: "guild-read",
      env: envWith({ GUILD_APPROVE: "all" }),
      confContents: "",
      agentDefDirs: [defs],
      log,
    });
    c.check(
      readPath.ok && readPath.arming === undefined,
      "arm: GUILD_APPROVE=all on a READ path arms nothing (nothing to gate there)",
    );

    const bad = armApproval({
      agent: "guild-build",
      env: envWith({ GUILD_APPROVE: "sometimes" }),
      confContents: "",
      agentDefDirs: [defs],
      log,
    });
    c.check(!bad.ok && bad.refusal.kind === "approval-config", "arm: a bad knob REFUSES");

    const noChannel = armApproval({
      agent: "guild-build",
      env: envWith({ GUILD_APPROVE: "write", GUILD_LOG_DIR: logDir }),
      confContents: "",
      agentDefDirs: [defs],
      log: new EvidenceLog({ env: envWith({ GUILD_LOG_DIR: logDir }) }),
    });
    c.check(
      !noChannel.ok && noChannel.refusal.kind === "approval-channel-missing",
      "arm: armed with NO answering channel REFUSES up front",
    );
    c.check(
      !noChannel.ok &&
        noChannel.refusal.message.includes("modelguild watch --approve") &&
        noChannel.refusal.message.includes("HANGS"),
      "arm: the refusal names the fix AND why refusing beats arming (an unanswered ask hangs)",
    );

    plantWatcher(logDir);
    const armedByWatch = armApproval({
      agent: "guild-build",
      env: envWith({ GUILD_APPROVE: "write", GUILD_LOG_DIR: logDir }),
      confContents: "",
      agentDefDirs: [defs],
      log: new EvidenceLog({ env: envWith({ GUILD_LOG_DIR: logDir }) }),
    });
    c.check(
      armedByWatch.ok && armedByWatch.arming !== undefined,
      "arm: a live watch terminal is a sufficient channel",
    );
    c.check(
      armedByWatch.ok && armedByWatch.arming?.channels.includes("watch") === true,
      "arm: the channel is named on the arming",
    );

    const armedByElicit = armApproval({
      agent: "guild-build",
      env: envWith({ GUILD_APPROVE: "all" }),
      confContents: "",
      agentDefDirs: [defs],
      log: new EvidenceLog({ env: envWith({ GUILD_LOG_DIR: tmp("apr-arm2-") }) }),
      elicitation: stubElicitation("accept"),
    });
    c.check(
      armedByElicit.ok && armedByElicit.arming?.channels.includes("elicitation") === true,
      "arm: an elicitation-capable client is also a sufficient channel",
    );

    // GUILD_LOG=off removes the watch channel by construction (no run dir to publish into).
    const logOffDir = tmp("apr-logoff-");
    plantWatcher(logOffDir);
    const logOff = armApproval({
      agent: "guild-build",
      env: envWith({ GUILD_APPROVE: "write", GUILD_LOG: "off", GUILD_LOG_DIR: logOffDir }),
      confContents: "",
      agentDefDirs: [defs],
      log: new EvidenceLog({ env: envWith({ GUILD_LOG: "off", GUILD_LOG_DIR: logOffDir }) }),
    });
    c.check(
      !logOff.ok && logOff.refusal.message.includes("GUILD_LOG=off"),
      "arm: GUILD_LOG=off kills the watch channel, and the refusal says exactly that",
    );
  }

  // -------------------------------------------------------------------------
  // 6. Refusal happens BEFORE any log write — assert the log is untouched.
  // -------------------------------------------------------------------------
  {
    const root = tmp("apr-gap-");
    const logDir = tmp("apr-gaplogs-");
    const repo = tmp("apr-gaprepo-");
    const env = envWith({
      GUILD_ROOT: root,
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDirWith("guild-build"),
      GUILD_APPROVE: "all",
    });
    const fake = await startFakeOpencode({ historyText: "must not run", sessionId: "ses_gap" });
    try {
      const r = await delegate(
        { task: "edit things", model: "openai/allowed" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000, repoDir: repo },
      );
      c.check(!r.ok, "gap: an armed delegate with no channel is refused");
      c.check(
        !r.ok && r.error.kind === "approval-channel-missing",
        `gap: the refusal is structured (got ${!r.ok ? r.error.kind : "ok"})`,
      );
      c.check(!r.ok && r.error.exitAnalogue === null, "gap: no invented exit code");
      c.check(
        readdirSync(logDir).length === 0,
        `gap: NOTHING was logged — refused before expect (found ${JSON.stringify(readdirSync(logDir))})`,
      );
      c.check(
        fake.recorded.createBodies.length === 0 && fake.recorded.messageBodies.length === 0,
        "gap: and no session was created and no model turn sent",
      );
    } finally {
      closeAllBuses();
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 7. END TO END, APPROVE: the fake BLOCKS the turn on the reply; elicitation accepts.
  // -------------------------------------------------------------------------
  {
    const root = tmp("apr-ok-");
    const logDir = tmp("apr-oklogs-");
    const repo = tmp("apr-okrepo-");
    const env = envWith({
      GUILD_ROOT: root,
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDirWith("guild-build"),
      GUILD_APPROVE: "all",
    });
    const prompts: string[] = [];
    const fake = await startFakeOpencode({
      historyText: "I ran the tests",
      sessionId: "ses_ok",
      gateTool: "bash",
      gateMetadata: { command: "npm test" },
    });
    try {
      const r = await delegate(
        { task: "run the tests", model: "openai/allowed" },
        {
          serve: fakeServe(fake),
          env,
          messageTimeoutMs: 10_000,
          repoDir: repo,
          elicitation: stubElicitation("accept", prompts),
        },
      );
      c.check(r.ok, `approve: the gated call SUCCEEDED (${!r.ok ? r.error.message : ""})`);
      c.check(
        JSON.stringify(fake.recorded.createBodies[0].permission) ===
          JSON.stringify([
            { permission: "edit", pattern: "*", action: "ask" },
            { permission: "write", pattern: "*", action: "ask" },
            { permission: "patch", pattern: "*", action: "ask" },
            { permission: "bash", pattern: "*", action: "ask" },
          ]),
        `approve: the session was created with the ask ruleset (got ${JSON.stringify(fake.recorded.createBodies[0].permission)})`,
      );
      c.check(
        fake.gateOutcomes().length === 1 && fake.gateOutcomes()[0] === "once",
        `approve: the gated tool BLOCKED and observed the approval (got ${JSON.stringify(fake.gateOutcomes())})`,
      );
      const replies = fake.permissionReplies();
      c.check(
        replies.length === 1 && replies[0].via === "session" && replies[0].response === "once",
        `approve: an approval goes to the SESSION-scoped endpoint (got ${JSON.stringify(replies)})`,
      );
      c.check(
        prompts.length === 1 && prompts[0].includes("npm test"),
        `approve: the human was shown the actual command (got ${JSON.stringify(prompts)})`,
      );
      c.check(
        prompts[0].includes("approved shell") || prompts[0].toLowerCase().includes("not containment"),
        "approve: the prompt carries the honest bound, not a containment claim",
      );
      if (r.ok) {
        c.check(r.approval !== undefined, "approve: the result carries an approval record");
        c.check(r.approval?.armed === true && r.approval?.tier === "all", "approve: it names the tier");
        c.check(
          r.approval?.approved === 1 && r.approval?.rejected === 0 && r.approval?.timedOut === 0,
          `approve: the counters are right (${JSON.stringify(r.approval)})`,
        );
        c.check(
          (r.approval?.note ?? "").toLowerCase().includes("not containment"),
          "approve: the honest bound rides on the wire, where a reader cannot miss it",
        );
        const lines = readApprovals(path.join(logDir, r.attribution.runId));
        c.check(
          lines.some((l) => l.kind === "asked" && l.tool === "bash") &&
            lines.some((l) => l.kind === "decided" && l.decision === "once"),
          `approve: approvals.jsonl records ask AND decision (${JSON.stringify(lines.map((l) => l.kind))})`,
        );
        c.check(
          lines.every((l) => l.run_id === r.attribution.runId && l.call_id === r.attribution.callId),
          "approve: every approval line is attributable to the call",
        );
        // The evidence log is untouched by all of this.
        const verdict = new EvidenceLog({ env }).verify(r.attribution.runId);
        c.check(
          verdict.code === 0,
          `approve: the evidence run still VERIFIES with approvals.jsonl beside it (${verdict.code})`,
        );
      }
    } finally {
      closeAllBuses();
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 8. CANCEL ⇒ REJECT. A headless Claude Code auto-answers `cancel`; reading that as
  //    consent would be the single worst bug this feature could ship.
  // -------------------------------------------------------------------------
  {
    const root = tmp("apr-cancel-");
    const logDir = tmp("apr-cancellogs-");
    const repo = tmp("apr-cancelrepo-");
    const env = envWith({
      GUILD_ROOT: root,
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDirWith("guild-build"),
      GUILD_APPROVE: "all",
    });
    const fake = await startFakeOpencode({
      historyText: "I could not run it",
      sessionId: "ses_cancel",
      gateTool: "bash",
      gateMetadata: { command: "rm -rf /" },
    });
    try {
      const r = await delegate(
        { task: "do something", model: "openai/allowed" },
        {
          serve: fakeServe(fake),
          env,
          messageTimeoutMs: 10_000,
          repoDir: repo,
          elicitation: stubElicitation("cancel"),
        },
      );
      c.check(r.ok, "cancel: the TURN still completes — a rejection is a denied tool, not an abort");
      c.check(
        fake.gateOutcomes()[0] === "reject",
        `cancel: the gated tool observed a REJECT (got ${JSON.stringify(fake.gateOutcomes())})`,
      );
      const replies = fake.permissionReplies();
      c.check(
        replies[0].via === "global" && replies[0].response === "reject",
        "cancel: a rejection goes to the endpoint that carries a MESSAGE",
      );
      c.check(
        (replies[0].message ?? "").toLowerCase().includes("cancel"),
        `cancel: the model is TOLD why, verbatim (got '${replies[0].message}')`,
      );
      if (r.ok) {
        c.check(
          r.approval?.rejected === 1 && r.approval?.approved === 0,
          "cancel: the counters record a rejection",
        );
      }
    } finally {
      closeAllBuses();
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // The elicitation channel: an EMPTY-FIELD form, so the client's own Accept/Decline
  // buttons ARE the decision (maintainer feedback, 2026-07-28 — the previous boolean
  // `approve` field rendered in Claude Code's TUI as a checkbox you had to space-select
  // and then submit: two non-obvious steps to answer a one-keypress question).
  //
  // PROBED before this shape shipped (`claude -p` + a raw `elicitation/create`, the Slice 0
  // P4 method): Claude Code ACCEPTS and answers `{type:"object", properties:{}}` exactly as
  // it does the boolean and enum forms — all three returned `{"action":"cancel"}` headlessly.
  // -------------------------------------------------------------------------
  {
    const sent: Array<{ message: string; requestedSchema: unknown }> = [];
    const mk = (res: { action?: unknown; content?: unknown }) =>
      makeElicitationRequester({
        capabilities: { elicitation: {} },
        send: async (params) => {
          sent.push(params);
          return res;
        },
      });

    // THE SHAPE. No fields — that is the whole UX fix, so it is pinned.
    const probe = mk({ action: "decline" });
    c.check(probe.available, "elicit: a BARE `elicitation: {}` capability counts as available");
    await probe.ask({ message: "m", timeoutMs: 100 });
    c.check(sent.length === 1, "elicit: the request was actually issued");
    const schema = sent[0].requestedSchema as { type?: string; properties?: Record<string, unknown> };
    c.check(schema.type === "object", "elicit: the requestedSchema is an object schema");
    c.check(
      schema.properties !== undefined && Object.keys(schema.properties).length === 0,
      `elicit: it declares NO fields, so Accept/Decline is the decision (got ${JSON.stringify(schema.properties)})`,
    );
    c.check(
      !Object.prototype.hasOwnProperty.call(sent[0].requestedSchema as object, "required"),
      "elicit: and no `required` list, which would be meaningless with no fields",
    );

    // THE MAPPING. Only the literal "accept" approves.
    c.check(
      (await mk({ action: "accept" }).ask({ message: "m", timeoutMs: 100 })) === "accept",
      "elicit: action 'accept' approves — with no field to leave unset it is unambiguous",
    );
    c.check(
      (await mk({ action: "accept", content: {} }).ask({ message: "m", timeoutMs: 100 })) === "accept",
      "elicit: an accept with an EMPTY content still approves (the old approve:true rule is gone)",
    );
    c.check(
      (await mk({ action: "decline" }).ask({ message: "m", timeoutMs: 100 })) === "decline",
      "elicit: action 'decline' rejects",
    );
    c.check(
      (await mk({ action: "cancel" }).ask({ message: "m", timeoutMs: 100 })) === "cancel",
      "elicit: action 'cancel' is unchanged (the bridge abstains or rejects on it)",
    );

    // THE FAIL-CLOSED PROPERTY, stated positively: NOTHING but "accept" ever approves.
    const notConsent: Array<{ action?: unknown; content?: unknown }> = [
      {},
      { action: undefined },
      { action: null },
      { action: "" },
      { action: "Accept" },
      { action: "ACCEPT" },
      { action: "accepted" },
      { action: "approve" },
      { action: "ok" },
      { action: "some-future-action" },
      { action: 1 },
      { action: true },
      { action: ["accept"] },
      { action: { action: "accept" } },
      { action: "decline", content: { approve: true } },
      { action: "cancel", content: { approve: true } },
    ];
    let approvedSomething = "";
    for (const res of notConsent) {
      if ((await mk(res).ask({ message: "m", timeoutMs: 100 })) === "accept") {
        approvedSomething = JSON.stringify(res);
        break;
      }
    }
    c.check(
      approvedSomething === "",
      `elicit: ONLY the literal "accept" approves — no unknown/odd action ever does (leaked on ${approvedSomething})`,
    );
    // And the same values must not be silently re-read as a decline either: everything that
    // is not accept/decline is a cancel, which the bridge handles as abstain-or-reject.
    c.check(
      (await mk({ action: "some-future-action" }).ask({ message: "m", timeoutMs: 100 })) === "cancel",
      "elicit: an unknown action is a CANCEL, so the bridge's fail-closed handling applies",
    );

    const boom = makeElicitationRequester({
      capabilities: { elicitation: {} },
      send: async () => {
        throw new Error("client went away");
      },
    });
    c.check(
      (await boom.ask({ message: "m", timeoutMs: 100 })) === "cancel",
      "elicit: a transport failure maps to cancel ⇒ reject (fail-closed)",
    );
    const none = makeElicitationRequester({ capabilities: {}, send: async () => ({}) });
    c.check(!none.available, "elicit: a client without the capability is unavailable");
    c.check(
      (await none.ask({ message: "m", timeoutMs: 100 })) === "cancel",
      "elicit: and asking an unavailable channel never approves",
    );
  }

  // -------------------------------------------------------------------------
  // The MESSAGE now carries everything, because the form has no fields to carry it.
  // -------------------------------------------------------------------------
  {
    const msg = (tool: string, detail = "npm test") =>
      elicitationMessage({
        command: "/guild:delegate",
        model: "openai/gpt-5.5",
        tool,
        detail,
        timeoutMs: 120_000,
      });

    const bash = msg("bash");
    c.check(bash.includes("/guild:delegate"), "message: names the command");
    c.check(bash.includes("openai/gpt-5.5"), "message: names the model");
    c.check(bash.includes("bash") && bash.includes("npm test"), "message: names the tool and what it would run");
    c.check(
      bash.includes("approves a SHELL"),
      "message: a bash request states the shell bound AT THE POINT OF DECISION",
    );
    c.check(
      bash.toLowerCase().includes("not containment"),
      "message: and never reads as a containment guarantee",
    );
    c.check(
      bash.includes("Accept") && bash.includes("Decline"),
      "message: it tells you the buttons are the decision (there is no field to fill)",
    );
    c.check(bash.includes("120s"), "message: and states the fail-closed deadline");

    const edit = msg("edit", "src/foo.ts");
    c.check(
      edit.includes("write/patch family"),
      "message: an 'edit' request says what one approval actually covers (the write key is inert)",
    );
    c.check(!edit.includes("approves a SHELL"), "message: and does not claim the shell bound for edit");
    const web = msg("webfetch", "https://example.com");
    c.check(
      !web.includes("approves a SHELL") && !web.includes("write/patch family"),
      "message: a tool with neither caveat gets neither",
    );

    // Model-controlled fragments are sanitized here too — this string goes to a TUI.
    const ESC = "\u001b";
    const spoofed = msg(`bash${ESC}[2K`, `npm test${ESC}[1A${ESC}[2K`);
    c.check(!spoofed.includes(ESC), "message: control characters never reach the prompt");
  }

  // -------------------------------------------------------------------------
  // 9. TIMEOUT ⇒ REJECT. Nobody answers; the fail-closed deadline settles it.
  //    (Driven fast through GUILD_APPROVE_TIMEOUT_MS, not by waiting out a real one.)
  // -------------------------------------------------------------------------
  {
    const root = tmp("apr-timeout-");
    const logDir = tmp("apr-timeoutlogs-");
    const repo = tmp("apr-timeoutrepo-");
    plantWatcher(logDir); // a channel EXISTS (so arming is allowed) but never answers
    const env = envWith({
      GUILD_ROOT: root,
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDirWith("guild-build"),
      GUILD_APPROVE: "write",
      GUILD_APPROVE_TIMEOUT_MS: "300",
    });
    const fake = await startFakeOpencode({
      historyText: "blocked",
      sessionId: "ses_timeout",
      gateTool: "edit",
      gateMetadata: { filePath: "src/foo.ts" },
      gateTimeoutMs: 8_000,
    });
    try {
      const t0 = Date.now();
      const r = await delegate(
        { task: "edit foo", model: "openai/allowed" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 15_000, repoDir: repo },
      );
      const elapsed = Date.now() - t0;
      c.check(r.ok, "timeout: the turn completes once the request is rejected");
      c.check(
        fake.gateOutcomes()[0] === "reject",
        `timeout: an unanswered request is REJECTED, not left open (got ${JSON.stringify(fake.gateOutcomes())})`,
      );
      c.check(
        elapsed < 6_000,
        `timeout: it fired on the approval deadline, not the fake's backstop (${elapsed}ms)`,
      );
      const replies = fake.permissionReplies();
      c.check(
        (replies[0]?.message ?? "").includes("300ms"),
        `timeout: the model is told it was a timeout (got '${replies[0]?.message}')`,
      );
      if (r.ok) {
        c.check(
          r.approval?.timedOut === 1 && r.approval?.rejected === 1,
          `timeout: the counters distinguish a timeout from a human 'no' (${JSON.stringify(r.approval)})`,
        );
        c.check(
          r.approval?.gatedTools.join(",") === "edit,write,patch",
          "timeout: GUILD_APPROVE=write gated exactly the file-mutation tools",
        );
      }
    } finally {
      closeAllBuses();
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 10. CONTINUED SESSIONS. A ruleset is fixed at creation; a session created WITHOUT it
  //     cannot be gated, so the turn is refused rather than run ungated.
  // -------------------------------------------------------------------------
  {
    const root = tmp("apr-cont-");
    const logDir = tmp("apr-contlogs-");
    plantWatcher(logDir);
    const env = envWith({
      GUILD_ROOT: root,
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDirWith("guild-read"),
      GUILD_APPROVE_EGRESS: "ask",
      GUILD_APPROVE_TIMEOUT_MS: "300",
    });
    const fake = await startFakeOpencode({ historyText: "should not run", sessionId: "ses_cont" });
    try {
      const r = await consult(
        { question: "q", model: "openai/allowed", sessionId: "ses_made_earlier" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(!r.ok, "continued: an armed continuation of an UNGATED session is refused");
      c.check(
        !r.ok && r.error.kind === "approval-not-applied",
        `continued: with its own error kind (got ${!r.ok ? r.error.kind : "ok"})`,
      );
      c.check(
        !r.ok && r.error.message.includes("fixed when the session is CREATED"),
        "continued: the message explains WHY, and what to do instead",
      );
      c.check(
        fake.recorded.messageBodies.length === 0,
        "continued: no turn was sent — it refused rather than run ungated",
      );
      // It got past the model gate, so the C24 lifecycle cardinality still has to hold: the
      // refusal must leave exactly one expect + started + completed, never a dangling
      // expected-call. (`verify` then reports exit-7 "incomplete capture" — the ORDINARY
      // verdict for any call that failed before producing a response, not a gap.)
      const runs = readdirSync(logDir).filter((n) => n !== "latest" && n !== "watchers");
      c.check(runs.length === 1, "continued: exactly one run was written");
      const entries = readFileSync(path.join(logDir, runs[0], "calls.jsonl"), "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      c.check(
        entries.length === 3 &&
          entries[0].type === "expected-call" &&
          entries[1].status === "started" &&
          entries[2].status === "completed",
        `continued: the refusal still wrote expect→started→completed (${JSON.stringify(entries.map((e) => e.status))})`,
      );
      c.check(
        entries[2].capture_state === "failed" && entries[2].raw_response === "",
        "continued: and NO answer was fabricated on the failed call",
      );
      const verdict = new EvidenceLog({ env }).verify(runs[0]);
      c.check(
        verdict.code === 7 && /incomplete evidence capture/.test(verdict.message),
        `continued: verify reports the ordinary failed-capture verdict, not a missing entry (${verdict.code}: ${verdict.message})`,
      );
    } finally {
      closeAllBuses();
      await fake.close();
    }
  }

  // A continuation of a session that DOES carry the rules proceeds — the workshop flow
  // (panel keepSessions → consult sessionId) must not break under the egress knob.
  {
    const root = tmp("apr-cont2-");
    const logDir = tmp("apr-cont2logs-");
    plantWatcher(logDir);
    const env = envWith({
      GUILD_ROOT: root,
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDirWith("guild-read"),
      GUILD_APPROVE_EGRESS: "ask",
      GUILD_APPROVE_TIMEOUT_MS: "300",
    });
    const fake = await startFakeOpencode({
      historyText: "round two",
      sessionId: "ses_kept",
    });
    try {
      // Round 1 creates the session WITH the ruleset and keeps it.
      const first = await consult(
        { question: "round one", model: "openai/allowed", keepSession: true },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(first.ok, "continued-ok: round 1 succeeded");
      const kept = first.ok ? first.sessionId : undefined;
      c.check(kept === "ses_kept", "continued-ok: round 1 returned the session id");
      const second = await consult(
        { question: "round two", model: "openai/allowed", sessionId: kept },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(
        second.ok,
        `continued-ok: round 2 of a session created WITH the rules proceeds (${!second.ok ? second.error.message : ""})`,
      );
    } finally {
      closeAllBuses();
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 11. An opencode that IGNORES the ruleset must be caught, not trusted.
  // -------------------------------------------------------------------------
  {
    const root = tmp("apr-ign-");
    const logDir = tmp("apr-ignlogs-");
    const repo = tmp("apr-ignrepo-");
    plantWatcher(logDir);
    const env = envWith({
      GUILD_ROOT: root,
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDirWith("guild-build"),
      GUILD_APPROVE: "all",
    });
    const fake = await startFakeOpencode({
      historyText: "ran ungated",
      sessionId: "ses_ign",
      ignoreSessionPermission: true,
    });
    try {
      const r = await delegate(
        { task: "edit", model: "openai/allowed" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000, repoDir: repo },
      );
      c.check(!r.ok, "echo-check: a build that ignores `permission` fails the call");
      c.check(
        !r.ok && r.error.kind === "approval-not-applied",
        `echo-check: with the ungated-refusal kind (got ${!r.ok ? r.error.kind : "ok"})`,
      );
      c.check(
        fake.recorded.messageBodies.length === 0,
        "echo-check: no model turn ran — it refused BEFORE the turn, not after",
      );
    } finally {
      closeAllBuses();
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 12. `modelguild watch --approve`: presence, prompt, reply, and the 404 race.
  // -------------------------------------------------------------------------
  {
    const guildRoot = tmp("apr-watch-");
    const logDir = path.join(guildRoot, "logs");
    const runId = "20260728T000000Z-aaaaaa";
    mkdirSync(path.join(logDir, runId), { recursive: true });
    writeFileSync(path.join(logDir, runId, "activity.jsonl"), "");
    const approvalsFile = path.join(logDir, runId, APPROVALS_FILE);
    writeFileSync(approvalsFile, "");

    const env = envWith({ GUILD_ROOT: guildRoot, GUILD_LOG_DIR: logDir });
    const posted: Array<{ url: string; body: unknown }> = [];
    let nextStatus = 200;
    const fetchImpl = (async (url: unknown, init: unknown) => {
      posted.push({
        url: String(url),
        body: JSON.parse(String((init as { body?: unknown }).body ?? "{}")),
      });
      return { status: nextStatus } as Response;
    }) as unknown as typeof fetch;

    const asked: string[] = [];
    const answers = ["y", "n"];
    const printed: string[] = [];
    const realLog = console.log;
    // The watcher prints on console.log, and so does the Checker — so assertions made WHILE
    // it is hijacked would have their PASS lines swallowed into `printed`. Collect the
    // observations here and assert them after the real console is back.
    const obs: Array<[boolean, string]> = [];
    console.log = (...a: unknown[]) => {
      printed.push(a.map(String).join(" "));
    };
    const watching = runWatch(["--run", runId, "--approve"], {
      env,
      maxPolls: 60,
      pollMs: 15,
      fetchImpl,
      prompt: async (q) => {
        asked.push(q);
        return answers.shift() ?? "n";
      },
    });
    try {
      // The presence file must exist while the watcher runs — that is what lets the server arm.
      const announced = await waitFor(() => liveApprovalWatchers(logDir).length === 1, 2_000, 20);
      obs.push([announced, "watch: --approve announces a live approval watcher"]);

      const ask = (id: string, tool: string, detail: string) =>
        `${JSON.stringify({
          ts: new Date().toISOString(),
          run_id: runId,
          call_id: "call-w",
          command: "/guild:delegate",
          model: "openai/gpt-fake",
          agent: "guild-build",
          kind: "asked",
          permission_id: id,
          session_id: "ses_w",
          base_url: "http://127.0.0.1:1",
          tool,
          detail,
          timeout_ms: 120000,
          deadline: new Date(Date.now() + 120000).toISOString(),
        })}\n`;

      writeFileSync(approvalsFile, ask("per_1", "bash", "npm test") + ask("per_2", "edit", "src/x.ts"));
      const answered = await waitFor(() => posted.length === 2, 3_000, 20);
      obs.push([answered, `watch: both requests were answered (posted ${posted.length})`]);
      obs.push([asked.length === 2, `watch: the human was prompted once per request (got ${asked.length})`]);
      obs.push([
        printed.some((l) => l.includes("npm test")) && printed.some((l) => l.includes("src/x.ts")),
        "watch: each prompt showed what would run",
      ]);
      obs.push([
        printed.some((l) => l.includes("approves a SHELL")),
        "watch: the bash prompt states the honest bound",
      ]);
      obs.push([
        posted[0].url.includes("/session/ses_w/permissions/per_1") &&
          JSON.stringify(posted[0].body) === JSON.stringify({ response: "once" }),
        `watch: 'y' approves via the session-scoped endpoint (got ${posted[0]?.url})`,
      ]);
      obs.push([
        posted[1].url.includes("/permission/per_2/reply") &&
          (posted[1].body as { reply?: string }).reply === "reject",
        `watch: 'N' rejects via the message-carrying endpoint (got ${posted[1]?.url})`,
      ]);
      obs.push([
        String((posted[1].body as { message?: string }).message ?? "").includes("watch"),
        "watch: the rejection tells the model where the 'no' came from",
      ]);

      // A request the SERVER already decided must never be prompted for again.
      const before = asked.length;
      writeFileSync(
        approvalsFile,
        `${JSON.stringify({ kind: "decided", permission_id: "per_3", decision: "reject", by: "timeout" })}\n` +
          ask("per_3", "bash", "too late"),
      );
      await new Promise((r) => setTimeout(r, 300));
      obs.push([asked.length === before, "watch: an already-decided request is never prompted for"]);

      // Losing the race is reported, not retried.
      nextStatus = 404;
      answers.push("y");
      writeFileSync(approvalsFile, ask("per_4", "bash", "raced"));
      await waitFor(() => posted.length === 3, 2_000, 20);
      await new Promise((r) => setTimeout(r, 150));
      obs.push([
        printed.some((l) => l.includes("too late: opencode had already settled")),
        "watch: a 404 (somebody answered first) is reported plainly, not retried",
      ]);
    } finally {
      await watching;
      console.log = realLog;
    }
    for (const [ok, msg] of obs) c.check(ok, msg);
    c.check(
      liveApprovalWatchers(logDir).length === 0,
      "watch: the presence file is retracted when the watcher stops",
    );

    // `--approve --no-follow` is a usage error: you cannot answer after you have exited.
    const realErr = console.error;
    console.error = () => {};
    let badCode: number;
    try {
      badCode = await runWatch(["--approve", "--no-follow"], { env });
    } finally {
      console.error = realErr;
    }
    c.check(badCode === 2, "watch: --approve with --no-follow is a usage error");
  }

  // -------------------------------------------------------------------------
  // 13. NO SELF-APPROVAL SURFACE. There must be no tool input by which the driver can
  //     pre-approve a permission request — a decision comes only from a human channel.
  // -------------------------------------------------------------------------
  {
    const serverSrc = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    // Every inputSchema property name in the file. Indentation-independent (the old version
    // pinned exactly ten spaces, so a reformat would have silently disarmed this check) and
    // ASSERTED NON-EMPTY, so "found nothing" can never pass as "found nothing forbidden".
    const props = new Set<string>();
    const schemaBlocks = serverSrc.matchAll(/properties:\s*\{([\s\S]*?)\n\s*\},?\n\s*(?:required|additionalProperties)/g);
    for (const block of schemaBlocks) {
      for (const m of block[1].matchAll(/^\s+(\w+):\s*(?:\{|TIMEOUT_MS_PROP)/gm)) props.add(m[1]);
    }
    c.check(
      props.size > 0,
      `self-approval: the scan actually found tool input properties (${props.size}) — a scan that finds none proves nothing`,
    );
    c.check(
      props.has("question") && props.has("task"),
      `self-approval: and it found the known ones (${[...props].sort().join(",")})`,
    );
    const forbidden = [...props].filter((p) => /approv|permission|elicit/i.test(p));
    c.check(
      forbidden.length === 0,
      `self-approval: no tool input names an approval (found ${JSON.stringify(forbidden)})`,
    );
    c.check(
      !/approve\s*[:=]\s*(a\.|args)/.test(serverSrc),
      "self-approval: no handler reads an approval argument off the tool input",
    );
  }

  // -------------------------------------------------------------------------
  // 14. The read paths are untouched by GUILD_APPROVE alone — the default stays default.
  // -------------------------------------------------------------------------
  {
    const root = tmp("apr-read-");
    const logDir = tmp("apr-readlogs-");
    const env = envWith({
      GUILD_ROOT: root,
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDirWith("guild-research"),
      // Armed for the write path, and with NO channel available — a read call must still run,
      // because nothing on it is gated.
      GUILD_APPROVE: "all",
    });
    const fake = await startFakeOpencode({ historyText: "researched", sessionId: "ses_read" });
    try {
      const r = await research(
        { question: "q", model: "openai/allowed" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000 },
      );
      c.check(r.ok, `read-path: GUILD_APPROVE=all does not gate or refuse a read call`);
      c.check(
        r.ok && r.approval === undefined,
        "read-path: and no approval record is attached — nothing was armed",
      );
      c.check(
        fake.recorded.createBodies[0].permission === undefined,
        "read-path: no ruleset was sent",
      );
    } finally {
      closeAllBuses();
      await fake.close();
    }
  }

  // =========================================================================
  // REVIEW FINDINGS (adversarial + functional review, 2026-07-28). Each block names the
  // finding it pins, so a regression reads as "H1 came back", not as an anonymous red.
  //
  // NOTE ON THIS FILE'S CONTROL CHARACTERS: they are written as \u escapes, never as literal
  // bytes. A literal ESC in a source file is precisely what an editor, a diff viewer or a
  // terminal mangles — and a test about ANSI injection that cannot survive being read is
  // worse than no test.
  // =========================================================================

  // -------------------------------------------------------------------------
  // H1 — terminal/elicitation spoof. Model-controlled text reaches a TTY and an MCP prompt;
  //      JS `\s` does NOT include ESC, so a whitespace collapse leaves ANSI intact and a
  //      crafted command can REPAINT the prompt as a benign one (reproduced in review).
  // -------------------------------------------------------------------------
  {
    const ESC = "\u001b";
    c.check(
      sanitizeForDisplay(`${ESC}[1A${ESC}[2K harmless`).includes("�"),
      "H1: ESC-based ANSI is replaced, not preserved",
    );
    c.check(
      !sanitizeForDisplay(`rm -rf /${ESC}[2K`).includes(ESC),
      "H1: no ESC survives sanitizing",
    );
    c.check(
      sanitizeForDisplay("a\u0000b\u0007c\u009bd").split("�").length === 4,
      "H1: NUL, BEL and the 8-bit C1/CSI range are all replaced",
    );
    c.check(sanitizeForDisplay("plain text") === "plain text", "H1: ordinary text is untouched");

    // Through the WATCHER's renderer — where the developer actually reads it.
    const spoof = `npm test${ESC}[1A${ESC}[2K   tool: bash  echo hi`;
    const rendered = formatApprovalPrompt({
      permission_id: "per_x",
      session_id: "s",
      base_url: "http://127.0.0.1:1",
      tool: `bash${ESC}[2K`,
      detail: spoof,
      model: `m${ESC}[2K`,
      command: `/guild:delegate${ESC}[2K`,
      deadline: "",
      timeout_ms: 1000,
    }).join("\n");
    c.check(!rendered.includes(ESC), "H1: the watcher prompt contains NO escape characters");
    c.check(
      rendered.includes("�"),
      "H1: tampering stays VISIBLE as replacement chars rather than being silently cleaned",
    );
    c.check(
      formatApprovalNotice({
        permission_id: "p",
        session_id: "s",
        base_url: "",
        tool: `bash${ESC}[2K`,
        detail: spoof,
        model: "m",
        command: "/guild:delegate",
        deadline: "",
        timeout_ms: 1000,
      }).includes(ESC) === false,
      "H1: the queued-request notice is sanitized too",
    );

    // Through the BRIDGE, which builds the elicitation message and the approvals record.
    c.check(
      !summarizePermission({
        ts: 0,
        sessionId: "s",
        kind: "permission-asked",
        summary: "",
        detail: { metadata: { command: spoof } },
      }).includes(ESC),
      "H1: the bridge's permission summary strips escapes before anything renders it",
    );

    const seen: string[] = [];
    const dir = tmp("apr-h1-");
    const file = path.join(dir, APPROVALS_FILE);
    const bridge = new ApprovalBridge({
      settings: { tier: "all", egress: "off", timeoutMs: 5_000 },
      gatedTools: ["bash"],
      channels: ["elicitation"],
      context: { runId: "r", callId: "c", model: "m", agent: "guild-build", command: "/guild:delegate" },
      armed: true,
      file,
      elicitation: {
        available: true,
        async ask({ message }) {
          seen.push(message);
          return "decline";
        },
      },
      fetchImpl: (async () => ({ status: 200 })) as unknown as typeof fetch,
    });
    bridge.handleEvent({
      ts: Date.now(),
      sessionId: "s",
      kind: "permission-asked",
      summary: "permission asked: bash",
      permissionId: "per_spoof",
      permissionTool: `bash${ESC}[2K`,
      detail: { metadata: { command: spoof }, patterns: ["*"] },
    });
    await new Promise((r) => setTimeout(r, 50));
    c.check(seen.length === 1, "H1: the elicitation prompt was issued");
    c.check(!seen[0].includes(ESC), "H1: and it carries NO escape characters either");
    const recorded = readFileSync(file, "utf8");
    c.check(!recorded.includes(ESC), "H1: nor does the approvals.jsonl record");
    bridge.close();
  }

  // -------------------------------------------------------------------------
  // H3 — the allow-set must come from the def IN FORCE, never a hard-coded mirror.
  // -------------------------------------------------------------------------
  {
    // (a) The parser's answer for each SHIPPED def. This is the lint tying the code to the
    //     files, replacing the mirror table that could silently disagree with them.
    const build = shippedAllowSet("guild-build");
    c.check(
      build.has("edit") && build.has("write") && build.has("patch") && build.has("bash"),
      `H3: guild-build's def allows edit/write/patch/bash (got ${[...build].sort().join(",")})`,
    );
    c.check(
      !build.has("webfetch") && !build.has("websearch"),
      "H3: guild-build's def does NOT allow the web tools",
    );
    for (const agent of ["guild-read", "guild-research"]) {
      const set = shippedAllowSet(agent);
      c.check(
        set.has("webfetch") && set.has("websearch"),
        `H3: ${agent}'s def allows webfetch/websearch`,
      );
      c.check(
        !set.has("edit") && !set.has("write") && !set.has("patch") && !set.has("bash"),
        `H3: ${agent}'s def allows NONE of the write tools (got ${[...set].sort().join(",")})`,
      );
    }

    // (b) Last-match-wins, including a `"*"` placed AFTER a named key.
    const floorLast = parseAgentPermissions(
      '---\nmode: all\npermission:\n  edit: allow\n  "*": deny\n---\n',
    );
    c.check(
      floorLast.ok && !floorLast.allow.has("edit"),
      'H3: a `"*": deny` AFTER a named allow wins (last match)',
    );
    const noFloor = parseAgentPermissions("---\nmode: all\npermission:\n  bash: allow\n---\n");
    c.check(
      noFloor.ok && noFloor.allow.has("bash") && noFloor.allow.has("edit"),
      'H3: with no `"*"` at all, opencode\'s built-in default (allow) is modelled',
    );
    const submap = parseAgentPermissions(
      '---\nmode: all\npermission:\n  "*": deny\n  edit:\n    "*": allow\n    "x": deny\n---\n',
    );
    c.check(submap.ok && submap.allow.has("edit"), 'H3: a submap resolves by its own `"*"`');
    const noStar = parseAgentPermissions(
      '---\nmode: all\npermission:\n  "*": deny\n  edit:\n    "x": deny\n---\n',
    );
    c.check(
      noStar.ok && !noStar.allow.has("edit"),
      'H3: a submap with NO `"*"` is unresolved and treated as NOT allowed (gate less)',
    );
    c.check(
      (() => {
        const r = parseAgentPermissions(
          '---\nmode: all\npermission:\n  # a comment\n  "*": deny\n\n  bash: allow  # inline\n---\n',
        );
        return r.ok && r.allow.has("bash") && !r.allow.has("edit");
      })(),
      "H3: comments and blank lines inside the block are ignored",
    );
    for (const [text, why] of [
      ["no frontmatter here", "a def with no frontmatter"],
      ["---\nmode: all\n---\nbody", "a def with no permission block"],
      ["---\nmode: all\npermission:\n---\nbody", "a permission block with no entries"],
    ] as const) {
      c.check(!parseAgentPermissions(text).ok, `H3: ${why} is a PARSE FAILURE, not an empty guess`);
    }

    // (c) THE FINDING ITSELF: a user-hardened def that denies bash must never be gated for it.
    const hardened = defDirWithPermissions(
      "guild-build",
      '  "*": deny\n  edit: allow\n  write: allow\n  patch: allow\n  bash: deny\n',
    );
    const logDir = tmp("apr-h3-");
    plantWatcher(logDir);
    const armed = armApproval({
      agent: "guild-build",
      env: envWith({ GUILD_APPROVE: "all", GUILD_LOG_DIR: logDir }),
      confContents: "",
      agentDefDirs: [hardened],
      log: new EvidenceLog({ env: envWith({ GUILD_LOG_DIR: logDir }) }),
    });
    c.check(armed.ok && armed.arming !== undefined, "H3: it still arms for the tools that ARE allowed");
    c.check(
      armed.ok && armed.arming?.gatedTools.includes("bash") === false,
      `H3: a def that DENIES bash is never gated for bash (got ${armed.ok ? JSON.stringify(armed.arming?.gatedTools) : "refused"})`,
    );
    c.check(
      armed.ok && armed.arming?.ruleset.every((r) => r.permission !== "bash") === true,
      "H3: and no {bash,*,ask} rule is emitted — the widening the mirror allowed is gone",
    );
    c.check(
      armed.ok && armed.arming?.agentDefFile.includes("guild-build.md") === true,
      "H3: the arming names the def file its answer came from",
    );

    // (d) An UNPARSEABLE def refuses rather than guessing.
    const brokenDir = tmp("apr-h3-broken-");
    writeFileSync(path.join(brokenDir, "guild-build.md"), "no frontmatter at all\n");
    const broken = armApproval({
      agent: "guild-build",
      env: envWith({ GUILD_APPROVE: "write", GUILD_LOG_DIR: logDir }),
      confContents: "",
      agentDefDirs: [brokenDir],
      log: new EvidenceLog({ env: envWith({ GUILD_LOG_DIR: logDir }) }),
    });
    c.check(!broken.ok, "H3: an unparseable def REFUSES rather than running ungated");
    c.check(
      !broken.ok && broken.refusal.message.includes("guild-build.md"),
      "H3: and the refusal names the file to fix",
    );
    c.check(
      !broken.ok && broken.refusal.kind === "approval-config",
      "H3: refused as a config problem, which is what it is",
    );

    // (e) With the knob OFF the def is never consulted — the default path stays free.
    const offBroken = armApproval({
      agent: "guild-build",
      env: envWith({}),
      confContents: "",
      agentDefDirs: [brokenDir],
      log: new EvidenceLog({ env: envWith({ GUILD_LOG_DIR: logDir }) }),
    });
    c.check(
      offBroken.ok && offBroken.arming === undefined,
      "H3: GUILD_APPROVE=off never consults the def (an unparseable def is harmless when off)",
    );
  }

  // -------------------------------------------------------------------------
  // H2 — elicitation must not PRE-EMPT the watch terminal. Headless clients auto-cancel in
  //      milliseconds; treating that as an immediate reject burned every request's window.
  // -------------------------------------------------------------------------
  {
    const root = tmp("apr-h2-");
    const logDir = tmp("apr-h2logs-");
    const repo = tmp("apr-h2repo-");
    plantWatcher(logDir);
    const env = envWith({
      GUILD_ROOT: root,
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDirWith("guild-build"),
      GUILD_APPROVE: "all",
      GUILD_APPROVE_TIMEOUT_MS: "700",
    });
    const fake = await startFakeOpencode({
      historyText: "done",
      sessionId: "ses_h2",
      gateTool: "bash",
      gateMetadata: { command: "npm test" },
      gateTimeoutMs: 9_000,
    });
    try {
      const t0 = Date.now();
      const r = await delegate(
        { task: "t", model: "openai/allowed" },
        {
          serve: fakeServe(fake),
          env,
          messageTimeoutMs: 15_000,
          repoDir: repo,
          elicitation: stubElicitation("cancel"),
        },
      );
      const elapsed = Date.now() - t0;
      c.check(r.ok, "H2: the turn completes");
      c.check(
        elapsed > 600,
        `H2: the request was NOT settled in milliseconds — the watcher's window was honoured (${elapsed}ms)`,
      );
      if (r.ok) {
        c.check(
          r.approval?.abstained === 1,
          `H2: the cancel is recorded as an ABSTENTION (${JSON.stringify(r.approval?.abstained)})`,
        );
        c.check(
          r.approval?.decidedBy.timeout === 1,
          `H2: and the fail-closed TIMEOUT settled it, not the cancel (${JSON.stringify(r.approval?.decidedBy)})`,
        );
      }
      c.check(
        fake.gateOutcomes()[0] === "reject",
        "H2: still fail-closed — an unanswered request is rejected",
      );
    } finally {
      closeAllBuses();
      await fake.close();
    }
  }
  {
    // With elicitation as the SOLE channel, a cancel still REJECTS immediately.
    const root = tmp("apr-h2b-");
    const logDir = tmp("apr-h2blogs-");
    const repo = tmp("apr-h2brepo-");
    const env = envWith({
      GUILD_ROOT: root,
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDirWith("guild-build"),
      GUILD_APPROVE: "all",
      GUILD_APPROVE_TIMEOUT_MS: "60000",
    });
    const fake = await startFakeOpencode({
      historyText: "done",
      sessionId: "ses_h2b",
      gateTool: "bash",
      gateTimeoutMs: 9_000,
    });
    try {
      const t0 = Date.now();
      const r = await delegate(
        { task: "t", model: "openai/allowed" },
        {
          serve: fakeServe(fake),
          env,
          messageTimeoutMs: 15_000,
          repoDir: repo,
          elicitation: stubElicitation("cancel"),
        },
      );
      const elapsed = Date.now() - t0;
      c.check(r.ok, "H2: (sole channel) the turn completes");
      c.check(
        elapsed < 10_000,
        `H2: (sole channel) a cancel settles at once rather than waiting out a 60s deadline (${elapsed}ms)`,
      );
      if (r.ok) {
        c.check(
          r.approval?.abstained === 0 && r.approval?.decidedBy.elicitation === 1,
          `H2: (sole channel) the cancel itself rejected — fail-closed preserved (${JSON.stringify(r.approval?.decidedBy)})`,
        );
      }
      c.check(fake.gateOutcomes()[0] === "reject", "H2: (sole channel) the tool saw a reject");
    } finally {
      closeAllBuses();
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // M5 — counters must come from EVIDENCE. A reply that 404'd or never left the process is
  //      not a decision, and the old code counted it as one.
  // -------------------------------------------------------------------------
  {
    // Each bridge is ATTACHED to a real (fake) serve rather than driven with an empty
    // baseUrl: the reply path is what is under test, and a bridge that never attached would
    // short-circuit before it, proving nothing.
    const unitFake = await startFakeOpencode({ historyText: "unused", sessionId: "ses_unit" });
    const mk = async (fetchImpl: typeof fetch, timeoutMs = 30): Promise<ApprovalBridge> => {
      const b = new ApprovalBridge({
        settings: { tier: "all", egress: "off", timeoutMs },
        gatedTools: ["bash"],
        channels: ["watch"],
        context: { runId: "", callId: "c", model: "m", agent: "guild-build", command: "/guild:delegate" },
        armed: true,
        fetchImpl,
      });
      await b.attach(unitFake.baseUrl, "ses_unit");
      return b;
    };
    const ask = (b: ApprovalBridge, id: string): void =>
      b.handleEvent({
        ts: Date.now(),
        sessionId: "s",
        kind: "permission-asked",
        summary: "permission asked: bash",
        permissionId: id,
        permissionTool: "bash",
        detail: { metadata: { command: "npm test" } },
      });

    // A 404 — the DOCUMENTED lost-race outcome. Driven through the real fail-closed timer.
    const lost = await mk((async () => ({ status: 404 })) as unknown as typeof fetch);
    ask(lost, "per_404");
    await new Promise((r) => setTimeout(r, 200));
    const s404 = lost.summary();
    c.check(
      s404.rejected === 0 && s404.approved === 0,
      `M5: a 404 reply is NOT counted as a decision (${JSON.stringify(s404)})`,
    );
    c.check(s404.contested === 1, "M5: it is counted as contested — somebody else settled it");
    c.check(s404.requests === 1, "M5: the request itself is still counted");
    lost.close();

    // A transport failure.
    const dead = await mk((async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch);
    ask(dead, "per_dead");
    await new Promise((r) => setTimeout(r, 200));
    const sDead = dead.summary();
    c.check(
      sDead.rejected === 0 && sDead.undelivered === 1,
      `M5: an undelivered reply is counted as undelivered, not as a rejection (${JSON.stringify(sDead)})`,
    );
    dead.close();

    // A 2xx — the only thing that counts as a decision.
    const okB = await mk((async () => ({ status: 200 })) as unknown as typeof fetch);
    ask(okB, "per_ok");
    await new Promise((r) => setTimeout(r, 200));
    const sOk = okB.summary();
    c.check(
      sOk.rejected === 1 && sOk.timedOut === 1 && sOk.decidedBy.timeout === 1,
      `M5: a 2xx reply IS the decision, attributed to its settler (${JSON.stringify(sOk)})`,
    );
    okB.close();

    // L11: a reply for an id we never saw ASKED still counts as a request.
    const surprise = await mk((async () => ({ status: 200 })) as unknown as typeof fetch, 60_000);
    surprise.handleEvent({
      ts: Date.now(),
      sessionId: "s",
      kind: "permission-replied",
      summary: "permission once",
      permissionId: "per_unseen",
      permissionReply: "once",
    });
    const sSurprise = surprise.summary();
    c.check(
      sSurprise.requests === 1 && sSurprise.approved === 1,
      `L11: a reply we never saw asked cannot yield requests:0, approved:1 (${JSON.stringify(sSurprise)})`,
    );
    c.check(sSurprise.externallyAnswered === 1, "L11: and it is attributed to an outside answerer");
    surprise.close();
    closeAllBuses();
    await unitFake.close();
  }

  // -------------------------------------------------------------------------
  // M6 — a bridge that goes blind mid-turn must say so and reject what is open, rather than
  //      leaving the model to block to GUILD_MESSAGE_TIMEOUT_MS while reporting requests:0.
  // -------------------------------------------------------------------------
  {
    const m6Fake = await startFakeOpencode({ historyText: "unused", sessionId: "ses_m6" });
    const replies: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    const bridge = new ApprovalBridge({
      settings: { tier: "all", egress: "off", timeoutMs: 60_000 },
      gatedTools: ["bash"],
      channels: ["watch"],
      context: { runId: "", callId: "c", model: "m", agent: "guild-build", command: "/guild:delegate" },
      armed: true,
      fetchImpl: (async (url: unknown, init: unknown) => {
        replies.push(String(url));
        bodies.push(JSON.parse(String((init as { body?: unknown }).body ?? "{}")) as Record<string, unknown>);
        return { status: 200 } as Response;
      }) as unknown as typeof fetch,
    });
    await bridge.attach(m6Fake.baseUrl, "ses_m6");
    bridge.handleEvent({
      ts: Date.now(),
      sessionId: "ses_m6",
      kind: "permission-asked",
      summary: "permission asked: bash",
      permissionId: "per_blind",
      permissionTool: "bash",
      detail: { metadata: { command: "npm test" } },
    });
    c.check(bridge.summary().requests === 1, "M6: the request was seen");
    c.check(bridge.summary().degraded === false, "M6: not degraded yet");
    bridge.degrade("event stream dropped: socket hang up");
    await new Promise((r) => setTimeout(r, 80));
    const s = bridge.summary();
    c.check(s.degraded === true, "M6: degradation is surfaced on the summary");
    c.check(
      (s.degradedReason ?? "").includes("socket hang up"),
      `M6: with the reason it was lost for (${s.degradedReason})`,
    );
    c.check(
      s.rejected === 1 && s.decidedBy.degraded === 1,
      `M6: the open request was REJECTED rather than left to block (${JSON.stringify(s.decidedBy)})`,
    );
    c.check(
      replies.some((u) => u.includes("/permission/per_blind/reply")),
      "M6: and the reject was actually sent",
    );
    c.check(
      String(bodies[0]?.message ?? "").includes("lost opencode's event stream"),
      `M6: the model is told WHY it was rejected (${String(bodies[0]?.message ?? "").slice(0, 60)})`,
    );
    bridge.close();
    closeAllBuses();
    await m6Fake.close();
  }

  // -------------------------------------------------------------------------
  // #91 — RE-LIST ON RE-ATTACH. M6 covers requests that were already OPEN when the stream
  //       died. This covers the ones raised WHILE blind, which the stream can never deliver
  //       (SSE has no replay) and which therefore used to wait on GUILD_MESSAGE_TIMEOUT_MS
  //       with nothing prompted at all.
  //
  //       The guarantee under test is "recovered on re-attach", NOT "never missed" — the
  //       endpoint lists what is still OPEN, so a request settled by somebody else during the
  //       blind window leaves nothing to find. That is why `blindWindows` is latched even
  //       when `degraded` clears, and it is asserted below.
  // -------------------------------------------------------------------------
  {
    /** A bridge wired to a fake, whose replies go to a stub (so the fake never learns of them
     * and the request stays OPEN in its list — which is exactly the state a dedup test needs)
     * while GETs still reach the fake for real. */
    const relistBridge = async (
      fake: FakeOpencode,
      sessionId: string,
      opts: { prompts?: string[]; file?: string; stubReplies?: boolean } = {},
    ): Promise<{ bridge: ApprovalBridge; posted: string[] }> => {
      const posted: string[] = [];
      const fetchImpl = (async (url: unknown, init: unknown) => {
        const method = String((init as { method?: unknown })?.method ?? "GET");
        if (method === "POST") {
          posted.push(String(url));
          if (opts.stubReplies === true) return { status: 200 } as Response;
        }
        return fetch(url as string, init as RequestInit);
      }) as unknown as typeof fetch;
      const bridgeOpts: ConstructorParameters<typeof ApprovalBridge>[0] = {
        settings: { tier: "all", egress: "off", timeoutMs: 60_000 },
        gatedTools: ["bash"],
        channels: ["elicitation"],
        context: { runId: "", callId: "c", model: "m", agent: "guild-build", command: "/guild:delegate" },
        armed: true,
        elicitation: stubElicitation("accept", opts.prompts),
        fetchImpl,
      };
      if (opts.file !== undefined) bridgeOpts.file = opts.file;
      const bridge = new ApprovalBridge(bridgeOpts);
      await bridge.attach(fake.baseUrl, sessionId);
      return { bridge, posted };
    };

    // (a) THE WIRING: the BUS calls back on re-attach, and the bridge recovers the request.
    //     Driven through a real stream drop rather than by poking the bridge, so the seam
    //     added to `ServeEventBus` is what is under test, not a hand-called method.
    {
      const fake = await startFakeOpencode({ historyText: "unused", sessionId: "ses_91a" });
      const prompts: string[] = [];
      const { bridge } = await relistBridge(fake, "ses_91a", { prompts });
      fake.addPendingPermission({
        id: "per_blindraised",
        sessionID: "ses_91a",
        permission: "bash",
        metadata: { command: "npm run build" },
      });
      fake.dropEventClients();
      const ok = await waitFor(() => bridge.summary().recovered === 1, 6_000, 50);
      const s = bridge.summary();
      c.check(ok, `#91a: a request raised while blind is RECOVERED on re-attach (${JSON.stringify(s)})`);
      c.check(s.requests === 1, "#91a: and counted as a request, not silently absorbed");
      c.check(
        prompts.length === 1 && prompts[0].includes("npm run build"),
        `#91a: the developer is PROMPTED with the real command (${JSON.stringify(prompts)})`,
      );
      c.check(s.blindWindows === 1, `#91a: the blind window is latched (${s.blindWindows})`);
      await waitFor(() => bridge.summary().approved === 1, 3_000, 50);
      c.check(
        bridge.summary().approved === 1,
        `#91a: and the recovered request is answered, unblocking the model (${JSON.stringify(bridge.summary())})`,
      );
      bridge.close();
      closeAllBuses();
      await fake.close();
    }

    // (b) A REQUEST THIS BRIDGE ALREADY REJECTED ON THE DEGRADED PATH IS NOT RE-PROMPTED.
    //     The stub swallows the reject, so opencode still lists the request as open — the
    //     hardest version of this case, and the one where a naive re-list double-prompts.
    {
      const dir = tmp("apr-91b-");
      const file = path.join(dir, APPROVALS_FILE);
      const fake = await startFakeOpencode({ historyText: "unused", sessionId: "ses_91b" });
      const prompts: string[] = [];
      const { bridge } = await relistBridge(fake, "ses_91b", { prompts, file, stubReplies: true });
      fake.addPendingPermission({ id: "per_alreadyrejected", sessionID: "ses_91b" });
      // Seen on the stream, then the stream dies with it open ⇒ rejected fail-closed (M6).
      // `degrade` runs in the SAME synchronous block as `handleEvent`, so it settles the
      // request before the stub elicitation's answer can be delivered on a microtask — the
      // late `accept` is then correctly dropped by the already-claimed guard, which is why
      // `decidedBy` below is the degraded reject and not an approval.
      bridge.handleEvent({
        ts: Date.now(),
        sessionId: "ses_91b",
        kind: "permission-asked",
        summary: "permission asked: bash",
        permissionId: "per_alreadyrejected",
        permissionTool: "bash",
        detail: { metadata: { command: "rm -rf /" } },
      });
      bridge.degrade("event stream dropped: socket hang up");
      await waitFor(() => bridge.summary().rejected === 1, 2_000, 25);
      const promptsAfterReject = prompts.length;
      await bridge.reattached();
      const s = bridge.summary();
      c.check(
        prompts.length === promptsAfterReject,
        `#91b: a request already answered is NOT put to the developer a second time (${prompts.length} vs ${promptsAfterReject})`,
      );
      c.check(s.recovered === 0, "#91b: and it is not counted as recovered");
      c.check(s.rejected === 1 && s.approved === 0, `#91b: its outcome is unchanged (${JSON.stringify(s)})`);
      c.check(
        s.degraded === true,
        "#91b: degraded STAYS set — our reply demonstrably did not take effect, so we cannot claim to be fine",
      );
      const lines = readApprovals(dir);
      c.check(
        lines.some((l) => l.kind === "relist-unsettled" && l.permission_id === "per_alreadyrejected"),
        `#91b: and the unresolved decision is RECORDED, not hidden (${JSON.stringify(lines.map((l) => l.kind))})`,
      );
      bridge.close();
      closeAllBuses();
      await fake.close();
    }

    // (c) ANOTHER SESSION'S REQUEST IS NOT TOUCHED. `GET /permission` is global to the serve
    //     child, so on a panel this filter is the only thing stopping one member's bridge
    //     answering another member's request.
    {
      const fake = await startFakeOpencode({ historyText: "unused", sessionId: "ses_91c" });
      const prompts: string[] = [];
      const { bridge, posted } = await relistBridge(fake, "ses_91c", { prompts });
      fake.addPendingPermission({ id: "per_mine", sessionID: "ses_91c", metadata: { command: "mine" } });
      fake.addPendingPermission({ id: "per_theirs", sessionID: "ses_other", metadata: { command: "theirs" } });
      bridge.degrade("event stream dropped: socket hang up");
      await bridge.reattached();
      await waitFor(() => bridge.summary().approved === 1, 3_000, 25);
      const s = bridge.summary();
      c.check(s.recovered === 1 && s.requests === 1, `#91c: only OUR session's request is recovered (${JSON.stringify(s)})`);
      c.check(
        prompts.length === 1 && prompts[0].includes("mine") && !prompts[0].includes("theirs"),
        `#91c: and only ours is put to the developer (${JSON.stringify(prompts)})`,
      );
      c.check(
        !posted.some((u) => u.includes("per_theirs")),
        `#91c: no reply is ever sent for another session's request (${JSON.stringify(posted)})`,
      );
      c.check(
        fake.pendingPermissions().includes("per_theirs"),
        "#91c: it is left open for the bridge that owns it",
      );
      // The client's own accounting of the endpoint being global, asserted directly.
      const listed = await listPendingPermissions({ baseUrl: fake.baseUrl, sessionId: "ses_91c" });
      c.check(
        listed.otherSessions === 1 && listed.pending.every((p) => p.sessionID === "ses_91c"),
        `#91c: listPendingPermissions filters and COUNTS the rest (${JSON.stringify(listed)})`,
      );
      bridge.close();
      closeAllBuses();
      await fake.close();
    }

    // (d) A CLEAN RE-LIST CLEARS `degraded`; nothing else does. The flag was latched for the
    //     life of the call before #91, so every run that survived a blip lied at the end.
    {
      const fake = await startFakeOpencode({ historyText: "unused", sessionId: "ses_91d" });
      const { bridge } = await relistBridge(fake, "ses_91d");
      bridge.degrade("event stream dropped: socket hang up");
      c.check(bridge.summary().degraded === true, "#91d: degraded while the stream is down");
      await bridge.reattached();
      const s = bridge.summary();
      c.check(s.degraded === false, `#91d: a clean re-list clears it (${JSON.stringify(s)})`);
      c.check(
        s.blindWindows === 1 && s.degradedReason !== null,
        `#91d: but the window and its reason are LATCHED — recovered is not the same as never happened (${JSON.stringify(s)})`,
      );
      bridge.close();
      closeAllBuses();
      await fake.close();
    }

    // (e) A FAILED RE-LIST DEGRADES; IT NEVER THROWS INTO THE CALL. Both failure shapes: a
    //     500, and a 200 whose body is not the array the contract promises.
    for (const [label, fakeOpts] of [
      ["a 500", { failListPermissions: true }],
      ["a non-array body", { listPermissionsGarbage: true }],
    ] as const) {
      const dir = tmp("apr-91e-");
      const file = path.join(dir, APPROVALS_FILE);
      const fake = await startFakeOpencode({
        historyText: "unused",
        sessionId: "ses_91e",
        ...fakeOpts,
      });
      const { bridge } = await relistBridge(fake, "ses_91e", { file });
      bridge.degrade("event stream dropped: socket hang up");
      let threw = false;
      try {
        await bridge.reattached();
      } catch {
        threw = true;
      }
      const s = bridge.summary();
      c.check(!threw, `#91e (${label}): the re-list does not throw — a stream failure is never a call failure`);
      c.check(
        s.degraded === true,
        `#91e (${label}): and the bridge stays degraded, because it still cannot say it can see`,
      );
      const lines = readApprovals(dir);
      c.check(
        lines.some((l) => l.kind === "relist-failed"),
        `#91e (${label}): the failure is recorded (${JSON.stringify(lines.map((l) => l.kind))})`,
      );
      bridge.close();
      closeAllBuses();
      await fake.close();
    }

    // (f) END TO END: the fake raises its gated request while NOBODY is attached, and blocks
    //     the turn on it. The only route to that request is the re-list, so a completed turn
    //     with the tool approved is proof the recovery works against the full stack.
    {
      const root = tmp("apr-91f-");
      const logDir = tmp("apr-91flogs-");
      const repo = tmp("apr-91frepo-");
      const env = envWith({
        GUILD_ROOT: root,
        GUILD_LOG_DIR: logDir,
        GUILD_AGENT_DIR: defDirWith("guild-build"),
        GUILD_APPROVE: "all",
      });
      const prompts: string[] = [];
      const fake = await startFakeOpencode({
        historyText: "I built it",
        sessionId: "ses_91f",
        gateTool: "bash",
        gateMetadata: { command: "npm run build" },
        gateBlind: true,
        gateTimeoutMs: 20_000,
      });
      try {
        const r = await delegate(
          { task: "build it", model: "openai/allowed" },
          {
            serve: fakeServe(fake),
            env,
            messageTimeoutMs: 30_000,
            repoDir: repo,
            elicitation: stubElicitation("accept", prompts),
          },
        );
        c.check(r.ok, `#91f: the turn COMPLETED (${!r.ok ? r.error.message : ""})`);
        c.check(
          fake.gateOutcomes()[0] === "once",
          `#91f: the gated tool was raised while blind and still got its answer (${JSON.stringify(fake.gateOutcomes())})`,
        );
        c.check(
          prompts.length === 1 && prompts[0].includes("npm run build"),
          `#91f: the developer saw the real command (${JSON.stringify(prompts)})`,
        );
        if (r.ok) {
          c.check(
            r.approval?.recovered === 1 && r.approval?.approved === 1,
            `#91f: the result attributes it to the re-list (${JSON.stringify(r.approval)})`,
          );
          c.check(
            r.approval?.blindWindows === 1 && r.approval?.degraded === false,
            `#91f: recovered, and honest that a window happened (${JSON.stringify(r.approval)})`,
          );
          const lines = readApprovals(path.join(logDir, r.attribution.runId));
          c.check(
            lines.some((l) => l.kind === "relisted") && lines.some((l) => l.kind === "stream-recovered"),
            `#91f: approvals.jsonl records the recovery (${JSON.stringify(lines.map((l) => l.kind))})`,
          );
        }
      } finally {
        closeAllBuses();
        await fake.close();
      }
    }
  }

  // -------------------------------------------------------------------------
  // close() must reject anything still open — a bridge going away must never leave the
  // model waiting on a prompt whose listener has gone.
  // -------------------------------------------------------------------------
  {
    const closeFake = await startFakeOpencode({ historyText: "unused", sessionId: "ses_close" });
    const posted: Array<{ url: string; body: Record<string, unknown> }> = [];
    const bridge = new ApprovalBridge({
      settings: { tier: "all", egress: "off", timeoutMs: 60_000 },
      gatedTools: ["bash"],
      channels: ["watch"],
      context: { runId: "", callId: "c", model: "m", agent: "guild-build", command: "/guild:delegate" },
      armed: true,
      fetchImpl: (async (url: unknown, init: unknown) => {
        posted.push({
          url: String(url),
          body: JSON.parse(String((init as { body?: unknown }).body ?? "{}")) as Record<string, unknown>,
        });
        return { status: 200 } as Response;
      }) as unknown as typeof fetch,
    });
    await bridge.attach(closeFake.baseUrl, "ses_close");
    bridge.handleEvent({
      ts: Date.now(),
      sessionId: "ses_close",
      kind: "permission-asked",
      summary: "permission asked: bash",
      permissionId: "per_open",
      permissionTool: "bash",
      detail: { metadata: { command: "sleep 999" } },
    });
    bridge.close();
    await new Promise((r) => setTimeout(r, 80));
    c.check(posted.length === 1, "close: the open request was answered on the way out");
    c.check(posted[0].body.reply === "reject", "close: and answered with a REJECT (fail-closed)");
    c.check(
      String(posted[0].body.message ?? "").includes("closed"),
      "close: the model is told the bridge closed, not left guessing",
    );
    c.check(
      bridge.summary().decidedBy.closed === 1,
      `close: attributed to the close, not to a timeout (${JSON.stringify(bridge.summary().decidedBy)})`,
    );
    closeAllBuses();
    await closeFake.close();
  }

  // -------------------------------------------------------------------------
  // The `unroutable` record: a request with no id cannot be answered, and that must be
  // VISIBLE rather than silently dropped.
  // -------------------------------------------------------------------------
  {
    const dir = tmp("apr-unroutable-");
    const file = path.join(dir, APPROVALS_FILE);
    const bridge = new ApprovalBridge({
      settings: { tier: "all", egress: "off", timeoutMs: 1_000 },
      gatedTools: ["bash"],
      channels: ["watch"],
      context: { runId: "r", callId: "c", model: "m", agent: "guild-build", command: "/guild:delegate" },
      armed: true,
      file,
      fetchImpl: (async () => ({ status: 200 })) as unknown as typeof fetch,
    });
    bridge.handleEvent({
      ts: Date.now(),
      sessionId: "s",
      kind: "permission-asked",
      summary: "permission asked: bash",
      permissionTool: "bash",
    });
    const lines = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    c.check(
      lines.some((l) => l.kind === "unroutable"),
      "unroutable: a request with no permission id is RECORDED, not silently dropped",
    );
    c.check(
      bridge.summary().requests === 0,
      "unroutable: and it is not counted as an answerable request",
    );
    bridge.close();
  }

  // -------------------------------------------------------------------------
  // GUILD_APPROVE=off on the WRITE path pins NO `permission` key on the wire.
  // -------------------------------------------------------------------------
  {
    const root = tmp("apr-offwire-");
    const logDir = tmp("apr-offwirelogs-");
    const repo = tmp("apr-offwirerepo-");
    const env = envWith({
      GUILD_ROOT: root,
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDirWith("guild-build"),
    });
    const fake = await startFakeOpencode({ historyText: "ungated", sessionId: "ses_offwire" });
    try {
      const r = await delegate(
        { task: "t", model: "openai/allowed" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 5_000, repoDir: repo },
      );
      c.check(r.ok, "off-wire: the default (unarmed) delegate runs");
      const body = fake.recorded.createBodies[0];
      c.check(
        !Object.prototype.hasOwnProperty.call(body, "permission"),
        `off-wire: NO 'permission' key is sent at all when the knob is off (${JSON.stringify(Object.keys(body))})`,
      );
      c.check(r.ok && r.approval === undefined, "off-wire: and no approval record is attached");
    } finally {
      closeAllBuses();
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // `always` is NEVER sent by the bridge — it persists past the call, so only a human
  // explicitly choosing it may produce one.
  // -------------------------------------------------------------------------
  {
    const root = tmp("apr-always-");
    const logDir = tmp("apr-alwayslogs-");
    const repo = tmp("apr-alwaysrepo-");
    const env = envWith({
      GUILD_ROOT: root,
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDirWith("guild-build"),
      GUILD_APPROVE: "all",
      GUILD_APPROVE_TIMEOUT_MS: "400",
    });
    const fake = await startFakeOpencode({
      historyText: "x",
      sessionId: "ses_always",
      gateTool: "bash",
      gateTimeoutMs: 9_000,
    });
    try {
      await delegate(
        { task: "t", model: "openai/allowed" },
        {
          serve: fakeServe(fake),
          env,
          messageTimeoutMs: 15_000,
          repoDir: repo,
          elicitation: stubElicitation("accept"),
        },
      );
      const replies = fake.permissionReplies();
      c.check(replies.length > 0, "always: a reply was sent");
      c.check(
        replies.every((r) => r.response !== "always"),
        `always: the bridge NEVER sends 'always' (got ${JSON.stringify(replies.map((r) => r.response))})`,
      );
    } finally {
      closeAllBuses();
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // The SECOND backstop: if the approval deadline outlives the model-turn timeout, the turn
  // aborts on GUILD_MESSAGE_TIMEOUT_MS rather than hanging. Pinned so nobody assumes an
  // over-long GUILD_APPROVE_TIMEOUT_MS is bounded only by itself.
  // -------------------------------------------------------------------------
  {
    const root = tmp("apr-backstop-");
    const logDir = tmp("apr-backstoplogs-");
    const repo = tmp("apr-backstoprepo-");
    plantWatcher(logDir);
    const env = envWith({
      GUILD_ROOT: root,
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDirWith("guild-build"),
      GUILD_APPROVE: "all",
      GUILD_APPROVE_TIMEOUT_MS: "60000",
    });
    const fake = await startFakeOpencode({
      historyText: "never answered",
      sessionId: "ses_backstop",
      gateTool: "bash",
      gateTimeoutMs: 20_000,
    });
    try {
      const t0 = Date.now();
      const r = await delegate(
        { task: "t", model: "openai/allowed" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 900, repoDir: repo },
      );
      const elapsed = Date.now() - t0;
      c.check(!r.ok, "backstop: the call FAILS rather than hanging when nobody answers");
      c.check(
        elapsed < 15_000,
        `backstop: it aborted on GUILD_MESSAGE_TIMEOUT_MS, not on the 60s approval deadline (${elapsed}ms)`,
      );
      c.check(
        !r.ok && /timeout/i.test(r.error.message),
        `backstop: and the error says so (${!r.ok ? r.error.message.slice(0, 120) : ""})`,
      );
    } finally {
      closeAllBuses();
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // externallyAnswered, END TO END: a REAL `modelguild watch --approve` tailing the run
  // answers the serve directly while the bridge is armed. No stubbed fetch on either side.
  // -------------------------------------------------------------------------
  {
    const root = tmp("apr-ext-");
    const logDir = tmp("apr-extlogs-");
    const repo = tmp("apr-extrepo-");
    const env = envWith({
      GUILD_ROOT: root,
      GUILD_LOG_DIR: logDir,
      GUILD_AGENT_DIR: defDirWith("guild-build"),
      GUILD_APPROVE: "all",
      GUILD_APPROVE_TIMEOUT_MS: "9000",
    });
    const fake = await startFakeOpencode({
      historyText: "the watcher let me run it",
      sessionId: "ses_ext",
      gateTool: "bash",
      gateMetadata: { command: "npm test" },
      gateTimeoutMs: 20_000,
    });
    const printed: string[] = [];
    const realLog = console.log;
    const obs: Array<[boolean, string]> = [];
    console.log = (...a: unknown[]) => {
      printed.push(a.map(String).join(" "));
    };
    // The watcher runs for real: its own heartbeat is what makes the server willing to arm,
    // and its own fetch is what answers opencode.
    const watching = runWatch(["--approve"], {
      env,
      maxPolls: 400,
      pollMs: 20,
      prompt: async () => "y",
    });
    try {
      await waitFor(() => liveApprovalWatchers(logDir).length === 1, 3_000, 20);
      const r = await delegate(
        { task: "run the tests", model: "openai/allowed" },
        { serve: fakeServe(fake), env, messageTimeoutMs: 25_000, repoDir: repo },
      );
      obs.push([r.ok, `external: the gated call SUCCEEDED (${!r.ok ? r.error.message : ""})`]);
      obs.push([
        fake.gateOutcomes()[0] === "once",
        `external: the gated tool observed the WATCHER's approval (${JSON.stringify(fake.gateOutcomes())})`,
      ]);
      const replies = fake.permissionReplies();
      obs.push([
        replies.length === 1 && replies[0].via === "session" && replies[0].response === "once",
        `external: exactly one reply, from the watcher, on the session endpoint (${JSON.stringify(replies)})`,
      ]);
      if (r.ok) {
        obs.push([
          r.approval?.externallyAnswered === 1,
          `external: the bridge attributes it to an OUTSIDE answerer (${JSON.stringify(r.approval?.decidedBy)})`,
        ]);
        obs.push([
          r.approval?.approved === 1 && r.approval?.timedOut === 0,
          `external: counted as an approval, not a timeout (${JSON.stringify(r.approval)})`,
        ]);
      }
      obs.push([
        printed.some((l) => l.includes("npm test")),
        "external: the watcher showed the command it was approving",
      ]);
    } finally {
      await watching;
      console.log = realLog;
      closeAllBuses();
      await fake.close();
    }
    for (const [ok, msg] of obs) c.check(ok, msg);
  }

  // -------------------------------------------------------------------------
  // L9 — watcher liveness uses the recorded pid, and reaps corpses.
  // -------------------------------------------------------------------------
  {
    const logDir = tmp("apr-l9-");
    const dir = watcherDirFor(logDir);
    mkdirSync(dir, { recursive: true });
    const deadFile = path.join(dir, "dead.watcher");
    // A pid that cannot be running, with a FRESH mtime — so only the pid check can catch it.
    writeFileSync(deadFile, JSON.stringify({ pid: 2 ** 30, mode: "approve" }));
    c.check(
      liveApprovalWatchers(logDir).length === 0,
      "L9: a fresh presence file whose PROCESS is gone does not count as live",
    );
    c.check(!existsSync(deadFile), "L9: and the corpse is reaped, not left to age out");

    const junk = path.join(dir, "junk.watcher");
    writeFileSync(junk, "not json");
    c.check(liveApprovalWatchers(logDir).length === 0, "L9: an unreadable presence file is dead");
    c.check(!existsSync(junk), "L9: and is reaped too");

    const mine = plantWatcher(logDir); // this process's pid, which is alive
    c.check(liveApprovalWatchers(logDir).length === 1, "L9: a live process's file still counts");
    c.check(existsSync(mine), "L9: and a live watcher's file is never reaped");
  }

  // -------------------------------------------------------------------------
  // L12 — doctor/guild_status can answer "am I gated?" without a model call.
  // -------------------------------------------------------------------------
  {
    const logDir = tmp("apr-l12-");
    const off = approvalDoctorInfo({ env: envWith({}), confContents: "", logDir });
    c.check(off.requested === false && off.tier === "off", "L12: doctor reports the default OFF");
    c.check(off.error === null, "L12: with no error");
    plantWatcher(logDir);
    const on = approvalDoctorInfo({
      env: envWith({ GUILD_APPROVE: "all", GUILD_APPROVE_EGRESS: "ask" }),
      confContents: "",
      logDir,
    });
    c.check(
      on.requested === true && on.tier === "all" && on.egress === "ask",
      `L12: and reports the armed state (${JSON.stringify(on)})`,
    );
    c.check(on.watchers === 1, "L12: including whether anything can actually answer");
    c.check(on.watcherDir === watcherDirFor(logDir), "L12: and where it looked");
    const bad = approvalDoctorInfo({
      env: envWith({ GUILD_APPROVE: "yes-please" }),
      confContents: "",
      logDir,
    });
    c.check(
      bad.error !== null && bad.tier === null,
      "L12: an invalid knob is reported as an error, not as 'off'",
    );
  }

  closeAllBuses();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  console.log(`approve.test: ${c.passes} passed, ${c.failures} failed`);
  return c.failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((f) => process.exit(f > 0 ? 1 : 0));
}
