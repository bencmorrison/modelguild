/**
 * Evidence-layer tests (CONTRACT.md area D, C22–C35) — OFFLINE.
 *
 * No model is called. The suite drives `src/log.ts` (the reference implementation; the
 * bash `log.sh` it was cross-verified against retired at M12). Canonicalization is
 * still pinned byte-for-byte against `jq` (a system tool, not a ModelGuild script), and
 * cross-process concurrency is proven with genuinely-racing TS writer child processes
 * (`test/log-writer-child.ts`) contending the shared `mkdir` lock.
 */

import { execFileSync, spawnSync, spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  utimesSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  EvidenceLog,
  assertRunId,
  confGet,
  enforceRetentionOnStart,
  isRunId,
  resolveRunIdArg,
  type PromptMode,
} from "../src/log.js";
import { runLogsClean } from "../src/cli.js";
import { canonicalStringify, buildEntryLine } from "../src/canonical.js";
import { Checker, repoRoot, tsxBin, sleep } from "./harness.js";

const CHILD = path.join(repoRoot, "test", "log-writer-child.ts");

/** A fresh temp dir, cleaned at suite end. */
const tmpDirs: string[] = [];
function tmp(prefix = "m3log-"): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function envFor(logDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, GUILD_LOG_DIR: logDir, ...extra } as NodeJS.ProcessEnv;
}

function lines(file: string): string[] {
  return readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);
}
function parsed(file: string): Array<Record<string, unknown>> {
  return lines(file).map((l) => JSON.parse(l) as Record<string, unknown>);
}

export async function run(): Promise<number> {
  const c = new Checker();
  console.log("== log.test (evidence layer, M3) ==");

  // -------------------------------------------------------------------------
  // 0. Canonicalization byte-match against jq (the heart of the milestone).
  // -------------------------------------------------------------------------
  {
    // Every entry field type + the awkward string, canonicalized by TS and by jq -cS,
    // must be byte-identical. Includes DEL (U+007F), the one code point where
    // JSON.stringify and jq diverge.
    const sample = {
      z_last: "zebra",
      a_first: 1,
      raw_response: 'line\n"q"\ttab\\back\ncafé ☕ 𝄞\x7fDEL\n\n',
      nested: { b: true, a: null },
      arr: [3, "x", false],
      exit_code: 0,
      neg: -5,
    };
    const tsCanon = canonicalStringify(sample as never);
    const jqCanon = execFileSync("jq", ["-cS", "."], {
      input: JSON.stringify(sample),
      encoding: "utf8",
    }).replace(/\n$/, "");
    c.check(tsCanon === jqCanon, "canonical: TS canonicalStringify byte-matches jq -cS (incl. U+007F)");

    // entry_hash reproduced exactly the way bash computes it (sha over canonical form).
    const { line, entryHash } = buildEntryLine({ b: "x", a: "y" });
    const jqSorted = execFileSync("jq", ["-cjS", "."], {
      input: JSON.stringify({ b: "x", a: "y" }),
      encoding: "utf8",
    });
    const expectHash = execFileSync("bash", ["-c", `printf %s ${shellQuote(jqSorted)} | sha256sum | cut -d" " -f1`], {
      encoding: "utf8",
    }).trim();
    c.check(entryHash === expectHash, "canonical: entry_hash == sha256 of jq -cjS canonical form");
    c.check(line.endsWith(`"entry_hash":"${entryHash}"}`), "canonical: entry_hash is appended LAST (bash quirk)");
  }

  // -------------------------------------------------------------------------
  // 1. A run with every entry type: lifecycle + final + disposition +
  //    subagent-voice + a delegate-diff with a real patch artifact, verified.
  // -------------------------------------------------------------------------
  let tsRunDir = "";
  let tsRunId = "";
  let tsLogDir = "";
  {
    tsLogDir = tmp();
    const env = envFor(tsLogDir, { GUILD_LOG_PROMPTS: "full" });
    const log = new EvidenceLog({ env });
    tsRunId = log.newRun("/guild:delegate");
    const runEnv = envFor(tsLogDir, { GUILD_RUN_ID: tsRunId, GUILD_LOG_PROMPTS: "full" });
    const l = new EvidenceLog({ env: runEnv });
    await l.expect({ callId: "c1", command: "/guild:delegate", model: "openai/gpt-5", agent: "guild-build" });
    const st = await l.started({ callId: "c1", command: "/guild:delegate", model: "openai/gpt-5", agent: "guild-build", prompt: "do the work\n" });
    await l.completed({
      callId: "c1", exit: 0, turn: st.turn, command: "/guild:delegate", model: "openai/gpt-5", agent: "guild-build",
      captureState: "complete", response: 'model reply "q" \\b\ntrailing\x7f\n\n',
    });
    await l.final("summary the developer read");
    await l.disposition({ model: "openai/gpt-5", point: "the point", verdict: "Adapt", why: "partial" });
    await l.subagentVoice({ model: "claude-opus-4-8", label: "anthropic voice", response: 'subagent said\n"x"\n' });
    tsRunDir = l.dir(tsRunId);
    const patch = path.join(tsRunDir, "diff-c1.patch");
    writeFileSync(patch, "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1,2 @@\n orig\n+MODEL-EDIT\n");
    const dr = await l.diff({ callId: "c1", patchFile: patch, base: "basetree", after: "aftertree" });
    c.check(dr.ok, "diff: delegate-diff entry written");

    const tsv = l.verify(tsRunId);
    c.check(tsv.ok && tsv.code === 0, "verify: TS verifies its own full run (all 7 entry types)");
  }

  // -------------------------------------------------------------------------
  // 1c. Negative: corrupt one byte of a TS-written run → verify FAILS (code 7).
  // -------------------------------------------------------------------------
  {
    const env = envFor(tsLogDir, { GUILD_LOG_PROMPTS: "full" });
    const file = path.join(tsRunDir, "calls.jsonl");
    const orig = readFileSync(file, "utf8");
    const arr = orig.split("\n");
    // Edit the completed (line 3) raw_response — a middle entry, breaks the chain.
    arr[2] = arr[2].replace("model reply", "MODEL LIED");
    writeFileSync(file, arr.join("\n"));
    const v = new EvidenceLog({ env }).verify(tsRunId);
    c.check(!v.ok && v.code === 7, "1c: a corrupted middle entry FAILS verify (code 7)");
    writeFileSync(file, orig); // restore
  }

  // -------------------------------------------------------------------------
  // 2b. LONE-SURROGATE (reviewer probe): a completed response carrying a lone \ud800
  //     must FAIL verify. JS JSON.parse ACCEPTS the escape while jq rejects it, so
  //     without the round-trip cleanliness check the verifier would pass an invalid log —
  //     a false-clean in the exact direction this project kills.
  // -------------------------------------------------------------------------
  {
    const dir = tmp();
    const env = envFor(dir, { GUILD_RUN_ID: "surr" });
    const log = new EvidenceLog({ env });
    await log.expect({ callId: "s", model: "m/x", agent: "guild-read" });
    const st = await log.started({ callId: "s", model: "m/x", agent: "guild-read", prompt: "p" });
    // A model reply carrying a lone high surrogate; JSON.stringify serializes it as the
    // escape `\ud800`, so the stored line is exactly the reviewer's probe input.
    await log.completed({ callId: "s", exit: 0, turn: st.turn, captureState: "complete", response: "before\ud800after" });
    const file = path.join(dir, "surr", "calls.jsonl");
    c.check(readFileSync(file, "utf8").includes("\\ud800"), "2b setup: the stored line carries a lone \\ud800 escape");
    const tsv = log.verify("surr");
    c.check(!tsv.ok && tsv.code === 7, "2b: verify FAILS a lone-surrogate response (code 7)");
  }

  // -------------------------------------------------------------------------
  // 4. C22/C23 — 3-entry lifecycle sharing one call_id.
  // -------------------------------------------------------------------------
  {
    const dir = tmp();
    const env = envFor(dir, { GUILD_RUN_ID: "run-lc" });
    const log = new EvidenceLog({ env });
    await log.expect({ callId: "x", command: "/c", model: "m/x", agent: "guild-read" });
    const st = await log.started({ callId: "x", command: "/c", model: "m/x", agent: "guild-read", prompt: "p" });
    await log.completed({ callId: "x", exit: 0, turn: st.turn, captureState: "complete", response: "a" });
    const es = parsed(path.join(dir, "run-lc", "calls.jsonl"));
    const types = es.map((e) => `${e.type}/${e.status}`);
    const ids = new Set(es.map((e) => e.call_id));
    c.check(
      es.length === 3 &&
        types.includes("expected-call/expected") &&
        types.includes("call/started") &&
        types.includes("call/completed") &&
        ids.size === 1 && ids.has("x"),
      "C22/C23: one call = expected+started+completed, all sharing one call_id",
    );
  }

  // -------------------------------------------------------------------------
  // 5. C24 — cardinality both directions: orphan started, orphan completed,
  //    duplicate started, duplicate completed all FAIL.
  // -------------------------------------------------------------------------
  {
    // orphan started (no completed)
    let dir = tmp();
    let env = envFor(dir, { GUILD_RUN_ID: "r" });
    let log = new EvidenceLog({ env });
    await log.expect({ callId: "o", model: "m/x", agent: "guild-read" });
    await log.started({ callId: "o", model: "m/x", agent: "guild-read", prompt: "p" });
    c.check(log.verify("r").code === 7, "C24: an unpaired started FAILS verify");

    // orphan completed (no started) — the lost-prompt gap in disguise
    dir = tmp(); env = envFor(dir, { GUILD_RUN_ID: "r" }); log = new EvidenceLog({ env });
    await log.expect({ callId: "o", model: "m/x", agent: "guild-read" });
    await log.completed({ callId: "o", exit: 0, captureState: "complete", response: "a" });
    c.check(log.verify("r").code === 7, "C24: an unpaired completed FAILS verify (both directions)");

    // duplicate started
    dir = tmp(); env = envFor(dir, { GUILD_RUN_ID: "r" }); log = new EvidenceLog({ env });
    await log.expect({ callId: "d", model: "m/x", agent: "guild-read" });
    const st = await log.started({ callId: "d", model: "m/x", agent: "guild-read", prompt: "p" });
    await log.started({ callId: "d", model: "m/x", agent: "guild-read", prompt: "p" });
    await log.completed({ callId: "d", exit: 0, turn: st.turn, captureState: "complete", response: "a" });
    c.check(log.verify("r").code === 7, "C24: duplicate started FAILS exact cardinality");

    // duplicate completed
    dir = tmp(); env = envFor(dir, { GUILD_RUN_ID: "r" }); log = new EvidenceLog({ env });
    await log.expect({ callId: "d", model: "m/x", agent: "guild-read" });
    const st2 = await log.started({ callId: "d", model: "m/x", agent: "guild-read", prompt: "p" });
    await log.completed({ callId: "d", exit: 0, turn: st2.turn, captureState: "complete", response: "a" });
    await log.completed({ callId: "d", exit: 0, turn: st2.turn, captureState: "complete", response: "a" });
    c.check(log.verify("r").code === 7, "C24: duplicate completed FAILS exact cardinality");
  }

  // -------------------------------------------------------------------------
  // 6. C25 — byte-exact raw_response (trailing newlines + DEL) and present-empty
  //    vs missing (carried decision).
  // -------------------------------------------------------------------------
  {
    const dir = tmp();
    const env = envFor(dir, { GUILD_RUN_ID: "r" });
    const log = new EvidenceLog({ env });
    const awkward = "trailing bytes\n\n";
    await log.expect({ callId: "b", model: "m/x", agent: "guild-read" });
    const st = await log.started({ callId: "b", model: "m/x", agent: "guild-read", prompt: "p" });
    await log.completed({ callId: "b", exit: 0, turn: st.turn, captureState: "complete", response: awkward });
    const es = parsed(path.join(dir, "r", "calls.jsonl"));
    const comp = es.find((e) => e.status === "completed")!;
    c.check(comp.raw_response === awkward, "C25: raw_response keeps trailing newlines byte-exact");
    c.check(log.verify("r").ok, "C25: verify agrees with the byte-exact writer");

    // present-empty: complete + response "" stays complete with sha of "".
    const dir2 = tmp();
    const env2 = envFor(dir2, { GUILD_RUN_ID: "r" });
    const log2 = new EvidenceLog({ env: env2 });
    await log2.expect({ callId: "e", model: "m/x", agent: "guild-read" });
    const st2 = await log2.started({ callId: "e", model: "m/x", agent: "guild-read", prompt: "p" });
    await log2.completed({ callId: "e", exit: 0, turn: st2.turn, captureState: "complete", response: "" });
    const compE = parsed(path.join(dir2, "r", "calls.jsonl")).find((e) => e.status === "completed")!;
    c.check(
      compE.capture_state === "complete" && compE.raw_response === "" &&
        compE.response_hash === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "C25 (carried): present-but-empty response stays complete (sha of empty)",
    );

    // missing: complete + no response ⇒ downgrade to failed, and verify FAILS clean.
    const dir3 = tmp();
    const env3 = envFor(dir3, { GUILD_RUN_ID: "r" });
    const log3 = new EvidenceLog({ env: env3 });
    await log3.expect({ callId: "m", model: "m/x", agent: "guild-read" });
    const st3 = await log3.started({ callId: "m", model: "m/x", agent: "guild-read", prompt: "p" });
    await log3.completed({ callId: "m", exit: 0, turn: st3.turn, captureState: "complete" }); // no response
    const compM = parsed(path.join(dir3, "r", "calls.jsonl")).find((e) => e.status === "completed")!;
    c.check(
      compM.capture_state === "failed" && compM.response_hash === null && log3.verify("r").code === 7,
      "C25 (carried): missing response downgrades complete→failed and cannot verify clean",
    );

    // A non-zero exit still writes completed and stays integral.
    const dir4 = tmp();
    const env4 = envFor(dir4, { GUILD_RUN_ID: "r" });
    const log4 = new EvidenceLog({ env: env4 });
    await log4.expect({ callId: "z", model: "m/x", agent: "guild-read" });
    const st4 = await log4.started({ callId: "z", model: "m/x", agent: "guild-read", prompt: "p" });
    await log4.completed({ callId: "z", exit: 3, turn: st4.turn, captureState: "complete", response: "boom" });
    const compZ = parsed(path.join(dir4, "r", "calls.jsonl")).find((e) => e.status === "completed")!;
    c.check(compZ.exit_code === 3 && log4.verify("r").ok, "C25: a non-zero exit still writes an integral completed");
  }

  // -------------------------------------------------------------------------
  // 7. C25 (carried) — aborted send BEFORE started leaves only expected-call: the
  //    gap is preserved and made visible (verify fails), never auto-closed.
  // -------------------------------------------------------------------------
  {
    const dir = tmp();
    const env = envFor(dir, { GUILD_RUN_ID: "r" });
    const log = new EvidenceLog({ env });
    await log.expect({ callId: "aborted", model: "m/x", agent: "guild-read" });
    // (An abort that produced a session DELETE but never reached `started` records NO
    //  completed — the durable expected-call is what surfaces the gap.)
    c.check(log.verify("r").code === 7, "C25 (carried): an expected-call with no lifecycle is a visible gap (verify fails)");
  }

  // -------------------------------------------------------------------------
  // 8. C26 — prompt privacy modes full / hash / off (off = no text AND no digest).
  // -------------------------------------------------------------------------
  {
    for (const mode of ["full", "hash", "off"] as PromptMode[]) {
      const dir = tmp();
      const env = envFor(dir, { GUILD_RUN_ID: "r", GUILD_LOG_PROMPTS: mode });
      const log = new EvidenceLog({ env });
      await log.expect({ callId: "p", model: "m/x", agent: "guild-read" });
      const st = await log.started({ callId: "p", model: "m/x", agent: "guild-read", prompt: "SENTINEL-abc123" });
      await log.completed({ callId: "p", exit: 0, turn: st.turn, captureState: "complete", response: "a" });
      const started = parsed(path.join(dir, "r", "calls.jsonl")).find((e) => e.status === "started")!;
      const hasText = started.prompt === "SENTINEL-abc123";
      const hasHash = typeof started.prompt_hash === "string";
      if (mode === "full") c.check(hasText && hasHash, "C26: full records prompt text + digest");
      if (mode === "hash") c.check(!hasText && hasHash, "C26: hash records digest only, not text");
      if (mode === "off") c.check(started.prompt === null && started.prompt_hash === null, "C26: off records NEITHER text nor digest");
      c.check(log.verify("r").ok, `C26: verify passes ${mode} mode`);
    }
  }

  // -------------------------------------------------------------------------
  // 9. C27 — chain + self-hash: editing a MIDDLE entry breaks the chain; editing
  //    the LAST entry is caught by the entry_hash self-check (tail blind spot).
  // -------------------------------------------------------------------------
  {
    const dir = tmp();
    const env = envFor(dir, { GUILD_RUN_ID: "r" });
    const log = new EvidenceLog({ env });
    await log.expect({ callId: "a", model: "m/x", agent: "guild-read" });
    const s1 = await log.started({ callId: "a", model: "m/x", agent: "guild-read", prompt: "p" });
    await log.completed({ callId: "a", exit: 0, turn: s1.turn, captureState: "complete", response: "canned answer" });
    const file = path.join(dir, "r", "calls.jsonl");

    // middle edit (line 2 = started)
    let arr = readFileSync(file, "utf8").split("\n");
    const mid = arr[1].replace(/"prompt":"p"/, '"prompt":"HACKED"');
    c.check(mid !== arr[1], "C27 setup: middle line mutated");
    const saved = arr[1]; arr[1] = mid; writeFileSync(file, arr.join("\n"));
    c.check(log.verify("r").code === 7, "C27: editing a middle entry FAILS (prev_hash chain)");
    arr[1] = saved; writeFileSync(file, arr.join("\n"));
    c.check(log.verify("r").ok, "C27: restore verifies clean");

    // last-line edit — the chain has no successor; only entry_hash covers it.
    arr = readFileSync(file, "utf8").split("\n");
    arr[2] = arr[2].replace("canned answer", "SOMETHING ELSE");
    writeFileSync(file, arr.join("\n"));
    c.check(log.verify("r").code === 7, "C27: editing the LAST entry FAILS (entry_hash self-check covers the tail)");
  }

  // -------------------------------------------------------------------------
  // 10. C29 — disposition claim:true + verdict vocabulary; final; subagent-voice
  //     claim:true/captured:false/claimed_response; delegate-diff claim:false.
  // -------------------------------------------------------------------------
  {
    const dir = tmp();
    const env = envFor(dir, { GUILD_RUN_ID: "r" });
    const log = new EvidenceLog({ env });
    await log.expect({ callId: "c1", model: "m/x", agent: "guild-read" });
    const st = await log.started({ callId: "c1", model: "m/x", agent: "guild-read", prompt: "p" });
    await log.completed({ callId: "c1", exit: 0, turn: st.turn, captureState: "complete", response: "a" });

    const good = await log.disposition({ model: "m/x", point: "p", verdict: "Adopt" });
    const bad = await log.disposition({ model: "m/x", point: "p", verdict: "Maybe" as never });
    c.check(good.ok && !bad.ok, "C29: disposition accepts Adopt, rejects a bogus verdict (no throw)");
    const disp = parsed(path.join(dir, "r", "calls.jsonl")).find((e) => e.type === "claude-disposition")!;
    c.check(disp.claim === true, "C29: disposition is claim:true");

    const svResp = 'subagent says:\n  "quote", back\\slash\n';
    await log.subagentVoice({ model: "claude-opus-4-8", label: "voice", response: svResp });
    const sv = parsed(path.join(dir, "r", "calls.jsonl")).find((e) => e.type === "subagent-voice")!;
    c.check(
      sv.claim === true && sv.captured === false && sv.transport === "claude-subagent" &&
        !("raw_response" in sv) && sv.claimed_response === svResp,
      "C29: subagent-voice is claim:true/captured:false, uses claimed_response not raw_response, byte-exact",
    );
    c.check(log.verify("r").ok, "C29: verify accepts opencode call + disposition + subagent-voice");

    // Tamper the final subagent-voice text (the last line) → response_hash self-check
    // catches it, since the chain has no successor to cover the tail.
    const file = path.join(dir, "r", "calls.jsonl");
    const arr = readFileSync(file, "utf8").split("\n");
    const idx = arr.map((l, i) => (l.length ? i : -1)).filter((i) => i >= 0).pop()!;
    arr[idx] = arr[idx].replace("subagent says", "subagent LIED");
    writeFileSync(file, arr.join("\n"));
    c.check(log.verify("r").code === 7, "C29: an altered subagent-voice transcript FAILS (response_hash)");
  }

  // -------------------------------------------------------------------------
  // 11. C28/C29 — delegate-diff patch hashed; missing patch and tampered patch FAIL.
  // -------------------------------------------------------------------------
  {
    const dir = tmp();
    const env = envFor(dir, { GUILD_RUN_ID: "r" });
    const log = new EvidenceLog({ env });
    await log.expect({ callId: "d1", model: "m/x", agent: "guild-build" });
    const st = await log.started({ callId: "d1", model: "m/x", agent: "guild-build", prompt: "p" });
    await log.completed({ callId: "d1", exit: 0, turn: st.turn, captureState: "complete", response: "did work" });
    const rd = log.dir("r");
    const patch = path.join(rd, "diff-d1.patch");
    writeFileSync(patch, "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-o\n+n\ndiff --git a/y b/y\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n-a\n+b\n");
    const dr = await log.diff({ callId: "d1", patchFile: patch, base: "bt", after: "at" });
    const diffEntry = parsed(path.join(rd, "calls.jsonl")).find((e) => e.type === "delegate-diff")!;
    c.check(dr.ok && diffEntry.claim === false && diffEntry.files_changed === 2, "C29: delegate-diff is claim:false, counts 2 changed files");
    c.check(log.verify("r").ok, "C28: verify passes with a present, hash-matching patch");

    // tamper the patch → verify FAILS
    writeFileSync(patch, readFileSync(patch, "utf8") + "tampered\n");
    c.check(log.verify("r").code === 7, "C28: a tampered patch FAILS verify (diff is inside the integrity contract)");

    // missing patch → verify FAILS
    rmSync(patch);
    c.check(log.verify("r").code === 7, "C28: a MISSING referenced patch FAILS verify");

    // diff with a nonexistent patch file is a no-op that does not throw
    const nope = await log.diff({ callId: "d1", patchFile: path.join(rd, "does-not-exist.patch") });
    c.check(!nope.ok, "C28: diff() on a missing patch file returns ok:false, does not throw");
  }

  // -------------------------------------------------------------------------
  // 12. C30 — a subagent-voice-only run verifies (all-Anthropic exchange); a
  //     claude-final-only run does NOT.
  // -------------------------------------------------------------------------
  {
    const dir = tmp();
    const env = envFor(dir, { GUILD_RUN_ID: "sv" });
    const log = new EvidenceLog({ env });
    await log.subagentVoice({ model: "claude-opus-4-8", response: "lone subagent reply" });
    c.check(log.verify("sv").ok, "C30: a subagent-voice-only run verifies (all-Anthropic exchange is not empty)");

    const dir2 = tmp();
    const env2 = envFor(dir2, { GUILD_RUN_ID: "cf" });
    const log2 = new EvidenceLog({ env: env2 });
    await log2.final("only a summary, no model call");
    c.check(log2.verify("cf").code === 7, "C30: a claude-final-only run FAILS (no lifecycle nor voice)");
  }

  // -------------------------------------------------------------------------
  // 13. C31 — logging never throws into the caller (unwritable log dir).
  // -------------------------------------------------------------------------
  {
    // Point the log dir at a path whose parent is a FILE, so mkdir/append fail.
    const base = tmp();
    const blocker = path.join(base, "blocker");
    writeFileSync(blocker, "not a dir");
    const env = envFor(path.join(blocker, "logs"), { GUILD_RUN_ID: "r" });
    const log = new EvidenceLog({ env });
    let threw = false;
    let res;
    try {
      res = await log.started({ callId: "x", model: "m/x", agent: "guild-read", prompt: "p" });
    } catch {
      threw = true;
    }
    c.check(!threw && res !== undefined && res.ok === false, "C31: an unwritable log dir returns ok:false, never throws");
  }

  // -------------------------------------------------------------------------
  // 13b. C31 (audit path) — verify() must not THROW on an IO error (an MCP handler
  //      calls it). A calls.jsonl that is a DIRECTORY makes readFileSync throw EISDIR;
  //      verify must catch it and return a failed result, not propagate.
  // -------------------------------------------------------------------------
  {
    const dir = tmp();
    const env = envFor(dir, { GUILD_RUN_ID: "iofail" });
    // Put a DIRECTORY where calls.jsonl should be, so existsSync passes but read fails.
    mkdirSync(path.join(dir, "iofail", "calls.jsonl"), { recursive: true });
    const log = new EvidenceLog({ env });
    let threw = false;
    let v;
    try {
      v = log.verify("iofail");
    } catch {
      threw = true;
    }
    c.check(!threw && v !== undefined && !v.ok && v.code === 7, "C31: verify() on an unreadable log returns a failed result (code 7), never throws");
  }

  // -------------------------------------------------------------------------
  // 14. C32 — retention/prune removes old run dirs; only run-id-shaped dirs.
  // -------------------------------------------------------------------------
  {
    const dir = tmp();
    const env = envFor(dir);
    const log = new EvidenceLog({ env });
    const oldRun = path.join(dir, "20200101T000000Z-deadbeef");
    mkdirSync(oldRun, { recursive: true });
    const notARun = path.join(dir, "keepme");
    mkdirSync(notARun, { recursive: true });
    const old = new Date(Date.now() - 60 * 86_400_000);
    utimesSync(oldRun, old, old);
    utimesSync(notARun, old, old);
    const r14 = log.prune(14);
    c.check(!existsSync(oldRun), "C32: prune removes a 60-day-old run dir");
    c.check(existsSync(notARun), "C32: prune leaves a non-run-shaped dir untouched");
    c.check(
      r14.days === 14 && r14.scanned === 1 && r14.removed.length === 1 &&
        r14.removed[0].runId === "20200101T000000Z-deadbeef" && r14.removed[0].ageDays >= 59,
      "C32: prune returns a structured result naming the run it removed and its age",
    );
  }

  // -------------------------------------------------------------------------
  // 14a. Issue #23 — the AGE RULE is newest content, not the run dir's own mtime.
  //      The regression this exists for: a long-lived run still being appended to,
  //      whose parent dir mtime does not move, silently deleted mid-run.
  // -------------------------------------------------------------------------
  {
    const dir = tmp();
    const log = new EvidenceLog({ env: envFor(dir) });
    const old = new Date(Date.now() - 60 * 86_400_000);

    // (i) dir mtime old, but a FRESH file inside ⇒ KEPT.
    const liveRun = path.join(dir, "20200101T000000Z-11111111");
    mkdirSync(path.join(liveRun, "reports"), { recursive: true });
    writeFileSync(path.join(liveRun, "calls.jsonl"), "{}\n");
    utimesSync(path.join(liveRun, "reports"), old, old);
    utimesSync(liveRun, old, old); // the dir is backdated; the file inside is NOT
    // (ii) everything old ⇒ REMOVED.
    const deadRun = path.join(dir, "20200101T000000Z-22222222");
    mkdirSync(path.join(deadRun, "reports"), { recursive: true });
    writeFileSync(path.join(deadRun, "calls.jsonl"), "{}\n");
    utimesSync(path.join(deadRun, "calls.jsonl"), old, old);
    utimesSync(path.join(deadRun, "reports"), old, old);
    utimesSync(deadRun, old, old);
    // (iii) fresh content one level DOWN (reports/) also keeps the run.
    const nestedRun = path.join(dir, "20200101T000000Z-33333333");
    mkdirSync(path.join(nestedRun, "reports"), { recursive: true });
    writeFileSync(path.join(nestedRun, "reports", "note.md"), "x");
    utimesSync(nestedRun, old, old);

    const rAge = log.prune(14);
    c.check(existsSync(liveRun), "#23 age: a backdated dir with a FRESH file inside is KEPT");
    c.check(!existsSync(deadRun), "#23 age: a run whose newest content is old is removed");
    c.check(existsSync(nestedRun), "#23 age: fresh content inside reports/ keeps the run");
    c.check(rAge.kept === 2 && rAge.removed.length === 1, "#23 age: the result counts kept vs removed");
    c.check(rAge.freedBytes >= 3, "#23: freedBytes reports the reclaimed size of the removed run");
  }

  // -------------------------------------------------------------------------
  // 14b. Issue #23 — prune SCOPE fences: symlinks, non-dirs, nothing outside the root.
  // -------------------------------------------------------------------------
  {
    const dir = tmp();
    const outside = tmp(); // a sibling tree that must never be touched
    const victim = path.join(outside, "precious");
    mkdirSync(victim, { recursive: true });
    writeFileSync(path.join(victim, "keep.txt"), "do not delete");
    const old = new Date(Date.now() - 60 * 86_400_000);
    utimesSync(path.join(victim, "keep.txt"), old, old);
    utimesSync(victim, old, old);
    // A run-id-shaped SYMLINK in the logs dir pointing at that tree.
    const link = path.join(dir, "20200101T000000Z-4444beef");
    symlinkSync(victim, link);
    // A run-id-shaped FILE (not a dir) — also not a run.
    const stray = path.join(dir, "20200101T000000Z-5555beef.txt");
    writeFileSync(stray, "x");
    utimesSync(stray, old, old);

    const rScope = new EvidenceLog({ env: envFor(dir) }).prune(14);
    c.check(existsSync(link), "#23 scope: a run-id-shaped SYMLINK is not followed and not removed");
    c.check(existsSync(path.join(victim, "keep.txt")), "#23 scope: the symlink's target tree is untouched");
    c.check(existsSync(stray), "#23 scope: a run-id-shaped FILE is not removed");
    c.check(rScope.scanned === 0 && rScope.removed.length === 0, "#23 scope: neither is counted as a run");
  }

  // -------------------------------------------------------------------------
  // 14c. Issue #23 — dry run reports without deleting; `latest` stops dangling.
  // -------------------------------------------------------------------------
  {
    const dir = tmp();
    const log = new EvidenceLog({ env: envFor(dir) });
    const oldRun = path.join(dir, "20200101T000000Z-66666666");
    mkdirSync(oldRun, { recursive: true });
    writeFileSync(path.join(oldRun, "calls.jsonl"), "{}\n");
    const old = new Date(Date.now() - 60 * 86_400_000);
    utimesSync(path.join(oldRun, "calls.jsonl"), old, old);
    utimesSync(oldRun, old, old);
    symlinkSync("20200101T000000Z-66666666", path.join(dir, "latest"));

    const dry = log.prune(14, { dryRun: true });
    c.check(dry.dryRun && dry.removed.length === 1, "#23 dry-run: reports the run it would remove");
    c.check(existsSync(oldRun), "#23 dry-run: deletes NOTHING");
    c.check(log.latest() === "20200101T000000Z-66666666", "#23 dry-run: leaves `latest` alone");

    const wet = log.prune(14);
    c.check(!existsSync(oldRun) && wet.removed.length === 1, "#23: the same call without dryRun removes it");
    c.check(log.latest() === undefined, "#23: a `latest` left dangling by a prune is dropped");
  }

  // -------------------------------------------------------------------------
  // 14d. Issue #23 — retention() resolution (C35 order) and the fail-safe on a typo.
  // -------------------------------------------------------------------------
  {
    const dir = tmp();
    const guildDir = tmp();
    writeFileSync(path.join(guildDir, "modelguild.conf.local"), "GUILD_LOG_RETENTION_DAYS=3\n");
    const mk = (extra: Record<string, string> = {}) =>
      new EvidenceLog({ env: envForNoLogDir({ GUILD_LOG_DIR: dir, ...extra }), guildDir });

    const dflt = new EvidenceLog({ env: envForNoLogDir({ GUILD_LOG_DIR: dir }) }).retention();
    c.check(dflt.days === 14 && dflt.source === "default" && dflt.valid,
      "#23 retention: the default window is 14 days");
    const conf = mk().retention();
    c.check(conf.days === 3 && conf.source === "conf", "#23 retention: modelguild.conf.local beats the default");
    const envWins = mk({ GUILD_LOG_RETENTION_DAYS: "7" }).retention();
    c.check(envWins.days === 7 && envWins.source === "env", "#23 retention: env beats the conf file (C35)");
    const zero = mk({ GUILD_LOG_RETENTION_DAYS: "0" }).retention();
    c.check(zero.days === 0 && zero.valid, "#23 retention: an explicit 0 is VALID and means disabled");
    const typo = mk({ GUILD_LOG_RETENTION_DAYS: "fourteen" }).retention();
    c.check(typo.days === 0 && !typo.valid, "#23 retention: an unparseable value is invalid ⇒ disabled, not 14");

    // A typo must NOT delete — the fail-safe direction.
    const oldRun = path.join(dir, "20200101T000000Z-77777777");
    mkdirSync(oldRun, { recursive: true });
    const old = new Date(Date.now() - 600 * 86_400_000);
    utimesSync(oldRun, old, old);
    const rBad = mk({ GUILD_LOG_RETENTION_DAYS: "fourteen" }).prune();
    c.check(existsSync(oldRun) && rBad.reason === "disabled" && !!rBad.invalidSetting,
      "#23 retention: prune() on an unparseable window deletes nothing and says why");
    const rZero = mk({ GUILD_LOG_RETENTION_DAYS: "0" }).prune();
    c.check(existsSync(oldRun) && rZero.reason === "disabled", "C32: 0 disables pruning");
    const rNeg = new EvidenceLog({ env: envForNoLogDir({ GUILD_LOG_DIR: dir }) }).prune(-1);
    c.check(existsSync(oldRun) && rNeg.reason === "disabled", "#23: a negative explicit window disables, never inverts");
  }

  // -------------------------------------------------------------------------
  // 14e. Issue #23 — enforceRetentionOnStart: the server-start hook.
  // -------------------------------------------------------------------------
  {
    const dir = tmp();
    const mkOld = (name: string): string => {
      const p = path.join(dir, name);
      mkdirSync(p, { recursive: true });
      writeFileSync(path.join(p, "calls.jsonl"), "{}\n");
      const old = new Date(Date.now() - 60 * 86_400_000);
      utimesSync(path.join(p, "calls.jsonl"), old, old);
      utimesSync(p, old, old);
      return p;
    };

    // (i) logging OFF ⇒ the hook is a NO-OP. A user who froze the log keeps it.
    const frozen = mkOld("20200101T000000Z-88888888");
    const offRes = enforceRetentionOnStart({
      env: envForNoLogDir({ GUILD_LOG_DIR: dir, GUILD_LOG: "off" }),
    });
    c.check(offRes === null && existsSync(frozen),
      "#23 on-start: GUILD_LOG=off ⇒ the hook returns null and deletes nothing");

    // (ii) logging on ⇒ the configured window is applied.
    const onRes = enforceRetentionOnStart({ env: envForNoLogDir({ GUILD_LOG_DIR: dir }) });
    c.check(!!onRes && onRes.removed.length === 1 && !existsSync(frozen),
      "#23 on-start: with logging on, a run past the window is removed");
    c.check(!!onRes && onRes.days === 14,
      "#23 on-start: uses the SAME resolved window as every other prune path");

    // (iii) retention disabled ⇒ no-op, not a surprise delete.
    const kept = mkOld("20200101T000000Z-99999999");
    const disabled = enforceRetentionOnStart({
      env: envForNoLogDir({ GUILD_LOG_DIR: dir, GUILD_LOG_RETENTION_DAYS: "0" }),
    });
    c.check(!!disabled && disabled.reason === "disabled" && existsSync(kept),
      "#23 on-start: GUILD_LOG_RETENTION_DAYS=0 ⇒ nothing is removed");

    // (iv) a logs dir that does not exist is reported, never thrown.
    const missing = enforceRetentionOnStart({
      env: envForNoLogDir({ GUILD_LOG_DIR: path.join(dir, "nope", "nowhere") }),
    });
    c.check(!!missing && missing.reason === "no-log-dir", "#23 on-start: a missing logs dir is non-fatal");
  }

  // -------------------------------------------------------------------------
  // 14f. Issue #23 — C33 partitioning is honored: the hook prunes only the CURRENT
  //      project's partition, never a neighbouring project's.
  // -------------------------------------------------------------------------
  {
    const base = tmp();
    const guildDir = path.join(base, "modelguild");
    mkdirSync(guildDir, { recursive: true });
    const projA = path.join(tmp(), "projA");
    const projB = path.join(tmp(), "projB");
    mkdirSync(projA, { recursive: true });
    mkdirSync(projB, { recursive: true });
    gitInit(projA);
    gitInit(projB);
    const partEnv = envForNoLogDir({ GUILD_LOG_PARTITION: "1" });
    const logA = new EvidenceLog({ env: partEnv, cwd: projA, guildDir });
    const logB = new EvidenceLog({ env: partEnv, cwd: projB, guildDir });
    const old = new Date(Date.now() - 60 * 86_400_000);
    const stale = (root: string): string => {
      const p = path.join(root, "20200101T000000Z-aaaaaaaa");
      mkdirSync(p, { recursive: true });
      utimesSync(p, old, old);
      return p;
    };
    mkdirSync(logA.logDir(), { recursive: true });
    mkdirSync(logB.logDir(), { recursive: true });
    const staleA = stale(logA.logDir());
    const staleB = stale(logB.logDir());

    const rPart = enforceRetentionOnStart({ env: partEnv, cwd: projA, guildDir });
    c.check(!!rPart && rPart.dir === logA.logDir(), "#23 C33: the hook scans the CURRENT project's partition");
    c.check(!existsSync(staleA), "#23 C33: the current partition's stale run is removed");
    c.check(existsSync(staleB), "#23 C33: another project's partition is out of scope and untouched");
  }

  // -------------------------------------------------------------------------
  // 14g. Issue #23 — the `modelguild logs clean` CLI surface.
  // -------------------------------------------------------------------------
  {
    const dir = tmp();
    const project = tmp();
    const seed = (name: string, ageDays: number): string => {
      const p = path.join(dir, name);
      mkdirSync(p, { recursive: true });
      writeFileSync(path.join(p, "calls.jsonl"), "{}\n");
      const t = new Date(Date.now() - ageDays * 86_400_000);
      utimesSync(path.join(p, "calls.jsonl"), t, t);
      utimesSync(p, t, t);
      return p;
    };
    const baseEnv = (extra: Record<string, string> = {}) =>
      envForNoLogDir({ GUILD_LOG_DIR: dir, ...extra });

    const oldRun = seed("20200101T000000Z-bbbbbbbb", 60);
    const freshRun = seed("20200101T000000Z-cccccccc", 1);

    // --dry-run: exit 0, names the run, deletes nothing.
    const dry = await captureCli(["--dry-run", "--dir", project], baseEnv());
    c.check(dry.code === 0 && existsSync(oldRun), "#23 CLI: --dry-run exits 0 and deletes nothing");
    c.check(dry.out.includes("would remove") && dry.out.includes("20200101T000000Z-bbbbbbbb"),
      "#23 CLI: --dry-run names the run it would remove");
    c.check(dry.out.includes("14 day(s) (default)"), "#23 CLI: reports the window and where it came from");

    // Real run: removes the stale one, keeps the fresh one.
    const wet = await captureCli(["--dir", project], baseEnv());
    c.check(wet.code === 0 && !existsSync(oldRun) && existsSync(freshRun),
      "#23 CLI: clean removes only the run past the window");
    c.check(wet.out.includes("removed") && wet.out.includes("kept"), "#23 CLI: prints what it removed and kept");

    // --days overrides the configured window.
    const frac = await captureCli(["--days", "0.5", "--dir", project], baseEnv());
    c.check(frac.code === 2, "#23 CLI: --days rejects a non-integer");
    const d1 = await captureCli(["--days", "1", "--dir", project], baseEnv());
    c.check(d1.code === 0 && d1.out.includes("(--days)"), "#23 CLI: --days N overrides the configured window");

    // Refusals — the never-delete-everything rule.
    const zero = await captureCli(["--days", "0", "--dir", project], baseEnv());
    c.check(zero.code === 2 && /DISABLES retention/.test(zero.out),
      "#23 CLI: --days 0 is REFUSED (it would delete the whole log)");
    const offWindow = await captureCli(["--dir", project], baseEnv({ GUILD_LOG_RETENTION_DAYS: "0" }));
    c.check(offWindow.code === 2 && /retention is disabled/.test(offWindow.out),
      "#23 CLI: a disabled retention window is refused, not defaulted");
    const typo = await captureCli(["--dir", project], baseEnv({ GUILD_LOG_RETENTION_DAYS: "two weeks" }));
    c.check(typo.code === 2 && /not a whole number of days/.test(typo.out),
      "#23 CLI: an unreadable retention setting is refused with the reason");
    const bogus = await captureCli(["--nope"], baseEnv());
    c.check(bogus.code === 2 && /unknown argument/.test(bogus.out), "#23 CLI: an unknown flag exits 2");

    // A logs dir that does not exist yet: reported, exit 0 (nothing is wrong).
    const empty = await captureCli(["--dir", project], baseEnv({ GUILD_LOG_DIR: path.join(dir, "not-created") }));
    c.check(empty.code === 0 && /does not exist yet/.test(empty.out),
      "#23 CLI: a missing logs dir is reported, not an error");
  }

  // -------------------------------------------------------------------------
  // 14h. Issue #23 — the WIRING: a real `src/server.ts` process prunes on start.
  //      14e proves the hook; only this proves server.ts actually calls it. Offline:
  //      the prune happens before `connect`, and no opencode child is ever spawned —
  //      the process exits on the stdin EOF we hand it.
  // -------------------------------------------------------------------------
  {
    const dir = tmp();
    const oldRun = path.join(dir, "20200101T000000Z-eeeeeeee");
    mkdirSync(oldRun, { recursive: true });
    writeFileSync(path.join(oldRun, "calls.jsonl"), "{}\n");
    const old = new Date(Date.now() - 60 * 86_400_000);
    utimesSync(path.join(oldRun, "calls.jsonl"), old, old);
    utimesSync(oldRun, old, old);
    const freshRun = path.join(dir, "20200101T000000Z-ffffffff");
    mkdirSync(freshRun, { recursive: true });

    const child = spawn(tsxBin, [path.join(repoRoot, "src", "server.ts")], {
      env: envForNoLogDir({ GUILD_LOG_DIR: dir }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.stdin.end(); // EOF ⇒ the documented teardown trigger
    const status = await new Promise<number>((resolve) => {
      const t = setTimeout(() => { child.kill("SIGKILL"); resolve(-1); }, 30_000);
      child.on("close", (code) => { clearTimeout(t); resolve(code ?? -1); });
    });

    c.check(status === 0, `#23 wiring: src/server.ts starts and exits cleanly on stdin EOF (exit ${status})`);
    c.check(!existsSync(oldRun), "#23 wiring: a REAL server start pruned the run past the window");
    c.check(existsSync(freshRun), "#23 wiring: the fresh run survived the server start");
    c.check(/log retention — removed 1 run\(s\)/.test(stderr),
      "#23 wiring: the server reports the prune on STDERR (stdout is the MCP channel)");
  }

  // -------------------------------------------------------------------------
  // 14i. Issues #23 × #19 — retention under LAYERED roots: the window is READ across
  //      every layer, but only the PRIMARY root's logs/ is pruned. The failure this
  //      guards is a project's server start deleting runs out of the GLOBAL root,
  //      which is not a root it ever writes to.
  // -------------------------------------------------------------------------
  {
    const globalRoot = tmp();
    const projectRoot = tmp();
    const old = new Date(Date.now() - 60 * 86_400_000);
    const seedRun = (root: string): string => {
      const p = path.join(root, "logs", "20200101T000000Z-dddddddd");
      mkdirSync(p, { recursive: true });
      writeFileSync(path.join(p, "calls.jsonl"), "{}\n");
      utimesSync(path.join(p, "calls.jsonl"), old, old);
      utimesSync(p, old, old);
      return p;
    };
    const globalStale = seedRun(globalRoot);
    const projectStale = seedRun(projectRoot);

    // Only the GLOBAL layer sets the knob; the project layer is silent about it.
    writeFileSync(path.join(globalRoot, "modelguild.conf.local"), "GUILD_LOG_RETENTION_DAYS=1\n");
    const layers = [projectRoot, globalRoot]; // most-specific first, as layeredRoots() returns
    const layered = new EvidenceLog({
      env: envForNoLogDir(),
      guildDir: projectRoot,
      guildDirs: layers,
    });
    c.check(layered.retention().days === 1 && layered.retention().source === "conf",
      "#23×#19: a GLOBAL-only retention setting binds in a project that never restates it");
    c.check(layered.logDir() === path.join(projectRoot, "logs"),
      "#23×#19: writes/logDir still derive from the PRIMARY root alone");

    const r = enforceRetentionOnStart({
      env: envForNoLogDir(),
      guildDir: projectRoot,
      guildDirs: layers,
    });
    c.check(!!r && r.dir === path.join(projectRoot, "logs") && r.removed.length === 1,
      "#23×#19: the start hook prunes the PRIMARY root's logs, using the global window");
    c.check(!existsSync(projectStale), "#23×#19: the primary root's stale run is removed");
    c.check(existsSync(globalStale),
      "#23×#19: the GLOBAL layer's logs are NOT pruned by a project's server start");

    // The project layer overrides the global one, last-wins, as for every other key.
    writeFileSync(path.join(projectRoot, "modelguild.conf.local"), "GUILD_LOG_RETENTION_DAYS=90\n");
    const overridden = new EvidenceLog({
      env: envForNoLogDir(),
      guildDir: projectRoot,
      guildDirs: layers,
    });
    c.check(overridden.retention().days === 90,
      "#23×#19: a project retention setting overrides the global baseline");
    // …and env still beats both (C35 order survives layering).
    const envWins = new EvidenceLog({
      env: envForNoLogDir({ GUILD_LOG_RETENTION_DAYS: "5" }),
      guildDir: projectRoot,
      guildDirs: layers,
    });
    c.check(envWins.retention().days === 5 && envWins.retention().source === "env",
      "#23×#19: env still beats every conf layer (C35)");
  }

  // -------------------------------------------------------------------------
  // 15. run-id format + fresh-id-even-when-GUILD_RUN_ID-set + latest symlink.
  // -------------------------------------------------------------------------
  {
    const dir = tmp();
    const r1 = new EvidenceLog({ env: envFor(dir) }).newRun("/guild:consult");
    c.check(/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/.test(r1), "run-id: matches YYYYMMDDTHHMMSSZ-<8hex>");
    // new-run mints fresh even with an ambient GUILD_RUN_ID.
    const r2 = new EvidenceLog({ env: envFor(dir, { GUILD_RUN_ID: r1 }) }).newRun("/guild:panel");
    c.check(r2 !== "" && r2 !== r1, "newRun: mints a fresh id even when GUILD_RUN_ID is set");
    // latest points at the most recent run.
    c.check(new EvidenceLog({ env: envFor(dir) }).latest() === r2, "latest: resolves the most recent run id");
  }

  // -------------------------------------------------------------------------
  // 16. C33 — partitioning: same-basename projects distinguished by path-hash suffix;
  //     OFF ⇒ flat; explicit GUILD_LOG_DIR disables partitioning.
  // -------------------------------------------------------------------------
  {
    const base = tmp();
    const guildDir = path.join(base, "modelguild");
    mkdirSync(guildDir, { recursive: true });
    const baseLogs = path.join(guildDir, "logs");
    // Two same-basename project roots under different parents.
    const sharedA = path.join(tmp(), "proj");
    const sharedB = path.join(tmp(), "proj");
    mkdirSync(sharedA, { recursive: true });
    mkdirSync(sharedB, { recursive: true });
    gitInit(sharedA); gitInit(sharedB);
    const mk = (cwd: string) =>
      new EvidenceLog({ env: envForNoLogDir({ GUILD_LOG_PARTITION: "1" }), cwd, guildDir });
    const rA = mk(sharedA).newRun("/guild:consult");
    const dirA = mk(sharedA).dir(rA);
    const rB = mk(sharedB).newRun("/guild:consult");
    const dirB = mk(sharedB).dir(rB);
    const keyA = dirA.slice(baseLogs.length + 1).split("/")[0];
    const keyB = dirB.slice(baseLogs.length + 1).split("/")[0];
    c.check(
      dirA.startsWith(baseLogs + "/") && keyA !== rA && dirA === path.join(baseLogs, keyA, rA),
      "C33: PARTITION=1 places a run under <base>/<project-key>/<run>",
    );
    c.check(
      keyA !== keyB && keyA.startsWith("proj-") && keyB.startsWith("proj-"),
      "C33: same-basename projects get DISTINCT keys via the path-hash suffix",
    );
    // OFF ⇒ flat under base.
    const off = new EvidenceLog({ env: envForNoLogDir(), cwd: sharedA, guildDir });
    const rOff = off.newRun("/guild:consult");
    c.check(off.dir(rOff) === path.join(baseLogs, rOff), "C33: partitioning OFF ⇒ run lands directly in base logs dir");
    // explicit GUILD_LOG_DIR beats PARTITION=1.
    const explicit = tmp();
    const ex = new EvidenceLog({ env: envFor(explicit, { GUILD_LOG_PARTITION: "1" }), cwd: sharedA, guildDir });
    const rE = ex.newRun("/guild:consult");
    c.check(ex.dir(rE) === path.join(explicit, rE), "C33: explicit GUILD_LOG_DIR disables partitioning");
  }

  // -------------------------------------------------------------------------
  // 17. C35 — config resolution env > modelguild.conf.local > default (confGet + live).
  // -------------------------------------------------------------------------
  {
    // confGet parsing (the parser the whole config layer shares).
    const conf = [
      "# comment",
      "  GUILD_LOG_PROMPTS = hash   # inline comment",
      'GUILD_MODEL="openai/gpt-5"',
      "GUILD_MODEL='second-wins'",
      "no_equals_line",
    ].join("\n");
    c.check(confGet(conf, "GUILD_LOG_PROMPTS") === "hash", "C35: confGet strips whitespace + inline comment");
    c.check(confGet(conf, "GUILD_MODEL") === "second-wins", "C35: confGet — last assignment wins, quotes stripped");
    c.check(confGet(conf, "ABSENT") === "", "C35: confGet returns empty for an absent key");

    // Live: a config file sets GUILD_LOG_PROMPTS=off; a started entry records no prompt.
    const base = tmp();
    const guildDir = path.join(base, "modelguild");
    mkdirSync(guildDir, { recursive: true });
    writeFileSync(path.join(guildDir, "modelguild.conf.local"), "GUILD_LOG_PROMPTS=off\n");
    const logDir = path.join(guildDir, "logs");
    const log = new EvidenceLog({ env: { ...cleanEnv(), GUILD_LOG_DIR: logDir, GUILD_RUN_ID: "r" } as NodeJS.ProcessEnv, guildDir });
    await log.expect({ callId: "p", model: "m/x", agent: "guild-read" });
    const st = await log.started({ callId: "p", model: "m/x", agent: "guild-read", prompt: "SENTINEL-abc123" });
    const started = parsed(path.join(logDir, "r", "calls.jsonl")).find((e) => e.status === "started")!;
    c.check(started.prompt === null && started.prompt_hash === null, "C35: GUILD_LOG_PROMPTS honored from modelguild.conf.local");
    // env overrides the file.
    const log2 = new EvidenceLog({ env: { ...cleanEnv(), GUILD_LOG_DIR: logDir, GUILD_RUN_ID: "r2", GUILD_LOG_PROMPTS: "full" } as NodeJS.ProcessEnv, guildDir });
    await log2.expect({ callId: "p", model: "m/x", agent: "guild-read" });
    await log2.started({ callId: "p", model: "m/x", agent: "guild-read", prompt: "SENTINEL-abc123" });
    void st;
    const started2 = parsed(path.join(logDir, "r2", "calls.jsonl")).find((e) => e.status === "started")!;
    c.check(started2.prompt === "SENTINEL-abc123", "C35: env GUILD_LOG_PROMPTS overrides the config file");
  }

  // -------------------------------------------------------------------------
  // 18. C34 — three GENUINELY-CONCURRENT writer processes get distinct turns, 9 intact
  //     JSONL lines, and the run verifies. Proves the mkdir lock under real contention.
  //
  //     Spawned via async `spawn` (NOT spawnSync-in-a-Promise, which blocks the event
  //     loop and runs children in series — a lock is never contended, so the test would
  //     pass with no lock at all). Each child holds between its appends and prints its
  //     wall-clock span; the test ASSERTS OVERLAP (all three alive at one instant), which
  //     is impossible under serialization. This is the "guarantee holds only where
  //     tested" trap the repo memory names, closed.
  // -------------------------------------------------------------------------
  {
    const dir = tmp();
    const runId = new EvidenceLog({ env: envFor(dir) }).newRun("/guild:panel");
    const hold = "150";
    const results = await Promise.all(
      ["k1", "k2", "k3"].map((cid) =>
        spawnAsync(tsxBin, [CHILD], envFor(dir, { GUILD_RUN_ID: runId, CHILD_CALL_ID: cid, GUILD_TEST_HOLD_MS: hold })),
      ),
    );
    const file = path.join(dir, runId, "calls.jsonl");
    const es = parsed(file);
    const turns = new Set(es.filter((e) => e.status === "started").map((e) => e.turn));
    const spans = results.map((r) => parseSpan(r.stdout)).filter((s): s is { start: number; end: number } => !!s);
    // Genuine overlap: the LATEST start precedes the EARLIEST end ⇒ at some instant all
    // three children were alive at once. Under serialization each start ≥ the prior end,
    // so latestStart ≥ earliestEnd and this fails.
    const latestStart = Math.max(...spans.map((s) => s.start));
    const earliestEnd = Math.min(...spans.map((s) => s.end));
    const overlapped = spans.length === 3 && latestStart < earliestEnd;

    c.check(results.every((r) => r.status === 0), "C34: all 3 concurrent writer processes exited 0");
    c.check(overlapped, `C34: the 3 writers genuinely OVERLAP (latestStart ${latestStart} < earliestEnd ${earliestEnd})`);
    c.check(es.length === 9, "C34: 3 concurrent lifecycles ⇒ 9 intact JSONL lines (no torn appends)");
    c.check(turns.size === 3, "C34: concurrent started entries get 3 DISTINCT turns (turn counted inside the lock)");
    c.check(new EvidenceLog({ env: envFor(dir) }).verify(runId).ok, "C34: the concurrent run verifies");
    console.log(`    [overlap evidence] spans: ${spans.map((s) => `${s.start % 100000}..${s.end % 100000}`).join(", ")} → latestStart ${latestStart % 100000} < earliestEnd ${earliestEnd % 100000}`);
  }

  // -------------------------------------------------------------------------
  // 19. Issue #73 — a runId is a DIRECTORY NAME under the logs root, so it is validated
  //     at the single choke point (`#resolveRun`) on BOTH supplied paths: the caller's
  //     argument and `$GUILD_RUN_ID`. Before this it was used verbatim, so `../../..`
  //     wrote calls.jsonl / activity.jsonl / delegate patches outside the root.
  //
  //     The posture is fail-LOUD, never a silent fresh-run fallback: a caller that thinks
  //     it threaded a run must not quietly be handed a different one.
  // -------------------------------------------------------------------------
  {
    // --- the grammar itself ------------------------------------------------
    const minted = new EvidenceLog({ env: envFor(tmp()) }).newRun("/guild:consult");
    const good = [
      minted,
      "20260728T055956Z-7526f9dd",
      "r",
      "run-1",
      "run_b",
      "a.b",
      "20260727T000000Z-threaded",
      "A".repeat(128),
    ];
    c.check(good.every((g) => isRunId(g)), "#73: the minted shape and conservative segments are ACCEPTED");
    const bad: unknown[] = [
      "../escape",
      "../../../../tmp/pwn",
      "/etc/passwd",
      "a/b",
      "a\\b",
      "..",
      ".",
      ".hidden",
      "a..b",
      "a\0b",
      "a\nb",
      "a b",
      "latest", // the symlink `#ensureRun` maintains beside the run dirs
      "A".repeat(129),
      "",
      42,
      null,
      { toString: () => "ok" },
    ];
    const rejected = bad.filter((v) => !isRunId(v));
    c.check(rejected.length === bad.length,
      `#73: every unsafe/ill-formed run id is REJECTED (${rejected.length}/${bad.length})`);

    // --- the argument path: nothing is written, inside or outside the root ---
    const dir = tmp();
    const escapeName = `mg73-escape-${process.pid}-${Date.now()}`;
    const escapeTarget = path.join(tmpdir(), escapeName);
    const traversal = `${"../".repeat(dir.split(path.sep).length + 3)}${path.basename(tmpdir())}/${escapeName}`;
    const log = new EvidenceLog({ env: envFor(dir) });
    let argThrew = false;
    let argRes;
    try {
      argRes = await log.expect({ callId: "call-x", command: "/guild:consult", run: traversal });
    } catch {
      argThrew = true;
    }
    c.check(!argThrew && argRes !== undefined && argRes.ok === false,
      "#73: a traversing runId argument returns ok:false (C31: never throws into the call)");
    c.check(!existsSync(escapeTarget),
      "#73: NOTHING is written outside the logs root (the pre-fix repro wrote calls.jsonl there)");
    // The escape is refused, not silently redirected into a fresh run inside the root:
    // a fallback would leave the caller's entries in a run it was never told about.
    c.check(!existsSync(path.join(dir, "latest")),
      "#73: the refused call mints NO fallback run (no `latest`, no run dir)");

    // The read-only path helpers refuse too, rather than handing back an escaping path.
    let dirThrew = false;
    try { log.dir(traversal); } catch { dirThrew = true; }
    let pathThrew = false;
    try { log.path(traversal); } catch { pathThrew = true; }
    c.check(dirThrew && pathThrew, "#73: dir()/path() refuse an invalid runId instead of returning an escaping path");

    // --- the env path: same refusal, and the error NAMES the env var --------
    const envLog = new EvidenceLog({ env: envFor(dir, { GUILD_RUN_ID: traversal }) });
    let envThrew = false;
    let envRes;
    try {
      envRes = await envLog.started({ callId: "call-y", model: "m/x", agent: "guild-read", prompt: "p" });
    } catch {
      envThrew = true;
    }
    c.check(!envThrew && envRes !== undefined && envRes.ok === false,
      "#73: a traversing $GUILD_RUN_ID returns ok:false rather than writing outside the root");
    c.check(!existsSync(escapeTarget),
      "#73: the env path writes nothing outside the logs root either");
    let envMsg = "";
    try { assertRunId(traversal, "GUILD_RUN_ID"); } catch (err) { envMsg = String(err); }
    c.check(envMsg.includes("GUILD_RUN_ID"),
      "#73: the env-path error NAMES GUILD_RUN_ID (a bare 'runId' would send the operator to the wrong knob)");

    // --- verify(): data, not an exception (the 13b posture) ----------------
    let verifyThrew = false;
    let v;
    try { v = log.verify(traversal); } catch { verifyThrew = true; }
    c.check(!verifyThrew && v !== undefined && !v.ok && v.code === 7,
      "#73: verify() on an invalid runId returns code 7, never throws");

    // --- the tool-INPUT surface (what an MCP handler returns) ---------------
    const absent = resolveRunIdArg("guild_consult", undefined);
    const empty = resolveRunIdArg("guild_consult", "");
    const ok = resolveRunIdArg("guild_consult", minted);
    const nope = resolveRunIdArg("guild_consult", traversal);
    const nonString = resolveRunIdArg("guild_delegate", 7);
    c.check("value" in absent && absent.value === undefined, "#73: resolveRunIdArg: an ABSENT runId is undefined (fresh run)");
    c.check("value" in empty && empty.value === undefined, "#73: resolveRunIdArg: an EMPTY runId keeps its 'absent' meaning");
    c.check("value" in ok && ok.value === minted, "#73: resolveRunIdArg: a valid runId passes through verbatim");
    c.check("error" in nope && nope.error.startsWith("guild_consult: runId ") && nope.error.includes("single path segment"),
      "#73: resolveRunIdArg: an invalid runId is a TOOL INPUT ERROR naming the tool, the field and the rule");
    c.check("error" in nonString && nonString.error.startsWith("guild_delegate: runId "),
      "#73: resolveRunIdArg: a non-string runId is an input error, NOT a silent fall to a fresh run");

    // --- and the good path is untouched end-to-end -------------------------
    const okDir = tmp();
    const okLog = new EvidenceLog({ env: envFor(okDir) });
    const rid = okLog.newRun("/guild:consult");
    await okLog.expect({ callId: "call-ok", command: "/guild:consult", run: rid });
    await okLog.started({ callId: "call-ok", model: "m/x", agent: "guild-read", prompt: "p", run: rid });
    await okLog.completed({ callId: "call-ok", model: "m/x", agent: "guild-read", response: "hi", captureState: "complete", run: rid });
    c.check(existsSync(path.join(okDir, rid, "calls.jsonl")) && okLog.verify(rid).ok,
      "#73: a minted run id still writes inside the root and verifies clean");
  }

  // cleanup
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`log.test: ${c.passes} passed, ${c.failures} failed`);
  return c.failures;
}

// --- local helpers ----------------------------------------------------------
/** An env with GUILD_* knobs cleared, so a test's expectations aren't perturbed by
 * the developer's shell (e.g. a real GUILD_LOG_DIR). */
function cleanEnv(): NodeJS.ProcessEnv {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (k.startsWith("GUILD_")) delete e[k];
  return e;
}
function envForNoLogDir(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...cleanEnv(), ...extra } as NodeJS.ProcessEnv;
}
function gitInit(dir: string): void {
  spawnSync("git", ["init", "-q"], { cwd: dir });
}

/** Drive `modelguild logs clean` in-process (the doctor.test idiom) with stdout/stderr
 * captured, so a refusal's WORDING can be asserted, not just its exit code. */
async function captureCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; out: string }> {
  const origLog = console.log;
  const origWarn = console.warn;
  const origErr = console.error;
  let out = "";
  const sink = (...a: unknown[]) => { out += a.join(" ") + "\n"; };
  console.log = sink;
  console.warn = sink;
  console.error = sink;
  try {
    const code = await runLogsClean(argv, { env });
    return { code, out };
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origErr;
  }
}

/** Spawn a child ASYNCHRONOUSLY (unlike spawnSync, which blocks the event loop and would
 * force children to run in series — defeating any concurrency test). Resolves with the
 * exit status and captured stdout only after the child exits, so `Promise.all` over
 * several of these runs them genuinely simultaneously. */
function spawnAsync(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ status: code ?? -1, stdout, stderr }));
    child.on("error", () => resolve({ status: -1, stdout, stderr }));
  });
}

/** Parse `START <ms> END <ms>` overlap markers a child (or shell) prints. */
function parseSpan(s: string): { start: number; end: number } | undefined {
  const m = s.match(/START (\d+) END (\d+)/);
  return m ? { start: Number(m[1]), end: Number(m[2]) } : undefined;
}
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((f) => process.exit(f > 0 ? 1 : 0));
}
