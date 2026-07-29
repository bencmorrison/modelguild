/**
 * snapshot.ts — the WRITE-PATH worktree snapshot + delegated-diff machinery.
 *
 * A faithful TypeScript port of ask.sh's `_snapshot_tree`, `record_delegate_diff`,
 * `_ignored_fingerprint` and `_submodule_state` (CONTRACT.md area E, C36–C40). ask.sh is
 * the oracle; where a behavior is described below it is the bash behavior unless a
 * DIVERGENCE is called out.
 *
 * The design in one line: before the delegated model runs, snapshot the worktree as a git
 * TREE via a throwaway index (`git add -A` honoring .gitignore, `git write-tree`) WITHOUT
 * touching the caller's index or worktree (C36/C37); after it runs, snapshot again and
 * `git diff-tree` the two trees to record the model's changes ONLY — including files it
 * created (C37 — the scar: a plain `git diff <sha>` misses created files and produced an
 * EMPTY diff on a files-only-added delegation). The pre-tree id is the recovery hint
 * (C38/C39: `git checkout <tree> -- <path>`). When the ignored-file state or submodule
 * state cannot be faithfully represented in the patch, the capture is marked INCOMPLETE so
 * the delegate-diff log entry fails integrity loudly (C40).
 *
 * This is a RECORD, not containment — the trust boundary is the human diff review
 * (SECURITY.md guild-build). The snapshot never runs for read-only agents.
 *
 * All functions take an explicit `repoDir` (the worktree opencode edits — the project dir
 * the serve was spawned from). Pure git plumbing: no logging, no policy, no MCP.
 */

import { spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import {
  existsSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  lstatSync,
  readdirSync,
  type Dirent,
} from "node:fs";
import os from "node:os";
import path from "node:path";

/** git diff-tree of a whole worktree can be large; cap captured stdout generously for the
 * text commands (the patch itself is streamed to a file descriptor, never buffered). */
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

function git(repoDir: string, args: string[], extraEnv?: NodeJS.ProcessEnv): GitResult {
  const r = spawnSync("git", args, {
    cwd: repoDir,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Split a NUL-delimited git `-z` payload into entries (dropping a trailing empty). */
function splitZ(s: string): string[] {
  if (s.length === 0) return [];
  const parts = s.split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/**
 * True iff `rel` (a git-style, forward-slash repo-relative path) is `opencode serve`'s own
 * runtime scaffolding, excluded from the ignored-file fingerprint.
 *
 * NAMED HARNESS DIFFERENCE — serve scaffolds the project dir; `opencode run` does not.
 * RATIFIED by the maintainer on 2026-07-22, CONDITIONAL ON the scaffoldDigest tamper signal
 * (below) that this exclusion is paired with. `opencode serve` (the transport the TS rewrite
 * runs on) materializes a plugin runtime — `.opencode/node_modules/` (which carries symlinked
 * `.bin/*` entries the fingerprint would otherwise flag as unrepresentable `unsupported-path`,
 * and thousands of files that blow the count/walk caps) plus its `.opencode/{package.json,
 * package-lock.json,bun.lock,.gitignore}` manifests — INTO the edited worktree. Without
 * excluding them EVERY serve-transport delegate reports capture-incomplete (traced live
 * 2026-07-22).
 *
 * THIS IS NOT the same class as the `modelguild/logs/` exclusion, and the analogy was wrong: logs
 * are INERT evidence, but `.opencode/node_modules/` is LOADED AND EXECUTED by `opencode serve`
 * (it loads plugins from there). So excluding it trades fingerprint noise for a real BLIND SPOT
 * — a delegated model could write persistence into a plugin the record would never show. That
 * blind spot is exactly what `scaffoldDigest` (a before/after tamper signal on these same
 * paths) now covers: a scaffolding change during the call sets `scaffoldChanged:true` with a
 * warning and is recorded on the delegate-diff entry. The exclusion is ratified WITH that
 * signal as its condition; the two ship together.
 *
 * DELIBERATELY NARROW — `.opencode/agent/**` is NOT excluded. Those files are the hardened
 * permission defs (guild-build/read/research/watch); a bash-capable delegated model
 * tampering with a def is PRECISELY a change the capture must never silently drop, so the
 * def surface stays fully inside the fingerprint and the recorded patch.
 *
 * bash's `_ignored_fingerprint` is deliberately left UNTOUCHED: it runs behind `opencode
 * run`, which never materializes this scaffolding, so it never encounters the problem and
 * needs no corresponding exclusion (keeping the two sides as close as their transports allow).
 */
function isServeScaffold(rel: string): boolean {
  const p = rel.replace(/\/+$/, ""); // git may report a collapsed ignored dir with a trailing /
  return (
    p === ".opencode/node_modules" ||
    p.startsWith(".opencode/node_modules/") ||
    p === ".opencode/package.json" ||
    p === ".opencode/package-lock.json" ||
    p === ".opencode/bun.lock" ||
    p === ".opencode/.gitignore"
  );
}

/** True iff `repoDir` is inside a git worktree (mirrors ask.sh's `--is-inside-work-tree`
 * guard: a non-git dir gets no snapshot and no recorded diff). */
export function isGitWorktree(repoDir: string): boolean {
  const r = git(repoDir, ["rev-parse", "--is-inside-work-tree"]);
  return r.status === 0 && r.stdout.trim() === "true";
}

/** True iff the worktree has uncommitted changes (drives the recovery-hint surfacing). */
export function worktreeDirty(repoDir: string): boolean {
  return git(repoDir, ["status", "--porcelain"]).stdout.length > 0;
}

/**
 * Snapshot the worktree as a git tree object via a THROWAWAY index (`GIT_INDEX_FILE` at a
 * temp path). Seed it from HEAD (or empty for an unborn branch), `git add -A` (which honors
 * .gitignore, so .env / logs stay out — C37), then `git write-tree`. The caller's real
 * index and worktree are never touched (C36). Returns the tree sha, or null if not a git
 * worktree / the write failed.
 */
export function snapshotTree(repoDir: string): string | null {
  if (!isGitWorktree(repoDir)) return null;
  const idx = path.join(os.tmpdir(), `guild-index-${randomBytes(8).toString("hex")}`);
  const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: idx };
  try {
    if (git(repoDir, ["read-tree", "HEAD"], env).status !== 0) {
      git(repoDir, ["read-tree", "--empty"], env);
    }
    git(repoDir, ["add", "-A"], env);
    const tree = git(repoDir, ["write-tree"], env).stdout.trim();
    return tree.length > 0 ? tree : null;
  } finally {
    try {
      if (existsSync(idx)) unlinkSync(idx);
    } catch {
      /* best-effort: the throwaway index is disposable */
    }
  }
}

/**
 * Report whether the submodule worktree state can be faithfully represented in a
 * `git write-tree` snapshot: "clean" (no submodules, or all committed), "dirty" (a
 * submodule has uncommitted work write-tree would silently drop), or "unavailable" (git
 * could not answer). Port of `_submodule_state`. A dirty/unavailable submodule makes the
 * capture INCOMPLETE (C40) because the snapshot records only a submodule's committed object
 * id, not its in-progress work.
 */
export function submoduleState(repoDir: string): "clean" | "dirty" | "unavailable" {
  if (!existsSync(path.join(repoDir, ".gitmodules"))) return "clean";
  if (git(repoDir, ["submodule", "status", "--recursive"]).status !== 0) return "unavailable";
  const st = git(repoDir, ["status", "--porcelain=v2", "--ignore-submodules=none"]);
  if (st.status !== 0) return "unavailable";
  // porcelain v2 changed-entry: `1 <XY> <sub> …`; <sub> is 4 chars, `S....` for a submodule.
  // `S...` (no flags) is clean; any flag set means the submodule changed (matches ask.sh's
  // awk `$3 ~ /^S/ && $3 != "S..."`).
  for (const line of st.stdout.split("\n")) {
    if (!line.startsWith("1 ")) continue;
    const sub = line.split(" ")[2];
    if (sub && sub[0] === "S" && sub !== "S...") return "dirty";
  }
  const cfg = git(repoDir, [
    "config",
    "-f",
    ".gitmodules",
    "--get-regexp",
    "^submodule\\..*\\.path$",
  ]);
  if (cfg.status === 0) {
    for (const line of cfg.stdout.split("\n")) {
      if (line === "") continue;
      const sp = line.indexOf(" ");
      if (sp < 0) continue;
      const subPath = line.slice(sp + 1).trim();
      if (subPath === "") continue;
      // Parent git flags a dirty submodule gitlink even though write-tree records only its
      // committed id — check that first, then descend into the nested worktree.
      if (
        git(repoDir, ["diff-files", "--quiet", "--ignore-submodules=none", "--", subPath])
          .status !== 0
      ) {
        return "dirty";
      }
      const abs = path.join(repoDir, subPath);
      if (git(abs, ["rev-parse", "--is-inside-work-tree"]).status !== 0) continue;
      const nested = git(abs, ["status", "--porcelain", "--untracked-files=normal"]);
      if (nested.status !== 0) return "unavailable";
      if (nested.stdout.length > 0) return "dirty";
    }
  }
  return "clean";
}

/**
 * Fingerprint the .gitignore'd file state so a CHANGE to it between the before/after
 * snapshots (which `git add -A` deliberately excludes from the tree) is detectable and
 * marks the capture incomplete. Returns `complete:<hex>` (a digest that changes iff any
 * ignored file's path or content changes) or `incomplete:<reason>`. Port of
 * `_ignored_fingerprint`; the aggregate digest is ephemeral and never logged.
 *
 * DIVERGENCE FROM BASH — deliberate, fidelity to CONTRACT C40 not to the defect
 * (2026-07-22 evaluation): ask.sh's Phase-A loop increments its file counter for EVERY
 * porcelain entry — modified, untracked, AND ignored — so a repo with >1024 modified or
 * untracked (but zero ignored) files trips the `file-limit` incomplete. The 1024 cap exists
 * to bound the IGNORED files Phase C hashes; counting all status entries against it is a
 * bug. Here we count ONLY ignored (`!! `) entries, which is the population the limit is
 * actually about. C40 is phrased behaviorally, so the correct population count is the
 * faithful implementation; bash's over-count is the bug, not the contract.
 */
export function ignoredFingerprint(repoDir: string): string {
  const MAX_FILES = 1024;
  const MAX_BYTES = 16 * 1024 * 1024;
  const MAX_WALK = 16384;

  let incomplete = "";

  // Phase A: detect an ignored DIRECTORY (git collapses a wholly-ignored dir into one
  // `!! dir/` entry, which Phase C's per-file listing would miss → unmonitorable) and bound
  // the number of ignored files. See the DIVERGENCE note: only `!! ` entries are counted.
  const statusA = git(repoDir, [
    "status",
    "--porcelain=1",
    "--ignored=matching",
    "--untracked-files=all",
    "-z",
  ]);
  let ignoredCount = 0;
  for (const entry of splitZ(statusA.stdout)) {
    if (entry.startsWith("!! modelguild/logs/")) continue;
    if (!entry.startsWith("!! ")) continue; // CORRECTED count: only ignored entries.
    const p = entry.slice(3);
    if (isServeScaffold(p)) continue; // serve-runtime scaffolding — excluded (see isServeScaffold)
    if (p.endsWith("/")) {
      incomplete = "ignored-directory";
      break;
    }
    ignoredCount++;
    if (ignoredCount > MAX_FILES) {
      incomplete = "file-limit";
      break;
    }
  }

  // Phase B: git's ignored listings omit special files (symlinks, FIFOs, sockets, devices).
  // Walk metadata only (bounded by MAX_WALK), pruning .git, modelguild/logs, and
  // .opencode/node_modules (serve scaffolding — its .bin/* symlinks would otherwise flag
  // unsupported-path and its file count would blow MAX_WALK), and for any non-regular path
  // git considers ignored, mark incomplete — it cannot be represented.
  const scaffoldNodeModules = path.join(".opencode", "node_modules");
  if (incomplete === "") {
    let walkCount = 0;
    const stack: string[] = [repoDir];
    walkLoop: while (stack.length > 0) {
      const dir = stack.pop() as string;
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        incomplete = "walk-failed";
        break;
      }
      for (const de of entries) {
        const full = path.join(dir, de.name);
        const rel = path.relative(repoDir, full);
        if (rel === ".git" || rel === path.join("modelguild", "logs") || rel === scaffoldNodeModules) {
          continue; // prune subtree (incl. serve scaffolding)
        }
        walkCount++;
        if (walkCount > MAX_WALK) {
          incomplete = "walk-limit";
          break walkLoop;
        }
        if (de.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!de.isFile()) {
          // symlink / FIFO / socket / device — unrepresentable IF git ignores it.
          if (git(repoDir, ["check-ignore", "-q", "--", rel]).status === 0) {
            incomplete = "unsupported-path";
            break walkLoop;
          }
        }
      }
    }
  }

  // Phase C: hash the content of each ignored regular file into a manifest whose digest
  // changes iff any ignored file's path or content changes.
  const manifest: Buffer[] = [];
  if (incomplete === "") {
    const ls = git(repoDir, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
    ]);
    if (ls.status !== 0) {
      incomplete = "enumeration-failed";
    } else {
      let count = 0;
      let total = 0;
      for (const rel of splitZ(ls.stdout)) {
        if (rel === "") continue;
        if (rel.startsWith("modelguild/logs/")) continue; // the logger's own output is infra.
        if (isServeScaffold(rel)) continue; // serve-runtime scaffolding — excluded.
        count++;
        if (count > MAX_FILES) {
          incomplete = "file-limit";
          break;
        }
        const full = path.join(repoDir, rel);
        let st;
        try {
          st = lstatSync(full);
        } catch {
          incomplete = "metadata-unavailable";
          break;
        }
        if (st.isSymbolicLink() || !st.isFile()) {
          incomplete = "unsupported-path";
          break;
        }
        if (st.size > MAX_BYTES - total) {
          incomplete = "byte-limit";
          break;
        }
        total += st.size;
        const h = git(repoDir, ["hash-object", "--no-filters", "--", rel]);
        const digest = h.stdout.trim();
        if (h.status !== 0 || digest === "") {
          incomplete = "read-failed"; // covers unreadable-path too (open fails)
          break;
        }
        manifest.push(Buffer.from(`${rel}\0${digest}\0`, "utf8"));
      }
    }
  }

  if (incomplete !== "") return `incomplete:${incomplete}`;
  const digest = createHash("sha256").update(Buffer.concat(manifest)).digest("hex");
  return `complete:${digest}`;
}

// ===========================================================================
// The before/after snapshot pair + the capture orchestration.
// ===========================================================================

/**
 * The TAMPER SIGNAL for the serve-runtime scaffolding the fingerprint excludes. A cheap digest
 * of `.opencode/node_modules/**` + the excluded `.opencode/{package.json,package-lock.json,
 * bun.lock,.gitignore}` manifests, taken before and after the model turn; a difference means
 * the transport's PLUGIN DIRECTORY changed during the call — which, because serve loads and
 * executes that directory, is exactly the invisible-persistence write the exclusion would
 * otherwise hide (see isServeScaffold). This does NOT affect captureComplete; it is a separate
 * warning surfaced on the result and recorded on the delegate-diff entry.
 *
 * DIGEST CHOICE (cheapest that catches adds/modifies/deletes): a sorted list of `<relpath>\0
 * <size>\0<mtimeMs>` over every scaffolding path (directories included as `<rel>/\0d`), sha256'd
 * — metadata only, NO file-content reads, one lstat per entry. Size catches most modifies and
 * all adds/deletes; mtime is the catch-all for a same-size overwrite. KNOWN BOUND: a same-size
 * write that also restores the original mtime (a deliberate anti-forensic move) is missed; and
 * conversely serve's own housekeeping touch of node_modules will conservatively set the flag —
 * an over-report, the safe direction for a tamper signal. Walk is capped (metadata-only) and a
 * cap hit is folded into the digest so it stays deterministic and still flags real changes below
 * the cap.
 */
export function scaffoldDigest(repoDir: string): string {
  const MAX = 200000;
  const entries: string[] = [];
  let count = 0;
  let truncated = false;
  const nm = path.join(repoDir, ".opencode", "node_modules");
  const stack: string[] = existsSync(nm) ? [nm] : [];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let des: Dirent[];
    try {
      des = readdirSync(dir, { withFileTypes: true });
    } catch {
      entries.push(`${path.relative(repoDir, dir)}\0ERR`);
      continue;
    }
    for (const de of des) {
      const full = path.join(dir, de.name);
      const rel = path.relative(repoDir, full);
      count++;
      if (count > MAX) {
        truncated = true;
        break;
      }
      if (de.isDirectory()) {
        stack.push(full);
        entries.push(`${rel}/\0d`);
        continue;
      }
      try {
        const st = lstatSync(full);
        entries.push(`${rel}\0${st.size}\0${Math.floor(st.mtimeMs)}`);
      } catch {
        entries.push(`${rel}\0ERR`);
      }
    }
    if (truncated) break;
  }
  for (const m of [
    path.join(".opencode", "package.json"),
    path.join(".opencode", "package-lock.json"),
    path.join(".opencode", "bun.lock"),
    path.join(".opencode", ".gitignore"),
  ]) {
    try {
      const st = lstatSync(path.join(repoDir, m));
      entries.push(`${m}\0${st.size}\0${Math.floor(st.mtimeMs)}`);
    } catch {
      /* absent — omitted, so its later appearance/disappearance changes the digest */
    }
  }
  entries.sort();
  const payload = (truncated ? "TRUNCATED\0" : "") + entries.join("\n");
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * The digest `scaffoldDigest` returns for a tree with NO serve scaffolding at all — no
 * `.opencode/node_modules`, none of the four excluded manifests. Derived from the same payload
 * construction above (no entries, not truncated ⇒ the empty string), and pinned by a test that
 * calls `scaffoldDigest` on a scaffolding-free directory so the two cannot drift apart.
 *
 * WHY IT IS NEEDED (issue #107, and the known unknown #96 left open). The trigger for opencode
 * materializing its plugin runtime into a serve's cwd is now CHARACTERISED — probed on 1.18.7,
 * 2026-07-29, five configurations:
 *   - The condition is an **existing `.opencode/` DIRECTORY** in that cwd. A dir with no
 *     `.opencode/` is never scaffolded, not on serve start and not after a session is created.
 *     A dir with an EMPTY `.opencode/` is scaffolded, so it is the directory's existence that
 *     decides, not what is in it.
 *   - The moment is **the first request that loads the project's plugin runtime** — `GET /agent`
 *     and `POST /session` both do it — NOT serve startup, which is lazy: a serve that answered
 *     `/doc` and then sat idle for 25s wrote nothing.
 * `guild_delegate` requires `.opencode/agent/guild-build.md` in the tree it edits (it refuses
 * otherwise), so the condition is ALWAYS met on the write path. Consequence: the FIRST
 * delegation into a tree whose runtime has not been materialized yet will see the scaffolding
 * appear during the turn, and the before/after digests differ for a reason that is opencode's
 * own housekeeping rather than anything the model did.
 *
 * WHAT THE WRITE PATH DOES WITH THAT, and what it deliberately does NOT do: the
 * `scaffoldChanged` FLAG is unchanged — it still fires, because something in an
 * execution-carrying directory really did change and suppressing it would be the tamper
 * signal's one unforgivable failure. Only the WARNING TEXT is narrowed, to say the scaffolding
 * was CREATED rather than modified. Pre-emptively warming the child before the baseline
 * snapshot was considered and rejected: it would pin the write path's evidence baseline to an
 * undocumented lazy-load ordering in a dependency this repo tracks unpinned, and buy only the
 * suppression of a first-call-per-tree warning.
 */
export const EMPTY_SCAFFOLD_DIGEST = createHash("sha256").update("").digest("hex");

/** The BEFORE snapshot: everything the AFTER capture needs to attribute the model's diff
 * and judge representability. Taken immediately before the model turn. */
export interface WorktreeSnapshot {
  gitWorktree: boolean;
  dirty: boolean;
  /** The base tree sha (the recovery point). null when not a git worktree / write failed. */
  tree: string | null;
  ignored: string;
  submodules: string;
  /** Tamper-signal digest of the excluded serve scaffolding (see scaffoldDigest). */
  scaffold: string;
}

/** Take the BEFORE snapshot of `repoDir`. Cheap and non-mutating (C36). */
export function snapshotWorktree(repoDir: string): WorktreeSnapshot {
  const gitWorktree = isGitWorktree(repoDir);
  if (!gitWorktree) {
    return { gitWorktree: false, dirty: false, tree: null, ignored: "", submodules: "clean", scaffold: "" };
  }
  const tree = snapshotTree(repoDir);
  return {
    gitWorktree: true,
    dirty: worktreeDirty(repoDir),
    tree,
    ignored: ignoredFingerprint(repoDir),
    submodules: submoduleState(repoDir),
    scaffold: scaffoldDigest(repoDir),
  };
}

export interface CaptureInput {
  repoDir: string;
  baseTree: string | null;
  ignoredBefore: string;
  submodulesBefore: string;
  /** Where to write the patch (must be inside the run dir; log.diff stores its basename). */
  patchPath: string;
}

export interface CaptureResult {
  captureComplete: boolean;
  /** The incomplete reason (matches ask.sh's reason strings); "" when complete. */
  reason: string;
  afterTree: string | null;
  filesChanged: number;
  /** true → the model changed no tracked files AND state was fully representable: no patch
   * was written and NO delegate-diff entry should be logged ("nothing to review"). */
  nothingToReview: boolean;
}

/**
 * The AFTER capture: snapshot again, diff base→after into `patchPath` (model's changes only,
 * INCLUDING created files — C37), and decide completeness. Mirrors `record_delegate_diff`'s
 * exact ordering and reason precedence:
 *   baseline-tree-unavailable → after-tree-unavailable → ignored-state-incomplete /
 *   ignored-paths-changed → submodule-worktree-unrepresentable (unconditional override) →
 *   diff-generation-failed (unconditional override when the diff itself fails).
 *
 * An INCOMPLETE capture still writes and logs the reviewable subset patch (so the
 * delegate-diff entry exists with capture_complete:false and the log fails integrity
 * loudly, C40). Only an EMPTY patch with a fully-representable state is "nothing to review".
 */
export function captureDelegateDiff(input: CaptureInput): CaptureResult {
  const { repoDir, baseTree, ignoredBefore, submodulesBefore, patchPath } = input;
  let complete = true;
  let reason = "";
  let afterTree: string | null = null;

  if (!baseTree) {
    complete = false;
    reason = "baseline-tree-unavailable";
  } else {
    afterTree = snapshotTree(repoDir);
    if (!afterTree) {
      complete = false;
      reason = "after-tree-unavailable";
    }
  }

  const ignoredAfter = ignoredFingerprint(repoDir);
  if (
    complete &&
    (ignoredBefore === "" ||
      ignoredAfter === "" ||
      ignoredBefore.startsWith("incomplete:") ||
      ignoredAfter.startsWith("incomplete:"))
  ) {
    complete = false;
    reason = "ignored-state-incomplete";
  } else if (complete && ignoredBefore !== ignoredAfter) {
    complete = false;
    reason = "ignored-paths-changed";
  }

  let submodulesAfter = submoduleState(repoDir);
  // Authoritative parent-level check at capture time (porcelain v2's submodule field is
  // explicit: `S.M.`, `S..U`, …), independent of nested-shell propagation.
  const v2 = git(repoDir, ["status", "--porcelain=v2", "--ignore-submodules=none"]);
  if (v2.status === 0) {
    for (const line of v2.stdout.split("\n")) {
      if (!line.startsWith("1 ")) continue;
      const sub = line.split(" ")[2];
      if (sub && sub[0] === "S" && /[MU?]/.test(sub.slice(1))) {
        submodulesAfter = "dirty";
        break;
      }
    }
  }
  if (submodulesBefore !== "clean" || submodulesAfter !== "clean") {
    complete = false; // unconditional override, matching ask.sh
    reason = "submodule-worktree-unrepresentable";
  }

  // Generate the patch: base→after via diff-tree, INCLUDING created files (add -A into the
  // throwaway index put them in the trees, so a files-only-added delegation is NOT empty —
  // the C37 scar). Stream straight to the file descriptor so a huge diff is never buffered.
  let patchLen = 0;
  if (baseTree && afterTree) {
    const fd = openSync(patchPath, "w");
    let diffStatus = 1;
    try {
      const r = spawnSync("git", ["diff-tree", "--binary", "-p", baseTree, afterTree], {
        cwd: repoDir,
        stdio: ["ignore", fd, "ignore"],
      });
      diffStatus = r.status ?? 1;
    } finally {
      closeSync(fd);
    }
    if (diffStatus !== 0) {
      writeFileSync(patchPath, "");
      complete = false; // unconditional override, matching ask.sh
      reason = "diff-generation-failed";
    }
  } else {
    writeFileSync(patchPath, "");
  }
  const patchBuf = readFileSync(patchPath);
  patchLen = patchBuf.byteLength;

  if (patchLen === 0 && complete) {
    try {
      unlinkSync(patchPath);
    } catch {
      /* best-effort */
    }
    return { captureComplete: true, reason: "", afterTree, filesChanged: 0, nothingToReview: true };
  }

  const text = patchBuf.toString("utf8");
  const filesChanged = (text.match(/^diff --git /gm) || []).length;
  return { captureComplete: complete, reason, afterTree, filesChanged, nothingToReview: false };
}
