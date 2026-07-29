/**
 * guild_delegate — the WRITE path.
 *
 * The MCP translation of bash `/guild:delegate` / `ask.sh --edit`: one model turn through
 * the UNMODIFIED `guild-build` agent (`.opencode/agent/guild-build.md` — a default-deny
 * allowlist re-allowing edit/write/patch/bash + a plain `read`; C47/C48), wrapped in the worktree
 * snapshot/diff machinery (src/snapshot.ts) so the model's changes are recorded as a patch
 * a human reviews. The model's report AND its diff are untrusted DATA the DRIVER reviews and
 * verifies — never instructions to act on (C42/C52). The human diff review is the trust
 * boundary (SECURITY.md guild-build: `bash` is allowed by design, so the remaining
 * denies are defense-in-depth, not by construction — and there is no secret-read fence
 * at all since 2026-07-29, issue #29, because `cat` walked through the one there was).
 *
 * TWO DELIBERATE DEVIATIONS FROM bash C16, both task-directed (applied
 * to the write path):
 *   1. NO fallback EVER. bash falls back to the UNRESTRICTED built-in `build` when
 *      guild-build.md is missing (loud warning; hard-error only under
 *      GUILD_REQUIRE_HARDENED). Here a missing def is a structured `agent-def-missing`
 *      refusal (exit-5 analogue, C57): no model called, no log written. Silently degrading
 *      the write path to the unrestricted editor while the caller still believes it got the
 *      hardened one is exactly the failure mode this repo kills — and it matters MOST on the
 *      write path, where the fallback is `build` (everything allowed), not a weaker read.
 *   2. Post-call agent-mismatch check (via runAgentLifecycle's expectedAgent): if opencode
 *      served a different agent than guild-build, the turn fails closed. A build-agent
 *      masquerade is the write-path's worst case; bash has no such check.
 *
 * WRITE-PATH ORDERING (C36–C40, C37 the scar): snapshot the worktree as a git tree BEFORE
 * the model turn (throwaway index, caller's index/worktree untouched); run the turn; then —
 * on EVERY path, including a partially-failed call, because whatever the model changed must
 * be captured — snapshot again and diff base→after (created files included). The patch lands
 * at <runDir>/diff-<callId>.patch, logged as a `delegate-diff` entry (claim:false, patch
 * hashed). The pre-tree sha is the recovery hint (`git checkout <tree> -- <path>`).
 *
 * Everything else mirrors guild_research: gate (leading-dash → policy tier) BEFORE any log
 * write so a refusal logs nothing (C24 gap parity), then the shared expect→started→completed
 * lifecycle spine (src/consult.ts runAgentLifecycle), reused not forked.
 */

import os from "node:os";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { type ServeProvider } from "./client.js";
import { EvidenceLog } from "./log.js";
import {
  resolveRootWithConflict,
  gateModel,
  runAgentLifecycle,
  activityLayerFor,
  approvalFor,
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
import { snapshotWorktree, captureDelegateDiff, scaffoldDigest } from "./snapshot.js";

/** The write-capable, hardened agent this tool ALWAYS uses, unmodified (C15/C47/C48). */
export const DELEGATE_AGENT = "guild-build";
/** The command label recorded in the evidence log. */
export const DELEGATE_COMMAND = "/guild:delegate";

// --- Params + deps ---------------------------------------------------------
export interface DelegateParams {
  task: string;
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

export interface DelegateDeps {
  serve: ServeProvider;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  home?: string;
  /** Injected in tests so root/policy/log all share one guild dir; else resolved. */
  log?: EvidenceLog;
  messageTimeoutMs?: number;
  /**
   * LIVE sink for each normalized activity event (issue #20). This is the path the live
   * visibility matters most on: a delegate turn is the 15-minute black box the issue was
   * filed about, and its edits/bash calls are what the developer wants to watch happen.
   */
  onActivity?: (e: ActivityEvent) => void;
  /**
   * The MCP elicitation channel (issue #20 slice 4), supplied by `src/server.ts`. Consulted
   * only when the approval bridge is armed.
   */
  elicitation?: ElicitationRequester;
  /**
   * The worktree the model edits — the project dir the serve was spawned from. Defaults to
   * `GUILD_PROJECT_DIR ?? cwd`, matching OpencodeLifecycle's own default so the snapshot
   * targets the SAME tree opencode mutates. Injected in tests to point at a disposable repo.
   */
  repoDir?: string;
}

// --- Capture shape (attached to both ok and failed results) ----------------
export interface DelegateCapture {
  /** Whether the model edited inside a git worktree (no worktree ⇒ no diff recorded). */
  gitWorktree: boolean;
  /** The patch of the model's changes; null when nothing to review or not a git worktree. */
  patchPath: string | null;
  /** The pre-turn tree sha (the recovery point). */
  preTree: string | null;
  afterTree: string | null;
  filesChanged: number;
  /** false ⇒ no COMPLETE patch record exists. Either the recorded patch is a partial record
   * — the log then fails integrity loudly (C40), and the reason names why (ignored/submodule/
   * tree state unrepresentable, `capture-crashed`) — or none was recorded at all because the
   * evidence layer is off (`logging-off`, review finding F2; `patchPath` is then null and
   * `recoveryHint` is the way back). */
  captureComplete: boolean;
  incompleteReason: string;
  /**
   * true ⇒ THE EVIDENCE WRITE ITSELF FAILED (issue #74 review, F2). The `delegate-diff` entry
   * this call should have appended — patch-ful or patch-less — did not land, so the log holds
   * only the three lifecycle entries and the run VERIFIES CLEAN. No cardinality rule requires a
   * `delegate-diff` (C24 covers only expected/started/completed), so `verify` cannot see the
   * gap: this flag is the ONLY witness of it, which is why it rides on the tool result rather
   * than in the log it is reporting the absence from. The correlation is the point — an ENOSPC
   * or a lock timeout is exactly the condition that crashes a capture AND then swallows the
   * record of the crash. When true, treat the worktree as unrecorded and inspect it yourself.
   */
  recordFailed: boolean;
  /** `git checkout <preTree> -- <path>` template, surfaced when the worktree was dirty. */
  recoveryHint: string | null;
  /** TAMPER SIGNAL (M8): the serve-runtime scaffolding (`.opencode/node_modules/**` + its
   * manifests — excluded from the ignored fingerprint, but LOADED AND EXECUTED by opencode
   * serve) changed during the model turn. Does NOT affect captureComplete; it is a separate
   * flag so an otherwise-invisible write into the transport's plugin dir is surfaced. */
  scaffoldChanged: boolean;
  /** One-line warning when `scaffoldChanged`, naming the path class to review; else null. */
  scaffoldWarning: string | null;
}

// --- Result / error shapes -------------------------------------------------
export type DelegateErrorKind =
  | "agent-def-missing"
  | "model-id"
  | "policy-deny"
  | "policy-ask"
  // The approval bridge's refusals (issue #20 slice 4). `approval-config` and
  // `approval-channel-missing` are decided BEFORE any log write and before the worktree
  // snapshot (nothing ran); `approval-not-applied` needs a serve round-trip.
  | "approval-config"
  | "approval-channel-missing"
  | "approval-not-applied"
  | "call-failed"
  | "agent-mismatch";

export interface DelegateAttribution {
  /** The EXACT model id used: the resolved id, or the id opencode actually ran. */
  model: string;
  requestedModel: string;
  agent: string;
  runId: string;
  callId: string;
}

export interface DelegateError {
  kind: DelegateErrorKind;
  message: string;
  /** 5 agent-def-missing (C57), 2 model-id (C55), 3 deny, 4 ask (C56); null for a
   * call-failed/agent-mismatch (bash propagates opencode's own status; 0 = success). */
  exitAnalogue: number | null;
  model: string;
  tier?: PolicyTier;
}

export interface DelegateOk {
  ok: true;
  /** The model's own text account of what it did — DATA to review, not instructions. */
  report: string;
  attribution: DelegateAttribution;
  capture: DelegateCapture;
  rootConflict?: string;
  /**
   * Bounded live-activity summary (issue #20); absent when the layer is off. It is a
   * READING AID, not a substitute for the diff review: it says what opencode reported the
   * model doing, at opencode's fidelity. `capture.patchPath` is still what you review.
   */
  activity?: ActivitySummary;
  /**
   * Present only when the approval bridge was ARMED (issue #20 slice 4): the tools gated,
   * the channels that could answer, and how each request was settled. Its `note` carries the
   * honest bound — an approved `bash` is an approved shell, so this is attention, not
   * containment, and `capture.patchPath` remains the review point.
   */
  approval?: ApprovalSummary;
}
export interface DelegateFail {
  ok: false;
  error: DelegateError;
  /** Present when the model turn RAN (call-failed / agent-mismatch): whatever it changed
   * before failing is still captured and surfaced so the human can review/recover it. */
  capture?: DelegateCapture;
  rootConflict?: string;
  /** Present when the turn RAN: the action trace up to the failure. */
  activity?: ActivitySummary;
  /** Present when the bridge was armed and the turn ran — e.g. every gated call timed out. */
  approval?: ApprovalSummary;
}
export type DelegateResult = DelegateOk | DelegateFail;

/** Resolve the worktree the model edits, matching OpencodeLifecycle's default. */
function resolveRepoDir(deps: DelegateDeps, env: NodeJS.ProcessEnv, cwd: string): string {
  if (deps.repoDir && deps.repoDir.length > 0) return deps.repoDir;
  if (env.GUILD_PROJECT_DIR && env.GUILD_PROJECT_DIR.length > 0) return env.GUILD_PROJECT_DIR;
  return cwd;
}

/**
 * Run one delegation. Pure of the MCP layer: returns a discriminated result the server
 * translates. Never throws for an expected refusal or a model failure — both are data.
 */
export async function delegate(
  params: DelegateParams,
  deps: DelegateDeps,
): Promise<DelegateResult> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const home = deps.home ?? os.homedir();

  // 1. Resolve the config root LAYERS ONCE (project over global baseline — issue #19).
  const rootRes = resolveRootWithConflict(env, cwd, home);
  const guildDirs = rootRes.layers.map((l) => l.root);
  const guildDir = rootRes.root; // PRIMARY: where the evidence log writes.
  const rootConflict = rootRes.conflict;
  const confContents = readLayeredConfContents(guildDirs, env);

  // NO `worktree` READ ROOT ON THIS PATH (issue #96, deliberate and scoped). The READ tools
  // can be re-rooted at a validated sibling worktree; the WRITE path cannot, and is not.
  // Everything downstream of here — `snapshotWorktree`, the throwaway-index baseline, the
  // after-tree, the ignored-file fingerprint, the submodule state, the recovery hint and the
  // recorded patch (C37–C40) — is rooted at THIS project dir, and the delegate result's whole
  // value is that the patch faithfully records what the model changed. Re-rooting the serve
  // child without re-rooting the snapshot would capture the wrong tree while still LOOKING
  // complete, which is worse than not offering the feature. Doing it properly is a larger
  // change (snapshot against the target repo, recovery hints that name it, and the
  // `.opencode/` scaffolding tamper signal in someone else's worktree) and belongs in its
  // own issue.
  //
  // 2. NO-FALLBACK def gate (deviation from bash C16). A missing guild-build def REFUSES
  //    loudly — never silently degrades to the UNRESTRICTED `build`. Refused before any log
  //    write (gap parity) and before any snapshot (nothing ran).
  const agentDefDirs = resolveAgentDefDirs({ env, cwd, confContents });
  if (!hardenedDefPresentIn(DELEGATE_AGENT, agentDefDirs).present) {
    return {
      ok: false,
      rootConflict,
      error: {
        kind: "agent-def-missing",
        model: "",
        exitAnalogue: 5,
        message:
          `The hardened '${DELEGATE_AGENT}' agent def (${DELEGATE_AGENT}.md) was not found in ` +
          `any of: ${agentDefDirs.join(", ")}. Refusing to delegate: unlike the bash path there ` +
          `is NO fallback — and the write-path fallback would be the UNRESTRICTED built-in ` +
          `'build' agent (all tools allowed), so silently degrading here is worse than on any ` +
          `read path. Install the def (per-project or via 'init --global'), or set ` +
          `GUILD_AGENT_DIR to where it lives, and retry.`,
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

  // --- Past the gate. Constructing the log writes NOTHING (only `newRun` does). ---
  const log = deps.log ?? new EvidenceLog({ env, cwd, guildDir, guildDirs });

  // 4b. APPROVAL BRIDGE pre-flight (issue #20 slice 4). This is THE path the bridge exists
  //     for. Refused here — before any log write AND before the worktree snapshot — so a
  //     refusal leaves nothing behind at all. Arming with no answering channel would
  //     DEADLOCK the turn rather than fail closed (probe P3), which is why this is a
  //     refusal and not a warning.
  const armed = approvalFor({
    agent: DELEGATE_AGENT,
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

  const runId =
    params.runId && params.runId.length > 0 ? params.runId : log.newRun(DELEGATE_COMMAND);
  const repoDir = resolveRepoDir(deps, env, cwd);

  // 5. Snapshot the worktree BEFORE the model runs (throwaway index; caller's index and
  //    worktree untouched — C36/C37). Nothing has been edited yet, so this is the baseline.
  const before = snapshotWorktree(repoDir);

  // 6. The model turn, via the UNMODIFIED guild-build agent (shared spine + agent-mismatch).
  const outcome = await runAgentLifecycle(
    {
      question: params.task,
      requestedModel,
      agent: DELEGATE_AGENT,
      command: DELEGATE_COMMAND,
      title: "guild_delegate",
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
      ...(armed.approval !== undefined ? { approval: armed.approval } : {}),
    },
  );

  // 7. Capture AFTER — on EVERY path, including a failed call: whatever the model changed
  //    before failing must be recorded (trace ask.sh, which calls record_delegate_diff before
  //    log_complete regardless of opencode's exit). The callId is the lifecycle's; using it
  //    keeps the delegate-diff entry paired to the same call (verify cardinality, C24).
  const capture = await captureAndLog(before, {
    repoDir,
    log,
    runId,
    callId: outcome.callId,
  });

  if (outcome.ok) {
    const ok: DelegateOk = {
      ok: true,
      report: outcome.text,
      rootConflict,
      attribution: {
        model: outcome.actualModel,
        requestedModel,
        agent: DELEGATE_AGENT,
        runId,
        callId: outcome.callId,
      },
      capture,
    };
    if (outcome.activity !== undefined) ok.activity = outcome.activity;
    if (outcome.approval !== undefined) ok.approval = outcome.approval;
    return ok;
  }

  const modelLabel = requestedModel === "" ? "(opencode default)" : requestedModel;
  const message =
    outcome.kind === "agent-mismatch" || outcome.kind === "approval-not-applied"
      ? outcome.reason
      : `The delegate call to '${modelLabel}' failed: ${outcome.reason}. ` +
        `Any changes the model made before failing are captured for review (see capture.patchPath).`;
  const fail: DelegateFail = {
    ok: false,
    rootConflict,
    error: {
      kind: outcome.kind,
      model: requestedModel,
      exitAnalogue: null,
      message,
    },
    // Surface the partial capture even on failure so the human can review/recover.
    capture,
  };
  if (outcome.activity !== undefined) fail.activity = outcome.activity;
  if (outcome.approval !== undefined) fail.approval = outcome.approval;
  return fail;
}

/**
 * Run the AFTER capture, write the patch into the run dir, and log the delegate-diff entry.
 * Best-effort like every log hook (C31): a capture/log failure never throws into the caller.
 *
 * EVERY path that ran the model and found a git worktree leaves a durable record: a normal or
 * INCOMPLETE capture logs `log.diff` (patch hashed, `complete` flag), and a capture that THREW
 * logs the patch-less `log.diffUncaptured` (issue #74). The one path that deliberately logs
 * nothing is "nothing to review" — an empty patch over fully-representable state, which is a
 * true statement that the model changed nothing, not a gap.
 *
 * RESIDUAL, and the reason `capture.recordFailed` exists: when the evidence APPEND itself fails
 * (a lock timeout; ENOSPC — which correlates with the very conditions that crash a capture),
 * the entry never lands and the run verifies CLEAN, because no cardinality rule requires a
 * `delegate-diff`. C31's "a lost entry surfaces as a verify gap" holds for the three lifecycle
 * entries, NOT for this one. The flag is the only witness, so it is set on both write paths.
 */
async function captureAndLog(
  before: ReturnType<typeof snapshotWorktree>,
  ctx: { repoDir: string; log: EvidenceLog; runId: string; callId: string },
): Promise<DelegateCapture> {
  const recoveryHint =
    before.gitWorktree && before.dirty && before.tree
      ? `git checkout ${before.tree} -- <path>`
      : null;

  if (!before.gitWorktree) {
    // Not a git worktree: no snapshot, no diff recorded (matches ask.sh's warning path).
    return {
      gitWorktree: false,
      patchPath: null,
      preTree: null,
      afterTree: null,
      filesChanged: 0,
      captureComplete: true,
      incompleteReason: "",
      recordFailed: false, // nothing was owed to the log, so nothing was lost
      recoveryHint: null,
      scaffoldChanged: false,
      scaffoldWarning: null,
    };
  }

  // TAMPER SIGNAL: did the excluded, execution-carrying serve scaffolding change during the
  // turn? Computed AFTER the model turn against the before-snapshot's digest. Independent of
  // captureComplete — a scaffolding write is invisible to the fingerprint by design, so this
  // is the ONLY place it surfaces.
  const scaffoldChanged = before.gitWorktree && scaffoldDigest(ctx.repoDir) !== before.scaffold;
  const scaffoldWarning = scaffoldChanged
    ? "the transport's plugin directory (.opencode/node_modules + manifests) changed during this call — review it; this directory is loaded by opencode serve"
    : null;

  // NO RUN, NO CAPTURE — the guard `consult.ts` and `approve.ts` already apply before
  // calling `log.dir()`, missing here (review finding F1/F2 on issue #73). Two reasons,
  // both load-bearing:
  //   1. C31. With `GUILD_LOG=off` (or a failed `newRun`) `runId` is `""`, which is falsy,
  //      so `#resolveRun` would fall through to `$GUILD_RUN_ID` — and an invalid one now
  //      THROWS. This call site sits outside every `try` below, so that throw would escape
  //      through `delegate()` to the MCP handler AFTER the model already edited files,
  //      discarding the report AND the recovery hint. The exact failure C31 forbids.
  //   2. Logging off must mean nothing on disk. `dir()`/`path()` never consult `#disabled()`,
  //      so `dir("")` minted a FRESH run id and the mkdir below created that directory and
  //      wrote a patch into it — with no calls.jsonl beside it, and against the documented
  //      "GUILD_LOG=off mints no run dir".
  // The capture is reported as absent WITH ITS REASON rather than silently skipped: the
  // model did edit files, so `recoveryHint` and the scaffold tamper signal still ride out.
  if (!ctx.log.enabled() || ctx.runId.length === 0) {
    return {
      gitWorktree: true,
      patchPath: null,
      preTree: before.tree,
      afterTree: null,
      filesChanged: 0,
      captureComplete: false,
      incompleteReason: "logging-off",
      recordFailed: false, // logging off owes the log no entry, so none was lost (cf. "nothing to review")
      recoveryHint,
      scaffoldChanged,
      scaffoldWarning,
    };
  }

  // The run dir already exists (expect/started/completed wrote to it); ensure it anyway so
  // the patch write can't race a missing dir. The patch MUST live in the run dir — log.diff
  // stores its basename and verify resolves it there.
  const runDir = ctx.log.dir(ctx.runId);
  try {
    mkdirSync(runDir, { recursive: true });
  } catch {
    /* best-effort */
  }
  const patchPath = path.join(runDir, `diff-${ctx.callId}.patch`);

  let cap;
  try {
    cap = captureDelegateDiff({
      repoDir: ctx.repoDir,
      baseTree: before.tree,
      ignoredBefore: before.ignored,
      submodulesBefore: before.submodules,
      patchPath,
    });
  } catch (err) {
    // A snapshot/diff crash must not sink the whole call — but it must not pass SILENTLY
    // either (issue #74). Until this write existed the crash path returned here without
    // logging anything, so the run held only the three lifecycle entries and `verify()`
    // passed it CLEAN: a crashed capture looked exactly like a delegation that changed
    // nothing, while the six snapshot incomplete-reasons below reached `log.diff` with
    // complete:false and failed integrity loudly. The record is patch-less (there is no
    // patch to hash) and carries capture_complete:false, so the run fails integrity for the
    // true reason. Guarded and best-effort per C31: the log write must never mask the
    // original crash nor sink the call, so its own failure only warns (inside log.ts).
    let recordFailed = true;
    try {
      const w = await ctx.log.diffUncaptured({
        callId: ctx.callId,
        base: before.tree ?? "",
        reason: "capture-crashed",
        detail: err instanceof Error ? err.message : String(err),
        run: ctx.runId,
        scaffoldChanged,
      });
      recordFailed = !w.ok;
    } catch {
      /* belt-and-braces: diffUncaptured returns failures as data, but nothing in this
         catch block may become a second, louder failure than the one being recorded.
         `recordFailed` stays true — a throw here means no entry landed either. */
    }
    return {
      gitWorktree: true,
      patchPath: null,
      preTree: before.tree,
      afterTree: null,
      filesChanged: 0,
      captureComplete: false,
      incompleteReason: "capture-crashed",
      recordFailed,
      recoveryHint,
      scaffoldChanged,
      scaffoldWarning,
    };
  }

  if (cap.nothingToReview) {
    // The model changed no tracked files AND state was representable: no entry (matches
    // ask.sh's "nothing to review" — it removes the empty patch and logs no delegate-diff).
    // The scaffold flag is still surfaced on the result (a scaffolding-only write leaves no
    // tracked change but must not go unnoticed), even though there is no delegate-diff entry.
    return {
      gitWorktree: true,
      patchPath: null,
      preTree: before.tree,
      afterTree: cap.afterTree,
      filesChanged: 0,
      captureComplete: true,
      incompleteReason: "",
      recordFailed: false, // "nothing to review" owes the log no entry (see the note above)
      recoveryHint,
      scaffoldChanged,
      scaffoldWarning,
    };
  }

  // Log the delegate-diff entry (claim:false, patch hashed, folded into integrity — C29/C39).
  // An INCOMPLETE capture is logged with complete:false so the run fails integrity loudly.
  // The scaffold tamper flag rides along as an optional, non-asserted evidence field.
  // `recordFailed` is watched HERE TOO, not only on the crash path (issue #74 review, F2): a
  // failed append leaves the same clean-verifying run whichever entry it was, and a flag that
  // only told the truth on one of two paths would be its own trap.
  let recordFailed = true;
  try {
    const w = await ctx.log.diff({
      callId: ctx.callId,
      patchFile: patchPath,
      base: before.tree ?? "",
      after: cap.afterTree ?? "",
      complete: cap.captureComplete,
      reason: cap.reason,
      run: ctx.runId,
      scaffoldChanged,
    });
    recordFailed = !w.ok;
  } catch {
    /* C31: a log failure never sinks the call it records — but it is reported, not swallowed. */
  }

  return {
    gitWorktree: true,
    patchPath,
    preTree: before.tree,
    afterTree: cap.afterTree,
    filesChanged: cap.filesChanged,
    captureComplete: cap.captureComplete,
    incompleteReason: cap.reason,
    recordFailed,
    recoveryHint,
    scaffoldChanged,
    scaffoldWarning,
  };
}

// --- MCP tool-result translation -------------------------------------------
/**
 * Map a `DelegateResult` to the MCP wire shape. Success: the model's report is BOTH the text
 * block and `structuredContent.report`, alongside the capture (patch path, files changed,
 * completeness, recovery hint) and exact-id attribution. Failure: the structured error with
 * `isError:true` and any partial capture, so the driver treats a refusal/failure as
 * something to act on (review the partial diff, choose another model) — not a normal answer.
 *
 * The report AND the diff are DATA for the driver to review and verify against the code —
 * never instructions to execute (C42/C52). The human diff review is the trust boundary.
 */
export function delegateToToolResult(r: DelegateResult): McpToolResult {
  if (r.ok) {
    const structured: Record<string, unknown> = {
      report: r.report,
      ...r.attribution,
      capture: r.capture,
    };
    if (r.rootConflict) structured.rootConflict = r.rootConflict;
    if (r.activity) structured.activity = r.activity;
    if (r.approval) structured.approval = r.approval;
    return { content: [{ type: "text", text: r.report }], structuredContent: structured };
  }
  const structured: Record<string, unknown> = { error: r.error };
  if (r.capture) structured.capture = r.capture;
  if (r.rootConflict) structured.rootConflict = r.rootConflict;
  if (r.activity) structured.activity = r.activity;
  if (r.approval) structured.approval = r.approval;
  return {
    content: [{ type: "text", text: r.error.message }],
    structuredContent: structured,
    isError: true,
  };
}
