/**
 * A standalone MULTI-SESSION actor, spawned as a child PROCESS by log.test.ts's
 * issue-#80 cases. Where `log-writer-child.ts` models several calls inside ONE run
 * (C34's shared-file lock), this models what two Claude Code sessions open on one
 * project actually do to a shared `modelguild/logs/` root: each session mints its OWN
 * run, appends its own lifecycles, and runs its own retention passes — so the races are
 * on the things a run does NOT own, the `latest` symlink and the prune scan, rather than
 * on `calls.jsonl`.
 *
 * Run as a separate process on purpose: `mkdirSync`/`unlinkSync`/`renameSync`/`rmSync`
 * are synchronous, so two `EvidenceLog` instances inside ONE process can never be inside
 * the same syscall window. Only real processes race there.
 *
 * All actors wait until `SESSION_START_AT` (an epoch-ms gate the parent computes) before
 * touching the shared root, so the racy phase is entered simultaneously instead of
 * whenever each `tsx` finished booting.
 *
 * Output (stdout, one line):
 *   `RUN <runId|-> CALLS <n> PRUNES <n> REMOVED <n> PRUNE_ERRORS <n> START <ms> END <ms>`
 *
 * Env: GUILD_LOG_DIR, GUILD_LOG_RETENTION_DAYS (read by EvidenceLog itself),
 *      SESSION_ID, SESSION_CALLS, SESSION_PRUNES, SESSION_GAP_MS, SESSION_START_AT.
 */

import { EvidenceLog } from "../src/log.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const label = process.env.SESSION_ID ?? "s";
  const calls = Number(process.env.SESSION_CALLS ?? "6");
  const prunes = Number(process.env.SESSION_PRUNES ?? "0");
  const gap = Number(process.env.SESSION_GAP_MS ?? "4");
  const gate = Number(process.env.SESSION_START_AT ?? "0");
  const log = new EvidenceLog({ env: process.env });

  // The gate: sleep to the shared instant, then spin the last few ms so the actors enter
  // the shared root together (a setTimeout alone can land tens of ms late under load).
  if (gate > 0) {
    const slack = gate - Date.now() - 5;
    if (slack > 0) await sleep(slack);
    while (Date.now() < gate) { /* short, bounded spin to the gate */ }
  }

  const start = Date.now();
  let removed = 0;
  let pruneErrors = 0;
  let pruneRuns = 0;

  const prune = (): void => {
    const r = log.prune();
    pruneRuns += 1;
    removed += r.removed.length;
    if (r.reason === "error") pruneErrors += 1;
  };

  // A session that makes calls mints a run first — `newRun` prunes, exactly as a real
  // session's first model call does.
  const runId = calls > 0 ? log.newRun("/guild:panel") : "";

  for (let i = 0; i < calls; i++) {
    const callId = `${label}-${i}`;
    // `run: runId` on every append, exactly as the MCP tools thread their run — without
    // it each append would resolve a FRESH run (`#resolveRun`), which is a different test.
    await log.expect({ callId, command: "/guild:panel", model: "m/x", agent: "guild-read", run: runId });
    await sleep(gap);
    const st = await log.started({
      callId,
      command: "/guild:panel",
      model: "m/x",
      agent: "guild-read",
      prompt: `prompt ${callId}`,
      run: runId,
    });
    await sleep(gap);
    await log.completed({
      callId,
      exit: 0,
      turn: st.turn,
      command: "/guild:panel",
      model: "m/x",
      agent: "guild-read",
      captureState: "complete",
      response: `answer ${callId}`,
      run: runId,
    });
    // A retention pass INTERLEAVED with this session's own appends — the "two servers
    // pruning while a third writes" shape from issue #80.
    if (prunes > 0 && i % 2 === 1) prune();
    await sleep(gap);
  }

  // A session that only prunes (SESSION_CALLS=0) models a second server that started,
  // ran `enforceRetentionOnStart`, and made no model call.
  for (let i = pruneRuns; i < prunes; i++) {
    prune();
    await sleep(gap);
  }

  const end = Date.now();
  process.stdout.write(
    `RUN ${runId === "" ? "-" : runId} CALLS ${calls} PRUNES ${pruneRuns} ` +
      `REMOVED ${removed} PRUNE_ERRORS ${pruneErrors} START ${start} END ${end}\n`,
  );
}

// `process.exitCode`, NOT `process.exit()`: the report line above is what the parent
// parses, and an explicit exit can truncate a pending stdout write on a pipe — which
// surfaces as several confusing case-18 failures rather than as "the child was cut off".
// Letting the process end naturally flushes it.
main().then(
  () => {
    process.exitCode = 0;
  },
  (err) => {
    console.error("log-session-child failed:", err);
    process.exitCode = 1;
  },
);
