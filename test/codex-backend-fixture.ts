/** Offline JSONL App Server fixture. It persists only synthetic transcripts. */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const dir = process.env.GUILD_CODEX_FIXTURE_DIR!;
const mode = process.env.GUILD_CODEX_FIXTURE_MODE ?? "normal";
process.stdin.once("end", () => {
  if (mode === "ignore-eof") { setInterval(() => {}, 1000); return; }
  if (mode === "pipe-holder") {
    const helper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
    appendFileSync(`${dir}/pipe-holder-pids`, `${helper.pid}\n`);
    helper.unref();
    setTimeout(() => process.exit(0), 25);
  }
  // Delayed flush is lost by immediate SIGKILL, even if stdin.end was called.
  setTimeout(() => appendFileSync(`${dir}/graceful-flush.jsonl`, JSON.stringify({ pid: process.pid, kind: activeTurn ? "turn" : "control" }) + "\n"), 25);
});
appendFileSync(`${dir}/pids`, `${process.pid}\n`);
process.once("exit", code => appendFileSync(`${dir}/exit-codes.jsonl`, JSON.stringify({ pid: process.pid, mode, code }) + "\n"));
let initialized = false;
let thread: any;
let activeTurn: any;
let requestId: number | undefined;
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
const notify = (method: string, params: unknown) => send({ method, params });
const save = () => writeFileSync(`${dir}/${thread.id}.json`, JSON.stringify(thread));
function complete(status = "completed", text = 'answer\n"quoted" café\n') {
  activeTurn.status = status;
  if (text) activeTurn.items.push({ type: "agentMessage", id: `answer-${activeTurn.id}`, text, phase: "final_answer" });
  save();
  notify("turn/completed", { threadId: thread.id, turn: activeTurn });
}
createInterface({ input: process.stdin }).on("line", line => {
  const frame = JSON.parse(line);
  appendFileSync(`${dir}/wire.jsonl`, JSON.stringify(frame) + "\n");
  if (frame.id === requestId && !frame.method) {
    appendFileSync(`${dir}/approvals.jsonl`, JSON.stringify(frame) + "\n");
    complete("completed", frame.result?.decision === "accept" ? "accepted" : "declined");
    return;
  }
  if (frame.method === "initialized") { initialized = true; return; }
  const answer = (result: unknown) => send({ id: frame.id, result });
  if (frame.method === "initialize") { answer({ userAgent: "fake" }); return; }
  if (!initialized) { send({ id: frame.id, error: { message: "missing initialized" } }); return; }
  const p = frame.params;
  switch (frame.method) {
    case "model/list": answer(p.cursor ? { data: [{ id: "b", model: "b", displayName: "B" }], nextCursor: null } : { data: [{ id: "a", model: "a", displayName: "A", isDefault: true }], nextCursor: "page2" }); return;
    case "account/read": answer({ account: { type: "chatgpt", email: "do-not-expose@example.invalid" } }); return;
    case "thread/start":
      thread = { id: randomUUID(), cwd: p.cwd, model: p.model, turns: [] }; save(); break;
    case "thread/resume": thread = JSON.parse(readFileSync(`${dir}/${p.threadId}.json`, "utf8")); thread.model = p.model; break;
    case "thread/read": answer({ thread: JSON.parse(readFileSync(`${dir}/${p.threadId}.json`, "utf8")) }); return;
    case "thread/archive": appendFileSync(`${dir}/archived`, p.threadId + "\n"); answer({}); return;
    case "turn/start": {
      activeTurn = { id: randomUUID(), status: "inProgress", itemsView: "full", items: [{ type: "userMessage", id: randomUUID(), content: p.input }] };
      thread.turns.push(activeTurn); save();
      if (mode === "crash") process.exit(9);
      if (mode === "lost-start") return;
      if (mode === "descendant" || mode === "completed-descendant") {
        // Keep the fixture path as argv data, never interpolated JavaScript.
        const child = spawn(process.execPath, [
          "-e",
          "process.on('SIGTERM', () => {}); setTimeout(() => require('fs').writeFileSync(process.argv[1], 'late'), 1000); setInterval(() => {}, 1000);",
          `${dir}/late-write`,
        ], { detached: true, stdio: "ignore" });
        appendFileSync(`${dir}/descendant-pids`, `${child.pid}\n`);
        child.unref();
      }
      notify("item/completed", { threadId: thread.id, turnId: "a-prior-turn", item: { type: "commandExecution", id: "foreign-tool" } });
      if (mode === "malformed") { process.stdout.write("not-json\n"); return; }
      // Completion deliberately precedes the start RPC response.
      if (mode === "normal" || mode === "empty" || mode === "completed-descendant") {
        const item = { type: "commandExecution", id: "tool", command: "cat note", aggregatedOutput: "token" };
        notify("item/started", { threadId: thread.id, turnId: activeTurn.id, item });
        notify("item/completed", { threadId: thread.id, turnId: activeTurn.id, item });
        complete("completed", mode === "empty" ? "" : undefined);
      }
      answer({ turn: activeTurn });
      if (mode === "approval" || mode === "unsupported") {
        requestId = 900;
        send({ id: requestId, method: mode === "approval" ? "item/commandExecution/requestApproval" : "item/tool/requestUserInput", params: { threadId: thread.id, turnId: activeTurn.id, command: "cat note" } });
      }
      if (mode === "slow") setTimeout(() => complete(), 400);
      return;
    }
    case "turn/interrupt":
      answer({});
      if (mode !== "ignore-interrupt" && mode !== "descendant") setTimeout(() => complete("interrupted", "partial bytes\n"), 30);
      return;
    default: send({ id: frame.id, error: { message: `unknown method ${frame.method}` } }); return;
  }
  answer({ thread, cwd: thread.cwd, model: mode === "model-mismatch" ? "other-model" : thread.model, modelProvider: "openai", sandbox: { type: "readOnly" }, approvalPolicy: "on-request", approvalsReviewer: "user" });
});
