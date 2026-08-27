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
  fetchSession,
  AgentMismatchError,
  EmptyAnswerError,
  AgentFloorNotInForceError,
  SessionPermissionMismatchError,
  isBlank,
  type PreTurnAgentCheck,
  type ServeProvider,
  type ServeRouter,
  type TurnCompletion,
  type TurnDiagnostics,
  type TurnPart,
} from "./client.js";
import { resolveWorktreeTarget, type GitRunner } from "./worktree.js";
import { defaultAgentFloorChecker, type AgentFloorChecker } from "./agentfloor.js";
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
  resolvePayloadNoticeSettings,
  type GuildRoot,
  type RootSource,
} from "./config.js";
// Payload skew/drift (issues #22, #94) — the SAME detection `doctor` and the server's
// start-up notice use. `guild_status` is a third surface on one comparison, not a fourth
// implementation of it.
import {
  PACKAGE_ROOT,
  packageVersion,
  resolveGlobalDirs,
  resolveProjectDir,
  scanInstalledPayload,
  type PayloadFileState,
} from "./init.js";
import { noticeStatePath } from "./notice.js";
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
  /** PAYLOAD SKEW / UPGRADE DRIFT (issues #94, #22) — the installed `/guild:*` commands,
   * agent defs and templates measured against what THIS server ships. The MCP server updates
   * itself via npx and the payload in the repo does not, so "which version of the commands am
   * I actually running?" has no other cheap answer. */
  payload: PayloadDoctorInfo;
}

/** `guild_status`'s view of the installed payload. Bounded by construction — the payload is a
 * fixed, short list — so the whole classification is reported rather than a count. */
export interface PayloadDoctorInfo {
  /** The running server's version — what `skewed` is behind. `""` if unreadable. */
  serverVersion: string;
  /** Ours, untouched, behind the release: `npx modelguild init` fixes these in place. */
  skewed: PayloadFileReport[];
  /** Ours, edited, behind the release: reported, never overwritten (issue #22). */
  drifted: PayloadFileReport[];
  /** Differs from the shipped bytes with no ownership record — unjudgeable, never guessed. */
  unknown: PayloadFileReport[];
  /** Whether the START-UP notice is enabled. `doctor`/`guild_status` report skew either way —
   * the knob governs the unsolicited surface only. */
  noticeEnabled: boolean;
  /** Where the notice's suppression state lives (review finding L6: nothing
   * reported it, so a user who wanted to reset or inspect it had nowhere to look). */
  noticeStatePath: string;
}

export interface PayloadFileReport {
  dest: string;
  installedPath: string;
  /** sha256 on disk. For a SKEWED file this is by definition also the RECORDED hash, so
   * `installedHash` vs `shippedHash` is exactly the "recorded vs shipped" comparison. */
  installedHash: string;
  shippedHash: string;
  /** The ownership record this verdict was made against — project or global, whichever the
   * file was found in. Names WHICH install the row is about on a mixed setup. */
  recordPath: string;
}

const payloadReport = (f: PayloadFileState): PayloadFileReport => ({
  dest: f.dest,
  installedPath: f.installedPath,
  installedHash: f.installedHash,
  shippedHash: f.shippedHash,
  recordPath: f.recordPath,
});

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
  // Payload skew/drift (issue #94). Resolved from the same (env, cwd, home) this function is
  // already injected with — `resolveGlobalDirs` derives the XDG dir from `env`, and the project
  // dir comes from the SHARED `resolveProjectDir` that `src/notice.ts` uses (review finding L7:
  // the two had derived it separately) — so `guild_status` and its test drive the same code with
  // no new parameters and never touch the real `~`.
  const payloadScan = scanInstalledPayload({
    packageRoot: PACKAGE_ROOT,
    targetDir: resolveProjectDir(env, cwd),
    global_dirs: resolveGlobalDirs({ homeDir: home, env }),
  });
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
    payload: {
      serverVersion: packageVersion(PACKAGE_ROOT),
      skewed: payloadScan.skewed.map(payloadReport),
      drifted: payloadScan.drifted.map(payloadReport),
      unknown: payloadScan.unknown.map(payloadReport),
      // Reported, never CONSULTED here: `guild_status` was asked for, so it answers whatever
      // the knob says (issue #23's `logs clean`-under-`GUILD_LOG=off` precedent).
      noticeEnabled: resolvePayloadNoticeSettings({ env, confContents }).enabled,
      noticeStatePath: noticeStatePath({ env, home }),
    },
  };
}

// --- Result / error shapes -------------------------------------------------
export type ConsultErrorKind =
  | "agent-def-missing"
  // The def FILE is present but opencode is not applying it (issue #111, C73). TWO SHAPES, and
  // they differ in footprint (review B4): the EARLY refusal is decided before any log write and
  // before any snapshot — nothing ran; the LATE one comes from the re-check made inside the turn's
  // own serve lease, so it lands after `expect`/`started` and is recorded like a failed call. Both
  // carry the same `kind`; exit-analogue null either way (no bash counterpart, and NOT a reuse of
  // C57's 5, which means specifically "the def is missing").
  | "agent-unhardened"
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
  /** The turn completed and the model produced NO ANSWER (issue #117, C74) — a read-path
   * refusal, never an empty success. `guild_delegate` cannot produce it. */
  | "empty-answer"
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
  /**
   * Present ONLY on `empty-answer` (issue #168): the turn's tool-call count and the provider's
   * completion metadata (`finish`, token counts, cost) as opencode recorded them. It rides
   * inside `error` deliberately — `consultToToolResult` copies that object wholesale into
   * `structuredContent.error`, so no second plumbing point exists to drift.
   */
  diagnostics?: TurnDiagnostics;
}

export interface ConsultOk {
  ok: true;
  answer: string;
  attribution: ConsultAttribution;
  /** Multi-root conflict note, if any (surfaced, never fatal). */
  rootConflict?: string;
  /**
   * Present ONLY when the issue-#111 resolved-agent check could not be made (opencode
   * unreachable, or an answer this cannot read). The call PROCEEDED — that is the decided
   * direction — and this is the "never silently" half of it (C73). Absent on every call where
   * the floor was verified, so a result is byte-identical to a pre-#111 one in the normal case.
   */
  agentUnverified?: string;
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
  /**
   * WHERE THE RECEIPT IS (issue #117 review). `ConsultOk` has carried these in `attribution`
   * since M5; a failure did not, so an `empty-answer` refusal — whose whole rationale is that
   * the blank response WAS captured byte-exactly — gave the caller no way to go and read it.
   * `guild_panel` already sets `callId` per member. Present only when the call reached the
   * model and the evidence layer is on: a pre-flight refusal has no call to point at.
   */
  runId?: string;
  callId?: string;
  /** Even on a refusal, tell the caller which root's policy did the refusing. */
  rootConflict?: string;
  /** See `ConsultOk.agentUnverified` — carried on a failure too, because "the call failed AND
   * we could not confirm the agent was hardened" is exactly when it matters most. */
  agentUnverified?: string;
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
  /** Test seam for a continuation's session-directory lookup (issue #96, finding M3). */
  fetchSessionDirectory?: (sessionId: string) => Promise<string | undefined>;
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
  /**
   * The resolved-agent floor check (issue #111). Defaults to the process-wide checker, whose
   * per-serve-child cache is the point; injected in tests so one suite's cache never decides
   * another's assertion.
   */
  agentFloor?: AgentFloorChecker;
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

// --- RESOLVED-AGENT GATE: is the hardened def actually IN FORCE? (issue #111) ----
/**
 * The second stage of the def check, shared by all four model-calling tools.
 *
 * STAGE ONE IS THE FILESYSTEM PRESENCE CHECK ABOVE (`hardenedDefPresentIn`, C16) and it stays
 * exactly where it is, unchanged: it is cheap, fail-closed, and needs no serve. This is
 * ADDITIONAL, not a replacement — presence says the file exists, this says opencode is
 * actually applying it. A def whose frontmatter opencode cannot parse passes the first and
 * fails the second, which is the whole of issue #111 (see `src/agentfloor.ts` for the probe).
 *
 * PLACEMENT, and it is deliberate in both directions:
 *   - AFTER the model-policy gate, so a call naming a denied model is still refused without
 *     ever contacting opencode. (C70 already accepted that cost for a *continuation*; there
 *     was no reason to extend it to every call.)
 *   - BEFORE the approval pre-flight, before `log.newRun()`, and — on the write path — before
 *     the worktree snapshot. Gap parity (C24): a refusal here routes nothing and writes no
 *     evidence run. Ordering it ahead of the approval pre-flight is what closes issue #111's
 *     first consequence: the bridge computes its never-widen intersection from the def SOURCE,
 *     so on a voided def it would compute the narrow written allow-set while opencode allowed
 *     everything — armed, and gating nothing it thinks it is gating.
 *
 * The verdict is three-valued and the third value is the interesting one; see
 * `AgentFloorChecker` for why "opencode could not be asked" proceeds rather than refuses.
 */
export type AgentFloorGate =
  | { ok: true; unverified?: string }
  | { ok: false; message: string };

export async function gateAgentFloor(opts: {
  serve: ServeProvider;
  agent: string;
  agentDefDirs: readonly string[];
  /** Injected in tests so one suite's per-child cache never decides another's assertion. */
  checker?: AgentFloorChecker;
  /** Per-CALL stderr dedupe, shared with the in-lease re-check (review B1). See `#announce`. */
  announced?: Set<string>;
}): Promise<AgentFloorGate> {
  const checker = opts.checker ?? defaultAgentFloorChecker;
  const verdict = await checker.verify(opts.serve, opts.agent, opts.agentDefDirs, {
    ...(opts.announced !== undefined ? { announced: opts.announced } : {}),
  });
  if (verdict.state === "unhardened") return { ok: false, message: verdict.message };
  if (verdict.state === "unverified") return { ok: true, unverified: verdict.note };
  return { ok: true };
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
  /**
   * THE ROOT THIS CALL RUNS AGAINST — the directory `serve`'s child is (or will be) rooted
   * at. ALWAYS set: the project dir when nothing was targeted, the validated worktree when
   * something was.
   *
   * `worktree` below says whether a root was ASKED FOR; this says WHICH ROOT WON. The read
   * tools only ever needed the former (a `read_root` receipt is meaningful precisely when it
   * is non-default). The WRITE path needs the latter, because issue #107's whole failure mode
   * is a capture layer that computes its own root independently of the serve child's: with
   * this field there is exactly ONE root value in scope after resolution, and
   * `snapshotWorktree`/`captureDelegateDiff`/`scaffoldDigest` all take it. Do not add a second
   * way to reach the project dir on that path.
   */
  root: string;
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
 *
 * A CONTINUATION'S ROOT COMES FROM THE SESSION, NOT FROM THIS CALL (review finding M3).
 * opencode keys sessions by PROJECT, and a git worktree and its main checkout are the same
 * project — probed on 1.18.7: a session created on a worktree-rooted child is served without
 * complaint by a repo-rooted one, and a full turn posted to the other child completes
 * normally. Composed with this feature's own probe finding (the read fence follows the serve
 * child's CWD), a `sessionId` continuation that simply omitted `worktree` would continue the
 * SAME conversation while fenced at a DIFFERENT directory, and nothing anywhere would say so.
 * `/guild:collaborate` and `/guild:workshop` drive exactly that pattern.
 *
 * So the session's own `directory` — opencode's record of where it was created — is the
 * authority, and this is where it is consulted:
 *   - `sessionId` present ⇒ fetch it, and route the continuation THERE. A continuation
 *     therefore inherits its root by construction; the caller does not have to remember.
 *   - An explicit `worktree` that resolves to a DIFFERENT root than the session's is an
 *     ERROR naming both, never a silent win for either. (A matching one is fine — repeating
 *     yourself is allowed.)
 *   - A session that cannot be fetched, or whose directory is not the project root and not a
 *     worktree of this repository, is a REFUSAL. Guessing here is precisely the failure this
 *     resolves.
 *
 * COST, STATED: this makes a continuation contact the serve (one short control-plane GET,
 * on the primary child) BEFORE the model-policy gate, so a continuation naming a denied model
 * now ensures a serve is up on its way to being refused. No model turn happens, nothing is
 * logged, and in practice the serve is already up — you only have a `sessionId` because an
 * earlier call in this session produced one. A fresh (non-continuation) call is unchanged and
 * still touches opencode only after every gate.
 */
export async function resolveReadRoot(opts: {
  worktree?: string;
  /**
   * A continuation's session id (issue #96, review finding M3). When present, the session's
   * OWN directory decides the root — see the doc comment.
   */
  sessionId?: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  confContents: string;
  serve: ServeProvider;
  router?: ServeRouter;
  /**
   * The repository this resolution is anchored to — the default root, and the repo whose
   * `git worktree list` is the fence. WINS over `router.projectDir` and the
   * `$GUILD_PROJECT_DIR`/cwd fallback when supplied.
   *
   * It exists for `guild_delegate` (issue #107), which already owns a resolved project dir
   * (`resolveRepoDir` — `deps.repoDir` else `$GUILD_PROJECT_DIR` else cwd) that its capture
   * layer was rooted at. Feeding THAT value in here is what makes the serve child and the
   * capture provably share one root: the write path resolves its root once and hands the
   * result to both, instead of each deriving one. In production the two agree by
   * construction (`OpencodeLifecycle` defaults its own `projectDir` to the identical
   * expression); the parameter matters where they are injected, i.e. tests.
   */
  projectDir?: string;
  /** Test seam: the git runner `resolveWorktreeTarget` uses. */
  git?: GitRunner;
  /** Test seam: how a continuation's session record is fetched (default: the real client). */
  fetchSessionDirectory?: (sessionId: string) => Promise<string | undefined>;
}): Promise<{ ok: true; value: ReadRootOk } | { ok: false; message: string }> {
  const { env, cwd, confContents } = opts;
  const target = opts.worktree?.trim() ?? "";
  const sessionId = opts.sessionId?.trim() ?? "";

  // The repository the server itself resolved — never an arbitrary one. The router knows the
  // primary child's cwd; without a router (tests that only exercise validation) fall back to
  // the same value `OpencodeLifecycle` would have used.
  const projectDir =
    opts.projectDir && opts.projectDir.length > 0
      ? opts.projectDir
      : (opts.router?.projectDir ??
        (env.GUILD_PROJECT_DIR && env.GUILD_PROJECT_DIR.length > 0 ? env.GUILD_PROJECT_DIR : cwd));

  // Whatever THIS call asked for, validated. `undefined` = it asked for nothing.
  let asked: { root: string; isDefault: boolean } | undefined;
  if (target.length > 0) {
    const resolved = resolveWorktreeTarget(target, {
      projectDir,
      ...(opts.git !== undefined ? { git: opts.git } : {}),
    });
    if (!resolved.ok) return { ok: false, message: resolved.message };
    asked = { root: resolved.root, isDefault: resolved.isDefault };
  }

  // A CONTINUATION: the session's own directory decides, and disagreement is an error.
  let effective = asked;
  if (sessionId.length > 0) {
    // CAN THE ANSWER EVEN DIFFER? If this call names no root AND no other root has been
    // routed in this server's life, the primary child is the only one that exists, so the
    // continuation cannot land anywhere else and the lookup decides nothing. That gate is
    // what keeps `/guild:collaborate` and `/guild:workshop` — which never touch a worktree
    // — from newly depending on a `GET /session/{id}` succeeding. Where the ambiguity IS
    // real (a root was named, or extra roots exist), a failed lookup is a refusal.
    const ambiguous = asked !== undefined || (opts.router?.extraRoots.length ?? 0) > 0;
    let dir: string | undefined;
    let lookupError: string | undefined;
    try {
      dir = opts.fetchSessionDirectory
        ? await opts.fetchSessionDirectory(sessionId)
        : await defaultSessionDirectory(opts.serve, sessionId);
    } catch (err) {
      lookupError = err instanceof Error ? err.message : String(err);
    }
    if (lookupError !== undefined) {
      if (!ambiguous) return unrooted(env, cwd, confContents, opts.serve, projectDir);
      return {
        ok: false,
        message:
          `could not read session '${sessionId}' from opencode to determine which directory ` +
          `it was created in (${lookupError}). Refusing the continuation: opencode serves a ` +
          `session from any child of the same project, so continuing without knowing its ` +
          `directory could answer from a different tree than the one the conversation is ` +
          `about.`,
      };
    }
    if (dir === undefined || dir.length === 0) {
      if (!ambiguous) return unrooted(env, cwd, confContents, opts.serve, projectDir);
      return {
        ok: false,
        message:
          `opencode did not report a directory for session '${sessionId}', so which tree this ` +
          `conversation was held against cannot be established. Refusing the continuation ` +
          `rather than guessing.`,
      };
    }
    const sessionRoot = resolveWorktreeTarget(dir, {
      projectDir,
      ...(opts.git !== undefined ? { git: opts.git } : {}),
    });
    if (!sessionRoot.ok) {
      return {
        ok: false,
        message:
          `session '${sessionId}' was created in '${dir}', which is not the project root and ` +
          `not a worktree of this repository — so this server will not continue it. ` +
          `(${sessionRoot.message})`,
      };
    }
    if (asked !== undefined && asked.root !== sessionRoot.root) {
      return {
        ok: false,
        message:
          `worktree '${target}' resolves to '${asked.root}', but session '${sessionId}' was ` +
          `created in '${sessionRoot.root}'. Refusing: a continuation carries the earlier ` +
          `turns of a conversation held against ONE tree, and running it fenced at another ` +
          `would answer about code the session never saw. Omit 'worktree' to continue in the ` +
          `session's own tree, or start a fresh call (no sessionId) against '${asked.root}'.`,
      };
    }
    effective = { root: sessionRoot.root, isDefault: sessionRoot.isDefault };
  }

  if (effective === undefined) {
    // Neither a target nor a resolvable session root: the pre-#96 path, byte-identical.
    return unrooted(env, cwd, confContents, opts.serve, projectDir);
  }
  if (effective.isDefault) {
    // The root IS the project root: honour it by doing nothing special. No second child, no
    // second port — the ordinary path, with the root reported back so the caller can see what
    // it actually got.
    return {
      ok: true,
      value: {
        serve: opts.serve,
        agentDefDirs: resolveAgentDefDirs({ env, cwd, confContents }),
        root: effective.root,
        worktree: effective.root,
      },
    };
  }
  if (opts.router === undefined) {
    throw new Error(
      `internal: a worktree read root ('${effective.root}') was requested but no ServeRouter ` +
        `was wired, so the call cannot be routed to a serve child rooted there. Refusing to ` +
        `run it against the project root instead.`,
    );
  }
  return {
    ok: true,
    value: {
      serve: opts.router.forRoot(effective.root),
      // The def must be resolvable FROM THE WORKTREE: opencode looks in the serve cwd's
      // `.opencode/agent/` plus the global dir, and does NOT fall back to the repository's
      // main checkout (probed live, 1.18.7). A worktree whose `.opencode/agent/` is absent
      // — e.g. a repo that never committed the payload — therefore refuses up front rather
      // than dying on an HTTP 500 mid-turn.
      agentDefDirs: resolveAgentDefDirs({ env, cwd, confContents, projectDir: effective.root }),
      root: effective.root,
      worktree: effective.root,
    },
  };
}

/** The pre-#96 answer: the primary provider, project-resolved def dirs, no read root — plus
 * `root`, which is the project dir itself. `worktree` stays ABSENT here, and that distinction
 * is load-bearing: it is what keeps an untargeted call's evidence entry and tool result
 * byte-identical to one written before either issue existed. */
function unrooted(
  env: NodeJS.ProcessEnv,
  cwd: string,
  confContents: string,
  serve: ServeProvider,
  projectDir: string,
): { ok: true; value: ReadRootOk } {
  return {
    ok: true,
    value: {
      serve,
      agentDefDirs: resolveAgentDefDirs({ env, cwd, confContents }),
      root: projectDir,
    },
  };
}

/** Read a session's `directory` off the PRIMARY serve child. Any child of the project can
 * answer (opencode keys sessions by project), and the primary is the one that always exists. */
async function defaultSessionDirectory(
  serve: ServeProvider,
  sessionId: string,
): Promise<string | undefined> {
  return serve.withServe(async (h) => {
    const rec = await fetchSession({ baseUrl: h.baseUrl, sessionId });
    return typeof rec.directory === "string" ? rec.directory : undefined;
  });
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
  /** The non-default read root this turn ran against (issue #96), recorded on the `started`
   * evidence entry so the receipts say WHICH TREE the answer describes. Absent otherwise. */
  readRoot?: string;
  /** The non-default WRITE root this turn edited (issue #107) — the write-path counterpart,
   * deliberately its own field rather than a reuse of `readRoot`; see `log.started`. */
  writeRoot?: string;
  /**
   * A turn that answers nothing is a FAILURE for this caller (issue #117, C74). OPT-IN, and
   * the opt-in is the point: `guild_consult`/`guild_panel`/`guild_research` set it, because a
   * read path with no text produced nothing at all. `guild_delegate` does NOT — its answer is
   * the patch, and an empty report beside real edits is a successful delegation.
   *
   * Issue #121 did not change that: the write path refuses only the narrower "no report AND no
   * TOOL CALLS", which it decides itself from `LifecycleOutcome.toolCallCount`. Do not "tidy" it
   * by setting this flag on the delegate path; that would throw before the after-snapshot and
   * fail exactly the case #120 pinned as a success.
   */
  requireAnswer?: boolean;
  /**
   * THIS TURN IS A SECOND ATTEMPT (issue #187): the `call_id` of the attempt it retries,
   * recorded on this call's `started` entry (`retry_of`) so the receipts distinguish a retried
   * answer from an independent second call to the same model. Set by `guild_panel` only.
   *
   * It changes NOTHING about how the turn runs: a retry is a full, separate lifecycle with its
   * own call id and — because this spine never reuses a session it was not given one for — its
   * own FRESH opencode session. Do not add a `sessionId` here to "reuse" the dead session; the
   * turn that produced nothing is exactly the context a retry must not inherit.
   */
  retryOf?: string;
}

/** Every tool's approval plumbing, resolved once by `armApproval` and threaded through the
 * spine. `undefined` (the default) means nothing is gated and this file behaves exactly as
 * it did before slice 4. */
export interface LifecycleApproval {
  arming: ApprovalArming;
}

export interface LifecycleDeps {
  serve: ServeProvider;
  /**
   * The issue-#111 floor re-check, run INSIDE the turn's own serve lease (review A3). Absent ⇒
   * nothing extra happens. Threaded rather than constructed here so the tools' single checker
   * instance (and therefore its cache) is the one used.
   */
  preTurnCheck?: PreTurnAgentCheck;
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
      /**
       * The turn's own `info.error`, whitelisted by `finalAssistantError` — present only when
       * opencode carried one. Threaded for issue #121: `guild_delegate` decides its
       * `empty-delegation` refusal AFTER this outcome and after its capture, so this is the only
       * route by which the provider's own words reach that message. The read paths never read it
       * (they refuse inside `askViaAgent` and quote it from `EmptyAnswerError`).
       */
      providerError?: string;
      /**
       * Tool calls made by THIS turn, turn-scoped (issue #121; see `turnToolCallCount`).
       * `guild_delegate`'s refusal rests on it: zero tool calls means the model cannot have
       * edited a file or run a command, which is a fact about the TURN and therefore
       * independent of whatever the capture was able to measure afterwards.
       */
      toolCallCount: number;
      /**
       * The turn's completion metadata (issue #168), turn-scoped like `toolCallCount`.
       * `guild_delegate` reads it for the `empty-delegation` refusal; the read paths get theirs
       * off `EmptyAnswerError` instead, because they refuse inside `askViaAgent`.
       */
      completion?: TurnCompletion;
      /** The turn's assistant part types, counted (issue #168) — threaded for the same reason
       * as `completion`: only `guild_delegate` builds its own diagnostics. */
      partTypes?: Record<string, number>;
      /** The same parts ordered and measured (issue #191) — threaded for the same reason as
       * `partTypes`, and it is the half that answers #168's deciding cell. */
      parts?: TurnPart[];
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
      kind:
        | "call-failed"
        | "agent-mismatch"
        | "approval-not-applied"
        | "agent-unhardened"
        /** Only produced when the caller set `requireAnswer` (issue #117, C74). */
        | "empty-answer";
      /**
       * Set ONLY on `empty-answer` (issue #168): what the turn did before it went quiet, and
       * what the provider said about the completion that ended it. Every other failure kind
       * either never reached the model or has its own message; attaching a turn's diagnostics
       * to a turn that did not happen would be a fabrication.
       */
      diagnostics?: TurnDiagnostics;
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
  const started = await d.log.started({
    ...common,
    session: p.sessionId,
    prompt: p.question,
    ...(p.readRoot !== undefined ? { readRoot: p.readRoot } : {}),
    ...(p.writeRoot !== undefined ? { writeRoot: p.writeRoot } : {}),
    ...(p.retryOf !== undefined ? { retryOf: p.retryOf } : {}),
  });
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
      // Issue #117: only the read paths ask for this; see `LifecycleParams.requireAnswer`.
      requireAnswer: p.requireAnswer === true,
    };
    if (recorder !== undefined) askOpts.activity = recorder;
    // A3: re-verify the floor on the child that will actually serve this turn.
    if (d.preTurnCheck !== undefined) askOpts.preTurnCheck = d.preTurnCheck;
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
    // THE WRITE PATH'S REFUSAL CANNOT REACH ITS OWN RECEIPT, SO THE SPINE WRITES IT (issue #188).
    //
    // `guild_delegate` decides `empty-delegation` after this function has returned AND after its
    // capture — by which time `completed` is written and C24 allows exactly one per `call_id`,
    // so there is no second entry to carry the diagnostics and no amending the first. The three
    // options were: defer the `completed` write out of the shared spine for all four tools (the
    // change C74 already weighed and declined as far larger than the defect earns), leave the
    // write path's refusal undiagnosable in the receipts (the defect itself), or write the
    // diagnostics here on the TURN-SIDE half of `nothingDelivered` — blank answer AND no tool
    // calls — which is what this does.
    //
    // WHAT THAT COSTS, STATED: the condition is a SUPERSET of the refusal by exactly the
    // `capture.filesChanged === 0` guard, so a turn that made no tool calls, said nothing, and
    // somehow changed files would carry diagnostics on a receipt whose call SUCCEEDED. A model
    // that reached for no tool cannot have edited a file (C74's own reasoning), so that is not a
    // shape anyone has produced — and if it ever appears, a diagnosed receipt is the surface you
    // would want it on. It is a superset in the informative direction, never a gap.
    //
    // NO READ-PATH ENTRY MOVES. `requireAnswer` throws on a blank answer, so a read tool never
    // reaches this line with one — the branch is unreachable for `guild_consult`/`guild_panel`/
    // `guild_research` by construction, not by a flag someone could forget to pass.
    const silentTurn = isBlank(result.text) && result.toolCallCount === 0;
    await d.log.completed({
      ...common,
      exit: 0,
      turn: started.turn,
      session: result.sessionId,
      captureState: "complete",
      response: result.text,
      // Issue #168: absent unless the answer was promoted off a non-text channel, so an
      // ordinary call's entry is byte-identical to a pre-#168 one.
      ...(result.answerChannel !== undefined ? { answerChannel: result.answerChannel } : {}),
      // Built from the same three values `guild_delegate` builds `delegateDiagnostics` from,
      // so the receipt and that refusal's `error.diagnostics` are the same object's content.
      ...(silentTurn
        ? {
            diagnostics: {
              toolCallCount: result.toolCallCount,
              ...(result.completion !== undefined ? { completion: result.completion } : {}),
              ...(result.partTypes !== undefined ? { partTypes: result.partTypes } : {}),
              ...(result.parts !== undefined ? { parts: result.parts } : {}),
            } satisfies TurnDiagnostics,
          }
        : {}),
    });
    const ok: LifecycleOutcome = {
      ok: true,
      text: result.text,
      callId,
      actualModel: actualModel(p.requestedModel, result.metadata.providerID, result.metadata.modelID),
      sessionId: result.sessionId,
      toolCallCount: result.toolCallCount,
    };
    if (recorder !== undefined) ok.activity = recorder.summary();
    if (approver !== undefined) ok.approval = approver.summary();
    if (result.providerError !== undefined) ok.providerError = result.providerError;
    if (result.completion !== undefined) ok.completion = result.completion;
    if (result.partTypes !== undefined) ok.partTypes = result.partTypes;
    if (result.parts !== undefined) ok.parts = result.parts;
    return ok;
  } catch (err) {
    const mismatch = err instanceof AgentMismatchError;
    const ungated = err instanceof SessionPermissionMismatchError;
    // A LATE FLOOR REFUSAL LANDS HERE, AND THAT IS WHY IT IS SAFE (issue #111, review A3).
    // The in-lease re-check throws from inside `askViaAgent`, i.e. AFTER `log.expect()` and
    // `log.started()`. C24 requires exactly one of expected/started/completed per call_id in
    // BOTH directions, so a refusal that simply returned here would leave an `expected-call`
    // and a `started` with no `completed` and fail `verify()` — an unverifiable run produced by
    // a SAFETY check is the worst possible trade. It needs no special path: this catch already
    // writes `completed` (exit 1, capture_state failed) for every thrown failure, so the late
    // refusal is recorded exactly like a model failure and the run verifies clean. The EARLY
    // gate is what keeps the common case free of any log footprint at all.
    const unhardened = err instanceof AgentFloorNotInForceError;
    // AN EMPTY ANSWER IS A FAILED CALL WITH AN INTACT CAPTURE (issue #117, C74), which is why
    // it cannot share the line below. Capture did NOT fail here: the turn completed, history
    // was read, and what the model produced is known byte-exactly — it is simply blank. So
    // `capture_state` stays `complete` with the byte-exact `raw_response`, and only
    // `exit_code` says the call produced no answer. Reusing `failed` would blank a response we
    // in fact hold — and would also read as the capture-machinery failure issue #74 named on a
    // NEIGHBOURING field (`capture_complete:false` on the `delegate-diff` entry, not
    // `capture_state` on `completed`), which is a confusion worth not inviting. The second
    // reason is the sufficient one. `verify()` reads `capture_state`, the hash chain and
    // the response digest — never `exit_code` — so exit 1 + complete verifies clean.
    const empty = err instanceof EmptyAnswerError;
    const reason = err instanceof Error ? err.message : String(err);
    await d.log.completed({
      ...common,
      exit: 1,
      turn: started.turn,
      // Record the session id we know: the served one on a mismatch or an empty answer, else
      // the continued id (item 4 — a failed continuation must still record which session it
      // was; null for a fresh session whose id we never learned before the throw).
      session: mismatch || empty ? err.sessionId : p.sessionId,
      ...(empty
        ? { captureState: "complete" as const, response: err.text }
        : { captureState: "failed" as const }),
      // ISSUE #188: THE REFUSAL'S EVIDENCE GOES IN THE RECEIPT, NOT ONLY IN THE TOOL RESULT.
      // C74 has claimed since #173 that an `empty-answer` is self-diagnosing from the receipts
      // alone; it was not, because the diagnostics were attached to the returned object a few
      // lines below and to nothing on disk. The tool result lives in a Claude Code transcript;
      // `calls.jsonl` is the durable artefact, and it is what a corpus analysis reads. Same
      // object as `failed.diagnostics` below — deliberately the identical value rather than a
      // second construction, so the two surfaces cannot drift.
      ...(empty && err.diagnostics !== undefined ? { diagnostics: err.diagnostics } : {}),
    });
    const failed: LifecycleOutcome = {
      ok: false,
      callId,
      reason,
      kind: mismatch
        ? "agent-mismatch"
        : ungated
          ? "approval-not-applied"
          : unhardened
            ? "agent-unhardened"
            : empty
              ? "empty-answer"
              : "call-failed",
    };
    // Issue #168: the diagnostics ride out on the refusal, structurally as well as in the
    // message text, so a caller can tell "read five files then said nothing" from "said
    // nothing at all" without parsing prose.
    if (empty && err.diagnostics !== undefined) failed.diagnostics = err.diagnostics;
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
  const readRoot = await resolveReadRoot({
    ...(params.worktree !== undefined ? { worktree: params.worktree } : {}),
    // A continuation inherits its root from the session (review finding M3).
    ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
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

  // 4b. RESOLVED-AGENT GATE (issue #111, C73) — stage two of the def check. Step 2 proved the
  //     file exists; this proves opencode is APPLYING it. Before any log write and before the
  //     approval pre-flight; see `gateAgentFloor` for why it sits exactly here.
  /** ONE per call, shared by the early gate and the in-lease re-check: the stderr dedupe is
   * keyed on the child instance WITHIN a call, so the same child warns once, a different serving
   * child warns again, and the next call starts fresh (review B1). */
  const announced = new Set<string>();
  const floor = await gateAgentFloor({
    serve,
    agent: CONSULT_AGENT,
    agentDefDirs,
    announced,
    ...(deps.agentFloor !== undefined ? { checker: deps.agentFloor } : {}),
  });
  if (!floor.ok) {
    return {
      ok: false,
      rootConflict,
      error: {
        kind: "agent-unhardened",
        model: "",
        exitAnalogue: null,
        message: floor.message,
      },
    };
  }
  /** Carried onto every result below — see `ConsultOk.agentUnverified`. */
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
    CONSULT_AGENT,
    agentDefDirs,
    {
      announced,
      // Without this the late verdict reached NO channel when the early one was `verified`.
      onUnverified: (note) => {
        if (floorNote.note === undefined) floorNote.note = note;
      },
    },
  );

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
      ...(floorNote.note !== undefined ? { agentUnverified: floorNote.note } : {}),
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
      // A read path with no text produced nothing at all (issue #117, C74).
      requireAnswer: true,
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
    if (floorNote.note !== undefined) ok.agentUnverified = floorNote.note;
    return ok;
  }
  const modelLabel = requestedModel === "" ? "(opencode default)" : requestedModel;
  // agent-mismatch is a positive-direction addition over bash (which has no post-call
  // agent check); it has NO bash exit analogue, so exitAnalogue stays null like
  // call-failed — the kind + isError carry the fail-closed signal.
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
      : // NAME THE MODEL (issue #117): the whole failure is that nothing came back, so the
        // one fact worth reporting is which model said nothing.
        outcome.kind === "empty-answer"
        ? `The consult call to '${modelLabel}' returned NO ANSWER: ${outcome.reason}`
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
      ...(outcome.diagnostics !== undefined ? { diagnostics: outcome.diagnostics } : {}),
    },
  };
  if (runId.length > 0) fail.runId = runId;
  if (outcome.callId.length > 0) fail.callId = outcome.callId;
  if (outcome.activity !== undefined) fail.activity = outcome.activity;
  if (outcome.approval !== undefined) fail.approval = outcome.approval;
  if (floorNote.note !== undefined) fail.agentUnverified = floorNote.note;
  return fail;
}

// --- MCP tool-result translation -------------------------------------------
/**
 * The read-root note for a tool result's TEXT channel (issue #96, review finding L7).
 *
 * A human skimming the transcript sees the text blocks, and after #96 "which tree was this?"
 * is a question the text has to be able to answer — `guild_panel` already prints it in its
 * digest. But `guild_consult`/`guild_research` do NOT have a digest: their first text block
 * is the model's answer **byte-exact**, and a test pins that through the MCP boundary. So the
 * note is an ADDITIONAL block rather than a prefix — `content[0]` stays byte-identical to the
 * answer, and the note only exists at all when a non-default root was used. Do not "tidy"
 * this into a prefix.
 */
export function readRootBlocks(worktree: string | undefined): Array<{ type: "text"; text: string }> {
  if (worktree === undefined || worktree.length === 0) return [];
  return [{ type: "text", text: `Read root: ${worktree}` }];
}

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
    if (r.agentUnverified) structured.agentUnverified = r.agentUnverified;
    // Surface the kept session id so the driver can thread a follow-up turn by id.
    if (r.sessionId) structured.sessionId = r.sessionId;
    if (r.activity) structured.activity = r.activity;
    if (r.approval) structured.approval = r.approval;
    return {
      content: [{ type: "text", text: r.answer }, ...readRootBlocks(r.attribution.worktree)],
      structuredContent: structured,
    };
  }
  const structured: Record<string, unknown> = { error: r.error };
  if (r.runId) structured.runId = r.runId;
  if (r.callId) structured.callId = r.callId;
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
