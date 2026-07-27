/**
 * M7 live smoke — guild_research (NOT part of `npm test`; run via `npm run test:live`).
 *
 * Drives the REAL production research path: `research()` composes the M1 lifecycle, the
 * model policy (default-allow ⇒ a free model passes), the evidence layer, and the typed
 * client against the UNMODIFIED, web-capable `guild-research` agent, in a disposable
 * project carrying a planted marker file.
 *
 * The question is a REPO-FILE question (read marker.txt), NOT an egress-dependent web
 * query — web capability is already proven opencode-side by verify-guild-research.sh, and
 * a network-dependent assertion would be flaky. We assert the marker round-trips byte-exact,
 * attribution names guild-research, and the run verifies under the TS verifier. A separate
 * check confirms the NO-FALLBACK def refusal fires live when the def is absent.
 *
 * Hygiene: free model only, timeout-bounded, benign canary, disposable dir.
 */

import { mkdtemp, mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpencodeLifecycle } from "../src/lifecycle.js";
import { research, researchToToolResult } from "../src/research.js";
import { EvidenceLog } from "../src/log.js";
import { Checker, repoRoot, withTimeout, waitFor, pidAlive } from "./harness.js";

const FREE_MODEL = "opencode/deepseek-v4-flash-free";
const ASK_MS = 120_000;
const MARKER = "PLATYPUS-ORBIT-7731";

async function main(): Promise<number> {
  const c = new Checker();
  console.log("== research.live (M7) ==");

  const scratch = await mkdtemp(path.join(tmpdir(), "guild-m7-research-"));
  const agentDir = path.join(scratch, ".opencode", "agent");
  const logDir = path.join(scratch, "logs");
  // HERMETICITY (issue #24): point XDG_CONFIG_HOME at an empty temp dir so the GLOBAL
  // opencode agent dir (`${XDG_CONFIG_HOME:-~/.config}/opencode/agent/`) resolves empty —
  // otherwise a box with a global install satisfies the def-missing refusal check globally.
  const emptyXdg = await mkdtemp(path.join(tmpdir(), "guild-m7-research-xdg-"));
  const lc = new OpencodeLifecycle({ projectDir: scratch, idleMs: 0 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GUILD_ROOT: scratch, // no policy ⇒ default-allow
    GUILD_LOG_DIR: logDir,
    GUILD_LOG_PROMPTS: "full",
    GUILD_AGENT_DIR: agentDir,
    XDG_CONFIG_HOME: emptyXdg,
  };
  let servePid: number | undefined;

  try {
    await mkdir(agentDir, { recursive: true });

    // First: the NO-FALLBACK refusal fires live BEFORE the def is installed (no serve call).
    const refusal = await research(
      { question: "read marker.txt", model: FREE_MODEL },
      { serve: lc, env, messageTimeoutMs: ASK_MS },
    );
    c.check(!refusal.ok && refusal.error.kind === "agent-def-missing", "def-missing: research refuses live (no fallback)");
    c.check(!refusal.ok && refusal.error.exitAnalogue === 5, "def-missing: exit-5 analogue live");
    c.check(lc.pid === undefined, "def-missing: refused WITHOUT spawning a serve");

    // Now install the real hardened def and the marker file.
    await copyFile(
      path.join(repoRoot, ".opencode", "agent", "guild-research.md"),
      path.join(agentDir, "guild-research.md"),
    );
    await writeFile(
      path.join(scratch, "marker.txt"),
      `The marker code is ${MARKER}. Report it exactly.\n`,
      "utf8",
    );

    const result = await withTimeout(
      research(
        {
          question:
            "Read the file marker.txt in the current directory and reply with the exact marker code it contains.",
          model: FREE_MODEL,
        },
        { serve: lc, env, messageTimeoutMs: ASK_MS },
      ),
      ASK_MS + 10_000,
      "research(live)",
    );

    servePid = lc.pid;
    c.check(result.ok, "research returned ok");
    if (result.ok) {
      console.log(`  model text: ${JSON.stringify(result.answer).slice(0, 200)}`);
      c.check(result.answer.includes(MARKER), `marker round-tripped through the research answer (${MARKER})`);
      c.check(result.attribution.agent === "guild-research", "attribution names the guild-research agent");
      c.check(result.attribution.model === FREE_MODEL, "exact-id attribution matches the requested model");

      const wire = researchToToolResult(result);
      const round = JSON.parse(JSON.stringify(wire)) as { content: Array<{ text: string }> };
      c.check(round.content[0].text.includes(MARKER), "marker survives the MCP tool boundary");

      const runId = result.attribution.runId;
      c.check(new EvidenceLog({ env }).verify(runId).code === 0, "research run passes TS verify()");
    } else {
      console.error(`  research error: ${result.error.kind} — ${result.error.message}`);
    }
  } finally {
    lc.shutdown("live-smoke-done");
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
    await rm(emptyXdg, { recursive: true, force: true }).catch(() => {});
  }

  if (servePid !== undefined) {
    const gone = await waitFor(() => !pidAlive(servePid!), 10_000);
    c.check(gone, `serve pid ${servePid} is dead after shutdown`);
  }
  let leftover = "";
  try {
    leftover = execSync("ps -o comm= -C opencode 2>/dev/null || true").toString().trim();
  } catch {
    /* no matches */
  }
  c.check(leftover === "", `no opencode process remains (ps -C opencode: ${JSON.stringify(leftover)})`);

  console.log(`research.live: ${c.passes} passed, ${c.failures} failed`);
  return c.failures;
}

main().then((f) => {
  if (f > 0) console.error(`FAILED: ${f} live check(s) failed.`);
  else console.log("M7 research live smoke passed.");
  process.exit(f > 0 ? 1 : 0);
});
