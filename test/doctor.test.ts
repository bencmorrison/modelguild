/**
 * `modelguild doctor` test (fix/doctor-detects-global; upgrade drift, issue #22).
 *
 * Regression guard for the bug where DEFAULT (non-`--global`) doctor only checked the PROJECT
 * payload locations, so a working GLOBAL install (`init --global`) falsely reported 0/8 docs,
 * 0/3 agents, a missing policy, and exited 1 — even though everything resolves fine globally.
 *
 * `runDoctor` returns 0/1 and takes an `inject?: { homeDir, xdgConfigHome }`, so we drive it
 * with injected temp dirs and NEVER touch the real `~/.claude` / `~/.config`. Offline: the
 * MCP-registration and opencode-binary checks are warnings (not failures) when the tools are
 * absent, so the pass/fail is driven only by the docs/agents/policy payload checks under test.
 *
 * ENVIRONMENT DEPENDENCY, stated because it bites locally: that "warning, not failure" holds
 * only while the `claude` CLI is ABSENT. When `claude` IS on PATH and answers "modelguild is not
 * registered", doctor hard-fails that check (correctly) and every absolute `code === 0`
 * assertion here fails — a dev-container fact, not a regression. CI has no `claude`, so the
 * suite is green there. The issue-#22 drift checks below deliberately assert against a BASELINE
 * doctor run in the same environment rather than a literal 0, so they hold either way.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Checker, repoRoot } from "./harness.js";
import { init, type ServerLaunch } from "../src/init.js";
import { runDoctor } from "../src/cli.js";

const LAUNCH: ServerLaunch = { command: "npx", args: ["-y", "modelguild", "serve"] };

function tempDir(): string {
  // realpath: macOS /tmp is a symlink; keep paths canonical to match safeJoin/existsSync.
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), "cc-doctor-")));
}

/** Run runDoctor with stdout/stderr captured, so we can assert the ✓/✗ lines AND the code. */
async function captureDoctor(
  argv: string[],
  inject: { homeDir: string; xdgConfigHome: string },
): Promise<{ code: number; out: string }> {
  const origLog = console.log;
  const origWarn = console.warn;
  const origErr = console.error;
  let out = "";
  const sink = (...a: unknown[]) => { out += a.join(" ") + "\n"; };
  console.log = sink;
  console.warn = sink;
  console.error = sink;
  try {
    const code = await runDoctor(argv, inject);
    return { code, out };
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origErr;
  }
}

export async function run(): Promise<number> {
  const c = new Checker();
  console.log("== doctor.test ==");

  // ---- (a) GLOBAL-only install: plain `doctor` (no --global) must PASS -----
  // Payload lands ONLY in the injected global dirs; the project dir is empty.
  const gHome = tempDir();
  const gXdg = tempDir();
  const inject = { homeDir: gHome, xdgConfigHome: gXdg };
  const emptyProject = tempDir();
  init({ targetDir: tempDir(), packageRoot: repoRoot, serverLaunch: LAUNCH, global: true, homeDir: gHome, xdgConfigHome: gXdg });

  const a = await captureDoctor(["--dir", emptyProject], inject);
  c.check(a.code === 0, `(a) GLOBAL-only install: plain doctor PASSES (exit ${a.code})`);
  c.check(!a.out.includes("✗"), "(a) plain doctor over a global install prints NO ✗ line");
  c.check(a.out.includes("8/8 command docs"), "(a) plain doctor counts 8/8 docs from the global dir");
  c.check(a.out.includes("3/3 hardened agent defs"), "(a) plain doctor counts 3/3 agents from the global dir");
  c.check(a.out.includes("[found: global]"), "(a) plain doctor reports the payload was found globally");

  // ---- (b) PROJECT install: plain `doctor` must PASS -----------------------
  // Inject EMPTY global dirs so the global lookups find nothing and the project wins.
  const proj = tempDir();
  const emptyHome = tempDir();
  const emptyXdg = tempDir();
  init({ targetDir: proj, packageRoot: repoRoot, serverLaunch: LAUNCH });
  const b = await captureDoctor(["--dir", proj], { homeDir: emptyHome, xdgConfigHome: emptyXdg });
  c.check(b.code === 0, `(b) PROJECT install: plain doctor PASSES (exit ${b.code})`);
  c.check(!b.out.includes("✗"), "(b) plain doctor over a project install prints NO ✗ line");
  c.check(b.out.includes("[found: project]"), "(b) plain doctor reports the payload was found in the project");

  // ---- (c) NEITHER: plain `doctor` must FAIL (fail-closed) -----------------
  const c1 = await captureDoctor(["--dir", tempDir()], { homeDir: tempDir(), xdgConfigHome: tempDir() });
  c.check(c1.code === 1, `(c) NEITHER project nor global: plain doctor FAILS (exit ${c1.code})`);
  c.check(c1.out.includes("0/8 command docs"), "(c) reports 0/8 docs when nothing is installed");
  c.check(c1.out.includes("✗"), "(c) prints a ✗ line when the payload is absent");

  // ---- --global mode is unchanged: checks ONLY the global location ---------
  // A global install passes --global doctor.
  const g = await captureDoctor(["--dir", emptyProject, "--global"], inject);
  c.check(g.code === 0, `(d) --global doctor PASSES for a global install (exit ${g.code})`);
  c.check(!g.out.includes("[found:"), "(d) --global doctor does not print the project-or-global 'found' suffix");

  // A PROJECT-only install must NOT satisfy --global doctor (global location empty).
  const g2 = await captureDoctor(["--dir", proj, "--global"], { homeDir: emptyHome, xdgConfigHome: emptyXdg });
  c.check(g2.code === 1, `(e) --global doctor FAILS for a project-only install (exit ${g2.code})`);

  // ---- (f) ONE command doc missing must FAIL, naming the doc (issue #33) ----
  // Regression guard for the `docsPresent >= 7` slack: a full install minus one doc reported
  // `doctor: OK`. Now a HARD fail, with the missing doc named (not a bare count).
  const projMissing = tempDir();
  init({ targetDir: projMissing, packageRoot: repoRoot, serverLaunch: LAUNCH });
  rmSync(path.join(projMissing, ".claude/commands/guild/consult.md"));
  const f = await captureDoctor(["--dir", projMissing], { homeDir: tempDir(), xdgConfigHome: tempDir() });
  c.check(f.code === 1, `(f) one doc missing: plain doctor FAILS (exit ${f.code})`);
  c.check(f.out.includes("7/8 command docs"), "(f) reports 7/8 docs with one removed");
  c.check(f.out.includes("missing: consult"), "(f) names the missing doc (consult)");
  c.check(f.out.includes("✗"), "(f) prints a ✗ line for the missing doc");

  // ---- (g) LAYERED config/policy chain is REPORTED (issue #19) -------------
  // A project install under a home that ALSO carries a global install: doctor must print
  // BOTH layers (project over global baseline) plus every policy file in the chain, so the
  // operator can see what actually binds rather than only the winner.
  {
    const layHome = tempDir();
    const layXdg = tempDir();
    const layProj = tempDir();
    init({ targetDir: layProj, packageRoot: repoRoot, serverLaunch: LAUNCH });
    init({ targetDir: tempDir(), packageRoot: repoRoot, serverLaunch: LAUNCH, global: true, homeDir: layHome, xdgConfigHome: layXdg });
    const g3 = await captureDoctor(["--dir", layProj], { homeDir: layHome, xdgConfigHome: layXdg });
    c.check(g3.code === 0, `(g) layered project+global install: doctor PASSES (exit ${g3.code})`);
    c.check(g3.out.includes("config/policy layers"), "(g) doctor prints the layered config/policy chain");
    c.check(
      g3.out.includes(path.join(layProj, "modelguild")) &&
        g3.out.includes(path.join(layHome, ".claude", "modelguild")),
      "(g) the chain names BOTH the project layer and the global baseline",
    );
    c.check(g3.out.includes("default-allow"), "(g) the chain ends at default-allow");
    c.check(
      g3.out.includes(path.join(layProj, "modelguild", "models.policy")) &&
        g3.out.includes(path.join(layHome, ".claude", "modelguild", "models.policy")),
      "(g) both roots' policy files are listed as layers",
    );
  }

  // ---- issue #22: UPGRADE DRIFT — cases (k)-(n) ---------------------------------
  // Lettered from (k): (g) is #19's layered-chain case above, which landed on main first.
  // BASELINE first: a pristine install in THIS environment. The drift assertions below compare
  // against it rather than against a literal 0, because doctor's MCP-registration check depends
  // on whether the `claude` CLI is on PATH and what it answers — an environment fact this suite
  // does not control. What must hold is that drift does not CHANGE the verdict.
  const projClean = tempDir();
  init({ targetDir: projClean, packageRoot: repoRoot, serverLaunch: LAUNCH });
  const base = await captureDoctor(["--dir", projClean], { homeDir: tempDir(), xdgConfigHome: tempDir() });
  c.check(base.out.includes("no upgrade drift"), "(k) a pristine install reports no upgrade drift");
  c.check(!base.out.includes("STALE"), "(k) a pristine install reports nothing stale");

  /** The lines that mention drift, so we can assert they are `!` warnings and never `✗`. */
  const driftLines = (out: string): string[] =>
    out.split("\n").filter((l) => /STALE|upgrade drift|CANNOT tell/.test(l));

  // ---- (l) UPGRADE DRIFT is reported, and is a WARNING not a failure ----
  // A user who edited a command doc keeps it forever (init never clobbers) — so after a release
  // moves that file on, they are silently on a stale copy. Doctor must say so. Simulate the
  // three-hash state: on-disk = the user's edit, record = a release neither side ships now.
  const projDrift = tempDir();
  init({ targetDir: projDrift, packageRoot: repoRoot, serverLaunch: LAUNCH });
  const DEST = ".claude/commands/guild/consult.md";
  writeFileSync(path.join(projDrift, DEST), "MY EDIT OF AN OLD RELEASE\n");
  const dRecPath = path.join(projDrift, "modelguild/.modelguild-install.json");
  const dRec = JSON.parse(readFileSync(dRecPath, "utf8"));
  dRec.files[DEST] = createHash("sha256").update("AN OLDER RELEASE\n").digest("hex");
  writeFileSync(dRecPath, JSON.stringify(dRec, null, 2) + "\n");
  const lDrift = await captureDoctor(["--dir", projDrift], { homeDir: tempDir(), xdgConfigHome: tempDir() });
  c.check(lDrift.out.includes("STALE"), "(l) doctor reports the drifted file as STALE");
  c.check(lDrift.out.includes(DEST), "(l) doctor names the drifted file");
  c.check(lDrift.out.includes("diff "), "(l) doctor prints a diff hint for the drifted file");
  c.check(
    lDrift.out.includes(path.join(repoRoot, DEST)) && lDrift.out.includes(path.join(projDrift, DEST)),
    "(l) the diff hint names BOTH the shipped bytes and the user's copy, absolute",
  );
  c.check(
    lDrift.code === base.code,
    `(l) drift does not change doctor's verdict — a warning, not a failure (${lDrift.code} vs baseline ${base.code})`,
  );
  c.check(
    driftLines(lDrift.out).every((l) => !l.includes("✗")),
    "(l) the drift report is a ! warning line, never a ✗ (a customized install is not broken)",
  );

  // ---- (m) no install record: doctor says it CANNOT judge, rather than guessing ----
  const projNoRec = tempDir();
  init({ targetDir: projNoRec, packageRoot: repoRoot, serverLaunch: LAUNCH });
  writeFileSync(path.join(projNoRec, DEST), "SOMETHING ELSE ENTIRELY\n");
  const lostRecord = path.join(projNoRec, "modelguild/.modelguild-install.json");
  rmSync(lostRecord);
  const mNoRec = await captureDoctor(["--dir", projNoRec], { homeDir: tempDir(), xdgConfigHome: tempDir() });
  c.check(mNoRec.out.includes("CANNOT"), "(m) doctor states it cannot judge drift without an ownership record");
  c.check(mNoRec.out.includes(lostRecord), "(m) doctor names the missing install record by path");
  c.check(!mNoRec.out.includes("STALE"), "(m) doctor does NOT call an unrecorded difference stale (no guessing)");
  c.check(
    mNoRec.code === base.code,
    `(m) an unjudgeable file does not change the verdict either (${mNoRec.code} vs baseline ${base.code})`,
  );
  c.check(
    driftLines(mNoRec.out).every((l) => !l.includes("✗")),
    "(m) the cannot-judge report is a ! warning line, never a ✗",
  );

  // ---- (n) plain doctor over a GLOBAL install judges drift by the GLOBAL record ----
  // The project has no record at all; if doctor read the wrong one this would report nothing
  // (or claim it cannot judge).
  const gDest = path.join(gHome, ".claude/commands/guild/consult.md");
  writeFileSync(gDest, "MY GLOBAL EDIT OF AN OLD RELEASE\n");
  const gRecPath = path.join(gHome, ".claude/modelguild/.modelguild-install.json");
  const gRec = JSON.parse(readFileSync(gRecPath, "utf8"));
  gRec.files[DEST] = createHash("sha256").update("AN OLDER RELEASE\n").digest("hex");
  writeFileSync(gRecPath, JSON.stringify(gRec, null, 2) + "\n");
  const nGlobal = await captureDoctor(["--dir", emptyProject], inject);
  c.check(nGlobal.out.includes("STALE"), "(n) plain doctor detects drift in a global-only install");
  c.check(nGlobal.out.includes(gDest), "(n) drift names the file in the global commands dir");
  c.check(
    driftLines(nGlobal.out).every((l) => !l.includes("✗")),
    "(n) global drift is a ! warning line too, never a ✗",
  );

  console.log(`doctor.test: ${c.passes} passed, ${c.failures} failed`);
  return c.failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((f) => process.exit(f > 0 ? 1 : 0));
}
