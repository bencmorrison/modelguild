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
 * TEARDOWN. The pool registers ONE callback on the primary lifecycle (`onShutdown`) rather
 * than duplicating the stdin-EOF / transport-close wiring that the M1 orphan proof rests
 * on. Every extra child therefore dies on the same trigger as the primary one. Each extra
 * additionally installs the lifecycle's own signal/`process.on("exit")` backstop when it
 * starts, so a hard exit kills them too.
 */

import { OpencodeLifecycle, type LifecycleOptions } from "./lifecycle.js";
import { type ServeProvider, type ServeRouter } from "./client.js";

export class ServePool implements ServeProvider, ServeRouter {
  readonly #primary: OpencodeLifecycle;
  readonly #extra = new Map<string, OpencodeLifecycle>();
  /** Options handed to every extra child, minus `projectDir` (which IS the key). */
  readonly #opts: Omit<LifecycleOptions, "projectDir">;

  constructor(primary: OpencodeLifecycle, opts: Omit<LifecycleOptions, "projectDir"> = {}) {
    this.#primary = primary;
    this.#opts = opts;
    // Die together. Registered in the constructor so there is no window in which an extra
    // child exists but is not covered by the primary's teardown.
    this.#primary.onShutdown(() => this.shutdownExtras("primary-shutdown"));
  }

  /** The default root — the project the server itself was launched in. */
  get projectDir(): string {
    return this.#primary.projectDir;
  }

  /** The primary child, so the pool can stand in wherever a bare `ServeProvider` is wanted. */
  withServe<T>(fn: Parameters<ServeProvider["withServe"]>[0]): Promise<T> {
    return this.#primary.withServe(fn) as Promise<T>;
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
    if (root === this.#primary.projectDir) return this.#primary;
    const existing = this.#extra.get(root);
    if (existing) return existing;
    const child = new OpencodeLifecycle({ ...this.#opts, projectDir: root });
    this.#extra.set(root, child);
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
