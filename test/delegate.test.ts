/**
 * guild_delegate tests (CONTRACT.md C1–C7, C12, C16-deviation, C22–C25,
 * C36–C40, C42/C52, C57) — OFFLINE.
 *
 * The fake `opencode` server can't edit files, so the WRITE path is driven with REAL git
 * state: a `ServeProvider` wrapper runs a SCRIPTED MUTATION on a disposable git repo as the
 * "model turn" (created/modified/deleted files), and the snapshot/diff machinery
 * (src/snapshot.ts) is exercised against that real state. The mutation runs BEFORE the fake
 * HTTP turn resolves, so a FAILED call (fake 500 / agent mismatch) still leaves the model's
 * changes on disk — proving the "capture even a partially-failed call" contract.
 *
 * Coverage:
 *   - C37 scar: created files appear in the patch (a plain `git diff <sha>` would miss them)
 *   - modified + created + deleted mix; filesChanged count
 *   - C36/C37: dirty pre-state → the patch is the MODEL's changes ONLY
 *   - .gitignore'd files excluded from the patch (pre-existing, unchanged ⇒ complete)
 *   - recovery hint: `git checkout <preTree> -- <path>` actually restores the pre-state
 *   - C40: unrepresentable state (ignored file changed) → captureComplete:false + the entry
 *     says so + the run FAILS integrity under verify
 *   - the delegate-diff entry passes verify; a corrupted patch fails it (C39 neg)
 *   - NO-FALLBACK def gate, gate deny/ask, agent-mismatch, partially-failed-call capture
 *
 * The TS verifier is the reference (the bash `log.sh verify` + `ask.sh --edit`
 * parity fixture these were cross-checked against retired at M12).
 */

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  appendFileSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { delegate, delegateToToolResult, type DelegateResult } from "../src/delegate.js";
import { EvidenceLog } from "../src/log.js";
import { startFakeOpencode, type FakeOpencode } from "./fake-opencode-server.js";
import type { ServeProvider } from "../src/client.js";
import type { ServeHandle } from "../src/lifecycle.js";
import { Checker } from "./harness.js";

const tmpDirs: string[] = [];
function tmp(prefix = "m8-"): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function git(dir: string, args: string[]): { status: number; stdout: string } {
  const r = spawnSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "" };
}

/** A disposable git repo seeded with `files` and committed. Returns the repo dir. */
function initRepo(files: Record<string, string>, prefix = "m8-repo-"): string {
  const dir = tmp(prefix);
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function read(dir: string, rel: string): string {
  return readFileSync(path.join(dir, rel), "utf8");
}

/** A ServeProvider whose "model turn" applies `mutate` to the repo, THEN runs the fake HTTP
 * turn — so even a failing turn leaves the mutation on disk (partial-capture contract). */
function mutatingServe(fake: FakeOpencode, mutate: () => void): ServeProvider {
  const handle: ServeHandle = { baseUrl: fake.baseUrl, port: 0, pid: 0 };
  return {
    withServe: async (fn) => {
      mutate();
      return fn(handle);
    },
  };
}

/** A plain (non-mutating) ServeProvider for gate/refusal cases. */
function fakeServe(fake: FakeOpencode): ServeProvider {
  const handle: ServeHandle = { baseUrl: fake.baseUrl, port: 0, pid: 0 };
  return { withServe: (fn) => fn(handle) };
}

/** An agent-def dir CONTAINING a guild-build.md so the presence gate passes. */
function defDirWithBuild(): string {
  const dir = tmp("m8-agent-");
  writeFileSync(path.join(dir, "guild-build.md"), "---\nmode: all\n---\nfake\n");
  return dir;
}

function envWith(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith("GUILD_")) delete base[k];
  return { ...base, ...overrides };
}

export async function run(): Promise<number> {
  const c = new Checker();
  console.log("== delegate.test (M8 guild_delegate) ==");

  // -------------------------------------------------------------------------
  // 1. C37 SCAR: a delegation that only CREATES a file produces a NON-empty patch
  //    containing that file (a plain `git diff <sha>` would show nothing).
  // -------------------------------------------------------------------------
  {
    const repo = initRepo({ "a.txt": "A\n" });
    const logDir = tmp("m8-logs-");
    const env = envWith({ GUILD_ROOT: tmp("m8-guild-"), GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithBuild() });
    const fake = await startFakeOpencode({ historyText: "created new.txt" });
    try {
      const r = await delegate(
        { task: "create new.txt", model: "openai/m" },
        { serve: mutatingServe(fake, () => writeFileSync(path.join(repo, "new.txt"), "NEWCONTENT\n")), env, repoDir: repo, messageTimeoutMs: 5_000 },
      );
      c.check(r.ok, "scar: delegate ok");
      if (r.ok) {
        c.check(r.capture.patchPath !== null, "scar: a patch WAS recorded for a create-only delegation");
        c.check(r.capture.captureComplete === true, "scar: capture complete");
        c.check(r.capture.filesChanged === 1, "scar: filesChanged === 1");
        const patch = readFileSync(r.capture.patchPath as string, "utf8");
        c.check(/^diff --git a\/new\.txt b\/new\.txt$/m.test(patch), "scar: patch names the CREATED file");
        c.check(patch.includes("+NEWCONTENT"), "scar: patch carries the created content");
        c.check(r.report === "created new.txt", "scar: report is the model's text (DATA to review)");
        c.check(new EvidenceLog({ env }).verify(r.attribution.runId).code === 0, "scar: TS verify() passes");
      }
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 2. modified + created + deleted MIX; filesChanged counts all three.
  // -------------------------------------------------------------------------
  {
    const repo = initRepo({ "a.txt": "A0\n", "b.txt": "B0\n" });
    const logDir = tmp("m8-logs-");
    const env = envWith({ GUILD_ROOT: tmp("m8-guild-"), GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithBuild() });
    const fake = await startFakeOpencode({ historyText: "mixed edits" });
    try {
      const r = await delegate(
        { task: "edit", model: "openai/m" },
        {
          serve: mutatingServe(fake, () => {
            writeFileSync(path.join(repo, "a.txt"), "A1\n"); // modify
            writeFileSync(path.join(repo, "c.txt"), "C0\n"); // create
            rmSync(path.join(repo, "b.txt")); // delete
          }),
          env,
          repoDir: repo,
          messageTimeoutMs: 5_000,
        },
      );
      c.check(r.ok && r.capture.filesChanged === 3, "mix: filesChanged === 3 (modify+create+delete)");
      if (r.ok && r.capture.patchPath) {
        const p = readFileSync(r.capture.patchPath, "utf8");
        c.check(/diff --git a\/a\.txt b\/a\.txt/.test(p) && p.includes("+A1"), "mix: modified file present");
        c.check(/diff --git a\/c\.txt b\/c\.txt/.test(p) && p.includes("+C0"), "mix: created file present");
        c.check(/diff --git a\/b\.txt b\/b\.txt/.test(p) && p.includes("-B0"), "mix: deleted file present");
      }
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 3. C36/C37: a DIRTY pre-state → the patch is the MODEL's changes ONLY (the caller's
  //    uncommitted work is in BOTH snapshots, so it diffs out).
  // -------------------------------------------------------------------------
  {
    const repo = initRepo({ "x.txt": "X0\n", "y.txt": "Y0\n" });
    // The caller's own uncommitted edit BEFORE delegating (live work in progress).
    writeFileSync(path.join(repo, "x.txt"), "XDIRTY\n");
    const logDir = tmp("m8-logs-");
    const env = envWith({ GUILD_ROOT: tmp("m8-guild-"), GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithBuild() });
    const fake = await startFakeOpencode({ historyText: "edited y" });
    try {
      const r = await delegate(
        { task: "edit y", model: "openai/m" },
        { serve: mutatingServe(fake, () => writeFileSync(path.join(repo, "y.txt"), "YMODEL\n")), env, repoDir: repo, messageTimeoutMs: 5_000 },
      );
      c.check(r.ok, "dirty: delegate ok");
      if (r.ok && r.capture.patchPath) {
        const p = readFileSync(r.capture.patchPath, "utf8");
        c.check(p.includes("+YMODEL") && /diff --git a\/y\.txt/.test(p), "dirty: MODEL's y.txt change is in the patch");
        c.check(!p.includes("XDIRTY") && !/diff --git a\/x\.txt/.test(p), "dirty: caller's x.txt change is NOT in the patch (attribution)");
        c.check(r.capture.filesChanged === 1, "dirty: exactly the one model-changed file");
        c.check(r.capture.recoveryHint !== null && r.capture.recoveryHint.includes(r.capture.preTree as string), "dirty: recovery hint surfaced with the pre-tree");
      }
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 4. .gitignore'd files EXCLUDED from the patch (pre-existing + unchanged ⇒ complete).
  // -------------------------------------------------------------------------
  {
    const repo = initRepo({ ".gitignore": "*.log\n", "a.txt": "A0\n" });
    // A pre-existing ignored file, present BEFORE the turn and left unchanged by the model.
    writeFileSync(path.join(repo, "ig.log"), "IG0\n");
    const logDir = tmp("m8-logs-");
    const env = envWith({ GUILD_ROOT: tmp("m8-guild-"), GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithBuild() });
    const fake = await startFakeOpencode({ historyText: "edited a" });
    try {
      const r = await delegate(
        { task: "edit a", model: "openai/m" },
        { serve: mutatingServe(fake, () => writeFileSync(path.join(repo, "a.txt"), "A1\n")), env, repoDir: repo, messageTimeoutMs: 5_000 },
      );
      c.check(r.ok && r.capture.captureComplete === true, "ignore: capture complete (ignored file unchanged)");
      if (r.ok && r.capture.patchPath) {
        const p = readFileSync(r.capture.patchPath, "utf8");
        c.check(!p.includes("ig.log") && !p.includes("IG0"), "ignore: ignored file excluded from the patch");
        c.check(/diff --git a\/a\.txt/.test(p), "ignore: tracked change present");
      }
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 5. RECOVERY HINT works: `git checkout <preTree> -- <path>` restores the pre-state.
  // -------------------------------------------------------------------------
  {
    const repo = initRepo({ "r.txt": "R0\n" });
    writeFileSync(path.join(repo, "r.txt"), "R_DIRTY\n"); // caller's uncommitted state
    const logDir = tmp("m8-logs-");
    const env = envWith({ GUILD_ROOT: tmp("m8-guild-"), GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithBuild() });
    const fake = await startFakeOpencode({ historyText: "clobbered r" });
    try {
      const r = await delegate(
        { task: "edit r", model: "openai/m" },
        { serve: mutatingServe(fake, () => writeFileSync(path.join(repo, "r.txt"), "R_MODEL\n")), env, repoDir: repo, messageTimeoutMs: 5_000 },
      );
      c.check(r.ok, "recovery: delegate ok");
      if (r.ok && r.capture.preTree) {
        c.check(read(repo, "r.txt") === "R_MODEL\n", "recovery: model's change is on disk");
        // Actually run the surfaced recovery command against the recorded pre-tree.
        const co = git(repo, ["checkout", r.capture.preTree, "--", "r.txt"]);
        c.check(co.status === 0, "recovery: git checkout <preTree> -- r.txt succeeds");
        c.check(read(repo, "r.txt") === "R_DIRTY\n", "recovery: the caller's pre-state is restored");
      }
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 6. C40: UNREPRESENTABLE state (model changed an ignored file) → captureComplete:false,
  //    the delegate-diff entry SAYS so, and the run FAILS integrity under verify.
  // -------------------------------------------------------------------------
  {
    const repo = initRepo({ ".gitignore": "*.log\n", "a.txt": "A0\n" });
    writeFileSync(path.join(repo, "ig.log"), "IG0\n"); // present before
    const logDir = tmp("m8-logs-");
    const env = envWith({ GUILD_ROOT: tmp("m8-guild-"), GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithBuild() });
    const fake = await startFakeOpencode({ historyText: "touched ignored" });
    try {
      const r = await delegate(
        { task: "edit", model: "openai/m" },
        {
          serve: mutatingServe(fake, () => {
            writeFileSync(path.join(repo, "a.txt"), "A1\n"); // tracked change (reviewable subset)
            writeFileSync(path.join(repo, "ig.log"), "IG1\n"); // ignored change ⇒ unrepresentable
          }),
          env,
          repoDir: repo,
          messageTimeoutMs: 5_000,
        },
      );
      c.check(r.ok, "incomplete: delegate returns ok (the CALL succeeded)");
      if (r.ok) {
        c.check(r.capture.captureComplete === false, "incomplete: captureComplete is false");
        c.check(r.capture.incompleteReason === "ignored-paths-changed", "incomplete: reason names ignored-paths-changed");
        c.check(r.capture.patchPath !== null, "incomplete: the reviewable-subset patch is still written");
        // The delegate-diff entry with capture_complete:false makes the run FAIL integrity.
        c.check(new EvidenceLog({ env }).verify(r.attribution.runId).code === 7, "incomplete: TS verify() reports integrity failure (7)");
      }
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 7. C39 NEGATIVE: a CORRUPTED patch file fails verify (the diff was altered).
  // -------------------------------------------------------------------------
  {
    const repo = initRepo({ "a.txt": "A0\n" });
    const logDir = tmp("m8-logs-");
    const env = envWith({ GUILD_ROOT: tmp("m8-guild-"), GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithBuild() });
    const fake = await startFakeOpencode({ historyText: "edit" });
    try {
      const r = await delegate(
        { task: "edit", model: "openai/m" },
        { serve: mutatingServe(fake, () => writeFileSync(path.join(repo, "a.txt"), "A1\n")), env, repoDir: repo, messageTimeoutMs: 5_000 },
      );
      c.check(r.ok && r.capture.patchPath !== null, "corrupt: baseline delegation captured a patch");
      if (r.ok && r.capture.patchPath) {
        const runId = r.attribution.runId;
        c.check(new EvidenceLog({ env }).verify(runId).code === 0, "corrupt: run is clean BEFORE corruption");
        appendFileSync(r.capture.patchPath, "TAMPERED\n"); // alter the recorded diff
        c.check(new EvidenceLog({ env }).verify(runId).code === 7, "corrupt: TS verify() fails after tampering (7)");
      }
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 9. NO-FALLBACK def gate: a MISSING guild-build.md refuses (exit-5), NOTHING logged, NO
  //    model call, NO snapshot — the deliberate deviation from bash C16 (write-path critical:
  //    the bash fallback would be the UNRESTRICTED `build`).
  // -------------------------------------------------------------------------
  {
    const repo = initRepo({ "a.txt": "A\n" });
    const logDir = tmp("m8-logs-");
    const emptyDefDir = tmp("m8-emptyagent-");
    // HERMETICITY: resolveAgentDefDirs also looks in the GLOBAL opencode dir
    // (`${XDG_CONFIG_HOME:-~/.config}/opencode/agent/`). On a box with a global install (e.g.
    // this dev container) that dir HAS guild-build.md, so the def would resolve globally and the
    // tool would NOT refuse — the def-missing path would never run. Point XDG_CONFIG_HOME at an
    // empty temp dir: non-empty, so it wins over the ~/.config fallback, making the global dir
    // resolve to an empty location. Now BOTH dirs are genuinely def-free (issue #24).
    const emptyXdg = tmp("m8-emptyxdg-"); // <emptyXdg>/opencode/agent does not exist
    const env = envWith({ GUILD_ROOT: tmp("m8-guild-"), GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: emptyDefDir, XDG_CONFIG_HOME: emptyXdg });
    const fake = await startFakeOpencode({ historyText: "unreached" });
    try {
      let mutated = false;
      const r = await delegate(
        { task: "edit", model: "openai/m" },
        { serve: mutatingServe(fake, () => { mutated = true; }), env, repoDir: repo, messageTimeoutMs: 5_000 },
      );
      c.check(!r.ok, "def-missing: delegate refuses");
      if (!r.ok) {
        c.check(r.error.kind === "agent-def-missing", "def-missing: kind is agent-def-missing");
        c.check(r.error.exitAnalogue === 5, "def-missing: exit analogue is 5 (C57)");
        c.check(/no.*fallback/i.test(r.error.message), "def-missing: message states there is no fallback");
        c.check(/build/i.test(r.error.message), "def-missing: message names the unrestricted build fallback it refuses");
      }
      c.check(!mutated, "def-missing: the model turn never ran (no snapshot, no edit)");
      c.check(fake.recorded.messageBodies.length === 0, "def-missing: no model call");
      c.check(readdirSync(logDir).length === 0, "def-missing: NOTHING logged (gap parity)");
      c.check(delegateToToolResult(r).isError === true, "def-missing: MCP result flags isError");
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 10. gate parity — DENY (exit-3) and ASK (exit-4 → confirmed proceeds).
  // -------------------------------------------------------------------------
  {
    const root = tmp("m8-guild-");
    writeFileSync(path.join(root, "models.policy.local"), "deny openai/denied\nask openai/ask-me\n");
    const repo = initRepo({ "a.txt": "A\n" });
    const logDir = tmp("m8-logs-");
    const env = envWith({ GUILD_ROOT: root, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithBuild() });
    const fake = await startFakeOpencode({ historyText: "edited" });
    try {
      const den = await delegate(
        { task: "edit", model: "openai/denied" },
        { serve: mutatingServe(fake, () => writeFileSync(path.join(repo, "a.txt"), "NOPE\n")), env, repoDir: repo, messageTimeoutMs: 5_000 },
      );
      c.check(!den.ok && den.error.kind === "policy-deny" && den.error.exitAnalogue === 3, "deny: policy-deny exit-3");
      c.check(read(repo, "a.txt") === "A\n", "deny: no edit happened (model never ran)");
      c.check(readdirSync(logDir).length === 0, "deny: nothing logged");

      const unc = await delegate(
        { task: "edit", model: "openai/ask-me" },
        { serve: fakeServe(fake), env, repoDir: repo, messageTimeoutMs: 5_000 },
      );
      c.check(!unc.ok && unc.error.kind === "policy-ask" && unc.error.exitAnalogue === 4, "ask: unconfirmed policy-ask exit-4");
      c.check(readdirSync(logDir).length === 0, "ask: unconfirmed logged nothing");

      const ok = await delegate(
        { task: "edit", model: "openai/ask-me", confirmed: true },
        { serve: mutatingServe(fake, () => writeFileSync(path.join(repo, "a.txt"), "A1\n")), env, repoDir: repo, messageTimeoutMs: 5_000 },
      );
      c.check(ok.ok, "ask: confirmed:true proceeds");
      c.check(fake.recorded.messageBodies.length === 1, "ask: exactly one model call across the three (only the confirmed one)");
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 11. AGENT-MISMATCH + PARTIALLY-FAILED CALL both still CAPTURE the model's changes.
  // -------------------------------------------------------------------------
  {
    // (a) agent-mismatch: opencode serves a different agent than guild-build → fail closed,
    //     but the mutation already happened → capture is surfaced.
    const repoA = initRepo({ "a.txt": "A0\n" });
    const logA = tmp("m8-logs-");
    const envA = envWith({ GUILD_ROOT: tmp("m8-guild-"), GUILD_LOG_DIR: logA, GUILD_AGENT_DIR: defDirWithBuild() });
    const fakeA = await startFakeOpencode({ historyText: "x", servedAgent: "build" });
    try {
      const r = await delegate(
        { task: "edit", model: "openai/m" },
        { serve: mutatingServe(fakeA, () => writeFileSync(path.join(repoA, "a.txt"), "A1\n")), env: envA, repoDir: repoA, messageTimeoutMs: 5_000 },
      );
      c.check(!r.ok && r.error.kind === "agent-mismatch", "mismatch: fails closed as agent-mismatch");
      c.check(!r.ok && r.capture !== undefined && r.capture.patchPath !== null, "mismatch: the partial capture is still surfaced");
      if (!r.ok && r.capture?.patchPath) {
        c.check(readFileSync(r.capture.patchPath, "utf8").includes("+A1"), "mismatch: the model's change is in the captured patch");
      }
    } finally {
      await fakeA.close();
    }

    // (b) call-failed (fake 500) after the mutation → capture surfaced, delegate-diff logged.
    const repoB = initRepo({ "a.txt": "A0\n" });
    const logB = tmp("m8-logs-");
    const envB = envWith({ GUILD_ROOT: tmp("m8-guild-"), GUILD_LOG_DIR: logB, GUILD_AGENT_DIR: defDirWithBuild() });
    const fakeB = await startFakeOpencode({ historyText: "x", failMessage: true });
    try {
      const r = await delegate(
        { task: "edit", model: "openai/m" },
        { serve: mutatingServe(fakeB, () => writeFileSync(path.join(repoB, "created.txt"), "MADE\n")), env: envB, repoDir: repoB, messageTimeoutMs: 5_000 },
      );
      c.check(!r.ok && r.error.kind === "call-failed", "call-failed: fails as call-failed");
      c.check(!r.ok && r.capture?.patchPath !== null && r.capture?.patchPath !== undefined, "call-failed: partial capture surfaced");
      if (!r.ok && r.capture?.patchPath) {
        c.check(/diff --git a\/created\.txt/.test(readFileSync(r.capture.patchPath, "utf8")), "call-failed: the file the model created before failing is captured");
        // The delegate-diff entry was logged even though the CALL failed (the run dir is the
        // patch's parent). The run also carries completed(capture_state:failed), so verify
        // correctly reports a gap — a failed call is surfaced, never a false clean.
        const runDir = path.dirname(r.capture.patchPath);
        const jsonl = readFileSync(path.join(runDir, "calls.jsonl"), "utf8");
        c.check(jsonl.includes('"delegate-diff"'), "call-failed: a delegate-diff entry was logged despite the failed call");
        const runId = path.basename(runDir);
        c.check(new EvidenceLog({ env: envB }).verify(runId).code === 7, "call-failed: verify reports the failed-call gap (7), never a false clean");
      }
    } finally {
      await fakeB.close();
    }
  }

  // -------------------------------------------------------------------------
  // 12. C40 "nothing to review": the model changed NO tracked files AND state is fully
  //     representable → no patch, no delegate-diff entry, but the run still verifies (just
  //     the lifecycle triple). A no-op mutation models a delegate that decided to change
  //     nothing.
  // -------------------------------------------------------------------------
  {
    const repo = initRepo({ "a.txt": "A\n" });
    const logDir = tmp("m8-logs-");
    const env = envWith({ GUILD_ROOT: tmp("m8-guild-"), GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithBuild() });
    const fake = await startFakeOpencode({ historyText: "nothing to change" });
    try {
      const r = await delegate(
        { task: "no-op", model: "openai/m" },
        { serve: mutatingServe(fake, () => {}), env, repoDir: repo, messageTimeoutMs: 5_000 },
      );
      c.check(r.ok, "nothing-to-review: delegate ok");
      if (r.ok) {
        c.check(r.capture.patchPath === null, "nothing-to-review: no patch recorded");
        c.check(r.capture.filesChanged === 0, "nothing-to-review: filesChanged === 0");
        c.check(r.capture.captureComplete === true, "nothing-to-review: capture complete");
        const jsonl = readFileSync(path.join(logDir, r.attribution.runId, "calls.jsonl"), "utf8");
        c.check(!jsonl.includes('"delegate-diff"'), "nothing-to-review: NO delegate-diff entry logged");
        c.check(new EvidenceLog({ env }).verify(r.attribution.runId).code === 0, "nothing-to-review: run still verifies (lifecycle triple only)");
      }
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 13. NARROW serve-scaffold exclusion (coordinator decision 2026-07-22): a change under
  //     `.opencode/agent/**` (a hardened DEF — security surface) MUST be captured, while a
  //     concurrent change to serve-runtime scaffolding (`.opencode/node_modules/**`) is
  //     EXCLUDED (so it does not trip capture-incomplete). Proves the exclusion is narrow,
  //     not "exclude all of .opencode/".
  // -------------------------------------------------------------------------
  {
    const repo = initRepo({
      ".gitignore": ".opencode/node_modules/\n",
      ".opencode/agent/somedef.md": "def-v1\n", // tracked hardened def
      ".opencode/node_modules/dep.js": "old\n", // ignored serve scaffolding (present before)
    });
    const logDir = tmp("m8-logs-");
    const env = envWith({ GUILD_ROOT: tmp("m8-guild-"), GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithBuild() });
    const fake = await startFakeOpencode({ historyText: "tampered a def + touched scaffolding" });
    try {
      const r = await delegate(
        { task: "edit", model: "openai/m" },
        {
          serve: mutatingServe(fake, () => {
            writeFileSync(path.join(repo, ".opencode", "agent", "somedef.md"), "def-TAMPERED\n"); // DEF tamper
            writeFileSync(path.join(repo, ".opencode", "node_modules", "dep.js"), "new\n"); // scaffolding change
          }),
          env,
          repoDir: repo,
          messageTimeoutMs: 5_000,
        },
      );
      c.check(r.ok, "narrow: delegate ok");
      if (r.ok && r.capture.patchPath) {
        const p = readFileSync(r.capture.patchPath, "utf8");
        // The DEF change is captured — never silently excluded.
        c.check(/diff --git a\/\.opencode\/agent\/somedef\.md/.test(p), "narrow: the .opencode/agent def change IS in the patch (not excluded)");
        c.check(p.includes("+def-TAMPERED") && p.includes("-def-v1"), "narrow: the def tamper content is captured");
        c.check(r.capture.filesChanged === 1, "narrow: exactly the def changed (scaffolding not counted)");
        // The scaffolding change is excluded — never in the patch...
        c.check(!p.includes("node_modules"), "narrow: the .opencode/node_modules scaffolding change is NOT in the patch");
        // ...and does NOT trip capture-incomplete (the whole point of the exclusion).
        c.check(r.capture.captureComplete === true, "narrow: capture stays COMPLETE despite the concurrent scaffolding change");
        c.check(new EvidenceLog({ env }).verify(r.attribution.runId).code === 0, "narrow: TS verify passes (complete)");
      }
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 14. TAMPER SIGNAL (maintainer-ratified condition, 2026-07-22): a change to the excluded,
  //     execution-carrying serve scaffolding (`.opencode/node_modules/**`) during the turn is
  //     surfaced as scaffoldChanged:true + a warning + an optional delegate-diff field, WITHOUT
  //     changing captureComplete — and both verifiers still accept the entry (field present).
  //     A quiet turn → scaffoldChanged:false. Pins the both-verifier-tolerance both ways.
  // -------------------------------------------------------------------------
  {
    const seed = () =>
      initRepo({
        ".gitignore": ".opencode/node_modules/\n",
        "a.txt": "A0\n",
        ".opencode/node_modules/dep.js": "v1\n", // ignored, execution-carrying scaffolding
      });

    // (a) scaffolding CHANGED during the turn.
    {
      const repo = seed();
      const logDir = tmp("m8-logs-");
      const env = envWith({ GUILD_ROOT: tmp("m8-guild-"), GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithBuild() });
      const fake = await startFakeOpencode({ historyText: "touched a plugin" });
      try {
        const r = await delegate(
          { task: "edit", model: "openai/m" },
          {
            serve: mutatingServe(fake, () => {
              writeFileSync(path.join(repo, "a.txt"), "A1\n"); // tracked change
              writeFileSync(path.join(repo, ".opencode", "node_modules", "dep.js"), "brand-new-bigger\n"); // scaffolding write (size-changing ⇒ deterministic)
            }),
            env,
            repoDir: repo,
            messageTimeoutMs: 5_000,
          },
        );
        c.check(r.ok, "scaffold-changed: delegate ok");
        if (r.ok) {
          c.check(r.capture.captureComplete === true, "scaffold-changed: captureComplete UNCHANGED (still true)");
          c.check(r.capture.scaffoldChanged === true, "scaffold-changed: scaffoldChanged is true");
          c.check(
            r.capture.scaffoldWarning !== null && /plugin directory/.test(r.capture.scaffoldWarning) && /opencode serve/.test(r.capture.scaffoldWarning),
            "scaffold-changed: a one-line warning names the plugin dir + opencode serve",
          );
          const patch = readFileSync(r.capture.patchPath as string, "utf8");
          c.check(!patch.includes("node_modules"), "scaffold-changed: scaffolding still excluded from the patch");
          c.check(r.capture.filesChanged === 1, "scaffold-changed: only the tracked file counted");
          const jsonl = readFileSync(path.join(logDir, r.attribution.runId, "calls.jsonl"), "utf8");
          c.check(/"scaffold_changed":true/.test(jsonl), "scaffold-changed: delegate-diff entry records scaffold_changed:true");
          c.check(new EvidenceLog({ env }).verify(r.attribution.runId).code === 0, "scaffold-changed: TS verify accepts the new field (green)");
        }
      } finally {
        await fake.close();
      }
    }

    // (b) scaffolding UNCHANGED (quiet turn).
    {
      const repo = seed();
      const logDir = tmp("m8-logs-");
      const env = envWith({ GUILD_ROOT: tmp("m8-guild-"), GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: defDirWithBuild() });
      const fake = await startFakeOpencode({ historyText: "left plugins alone" });
      try {
        const r = await delegate(
          { task: "edit", model: "openai/m" },
          { serve: mutatingServe(fake, () => writeFileSync(path.join(repo, "a.txt"), "A1\n")), env, repoDir: repo, messageTimeoutMs: 5_000 },
        );
        c.check(r.ok, "scaffold-quiet: delegate ok");
        if (r.ok) {
          c.check(r.capture.scaffoldChanged === false, "scaffold-quiet: scaffoldChanged is false");
          c.check(r.capture.scaffoldWarning === null, "scaffold-quiet: no warning");
          const jsonl = readFileSync(path.join(logDir, r.attribution.runId, "calls.jsonl"), "utf8");
          c.check(/"scaffold_changed":false/.test(jsonl), "scaffold-quiet: delegate-diff entry records scaffold_changed:false");
          c.check(new EvidenceLog({ env }).verify(r.attribution.runId).code === 0, "scaffold-quiet: TS verify green");
        }
      } finally {
        await fake.close();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Issue #73, review findings F1/F2 — GUILD_LOG=off on the WRITE path (the suite only
  // ever set GUILD_LOG_DIR before, so neither bug had a test that could see it).
  //
  // With the evidence layer off, `runId` is `""` — which is FALSY, so `#resolveRun` fell
  // through to `$GUILD_RUN_ID`:
  //   F1 — a hostile `$GUILD_RUN_ID` then threw out of `log.dir()`, which sits outside
  //        every `try` in `captureAndLog`, so the exception escaped `delegate()` AFTER the
  //        model had already edited files, taking the report and the recovery hint with
  //        it. Exactly the failure C31 forbids.
  //   F2 — and with `$GUILD_RUN_ID` merely absent it minted a FRESH run id anyway, so the
  //        mkdir created a run dir and a patch was written into it with logging off —
  //        contradicting "GUILD_LOG=off mints no run dir".
  // -------------------------------------------------------------------------
  {
    // (a) hostile GUILD_RUN_ID + GUILD_LOG=off: the call still succeeds and still reports.
    const escapeDir = path.join(tmpdir(), `mg73-delegate-escape-${process.pid}`);
    const repo = initRepo({ "a.txt": "A\n" });
    const env = envWith({
      GUILD_ROOT: tmp("m8-guild-"),
      GUILD_LOG_DIR: tmp("m8-logs-off-"),
      GUILD_AGENT_DIR: defDirWithBuild(),
      GUILD_LOG: "off",
      GUILD_RUN_ID: `../../../../../../${path.basename(tmpdir())}/${path.basename(escapeDir)}`,
    });
    const fake = await startFakeOpencode({ historyText: "edited a.txt" });
    let threw = false;
    let r;
    try {
      r = await delegate(
        { task: "edit a.txt", model: "openai/m" },
        {
          serve: mutatingServe(fake, () => writeFileSync(path.join(repo, "a.txt"), "A1\n")),
          env,
          repoDir: repo,
          messageTimeoutMs: 5_000,
        },
      );
    } catch {
      threw = true;
    } finally {
      await fake.close();
    }
    c.check(!threw, "F1: GUILD_LOG=off + a hostile GUILD_RUN_ID does NOT throw out of delegate()");
    c.check(r !== undefined && r.ok, "F1: the call still succeeds — a log-path failure never discards the model's work");
    if (r !== undefined && r.ok) {
      c.check(r.report === "edited a.txt", "F1: the model's report still reaches the caller");
      c.check(r.capture.patchPath === null && r.capture.incompleteReason === "logging-off",
        "F1: the absent capture is REPORTED with its reason, not silently missing");
    }
    c.check(!existsSync(escapeDir), "F1: the write path writes nothing outside the logs root either");

    // (b) GUILD_LOG=off with NO ambient run id: the logs root stays EMPTY.
    const repo2 = initRepo({ "b.txt": "B\n" });
    const logDir2 = tmp("m8-logs-off2-");
    const env2 = envWith({
      GUILD_ROOT: tmp("m8-guild-"),
      GUILD_LOG_DIR: logDir2,
      GUILD_AGENT_DIR: defDirWithBuild(),
      GUILD_LOG: "off",
    });
    const fake2 = await startFakeOpencode({ historyText: "edited b.txt" });
    let r2;
    try {
      r2 = await delegate(
        { task: "edit b.txt", model: "openai/m" },
        {
          serve: mutatingServe(fake2, () => writeFileSync(path.join(repo2, "b.txt"), "B1\n")),
          env: env2,
          repoDir: repo2,
          messageTimeoutMs: 5_000,
        },
      );
    } finally {
      await fake2.close();
    }
    c.check(r2 !== undefined && r2.ok, "F2: a GUILD_LOG=off delegation succeeds");
    c.check(existsSync(logDir2) && readdirSync(logDir2).length === 0,
      "F2: GUILD_LOG=off mints NO run dir and writes NO patch (the documented claim, now true)");
  }

  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  console.log(`delegate.test: ${c.passes} passed, ${c.failures} failed`);
  return c.failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((f) => process.exit(f > 0 ? 1 : 0));
}
