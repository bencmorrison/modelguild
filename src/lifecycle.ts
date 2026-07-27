/**
 * `opencode serve` lifecycle supervisor.
 *
 * Manages a single `opencode serve` child on loopback: lazy spawn, free-port
 * negotiation, readiness poll, crash-revive, idle timeout, and — the load-bearing
 * part — SHUTDOWN KEYED ON STDIN EOF AND TRANSPORT CLOSE, NOT SIGNALS.
 *
 * Why not signals: the spike proved Claude Code's MCP teardown does NOT deliver a
 * catchable signal to the server process (reproduced under both `claude -p` and the
 * maintainer's interactive session).
 * What it DOES do is close the server's stdin. And the MCP SDK's StdioServerTransport
 * only ever registers a `data` listener on stdin — never `end`/`close` — so stdin EOF
 * does not fire the transport's `onclose` either. The only reliable trigger is to watch
 * `process.stdin` end/close ourselves. Signal and process-`exit` handlers are kept as a
 * strictly second layer, never the primary mechanism.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type { Readable } from "node:stream";
import { closeBusesFor } from "./activity.js";

export interface LifecycleOptions {
  /** Project dir to spawn `opencode serve` from (its `.opencode/agent/` holds the defs). */
  projectDir?: string;
  /** Loopback host to bind. Kept configurable for tests; production stays 127.0.0.1. */
  host?: string;
  /** Idle timeout (ms) after which an idle serve is killed. 0 disables. */
  idleMs?: number;
  /** Per-call mode: spawn a fresh serve per call and kill it when the call returns. */
  perCall?: boolean;
  /** Total time to wait for `opencode serve` to answer GET /doc. */
  readyTimeoutMs?: number;
}

/** The live serve endpoint exposed to callers (no child handle leaked out). */
export interface ServeHandle {
  baseUrl: string;
  port: number;
  pid: number;
}

interface InternalHandle extends ServeHandle {
  proc: ChildProcess;
  exited: boolean;
}

const DEFAULT_IDLE_MS = 600_000; // 10 minutes
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 250;
const READY_HTTP_MS = 5_000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Ask the OS for a free loopback TCP port by binding to :0 and reading it back.
 *
 * Accepted TOCTOU: this probe listener closes before `opencode serve` binds the
 * same port, leaving a gap another process could win. There's no way to close it —
 * opencode has no `--port 0` readback that would let us hand it an already-bound
 * socket. A racer landing in that gap surfaces loudly, as `opencode serve` exiting
 * before becoming ready (see the readiness poll in `#start`), never as a silent hang.
 */
function pickFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not determine a free port")));
      }
    });
  });
}

/** Kill a serve process group (best-effort, synchronous-safe). */
function killServe(proc: ChildProcess | undefined): void {
  if (!proc || proc.killed || proc.pid === undefined) return;
  try {
    // Spawned detached → its own process group; the negative pid takes down any
    // children `opencode serve` spawned as a unit, so nothing is orphaned.
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export class OpencodeLifecycle {
  readonly #projectDir: string;
  readonly #host: string;
  readonly #idleMs: number;
  readonly #perCall: boolean;
  readonly #readyTimeoutMs: number;

  #handle: InternalHandle | undefined;
  // A spawned-but-not-yet-ready child. #handle is only assigned once readiness
  // passes, so during the startup window this is the ONLY reference to the child
  // — shutdown() must kill it here or the detached child outlives the process.
  #starting: InternalHandle | undefined;
  // Bumped by shutdown() to abandon the in-flight #start(); each start claims a
  // generation and aborts if it no longer matches. Scoped to one start, so a
  // later ensureServe() after shutdown claims a fresh generation and proceeds.
  #startGen = 0;
  #startPromise: Promise<InternalHandle> | undefined;
  #inFlight = 0;
  #idleTimer: NodeJS.Timeout | undefined;
  #backstopInstalled = false;
  #triggersAttached = false;

  constructor(opts: LifecycleOptions = {}) {
    this.#projectDir = opts.projectDir ?? process.env.GUILD_PROJECT_DIR ?? process.cwd();
    this.#host = opts.host ?? "127.0.0.1";
    this.#idleMs = opts.idleMs ?? envInt("GUILD_SERVE_IDLE_MS", DEFAULT_IDLE_MS);
    this.#perCall = opts.perCall ?? process.env.GUILD_SERVE_PER_CALL === "1";
    this.#readyTimeoutMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
  }

  // --- Observable state (for tests and diagnostics) -------------------------
  get isRunning(): boolean {
    return this.#handle !== undefined && !this.#handle.exited;
  }
  get pid(): number | undefined {
    return this.isRunning ? this.#handle!.pid : undefined;
  }
  /** Pid of a spawned-but-not-yet-ready child (startup window). Test/diagnostic. */
  get startingPid(): number | undefined {
    return this.#starting?.pid;
  }
  get port(): number | undefined {
    return this.isRunning ? this.#handle!.port : undefined;
  }
  get perCall(): boolean {
    return this.#perCall;
  }
  get idleMs(): number {
    return this.#idleMs;
  }

  /** Lazily spawn (or crash-revive) the serve child and return its live endpoint. */
  async ensureServe(): Promise<ServeHandle> {
    // Crash-revive: a handle whose child has exited (idle death, or an external
    // kill) is stale — drop it so the next line respawns.
    if (this.#handle && this.#handle.exited) {
      this.#handle = undefined;
    }
    if (this.#handle) return this.#public(this.#handle);
    if (!this.#startPromise) {
      // Identity-guard the cleanup: an aborted start's late finally must not clear
      // a newer start's promise (doing so would let a caller spawn a redundant
      // #start whose gen-bump aborts the newer one, hiding its live child).
      const p = this.#start().finally(() => {
        if (this.#startPromise === p) this.#startPromise = undefined;
      });
      this.#startPromise = p;
    }
    const h = await this.#startPromise;
    return this.#public(h);
  }

  /**
   * Run `fn` against a ready serve, tracking it as in-flight so the idle timer
   * never kills a serve mid-call. In per-call mode the serve is killed when `fn`
   * returns (or throws); otherwise the idle timer is (re)armed once idle.
   *
   * A serve that dies mid-call surfaces as `fn`'s own error — it is NOT swallowed
   * or retried here; only an idle death is revived (on the next call).
   */
  async withServe<T>(fn: (h: ServeHandle) => Promise<T>): Promise<T> {
    this.#clearIdleTimer();
    this.#inFlight += 1;
    try {
      const handle = await this.ensureServe();
      return await fn(handle);
    } finally {
      this.#inFlight -= 1;
      if (this.#inFlight === 0) {
        if (this.#perCall) {
          this.shutdown("per-call");
        } else {
          this.#armIdleTimer();
        }
      }
    }
  }

  /** Kill the serve child and clear all timers. Idempotent. */
  shutdown(_reason?: string): void {
    this.#clearIdleTimer();
    // Invalidate any in-flight #start() so it aborts at its next checkpoint
    // instead of assigning a handle nothing will kill.
    this.#startGen += 1;
    const h = this.#handle;
    const starting = this.#starting;
    this.#handle = undefined;
    this.#starting = undefined;
    this.#startPromise = undefined;
    // Close any live activity subscription against the dying child's port (issue #20).
    // Without this an idle-timeout kill leaves a `GET /event` fetch stream dangling on a
    // dead port, reconnecting forever. Guarded: the visibility layer must never be able
    // to break the teardown path the M1 orphan proof rests on.
    for (const url of [h?.baseUrl, starting?.baseUrl]) {
      if (url === undefined) continue;
      try {
        closeBusesFor(url);
      } catch {
        /* best-effort */
      }
    }
    killServe(h?.proc);
    // Kill the not-yet-ready child directly too: the startup poll may be mid-fetch
    // or mid-sleep for hundreds of ms, and teardown must be prompt (the abort check
    // then throws, but killing here is what makes the child die now, not orphan).
    killServe(starting?.proc);
  }

  /**
   * Wire the PRIMARY shutdown triggers: stdin end/close and the MCP transport's
   * onclose. These are what actually fire under Claude Code teardown. Signals and
   * process `exit` are installed here too, but only as a second layer.
   *
   * `exitProcess` (server use) exits the process after shutdown on a stdin/transport
   * trigger; tests pass a fake stdin with `exitProcess:false` to observe shutdown.
   */
  attachShutdownTriggers(
    sources: { stdin?: Readable; transport?: { onclose?: (() => void) | undefined } },
    opts: { exitProcess?: boolean } = {},
  ): void {
    // Idempotent: a second call must not stack another stdin 'end'/'close' listener
    // or re-wrap (and re-chain) transport.onclose, so calling this more than once is
    // a harmless no-op rather than a double-shutdown hazard.
    if (this.#triggersAttached) return;
    this.#installBackstop();
    const exitProcess = opts.exitProcess ?? false;

    const trigger = (reason: string) => {
      this.shutdown(reason);
      if (exitProcess) process.exit(0);
    };

    const { stdin, transport } = sources;
    if (stdin) {
      // `resume()` guarantees the stream reaches 'end' on EOF even if nothing else
      // is consuming it yet; the MCP transport's own 'data' listener also keeps it
      // flowing, and both listeners coexist.
      stdin.on("end", () => trigger("stdin-end"));
      stdin.on("close", () => trigger("stdin-close"));
      stdin.resume();
    }
    if (transport) {
      const prev = transport.onclose;
      transport.onclose = () => {
        try {
          prev?.();
        } finally {
          trigger("transport-close");
        }
      };
    }
    this.#triggersAttached = true;
  }

  get triggersAttached(): boolean {
    return this.#triggersAttached;
  }

  // --- internals ------------------------------------------------------------
  #public(h: InternalHandle): ServeHandle {
    return { baseUrl: h.baseUrl, port: h.port, pid: h.pid };
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }
  }

  #armIdleTimer(): void {
    this.#clearIdleTimer();
    if (this.#idleMs <= 0 || this.#perCall) return;
    this.#idleTimer = setTimeout(() => {
      if (this.#inFlight === 0) this.shutdown("idle");
    }, this.#idleMs);
    // Don't let a pending idle timer keep the process alive on its own.
    this.#idleTimer.unref();
  }

  /** Synchronous, second-layer backstop: kill the child on any process exit/signal. */
  #installBackstop(): void {
    if (this.#backstopInstalled) return;
    this.#backstopInstalled = true;

    process.on("exit", () => {
      killServe(this.#handle?.proc);
      killServe(this.#starting?.proc);
    });

    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    for (const sig of signals) {
      process.on(sig, () => {
        killServe(this.#handle?.proc);
        process.exit(sig === "SIGINT" ? 130 : sig === "SIGTERM" ? 143 : 129);
      });
    }
  }

  async #start(): Promise<InternalHandle> {
    this.#installBackstop();
    // Claim a generation; shutdown() bumps #startGen to abandon this start. Every
    // checkpoint below re-checks it so a shutdown() arriving anywhere in the
    // startup window leaves no live child behind.
    const myGen = ++this.#startGen;
    const aborted = () => this.#startGen !== myGen;
    const abortError = () => new Error("opencode serve shut down during startup");

    const port = await pickFreePort(this.#host);
    // Shut down after the port await but before we spawned anything — nothing to kill.
    if (aborted()) throw abortError();
    const baseUrl = `http://${this.#host}:${port}`;

    const proc = spawn(
      "opencode",
      ["serve", "--port", String(port), "--hostname", this.#host],
      {
        cwd: this.#projectDir,
        detached: true, // own process group → killable as a unit
        stdio: ["ignore", "ignore", "ignore"],
        env: { ...process.env },
      },
    );
    if (proc.pid === undefined) {
      throw new Error("failed to spawn `opencode serve` (no pid)");
    }

    const handle: InternalHandle = { proc, baseUrl, port, pid: proc.pid, exited: false };
    // Publish the child before the first await so a shutdown() racing the readiness
    // poll has a reference to kill (spawn→here is synchronous, so shutdown cannot
    // interleave and see a spawned-but-untracked child).
    this.#starting = handle;

    // Mark the handle exited so ensureServe() crash-revives on the next call, and
    // so isRunning reflects reality without an extra probe.
    proc.on("exit", () => {
      handle.exited = true;
      if (this.#handle === handle) this.#handle = undefined;
      if (this.#starting === handle) this.#starting = undefined;
    });

    try {
      // Poll GET /doc until the server answers or we time out (readiness contract).
      const deadline = Date.now() + this.#readyTimeoutMs;
      for (;;) {
        if (aborted()) {
          killServe(proc);
          throw abortError();
        }
        if (handle.exited) {
          throw new Error(`opencode serve exited before becoming ready (cwd=${this.#projectDir})`);
        }
        try {
          const res = await fetch(`${baseUrl}/doc`, { signal: AbortSignal.timeout(READY_HTTP_MS) });
          if (res.ok) break;
        } catch {
          /* not up yet */
        }
        if (aborted()) {
          killServe(proc);
          throw abortError();
        }
        if (Date.now() > deadline) {
          killServe(proc);
          throw new Error(`opencode serve did not become ready within ${this.#readyTimeoutMs}ms`);
        }
        await new Promise((r) => setTimeout(r, READY_POLL_MS));
      }

      // Ready — but a shutdown() may have landed during the final poll sleep.
      if (aborted()) {
        killServe(proc);
        throw abortError();
      }
      // Guard against publishing a dead child: if it exited between the last check
      // and now, /doc may have been answered by an unrelated process that rebound
      // the freed port, so treat readiness as invalid.
      if (handle.exited) {
        throw new Error(`opencode serve exited before becoming ready (cwd=${this.#projectDir})`);
      }
      this.#handle = handle;
      return handle;
    } finally {
      if (this.#starting === handle) this.#starting = undefined;
    }
  }
}
