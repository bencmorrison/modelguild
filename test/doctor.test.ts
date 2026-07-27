/**
 * `modelguild doctor` test (fix/doctor-detects-global).
 *
 * Regression guard for the bug where DEFAULT (non-`--global`) doctor only checked the PROJECT
 * payload locations, so a working GLOBAL install (`init --global`) falsely reported 0/8 docs,
 * 0/3 agents, a missing policy, and exited 1 — even though everything resolves fine globally.
 *
 * `runDoctor` returns 0/1 and takes an `inject?: { homeDir, xdgConfigHome }`, so we drive it
 * with injected temp dirs and NEVER touch the real `~/.claude` / `~/.config`. Offline: the
 * MCP-registration and opencode-binary checks are warnings (not failures) when the tools are
 * absent, so the pass/fail is driven only by the docs/agents/policy payload checks under test.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
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

  console.log(`doctor.test: ${c.passes} passed, ${c.failures} failed`);
  return c.failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((f) => process.exit(f > 0 ? 1 : 0));
}
