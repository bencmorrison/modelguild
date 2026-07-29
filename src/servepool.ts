/**
 * servepool.ts — one supervised `opencode serve` child PER READ ROOT (issue #96).
 *
 * WHY A SECOND CHILD RATHER THAN RE-ROOTING THE FIRST. `opencode serve` fixes its cwd at
 * spawn, and opencode's `external_directory` rule fences the read tools inside that cwd —
 * so reviewing a sibling worktree means a child rooted THERE. Two ways to get one:
 *
 *   - RESTART the single supervised child at the new root. Rejected: the lifecycle is
 *     refcounted and a session is long-lived, so a restart would kill a serve with other
 *     calls in flight (a panel member, a slow research turn) to satisfy an unrelated
 *     review, and would thrash on any workflow that alternates roots.
 *   - A SECOND supervised child, keyed by root. Chosen. Each root gets its own
 *     `OpencodeLifecycle`, so it inherits — unchanged — free-port negotiation, the
 *     readiness poll, crash-revive, the idle timeout and the stdin/transport teardown.
 *
 * THE COST, STATED. A second root means a second loopback port open for as long as that
 * child lives, a second `GET /event` subscription (`ServeEventBus` is keyed by base URL,
 * so nothing is shared between children), a second idle timer, and a second `opencode
 * serve` process's memory. Nothing caps the number of roots except the set of the
 * repository's own worktrees (`src/worktree.ts` is the fence) and the idle timeout, which
 * is what actually reclaims them: a root nobody has consulted for `GUILD_SERVE_IDLE_MS`
 * shuts itself down and is respawned on demand. The loopback surface itself is the one
 * SECURITY.md already documents, multiplied by the roots in use.
 *
 * NOT A `ServeProvider`. An earlier cut had the pool delegate `withServe` to the primary so
 * it could stand in wherever a bare provider was wanted (review finding L3). Nothing used it,
 * and what it actually offered was a way to hand the pool to a call site expecting "the serve"
 * and silently get the project root — the exact confusion this module exists to remove. The
 * caller names the root or names the primary lifecycle; there is no third option.
 *
 * TEARDOWN, AND THE ONE DISTINCTION THAT COSTS A BUG IF YOU MISS IT (review finding H1).
 * The pool registers ONE callback on the primary lifecycle (`onShutdown`) rather than
 * duplicating the stdin-EOF / transport-close wiring that the M1 orphan proof rests on — so
 * every extra child dies when the PROCESS is going away. It does **not** die when the
 * primary child is merely being RECLAIMED: `shutdown()` is also how the idle timer and
 * per-call mode retire a child, and `#inFlight` counts calls on the primary alone, so a
 * worktree-targeted call running entirely on an extra leaves the primary looking idle. The
 * first cut of this file claimed "every extra child dies on the same trigger as the primary
 * one" as a safety property without noticing that two of those triggers are not teardown at
 * all; the primary's 10-minute idle timer would kill a 15-minute review mid-turn.
 * `RECLAMATION_REASONS` in `src/lifecycle.ts` is the fence, and it defaults to teardown so
 * the orphan guarantee cannot be weakened by a reason someone adds later.
 *
 * Reclamation still happens — per child. Each extra is a full `OpencodeLifecycle` with its
 * own idle timer and its own per-call mode, so an idle root retires itself on exactly the
 * same terms the primary does. Each also joins the process-wide signal/`exit` backstop when
 * it starts, so a hard exit kills them too.
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import { OpencodeLifecycle, type LifecycleOptions } from "./lifecycle.js";
import { type ServeProvider, type ServeRouter } from "./client.js";

/** Canonicalize a directory for use as a pool key. Falls back to a plain `resolve` when the
 * path cannot be stat'd, so this never throws on the routing path. */
function canonical(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

export class ServePool implements ServeRouter {
  readonly #primary: OpencodeLifecycle;
  readonly #extra = new Map<string, OpencodeLifecycle>();
  /** The primary's root, CANONICALIZED (review finding L4). `resolveWorktreeTarget` hands
   * back realpaths while `OpencodeLifecycle#projectDir` is whatever `$GUILD_PROJECT_DIR`/cwd
   * said, so comparing raw strings could mint a second child for a directory that already has
   * one — reachable only via a symlinked project dir today, but free to close. */
  readonly #primaryKey: string;
  /** Options handed to every extra child, minus `projectDir` (which IS the key). */
  readonly #opts: Omit<LifecycleOptions, "projectDir">;

  constructor(primary: OpencodeLifecycle, opts: Omit<LifecycleOptions, "projectDir"> = {}) {
    this.#primary = primary;
    this.#primaryKey = canonical(primary.projectDir);
    this.#opts = opts;
    // Die together ON TEARDOWN. Registered in the constructor so there is no window in which
    // an extra child exists but is not covered by the primary's teardown. `onShutdown`
    // deliberately does NOT fire for the primary's idle/per-call reclamation — see the
    // header and `RECLAMATION_REASONS`.
    this.#primary.onShutdown(() => this.shutdownExtras("primary-teardown"));
  }

  /** The default root — the project the server itself was launched in. */
  get projectDir(): string {
    return this.#primary.projectDir;
  }

  /**
   * The provider for `root`. The primary lifecycle is returned for the project root itself,
   * so the ordinary (untargeted) path spawns exactly the one child it always did — a review
   * of the checkout you are already in costs nothing new.
   *
   * `root` MUST already have been validated by `resolveWorktreeTarget`; this method is the
   * mechanism, not the fence, and deliberately does no checking of its own so there is only
   * one place where "which directories may be a read root" is decided (CONTRACT C33a's
   * one-choke-point discipline).
   */
  forRoot(root: string): ServeProvider {
    const key = canonical(root);
    if (key === this.#primaryKey) return this.#primary;
    const existing = this.#extra.get(key);
    // Deliberately RETURNED, not re-created, even if its child has since died: an entry here
    // is a SUPERVISOR, not a process (review finding L2). `OpencodeLifecycle.ensureServe`
    // crash-revives on the next call, so dropping the entry when an extra idles out would
    // only mint a duplicate supervisor for the same directory.
    if (existing) return existing;
    // NOTE (review finding L1): constructing a lifecycle spawns NOTHING — no process, no
    // port, no timer, no signal handler. So a call that is refused after this point (a
    // missing hardened def in the worktree, a policy deny) leaves behind a Map entry and
    // nothing else, and that entry is exactly what a corrected retry reuses.
    const child = new OpencodeLifecycle({ ...this.#opts, projectDir: key });
    this.#extra.set(key, child);
    return child;
  }

  /** Roots with a child in the pool (the primary root is not listed). Diagnostic. */
  get extraRoots(): string[] {
    return [...this.#extra.keys()];
  }

  /** Tear down every extra child. Idempotent; never throws (teardown must not fail). */
  shutdownExtras(reason?: string): void {
    for (const child of this.#extra.values()) {
      try {
        child.shutdown(reason);
      } catch {
        /* best-effort: one child's teardown failure must not skip the rest */
      }
    }
    this.#extra.clear();
  }
}
