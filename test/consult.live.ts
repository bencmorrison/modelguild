/**
 * M5 live smoke (NOT part of `npm test` — run via `npm run test:live`).
 *
 * Drives the REAL production path: `consult()` composes the M1 lifecycle (`opencode
 * serve`), the model policy (default-allow, so a free model passes), the evidence layer,
 * and the typed client, against the UNMODIFIED read-only `guild-read` agent in a
 * disposable scratch project carrying a planted marker file. We assert the marker
 * round-trips byte-exact through the tool result, the tool-produced run verifies under
 * the TS verifier, and no `opencode serve` survives.
 *
 * Hygiene (repo rule): free model only, timeout-bounded, benign canary, disposable dir.
 */

import { mkdtemp, mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { OpencodeLifecycle } from "../src/lifecycle.js";
import { consult, consultToToolResult } from "../src/consult.js";
import { EvidenceLog } from "../src/log.js";
import { Checker, repoRoot, withTimeout, waitFor, pidAlive } from "./harness.js";

const FREE_MODEL = "opencode/deepseek-v4-flash-free";
const ASK_MS = 120_000;
const MARKER = "PLATYPUS-ORBIT-7731";

async function main(): Promise<number> {
  const c = new Checker();
  console.log("== consult.live (M5) ==");

  const scratch = await mkdtemp(path.join(tmpdir(), "guild-m5-live-"));
  const logDir = path.join(scratch, "logs");
  const lc = new OpencodeLifecycle({ projectDir: scratch, idleMs: 0 });
  // GUILD_ROOT → scratch (no policy file there ⇒ default-allow); logs under scratch.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GUILD_ROOT: scratch,
    GUILD_LOG_DIR: logDir,
    GUILD_LOG_PROMPTS: "full",
  };
  let servePid: number | undefined;

  try {
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
      consult(
        {
          question:
            "Read the file marker.txt in the current directory and reply with the exact marker code it contains.",
          model: FREE_MODEL,
        },
        { serve: lc, env, messageTimeoutMs: ASK_MS },
      ),
      ASK_MS + 10_000,
      "consult(live)",
    );

    servePid = lc.pid; // still warm (idleMs:0) until shutdown below

    c.check(result.ok, "consult returned ok");
    if (result.ok) {
      console.log(`  model text: ${JSON.stringify(result.answer).slice(0, 200)}`);
      c.check(result.answer.includes(MARKER), `marker round-tripped through the tool answer (${MARKER})`);
      c.check(result.attribution.agent === "guild-read", "attribution names the guild-read agent");
      c.check(result.attribution.model === FREE_MODEL, "exact-id attribution matches the requested model");

      // The MCP wire shape carries the same byte-exact answer.
      const wire = consultToToolResult(result);
      const roundTripped = JSON.parse(JSON.stringify(wire)) as { content: Array<{ text: string }> };
      c.check(roundTripped.content[0].text.includes(MARKER), "marker survives the MCP tool boundary");

      // The tool-produced run verifies under the TS verifier.
      const runId = result.attribution.runId;
      c.check(new EvidenceLog({ env }).verify(runId).code === 0, "tool-produced run passes TS verify()");
    } else {
      console.error(`  consult error: ${result.error.kind} — ${result.error.message}`);
    }
  } finally {
    lc.shutdown("live-smoke-done");
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }

  // Zero leftover processes.
  if (servePid !== undefined) {
    const gone = await waitFor(() => !pidAlive(servePid!), 10_000);
    c.check(gone, `serve pid ${servePid} is dead after shutdown`);
  }
  let leftover = "";
  try {
    leftover = execSync("ps -o comm= -C opencode 2>/dev/null || true").toString().trim();
  } catch {
    /* no matches → non-zero exit is fine */
  }
  c.check(leftover === "", `no opencode process remains (ps -C opencode: ${JSON.stringify(leftover)})`);

  console.log(`consult.live: ${c.passes} passed, ${c.failures} failed`);
  return c.failures;
}

main().then((f) => {
  if (f > 0) console.error(`FAILED: ${f} live check(s) failed.`);
  else console.log("M5 live smoke passed.");
  process.exit(f > 0 ? 1 : 0);
});
