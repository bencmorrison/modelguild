/**
 * M7 live smoke — SESSION CONTINUATION (NOT part of `npm test`; run via `npm run test:live`).
 *
 * Two live proofs, both on FREE models, that the Option-B construction guarantee holds on
 * the TS path:
 *
 *   A. SAME-SERVE MEMORY (the Phase 0 proof, now on TS): turn 1 (keepSession) plants a
 *      distinctive codeword; turn 2 CONTINUES the session and must recall it WITHOUT the
 *      codeword ever being restated by the driver. The codeword appears in turn 1's prompt
 *      and NOWHERE in turn 2's — recall proves opencode carried the peer's prior turn, not
 *      the driver re-transmitting it.
 *
 *   B. FRESH-SERVE CONTINUATION (the design-relevant probe): a session is created + planted
 *      by one `opencode serve`, that serve is KILLED, a FRESH serve is started against the
 *      same project dir, and the session is continued through it. If recall survives, opencode
 *      persists sessions on disk and a fresh server process can continue them — the assumption
 *      the multi-turn design rests on. If it does NOT, this prints a loud DESIGN-RELEVANT
 *      finding rather than passing silently.
 *
 * Hygiene: free model only, timeout-bounded, benign codeword, disposable dir, sessions deleted.
 */

import { mkdtemp, mkdir, copyFile, rm } from "node:fs/promises";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpencodeLifecycle } from "../src/lifecycle.js";
import { consult } from "../src/consult.js";
import { askViaAgent, deleteSession } from "../src/client.js";
import { Checker, repoRoot, withTimeout, waitFor, pidAlive } from "./harness.js";

const FREE_MODEL = "opencode/deepseek-v4-flash-free";
const ASK_MS = 120_000;
const CODEWORD_A = "PLATYPUS-ORBIT-7731";
const CODEWORD_B = "NARWHAL-COMET-5142";

async function setupProject(): Promise<string> {
  const scratch = await mkdtemp(path.join(tmpdir(), "guild-m7-sess-"));
  await mkdir(path.join(scratch, ".opencode", "agent"), { recursive: true });
  await copyFile(
    path.join(repoRoot, ".opencode", "agent", "guild-read.md"),
    path.join(scratch, ".opencode", "agent", "guild-read.md"),
  );
  return scratch;
}

async function main(): Promise<number> {
  const c = new Checker();
  console.log("== session.live (M7 continuation) ==");

  // -------------------------------------------------------------------------
  // A. Same-serve memory proof (production consult path, with logging).
  // -------------------------------------------------------------------------
  const scratchA = await setupProject();
  const envA: NodeJS.ProcessEnv = {
    ...process.env,
    GUILD_ROOT: scratchA,
    GUILD_LOG_DIR: path.join(scratchA, "logs"),
    GUILD_LOG_PROMPTS: "full",
  };
  const lcA = new OpencodeLifecycle({ projectDir: scratchA, idleMs: 0 });
  let pidA: number | undefined;
  try {
    const r1 = await withTimeout(
      consult(
        {
          question:
            `Remember this codeword for later: ${CODEWORD_A}. Reply with just the word "acknowledged".`,
          model: FREE_MODEL,
          keepSession: true,
        },
        { serve: lcA, env: envA, messageTimeoutMs: ASK_MS },
      ),
      ASK_MS + 10_000,
      "consult(A turn1)",
    );
    c.check(r1.ok, "A: turn 1 (plant) ok");
    const sid = r1.ok ? r1.sessionId : undefined;
    c.check(!!sid, "A: turn 1 returned a kept session id");

    // Turn 2 CONTINUES — the codeword is NOT in this prompt.
    const q2 = "What was the codeword I asked you to remember? Reply with ONLY the codeword, nothing else.";
    c.check(!q2.includes(CODEWORD_A), "A: turn-2 prompt does NOT contain the codeword (no re-transmission)");
    const r2 = await withTimeout(
      consult(
        { question: q2, model: FREE_MODEL, sessionId: sid },
        { serve: lcA, env: envA, messageTimeoutMs: ASK_MS },
      ),
      ASK_MS + 10_000,
      "consult(A turn2)",
    );
    c.check(r2.ok, "A: turn 2 (recall) ok");
    if (r2.ok) {
      console.log(`  A recall: ${JSON.stringify(r2.answer).slice(0, 160)}`);
      c.check(r2.answer.includes(CODEWORD_A), `A: MEMORY held — turn 2 recalled ${CODEWORD_A} via session, not re-transmission`);
    }
    pidA = lcA.pid;
  } finally {
    lcA.shutdown("A-done");
    await rm(scratchA, { recursive: true, force: true }).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // B. Fresh-serve continuation probe (client capability; DESIGN-RELEVANT).
  // -------------------------------------------------------------------------
  const scratchB = await setupProject();
  const lc1 = new OpencodeLifecycle({ projectDir: scratchB, idleMs: 0 });
  let baseUrl2: string | undefined;
  let sessionB: string | undefined;
  try {
    // Plant through serve #1, keep the session alive.
    const plant = await withTimeout(
      askViaAgent(lc1, {
        agent: "guild-read",
        model: FREE_MODEL,
        prompt: `Remember this codeword for later: ${CODEWORD_B}. Reply with just "ok".`,
        keepSession: true,
        messageTimeoutMs: ASK_MS,
      }),
      ASK_MS + 10_000,
      "askViaAgent(B plant)",
    );
    sessionB = plant.sessionId;
    c.check(!!sessionB, "B: planted session id captured");
    const pid1 = lc1.pid;
    lc1.shutdown("B-serve1-done");
    if (pid1 !== undefined) {
      await waitFor(() => !pidAlive(pid1), 10_000);
    }
    c.check(pid1 === undefined || !pidAlive(pid1), "B: serve #1 is dead before serve #2 starts");

    // Continue through a FRESH serve #2 against the same project dir.
    const lc2 = new OpencodeLifecycle({ projectDir: scratchB, idleMs: 0 });
    let recalled = false;
    try {
      const q = "What was the codeword I asked you to remember? Reply with ONLY the codeword.";
      const cont = await withTimeout(
        askViaAgent(lc2, {
          agent: "guild-read",
          model: FREE_MODEL,
          prompt: q,
          sessionId: sessionB,
          keepSession: true, // keep so we can clean up explicitly below
          messageTimeoutMs: ASK_MS,
        }),
        ASK_MS + 10_000,
        "askViaAgent(B continue)",
      );
      baseUrl2 = `http://127.0.0.1:${lc2.port}`;
      recalled = cont.text.includes(CODEWORD_B);
      console.log(`  B fresh-serve recall: ${JSON.stringify(cont.text).slice(0, 160)}`);
      if (recalled) {
        console.log("  DESIGN FACT: opencode sessions PERSIST across a fresh serve process (continuation survives serve restart).");
      } else {
        console.log("  DESIGN FACT: a FRESH serve did NOT recall the planted codeword — session continuation does NOT survive a serve restart on this opencode build. The multi-turn design must keep ONE serve alive for a session's lifetime.");
      }
      c.check(recalled, "B: fresh-serve continuation recalled the codeword (session persists on disk)");
      // Clean up the kept session through serve #2.
      if (baseUrl2 && sessionB) {
        await deleteSession({ baseUrl: baseUrl2, sessionId: sessionB }).catch(() => {});
      }
    } finally {
      lc2.shutdown("B-serve2-done");
    }
  } finally {
    await rm(scratchB, { recursive: true, force: true }).catch(() => {});
  }

  // No leftover opencode processes.
  if (pidA !== undefined) await waitFor(() => !pidAlive(pidA!), 10_000);
  let leftover = "";
  try {
    leftover = execSync("ps -o comm= -C opencode 2>/dev/null || true").toString().trim();
  } catch {
    /* no matches */
  }
  c.check(leftover === "", `no opencode process remains (ps -C opencode: ${JSON.stringify(leftover)})`);

  console.log(`session.live: ${c.passes} passed, ${c.failures} failed`);
  return c.failures;
}

main().then((f) => {
  if (f > 0) console.error(`FAILED: ${f} live check(s) failed.`);
  else console.log("M7 session live smoke passed.");
  process.exit(f > 0 ? 1 : 0);
});
