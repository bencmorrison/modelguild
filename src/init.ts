/**
 * `modelguild init` — the installer for the MCP era.
 *
 * Where the bash `install.sh` copies the whole bash payload (ask.sh/log.sh/… + all four
 * agent defs + witness.md) into a project, `init` places ONLY the MCP-era surface:
 *   (a) the 8 command docs (7 migrated + configure) → `.claude/commands/guild/`;
 *   (b) the 3 hardened agent defs the MCP tools resolve (`guild-read`/`guild-build`/
 *       `guild-research`) → `.opencode/agent/` (opencode serve resolves `--agent` from
 *       the project's `.opencode/`, and research/delegate REFUSE if their def is absent —
 *       so these are load-bearing, not optional);
 *   (c) the policy/config templates → `modelguild/` (where `resolveGuildRoot` reads them).
 * It does NOT install the bash wrappers or witness.md — those are retiring (M12).
 *
 * MCP REGISTRATION is user-driven by default: `init` does NOT touch `.mcp.json`. The user
 * registers the server themselves (`claude mcp add modelguild -s <scope> -- …`), choosing
 * per-project or global scope. The opt-in `--write-mcp` flag restores the old behavior —
 * writing/merging the project-scoped `.mcp.json` entry under the KEY `modelguild` (the
 * exact key the command grants `mcp__modelguild__<tool>` require).
 *
 * A registered MCP server is global by nature — one registration works in every project —
 * so the byte-templating and multi-root ownership machinery the old `--global` bash
 * installer needed no longer exists. Don't reintroduce it (issue #19).
 *
 * OWNERSHIP is ported from `install.sh`'s SHA-256 model, not reinvented: every file we
 * write records the sha256 of its written bytes in `modelguild/.modelguild-install.json`.
 * A re-install UPGRADES a file only while its current bytes still match the hash we
 * recorded (or already equal the incoming payload); a file the user edited is SKIPPED
 * and left untouched (never clobbered), with a warning. `uninstall` removes only
 * hash-verified files. The record file is deliberately named distinctly from bash's
 * `.install-manifest`/`.install-hashes`, so the two installers never read each other's
 * records. Idempotent.
 *
 * UPGRADE DRIFT (issue #22) is the cost of that never-clobber guarantee: the skip is silent
 * about *why* it matters, so a user who edited a command doc keeps running a copy of a
 * release that has since moved on — with no signal. `isDrifted` names that state exactly
 * (three distinct hashes: recorded ≠ current ≠ shipped, and shipped ≠ recorded) and both
 * `init` and `doctor` REPORT it. Reporting only: the file is still never touched, and drift
 * is a warning, not a failure — an edit is a supported, deliberate act, so a customized
 * install must not turn `doctor` red.
 *
 * PAYLOAD SKEW (issue #94) is the state next door, and it was invisible: the MCP SERVER
 * updates itself (`npx -y modelguild serve` resolves the current release on every launch),
 * while the payload it installs lives in the USER'S repo and does not move with it. So a
 * file that is ours and UNTOUCHED (recorded === current) can still be behind the release
 * (current ≠ shipped) — nothing to skip, nothing edited, nothing to warn about under #22's
 * predicate, and therefore no signal at all. `isSkewed` names it; `scanPayload` classifies
 * every installed file into exactly one of drifted / skewed / unknown; and one detection
 * entry point (`scanInstalledPayload`) feeds all three surfaces — `doctor`, `guild_status`,
 * and the server's start-up notice (`src/notice.ts`). Same posture as drift: REPORT only,
 * never a failure, never an exit-code change.
 *
 * SYMLINKS AT A DESTINATION differ BY MODE (issue #156).
 * PROJECT mode is unchanged: `safeJoin` refuses a symlink at any existing component.
 * `--global` writes into the user's OWN config (`~/.claude`, `<xdg>/opencode`), and a
 * dotfiles manager (GNU stow, chezmoi, a hand-rolled `ln -s`) makes those DIRECTORIES
 * symlinks — so `--global` uses `globalJoin`, which keeps the `..`/absolute guard and
 * FOLLOWS directory links, landing the payload in the backing store. Before this, such a
 * layout threw at the FIRST linked destination: nothing installed when `~/.claude` was the
 * link (`planFor` resolves the record path under it EAGERLY, before the loop), a PARTIAL
 * install with no ownership record when only `<xdg>/opencode` was. In GLOBAL mode a LEAF payload file that is a symlink is not
 * written through and not refused: it takes the existing never-clobber path — skipped
 * with a warning, `init` completes, the ownership record is still written. (Project mode
 * still REFUSES a live leaf link; only the dangling case changed there.) The RECORD's own
 * path is the exception in both modes: `writeRecords` is outside that loop, so a symlink
 * there is written THROUGH — deliberately, since only init writes the record and there is
 * no user content to preserve, but never silently (`recordSymlinkWarning`). TWO enumerated
 * shapes of record link are REFUSED instead, at plan time and before any byte is written
 * (`assertRecordLinkWritable`): a DANGLING one whose target's directory does not exist
 * (`ENOENT`) or is not a directory (`ENOTDIR`). Either write used to throw a raw errno after
 * the whole payload was already installed — no record, so a re-run crashed the same way and
 * uninstall could remove nothing. Two named conditions, not a general can-this-write predicate.
 * Capability cost, stated: `--global` now writes wherever those directory links point,
 * including outside `$HOME`, and uninstall's `pruneEmptyDirs` may `rmdir` now-empty dirs in the
 * backing store. UNINSTALL REMOVES THE LINK AND LEAVES THE TARGET, AND SAYS SO (issue #184):
 * `unlink(2)` never follows a final component, so that is what it always did — the change is
 * that it is named, because the write-through above is UNGATED and the file left behind may be
 * the user's own holding our record JSON. Disclosure only, no write-path change. The
 * ownership half of the message is gated on the record having parsed non-empty FROM that path,
 * and claims only what that parse carries — our JSON is behind the link NOW, by a route this
 * run cannot identify; the ungated half reports what this run could not read, never a property
 * of the user's file. See the removal branch in `init`. Provenance: the ask is the maintainer's,
 * one sentence — issue #156, "Init will not allow symlinks, this is likely a bad idea."
 * Everything below it is Claude's, including the global-only scope, the leaf rule and the
 * record write-through.
 *
 * WHEN A REFUSAL LANDS IS PART OF THE CONTRACT (issues #167/#159/#160/#161/#164, 2026-08-14).
 * Every path-level check used to run LAZILY — `plan.destFor` from inside the install and
 * uninstall loops, `.mcp.json` between the payload loop and `writeRecords`, `.gitignore` after
 * both — so a refusal of any kind landed AFTER the filesystem had been mutated. Because the
 * ownership record is what `--uninstall` and the never-clobber upgrade path both key on, a run
 * that died before `writeRecords` left an install that was neither present nor absent and that
 * NO subsequent invocation could repair: the retry threw at the same component, and
 * `--uninstall` removed nothing because there was no record to prove anything was ours.
 *
 * TWO RULES, and they point in opposite directions on purpose.
 *   INSTALL refuses EARLY or not at all. `planFor` resolves every payload destination, the
 *   ownership record and — under `--write-mcp` — `.mcp.json` BEFORE the loop, so a refusal costs
 *   nothing and leaves nothing. After that point nothing may throw UNTIL `writeRecords` (the form
 *   the call site at the install loop states): a per-file failure is a warning-and-skip, and the
 *   ancillary writes (`.gitignore`, which is deliberately NOT resolved in `planFor`, and
 *   `.mcp.json`) degrade the same way, so the run always reaches `writeRecords`. `writeRecords`
 *   ITSELF IS THE ONE DELIBERATE THROW AND IT STAYS ONE — an install with no ownership record IS
 *   a failed install, and dressing that as a warning would hide the state that matters — so the
 *   run leaves a record accounting for what it placed WHENEVER THE RECORD CAN BE WRITTEN AT ALL.
 *   `planFor` refuses the predictable link and non-regular shapes; an EACCES on the record path or
 *   its directory, ENOSPC, EROFS or a race still throws with the payload already on disk
 *   (reproduced: an existing record at mode 444, which passes both eager gates because it IS a
 *   regular file and IS not a link; and a `modelguild/` at mode 555, where the recursive
 *   `mkdirSync` no-ops and the EACCES lands on the write).
 *   `.gitignore` is the ancillary write that escaped the pre-`writeRecords` half of that rule
 *   TWICE, and both are now closed: issue #174 — `addGitignoreBlock` opened with `safeJoin`, which
 *   throws at a live leaf symlink, so a complete install exited 1 saying `Nothing was installed.`
 *   — and issue #179, where the surviving unguarded `readFileSync` threw an EACCES from the same
 *   position on a regular `.gitignore` the process could not read, because a shape gate answers
 *   shape and not permission.
 *   UNINSTALL NEVER REFUSES. Its job is removal, and an ancillary file — or one unreadable
 *   payload file — must not hold the payload hostage. Every failure there is a warning and the
 *   removal continues.
 * The dividing principle for install: REFUSE what can be determined before writing (a symlinked
 * or non-regular destination, unparseable `.mcp.json`); DEGRADE what can only be learnt by
 * writing (EACCES, ENOSPC, a race). An `accessSync`-style "can this write succeed?" predicate is
 * deliberately NOT used — it is advisory, it lies for root, and it is the general predicate the
 * maintainer declined for the record path (C77).
 *
 * A SKIP IS NOT ALWAYS A POLICY DECISION, and the exit code now says which (issue #164).
 * `InitResult.blocked` holds the destinations that do NOT resolve to a regular file once the run
 * is over — the mechanical form of "the payload piece is not there". Never-clobber skips (a file
 * of the user's, or a live symlink to one) resolve, so they stay exit 0; a dangling link, a
 * directory in the way, an EACCES or a failed ancillary write do not, and `cli.ts` exits 1. That
 * distinction matters because C16 makes an absent agent def a REFUSAL at every model-calling
 * tool, so an install that silently omitted one is not incomplete, it is non-functional.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isNonRegularFile, isRegularFile } from "./fsguard.js";

// ---------------------------------------------------------------------------
// "Shipped" — the payload the RUNNING code would install (issue #94).
//
// This module lives at `<pkg>/src/init.ts` in dev and `<pkg>/dist/init.js` once built, so
// `dirname(self)/..` is the package directory in BOTH — and therefore under `npx` (which
// materializes the package into its own cache and runs it from there) and under a global
// `npm i -g modelguild` alike. It is deliberately derived from `import.meta.url` rather
// than from the cwd or an env var: skew is a claim about the code that is executing, so
// "shipped" must be read from where that code actually lives.
//
// `cli.ts` imports this rather than recomputing it, so the installer's notion of the
// package root and the skew check's cannot drift apart.
// ---------------------------------------------------------------------------
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The running package's version — the suppression key for the start-up notice
 * (`src/notice.ts`). `npm` always ships `package.json`, so it is present beside `dist/`
 * in a published install as well as in a source checkout.
 *
 * An unreadable/absent version returns `""`, and callers treat that as "do not suppress":
 * a version we cannot name is not a version we can claim the user has already been told
 * about. Never throws — a broken read must degrade the notice, not the server.
 */
export function packageVersion(packageRoot: string = PACKAGE_ROOT): string {
  try {
    const parsed = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof parsed.version === "string" ? parsed.version : "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Payload inventory — explicit, like install.sh's PAYLOAD_FILES (no dir walk: a
// source tree can hold ignored/personal files a walk would sweep in).
// ---------------------------------------------------------------------------
/**
 * The command docs, installed to `.claude/commands/guild/` — the subdirectory is the
 * NAMESPACE, not tidiness (AGENTS.md carries the rule; this is the evidence for it).
 *
 * Our `/review` was found colliding with a bundled `review` skill in a live session
 * (2026-07-15); the namespace is what fixes that. The collision is silent — the installer
 * keeps the user's file — so nothing surfaces it but a human noticing the wrong command ran.
 *
 * The published Claude Code docs claim subdirectories do NOT namespace a command. Observed
 * behaviour is `/guild:consult`, verified live. Check the live skill list before trusting a
 * doc claim about command naming.
 */
const COMMAND_DOCS = [
  "consult",
  "panel",
  "research",
  "review",
  "delegate",
  "workshop",
  "collaborate",
  "configure",
] as const;
/** The hardened agents the MCP tools resolve. guild-watch is witness-only (retired). */
const AGENT_DEFS = ["guild-read", "guild-build", "guild-research"] as const;
const TEMPLATES = ["models.policy", "modelguild.conf.example"] as const;

export interface PayloadEntry {
  /** Path relative to the package root (source). */
  src: string;
  /** Path relative to the target project (destination). Equal to src here. */
  dest: string;
}

export function payloadFiles(): PayloadEntry[] {
  const out: PayloadEntry[] = [];
  for (const c of COMMAND_DOCS) {
    const rel = `.claude/commands/guild/${c}.md`;
    out.push({ src: rel, dest: rel });
  }
  for (const a of AGENT_DEFS) {
    const rel = `.opencode/agent/${a}.md`;
    out.push({ src: rel, dest: rel });
  }
  for (const t of TEMPLATES) {
    const rel = `modelguild/${t}`;
    out.push({ src: rel, dest: rel });
  }
  return out;
}

/** The command docs, for the shadow warning (a same-named non-ours command is silent). */
const COMMAND_DEST_RELS = new Set(
  COMMAND_DOCS.map((c) => `.claude/commands/guild/${c}.md`),
);

/** The PAYLOAD destinations alone. `InitResult.blocked` also carries the ancillary `.mcp.json`
 * and `.gitignore`, and uninstall's record-retention rule (issue #176) turns only on a payload
 * file being left behind — an ancillary write that failed leaves nothing needing proof of
 * ownership. Derived from `payloadFiles()` so it cannot drift from it. */
const PAYLOAD_DESTS = new Set(payloadFiles().map((f) => f.dest));

/** Deepest-first, pruned on uninstall only when empty (a user file keeps its dir). */
const PRUNE_DIRS = [
  ".claude/commands/guild",
  ".claude/commands",
  ".claude",
  ".opencode/agent",
  ".opencode",
  "modelguild",
];

const RECORD_REL = "modelguild/.modelguild-install.json";
const MCP_KEY = "modelguild";

// ---------------------------------------------------------------------------
// Destination resolution — project (default) vs global.
//
// A payload entry's project-relative `dest` (e.g. `.claude/commands/guild/consult.md`) is
// the stable RECORD KEY in BOTH modes; only the on-disk base changes. `payloadDest` maps a
// dest-rel to `{ base, rel }` so callers pick the rule for their question: `safeJoin(base,
// rel)` (project writes — refuse any symlinked component), `globalJoin(base, rel)` (global
// writes — follow directory links, issue #156) or `path.join(base, rel)` (plain existence
// check, doctor, which follows links and so already saw a dotfiles-managed layout).
// ---------------------------------------------------------------------------
export interface GlobalDirs {
  /** Resolved home dir (defaults to os.homedir()). */
  homeDir: string;
  /** Resolved XDG config home ($XDG_CONFIG_HOME else <homeDir>/.config). */
  xdgConfigHome: string;
}

/** Resolve the global-mode home + XDG dirs, applying injectable overrides ONCE (never read
 * unmockably in a loop). */
export function resolveGlobalDirs(opts: {
  homeDir?: string;
  xdgConfigHome?: string;
  env?: NodeJS.ProcessEnv;
}): GlobalDirs {
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir && opts.homeDir.length > 0 ? opts.homeDir : os.homedir();
  const xdgConfigHome =
    opts.xdgConfigHome && opts.xdgConfigHome.length > 0
      ? opts.xdgConfigHome
      : env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
        ? env.XDG_CONFIG_HOME
        : path.join(homeDir, ".config");
  return { homeDir, xdgConfigHome };
}

/**
 * Map a project-relative payload `dest` to its on-disk `{ base, rel }` for the given mode.
 * Project mode: base is the target project (`dest` unchanged). Global mode: commands/policy
 * land under `<home>/.claude/…`, agent defs under `<xdg>/opencode/agent/`.
 */
export function payloadDest(
  destRel: string,
  opts: { global?: boolean; targetDir: string; global_dirs?: GlobalDirs },
): { base: string; rel: string } {
  if (!opts.global) return { base: opts.targetDir, rel: destRel };
  const g = opts.global_dirs;
  if (!g) throw new Error("payloadDest: global mode requires resolved global dirs");
  if (destRel.startsWith(".claude/commands/guild/")) {
    return { base: g.homeDir, rel: destRel }; // <home>/.claude/commands/guild/<name>.md
  }
  if (destRel.startsWith(".opencode/agent/")) {
    // <xdg>/opencode/agent/guild-<x>.md — SINGULAR `agent`, the dir opencode resolves.
    return { base: g.xdgConfigHome, rel: path.join("opencode", destRel.slice(".opencode/".length)) };
  }
  if (destRel.startsWith("modelguild/")) {
    return {
      base: g.homeDir,
      rel: path.join(".claude", "modelguild", destRel.slice("modelguild/".length)),
    };
  }
  throw new Error(`payloadDest: unmapped payload dest '${destRel}'`);
}

/** The full install/uninstall plan for a run: how to resolve each dest, where the ownership
 * record lives, which dirs to prune, and whether a project `.gitignore` block applies. */
interface InstallPlan {
  destFor(destRel: string): string; // absolute, symlink-safe
  recordPath: string;
  pruneDirs: string[]; // absolute, deepest-first
  gitignoreDir?: string; // project mode only
  /** Warnings produced while RESOLVING the plan, replayed into the result. Only the uninstall
   * path produces any (a symlinked record path it reads through rather than refuses). */
  warnings: string[];
}

/**
 * Absolute path of the ownership record for a mode. It goes through `payloadDest` with the
 * record's own project-relative path, so the project/global mapping can never drift from the
 * payload's (`modelguild/…` → project `modelguild/` or global `<home>/.claude/modelguild/`).
 * Exported for `doctor`, which must read the record of the mode a file was found in.
 */
export function recordPathFor(opts: {
  global?: boolean;
  targetDir: string;
  global_dirs?: GlobalDirs;
}): string {
  const { base, rel } = payloadDest(RECORD_REL, opts);
  return path.join(base, rel);
}

/**
 * Resolve the plan, and — on an INSTALL — perform every path-level check the run can make
 * before it writes anything (issues #167/#160; see the module header for why "when" is the
 * whole point). `--global` needs no payload pass: `globalJoin` follows directory links by
 * decision (C77) and its only refusal is `validRel`, which cannot fail for the module's own
 * constants. What it does need is the record check, which it already had.
 *
 * NOTHING HERE RUNS ON `--uninstall`, and that is the fix for the regression this shape
 * carried on `wip/issue-156-full-review-work`: an eager destination check applied to the
 * removal path let a broken component in ONE destination tree abort removal from the OTHER.
 * Uninstall's job is removal; a destination it cannot resolve is one file kept with a warning
 * (see `init`), never a run that refuses.
 */
function planFor(opts: InitOptions): InstallPlan {
  const warnings: string[] = [];
  if (opts.global) {
    const g = resolveGlobalDirs(opts);
    const destOpts = { global: true as const, targetDir: opts.targetDir, global_dirs: g };
    // The eager pass for `--global`: the DIRECTORY chain of every destination and of the
    // ownership record. Install only — see `checkGlobalDirChain` for why running it on
    // `--uninstall` is the regression this shape must not carry.
    if (!opts.uninstall) {
      for (const { dest } of [...payloadFiles(), { dest: RECORD_REL }]) {
        const { base, rel } = payloadDest(dest, destOpts);
        checkGlobalDirChain(base, rel, dest === RECORD_REL ? "the ownership record" : dest);
      }
    }
    return {
      destFor: (rel) => {
        const { base, rel: r } = payloadDest(rel, destOpts);
        return globalJoin(base, r);
      },
      recordPath: (() => {
        const { base, rel } = payloadDest(RECORD_REL, destOpts);
        const p = globalJoin(base, rel);
        // Only an INSTALL writes the record; `--uninstall` reads it and unlinks the link, so
        // a link the write could not have followed must not stop a removal.
        if (!opts.uninstall) {
          assertRecordPathWritable(p);
          assertRecordLinkWritable(p);
        }
        return p;
      })(),
      pruneDirs: [
        path.join(g.homeDir, ".claude", "commands", "guild"),
        path.join(g.homeDir, ".claude", "commands"),
        path.join(g.xdgConfigHome, "opencode", "agent"),
        path.join(g.homeDir, ".claude", "modelguild"),
      ],
      warnings,
    };
  }
  let recordPath: string;
  if (opts.uninstall) {
    // `path.join`, NOT `safeJoin`: a symlinked record path used to throw from HERE, before the
    // removal loop, so `--uninstall` was impossible and the only way out was deleting the link
    // by hand — which the message did not mention (issue #167). Reading through the link is
    // safe enough to prefer over that dead end: removal is still hash-gated per file, and the
    // final `unlinkSync` removes the LINK and never its target (C77). Named, not silent.
    // Cost, stated: a record planted behind that link decides which of the 13 fixed payload
    // paths a removal will delete — bounded to files whose bytes already hash to a value the
    // planter chose, in a repository they can already write to.
    //
    // THE FINAL SENTENCE IS CONDITIONAL SINCE ISSUE #176, and the tense is the whole of it. It
    // used to promise the link would be removed, which was safe only while that removal was
    // unconditional; the retention branch in `init` KEEPS the record — and therefore the link —
    // whenever a payload file is blocked, so the flat promise became a plan-time claim about an
    // action that may not happen — which is why this says "if the removal completes" and `init`
    // states the actual outcome where it is known.
    recordPath = path.join(opts.targetDir, RECORD_REL);
    const link = resolveRecordLink(recordPath);
    if (link) {
      warnings.push(
        `reading the ownership record through a symlink — ${recordPath} links to ${link.target}` +
          `${link.live ? "" : " (dangling, so nothing is owned)"}. Files are still removed only ` +
          `where their bytes match what that record says init wrote; if the removal completes, ` +
          `the link itself is removed at the end and its target left alone.`,
      );
    }
  } else {
    // Payload destinations FIRST — the eager pass. `safeJoin` is unchanged in what it refuses
    // (project mode keeps refuse-any-directory-component); running it here is what makes the
    // refusal cost nothing (issue #167).
    for (const { dest } of payloadFiles()) safeJoin(opts.targetDir, dest);
    recordPath = safeJoin(opts.targetDir, RECORD_REL);
    // `safeJoin` refuses a symlinked component; it says nothing about a FIFO, which the record
    // write blocks on forever (issue #162, C78). Install-only, as in global mode.
    assertRecordPathWritable(recordPath);
    // C77 scoped this to `--global`, where the move off `safeJoin` had introduced it. The same
    // layout reaches the same unrepairable state in PROJECT mode — a dangling record link whose
    // target directory is missing passes `safeJoin`, the payload installs, and `writeRecords`
    // then raises a raw ENOENT with no record written — so the two enumerated refusals now
    // cover both modes. Install only, as before: `--uninstall` writes no record.
    assertRecordLinkWritable(recordPath);
    // …AND `.mcp.json` UNDER `--write-mcp` (issue #160). It was resolved LATE — after the
    // payload loop and before `writeRecords` — so a symlink, a non-regular file or unparseable
    // JSON there left a full payload on disk with NO ownership record, which no retry could
    // repair. Everything knowable is decided here instead, with nothing written.
    //
    // `.gitignore` is deliberately NOT refused here, and that is a resolution toward C78 rather
    // than an omission: it is the LAST step of an install whose payload and record are already
    // down, so `addGitignoreBlock` SKIPS every shape it cannot write and warns. Refusing the
    // whole install over an ignore-rule convenience would be the wrong direction for the same
    // reason C78 gives. THAT CLAIM WAS FALSE FOR A LIVE SYMLINK UNTIL ISSUE #174 — the function
    // opened with `safeJoin`, which throws there, so the install completed and then died with
    // `Nothing was installed.` If you move `.gitignore` handling, the invariant to preserve is
    // that this function never throws.
    if (opts.writeMcp) {
      const mcpAbs = safeJoin(opts.targetDir, ".mcp.json");
      const dangling = danglingLinkAt(mcpAbs);
      if (dangling !== undefined) {
        throw new Error(
          `refusing destination symlink: ${mcpAbs} (the project .mcp.json) is a symlink` +
            `${dangling ? ` to '${dangling}'` : ""} whose target does not exist, and writing it ` +
            `would create that file OUTSIDE this project. Nothing was installed — this is refused ` +
            `before any file is written, because an install that dies here leaves a payload with ` +
            `no ownership record that neither a re-run nor \`--uninstall\` can repair. Remove the ` +
            `link (\`rm ${mcpAbs}\`), then re-run.`,
        );
      }
      // The non-regular refusal (C78) and the unparseable-JSON refusal both live in
      // `readMcpRootForMerge`; `writeMcpJson` calls the same function again for real, so the
      // eager check and the write cannot disagree about what is acceptable.
      readMcpRootForMerge(mcpAbs);
    }
  }
  return {
    // The mode rides on the closure so the uninstall loop's embedded message is written for the
    // run it is actually in (issue #176).
    destFor: (rel) => safeJoin(opts.targetDir, rel, opts.uninstall ? "uninstall" : "install"),
    recordPath,
    pruneDirs: PRUNE_DIRS.map((d) => path.join(opts.targetDir, d)),
    gitignoreDir: opts.targetDir,
    warnings,
  };
}

const GITIGNORE_BEGIN = "# >>> ModelGuild >>>";
const GITIGNORE_END = "# <<< ModelGuild <<<";
const GITIGNORE_BODY = [
  GITIGNORE_BEGIN,
  "# Per-user config written by /guild:configure — never commit personal prefs.",
  "modelguild/models.policy.local",
  "modelguild/modelguild.conf.local",
  // NOTE (issue #94): the payload-skew notice's suppression state is deliberately NOT listed
  // here, because it is deliberately not written into a project at all — see `src/notice.ts`.
  // An ignore line added here would only reach projects that RE-RAN `init`, which is exactly
  // the population that no longer needs it.
  "# The evidence layer: raw prompts/responses of every model call (modelguild/logs).",
  "modelguild/logs/",
  GITIGNORE_END,
  "",
].join("\n");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface ServerLaunch {
  command: string;
  args: string[];
  /** Extra env keys to write into the `.mcp.json` server entry (GUILD_PROJECT_DIR is
   * always added by init from the target dir). */
  env?: Record<string, string>;
}

export interface InitOptions {
  /** Absolute path to the target project the payload lands in. Ignored when `global`. */
  targetDir: string;
  /** Absolute path to the package root the payload is read from. */
  packageRoot: string;
  /** How `.mcp.json` should launch the MCP server (command/args/env). */
  serverLaunch: ServerLaunch;
  /** true → uninstall (hash-verified removal) instead of install. */
  uninstall?: boolean;
  /** OPT-IN: write/merge the project `.mcp.json` server entry (the old auto-write). Default
   * false — the user registers the server themselves (`claude mcp add`, their choice of
   * scope), so `mcpAction` is `"skipped"` unless this is set. Ignored (forced skipped) in
   * `global` mode — there is no project `.mcp.json`. */
  writeMcp?: boolean;
  /**
   * GLOBAL payload install: place the payload into the user's global config so `/guild:*`,
   * the hardened agent defs, and the policy are available in EVERY project without a
   * per-project `init`. Destinations change (SOURCE files are identical, only DEST differs):
   *   command docs → `<homeDir>/.claude/commands/guild/<name>.md`
   *   agent defs   → `<xdgConfigHome>/opencode/agent/guild-<x>.md`
   *   policy/conf  → `<homeDir>/.claude/modelguild/<file>`
   *   record       → `<homeDir>/.claude/modelguild/.modelguild-install.json` (SEPARATE from
   *                  the per-project record so the two installs never read each other's).
   * No `.gitignore` block is written (there is no project). Same SHA-256 ownership semantics.
   */
  global?: boolean;
  /** Home dir for global-mode destinations. INJECTABLE for tests; defaults to `os.homedir()`.
   * Resolved once (not read unmockably inside the payload loop). */
  homeDir?: string;
  /** XDG config home for the global opencode agent dir. INJECTABLE for tests; defaults to
   * `$XDG_CONFIG_HOME` else `<homeDir>/.config`. */
  xdgConfigHome?: string;
}

export interface InitResult {
  installed: string[];
  skipped: string[];
  removed: string[];
  /** Command docs a user already had at our path that are NOT ours (shadowing). */
  shadowed: string[];
  /** UPGRADE DRIFT (issue #22): files init wrote, the user then edited, whose shipped bytes have
   * CHANGED since the version that edit was based on — so this upgrade skipped them and the
   * user's copy is now behind the release. Reported, never touched.
   *
   * There is deliberately NO `skewed` counterpart here (issue #94): an untouched file that is
   * behind the release passes the ownership check, so THIS RUN just upgraded it. Skew is a
   * state only an observer that is not installing can be in — `doctor`, `guild_status`, and the
   * server's start-up notice. Reporting it from `init` would be reporting what init just fixed. */
  drifted: PayloadFileState[];
  /**
   * THE SKIPS THAT ARE NOT POLICY (issue #164) — the destinations this run was expected to
   * produce and that, once it was over, do NOT resolve to a regular file. `cli.ts` exits 1 on a
   * non-empty list, so `install.sh` or a CI wrapper can tell a broken install from a good one.
   *
   * The test is mechanical rather than a taxonomy of causes, and that is what keeps it honest:
   * a never-clobber skip leaves the user's own file (or a live symlink to one) at the path, so
   * it resolves and stays exit 0 — a re-install that declines to clobber an edit is the
   * ownership model working, not a failure. A dangling link, a directory or FIFO in the way, an
   * EACCES, a failed ancillary write: nothing resolves, and the piece is missing. On
   * `--uninstall` it is the mirror image — what could not be REMOVED for an environmental
   * reason. A file kept because no record proves it is ours, or because its bytes changed, is
   * policy and is not listed.
   */
  blocked: string[];
  warnings: string[];
  /** `.mcp.json` outcome. `kept` (uninstall only): a `modelguild` key was present but left in
   * place because the ownership record does not prove init wrote it, or the current entry no
   * longer matches what init wrote — mirrors the skip-if-edited file guarantee. */
  mcpAction: "created" | "merged" | "updated" | "removed" | "unchanged" | "skipped" | "kept";
}

type Records = Record<string, string>; // destRel -> sha256(hex)

/** Proof that init wrote the project `.mcp.json` `modelguild` key: the key name plus the
 * sha256 of the exact entry init serialized. Persisted in the ownership record only on a
 * `--write-mcp` install; absent for a default install (init did not touch `.mcp.json`). */
interface McpRecord {
  key: string;
  entryHash: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Reject `..`, absolute, and empty components — the valid_rel guard from install.sh. */
function validRel(rel: string): boolean {
  if (!rel || path.isAbsolute(rel)) return false;
  const parts = rel.split("/");
  return parts.every((p) => p.length > 0 && p !== "..");
}

/**
 * Resolve `<base>/<rel>` refusing a symlinked DIRECTORY component, and a LIVE symlinked leaf —
 * the safe_dest_rel guard: a planted symlink must not redirect a write outside `base`. PROJECT
 * MODE ONLY since issue #156; `--global` uses `globalJoin` below — the project target is
 * somebody's source repo, the global target is the user's own config.
 *
 * THE GATE IS `lstat`, NOT `existsSync` (issue #159). `existsSync` FOLLOWS, so it answered
 * **false** for a DANGLING link and the guard skipped that component entirely. At a directory
 * component that produced a raw `ENOENT` from `ensureDir` PARTWAY THROUGH the install — the
 * unrepairable state of issue #167 by another route (reproduced on this base: `.opencode` as a
 * dangling link installs the 8 command docs, then dies with `ENOENT … mkdir`, no record). The
 * out-of-tree WRITE the issue reports is no longer reachable here — `mkdir -p` will not create
 * through a dangling link, and C77's `lstat`-based `entryExists` already stopped the leaf case —
 * but that is `mkdir(2)`'s behaviour holding the line, not this guard, and the guard's own
 * contract says a symlinked component is refused.
 *
 * THE LEAF IS DELIBERATELY ASYMMETRIC, and it is C77's rule, not a new one: a LIVE leaf link is
 * refused by name (unchanged), while a DANGLING one falls through to the install loop's
 * never-clobber branch, which skips it with a warning. Refusing it here would revert #156's
 * shipped decision. A directory component has no such branch to fall into — it redirects
 * everything below it — so it is refused whether it resolves or not.
 */
function safeJoin(base: string, rel: string, mode: "install" | "uninstall" = "install"): string {
  if (!validRel(rel)) throw new Error(`refusing unsafe path: ${rel}`);
  const parts = rel.split("/");
  let cur = base;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    let isLink: boolean;
    try {
      isLink = lstatSync(cur).isSymbolicLink();
    } catch {
      continue; // nothing there — `mkdir -p` will create it, and the write decides the rest
    }
    if (!isLink) continue;
    if (i === parts.length - 1 && !existsSync(cur)) continue; // dangling leaf ⇒ the skip branch
    // NAME THE ABSOLUTE PATH, THE OFFENDING COMPONENT AND A REMEDY (issue #167): the old text
    // was `refusing destination symlink: <dest-rel>`, a relative path with no base, so under
    // some layouts the user could not tell which file to remove — and it said nothing about
    // `--uninstall`, which the same refusal used to block outright. The leading phrase is kept
    // verbatim because it is what a user searching for this error already has.
    let target = "";
    try {
      target = readlinkSync(cur);
    } catch {
      /* unreadable link target — the message just omits it */
    }
    // THE TAIL IS PER-MODE (issue #176). The uninstall loop embeds this message verbatim into
    // `keeping <dest> — …`, so the install-only sentences were printed BY `--uninstall`: it said
    // `Nothing was installed.` in a run that had just removed ten files, and `\`--uninstall\` is
    // not blocked by this` in a run that then exited 1. The leading phrase, the component and the
    // remedy are identical in both modes — only the consequence sentence differs — because that
    // phrase is what a user searching for this error already has (issue #167).
    const tail =
      mode === "uninstall"
        ? `That file is left in place, untouched, and the rest of the removal continues. Remove ` +
          `the link (\`rm ${cur}\`) and re-run \`--uninstall\` to finish removing it.`
        : `Nothing was installed. Remove the link (\`rm ${cur}\`) and re-run. \`--uninstall\` is ` +
          `not blocked by this: it keeps that file, with the same warning, and removes the rest.`;
    throw new Error(
      `refusing destination symlink: ${path.join(base, rel)} — the path component ${cur} is a ` +
        `symlink${target ? ` to '${target}'` : ""}, and a project destination is never resolved ` +
        `through one (it can redirect a write out of ${base}). ${tail}`,
    );
  }
  return cur;
}

/** The errno of a caught fs error, so a warning says something rather than nothing. */
function errCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code ?? (err instanceof Error ? err.message : "unknown error");
}

/**
 * The link target when `p` is a symlink that does NOT resolve, else `undefined`.
 *
 * The one shape `fsguard` deliberately leaves alone (C78: "a write through a dangling link
 * creates its target and does not block, so refusing there would change behaviour this issue is
 * not about"), and the one shape the ANCILLARY files still need decided — because they have no
 * never-clobber branch to fall into. `safeJoin` refuses a LIVE leaf link, `isNonRegularFile`
 * catches a FIFO or a directory, and a dangling link slips between the two: the write follows it
 * and creates the target OUTSIDE the project (issue #159's write-through, at `.gitignore` /
 * `.mcp.json` rather than at a payload path).
 *
 * `lstat` is correct here precisely because the question IS about the link rather than its
 * target — the exception C78 names.
 */
function danglingLinkAt(p: string): string | undefined {
  try {
    if (!lstatSync(p).isSymbolicLink()) return undefined;
  } catch {
    return undefined; // absent
  }
  if (existsSync(p)) return undefined; // a LIVE link — somebody else's rule decides it
  try {
    return readlinkSync(p);
  } catch {
    return ""; // a dangling link whose target cannot be read — still dangling
  }
}

/**
 * Resolve `<base>/<rel>` for a GLOBAL install (issue #156): the `..`/absolute/empty guard
 * still applies, but a symlinked DIRECTORY component is followed rather than refused — a
 * dotfiles-managed `~/.claude` or `<xdg>/opencode` is a symlink, and refusing it made
 * `--global` install nothing at all. The LEAF is deliberately not decided here: the install
 * loop's existing never-clobber branch skips a destination that is not a regular file.
 */
function globalJoin(base: string, rel: string): string {
  if (!validRel(rel)) throw new Error(`refusing unsafe path: ${rel}`);
  return path.join(base, rel);
}

/** What one DIRECTORY component of a global destination is, after following links. */
type DirComponent =
  | { kind: "absent" }
  | { kind: "dir" }
  | { kind: "dangling"; target: string }
  | { kind: "not-a-dir" }
  | { kind: "error"; code: string };

/**
 * Classify a single directory component. Two syscalls, deliberately: `lstat` answers "is this a
 * link?" — needed to tell a DANGLING link from a plain absence, which report the same errno —
 * and `stat` answers "does it resolve to a directory?".
 */
function probeDirComponent(abs: string): DirComponent {
  let link = false;
  try {
    link = lstatSync(abs).isSymbolicLink();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "absent" };
    return { kind: "error", code: code ?? "unknown" };
  }
  try {
    return statSync(abs).isDirectory() ? { kind: "dir" } : { kind: "not-a-dir" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      if (!link) return { kind: "absent" }; // raced away between the two calls
      let target = "";
      try {
        target = readlinkSync(abs);
      } catch {
        /* unreadable link target — the message just omits it */
      }
      return { kind: "dangling", target };
    }
    return { kind: "error", code: code ?? "unknown" };
  }
}

/**
 * Validate the DIRECTORY components of a `--global` destination before anything is written.
 *
 * `globalJoin` follows directory links by decision (C77) and dropped `safeJoin`'s per-component
 * inspection WITHOUT substituting any diagnosis, so a half-applied stow layout produced a raw
 * `mkdir` errno from inside the payload loop rather than a sentence about the broken link. Three
 * routes were reproduced on this base and all three leave the unrepairable state — payload
 * partly on disk, NO ownership record, a re-run failing identically and `--uninstall` able to
 * prove nothing: a DANGLING `<home>/.claude/modelguild` (11 of 13 files, `ENOENT … mkdir`), an
 * `<xdg>/opencode` linking to a REGULAR FILE (8 files, `ENOTDIR … mkdir`), and the same shape at
 * any other component. `assertRecordLinkWritable` cannot see the first of those: it `lstat`s the
 * record path, which throws ENOENT when a parent does not resolve, so it returns "no link here"
 * and refuses nothing.
 *
 * Absent is fine — `mkdir -p` creates it, and nothing below an absent directory can exist, so
 * the walk stops. A link to a real directory is fine: that is the layout the whole `--global`
 * change exists to support. Everything else is refused, NAMING the absolute destination, the
 * offending component and a remedy.
 *
 * INSTALL ONLY. Running this on `--uninstall` is precisely the regression
 * `wip/issue-156-full-review-work` carried: a broken component in one destination tree aborted
 * removal from the other, and uninstall's job is removal.
 */
function checkGlobalDirChain(base: string, rel: string, what: string): void {
  const parts = rel.split("/");
  let cur = base;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = path.join(cur, parts[i]);
    const probe = probeDirComponent(cur);
    if (probe.kind === "dir") continue;
    if (probe.kind === "absent") return; // nothing below an absent directory can exist either
    const head =
      `modelguild init --global: refusing to place ${what} at ${path.join(base, rel)}`;
    const cost =
      ` Nothing was installed — refusing here costs nothing, whereas failing from the write ` +
      `leaves a payload with no ownership record that no re-run or \`--uninstall\` can repair.`;
    if (probe.kind === "dangling") {
      throw new Error(
        `${head} — the directory component ${cur} is a symlink` +
          `${probe.target ? ` to '${probe.target}'` : ""} whose target does not exist.${cost} ` +
          `Restore that directory or remove the link (\`rm ${cur}\`), then re-run.`,
      );
    }
    if (probe.kind === "not-a-dir") {
      throw new Error(
        `${head} — ${cur} exists but is not a directory.${cost} Move it aside, then re-run.`,
      );
    }
    throw new Error(
      `${head} — could not resolve the directory component ${cur} (${probe.code}` +
        `${probe.code === "ELOOP" ? ", a symlink loop" : ""}).${cost} Fix that path, then re-run.`,
    );
  }
}

/**
 * True when a path has an entry of its own — a DANGLING symlink included, which `existsSync`
 * (it follows) reports as absent. The install loop gates its never-clobber check on this so a
 * dangling leaf link reaches the not-a-regular-file branch instead of being written THROUGH.
 */
function entryExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function readRecords(recordPath: string): Records {
  const p = recordPath;
  // `isRegularFile`, not `existsSync`: a FIFO here answered TRUE and hung every init run on
  // the read below, which no `catch` can reach (issue #162). A non-regular path is treated
  // exactly like an unreadable one — no records, so nothing is "owned".
  if (!isRegularFile(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as { files?: unknown };
    const files = parsed.files;
    if (files && typeof files === "object") {
      const out: Records = {};
      for (const [k, v] of Object.entries(files as Record<string, unknown>)) {
        if (typeof v === "string" && /^[0-9a-f]{64}$/.test(v)) out[k] = v;
      }
      return out;
    }
  } catch {
    /* unreadable/corrupt → treat as no records (conservative: nothing is "owned") */
  }
  return {};
}

/** Read the MCP ownership proof from the record, if present and well-formed. A missing/legacy
 * record (no `mcp` field) or an unreadable one returns `undefined` — treated as NOT owned, so
 * uninstall never deletes a `.mcp.json` key it cannot prove init wrote. */
function readMcpRecord(recordPath: string): McpRecord | undefined {
  if (!isRegularFile(recordPath)) return undefined; // issue #162 — see `readRecords`
  try {
    const parsed = JSON.parse(readFileSync(recordPath, "utf8")) as { mcp?: unknown };
    const m = parsed.mcp;
    if (m && typeof m === "object" && !Array.isArray(m)) {
      const key = (m as Record<string, unknown>).key;
      const entryHash = (m as Record<string, unknown>).entryHash;
      if (typeof key === "string" && key.length > 0 && typeof entryHash === "string" && /^[0-9a-f]{64}$/.test(entryHash)) {
        return { key, entryHash };
      }
    }
  } catch {
    /* unreadable/corrupt → undefined (conservative: nothing is "owned") */
  }
  return undefined;
}

/**
 * The record path's own symlink, resolved: `{ target, live }`, or `undefined` when the path
 * holds no entry or is not a link — the normal case. `live` comes from `existsSync`, which
 * FOLLOWS the link, so `false` means DANGLING. Never throws: an unreadable link resolves to
 * `undefined`, the same as no link at all. Shared by the plan-time refusal below and the
 * pre-write warning, so the two can never describe the same link differently.
 */
function resolveRecordLink(recordPath: string): { target: string; live: boolean } | undefined {
  let linkText: string;
  try {
    if (!lstatSync(recordPath).isSymbolicLink()) return undefined;
    linkText = readlinkSync(recordPath);
  } catch {
    return undefined; // nothing there (the normal case), or unreadable — nothing to say
  }
  return {
    target: path.resolve(path.dirname(recordPath), linkText),
    live: existsSync(recordPath),
  };
}

/**
 * REFUSE — at PLAN time, before a single payload byte is written — a DANGLING record symlink
 * the write could not have followed (issue #156). `writeRecords` creates `dirname(recordPath)`,
 * which is the LINK's directory and not the TARGET's, so such a write raised a raw errno — and
 * raised it AFTER the whole payload was on disk, leaving an install with NO ownership record: a
 * re-run crashed identically and `--uninstall` could prove nothing was ours, so nothing was
 * removable. That is the unrepairable partial install this whole change exists to avoid, and
 * `safeJoin` refused these layouts cleanly before global mode stopped using it. Checked HERE
 * because the record path is the one destination `planFor` already resolves eagerly, so the
 * refusal lands where the mode's other record-path decisions do.
 *
 * THREE NAMED CONDITIONS, ENUMERATED — still NOT a general "can this write succeed?" predicate:
 * the target's directory is ABSENT (`ENOENT`), it is present
 * but NOT A DIRECTORY (`ENOTDIR`), or — added for the symlink LOOP that reproduced the identical
 * state, 13 files on disk and no record — the record path cannot be RESOLVED at all although its
 * target's directory is fine. Each is refused with wording naming which it is. Anything else is
 * left to fail from the write; try-and-report is a separate design question this does not
 * settle. The stats are POSITIVE evidence only: a stat that cannot be taken refuses nothing.
 *
 * Creating (or replacing) the target's directory was considered and REJECTED: init making
 * directories wherever a user's link happens to point is a bigger step than declining. The
 * working cases are untouched — a LIVE link, and a dangling link whose target directory EXISTS,
 * are both still written through with `recordSymlinkWarning`'s warning.
 *
 * BOTH MODES since issues #167/#160 (C77 scoped it to `--global`, where the move off `safeJoin`
 * had introduced it). Project mode reaches the identical unrepairable state by the identical
 * route — `safeJoin` lets a DANGLING record link through, the payload installs, and the write
 * raises the same raw errno with no record — and there is no reason for the same layout to be
 * refused in one mode and crash in the other. Still install-only.
 */
/**
 * REFUSE — at PLAN time, before a single payload byte is written — an ownership-record path
 * that is not a regular file: a FIFO, a directory, a socket (issue #162).
 *
 * `writeRecords` writes this path unconditionally, and `writeFileSync` to a FIFO BLOCKS
 * forever with no writer on the other end. That is not an exception, so the install did not
 * fail — it HUNG, after the whole payload was already on disk, on the default project path
 * with no flag. Same placement and same reasoning as `assertRecordLinkWritable` above: the
 * record path is the one destination `planFor` resolves eagerly, so refusing here leaves
 * nothing written. Install-only for the same reason — `--uninstall` writes no record.
 *
 * Both modes, unlike `assertRecordLinkWritable`: project mode's `safeJoin` refuses a symlink,
 * not a FIFO, so it had the identical hang.
 */
function assertRecordPathWritable(recordPath: string): void {
  if (!isNonRegularFile(recordPath)) return;
  throw new Error(
    `refusing to install: the ownership record path ${recordPath} exists and is not a regular ` +
      `file. Writing it would block forever (a FIFO) or fail (a directory). Remove or move ` +
      `whatever is there, then re-run init.`,
  );
}

function assertRecordLinkWritable(recordPath: string): void {
  const link = resolveRecordLink(recordPath);
  if (!link || link.live) return; // no link, or one that resolves to an existing file
  const targetDir = path.dirname(link.target);
  // The shared middle of both refusals: what it costs, and that nothing has been written yet.
  const why =
    ` — the record cannot be written there, and an install with no record leaves nothing for a ` +
    `re-run or --uninstall to verify. Nothing was installed. `;
  if (!existsSync(targetDir)) {
    throw new Error(
      `the ownership record ${recordPath} is a symlink to ${link.target}, whose directory ` +
        `${targetDir} does not exist${why}Create ${targetDir}, or remove the link, then re-run init.`,
    );
  }
  // `statSync` FOLLOWS links, so a symlinked directory is fine and a link to a file is not.
  // Refuse only on POSITIVE evidence: a stat that throws leaves the write to report it.
  let isDir: boolean;
  try {
    isDir = statSync(targetDir).isDirectory();
  } catch {
    return;
  }
  if (!isDir) {
    throw new Error(
      `the ownership record ${recordPath} is a symlink to ${link.target}, but ${targetDir} is not ` +
        `a directory${why}Replace ${targetDir} with a directory, or remove the link, then re-run init.`,
    );
  }
  // A THIRD ENUMERATED CONDITION, and it sits LAST because the two above are the more specific
  // diagnoses of the same errnos. `link.live` comes from `existsSync`, which reports false for a
  // symlink LOOP exactly as it does for a dangling link — so a loop was read as "dangling", the
  // target's directory was a real directory, this returned clean, and `writeFileSync` then
  // raised ELOOP with all 13 files on disk and no record (reproduced). Where the target's
  // directory is fine, a path that still cannot be resolved is a state this cannot describe and
  // must not write into. Still enumerated by observation rather than a general "can this write
  // succeed?" predicate: an absent target (ENOENT) is the normal dangling case and passes.
  try {
    statSync(recordPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      const shown = code ?? "unknown error";
      throw new Error(
        `the ownership record ${recordPath} is a symlink to ${link.target} that cannot be ` +
          `resolved (${shown}${shown === "ELOOP" ? ", a symlink loop" : ""})${why}Fix or remove ` +
          `the link (\`rm ${recordPath}\`), then re-run init.`,
      );
    }
  }
}

/**
 * The ownership record's own path is a SYMLINK: say so (issue #156). It is not skipped, and —
 * except for the two shapes `assertRecordLinkWritable`
 * refuses above — not refused either: the record is written THROUGH the link,
 * because only init writes this file, so there is no user content it is expected to
 * preserve, and a dotfiles manager that links files individually (GNU stow does, when the
 * parent directory already exists) legitimately puts a link here. But a user CAN point that
 * path at a file of their own, and then the bytes land somewhere they did not expect — so
 * name the link and the file the bytes actually go to, the same way the install loop names a
 * skipped payload file. Must be called BEFORE the write: afterwards a dangling link and a
 * live one are indistinguishable. Returns `undefined` for the normal case (no entry, or a
 * regular file). Never throws — a warning that cannot be computed must not fail the install.
 */
function recordSymlinkWarning(recordPath: string): string | undefined {
  const link = resolveRecordLink(recordPath);
  if (!link) return undefined;
  const { target, live } = link;
  return (
    `writing the ownership record through a symlink — ${recordPath} links to ${target}, so the record ` +
    (live ? `replaced that file's contents` : `created that file (the link was dangling)`) +
    `. Remove the link and re-run init to keep the record at ${recordPath} itself.`
  );
}

function writeRecords(recordPath: string, records: Records, mcp?: McpRecord): void {
  mkdirSync(path.dirname(recordPath), { recursive: true });
  const payload: { version: number; files: Records; mcp?: McpRecord } = { version: 1, files: records };
  if (mcp) payload.mcp = mcp;
  const body = JSON.stringify(payload, null, 2) + "\n";
  writeFileSync(recordPath, body);
}

/** Canonical sha256 of a `.mcp.json` server entry, used to prove init wrote it and to detect
 * a later user edit. Relies on JSON key order round-tripping write→parse (init writes the file,
 * so order is preserved); a hand-reordered entry hashes differently and is conservatively kept. */
function mcpEntryHash(entry: unknown): string {
  return sha256(Buffer.from(JSON.stringify(entry), "utf8"));
}

function ensureDir(p: string): void {
  mkdirSync(p, { recursive: true });
}

// ---------------------------------------------------------------------------
// Upgrade drift (issue #22) and payload SKEW (issue #94) — THREE hashes, THREE states.
//
// Every judgement here is made from the same three values:
//   recorded — what init last wrote (proof the file is ours, and which version any edit was
//              based on);
//   current  — what is on disk now;
//   shipped  — what the RUNNING package ships now (see PACKAGE_ROOT).
//
// DRIFT (#22): recorded ≠ current AND recorded ≠ shipped. The user edited the file AND the
// release has since moved on, so the never-clobber skip left them behind. Reported, never
// overwritten.
//
// SKEW (#94): recorded === current (untouched since init wrote it) but ≠ shipped. Nothing was
// edited and nothing was skipped — the file is simply from an older release than the server
// now running, because the server updates via npx and the payload in the user's repo does not.
// This is the state #22's predicate is deliberately silent about, and it was invisible.
//
// SHADOWED / unjudgeable (#22): no ownership record. An intentional edit and a stale leftover
// are byte-identical evidence there, so it stays unjudgeable — calling it either would be a
// guess. Explicitly NOT reclassified as skew.
//
// One further state is deliberately NOTHING: ours, edited, and the release still ships what
// the edit was based on (recorded === shipped) — there is nothing to catch up to.
//
// The three predicates are mutually exclusive by construction: drift requires
// `current !== recorded`, skew requires `current === recorded`, unjudgeable requires no record.
// ---------------------------------------------------------------------------

/** One installed file that differs from the shipped payload, with the hashes that decided it. */
export interface PayloadFileState {
  /** Project-relative payload dest — the stable record key in BOTH modes. */
  dest: string;
  /** Absolute path of the user's copy on disk. */
  installedPath: string;
  /** Absolute path of the bytes this package ships (for the `diff` hint). */
  shippedPath: string;
  /** sha256 of the bytes on disk. For SKEW this is also the recorded hash (that is the
   * definition), so "recorded vs shipped" is exactly this pair. */
  installedHash: string;
  /** sha256 of the bytes this release ships. */
  shippedHash: string;
  /**
   * The ownership record this file was JUDGED AGAINST — project or global, whichever location
   * it was found in. Carried because it is the only value that identifies *which install* the
   * verdict is about: `src/notice.ts` keys its suppression on it, so a global-only
   * payload is announced once across every project that shares it rather than once per project.
   */
  recordPath: string;
  /**
   * The absolute target of a SYMLINK at `installedPath`, when there is one — the stow/chezmoi
   * per-file layout. Absent otherwise, so an ordinary install's shape is byte-identical to one
   * produced before this field existed (C29's optional-field rule).
   *
   * IT EXISTS BECAUSE THE SKEW REMEDY WAS FALSE FOR EXACTLY THESE FILES, and the two halves of
   * that contradiction were each correct on their own. The scan reads THROUGH the link (C78's
   * `stat`, issue #163) — right, because every runtime consumer follows it — so a stowed payload
   * file is judged like any other and lands in `skewed`. `init` then refuses to write through a
   * symlink, so `doctor`'s "these files are unedited, so init rewrites them in place" named a
   * remedy that could not run: `installed=0`, `blocked=[]`, exit 0, the file unchanged, and the
   * next `doctor` reporting the same skew forever. Detection and remedy disagreed, and neither
   * surface could see why.
   *
   * SO THIS CARRIES THE ONE FACT THAT DECIDES THE REMEDY, and nothing more. It is not a verdict,
   * it gates no write, and no classification reads it — `isSkewed`/`isDrifted` are untouched.
   */
  linkTarget?: string;
}

/** True when the installed copy is ours, EDITED, and behind the shipped payload (issue #22). */
export function isDrifted(
  recorded: string | undefined,
  current: string,
  shipped: string,
): boolean {
  if (!recorded) return false; // never ours ⇒ not stale, just someone else's file
  if (current === recorded) return false; // unedited ⇒ skew's case, not drift's
  if (current === shipped) return false; // already equals the release ⇒ nothing behind
  return shipped !== recorded; // the release moved on since the edit was based on it
}

/**
 * The ABSOLUTE target of a symlink at `p`, or `undefined` when `p` holds no entry or is not a
 * link. Resolved against the LINK's own directory, because `readlink(2)` returns the stored text
 * and a relative one means nothing to a reader who does not know where the link lives.
 *
 * `lstat`, deliberately, and it is the one place in the scan that does not follow. C78's rule —
 * `stat`, never `lstat`, at a call site that then reads or writes the path — is untouched: this
 * call site reads NOTHING. It asks only "is this path a link, and to where", which is a question
 * about the link by definition. The bytes are still read through it, one line away.
 *
 * Never throws. A path that cannot be `lstat`ed, or a link that cannot be read, answers
 * `undefined` — the same as no link at all, so the report degrades to the wording it had before
 * this existed rather than failing.
 */
function symlinkTargetAt(p: string): string | undefined {
  try {
    if (!lstatSync(p).isSymbolicLink()) return undefined;
    return path.resolve(path.dirname(p), readlinkSync(p));
  } catch {
    return undefined;
  }
}

/**
 * True when the installed copy is ours, UNTOUCHED since init wrote it, and behind the shipped
 * payload (issue #94) — a clean install the release has moved past.
 *
 * `current === recorded` is what makes this safe to act on: `init` will rewrite exactly these
 * files (they pass the ownership check), so the fix is `npx modelguild init` with no risk of
 * clobbering anything. That is why skew and drift get different advice, and why they must not
 * be merged into one bucket.
 *
 * DIRECTION IS NOT KNOWABLE HERE and is not claimed anywhere downstream: two hashes carry no
 * ordering and the record holds no version, so "behind" is an inference from how the pieces
 * update (the server moves with npx, the payload does not) — right in the normal case, wrong
 * for someone who pinned an older server deliberately. The surfaces say "out of sync with what
 * this server ships" for exactly that reason. The remedy is the same in both directions.
 *
 * IT IS NOT A CLAIM THAT `init` CAN ACT, only that the bytes qualify. A stow/chezmoi-linked
 * destination is skew by this definition and `init` still declines to write through the link, so
 * the surfaces read `PayloadFileState.linkTarget` before naming a remedy.
 */
export function isSkewed(
  recorded: string | undefined,
  current: string,
  shipped: string,
): boolean {
  if (!recorded) return false; // never ours ⇒ unjudgeable, never guessed as behind
  if (current !== recorded) return false; // edited ⇒ drift's case (or a plain local edit)
  return current !== shipped; // untouched, but the release ships something else
}

/** One file to test, as resolved by the caller: the location the file was actually found in
 * (project or global) and the record for THAT mode. Built by `payloadScanEntries`. */
export interface PayloadScanEntry {
  dest: string;
  installedPath: string;
  recordPath: string;
}

export interface PayloadScanResult {
  /** Ours, edited, and behind the release (see `isDrifted`). */
  drifted: PayloadFileState[];
  /** Ours, untouched, and behind the release (see `isSkewed`). */
  skewed: PayloadFileState[];
  /** Differs from the shipped bytes but NO ownership record covers it — an intentional edit
   * and a stale leftover are indistinguishable here. Reported as unjudgeable, never guessed. */
  unknown: PayloadFileState[];
  /** Record files that were consulted and do not exist (absolute, de-duplicated) — the honest
   * reason `unknown` entries could not be judged. */
  missingRecords: string[];
}

/**
 * THE detection function. Every surface that reports drift or skew — `init`'s own run report,
 * `doctor`, `guild_status`, and the server's start-up notice — resolves to this one comparison;
 * there is deliberately no second copy of it anywhere.
 *
 * Files identical to the shipped bytes are skipped before any record is read, so a pristine
 * install consults nothing.
 */
export function scanPayload(packageRoot: string, entries: PayloadScanEntry[]): PayloadScanResult {
  const srcFor = new Map(payloadFiles().map((p) => [p.dest, p.src]));
  const recordCache = new Map<string, Records>();
  const missingRecords = new Set<string>();
  const drifted: PayloadFileState[] = [];
  const skewed: PayloadFileState[] = [];
  const unknown: PayloadFileState[] = [];
  for (const e of entries) {
    const src = srcFor.get(e.dest);
    if (!src) continue; // not a payload file — nothing shipped to compare against
    const shippedPath = path.join(packageRoot, src);
    let current: string;
    let shipped: string;
    try {
      // `stat`, NOT `lstat` (issue #163). The gate must answer the question the READ below
      // asks, and `readFileSync` follows symlinks. `lstat` answered about the LINK, so a
      // stow-/chezmoi-style install — real files in a store, symlinks at the destinations —
      // scored 0 of 8 command docs and vanished from every C72 surface with no signal. `stat`
      // scores 8 while still rejecting a directory, FIFO, socket or device at a payload path.
      if (!isRegularFile(shippedPath) || !isRegularFile(e.installedPath)) continue;
      current = sha256(readFileSync(e.installedPath));
      shipped = sha256(readFileSync(shippedPath));
    } catch {
      continue; // unreadable → say nothing rather than guess
    }
    if (current === shipped) continue; // up to date
    if (!recordCache.has(e.recordPath)) {
      if (!existsSync(e.recordPath)) missingRecords.add(e.recordPath);
      recordCache.set(e.recordPath, readRecords(e.recordPath));
    }
    const recorded = recordCache.get(e.recordPath)?.[e.dest];
    // The link, if there is one — see `PayloadFileState.linkTarget`. Read here rather than in the
    // formatter so the ONE detection still feeds all three surfaces (`doctor`, `guild_status`,
    // the start-up notice) and they cannot disagree about the same file.
    const linkTarget = symlinkTargetAt(e.installedPath);
    const entry: PayloadFileState = {
      dest: e.dest,
      installedPath: e.installedPath,
      shippedPath,
      installedHash: current,
      shippedHash: shipped,
      recordPath: e.recordPath,
      ...(linkTarget ? { linkTarget } : {}),
    };
    if (!recorded) unknown.push(entry);
    else if (isSkewed(recorded, current, shipped)) skewed.push(entry);
    else if (isDrifted(recorded, current, shipped)) drifted.push(entry);
    // else ⇒ ours, edited, and the release still ships what the edit was based on: nothing.
  }
  return { drifted, skewed, unknown, missingRecords: [...missingRecords] };
}

// ---------------------------------------------------------------------------
// Where a payload file actually IS, and which record judges it (issue #94).
//
// Both `doctor`'s presence check and every skew/drift scan need the same mapping: each piece
// resolves at RUNTIME from the project location OR the global one, and must then be judged
// against the record of the location it was FOUND in. That routing goes through `payloadDest`
// (and `recordPathFor`, which itself goes through `payloadDest`), so the project/global mapping
// can never drift from the payload's — the #22 property, inherited rather than reimplemented.
// ---------------------------------------------------------------------------
export type PayloadLocation = "project" | "global" | "none";

export interface PayloadLocateOptions {
  targetDir: string;
  global_dirs: GlobalDirs;
  /** `--global` mode: ONLY the global locations count (an explicit "check my global install"). */
  globalOnly?: boolean;
}

/** Project first, then global — mirroring how each piece resolves at runtime. Fail-closed:
 * found in neither ⇒ `"none"`.
 *
 * `isRegularFile`, NOT `existsSync` (issue #175, C78). `existsSync` answers TRUE for a DIRECTORY,
 * so a directory at a hardened agent def path made `doctor` print `✓ 3/3 hardened agent defs
 * present` for a repo where `hardenedDefPresentIn` — the predicate C78 fixed for exactly this
 * shape — says absent and C16 therefore refuses at every model-calling tool. Two surfaces of one
 * product disagreeing about one file, with no way for a reader to tell which to believe. `stat`
 * and not `lstat` is load-bearing here in the other direction: a stow- or chezmoi-linked payload
 * file IS present (issue #163), and this must keep following the link, exactly as opencode's own
 * `--agent` resolution and every other runtime consumer does. Fail-closed, so nothing that
 * currently resolves starts reading as absent. */
export function locatePayload(destRel: string, opts: PayloadLocateOptions): PayloadLocation {
  const at = (global: boolean): boolean => {
    const { base, rel } = payloadDest(destRel, {
      global,
      targetDir: opts.targetDir,
      global_dirs: opts.global_dirs,
    });
    return isRegularFile(path.join(base, rel));
  };
  if (opts.globalOnly) return at(true) ? "global" : "none";
  if (at(false)) return "project";
  if (at(true)) return "global";
  return "none";
}

/** The scan entries for every installed payload file, each paired with the record of the
 * location it was found in. Files present in neither location are omitted (absence is the
 * presence check's business, not skew's). */
export function payloadScanEntries(opts: PayloadLocateOptions): PayloadScanEntry[] {
  const out: PayloadScanEntry[] = [];
  for (const { dest } of payloadFiles()) {
    const where = locatePayload(dest, opts);
    if (where === "none") continue;
    const destOpts = {
      global: where === "global",
      targetDir: opts.targetDir,
      global_dirs: opts.global_dirs,
    };
    const { base, rel } = payloadDest(dest, destOpts);
    out.push({
      dest,
      installedPath: path.join(base, rel),
      recordPath: recordPathFor(destOpts),
    });
  }
  return out;
}

/**
 * The project directory an IN-SERVER surface scans: `$GUILD_PROJECT_DIR` (what `.mcp.json`
 * sets, and what `lifecycle.ts` spawns `opencode serve` from) else the cwd — the same rule
 * `resolveAgentDefDir` uses, so the skew check and the agent-def refusal look at one directory.
 *
 * Shared by `src/notice.ts` and `guildDoctorSeed` (review finding L7: they had derived it
 * separately). **`doctor` deliberately does NOT use it** — its target is `--dir` else the cwd,
 * because an explicit CLI argument must beat an inherited env var, and a stale exported
 * `$GUILD_PROJECT_DIR` must not silently redirect a health check run in another repo. That
 * split is real and is SURFACED rather than hidden: `doctor` prints a note when the two
 * disagree, so nobody has to discover it from a divergent report.
 */
export function resolveProjectDir(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const fromEnv = env.GUILD_PROJECT_DIR;
  return fromEnv && fromEnv.length > 0 ? fromEnv : cwd;
}

/** The one entry point the surfaces call: locate every payload file, then classify it.
 * `packageRoot` defaults to the running package (`PACKAGE_ROOT`) — which is what "shipped"
 * means here — and is injectable for tests. */
export function scanInstalledPayload(
  opts: PayloadLocateOptions & { packageRoot?: string },
): PayloadScanResult {
  return scanPayload(opts.packageRoot ?? PACKAGE_ROOT, payloadScanEntries(opts));
}

// ---------------------------------------------------------------------------
// .mcp.json merge / removal
// ---------------------------------------------------------------------------
export function mcpServerEntry(opts: InitOptions): Record<string, unknown> {
  const env: Record<string, string> = {
    GUILD_PROJECT_DIR: opts.targetDir,
    ...(opts.serverLaunch.env ?? {}),
  };
  return {
    command: opts.serverLaunch.command,
    args: opts.serverLaunch.args,
    env,
  };
}

/**
 * The existing `.mcp.json` as a mergeable object, or `null` when there is nothing to merge into.
 *
 * FACTORED OUT SO IT CAN RUN EAGERLY (issue #160). This refusal is not path-level, so the
 * eager `safeJoin` pass does not cover it — but it has the identical failure shape: it fired
 * from inside `writeMcpJson`, which runs AFTER the payload loop and BEFORE `writeRecords`, so an
 * unparseable `.mcp.json` under `--write-mcp` left a full payload with NO ownership record, a
 * retry threw at the same point, and `--uninstall` (which treats unparseable JSON as
 * `unchanged`) could prove nothing and so removed nothing. `planFor` calls this before any byte
 * is written; `writeMcpJson` calls it again for real. ONE definition, so the two cannot disagree.
 *
 * The PATH-SHAPE gate is `fsguard` (issues #162/#163, C78), and it lives here rather than
 * beside the write so the eager call refuses the same shapes: BOTH directions block on a FIFO —
 * the `readFileSync` below and the `writeFileSync` at the end of `writeMcpJson` — and a block is
 * not an exception, so the shape has to be looked at before either. `isNonRegularFile` is the
 * refusal (something is there and it is not a file) and `isRegularFile` the read gate; an absent
 * path is neither, and is simply nothing to merge.
 */
function readMcpRootForMerge(p: string): Record<string, unknown> | null {
  if (isNonRegularFile(p)) {
    throw new Error(
      `.mcp.json exists but is not a regular file (${p}); ` +
        `fix or remove it, then re-run init. Nothing was installed.`,
    );
  }
  if (!isRegularFile(p)) return null;
  const raw = readFileSync(p, "utf8");
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error(".mcp.json is not a JSON object — refusing to overwrite it");
  } catch (err) {
    throw new Error(
      `.mcp.json exists but is not valid JSON (${(err as Error).message}); ` +
        `fix or remove it, then re-run init. Nothing was installed.`,
    );
  }
}

function writeMcpJson(opts: InitOptions): { action: InitResult["mcpAction"]; entryHash: string } {
  const p = safeJoin(opts.targetDir, ".mcp.json");
  const entry = mcpServerEntry(opts);
  const entryHash = mcpEntryHash(entry);
  const parsedRoot = readMcpRootForMerge(p);
  const existed = parsedRoot !== null;
  let hadKey = false;
  const root: Record<string, unknown> = parsedRoot ?? {};
  const servers =
    root.mcpServers && typeof root.mcpServers === "object" && !Array.isArray(root.mcpServers)
      ? (root.mcpServers as Record<string, unknown>)
      : {};
  hadKey = Object.prototype.hasOwnProperty.call(servers, MCP_KEY);
  servers[MCP_KEY] = entry;
  root.mcpServers = servers;
  ensureDir(path.dirname(p));
  writeFileSync(p, JSON.stringify(root, null, 2) + "\n");
  const action: InitResult["mcpAction"] = !existed ? "created" : hadKey ? "updated" : "merged";
  return { action, entryHash };
}

/**
 * Remove the `modelguild` key from a project `.mcp.json` — but ONLY when the ownership record
 * proves init wrote it (`owned`) AND the current entry still matches what init wrote. This
 * mirrors the SHA-256 file ownership: init removes only what it can prove it wrote, unedited.
 * A user-created key (default install: init never touched `.mcp.json`), a legacy record with
 * no `mcp` field, or a user-edited entry are all KEPT with a warning, never deleted.
 * A read/parse failure or a missing key is `unchanged`.
 *
 * NEVER THROWS, AND NEVER REFUSES (issue #161). It runs AFTER every payload file has been
 * removed, so a throw here left a record claiming files that were gone, the `.gitignore` block
 * still in place, `pruneEmptyDirs` unreached and every re-run exiting 1 — the ancillary file
 * holding the payload hostage. Three changes carry that: `path.join` rather than `safeJoin` (a
 * symlinked `.mcp.json` is KEPT with a warning, which honours project mode's never-write-through
 * -a-link rule by not writing rather than by failing the run); `isRegularFile` (C78) rather than
 * `existsSync`, which both stops a FIFO hanging the read and lets a non-regular file be NAMED
 * instead of silently reported `unchanged`; and a guarded write.
 */
function removeMcpKey(
  targetDir: string,
  owned: McpRecord | undefined,
): { action: InitResult["mcpAction"]; warning?: string; blocked?: boolean } {
  const p = path.join(targetDir, ".mcp.json");
  if (!isRegularFile(p)) {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return { action: "unchanged" }; // absent — the common case, and silent
    }
    // Present but not something we can read or rewrite. Say so: the old code called this
    // `unchanged` with no warning, so a user was never told anything had been left behind.
    return {
      action: "kept",
      warning: st.isSymbolicLink()
        ? `left ${p} alone — it is a symlink, and a project install never writes through one. ` +
          `If it holds a '${MCP_KEY}' key, remove it yourself: \`claude mcp remove ${MCP_KEY}\`.`
        : `left ${p} alone — it is not a regular file, so it was neither read nor rewritten. ` +
          `If it holds a '${MCP_KEY}' key, remove it yourself: \`claude mcp remove ${MCP_KEY}\`.`,
    };
  }
  let root: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { action: "unchanged" };
    root = parsed as Record<string, unknown>;
  } catch {
    return { action: "unchanged" };
  }
  const servers = root.mcpServers as Record<string, unknown> | undefined;
  if (!servers || typeof servers !== "object") return { action: "unchanged" };
  if (!Object.prototype.hasOwnProperty.call(servers, MCP_KEY)) return { action: "unchanged" };
  // The key exists — but delete it only with proof init wrote it (fail-safe: never remove a
  // registration the user made themselves).
  if (!owned || owned.key !== MCP_KEY) {
    return {
      action: "kept",
      warning:
        `keeping the '${MCP_KEY}' .mcp.json key — no ownership record proves init wrote it ` +
        `(a registration you made yourself is yours to remove: \`claude mcp remove ${MCP_KEY}\`).`,
    };
  }
  if (mcpEntryHash(servers[MCP_KEY]) !== owned.entryHash) {
    return {
      action: "kept",
      warning: `keeping the changed '${MCP_KEY}' .mcp.json key — it no longer matches what init wrote.`,
    };
  }
  delete servers[MCP_KEY];
  try {
    writeFileSync(p, JSON.stringify(root, null, 2) + "\n");
  } catch (err) {
    // The payload is already gone; a read-only `.mcp.json` must not abort what is left of the
    // removal (issue #161). Blocked: the caller asked for the key to go and it did not.
    return {
      action: "kept",
      blocked: true,
      warning:
        `could not remove the '${MCP_KEY}' key from ${p} (${errCode(err)}) — everything else was ` +
        `uninstalled. Fix that file's permissions and re-run, or remove the key yourself: ` +
        `\`claude mcp remove ${MCP_KEY}\`.`,
    };
  }
  return { action: "removed" };
}

// ---------------------------------------------------------------------------
// gitignore block (idempotent, fenced) — mirrors install.sh's markers so a project
// that also had a bash install shares one block rather than doubling it.
// ---------------------------------------------------------------------------
function stripGitignoreBlock(text: string): string {
  const lines = text.split("\n");
  const begin = lines.indexOf(GITIGNORE_BEGIN);
  const end = lines.indexOf(GITIGNORE_END);
  // Only strip when BOTH markers are present and ordered (a lone begin must not
  // swallow the rest of the file — the install.sh guard).
  if (begin === -1 || end === -1 || begin >= end) return text;
  const before = lines.slice(0, begin);
  // Drop one separator blank line we inserted before the block.
  if (before.length > 0 && before[before.length - 1] === "") before.pop();
  const after = lines.slice(end + 1);
  return [...before, ...after].join("\n");
}

/**
 * Returns a warning when the block could not be added, else `undefined`.
 *
 * A non-regular `.gitignore` — a FIFO, a directory — is SKIPPED with a warning rather than
 * written or refused (issue #162). Both the read and the write below block forever on a FIFO,
 * and neither is reachable by a `catch`. Skipping is the right direction here specifically:
 * this is the LAST step of an install whose payload and ownership record are already on disk,
 * the block is a convenience rather than part of the payload, and the never-clobber posture
 * says a thing the user put there is not ours to replace. (`.mcp.json` refuses instead — see
 * `readMcpRootForMerge`; it is written mid-install and init already refuses an unusable one.)
 *
 * THE WRITE IS GUARDED FOR THE SAME REASON THE SHAPE IS (issue #160): an EACCES here — a
 * read-only `.gitignore` — is not knowable before the write and must not turn a complete
 * install into a total failure. It is a warning, never a throw.
 *
 * THE READ IS GUARDED FOR THAT SAME REASON, AND IT WAS NOT UNTIL ISSUE #179 — the second escape
 * that kept C79's strong invariant unstated. `isRegularFile` answers SHAPE, not PERMISSION, so a
 * regular `.gitignore` this process cannot READ passes the gate above and the read threw from the
 * same position the #174 throw came from: payload and ownership record already on disk, exit 1,
 * a bare errno with no path context and no remedy, identically on every re-run. `mode 000`
 * reaches it; `mode 444` — the common shape — already degraded correctly, from the WRITE. Those
 * two are one class (an EACCES on a read-modify-write of a regular file, learnable only by
 * trying), so they take one branch: `blocked`, not policy. `stripGitignoreOnly` has had the
 * identical read inside a `try` since #161; this is the install side catching up to it.
 *
 * THE TWO OUTCOMES ARE NOT THE SAME KIND, and only one of them is `blocked` (issue #164). A
 * shape we DECLINE to write is policy — the same judgement C78 makes above, and the same
 * judgement never-clobber makes about a payload file — so it stays exit 0. A write that FAILED
 * is an environmental failure the caller could not have chosen, so it is `blocked` and exits 1.
 *
 * `path.join`, NOT `safeJoin` (issue #174) — and this is the one line that made C79's "an
 * install refuses early or not at all" false in the shipped release. `safeJoin` refuses a LIVE
 * leaf symlink by THROWING, and this function runs after the payload loop AND after
 * `writeRecords`, so a `.gitignore` symlinked into a dotfiles repo — an ordinary layout — got a
 * complete, correct install reported as `Nothing was installed.` with exit 1, on every run
 * forever; `install.sh` propagates that status. A LIVE link now takes the SAME skip-and-warn
 * branch a dangling one already took, which is what the comment in `planFor` always claimed
 * happened. Hoisting `.gitignore` into `planFor`'s eager pass was the alternative and was
 * REJECTED: it would make a shared/symlinked `.gitignore` refuse the whole install, which is a
 * harder failure than the bug it replaces, over an ignore-rule convenience that is not payload
 * and whose absence breaks nothing C16 depends on. It also matches the uninstall side, where
 * `stripGitignoreOnly` already declines the write at a link rather than failing the run. COST,
 * stated: the block is not added, so `modelguild/logs/` — which holds raw prompts and responses
 * — is not git-ignored by us and can be committed. The warning names all three rules.
 */
function addGitignoreBlock(targetDir: string): { warning?: string; blocked?: boolean } {
  const p = path.join(targetDir, ".gitignore");
  // ANY symlink, live or dangling. A dangling one would create its target outside the project
  // (issue #159's write-through); a live one would write THROUGH into a file that is the user's,
  // which project mode never does. One branch, one posture, the wording differing only in which
  // it is. (`resolveRecordLink` is not record-specific — it is the general "is there a link here,
  // where does it point, and does it resolve?" probe.)
  const link = resolveRecordLink(p);
  if (link) {
    return {
      warning:
        `skipping the .gitignore block — ${p} is a symlink to ${link.target}` +
        `${link.live ? ", and a project install never writes through one" : " whose target does not exist, so writing it would create that file outside this project"}. ` +
        `Everything else was installed. Add \`modelguild/logs/\`, ` +
        `\`modelguild/models.policy.local\` and \`modelguild/modelguild.conf.local\` to your ` +
        `ignore rules by hand (that first one holds the raw prompts and responses of every model ` +
        `call), or remove the link and re-run init.`,
    };
  }
  if (isNonRegularFile(p)) {
    return {
      warning: `skipping the .gitignore block — ${p} is not a regular file; add it by hand if you want it.`,
    };
  }
  let text: string;
  try {
    // The shape gate above says this is a regular file; it does NOT say it is readable (#179).
    text = isRegularFile(p) ? readFileSync(p, "utf8") : "";
  } catch (err) {
    return {
      blocked: true,
      warning:
        `could not read ${p} to add the ModelGuild block (${errCode(err)}) — everything else was ` +
        `installed. Add \`modelguild/logs/\`, \`modelguild/models.policy.local\` and ` +
        `\`modelguild/modelguild.conf.local\` to your ignore rules by hand (that first one holds ` +
        `the raw prompts and responses of every model call), or fix that file and re-run init.`,
    };
  }
  try {
    // Inside the try with the write, not between the two: appending to a string the read only
    // just proved fits raises a `RangeError` at V8's max string length, which is not an errno
    // but is still a throw, and this function may not have one anywhere.
    text = stripGitignoreBlock(text); // idempotent — never double-add
    if (text.length > 0 && !text.endsWith("\n")) text += "\n";
    if (text.length > 0) text += "\n";
    text += GITIGNORE_BODY;
    writeFileSync(p, text);
  } catch (err) {
    return {
      blocked: true,
      warning:
        `could not write the ModelGuild block into ${p} (${errCode(err)}) — everything else was ` +
        `installed. Add \`modelguild/logs/\`, \`modelguild/models.policy.local\` and ` +
        `\`modelguild/modelguild.conf.local\` to your ignore rules by hand (that first one holds ` +
        `the raw prompts and responses of every model call), or fix that file and re-run init.`,
    };
  }
  return {};
}

/**
 * Strip our fenced block on uninstall. Returns a warning where it declined to, and NEVER throws
 * (issue #161): like `removeMcpKey` this runs after the payload has been removed, so a refusal
 * here would wedge the very uninstall it is a footnote to — reproduced as a read-only
 * `.gitignore` giving exit 1, zero payload files, the record removed, the block still present
 * and `pruneEmptyDirs` never reached.
 *
 * `path.join` + an explicit link check rather than `safeJoin`: project mode's rule is that it
 * does not write THROUGH a link, and declining the write honours that without failing the run.
 */
function stripGitignoreOnly(targetDir: string): { warning?: string; blocked?: boolean } {
  const p = path.join(targetDir, ".gitignore");
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return {}; // absent — the common case, and silent
  }
  if (st.isSymbolicLink() || !isRegularFile(p)) {
    // POLICY, not `blocked` — the same split `addGitignoreBlock` makes: a shape we DECLINE to
    // write is not a failure, so it does not change the exit code (issue #164).
    return {
      warning:
        `left the ModelGuild block in ${p} — it is ${st.isSymbolicLink() ? "a symlink, and a project install never writes through one" : "not a regular file"}. ` +
        `Delete the fenced \`${GITIGNORE_BEGIN}\` … \`${GITIGNORE_END}\` block by hand if you want it gone.`,
    };
  }
  try {
    writeFileSync(p, stripGitignoreBlock(readFileSync(p, "utf8")));
  } catch (err) {
    return {
      blocked: true,
      warning:
        `could not strip the ModelGuild block from ${p} (${errCode(err)}) — everything else was ` +
        `uninstalled. Delete the fenced \`${GITIGNORE_BEGIN}\` … \`${GITIGNORE_END}\` block by hand.`,
    };
  }
  return {};
}

// ---------------------------------------------------------------------------
// Install / uninstall
// ---------------------------------------------------------------------------
function pruneEmptyDirs(dirs: string[]): void {
  for (const abs of dirs) {
    if (!existsSync(abs)) continue;
    try {
      if (readdirSync(abs).length === 0) rmdirSync(abs);
    } catch {
      /* not empty or not a dir — leave it */
    }
  }
}

export function init(opts: InitOptions): InitResult {
  const result: InitResult = {
    installed: [],
    skipped: [],
    removed: [],
    shadowed: [],
    drifted: [],
    blocked: [],
    warnings: [],
    mcpAction: "unchanged",
  };
  const plan = planFor(opts);
  result.warnings.push(...plan.warnings);
  const records = readRecords(plan.recordPath);
  const ownedMcp = readMcpRecord(plan.recordPath);

  if (opts.uninstall) {
    // NOTHING IN THIS BLOCK MAY THROW (issue #161, and the uninstall half of #167). Every step
    // below used to be able to abort a removal that had already deleted files, which is the
    // worst of the three possible outcomes: the payload half-gone, the record gone or claiming
    // files that are not there, and every re-run failing the same way. Uninstall's job is
    // removal, so the failing step is what gives way.
    for (const { dest } of payloadFiles()) {
      let abs = "";
      try {
        abs = plan.destFor(dest);
      } catch (err) {
        // A symlinked destination. `safeJoin` threw here from inside this loop and made
        // `--uninstall` impossible for the WHOLE payload (issue #167). One file, one warning.
        // BLOCKED, unlike the non-regular case below: a refused component can HIDE our file
        // rather than replace it, so the run cannot claim it removed everything.
        result.warnings.push(`keeping ${dest} — ${(err as Error).message}`);
        result.blocked.push(dest);
        continue;
      }
      // `isRegularFile`, not `existsSync`: a FIFO at a payload path answered TRUE and hung the
      // hash read below (issue #162, C78) — and `stat`, not `lstat`, so a stow-style symlink to
      // a real file is FOLLOWED and hash-checked like any other (issue #163).
      if (!isRegularFile(abs)) {
        // Absent is the common case and silent. Something that IS there but is not a regular
        // file gets NAMED, because #161 is about a user never being told what was left behind
        // — but it is POLICY rather than a failure (it cannot hash to what init recorded, so it
        // was never ours to remove), so it does not go in `blocked`.
        if (entryExists(abs)) {
          result.warnings.push(`keeping ${dest} — ${abs} is not a regular file; left untouched.`);
        }
        continue;
      }
      const recorded = records[dest];
      if (!recorded) {
        result.warnings.push(`keeping ${dest} — no ownership record to prove it's ours.`);
        continue; // POLICY, not blocked: init cannot prove this file is ours.
      }
      try {
        const current = sha256(readFileSync(abs));
        if (current === recorded) {
          unlinkSync(abs);
          result.removed.push(dest);
        } else {
          result.warnings.push(`keeping changed file ${dest} — it no longer matches what init wrote.`);
        }
      } catch (err) {
        // An unreadable file or a read-only parent directory. This threw MID-LOOP, so some
        // files were removed and the rest were not (issue #161).
        result.warnings.push(`keeping ${dest} — could not remove ${abs} (${errCode(err)}).`);
        result.blocked.push(dest);
      }
    }
    // No project .mcp.json in global mode; the global payload never wrote one.
    if (opts.global) {
      result.mcpAction = "unchanged";
    } else {
      const { action, warning, blocked } = removeMcpKey(opts.targetDir, ownedMcp);
      result.mcpAction = action;
      if (warning) result.warnings.push(warning);
      if (blocked) result.blocked.push(".mcp.json");
    }
    // KEEP THE RECORD WHEN A PAYLOAD FILE COULD NOT BE REMOVED (issue #176). This unlink used to
    // be unconditional, and that closed the only door left: `.opencode` becoming a symlink after
    // an install made `--uninstall` keep the three agent defs, drop the record anyway, and then
    // every `init` was refused by `planFor`'s eager `safeJoin` loop while a second `--uninstall`
    // could no longer prove the leftovers were ours. Files present, record gone, install refused,
    // removal impossible — the unrepairable-by-any-invocation class #167/#159/#160/#161 exist to
    // eliminate, reached by a different route. The proof of ownership is the only thing that can
    // finish the job later, so it outlives the run that could not.
    //
    // SCOPED TO PAYLOAD DESTINATIONS, which AMENDS a shipped decision rather than reversing it
    // (C79): the case C79 argued — an uninstall whose `.mcp.json` write failed removes the record
    // that proved the key was ours, so a second run keeps the key fail-safe — is untouched,
    // because `.mcp.json` and `.gitignore` are not payload and their being blocked does not leave
    // a payload file needing proof. `blocked` is the right test rather than "anything kept": a
    // file kept for POLICY (no record, changed bytes, not a regular file) can never be removed by
    // a re-run either, so retaining the record buys nothing there.
    //
    // COST, stated. The record kept is the WHOLE record, so it still claims the files this run
    // did remove. That is benign in all three consumers and was checked rather than assumed: a
    // later install overwrites each entry as it places the file, a later uninstall skips an absent
    // path silently (`isRegularFile` is false), and `payloadScanEntries` only scans files it
    // located. Rewriting the record down to the blocked entries was the alternative and was
    // REJECTED: it puts a WRITE on a path whose whole contract is that it never refuses and never
    // throws (C79), to buy tidiness in a record every consumer already tolerates. The other cost
    // is that a user who wanted the record gone now has it; the warning names the path.
    const blockedPayload = result.blocked.filter((d) => PAYLOAD_DESTS.has(d));
    if (blockedPayload.length > 0 && entryExists(plan.recordPath)) {
      // THE RETAINED CASE HAS TO SAY WHAT HAPPENED TO A SYMLINKED RECORD PATH TOO, and this is
      // not an optional courtesy — without it this branch makes an EXISTING message false.
      // `planFor`'s plan-time disclosure promises "the link itself is removed at the end, its
      // target left alone", written when removal was unconditional; keeping the record keeps the
      // LINK, so that promise is broken by this branch and nothing else would correct it — a
      // message asserting an action that did not happen. So the plan-time sentence is now
      // conditional and the outcome is stated HERE, where it is known. It claims no leftover and
      // asserts no ownership of the target: nothing was removed.
      //
      // THE DANGLING CASE IS THE ONE THAT MATTERS, and it is a caveat on this branch's whole
      // remedy: `entryExists` is `lstat`-based, so a dangling link satisfies it while there is no
      // readable record behind it — so "re-run `--uninstall` to finish" would not work, and
      // saying so is the difference between a remedy and a false reassurance.
      const recordLink = resolveRecordLink(plan.recordPath);
      result.warnings.push(
        `KEEPING the ownership record at ${plan.recordPath} — ${blockedPayload.length} payload ` +
          `file(s) could not be removed (${blockedPayload.join(", ")}), and that record is the ` +
          `only proof they are ours. Fix the cause named above and re-run \`--uninstall\` to ` +
          `finish; deleting the record first would strand those files permanently.` +
          (recordLink
            ? ` That path is a symlink to ${recordLink.target}, and this run removed neither the ` +
              `link nor its target.` +
              (recordLink.live
                ? ` The next run reads the record through the link, so leave both in place.`
                : ` The link is DANGLING, so there is no record behind it to keep and re-running ` +
                  `\`--uninstall\` will prove nothing is ours: restore the target, or remove ` +
                  `those files by hand.`)
            : ""),
      );
    } else if (entryExists(plan.recordPath)) {
      // Remove the record file, then (project only) the gitignore block, then empty dirs.
      // `lstat`, so a DANGLING record link is removed rather than followed-and-called-absent;
      // `unlink(2)` never follows a final component, so a live link's target survives (C77).
      //
      // AND THAT LEFTOVER IS NAMED (issue #184). The call is unchanged — this is disclosure
      // only, no write-path change. It is worth a warning because C77's record write-through is
      // UNGATED: an install writes the record through a live link, replacing whatever the target
      // held, so the file left behind here may be the user's own with ModelGuild's JSON in it,
      // and after the unlink nothing points at it any more. `resolveRecordLink`, not a
      // global-only helper: the record write-through is BOTH modes (C77), and in `--global`
      // `planFor` emits no plan-time record-symlink line at all, so this is the only disclosure
      // that mode gets. Resolved BEFORE the unlink, because afterwards there is no link to read.
      //
      // DO NOT ASSERT A DESTRUCTION THAT MAY NOT HAVE HAPPENED (issue #165 review finding F-3,
      // carried forward because the guard is the reusable part of that change). "There is a link
      // here" says nothing about whether the bytes behind it were ever ours. Reproduced: plant a
      // record symlink at a file holding `MINE\n`, never install, run `--uninstall` ⇒ an
      // unguarded claim fired and the file was untouched. The evidence is already in hand at no
      // syscall cost — `records` / `ownedMcp` were parsed FROM this path at the top of `init`,
      // through the link (`isRegularFile` is `stat`-based, C78).
      //
      // NEITHER BRANCH MAY CLAIM MORE THAN THE PARSE CARRIES, and both overclaimed on the first
      // cut (— the #184 review). The variable is named `readAsOurs` and not `wasOurs` because
      // that is the whole of what it knows.
      //
      //   POSITIVE: a non-empty parse establishes that our record JSON is behind the link NOW.
      //   It does NOT establish that an install wrote it THROUGH the link — a record written
      //   by an ordinary install and symlinked afterwards by a dotfiles manager reads exactly
      //   the same, which is the shape `test/init.test.ts` case (c) constructs. So the message
      //   states the present fact, names both routes as indistinguishable, and keeps the half
      //   that is actionable either way: if the file was yours, nothing here restores it.
      //
      //   NEGATIVE: an empty parse is AMBIGUOUS — not ours, unreadable, dangling, or a VALID
      //   record whose `files` map is empty. That last one is reachable: a `--global` install
      //   into a tree where every payload destination is a leaf symlink (the GNU-stow `--adopt`
      //   layout `docs/setup.md` supports) skips all 13 and writes `{"files":{}}` through the
      //   record link, destroying the target to do it. So this branch reports the OBSERVATION
      //   — what this run could not read — and never a property of the user's file. Saying
      //   "its contents did not read as a ModelGuild ownership record" there was FALSE, and
      //   false in the mirror direction to F-3: an all-clear over a file we had just destroyed.
      //   A third state distinguishing the empty-but-valid record is deliberately NOT added
      //   here; it is filed separately. The leftover is still NAMED in both branches.
      const recordLink = resolveRecordLink(plan.recordPath);
      try {
        unlinkSync(plan.recordPath);
        if (recordLink) {
          const readAsOurs = Object.keys(records).length > 0 || ownedMcp !== undefined;
          result.warnings.push(
            `removed the symlink at ${plan.recordPath}, but LEFT its target ${recordLink.target} ` +
              `in place${recordLink.live ? "" : " (already gone)"} — uninstall deletes the link, ` +
              `never through it. ` +
              (readAsOurs
                ? `That file currently holds ModelGuild's ownership-record JSON — this run ` +
                  `cannot tell whether an install wrote it through this link or the link was ` +
                  `pointed at a record already written. Either way, if the file was originally ` +
                  `yours, nothing here restores it.`
                : `This run could not read a ModelGuild ownership record behind that link, so ` +
                  `it makes no claim about what the file holds; nothing was removed from the ` +
                  `file itself.`),
          );
        }
      } catch (err) {
        result.warnings.push(
          `could not remove the ownership record at ${plan.recordPath} (${errCode(err)}) — ` +
            `delete it by hand, or a re-install will judge files against a record for an install ` +
            `that no longer exists.`,
        );
        result.blocked.push(RECORD_REL);
      }
    }
    if (plan.gitignoreDir) {
      const gi = stripGitignoreOnly(plan.gitignoreDir);
      if (gi.warning) result.warnings.push(gi.warning);
      if (gi.blocked) result.blocked.push(".gitignore");
    }
    pruneEmptyDirs(plan.pruneDirs);
    return result;
  }

  // Install / upgrade. PAST THIS POINT NOTHING MAY THROW UNTIL `writeRecords` (issue #167):
  // every path-level refusal has already happened in `planFor`, so what is left is the
  // filesystem saying no — EACCES, ENOSPC, a race — and a throw here would leave a partial
  // payload with no ownership record and no in-tool way back. The loop always finishes, and the
  // record always accounts for what it managed to place.
  const newRecords: Records = {};
  for (const { src, dest } of payloadFiles()) {
    const srcAbs = path.join(opts.packageRoot, src);
    if (!existsSync(srcAbs)) {
      result.warnings.push(`payload source missing in package: ${src} (skipped).`);
      result.skipped.push(dest);
      continue;
    }
    let destAbs = "";
    try {
      const payloadBytes = readFileSync(srcAbs);
      const payloadHash = sha256(payloadBytes);
      destAbs = plan.destFor(dest);

      // `entryExists`, not `existsSync`: a DANGLING symlink at the destination is an entry the
      // user put there, and `existsSync` follows the link and calls it absent — which sent the
      // write straight through it (issue #156). The branch below is unchanged.
      if (entryExists(destAbs)) {
        if (!lstatSync(destAbs).isFile()) {
          // A SYMLINK IS NAMED AS ONE, AND THE REMEDY IS NAMED WITH IT. The bare "a non-file
          // exists here" is false to a reader in the stow/chezmoi per-file layout — the thing
          // behind the link IS a regular file, every runtime consumer reads it, and `doctor`'s
          // C72 scan reads it too and reports the file as SKEW. That left the product saying
          // "run `npx modelguild init`" on one surface and "a non-file exists" on the other,
          // for a run that had just declined to act: `installed=0`, `blocked=[]`, exit 0,
          // nothing changed, and the same report next time, forever.
          //
          // The rule itself is UNCHANGED and is the point: `init` does not write through a
          // symlink. What changes is that the skip says which link, where it points, and the
          // two things the user can actually do. `symlinkTargetAt` never throws, so a link that
          // cannot be read degrades to the original wording rather than failing the install.
          // THREE STATES, NOT TWO, because the remedy differs in each and a claim true of the
          // LINK must not be quietly assumed of the TARGET. "Update the file it points at" is
          // not advice when nothing is there, and it is not advice when the target is a
          // DIRECTORY either — which the two-state version printed, having asked only whether
          // the target resolved. `isRegularFile` (C78's `stat`) answers the shape, `existsSync`
          // separates a non-file from an absent one, and both are guarded: an unanswerable
          // probe degrades the wording to the mildest claim, never the install.
          const via = symlinkTargetAt(destAbs);
          let viaState: "file" | "other" | "absent" = "absent";
          if (via) {
            try {
              viaState = isRegularFile(destAbs) ? "file" : existsSync(destAbs) ? "other" : "absent";
            } catch {
              viaState = "absent"; // unanswerable ⇒ claim no destruction and no shape
            }
          }
          const reAdopt =
            ` (which then writes a regular file at ${destAbs}, so a dotfiles layout would need ` +
            `re-adopting).`;
          result.warnings.push(
            via
              ? `skipping ${dest} — ${destAbs} is a symlink to ${via}, and init does not write ` +
                `through a symlink. ` +
                (viaState === "file"
                  ? `Neither the link nor ${via} was touched. To take this release's version, ` +
                    `update ${via} yourself, or remove the link and re-run init` + reAdopt
                  : viaState === "other"
                    ? `${via} is not a regular file (a directory, FIFO or socket), so there is ` +
                      `nothing here init could manage and nothing was changed. Point the link at ` +
                      `a file, or remove it and re-run init` + reAdopt
                    : `The link is DANGLING — nothing is at ${via} — so nothing was created ` +
                      `there either. To get this file, restore the target or remove the link ` +
                      `and re-run init` + reAdopt)
              : `skipping ${dest} — a non-file exists at ${destAbs}; left untouched.`,
          );
          result.skipped.push(dest);
          if (records[dest]) newRecords[dest] = records[dest];
          continue;
        }
        const current = sha256(readFileSync(destAbs));
        const owned = records[dest] === current || current === payloadHash;
        if (!owned) {
          // A file the user already had (or edited). Never clobber it — but SAY when the skip
          // leaves them behind the release (issue #22), which the old bare warning did not.
          result.skipped.push(dest);
          const recorded = records[dest];
          if (isDrifted(recorded, current, payloadHash)) {
            result.drifted.push({
              dest,
              installedPath: destAbs,
              shippedPath: srcAbs,
              installedHash: current,
              shippedHash: payloadHash,
              recordPath: plan.recordPath,
            });
            result.warnings.push(
              `skipping ${dest} — you edited it since init wrote it, and this release ships a ` +
                `NEWER version: your copy is stale (see the drift note).`,
            );
          } else {
            result.warnings.push(
              recorded
                ? `skipping ${dest} — you edited it since init wrote it; left untouched ` +
                  `(your edit is against the version this release still ships — not stale).`
                : `skipping ${dest} — a file you already have is there; left untouched.`,
            );
          }
          if (COMMAND_DEST_RELS.has(dest)) result.shadowed.push(dest);
          if (records[dest]) newRecords[dest] = records[dest];
          continue;
        }
        if (current === payloadHash) {
          // Already up to date — record and move on (idempotent no-write).
          newRecords[dest] = payloadHash;
          continue;
        }
      }
      ensureDir(path.dirname(destAbs));
      writeFileSync(destAbs, payloadBytes);
      newRecords[dest] = payloadHash;
      result.installed.push(dest);
    } catch (err) {
      result.warnings.push(
        `skipping ${dest} — could not write ${destAbs || path.join(opts.targetDir, dest)} ` +
          `(${errCode(err)}); left untouched.`,
      );
      result.skipped.push(dest);
      if (records[dest]) newRecords[dest] = records[dest];
    }
  }

  // WHICH SKIPS ARE FAILURES (issue #164) — asked of the filesystem, not of the reason we
  // skipped. A never-clobber skip leaves the user's file (or a live link to one) resolving at
  // the path; a dangling link, a directory in the way or an EACCES leaves nothing there, and
  // that payload piece is simply missing. `cli.ts` turns a non-empty list into exit 1.
  for (const dest of result.skipped) {
    let abs = "";
    try {
      abs = plan.destFor(dest);
    } catch {
      /* the path itself is refused ⇒ nothing of ours resolves there */
    }
    if (!abs || !isRegularFile(abs)) result.blocked.push(dest);
  }

  // MCP registration is user-driven by default (`claude mcp add`, their choice of scope);
  // only the opt-in `--write-mcp` path writes the project `.mcp.json` for them. Global mode
  // has no project `.mcp.json`, so writeMcp is ignored there (forced skipped).
  let mcpRecord: McpRecord | undefined;
  if (!opts.global && opts.writeMcp) {
    // GUARDED (issue #160). `planFor` has refused the shapes that are knowable before writing —
    // a symlink, a non-regular file, unparseable JSON — so what reaches here is an EACCES, a
    // full disk or a race, none of which may cost the ownership record. Degrade instead: the
    // payload and the record still land, `.mcp.json` is reported unwritten, and `blocked` makes
    // the run exit 1 so the missing registration is not mistaken for the default install's
    // deliberate `skipped`.
    try {
      const { action, entryHash } = writeMcpJson(opts);
      result.mcpAction = action;
      mcpRecord = { key: MCP_KEY, entryHash }; // proof for a future uninstall
    } catch (err) {
      result.mcpAction = "skipped";
      mcpRecord = ownedMcp;
      result.blocked.push(".mcp.json");
      result.warnings.push(
        `could not write the project .mcp.json (${errCode(err)}) — the payload and the ownership ` +
          `record were still installed. Fix that file and re-run with --write-mcp, or register ` +
          `the server yourself: \`claude mcp add ${MCP_KEY} -s project -- …\`.`,
      );
    }
  } else {
    result.mcpAction = "skipped";
    // Carry forward a prior --write-mcp ownership proof so a DEFAULT re-run does not forget
    // that init wrote the key (mirrors carrying an unchanged file's record forward).
    mcpRecord = ownedMcp;
  }
  // Warn BEFORE the write: it is the only moment a dangling link is distinguishable from a
  // live one, and the write settles that either way (issue #156).
  const recordWarning = recordSymlinkWarning(plan.recordPath);
  if (recordWarning) result.warnings.push(recordWarning);
  try {
    writeRecords(plan.recordPath, newRecords, mcpRecord);
  } catch (err) {
    // THE ONE REMAINING THROW AFTER BYTES HAVE MOVED, and it stays a throw: an install with no
    // ownership record IS a failed install, and dressing it as a warning would hide the state
    // that matters. `assertRecordLinkWritable` has already refused the two link shapes that
    // reach here predictably; what is left (permissions, a full disk) a re-run repairs once the
    // cause is fixed, because the placed files now match the shipped bytes and pass the
    // ownership check on their own.
    throw new Error(
      `modelguild init: the payload was placed, but the ownership record could NOT be written at ` +
        `${plan.recordPath} (${errCode(err)}). Until it is, a re-install will treat those files as ` +
        `yours and skip them, and \`--uninstall\` will remove nothing. Fix that path — ` +
        `permissions, or free space — and re-run init to complete the install.`,
    );
  }
  // A project `.gitignore` block only makes sense for a project install. It runs AFTER the
  // record, so a failure here costs an ignore rule and nothing else — a warning, never a throw.
  if (plan.gitignoreDir) {
    const gi = addGitignoreBlock(plan.gitignoreDir);
    if (gi.warning) result.warnings.push(gi.warning);
    if (gi.blocked) result.blocked.push(".gitignore");
  }
  return result;
}
