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
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Checker, repoRoot, tsxBin } from "./harness.js";
import {
  init,
  isDrifted,
  isSkewed,
  packageVersion,
  payloadFiles,
  resolveGlobalDirs,
  scanInstalledPayload,
  type PayloadFileState,
  type ServerLaunch,
} from "../src/init.js";
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

  console.log(`init.test: ${c.passes} passed, ${c.failures} failed`);
  return c.failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((f) => process.exit(f > 0 ? 1 : 0));
}
