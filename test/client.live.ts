/**
 * M2 live smoke (NOT part of `npm test` — run via `npm run test:live`).
 *
 * Drives the REAL stack: the M1 lifecycle spawns `opencode serve` in a disposable
 * scratch project that carries only a copy of the read-only `guild-read` def and a
 * planted marker file, then `askViaAgent` consults a FREE model and we assert the
 * marker round-trips through the byte-exact history path and that no `opencode
 * serve` process is left behind.
 *
 * Hygiene (repo rule): free model only, every call timeout-bounded, benign canary
 * naming, disposable scratch dir, no repo payload touched.
 */

import { mkdtemp, mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { OpencodeLifecycle } from "../src/lifecycle.js";
import { askViaAgent } from "../src/client.js";
import { Checker, repoRoot, withTimeout, waitFor, pidAlive } from "./harness.js";

const FREE_MODEL = "opencode/deepseek-v4-flash-free";
const ASK_MS = 120_000;
// Benign canary (per AGENTS.md: a benign token so the model actually invokes the
// tool, rather than refusing on the "looks like a secret" framing and testing manners).
const MARKER = "PLATYPUS-ORBIT-7731";

async function main(): Promise<number> {
  const c = new Checker();
  console.log("== client.live ==");

  const scratch = await mkdtemp(path.join(tmpdir(), "guild-m2-live-"));
  const lc = new OpencodeLifecycle({ projectDir: scratch, idleMs: 0 });
  let servePid: number | undefined;

  try {
    // Scratch project: the read-only def + one benign marker file.
    await mkdir(path.join(scratch, ".opencode", "agent"), { recursive: true });
    await copyFile(
      path.join(repoRoot, ".opencode", "agent", "guild-read.md"),
      path.join(scratch, ".opencode", "agent", "guild-read.md"),
    );
    await writeFile(
      path.join(scratch, "marker.txt"),
      `The marker code is ${MARKER}. Report it exactly.\n`,
      "utf8",
    );

    const result = await withTimeout(
      askViaAgent(lc, {
        agent: "guild-read",
        model: FREE_MODEL,
        prompt:
          "Read the file marker.txt in the current directory and reply with the exact marker code it contains.",
      }),
      ASK_MS,
      "askViaAgent(live)",
    );

    servePid = lc.pid; // still warm (idleMs:0) until we shut down below

    console.log(`  model text: ${JSON.stringify(result.text).slice(0, 200)}`);
    c.check(result.text.includes(MARKER), `marker round-tripped through history (${MARKER})`);
    c.check(typeof result.sessionId === "string" && result.sessionId.length > 0, "a session id was returned");
    c.check(
      result.toolParts.some((t) => t.tool === "read"),
      "history shows the model used the read tool",
    );
    c.check(result.text.length > 0, "final text is non-empty");
  } finally {
    lc.shutdown("live-smoke-done");
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }

  // Zero leftover processes.
  if (servePid !== undefined) {
    const gone = await waitFor(() => !pidAlive(servePid!), 10_000);
    c.check(gone, `serve pid ${servePid} is dead after shutdown`);
  }
  // Belt-and-braces: the OS-level check the task names.
  let leftover = "";
  try {
    leftover = execSync("ps -o comm= -C opencode 2>/dev/null || true").toString().trim();
  } catch {
    /* no matches → non-zero exit is fine */
  }
  c.check(leftover === "", `no opencode process remains (ps -C opencode: ${JSON.stringify(leftover)})`);

  console.log(`client.live: ${c.passes} passed, ${c.failures} failed`);
  return c.failures;
}

main().then((f) => {
  if (f > 0) console.error(`FAILED: ${f} live check(s) failed.`);
  else console.log("Live smoke passed.");
  process.exit(f > 0 ? 1 : 0);
});
