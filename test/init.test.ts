/**
 * `modelguild init` test, in the spirit of the retired bash `tests/test-install.sh`:
 * install into throwaway temp dirs and assert the file / .mcp.json / ownership behaviour,
 * idempotency, the merge-not-clobber guarantee, hash-verified uninstall, and that the
 * bash wrappers are NOT installed. Offline, no model call. packageRoot is the repo root
 * (the payload assets live there — the same files npm's `files` allowlist ships).
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Checker, repoRoot, runBounded, tsxBin } from "./harness.js";
import {
  init,
  isDrifted,
  isSkewed,
  locatePayload,
  packageVersion,
  payloadFiles,
  resolveGlobalDirs,
  scanInstalledPayload,
  type PayloadFileState,
  type ServerLaunch,
} from "../src/init.js";
import { hardenedDefPresentIn } from "../src/config.js";
import { emitPayloadSkewNotice, noticeStatePath, payloadFingerprint, readNoticeState } from "../src/notice.js";

// The shipped default launch line: portable, non-interactive npx form.
const LAUNCH: ServerLaunch = { command: "npx", args: ["-y", "modelguild", "serve"] };

function tempProject(): string {
  // realpath: macOS /tmp is a symlink; safeJoin refuses symlink components, so canonicalize.
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), "cc-init-")));
}

function readJson(p: string): any {
  return JSON.parse(readFileSync(p, "utf8"));
}

/**
 * `init`, with a throw SCORED as a failed check instead of aborting the process. A regression
 * on the issue-#156 paths makes `init` throw, and an uncaught throw mid-file leaves every
 * later assertion in this suite unevaluated — a coarser failure mode than the rest of the
 * file. The empty result keeps the caller's follow-on assertions typed and failing.
 */
/** The ownership record's `files` key count, or -1 when the path is absent or does not hold the
 *  record JSON — so an assertion ABOUT the record fails rather than throwing out of the suite
 *  (the same reason `initScored` exists: a regression must score, not abort). */
function recordedFileCount(p: string): number {
  try {
    return Object.keys(readJson(p).files).length;
  } catch {
    return -1;
  }
}

/** Regular files under `dir`, recursively; 0 when `dir` does not exist. Symlinks are NOT
 *  counted — they are what the caller planted, not what init wrote. Used to assert that a
 *  refusal wrote NOTHING, which is the whole claim of a plan-time refusal. */
function countFiles(dir: string): number {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let n = 0;
  for (const e of entries) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
    else if (e.isFile()) n += 1;
  }
  return n;
}

function initScored(c: Checker, label: string, opts: Parameters<typeof init>[0]): ReturnType<typeof init> {
  try {
    return init(opts);
  } catch (e) {
    c.check(false, `${label} — init threw: ${(e as Error).message}`);
    return { installed: [], skipped: [], removed: [], shadowed: [], drifted: [], blocked: [], warnings: [], mcpAction: "skipped" };
  }
}

export async function run(): Promise<number> {
  const c = new Checker();
  console.log("== init.test ==");

  // --- fresh install (DEFAULT: does NOT write .mcp.json) -------------------
  const T = tempProject();
  const res = init({ targetDir: T, packageRoot: repoRoot, serverLaunch: LAUNCH });

  c.check(res.installed.length === 13, `installs 13 files (8 docs + 3 agents + 2 templates) (got ${res.installed.length})`);
  c.check(existsSync(path.join(T, ".claude/commands/guild/consult.md")), "places a command doc");
  c.check(existsSync(path.join(T, ".claude/commands/guild/configure.md")), "places configure.md (the 8th doc)");
  c.check(existsSync(path.join(T, ".opencode/agent/guild-read.md")), "places guild-read agent def");
  c.check(existsSync(path.join(T, ".opencode/agent/guild-research.md")), "places guild-research agent def");
  c.check(existsSync(path.join(T, ".opencode/agent/guild-build.md")), "places guild-build agent def");
  c.check(existsSync(path.join(T, "modelguild/models.policy")), "places models.policy template");
  c.check(existsSync(path.join(T, "modelguild/modelguild.conf.example")), "places modelguild.conf.example template");
  c.check(existsSync(path.join(T, "modelguild/.modelguild-install.json")), "writes the ownership record file");

  // The MCP-era payload must NOT ship the bash wrappers or witness.md.
  c.check(!existsSync(path.join(T, "modelguild/ask.sh")), "does NOT install modelguild/ask.sh");
  c.check(!existsSync(path.join(T, "modelguild/log.sh")), "does NOT install modelguild/log.sh");
  c.check(!existsSync(path.join(T, "modelguild/panel-models.sh")), "does NOT install panel-models.sh");
  c.check(!existsSync(path.join(T, ".claude/commands/guild/witness.md")), "does NOT install witness.md");
  c.check(!existsSync(path.join(T, ".opencode/agent/guild-watch.md")), "does NOT install guild-watch (witness) agent");

  // --- DEFAULT: .mcp.json is NOT written; user registers the server -------
  c.check(res.mcpAction === "skipped", "default install reports .mcp.json 'skipped' (user registers it)");
  c.check(!existsSync(path.join(T, ".mcp.json")), "default install does NOT create .mcp.json");

  // --- opt-in --write-mcp: the old auto-write of the project .mcp.json ----
  const Tw = tempProject();
  const resw = init({ targetDir: Tw, packageRoot: repoRoot, serverLaunch: LAUNCH, writeMcp: true });
  c.check(resw.mcpAction === "created", "--write-mcp reports .mcp.json created");
  const mcp = readJson(path.join(Tw, ".mcp.json"));
  c.check(
    !!mcp.mcpServers && Object.prototype.hasOwnProperty.call(mcp.mcpServers, "modelguild"),
    "--write-mcp .mcp.json has the 'modelguild' key (matches mcp__modelguild__* grants)",
  );
  const entry = mcp.mcpServers.modelguild;
  c.check(
    entry.command === "npx" &&
      JSON.stringify(entry.args) === JSON.stringify(["-y", "modelguild", "serve"]),
    "launch line is the portable non-interactive default `npx -y modelguild serve`",
  );
  c.check(entry.env?.GUILD_PROJECT_DIR === Tw, "--write-mcp .mcp.json entry sets GUILD_PROJECT_DIR to the target dir");

  // --- gitignore -----------------------------------------------------------
  const gi = readFileSync(path.join(T, ".gitignore"), "utf8");
  c.check(gi.includes("ModelGuild >>>") && gi.includes("modelguild/logs/"), "gitignore block written");

  // --- idempotent re-run ---------------------------------------------------
  const res2 = init({ targetDir: T, packageRoot: repoRoot, serverLaunch: LAUNCH });
  c.check(res2.installed.length === 0 && res2.skipped.length === 0, "re-run writes 0 files (idempotent)");
  const giCount = (readFileSync(path.join(T, ".gitignore"), "utf8").match(/ModelGuild >>>/g) || []).length;
  c.check(giCount === 1, "re-run keeps exactly one gitignore block");

  // --- upgrade: a stale-but-owned file is overwritten ----------------------
  const consultPath = path.join(T, ".claude/commands/guild/consult.md");
  const original = readFileSync(consultPath);
  // Simulate a prior-version file: overwrite its bytes AND record the new hash as ours,
  // so the ownership check treats it as owned (it matches the recorded hash).
  writeFileSync(consultPath, "OLD OWNED CONTENT\n");
  const recPath = path.join(T, "modelguild/.modelguild-install.json");
  const rec = readJson(recPath);
  rec.files[".claude/commands/guild/consult.md"] = createHash("sha256").update("OLD OWNED CONTENT\n").digest("hex");
  writeFileSync(recPath, JSON.stringify(rec, null, 2) + "\n");
  const res3 = init({ targetDir: T, packageRoot: repoRoot, serverLaunch: LAUNCH });
  c.check(res3.installed.includes(".claude/commands/guild/consult.md"), "an owned-but-stale file is upgraded");
  c.check(readFileSync(consultPath).equals(original), "upgrade restores the current payload bytes");

  // --- merge-not-clobber: a user-edited file is left untouched + shadow-warned
  writeFileSync(consultPath, "MY OWN COMMAND — DO NOT TOUCH\n");
  const res4 = init({ targetDir: T, packageRoot: repoRoot, serverLaunch: LAUNCH });
  c.check(
    readFileSync(consultPath, "utf8") === "MY OWN COMMAND — DO NOT TOUCH\n",
    "a user-edited command doc is NOT clobbered",
  );
  c.check(res4.skipped.includes(".claude/commands/guild/consult.md"), "the edited file is reported skipped");
  c.check(res4.shadowed.includes(".claude/commands/guild/consult.md"), "an unowned command doc raises a shadow warning");
  // The edit above is against the CURRENT release (the record holds the shipped hash), so the
  // skip is not drift — the user is customizing the latest version, not stuck on an old one.
  c.check(res4.drifted.length === 0, "an edit against the current release is NOT reported as drift");

  // --- issue #22: UPGRADE DRIFT — ours + user-edited + the release moved on ----
  // The never-clobber skip is correct and stays; the bug was that it was SILENT, leaving the
  // user on a stale command after an upgrade. Simulate the exact three-hash state: the file on
  // disk is the user's edit, and the RECORD holds a hash that is neither the current bytes nor
  // the shipped bytes (i.e. init wrote an older release, which the user then edited).
  const TD = tempProject();
  init({ targetDir: TD, packageRoot: repoRoot, serverLaunch: LAUNCH });
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const setRecord = (dir: string, dest: string, hash: string | null) => {
    const rp = path.join(dir, "modelguild/.modelguild-install.json");
    const r = readJson(rp);
    if (hash === null) delete r.files[dest];
    else r.files[dest] = hash;
    writeFileSync(rp, JSON.stringify(r, null, 2) + "\n");
  };
  const D_STALE = ".claude/commands/guild/consult.md";
  const D_EDIT_CURRENT = ".claude/commands/guild/panel.md";
  const D_NOT_OURS = ".claude/commands/guild/review.md";
  // (i) drifted: edited + record points at a release the shipped bytes have moved past.
  writeFileSync(path.join(TD, D_STALE), "MY EDIT OF AN OLD RELEASE\n");
  setRecord(TD, D_STALE, sha("AN OLDER RELEASE\n"));
  // (ii) control — edited, but the record still holds the CURRENT shipped hash (no drift).
  writeFileSync(path.join(TD, D_EDIT_CURRENT), "MY EDIT OF THE CURRENT RELEASE\n");
  // (iii) control — no record at all: never ours, so "stale" would be a guess, not a finding.
  writeFileSync(path.join(TD, D_NOT_OURS), "MY OWN REVIEW COMMAND\n");
  setRecord(TD, D_NOT_OURS, null);

  const resd = init({ targetDir: TD, packageRoot: repoRoot, serverLaunch: LAUNCH });
  c.check(resd.drifted.length === 1, `drift: exactly one file reported stale (got ${resd.drifted.length})`);
  c.check(resd.drifted[0]?.dest === D_STALE, "drift: names the ours-but-stale command doc");
  c.check(
    resd.drifted[0]?.installedPath === path.join(TD, D_STALE),
    "drift: carries the absolute path of the user's copy (for a diff hint)",
  );
  c.check(
    resd.drifted[0]?.shippedPath === path.join(repoRoot, D_STALE),
    "drift: carries the absolute path of the shipped bytes (for a diff hint)",
  );
  c.check(
    !resd.drifted.some((d) => d.dest === D_EDIT_CURRENT),
    "drift: an edit against the still-shipped version is NOT drift",
  );
  c.check(
    !resd.drifted.some((d) => d.dest === D_NOT_OURS),
    "drift: a file with no ownership record is NOT drift (never ours — no basis to call it stale)",
  );
  c.check(
    readFileSync(path.join(TD, D_STALE), "utf8") === "MY EDIT OF AN OLD RELEASE\n",
    "drift: the stale file is still NOT clobbered (report only)",
  );
  c.check(
    resd.skipped.includes(D_STALE),
    "drift: the stale file is still reported skipped (drift is additive to the skip)",
  );
  c.check(
    resd.warnings.some((w) => w.includes(D_STALE) && /stale/i.test(w)),
    "drift: the per-file skip warning says the copy is stale",
  );
  c.check(
    resd.warnings.some((w) => w.includes(D_EDIT_CURRENT) && /not stale/i.test(w)),
    "drift: the non-stale edited file's warning says so explicitly (never claims staleness)",
  );
  // The record must NOT be advanced for a skipped file — the recorded hash is the evidence that
  // the copy is behind, so a re-run must keep reporting it until the user acts.
  const recd = readJson(path.join(TD, "modelguild/.modelguild-install.json"));
  c.check(recd.files[D_STALE] === sha("AN OLDER RELEASE\n"), "drift: the recorded hash survives the skip");
  const resd2 = init({ targetDir: TD, packageRoot: repoRoot, serverLaunch: LAUNCH });
  c.check(resd2.drifted.length === 1, "drift: a further re-run still reports it (not a one-shot warning)");
  // Deleting the stale copy and re-running is the documented way to take the shipped version.
  rmSync(path.join(TD, D_STALE));
  const resd3 = init({ targetDir: TD, packageRoot: repoRoot, serverLaunch: LAUNCH });
  c.check(resd3.installed.includes(D_STALE), "drift: deleting the file and re-running installs the shipped version");
  c.check(resd3.drifted.length === 0, "drift: nothing stale remains after adopting the shipped version");

  // isDrifted's three-hash predicate, directly (the shared rule init and doctor both use).
  c.check(isDrifted("a", "b", "c"), "isDrifted: three distinct hashes ⇒ stale");
  c.check(!isDrifted(undefined, "b", "c"), "isDrifted: no record ⇒ not ours ⇒ not stale");
  c.check(!isDrifted("a", "a", "c"), "isDrifted: unedited ⇒ not stale (the upgrade handles it)");
  c.check(!isDrifted("a", "c", "c"), "isDrifted: already equals the shipped bytes ⇒ not stale");
  c.check(!isDrifted("a", "b", "a"), "isDrifted: release unchanged since the edit ⇒ not stale");

  // --- issue #94: PAYLOAD SKEW — ours, UNTOUCHED, and behind the release ---------
  //
  // The state #22 is deliberately silent about, and the one this issue exists for: the MCP
  // server updates itself via npx, the payload in the user's repo does not, so a CLEAN install
  // ends up behind with nothing edited and nothing skipped. Nothing warned about it.
  //
  // "Shipped" is the payload of the package the running code was loaded from, so these cases
  // build a FAKE package root (payload + a package.json version) and move it on — which is
  // exactly what a release does, and lets the version-keyed suppression below be driven
  // without publishing anything.
  const fakePackage = (version: string, mutate?: (root: string) => void): string => {
    const root = tempProject();
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "modelguild", version }) + "\n");
    for (const { src } of payloadFiles()) {
      const dst = path.join(root, src);
      mkdirSync(path.dirname(dst), { recursive: true });
      copyFileSync(path.join(repoRoot, src), dst);
    }
    mutate?.(root);
    return root;
  };
  const CONSULT = ".claude/commands/guild/consult.md";
  const bumpConsult = (root: string) => {
    writeFileSync(path.join(root, CONSULT), readFileSync(path.join(root, CONSULT), "utf8") + "\n<!-- next release -->\n");
  };
  // A DIFFERENT payload mutation than `bumpConsult` — used to simulate a republish/moving
  // dist-tag/source-checkout iteration that changes the shipped BYTES without bumping the
  // version string (issue #145).
  const bumpConsultDifferently = (root: string) => {
    writeFileSync(
      path.join(root, CONSULT),
      readFileSync(path.join(root, CONSULT), "utf8") + "\n<!-- a DIFFERENT follow-up release -->\n",
    );
  };

  const PKG_V1 = fakePackage("1.0.0");
  const PKG_V2 = fakePackage("2.0.0", bumpConsult);
  const PKG_V3 = fakePackage("3.0.0", bumpConsult); // same payload as V2, newer version

  c.check(packageVersion(PKG_V2) === "2.0.0", "packageVersion reads the running package's version");
  c.check(packageVersion(tempProject()) === "", "packageVersion returns '' when package.json is absent (never throws)");

  // A project installed from V1, then measured against V2: one file is behind, untouched.
  const TS = tempProject();
  init({ targetDir: TS, packageRoot: PKG_V1, serverLaunch: LAUNCH });
  const skewDirs = resolveGlobalDirs({ homeDir: tempProject(), xdgConfigHome: tempProject() });
  const scanAgainst = (pkg: string, target = TS) =>
    scanInstalledPayload({ packageRoot: pkg, targetDir: target, global_dirs: skewDirs });

  const sameRelease = scanAgainst(PKG_V1);
  c.check(
    sameRelease.skewed.length === 0 && sameRelease.drifted.length === 0 && sameRelease.unknown.length === 0,
    "skew: a clean install measured against the release it came from is clean",
  );

  const behind = scanAgainst(PKG_V2);
  c.check(behind.skewed.length === 1, `skew: a clean install behind the release reports 1 skewed file (got ${behind.skewed.length})`);
  c.check(behind.skewed[0]?.dest === CONSULT, "skew: names the file the release moved on");
  c.check(behind.skewed[0]?.installedPath === path.join(TS, CONSULT), "skew: carries the absolute installed path");
  c.check(behind.skewed[0]?.shippedPath === path.join(PKG_V2, CONSULT), "skew: carries the absolute shipped path");
  c.check(
    behind.skewed[0]?.installedHash !== behind.skewed[0]?.shippedHash,
    "skew: carries the recorded(=installed) vs shipped hashes that decided it",
  );
  c.check(behind.drifted.length === 0, "skew: an untouched file behind the release is NOT reported as drift");
  c.check(behind.unknown.length === 0, "skew: an untouched file behind the release is NOT reported as unjudgeable");

  // (ii) an EDITED file the release also moved is still DRIFT, never reclassified as skew.
  const TSD = tempProject();
  init({ targetDir: TSD, packageRoot: PKG_V1, serverLaunch: LAUNCH });
  writeFileSync(path.join(TSD, CONSULT), "MY EDIT OF AN OLD RELEASE\n");
  setRecord(TSD, CONSULT, sha("AN OLDER RELEASE\n"));
  const edited = scanAgainst(PKG_V2, TSD);
  c.check(edited.drifted.length === 1 && edited.drifted[0]?.dest === CONSULT, "skew: an edited file the release moved is DRIFT");
  c.check(edited.skewed.length === 0, "skew: drift is NOT reclassified as skew");

  // (iii) an EDITED file the release still ships (recorded === shipped) is NEITHER.
  const TSE = tempProject();
  init({ targetDir: TSE, packageRoot: PKG_V1, serverLaunch: LAUNCH });
  writeFileSync(path.join(TSE, CONSULT), "MY EDIT OF THE CURRENT RELEASE\n");
  const editedCurrent = scanAgainst(PKG_V1, TSE);
  c.check(
    editedCurrent.skewed.length === 0 && editedCurrent.drifted.length === 0 && editedCurrent.unknown.length === 0,
    "skew: an edit against the version the release still ships is neither skew nor drift",
  );

  // (iv) NO ownership record ⇒ still unjudgeable. Guessing "behind" here would be a guess.
  const TSN = tempProject();
  init({ targetDir: TSN, packageRoot: PKG_V1, serverLaunch: LAUNCH });
  setRecord(TSN, CONSULT, null);
  const noRecord = scanAgainst(PKG_V2, TSN);
  c.check(noRecord.unknown.length === 1 && noRecord.unknown[0]?.dest === CONSULT, "skew: no record ⇒ unjudgeable");
  c.check(noRecord.skewed.length === 0, "skew: an unrecorded difference is NOT guessed as skew");

  // (v) --global: skew judged against the GLOBAL record and the GLOBAL location.
  const SG_HOME = tempProject();
  const SG_XDG = tempProject();
  init({ targetDir: tempProject(), packageRoot: PKG_V1, serverLaunch: LAUNCH, global: true, homeDir: SG_HOME, xdgConfigHome: SG_XDG });
  const gScan = scanInstalledPayload({
    packageRoot: PKG_V2,
    targetDir: tempProject(), // an EMPTY project: nothing here can supply the answer
    global_dirs: resolveGlobalDirs({ homeDir: SG_HOME, xdgConfigHome: SG_XDG }),
  });
  c.check(gScan.skewed.length === 1, `skew: a global-only install behind the release reports skew (got ${gScan.skewed.length})`);
  c.check(
    gScan.skewed[0]?.installedPath === path.join(SG_HOME, ".claude/commands/guild/consult.md"),
    "skew: --global skew names the file in the GLOBAL commands dir, judged by the global record",
  );

  // isSkewed's predicate, directly — the second half of the three-state rule.
  c.check(isSkewed("a", "a", "b"), "isSkewed: ours, untouched, behind the release ⇒ skew");
  c.check(!isSkewed(undefined, "a", "b"), "isSkewed: no record ⇒ not ours ⇒ unjudgeable, not skew");
  c.check(!isSkewed("a", "b", "c"), "isSkewed: edited ⇒ drift's case, not skew");
  c.check(!isSkewed("a", "a", "a"), "isSkewed: identical to the shipped bytes ⇒ not skew");
  c.check(!isDrifted("a", "a", "b"), "isDrifted: an untouched file behind the release is skew, NOT drift");

  // --- issue #94: the START-UP NOTICE — once per server version + payload state, silenceable -
  {
    const noticeHome = tempProject();
    let out: string[] = [];
    const base = {
      env: {} as NodeJS.ProcessEnv,
      cwd: TS,
      home: noticeHome,
      xdgConfigHome: tempProject(),
      write: (t: string) => { out.push(t); },
    };
    // The state lives in the GLOBAL guild root, never in the project (review finding M3).
    const statePath = noticeStatePath({ env: {}, home: noticeHome });
    c.check(
      statePath === path.join(noticeHome, ".claude/modelguild/.modelguild-notice.json"),
      "notice: state resolves to the GLOBAL guild root, not the project",
    );

    // (1) skew present, never announced ⇒ it fires.
    const n1 = emitPayloadSkewNotice({ ...base, packageRoot: PKG_V2 });
    c.check(n1.outcome === null, `notice: fires when a clean install is behind the release (outcome ${n1.outcome})`);
    c.check(n1.skewed.length === 1, "notice: reports the skewed file");
    c.check(out.join("").includes(CONSULT), "notice: names the file that is behind");
    c.check(out.join("").includes("OUT OF SYNC"), "notice: says the file does not match what this server ships");
    c.check(out.join("").includes("GUILD_PAYLOAD_NOTICE=off"), "notice: names the knob that silences it");
    c.check(out.length === 1, "notice: written as ONE block (stderr is shared with the serve child)");
    c.check(n1.statePath === statePath, "notice: reports where it filed the announcement");
    // M2: the remedy must CONVERGE. Plain `npx modelguild init` resolves the LATEST dist-tag,
    // which does not converge when the server is a deliberately pinned older release — the
    // exact case the direction-neutral wording exists for.
    c.check(
      out.join("").includes("npx modelguild@2.0.0 init"),
      "notice: the fix is PINNED to the running version (plain `init` takes latest and may not converge)",
    );
    c.check(
      /plain `npx modelguild init` installs the LATEST/.test(out.join("")),
      "notice: says why the unpinned command is not the fix",
    );
    // NOTHING is written into the user's repo — the population this fires for has by definition
    // not re-run `init`, so an ignore line in init's block would arrive too late to help.
    c.check(
      !existsSync(path.join(TS, "modelguild/.modelguild-notice.json")),
      "notice: writes NOTHING into the project (no untracked file appears in the user's repo)",
    );
    c.check(
      !readFileSync(path.join(TS, ".gitignore"), "utf8").includes(".modelguild-notice.json"),
      "notice: init's .gitignore block carries no line for it either (there is nothing to ignore)",
    );
    // Keyed on the ownership RECORD that judged the files, so what is announced and what counts
    // as announced come from one place (review finding L2).
    c.check(
      n1.key === path.join(TS, "modelguild/.modelguild-install.json"),
      "notice: the suppression key is the ownership record the skew was judged against",
    );
    c.check(
      readNoticeState(statePath).seen[n1.key]?.version === "2.0.0",
      "notice: records the server VERSION it announced, under that key (not a session marker)",
    );
    // issue #145: the suppression key also carries a payload FINGERPRINT, as a separate field.
    c.check(
      typeof readNoticeState(statePath).seen[n1.key]?.fingerprint === "string" &&
        (readNoticeState(statePath).seen[n1.key]?.fingerprint?.length ?? 0) > 0,
      "notice: the recorded entry also carries a payload fingerprint, alongside the version",
    );
    c.check(
      n1.fingerprint !== null && n1.fingerprint === readNoticeState(statePath).seen[n1.key]?.fingerprint,
      "notice: the result reports the same fingerprint that was recorded",
    );
    // The suppression state must NOT live in — or disturb — the ownership record: that file is
    // the sole basis for never-clobber and hash-verified uninstall.
    const recAfter = readJson(path.join(TS, "modelguild/.modelguild-install.json"));
    c.check(
      typeof recAfter.files?.[CONSULT] === "string" && recAfter.seen === undefined,
      "notice: the ownership record is untouched and carries no notice state (separate files)",
    );

    // (2) same version again ⇒ silent (per VERSION, not per session).
    out = [];
    const n2 = emitPayloadSkewNotice({ ...base, packageRoot: PKG_V2 });
    c.check(n2.outcome === "already-shown", `notice: does NOT fire again for the same server version (outcome ${n2.outcome})`);
    c.check(out.length === 0, "notice: nothing is written on the second start at the same version");

    // (3) a NEW version with the same skew ⇒ it fires again.
    out = [];
    const n3 = emitPayloadSkewNotice({ ...base, packageRoot: PKG_V3 });
    c.check(n3.outcome === null, `notice: fires again for a NEW server version (outcome ${n3.outcome})`);
    c.check(out.join("").includes("3.0.0"), "notice: names the new server version");

    // (4) the knob silences it — via env AND via the layered conf file.
    out = [];
    const n4 = emitPayloadSkewNotice({ ...base, env: { GUILD_PAYLOAD_NOTICE: "off" }, packageRoot: fakePackage("4.0.0", bumpConsult) });
    c.check(n4.outcome === "knob-off", `notice: GUILD_PAYLOAD_NOTICE=off (env) suppresses it (outcome ${n4.outcome})`);
    c.check(out.length === 0, "notice: nothing is written with the knob off");
    writeFileSync(path.join(TS, "modelguild/modelguild.conf.local"), "GUILD_PAYLOAD_NOTICE=off\n");
    const n5 = emitPayloadSkewNotice({ ...base, packageRoot: fakePackage("5.0.0", bumpConsult) });
    c.check(n5.outcome === "knob-off", `notice: the conf file silences it too (file-based config, outcome ${n5.outcome})`);
    c.check(out.length === 0, "notice: nothing is written with the conf knob off");
    rmSync(path.join(TS, "modelguild/modelguild.conf.local"));

    // (5) no skew at all ⇒ nothing, and nothing recorded.
    out = [];
    const clean = tempProject();
    init({ targetDir: clean, packageRoot: PKG_V1, serverLaunch: LAUNCH });
    const n6 = emitPayloadSkewNotice({ ...base, cwd: clean, packageRoot: PKG_V1 });
    c.check(n6.outcome === "no-skew", `notice: silent when the payload matches the release (outcome ${n6.outcome})`);
    c.check(
      readNoticeState(noticeStatePath({ env: {}, home: noticeHome })).seen[
        path.join(clean, "modelguild/.modelguild-install.json")
      ] === undefined,
      "notice: a healthy install files nothing (no key recorded for it)",
    );

    // (6) FAILURE-PROOF: a broken environment degrades the notice, never throws. The package
    //     root is a file rather than a directory, so every payload read fails.
    out = [];
    const brokenPkg = path.join(tempProject(), "not-a-dir");
    writeFileSync(brokenPkg, "x");
    let threw = false;
    let n7;
    try {
      n7 = emitPayloadSkewNotice({ ...base, packageRoot: brokenPkg });
    } catch { threw = true; }
    c.check(!threw, "notice: an unreadable package root does not throw (it may never take the server down)");
    c.check(n7?.outcome === "no-skew" || n7?.outcome === "error", `notice: it degrades to a reported outcome (${n7?.outcome})`);

    // (7) M4 — a FIFO at the state path must NOT BLOCK. `readFileSync` on a FIFO with no writer
    //     hangs, and no try/catch can reach a block: the server would never reach `connect`.
    //     The `lstat`-is-a-regular-file gate is what makes this return at all.
    {
      const fifoHome = tempProject();
      const fifoState = noticeStatePath({ env: {}, home: fifoHome });
      mkdirSync(path.dirname(fifoState), { recursive: true });
      let madeFifo = false;
      try {
        execFileSync("mkfifo", [fifoState]);
        madeFifo = true;
      } catch {
        /* no mkfifo on this platform — the guard is still asserted by the directory case below */
      }
      if (madeFifo) {
        const t0 = Date.now();
        const state = readNoticeState(fifoState);
        c.check(
          Object.keys(state.seen).length === 0 && Date.now() - t0 < 2000,
          "notice: a FIFO at the state path reads as 'never shown' and does NOT block the server",
        );
        out = [];
        const nf = emitPayloadSkewNotice({ ...base, home: fifoHome, packageRoot: PKG_V2 });
        c.check(nf.outcome === null, "notice: it still announces (the unreadable state re-arms, never silences)");
        unlinkSync(fifoState);
      }
      // A DIRECTORY at the state path: unreadable AND unwritable, so it re-arms every time.
      const dirHome = tempProject();
      const dirState = noticeStatePath({ env: {}, home: dirHome });
      mkdirSync(dirState, { recursive: true });
      c.check(
        Object.keys(readNoticeState(dirState).seen).length === 0,
        "notice: a directory at the state path reads as 'never shown' rather than throwing",
      );
      out = [];
      const nd1 = emitPayloadSkewNotice({ ...base, home: dirHome, packageRoot: PKG_V2 });
      const nd2 = emitPayloadSkewNotice({ ...base, home: dirHome, packageRoot: PKG_V2 });
      c.check(
        nd1.stateWriteFailed === true && nd2.outcome === null,
        "notice: an unwritable state means it fires on EVERY start — the honest cost, reported as stateWriteFailed",
      );
    }

    // (8) M5 — the write must NOT FOLLOW A SYMLINK at the state path. `writeFileSync` did,
    //     creating a file outside the guild root; the temp-file + `rename` replaces the LINK.
    {
      const symHome = tempProject();
      const symState = noticeStatePath({ env: {}, home: symHome });
      const outside = path.join(tempProject(), "escaped.json");
      writeFileSync(outside, "ORIGINAL\n");
      mkdirSync(path.dirname(symState), { recursive: true });
      symlinkSync(outside, symState);
      out = [];
      emitPayloadSkewNotice({ ...base, home: symHome, packageRoot: PKG_V2 });
      c.check(
        readFileSync(outside, "utf8") === "ORIGINAL\n",
        "notice: the state write does NOT follow a symlink out of the guild root (rename replaces the link)",
      );
      c.check(
        !lstatSync(symState).isSymbolicLink() && readNoticeState(symState).seen !== undefined,
        "notice: the symlink itself is replaced by the real state file",
      );
    }

    // (9) L1/L2 — the key is the RECORD, so a GLOBAL-only payload is announced ONCE across the
    //     projects that share it, even when each project has its own `modelguild/` (which
    //     /guild:configure creates). A root-derived key re-announced it per project.
    {
      const shHome = tempProject();
      const shXdg = tempProject();
      init({ targetDir: tempProject(), packageRoot: PKG_V1, serverLaunch: LAUNCH, global: true, homeDir: shHome, xdgConfigHome: shXdg });
      // Two DIFFERENT projects, each with its own modelguild/ dir but no project payload.
      const projA = tempProject();
      const projB = tempProject();
      for (const p of [projA, projB]) mkdirSync(path.join(p, "modelguild"), { recursive: true });
      const shBase = {
        env: {} as NodeJS.ProcessEnv,
        home: shHome,
        xdgConfigHome: shXdg,
        packageRoot: PKG_V2,
        write: (t: string) => { out.push(t); },
      };
      out = [];
      const a1 = emitPayloadSkewNotice({ ...shBase, cwd: projA });
      const b1 = emitPayloadSkewNotice({ ...shBase, cwd: projB });
      c.check(a1.outcome === null, "notice: the shared global payload is announced in the first project");
      c.check(
        a1.key === path.join(shHome, ".claude/modelguild/.modelguild-install.json"),
        "notice: a global-only payload keys on the GLOBAL ownership record",
      );
      c.check(
        b1.outcome === "already-shown",
        `notice: the SAME global payload is not re-announced in a second project (outcome ${b1.outcome})`,
      );
    }

    // (10) L6/$GUILD_ROOT — an explicitly pinned root takes the state too ("guild state lives
    //      here"), instead of the notice silently writing into the user's home.
    {
      const pinned = tempProject();
      c.check(
        noticeStatePath({ env: { GUILD_ROOT: pinned }, home: tempProject() }) ===
          path.join(pinned, ".modelguild-notice.json"),
        "notice: $GUILD_ROOT takes the suppression state (an explicitly pinned root stays the whole answer)",
      );
    }

    // --- issue #145: the payload FINGERPRINT joins the suppression key -------------------
    // Each of these gets its own fresh home/project so it cannot be perturbed by — or perturb —
    // the version-only assertions above.

    // (11) Same version, IDENTICAL shipped payload ⇒ suppressed, same as before #145 — but now
    //      because BOTH fields match, not just the version.
    {
      const fpHome = tempProject();
      const fpProj = tempProject();
      init({ targetDir: fpProj, packageRoot: PKG_V1, serverLaunch: LAUNCH });
      const fpBase = {
        env: {} as NodeJS.ProcessEnv,
        cwd: fpProj,
        home: fpHome,
        xdgConfigHome: tempProject(),
        write: (t: string) => { out.push(t); },
      };
      const fpStatePath = noticeStatePath({ env: {}, home: fpHome });

      out = [];
      const fp1 = emitPayloadSkewNotice({ ...fpBase, packageRoot: PKG_V2 });
      c.check(fp1.outcome === null, `notice/fingerprint: fires on a fresh skew (outcome ${fp1.outcome})`);
      const entry1 = readNoticeState(fpStatePath).seen[fp1.key];
      c.check(
        entry1?.version === "2.0.0" && typeof entry1?.fingerprint === "string" && entry1.fingerprint.length > 0,
        "notice/fingerprint: the recorded entry carries version and fingerprint as separate fields",
      );

      out = [];
      const fp2 = emitPayloadSkewNotice({ ...fpBase, packageRoot: PKG_V2 });
      c.check(
        fp2.outcome === "already-shown",
        `notice/fingerprint: identical version+payload stays suppressed (outcome ${fp2.outcome})`,
      );

      // (12) Same version, DIFFERENT shipped payload — a republish, a moving dist-tag, or
      //      source-checkout iteration. The version alone would have suppressed this; the
      //      fingerprint is exactly what makes it fire again.
      const PKG_V2_REPUBLISH = fakePackage("2.0.0", bumpConsultDifferently);
      out = [];
      const fp3 = emitPayloadSkewNotice({ ...fpBase, packageRoot: PKG_V2_REPUBLISH });
      c.check(
        fp3.outcome === null,
        `notice/fingerprint: a same-version republish with different shipped bytes re-fires (outcome ${fp3.outcome})`,
      );
      const entry3 = readNoticeState(fpStatePath).seen[fp3.key];
      c.check(
        typeof entry3?.fingerprint === "string" && entry3.fingerprint !== entry1?.fingerprint,
        "notice/fingerprint: the stored fingerprint changed to match the new shipped bytes",
      );

      // And it is suppressed again once the new fingerprint is the recorded one.
      out = [];
      const fp4 = emitPayloadSkewNotice({ ...fpBase, packageRoot: PKG_V2_REPUBLISH });
      c.check(
        fp4.outcome === "already-shown",
        `notice/fingerprint: suppressed again once the new fingerprint is recorded (outcome ${fp4.outcome})`,
      );
    }

    // (13) BACKWARD COMPATIBILITY: a state file written before #145 held the bare version
    //      string. That must NOT suppress the new key (my instruction: err toward telling) —
    //      the notice fires once more and the entry is upgraded to carry both fields.
    {
      const legHome = tempProject();
      const legProj = tempProject();
      init({ targetDir: legProj, packageRoot: PKG_V1, serverLaunch: LAUNCH });
      const legBase = {
        env: {} as NodeJS.ProcessEnv,
        cwd: legProj,
        home: legHome,
        xdgConfigHome: tempProject(),
        write: (t: string) => { out.push(t); },
      };
      const legStatePath = noticeStatePath({ env: {}, home: legHome });
      const legKey = path.join(legProj, "modelguild/.modelguild-install.json");

      mkdirSync(path.dirname(legStatePath), { recursive: true });
      writeFileSync(legStatePath, JSON.stringify({ version: 1, seen: { [legKey]: "2.0.0" } }, null, 2) + "\n");
      c.check(
        readNoticeState(legStatePath).seen[legKey]?.version === "2.0.0" &&
          readNoticeState(legStatePath).seen[legKey]?.fingerprint === undefined,
        "notice/fingerprint: a hand-written legacy entry reads back as version-only, no fingerprint",
      );

      out = [];
      const leg1 = emitPayloadSkewNotice({ ...legBase, packageRoot: PKG_V2 });
      c.check(
        leg1.outcome === null,
        `notice/fingerprint: a legacy version-only entry does NOT suppress the new key (outcome ${leg1.outcome})`,
      );
      const upgraded = readNoticeState(legStatePath).seen[legKey];
      c.check(
        upgraded?.version === "2.0.0" && typeof upgraded?.fingerprint === "string" && upgraded.fingerprint.length > 0,
        "notice/fingerprint: the legacy entry is rewritten to carry both fields on this same run",
      );

      // Once upgraded, the identical payload is suppressed as normal.
      out = [];
      const leg2 = emitPayloadSkewNotice({ ...legBase, packageRoot: PKG_V2 });
      c.check(
        leg2.outcome === "already-shown",
        `notice/fingerprint: the upgraded entry suppresses normally afterwards (outcome ${leg2.outcome})`,
      );
    }

    // (14) An UNCOMPUTABLE fingerprint must suppress NOTHING — same direction as an unreadable
    //      version — and it fires on EVERY start while it stays uncomputable, never recording a
    //      half-formed entry.
    {
      const uHome = tempProject();
      const uProj = tempProject();
      init({ targetDir: uProj, packageRoot: PKG_V1, serverLaunch: LAUNCH });
      const uBase = {
        env: {} as NodeJS.ProcessEnv,
        cwd: uProj,
        home: uHome,
        xdgConfigHome: tempProject(),
        write: (t: string) => { out.push(t); },
        computeFingerprint: () => null,
      };

      out = [];
      const u1 = emitPayloadSkewNotice({ ...uBase, packageRoot: PKG_V2 });
      c.check(
        u1.outcome === null,
        `notice/fingerprint: an uncomputable fingerprint still announces, never silences (outcome ${u1.outcome})`,
      );
      c.check(u1.fingerprint === null, "notice/fingerprint: the result reports the uncomputable fingerprint as null");
      c.check(
        readNoticeState(noticeStatePath({ env: {}, home: uHome })).seen[u1.key] === undefined,
        "notice/fingerprint: nothing is recorded when the fingerprint could not be computed",
      );

      out = [];
      const u2 = emitPayloadSkewNotice({ ...uBase, packageRoot: PKG_V2 });
      c.check(
        u2.outcome === null,
        `notice/fingerprint: it keeps firing on every start while the fingerprint stays uncomputable (outcome ${u2.outcome})`,
      );
    }

    // (15) Direct unit coverage of `payloadFingerprint` itself, independent of the emitter.
    {
      const validEntry: PayloadFileState = {
        dest: "x",
        installedPath: "/a",
        shippedPath: "/b",
        installedHash: "h1",
        shippedHash: "h2",
        recordPath: "/r",
      };
      c.check(
        payloadFingerprint([]) === null,
        "payloadFingerprint: an empty skew set is uncomputable (defensive — the emitter never calls it this way)",
      );
      c.check(
        payloadFingerprint([{ ...validEntry, shippedHash: "" }]) === null,
        "payloadFingerprint: a malformed entry (empty shipped hash) is uncomputable rather than guessed",
      );
      const fpA = payloadFingerprint([validEntry]);
      const fpB = payloadFingerprint([validEntry]);
      c.check(typeof fpA === "string" && fpA === fpB, "payloadFingerprint: deterministic for the same input");
      const other: PayloadFileState = { ...validEntry, dest: "y", shippedHash: "h3" };
      const comboAB = payloadFingerprint([validEntry, other]);
      const comboBA = payloadFingerprint([other, validEntry]);
      c.check(
        typeof comboAB === "string" && comboAB === comboBA,
        "payloadFingerprint: order-independent (sorted before hashing, mirrors noticeKeyFor)",
      );
      c.check(comboAB !== fpA, "payloadFingerprint: a different skewed set produces a different fingerprint");
    }
  }

  // --- issue #94: the WIRING — a REAL `src/server.ts` emits the notice on stderr ----
  // The block above proves the emitter; only this proves server.ts actually calls it, that the
  // line lands on STDERR (stdout is the MCP transport), and that the suppression survives
  // across PROCESSES — which is the whole point of putting it in a file.
  //
  // Offline: the notice (like the #23 retention prune) happens before `connect`, no opencode
  // child is ever spawned, and the process exits on the stdin EOF we hand it. "Shipped" for a
  // real server is the repo it is running from, so skew is simulated by moving the INSTALLED
  // bytes and recording that same hash as ours — untouched-since-install, behind the release.
  {
    const SW = tempProject();
    init({ targetDir: SW, packageRoot: repoRoot, serverLaunch: LAUNCH });
    const swBytes = "AN OLDER RELEASE OF REVIEW\n";
    const SW_DEST = ".claude/commands/guild/review.md";
    writeFileSync(path.join(SW, SW_DEST), swBytes);
    setRecord(SW, SW_DEST, sha(swBytes));

    const swHome = tempProject();
    const runServer = async (): Promise<{ code: number; stdout: string; stderr: string }> => {
      const child = spawn(tsxBin, [path.join(repoRoot, "src", "server.ts")], {
        cwd: SW,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: swHome,
          XDG_CONFIG_HOME: path.join(swHome, ".config"),
          GUILD_LOG: "off", // no run dir, no retention noise — the notice is independent of it
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.stdin.end();
      const code = await new Promise<number>((resolve) => {
        const t = setTimeout(() => { child.kill("SIGKILL"); resolve(-1); }, 30_000);
        child.on("close", (x) => { clearTimeout(t); resolve(x ?? -1); });
      });
      return { code, stdout, stderr };
    };

    const s1 = await runServer();
    c.check(s1.code === 0, `#94 wiring: src/server.ts starts and exits cleanly on stdin EOF (exit ${s1.code})`);
    c.check(/OUT OF SYNC/.test(s1.stderr), "#94 wiring: a REAL server start reports the payload skew");
    c.check(s1.stderr.includes(SW_DEST), "#94 wiring: the notice names the file that is behind");
    c.check(!/OUT OF SYNC/.test(s1.stdout), "#94 wiring: the notice is on STDERR, never stdout (the MCP channel)");
    c.check(
      existsSync(noticeStatePath({ env: {}, home: swHome })),
      "#94 wiring: the server recorded the version it announced, under the injected HOME",
    );
    c.check(
      !existsSync(path.join(SW, "modelguild/.modelguild-notice.json")),
      "#94 wiring: a REAL server start writes NOTHING into the project it serves",
    );

    const s2 = await runServer();
    c.check(!/OUT OF SYNC/.test(s2.stderr), "#94 wiring: a SECOND server start at the same version is silent");
    c.check(
      readFileSync(path.join(SW, SW_DEST), "utf8") === swBytes,
      "#94 wiring: the notice reports only — it never touches the file",
    );
  }

  // --- --write-mcp merge preserves a sibling server ------------------------
  const T2 = tempProject();
  writeFileSync(
    path.join(T2, ".mcp.json"),
    JSON.stringify({ mcpServers: { other: { command: "x", args: [] } }, someOtherKey: 1 }, null, 2),
  );
  const resm = init({ targetDir: T2, packageRoot: repoRoot, serverLaunch: LAUNCH, writeMcp: true });
  c.check(resm.mcpAction === "merged", "existing .mcp.json without our key → merged (--write-mcp)");
  const mcp2 = readJson(path.join(T2, ".mcp.json"));
  c.check(!!mcp2.mcpServers.other && !!mcp2.mcpServers.modelguild, "merge keeps the sibling server AND adds ours");
  c.check(mcp2.someOtherKey === 1, "merge preserves unrelated top-level keys");

  // --- invalid .mcp.json is refused, not clobbered (--write-mcp path) ------
  const T3 = tempProject();
  writeFileSync(path.join(T3, ".mcp.json"), "{ not json");
  let refused = false;
  try {
    init({ targetDir: T3, packageRoot: repoRoot, serverLaunch: LAUNCH, writeMcp: true });
  } catch {
    refused = true;
  }
  c.check(refused, "invalid .mcp.json is refused rather than overwritten");
  c.check(readFileSync(path.join(T3, ".mcp.json"), "utf8") === "{ not json", "the invalid .mcp.json is left untouched");

  // --- uninstall: hash-verified removal (install with --write-mcp so there is
  //     a .mcp.json key for uninstall to clean up) --------------------------
  const T4 = tempProject();
  init({ targetDir: T4, packageRoot: repoRoot, serverLaunch: LAUNCH, writeMcp: true });
  // A user file the installer never wrote must survive.
  writeFileSync(path.join(T4, ".claude/commands/guild/mine.md"), "keep me\n");
  // A user EDIT to one of our files must survive uninstall (hash no longer matches).
  writeFileSync(path.join(T4, ".claude/commands/guild/panel.md"), "edited by user\n");
  const resu = init({ targetDir: T4, packageRoot: repoRoot, serverLaunch: LAUNCH, uninstall: true });
  c.check(resu.removed.includes(".claude/commands/guild/consult.md"), "uninstall removes a pristine owned file");
  c.check(!existsSync(path.join(T4, ".opencode/agent/guild-read.md")), "uninstall removes agent defs");
  c.check(existsSync(path.join(T4, ".claude/commands/guild/mine.md")), "uninstall keeps a user's own file");
  c.check(
    existsSync(path.join(T4, ".claude/commands/guild/panel.md")),
    "uninstall keeps a file the user edited (hash mismatch → not ours to delete)",
  );
  c.check(resu.mcpAction === "removed", "uninstall removes the modelguild .mcp.json key");
  const mcpu = readJson(path.join(T4, ".mcp.json"));
  c.check(
    !mcpu.mcpServers || !Object.prototype.hasOwnProperty.call(mcpu.mcpServers, "modelguild"),
    "the modelguild key is gone after uninstall",
  );
  c.check(!existsSync(path.join(T4, "modelguild/.modelguild-install.json")), "uninstall removes the ownership record");
  const giu = existsSync(path.join(T4, ".gitignore")) ? readFileSync(path.join(T4, ".gitignore"), "utf8") : "";
  c.check(!giu.includes("ModelGuild >>>"), "uninstall strips the gitignore block");

  // --- issue #32: uninstall must NOT delete a USER-created .mcp.json key -----
  // A DEFAULT install never writes .mcp.json; a user who registered the server themselves
  // (hand-placed key or `claude mcp add -s project`) must keep it through uninstall.
  const T5 = tempProject();
  init({ targetDir: T5, packageRoot: repoRoot, serverLaunch: LAUNCH }); // default: no --write-mcp
  writeFileSync(
    path.join(T5, ".mcp.json"),
    JSON.stringify({ mcpServers: { modelguild: { command: "npx", args: ["-y", "modelguild", "serve"] } } }, null, 2) + "\n",
  );
  const res5 = init({ targetDir: T5, packageRoot: repoRoot, serverLaunch: LAUNCH, uninstall: true });
  c.check(res5.mcpAction === "kept", "uninstall reports 'kept' for a user-created modelguild key (no ownership record)");
  const m5 = readJson(path.join(T5, ".mcp.json"));
  c.check(
    !!m5.mcpServers && Object.prototype.hasOwnProperty.call(m5.mcpServers, "modelguild"),
    "the user-created modelguild key SURVIVES uninstall (never written by init → not ours to delete)",
  );
  c.check(
    res5.warnings.some((w) => w.includes("no ownership record")),
    "uninstall warns it kept the unproven key",
  );

  // --- issue #32: uninstall DOES remove a --write-mcp-written key (proven) ----
  // (T4 above already exercises this end-to-end; assert the record carries the proof.)
  const T6 = tempProject();
  init({ targetDir: T6, packageRoot: repoRoot, serverLaunch: LAUNCH, writeMcp: true });
  const rec6 = readJson(path.join(T6, "modelguild/.modelguild-install.json"));
  c.check(
    rec6.mcp && rec6.mcp.key === "modelguild" && /^[0-9a-f]{64}$/.test(rec6.mcp.entryHash),
    "--write-mcp records the mcp ownership proof (key + entry hash) in the install record",
  );
  const res6 = init({ targetDir: T6, packageRoot: repoRoot, serverLaunch: LAUNCH, uninstall: true });
  c.check(res6.mcpAction === "removed", "uninstall removes a --write-mcp-written key whose entry still matches");
  const m6 = readJson(path.join(T6, ".mcp.json"));
  c.check(
    !m6.mcpServers || !Object.prototype.hasOwnProperty.call(m6.mcpServers, "modelguild"),
    "the proven-owned modelguild key is gone after uninstall",
  );

  // --- issue #32: a USER-EDITED --write-mcp entry is kept + warned -----------
  const T7 = tempProject();
  init({ targetDir: T7, packageRoot: repoRoot, serverLaunch: LAUNCH, writeMcp: true });
  const m7path = path.join(T7, ".mcp.json");
  const m7 = readJson(m7path);
  m7.mcpServers.modelguild.args = ["--user-changed"]; // edit the entry init wrote
  writeFileSync(m7path, JSON.stringify(m7, null, 2) + "\n");
  const res7 = init({ targetDir: T7, packageRoot: repoRoot, serverLaunch: LAUNCH, uninstall: true });
  c.check(res7.mcpAction === "kept", "uninstall keeps an EDITED --write-mcp entry (hash mismatch)");
  c.check(
    readJson(m7path).mcpServers.modelguild.args[0] === "--user-changed",
    "the edited entry survives uninstall",
  );
  c.check(
    res7.warnings.some((w) => w.includes("no longer matches")),
    "uninstall warns it kept the changed key",
  );

  // --- issue #32: a LEGACY record without the mcp field → key NOT removed ----
  // Fail-safe: a pre-fix --write-mcp install has no `mcp` field; treat as NOT owned.
  const T8 = tempProject();
  init({ targetDir: T8, packageRoot: repoRoot, serverLaunch: LAUNCH, writeMcp: true });
  const rec8path = path.join(T8, "modelguild/.modelguild-install.json");
  const rec8 = readJson(rec8path);
  delete rec8.mcp; // simulate a legacy record written before the ownership proof existed
  writeFileSync(rec8path, JSON.stringify(rec8, null, 2) + "\n");
  const res8 = init({ targetDir: T8, packageRoot: repoRoot, serverLaunch: LAUNCH, uninstall: true });
  c.check(res8.mcpAction === "kept", "legacy record (no mcp field): uninstall keeps the key");
  const m8 = readJson(path.join(T8, ".mcp.json"));
  c.check(
    !!m8.mcpServers && Object.prototype.hasOwnProperty.call(m8.mcpServers, "modelguild"),
    "legacy: the key survives (can't prove init wrote it)",
  );
  c.check(
    res8.warnings.some((w) => w.includes("no ownership record")),
    "legacy: uninstall warns it kept the unproven key",
  );

  // --- issue #32: a DEFAULT re-run carries the mcp ownership proof forward ----
  // A --write-mcp install, then a plain re-run, must NOT forget it owns the key.
  const T9 = tempProject();
  init({ targetDir: T9, packageRoot: repoRoot, serverLaunch: LAUNCH, writeMcp: true });
  init({ targetDir: T9, packageRoot: repoRoot, serverLaunch: LAUNCH }); // default re-run
  const rec9 = readJson(path.join(T9, "modelguild/.modelguild-install.json"));
  c.check(rec9.mcp && rec9.mcp.key === "modelguild", "a default re-run preserves the mcp ownership proof");
  const res9 = init({ targetDir: T9, packageRoot: repoRoot, serverLaunch: LAUNCH, uninstall: true });
  c.check(res9.mcpAction === "removed", "uninstall after a default re-run still removes the proven-owned key");

  // --- GLOBAL payload install (init --global) ------------------------------
  // Inject fake home + XDG dirs so nothing touches the real ~/.claude / ~/.config.
  const G_HOME = tempProject();
  const G_XDG = tempProject();
  const gOpts = { homeDir: G_HOME, xdgConfigHome: G_XDG };
  const cmdDir = path.join(G_HOME, ".claude/commands/guild");
  const agentDir = path.join(G_XDG, "opencode/agent");
  const mgDir = path.join(G_HOME, ".claude/modelguild");

  const resg = init({ targetDir: tempProject(), packageRoot: repoRoot, serverLaunch: LAUNCH, global: true, ...gOpts });
  c.check(resg.installed.length === 13, `global install writes 13 files (got ${resg.installed.length})`);
  c.check(existsSync(path.join(cmdDir, "consult.md")), "global: command doc lands in <home>/.claude/commands/guild/");
  c.check(existsSync(path.join(cmdDir, "configure.md")), "global: configure.md lands in the global commands dir");
  c.check(existsSync(path.join(agentDir, "guild-read.md")), "global: agent def lands in <xdg>/opencode/agent/");
  c.check(existsSync(path.join(agentDir, "guild-build.md")), "global: guild-build lands in the global agent dir");
  c.check(existsSync(path.join(agentDir, "guild-research.md")), "global: guild-research lands in the global agent dir");
  c.check(existsSync(path.join(mgDir, "models.policy")), "global: policy lands in <home>/.claude/modelguild/");
  c.check(existsSync(path.join(mgDir, ".modelguild-install.json")), "global: ownership record lands in <home>/.claude/modelguild/");
  c.check(resg.mcpAction === "skipped", "global install never writes .mcp.json (skipped)");
  // The project dir must be untouched by a global install.
  c.check(!existsSync(path.join(G_HOME, ".opencode")), "global: does NOT create a project .opencode under home");

  // Global record is SEPARATE from any project record (distinct file, distinct location).
  const gRec = readJson(path.join(mgDir, ".modelguild-install.json"));
  c.check(
    Object.prototype.hasOwnProperty.call(gRec.files, ".claude/commands/guild/consult.md"),
    "global record keys by the stable project-relative dest",
  );

  // Idempotent re-run.
  const resg2 = init({ targetDir: tempProject(), packageRoot: repoRoot, serverLaunch: LAUNCH, global: true, ...gOpts });
  c.check(resg2.installed.length === 0 && resg2.skipped.length === 0, "global re-run writes 0 files (idempotent)");

  // A user-edited global file is NOT clobbered.
  const gConsult = path.join(cmdDir, "consult.md");
  writeFileSync(gConsult, "MY GLOBAL EDIT\n");
  const resg3 = init({ targetDir: tempProject(), packageRoot: repoRoot, serverLaunch: LAUNCH, global: true, ...gOpts });
  c.check(readFileSync(gConsult, "utf8") === "MY GLOBAL EDIT\n", "global: a user-edited file is not clobbered");
  c.check(resg3.skipped.includes(".claude/commands/guild/consult.md"), "global: the edited file is reported skipped");

  // issue #22: drift in GLOBAL mode must be judged against the GLOBAL record, not a project one.
  // `gConsult` above is already user-edited; point the GLOBAL record at an older release so the
  // three hashes are distinct. (A project record does not exist here at all — if the mode picked
  // the wrong record this would report nothing.)
  const gRecPath = path.join(mgDir, ".modelguild-install.json");
  const gRecNow = readJson(gRecPath);
  gRecNow.files[".claude/commands/guild/consult.md"] = sha("AN OLDER GLOBAL RELEASE\n");
  writeFileSync(gRecPath, JSON.stringify(gRecNow, null, 2) + "\n");
  const resg4 = init({ targetDir: tempProject(), packageRoot: repoRoot, serverLaunch: LAUNCH, global: true, ...gOpts });
  c.check(resg4.drifted.length === 1, `global: drift is detected via the global record (got ${resg4.drifted.length})`);
  c.check(
    resg4.drifted[0]?.installedPath === gConsult,
    "global: drift names the file in the GLOBAL commands dir, not a project path",
  );
  c.check(readFileSync(gConsult, "utf8") === "MY GLOBAL EDIT\n", "global: the stale file is still not clobbered");

  // uninstall --global removes only hash-verified files; the user-edited one survives.
  const resgu = init({ targetDir: tempProject(), packageRoot: repoRoot, serverLaunch: LAUNCH, global: true, uninstall: true, ...gOpts });
  c.check(resgu.removed.includes(".opencode/agent/guild-read.md"), "uninstall --global removes a pristine owned agent def");
  c.check(!existsSync(path.join(agentDir, "guild-read.md")), "uninstall --global deletes the agent def from the global dir");
  c.check(existsSync(gConsult), "uninstall --global keeps the user-edited file (hash mismatch)");
  c.check(!existsSync(path.join(mgDir, ".modelguild-install.json")), "uninstall --global removes the global ownership record");
  c.check(resgu.mcpAction === "unchanged", "uninstall --global does not touch any .mcp.json");

  // --- issue #156: --global through a DOTFILES-MANAGED (symlinked) config ---
  // `~/.claude` and `<xdg>/opencode` are symlinks under GNU stow / chezmoi / a hand-rolled
  // `ln -s`. Global mode follows those DIRECTORY links; project mode still refuses (below).
  const N_PAYLOAD = payloadFiles().length;
  const AGENT_DEF_COUNT = payloadFiles().filter((p) => p.dest.startsWith(".opencode/agent/")).length;
  {
    const linkHome = tempProject();
    const linkXdg = tempProject();
    const store = tempProject(); // the dotfiles backing store
    const storeClaude = path.join(store, "claude");
    const storeOpencode = path.join(store, "opencode");
    mkdirSync(storeClaude, { recursive: true });
    mkdirSync(storeOpencode, { recursive: true });
    // RELATIVE targets — what a dotfiles manager actually emits.
    const relClaude = path.relative(linkHome, storeClaude);
    const relOpencode = path.relative(linkXdg, storeOpencode);
    c.check(!path.isAbsolute(relClaude) && !path.isAbsolute(relOpencode), "symlink: the fixture links are RELATIVE");
    symlinkSync(relClaude, path.join(linkHome, ".claude"));
    symlinkSync(relOpencode, path.join(linkXdg, "opencode"));

    const linkOpts = { homeDir: linkHome, xdgConfigHome: linkXdg };
    const resL = initScored(c, "symlink: --global install through the directory links", {
      targetDir: tempProject(),
      packageRoot: repoRoot,
      serverLaunch: LAUNCH,
      global: true,
      ...linkOpts,
    });
    c.check(
      resL.installed.length === N_PAYLOAD,
      `symlink: --global through symlinked ~/.claude + <xdg>/opencode installs all ${N_PAYLOAD} files (got ${resL.installed.length}, warnings: ${resL.warnings.join(" | ")})`,
    );
    // Assert on the BACKING STORE's real paths, not through the link — that is the claim.
    c.check(
      existsSync(path.join(storeClaude, "commands/guild/consult.md")),
      "symlink: a command doc lands in the dotfiles backing store",
    );
    c.check(
      existsSync(path.join(storeOpencode, "agent/guild-read.md")),
      "symlink: an agent def lands in the backing store via the <xdg>/opencode link",
    );
    const linkRecord = path.join(storeClaude, "modelguild/.modelguild-install.json");
    c.check(existsSync(linkRecord), "symlink: the ownership record is written into the backing store");
    c.check(
      recordedFileCount(linkRecord) === N_PAYLOAD,
      `symlink: the record covers all ${N_PAYLOAD} payload files (got ${recordedFileCount(linkRecord)})`,
    );
    // The links themselves must survive — replaced by a real directory would break the dotfiles setup.
    c.check(
      lstatSync(path.join(linkHome, ".claude")).isSymbolicLink() &&
        lstatSync(path.join(linkXdg, "opencode")).isSymbolicLink(),
      "symlink: the directory links are followed, never replaced",
    );

    // Uninstall through the same links.
    const resLu = initScored(c, "symlink: --uninstall --global through the directory links", {
      targetDir: tempProject(),
      packageRoot: repoRoot,
      serverLaunch: LAUNCH,
      global: true,
      uninstall: true,
      ...linkOpts,
    });
    c.check(
      resLu.removed.length === N_PAYLOAD,
      `symlink: uninstall --global removes all ${N_PAYLOAD} files through the links (got ${resLu.removed.length})`,
    );
    c.check(
      !existsSync(path.join(storeClaude, "commands/guild/consult.md")) && !existsSync(path.join(storeOpencode, "agent/guild-read.md")),
      "symlink: uninstall deletes the files from the backing store",
    );
    c.check(!existsSync(linkRecord), "symlink: uninstall removes the ownership record from the backing store");
    c.check(
      lstatSync(path.join(linkHome, ".claude")).isSymbolicLink(),
      "symlink: uninstall leaves the directory link in place",
    );
  }

  // A LEAF payload-file symlink is settled by the OWNERSHIP RULE (issue #165, C80), so a link
  // whose bytes are NOT ours is skipped with a warning — never written through, never a throw:
  // the install completes and still writes the ownership record. A DANGLING link has no bytes at
  // all, so it cannot match and is skipped by the same rule.
  {
    const leafHome = tempProject();
    const leafXdg = tempProject();
    const store = tempProject();
    const outside = tempProject();
    const storeClaude = path.join(store, "claude");
    const storeOpencode = path.join(store, "opencode");
    mkdirSync(path.join(storeClaude, "commands/guild"), { recursive: true });
    mkdirSync(path.join(storeOpencode, "agent"), { recursive: true });
    symlinkSync(path.relative(leafHome, storeClaude), path.join(leafHome, ".claude"));
    symlinkSync(path.relative(leafXdg, storeOpencode), path.join(leafXdg, "opencode"));

    const kept = path.join(outside, "my-consult.md");
    writeFileSync(kept, "MY OWN FILE\n");
    const missing = path.join(outside, "never-created.md");
    symlinkSync(kept, path.join(storeClaude, "commands/guild/consult.md")); // live leaf link
    symlinkSync(missing, path.join(storeOpencode, "agent/guild-read.md")); // DANGLING leaf link

    const resLeaf = initScored(c, "symlink leaf: --global install over leaf links", {
      targetDir: tempProject(),
      packageRoot: repoRoot,
      serverLaunch: LAUNCH,
      global: true,
      homeDir: leafHome,
      xdgConfigHome: leafXdg,
    });
    c.check(
      resLeaf.installed.length === N_PAYLOAD - 2,
      `symlink leaf: the other ${N_PAYLOAD - 2} files still install (got ${resLeaf.installed.length})`,
    );
    c.check(
      resLeaf.skipped.includes(".claude/commands/guild/consult.md") && resLeaf.skipped.includes(".opencode/agent/guild-read.md"),
      `symlink leaf: both linked destinations are reported skipped (got ${resLeaf.skipped.join(", ")})`,
    );
    c.check(
      resLeaf.warnings.includes(
        `skipping .claude/commands/guild/consult.md — a file you already have is there; left untouched ` +
          `(${path.join(leafHome, ".claude/commands/guild/consult.md")} is a symlink to ${kept}).`,
      ),
      `symlink leaf: the live NOT-OURS link is never-clobbered and the warning names the link AND its ` +
        `target — "I left your file alone" has to point at the file (got ${resLeaf.warnings.join(" | ")})`,
    );
    c.check(
      resLeaf.warnings.includes(
        `skipping .opencode/agent/guild-read.md — ${path.join(leafXdg, "opencode/agent/guild-read.md")} ` +
          `is a symlink to ${missing}, which is not a regular file (missing, a directory, or a FIFO); ` +
          `left untouched. A leaf link is followed only when the bytes behind it are ones init recorded, ` +
          `and there are none.`,
      ),
      `symlink leaf: the DANGLING link warns by name rather than being written through (got ${resLeaf.warnings.join(" | ")})`,
    );
    c.check(readFileSync(kept, "utf8") === "MY OWN FILE\n", "symlink leaf: the live link's target is not overwritten");
    c.check(!existsSync(missing), "symlink leaf: the dangling link's target is NOT created by the write");
    c.check(
      existsSync(path.join(storeClaude, "modelguild/.modelguild-install.json")),
      "symlink leaf: a skipped leaf does not stop the ownership record being written",
    );
    // C79 is untouched by C80, in BOTH directions and for opposite reasons: a live link to a
    // regular file RESOLVES, so a never-clobber skip is still exit 0; a dangling one resolves to
    // nothing, so that payload piece really is missing and the run is exit 1.
    c.check(
      !(resLeaf.blocked ?? []).includes(".claude/commands/guild/consult.md") &&
        (resLeaf.blocked ?? []).includes(".opencode/agent/guild-read.md"),
      `symlink leaf: C79 blocked = the DANGLING leaf only (got ${JSON.stringify(resLeaf.blocked ?? [])})`,
    );
  }

  // ISSUE #165 / C80 — THE PER-FILE (stow/chezmoi) LAYOUT UPGRADES.
  //
  // The defect this replaces: a payload file the user has since stowed — the real bytes moved
  // into a dotfiles store, a symlink left at the destination — was skipped as "a non-file", so
  // the store copy stayed on whatever release wrote it, FOREVER, while `doctor` kept reporting it
  // as skew and naming `npx modelguild init` as the fix. Reproduced on the pre-fix code:
  // installed=0, blocked=[], exit 0, store copy unchanged.
  //
  // These cases are BEHAVIOURAL — they assert the bytes in the store, not just the result shape —
  // because "followed the link" and "wrote beside the link" produce identical `installed` lists.
  {
    const V1 = fakePackage("1.0.0");
    const V2 = fakePackage("2.0.0", bumpConsult);
    const CONSULT_REL = ".claude/commands/guild/consult.md";
    const v2Bytes = readFileSync(path.join(V2, CONSULT_REL), "utf8");

    // (a) OURS ⇒ WRITTEN THROUGH. Install v1 as real files, then stow one of them (rename into a
    //     store, symlink the destination at it — `stow --adopt`, chezmoi's `symlink_`), then
    //     install v2. The bytes behind the link still hash to what the record says init wrote.
    const H = tempProject();
    const X = tempProject();
    const STORE = tempProject();
    initScored(c, "C80: seed v1", {
      targetDir: tempProject(), packageRoot: V1, serverLaunch: LAUNCH, global: true, homeDir: H, xdgConfigHome: X,
    });
    const dest = path.join(H, CONSULT_REL);
    const stowed = path.join(STORE, "consult.md");
    renameSync(dest, stowed);
    symlinkSync(stowed, dest);

    const up = initScored(c, "C80: upgrade over a stowed leaf link", {
      targetDir: tempProject(), packageRoot: V2, serverLaunch: LAUNCH, global: true, homeDir: H, xdgConfigHome: X,
    });
    c.check(
      up.installed.includes(CONSULT_REL) && !up.skipped.includes(CONSULT_REL),
      `C80: a stowed leaf whose bytes are OURS is installed, not skipped (installed=${JSON.stringify(up.installed)} skipped=${JSON.stringify(up.skipped)})`,
    );
    c.check(
      readFileSync(stowed, "utf8") === v2Bytes,
      "C80: the write goes THROUGH the link — the dotfiles store copy is upgraded to v2",
    );
    c.check(
      lstatSync(dest).isSymbolicLink(),
      "C80: the link itself survives — init writes through it, it does not replace it with a regular file",
    );
    c.check(
      (up.blocked ?? []).length === 0,
      `C80: an upgraded stow layout is a clean run (blocked=${JSON.stringify(up.blocked ?? [])})`,
    );
    c.check(
      up.warnings.some((w) => w.startsWith(`wrote ${CONSULT_REL} THROUGH the symlink at ${dest} —`) && w.includes(stowed)),
      `C80: the write-through is SURFACED, naming the link and where the bytes landed (got ${up.warnings.join(" | ")})`,
    );
    // THE BOUND, ASSERTED IN THE PRODUCT'S OWN WORDS: the check that authorized this is freshness,
    // not authority, and the message has to keep saying so — "ownership" reads as more than it is.
    c.check(
      up.warnings.some((w) => w.includes("FRESHNESS check, not an authorization check")),
      "C80: the write-through warning states that the hash is a freshness check, not an authorization check",
    );
    // Idempotence: a second run against the SAME release writes nothing and so says nothing.
    const again = initScored(c, "C80: idempotent re-run over the link", {
      targetDir: tempProject(), packageRoot: V2, serverLaunch: LAUNCH, global: true, homeDir: H, xdgConfigHome: X,
    });
    c.check(
      !again.installed.includes(CONSULT_REL) && !again.warnings.some((w) => w.includes("THROUGH the symlink")),
      `C80: equal bytes ⇒ no write and no repeated warning (installed=${JSON.stringify(again.installed)})`,
    );

    // (b) UNINSTALL removes the LINK, leaves the TARGET, and names it.
    const un = initScored(c, "C80: uninstall through a stowed leaf link", {
      targetDir: tempProject(), packageRoot: V2, serverLaunch: LAUNCH, global: true, homeDir: H, xdgConfigHome: X, uninstall: true,
    });
    c.check(un.removed.includes(CONSULT_REL), `C80: the stowed leaf is removed (got ${JSON.stringify(un.removed)})`);
    c.check(
      !existsSync(dest) && lstatSync(dest, { throwIfNoEntry: false }) === undefined,
      "C80: uninstall removes the LINK",
    );
    c.check(existsSync(stowed), "C80: uninstall LEAVES the link's target in the dotfiles store");
    c.check(
      un.warnings.some((w) => w.startsWith(`removed the symlink at ${dest}, but LEFT its target ${stowed} in place`)),
      `C80: the orphaned target is NAMED (got ${un.warnings.join(" | ")})`,
    );
    // The stated consequence: a reinstall does NOT restore the stow layout.
    const re = initScored(c, "C80: reinstall after uninstall", {
      targetDir: tempProject(), packageRoot: V2, serverLaunch: LAUNCH, global: true, homeDir: H, xdgConfigHome: X,
    });
    c.check(re.installed.includes(CONSULT_REL), "C80: the reinstall places the file again");
    c.check(
      !lstatSync(dest).isSymbolicLink() && lstatSync(dest).isFile(),
      "C80 (stated cost): the reinstall writes a REGULAR FILE — the stow layout is not restored",
    );
    c.check(existsSync(stowed), "C80 (stated cost): the orphaned store copy is left behind");

    // (c) FRESHNESS, NOT AUTHORIZATION — the demonstration, kept executable so the cost cannot be
    //     quietly reworded out of the docs. The recorded hashes are of SHIPPED files, public in
    //     the npm tarball, so planting matching bytes needs no access to the ownership record.
    const H2 = tempProject();
    const X2 = tempProject();
    const VICTIMDIR = tempProject();
    initScored(c, "C80: seed v1 for the freshness demo", {
      targetDir: tempProject(), packageRoot: V1, serverLaunch: LAUNCH, global: true, homeDir: H2, xdgConfigHome: X2,
    });
    const victim = path.join(VICTIMDIR, "victim.md");
    copyFileSync(path.join(V1, CONSULT_REL), victim); // a copy of the PUBLISHED v1 payload file
    const dest2 = path.join(H2, CONSULT_REL);
    unlinkSync(dest2);
    symlinkSync(victim, dest2);
    const pwn = initScored(c, "C80: install v2 over a planted link with matching bytes", {
      targetDir: tempProject(), packageRoot: V2, serverLaunch: LAUNCH, global: true, homeDir: H2, xdgConfigHome: X2,
    });
    c.check(
      pwn.installed.includes(CONSULT_REL) && readFileSync(victim, "utf8") === v2Bytes,
      "C80 (stated cost): matching bytes at a planted link ARE written through — freshness, not authorization",
    );
    c.check(
      pwn.warnings.some((w) => w.includes(victim)),
      `C80: the write-through names the file it actually landed in (got ${pwn.warnings.join(" | ")})`,
    );

    // (d) NOT ours ⇒ still never-clobbered, which is the half that makes (c) a bounded cost
    //     rather than an unbounded one: only bytes that already match are followed.
    const H3 = tempProject();
    const X3 = tempProject();
    const OTHER = tempProject();
    initScored(c, "C80: seed v1 for the not-ours case", {
      targetDir: tempProject(), packageRoot: V1, serverLaunch: LAUNCH, global: true, homeDir: H3, xdgConfigHome: X3,
    });
    const mine = path.join(OTHER, "mine.md");
    writeFileSync(mine, "MY OWN CONSULT\n");
    const dest3 = path.join(H3, CONSULT_REL);
    unlinkSync(dest3);
    symlinkSync(mine, dest3);
    const nc = initScored(c, "C80: install v2 over a link to a file that is not ours", {
      targetDir: tempProject(), packageRoot: V2, serverLaunch: LAUNCH, global: true, homeDir: H3, xdgConfigHome: X3,
    });
    c.check(
      nc.skipped.includes(CONSULT_REL) && readFileSync(mine, "utf8") === "MY OWN CONSULT\n",
      `C80: bytes that are not ours are never clobbered through the link (skipped=${JSON.stringify(nc.skipped)})`,
    );
    c.check(
      !(nc.blocked ?? []).includes(CONSULT_REL),
      `C80: a never-clobber skip through a LIVE link still resolves, so C79 keeps it exit 0 (blocked=${JSON.stringify(nc.blocked ?? [])})`,
    );

    // (e) PROJECT MODE IS UNCHANGED — the leaf rule is global-only, inheriting C77's asymmetry.
    //     A live leaf link in a project is still REFUSED by name, at plan time, with nothing
    //     written; it is NOT followed just because its bytes happen to be ours.
    const P = tempProject();
    initScored(c, "C80: seed a project install", { targetDir: P, packageRoot: V1, serverLaunch: LAUNCH });
    const pStore = tempProject();
    const pDest = path.join(P, CONSULT_REL);
    const pStowed = path.join(pStore, "consult.md");
    renameSync(pDest, pStowed);
    symlinkSync(pStowed, pDest);
    let pMsg = "";
    try {
      init({ targetDir: P, packageRoot: V2, serverLaunch: LAUNCH });
    } catch (e) {
      pMsg = (e as Error).message;
    }
    c.check(
      pMsg.startsWith(`refusing destination symlink: ${pDest} —`),
      `C80: PROJECT mode still refuses a live leaf link even when the bytes ARE ours (got "${pMsg}")`,
    );
    c.check(
      readFileSync(pStowed, "utf8") !== v2Bytes,
      "C80: the project refusal writes nothing through the link",
    );
  }

  // ISSUE #165 REVIEW FINDINGS — the four the reviewer found, pinned so they cannot come back.
  {
    const V1 = fakePackage("1.0.0");
    const V2 = fakePackage("2.0.0", bumpConsult);
    const CONSULT_REL = ".claude/commands/guild/consult.md";
    const DEF_REL = ".opencode/agent/guild-read.md";

    // (F-1) THE RECORD LINK'S TARGET CAN BE A PAYLOAD DESTINATION, so its live/dangling state is
    // NOT stable across the run: dangling when the plan is made, LIVE by the time the record is
    // written, because the payload loop created it in between. An earlier cut computed the whole
    // warning at plan time on the reasoning that nothing could change it, and therefore announced
    // "will CREATE that file (the link is dangling)" while silently overwriting an agent def it
    // had just installed. The liveness is read beside the write; the collision is NAMED.
    {
      const H = tempProject();
      const X = tempProject();
      const defAbs = path.join(X, "opencode/agent/guild-read.md");
      mkdirSync(path.dirname(defAbs), { recursive: true }); // directory yes, FILE no
      const recLink = path.join(H, ".claude/modelguild/.modelguild-install.json");
      mkdirSync(path.dirname(recLink), { recursive: true });
      symlinkSync(defAbs, recLink);
      c.check(!existsSync(defAbs), "F-1: the record link is DANGLING when the plan is made");

      const r = initScored(c, "F-1: record link aimed at a not-yet-installed payload file", {
        targetDir: tempProject(), packageRoot: V1, serverLaunch: LAUNCH, global: true, homeDir: H, xdgConfigHome: X,
      });
      c.check(r.installed.includes(DEF_REL), `F-1: the def is installed by the loop (got ${r.installed.length} files)`);
      const w = r.warnings.find((x) => x.startsWith("writing the ownership record through a symlink"));
      c.check(w !== undefined, `F-1: the record-link warning is emitted (got ${r.warnings.join(" | ")})`);
      c.check(
        (w ?? "").includes("will REPLACE that file's contents"),
        `F-1: it reports a REPLACEMENT, because the payload loop made the link live — the plan-time ` +
          `answer ("will CREATE … dangling") was the defect (got "${w ?? ""}")`,
      );
      c.check(
        (w ?? "").includes(`THAT FILE IS A PAYLOAD DESTINATION (${DEF_REL})`),
        `F-1: the collision with a payload file is NAMED, not left reading as an ordinary overwrite ` +
          `(got "${w ?? ""}")`,
      );
      // The honest state afterwards: the def really does hold the record JSON. Asserted so the
      // severity in the docs is measured rather than asserted.
      c.check(
        readFileSync(defAbs, "utf8").includes(`"version": 1`),
        "F-1: the agent def now holds the ownership-record JSON — the outcome the warning must describe",
      );
    }

    // (F-3) THE UNINSTALL RECORD WARNING MUST NOT ASSERT A DESTRUCTION THAT DID NOT HAPPEN. Its
    // only guard was "there is a link here", which says nothing about whether an install ever
    // wrote through it.
    {
      // Never installed: the target still holds the user's bytes, and the warning must say so.
      const H = tempProject();
      const X = tempProject();
      const OUT = tempProject();
      const mine = path.join(OUT, "mine.json");
      writeFileSync(mine, "MINE\n");
      const recLink = path.join(H, ".claude/modelguild/.modelguild-install.json");
      mkdirSync(path.dirname(recLink), { recursive: true });
      symlinkSync(mine, recLink);
      const u = initScored(c, "F-3: uninstall over a record link that was never written through", {
        targetDir: tempProject(), packageRoot: V1, serverLaunch: LAUNCH, global: true, homeDir: H, xdgConfigHome: X, uninstall: true,
      });
      const w = u.warnings.find((x) => x.startsWith(`removed the symlink at ${recLink}`)) ?? "";
      c.check(w !== "", `F-3: the leftover is still named (got ${u.warnings.join(" | ")})`);
      c.check(
        w.includes("did not read as a ModelGuild ownership record") && !w.includes("which an install wrote"),
        `F-3: it makes NO claim that the file was overwritten — nothing was (got "${w}")`,
      );
      c.check(readFileSync(mine, "utf8") === "MINE\n", "F-3: and indeed the user's bytes are untouched");

      // The positive control: a real install DID write through, so the claim is made.
      const H2 = tempProject();
      const X2 = tempProject();
      const OUT2 = tempProject();
      const theirs = path.join(OUT2, "theirs.json");
      writeFileSync(theirs, "THEIRS\n");
      const recLink2 = path.join(H2, ".claude/modelguild/.modelguild-install.json");
      mkdirSync(path.dirname(recLink2), { recursive: true });
      symlinkSync(theirs, recLink2);
      initScored(c, "F-3: seed an install through the record link", {
        targetDir: tempProject(), packageRoot: V1, serverLaunch: LAUNCH, global: true, homeDir: H2, xdgConfigHome: X2,
      });
      const u2 = initScored(c, "F-3: uninstall after a real write-through", {
        targetDir: tempProject(), packageRoot: V1, serverLaunch: LAUNCH, global: true, homeDir: H2, xdgConfigHome: X2, uninstall: true,
      });
      const w2 = u2.warnings.find((x) => x.startsWith(`removed the symlink at ${recLink2}`)) ?? "";
      c.check(
        w2.includes("which an install wrote through this link"),
        `F-3 (control): where the bytes really are ours, the claim IS made (got "${w2}")`,
      );
    }

    // (F-4) A LIVE NOT-OURS LEAF LINK NOW REACHES THE DRIFT/SHADOW MACHINERY it never reached
    // before, because it is hashed rather than dismissed as a non-file. That is new OUTPUT —
    // `drifted`, `shadowed` and a paste-able diff hint — on a path that previously produced only
    // a skip. Pinned rather than redesigned, including the wording's known imprecision: the file
    // was not "edited", the LINK was repointed, and the message cannot tell the difference.
    {
      const H = tempProject();
      const X = tempProject();
      const OUT = tempProject();
      initScored(c, "F-4: seed v1", {
        targetDir: tempProject(), packageRoot: V1, serverLaunch: LAUNCH, global: true, homeDir: H, xdgConfigHome: X,
      });
      // A file of the user's whose bytes are v1's consult.md PLUS an edit — so all three hashes
      // differ and `isDrifted` fires, the state that used to be unreachable through a link.
      const theirs = path.join(OUT, "theirs.md");
      writeFileSync(theirs, readFileSync(path.join(V1, CONSULT_REL), "utf8") + "\n<!-- mine -->\n");
      const dest = path.join(H, CONSULT_REL);
      unlinkSync(dest);
      symlinkSync(theirs, dest);

      const r = initScored(c, "F-4: install v2 over a live link to an edited copy", {
        targetDir: tempProject(), packageRoot: V2, serverLaunch: LAUNCH, global: true, homeDir: H, xdgConfigHome: X,
      });
      c.check(r.skipped.includes(CONSULT_REL), "F-4: still never-clobbered");
      c.check(
        (r.drifted ?? []).some((d) => d.dest === CONSULT_REL && d.installedPath === dest),
        `F-4: it now reports DRIFT, naming the destination (the link), not the store file — new ` +
          `output on this path (got ${JSON.stringify((r.drifted ?? []).map((d) => d.dest))})`,
      );
      c.check(
        (r.shadowed ?? []).includes(CONSULT_REL),
        `F-4: and SHADOWED, since a command doc at our path is not ours (got ${JSON.stringify(r.shadowed ?? [])})`,
      );
      c.check(
        r.warnings.some((x) => x.includes("you edited it since init wrote it") && x.includes(`is a symlink to ${theirs}`)),
        `F-4: the wording says "you edited it" when the user repointed a LINK — imprecise, and ` +
          `pinned so it is a known state rather than a surprise (got ${r.warnings.join(" | ")})`,
      );
      c.check(readFileSync(theirs, "utf8").endsWith("<!-- mine -->\n"), "F-4: their file is untouched");
    }

    // (ITEM 2) TWO PAYLOAD DESTINATIONS LINKED AT ONE STORE FILE. Not a plausible stow layout,
    // but it is the shape the leaf rule makes reachable, so it is pinned rather than predicted:
    // the second file loses, silently, and the run still exits 0.
    {
      const H = tempProject();
      const X = tempProject();
      const STORE = tempProject();
      initScored(c, "item2: seed v1", {
        targetDir: tempProject(), packageRoot: V1, serverLaunch: LAUNCH, global: true, homeDir: H, xdgConfigHome: X,
      });
      const PANEL_REL = ".claude/commands/guild/panel.md";
      const one = path.join(STORE, "shared.md");
      copyFileSync(path.join(V1, CONSULT_REL), one); // ours by hash, for consult.md
      for (const rel of [CONSULT_REL, PANEL_REL]) {
        unlinkSync(path.join(H, rel));
        symlinkSync(one, path.join(H, rel));
      }
      const r = initScored(c, "item2: install v2 with two dests on one store file", {
        targetDir: tempProject(), packageRoot: V2, serverLaunch: LAUNCH, global: true, homeDir: H, xdgConfigHome: X,
      });
      c.check(
        r.installed.includes(CONSULT_REL) && !r.installed.includes(PANEL_REL),
        `item2: the first write wins and the second is skipped (installed=${JSON.stringify(r.installed)})`,
      );
      c.check(
        readFileSync(one, "utf8") === readFileSync(path.join(V2, CONSULT_REL), "utf8"),
        "item2: the shared file holds the CONSULT doc — so panel.md now serves consult's content",
      );
      c.check(
        (r.blocked ?? []).length === 0,
        `item2: and the run still exits 0, because both destinations resolve to a regular file — ` +
          `C79's test is shape, not content (blocked=${JSON.stringify(r.blocked ?? [])})`,
      );
    }
  }

  // PROJECT mode is UNCHANGED: a symlink at any existing component is refused by name.
  {
    const P = tempProject();
    const outside = tempProject();
    const target = path.join(outside, "x.md");
    writeFileSync(target, "OUTSIDE\n");
    mkdirSync(path.join(P, ".opencode/agent"), { recursive: true });
    symlinkSync(target, path.join(P, ".opencode/agent/guild-read.md"));
    let msg = "";
    try {
      init({ targetDir: P, packageRoot: repoRoot, serverLaunch: LAUNCH });
    } catch (e) {
      msg = (e as Error).message;
    }
    c.check(
      // The refusal now names the ABSOLUTE path, the offending component, the link's target and
      // a remedy (issue #167) — the old text was a bare project-relative path with no base.
      msg.startsWith(`refusing destination symlink: ${path.join(P, ".opencode/agent/guild-read.md")} —`) &&
        msg.includes(`the path component ${path.join(P, ".opencode/agent/guild-read.md")} is a symlink to '${target}'`) &&
        msg.includes(`\`rm ${path.join(P, ".opencode/agent/guild-read.md")}\``) &&
        msg.includes("`--uninstall` is not blocked by this"),
      `project mode still refuses a leaf symlink, naming the absolute path, the component and the remedy (got: ${msg || "<no throw>"})`,
    );
    c.check(
      countFiles(path.join(P, ".claude")) + countFiles(path.join(P, "modelguild")) === 0,
      "project mode: the leaf-symlink refusal lands at PLAN time — ZERO files written",
    );
    c.check(readFileSync(target, "utf8") === "OUTSIDE\n", "project mode: the refused link's target is untouched");

    // A symlinked DIRECTORY component is refused the same way.
    const P2 = tempProject();
    symlinkSync(outside, path.join(P2, ".opencode"));
    let msg2 = "";
    try {
      init({ targetDir: P2, packageRoot: repoRoot, serverLaunch: LAUNCH });
    } catch (e) {
      msg2 = (e as Error).message;
    }
    c.check(
      msg2.startsWith(`refusing destination symlink: ${path.join(P2, ".opencode/agent/")}`) &&
        msg2.includes(`the path component ${path.join(P2, ".opencode")} is a symlink`),
      `project mode still refuses a symlinked directory component, naming THAT component (got: ${msg2 || "<no throw>"})`,
    );

    // A DANGLING leaf link in project mode used to be written THROUGH — `existsSync` follows,
    // so the guard did not see it and the payload bytes landed outside the project. It now
    // reaches the same skip-with-warning branch a live link does.
    const P3 = tempProject();
    const escaped = path.join(outside, "escaped.md");
    mkdirSync(path.join(P3, ".opencode/agent"), { recursive: true });
    symlinkSync(escaped, path.join(P3, ".opencode/agent/guild-read.md"));
    const res3 = init({ targetDir: P3, packageRoot: repoRoot, serverLaunch: LAUNCH });
    c.check(!existsSync(escaped), "project mode: a DANGLING leaf link is not written through (nothing created outside)");
    c.check(
      res3.skipped.includes(".opencode/agent/guild-read.md") && res3.installed.length === N_PAYLOAD - 1,
      `project mode: the dangling leaf is skipped and the rest installs (got ${res3.installed.length} installed, skipped ${res3.skipped.join(", ")})`,
    );
  }

  // The OWNERSHIP RECORD's own path is the exception to the leaf rule: `writeRecords` sits
  // outside the install loop, so a symlink there is written THROUGH — live or dangling —
  // rather than skipped. Deliberate (only init writes the record, so there is no user content
  // it is expected to preserve), but never silent: it warns, naming the link and the file the
  // bytes actually landed in. The realistic trigger is a dotfiles manager that links files
  // individually — GNU stow does, when the parent directory already exists.
  {
    // (a) a LIVE record symlink pointing at a file of the user's own.
    const recHome = tempProject();
    const recXdg = tempProject();
    const outside = tempProject();
    const userFile = path.join(outside, "my-record.json");
    writeFileSync(userFile, "MY OWN FILE\n");
    const recLink = path.join(recHome, ".claude/modelguild/.modelguild-install.json");
    mkdirSync(path.dirname(recLink), { recursive: true });
    symlinkSync(userFile, recLink);

    const resR = initScored(c, "record symlink: --global install over a live record link", {
      targetDir: tempProject(),
      packageRoot: repoRoot,
      serverLaunch: LAUNCH,
      global: true,
      homeDir: recHome,
      xdgConfigHome: recXdg,
    });
    c.check(
      resR.installed.length === N_PAYLOAD,
      `record symlink: the payload still installs in full (got ${resR.installed.length})`,
    );
    c.check(
      resR.warnings.includes(
        // FUTURE tense since issue #165: the disclosure is produced at PLAN time, before a byte
        // moves, rather than one line above the write.
        `writing the ownership record through a symlink — ${recLink} links to ${userFile}, so the record ` +
          `will REPLACE that file's contents. Unlike a payload file, this is NOT hash-gated — there is no ` +
          `record of the record to recognise, so nothing here declines to clobber. Remove the link and ` +
          `re-run init to keep the record at ${recLink} itself.`,
      ),
      `record symlink: the live link warns, naming BOTH the link and the file written (got ${resR.warnings.join(" | ")})`,
    );
    c.check(
      lstatSync(recLink).isSymbolicLink(),
      "record symlink: the link itself survives (written through, not replaced)",
    );
    c.check(
      recordedFileCount(userFile) === N_PAYLOAD,
      `record symlink: the record bytes land in the link's target, replacing the user's file (got ${recordedFileCount(userFile)})`,
    );

    // (b) a DANGLING record symlink: `existsSync` calls it absent, so it is written through
    // too — the write CREATES the target. Same warning shape, different clause.
    const dngHome = tempProject();
    const dngXdg = tempProject();
    const dngOutside = tempProject();
    const missing = path.join(dngOutside, "never-created.json");
    const dngLink = path.join(dngHome, ".claude/modelguild/.modelguild-install.json");
    mkdirSync(path.dirname(dngLink), { recursive: true });
    symlinkSync(missing, dngLink);
    c.check(!existsSync(missing), "record symlink: the dangling link's target does not exist before the install");

    const resD = initScored(c, "record symlink: --global install over a dangling record link", {
      targetDir: tempProject(),
      packageRoot: repoRoot,
      serverLaunch: LAUNCH,
      global: true,
      homeDir: dngHome,
      xdgConfigHome: dngXdg,
    });
    c.check(
      resD.installed.length === N_PAYLOAD,
      `record symlink: the payload still installs in full over a dangling record link (got ${resD.installed.length})`,
    );
    c.check(
      resD.warnings.includes(
        `writing the ownership record through a symlink — ${dngLink} links to ${missing}, so the record ` +
          `will CREATE that file (the link is dangling). Unlike a payload file, this is NOT hash-gated — ` +
          `there is no record of the record to recognise, so nothing here declines to clobber. Remove the ` +
          `link and re-run init to keep the record at ${dngLink} itself.`,
      ),
      `record symlink: the DANGLING link warns, naming BOTH paths and saying the file was created (got ${resD.warnings.join(" | ")})`,
    );
    c.check(
      existsSync(missing) && recordedFileCount(missing) === N_PAYLOAD,
      "record symlink: the record bytes land in the dangling link's target, which the write creates",
    );
    c.check(lstatSync(dngLink).isSymbolicLink(), "record symlink: the dangling link itself survives");

    // (c) a dangling record symlink whose TARGET'S DIRECTORY does not exist is REFUSED at plan
    // time. `writeRecords` creates the LINK's directory, not the target's, so the write through
    // such a link raised a raw ENOENT — AFTER the whole payload was on disk, leaving an install
    // with no ownership record (a re-run crashed identically, and `--uninstall` could prove
    // nothing was ours). `origin/main` refused this same layout cleanly via `safeJoin`; the
    // refusal is back, and it lands before a single byte is written.
    const badHome = tempProject();
    const badXdg = tempProject();
    const badOutside = tempProject();
    const missingDir = path.join(badOutside, "no-such-dir");
    const badTarget = path.join(missingDir, "rec.json");
    const badLink = path.join(badHome, ".claude/modelguild/.modelguild-install.json");
    mkdirSync(path.dirname(badLink), { recursive: true });
    symlinkSync(badTarget, badLink);
    c.check(!existsSync(missingDir), "record symlink: the link's target DIRECTORY does not exist before the install");

    const badOpts = {
      targetDir: tempProject(),
      packageRoot: repoRoot,
      serverLaunch: LAUNCH,
      global: true as const,
      homeDir: badHome,
      xdgConfigHome: badXdg,
    };
    let badMsg = "";
    try {
      init(badOpts);
    } catch (e) {
      badMsg = (e as Error).message;
    }
    c.check(
      badMsg ===
        `the ownership record ${badLink} is a symlink to ${badTarget}, whose directory ` +
          `${missingDir} does not exist — the record cannot be written there, and an install with ` +
          `no record leaves nothing for a re-run or --uninstall to verify. Nothing was installed. ` +
          `Create ${missingDir}, or remove the link, then re-run init.`,
      `record symlink: a dangling link into a MISSING directory is refused, naming the record, the target and the missing dir (got: ${badMsg || "<no throw>"})`,
    );
    const badWritten = countFiles(path.join(badHome, ".claude")) + countFiles(path.join(badXdg, "opencode"));
    c.check(
      badWritten === 0,
      `record symlink: the refusal writes ZERO of the ${N_PAYLOAD} payload files (got ${badWritten})`,
    );
    c.check(!existsSync(missingDir), "record symlink: the refusal creates no directory at the link's target");

    // (d) the sibling errno, and the second of the TWO enumerated conditions: the target's
    // parent is PRESENT but not a directory, so the write raised a raw ENOTDIR — same shape,
    // same cost (the whole payload installed, no record), and the same regression against
    // `origin/main`, which refused this layout too. Distinct wording, same three paths.
    const ndHome = tempProject();
    const ndXdg = tempProject();
    const ndOutside = tempProject();
    const notADir = path.join(ndOutside, "i-am-a-file");
    writeFileSync(notADir, "NOT A DIRECTORY\n");
    const ndTarget = path.join(notADir, "rec.json");
    const ndLink = path.join(ndHome, ".claude/modelguild/.modelguild-install.json");
    mkdirSync(path.dirname(ndLink), { recursive: true });
    symlinkSync(ndTarget, ndLink);

    let ndMsg = "";
    try {
      init({
        targetDir: tempProject(),
        packageRoot: repoRoot,
        serverLaunch: LAUNCH,
        global: true,
        homeDir: ndHome,
        xdgConfigHome: ndXdg,
      });
    } catch (e) {
      ndMsg = (e as Error).message;
    }
    c.check(
      ndMsg ===
        `the ownership record ${ndLink} is a symlink to ${ndTarget}, but ${notADir} is not ` +
          `a directory — the record cannot be written there, and an install with no record leaves ` +
          `nothing for a re-run or --uninstall to verify. Nothing was installed. Replace ${notADir} ` +
          `with a directory, or remove the link, then re-run init.`,
      `record symlink: a dangling link whose target's parent is NOT A DIRECTORY is refused, naming the record, the target and that path (got: ${ndMsg || "<no throw>"})`,
    );
    const ndWritten = countFiles(path.join(ndHome, ".claude")) + countFiles(path.join(ndXdg, "opencode"));
    c.check(
      ndWritten === 0,
      `record symlink: the not-a-directory refusal writes ZERO of the ${N_PAYLOAD} payload files (got ${ndWritten})`,
    );
    c.check(
      readFileSync(notADir, "utf8") === "NOT A DIRECTORY\n",
      "record symlink: the file standing where a directory was needed is untouched",
    );

    // `--uninstall` writes no record, so the refusal must not block it: the removal path is the
    // user's way out of a layout init declined to install into.
    let badUninstallMsg = "";
    try {
      init({ ...badOpts, uninstall: true });
    } catch (e) {
      badUninstallMsg = (e as Error).message;
    }
    c.check(
      badUninstallMsg === "",
      `record symlink: --uninstall --global is NOT blocked by the refused link (got: ${badUninstallMsg})`,
    );
  }

  // --- issues #162 / #163: THE STAT PREDICATE AT A PRESENCE CHECK -----------------------
  //
  // One defect class, two directions. `existsSync` says TRUE for a FIFO and the read that
  // follows BLOCKS (#162); `lstatSync().isFile()` says FALSE for a symlink and the read that
  // follows never happens (#163). Both were gates on a path that is about to be opened, and
  // the gate has to answer the question the OPEN asks — which is `stat`'s question.
  //
  // EVERY FIFO CASE RUNS IN A CHILD PROCESS UNDER A WALL-CLOCK BOUND (`runBounded`). A
  // blocking synchronous fs call cannot be interrupted from inside this process, so an
  // in-process assertion would HANG the suite on a regression instead of failing it — see the
  // note on `runBounded` in `test/harness.ts`.
  {
    const CLI = path.join(repoRoot, "src", "cli.ts");
    const mkfifo = (p: string): void => { execFileSync("mkfifo", [p]); };

    // (1) #163 — THE STOW LAYOUT. Real files in a store, symlinks at the destinations: the
    // layout GNU stow produces whenever the parent directory cannot be tree-folded, and what
    // chezmoi's `symlink_` targets do by design. Under `lstat` all 8 command docs scored 0 and
    // the whole install vanished from skew/drift detection with no signal (C72's three
    // surfaces all went quiet). Under `stat` they are scanned and classified.
    {
      const SP = tempProject();
      init({ targetDir: SP, packageRoot: PKG_V1, serverLaunch: LAUNCH });
      const store = tempProject();
      const real = path.join(store, "consult.md");
      writeFileSync(real, readFileSync(path.join(SP, CONSULT), "utf8"));
      unlinkSync(path.join(SP, CONSULT));
      symlinkSync(real, path.join(SP, CONSULT));

      c.check(
        lstatSync(path.join(SP, CONSULT)).isSymbolicLink(),
        "stat predicate: the stow fixture really is a symlink at the payload destination",
      );
      const stow = scanAgainst(PKG_V2, SP);
      c.check(
        stow.skewed.length === 1 && stow.skewed[0]?.dest === CONSULT,
        `stat predicate (#163): a SYMLINKED payload file behind the release is reported as skew (got skewed=${stow.skewed.length}, unknown=${stow.unknown.length})`,
      );
      c.check(
        scanAgainst(PKG_V1, SP).skewed.length === 0,
        "stat predicate (#163): a symlinked payload file matching the release it came from is still clean",
      );
    }

    // (2) #163 / review finding F8 — THE OTHER SYMLINK. A payload path pointed at a file of
    // the user's own that init never wrote, with no ownership record covering it. This must
    // NOT come out as silence: presence is not identity, and C72's honest answer for "differs
    // from shipped, no record to judge it by" is UNJUDGEABLE. Under `lstat` it was skipped
    // entirely, so `doctor`/`guild_status`/the notice all said nothing at all about it.
    {
      const FP = tempProject();
      init({ targetDir: FP, packageRoot: PKG_V1, serverLaunch: LAUNCH });
      setRecord(FP, CONSULT, null); // the link predates any install of ours
      const mine = path.join(tempProject(), "my-own-notes.md");
      writeFileSync(mine, "my own file, nothing to do with modelguild\n");
      unlinkSync(path.join(FP, CONSULT));
      symlinkSync(mine, path.join(FP, CONSULT));

      const shadowed = scanAgainst(PKG_V1, FP);
      c.check(
        shadowed.unknown.length === 1 && shadowed.unknown[0]?.dest === CONSULT,
        `stat predicate (#163/F8): a payload path linked to an UNRELATED file with no record is reported as unjudgeable, not skipped (got unknown=${shadowed.unknown.length})`,
      );
      c.check(
        shadowed.skewed.length === 0 && shadowed.drifted.length === 0,
        "stat predicate (#163/F8): an unrecorded shadowing file is NOT guessed as skew or drift",
      );
    }

    // (3) #163 — the guard the `isFile()` half was there for, kept. `stat` follows the link;
    // it still refuses a DIRECTORY standing where a payload file should be.
    {
      const DP = tempProject();
      init({ targetDir: DP, packageRoot: PKG_V1, serverLaunch: LAUNCH });
      rmSync(path.join(DP, CONSULT));
      mkdirSync(path.join(DP, CONSULT), { recursive: true });
      const dirCase = scanAgainst(PKG_V2, DP);
      c.check(
        dirCase.skewed.length === 0 && dirCase.drifted.length === 0 && dirCase.unknown.length === 0,
        `stat predicate (#163): a DIRECTORY at a payload path is still skipped by the scan (got skewed=${dirCase.skewed.length}, unknown=${dirCase.unknown.length})`,
      );
    }

    // (4) #162 — a FIFO at `.gitignore`. THE DEFAULT PROJECT INSTALL PATH, no flag required:
    // the read hung, and gating only the read would have moved the hang to the write. The
    // block is the last step of the install, so it is SKIPPED with a warning rather than
    // refused — the payload and the ownership record are already on disk and correct.
    {
      const GP = tempProject();
      mkfifo(path.join(GP, ".gitignore"));
      const r = runBounded([CLI, "init", "--dir", GP], { timeoutMs: 60_000 });
      c.check(!r.timedOut, "FIFO (#162): `init` with a FIFO at .gitignore RETURNS (it used to block forever)");
      c.check(r.status === 0, `FIFO (#162): that install still succeeds (exit ${r.status})`);
      c.check(
        countFiles(path.join(GP, ".claude")) + countFiles(path.join(GP, ".opencode")) > 0,
        "FIFO (#162): the payload is installed despite the unusable .gitignore",
      );
      c.check(
        existsSync(path.join(GP, "modelguild", ".modelguild-install.json")),
        "FIFO (#162): the ownership record is still written",
      );
      c.check(
        (r.stdout + r.stderr).includes("skipping the .gitignore block"),
        `FIFO (#162): and it SAYS the block was skipped rather than doing it silently (got: ${(r.stdout + r.stderr).slice(-300)})`,
      );
    }

    // (5) #162 — a FIFO at `.mcp.json` under `--write-mcp`. Refused, not skipped: this file is
    // written mid-install and init already refuses an unparseable one, so the shape check
    // lands on the same branch with the same remedy.
    {
      const MP = tempProject();
      mkfifo(path.join(MP, ".mcp.json"));
      const r = runBounded([CLI, "init", "--dir", MP, "--write-mcp"], { timeoutMs: 60_000 });
      c.check(!r.timedOut, "FIFO (#162): `init --write-mcp` with a FIFO at .mcp.json RETURNS (it used to block forever)");
      // `!== null` as well as `!== 0`: a KILLED child reports a null status, which `!== 0`
      // alone accepts — so the weaker form passed against the very hang it is here to catch.
      c.check(
        r.status !== null && r.status !== 0,
        `FIFO (#162): and it refuses rather than reporting success (exit ${r.status})`,
      );
      c.check(
        (r.stdout + r.stderr).includes("not a regular file"),
        `FIFO (#162): the .mcp.json refusal says what is wrong with the path (got: ${(r.stdout + r.stderr).slice(-300)})`,
      );
    }

    // (6) #162 — a FIFO at the OWNERSHIP RECORD. `writeRecords` writes that path
    // unconditionally, so this is the WRITE direction with no read to gate. Refused at plan
    // time, which is the only placement that leaves nothing behind: the pre-fix behaviour
    // installed the entire payload and THEN hung on the record.
    {
      const RP = tempProject();
      mkdirSync(path.join(RP, "modelguild"), { recursive: true });
      mkfifo(path.join(RP, "modelguild", ".modelguild-install.json"));
      const r = runBounded([CLI, "init", "--dir", RP], { timeoutMs: 60_000 });
      c.check(!r.timedOut, "FIFO (#162): `init` with a FIFO at the ownership record RETURNS (it used to block forever)");
      c.check(r.status !== null && r.status !== 0, `FIFO (#162): and it refuses (exit ${r.status})`);
      const written = countFiles(path.join(RP, ".claude")) + countFiles(path.join(RP, ".opencode"));
      c.check(
        written === 0,
        `FIFO (#162): the record refusal is at PLAN time — ZERO payload files written (got ${written})`,
      );
    }

    // (7) #162 — a FIFO at a payload path during `--uninstall`. The hash read that decides
    // whether a file is ours blocked on it; a non-regular entry cannot hash to what init
    // recorded, so skipping it is the same answer arrived at without the block.
    {
      const UP = tempProject();
      init({ targetDir: UP, packageRoot: PKG_V1, serverLaunch: LAUNCH });
      rmSync(path.join(UP, CONSULT));
      mkfifo(path.join(UP, CONSULT));
      const r = runBounded([CLI, "init", "--dir", UP, "--uninstall"], { timeoutMs: 60_000 });
      c.check(!r.timedOut, "FIFO (#162): `init --uninstall` with a FIFO at a payload path RETURNS (it used to block forever)");
      c.check(r.status === 0, `FIFO (#162): the uninstall completes (exit ${r.status})`);
      c.check(
        lstatSync(path.join(UP, CONSULT)).isFIFO(),
        "FIFO (#162): the user's FIFO is left alone, not removed",
      );
    }
  }

  // =========================================================================
  // Issues #167 / #159 / #160 / #161 / #164 — WHEN a refusal lands.
  //
  // One defect: every path-level check ran lazily, so a refusal of any kind landed after the
  // filesystem had been mutated, and — because the ownership record is what `--uninstall` and
  // never-clobber both key on — a run that died before `writeRecords` left an install that was
  // neither present nor absent and that NO invocation could repair.
  //
  // The two rules under test: an INSTALL refuses EARLY (nothing written) or not at all; an
  // UNINSTALL never refuses at all.
  // =========================================================================
  {
    const LINKED_DEST = "modelguild/models.policy"; // payload entry 12 of 13 — 11 land before it

    // --- #167 (a): a symlinked payload destination refuses at PLAN time -----
    {
      const P = tempProject();
      const outside = tempProject();
      const mine = path.join(outside, "mine");
      writeFileSync(mine, "MY OWN POLICY\n");
      mkdirSync(path.join(P, "modelguild"), { recursive: true });
      symlinkSync(mine, path.join(P, LINKED_DEST));
      let msg = "";
      try {
        init({ targetDir: P, packageRoot: repoRoot, serverLaunch: LAUNCH });
      } catch (e) {
        msg = (e as Error).message;
      }
      c.check(msg.startsWith("refusing destination symlink:"), `#167: a linked payload dest is refused (got: ${msg || "<no throw>"})`);
      // The whole point: on the pre-fix code this threw from INSIDE the loop, leaving 11 files.
      c.check(
        countFiles(path.join(P, ".claude")) === 0 && countFiles(path.join(P, ".opencode")) === 0,
        `#167: the refusal writes ZERO files (got ${countFiles(path.join(P, ".claude")) + countFiles(path.join(P, ".opencode"))})`,
      );
      c.check(!existsSync(path.join(P, "modelguild/.modelguild-install.json")), "#167: and no ownership record");
      c.check(readFileSync(mine, "utf8") === "MY OWN POLICY\n", "#167: the link's target is untouched");
    }

    // --- #167 (b): the WORST shape — a link at an AGENT DEF ----------------
    // Per C16 a missing hardened def makes guild_research/guild_delegate REFUSE, so the
    // pre-fix outcome (8 command docs, no agent defs, no record) was non-functional, not
    // merely incomplete.
    {
      const P = tempProject();
      const outside = tempProject();
      const t = path.join(outside, "def.md");
      writeFileSync(t, "MINE\n");
      mkdirSync(path.join(P, ".opencode/agent"), { recursive: true });
      symlinkSync(t, path.join(P, ".opencode/agent/guild-build.md"));
      let threw = false;
      try {
        init({ targetDir: P, packageRoot: repoRoot, serverLaunch: LAUNCH });
      } catch {
        threw = true;
      }
      c.check(
        threw && countFiles(path.join(P, ".claude")) === 0,
        "#167: a link at an agent def refuses BEFORE the command docs land (never 'docs but no defs')",
      );
    }

    // --- #167 (c): UNINSTALL is no longer blocked by the same link ---------
    {
      const P = tempProject();
      const outside = tempProject();
      init({ targetDir: P, packageRoot: repoRoot, serverLaunch: LAUNCH });
      // Plant a LIVE link AFTER a good install, over a file init owns — the shape `safeJoin`
      // refuses, and therefore the shape that used to make `--uninstall` impossible.
      const elsewhere = path.join(outside, "elsewhere");
      writeFileSync(elsewhere, "SOMEBODY ELSE'S FILE\n");
      unlinkSync(path.join(P, LINKED_DEST));
      symlinkSync(elsewhere, path.join(P, LINKED_DEST));
      const ru = initScored(c, "#167: uninstall over a linked payload dest", {
        targetDir: P, packageRoot: repoRoot, serverLaunch: LAUNCH, uninstall: true,
      });
      c.check(
        ru.removed.length === N_PAYLOAD - 1,
        `#167: uninstall removes every OTHER file rather than refusing the run (got ${ru.removed.length})`,
      );
      c.check((ru.blocked ?? []).includes(LINKED_DEST), `#167: the one it could not resolve is reported blocked (got [${(ru.blocked ?? []).join(", ")}])`);
      c.check(
        ru.warnings.some((w) => w.startsWith(`keeping ${LINKED_DEST} — refusing destination symlink:`)),
        `#167: with a warning naming it (got ${ru.warnings.join(" | ")})`,
      );
      c.check(lstatSync(path.join(P, LINKED_DEST)).isSymbolicLink(), "#167: the user's link itself is left alone");
      c.check(readFileSync(elsewhere, "utf8") === "SOMEBODY ELSE'S FILE\n", "#167: and its target is not deleted through it");
    }

    // --- #159: a DANGLING symlink at a DIRECTORY component -----------------
    // `safeJoin` gated on `existsSync`, which FOLLOWS, so a dangling link was skipped by the
    // guard entirely. Pre-fix on this base that surfaced as a raw `ENOENT … mkdir` from inside
    // the loop with 8 files on disk and no record.
    {
      const P = tempProject();
      const outside = tempProject();
      symlinkSync(path.join(outside, "nodir"), path.join(P, ".opencode"));
      let msg = "";
      try {
        init({ targetDir: P, packageRoot: repoRoot, serverLaunch: LAUNCH });
      } catch (e) {
        msg = (e as Error).message;
      }
      c.check(
        msg.startsWith("refusing destination symlink:") && msg.includes(`the path component ${path.join(P, ".opencode")} is a symlink`),
        `#159: a DANGLING directory component is refused by name (got: ${msg || "<no throw>"})`,
      );
      c.check(
        countFiles(path.join(P, ".claude")) === 0 && countFiles(path.join(P, "modelguild")) === 0,
        "#159: and nothing is written (pre-fix: 8 command docs, then ENOENT)",
      );
      c.check(!existsSync(path.join(outside, "nodir")), "#159: nothing is created at the link's target either");
    }

    // A DANGLING LEAF link stays a SKIP, not a refusal — that is C77's shipped decision and
    // this change must not revert it. (A LIVE leaf link is still refused, asserted above.)
    {
      const P = tempProject();
      const outside = tempProject();
      mkdirSync(path.join(P, ".opencode/agent"), { recursive: true });
      symlinkSync(path.join(outside, "escaped.md"), path.join(P, ".opencode/agent/guild-read.md"));
      const r = initScored(c, "#159: dangling LEAF link", { targetDir: P, packageRoot: repoRoot, serverLaunch: LAUNCH });
      c.check(
        r.installed.length === N_PAYLOAD - 1 && r.skipped.includes(".opencode/agent/guild-read.md"),
        `#159: a dangling LEAF link is still skipped, not refused (got ${r.installed.length} installed)`,
      );
      c.check(!existsSync(path.join(outside, "escaped.md")), "#159: and never written through");
    }

    // --- #160: `.mcp.json` sits between the payload loop and the record ----
    // DESIGN CALL: what is KNOWABLE before writing is refused up front (nothing written); what
    // can only be learnt BY writing degrades to a warning with the record still written.
    {
      // (a) UNPARSEABLE — knowable ⇒ refused, nothing written.
      const P = tempProject();
      writeFileSync(path.join(P, ".mcp.json"), "not json at all\n");
      let msg = "";
      try {
        init({ targetDir: P, packageRoot: repoRoot, serverLaunch: LAUNCH, writeMcp: true });
      } catch (e) {
        msg = (e as Error).message;
      }
      c.check(
        msg.includes("not valid JSON") && msg.includes("Nothing was installed"),
        `#160: an unparseable .mcp.json is refused up front (got: ${msg || "<no throw>"})`,
      );
      c.check(
        countFiles(path.join(P, ".claude")) === 0 && countFiles(path.join(P, ".opencode")) === 0,
        "#160: the unparseable refusal writes ZERO payload files (pre-fix: 13, and no record)",
      );

      // (b) SYMLINKED — knowable ⇒ refused, nothing written.
      const P2 = tempProject();
      const outside = tempProject();
      const real = path.join(outside, "real.json");
      writeFileSync(real, '{"mcpServers":{}}\n');
      symlinkSync(real, path.join(P2, ".mcp.json"));
      let msg2 = "";
      try {
        init({ targetDir: P2, packageRoot: repoRoot, serverLaunch: LAUNCH, writeMcp: true });
      } catch (e) {
        msg2 = (e as Error).message;
      }
      c.check(
        msg2.startsWith("refusing destination symlink:") && msg2.includes(".mcp.json"),
        `#160: a symlinked .mcp.json is refused up front (got: ${msg2 || "<no throw>"})`,
      );
      c.check(countFiles(path.join(P2, ".opencode")) === 0, "#160: and writes nothing");

      // (c) UNWRITABLE — only learnable by writing ⇒ the payload AND THE RECORD still land.
      const P3 = tempProject();
      writeFileSync(path.join(P3, ".mcp.json"), '{"mcpServers":{}}\n');
      execFileSync("chmod", ["444", path.join(P3, ".mcp.json")]);
      const r3 = initScored(c, "#160: unwritable .mcp.json", {
        targetDir: P3, packageRoot: repoRoot, serverLaunch: LAUNCH, writeMcp: true,
      });
      c.check(r3.installed.length === N_PAYLOAD, `#160: an unwritable .mcp.json does not stop the payload (got ${r3.installed.length})`);
      c.check(
        recordedFileCount(path.join(P3, "modelguild/.modelguild-install.json")) === N_PAYLOAD,
        "#160: THE OWNERSHIP RECORD IS STILL WRITTEN (pre-fix: absent, and unrepairable)",
      );
      c.check(r3.mcpAction === "skipped" && (r3.blocked ?? []).includes(".mcp.json"), `#160: .mcp.json is reported unwritten and blocked (got ${r3.mcpAction}, [${(r3.blocked ?? []).join(", ")}])`);
      // …and the install is now repairable: fix the cause, re-run, done.
      execFileSync("chmod", ["644", path.join(P3, ".mcp.json")]);
      const r3b = initScored(c, "#160: retry after fixing the cause", {
        targetDir: P3, packageRoot: repoRoot, serverLaunch: LAUNCH, writeMcp: true,
      });
      c.check(
        r3b.mcpAction === "merged" && (r3b.blocked ?? []).length === 0,
        `#160: a retry completes the install rather than throwing at the same point (got ${r3b.mcpAction}, [${(r3b.blocked ?? []).join(", ")}])`,
      );
    }

    // --- #161: uninstall must never be held hostage by an ancillary file ---
    {
      // (a) read-only `.gitignore`: pre-fix ⇒ exit 1, payload gone, record gone, block still
      //     present, `pruneEmptyDirs` NEVER REACHED.
      const P = tempProject();
      init({ targetDir: P, packageRoot: repoRoot, serverLaunch: LAUNCH });
      execFileSync("chmod", ["444", path.join(P, ".gitignore")]);
      const r = initScored(c, "#161: uninstall over a read-only .gitignore", {
        targetDir: P, packageRoot: repoRoot, serverLaunch: LAUNCH, uninstall: true,
      });
      c.check(r.removed.length === N_PAYLOAD, `#161: every payload file is still removed (got ${r.removed.length})`);
      c.check((r.blocked ?? []).includes(".gitignore"), `#161: the .gitignore is reported blocked (got [${(r.blocked ?? []).join(", ")}])`);
      c.check(
        !existsSync(path.join(P, ".claude/commands/guild")),
        "#161: pruneEmptyDirs IS reached (pre-fix the throw landed before it)",
      );
      execFileSync("chmod", ["644", path.join(P, ".gitignore")]);

      // (b) read-only `.mcp.json` holding our key: pre-fix ⇒ the record survived, CLAIMING 13
      //     files that were already gone, and every re-run exited 1.
      const P2 = tempProject();
      init({ targetDir: P2, packageRoot: repoRoot, serverLaunch: LAUNCH, writeMcp: true });
      execFileSync("chmod", ["444", path.join(P2, ".mcp.json")]);
      const r2 = initScored(c, "#161: uninstall over a read-only .mcp.json", {
        targetDir: P2, packageRoot: repoRoot, serverLaunch: LAUNCH, uninstall: true,
      });
      c.check(r2.removed.length === N_PAYLOAD, `#161: the payload is removed (got ${r2.removed.length})`);
      c.check(
        !existsSync(path.join(P2, "modelguild/.modelguild-install.json")),
        "#161: and the record does not survive claiming files that are gone",
      );
      c.check(r2.mcpAction === "kept" && (r2.blocked ?? []).includes(".mcp.json"), `#161: the key is kept and reported (got ${r2.mcpAction})`);
      execFileSync("chmod", ["644", path.join(P2, ".mcp.json")]);

      // (c) a NON-REGULAR `.mcp.json` was reported `unchanged` with NO warning — and on this
      //     base `readFileSync` on a FIFO does not merely mislead, it HANGS.
      //
      //     IN A BOUNDED CHILD PROCESS, for the reason `runBounded` exists (C78): reverting the
      //     fix makes this BLOCK, and a blocking synchronous fs call cannot be interrupted from
      //     inside this process — an in-process assertion would wedge the suite instead of going
      //     red, which is a bite-check that silently proves nothing. `timedOut` is asserted
      //     FIRST and the exit code is compared to `0` rather than `!== 0`, because a killed
      //     child reports `status === null` and `!== 0` would ACCEPT the hang.
      const P3 = tempProject();
      init({ targetDir: P3, packageRoot: repoRoot, serverLaunch: LAUNCH });
      execFileSync("mkfifo", [path.join(P3, ".mcp.json")]);
      const r3 = runBounded([path.join(repoRoot, "src", "cli.ts"), "init", "--dir", P3, "--uninstall"], {
        timeoutMs: 60_000,
      });
      c.check(!r3.timedOut, "#161: uninstall with a FIFO at .mcp.json RETURNS (the read used to block forever)");
      c.check(r3.status === 0, `#161: and completes (exit ${r3.status})`);
      c.check(
        r3.stdout.includes(`removed ${N_PAYLOAD} file(s)`),
        `#161: the whole payload is removed rather than the read hanging (got: ${r3.stdout.split("\n")[1]})`,
      );
      c.check(
        (r3.stdout + r3.stderr).includes("is not a regular file, so it was neither read nor rewritten"),
        `#161: a non-regular .mcp.json is NAMED rather than silently 'unchanged' (got: ${(r3.stdout + r3.stderr).slice(-300)})`,
      );
      unlinkSync(path.join(P3, ".mcp.json"));

      // (d) an UNREADABLE payload file inside the removal loop. DESIGN CALL: warn-and-continue.
      const P4 = tempProject();
      init({ targetDir: P4, packageRoot: repoRoot, serverLaunch: LAUNCH });
      const locked = path.join(P4, ".opencode/agent/guild-read.md");
      execFileSync("chmod", ["000", locked]);
      const r4 = initScored(c, "#161: uninstall over an unreadable payload file", {
        targetDir: P4, packageRoot: repoRoot, serverLaunch: LAUNCH, uninstall: true,
      });
      c.check(
        r4.removed.length === N_PAYLOAD - 1 && (r4.blocked ?? []).includes(".opencode/agent/guild-read.md"),
        `#161: the other ${N_PAYLOAD - 1} are removed and the one that failed is reported (got ${r4.removed.length}, [${(r4.blocked ?? []).join(", ")}])`,
      );
      execFileSync("chmod", ["644", locked]);
    }

    // --- #164: a partial install must not exit 0 ---------------------------
    // Asserted through the CLI, because the exit code is the defect.
    {
      // `runBounded`, not `execFileSync`: the exit code IS the assertion here, and a bare
      // `execFileSync` has no timeout — so a regression that blocks would wedge the suite rather
      // than fail it. Every case below asserts `!timedOut` before it reads `status`, because a
      // killed child reports `status === null` (C78).
      const cli = (args: string[]): { status: number | null; out: string; timedOut: boolean } => {
        const r = runBounded([path.join(repoRoot, "src/cli.ts"), ...args], { timeoutMs: 60_000 });
        return { status: r.status, out: r.stdout + r.stderr, timedOut: r.timedOut };
      };

      // BLOCKED: a file stands where `.claude/commands/guild` must be a directory, so none of
      // the 8 slash commands can be placed.
      const P = tempProject();
      mkdirSync(path.join(P, ".claude/commands"), { recursive: true });
      writeFileSync(path.join(P, ".claude/commands/guild"), "not a dir\n");
      const r = cli(["init", "--dir", P]);
      c.check(!r.timedOut, "#164: the blocked install RETURNS");
      c.check(r.status === 1, `#164: an install that placed none of the 8 commands exits 1 (got ${r.status})`);
      c.check(r.out.includes("INCOMPLETE"), `#164: and does not read as 'Installed' (got: ${r.out.split("\n")[0]})`);
      c.check(
        recordedFileCount(path.join(P, "modelguild/.modelguild-install.json")) === N_PAYLOAD - 8,
        `#164: while STILL writing a record for the 5 that landed (got ${recordedFileCount(path.join(P, "modelguild/.modelguild-install.json"))})`,
      );

      // POLICY: a re-install that declines to clobber a user's edit is the ownership model
      // working, so it must stay exit 0. This is the line the exit code is drawn on.
      const P2 = tempProject();
      cli(["init", "--dir", P2]);
      writeFileSync(path.join(P2, ".claude/commands/guild/consult.md"), "MY EDIT\n");
      const r2 = cli(["init", "--dir", P2]);
      c.check(!r2.timedOut, "#164: the re-install RETURNS");
      c.check(r2.status === 0, `#164: a never-clobber skip stays exit 0 (got ${r2.status})`);
      c.check(!r2.out.includes("INCOMPLETE"), "#164: and does not claim to be incomplete");

      // A clean install is untouched.
      const P3 = tempProject();
      const r3 = cli(["init", "--dir", P3]);
      c.check(!r3.timedOut, "#164: the clean install RETURNS");
      c.check(r3.status === 0 && !r3.out.includes("INCOMPLETE"), `#164: a clean install is exit 0 (got ${r3.status})`);
    }

    // --- The four routes an adversarial review of #156 reproduced ----------
    // Same defect, same fix: the record write throwing AFTER the payload loop.
    {
      // F1a — a DANGLING DIRECTORY link above the record path. `assertRecordLinkWritable`
      // cannot see this: it `lstat`s the record, which throws ENOENT when a parent does not
      // resolve. Pre-fix: 11 of 13 files, no record, `--uninstall` removes nothing.
      const H = tempProject();
      const X = tempProject();
      const G = tempProject();
      mkdirSync(path.join(H, ".claude"), { recursive: true });
      symlinkSync(path.join(G, "nowhere"), path.join(H, ".claude/modelguild"));
      let msg = "";
      try {
        init({ targetDir: tempProject(), packageRoot: repoRoot, serverLaunch: LAUNCH, global: true, homeDir: H, xdgConfigHome: X });
      } catch (e) {
        msg = (e as Error).message;
      }
      c.check(
        msg.includes(`the directory component ${path.join(H, ".claude/modelguild")} is a symlink`) &&
          msg.includes("whose target does not exist"),
        `F1a: a dangling directory link above the record is refused by name (got: ${msg || "<no throw>"})`,
      );
      c.check(
        countFiles(path.join(H, ".claude")) + countFiles(path.join(X, "opencode")) === 0,
        "F1a: with ZERO files written (pre-fix: 11 of 13, no record)",
      );

      // F1b — `<xdg>/opencode` is a symlink to a REGULAR FILE. Pre-fix: 8 files, ENOTDIR.
      const H2 = tempProject();
      const X2 = tempProject();
      const G2 = tempProject();
      const afile = path.join(G2, "afile");
      writeFileSync(afile, "i am a file\n");
      symlinkSync(afile, path.join(X2, "opencode"));
      let msg2 = "";
      try {
        init({ targetDir: tempProject(), packageRoot: repoRoot, serverLaunch: LAUNCH, global: true, homeDir: H2, xdgConfigHome: X2 });
      } catch (e) {
        msg2 = (e as Error).message;
      }
      c.check(
        msg2.includes(`${path.join(X2, "opencode")} exists but is not a directory`),
        `F1b: a directory component that is a regular file is refused by name (got: ${msg2 || "<no throw>"})`,
      );
      c.check(countFiles(path.join(H2, ".claude")) === 0, "F1b: with ZERO files written (pre-fix: 8, no record)");
      c.check(readFileSync(afile, "utf8") === "i am a file\n", "F1b: and the user's file is untouched");

      // F1c — a symlink LOOP at the record path. `existsSync` reports false for ELOOP exactly
      // as for a dangling link, so the two enumerated conditions passed it. Pre-fix: 13 files
      // on disk, no record.
      const H3 = tempProject();
      const X3 = tempProject();
      const rec3 = path.join(H3, ".claude/modelguild/.modelguild-install.json");
      mkdirSync(path.dirname(rec3), { recursive: true });
      symlinkSync(rec3, rec3);
      let msg3 = "";
      try {
        init({ targetDir: tempProject(), packageRoot: repoRoot, serverLaunch: LAUNCH, global: true, homeDir: H3, xdgConfigHome: X3 });
      } catch (e) {
        msg3 = (e as Error).message;
      }
      c.check(
        msg3.includes("cannot be resolved (ELOOP, a symlink loop)"),
        `F1c: a symlink loop at the record path is refused by name (got: ${msg3 || "<no throw>"})`,
      );
      c.check(
        countFiles(path.join(H3, ".claude")) + countFiles(path.join(X3, "opencode")) === 0,
        "F1c: with ZERO files written (pre-fix: 13, no record)",
      );

      // F4 — PROJECT mode reaches the identical state. C77 scoped the two refusals to
      // `--global`; the same layout crashed one branch over.
      const P = tempProject();
      const G4 = tempProject();
      mkdirSync(path.join(P, "modelguild"), { recursive: true });
      symlinkSync(path.join(G4, "nodir/rec.json"), path.join(P, "modelguild/.modelguild-install.json"));
      let msg4 = "";
      try {
        init({ targetDir: P, packageRoot: repoRoot, serverLaunch: LAUNCH });
      } catch (e) {
        msg4 = (e as Error).message;
      }
      c.check(
        msg4.includes(`whose directory ${path.join(G4, "nodir")} does not exist`),
        `F4: project mode refuses the dangling record link too (got: ${msg4 || "<no throw>"})`,
      );
      c.check(
        countFiles(path.join(P, ".claude")) + countFiles(path.join(P, ".opencode")) === 0,
        "F4: with ZERO files written (pre-fix: 13, no record)",
      );
    }

    // --- THE REGRESSION `wip/issue-156-full-review-work` CARRIED -----------
    // That branch ran the eager global directory-chain check on the UNINSTALL path too, so a
    // broken component in ONE destination tree aborted removal from the OTHER. It must not.
    {
      const H = tempProject();
      const X = tempProject();
      const G = tempProject();
      const seeded = initScored(c, "regression guard: seed a global install", {
        targetDir: tempProject(), packageRoot: repoRoot, serverLaunch: LAUNCH, global: true, homeDir: H, xdgConfigHome: X,
      });
      c.check(seeded.installed.length === N_PAYLOAD, `regression guard: seeded ${N_PAYLOAD} files (got ${seeded.installed.length})`);
      // Break the <xdg>/opencode tree the way F1b does — the exact shape the eager check
      // refuses on INSTALL — leaving <home>/.claude intact and full of our files.
      rmSync(path.join(X, "opencode"), { recursive: true, force: true });
      const notADir = path.join(G, "in-the-way");
      writeFileSync(notADir, "NOT A DIRECTORY\n");
      symlinkSync(notADir, path.join(X, "opencode"));
      const ru = initScored(c, "regression guard: uninstall with one tree broken", {
        targetDir: tempProject(), packageRoot: repoRoot, serverLaunch: LAUNCH, global: true, homeDir: H, xdgConfigHome: X, uninstall: true,
      });
      c.check(
        ru.removed.length === N_PAYLOAD - AGENT_DEF_COUNT,
        `regression guard: removal from the INTACT tree still happens (got ${ru.removed.length} of ${N_PAYLOAD - AGENT_DEF_COUNT})`,
      );
      c.check(
        countFiles(path.join(H, ".claude")) === 0,
        `regression guard: <home>/.claude is emptied (got ${countFiles(path.join(H, ".claude"))} file(s) left)`,
      );
    }

    // --- #174: a LIVE symlink at `.gitignore` must not fail a complete install ----
    // The defect that falsified C79's "an install refuses early or not at all":
    // `addGitignoreBlock` opened with `safeJoin`, which THROWS at a live leaf link, and it runs
    // after the payload loop AND after `writeRecords` — so an install that had fully succeeded
    // exited 1 saying `Nothing was installed.`, on every run, forever. `initScored` is what makes
    // this a red line rather than an aborted suite: it catches the throw, scores it, and returns
    // an empty result, so the assertions below read `[]` instead of killing the run.
    {
      const P = tempProject();
      const store = tempProject();
      const shared = path.join(store, "shared-gitignore");
      writeFileSync(shared, "node_modules/\n");
      symlinkSync(shared, path.join(P, ".gitignore"));
      const r = initScored(c, "#174: install with a LIVE symlink at .gitignore", {
        targetDir: P, packageRoot: repoRoot, serverLaunch: LAUNCH,
      });
      c.check(
        r.installed.length === N_PAYLOAD,
        `#174: the whole payload is installed (got ${r.installed.length} of ${N_PAYLOAD}) — pre-fix this THREW`,
      );
      c.check(
        recordedFileCount(path.join(P, "modelguild/.modelguild-install.json")) === N_PAYLOAD,
        "#174: and the ownership record is written",
      );
      c.check(
        (r.blocked ?? []).length === 0,
        `#174: a shape init DECLINES to write is policy, so the run stays exit 0 (got blocked=[${(r.blocked ?? []).join(", ")}])`,
      );
      c.check(
        r.warnings.some((w) => w.includes("skipping the .gitignore block") && w.includes("never writes through one")),
        `#174: it SAYS the block was skipped and why (got: ${r.warnings.join(" | ").slice(-300)})`,
      );
      c.check(
        readFileSync(shared, "utf8") === "node_modules/\n",
        "#174: the file behind the link is untouched — a project install never writes through one",
      );

      // Through the CLI, because the exit code and the sentence are the user-visible defect.
      const P2 = tempProject();
      symlinkSync(shared, path.join(P2, ".gitignore"));
      const rc = runBounded([path.join(repoRoot, "src/cli.ts"), "init", "--dir", P2], { timeoutMs: 60_000 });
      c.check(!rc.timedOut, "#174: the CLI install RETURNS");
      c.check(rc.status === 0, `#174: and exits 0 (got ${rc.status}) — pre-fix: 1`);
      c.check(
        !(rc.stdout + rc.stderr).includes("Nothing was installed"),
        `#174: it does not claim 'Nothing was installed' over a complete install (got: ${(rc.stdout + rc.stderr).slice(0, 200)})`,
      );

      // The DANGLING case already worked; it must keep working, and must still not write
      // through the link (issue #159's write-through, at `.gitignore`).
      const P3 = tempProject();
      const nowhere = path.join(store, "no-such-dir", "x");
      symlinkSync(nowhere, path.join(P3, ".gitignore"));
      const r3 = initScored(c, "#174: install with a DANGLING symlink at .gitignore", {
        targetDir: P3, packageRoot: repoRoot, serverLaunch: LAUNCH,
      });
      c.check(
        r3.installed.length === N_PAYLOAD && (r3.blocked ?? []).length === 0,
        `#174: a dangling link is still a clean skip (got ${r3.installed.length}, blocked=[${(r3.blocked ?? []).join(", ")}])`,
      );
      c.check(
        !existsSync(path.join(store, "no-such-dir")),
        "#174: and nothing is written THROUGH it",
      );
    }

    // --- #175: `doctor`'s presence check and C16's refusal must agree ------
    // `locatePayload` used a bare `existsSync`, which is TRUE for a DIRECTORY — so `doctor`
    // printed `✓ 3/3 hardened agent defs present` for a repo where `hardenedDefPresentIn` says
    // absent and C16 therefore refuses at every model-calling tool. The value asserted here is
    // the AGREEMENT: one product must not have two answers about one file.
    {
      const P = tempProject();
      const G = tempProject();
      init({ targetDir: P, packageRoot: repoRoot, serverLaunch: LAUNCH });
      const gd = resolveGlobalDirs({ homeDir: G, xdgConfigHome: path.join(G, ".config") });
      const defRel = ".opencode/agent/guild-read.md";
      const defAbs = path.join(P, defRel);
      const agentDir = path.join(P, ".opencode/agent");
      const locate = (): string => locatePayload(defRel, { targetDir: P, global_dirs: gd });
      const predicate = (): boolean => hardenedDefPresentIn("guild-read", [agentDir]).present;

      c.check(
        locate() === "project" && predicate(),
        `#175: baseline — a real def reads present on BOTH surfaces (locate=${locate()}, predicate=${predicate()})`,
      );

      // A DIRECTORY at the def path. Neither can block, so this is safe in-process (C78).
      rmSync(defAbs);
      mkdirSync(defAbs, { recursive: true });
      c.check(
        locate() === "none" && !predicate(),
        `#175: a DIRECTORY at a def path reads ABSENT on both (locate=${locate()}, predicate=${predicate()}) — pre-fix locate said "project"`,
      );
      rmSync(defAbs, { recursive: true });

      // #163's direction, unchanged and load-bearing: `stat` not `lstat`, so a stow-style link
      // to a real def is still PRESENT on both surfaces. Fixing #175 must not break this.
      const store = tempProject();
      const stored = path.join(store, "guild-read.md");
      copyFileSync(path.join(repoRoot, defRel), stored);
      symlinkSync(stored, defAbs);
      c.check(
        locate() === "project" && predicate(),
        `#175/#163: a SYMLINKED def is still present on both (locate=${locate()}, predicate=${predicate()})`,
      );
    }

    // --- #176: an uninstall that could not remove a payload file keeps the record ----
    // Sequence: install cleanly, a symlink appears at `.opencode`, `--uninstall` keeps the 3
    // defs and (pre-fix) unlinked the record anyway — after which every `init` was refused by
    // `planFor`'s eager loop and a second `--uninstall` could no longer prove the leftovers
    // were ours. Files present, record gone, install refused, removal impossible.
    {
      const P = tempProject();
      const store = tempProject();
      init({ targetDir: P, packageRoot: repoRoot, serverLaunch: LAUNCH });
      const oc = path.join(store, "oc");
      execFileSync("mv", [path.join(P, ".opencode"), oc]);
      symlinkSync(oc, path.join(P, ".opencode"));
      const record = path.join(P, "modelguild/.modelguild-install.json");

      const r = initScored(c, "#176: uninstall through a symlinked directory component", {
        targetDir: P, packageRoot: repoRoot, serverLaunch: LAUNCH, uninstall: true,
      });
      c.check(
        r.removed.length === N_PAYLOAD - AGENT_DEF_COUNT &&
          (r.blocked ?? []).length === AGENT_DEF_COUNT,
        `#176: the resolvable files are removed and the ${AGENT_DEF_COUNT} defs are blocked (got removed=${r.removed.length}, blocked=[${(r.blocked ?? []).join(", ")}])`,
      );
      c.check(
        existsSync(record),
        "#176: THE OWNERSHIP RECORD SURVIVES — it is the only proof the leftovers are ours (pre-fix: unlinked)",
      );
      c.check(
        r.warnings.some((w) => w.includes("KEEPING the ownership record")),
        `#176: and the run says so rather than leaving it silently (got: ${r.warnings.join(" | ").slice(-300)})`,
      );

      // THE MESSAGE DEFECT, same path: `safeJoin`'s install-only sentences were embedded
      // verbatim into an uninstall warning.
      const kept = r.warnings.find((w) => w.startsWith(`keeping ${".opencode/agent/guild-read.md"}`)) ?? "";
      c.check(
        kept.includes("the rest of the removal continues"),
        `#176: the uninstall warning is written for an uninstall (got: ${kept.slice(-220) || "<no warning>"})`,
      );
      c.check(
        !kept.includes("Nothing was installed") && !kept.includes("`--uninstall` is not blocked by this"),
        `#176: and carries neither install-only sentence (got: ${kept.slice(-220) || "<no warning>"})`,
      );

      // THE REPAIR the retained record buys: undo the link, re-run `--uninstall`, done.
      unlinkSync(path.join(P, ".opencode"));
      execFileSync("mv", [oc, path.join(P, ".opencode")]);
      const r2 = initScored(c, "#176: the second uninstall finishes the job", {
        targetDir: P, packageRoot: repoRoot, serverLaunch: LAUNCH, uninstall: true,
      });
      c.check(
        r2.removed.length === AGENT_DEF_COUNT && (r2.blocked ?? []).length === 0,
        `#176: the leftovers ARE removable afterwards (got removed=${r2.removed.length}, blocked=[${(r2.blocked ?? []).join(", ")}]) — pre-fix: kept forever, "no ownership record to prove it's ours"`,
      );
      c.check(!existsSync(record), "#176: and the record goes with them once nothing is blocked");

      // THE SCOPE, so the amendment to C79 stays narrow: an ANCILLARY blocked write does NOT
      // retain the record. C79 argued that case deliberately (a kept record claiming files
      // already gone was judged worse), and #176 does not reopen it.
      const P2 = tempProject();
      init({ targetDir: P2, packageRoot: repoRoot, serverLaunch: LAUNCH, writeMcp: true });
      execFileSync("chmod", ["444", path.join(P2, ".mcp.json")]);
      const r3 = initScored(c, "#176: an ancillary block does not retain the record", {
        targetDir: P2, packageRoot: repoRoot, serverLaunch: LAUNCH, uninstall: true,
      });
      execFileSync("chmod", ["644", path.join(P2, ".mcp.json")]);
      c.check(
        (r3.blocked ?? []).includes(".mcp.json") &&
          !existsSync(path.join(P2, "modelguild/.modelguild-install.json")),
        `#176: a blocked .mcp.json still removes the record (C79 unchanged; blocked=[${(r3.blocked ?? []).join(", ")}])`,
      );
    }

    // --- #176 × #165: a SYMLINKED record path on the retained branch -------
    // Neither branch covered this on its own, and the merge is where it bites twice.
    //   (1) MERGE HAZARD: #165's leftover disclosure ("removed the symlink at …") belongs to the
    //       REMOVAL arm only. Hoisted above the retention branch it announces a destruction that
    //       did not happen — #165's own F-3 defect, re-created by a merge rather than an edit.
    //   (2) `planFor`'s plan-time line promised the link "is removed at the end", which the
    //       retention branch falsifies — so it is conditional now, and the outcome is stated
    //       where it is known.
    {
      const P = tempProject();
      const store = tempProject();
      init({ targetDir: P, packageRoot: repoRoot, serverLaunch: LAUNCH });
      // Move the record behind a symlink, the way a dotfiles manager would.
      const record = path.join(P, "modelguild/.modelguild-install.json");
      const stored = path.join(store, "install.json");
      copyFileSync(record, stored);
      unlinkSync(record);
      symlinkSync(stored, record);
      // …and block the payload the same way the section above does.
      const oc = path.join(store, "oc");
      execFileSync("mv", [path.join(P, ".opencode"), oc]);
      symlinkSync(oc, path.join(P, ".opencode"));

      const r = initScored(c, "#176×#165: uninstall, record behind a LIVE symlink, payload blocked", {
        targetDir: P, packageRoot: repoRoot, serverLaunch: LAUNCH, uninstall: true,
      });
      c.check(
        (r.blocked ?? []).length === AGENT_DEF_COUNT &&
          lstatSync(record).isSymbolicLink() &&
          existsSync(stored),
        `#176×#165: the record link AND its target both survive (blocked=[${(r.blocked ?? []).join(", ")}])`,
      );
      const keeping = r.warnings.find((w) => w.startsWith("KEEPING the ownership record")) ?? "";
      c.check(
        keeping.includes(stored) && keeping.includes("removed neither the link nor its target"),
        `#176×#165: the retained branch names the link's target and says nothing was removed (got: ${keeping.slice(-260) || "<no warning>"})`,
      );
      c.check(
        !r.warnings.some((w) => w.includes("removed the symlink at")),
        `#176×#165: THE MERGE HAZARD — #165's removal disclosure must NOT fire when nothing was removed (got: ${r.warnings.join(" | ").slice(-260)})`,
      );
      // The plan-time line: CONDITIONAL now, not a promise. Asserted in both directions — the
      // pre-fix text is the flat `wrote; the link itself is removed at the end`, which this run
      // would have made false.
      const planLine = r.warnings.find((w) => w.startsWith("reading the ownership record")) ?? "";
      c.check(
        planLine.includes("if the removal completes") &&
          !planLine.includes("wrote; the link itself is removed"),
        `#176×#165: the plan-time line no longer PROMISES a removal this run did not do (got: ${planLine.slice(-200) || "<no warning>"})`,
      );

      // A DANGLING record link on the same branch: `entryExists` is `lstat`-based, so the record
      // is "kept" while there is nothing behind it — the remedy would not work, and saying so is
      // the difference between a remedy and a false reassurance.
      const P2 = tempProject();
      const store2 = tempProject();
      init({ targetDir: P2, packageRoot: repoRoot, serverLaunch: LAUNCH });
      const record2 = path.join(P2, "modelguild/.modelguild-install.json");
      unlinkSync(record2);
      symlinkSync(path.join(store2, "gone.json"), record2);
      const oc2 = path.join(store2, "oc");
      execFileSync("mv", [path.join(P2, ".opencode"), oc2]);
      symlinkSync(oc2, path.join(P2, ".opencode"));
      const rd = initScored(c, "#176×#165: uninstall, record behind a DANGLING symlink", {
        targetDir: P2, packageRoot: repoRoot, serverLaunch: LAUNCH, uninstall: true,
      });
      const keeping2 = rd.warnings.find((w) => w.startsWith("KEEPING the ownership record")) ?? "";
      c.check(
        keeping2.includes("DANGLING") && keeping2.includes("prove nothing is ours"),
        `#176×#165: a dangling record link says the remedy will NOT work (got: ${keeping2.slice(-260) || "<no warning>"})`,
      );

      // AND THE REMOVAL ARM IS UNTOUCHED: with nothing blocked, #165's disclosure still fires.
      const P3 = tempProject();
      const store3 = tempProject();
      init({ targetDir: P3, packageRoot: repoRoot, serverLaunch: LAUNCH });
      const record3 = path.join(P3, "modelguild/.modelguild-install.json");
      const stored3 = path.join(store3, "install.json");
      copyFileSync(record3, stored3);
      unlinkSync(record3);
      symlinkSync(stored3, record3);
      const rr = initScored(c, "#176×#165: a clean uninstall still discloses the removed link", {
        targetDir: P3, packageRoot: repoRoot, serverLaunch: LAUNCH, uninstall: true,
      });
      c.check(
        (rr.blocked ?? []).length === 0 &&
          rr.warnings.some((w) => w.includes("removed the symlink at") && w.includes(stored3)),
        `#176×#165: #165's removal disclosure is NOT suppressed by the retention branch (blocked=[${(rr.blocked ?? []).join(", ")}], got: ${rr.warnings.join(" | ").slice(-260)})`,
      );
      c.check(
        !existsSync(record3) && existsSync(stored3),
        "#176×#165: …and it removed the link while leaving the target, as C77 says",
      );
    }
  }

  console.log(`init.test: ${c.passes} passed, ${c.failures} failed`);
  return c.failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((f) => process.exit(f > 0 ? 1 : 0));
}
