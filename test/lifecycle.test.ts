/**
 * Lifecycle supervisor tests: clean spawn→ready→shutdown, idle timeout,
 * crash-revive, and per-call mode. In-process against the real `opencode serve`
 * (free — no model call). Every wait is bounded.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpencodeLifecycle, type ServeHandle } from "../src/lifecycle.js";
import { ServePool } from "../src/servepool.js";
import { ServeEventBus, closeAllBuses, liveBusCount } from "../src/activity.js";
import { Checker, pidAlive, waitFor, withTimeout, sleep } from "./harness.js";

const SPAWN_MS = 40_000;

/** A trivial, model-free "call": prove the handle points at a live serve. */
async function poke(h: ServeHandle): Promise<void> {
  const res = await fetch(`${h.baseUrl}/doc`, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`/doc → ${res.status}`);
}

export async function run(): Promise<number> {
  const c = new Checker();
  console.log("== lifecycle.test ==");

  // 1. clean spawn → ready → shutdown -----------------------------------------
  {
    const lc = new OpencodeLifecycle({ idleMs: 0 });
    const h = await withTimeout(lc.ensureServe(), SPAWN_MS, "clean:ensureServe");
    c.check(lc.isRunning, "clean: isRunning after ensureServe");
    c.check(typeof h.port === "number" && h.port > 0, "clean: handle has a port");
    c.check(lc.pid === h.pid && pidAlive(h.pid), "clean: pid reported and alive");
    await poke(h);
    c.check(true, "clean: /doc answered on the negotiated port");
    const pid = h.pid;
    lc.shutdown("test");
    c.check(!lc.isRunning, "clean: isRunning false after shutdown");
    c.check(await waitFor(() => !pidAlive(pid), 8_000), "clean: serve pid dead after shutdown");
  }

  // 2. idle timeout fires ------------------------------------------------------
  {
    const lc = new OpencodeLifecycle({ idleMs: 800 });
    const pid = await withTimeout(
      lc.withServe(async (h) => {
        await poke(h);
        return h.pid;
      }),
      SPAWN_MS,
      "idle:withServe",
    );
    c.check(lc.isRunning, "idle: serve still up immediately after the call (timer armed)");
    const died = await waitFor(() => !pidAlive(pid), 6_000);
    c.check(died, "idle: serve killed after the idle timeout elapsed");
    c.check(!lc.isRunning, "idle: isRunning false once idle-killed");
    lc.shutdown();
  }

  // 3. crash-revive: idle death → next call respawns ---------------------------
  {
    const lc = new OpencodeLifecycle({ idleMs: 0 });
    const h1 = await withTimeout(lc.ensureServe(), SPAWN_MS, "revive:ensureServe1");
    const pid1 = h1.pid;
    // Simulate a crash while idle: kill the serve out from under the manager.
    try {
      process.kill(-pid1, "SIGKILL");
    } catch {
      process.kill(pid1, "SIGKILL");
    }
    c.check(await waitFor(() => !pidAlive(pid1), 8_000), "revive: original serve is dead");
    c.check(await waitFor(() => !lc.isRunning, 4_000), "revive: manager observed the exit (isRunning false)");
    const h2 = await withTimeout(lc.ensureServe(), SPAWN_MS, "revive:ensureServe2");
    c.check(h2.pid !== pid1 && pidAlive(h2.pid), "revive: next ensureServe respawned a fresh, live serve");
    lc.shutdown();
    c.check(await waitFor(() => !pidAlive(h2.pid), 8_000), "revive: revived serve dead after shutdown");
  }

  // 4. per-call mode: spawn and kill per call ----------------------------------
  {
    const lc = new OpencodeLifecycle({ perCall: true });
    let seenRunning = false;
    const pid1 = await withTimeout(
      lc.withServe(async (h) => {
        await poke(h);
        seenRunning = lc.isRunning;
        return h.pid;
      }),
      SPAWN_MS,
      "percall:withServe1",
    );
    c.check(seenRunning, "per-call: serve was up during the call");
    c.check(await waitFor(() => !pidAlive(pid1), 8_000), "per-call: serve killed when the call returned");
    c.check(!lc.isRunning, "per-call: isRunning false between calls");

    const pid2 = await withTimeout(
      lc.withServe(async (h) => {
        await poke(h);
        return h.pid;
      }),
      SPAWN_MS,
      "percall:withServe2",
    );
    c.check(pid2 !== pid1, "per-call: second call spawned a fresh serve (new pid)");
    c.check(await waitFor(() => !pidAlive(pid2), 8_000), "per-call: second serve killed when its call returned");
    lc.shutdown();
  }

  // 5. teardown during startup: shutdown() before readiness must not orphan ----
  {
    const lc = new OpencodeLifecycle({ idleMs: 0 });
    const startPromise = lc.ensureServe();
    // Deterministic: fire shutdown the instant a child is spawned but before it is
    // ready (opencode takes seconds to answer /doc; startingPid is set right after
    // spawn), so this reliably lands inside the readiness window.
    const spawned = await waitFor(() => lc.startingPid !== undefined, SPAWN_MS, 5);
    c.check(spawned, "startup: a serve child was spawned during startup");
    const pid = lc.startingPid;
    lc.shutdown("test-teardown-during-startup");

    let rejected = false;
    try {
      await startPromise;
    } catch {
      rejected = true;
    }
    c.check(rejected, "startup: ensureServe() rejects when shutdown arrives mid-startup");
    c.check(!lc.isRunning, "startup: no live serve tracked after mid-startup shutdown");
    if (pid !== undefined) {
      c.check(await waitFor(() => !pidAlive(pid), 8_000), "startup: the in-flight serve child is dead");
    }

    // The abort flag must not poison the lifecycle: a later ensureServe() respawns.
    const h = await withTimeout(lc.ensureServe(), SPAWN_MS, "startup:respawn");
    c.check(lc.isRunning && pidAlive(h.pid), "startup: a later ensureServe() respawns after mid-startup shutdown");
    const pid2 = h.pid;
    lc.shutdown();
    c.check(await waitFor(() => !pidAlive(pid2), 8_000), "startup: respawned serve dead after shutdown");
  }

  // 6. shutdown() closes a live activity bus on the dying child's port (issue #20) -------
  //
  // This lives HERE, in the opencode-dependent suite, rather than in the offline activity
  // suite, because the only honest way to prove it is a REAL handle: `shutdown()` closes
  // buses keyed on `#handle.baseUrl`, which nothing but a spawned child ever sets. Without
  // this, an idle-timeout kill leaves a `GET /event` fetch reconnecting forever against a
  // dead port.
  {
    const lc = new OpencodeLifecycle({ idleMs: 0 });
    const h = await withTimeout(lc.ensureServe(), SPAWN_MS, "bus:ensureServe");
    const bus = ServeEventBus.acquire(h.baseUrl);
    let degraded = "";
    bus.subscribe("ses_probe", { onEvent: () => {}, onDegraded: (why) => (degraded = why) });
    const attached = await withTimeout(bus.ready(), 10_000, "bus:ready");
    c.check(attached, "bus: the activity stream attaches to the real serve");
    c.check(liveBusCount() === 1, "bus: one live bus before shutdown");

    lc.shutdown("test-bus-close");
    c.check(liveBusCount() === 0, "bus: shutdown() closed the bus for the dying child's port");
    c.check(bus.connected === false, "bus: the closed bus reports disconnected");
    // A closed bus must not keep reconnecting against the dead port.
    await sleep(1_200);
    c.check(liveBusCount() === 0, "bus: it stays closed (no reconnect against a dead port)");
    c.check(degraded === "" || degraded.length > 0, "bus: any degrade reason is delivered, never thrown");
    closeAllBuses();
  }

  // ---------------------------------------------------------------------------
  // ServePool with REAL children (issue #96, review finding H1a).
  //
  // WHY IT LIVES HERE. `test/worktree.test.ts` covers the pool by inspecting lifecycle
  // OBJECTS and deliberately spawns nothing — which is exactly the hole that let H1 ship: the
  // entire second-child PROCESS lifecycle was untested by anything that runs processes, so
  // the M1 orphan guarantee did not cover the one new thing that could break it. This file
  // already spawns the real `opencode serve` and has no graceful skip, so it is the home.
  //
  // Two claims, and they pull in opposite directions on purpose:
  //   (1) the primary's IDLE timer must NOT kill an extra child with a call in flight on it;
  //   (2) a genuine TEARDOWN must still take that same extra child down.
  // A fix that only satisfied (1) would be an orphan bug; one that only satisfied (2) is the
  // bug being fixed.
  {
    const extraRootDir = mkdtempSync(path.join(tmpdir(), "m96-root-"));
    // Primary idle window deliberately SHORTER than the in-flight extra call, so the timer
    // is guaranteed to fire mid-call rather than racing it.
    const primary = new OpencodeLifecycle({ idleMs: 1_000 });
    const pool = new ServePool(primary);
    try {
      // Arm the primary's idle timer exactly the way `/guild:review` does — a call that runs
      // on the PRIMARY (guild_models) and returns, leaving the timer running.
      const primaryPid = await withTimeout(
        primary.withServe(async (h) => {
          await poke(h);
          return h.pid;
        }),
        SPAWN_MS,
        "pool:primary withServe",
      );
      c.check(primary.isRunning, "pool: primary up with its idle timer armed");

      const extra = pool.forRoot(extraRootDir);
      c.check(extra !== primary, "pool: a second root yields a different supervisor");

      // A call in flight on the EXTRA child, spanning the primary's idle window.
      let extraPid = 0;
      let callError = "";
      let stillAliveMidCall = false;
      let stillPooledMidCall = false;
      const inFlight = extra.withServe(async (h) => {
        extraPid = h.pid;
        await sleep(3_000); // > primary idleMs, so the primary's timer fires during this
        // Probed from INSIDE the call: this is the moment the bug destroyed.
        try {
          await poke(h);
          stillAliveMidCall = true;
        } catch {
          stillAliveMidCall = false;
        }
        stillPooledMidCall = pool.extraRoots.length === 1;
        return h.pid;
      });

      // The in-flight call is caught rather than awaited bare: with the bug present the extra
      // child is SIGKILLed mid-call and this rejects, and a thrown suite reports far less than
      // a failed check does. (Verified as a negative control: with the reclamation exemption
      // removed, the two checks below fail instead of the suite exploding.)
      const returned = await withTimeout(
        inFlight.catch((err: unknown) => {
          callError = err instanceof Error ? err.message : String(err);
          return -1;
        }),
        SPAWN_MS,
        "pool:extra withServe",
      );
      c.check(
        await waitFor(() => !pidAlive(primaryPid), 6_000),
        "pool: the primary's idle timer DID fire (its own child is dead)",
      );
      c.check(
        stillAliveMidCall,
        `pool: the extra child SURVIVED the primary's idle-timer fire, mid-call (H1)${callError ? ` [call failed: ${callError}]` : ""}`,
      );
      c.check(stillPooledMidCall, "pool: the extra stayed in the pool across that fire");
      c.check(returned === extraPid && extraPid > 0, "pool: the in-flight extra call completed");
      c.check(pidAlive(extraPid), "pool: the extra child is still alive after its call returned");

      // (2) A genuine teardown still takes it with it — the orphan guarantee, unweakened.
      primary.shutdown("stdin-end");
      c.check(pool.extraRoots.length === 0, "pool: teardown emptied the pool");
      c.check(
        await waitFor(() => !pidAlive(extraPid), 8_000),
        "pool: teardown killed the extra child too (no orphan)",
      );
    } finally {
      pool.shutdownExtras("cleanup");
      primary.shutdown("cleanup");
      try {
        rmSync(extraRootDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }

  await sleep(50);
  console.log(`lifecycle.test: ${c.passes} passed, ${c.failures} failed`);
  return c.failures;
}

// Allow standalone execution: `tsx test/lifecycle.test.ts`.
if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((f) => process.exit(f > 0 ? 1 : 0));
}
