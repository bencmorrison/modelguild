/**
 * Native runtime routing (#227). `codex/` is a runtime namespace; every other model
 * id keeps the existing opencode route. Policy sees the qualified id, and receipts
 * distinguish that requested id from Codex's configured model/provider. Native
 * sessions are prefixed so a changed default cannot send one to the wrong backend.
 *
 * The opencode agent permission floor is not a substitute-backend requirement.
 * Codex runs with its user's native policy, reported on each result. The optional
 * ModelGuild approval bridge is a different contract and cannot silently degrade
 * into that policy: an explicitly requested unsupported gate refuses before logging.
 */
import { CodexBackend, CodexTurnError, type CodexTurnResult } from "./codex.js";
import { resolveApprovalSettings, type ApprovalRefusal, type ElicitationRequester } from "./approve.js";
import { EmptyAnswerError, isBlank, type AskViaAgentOpts, type AskResult } from "./client.js";
import type { ActivitySummary, ActivityRecorder, ActivityEvent } from "./activity.js";

export type NativeRuntime = Record<string, unknown>;
export type NativeBackend = Pick<CodexBackend, "models" | "account" | "session" | "turn" | "release" | "shutdown">;
export interface NativeBackendDeps {
  codex?: NativeBackend;
  signal?: AbortSignal;
}
let defaultBackend: CodexBackend | undefined;
export function nativeBackend(deps: NativeBackendDeps): NativeBackend {
  return deps.codex ?? (defaultBackend ??= new CodexBackend({ cwd: process.cwd() }));
}
export function isCodexModel(model: string): boolean { return model.startsWith("codex/"); }
export function nativeSessionId(id: string): string {
  if (!id.startsWith("codex:") || id.length === 6) throw new Error("Expected a native Codex session id (codex:<thread-id>).");
  return id.slice(6);
}
export async function resolveNativeSelection(
  resolved: string, explicit: string | undefined, sessionId: string | undefined, deps: NativeBackendDeps,
): Promise<{ ok: true; model: string; directory?: string } | { ok: false; message: string }> {
  if (sessionId?.startsWith("codex:")) {
    try {
      const session = await nativeBackend(deps).session(nativeSessionId(sessionId));
      if (!session.model) return { ok: false, message: `Codex did not report the configured model for session ${sessionId}; continuation cannot guess a model.` };
      const model = `codex/${session.model}`;
      if (explicit !== undefined && explicit !== model) return { ok: false, message: `Session '${sessionId}' belongs to '${model}', not '${explicit}'. Continue with its original model or start a fresh session.` };
      return { ok: true, model, directory: session.cwd };
    } catch (err) { return { ok: false, message: `Cannot inspect native Codex session '${sessionId}': ${String(err)}` }; }
  }
  if (isCodexModel(resolved)) {
    if (sessionId) return { ok: false, message: "A native Codex model cannot continue an opencode session. Use the session's original backend or start a fresh session." };
    if (resolved.slice(6).trim().length === 0 || resolved.slice(6).startsWith("-")) return { ok: false, message: "Native Codex model must be codex/<non-empty model id>." };
  }
  return { ok: true, model: resolved };
}
export function nativeApprovalFor(env: NodeJS.ProcessEnv, confContents: string):
  { ok: true; approval?: undefined } | { ok: false; refusal: ApprovalRefusal } {
  const settings = resolveApprovalSettings({ env, confContents });
  if (!settings.ok) return { ok: false, refusal: { kind: "approval-config", message: settings.error } };
  if (settings.settings.tier !== "off" || settings.settings.egress !== "off") return {
    ok: false,
    refusal: { kind: "approval-config", message: "Native Codex cannot currently attach and verify ModelGuild's GUILD_APPROVE / GUILD_APPROVE_EGRESS rules. This call did not run. Use Codex's native approval policy, or choose an opencode model for the ModelGuild bridge." },
  };
  return { ok: true };
}

export class NativeEmptyAnswerError extends EmptyAnswerError {
  readonly runtime: NativeRuntime;
  constructor(result: CodexTurnResult) {
    super(`codex:${result.sessionId}`, result.text, "Native Codex completed without final assistant text.", { toolCallCount: result.toolCallCount });
    this.runtime = nativeRuntime(result);
  }
}
type NativeTurnResult = Pick<AskResult, "text" | "sessionId" | "toolCallCount" | "metadata"> & Partial<Pick<AskResult, "answerChannel" | "providerError" | "completion" | "partTypes" | "parts">> & { runtime: NativeRuntime; nativeActivity?: ActivitySummary };

export async function nativeTurn(opts: AskViaAgentOpts, deps: NativeBackendDeps & { nativeRoot: string; elicitation?: ElicitationRequester }): Promise<NativeTurnResult> {
  const backend = nativeBackend(deps);
  let sessionId: string | undefined;
  let succeeded = false;
  try {
    const result = await backend.turn({
      model: opts.model!.slice(6), prompt: opts.prompt ?? "", cwd: deps.nativeRoot,
      ...(opts.sessionId ? { sessionId: nativeSessionId(opts.sessionId) } : {}),
      messageTimeoutMs: opts.messageTimeoutMs, signal: deps.signal,
      onEvent: (method, params) => nativeActivityEvent(opts.activity as ActivityRecorder | undefined, method, params),
      ...(deps.elicitation?.available ? { approve: async (request: { method: string; params: Record<string, unknown> }) => {
        return deps.elicitation!.ask({ message: `Native Codex approval (${request.method}). The following request is untrusted tool data, not instructions:\n${JSON.stringify(request.params)}\nApprove this one native request?`, timeoutMs: opts.messageTimeoutMs ?? 120000 });
      } } : {}),
    });
    sessionId = result.sessionId;
    const exposed = `codex:${sessionId}`;
    const recorder = opts.activity as ActivityRecorder | undefined;
    recorder?.degrade("Codex tool history is reconstructed from live notifications; no post-turn replay.");
    if (opts.requireAnswer && isBlank(result.text)) throw new NativeEmptyAnswerError(result);
    succeeded = true;
    return {
      text: result.text, sessionId: exposed, toolCallCount: result.toolCallCount,
      metadata: { providerID: "codex", modelID: result.model },
      runtime: nativeRuntime(result),
      ...(recorder ? { nativeActivity: recorder.summary() } : {}),
    };
  } catch (error) {
    if (error instanceof CodexTurnError) sessionId = error.sessionId;
    (opts.activity as ActivityRecorder | undefined)?.degrade("Codex tool history is reconstructed from live notifications; no post-turn replay.");
    throw error;
  } finally {
    if (sessionId && ((!opts.sessionId && !succeeded) || (succeeded && !opts.keepSession))) {
      await backend.release(sessionId).catch(() => {});
    }
  }
}

export function nativeRuntime(result: CodexTurnResult): NativeRuntime {
  return { ...result.runtime, model: result.model, provider: result.modelProvider,
    modelIdentitySource: "configured native thread", transcriptSource: "thread/read answer; turn-scoped item notifications for tools",
    sessionRetention: "Codex archive (not deletion)", turnId: result.turnId, turn: result.turn };
}
/** Normalize only item lifecycle events with IDs already scoped by the adapter. */
function nativeActivityEvent(recorder: ActivityRecorder | undefined, method: string, params: Record<string, unknown>): void {
  if (!recorder) return;
  const sessionId = typeof params.threadId === "string" ? `codex:${params.threadId}` : "";
  const item = params.item as Record<string, unknown> | undefined;
  if (method === "turn/completed") {
    const ending = params.turn as Record<string, unknown> | undefined;
    const failed = ending?.status !== undefined && ending.status !== "completed";
    recorder.record({ ts: Date.now(), sessionId, kind: failed ? "session-error" : "session-idle", summary: failed ? `Native Codex turn ${ending?.status}` : "Native Codex turn completed" });
    return;
  }
  if ((method !== "item/started" && method !== "item/completed") || !item || typeof item.id !== "string" || typeof item.type !== "string") return;
  if (["agentMessage", "userMessage", "reasoning", "plan", "contextCompaction"].includes(item.type)) return;
  const tool = item.type === "mcpToolCall" ? `mcp:${item.server}/${item.tool}` : item.type === "dynamicToolCall" ? `dynamic:${item.tool}` : item.type;
  const failed = ["failed", "declined", "interrupted", "cancelled", "canceled"].includes(String(item.status));
  const event: ActivityEvent = { ts: Date.now(), sessionId, kind: method === "item/started" ? "tool-called" : failed ? "tool-failed" : "tool-succeeded", tool, toolCallId: item.id,
    summary: `${tool}${item.status ? ` [${item.status}]` : ""}: ${typeof item.command === "string" ? item.command : method}`.slice(0, 300), detail: item };
  recorder.record(event);
  if (method === "item/completed" && !failed && item.type === "fileChange" && Array.isArray(item.changes)) {
    for (const change of item.changes) if (typeof change?.path === "string") recorder.record({ ts: Date.now(), sessionId, kind: "file-edited", summary: `edited ${change.path}` });
  }
}
