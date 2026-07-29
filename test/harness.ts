/**
 * Shared test helpers.
 *
 * Plain-script style like the spike — no test-framework dependency. Every test is
 * offline: spawning `opencode serve` is free and allowed, but NO model is called.
 */

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
