/**
 * `modelguild doctor` test (fix/doctor-detects-global; upgrade drift, issue #22).
 *
 * Regression guard for the bug where DEFAULT (non-`--global`) doctor only checked the PROJECT
 * payload locations, so a working GLOBAL install (`init --global`) falsely reported 0/8 docs,
 * 0/3 agents, a missing policy, and exited 1 — even though everything resolves fine globally.
 *
 * `runDoctor` returns 0/1 and takes an `inject?: { homeDir, xdgConfigHome }`, so we drive it
 * with injected temp dirs and NEVER touch the real `~/.claude` / `~/.config`. Offline
 * throughout: no model is called and no opencode process is spawned.
 *
 * THE ENVIRONMENT DEPENDENCY THIS SUITE USED TO CARRY IS GONE, and the reason it had to go is
 * worth knowing. It used to run under the ambient PATH, which made the verdict depend on two
 * host facts: whether the `claude` CLI was present (present-and-answering-"not registered" is a
 * hard fail, so every absolute `code === 0` assertion went red on a dev box and green in CI),
 * and — since issue #151 made a missing opencode a hard fail too — whether opencode was
 * installed at all, which CI deliberately does not do. Both are now shadowed: `run()` wraps the
 * whole suite in a PATH holding a stub `opencode` and nothing else. The BASELINE-RELATIVE
 * pattern is kept regardless (the issue-#22/#94 drift and skew cases compare against a `base`
 * doctor run rather than a literal 0) — it costs nothing and it is the honest assertion: what
 * those cases claim is that drift does not CHANGE the verdict.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Checker, repoRoot, runBounded } from "./harness.js";
import { init, type ServerLaunch } from "../src/init.js";
import { runDoctor } from "../src/cli.js";

/**
 * A fake `opencode` placed FIRST on PATH — the same injection point `test/serve-stderr.test.ts`
 * uses, and for the same reason: it drives the real `spawnSync("opencode", …)` rather than a
 * test-only command knob production would never take.
 *
 * `authList` is the byte-exact output `opencode auth list` should produce; `versionFails` makes
 * `--version` exit non-zero (an installed-but-broken opencode, a different message from an
 * absent one); `notExecutable` produces EACCES instead of ENOENT. Everything else exits 1, so an
 * unexpected invocation is loud rather than silently fine.
 */
function opencodeStub(opts: {
  versionFails?: boolean;
  authList?: AuthListFixture;
  notExecutable?: boolean;
}): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cc-doctor-oc-")));
  // The `auth list` payload goes to a FILE the stub `cat`s, never through `printf` in the
  // script. That is not tidiness: `printf '%s\n' "…\n…"` emits the backslash-n LITERALLY, so
  // every fixture was really one physical line. The old unanchored parser matched anyway; the
  // line-anchored one (correctly) did not, and the fixture — not the product — was what was
  // wrong. A file keeps the bytes exactly as `opencode auth list` writes them.
  const listPath = path.join(dir, "authlist.txt");
  writeFileSync(listPath, opts.authList?.out ?? "");
  const errLine = opts.authList?.err !== undefined ? `  printf '%s' ${shq(opts.authList.err)} >&2` : "  :";
  const body = [
    "#!/usr/bin/env bash",
    'if [ "$1" = "--version" ]; then',
    opts.versionFails === true
      ? "  echo 'opencode: fatal' >&2\n  exit 3"
      : "  printf '9.9.9-fake\\n'\n  exit 0",
    "fi",
    'if [ "$1" = "auth" ] && [ "$2" = "list" ]; then',
    `  cat ${shq(listPath)}`,
    errLine,
    `  exit ${opts.authList?.exit ?? 0}`,
    "fi",
    "exit 1",
  ].join("\n");
  // `notExecutable` drops the exec bits, which makes `spawnSync` fail with EACCES rather than
  // ENOENT — the case that proves the not-found wording is gated on the errno, not on "any
  // spawn error" (issue #151 review, D3).
  writeFileSync(path.join(dir, "opencode"), body + "\n", {
    mode: opts.notExecutable === true ? 0o644 : 0o755,
  });
  return dir;
}

/** Single-quote a string for the stub's bash. */
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** What a stubbed `opencode auth list` writes: stdout bytes, optional stderr, optional exit. */
interface AuthListFixture {
  out: string;
  err?: string;
  exit?: number;
}

/** The real `opencode auth list` shapes, transcribed from a live probe on 1.18.11 (issue #151).
 *  Written with the ANSI colour codes it actually emits, because stripping them is part of what
 *  the parse has to get right — and as raw bytes, `cat`'d by the stub (see `opencodeStub`). */
const ESC = String.fromCharCode(27);
const AUTH_LIST: Record<string, AuthListFixture> = {
  /** One stored credential (GitHub Copilot oauth), no provider env vars. */
  authed: {
    out:
      `${ESC}[0m\n┌  Credentials ${ESC}[90m~/.local/share/opencode/auth.json\n│\n` +
      `●  GitHub Copilot ${ESC}[90moauth\n│\n└  1 credentials\n`,
  },
  /** An empty auth store — note the exit code is 0 here too, which is why it cannot be used. */
  empty: {
    out: `${ESC}[0m\n┌  Credentials ${ESC}[90m~/.local/share/opencode/auth.json\n│\n└  0 credentials\n`,
  },
  /** No stored credentials, but two provider API-key env vars — a WORKING setup. */
  envOnly: {
    out:
      `${ESC}[0m\n┌  Credentials ${ESC}[90m~/.local/share/opencode/auth.json\n│\n└  0 credentials\n\n` +
      `┌  Environment\n│\n●  Anthropic ${ESC}[90mANTHROPIC_API_KEY\n│\n` +
      `●  OpenAI ${ESC}[90mOPENAI_API_KEY\n│\n└  2 environment variables\n`,
  },
  /** A future opencode that reformats the output: parseable by nothing here. */
  unreadable: { out: "credentials: none of your business\n" },
  /** The subcommand itself failing. */
  fails: { out: "", err: "auth: boom\n", exit: 4 },
  /** SINGULAR — "1 credential", not "1 credentials". */
  singular: { out: `┌  Credentials\n│\n●  GitHub Copilot ${ESC}[90moauth\n│\n└  1 credential\n` },
  /** A misleading EARLIER line-final count, then the real footer. The last one must win. */
  misleadingEarlier: {
    out:
      "note: migrated 0 credentials\n" +
      `┌  Credentials\n│\n●  GitHub Copilot ${ESC}[90moauth\n│\n└  2 credentials\n`,
  },
  /** The hyphenated shape an unanchored `\b` matched INSIDE: not a footer, must not read as one. */
  hyphenatedOnly: { out: "note: 0 credentials-migrated during upgrade\n" },
};

/**
 * A directory holding exactly the two commands the stubs need: `bash` (their
 * `#!/usr/bin/env bash` resolves it through PATH) and `cat` (the stub prints its `auth list`
 * fixture from a file). Listing them EXPLICITLY, rather than keeping `/usr/bin:/bin` on PATH,
 * makes the shadowing total for the binaries under test: no `opencode` and no `claude` can be
 * reached however the host is laid out.
 *
 * Both entries are load-bearing and were each found the hard way — a PATH without `bash` makes
 * every stub invocation a spawn error, and a PATH without `cat` makes the stub print nothing,
 * which the parser correctly reports as "could not determine" and every authed assertion fails.
 */
const SHELL_TOOLS: Record<string, string[]> = {
  bash: ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"],
  cat: ["/bin/cat", "/usr/bin/cat"],
};
let shellDirCache: string | null = null;
function shellOnlyDir(): string {
  if (shellDirCache !== null) return shellDirCache;
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cc-doctor-sh-")));
  for (const [name, candidates] of Object.entries(SHELL_TOOLS)) {
    const found = candidates.find((p) => existsSync(p));
    if (found === undefined) {
      throw new Error(`doctor.test: no ${name} found for the PATH-shadowed cases`);
    }
    symlinkSync(found, path.join(dir, name));
  }
  shellDirCache = dir;
  return dir;
}

/**
 * Run `fn` with PATH replaced by `dir` plus the bash-only dir — `null` means the bash-only dir
 * alone, i.e. no `opencode` on PATH at all. `claude` is absent either way, which puts the MCP
 * check on its documented warning branch; that is what lets these cases assert ABSOLUTE exit
 * codes where the rest of this suite has to compare against `base`.
 */
async function withPath<T>(dir: string | null, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PATH;
  const sh = shellOnlyDir();
  process.env.PATH = dir === null ? sh : `${dir}:${sh}`;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.PATH;
    else process.env.PATH = prev;
  }
}

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

/**
 * The WHOLE suite runs with PATH shadowed by a stub `opencode` that reports itself present and
 * authenticated (issue #151). This is not decoration — it is what keeps the suite offline AND
 * environment-independent now that both opencode checks are hard failures:
 *
 *   - CI has no opencode at all, so without a stub every absolute `code === 0` assertion in
 *     cases (a)-(r) would fail there for a reason those cases are not about.
 *   - A dev box HAS opencode and may or may not be logged in, so the verdict would differ
 *     between machines.
 *   - `claude` is off PATH here too, which puts the MCP-registration check on its documented
 *     warning branch — the same state CI has always had.
 *
 * Cases (s)-(z) nest their own `withPath` inside this one to vary the opencode state.
 */
export async function run(): Promise<number> {
  return withPath(opencodeStub({ authList: AUTH_LIST.authed }), runCases);
}

async function runCases(): Promise<number> {
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

  // ---- (f2) A DIRECTORY at a def path must FAIL, agreeing with C16 (issue #175) ----
  // `locatePayload` used a bare `existsSync`, which is TRUE for a directory — so this exact
  // fixture printed `✓ 3/3 hardened agent defs present` and `doctor: OK` for a repo where
  // `hardenedDefPresentIn` (C78's predicate) says absent and C16 therefore refuses at every
  // model-calling tool. The user-visible half of that contradiction is asserted here; the
  // predicate-level agreement is in `test/init.test.ts`. Neither shape can block, so no
  // bounded child is needed (C78's test discipline applies to FIFOs, not to directories).
  const projDirDef = tempDir();
  init({ targetDir: projDirDef, packageRoot: repoRoot, serverLaunch: LAUNCH });
  const dirDef = path.join(projDirDef, ".opencode/agent/guild-read.md");
  rmSync(dirDef);
  mkdirSync(dirDef, { recursive: true });
  const f2 = await captureDoctor(["--dir", projDirDef], { homeDir: tempDir(), xdgConfigHome: tempDir() });
  c.check(f2.code === 1, `(f2) a DIRECTORY at a def path FAILS (exit ${f2.code}) — pre-fix: 0, "doctor: OK"`);
  c.check(
    f2.out.includes("2/3 hardened agent defs") && f2.out.includes("missing: guild-read"),
    `(f2) and it is counted absent and named, as C16's refusal already treats it (got: ${f2.out.split("\n").find((l) => l.includes("hardened agent defs")) ?? "<no line>"})`,
  );

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

  // ---- issue #94: PAYLOAD SKEW — cases (o)-(r) ---------------------------------
  // The MCP server updates itself via npx; the payload it installed in the repo does not. So a
  // CLEAN install ends up behind the release with nothing edited and nothing skipped — invisible
  // to #22's drift predicate, and the state this issue is about. Doctor is where a user looks
  // when something behaves oddly, so it must say so — as a WARNING that leaves the exit code
  // alone, exactly like drift: being behind a release is not a broken install.
  //
  // "Behind the release" is simulated the only way it can be from inside the repo that IS the
  // release: change the installed bytes AND record that same hash as ours, so the file reads as
  // untouched-since-install while the shipped bytes have moved on.
  const skewLines = (out: string): string[] =>
    out.split("\n").filter((l) => /OUT OF SYNC|payload skew|Normally they are BEHIND/.test(l));

  const projSkew = tempDir();
  init({ targetDir: projSkew, packageRoot: repoRoot, serverLaunch: LAUNCH });
  const SKEW_DEST = ".claude/commands/guild/panel.md";
  const skewBytes = "AN OLDER RELEASE OF PANEL\n";
  writeFileSync(path.join(projSkew, SKEW_DEST), skewBytes);
  const sRecPath = path.join(projSkew, "modelguild/.modelguild-install.json");
  const sRec = JSON.parse(readFileSync(sRecPath, "utf8"));
  sRec.files[SKEW_DEST] = createHash("sha256").update(skewBytes).digest("hex");
  writeFileSync(sRecPath, JSON.stringify(sRec, null, 2) + "\n");

  const o = await captureDoctor(["--dir", projSkew], { homeDir: tempDir(), xdgConfigHome: tempDir() });
  c.check(o.out.includes("OUT OF SYNC"), "(o) doctor reports a clean install that is behind the release as skew");
  c.check(o.out.includes(SKEW_DEST), "(o) doctor names the skewed file");
  c.check(o.out.includes("npx modelguild init"), "(o) doctor names the fix (init rewrites unedited files in place)");
  c.check(!o.out.includes("STALE"), "(o) skew is NOT reported as drift (the file was never edited)");
  c.check(!o.out.includes("CANNOT"), "(o) skew is NOT reported as unjudgeable (it has an ownership record)");
  c.check(
    o.code === base.code,
    `(o) skew does not change doctor's verdict — a warning, not a failure (${o.code} vs baseline ${base.code})`,
  );
  c.check(
    skewLines(o.out).every((l) => !l.includes("✗")),
    "(o) the skew report is a ! warning line, never a ✗ (behind a release is not broken)",
  );
  c.check(
    !o.out.includes("no payload skew"),
    "(o) the up-to-date ✓ line is NOT printed when a file is behind the release",
  );

  // ---- (p) the SILENCE KNOB governs the start-up notice, NOT doctor ---------
  // Precedent, cited deliberately: issue #23's `logs clean` still runs under GUILD_LOG=off,
  // because it was asked for in so many words. Doctor is asked for; the start-up line is not.
  {
    const prev = process.env.GUILD_PAYLOAD_NOTICE;
    process.env.GUILD_PAYLOAD_NOTICE = "off";
    try {
      const p = await captureDoctor(["--dir", projSkew], { homeDir: tempDir(), xdgConfigHome: tempDir() });
      c.check(p.out.includes("OUT OF SYNC"), "(p) GUILD_PAYLOAD_NOTICE=off does NOT silence doctor's skew report");
      c.check(p.code === base.code, `(p) the knob does not change doctor's verdict either (${p.code})`);
    } finally {
      if (prev === undefined) delete process.env.GUILD_PAYLOAD_NOTICE;
      else process.env.GUILD_PAYLOAD_NOTICE = prev;
    }
  }

  // ---- (q) a pristine install reports neither skew nor drift ---------------
  c.check(base.out.includes("no payload skew"), "(q) a pristine install reports no payload skew");
  c.check(!base.out.includes("OUT OF SYNC"), "(q) a pristine install reports nothing behind the release");

  // ---- (r) plain doctor over a GLOBAL install judges SKEW by the GLOBAL record ----
  // Same mode-correctness (r) as the drift case (n), on the state that has no edit to hint at
  // it. The project here is empty, so a wrong record would report nothing at all.
  const gSkewDest = path.join(gHome, ".claude/commands/guild/panel.md");
  writeFileSync(gSkewDest, skewBytes);
  const gRec2 = JSON.parse(readFileSync(gRecPath, "utf8"));
  gRec2.files[SKEW_DEST] = createHash("sha256").update(skewBytes).digest("hex");
  writeFileSync(gRecPath, JSON.stringify(gRec2, null, 2) + "\n");
  const r = await captureDoctor(["--dir", emptyProject], inject);
  c.check(r.out.includes("OUT OF SYNC"), "(r) plain doctor detects skew in a global-only install");
  c.check(r.out.includes(gSkewDest), "(r) skew names the file in the GLOBAL commands dir (judged by the global record)");
  c.check(
    skewLines(r.out).every((l) => !l.includes("✗")),
    "(r) global skew is a ! warning line too, never a ✗",
  );

  // ---- issue #151: opencode presence + AUTH are HARD failures — cases (s)-(z) --------
  // These cases replace PATH with a stub dir containing only a fake `opencode`, so `claude` is
  // absent too and the MCP check takes its warning branch. The verdict is then a pure function
  // of the payload (a full, pristine install) plus the two opencode checks — which is what lets
  // them assert absolute exit codes where the rest of this suite must go through `base`.
  const projOc = tempDir();
  init({ targetDir: projOc, packageRoot: repoRoot, serverLaunch: LAUNCH });
  const ocInject = { homeDir: tempDir(), xdgConfigHome: tempDir() };
  const runOc = (stubDir: string | null) =>
    withPath(stubDir, () => captureDoctor(["--dir", projOc], ocInject));

  // (s) The reference point for the rest: binary present, authed ⇒ a clean exit 0.
  const sOk = await runOc(opencodeStub({ authList: AUTH_LIST.authed }));
  c.check(sOk.code === 0, `(s) opencode present + authed: doctor PASSES (exit ${sOk.code})`);
  c.check(!sOk.out.includes("✗"), "(s) a healthy install with an authed opencode prints NO ✗ line");
  c.check(sOk.out.includes("✓ opencode present (9.9.9-fake)"), "(s) reports the opencode version");
  c.check(
    sOk.out.includes("✓ opencode authenticated (1 stored credential(s), 0 provider env var(s))"),
    "(s) reports the credential counts it parsed",
  );

  // (t) MISSING BINARY: was a `!` warning under `doctor: OK`. Now a ✗ / exit 1 — the severity
  // inversion issue #151 is named for. Nothing else about the install has changed from (s).
  const tMissing = await runOc(null);
  c.check(tMissing.code === 1, `(t) opencode missing: doctor FAILS (exit ${tMissing.code})`);
  c.check(
    tMissing.out.includes("✗ opencode not found on PATH"),
    "(t) the missing binary is a ✗ line, not a ! warning",
  );
  c.check(
    tMissing.out.includes("opencode auth login") && tMissing.out.includes("opencode.ai"),
    "(t) the refusal keeps the actionable remedy (install, then auth login)",
  );
  c.check(
    !tMissing.out.includes("doctor: OK"),
    "(t) doctor does not print OK when opencode is missing",
  );
  // AND the auth check is SKIPPED — one cause must not produce two lines.
  c.check(
    !tMissing.out.includes("authenticated") && !tMissing.out.includes("NO credentials"),
    "(t) no auth line at all when the binary itself is missing",
  );

  // (u) On PATH but `--version` fails: same verdict, distinct message (different remedy).
  const uBroken = await runOc(opencodeStub({ versionFails: true }));
  c.check(uBroken.code === 1, `(u) opencode --version failing: doctor FAILS (exit ${uBroken.code})`);
  c.check(
    uBroken.out.includes("✗ opencode is on PATH but") && uBroken.out.includes("exit 3"),
    "(u) an installed-but-broken opencode is named as such, with its exit status",
  );

  // (v) ZERO credentials AND zero provider env vars ⇒ a `!` WARNING, exit UNCHANGED
  // (maintainer decision 2026-08-03; both review rounds independently reached it). The probe
  // has real blind spots — a provider configured straight into opencode.json, whether by
  // apiKey or as a local endpoint needing no credential, is invisible to `auth list` while
  // models answer — so a zero is evidence, not proof, and doctor must not call that setup
  // broken. Same posture as the claude-absent registration downgrade and C72's report-only
  // skew/drift rule.
  const vEmptyList = await runOc(opencodeStub({ authList: AUTH_LIST.empty }));
  c.check(
    vEmptyList.code === sOk.code,
    `(v) no credentials does NOT change doctor's verdict (${vEmptyList.code} vs authed ${sOk.code})`,
  );
  c.check(
    vEmptyList.out.includes("! opencode has NO credentials"),
    "(v) the unauthenticated state is a ! warning line",
  );
  c.check(
    !vEmptyList.out.includes("✗ opencode has NO credentials"),
    "(v) it is NOT a ✗ (the probe cannot see every working configuration)",
  );
  c.check(vEmptyList.out.includes("doctor: OK"), "(v) doctor still reports OK");
  c.check(vEmptyList.out.includes("opencode auth login"), "(v) names the remedy");
  c.check(vEmptyList.out.includes("Until you do"), "(v) the remedy sentence reads grammatically");
  c.check(
    vEmptyList.out.includes("opencode.json") &&
      vEmptyList.out.includes("apiKey") &&
      vEmptyList.out.includes("local endpoint needing no credential"),
    "(v) names BOTH blind-spot shapes, not just the apiKey one",
  );
  c.check(
    vEmptyList.out.includes("✓ opencode present"),
    "(v) the binary line still passes — the two checks are independent",
  );

  // (w) ZERO stored credentials but provider API-key ENV VARS ⇒ a working setup, so ✓.
  // The false-✗ guard: reading only the `Credentials` section would fail this user.
  const wEnv = await runOc(opencodeStub({ authList: AUTH_LIST.envOnly }));
  c.check(wEnv.code === 0, `(w) env-var-only auth PASSES (exit ${wEnv.code})`);
  c.check(
    wEnv.out.includes("✓ opencode authenticated (0 stored credential(s), 2 provider env var(s))"),
    "(w) both credential sources are counted, and reported separately",
  );

  // (x) UNPARSEABLE output ⇒ a `!` "could not determine", never a "no credentials" claim.
  // Both are warnings now, but they say different things: one reports a state, the other
  // reports that no state could be read.
  const xUnknown = await runOc(opencodeStub({ authList: AUTH_LIST.unreadable }));
  c.check(
    xUnknown.out.includes("! could not determine whether opencode is authenticated"),
    "(x) unparseable `auth list` output is reported as could-not-determine",
  );
  c.check(
    !xUnknown.out.includes("NO credentials"),
    "(x) could-not-determine is NOT reported as unauthenticated",
  );
  c.check(xUnknown.code === 0, `(x) an unreadable probe does not fail doctor (exit ${xUnknown.code})`);

  // (y) `auth list` itself failing ⇒ same fail-open verdict, naming the exit status.
  const yFails = await runOc(opencodeStub({ authList: AUTH_LIST.fails }));
  c.check(
    yFails.out.includes("! could not determine") && yFails.out.includes("exited 4"),
    "(y) a failing `auth list` is a warning naming its exit status",
  );
  c.check(yFails.code === 0, `(y) a failing auth probe does not fail doctor (exit ${yFails.code})`);

  // ---- (y2) D3: a spawn error that is NOT ENOENT must not say "not found on PATH" ----------
  // An opencode that is present but not executable sets EACCES. Telling that user to install
  // opencode sends them at the wrong problem; it is still a hard failure, with its own wording.
  const y2Eacces = await runOc(opencodeStub({ notExecutable: true }));
  c.check(y2Eacces.code === 1, `(y2) a non-executable opencode still FAILS (exit ${y2Eacces.code})`);
  c.check(
    y2Eacces.out.includes("✗ could not execute opencode") && y2Eacces.out.includes("EACCES"),
    "(y2) the errno is named rather than guessed at",
  );
  c.check(
    !y2Eacces.out.includes("not found on PATH"),
    "(y2) EACCES is NOT reported as 'not found on PATH' (the wording is gated on ENOENT)",
  );
  c.check(
    !y2Eacces.out.includes("authenticated") && !y2Eacces.out.includes("NO credentials"),
    "(y2) the auth check is skipped whenever the BINARY check failed, not only when it is missing",
  );

  // ---- (y3) PARSER ANCHORING: the counts are LINE FOOTERS ---------------------------------
  // The first cut used an unanchored `\b` search and took the FIRST match, so a stray earlier
  // count — or a hyphenated word the `\b` matched inside — was read as the credential total.
  {
    const singular = await runOc(opencodeStub({ authList: AUTH_LIST.singular }));
    c.check(
      singular.out.includes("✓ opencode authenticated (1 stored credential(s), 0 provider env var(s))"),
      "(y3) the SINGULAR footer '1 credential' parses",
    );

    const earlier = await runOc(opencodeStub({ authList: AUTH_LIST.misleadingEarlier }));
    c.check(
      earlier.out.includes("✓ opencode authenticated (2 stored credential(s), 0 provider env var(s))"),
      "(y3) a misleading EARLIER '0 credentials' line loses to the real footer (last match wins)",
    );
    c.check(
      !earlier.out.includes("NO credentials"),
      "(y3) ...and does not produce a false 'no credentials' warning",
    );

    const hyphen = await runOc(opencodeStub({ authList: AUTH_LIST.hyphenatedOnly }));
    c.check(
      hyphen.out.includes("! could not determine whether opencode is authenticated"),
      "(y3) '0 credentials-migrated' is not a footer — it degrades to could-not-determine",
    );
    c.check(
      !hyphen.out.includes("NO credentials"),
      "(y3) ...never to a false 'no credentials' (the whole point of anchoring)",
    );
  }

  // (z) NEGATIVE WORDING (issue #151 finding 3): `line(ok, msg)` picks the glyph but cannot
  // rewrite the words, so a single positive sentence produced `✗ model policy present (…)`.
  // Reuses (c)'s nothing-installed fixture shape.
  const zEmpty = await withPath(opencodeStub({ authList: AUTH_LIST.authed }), () =>
    captureDoctor(["--dir", tempDir()], { homeDir: tempDir(), xdgConfigHome: tempDir() }),
  );
  c.check(zEmpty.code === 1, `(z) nothing installed still FAILS (exit ${zEmpty.code})`);
  c.check(
    !zEmpty.out.includes("✗ model policy present"),
    "(z) the policy failure no longer contradicts itself",
  );
  c.check(
    zEmpty.out.includes("✗ model policy MISSING"),
    "(z) the policy failure states a negative, naming where it looked",
  );
  c.check(
    zEmpty.out.includes("modelguild/models.policy"),
    "(z) the policy failure still names the locations it searched",
  );
  c.check(
    zEmpty.out.includes("0/3 hardened agent defs") && zEmpty.out.includes("missing: guild-"),
    "(z) the agent-def failure mirrors the command-docs `— missing:` pattern, naming each def",
  );
  // Asserted on the agent-def LINE, not on the whole output: the def names must appear in its
  // `— missing:` list, not merely somewhere on screen.
  {
    const agentLine = zEmpty.out.split("\n").find((l) => l.includes("hardened agent defs")) ?? "";
    const missingPart = agentLine.split("— missing:")[1] ?? "";
    c.check(
      ["guild-read", "guild-build", "guild-research"].every((n) => missingPart.includes(n)),
      `(z) all three missing agent defs are named on that line (got "${missingPart.trim()}")`,
    );
  }
  // And the positive forms are untouched when everything IS present (regression guard on (s)).
  c.check(
    sOk.out.includes("✓ model policy present (") && sOk.out.includes("✓ 3/3 hardened agent defs present in"),
    "(z) the passing forms are unchanged",
  );

  // ---- (aa) issue #162: `doctor` RETURNS on a FIFO at any path it reads --------------------
  //
  // Four paths `doctor` opened behind an `existsSync`/no gate at all: `.mcp.json`,
  // `modelguild.conf.local`, `models.policy.local`, and (the inconsistency that made the bug
  // obvious) `models.policy`, which already stat-gated and so merely contributed nothing.
  // The first three hung the process forever.
  //
  // THESE RUN IN A CHILD PROCESS UNDER A WALL-CLOCK BOUND, and that is the only way to write
  // them: the defect is a BLOCKING synchronous read, which is neither an exception nor a
  // pending promise, so nothing in this process could interrupt it. An in-process assertion
  // would hang the suite on a regression — a CI timeout with no signal — rather than fail.
  // `runBounded` hands the job to the OS: a regression is a killed child and a red line.
  //
  // PATH is shadowed the same way the rest of this suite shadows it, for the same reason and
  // one more: `doctor` shells out to `claude mcp get`, and the Claude CLI in this dev
  // container ALSO blocks when `$GUILD_CONF` points at a FIFO. Keeping it off PATH makes
  // these cases a statement about ModelGuild rather than about the host's other tools.
  {
    const cliEntry = path.join(repoRoot, "src", "cli.ts");
    // An ABSOLUTE `mkfifo`: this suite's PATH shadow is total, so a bare name would not
    // resolve. Same candidate-list shape as `SHELL_TOOLS`, and loud if it is nowhere.
    const mkfifoBin = ["/usr/bin/mkfifo", "/bin/mkfifo"].find((p) => existsSync(p));
    if (mkfifoBin === undefined) throw new Error("doctor.test: no mkfifo found for the issue-#162 cases");
    const stubPath = `${opencodeStub({ authList: AUTH_LIST.authed })}:${shellOnlyDir()}`;
    const fifoCase = (label: string, rel: string): void => {
      const dir = tempDir();
      mkdirSync(path.join(dir, "modelguild"), { recursive: true });
      execFileSync(mkfifoBin, [path.join(dir, rel)]);
      const r = runBounded([cliEntry, "doctor", "--dir", dir], {
        env: { ...process.env, PATH: stubPath, HOME: tempDir(), XDG_CONFIG_HOME: tempDir() },
        timeoutMs: 60_000,
      });
      c.check(!r.timedOut, `(aa) doctor RETURNS with a FIFO at ${label} (it used to block forever)`);
      c.check(
        !r.timedOut && r.status !== null,
        `(aa) ...with a real exit status rather than a signal (status ${r.status}, signal-killed=${r.timedOut})`,
      );
    };
    fifoCase(".mcp.json", ".mcp.json");
    fifoCase("modelguild/modelguild.conf.local", "modelguild/modelguild.conf.local");
    fifoCase("modelguild/models.policy.local", "modelguild/models.policy.local");
    fifoCase("modelguild/models.policy", "modelguild/models.policy"); // the one that never hung
  }

  console.log(`doctor.test: ${c.passes} passed, ${c.failures} failed`);
  return c.failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((f) => process.exit(f > 0 ? 1 : 0));
}
