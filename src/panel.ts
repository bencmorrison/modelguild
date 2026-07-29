/**
 * guild_panel — multi-model orchestration over the committed substrate.
 *
 * Generalizes the single-call guild_consult flow (src/consult.ts) to a PANEL: ask the
 * SAME question to 2–3 models from (ideally) different families, concurrently, each
 * through the UNMODIFIED read-only `guild-read` agent, and return every model's answer
 * with EXACT-ID attribution (panel.md "Report the exact model ids used" — area-F command
 * surface; NOT C45, which is verify-not-relay). It is a TRANSPORT, not a synthesizer: there is no
 * tie-breaking or reconciliation here — the DRIVER (the `/guild:panel` command doc)
 * synthesizes and preserves disagreement. Keeping the tool a transport is what stops it
 * from silently substituting its own take for the panel's (the command doc's job).
 *
 * PER-CALL INDEPENDENCE (matches bash, where each panel member is its own `ask.sh`):
 *   - Model-set resolution is `resolvePanelModels` (C13/C14), WIRED not reimplemented —
 *     its dedup + <2-model + single-provider "diversity theater" warnings are surfaced in
 *     the result, never swallowed.
 *   - Each member is gated INDEPENDENTLY (`gateModel`): a deny-tier member yields a
 *     per-model policy error while the others still run; an ask-tier member without
 *     confirmed yields the consult-style ask error for THAT member; a leading-dash id
 *     yields a per-member model-id error. A refused member logs NOTHING (C24 gap parity).
 *   - A member whose model call THROWS records completed/failed and surfaces a per-model
 *     call-failed error; it NEVER aborts the other members (Promise.all resolves each to
 *     a result object, so no member's rejection can reject the whole panel).
 *   - The WHOLE panel refuses up front in two cases: the hardened guild-read def is absent
 *     (agent-def-missing, exit-5 analogue — one check for every member, the NO-FALLBACK
 *     deviation guild_research/guild_delegate also make), or the resolved model set is EMPTY
 *     (C14 exit-2).
 *
 * CONFIRMED IS PANEL-WIDE (documented honestly): a single `confirmed:true` on the panel
 * call approves EVERY ask-tier member of THIS call — the human is asked once about "this
 * panel", not once per model. That is a deliberately wider scope than guild_consult's
 * single-model confirm; it is recorded per-member in the evidence entries (tier/confirmed)
 * so a reader of the log can still audit, after the fact, that an ask-tier member ran under
 * a claimed approval. Same non-witness-grade bound as consult: a driver that sets confirmed
 * without asking is caught by audit, not prevented.
 *
 * ONE RUN FOR THE WHOLE PANEL (C23/C43): a single runId groups the workflow. It is minted
 * up front (or threaded from `runId`) so all members log into one auditable unit; each
 * member still gets its OWN call_id and its own expect→started→completed lifecycle with
 * DISTINCT turns under the shared lock (the log layer already proves concurrent
 * distinct-turn integrity; the panel test pins it again at this level).
 */

import os from "node:os";
import { type ServeProvider, type ServeRouter } from "./client.js";
import { type GitRunner } from "./worktree.js";
import { EvidenceLog } from "./log.js";
import {
  resolveRootWithConflict,
  gateModel,
  runAgentLifecycle,
  activityLayerFor,
  approvalFor,
  resolveReadRoot,
  APPROVAL_EXIT_ANALOGUE,
  type McpToolResult,
} from "./consult.js";
import { type ActivityEvent, type ActivitySummary } from "./activity.js";
import { type ApprovalSummary, type ElicitationRequester } from "./approve.js";
import {
  readLayeredConfContents,
  resolvePanelModels,
  resolveMessageTimeoutMs,
  resolveAgentDefDirs,
  hardenedDefPresentIn,
} from "./config.js";
import { type PolicyTier } from "./policy.js";

/** The read-only agent every panel member uses, unmodified (C15/C47/C48). */
export const PANEL_AGENT = "guild-read";
/** The command label recorded in the evidence log. */
export const PANEL_COMMAND = "/guild:panel";

// --- Params + deps ---------------------------------------------------------
export interface PanelParams {
  question: string;
  /** Explicit provider/model ids. Omit to fall back to $GUILD_MODELS then conf (C13). */
  models?: string[];
  /** Thread this call into an existing run; omit to mint one for the whole panel. */
  runId?: string;
  /** Human approval for ANY ask-tier member of this panel call (panel-wide scope). */
  confirmed?: boolean;
  /**
   * ROUND 1 of `/guild:workshop` (M7 / Option B). Keep every member's session alive
   * and return its id per-member (`PanelMemberResult.sessionId`), so round 2 can CONTINUE
   * each member's own session. Round 2 is NOT a panel feature: it is N independent
   * continuations, each threading a distinct sessionId with a distinct prompt — that is
   * exactly `guild_consult({ sessionId, keepSession? })`. Keeping panel a fan-out-only
   * primitive (same question → many FRESH models) and doing round 2 as a per-member
   * consult loop avoids duplicating consult's continuation logic here and keeps each
   * tool's identity crisp. The driver shares one `runId` across both rounds so the whole
   * workshop is one auditable run. Default (unset) deletes each session after its turn.
   */
  keepSessions?: boolean;
  /**
   * READ ROOT for the WHOLE panel (issue #96): a git worktree of THIS repository every
   * member reads against. Validated against `git worktree list`; anything else refuses the
   * panel by name before a single member is dispatched. It is deliberately panel-WIDE — a
   * panel exists to put ONE question to several models, and members reading different trees
   * would make their answers incomparable while looking as if they disagreed.
   */
  worktree?: string;
  /**
   * Per-call model-turn HTTP timeout (ms), ALREADY validated/resolved by the server layer
   * (`parsePerCallTimeoutMs`). Applies to EVERY member of this panel. Precedence: over
   * `GUILD_MESSAGE_TIMEOUT_MS` env/conf/default; the test seam `deps.messageTimeoutMs` wins.
   */
  timeoutMs?: number;
}

export interface PanelDeps {
  serve: ServeProvider;
  /** Serve providers keyed by read root (issue #96); wired to the `ServePool` in production. */
  router?: ServeRouter;
  /** Test seam for the `git worktree list` enumeration (issue #96). */
  git?: GitRunner;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  home?: string;
  /** Injected in tests so root/policy/log share one guild dir; else resolved. */
  log?: EvidenceLog;
  messageTimeoutMs?: number;
  /** LIVE sink for each normalized activity event (issue #20). Every member's events flow
   * through this ONE sink, so attribution has to be carried on the events themselves: each
   * member's recorder stamps its `model` and `callId` on the way out (see
   * `ActivityRecorder#handle`), which is what stops a 3-model panel's progress lines from
   * interleaving into an anonymous blur. Two caveats, both real: a `file.edited` event
   * carries no session id and is broadcast to every member flagged `unattributed`, and the
   * MCP progress channel has a single token for the whole call, so the per-line model label
   * is the only thing distinguishing members there. */
  onActivity?: (e: ActivityEvent) => void;
  /**
   * The MCP elicitation channel (issue #20 slice 4). ONE arming decision covers the whole
   * panel (every member runs the same guild-read agent), and each member gets its own bridge
   * so its requests and decisions stay attributable to that member.
   */
  elicitation?: ElicitationRequester;
}

// --- Result / error shapes -------------------------------------------------
export type PanelMemberErrorKind =
  | "model-id"
  | "policy-deny"
  | "policy-ask"
  /** Only reachable under the opt-in `GUILD_APPROVE_EGRESS=ask` (issue #20 slice 4). */
  | "approval-not-applied"
  | "call-failed"
  | "agent-mismatch";

export interface PanelMemberError {
  kind: PanelMemberErrorKind;
  message: string;
  /** bash exit analogue: 2 model-id, 3 deny, 4 ask; null for a call-failed (see consult). */
  exitAnalogue: number | null;
  /** Present on policy errors: the tier that refused. */
  tier?: PolicyTier;
}

/** One panel member's outcome — exactly one of `text` / `error` is set. `model` is the
 * EXACT id (area-F command surface, panel.md): the resolved/actual id on success, the
 * requested id on a refusal. */
export interface PanelMemberResult {
  model: string;
  text?: string;
  error?: PanelMemberError;
  /** Set once the member reached the lifecycle (success OR call-failed); absent for a
   * pre-log refusal (model-id/deny/ask), which writes no call. */
  callId?: string;
  /** The member's opencode session id — present ONLY when `keepSessions` was requested
   * AND the call succeeded. Pass it back as `guild_consult({ sessionId })` for round 2. */
  sessionId?: string;
  /** This member's bounded live-activity summary (issue #20). PER MEMBER, not per panel:
   * one merged blob would lose which model did what. Absent when the layer is off or the
   * member was refused before it ran. */
  activity?: ActivitySummary;
  /** PER MEMBER, like `activity`: present only when the approval bridge was armed (issue
   * #20 slice 4) — which on this read path needs `GUILD_APPROVE_EGRESS=ask`. */
  approval?: ApprovalSummary;
}

export interface PanelOk {
  ok: true;
  runId: string;
  /** Per-member results in INPUT ORDER; exact-id attribution (area-F command surface). */
  results: PanelMemberResult[];
  /** resolvePanelModels warnings (dedup, <2 models, single-provider) — surfaced, C14. */
  warnings: string[];
  rootConflict?: string;
  /** The read root every member ran against; present only when one was targeted (#96). */
  worktree?: string;
}

export interface PanelFail {
  ok: false;
  /**
   * The whole panel refused, up front, for one of two reasons:
   *   - `agent-def-missing` (exit-5 analogue, C57): the hardened guild-read def every member
   *     needs is absent — one check for the whole panel (all members use the same agent), the
   *     NO-FALLBACK deviation from bash C16 that guild_research/guild_delegate also make.
   *   - `no-models` (exit-2 analogue, C14): the resolved model set was empty.
   */
  error:
    | { kind: "agent-def-missing"; message: string; exitAnalogue: number }
    | { kind: "no-models"; message: string; exitAnalogue: number }
    // The named read root is not a worktree of this repository (issue #96). Panel-wide,
    // like the def check, and refused before any member runs.
    | { kind: "worktree-invalid"; message: string; exitAnalogue: null }
    // Panel-wide, like the def check: every member runs the same agent, so a bad approval
    // knob or a missing answering channel refuses the WHOLE panel up front — before any log
    // write, and before a single member is dispatched.
    | { kind: "approval-config"; message: string; exitAnalogue: null }
    | { kind: "approval-channel-missing"; message: string; exitAnalogue: null };
  warnings: string[];
  rootConflict?: string;
}

export type PanelResult = PanelOk | PanelFail;

/**
 * Run one panel. Never throws for an expected refusal or a member failure — both are
 * data. A member's model call that throws is caught inside `runAgentLifecycle` and
 * surfaced as a per-member `call-failed`; `Promise.all` therefore never rejects.
 */
export async function panel(params: PanelParams, deps: PanelDeps): Promise<PanelResult> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const home = deps.home ?? os.homedir();

  // 1. Resolve the config root LAYERS ONCE (project over global baseline — issue #19).
  const rootRes = resolveRootWithConflict(env, cwd, home);
  const guildDirs = rootRes.layers.map((l) => l.root);
  const guildDir = rootRes.root; // PRIMARY: where the evidence log writes.
  const rootConflict = rootRes.conflict;
  const confContents = readLayeredConfContents(guildDirs, env);

  // 2. NO-FALLBACK def gate for the WHOLE panel (deviation from bash C16, mirroring
  //    guild_research/guild_delegate). Every member runs through the SAME hardened guild-read
  //    agent, so one presence check up front decides the whole panel: if the def is absent,
  //    REFUSE loudly rather than run any member on whatever opencode resolves in its place.
  //    Refused BEFORE the model-set resolution and any log write (gap parity) — no member runs.
  // 1b. READ ROOT for the whole panel (issue #96) — see `resolveReadRoot`. A no-op without
  //     `worktree`; with it, every member is routed to a serve child rooted there and the
  //     agent-def dirs move with it. Refused before the model set is even resolved.
  const readRoot = resolveReadRoot({
    ...(params.worktree !== undefined ? { worktree: params.worktree } : {}),
    env,
    cwd,
    confContents,
    serve: deps.serve,
    ...(deps.router !== undefined ? { router: deps.router } : {}),
    ...(deps.git !== undefined ? { git: deps.git } : {}),
  });
  if (!readRoot.ok) {
    return {
      ok: false,
      warnings: [],
      rootConflict,
      error: { kind: "worktree-invalid", message: readRoot.message, exitAnalogue: null },
    };
  }
  const { serve, agentDefDirs, worktree: worktreeRoot } = readRoot.value;

  if (!hardenedDefPresentIn(PANEL_AGENT, agentDefDirs).present) {
    return {
      ok: false,
      warnings: [],
      rootConflict,
      error: {
        kind: "agent-def-missing",
        exitAnalogue: 5,
        message:
          `The hardened '${PANEL_AGENT}' agent def (${PANEL_AGENT}.md) was not found in ` +
          `any of: ${agentDefDirs.join(", ")}. Refusing to run the panel: unlike the bash path ` +
          `there is NO fallback to a weaker agent, because silently degrading a hardened path ` +
          `while the caller still expects its guarantees is worse than refusing. Install the ` +
          `def (per-project or via 'init --global'), or set GUILD_AGENT_DIR to where it lives, ` +
          `and retry.`,
      },
    };
  }

  // 3. Resolve the panel's model set (args > $GUILD_MODELS > conf), WIRING C13/C14's
  //    resolvePanelModels — dedup, order, and the diversity/shape warnings intact.
  const panelRes = resolvePanelModels({ args: params.models, env, confContents });
  if (panelRes.error !== undefined || panelRes.models.length === 0) {
    return {
      ok: false,
      warnings: panelRes.warnings,
      rootConflict,
      error: {
        kind: "no-models",
        message:
          panelRes.error ??
          "no models resolved for the panel. Pass provider/model ids, set GUILD_MODELS, or add a GUILD_MODELS= line to modelguild.conf.local.",
        exitAnalogue: panelRes.exitCode ?? 2,
      },
    };
  }

  // 4. One run for the whole panel (C23/C43). Mint up front so every member logs into the
  //    same auditable unit; a threaded runId reuses that run.
  const log = deps.log ?? new EvidenceLog({ env, cwd, guildDir, guildDirs });

  // 4b. APPROVAL BRIDGE pre-flight for the WHOLE panel (issue #20 slice 4), before `newRun`
  //     so a refusal writes nothing. One check: every member uses the same guild-read agent,
  //     so what is gated and whether anyone can answer is identical for all of them.
  const armed = approvalFor({
    agent: PANEL_AGENT,
    env,
    confContents,
    agentDefDirs,
    log,
    ...(deps.elicitation !== undefined ? { elicitation: deps.elicitation } : {}),
  });
  if (!armed.ok) {
    return {
      ok: false,
      warnings: panelRes.warnings,
      rootConflict,
      error: {
        kind: armed.refusal.kind,
        message: armed.refusal.message,
        exitAnalogue: APPROVAL_EXIT_ANALOGUE,
      },
    };
  }

  const runId = params.runId && params.runId.length > 0 ? params.runId : log.newRun(PANEL_COMMAND);
  const confirmed = params.confirmed === true;
  const keepSessions = params.keepSessions === true;
  // Loop-invariant: resolve the per-turn timeout once for the whole panel. A per-call
  // param (validated by the server) applies to every member; else env/conf/default.
  const messageTimeoutMs =
    deps.messageTimeoutMs ?? params.timeoutMs ?? resolveMessageTimeoutMs({ env, confContents });
  // ONE activity layer for the panel; each member's recorder is minted per call and routes
  // by its own opencode session id, so concurrent members never see each other's events.
  const activity = activityLayerFor({ env, confContents, log, onActivity: deps.onActivity });

  // 5. Members run CONCURRENTLY; each is gated + logged independently. One member's
  //    refusal or failure never touches another's result (order preserved by Promise.all).
  const results = await Promise.all(
    panelRes.models.map(async (model): Promise<PanelMemberResult> => {
      const gate = gateModel(model, confirmed, { guildDirs, env });
      if (!gate.ok) {
        // A pre-log refusal: no call_id, nothing written for this member (gap parity).
        return {
          model,
          error: {
            kind: gate.refusal.kind,
            message: gate.refusal.message,
            exitAnalogue: gate.refusal.exitAnalogue,
            tier: gate.refusal.tier,
          },
        };
      }
      const outcome = await runAgentLifecycle(
        {
          question: params.question,
          requestedModel: model,
          agent: PANEL_AGENT,
          command: PANEL_COMMAND,
          title: "guild_panel",
          runId,
          tier: gate.tier,
          confirmed: gate.confirmed,
          keepSession: keepSessions,
        },
        {
          serve,
          log,
          messageTimeoutMs,
          activity,
          ...(armed.approval !== undefined ? { approval: armed.approval } : {}),
        },
      );
      if (outcome.ok) {
        const member: PanelMemberResult = {
          model: outcome.actualModel,
          text: outcome.text,
          callId: outcome.callId,
        };
        // Return the id ONLY when kept — a deleted session's id is a dangling reference.
        if (keepSessions) member.sessionId = outcome.sessionId;
        if (outcome.activity !== undefined) member.activity = outcome.activity;
        if (outcome.approval !== undefined) member.approval = outcome.approval;
        return member;
      }
      // A FAILED member (call-failed OR agent-mismatch) carries NO sessionId even under
      // keepSessions — its session was cleaned up by the deletion matrix (or never usably
      // created), so there is no live session to continue; fabricating an id would send a
      // round-2 continuation at a dead/wrong session. The absent sessionId is exactly what
      // makes the round-2 consult loop skip this member.
      const message =
        outcome.kind === "agent-mismatch" || outcome.kind === "approval-not-applied"
          ? outcome.reason
          : `The panel call to '${model}' failed: ${outcome.reason}. No answer was produced.`;
      const failed: PanelMemberResult = {
        model,
        callId: outcome.callId,
        error: {
          kind: outcome.kind,
          exitAnalogue: null,
          message,
        },
      };
      if (outcome.activity !== undefined) failed.activity = outcome.activity;
      if (outcome.approval !== undefined) failed.approval = outcome.approval;
      return failed;
    }),
  );

  return {
    ok: true,
    runId,
    results,
    warnings: panelRes.warnings,
    rootConflict,
    ...(worktreeRoot !== undefined ? { worktree: worktreeRoot } : {}),
  };
}

// --- MCP tool-result translation -------------------------------------------
/**
 * Render a human-readable digest for the tool's text block. The DRIVER synthesizes from
 * `structuredContent` (the machine-readable per-member results); this text is a readable
 * mirror so a bare text-only client still sees every voice and every warning.
 */
function renderPanelText(r: PanelOk): string {
  const lines: string[] = [];
  lines.push(`Panel of ${r.results.length} model(s) — run ${r.runId || "(logging off)"}.`);
  if (r.worktree) lines.push(`Read root: ${r.worktree}`);
  if (r.rootConflict) lines.push(`Root: ${r.rootConflict}`);
  if (r.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const w of r.warnings) lines.push(`  - ${w}`);
  }
  for (const m of r.results) {
    lines.push("");
    lines.push(`## ${m.model}`);
    if (m.error) lines.push(`ERROR (${m.error.kind}): ${m.error.message}`);
    else lines.push(m.text ?? "");
  }
  return lines.join("\n");
}

/**
 * Map a `PanelResult` to the MCP wire shape. On success the text block is the readable
 * digest and `structuredContent` carries the per-member results + warnings + runId (the
 * driver's real input). A whole-panel refusal (empty set) sets `isError:true` so the
 * driver treats it as a refusal to act on — a per-member error does NOT set `isError`,
 * because the panel call itself succeeded (that error is data about one voice).
 */
export function panelToToolResult(r: PanelResult): McpToolResult {
  if (!r.ok) {
    const structured: Record<string, unknown> = { error: r.error, warnings: r.warnings };
    if (r.rootConflict) structured.rootConflict = r.rootConflict;
    return {
      content: [{ type: "text", text: r.error.message }],
      structuredContent: structured,
      isError: true,
    };
  }
  const structured: Record<string, unknown> = {
    runId: r.runId,
    results: r.results,
    warnings: r.warnings,
  };
  if (r.rootConflict) structured.rootConflict = r.rootConflict;
  if (r.worktree) structured.worktree = r.worktree;
  return { content: [{ type: "text", text: renderPanelText(r) }], structuredContent: structured };
}
