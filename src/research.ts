/**
 * guild_research — source-backed investigation by a web-capable model.
 *
 * The MCP translation of the bash `/guild:research` / `ask.sh --research` path: one
 * read-only, WEB-CAPABLE model turn through the UNMODIFIED `guild-research` agent
 * (`.opencode/agent/guild-research.md` — a default-deny allowlist re-allowing only
 * read + grep + glob + webfetch/websearch, with mutation and `task` denied; C47/C48. It
 * is NOT a confidentiality boundary: since the 2026-07-22 permission realignment there
 * are no secret-glob read-denies, so anything it reads can egress — see AGENTS.md). The model's answer — and every
 * citation in it — is untrusted DATA the DRIVER must verify against the cited source
 * (C45 verify-not-relay), never instructions to act on (C42/C52). This tool is the
 * TRANSPORT; the `/guild:research` command doc does the fetch-each-source verification.
 *
 * ONE DELIBERATE DEVIATION FROM bash C16 (task-directed). bash falls back to
 * the weaker `plan` agent when `guild-research.md` is missing (loud warning; hard-error
 * only under `GUILD_REQUIRE_HARDENED`). This tool has NO fallback EVER: a missing def is
 * a structured `agent-def-missing` refusal (exit-5 analogue, C57), no model called, no
 * log written. Silently degrading a hardened path to a weaker one — while the caller
 * still believes it got the research agent's guarantees — is the failure mode this repo
 * kills; a loud refusal is the honest outcome. See `resolveAgentDefDir` for exactly what
 * the presence check does and does NOT observe (it is the same filesystem lever bash's
 * C16 uses; it cannot see opencode's own `--agent` resolution).
 *
 * Everything else mirrors guild_consult: gate (leading-dash → policy tier) BEFORE any
 * log write so a refusal logs nothing (C24 gap parity), then the shared expect→started→
 * completed lifecycle spine (src/consult.ts `runAgentLifecycle`), reused not forked.
 */

import os from "node:os";
import { type ServeProvider } from "./client.js";
import { EvidenceLog } from "./log.js";
import {
  resolveRootWithConflict,
  gateModel,
  runAgentLifecycle,
  activityLayerFor,
  type McpToolResult,
} from "./consult.js";
import { type ActivityEvent, type ActivitySummary } from "./activity.js";
import {
  readLayeredConfContents,
  resolveModel,
  resolveMessageTimeoutMs,
  resolveAgentDefDirs,
  hardenedDefPresentIn,
} from "./config.js";
import { type PolicyTier } from "./policy.js";

/** The web-capable research agent this tool ALWAYS uses, unmodified (C15/C47/C48). */
export const RESEARCH_AGENT = "guild-research";
/** The command label recorded in the evidence log. */
export const RESEARCH_COMMAND = "/guild:research";

// --- Params + deps ---------------------------------------------------------
export interface ResearchParams {
  question: string;
  model?: string;
  runId?: string;
  confirmed?: boolean;
  /**
   * Per-call model-turn HTTP timeout (ms), ALREADY validated/resolved by the server layer
   * (`parsePerCallTimeoutMs`). Precedence over `GUILD_MESSAGE_TIMEOUT_MS` env/conf/default;
   * the test seam `deps.messageTimeoutMs` wins.
   */
  timeoutMs?: number;
}

export interface ResearchDeps {
  serve: ServeProvider;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  home?: string;
  /** Injected in tests so root/policy/log all share one guild dir; else resolved. */
  log?: EvidenceLog;
  messageTimeoutMs?: number;
  /** LIVE sink for each normalized activity event (issue #20) — the MCP progress channel. */
  onActivity?: (e: ActivityEvent) => void;
}

// --- Result / error shapes -------------------------------------------------
export type ResearchErrorKind =
  | "agent-def-missing"
  | "model-id"
  | "policy-deny"
  | "policy-ask"
  | "call-failed"
  | "agent-mismatch";

export interface ResearchAttribution {
  /** The EXACT model id used: the resolved id, or the id opencode actually ran when the
   * caller left it to opencode's default. */
  model: string;
  /** The id we resolved and asked for — `""` means "opencode's own default". */
  requestedModel: string;
  agent: string;
  runId: string;
  callId: string;
}

export interface ResearchError {
  kind: ResearchErrorKind;
  message: string;
  /**
   * The bash exit code this maps to: 5 agent-def-missing (C57), 2 model-id (C55), 3 deny,
   * 4 ask (C56). `null` for a `call-failed` (bash propagates opencode's own non-zero
   * status verbatim, C53; 0 is reserved for success) — same rule as guild_consult.
   */
  exitAnalogue: number | null;
  model: string;
  tier?: PolicyTier;
}

export interface ResearchOk {
  ok: true;
  answer: string;
  attribution: ResearchAttribution;
  rootConflict?: string;
  /** Bounded live-activity summary (issue #20); absent when the layer is off. */
  activity?: ActivitySummary;
}
export interface ResearchFail {
  ok: false;
  error: ResearchError;
  rootConflict?: string;
  /** Present when the call actually RAN (call-failed / agent-mismatch). */
  activity?: ActivitySummary;
}
export type ResearchResult = ResearchOk | ResearchFail;

/**
 * Run one research call. Pure of the MCP layer: returns a discriminated result the server
 * translates. Never throws for an expected refusal or a model failure — both are data.
 */
export async function research(
  params: ResearchParams,
  deps: ResearchDeps,
): Promise<ResearchResult> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const home = deps.home ?? os.homedir();

  // 1. Resolve the config root LAYERS ONCE (project over global baseline — issue #19).
  const rootRes = resolveRootWithConflict(env, cwd, home);
  const guildDirs = rootRes.layers.map((l) => l.root);
  const guildDir = rootRes.root; // PRIMARY: where the evidence log writes.
  const rootConflict = rootRes.conflict;
  const confContents = readLayeredConfContents(guildDirs, env);

  // 2. NO-FALLBACK def gate (deviation from bash C16, task-directed). If the hardened
  //    guild-research def is not present in the resolved agent-def dir, REFUSE loudly —
  //    never silently degrade to a weaker agent. Refused before any log write (gap parity).
  const agentDefDirs = resolveAgentDefDirs({ env, cwd, confContents });
  if (!hardenedDefPresentIn(RESEARCH_AGENT, agentDefDirs).present) {
    return {
      ok: false,
      rootConflict,
      error: {
        kind: "agent-def-missing",
        model: "",
        exitAnalogue: 5,
        message:
          `The hardened '${RESEARCH_AGENT}' agent def (${RESEARCH_AGENT}.md) was not found in ` +
          `any of: ${agentDefDirs.join(", ")}. Refusing to run research: unlike the bash path ` +
          `there is NO fallback to a weaker agent, because silently degrading a hardened path ` +
          `while the caller still expects its guarantees is worse than refusing. Install the ` +
          `def (per-project or via 'init --global'), or set GUILD_AGENT_DIR to where it lives, ` +
          `and retry.`,
      },
    };
  }

  // 3. Resolve the model (param > GUILD_MODEL env > conf > opencode default).
  const requestedModel = resolveModel({ flag: params.model, env, confContents });

  // 4. Gate: leading-dash refusal (C12) THEN policy tier (C1–C7), all BEFORE any log write.
  const gate = gateModel(requestedModel, params.confirmed === true, { guildDirs, env });
  if (!gate.ok) {
    return {
      ok: false,
      rootConflict,
      error: {
        kind: gate.refusal.kind,
        message: gate.refusal.message,
        exitAnalogue: gate.refusal.exitAnalogue,
        model: gate.refusal.model,
        tier: gate.refusal.tier,
      },
    };
  }

  // --- Past the gate: from here every path writes exactly one started + completed. ---
  const log = deps.log ?? new EvidenceLog({ env, cwd, guildDir, guildDirs });
  const runId =
    params.runId && params.runId.length > 0 ? params.runId : log.newRun(RESEARCH_COMMAND);

  const outcome = await runAgentLifecycle(
    {
      question: params.question,
      requestedModel,
      agent: RESEARCH_AGENT,
      command: RESEARCH_COMMAND,
      title: "guild_research",
      runId,
      tier: gate.tier,
      confirmed: gate.confirmed,
    },
    {
      serve: deps.serve,
      log,
      messageTimeoutMs:
        deps.messageTimeoutMs ?? params.timeoutMs ?? resolveMessageTimeoutMs({ env, confContents }),
      activity: activityLayerFor({ env, confContents, log, onActivity: deps.onActivity }),
    },
  );

  if (outcome.ok) {
    const ok: ResearchOk = {
      ok: true,
      answer: outcome.text,
      rootConflict,
      attribution: {
        model: outcome.actualModel,
        requestedModel,
        agent: RESEARCH_AGENT,
        runId,
        callId: outcome.callId,
      },
    };
    if (outcome.activity !== undefined) ok.activity = outcome.activity;
    return ok;
  }
  const modelLabel = requestedModel === "" ? "(opencode default)" : requestedModel;
  // agent-mismatch (positive-direction addition over bash; no exit analogue) carries its
  // own message; a plain call failure is wrapped. Both stay exitAnalogue null.
  const message =
    outcome.kind === "agent-mismatch"
      ? outcome.reason
      : `The research call to '${modelLabel}' failed: ${outcome.reason}. No answer was produced.`;
  const fail: ResearchFail = {
    ok: false,
    rootConflict,
    error: {
      kind: outcome.kind,
      model: requestedModel,
      exitAnalogue: null,
      message,
    },
  };
  if (outcome.activity !== undefined) fail.activity = outcome.activity;
  return fail;
}

// --- MCP tool-result translation -------------------------------------------
/**
 * Map a `ResearchResult` to the MCP wire shape. Success: the byte-exact answer is BOTH the
 * text block and `structuredContent.answer`, with exact-id attribution. Failure: the
 * structured error with `isError:true`, so the driver treats a refusal (def-missing,
 * policy, or a failed call) as something to act on, not a normal answer.
 */
export function researchToToolResult(r: ResearchResult): McpToolResult {
  if (r.ok) {
    const structured: Record<string, unknown> = { answer: r.answer, ...r.attribution };
    if (r.rootConflict) structured.rootConflict = r.rootConflict;
    if (r.activity) structured.activity = r.activity;
    return { content: [{ type: "text", text: r.answer }], structuredContent: structured };
  }
  const structured: Record<string, unknown> = { error: r.error };
  if (r.rootConflict) structured.rootConflict = r.rootConflict;
  if (r.activity) structured.activity = r.activity;
  return {
    content: [{ type: "text", text: r.error.message }],
    structuredContent: structured,
    isError: true,
  };
}
