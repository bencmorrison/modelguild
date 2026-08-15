/**
 * Path-shape predicates for "is it safe to read/write this path?" (issues #162, #163).
 *
 * A leaf module on purpose: it imports nothing but `node:fs`, so every layer — the
 * installer, the config/policy resolvers and the CLI — can share ONE predicate without a
 * dependency cycle, and the four sites that had four different answers cannot drift apart
 * again.
 *
 * THE POINT A `try/catch` DOES NOT COVER: `existsSync` answers TRUE for a FIFO, and both
 * `readFileSync` and `writeFileSync` on a FIFO with no peer BLOCK — a block is not an
 * exception, so no surrounding handler can reach it. The only defence is to look at the
 * path's shape before touching it. `src/notice.ts` reached this conclusion first (C72); the
 * predicate lives here so the rest of the codebase states it once.
 *
 * `stat`, NOT `lstat`, and that choice is the whole of issue #163: `lstat` answers about the
 * LINK, so a payload file symlinked by a dotfiles manager (GNU stow, chezmoi) reads as "not
 * a regular file" and disappears from skew/drift detection — while every runtime consumer,
 * `open(2)` included, follows it and reads the bytes fine. `stat` answers the question the
 * consumers actually ask, and still rejects a directory, FIFO, socket or device.
 *
 * Do NOT substitute `lstat` at a call site that then reads or writes the path. Where a rule is
 * genuinely about the LINK rather than its target — `safeJoin`'s per-component refusal and
 * `danglingLinkAt` in `src/init.ts`, the notice state file — `lstat` is correct and stays.
 *
 * The install loop's never-clobber leaf branch USED to be on that list and no longer is (issue
 * #165, C80): a `--global` leaf symlink is now settled from the bytes read THROUGH it, so it is
 * a call site that reads the path and takes `stat` like every other. It is named here because
 * the old wording pointed at exactly the line that changed, and pointed the wrong way.
 */

import { statSync } from "node:fs";

/**
 * True iff the path resolves (following symlinks) to a regular file. Absent, dangling,
 * unreadable, or any non-regular shape ⇒ false. Never throws.
 *
 * The gate for a READ: safe to `readFileSync`.
 */
export function isRegularFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * True iff something IS there and it is NOT a regular file — a directory, FIFO, socket or
 * device. Absent and DANGLING both answer false, deliberately: a write through a dangling
 * link creates its target and does not block, so refusing there would change behaviour this
 * issue is not about (see C77 for who owns dangling links).
 *
 * The gate for a WRITE: `writeFileSync` here would block or fail, so refuse first.
 *
 * NOT the complement of `isRegularFile` — both are false for an absent path.
 */
export function isNonRegularFile(p: string): boolean {
  try {
    return !statSync(p).isFile();
  } catch {
    return false;
  }
}
