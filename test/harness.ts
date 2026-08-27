/**
 * Shared test helpers.
 *
 * Plain-script style like the spike — no test-framework dependency. Every test is
 * offline: spawning `opencode serve` is free and allowed, but NO model is called.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServeHandle } from "../src/lifecycle.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(__dirname, "..");
export const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
export const serverEntry = path.join(repoRoot, "src", "server.ts");

/**
 * A `ServeHandle` for a test fake, with a DISTINCT `instanceId` every time (issue #111).
 *
 * The counter matters, and hand-written literals are what it replaces: `instanceId` is a
 * child IDENTITY, so a fixture that hard-coded one value would make two different fakes look
 * like the same child to anything keyed on it — and the cache this field exists for would
 * then be tested against a fixture that cannot exhibit the bug. Minting per handle means a
 * fake behaves like what it stands in for: a distinct child. To model a REUSED port (a dead
 * child's URL taken by a new one) start a second fake on the same port and take a second
 * handle — different id, same URL, which is exactly the shape that bites.
 */
let nextFakeInstanceId = 1;
export function fakeServeHandle(baseUrl: string, pid = 0): ServeHandle {
  return { baseUrl, port: 0, pid, instanceId: nextFakeInstanceId++ };
}

/**
 * Thrown by `runBounded` when `tsxBin` does not exist (issue #200) — i.e. the harness
 * itself is broken, not the thing under test. Distinct from a red assertion on purpose:
 * a worktree with no `node_modules` used to make every FIFO/symlink case in
 * `test/config.test.ts` fail as `value: undefined`, indistinguishable from the probe
 * having run and gotten the wrong answer. A thrown, named error can't be mistaken for
 * that — it names the missing path and the fix (`npm ci` in this checkout) instead of
 * four misleading FAILs.
 */
export class MissingTestHarnessError extends Error {
  constructor(missingTsxBin: string) {
    super(`test harness broken: ${missingTsxBin} does not exist — run 'npm ci' in this checkout to fix it`);
    this.name = "MissingTestHarnessError";
  }
}

/** The result of `runBounded`: `timedOut` is the assertion that matters most. */
export interface BoundedRun {
  /** True when the child had to be killed — i.e. it BLOCKED. */
  timedOut: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run a `.ts` entry point in a CHILD PROCESS under a hard wall-clock bound (issues #162/#163).
 *
 * WHY A CHILD PROCESS, and it is the whole point of this helper: the defect under test is a
 * BLOCKING synchronous fs call — `readFileSync`/`writeFileSync` on a FIFO with no peer. A
 * block is not an exception and not a pending promise, so nothing inside the test process can
 * interrupt it: no `try/catch`, no `Promise.race`, no timer (the event loop never gets a turn).
 * An in-process assertion would therefore not FAIL on a regression, it would HANG — and a suite
 * that hangs gives CI a timeout with no signal, which is worse than having no test at all.
 * Handing the work to a separate process makes the OS the arbiter: a regression is a killed
 * child and a red line, in bounded time.
 *
 * `SIGKILL`, not the default `SIGTERM`: a process parked in a blocking `open(2)` should not be
 * relied on to run a JS signal handler before it dies.
 *
 * Spawned as `node <tsx> <entry>` rather than through the `tsx` bin shim, so the child does not
 * need `node` on its PATH — which lets a caller shadow PATH completely (as `doctor.test.ts`
 * does) without breaking the spawn itself.
 *
 * Checks `tsxBin` exists before spawning (issue #200) and throws `MissingTestHarnessError`
 * if not: a worktree with no `node_modules` has no `tsx` binary, so the spawn used to fail
 * with `Cannot find module` and get reported as an ordinary `status !== 0` — indistinguishable
 * from the FIFO/symlink guard itself misbehaving. Every OTHER failure cause (blocked, crashed,
 * wrong answer) still falls through to the plain `value`/`status` fields below, fail-toward-red
 * as before — this check narrows only the one cause that means "the harness can't run at all".
 */
export function runBounded(
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number } = {},
): BoundedRun {
  if (!existsSync(tsxBin)) throw new MissingTestHarnessError(tsxBin);
  const r = spawnSync(process.execPath, [tsxBin, ...args], {
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 30_000,
    killSignal: "SIGKILL",
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });
  const err = r.error as NodeJS.ErrnoException | undefined;
  return {
    timedOut: err?.code === "ETIMEDOUT" || r.signal === "SIGKILL",
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

/** `runBoundedProbe`'s result: `value` is `undefined` whenever the probe did not report. */
export interface BoundedProbe<T> extends BoundedRun {
  value: T | undefined;
}

/**
 * Evaluate a snippet of TypeScript against `src/` in a bounded CHILD PROCESS and bring its
 * answer back as JSON (issues #162/#163).
 *
 * `runBounded` bounds a whole CLI invocation; this bounds a LIBRARY-LEVEL assertion, which is
 * what the config- and policy-layer cases need — they are about `resolveConfFile`,
 * `readLayeredConfContents`, `resolvePolicyLayers` and friends, not about `doctor`'s output.
 *
 * WHY THEY CANNOT SIMPLY RUN IN-PROCESS, stated because I got this wrong once and the wrong
 * reasoning was written into the file: **the bite-check is a PRE-fix question.** Post-fix these
 * predicates never open the FIFO, so an in-process call returns instantly — which is exactly
 * what makes an in-process test worthless. Pre-fix the code DOES open it and DOES block, so on
 * a regression the assertion cannot go red: it wedges the suite, and CI reports a timeout with
 * no signal. A test is only a test in the state where the bug is present. Every FIFO assertion
 * therefore runs where the OS can kill it.
 *
 * The snippet is written to a temp file and imports `src/` by ABSOLUTE specifier, so it does
 * not depend on where the temp file landed. It must `console.log` exactly one JSON value; the
 * last non-empty stdout line is parsed. A probe that blocked, crashed, or printed nothing
 * yields `value: undefined`, so a caller that forgets to check `timedOut` still fails rather
 * than silently passing on absent data.
 */
export function runBoundedProbe<T = unknown>(
  source: string,
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): BoundedProbe<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mg-probe-"));
  const file = path.join(dir, "probe.ts");
  writeFileSync(file, source);
  const run = runBounded([file], opts);
  const lines = run.stdout.split("\n").filter((l) => l.trim().length > 0);
  let value: T | undefined;
  try {
    value = lines.length > 0 ? (JSON.parse(lines[lines.length - 1]) as T) : undefined;
  } catch {
    value = undefined;
  }
  return { ...run, value };
}

/** Absolute import specifier for a `src/` module, for use inside a `runBoundedProbe` snippet. */
export function srcSpecifier(rel: string): string {
  return JSON.stringify(path.join(repoRoot, "src", rel));
}

/** A single test file's pass/fail accounting. */
export class Checker {
  failures = 0;
  passes = 0;
  check(condition: boolean, message: string): void {
    if (condition) {
      this.passes += 1;
      console.log(`  PASS: ${message}`);
    } else {
      this.failures += 1;
      console.error(`  FAIL: ${message}`);
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** True if a pid exists (EPERM counts as "exists but not ours"). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Poll until `fn()` is true or the deadline passes. Returns the final value. */
export async function waitFor(
  fn: () => boolean,
  timeoutMs: number,
  pollMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return true;
    if (Date.now() >= deadline) return fn();
    await sleep(pollMs);
  }
}

/**
 * Environment for a git invocation made by a test FIXTURE (issue #98).
 *
 * Two things are forced, for one reason: a fixture's repo is nobody's repo, so the
 * developer's git config must not be able to change what the suite does.
 *
 *   - **Identity** (`GIT_{AUTHOR,COMMITTER}_{NAME,EMAIL}`) — a box with no `user.email`
 *     configured would otherwise fail `git commit` outright.
 *   - **Signing** (`commit.gpgsign` / `tag.gpgsign` = `false`) — with `commit.gpgsign=true`
 *     and `gpg.format=ssh`, the configuration this dev container ships, `git commit` invokes
 *     an ssh signer that can block indefinitely, and `npm test` **HANGS SILENTLY** with no
 *     output rather than failing. It cost two people 20+ minutes each before it was
 *     diagnosed. A fixture's commit is not a commit anyone signs, so it has no business
 *     consulting the user's signing config at all.
 *
 * **The hang is STATE-DEPENDENT, which is why it went undiagnosed twice** (measured
 * 2026-07-29, correcting the mechanism given in issue #98). The signing key here reaches a
 * **forwarded** ssh-agent, so the sign request leaves the container and the *host* decides
 * it — and a host that asks for confirmation blocks a test process that can never answer.
 * Once the agent has that confirmation cached the very same commit returns in ~300ms, so
 * the bug appears to come and go: a run that passes proves nothing about the next one. With
 * no agent reachable at all it does not hang, it fails fast (exit 128) — and `initRepo`
 * discarded that status, so the fixture then produced a repo with **no HEAD** and the suite
 * silently ran against an unborn branch. Both halves are closed: signing never engages, and
 * `initRepo` now throws on a failed commit.
 *
 * `gpg.format` is deliberately NOT overridden: with signing off the format is never
 * consulted (verified — a commit under these two keys completes on a `gpg.format=ssh` box),
 * so pinning it would assert something about the developer's setup that buys nothing.
 * `tag.gpgsign` IS set although nothing here tags today — one extra entry, and the next
 * fixture that tags is immune for free.
 *
 * **ENV FORM, NOT `-c` ON THE ARGV — deliberate.** `-c` covers only the call sites someone
 * remembered to edit, so the next `git commit` added to a test reintroduces the hang; this
 * covers every git run with this env, INCLUDING a git spawned by a child process, and it
 * writes to no config file on disk (the developer's real config is never touched).
 *
 * **`GIT_CONFIG_COUNT` is APPENDED TO, never clobbered.** The documented workaround for #98
 * is itself `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign …`, so a run that still uses
 * it must keep its entry rather than have index 0 silently overwritten. Ours are added after
 * the inherited ones, and a later entry wins for the same key (verified), so signing is off
 * even if an inherited entry turned it on. An inherited count that is not a plain
 * non-negative integer is ignored and ours start at 0 — git fatals on such a value anyway,
 * so there is no valid caller state to preserve.
 */
export function fixtureGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  const inherited = base.GIT_CONFIG_COUNT ?? "";
  const parsed = /^[0-9]+$/.test(inherited) ? Number(inherited) : 0;
  const start = Number.isSafeInteger(parsed) ? parsed : 0;
  const entries: Array<[string, string]> = [
    ["commit.gpgsign", "false"],
    ["tag.gpgsign", "false"],
  ];
  entries.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${start + i}`] = key;
    env[`GIT_CONFIG_VALUE_${start + i}`] = value;
  });
  env.GIT_CONFIG_COUNT = String(start + entries.length);
  return env;
}

/** Reject if `p` doesn't settle within `ms` — keeps a stuck spawn from hanging CI. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
