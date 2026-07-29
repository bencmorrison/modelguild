/**
 * guild_consult — the first PRODUCTION tool.
 *
 * Composes the four committed layers into the read-only "second opinion" flow the bash
 * `/guild:consult` gives, translated to the MCP surface:
 *
 *   config root (resolved ONCE, multi-root conflict surfaced)  ── config.ts
 *     → model resolution + leading-dash refusal (C12)          ── config.ts
 *     → policy gate deny/ask/allow (C1–C7)                     ── policy.ts
 *     → evidence lifecycle expect→started→completed (C22–C25)  ── log.ts
 *     → the model turn via the UNMODIFIED guild-read agent    ── client.ts
 *
 * The bash exit codes (CONTRACT.md area H) become STRUCTURED tool errors, not process
 * exits: a denied model is exit 3 → a `policy-deny` error naming the model and tier; an
 * `ask`-tier model without `confirmed:true` is exit 4 → a `policy-ask` error whose text
 * instructs the DRIVER to ask the human and retry with `confirmed:true`. That is C41's
 * two-layer defense on the MCP side: Claude cannot self-confirm silently because the
 * mechanical gate lives here (the tool), and the error text says the USER must be asked.
 *
 * EVIDENCE-GAP PARITY (C24). Everything that can refuse the call — a leading-dash model
 * id, a policy deny, an unconfirmed ask — refuses BEFORE `expect` is written, so a
 * refused call logs NOTHING (matching ask.sh, which refuses before it logs). Once
 * `expect` is written, EVERY path (success, empty answer, thrown model call) ends in
 * exactly one `started` + one `completed`, so the log never carries a dangling
 * expected-call. A thrown model call records `completed` with `capture_state:failed` and
 * returns a `call-failed` error carrying the reason — NEVER a fabricated answer.
 *
 * Logging is best-effort and never fails the call it records (C31): the log layer's write
 * methods already return `{ok}` instead of throwing, and this flow ignores their `ok`.
 */

import { randomBytes } from "node:crypto";
import os from "node:os";
import {
  askViaAgent,
  AgentMismatchError,
  SessionPermissionMismatchError,
  type ServeProvider,
  type ServeRouter,
} from "./client.js";
import { resolveWorktreeTarget, type GitRunner } from "./worktree.js";
import { EvidenceLog } from "./log.js";
import {
  candidateRoots,
  layeredRoots,
  readLayeredConfContents,
  resolveModel,
  resolveMessageTimeoutMs,
  checkResolvedModelId,
  resolveAgentDefDirs,
  hardenedDefPresentIn,
  resolveActivitySettings,
  type GuildRoot,
  type RootSource,
} from "./config.js";
import {
  policyTierAcross,
  resolvePolicyLayers,
  type PolicyTier,
  type PolicySource,
  type PolicyLayer,
} from "./policy.js";
import {
  createActivityLayer,
  type ActivityEvent,
  type ActivityLayer,
  type ActivityRecorder,
  type ActivitySummary,
} from "./activity.js";
import {
  approvalDoctorInfo,
  armApproval,
  type ApprovalArming,
  type ApprovalBridge,
  type ApprovalRefusal,
  type ApprovalDoctorInfo,
  type ApprovalSummary,
  type ElicitationRequester,
} from "./approve.js";

/** The read-only agent this tool ALWAYS uses, unmodified (C15/C47/C48). */
export const CONSULT_AGENT = "guild-read";
/** The command label recorded in the evidence log. */
export const CONSULT_COMMAND = "/guild:consult";

// --- Root resolution + layering / shadowing surfacing (issue #19) ----------
export interface RootResolution {
  /** The PRIMARY root — the most-specific layer. Writes (the evidence `logs/`) go here. */
  root: string;
  source: RootSource;
  /** The READ layers actually in effect, most-specific first (project over global). */
  layers: GuildRoot[];
  /** Every root that exists on disk, precedence order (env > project > home). */
  candidates: GuildRoot[];
  /**
   * Set ONLY when a root that exists on disk is NOT layered — which, since #19, happens
   * for exactly one reason: an explicit `$GUILD_ROOT` single-root override. A project
   * root sitting above a global one is no longer a conflict; it is the design.
   */
  conflict?: string;
}

/**
 * Resolve the guild root layers ONCE, and describe the one case where a root on disk is
 * NOT contributing, so the caller (tool metadata + `guild_status`) can surface it.
 *
 * BEFORE #19 this reported "multiple roots exist, one SHADOWS the others" — because it did.
 * Now the project layer sits ON TOP of the global baseline and both bind, so that is no
 * longer a warning: nothing is silently lost. What IS still lossy is `$GUILD_ROOT`, which
 * is a deliberate single-root override (see `layeredRoots`) — so when it is set AND some
 * other root exists on disk, say plainly that the global baseline is not layered under it.
 */
export function resolveRootWithConflict(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  home: string = os.homedir(),
): RootResolution {
  const layers = layeredRoots(env, cwd, home);
  const chosen = layers[0];
  const candidates = candidateRoots(env, cwd, home);
  const override = env.GUILD_ROOT;
  const hasOverride = override !== undefined && override.length > 0;
  let conflict: string | undefined;
  if (hasOverride) {
    const unlayered = candidates.filter((c) => c.source !== "env" && c.root !== chosen.root);
    if (unlayered.length > 0) {
      conflict =
        `$GUILD_ROOT is set (${chosen.root}) — that is a SINGLE-ROOT override, so these roots ` +
        `that exist on disk are NOT layered under it: ` +
        `${unlayered.map((r) => `${r.source} (${r.root})`).join(", ")}. ` +
        `Their policy and preferences do NOT bind. Unset $GUILD_ROOT to get the layered ` +
        `resolution (project over global baseline).`;
    }
  }
  return { root: chosen.root, source: chosen.source, layers, candidates, conflict };
}

// --- Doctor-seed checks (M4 "doctor MUST warn"; surfaced by guild_status) --
export interface GuildDoctorSeed {
  /**
   * The PRIMARY guild root (writes/logs), the ordered READ layers now in effect
   * (project over global baseline — issue #19), and the note set only when a root on
   * disk is NOT layered (an explicit `$GUILD_ROOT`).
   */
  guildRoot: {
    root: string;
    source: RootSource;
    layers: Array<{ root: string; source: RootSource }>;
    conflict: string | null;
  };
  /**
   * The model-policy resolution: `file`/`source` are the most-specific slot (what the
   * pre-#19 shape reported), and `layers` is the FULL chain a verdict walks, most-specific
   * first — so `doctor` can show both the project and the global layer.
   */
  policy: { file: string; source: PolicySource; layers: PolicyLayer[] };
  /** Evidence layer on/off and the effective log directory. */
  logging: { enabled: boolean; logDir: string };
  /** The approval bridge's knobs and whether anything can answer (issue #20 slice 4). A
   * token-free answer to "am I actually gated, and why did that call refuse?". */
  approval: ApprovalDoctorInfo;
}

/**
 * The filesystem/env checks M4 made a precondition for production: multi-root conflict,
 * the active policy file + source, and logging on/off + effective dir. No serve needed.
 * Pure and injectable so `guild_status` and its test drive the SAME code.
 *
 * CALLER-BEWARE (deliberate, not a bug): an explicit `$GUILD_ROOT` pointing at a root
 * that has NO policy file resolves to default-allow (C4) — and, being a single-root
 * override, nothing is layered beneath it, so a global policy does NOT rescue it. So
 * `policy.source` may read `committed`/`local` for a file that does not exist there; every
 * model is then allowed. `policy.layers` carries each layer's `exists` flag so the operator
 * can see that directly rather than assuming a policy binds when none is present.
 */
export function guildDoctorSeed(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  home: string = os.homedir(),
): GuildDoctorSeed {
  const rootRes = resolveRootWithConflict(env, cwd, home);
  const guildDirs = rootRes.layers.map((l) => l.root);
  const guildDir = rootRes.root;
  const layers = resolvePolicyLayers(guildDirs, env);
  const head = layers.find((l) => l.exists) ?? layers[0];
  const log = new EvidenceLog({ env, cwd, guildDir, guildDirs });
  const confContents = readLayeredConfContents(guildDirs, env);
  return {
    guildRoot: {
      root: rootRes.root,
      source: rootRes.source,
      layers: rootRes.layers.map((l) => ({ root: l.root, source: l.source })),
      conflict: rootRes.conflict ?? null,
    },
    policy: { file: head.file, source: head.source, layers },
    logging: { enabled: log.enabled(), logDir: log.logDir() },
    approval: approvalDoctorInfo({ env, confContents, logDir: log.logDir() }),
  };
}

// --- Result / error shapes -------------------------------------------------
export type ConsultErrorKind =
  | "agent-def-missing"
  // The review target named a directory that is not a worktree of this repository
  // (issue #96). Refused before any log write, like every other pre-call refusal.
  | "worktree-invalid"
  | "model-id"
  | "policy-deny"
  | "policy-ask"
  // The approval bridge's three refusals (issue #20 slice 4). `approval-config` and
  // `approval-channel-missing` are decided BEFORE any log write (gap parity, C24);
  // `approval-not-applied` needs a serve round-trip, so it lands as a completed-with-failure
  // call that never reached the model.
  | "approval-config"
  | "approval-channel-missing"
  | "approval-not-applied"
  | "call-failed"
  | "agent-mismatch";

export interface ConsultAttribution {
  /** The EXACT model id used (consult.md reports the model id used — area-F command
   * surface; NOT C45, which is verify-not-relay): the resolved id, or the id opencode actually ran
   * (from the turn metadata) when the caller left it to opencode's default. */
  model: string;
  /** The id we resolved and asked for — `""` means "opencode's own default". */
  requestedModel: string;
  agent: string;
  runId: string;
  callId: string;
  /** The read root this call actually ran against, present ONLY when the caller targeted a
   * worktree (issue #96). Reported so a review can state which tree it read — a review of
   * the wrong tree is the failure the target exists to prevent. */
  worktree?: string;
}

export interface ConsultError {
  kind: ConsultErrorKind;
  message: string;
  /**
   * The bash exit code this maps to: 5 agent-def-missing (C57), 2 model-id (C55), 3 deny
   * (C56), 4 ask (C56). For a `call-failed`/`agent-mismatch` this is **null**, NOT 0 — bash
   * propagates opencode's own non-zero status verbatim (C53) with no fixed ModelGuild code, and
   * 0 is reserved for success (C53), so a numeric code here would be a lie. `kind` + `isError`
   * is the failure signal; the message carries the underlying reason.
   */
  exitAnalogue: number | null;
  /** The model id involved, for a machine-readable error envelope. */
  model: string;
  /** Present on policy errors: the tier that produced the refusal. */
  tier?: PolicyTier;
}

export interface ConsultOk {
  ok: true;
  answer: string;
  attribution: ConsultAttribution;
  /** Multi-root conflict note, if any (surfaced, never fatal). */
  rootConflict?: string;
  /**
   * The opencode session id, returned ONLY when `keepSession` was requested (a deleted
   * session's id is useless). This is the sole way a caller threads a follow-up turn:
   * pass it back as `sessionId`. There is deliberately NO parameter for handing back the
   * peer's previous ANSWER — continuation is by session id, never by re-transmitting the
   * other model's words (the "Option B" session-continuation guarantee).
   */
  sessionId?: string;
  /** Bounded live-activity summary for this call (issue #20); absent when the layer is
   * off. `activity.degraded` means the stream was lost — a quiet list is then "we could
   * not see", not "the model did nothing". */
  activity?: ActivitySummary;
  /** Present only when the approval bridge was ARMED for this call (issue #20 slice 4):
   * what was gated, which channels could answer, and how each request was settled. Its
   * `note` carries the honest bound — approval is not containment. */
  approval?: ApprovalSummary;
}
export interface ConsultFail {
  ok: false;
  error: ConsultError;
  /** Even on a refusal, tell the caller which root's policy did the refusing. */
  rootConflict?: string;
  /** Present when the call actually RAN (call-failed / agent-mismatch): the action trace
   * of a failed call is exactly what makes the failure diagnosable. */
  activity?: ActivitySummary;
  /** Present when the bridge was armed and the turn ran: a failed gated call's approval
   * record is exactly what explains WHY it failed (e.g. every request timed out). */
  approval?: ApprovalSummary;
}
export type ConsultResult = ConsultOk | ConsultFail;

// --- Params + deps ---------------------------------------------------------
export interface ConsultParams {
  question: string;
  model?: string;
  runId?: string;
  confirmed?: boolean;
  /**
   * Continue an EXISTING opencode session (Option B). The peer's prior turns already
   * live in that session, so `question` is the only new text sent — the driver never
   * re-quotes the other model. This is the round-2 primitive for `/guild:workshop`
   * (each panel member continues its OWN round-1 session; see panel.ts keepSessions).
   */
  sessionId?: string;
  /** Keep the session alive after this turn and return its id (for a further turn). */
  keepSession?: boolean;
  /**
   * REVIEW TARGET (issue #96): a git worktree of THIS repository to root the read at, so the
   * consulted model can read a branch that has not merged. Validated against
   * `git worktree list`; anything else is refused by name, never silently swapped for the
   * project root. Omit for the project the server was launched in.
   */
  worktree?: string;
  /**
   * Per-call model-turn HTTP timeout (ms), ALREADY validated/resolved by the server layer
   * (`parsePerCallTimeoutMs`): a positive number capped at `TIMER_MAX_MS`, or the ceiling
   * for `"max"`. When set it takes precedence over `GUILD_MESSAGE_TIMEOUT_MS` env/conf/
   * default; the test seam `deps.messageTimeoutMs` still wins over it.
   */
  timeoutMs?: number;
}

export interface ConsultDeps {
  /** A ready-serve provider (the M1 lifecycle in production; a fake in tests). */
  serve: ServeProvider;
  /**
   * Serve providers keyed by read root (issue #96). Wired to the `ServePool` in production;
   * required only when `params.worktree` names a root other than the project's own.
   */
  router?: ServeRouter;
  /** Test seam for the `git worktree list` enumeration (issue #96). */
  git?: GitRunner;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  home?: string;
  /** Injected in tests so root/policy/log all share one guild dir; else resolved. */
  log?: EvidenceLog;
  /** Per-turn timeout override (tests shorten it). */
  messageTimeoutMs?: number;
  /**
   * LIVE sink for each normalized activity event (issue #20). The MCP server wires this to
   * `notifications/progress` when the client sent a `progressToken`; left unset, activity
   * is still recorded to `activity.jsonl` and summarized on the result, just not streamed.
   */
  onActivity?: (e: ActivityEvent) => void;
  /**
   * The MCP elicitation channel (issue #20 slice 4), supplied by `src/server.ts`. Only
   * consulted when the approval bridge is armed; absent ⇒ that channel is unavailable and
   * the watch terminal is the only way to answer.
   */
  elicitation?: ElicitationRequester;
}

/** A fresh, non-empty call id (the pairing key for a call's three lifecycle entries). */
function newCallId(): string {
  return `call-${randomBytes(8).toString("hex")}`;
}

/** The exact model id that ran: prefer the resolved request; if it was empty (opencode
 * default) fall back to the provider/model the turn metadata reports. */
function actualModel(requested: string, providerID?: string, modelID?: string): string {
  if (requested !== "") return requested;
  if (providerID && modelID) return `${providerID}/${modelID}`;
  return "(opencode default)";
}

// ===========================================================================
// SHARED FLOW (factored so guild_panel — M6 — reuses the exact same gating and
// lifecycle as guild_consult, rather than a divergent second copy). The gate is
// pure (no logging, no run); the lifecycle is the expect→started→completed spine.
// ===========================================================================

/** A refusal produced by `gateModel` BEFORE any log write. A model-id/deny/ask
 * refusal is identical whether it comes from consult or a panel member — the
 * caller maps it into its own error envelope. */
export interface GateRefusal {
  kind: "model-id" | "policy-deny" | "policy-ask";
  message: string;
  /** bash exit analogue: 2 model-id (C55), 3 deny, 4 ask (C56). */
  exitAnalogue: number;
  model: string;
  /** Present on policy refusals: the tier that refused. */
  tier?: PolicyTier;
}

export type GateOutcome =
  | { ok: true; tier: PolicyTier; confirmed: boolean }
  | { ok: false; refusal: GateRefusal };

/**
 * The pre-log gate shared by every model-touching call: the leading-dash model-id
 * refusal (C12) THEN the policy tier gate (C1–C7). Deterministic ordering — model-id
 * is checked first, so a dash-leading id that a `deny -*` rule would also match is
 * refused as `model-id`, not `policy-deny`. Pure: it writes NOTHING, so a refusal
 * logs nothing (C24 gap parity), exactly like ask.sh refusing before it logs.
 *
 * `confirmed` is the human-approval flag for an ask-tier model. It only unlocks an
 * ask-tier call; on allow/deny it is simply recorded (allow) or irrelevant (deny).
 */
export function gateModel(
  requestedModel: string,
  confirmed: boolean,
  /** `guildDirs` are the LAYERED read roots, most-specific first (issue #19): the policy
   * verdict walks project rules, then the global baseline, then default-allow. */
  deps: { guildDirs: string[]; env: NodeJS.ProcessEnv },
): GateOutcome {
  const idCheck = checkResolvedModelId(requestedModel);
  if (!idCheck.ok) {
    return {
      ok: false,
      refusal: {
        kind: "model-id",
        message: idCheck.reason ?? `refusing model id '${requestedModel}'.`,
        exitAnalogue: idCheck.exitCode ?? 2,
        model: requestedModel,
      },
    };
  }
  const decision = policyTierAcross(requestedModel, { guildDirs: deps.guildDirs, env: deps.env });
  const modelLabel = requestedModel === "" ? "(opencode default)" : requestedModel;
  if (decision.tier === "deny") {
    return {
      ok: false,
      refusal: {
        kind: "policy-deny",
        model: requestedModel,
        tier: "deny",
        exitAnalogue: 3,
        message:
          decision.reason ??
          `Model '${modelLabel}' is DENIED by the model policy (${decision.source} policy at ${decision.policyFile}). ` +
            `Not consulting it. Choose an allowed model or change the policy.`,
      },
    };
  }
  if (decision.tier === "ask" && confirmed !== true) {
    return {
      ok: false,
      refusal: {
        kind: "policy-ask",
        model: requestedModel,
        tier: "ask",
        exitAnalogue: 4,
        message:
          `Model '${modelLabel}' is gated ASK by the model policy (${decision.source} policy at ${decision.policyFile}). ` +
          `This tool will NOT consult it until the human user explicitly approves. ` +
          `Ask the user whether to consult '${modelLabel}', and only if they say yes, retry with confirmed:true. ` +
          `Do not set confirmed yourself — it represents the user's approval, not yours.`,
      },
    };
  }
  return { ok: true, tier: decision.tier, confirmed: confirmed === true };
}

// --- READ ROOT: the optional worktree target (issue #96) -------------------
/**
 * What a read tool resolved for this call: the serve provider to run the turn on, and the
 * agent-def dirs whose presence pre-check must match where that provider's child will look.
 * The two travel together on purpose — a re-rooted child changes BOTH, and opencode
 * resolves agents from the serve's cwd (probed; see `resolveAgentDefDir`), so resolving one
 * without the other is exactly how this feature would break silently.
 */
export interface ReadRootOk {
  serve: ServeProvider;
  agentDefDirs: string[];
  /** The validated worktree root, present only when the caller named one. */
  worktree?: string;
}

/**
 * Resolve the read root for one call, from the optional caller-supplied `worktree`.
 *
 * WITHOUT `worktree` this is a no-op that returns exactly what every tool computed before
 * issue #96 — same provider, same agent-def dirs. WITH it, the target is validated against
 * `git worktree list` (`src/worktree.ts` — the single choke point, C33a's discipline) and,
 * when it is not the project root, the call is routed to a serve child rooted THERE.
 *
 * A target that does not validate is a REFUSAL, never a fall back to the project root:
 * a review silently run against the wrong tree reads exactly like a review run against the
 * right one, which is the failure this whole feature exists to remove.
 *
 * The `worktree`-without-a-router case THROWS rather than degrading. It is unreachable in
 * production (`src/server.ts` always passes the pool) and is therefore a wiring bug, not a
 * user error — and the honest response to "I cannot honour the root you asked for" is to
 * fail loudly, not to answer about a different one.
 */
export function resolveReadRoot(opts: {
  worktree?: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  confContents: string;
  serve: ServeProvider;
  router?: ServeRouter;
  /** Test seam: the git runner `resolveWorktreeTarget` uses. */
  git?: GitRunner;
}): { ok: true; value: ReadRootOk } | { ok: false; message: string } {
  const { env, cwd, confContents } = opts;
  const target = opts.worktree?.trim() ?? "";
  if (target.length === 0) {
    return {
      ok: true,
      value: { serve: opts.serve, agentDefDirs: resolveAgentDefDirs({ env, cwd, confContents }) },
    };
  }
  // The repository the server itself resolved — never an arbitrary one. The router knows the
  // primary child's cwd; without a router (tests that only exercise validation) fall back to
  // the same value `OpencodeLifecycle` would have used.
  const projectDir =
    opts.router?.projectDir ??
    (env.GUILD_PROJECT_DIR && env.GUILD_PROJECT_DIR.length > 0 ? env.GUILD_PROJECT_DIR : cwd);
  const resolved = resolveWorktreeTarget(target, {
    projectDir,
    ...(opts.git !== undefined ? { git: opts.git } : {}),
  });
  if (!resolved.ok) return { ok: false, message: resolved.message };

  if (resolved.isDefault) {
    // The target IS the project root: honour it by doing nothing special. No second child,
    // no second port — the ordinary path, with the root reported back so the caller can see
    // what it actually got.
    return {
      ok: true,
      value: {
        serve: opts.serve,
        agentDefDirs: resolveAgentDefDirs({ env, cwd, confContents }),
        worktree: resolved.root,
      },
    };
  }
  if (opts.router === undefined) {
    throw new Error(
      `internal: a worktree read root ('${resolved.root}') was requested but no ServeRouter ` +
        `was wired, so the call cannot be routed to a serve child rooted there. Refusing to ` +
        `run it against the project root instead.`,
    );
  }
  return {
    ok: true,
    value: {
      serve: opts.router.forRoot(resolved.root),
      // The def must be resolvable FROM THE WORKTREE: opencode looks in the serve cwd's
      // `.opencode/agent/` plus the global dir, and does NOT fall back to the repository's
      // main checkout (probed live, 1.18.7). A worktree whose `.opencode/agent/` is absent
      // — e.g. a repo that never committed the payload — therefore refuses up front rather
      // than dying on an HTTP 500 mid-turn.
      agentDefDirs: resolveAgentDefDirs({ env, cwd, confContents, projectDir: resolved.root }),
      worktree: resolved.root,
    },
  };
}

export interface LifecycleParams {
  question: string;
  requestedModel: string;
  agent: string;
  command: string;
  /** Session title recorded by opencode (diagnostic only). */
  title: string;
  runId: string;
  tier: PolicyTier;
  confirmed: boolean;
  /**
   * SESSION CONTINUATION (M7 / Option B). Continue this EXISTING opencode session
   * (skip create); its id is known up front so it is recorded on the `started` entry
   * too, letting a reader of the log see which turns shared a session. Omit to mint a fresh one.
   */
  sessionId?: string;
  /** Keep the session alive after the turn (return its id); default deletes it. */
  keepSession?: boolean;
}

/** Every tool's approval plumbing, resolved once by `armApproval` and threaded through the
 * spine. `undefined` (the default) means nothing is gated and this file behaves exactly as
 * it did before slice 4. */
export interface LifecycleApproval {
  arming: ApprovalArming;
}

export interface LifecycleDeps {
  serve: ServeProvider;
  log: EvidenceLog;
  messageTimeoutMs?: number;
  /**
   * LIVE ACTIVITY (issue #20). When present, each call gets its own recorder: it attaches
   * to the turn's opencode session, appends `<runDir>/activity.jsonl`, and returns the
   * bounded summary on the outcome. Absent (or a layer resolved `off`) ⇒ nothing changes
   * on any existing path.
   */
  activity?: ActivityLayer;
  /**
   * THE APPROVAL BRIDGE (issue #20 slice 4). Present only when `armApproval` armed it, which
   * requires an explicit knob AND a channel that can answer. When present, the session is
   * created with the `ask` ruleset and this call's bridge answers the requests.
   */
  approval?: LifecycleApproval;
}

export type LifecycleOutcome =
  | {
      ok: true;
      text: string;
      callId: string;
      actualModel: string;
      sessionId: string;
      /** Bounded activity summary for this call; absent when the layer is off. */
      activity?: ActivitySummary;
      /** Approval record for this call; absent unless the bridge was armed. */
      approval?: ApprovalSummary;
    }
  | {
      ok: false;
      callId: string;
      reason: string;
      /** `approval-not-applied` is only reachable when the bridge is armed: the session this
       * turn would run in is not carrying the `ask` rules, so the turn was refused rather
       * than run ungated. No model was called. */
      kind: "call-failed" | "agent-mismatch" | "approval-not-applied";
      /** Present on failure too — a black-box call that DIED is exactly the one whose
       * action trace matters most. */
      activity?: ActivitySummary;
      approval?: ApprovalSummary;
    };

/**
 * Build the per-call activity layer from the resolved knobs, wired to write into the
 * evidence run dir. Factored here so all four tools construct it identically — a second
 * copy would be free to drift on the `GUILD_LOG=off` ⇒ no-file rule.
 */
export function activityLayerFor(deps: {
  env: NodeJS.ProcessEnv;
  confContents: string;
  log: EvidenceLog;
  onActivity?: (e: ActivityEvent) => void;
}): ActivityLayer {
  const settings = resolveActivitySettings({ env: deps.env, confContents: deps.confContents });
  const opts: Parameters<typeof createActivityLayer>[0] = {
    enabled: settings.enabled,
    detail: settings.detail,
    // NO run dir unless the evidence layer is ON *and* a run id exists. Both halves are
    // load-bearing. `GUILD_LOG=off` normally yields an empty run id — but `runId` is a
    // documented TOOL INPUT, so a caller threading one while logging is off would otherwise
    // get a run directory holding `activity.jsonl` and no `calls.jsonl`, which `verify()`
    // then fails as a broken run (exit-analogue 7). Turning the record off must leave
    // nothing behind — including a DIFFERENT record.
    runDir: (runId: string) =>
      deps.log.enabled() && runId.length > 0 ? deps.log.dir(runId) : undefined,
  };
  if (deps.onActivity !== undefined) opts.onEvent = deps.onActivity;
  return createActivityLayer(opts);
}

/**
 * Arm (or decline to arm) the approval bridge for one call — the shared pre-flight all four
 * tools run, factored here beside `activityLayerFor` for the same reason: a second copy
 * would be free to drift on the one rule that matters, which is that this decision happens
 * BEFORE anything is logged.
 *
 * Three outcomes:
 *   - `{ok:true}` with no `approval` — nothing is gated for this agent (the default, and for
 *     every read path unless `GUILD_APPROVE_EGRESS=ask`). Byte-identical behaviour to before.
 *   - `{ok:true, approval}` — armed: the ruleset goes on the session, the bridge answers.
 *   - `{ok:false, refusal}` — a bad knob value, or armed with no channel that can answer.
 *     The caller turns it into its own structured error and returns WITHOUT logging (C24).
 */
export function approvalFor(deps: {
  agent: string;
  env: NodeJS.ProcessEnv;
  confContents: string;
  /** The SAME dirs the caller's def-presence pre-check just used. The allow-set the bridge
   * intersects against is read from the def in force, not from a table (review finding H3). */
  agentDefDirs: readonly string[];
  log: EvidenceLog;
  elicitation?: ElicitationRequester;
}): { ok: true; approval?: LifecycleApproval } | { ok: false; refusal: ApprovalRefusal } {
  const armed = armApproval({
    agent: deps.agent,
    env: deps.env,
    confContents: deps.confContents,
    agentDefDirs: deps.agentDefDirs,
    log: deps.log,
    ...(deps.elicitation !== undefined ? { elicitation: deps.elicitation } : {}),
  });
  if (!armed.ok) return { ok: false, refusal: armed.refusal };
  if (armed.arming === undefined) return { ok: true };
  return { ok: true, approval: { arming: armed.arming } };
}

/** The exit analogue for an approval refusal. **null, not a number**: these refusals have no
 * bash-era counterpart (the bash wrapper had no approval bridge), and inventing a code would
 * collide with the table in CONTRACT.md area H. `kind` + `isError` carry the signal. */
export const APPROVAL_EXIT_ANALOGUE = null;

/**
 * The evidence spine every model turn shares: mint a call id, write expect→started
 * BEFORE the call, run the model turn via the UNMODIFIED agent, then write completed
 * on EVERY path (success or thrown). A thrown call records `completed` with
 * `capture_state:failed` and NO fabricated answer, closing the expected-call gap
 * (C24/C25). Assumes the run is already resolved and the gate already passed — so it
 * always writes exactly one started + one completed for its call id.
 */
export async function runAgentLifecycle(
  p: LifecycleParams,
  d: LifecycleDeps,
): Promise<LifecycleOutcome> {
  const callId = newCallId();
  const common = {
    callId,
    command: p.command,
    model: p.requestedModel,
    agent: p.agent,
    tier: p.tier,
    confirmed: p.confirmed,
    run: p.runId,
  };
  await d.log.expect({
    callId,
    command: p.command,
    model: p.requestedModel,
    agent: p.agent,
    run: p.runId,
  });
  // On a continuation the session id is known before the call, so it is stamped on
  // `started` too (a fresh session is only known post-call and lands on `completed`).
  const started = await d.log.started({ ...common, session: p.sessionId, prompt: p.question });
  // One recorder per call. Undefined when the activity layer is absent or `off`, in which
  // case `askViaAgent` opens no subscription at all and nothing below changes.
  //
  // CONSTRUCTED INSIDE THE TRY, and guarded on its own: everything between `started` and
  // the `catch` must be covered by the completed-guarantee, and a throw from the visibility
  // layer must never be the thing that leaves a dangling `started` with no `completed`.
  let recorder: ActivityRecorder | undefined;
  // The approval bridge, by contrast, is NOT swallow-on-throw: if it cannot be built the
  // turn must not run, because it would run ungated. It is constructed before the try so a
  // construction failure surfaces as a normal thrown call rather than a silent downgrade.
  let approver: ApprovalBridge | undefined;
  const ctx = {
    runId: p.runId,
    callId,
    model: p.requestedModel === "" ? "(opencode default)" : p.requestedModel,
    agent: p.agent,
    command: p.command,
  };
  try {
    try {
      recorder = d.activity?.recorder(ctx);
    } catch {
      /* never fail a call over the visibility layer */
    }
    if (d.approval !== undefined) approver = d.approval.arming.bridge(ctx);
    const askOpts: Parameters<typeof askViaAgent>[1] = {
      agent: p.agent,
      model: p.requestedModel === "" ? undefined : p.requestedModel,
      prompt: p.question,
      title: p.title,
      messageTimeoutMs: d.messageTimeoutMs,
      sessionId: p.sessionId,
      keepSession: p.keepSession,
      // Fail closed if opencode serves a different agent than the hardened one requested.
      expectedAgent: p.agent,
    };
    if (recorder !== undefined) askOpts.activity = recorder;
    if (d.approval !== undefined && approver !== undefined) {
      askOpts.permission = d.approval.arming.ruleset;
      // Invariant 2 at the WIRE (review finding M4) and the ONE stored-ruleset predicate
      // (M10) both travel with the ruleset, so `client.ts` enforces the same rules this
      // module does without importing it.
      askOpts.allowedTools = [...d.approval.arming.allowSet];
      askOpts.permissionCheck = (stored) => d.approval!.arming.checkStored(stored);
      askOpts.approval = approver;
    }
    const result = await askViaAgent(d.serve, askOpts);
    await d.log.completed({
      ...common,
      exit: 0,
      turn: started.turn,
      session: result.sessionId,
      captureState: "complete",
      response: result.text,
    });
    const ok: LifecycleOutcome = {
      ok: true,
      text: result.text,
      callId,
      actualModel: actualModel(p.requestedModel, result.metadata.providerID, result.metadata.modelID),
      sessionId: result.sessionId,
    };
    if (recorder !== undefined) ok.activity = recorder.summary();
    if (approver !== undefined) ok.approval = approver.summary();
    return ok;
  } catch (err) {
    const mismatch = err instanceof AgentMismatchError;
    const ungated = err instanceof SessionPermissionMismatchError;
    const reason = err instanceof Error ? err.message : String(err);
    await d.log.completed({
      ...common,
      exit: 1,
      turn: started.turn,
      // Record the session id we know: the served one on a mismatch, else the continued
      // id (item 4 — a failed continuation must still record which session it was; null
      // for a fresh session whose id we never learned before the throw).
      session: mismatch ? err.sessionId : p.sessionId,
      captureState: "failed",
    });
    const failed: LifecycleOutcome = {
      ok: false,
      callId,
      reason,
      kind: mismatch ? "agent-mismatch" : ungated ? "approval-not-applied" : "call-failed",
    };
    if (recorder !== undefined) failed.activity = recorder.summary();
    if (approver !== undefined) failed.approval = approver.summary();
    return failed;
  } finally {
    // Detach is idempotent — `askViaAgent` already ran it, but a throw BEFORE the turn
    // (e.g. session creation failing) never reaches that finally, so close here too.
    recorder?.close();
    // Closing the approver also REJECTS anything still open, so a turn that died mid-flight
    // never leaves opencode waiting on a prompt nobody will answer.
    approver?.close();
  }
}

/**
 * Run one consult. Pure of the MCP layer: returns a discriminated result the server
 * translates into an MCP tool result. Never throws for an expected refusal or a model
 * failure — both are `{ ok:false }` data. (A programming error in a dep could still
 * throw; the server wraps the call.)
 */
export async function consult(params: ConsultParams, deps: ConsultDeps): Promise<ConsultResult> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const home = deps.home ?? os.homedir();

  // 1. Resolve the config root LAYERS ONCE (project over global baseline — issue #19);
  //    surface the note when an explicit $GUILD_ROOT leaves a root on disk unlayered.
  const rootRes = resolveRootWithConflict(env, cwd, home);
  const guildDirs = rootRes.layers.map((l) => l.root);
  const guildDir = rootRes.root; // PRIMARY: where the evidence log writes.
  const rootConflict = rootRes.conflict;
  const confContents = readLayeredConfContents(guildDirs, env);

  // 1b. READ ROOT (issue #96). Optional: without `worktree` this is exactly the pre-#96
  //     path. With it, the target is validated against `git worktree list` and the call is
  //     routed to a serve child rooted there — and the agent-def dirs move with it, because
  //     opencode resolves agents from the serve's cwd. Refused BEFORE any log write.
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
      rootConflict,
      error: {
        kind: "worktree-invalid",
        model: "",
        // No bash counterpart (the wrapper had no review target), so null rather than a
        // number that would collide with the area-H table.
        exitAnalogue: null,
        message: readRoot.message,
      },
    };
  }
  const { serve, agentDefDirs, worktree: worktreeRoot } = readRoot.value;

  // 2. NO-FALLBACK def gate (deviation from bash C16, mirroring guild_research/guild_delegate).
  //    If the hardened guild-read def is not present in the resolved agent-def dir(s), REFUSE
  //    loudly — never silently run the consult on whatever opencode resolves in its place (a
  //    missing def hard-errors on opencode 1.18.4, but that is a version artifact, not a
  //    guarantee; the pre-flight is version-independent and fail-closed). Refused BEFORE any
  //    log write (gap parity) and BEFORE any session/model work, so a `sessionId` continuation
  //    is governed identically — the def governs the agent regardless of session reuse.
  if (!hardenedDefPresentIn(CONSULT_AGENT, agentDefDirs).present) {
    return {
      ok: false,
      rootConflict,
      error: {
        kind: "agent-def-missing",
        model: "",
        exitAnalogue: 5,
        message:
          `The hardened '${CONSULT_AGENT}' agent def (${CONSULT_AGENT}.md) was not found in ` +
          `any of: ${agentDefDirs.join(", ")}. Refusing to run the consult: unlike the bash path ` +
          `there is NO fallback to a weaker agent, because silently degrading a hardened path ` +
          `while the caller still expects its guarantees is worse than refusing. Install the ` +
          `def (per-project or via 'init --global'), or set GUILD_AGENT_DIR to where it lives, ` +
          `and retry.`,
      },
    };
  }

  // 3. Resolve the model (param > GUILD_MODEL env > conf > opencode default).
  const requestedModel = resolveModel({ flag: params.model, env, confContents });

  // 4. Gate: the leading-dash refusal (C12) THEN the policy tier gate (C1–C7). deny →
  //    exit-3 analogue; ask without confirmed → exit-4 analogue instructing the DRIVER to
  //    ask the human; ask+confirmed or allow → proceed. All BEFORE any log write, so a
  //    refusal logs nothing (C24 gap parity).
  //
  // HONESTY BOUND (design input for M9): the MCP surface has NO per-argument permission
  // gate, so `confirmed:true` cannot be made to force a user prompt the way witness.md's
  // allowed-tools OMISSION of the GUILD_CONFIRMED form makes Claude-auditing-Claude
  // impossible to self-authorise. Here the ask gate is instruction-layer (the error text
  // telling the driver the user must approve) PLUS the mechanical backstop that a
  // non-confirmed call cannot proceed, PLUS the tier/confirmed audit trail written into
  // the evidence entries so a reader of the log can check after the fact whether an ask-tier
  // consult claimed approval. That is NOT witness-grade parity — a driver that sets
  // confirmed:true without asking is caught only by audit, not prevented.
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

  // --- Past the gate. Constructing the log writes NOTHING (only `newRun` does), so the
  //     approval pre-flight below still happens before any log entry exists. ---
  const log = deps.log ?? new EvidenceLog({ env, cwd, guildDir, guildDirs });

  // 5. APPROVAL BRIDGE pre-flight (issue #20 slice 4). Default OFF ⇒ `approval` is undefined
  //    and nothing below changes. Armed with no channel that can answer ⇒ REFUSE here,
  //    before any log write: an unanswered `ask` HANGS the turn under `opencode serve`
  //    (probe P3), so arming blind would deadlock rather than fail closed.
  const armed = approvalFor({
    agent: CONSULT_AGENT,
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
      error: {
        kind: armed.refusal.kind,
        model: requestedModel,
        exitAnalogue: APPROVAL_EXIT_ANALOGUE,
        message: armed.refusal.message,
      },
    };
  }

  // 6. Evidence lifecycle. Mint a fresh run only when the caller did not thread one; a
  //    provided runId reuses that run (so a workflow's calls share one auditable unit).
  const runId = params.runId && params.runId.length > 0 ? params.runId : log.newRun(CONSULT_COMMAND);

  // 7. The model turn, via the UNMODIFIED guild-read agent (shared spine).
  const outcome = await runAgentLifecycle(
    {
      question: params.question,
      requestedModel,
      agent: CONSULT_AGENT,
      command: CONSULT_COMMAND,
      title: "guild_consult",
      runId,
      tier: gate.tier,
      confirmed: gate.confirmed,
      sessionId: params.sessionId,
      keepSession: params.keepSession === true,
    },
    {
      serve,
      log,
      messageTimeoutMs:
        deps.messageTimeoutMs ?? params.timeoutMs ?? resolveMessageTimeoutMs({ env, confContents }),
      activity: activityLayerFor({ env, confContents, log, onActivity: deps.onActivity }),
      ...(armed.approval !== undefined ? { approval: armed.approval } : {}),
    },
  );

  if (outcome.ok) {
    const ok: ConsultOk = {
      ok: true,
      answer: outcome.text,
      rootConflict,
      attribution: {
        model: outcome.actualModel,
        requestedModel,
        agent: CONSULT_AGENT,
        runId,
        callId: outcome.callId,
        ...(worktreeRoot !== undefined ? { worktree: worktreeRoot } : {}),
      },
    };
    // Only expose the session id when the caller asked to keep it — otherwise the
    // session is deleted and its id is a dangling reference.
    if (params.keepSession === true) ok.sessionId = outcome.sessionId;
    if (outcome.activity !== undefined) ok.activity = outcome.activity;
    if (outcome.approval !== undefined) ok.approval = outcome.approval;
    return ok;
  }
  const modelLabel = requestedModel === "" ? "(opencode default)" : requestedModel;
  // agent-mismatch is a positive-direction addition over bash (which has no post-call
  // agent check); it has NO bash exit analogue, so exitAnalogue stays null like
  // call-failed — the kind + isError carry the fail-closed signal.
  const message =
    outcome.kind === "agent-mismatch" || outcome.kind === "approval-not-applied"
      ? outcome.reason
      : `The consult call to '${modelLabel}' failed: ${outcome.reason}. No answer was produced.`;
  const fail: ConsultFail = {
    ok: false,
    rootConflict,
    error: {
      kind: outcome.kind,
      model: requestedModel,
      // null, NOT 0: bash propagates opencode's own non-zero status verbatim (C53) and
      // 0 means success — a numeric analogue here would collide with that. The failure
      // signal is kind + isError; the reason rides in `message`.
      exitAnalogue: null,
      message,
    },
  };
  if (outcome.activity !== undefined) fail.activity = outcome.activity;
  if (outcome.approval !== undefined) fail.approval = outcome.approval;
  return fail;
}

// --- MCP tool-result translation -------------------------------------------
/** The MCP CallToolResult wire shape this tool emits. The index signature lets this
 * concrete type match MCP's passthrough `CallToolResult` union member (rather than the
 * task variant) at the handler boundary. */
export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * Map a `ConsultResult` to the MCP wire shape. Kept PURE (no server/transport imports) so
 * the byte-exact-through-the-boundary test can drive it without side effects.
 *
 * Success: the byte-exact answer is BOTH the text block and `structuredContent.answer`,
 * alongside exact-id attribution (model/agent/runId/callId). Failure: the structured
 * error (naming model + tier) with `isError:true`, so the driver treats a refusal as a
 * refusal it must act on (ask the user, choose another model) — not a normal answer.
 */
export function consultToToolResult(r: ConsultResult): McpToolResult {
  if (r.ok) {
    const structured: Record<string, unknown> = { answer: r.answer, ...r.attribution };
    if (r.rootConflict) structured.rootConflict = r.rootConflict;
    // Surface the kept session id so the driver can thread a follow-up turn by id.
    if (r.sessionId) structured.sessionId = r.sessionId;
    if (r.activity) structured.activity = r.activity;
    if (r.approval) structured.approval = r.approval;
    return { content: [{ type: "text", text: r.answer }], structuredContent: structured };
  }
  const structured: Record<string, unknown> = { error: r.error };
  if (r.rootConflict) structured.rootConflict = r.rootConflict;
  if (r.activity) structured.activity = r.activity;
  if (r.approval) structured.approval = r.approval;
  return {
    content: [{ type: "text", text: r.error.message }],
    structuredContent: structured,
    isError: true,
  };
}
