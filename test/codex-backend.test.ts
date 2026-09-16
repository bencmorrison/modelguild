/** Native Codex transport/turn semantics without Codex, auth or network. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexBackend, CodexTurnError, extractCodexTurn } from "../src/codex.js";
import { Checker, repoRoot } from "./harness.js";

export async function run(): Promise<number> {
  const c = new Checker();
  const root = mkdtempSync(path.join(tmpdir(), "guild-codex-offline-"));
  const backends: CodexBackend[] = [];
  function backend(mode = "normal") {
    const value = new CodexBackend({ cwd: root, command: process.execPath,
      args: ["--import", path.join(repoRoot, "node_modules/tsx/dist/loader.mjs"), path.join(repoRoot, "test/codex-backend-fixture.ts")],
      env: { ...process.env, GUILD_CODEX_FIXTURE_DIR: root, GUILD_CODEX_FIXTURE_MODE: mode }, requestTimeoutMs: 2000, interruptTimeoutMs: 100 });
    backends.push(value); return value;
  }
  const turn = (value: CodexBackend, extra = {}) => value.turn({ cwd: root, model: "native-model", prompt: "synthetic", ...extra });
  async function rejects(run: () => Promise<unknown>, fragment: string, label: string) {
    try { await run(); c.check(false, label); } catch (error) { c.check(String(error).includes(fragment), `${label}: ${String(error)}`); return error; }
  }
  try {
    const missing = new CodexBackend({ cwd: root, command: path.join(root, "missing-codex") });
    backends.push(missing);
    await rejects(() => missing.models(), "Cannot start Codex", "missing executable names the native backend");
    const api = backend();
    const models = await api.models();
    c.check(models.map(m => m.id).join() === "a,b" && models[0].isDefault, "catalog paginates and preserves default marker");
    const account = await api.account();
    c.check(account.authenticated === true && !JSON.stringify(account).includes("email"), "auth status does not expose account details");
    const events: Array<Record<string, unknown>> = [];
    const first = await turn(api, { onEvent: (_method: string, params: Record<string, unknown>) => events.push(params) });
    c.check(events.length > 0 && events.every(event => event.turnId !== "a-prior-turn"), "activity sink receives only exact current-turn events including early buffered events");
    c.check(first.text === 'answer\n"quoted" café\n', "answer preserves exact transcript bytes");
    c.check(first.toolCallCount === 1 && first.byTool.commandExecution === 1, "tool census dedupes observed notifications when history omits tools");
    c.check(first.runtime.approvalPolicy === "on-request", "resolved native permission facts returned without invented floor");
    c.check(first.items.every(item => item.type !== "commandExecution") && first.eventItems?.some(item => item.type === "commandExecution") === true, "history and notification items retain distinct provenance");
    c.check(first.runtime.toolTranscriptSource?.includes("no post-turn replay") === true, "tool capture limitation is explicit even when stream count is nonzero");
    c.check(first.turn === 1, "completion before start response is not lost");
    const next = await turn(api, { sessionId: first.sessionId });
    c.check(next.turn === 2 && next.sessionId === first.sessionId && next.turnId !== first.turnId, "continuation resumes thread and selects its new turn");
    const session = await api.session(first.sessionId);
    c.check(session.cwd === root && session.model === "native-model", "session exposes authoritative root and configured model");
    const empty = await turn(backend("empty"), { sessionId: first.sessionId });
    c.check(empty.text === "" && empty.turn === 3, "empty continuation never inherits preceding answer");
    await api.release(first.sessionId);
    c.check(readFileSync(path.join(root, "archived"), "utf8").includes(first.sessionId), "release archives rather than claims deletion");
    const wire = readFileSync(path.join(root, "wire.jsonl"), "utf8").trim().split("\n").map(s => JSON.parse(s));
    const started = wire.find(f => f.method === "thread/start").params;
    c.check(started.ephemeral === false && started.historyMode === "legacy" && started.allowProviderModelFallback === false, "durable complete readback and exact requested model");
    c.check(!("sandbox" in started) && !("approvalPolicy" in started), "normal configured sandbox and approvals inherited");
    const approved = await turn(backend("approval"), { approve: async () => "accept" as const });
    c.check(approved.text === "accepted", "native command approval is routed to callback");
    const declined = await turn(backend("approval"), { approve: async () => "decline" as const });
    c.check(declined.text === "declined", "native decline response reaches worker");
    await rejects(() => turn(backend("approval")), "no approval channel", "missing approval channel yields named failure");
    await rejects(() => turn(backend("unsupported")), "Unsupported Codex interactive request", "unsupported request is refused visibly");
    await rejects(() => turn(backend("model-mismatch")), "instead of requested", "resolved model mismatch refuses before running a turn");
    const timed = await rejects(() => turn(backend("wait"), { messageTimeoutMs: 25 }), "timed out", "deadline interrupts and waits terminal completion");
    c.check(timed instanceof CodexTurnError && timed.result?.text === "partial bytes\n" && timed.result.status === "interrupted", "interrupt failure retains exact partial transcript");
    const both = backend("slow"); const controller = new AbortController();
    const aborted = turn(both, { signal: controller.signal });
    const untouched = turn(both);
    setTimeout(() => controller.abort(), 160);
    const stopped = await rejects(() => aborted, "cancelled", "abort cancels its turn");
    c.check(stopped instanceof CodexTurnError && (await untouched).text.startsWith("answer"), "another concurrent turn survives cancellation");
    await rejects(() => turn(backend("descendant"), { messageTimeoutMs: 40 }), "timed out", "timeout stops native children outside the app-server process group");
    const descendantPids = readFileSync(path.join(root, "descendant-pids"), "utf8").trim().split("\n").map(Number);
    c.check(descendantPids.every(pid => {
      const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
      return !result.stdout.trim() || result.stdout.trim().startsWith("Z");
    }) && !existsSync(path.join(root, "late-write")), "detached descendants cannot execute after the turn returns");
    const pendingStartAt = Date.now();
    await rejects(() => turn(backend("lost-start"), { messageTimeoutMs: 25 }), "timed out", "deadline stops a turn with a lost start response");
    c.check(Date.now() - pendingStartAt < 1500, "lost turn/start is bounded by turn deadline, not generic RPC timeout");
    const stuck = await rejects(() => turn(backend("ignore-interrupt"), { messageTimeoutMs: 25 }), "process group terminated", "unconfirmed interrupt is forcibly stopped");
    c.check(stuck instanceof CodexTurnError && !stuck.result, "unconfirmed interruption does not invent a transcript");
    await rejects(() => turn(backend("crash")), "Codex", "child crash rejects promptly");
    await rejects(() => turn(backend("malformed")), "JSON", "malformed transport fails instead of silently skipping evidence");
    for (const variant of [{ turns: [] }, { turns: [{ id: "x", itemsView: "summary", items: [] }] }]) {
      try { extractCodexTurn(variant, "x"); c.check(false, "invalid transcript refused"); } catch { c.check(true, "missing turn or incomplete transcript refused"); }
    }
    const sample = extractCodexTurn({ turns: [{ id: "old", itemsView: "full", status: "completed", items: [{ type: "agentMessage", text: "BANANA" }] },
      { id: "new", itemsView: "full", status: "completed", items: [{ type: "agentMessage", text: "commentary", phase: "commentary" }, { type: "contextCompaction" }, { type: "agentMessage", text: "exact\n", phase: "final_answer" }, { type: "agentMessage", text: "later commentary", phase: "commentary" }] }] }, "new");
    c.check(sample.text === "exact\n", "final answer wins over commentary and compaction");
  } finally {
    await Promise.all(backends.map(value => value.shutdown()));
    const pids = readFileSync(path.join(root, "pids"), "utf8").trim().split("\n").map(Number);
    c.check(pids.every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } }), "all app-server fixture children are reaped");
    rmSync(root, { recursive: true, force: true });
  }
  console.log(`codex-backend.test: ${c.passes} passed, ${c.failures} failed`);
  return c.failures;
}
if (import.meta.url === `file://${process.argv[1]}`) run().then(failures => process.exit(failures ? 1 : 0));
