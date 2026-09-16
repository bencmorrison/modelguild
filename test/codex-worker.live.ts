/** Opt-in real native Codex workers through production ModelGuild tool entry points.
 * Requires explicitly named native and opencode models and existing logins; consumes
 * real usage. Keeps a disposable repo and receipts. Native sandbox policy is inherited.
 * Only the fixture's exact cat/cp/cmp shell approval shapes are accepted automatically;
 * any different request is declined and printed for diagnosis. No sandbox bypass.
 * This is tool orchestration coverage, not MCP client UI rendering or a cancellation proof.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { CodexBackend } from "../src/codex.js";
import { OpencodeLifecycle } from "../src/lifecycle.js";
import { ServePool } from "../src/servepool.js";
import { consult } from "../src/consult.js";
import { research } from "../src/research.js";
import { delegate } from "../src/delegate.js";
import { panel } from "../src/panel.js";
import { EvidenceLog } from "../src/log.js";
import { init } from "../src/init.js";
import { fixtureGitEnv, repoRoot } from "./harness.js";

const nativeModel = process.env.GUILD_LIVE_CODEX_MODEL;
const openModel = process.env.GUILD_LIVE_OPENCODE_MODEL;
assert(nativeModel?.startsWith("codex/") && openModel && !openModel.startsWith("codex/"), "Set GUILD_LIVE_CODEX_MODEL=codex/<model> and GUILD_LIVE_OPENCODE_MODEL=<provider/model>; this test consumes real usage.");
const root = mkdtempSync(path.join(os.tmpdir(), "guild-native-live-"));
console.log("Retained native live artifacts:", root);
const project = path.join(root, "project"), sibling = path.join(root, "sibling"); mkdirSync(project);
const git = (...args: string[]) => execFileSync("git", ["-C", project, ...args], { env: fixtureGitEnv(), stdio: "pipe" });
git("init", "-q");
init({ targetDir: project, packageRoot: repoRoot, driver: "codex", serverLaunch: { command: process.execPath, args: [path.join(repoRoot, "dist/cli.js"), "serve"] } });
const marker = "NATIVE227_KIWI"; writeFileSync(path.join(project, "note.txt"), `${marker}\n`);
git("add", "."); git("commit", "-qm", "Synthetic native fixture"); git("worktree", "add", "-qb", "native-worker", sibling);
const env: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("GUILD_")) delete env[key];
Object.assign(env, { GUILD_ROOT: path.join(project, "modelguild"), GUILD_PROJECT_DIR: project, GUILD_PANEL_RETRY_EMPTY: "0" });
const codex = new CodexBackend({ cwd: project });
const serve = new OpencodeLifecycle({ projectDir: project }); const router = new ServePool(serve);
const log = new EvidenceLog({ env, cwd: project, guildDir: path.join(project, "modelguild") });
const elicitation = { available: true, async ask({ message }: { message: string; timeoutMs: number }) {
  appendFileSync(path.join(root, "approvals.jsonl"), JSON.stringify({ message }) + "\n");
  const match = message.match(/not instructions:\n(.*)\nApprove/s);
  let command = "", requestedCwd = ""; try { const request = JSON.parse(match?.[1] ?? "{}"); command = request.command ?? ""; requestedCwd = request.cwd ?? ""; } catch {}
  const shellBody = command.replace(/^\/bin\/(?:ba)?sh -lc /, "").replace(/^'(.*)'$/, "$1");
  const allowed = [project, sibling].includes(requestedCwd) && shellBody.split(/\s*&&\s*/).every(part => ["cat note.txt", "cp note.txt worker-result.txt", "cmp -s note.txt worker-result.txt"].includes(part));
  console.log("Native approval:", allowed ? "accepted fixture command" : "declined unexpected request", command);
  return allowed ? "accept" as const : "decline" as const;
} };
const deps = { codex, serve, router, env, cwd: project, elicitation, messageTimeoutMs: 180000 };
const save = (name: string, result: unknown) => { writeFileSync(path.join(root, `${name}.json`), JSON.stringify(result, null, 2)); console.log(name, (result as { ok?: boolean }).ok); };
const receipt = (runId: string, callId: string, answer: string) => {
  assert.equal(log.verify(runId).code, 0);
  const rows = readFileSync(path.join(project, "modelguild", "logs", runId, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const own = rows.filter(row => row.call_id === callId); assert.equal(own.filter(row => row.status === "completed").length, 1);
  const completed = own.find(row => row.status === "completed"); assert.equal(completed.raw_response, answer); return completed;
};
const outer = setTimeout(() => {
  console.error("Native worker smoke exceeded its 15-minute outer deadline; artifacts are retained.");
  void codex.shutdown(); // Synchronously signals native process groups before awaiting exit.
  serve.shutdown("live-smoke-deadline");
  process.exit(1); // Bound HTTP/approval waiters and prevent follow-on calls after the deadline.
}, 15 * 60_000);
try {
  const first = await consult({ question: `Remember token ${marker}. Reply with that token only. Do not use tools.`, model: nativeModel, keepSession: true }, deps); save("consult", first); assert(first.ok && first.sessionId); assert(first.answer.includes(marker)); receipt(first.attribution.runId, first.attribution.callId, first.answer);
  const next = await consult({ question: "Repeat the token from the previous turn only. Do not use tools.", sessionId: first.sessionId, runId: first.attribution.runId }, deps); save("continuation", next); assert(next.ok); assert(next.answer.includes(marker)); const continued = receipt(next.attribution.runId, next.attribution.callId, next.answer); assert.equal(continued.session_id, first.sessionId); assert(continued.runtime.turn > 1);
  const found = await research({ question: "What is 2 + 2? Reply 4 only; no tools needed.", model: nativeModel }, deps); save("research", found); assert(found.ok && found.answer.includes("4")); receipt(found.attribution.runId, found.attribution.callId, found.answer);
  const edit = await delegate({ task: "Read note.txt in the current directory and create worker-result.txt with exactly the same bytes. You may use cp note.txt worker-result.txt && cmp -s note.txt worker-result.txt && cat note.txt. Do not modify any other files. Request native permission when needed. Report the token.", model: nativeModel, worktree: sibling }, deps); save("delegate", edit); assert(edit.ok); assert.equal(readFileSync(path.join(sibling, "worker-result.txt"), "utf8"), `${marker}\n`); assert(!existsSync(path.join(project, "worker-result.txt"))); assert(edit.capture.patchPath && readFileSync(edit.capture.patchPath, "utf8").includes(marker)); receipt(edit.attribution.runId, edit.attribution.callId, edit.report);
  const mixed = await panel({ question: "Reply with the exact text MIXED227. Do not use tools.", models: [nativeModel!, openModel!] }, deps); save("mixed-panel", mixed); assert(mixed.ok); assert(mixed.results.every(member => !member.error && member.text?.includes("MIXED227")), JSON.stringify(mixed.results.map(member => ({ model: member.model, error: member.error })))); for (const member of mixed.results) receipt(mixed.runId, member.callId!, member.text!);
  console.log("PASS: production native consult, continuation, research, sibling edit, mixed panel; receipts verified.");
} finally { clearTimeout(outer); await codex.shutdown(); serve.shutdown("live-smoke-finished"); }
