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
 * SYMLINKS AT A DESTINATION differ BY MODE (issue #156, maintainer decision 2026-08-05).
 * PROJECT mode is unchanged: `safeJoin` refuses a symlink at any existing component.
 * `--global` writes into the user's OWN config (`~/.claude`, `<xdg>/opencode`), and a
 * dotfiles manager (GNU stow, chezmoi, a hand-rolled `ln -s`) makes those DIRECTORIES
 * symlinks — so `--global` uses `globalJoin`, which keeps the `..`/absolute guard and
 * FOLLOWS directory links, landing the payload in the backing store. Before this, such a
 * layout threw at the FIRST linked destination: nothing installed when `~/.claude` was the
 * link (`planFor` resolves the record path under it EAGERLY, before the loop), a PARTIAL
 * install with no ownership record when only `<xdg>/opencode` was. In GLOBAL mode a LEAF payload
 * file that is a symlink is not refused — C80 below says what it does. (Project mode
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
 * backing store. Provenance: the ask and the global-only scope are the maintainer's
 * (issue #156); the shape is Claude's.
 *
 * A LEAF PAYLOAD SYMLINK IS SETTLED BY THE OWNERSHIP RULE, NOT BY PATH TYPE (issue #165,
 * maintainer decision 2026-08-05, C80). #156 covers the layout where a whole config DIRECTORY is
 * linked. The per-FILE layout is the common one: GNU stow links leaves whenever the parent
 * directory already has content and cannot be tree-folded — and `~/.claude` typically cannot, it
 * holds `settings.json`, `projects/` and credentials stow did not create — and chezmoi's
 * `symlink_` targets produce the same shape on purpose. C77 skipped those with a warning, so the
 * user's copy stayed on an old release FOREVER while `doctor` kept reporting it as skew and
 * naming `npx modelguild init` as the fix (reproduced 2026-08-15: v1 installed, stowed, re-run
 * against v2 ⇒ `installed=0`, `blocked=[]`, exit 0, store copy still v1).
 *
 * NOTHING NEW IS INVENTED: never-clobber already keys on BYTES, not on path type. The bytes are
 * read THROUGH the link and hashed; ours ⇒ the write goes through it too, updating the dotfiles
 * copy; not ours ⇒ skipped with a warning like any file init did not write. A DANGLING link has
 * no bytes, so it cannot match and stays a skip — by the rule, not by an exception to it. Scope
 * is `--global` only, inheriting C77's asymmetry unchanged.
 *
 * THE HASH IS A FRESHNESS CHECK, NOT AN AUTHORIZATION CHECK, and that has to be written down
 * rather than left implied by the word "ownership". Recorded hashes are of SHIPPED payload files,
 * which are public in the npm tarball, so anyone who can plant the link can also plant matching
 * bytes. Demonstrated end to end: install v1, copy v1's `consult.md` to a victim path, point the
 * payload path at it, install v2 ⇒ the victim file is overwritten (with a warning naming both).
 * Within the trusted-repo posture — planting a link in your own config tree already implies code
 * execution — but it buys freshness, never authority, and the warning says so in those words.
 *
 * UNINSTALL REMOVES THE LINK AND LEAVES THE TARGET, and now says so. `unlink(2)` never follows a
 * final component, so that is what it already did; the change is that it is named. Asymmetric with
 * install on purpose: updating a file the user asked to be there is not the same act as deleting
 * one out of a store they manage. Stated consequence: install → uninstall → reinstall does NOT
 * restore the stow layout — the reinstall writes a regular file at the destination and the
 * orphaned copy stays in the store.
 *
 * THE RECORD LEAF KEEPS DIVERGING, and the divergence is forced — see `recordSymlinkWarning`:
 * there is no record OF the record, so the hash gate is circular. Its write-through (C77) stands.
 * What changed is the disclosure, and it is SPLIT: WHICH link is there and where it points is
 * resolved at plan time (nothing in the run rewrites the link, and a future refusal would want
 * it there), while whether the target EXISTS is read beside the write. Moving that second half
 * to plan time was tried and was WRONG — a record link aimed at a not-yet-installed payload file
 * is dangling at plan time and live by the write, so the message announced a creation while
 * silently destroying an agent def the same run had just installed (issue #165 review, F-1). The
 * uninstall leftover is named too, and names only what the run can stand up: the record parsed
 * from that path is the evidence that the bytes behind the link were ever ours (F-3).
 *
 * Provenance: the ask, the rule and the uninstall shape are the maintainer's (issue #165,
 * 2026-08-05); the plan-time hoist and the wording are Claude's.
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
 *   nothing and leaves nothing. After that point nothing may throw: a per-file failure is a
 *   warning-and-skip, and the ancillary writes (`.gitignore`, which is deliberately NOT resolved
 *   in `planFor`, and `.mcp.json`) degrade the same way, so the run always reaches `writeRecords`
 *   and always leaves a record accounting for what it placed. `.gitignore` did NOT degrade until
 *   issue #174: `addGitignoreBlock` opened with `safeJoin`, which throws at a live leaf symlink,
 *   so a complete install exited 1 saying `Nothing was installed.`
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
  /**
   * The ownership record path's own symlink, RESOLVED at plan time (install only) — the link and
   * where it points, which nothing in the run changes. Deliberately NOT its live/dangling state:
   * that is a fact about the link's TARGET, and the target can be a payload destination this run
   * is about to create (issue #165 review, F-1), so it is only knowable at write time.
   */
  recordLink?: { target: string };
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
  // Filled by the record-path resolution below (install only); see `InstallPlan.recordLink`.
  let recordLink: { target: string } | undefined;
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
          // RESOLVED here, REPORTED at write time (issue #165). See the project branch below.
          recordLink = resolveRecordLink(p);
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
      // AFTER `recordPath` in this literal on purpose: the IIFE above is what assigns it, and
      // object properties are evaluated in source order.
      recordLink,
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
    // action that may not happen. That is #165's F-3 shape, and it is why this says "if the
    // removal completes" and `init` states the actual outcome where it is known.
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
    // THE RECORD LINK IS RESOLVED HERE AND REPORTED AT WRITE TIME, and the split is the whole
    // correction (issue #165, review finding F-1).
    //
    // An earlier cut of #165 moved the entire disclosure here, on the reasoning that "the link
    // state cannot change between plan time and the write, because the record path is not a
    // payload destination". The record PATH is not — but the record link's TARGET can be, and
    // `init` creates payload files in between. A record link pointing at a not-yet-installed
    // payload file (say `<xdg>/opencode/agent/guild-read.md`, directory present, file absent) is
    // DANGLING at plan time and LIVE at write time: the def is installed, reported in
    // `installed`, then overwritten by the record JSON — while a plan-time message says "will
    // CREATE that file (the link is dangling)". `origin/main`'s late call site said "replaced
    // that file's contents", which was RIGHT. The hoist made the message worse, so only the half
    // that is genuinely stable moves: WHICH link is here and WHERE it points (nothing in the run
    // rewrites the link itself), which is what a future refusal would need. Whether the target
    // EXISTS is a fact about the target, so it is read where it is true — beside the write.
    recordLink = resolveRecordLink(recordPath);
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
    recordLink,
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
 * MODE ONLY since issue #156; `--global` uses `globalJoin` below (maintainer decision
 * 2026-08-05 — the project target is somebody's source repo, the global target is the user's
 * own config).
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
 * The ABSOLUTE target of a symlink at `p`, or `undefined` when `p` holds no entry or is not a
 * link. Resolved against the LINK's own directory, because `readlink(2)` returns the stored text
 * and a relative one means nothing to a reader who does not know where the link lives. Never
 * throws — an unreadable link answers `undefined`, the same as no link at all.
 *
 * Deliberately narrower than `resolveRecordLink`, which also reports whether the link RESOLVES.
 * The payload loops ask only "is there a link here, and where does it point?"; `isRegularFile`
 * (C78: `stat`, so it follows) answers the other half from the bytes themselves.
 */
function symlinkTargetOf(p: string): string | undefined {
  try {
    if (!lstatSync(p).isSymbolicLink()) return undefined;
    return path.resolve(path.dirname(p), readlinkSync(p));
  } catch {
    return undefined;
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
 * THREE NAMED CONDITIONS, ENUMERATED — still NOT a general "can this write succeed?" predicate
 * (maintainer decision 2026-08-05): the target's directory is ABSENT (`ENOENT`), it is present
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
 * The ownership record's own path is a SYMLINK: say so (issue #156, maintainer decision
 * 2026-08-05). It is not skipped, and — except for the two shapes `assertRecordLinkWritable`
 * refuses above — not refused either: the record is written THROUGH the link,
 * because only init writes this file, so there is no user content it is expected to
 * preserve, and a dotfiles manager that links files individually (GNU stow does, when the
 * parent directory already exists) legitimately puts a link here. But a user CAN point that
 * path at a file of their own, and then the bytes land somewhere they did not expect — so
 * name the link and the file the bytes actually go to, the same way the install loop names a
 * skipped payload file. Must be called IMMEDIATELY BEFORE the write: afterwards a dangling link
 * and a live one are indistinguishable, and BEFOREHAND they can be the wrong way round.
 *
 * WHICH LINK is resolved at plan time (`InstallPlan.recordLink`) because nothing in the run
 * rewrites the link itself; whether its TARGET EXISTS is read HERE, because the payload loop can
 * have created it in between — issue #165's F-1, where a record link aimed at a
 * not-yet-installed agent def was dangling at plan time, live by the write, and described as a
 * creation while it was silently destroying a def that had just been installed. The tense stays
 * FUTURE: the write is the next statement, and it has not happened yet.
 *
 * `payloadAt` maps an absolute payload destination to its dest-rel, so the case that is not just
 * a lost user file — the record landing on top of a payload file this very run placed, which
 * makes an agent def unparseable and is caught only by C73 seconds into the first tool call —
 * is NAMED rather than left to read as an ordinary overwrite. Best-effort by string comparison:
 * a link reaching the same file by another route (through a directory symlink, say) is not
 * matched, and the warning then reads as the generic one, which is still accurate.
 *
 * Never throws — a warning that cannot be computed must not fail the install.
 *
 * THE RECORD LEAF DELIBERATELY DIVERGES FROM THE PAYLOAD LEAF (issue #165, C80), and the
 * divergence is FORCED rather than preferred. A payload leaf is followed only when the bytes
 * behind it hash to what the ownership record says init wrote there — and there is no record OF
 * the record: the hash it would be checked against is the one this very file is about to contain.
 * The check is circular, so the only two rules available here are write-through (C77's shipped
 * decision, and what a stow-managed record path needs) or skip-always (which breaks that layout
 * outright). Write-through stands; this warning is what carries its cost, so it says which of the
 * two it is doing and that nothing gated it.
 */
function recordSymlinkWarning(
  recordPath: string,
  link: { target: string },
  payloadAt: Map<string, string>,
): string {
  const { target } = link;
  // READ NOW, not at plan time: `existsSync` follows, so this is a question about the TARGET.
  let live: boolean;
  try {
    live = existsSync(recordPath);
  } catch {
    live = false; // unanswerable ⇒ the milder claim, never a destruction we cannot stand up
  }
  const collides = payloadAt.get(target);
  return (
    `writing the ownership record through a symlink — ${recordPath} links to ${target}, so the record ` +
    (live ? `will REPLACE that file's contents` : `will CREATE that file (the link is dangling)`) +
    (collides
      ? `. THAT FILE IS A PAYLOAD DESTINATION (${collides}): this install placed it and is about ` +
        `to overwrite it with the record JSON, which leaves it unusable — an agent def in this ` +
        `state is caught only when a tool call refuses`
      : ``) +
    `. Unlike a payload file, this is NOT hash-gated — there is no record of the record to ` +
    `recognise, so nothing here declines to clobber. Remove the link and re-run init to keep the ` +
    `record at ${recordPath} itself.`
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
    const entry: PayloadFileState = {
      dest: e.dest,
      installedPath: e.installedPath,
      shippedPath,
      installedHash: current,
      shippedHash: shipped,
      recordPath: e.recordPath,
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
  let text = isRegularFile(p) ? readFileSync(p, "utf8") : "";
  text = stripGitignoreBlock(text); // idempotent — never double-add
  if (text.length > 0 && !text.endsWith("\n")) text += "\n";
  if (text.length > 0) text += "\n";
  text += GITIGNORE_BODY;
  try {
    writeFileSync(p, text);
  } catch (err) {
    return {
      blocked: true,
      warning:
        `could not write the ModelGuild block into ${p} (${errCode(err)}) — everything else was ` +
        `installed. Add \`modelguild/logs/\`, \`modelguild/models.policy.local\` and ` +
        `\`modelguild/modelguild.conf.local\` to your ignore rules by hand, or fix that file and ` +
        `re-run init.`,
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
  /**
   * THE LEAF RULE IS GLOBAL-ONLY (issue #165, C80), and that is C77's asymmetry rather than a new
   * one: `--global` writes into the user's OWN config, where a dotfiles manager legitimately puts
   * a link at each payload path, while a project destination is somebody's source repo.
   *
   * In PROJECT mode no destination this reaches can BE a live link — `safeJoin` refuses one
   * eagerly in `planFor` and again from `destFor` — so the probe is SKIPPED rather than asked and
   * always answered `undefined`: same result, one fewer `lstat` per file, and a third destination
   * mode cannot be added without deciding what it answers here.
   */
  const leafLinkTarget = (p: string): string | undefined =>
    opts.global ? symlinkTargetOf(p) : undefined;

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
          // REMOVE THE LINK, LEAVE THE TARGET, AND SAY SO (issue #165, C80). `unlink(2)` never
          // follows a final component, so this is what it already did — silently. Asymmetric with
          // install ON PURPOSE: writing through the link updates a file the user asked to be
          // there, while deleting through it would remove a file out of a store they manage
          // (typically a git dotfiles repo), which nobody asked for. Init wrote the BYTES; the
          // user chose the link and where it points. Named so the leftover can be dealt with.
          const linkTarget = leafLinkTarget(abs);
          unlinkSync(abs);
          result.removed.push(dest);
          if (linkTarget) {
            result.warnings.push(
              `removed the symlink at ${abs}, but LEFT its target ${linkTarget} in place — it ` +
                `lives in a directory you manage (dotfiles?), so deleting from there is yours to ` +
                `do. A re-install will write a regular file at ${abs}, not restore the link.`,
            );
          }
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
      // LINK, so that promise is broken by this branch and nothing else would correct it. That is
      // #165's F-3 shape (a message asserting an action that did not happen) pointed the other
      // way, so the plan-time sentence is now conditional and the outcome is stated HERE, where
      // it is known. Deliberately NOT a copy of #165's removal warning below: nothing was
      // removed, so no leftover is claimed and no ownership of the target is asserted.
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
      // ISSUE #165'S LEFTOVER DISCLOSURE BELONGS TO THIS ARM ALONE (merge of #165 and #176):
      // hoisting it above the retention branch would announce a removal that did not happen —
      // #165's own F-3 defect, re-created by a merge rather than by an edit.
      const recordLink = symlinkTargetOf(plan.recordPath);
      try {
        unlinkSync(plan.recordPath);
        if (recordLink) {
          // THE SAME CALL AS A PAYLOAD LEAF'S, AND NOW THE SAME REPORTING (issue #165). This
          // already removed the LINK and left the target — silently, while the payload leaf's
          // whole justification is that the leftover must be named. It matters more here, not
          // less: the write-through was not hash-gated, so the file left behind may be the
          // user's own with ModelGuild's JSON in it (C77's stated cost), and nothing else in the
          // run mentions it. `symlinkTargetOf`, not `leafLinkTarget` — the record write-through
          // is BOTH modes (C77), so the disclosure of its leftover has to be too.
          //
          // DO NOT ASSERT A DESTRUCTION THAT MAY NOT HAVE HAPPENED (issue #165, review finding
          // F-3). An earlier cut said flatly that the target "still holds ModelGuild's
          // ownership-record JSON, which the install wrote over it" — but the only condition
          // guarding that sentence was "there is a link here", which says nothing about whether
          // any install ever wrote through it. Reproduced: plant a record symlink at a file
          // holding `MINE\n`, never install, run `--uninstall` ⇒ the claim fired and the file was
          // untouched. The evidence is already in hand and costs no syscall: `records` /
          // `ownedMcp` were parsed FROM that path at the top of this function, so a non-empty
          // read means the bytes behind the link really are ours. Empty is genuinely ambiguous —
          // not ours, unreadable, or an empty record — so it gets the conditional wording.
          const wasOurs = Object.keys(records).length > 0 || ownedMcp !== undefined;
          result.warnings.push(
            `removed the symlink at ${plan.recordPath}, but LEFT its target ${recordLink} in ` +
              `place${existsSync(recordLink) ? "" : " (already gone)"} — uninstall deletes the ` +
              `link, never through it. ` +
              (wasOurs
                ? `That file holds ModelGuild's ownership-record JSON, which an install wrote ` +
                  `through this link; if the file was originally yours, nothing here restores it.`
                : `Its contents did not read as a ModelGuild ownership record, so nothing was ` +
                  `removed from it and this run made no claim on it.`),
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
      const linkTarget = leafLinkTarget(destAbs);

      // `entryExists`, not `existsSync`: a DANGLING symlink at the destination is an entry the
      // user put there, and `existsSync` follows the link and calls it absent — which sent the
      // write straight through it (issue #156).
      if (entryExists(destAbs)) {
        // A LEAF LINK IS SETTLED BY THE OWNERSHIP RULE, NOT BY PATH TYPE (issue #165, C80).
        // `isRegularFile` is `stat` (C78), so it FOLLOWS the link and answers about the bytes the
        // hash two lines down will read; `lstatSync().isFile()` answers about the LINK, which is
        // what turned every stow/chezmoi per-file destination into a permanent skip. A DANGLING
        // link still skips — by this same rule rather than by an exception to it, because it has
        // no bytes and so cannot match anything init recorded.
        const usable = linkTarget ? isRegularFile(destAbs) : lstatSync(destAbs).isFile();
        if (!usable) {
          result.warnings.push(
            linkTarget
              ? `skipping ${dest} — ${destAbs} is a symlink to ${linkTarget}, which is not a ` +
                `regular file (missing, a directory, or a FIFO); left untouched. A leaf link is ` +
                `followed only when the bytes behind it are ones init recorded, and there are none.`
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
          // Where the destination is a link, SAY SO: "I left your file alone" reads differently
          // when the file is not at the path being named (issue #165).
          const via = linkTarget ? ` (${destAbs} is a symlink to ${linkTarget})` : "";
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
                `NEWER version: your copy is stale (see the drift note)${via}.`,
            );
          } else {
            result.warnings.push(
              recorded
                ? `skipping ${dest} — you edited it since init wrote it; left untouched ` +
                  `(your edit is against the version this release still ships — not stale)${via}.`
                : `skipping ${dest} — a file you already have is there; left untouched${via}.`,
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
      writeFileSync(destAbs, payloadBytes); // FOLLOWS a leaf link — deliberately (C80)
      newRecords[dest] = payloadHash;
      result.installed.push(dest);
      if (linkTarget) {
        // A write THROUGH a link lands in a directory the user manages, so it is surfaced rather
        // than done silently. An idempotent re-run never reaches here (equal bytes ⇒ no write),
        // so this fires on a real upgrade, not on every run. It states the bound of the check
        // that authorized it, because "ownership" makes it easy to read as more than it is.
        result.warnings.push(
          `wrote ${dest} THROUGH the symlink at ${destAbs} — the bytes landed in ${linkTarget}. ` +
            `init followed the link because what was behind it hashed to what init last wrote ` +
            `there; that is a FRESHNESS check, not an authorization check (the recorded hashes ` +
            `are of files published in the npm tarball).`,
        );
      }
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
  // THE RECORD-LINK DISCLOSURE, reported HERE and resolved at plan time (issue #165, F-1). The
  // live/dangling half is a fact about the link's TARGET, and the payload loop above can have
  // just created it, so it is read where it is true rather than where it would read tidily.
  if (plan.recordLink) {
    const payloadAt = new Map<string, string>();
    for (const { dest } of payloadFiles()) {
      try {
        payloadAt.set(plan.destFor(dest), dest);
      } catch {
        /* an unresolvable destination cannot be what the record link points at */
      }
    }
    result.warnings.push(recordSymlinkWarning(plan.recordPath, plan.recordLink, payloadAt));
  }
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
