/**
 * `modelguild init` test, in the spirit of collab/tests/test-install.sh:
 * install into throwaway temp dirs and assert the file / .mcp.json / ownership behaviour,
 * idempotency, the merge-not-clobber guarantee, hash-verified uninstall, and that the
 * bash wrappers are NOT installed. Offline, no model call. packageRoot is the repo root
 * (the payload assets live there — the same files npm's `files` allowlist ships).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Checker, repoRoot } from "./harness.js";
import { init, isDrifted, type ServerLaunch } from "../src/init.js";

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
