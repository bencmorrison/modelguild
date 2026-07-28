/**
 * Serve-child stderr capture (issue #75).
 *
 * The lifecycle used to spawn `opencode serve` with all three stdio ignored, so a child
 * that failed to start surfaced only as a generic readiness timeout while its actual
 * error text went to /dev/null. These checks pin the fix.
 *
 * OFFLINE by construction: every case runs against a FAKE `opencode` placed first on
 * PATH — a shell script that spews to stderr, hangs, exits, or (the happy path) answers
 * `GET /doc` from a real node HTTP server. No opencode binary, no model, no network.
 * PATH is the injection point deliberately: it exercises the real `spawn("opencode", …)`
 * call rather than a test-only command knob the production path would never take.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpencodeLifecycle } from "../src/lifecycle.js";
import { Checker, pidAlive, waitFor, withTimeout, sleep } from "./harness.js";

/** Write a fake `opencode` (bash) into a fresh temp dir and return the dir. */
function makeShim(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mg-serve-stderr-"));
  fs.writeFileSync(path.join(dir, "opencode"), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return dir;
}

/** Run `fn` with `dir` prepended to PATH, restoring PATH afterwards. */
async function withPath<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${prev ?? ""}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = prev;
  }
}

/** Drive one ensureServe() to failure and return the error message. */
async function failureMessage(shimBody: string, readyTimeoutMs = 8_000): Promise<string> {
  const dir = makeShim(shimBody);
  return withPath(dir, async () => {
    const lc = new OpencodeLifecycle({ idleMs: 0, projectDir: dir, readyTimeoutMs });
    try {
      await withTimeout(lc.ensureServe(), readyTimeoutMs + 10_000, "ensureServe");
      return "<<no error: ensureServe resolved>>";
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    } finally {
      lc.shutdown("test");
    }
  });
}

export async function run(): Promise<number> {
  const c = new Checker();
  console.log("== serve-stderr.test ==");

  // 1. a child that dies during startup carries its stderr into the error ------------
  {
    const msg = await failureMessage(
      'printf "ERROR: port already in use (marker-alpha)\\n" >&2\nexit 3',
    );
    c.check(
      msg.includes("exited before becoming ready"),
      "early exit: the failure is still reported as exited-before-ready",
    );
    c.check(msg.includes("marker-alpha"), "early exit: the child's stderr reaches the error message");
    c.check(msg.includes("exit code 3"), "early exit: the child's exit code is named");
    c.check(msg.includes("opencode serve stderr"), "early exit: the tail is fenced and labelled");
  }

  // 2. a child that never becomes ready: the readiness timeout carries stderr too ----
  //    (the child is still ALIVE here — the tail must be read without waiting on a pipe
  //    that will never close, and the child must still be killed.)
  {
    const dir = makeShim('printf "still starting (marker-beta)\\n" >&2\nsleep 60');
    const killed = await withPath(dir, async () => {
      const lc = new OpencodeLifecycle({ idleMs: 0, projectDir: dir, readyTimeoutMs: 1_500 });
      let msg = "";
      const t0 = Date.now();
      try {
        await withTimeout(lc.ensureServe(), 20_000, "hang:ensureServe");
      } catch (err) {
        msg = err instanceof Error ? err.message : String(err);
      }
      const elapsed = Date.now() - t0;
      const pid = lc.startingPid;
      c.check(msg.includes("did not become ready"), "hang: reported as a readiness timeout");
      c.check(msg.includes("marker-beta"), "hang: the readiness timeout carries the stderr tail");
      c.check(elapsed < 6_000, `hang: the timeout path does not wait on a live child's pipe (${elapsed}ms)`);
      lc.shutdown("test");
      return pid === undefined || (await waitFor(() => !pidAlive(pid), 5_000));
    });
    c.check(killed, "hang: the child is killed on the readiness-timeout path");
  }

  // 3. the ring is BOUNDED, and it keeps the NEWEST bytes ----------------------------
  {
    const msg = await failureMessage(
      'printf "marker-oldest\\n" >&2\n' +
        'for i in $(seq 1 400); do printf "filler line %s aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n" "$i" >&2; done\n' +
        'printf "marker-newest\\n" >&2\nexit 1',
    );
    c.check(msg.includes("marker-newest"), "ring: the newest stderr survives");
    c.check(!msg.includes("marker-oldest"), "ring: the oldest stderr is dropped (bounded, not unbounded)");
    c.check(msg.length < 4_000, `ring: the error message stays bounded (${msg.length} chars)`);
  }

  // 4. control characters are sanitized (this text is rendered to a human) -----------
  {
    const msg = await failureMessage(
      'printf "\\033[91m\\033[1mcoloured failure (marker-gamma)\\033[0m\\r\\n" >&2\n' +
        'printf "bell\\007 and \\177 del\\n" >&2\nexit 1',
    );
    c.check(msg.includes("marker-gamma"), "sanitize: the text itself survives");
    c.check(!/\u001b/.test(msg), "sanitize: no raw ESC / ANSI sequences in the message");
    c.check(
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(msg),
      "sanitize: no raw control characters",
    );
    c.check(msg.includes("\n"), "sanitize: line breaks are PRESERVED (a stack trace stays readable)");
  }

  // 5. an empty stderr says so rather than pretending to have captured something -----
  {
    const msg = await failureMessage("exit 7");
    c.check(msg.includes("no stderr captured"), "silent child: the absence of output is stated");
    c.check(msg.includes("exit code 7"), "silent child: the exit code is still named");
  }

  // 6. a spawn failure (no binary at all) rejects — it does NOT crash the process ----
  //    Before the fix the ChildProcess 'error' event had no listener, so an ENOENT was
  //    re-thrown as an uncaught exception: in production that takes the MCP server down.
  //    This suite reaching check 7 IS the proof it no longer does.
  {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "mg-serve-nopath-"));
    const prev = process.env.PATH;
    process.env.PATH = empty; // no `opencode` anywhere on it
    let msg = "";
    try {
      const lc = new OpencodeLifecycle({ idleMs: 0, projectDir: empty, readyTimeoutMs: 4_000 });
      try {
        await withTimeout(lc.ensureServe(), 15_000, "enoent:ensureServe");
      } catch (err) {
        msg = err instanceof Error ? err.message : String(err);
      }
      lc.shutdown("test");
    } finally {
      process.env.PATH = prev;
    }
    c.check(msg.length > 0, "spawn failure: ensureServe rejects");
    c.check(
      msg.includes("failed to spawn") || msg.includes("ENOENT"),
      `spawn failure: the message names the spawn error (got: ${msg.split("\n")[0]})`,
    );
    // Give any stray async 'error' emission a tick to blow up if it were unhandled.
    await sleep(100);
    c.check(true, "spawn failure: the process survived the failed spawn (no uncaught 'error')");
  }

  // 7. the HAPPY path is unperturbed: a serve that comes up still comes up ------------
  //    Capturing stderr must not change readiness, and a child writing to a piped stderr
  //    must not wedge on back-pressure.
  {
    const dir = makeShim(
      'printf "fake serve: starting (noise)\\n" >&2\n' +
        'port=""\n' +
        'while [ "$#" -gt 0 ]; do case "$1" in --port) port="$2"; shift 2;; *) shift;; esac; done\n' +
        '(while true; do printf "fake serve: heartbeat noise\\n" >&2; sleep 0.05; done) &\n' +
        'exec node -e ' +
        "'require(\"http\").createServer((q,s)=>{s.writeHead(200,{\"content-type\":\"application/json\"});s.end(\"{}\")}).listen(Number(process.argv[1]),\"127.0.0.1\")'" +
        ' "$port"',
    );
    await withPath(dir, async () => {
      const lc = new OpencodeLifecycle({ idleMs: 0, projectDir: dir, readyTimeoutMs: 15_000 });
      const h = await withTimeout(lc.ensureServe(), 25_000, "happy:ensureServe");
      c.check(lc.isRunning && pidAlive(h.pid), "happy: a serve that answers /doc still becomes ready");
      // Let the heartbeat spew for a while: a drained pipe means the child keeps running.
      await sleep(600);
      c.check(lc.isRunning && pidAlive(h.pid), "happy: the child keeps running while writing to the piped stderr");
      const res = await fetch(`${h.baseUrl}/doc`, { signal: AbortSignal.timeout(5_000) });
      c.check(res.ok, "happy: the handle points at the live fake serve");
      lc.shutdown("test");
      c.check(await waitFor(() => !pidAlive(h.pid), 8_000), "happy: the child dies on shutdown (teardown unchanged)");
    });
  }

  console.log(`serve-stderr.test: ${c.passes} passed, ${c.failures} failed`);
  return c.failures;
}

// Allow standalone execution: `tsx test/serve-stderr.test.ts`.
if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((f) => process.exit(f > 0 ? 1 : 0));
}
