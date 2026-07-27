/**
 * M6 live smoke (NOT part of `npm test` — run via `npm run test:live`).
 *
 * Drives the REAL production path for guild_panel: two FREE models, asked the SAME
 * question CONCURRENTLY through the UNMODIFIED read-only `guild-read` agent against one
 * `opencode serve`, in a disposable scratch project carrying a planted marker file. We
 * assert both voices round-trip the marker byte-exact, the single tool-produced run holds
 * both members' lifecycles and verifies under the TS verifier, and no `opencode serve`
 * survives.
 *
 * Both free models share the `opencode` provider, so the single-provider "diversity
 * theater" warning is EXPECTED here (surfaced, not fatal) — asserted, so a regression that
 * dropped the warning would fail.
 *
 * Hygiene (repo rule): free models only, timeout-bounded, benign canary, disposable dir.
 */

import { mkdtemp, mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpencodeLifecycle } from "../src/lifecycle.js";
import { panel, panelToToolResult } from "../src/panel.js";
import { EvidenceLog } from "../src/log.js";
import { Checker, repoRoot, withTimeout, waitFor, pidAlive } from "./harness.js";

const MODELS = ["opencode/deepseek-v4-flash-free", "opencode/nemotron-3-ultra-free"];
const ASK_MS = 120_000;
const MARKER = "PLATYPUS-ORBIT-7731";

async function main(): Promise<number> {
  const c = new Checker();
  console.log("== panel.live (M6) ==");

  const scratch = await mkdtemp(path.join(tmpdir(), "guild-m6-live-"));
  const logDir = path.join(scratch, "logs");
  const lc = new OpencodeLifecycle({ projectDir: scratch, idleMs: 0 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GUILD_ROOT: scratch, // no policy file ⇒ default-allow
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
      panel(
        {
          question:
            "Read the file marker.txt in the current directory and reply with the exact marker code it contains.",
          models: MODELS,
        },
        { serve: lc, env, messageTimeoutMs: ASK_MS },
      ),
      ASK_MS + 20_000,
      "panel(live)",
    );

    servePid = lc.pid; // still warm (idleMs:0) until shutdown below

    c.check(result.ok, "panel returned ok");
    if (result.ok) {
      c.check(result.results.length === 2, "two members answered");
      for (const m of result.results) {
        console.log(`  ${m.model}: ${JSON.stringify(m.text ?? m.error).slice(0, 160)}`);
        c.check(!m.error, `member ${m.model} had no error`);
        c.check((m.text ?? "").includes(MARKER), `member ${m.model} round-tripped the marker (${MARKER})`);
        c.check(!!m.callId, `member ${m.model} recorded a call_id`);
      }
      c.check(
        result.results.map((m) => m.model).join(",") === MODELS.join(","),
        "exact-id attribution in input order",
      );
      c.check(
        result.warnings.some((w) => /diversity theater/.test(w)),
        "single-provider 'diversity theater' warning surfaced (both models are opencode/*)",
      );

      // The MCP wire shape carries both voices.
      const wire = panelToToolResult(result);
      const round = JSON.parse(JSON.stringify(wire)) as { content: Array<{ text: string }> };
      c.check(round.content[0].text.includes(MARKER), "marker survives the MCP tool boundary");

      // The single tool-produced run verifies under the TS verifier.
      const runId = result.runId;
      c.check(new EvidenceLog({ env }).verify(runId).code === 0, "tool-produced run passes TS verify()");
    } else {
      console.error(`  panel error: ${result.error.kind} — ${result.error.message}`);
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

  console.log(`panel.live: ${c.passes} passed, ${c.failures} failed`);
  return c.failures;
}

main().then((f) => {
  if (f > 0) console.error(`FAILED: ${f} live check(s) failed.`);
  else console.log("M6 live smoke passed.");
  process.exit(f > 0 ? 1 : 0);
});
