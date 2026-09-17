/** Native Codex orchestration (#227), offline. The adapter itself has a separate
 * JSONL protocol suite; this suite proves policy/evidence/root/capture parity at
 * the actual production tool entry points without a model or installed Codex. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { consult } from "../src/consult.js";
import { panel } from "../src/panel.js";
import { research } from "../src/research.js";
import { delegate } from "../src/delegate.js";
import { CodexTurnError, type CodexTurnOptions, type CodexTurnResult } from "../src/codex.js";
import type { NativeBackend } from "../src/backend.js";
import { EvidenceLog } from "../src/log.js";
import { startFakeOpencode } from "./fake-opencode-server.js";
import { fixtureGitEnv, fakeServeHandle } from "./harness.js";
import type { ServeProvider } from "../src/client.js";

export async function run(): Promise<number> {
  const temp = mkdtempSync(path.join(os.tmpdir(), "native-routing-"));
  const project = path.join(temp, "project"); mkdirSync(project);
  const guild = path.join(project, "modelguild"); mkdirSync(guild);
  const logDir = path.join(temp, "logs");
  const env: NodeJS.ProcessEnv = { ...fixtureGitEnv(), GUILD_ROOT: guild, GUILD_PROJECT_DIR: project, GUILD_LOG_DIR: logDir, GUILD_AGENT_DIR: path.join(temp, "absent"), XDG_CONFIG_HOME: path.join(temp, "xdg"), GUILD_PANEL_RETRY_EMPTY: "0" };
  for (const key of Object.keys(env)) if (key.startsWith("GUILD_") && !["GUILD_ROOT", "GUILD_PROJECT_DIR", "GUILD_LOG_DIR", "GUILD_AGENT_DIR", "GUILD_PANEL_RETRY_EMPTY"].includes(key)) delete env[key];
  const git = (...args: string[]) => execFileSync("git", args, { cwd: project, env, encoding: "utf8", stdio: "pipe" });
  git("init", "-q"); writeFileSync(path.join(project, "note.txt"), "marker\n"); git("add", "."); git("commit", "-qm", "baseline");
  const sibling = path.join(temp, "sibling"); git("worktree", "add", "-qb", "native-test", sibling);
  let calls = 0;
  let mode = "answer";
  let lastOptions: CodexTurnOptions | undefined;
  const sessions = new Map<string, { cwd: string; model: string; turn: number }>();
  const released: string[] = [];
  const backend: NativeBackend = {
    async models() { return [{ id: "test-model", name: "fixture", description: "fixture", isDefault: true }]; },
    async account() { return { authenticated: true }; },
    async session(id) { const session = sessions.get(id); if (!session) throw new Error("unknown session"); return { id, ...session }; },
    async release(id) { released.push(id); }, async shutdown() {},
    async turn(options) {
      calls++; lastOptions = options;
      const id = options.sessionId ?? `thread-${calls}`;
      const previous = sessions.get(id);
      const state = { cwd: options.cwd, model: options.model, turn: (previous?.turn ?? 0) + 1 }; sessions.set(id, state);
      const result: CodexTurnResult = { text: mode === "empty" || mode === "silent-tools" ? "" : "answer\n", sessionId: id, turnId: `turn-${state.turn}`, turn: state.turn,
        toolCallCount: mode === "silent-tools" ? 1 : 0, byTool: mode === "silent-tools" ? { commandExecution: 1 } : {}, items: [], model: options.model, modelProvider: "openai", runtime: { sandbox: "read-only", approvalPolicy: "on-request", approvalsReviewer: "user" }, status: "completed" };
      if (mode === "edit" || mode === "edit-fail") { writeFileSync(path.join(options.cwd, "worker.txt"), "native edit\n"); result.toolCallCount = 1; }
      if (mode === "approval") { assert.ok(options.approve); assert.equal(await options.approve({ method: "item/commandExecution/requestApproval", params: { command: "cat note.txt" } }), "decline"); }
      if (mode === "activity" || mode === "declined" || mode === "declined-file") {
        for (const event of ["item/started", "item/completed"]) options.onEvent?.(event, { threadId: id, item: { id: "tool-1", type: mode === "declined-file" ? "fileChange" : "commandExecution", changes: [{ path: "not-written.txt" }], command: "cat note.txt", status: mode.startsWith("declined") ? "declined" : "completed" } });
        result.toolCallCount = 1; result.byTool = { commandExecution: 1 };
      }
      if (mode === "edit-fail") { result.text = "partial\n"; throw new CodexTurnError("interrupted", result, id); }
      return result;
    },
  };
  const noOpencode: ServeProvider = { async withServe() { throw new Error("native call touched opencode"); } };
  const deps = { codex: backend, serve: noOpencode, cwd: project, home: path.join(temp, "home"), env };
  const entries = (run: string) => readFileSync(path.join(logDir, run, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  try {
    const first = await consult({ question: "hello", model: "codex/test-model", keepSession: true, worktree: sibling }, deps);
    assert.ok(first.ok); assert.equal(first.answer, "answer\n"); assert.equal(first.attribution.backend, "codex"); assert.equal(first.attribution.agent, "codex"); assert.equal(first.attribution.worktree, sibling); assert.ok(first.sessionId?.startsWith("codex:"));
    const rows = entries(first.attribution.runId); assert.equal(rows.length, 3); assert.ok(rows.every(row => row.backend === "codex" && row.model === "codex/test-model")); assert.equal(rows[2].raw_response, first.answer); assert.equal(rows[2].runtime.modelIdentitySource, "configured native thread");
    const next = await consult({ question: "follow up", sessionId: first.sessionId, runId: first.attribution.runId, keepSession: true }, { ...deps, env: { ...env, GUILD_MODEL: "openai/wrong-default" } });
    assert.ok(next.ok); assert.equal(lastOptions?.cwd, sibling); assert.equal(lastOptions?.model, "test-model"); assert.equal(lastOptions?.sessionId, first.sessionId?.slice(6));
    const continued = entries(first.attribution.runId).filter(row => row.status === "completed"); assert.equal(continued[1].session_id, first.sessionId); assert.equal(continued[1].runtime.turn, 2);
    const before = calls;
    for (const params of [{ model: "openai/wrong", sessionId: first.sessionId }, { model: "codex/other", sessionId: first.sessionId }, { model: "codex/test-model", sessionId: "ses_opencode" }, { model: "codex/test-model", sessionId: first.sessionId, worktree: project }]) {
      assert.equal((await consult({ question: "bad", ...params }, deps)).ok, false);
    }
    assert.equal(calls, before);
    assert.equal((await consult({ question: "bad", model: "codex/test-model", readPaths: [temp] }, deps)).ok, false);
    for (const overrides of [{ GUILD_APPROVE: "write" }, { GUILD_APPROVE_EGRESS: "ask" }, { GUILD_APPROVE: "typo" }]) {
      const refused = await delegate({ task: "bad", model: "codex/test-model" }, { ...deps, env: { ...env, ...overrides } }); assert.equal(refused.ok, false); assert.equal("capture" in refused, false);
    }
    assert.equal(calls, before);
    writeFileSync(path.join(guild, "models.policy.local"), "deny codex/denied\nask codex/asked\n");
    assert.equal((await consult({ question: "bad", model: "codex/denied" }, deps)).ok, false); assert.equal((await consult({ question: "bad", model: "codex/asked" }, deps)).ok, false); assert.equal(calls, before);
    assert.ok((await consult({ question: "allowed", model: "codex/asked", confirmed: true }, deps)).ok);
    assert.ok((await research({ question: "research", model: "codex/test-model" }, deps)).ok);
    const nativePanel = await panel({ question: "panel", models: ["codex/test-model", "codex/other"], keepSessions: true }, deps);
    assert.ok(nativePanel.ok); assert.equal(nativePanel.results.length, 2); assert.ok(nativePanel.results.every(member => member.backend === "codex" && member.sessionId?.startsWith("codex:")));
    mode = "empty";
    const empty = await consult({ question: "empty", model: "codex/test-model" }, deps); assert.ok(!empty.ok); assert.equal(empty.error.kind, "empty-answer"); assert.equal(empty.backend, "codex"); assert.equal(empty.runtime?.model, "test-model"); assert.equal(entries(empty.runId!)[2].capture_state, "complete"); assert.equal(entries(empty.runId!)[2].runtime.model, "test-model");
    const emptyDelegate = await delegate({ task: "empty", model: "codex/test-model" }, deps); assert.ok(!emptyDelegate.ok); assert.equal(emptyDelegate.runtime?.model, "test-model");
    mode = "silent-tools";
    const silent = await delegate({ task: "silent", model: "codex/test-model" }, deps); assert.ok(silent.ok);
    mode = "edit";
    const edited = await delegate({ task: "edit", model: "codex/test-model", worktree: sibling }, deps); assert.ok(edited.ok); assert.equal(edited.attribution.worktree, sibling); assert.ok(edited.capture.patchPath); assert.ok(readFileSync(edited.capture.patchPath, "utf8").includes("native edit")); assert.equal(existsSync(path.join(project, "worker.txt")), false);
    mode = "edit-fail";
    const failed = await delegate({ task: "partial", model: "codex/test-model" }, deps); assert.ok(!failed.ok); assert.equal(failed.backend, "codex"); assert.equal(failed.runtime?.model, "test-model"); assert.ok(failed.capture?.patchPath); assert.equal(entries(path.basename(path.dirname(failed.capture!.patchPath!)))[2].raw_response, "partial\n"); assert.equal(entries(path.basename(path.dirname(failed.capture!.patchPath!)))[2].capture_state, "complete");
    mode = "approval";
    assert.ok((await consult({ question: "approval", model: "codex/test-model" }, { ...deps, elicitation: { available: true, async ask() { return "decline" as const; } } })).ok);
    mode = "activity"; const progress: unknown[] = [];
    const observed = await consult({ question: "activity", model: "codex/test-model" }, { ...deps, onActivity: event => progress.push(event) }); assert.ok(observed.ok); assert.equal(observed.activity?.toolCalls, 1); assert.equal(observed.activity?.degraded, true); assert.ok(progress.length > 0); assert.ok(observed.activity?.file);
    mode = "declined";
    const declined = await consult({ question: "declined activity", model: "codex/test-model" }, deps); assert.ok(declined.ok); assert.ok(declined.activity?.errors.some(error => error.includes("declined"))); assert.equal(declined.activity?.first.some(line => line.kind === "tool-succeeded"), false);
    mode = "declined-file";
    const deniedEdit = await consult({ question: "declined file", model: "codex/test-model" }, deps); assert.ok(deniedEdit.ok); assert.deepEqual(deniedEdit.activity?.filesEdited, []);
    mode = "answer";
    const defDir = path.join(temp, "defs"); mkdirSync(defDir); writeFileSync(path.join(defDir, "guild-read.md"), "---\nmode: all\n---\nfixture\n");
    const fake = await startFakeOpencode({ historyText: "opencode answer" });
    try {
      const handle = fakeServeHandle(fake.baseUrl);
      const mixed = await panel({ question: "mixed", models: ["openai/opencode-model", "codex/test-model"], keepSessions: true }, { ...deps, env: { ...env, GUILD_AGENT_DIR: defDir }, serve: { withServe: fn => fn(handle) } });
      assert.ok(mixed.ok); assert.ok(mixed.results.every(member => !member.error)); assert.equal(mixed.results[0].model, "openai/opencode-model"); assert.equal(mixed.results[1].backend, "codex");
      const mixedRows = entries(mixed.runId); assert.equal(mixedRows.filter(row => row.backend === "codex").length, 3); assert.equal(mixedRows.filter(row => row.backend === undefined).length, 3);
    } finally { await fake.close(); }
    assert.ok(released.length > 0);
    const log = new EvidenceLog({ env, cwd: project, guildDir: guild });
    assert.ok((await log.verify(first.attribution.runId)).ok);
    console.log("native-routing.test: passed native routing, policy, roots, sessions, approvals, evidence, capture, mixed panels and activity");
    return 0;
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
if (import.meta.url === `file://${process.argv[1]}`) run().then(failures => process.exit(failures ? 1 : 0));
