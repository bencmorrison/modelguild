/**
 * Native Codex App Server adapter (#227). The installed 0.153.4 JSONL schema and
 * https://learn.chatgpt.com/docs/app-server define this small protocol subset.
 * Each turn owns a child: an unconfirmed interrupt can kill its process group
 * without taking a concurrent panel member down. Codex creates separate process
 * groups for its code-mode host and shell commands (observed 0.153.4), so POSIX
 * forced teardown freezes the app-server group, inventories its descendants with ps,
 * freezes those, and kills the tree before the parent. A process that deliberately
 * daemonizes/reparents before this inventory, a crash before inventory, or a
 * missing/failing ps remains outside the descendant-cleanup guarantee.
 * Successful turns and control calls first close stdin and allow one second to
 * flush and exit on POSIX. Completed turns retain descendant birth identities
 * before EOF and stop surviving tools before returning. Windows completed turns
 * keep forced taskkill /T cleanup while their root is alive, because descendant
 * retention is POSIX-only; token-free controls can still use EOF. Controls have not run a model and
 * skip that scan on graceful exit. Hung exits fall back to forced teardown.
 * Catalog/read operations use a separate short-lived child too; no daemon or port.
 *
 * Receipts come from thread/read(includeTurns), selecting the exact turn/start
 * id. On 0.153.4 the read reports itemsView:full but OMITS command/tool
 * items; tool counts and input/output therefore come from turn-scoped item
 * notifications, with that weaker no-replay source stated on runtime. Stream
 * loss fails the call rather than reporting zero work. Ephemeral threads reject that read on 0.153.4, so these are durable legacy
 * threads. release archives them; it does NOT delete Codex's local history.
 * The configured/resolved model is not provider execution telemetry. Native
 * sandbox/approval settings are inherited and echoed, never called an opencode
 * permission floor. Unknown approval protocols fail visibly rather than grant.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isBlank } from "./client.js";

type ObjectValue = Record<string, any>;
export interface CodexOptions {
  cwd: string;
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  interruptTimeoutMs?: number;
  shutdownGraceMs?: number;
}
export interface CodexModel { id: string; name: string; description: string; isDefault: boolean }
export interface CodexSession { id: string; cwd: string; model?: string }
export interface CodexApprovalRequest { method: string; params: Record<string, unknown> }
export type CodexApprovalDecision = "accept" | "decline" | "cancel";
export interface CodexTurnOptions {
  model: string;
  prompt: string;
  cwd: string;
  sessionId?: string;
  messageTimeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (method: string, params: Record<string, unknown>) => void;
  approve?: (request: CodexApprovalRequest) => Promise<CodexApprovalDecision>;
}
export interface CodexRuntime {
  sandbox: unknown;
  approvalPolicy: unknown;
  approvalsReviewer: unknown;
  answerTranscriptSource?: string;
  toolTranscriptSource?: string;
}
export interface CodexTurnResult {
  text: string;
  sessionId: string;
  turnId: string;
  turn: number;
  toolCallCount: number;
  byTool: Record<string, number>;
  items: Record<string, unknown>[];
  eventItems?: Record<string, unknown>[];
  model: string;
  modelProvider: string;
  runtime: CodexRuntime;
  status: string;
}
/** Carries the current turn's bytes when a failed/interrupted turn was readable. */
export class CodexTurnError extends Error {
  constructor(message: string, readonly result?: CodexTurnResult, readonly sessionId?: string) {
    super(message);
    this.name = "CodexTurnError";
  }
}

function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Codex ${label} is not an object`);
  return value as ObjectValue;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Codex ${label} is missing`);
  return value;
}
const TOOL_TYPES = new Set(["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "webSearch", "imageView", "imageGeneration", "sleep"]);
/** Exact ID match prevents an empty current turn from inheriting an old answer. */
export function extractCodexTurn(thread: unknown, turnId: string): {
  text: string; items: ObjectValue[]; toolCallCount: number; byTool: Record<string, number>; turn: number; status: string;
} {
  const data = object(thread, "thread transcript");
  if (!Array.isArray(data.turns)) throw new Error("Codex transcript has no turn list");
  const matches = data.turns.filter((t: ObjectValue) => t?.id === turnId);
  if (matches.length !== 1) throw new Error(`Codex transcript does not uniquely contain turn ${turnId}`);
  const turn = object(matches[0], "turn");
  if (turn.itemsView !== "full" || !Array.isArray(turn.items)) throw new Error("Codex transcript turn items are not complete (itemsView must be full)");
  const items = turn.items.map((item: unknown) => object(item, "transcript item"));
  // Commentary is an answer only when no final answer exists; preserve bytes.
  // A compaction item is never a caller delimiter or an assistant answer.
  const messages = items.filter((i: ObjectValue) => i.type === "agentMessage" && typeof i.text === "string");
  const finals = messages.filter((i: ObjectValue) => i.phase === "final_answer");
  const candidates = finals.length ? finals : messages;
  const text = [...candidates].reverse().find((i: ObjectValue) => !isBlank(i.text))?.text
    ?? [...candidates].reverse().find((i: ObjectValue) => i.text.length)?.text ?? "";
  const byTool: Record<string, number> = Object.create(null);
  const seen = new Set<string>();
  for (const item of items) {
    if (!TOOL_TYPES.has(item.type)) continue;
    const id = string(item.id, "tool item id");
    if (seen.has(id)) continue;
    seen.add(id);
    const name = item.type === "mcpToolCall" ? `mcp:${item.server}/${item.tool}`
      : item.type === "dynamicToolCall" ? `dynamic:${item.tool}` : item.type;
    byTool[name] = (byTool[name] ?? 0) + 1;
  }
  return { text, items, toolCallCount: seen.size, byTool, turn: data.turns.indexOf(matches[0]) + 1, status: string(turn.status, "turn status") };
}

interface ProcessEntry { pid: number; parent: number; born: string }
function processTable(): ProcessEntry[] {
  const listing = spawnSync("ps", ["-axo", "pid=,ppid=,lstart="], { encoding: "utf8", timeout: 1000, maxBuffer: 4 * 1024 * 1024 });
  return (listing.stdout ?? "").split("\n").flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), born: match[3] }] : [];
  });
}
function processIdentity(entry: ProcessEntry, verifyParent = false): string | undefined {
  if (process.platform !== "linux") return entry.born;
  try {
    const stat = readFileSync(`/proc/${entry.pid}/stat`, "utf8");
    // Field 22 is starttime; the comm field may itself contain parentheses.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // During retention, do not pair an old ps parent row with a reused PID's
    // new birth identity. Later cleanup deliberately permits EOF reparenting.
    if (verifyParent && Number(fields[1]) !== entry.parent) return undefined;
    return fields[19];
  } catch { return undefined; }
}
/** One JSONL transport. Forced shutdown is synchronous; ordinary EOF gets a grace period. */
class Connection {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<void>;
  readonly pending = new Map<number, { resolve: (value: ObjectValue) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  onNotification?: (method: string, params: ObjectValue) => void;
  onRequest?: (method: string, params: ObjectValue) => Promise<unknown>;
  private nextId = 0;
  private buffer = "";
  private stderr = "";
  private failure?: Error;
  private closed = false;
  private killed = false;
  private rootExited = false;
  private readonly retainedDescendants = new Map<number, string>();
  constructor(readonly options: CodexOptions, cwd = options.cwd) {
    this.child = spawn(options.command ?? "codex", options.args ?? ["app-server"], {
      cwd, env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32",
    });
    this.exited = new Promise(resolve => this.child.once("close", () => {
      this.fail(new Error(`Codex app-server closed${this.stderr ? `: ${this.stderr}` : ""}`)); resolve();
    }));
    this.child.once("exit", () => { this.rootExited = true; });
    this.child.on("error", error => this.fail(new Error(`Cannot start Codex app-server: ${error.message}`)));
    this.child.stdin.on("error", error => this.fail(error));
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      // Fail loudly rather than quietly dropping part of a transcript.
      if (this.buffer.length > 64 * 1024 * 1024) { this.fail(new Error("Codex protocol frame exceeds 64 MiB")); this.kill(); return; }
      let at: number;
      while ((at = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, at); this.buffer = this.buffer.slice(at + 1);
        if (!line.trim()) continue;
        try { this.receive(object(JSON.parse(line), "protocol frame")); }
        catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); this.kill(); }
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-4096).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ""); });
  }
  private fail(error: Error): void {
    this.failure ??= error;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
  }
  private send(frame: unknown): void {
    if (this.failure) throw this.failure;
    this.child.stdin.write(JSON.stringify(frame) + "\n");
  }
  private receive(frame: ObjectValue): void {
    if (typeof frame.method === "string") {
      const params = object(frame.params ?? {}, "notification parameters");
      if (frame.id !== undefined) {
        const handler = this.onRequest;
        Promise.resolve().then(() => {
          if (!handler) throw new Error(`Unsupported Codex request: ${frame.method}`);
          return handler(frame.method, params);
        }).then(result => {
          if (!this.closed) this.send({ id: frame.id, result });
        }, error => {
          if (!this.closed) this.send({ id: frame.id, error: { code: -32603, message: String(error) } });
        }).catch(() => {});
      } else this.onNotification?.(frame.method, params);
      return;
    }
    const entry = this.pending.get(frame.id);
    if (!entry) return;
    clearTimeout(entry.timer); this.pending.delete(frame.id);
    if (frame.error) entry.reject(new Error(`Codex RPC: ${frame.error.message ?? JSON.stringify(frame.error)}`));
    else { try { entry.resolve(object(frame.result, "response")); } catch (error) { entry.reject(error as Error); } }
  }
  request(method: string, params: unknown, timeoutMs = this.options.requestTimeoutMs ?? 30_000): Promise<ObjectValue> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out after ${timeoutMs}ms`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async initialize(): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "modelguild", version: "1" }, capabilities: { experimentalApi: true } });
    this.send({ method: "initialized", params: {} });
  }
  private retainDescendants(): void {
    if (!this.child.pid || this.rootExited || process.platform === "win32") return;
    const descendants = new Set([this.child.pid]);
    const rows = processTable();
    let added = true;
    while (added) {
      added = false;
      for (const row of rows) {
        if (descendants.has(row.parent) && !descendants.has(row.pid)) {
          const identity = processIdentity(row, true);
          if (!identity) continue;
          descendants.add(row.pid); added = true;
          this.retainedDescendants.set(row.pid, identity);
        }
      }
    }
  }
  kill(): void {
    this.closed = true;
    if (this.killed) return;
    this.killed = true;
    try {
      if (!this.child.pid) return;
      if (process.platform === "win32") {
        // taskkill owns descendant discovery on Windows; no shell interpolation.
        spawnSync("taskkill", ["/pid", String(this.child.pid), "/T", "/F"], { timeout: 2000, windowsHide: true, stdio: "ignore" });
        try { this.child.kill("SIGKILL"); } catch { /* Already gone. */ }
        return;
      }
      const safeKill = (pid: number, how: NodeJS.Signals) => { try { process.kill(pid, how); } catch { /* Already gone. */ } };
      if (!this.rootExited) safeKill(-this.child.pid, "SIGSTOP");
      // Killing only the app-server group leaves Codex's independent command
      // groups alive. Freeze discovered descendants before killing any parent so
      // a shell cannot resume after its sleep child dies and perform a late edit.
      const descendants = new Set<number>(this.rootExited ? [] : [this.child.pid]);
      for (let pass = 0; pass < 2; pass++) {
        const rows = processTable();
        // EOF may have reparented a command before app-server close. Its captured
        // birth identity guards against PID reuse. Non-Linux lstart is only
        // second-resolution, so that check is best-effort on those systems.
        for (const row of rows) {
          const identity = this.retainedDescendants.get(row.pid);
          if (identity && identity === processIdentity(row)) {
            descendants.add(row.pid); safeKill(row.pid, "SIGSTOP");
          }
        }
        let added = true;
        while (added) {
          added = false;
          for (const { pid, parent } of rows) {
            if (pid > 0 && descendants.has(parent) && !descendants.has(pid)) {
              descendants.add(pid); safeKill(pid, "SIGSTOP"); added = true;
            }
          }
        }
      }
      for (const pid of [...descendants].reverse()) if (pid !== this.child.pid) safeKill(pid, "SIGKILL");
      // SIGTERM is ineffective while stopped; the child and descendants must be
      // gone before a delegation's after-snapshot can be taken.
      if (!this.rootExited) {
        safeKill(-this.child.pid, "SIGKILL");
        safeKill(this.child.pid, "SIGKILL");
      }
    } finally {
      // Close pipes AFTER freezing/stopping the tree: exposing EOF first could
      // reparent active tools before discovery. Also bound child.close when an
      // already-reparented helper retains inherited transport handles.
      this.child.stdin.destroy();
      this.child.stdout.destroy();
      this.child.stderr.destroy();
    }
  }
  async close(mode: "force" | "control" | "completed" = "force"): Promise<void> {
    this.closed = true;
    // Windows has no retained descendant identities here: keep its root alive
    // until taskkill /T owns the completed turn's whole process tree.
    if (mode === "force" || this.killed || (mode === "completed" && process.platform === "win32")) {
      this.kill();
      await this.exited;
      return;
    }
    // A successful turn can leave background tools. Inventory BEFORE EOF so
    // cleanup still owns them if graceful shutdown reparents them. Control RPCs
    // have never started a model turn and can skip this process-table scan.
    if (mode === "completed") this.retainDescendants();
    this.child.stdin.end();
    const timer = setTimeout(() => this.kill(), this.options.shutdownGraceMs ?? 1000);
    try { await this.exited; }
    finally {
      clearTimeout(timer);
      if (this.retainedDescendants.size) this.kill();
    }
  }
}

export class CodexBackend {
  private readonly children = new Set<Connection>();
  private readonly busy = new Set<string>();
  private stopped = false;
  constructor(readonly options: CodexOptions) {}
  private async connect(cwd = this.options.cwd): Promise<Connection> {
    if (this.stopped) throw new Error("Codex backend is shut down");
    const connection = new Connection(this.options, cwd); this.children.add(connection);
    connection.exited.then(() => this.children.delete(connection));
    try { await connection.initialize(); return connection; }
    catch (error) { await connection.close(); throw error; }
  }
  private async control<T>(run: (connection: Connection) => Promise<T>): Promise<T> {
    const connection = await this.connect();
    try { return await run(connection); } finally { await connection.close("control"); }
  }
  async start(): Promise<void> { await this.control(async () => {}); }
  async models(): Promise<CodexModel[]> {
    return this.control(async connection => {
      const models: CodexModel[] = []; const seen = new Set<string>(); let cursor: string | undefined;
      do {
        const page = await connection.request("model/list", { ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(page.data)) throw new Error("Codex model/list has no model array");
        for (const model of page.data) models.push({ id: string(model.model ?? model.id, "model id"), name: string(model.displayName, "model name"), description: typeof model.description === "string" ? model.description : "", isDefault: model.isDefault === true });
        cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
        if (cursor && seen.has(cursor)) throw new Error("Codex model/list repeated a cursor");
        if (cursor) seen.add(cursor);
      } while (cursor);
      return models;
    });
  }
  async account(): Promise<{ authenticated: boolean | null; type?: string }> {
    return this.control(async connection => {
      const value = await connection.request("account/read", {});
      // Never return account email, token, or other credential-adjacent fields.
      return { authenticated: value.account ? true : value.requiresOpenaiAuth === true ? false : null,
        ...(typeof value.account?.type === "string" ? { type: value.account.type } : {}) };
    });
  }
  async session(id: string): Promise<CodexSession> {
    return this.control(async connection => {
      const { thread } = await connection.request("thread/read", { threadId: id, includeTurns: false });
      return { id: string(thread?.id, "thread id"), cwd: string(thread?.cwd, "thread cwd"), ...(typeof thread?.model === "string" ? { model: thread.model } : {}) };
    });
  }
  async release(sessionId: string): Promise<void> {
    await this.control(async connection => { await connection.request("thread/archive", { threadId: sessionId }); });
  }
  /** Synchronous process-group kill precedes the await for process-exit callers. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    const connections = [...this.children];
    for (const connection of connections) connection.kill();
    await Promise.all(connections.map(connection => connection.close()));
  }
  async turn(options: CodexTurnOptions): Promise<CodexTurnResult> {
    if (options.signal?.aborted) throw new CodexTurnError("Codex turn cancelled before start", undefined, options.sessionId);
    if (options.sessionId && this.busy.has(options.sessionId)) throw new Error("Codex session already has an active turn");
    if (options.sessionId) this.busy.add(options.sessionId);
    let connection: Connection | undefined;
    let succeeded = false;
    let sessionId = options.sessionId;
    let turnId: string | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let interruptTimer: NodeJS.Timeout | undefined;
    let interruptSent = false;
    let interrupted: string | undefined;
    let approvalError: string | undefined;
    let resolveDone!: (turn: ObjectValue) => void;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<ObjectValue>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    // The completion may reject before turn/start returns. Always attach a handler.
    void done.catch(() => {});
    const completed = new Map<string, ObjectValue>();
    const eventItems = new Map<string, Map<string, ObjectValue>>();
    const pendingEvents: Array<[string, ObjectValue]> = [];
    const forwardEvent = (method: string, params: ObjectValue): void => {
      const id = params.turnId ?? params.turn?.id;
      if (id !== turnId) return;
      try { options.onEvent?.(method, params); } catch { /* Visibility cannot fail the turn. */ }
    };
    const interrupt = (reason: string): void => {
      interrupted ??= reason;
      if (!connection) return;
      const active = connection;
      if (!interruptTimer) interruptTimer = setTimeout(() => {
        active.kill(); rejectDone(new CodexTurnError(`${interrupted}; interruption unconfirmed, Codex process group terminated`, undefined, sessionId));
      }, this.options.interruptTimeoutMs ?? 5000);
      // Even while turn/start is pending the stop deadline is armed: a lost
      // start reply must not let the model run until the generic RPC timeout.
      if (!sessionId || !turnId || interruptSent) return;
      interruptSent = true;
      void active.request("turn/interrupt", { threadId: sessionId, turnId }).catch(() => {
        active.kill(); rejectDone(new CodexTurnError(`${interrupted}; interrupt failed, Codex process group terminated`, undefined, sessionId));
      });
    };
    const abort = () => interrupt("Codex turn cancelled");
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      connection = await this.connect(options.cwd);
      const active = connection;
      active.exited.then(() => rejectDone(new CodexTurnError("Codex app-server exited during turn", undefined, sessionId)));
      active.onNotification = (method, params) => {
        if (params.threadId !== sessionId) return;
        if ((method === "item/started" || method === "item/completed") && typeof params.turnId === "string") {
          const item = object(params.item, "event item");
          if (typeof item.id === "string") {
            let items = eventItems.get(params.turnId);
            if (!items) eventItems.set(params.turnId, items = new Map());
            items.set(item.id, item);
          }
        }
        if (turnId) forwardEvent(method, params);
        else pendingEvents.push([method, params]);
        if (method === "turn/completed") {
          const turn = object(params.turn, "completion turn");
          completed.set(string(turn.id, "completion turn id"), turn);
          if (turn.id === turnId) resolveDone(turn);
        }
      };
      active.onRequest = async (method, params) => {
        if (params.threadId !== sessionId) throw new Error("Codex request belongs to an unexpected thread");
        if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
          if (!options.approve) {
            approvalError = "Codex requested an approval but no approval channel is available. Use an elicitation-capable MCP client, or configure Codex's native approval_policy and sandbox for unattended use (see docs/operations.md).";
            return { decision: "decline" };
          }
          try {
            const decision = await options.approve({ method, params });
            if (!["accept", "decline", "cancel"].includes(decision)) throw new Error("Invalid Codex approval decision");
            return { decision };
          } catch (error) { approvalError = `Codex approval failed: ${String(error)}`; return { decision: "decline" }; }
        }
        approvalError = `Unsupported Codex interactive request: ${method}`;
        interrupt(approvalError);
        throw new Error(approvalError);
      };
      const setup = sessionId
        ? await active.request("thread/resume", { threadId: sessionId, model: options.model })
        : await active.request("thread/start", { model: options.model, cwd: options.cwd, ephemeral: false, historyMode: "legacy", allowProviderModelFallback: false });
      sessionId = string(setup.thread?.id, "thread id");
      if (options.sessionId && sessionId !== options.sessionId) throw new Error("Codex resumed a different thread");
      if (realpathSync(string(setup.cwd ?? setup.thread?.cwd, "resolved cwd")) !== realpathSync(options.cwd)) throw new Error("Codex session root differs from the requested worktree");
      const resolvedModel = string(setup.model, "resolved model");
      if (resolvedModel !== options.model) throw new Error(`Codex resolved ${resolvedModel} instead of requested ${options.model}`);
      if (interrupted || options.signal?.aborted) throw new CodexTurnError(interrupted ?? "Codex turn cancelled before start", undefined, sessionId);
      timeout = setTimeout(() => interrupt("Codex turn timed out"), options.messageTimeoutMs ?? 180_000);
      const started = await active.request("turn/start", { threadId: sessionId, input: [{ type: "text", text: options.prompt, text_elements: [] }] });
      turnId = string(started.turn?.id, "started turn id");
      for (const [method, params] of pendingEvents) forwardEvent(method, params);
      pendingEvents.length = 0;
      if (completed.has(turnId)) resolveDone(completed.get(turnId)!);
      if (interrupted) interrupt(interrupted);
      const ending = await done;
      if (timeout) clearTimeout(timeout);
      if (interruptTimer) clearTimeout(interruptTimer);
      const readback = await active.request("thread/read", { threadId: sessionId, includeTurns: true });
      if (readback.thread?.id !== sessionId) throw new Error("Codex transcript belongs to a different thread");
      const extracted = extractCodexTurn(readback.thread, turnId);
      if (extracted.status !== ending.status) throw new Error("Codex transcript and completion disagree on turn status");
      const observed = [...(eventItems.get(turnId)?.values() ?? [])];
      const eventCensus = extractCodexTurn({ turns: [{ id: turnId, itemsView: "full", status: ending.status, items: observed }] }, turnId);
      // History IDs may be rewritten (item-1...) on readback, so do not union
      // those IDs with live IDs. Prefer the observed event census when present.
      const census = eventCensus.toolCallCount > 0 ? eventCensus : extracted;
      const result: CodexTurnResult = { ...extracted, toolCallCount: census.toolCallCount, byTool: census.byTool,
        eventItems: observed, sessionId, turnId, model: resolvedModel,
        modelProvider: string(setup.modelProvider, "model provider"), runtime: { sandbox: setup.sandbox, approvalPolicy: setup.approvalPolicy, approvalsReviewer: setup.approvalsReviewer,
          answerTranscriptSource: "thread/read exact turn",
          toolTranscriptSource: "turn-scoped app-server item notifications; no post-turn replay" } };
      if (interrupted || approvalError || ending.status !== "completed") throw new CodexTurnError(interrupted ?? approvalError ?? `Codex turn ${ending.status}: ${ending.error?.message ?? "no error detail"}`, result, sessionId);
      succeeded = true;
      return result;
    } catch (error) {
      if (error instanceof CodexTurnError) throw error;
      if (interrupted) throw new CodexTurnError(`${interrupted}; Codex process group stopped`, undefined, sessionId);
      throw new CodexTurnError(error instanceof Error ? error.message : String(error), undefined, sessionId);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (interruptTimer) clearTimeout(interruptTimer);
      options.signal?.removeEventListener("abort", abort);
      // Also ends a turn whose start RPC failed after the server accepted it.
      if (connection) await connection.close(succeeded ? "completed" : "force");
      if (options.sessionId) this.busy.delete(options.sessionId);
    }
  }
}
