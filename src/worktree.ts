/**
 * worktree.ts — the review-target root: validate a caller-supplied directory against
 * `git worktree list` and hand back a root the serve child may be spawned from (issue #96).
 *
 * WHY THIS EXISTS. `opencode serve` runs with a cwd, and opencode's own
 * `external_directory` permission fences its `read`/`grep`/`glob` tools inside that cwd.
 * The hardened defs are default-deny allowlists, so `external_directory` resolves to
 * **deny** — every read against a sibling git worktree of the SAME repository is refused
 * (probed live on opencode 1.18.7, 2026-07-29; see AGENTS.md). This repo's documented
 * workflow is one worktree per issue, so `/guild:review` — a command whose whole point is a
 * second model reading a change BEFORE it merges — could only ever see the main checkout,
 * i.e. code that had already landed. A Claude review subagent reads a sibling worktree
 * fine, so this is a PARITY defect, and AGENTS.md says the direction to move is loosening.
 *
 * WHAT THE FENCE IS, NOW. Not "any directory": the caller names a target and it must be a
 * worktree of the repository the server already resolved, enumerated by
 * `git worktree list --porcelain` run in that repository. That set is small, checkable, and
 * belongs to the repo the user is already working in. Anything else — an arbitrary path, a
 * worktree of a DIFFERENT repository, a path that does not exist — is REFUSED and named.
 * (Maintainer decision, 2026-07-29, issue #96.)
 *
 * ONE CHOKE POINT, AND AN ERROR RATHER THAN A FALLBACK — the `#resolveRun` precedent
 * (CONTRACT C33a). The target is validated here and nowhere else, and a target that does
 * not validate is a REFUSAL, never a silent fall back to the project root: a caller that
 * believes it is reviewing a branch must not quietly be handed the main checkout, because
 * the resulting review would be fluent, plausible, and about the wrong code.
 *
 * WHAT THIS IS NOT. It is not a confidentiality boundary and does not pretend to be one.
 * A worktree of your own repository is a directory you already trust the read paths with;
 * rooting a serve there widens what an external model can read (and therefore what can
 * egress to a third-party model provider) by exactly that worktree — see SECURITY.md.
 */

import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

/** `git worktree list` output is small; this is a sanity bound, not a tuning knob. */
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

export interface GitRunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Injectable git runner (tests drive the real one against a real repo; this seam exists
 * so a failure mode — git absent, not a repository — can be exercised deterministically). */
export type GitRunner = (args: string[], cwd: string) => GitRunResult;

const realGit: GitRunner = (args, cwd) => {
  const r = spawnSync("git", args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

export type WorktreeResolution =
  | {
      ok: true;
      /** The validated, realpath-resolved worktree root to spawn the serve child from. */
      root: string;
      /** True when the target IS the server's own project root — nothing needs re-rooting. */
      isDefault: boolean;
    }
  | { ok: false; message: string };

/** Resolve caller-named dependency directories for a read-only turn. These are deliberately
 * not constrained to git worktrees: package caches and vendored dependencies are outside the
 * repository. The caller opts in path by path, and the canonical paths become the only
 * session-scoped `external_directory` grants we emit. */
export function resolveReadPaths(
  paths: readonly string[] | undefined,
  baseDir: string,
): { ok: true; paths: string[] } | { ok: false; message: string } {
  if (paths === undefined || paths.length === 0) return { ok: true, paths: [] };
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    if (typeof raw !== "string" || raw.trim().length === 0) {
      return { ok: false, message: "readPaths entries must be non-empty directory paths." };
    }
    let canonical: string;
    try {
      canonical = realpathSync(path.resolve(baseDir, raw));
    } catch {
      return { ok: false, message: `readPaths entry '${raw}' does not exist.` };
    }
    try {
      if (!statSync(canonical).isDirectory()) {
        return { ok: false, message: `readPaths entry '${raw}' resolves to '${canonical}', which is not a directory.` };
      }
    } catch {
      return { ok: false, message: `readPaths entry '${raw}' could not be inspected.` };
    }
    if (!seen.has(canonical)) {
      seen.add(canonical);
      resolved.push(canonical);
    }
  }
  return { ok: true, paths: resolved };
}

/**
 * Every worktree of the repository containing `projectDir`, realpath-resolved.
 *
 * `--porcelain` is the stable, machine-readable form: records separated by a blank line,
 * each opening with `worktree <absolute path>`. A worktree whose path no longer exists
 * (prunable) is dropped rather than reported, because it cannot be a valid target anyway
 * and naming it in the refusal message would only be noise.
 */
function listWorktrees(
  projectDir: string,
  git: GitRunner,
): { ok: true; roots: string[] } | { ok: false; message: string } {
  const r = git(["worktree", "list", "--porcelain"], projectDir);
  if (r.status !== 0) {
    const detail = r.stderr.trim() || r.stdout.trim();
    return {
      ok: false,
      message:
        `could not enumerate git worktrees from '${projectDir}' ` +
        `(git exited ${r.status}${detail ? `: ${detail}` : ""}). A review target is only ` +
        `accepted when it is a worktree of THIS repository, so with no worktree list there ` +
        `is nothing to validate against.`,
    };
  }
  const roots: string[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const p = line.slice("worktree ".length).trim();
    if (p.length === 0) continue;
    try {
      roots.push(realpathSync(p));
    } catch {
      /* prunable worktree — its path is gone, so it can never be a valid target */
    }
  }
  return { ok: true, roots };
}

/**
 * Validate a caller-supplied review target and return the root to spawn the serve child
 * from. `target` is DRIVER-CONTROLLED (Claude picks it), so this membership check is the
 * entire fence — there is no other gate between the tool input and the serve child's cwd.
 *
 * A relative target is resolved against `projectDir` (the repository the server already
 * resolved), never against the process cwd of whatever spawned us: the whole point is that
 * the answer is anchored to one known repository.
 *
 * The comparison is between REALPATHS on both sides, so a symlinked path that lands on a
 * listed worktree is accepted (it is the same directory) and a symlink that lands anywhere
 * else is refused (it is not). A target that does not exist is refused before git is even
 * consulted — "not in the list" would be a true but unhelpful thing to say about a typo.
 */
export function resolveWorktreeTarget(
  target: string,
  opts: { projectDir: string; git?: GitRunner },
): WorktreeResolution {
  const git = opts.git ?? realGit;
  const raw = target.trim();
  if (raw.length === 0) {
    return {
      ok: false,
      message:
        "worktree: an empty path is not a review target. Pass the directory of a git " +
        "worktree of this repository (see `git worktree list`), or omit the argument to " +
        "review the project the server is rooted at.",
    };
  }

  let projectRoot: string;
  try {
    projectRoot = realpathSync(opts.projectDir);
  } catch {
    projectRoot = path.resolve(opts.projectDir);
  }

  const absolute = path.resolve(projectRoot, raw);
  let candidate: string;
  try {
    candidate = realpathSync(absolute);
  } catch {
    return {
      ok: false,
      message:
        `worktree '${raw}' does not exist (resolved to '${absolute}'). A review target must ` +
        `be an existing git worktree of this repository — run \`git worktree list\` to see ` +
        `them.`,
    };
  }

  const listed = listWorktrees(projectRoot, git);
  if (!listed.ok) return { ok: false, message: `worktree '${raw}': ${listed.message}` };

  if (!listed.roots.includes(candidate)) {
    const known =
      listed.roots.length > 0 ? listed.roots.join(", ") : "(none — this is not a git worktree)";
    return {
      ok: false,
      message:
        `worktree '${raw}' (resolved to '${candidate}') is NOT a worktree of the repository ` +
        `at '${projectRoot}'. Refusing: the enumerable set of this repository's worktrees is ` +
        `the ONLY widening of the read root this tool performs, so a path outside it — ` +
        `including a worktree of a different repository — is refused rather than silently ` +
        `reviewed against the project root. Worktrees of this repository: ${known}.`,
    };
  }

  return { ok: true, root: candidate, isDefault: candidate === projectRoot };
}
