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
import { type ServeProvider, type ServeRouter } from "./client.js";
import { type GitRunner } from "./worktree.js";
import { defaultAgentFloorChecker, type AgentFloorChecker } from "./agentfloor.js";
import { EvidenceLog } from "./log.js";
import {
  resolveRootWithConflict,
  gateModel,
  runAgentLifecycle,
  activityLayerFor,
  approvalFor,
  resolveReadRoot,
  gateAgentFloor,
  readRootBlocks,
  APPROVAL_EXIT_ANALOGUE,
  type McpToolResult,
} from "./consult.js";
import { type ActivityEvent, type ActivitySummary } from "./activity.js";
import { type ApprovalSummary, type ElicitationRequester } from "./approve.js";
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
   * READ ROOT (issue #96): a git worktree of THIS repository to root the investigation's
   * local reads at. Validated against `git worktree list`; anything else is refused by name.
   */
  worktree?: string;
  /**
   * Per-call model-turn HTTP timeout (ms), ALREADY validated/resolved by the server layer
   * (`parsePerCallTimeoutMs`). Precedence over `GUILD_MESSAGE_TIMEOUT_MS` env/conf/default;
   * the test seam `deps.messageTimeoutMs` wins.
   */
  timeoutMs?: number;
}

export interface ResearchDeps {
  serve: ServeProvider;
  /** Serve providers keyed by read root (issue #96); wired to the `ServePool` in production. */
  router?: ServeRouter;
  /** Test seam for the `git worktree list` enumeration (issue #96). */
  git?: GitRunner;
  /** Test seam for a continuation's session-directory lookup (issue #96, finding M3). */
  fetchSessionDirectory?: (sessionId: string) => Promise<string | undefined>;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  home?: string;
  /** Injected in tests so root/policy/log all share one guild dir; else resolved. */
  log?: EvidenceLog;
  messageTimeoutMs?: number;
  /** LIVE sink for each normalized activity event (issue #20) — the MCP progress channel. */
  onActivity?: (e: ActivityEvent) => void;
  /**
   * The MCP elicitation channel (issue #20 slice 4). Only consulted when the approval
   * bridge is armed, which on this read path needs `GUILD_APPROVE_EGRESS=ask`.
   */
  elicitation?: ElicitationRequester;
  /** The resolved-agent floor check (issue #111); injected in tests. */
  agentFloor?: AgentFloorChecker;
}

// --- Result / error shapes -------------------------------------------------
export type ResearchErrorKind =
  | "agent-def-missing"
  // The def FILE is present but opencode is not applying it (issue #111, C73). TWO SHAPES, and
  // they differ in footprint (review B4): the EARLY refusal is decided before any log write and
  // before any snapshot — nothing ran; the LATE one comes from the re-check made inside the turn's
  // own serve lease, so it lands after `expect`/`started` and is recorded like a failed call. Both
  // carry the same `kind`; exit-analogue null either way (no bash counterpart, and NOT a reuse of
  // C57's 5, which means specifically "the def is missing").
  | "agent-unhardened"
  /** The named read root is not a worktree of this repository (issue #96). */
  | "worktree-invalid"
  | "model-id"
  | "policy-deny"
  | "policy-ask"
  // The approval bridge's refusals (issue #20 slice 4). On this READ path they are only
  // reachable under the opt-in `GUILD_APPROVE_EGRESS=ask` knob, which gates webfetch/
  // websearch — the one place the ratified egress harness difference buys a gate.
  | "approval-config"
  | "approval-channel-missing"
  | "approval-not-applied"
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
  /** The read root this call ran against; present only when a worktree was targeted (#96). */
  worktree?: string;
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
  /** Present ONLY when the issue-#111 resolved-agent check could not be made; the call
   * PROCEEDED and this is the "never silently" half of that decision (C73). */
  agentUnverified?: string;
  /** Bounded live-activity summary (issue #20); absent when the layer is off. */
  activity?: ActivitySummary;
  /** Present only when the approval bridge was ARMED for this call (issue #20 slice 4). */
  approval?: ApprovalSummary;
}
export interface ResearchFail {
  ok: false;
  error: ResearchError;
  rootConflict?: string;
  /** See `ResearchOk.agentUnverified`. */
  agentUnverified?: string;
  /** Present when the call actually RAN (call-failed / agent-mismatch). */
  activity?: ActivitySummary;
  /** Present when the bridge was armed and the turn ran. */
  approval?: ApprovalSummary;
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

  // 1b. READ ROOT (issue #96) — see `resolveReadRoot`. A no-op without `worktree`.
  const readRoot = await resolveReadRoot({
    ...(params.worktree !== undefined ? { worktree: params.worktree } : {}),
    env,
    cwd,
    confContents,
    serve: deps.serve,
    ...(deps.router !== undefined ? { router: deps.router } : {}),
    ...(deps.git !== undefined ? { git: deps.git } : {}),
    ...(deps.fetchSessionDirectory !== undefined
      ? { fetchSessionDirectory: deps.fetchSessionDirectory }
      : {}),
  });
  if (!readRoot.ok) {
    return {
      ok: false,
      rootConflict,
      error: {
        kind: "worktree-invalid",
        model: "",
        exitAnalogue: null,
        message: readRoot.message,
      },
    };
  }
  const { serve, agentDefDirs, worktree: worktreeRoot } = readRoot.value;

  // 2. NO-FALLBACK def gate (deviation from bash C16, task-directed). If the hardened
  //    guild-research def is not present in the resolved agent-def dir, REFUSE loudly —
  //    never silently degrade to a weaker agent. Refused before any log write (gap parity).
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

  // 4b. RESOLVED-AGENT GATE (issue #111, C73) — stage two of the def check: the file exists,
  //     but is opencode APPLYING it? Before any log write and before the approval pre-flight
  //     (which reads the def SOURCE and would otherwise arm against a map that is not in
  //     force). See `gateAgentFloor`.
  /** ONE per call, shared by the early gate and the in-lease re-check: the stderr dedupe is
   * keyed on the child instance WITHIN a call, so the same child warns once, a different serving
   * child warns again, and the next call starts fresh (review B1). */
  const announced = new Set<string>();
  const floor = await gateAgentFloor({
    serve,
    agent: RESEARCH_AGENT,
    agentDefDirs,
    announced,
    ...(deps.agentFloor !== undefined ? { checker: deps.agentFloor } : {}),
  });
  if (!floor.ok) {
    return {
      ok: false,
      rootConflict,
      error: { kind: "agent-unhardened", model: "", exitAnalogue: null, message: floor.message },
    };
  }
  /** THE EFFECTIVE cannot-ask NOTE, in a box because the late check fills it DURING the turn
   * (review B1). Seeded from the early verdict; the in-lease re-check writes here when it is the
   * one that could not verify — the case where the early gate said `verified` about a child that
   * `GUILD_SERVE_PER_CALL=1`, a crash-revive or an idle-out has since replaced. Reads before the
   * turn see only the early note, which is correct: the late one has not happened yet. */
  const floorNote: { note?: string } = {};
  if (floor.unverified !== undefined) floorNote.note = floor.unverified;
  /** A3: the same checker, re-asked inside the turn's own lease (a cache hit on the shared
   * child; a real check under `GUILD_SERVE_PER_CALL=1`, where the early lease is already gone). */
  const preTurnCheck = (deps.agentFloor ?? defaultAgentFloorChecker).preTurnCheck(
    RESEARCH_AGENT,
    agentDefDirs,
    {
      announced,
      // Without this the late verdict reached NO channel when the early one was `verified`.
      onUnverified: (note) => {
        if (floorNote.note === undefined) floorNote.note = note;
      },
    },
  );

  // --- Past the gate. Constructing the log writes NOTHING (only `newRun` does). ---
  const log = deps.log ?? new EvidenceLog({ env, cwd, guildDir, guildDirs });

  // 4c. APPROVAL BRIDGE pre-flight (issue #20 slice 4). On the read paths this only arms
  //     under the separate, opt-in `GUILD_APPROVE_EGRESS=ask`; `GUILD_APPROVE` alone gates
  //     nothing here, because guild-research holds none of edit/write/patch/bash.
  const armed = approvalFor({
    agent: RESEARCH_AGENT,
    env,
    confContents,
    agentDefDirs,
    log,
    ...(deps.elicitation !== undefined ? { elicitation: deps.elicitation } : {}),
  });
  if (!armed.ok) {
    return {
      ok: false,
      rootConflict,
      ...(floorNote.note !== undefined ? { agentUnverified: floorNote.note } : {}),
      error: {
        kind: armed.refusal.kind,
        model: requestedModel,
        exitAnalogue: APPROVAL_EXIT_ANALOGUE,
        message: armed.refusal.message,
      },
    };
  }

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
      ...(worktreeRoot !== undefined ? { readRoot: worktreeRoot } : {}),
    },
    {
      serve,
      log,
      preTurnCheck,
      messageTimeoutMs:
        deps.messageTimeoutMs ?? params.timeoutMs ?? resolveMessageTimeoutMs({ env, confContents }),
      activity: activityLayerFor({ env, confContents, log, onActivity: deps.onActivity }),
      ...(armed.approval !== undefined ? { approval: armed.approval } : {}),
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
        ...(worktreeRoot !== undefined ? { worktree: worktreeRoot } : {}),
      },
    };
    if (outcome.activity !== undefined) ok.activity = outcome.activity;
    if (outcome.approval !== undefined) ok.approval = outcome.approval;
    if (floorNote.note !== undefined) ok.agentUnverified = floorNote.note;
    return ok;
  }
  const modelLabel = requestedModel === "" ? "(opencode default)" : requestedModel;
  // agent-mismatch (positive-direction addition over bash; no exit analogue) carries its
  // own message; a plain call failure is wrapped. Both stay exitAnalogue null.
    // `agent-unhardened` joins these: it is a REFUSAL carrying its own actionable message
    // (agent named, resolved action, remedy), and the command docs tell the driver to report
    // it verbatim. Wrapping it produced "the call to X failed: <message>. Any changes ... see
    // capture.patchPath" with a null patchPath and no model call — plus a doubled period
    // (review B4). The two shapes of one kind now read the same.
  const message =
    outcome.kind === "agent-mismatch" ||
    outcome.kind === "approval-not-applied" ||
    outcome.kind === "agent-unhardened"
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
  if (outcome.approval !== undefined) fail.approval = outcome.approval;
  if (floorNote.note !== undefined) fail.agentUnverified = floorNote.note;
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
    if (r.agentUnverified) structured.agentUnverified = r.agentUnverified;
    if (r.activity) structured.activity = r.activity;
    if (r.approval) structured.approval = r.approval;
    // The read-root note rides as a SECOND text block, never a prefix — `content[0]` must
    // stay the byte-exact answer (issue #96, review finding L7; see `readRootBlocks`).
    return {
      content: [{ type: "text", text: r.answer }, ...readRootBlocks(r.attribution.worktree)],
      structuredContent: structured,
    };
  }
  const structured: Record<string, unknown> = { error: r.error };
  if (r.rootConflict) structured.rootConflict = r.rootConflict;
  if (r.agentUnverified) structured.agentUnverified = r.agentUnverified;
  if (r.activity) structured.activity = r.activity;
  if (r.approval) structured.approval = r.approval;
  return {
    content: [{ type: "text", text: r.error.message }],
    structuredContent: structured,
    isError: true,
  };
}
