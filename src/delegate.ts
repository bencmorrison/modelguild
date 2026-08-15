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
 * ONE ROOT PER CALL (issue #107). The tree may be the project the server was launched in or a
 * validated sibling git worktree of the same repository. Whichever it is, it is resolved ONCE
 * — through the same `resolveWorktreeTarget` choke point the read tools use — and the single
 * resulting `writeRoot` is what the serve child is rooted at AND what every capture consumer
 * takes. That coupling is the entire point of the issue: a serve child re-rooted without the
 * capture would let the model edit one tree while the evidence layer snapshotted, diffed and
 * hashed another, and then reported `captureComplete:true`. Do not add a second way to reach
 * the project dir below the resolution; `deps.repoDir` is an input to it, not a fallback.
 *
 * A DELEGATION THAT PRODUCED NOTHING IS A FAILURE (issue #121, C74 amended). An empty report is
 * not itself an error here — the answer is the patch — but an empty report from a turn that made
 * NO TOOL CALLS means nothing was produced on any channel, which is #117's failure mode on the
 * write path and is reachable the same way (a provider rejecting the model id ends the turn with
 * no text and no tool calls). Refused as `empty-delegation`. See `nothingDelivered` for the exact
 * predicate, for why the deciding half is the turn's tool-call count rather than the capture's
 * completeness, and for the three shapes that must stay successes.
 *
 * Everything else mirrors guild_research: gate (leading-dash → policy tier) BEFORE any log
 * write so a refusal logs nothing (C24 gap parity), then the shared expect→started→completed
 * lifecycle spine (src/consult.ts runAgentLifecycle), reused not forked.
 */

import os from "node:os";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  describeTurnDiagnostics,
  type ServeProvider,
  type ServeRouter,
  type TurnDiagnostics,
} from "./client.js";
import { type GitRunner } from "./worktree.js";
import { defaultAgentFloorChecker, type AgentFloorChecker } from "./agentfloor.js";
import { EvidenceLog } from "./log.js";
import {
  resolveRootWithConflict,
  resolveReadRoot,
  gateAgentFloor,
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
  hardenedDefPresentIn,
} from "./config.js";
import { type PolicyTier } from "./policy.js";
import {
  snapshotWorktree,
  captureDelegateDiff,
  scaffoldDigest,
  snapshotScaffold,
  EMPTY_SCAFFOLD_DIGEST,
} from "./snapshot.js";

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
   * THE TREE TO EDIT (issue #107): a git worktree of THIS repository. Validated at the same
   * single choke point the read tools use (`resolveWorktreeTarget`); anything else — an
   * arbitrary path, a worktree of a different repository, a typo — is refused BY NAME, never
   * silently swapped for the project root. Omit to edit the project the server was launched
   * in, which behaves exactly as it did before this parameter existed.
   *
   * The serve child AND the capture layer are rooted here together — see `delegate()`.
   */
  worktree?: string;
  /**
   * Per-call model-turn HTTP timeout (ms), ALREADY validated/resolved by the server layer
   * (`parsePerCallTimeoutMs`). Precedence over `GUILD_MESSAGE_TIMEOUT_MS` env/conf/default;
   * the test seam `deps.messageTimeoutMs` wins.
   */
  timeoutMs?: number;
}

export interface DelegateDeps {
  serve: ServeProvider;
  /**
   * Serve providers keyed by root (issue #96's `ServePool`, reused unchanged by #107). Wired
   * to the pool in production; required only when `params.worktree` names a root other than
   * the project's own — a `worktree` with no router THROWS rather than degrading, because
   * running the edit against the project root instead is the exact silent-wrong-tree failure
   * this feature exists to remove.
   */
  router?: ServeRouter;
  /** Test seam for the `git worktree list` enumeration (issue #96). */
  git?: GitRunner;
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
  /** The resolved-agent floor check (issue #111); injected in tests. */
  agentFloor?: AgentFloorChecker;
  /**
   * The DEFAULT root — the project dir the primary serve child is spawned from. Defaults to
   * `GUILD_PROJECT_DIR ?? cwd`, matching OpencodeLifecycle's own default. Injected in tests to
   * point at a disposable repo.
   *
   * SINCE #107 THIS IS AN INPUT TO ROOT RESOLUTION, NOT THE CAPTURE ROOT ITSELF. It is read
   * exactly once, fed into `resolveReadRoot` as the repository the `worktree` target is
   * validated against, and never consulted again; the capture is anchored at whatever that
   * resolution returns. Reaching for it after that point would reintroduce the second,
   * independent root this issue exists to remove.
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
  // The def FILE is present but opencode is not applying it — the resolved config carries no
  // default-deny floor (issue #111, C73). Worst here of anywhere: without the floor,
  // `guild-build` resolves on opencode's built-in `"*": allow`, i.e. the UNRESTRICTED tool set,
  // which is exactly what the def-missing refusal exists to prevent. TWO SHAPES, and the footprint
  // differs (review B4 — an earlier comment claimed the early one's footprint for both): the EARLY
  // refusal lands before `snapshotScaffold`, before the git snapshot and before any log write, so
  // nothing ran and nothing was recorded; the LATE one comes from the re-check inside the turn's
  // own serve lease, so it lands AFTER the scaffold baseline, AFTER `snapshotWorktree` and AFTER
  // `expect`/`started`, and is recorded exactly like a failed call (three entries, one call_id).
  // exitAnalogue null either way (no bash counterpart; NOT a reuse of C57's 5).
  | "agent-unhardened"
  // The target named a directory that is not a worktree of this repository (issue #107,
  // reusing #96's kind and refusal shape verbatim). Refused before any log write AND before
  // any snapshot.
  | "worktree-invalid"
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
  // THE TURN PRODUCED NOTHING ON ANY CHANNEL (issue #121, C74). NOT the read paths'
  // `empty-answer`, and the different name is the point: this path's answer is the PATCH, so an
  // empty report is only a failure when the turn ALSO made no tool calls — a model that reached
  // for no tool cannot have edited a file or run a command. Evaluated after the capture (the
  // `filesChanged` guard reads it), which changes nothing about it: the patch, the recovery hint
  // and the `delegate-diff` entry are exactly what they would have been. exitAnalogue null (no
  // bash counterpart). See `nothingDelivered`.
  | "empty-delegation"
  | "agent-mismatch";

export interface DelegateAttribution {
  /** The EXACT model id used: the resolved id, or the id opencode actually ran. */
  model: string;
  requestedModel: string;
  agent: string;
  runId: string;
  callId: string;
  /** The tree this delegation EDITED, present ONLY when the caller targeted a worktree
   * (issue #107). Reported so a review can state which tree the patch is of — a diff review
   * of the wrong tree is the failure the target exists to prevent. */
  worktree?: string;
}

export interface DelegateError {
  kind: DelegateErrorKind;
  message: string;
  /** 5 agent-def-missing (C57), 2 model-id (C55), 3 deny, 4 ask (C56); null for a
   * call-failed/agent-mismatch (bash propagates opencode's own status; 0 = success). */
  exitAnalogue: number | null;
  model: string;
  tier?: PolicyTier;
  /**
   * Present ONLY on `empty-delegation` (issue #168): the turn's tool-call count — zero, by the
   * refusal's own definition — and the provider's completion metadata for the turn.
   */
  diagnostics?: TurnDiagnostics;
}

export interface DelegateOk {
  ok: true;
  /** The model's own text account of what it did — DATA to review, not instructions. */
  report: string;
  attribution: DelegateAttribution;
  capture: DelegateCapture;
  rootConflict?: string;
  /** Present ONLY when the issue-#111 resolved-agent check could not be made; the delegation
   * PROCEEDED and this is the "never silently" half of that decision (C73). */
  agentUnverified?: string;
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
  /** See `DelegateOk.agentUnverified`. */
  agentUnverified?: string;
  /** The tree that was targeted, present whenever one was — including on a refusal that
   * happened before anything ran. A failed delegation is exactly the case where "which tree
   * do I go and look at?" is urgent, and `attribution` (which carries it on success) does not
   * exist here. Absent on a `worktree-invalid` refusal: nothing was resolved. */
  worktree?: string;
  /** Present when the turn RAN: the action trace up to the failure. */
  activity?: ActivitySummary;
  /** Present when the bridge was armed and the turn ran — e.g. every gated call timed out. */
  approval?: ApprovalSummary;
}
export type DelegateResult = DelegateOk | DelegateFail;

/** How a model id is named in an error message; `""` means "opencode picked". */
function modelLabel(requestedModel: string): string {
  return requestedModel === "" ? "(opencode default)" : requestedModel;
}

/**
 * DID THIS DELEGATION PRODUCE ANYTHING AT ALL? (issue #121, C74 amended.) True ⇒ the call is
 * refused as `empty-delegation` instead of returning an empty success. Exported for the tests,
 * which assert every column, because each one is either a way to fail a working delegation or a
 * way to let the defect back through.
 *
 * THE QUESTION IS ABOUT THE TURN, NOT ABOUT THE CAPTURE — and that is the whole of the redesign
 * (review round, 2026-08-03; coordinator's decision, maintainer to ratify). "Nothing was
 * produced on any channel" means the model said nothing AND reached for no tool. **Zero tool
 * calls is the load-bearing half: a model that made no tool call cannot have edited a file or
 * run a command**, so it settles the question without asking the capture whether it was ABLE to
 * measure. `toolCallCount` is turn-scoped (`turnToolCallCount`), not session-wide.
 *
 * THE FIRST CUT ASKED THE CAPTURE INSTEAD, AND IT WAS UNREACHABLE IN THIS VERY REPOSITORY.
 * It required `captureComplete` (plus `gitWorktree`), reasoning that only a completed capture
 * may claim "no change". But `ignoredFingerprint` marks the capture INCOMPLETE
 * (`ignored-state-incomplete`) whenever `git status --ignored` collapses a wholly-ignored
 * directory into one `!! dir/` entry — which it does for any such directory, `node_modules/`
 * included. Probed 2026-08-03 on a fixture repo with one ignored dir: the rejected turn came
 * back `ok:true`, `report:""`, `captureComplete:false` — issue #121's exact defect, unfixed, in
 * the common case. Capture representability is orthogonal to "did the turn produce anything",
 * and conflating them cost the fix.
 *
 * `filesChanged === 0` IS THE ONE CAPTURE COLUMN, AND IT IS PURELY A GUARD: a refusal must never
 * be returned while a patch with real content sits on disk. It cannot enable a refusal, only
 * suppress one.
 *
 * `patchPath === null` IS DELIBERATELY ABSENT, and this is a knowing deviation from the
 * predicate as specified to me — recorded because it inverts the outcome on the finding above.
 * The same probe showed the ignored-directory case returns `filesChanged: 0` with a **non-null**
 * `patchPath` (the patch file is written and empty; only `nothingToReview` nulls the path, and
 * that requires `captureComplete`). So keeping the column would have left the CRITICAL finding
 * unfixed by a different route. It also cannot serve the guard purpose it was given:
 * `patchPath === null` holds ONLY where `filesChanged === 0` already holds, so it can never stop
 * a refusal from hiding a real patch — it can only produce false negatives, which is exactly
 * what it did.
 *
 * TRIMMED-empty, not `=== ""`, mirroring C74: a turn that produced one newline has said nothing
 * either, and a one-whitespace-character difference must not decide this.
 *
 * THREE SHAPES STAY SUCCESSES, all live:
 *   (a) an empty report beside a REAL PATCH — a terse model that edited files and wrote no
 *       prose has delivered. It made tool calls, so the second column is false, and its patch
 *       makes the third false too. PR #120 pinned this; it must never be caught here.
 *   (b) a NON-EMPTY report beside ZERO edits — probed live 2026-08-02: a model whose writes the
 *       approval bridge rejected returns a real report explaining why nothing was written.
 *   (c) a SILENT BASH-ONLY turn — the model ran commands, changed nothing and said nothing
 *       (found by the gemini-3.1-pro guild review). It did something; the activity trace and the
 *       approval record are where that shows. This is the NEW stated residual: a turn with ≥1
 *       tool call, an empty report and no captured change stays a success, deliberately.
 */
export function nothingDelivered(
  report: string,
  toolCallCount: number,
  capture: DelegateCapture,
): boolean {
  return report.trim() === "" && toolCallCount === 0 && capture.filesChanged === 0;
}

/**
 * The DEFAULT root, matching OpencodeLifecycle's own default (`$GUILD_PROJECT_DIR` else cwd).
 *
 * Since #107 this is an INPUT to root resolution, not the answer: it names the repository the
 * `worktree` target is validated against and the root used when none was named. Called from
 * exactly one place — inline, inside the `resolveReadRoot` argument — so its value is never
 * bound to a local that a capture consumer could pick up instead of `writeRoot`.
 */
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

  // 1b. THE ROOT — RESOLVED ONCE, HERE, AND NOWHERE ELSE (issue #107).
  //
  //     #96 gave the READ tools a validated `worktree` target and moved the serve child's cwd.
  //     It deliberately did NOT give one to this path, because moving the child without moving
  //     the CAPTURE would let the model edit one tree while the evidence layer snapshotted,
  //     diffed and reported another — and reported itself COMPLETE while doing it. A patch that
  //     is wrong while claiming to be right is worse than no feature at all.
  //
  //     So the root is resolved exactly once, by the SAME `resolveReadRoot`/`resolveWorktreeTarget`
  //     choke point the read tools use (no second validation path, no second refusal shape), and
  //     the ONE value it returns is threaded to BOTH consumers:
  //       - the serve child (`serve`, from the ServePool) and its agent-def dirs, and
  //       - every capture consumer — `snapshotWorktree`, the throwaway-index baseline and
  //         after-tree, the ignored-file fingerprint, the submodule state, `scaffoldDigest`,
  //         the recovery hint and the recorded patch (C37–C40).
  //     `resolveRepoDir` is consumed INLINE as the repository the target is validated against
  //     and is never bound to a local. **That is a discipline, not a proof, and the honest
  //     statement matters here**: `cwd` remains in scope (the evidence log takes it, and the
  //     log root is deliberately NOT re-rooted at the target), so nothing in the type system
  //     stops a future edit handing `cwd` to a capture consumer. A reviewer did exactly that
  //     and the first cut's structural test passed. What actually holds the property is the
  //     BEHAVIOURAL suite — fixtures that mutate one tree while targeting the other, which
  //     fail loudly the moment the two roots diverge — backed by `test/delegate.test.ts`
  //     #107(i), which pins the specific call shapes (including that this function's result is
  //     handed on as the `writeRoot` BINDING, not an arbitrary expression) through which a
  //     second root could otherwise re-enter unnoticed.
  //
  //     NO SESSION-AUTHORITY LOOKUP, deliberately. #96 made `GET /session/{id}`'s `directory`
  //     the authority for a read CONTINUATION, because opencode serves a session from any child
  //     of the same project and a continuation that omitted `worktree` would otherwise carry one
  //     conversation into another tree. `guild_delegate` has no continuation: it takes no
  //     `sessionId`, mints a fresh session every call and does not keep it. There is no earlier
  //     turn whose root could disagree with this call's, so the lookup would decide nothing and
  //     would only add a control-plane round-trip. Machinery not needed is machinery not copied.
  //     (If a `sessionId` input is ever added here, this comment is the pointer: it must be
  //     routed through `resolveReadRoot`'s `sessionId`, which already implements the rule.)
  const readRoot = await resolveReadRoot({
    ...(params.worktree !== undefined ? { worktree: params.worktree } : {}),
    env,
    cwd,
    confContents,
    serve: deps.serve,
    projectDir: resolveRepoDir(deps, env, cwd),
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
        // No bash counterpart (the wrapper had no target), so null rather than a number that
        // would collide with the area-H table. Same choice #96 made for the read tools.
        exitAnalogue: null,
        message: readRoot.message,
      },
    };
  }
  /** THE root for this call: the serve child's cwd AND the capture root. One value, one
   * source. Every consumer below takes this and nothing else. */
  const writeRoot = readRoot.value.root;
  const { serve, agentDefDirs, worktree: worktreeRoot } = readRoot.value;

  // 2. NO-FALLBACK def gate (deviation from bash C16). A missing guild-build def REFUSES
  //    loudly — never silently degrades to the UNRESTRICTED `build`. Refused before any log
  //    write (gap parity) and before any snapshot (nothing ran).
  //
  //    THE DIRS MOVED WITH THE CHILD (#96's finding, and it binds harder here). opencode
  //    resolves agents from the SERVE's cwd, not from the git repository — so a worktree whose
  //    `.opencode/agent/` lacks `guild-build.md` must refuse naming THAT worktree's dir. The
  //    write path's ordering has one step the read paths do not: this refusal lands before
  //    `log.expect()` AND before `snapshotWorktree`, so a refused delegation leaves no run and
  //    takes no snapshot of a tree it was never going to touch.
  if (!hardenedDefPresentIn(DELEGATE_AGENT, agentDefDirs).present) {
    return {
      ok: false,
      rootConflict,
      ...(worktreeRoot !== undefined ? { worktree: worktreeRoot } : {}),
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
      ...(worktreeRoot !== undefined ? { worktree: worktreeRoot } : {}),
      error: {
        kind: gate.refusal.kind,
        message: gate.refusal.message,
        exitAnalogue: gate.refusal.exitAnalogue,
        model: gate.refusal.model,
        tier: gate.refusal.tier,
      },
    };
  }

  // 4a. THE SCAFFOLD BASELINE IS HOISTED ABOVE THE GATE (issue #111 review A1; maintainer
  //     decision 2026-07-30). This is a READ of a directory tree — it writes nothing, runs no
  //     git and mints nothing — so it does not touch the rule that a refusal below snapshots
  //     nothing (C24 gap parity).
  //
  //     WHY, PRECISELY — and an earlier version of this comment had it wrong. It is NOT that the
  //     gate silences `scaffoldChanged`: measured on 1.18.7 (three runs), `GET /agent` returns in
  //     ~200-270ms and `node_modules` lands +579ms/+581ms/+3680ms AFTER the response, so a
  //     post-gate baseline would still differ from the after-tree and the flag would still fire.
  //     (A margin, not a certainty — review B5: the gap below contains `new EvidenceLog`, the
  //     approval pre-flight and `log.newRun()`'s retention scan, so it is a race this wins wide,
  //     not an impossibility.)
  //     It is that `.opencode/.gitignore` IS written synchronously, and it is in
  //     `isServeScaffold`'s set — so a post-gate `before.scaffold` is non-EMPTY,
  //     `scaffoldAppeared` below is false, and the SEVERE "plugin directory MODIFIED, no benign
  //     explanation" wording fires on every first delegation into a tree. A false severe alarm on
  //     a routine event is how a tamper signal dies. The git snapshot stays below the gate, where
  //     a refusal never reaches it.
  const scaffoldBefore = snapshotScaffold(writeRoot);

  // 4b. RESOLVED-AGENT GATE (issue #111, C73) — stage two of the def check, and the highest
  //     stakes copy of it: step 2 proved `guild-build.md` exists, this proves opencode is
  //     APPLYING it. Without the floor, `guild-build` resolves on opencode's built-in
  //     `"*": allow` — the unrestricted tool set the def-missing refusal exists to keep this
  //     path off. Placed before the approval pre-flight (which reads the def SOURCE and would
  //     otherwise arm against a map that is not in force), before `newRun`, and before
  //     `snapshotWorktree`: a refusal here leaves no run and takes no snapshot of a tree it
  //     was never going to touch. See `gateAgentFloor`.
  /** ONE per call, shared by the early gate and the in-lease re-check: the stderr dedupe is
   * keyed on the child instance WITHIN a call, so the same child warns once, a different serving
   * child warns again, and the next call starts fresh (review B1). */
  const announced = new Set<string>();
  const floor = await gateAgentFloor({
    serve,
    agent: DELEGATE_AGENT,
    agentDefDirs,
    announced,
    ...(deps.agentFloor !== undefined ? { checker: deps.agentFloor } : {}),
  });
  if (!floor.ok) {
    return {
      ok: false,
      rootConflict,
      ...(worktreeRoot !== undefined ? { worktree: worktreeRoot } : {}),
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
    DELEGATE_AGENT,
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

  // 4c. APPROVAL BRIDGE pre-flight (issue #20 slice 4). This is THE path the bridge exists
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
      ...(floorNote.note !== undefined ? { agentUnverified: floorNote.note } : {}),
      ...(worktreeRoot !== undefined ? { worktree: worktreeRoot } : {}),
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

  // 5. Snapshot the RESOLVED root BEFORE the model runs (throwaway index; caller's index and
  //    worktree untouched — C36/C37). Nothing has been edited yet, so this is the baseline —
  //    of `writeRoot`, which is by construction the same directory the serve child below is
  //    rooted at. The SCAFFOLD half of the baseline was captured at step 4a, before the gate
  //    touched opencode at all; everything taken here is git state, which the gate cannot move.
  const before = snapshotWorktree(writeRoot, scaffoldBefore);

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
      // The receipts say WHICH TREE was edited (issue #107). Its own field, not `readRoot`:
      // "this tree was mutated" is a different claim from "the answer describes this tree".
      ...(worktreeRoot !== undefined ? { writeRoot: worktreeRoot } : {}),
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

  // 7. Capture AFTER — on EVERY path, including a failed call: whatever the model changed
  //    before failing must be recorded (trace ask.sh, which calls record_delegate_diff before
  //    log_complete regardless of opencode's exit). The callId is the lifecycle's; using it
  //    keeps the delegate-diff entry paired to the same call (verify cardinality, C24).
  const capture = await captureAndLog(before, {
    writeRoot,
    // Present ONLY for a targeted call: it is what turns the recovery hint into one that
    // names the tree. Absent ⇒ the hint stays byte-identical to the pre-#107 one.
    ...(worktreeRoot !== undefined ? { worktreeRoot } : {}),
    log,
    runId,
    callId: outcome.callId,
  });

  if (outcome.ok && nothingDelivered(outcome.text, outcome.toolCallCount, capture)) {
    // NOTHING WAS PRODUCED ON ANY CHANNEL (issue #121, C74 amended). Placed after the capture
    // because the `filesChanged` guard reads it; the DECIDING half — zero tool calls — is a fact
    // about the turn and would be available earlier. Everything above is deliberately left
    // alone: the snapshots, the patch decision, the recovery hint, the scaffold tamper signal
    // and the `delegate-diff` bookkeeping are byte-for-byte what they would be if this branch
    // did not exist. The refusal reads the capture; it does not shape it.
    //
    // THE EVIDENCE SAYS THE TURN SUCCEEDED, AND THAT IS CORRECT, NOT AN OVERSIGHT. `completed`
    // is written by the spine before this line runs, and it records what the TURN did: it
    // completed, history was read, and the byte-exact answer is `""` — `exit_code: 0`,
    // `capture_state: "complete"`. C74's read-path row records `exit_code: 1` because there the
    // failure IS the turn's, thrown from inside `askViaAgent`. Here the turn is a success that
    // delivered nothing, and the judgement is the tool's, made one layer up and one step later.
    // Making the receipts say otherwise would mean deferring the `completed` write out of the
    // shared spine for all four tools — a far larger change than this defect earns. And the log
    // does NOT lose the distinction meanwhile: #120's success (empty report, real patch) writes
    // a `delegate-diff` entry and this refusal's usual shape writes none, so `calls.jsonl` alone
    // separates them. (An earlier version of this comment claimed the opposite — that they were
    // indistinguishable without the capture — which was simply false; review round 2026-08-03.
    // The one case that also writes a `delegate-diff` is a CRASHED capture, via the patch-less
    // `diffUncaptured`, and that entry carries `capture_complete:false`, so it is not confusable
    // with #120's either.) The run still verifies clean.
    //
    // NOTHING TO CLEAN UP ON THE SESSION, EITHER. `guild_delegate` takes no `sessionId`, mints a
    // fresh session per call and never keeps it, so by the time this runs `askViaAgent`'s
    // deletion matrix has already torn it down under `created here + success + !keepSession`.
    // C74's continued-session row — a caller's id kept alive because the caller owns it — has no
    // counterpart here and no new row is added to that matrix.
    const delegateDiagnostics: TurnDiagnostics = {
      toolCallCount: outcome.toolCallCount,
      ...(outcome.completion !== undefined ? { completion: outcome.completion } : {}),
      ...(outcome.partTypes !== undefined ? { partTypes: outcome.partTypes } : {}),
    };
    const fail: DelegateFail = {
      ok: false,
      rootConflict,
      error: {
        kind: "empty-delegation",
        model: requestedModel,
        // No bash counterpart (the wrapper never judged this), so null rather than a number
        // that would collide with the area-H table — the same choice C74 made for `empty-answer`.
        exitAnalogue: null,
        message:
          `The delegation to '${modelLabel(requestedModel)}' produced NOTHING: the turn made no ` +
          `tool calls, wrote no report, and no file changes were captured. Refusing to return an ` +
          `empty success — there is no work to review and nothing was said about why. The full ` +
          `capture record is attached (structuredContent.capture), including any scaffoldWarning. ` +
          (outcome.providerError !== undefined
            ? `The provider reported: ${outcome.providerError}`
            : `opencode reported no error for the turn, so the cause is not in the history — ` +
              `check the model id (guild_models lists the authed provider CONFIGURATION, and a ` +
              `provider can still reject a listed id at call time) and, if the activity layer is ` +
              `on, the call's activity errors.`) +
          // Issue #168: the same diagnostics line the read paths carry. Here the tool-call half
          // is a tautology by construction — this refusal requires zero — but the COMPLETION
          // half is not, and a zero-output-token completion reads differently from one opencode
          // recorded no metadata for at all.
          ` ${describeTurnDiagnostics(delegateDiagnostics)}`,
        diagnostics: delegateDiagnostics,
      },
      capture,
      ...(worktreeRoot !== undefined ? { worktree: worktreeRoot } : {}),
    };
    if (outcome.activity !== undefined) fail.activity = outcome.activity;
    if (outcome.approval !== undefined) fail.approval = outcome.approval;
    if (floorNote.note !== undefined) fail.agentUnverified = floorNote.note;
    return fail;
  }

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
        ...(worktreeRoot !== undefined ? { worktree: worktreeRoot } : {}),
      },
      capture,
    };
    if (outcome.activity !== undefined) ok.activity = outcome.activity;
    if (outcome.approval !== undefined) ok.approval = outcome.approval;
    if (floorNote.note !== undefined) ok.agentUnverified = floorNote.note;
    return ok;
  }

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
      : `The delegate call to '${modelLabel(requestedModel)}' failed: ${outcome.reason}. ` +
        `Any changes the model made before failing are captured for review (see capture.patchPath).`;
  // ISSUE #117'S `requireAnswer` IS STILL DELIBERATELY NOT WIRED HERE, and this line is where
  // that shows. The shared spine can report `empty-answer`, but only for a caller that asked for
  // it — and this tool does not, because an empty report beside a real patch is a successful
  // delegation. So the kind is unreachable on this path and is mapped defensively rather than
  // widening this tool's wire contract with a kind it never emits. Issue #121's own refusal is a
  // DIFFERENT kind (`empty-delegation`) decided above; do not collapse the two — one is "the turn
  // said nothing", the other is "the turn said nothing AND made no tool calls".
  const kind: DelegateErrorKind =
    outcome.kind === "empty-answer" ? "call-failed" : outcome.kind;
  const fail: DelegateFail = {
    ok: false,
    rootConflict,
    error: {
      kind,
      model: requestedModel,
      exitAnalogue: null,
      message,
    },
    // Surface the partial capture even on failure so the human can review/recover.
    capture,
    ...(worktreeRoot !== undefined ? { worktree: worktreeRoot } : {}),
  };
  if (outcome.activity !== undefined) fail.activity = outcome.activity;
  if (outcome.approval !== undefined) fail.approval = outcome.approval;
  if (floorNote.note !== undefined) fail.agentUnverified = floorNote.note;
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
  ctx: {
    /** THE resolved root (issue #107) — the only directory this function may touch. Named
     * `writeRoot`, not `repoDir`, so a future edit that reaches for "the project dir" has
     * nothing here to reach for. */
    writeRoot: string;
    /** Set only when the caller targeted a worktree; drives the `-C` in the recovery hint. */
    worktreeRoot?: string;
    log: EvidenceLog;
    runId: string;
    callId: string;
  },
): Promise<DelegateCapture> {
  // THE HINT NAMES THE TREE WHEN IT IS NOT THE ONE YOU ARE STANDING IN (issue #107). A bare
  // `git checkout <tree> -- <path>` pasted into the project root after a worktree-targeted
  // delegation would restore into the WRONG tree — silently, and from a tree sha that does
  // resolve there, because a worktree and its main checkout share one object database. So a
  // targeted call gets the `-C` form. An UNTARGETED call's hint is left byte-identical to the
  // pre-#107 string (C39's `git checkout <tree> -- <path>`): nothing about it was ambiguous,
  // and changing it would churn the contract, the docs and the fixtures for no gain.
  const recoveryHint =
    before.gitWorktree && before.dirty && before.tree
      ? ctx.worktreeRoot !== undefined
        ? `git -C ${ctx.worktreeRoot} checkout ${before.tree} -- <path>`
        : `git checkout ${before.tree} -- <path>`
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
  const scaffoldChanged = before.gitWorktree && scaffoldDigest(ctx.writeRoot) !== before.scaffold;
  // THE FLAG NEVER VARIES; ONLY THE WORDING DOES, AND ONLY ON A CHECKED PRECONDITION
  // (issue #107, review finding M1). The probe that closed #96's known unknown (see
  // EMPTY_SCAFFOLD_DIGEST) established that opencode materializes its plugin runtime into a
  // serve cwd **iff that cwd already contains an `.opencode/` directory**, on the first request
  // that loads it. Where that held, the first delegation into a not-yet-materialized tree sees
  // the scaffolding appear for a reason that is opencode's housekeeping, and reporting it in
  // the same words as a model writing into an EXISTING plugin dir would train the reader to
  // ignore the one signal covering an execution-carrying blind spot.
  //
  // THE PRECONDITION IS READ FROM THE SNAPSHOT, NOT INFERRED. The first cut of this code
  // inferred it — "delegate requires guild-build.md in the target, so `.opencode/` always
  // exists" — and that is FALSE: `resolveAgentDefDirs` also resolves the opencode GLOBAL agent
  // dir, so under an `init --global` install a target with NO `.opencode/` passes the def
  // pre-check. In that configuration opencode never scaffolds, so scaffolding appearing anyway
  // has NO benign explanation — it is a write into a directory `opencode serve` loads and
  // executes — and the inferred premise handed exactly that case the reassuring wording.
  //
  // Hence three cases, and the middle one deliberately does not over-claim: a single digest
  // cannot separate "opencode scaffolded" from "opencode scaffolded AND something was written
  // alongside it", so it offers a SUFFICIENT explanation without asserting it is the whole one.
  const scaffoldAppeared = scaffoldChanged && before.scaffold === EMPTY_SCAFFOLD_DIGEST;
  const scaffoldWarning = !scaffoldChanged
    ? null
    : !scaffoldAppeared
      ? "the transport's plugin directory (.opencode/node_modules + manifests) changed during this call — review it; this directory is loaded by opencode serve"
      : before.opencodeDir
        ? "the transport's plugin directory (.opencode/node_modules + manifests) APPEARED during this call, in a tree that already had an .opencode/ directory — opencode materializes its own runtime into exactly such a tree on first use, which is a SUFFICIENT explanation but not proof that it is the whole of what appeared (one digest cannot separate opencode's scaffolding from anything written alongside it). Review the directory; opencode serve loads and executes it"
        : "the transport's plugin directory (.opencode/node_modules + manifests) was CREATED during this call in a tree that had NO .opencode/ directory beforehand — opencode does NOT scaffold such a tree (probed on 1.18.7), so its first-run materialization does not explain this. Treat it as an UNEXPLAINED write into a directory opencode serve loads and executes, and review it before anything else";

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
      repoDir: ctx.writeRoot,
      baseTree: before.tree,
      ignoredBefore: before.ignored,
      submodulesBefore: before.submodules,
      // The BASELINE's tracked-scaffold set (issue #108). The after-snapshot must subtract this
      // exact set: `guild-build` allows `bash`, so the model can `git commit` mid-turn and move
      // HEAD, and a re-derived set would flip scaffold paths between the two trees.
      trackedScaffold: before.trackedScaffold,
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
/**
 * The edited-tree note for the TEXT channel (issue #107) — the write-path sibling of
 * `readRootBlocks`, and worded differently on purpose: "Read root" and "Edited tree" are
 * different claims, and the human skimming the transcript before opening the patch is being
 * told which tree the patch is OF.
 *
 * An ADDITIONAL block, never a prefix, for the same reason #96 made that choice: `content[0]`
 * stays byte-exact the model's report, and the block exists at all only when a target was
 * named — so an untargeted delegation's wire shape is unchanged.
 */
export function writeRootBlocks(
  worktree: string | undefined,
): Array<{ type: "text"; text: string }> {
  if (worktree === undefined || worktree.length === 0) return [];
  return [{ type: "text", text: `Edited tree: ${worktree}` }];
}

export function delegateToToolResult(r: DelegateResult): McpToolResult {
  if (r.ok) {
    const structured: Record<string, unknown> = {
      report: r.report,
      ...r.attribution,
      capture: r.capture,
    };
    if (r.rootConflict) structured.rootConflict = r.rootConflict;
    if (r.agentUnverified) structured.agentUnverified = r.agentUnverified;
    if (r.activity) structured.activity = r.activity;
    if (r.approval) structured.approval = r.approval;
    return {
      content: [{ type: "text", text: r.report }, ...writeRootBlocks(r.attribution.worktree)],
      structuredContent: structured,
    };
  }
  const structured: Record<string, unknown> = { error: r.error };
  if (r.capture) structured.capture = r.capture;
  // THE TREE TRAVELS ON THE FAILURE PATH TOO (issue #107, review finding M2). Success carries
  // it via `...r.attribution`; failure has no attribution, so the first cut set `DelegateFail
  // .worktree` and then never copied it to the wire — the field's own doc comment, the tool
  // description and `/guild:delegate` step 3 all promised something the client never received.
  // The case that makes it consequential is `call-failed`/`agent-mismatch`, where the model
  // ALREADY EDITED the target tree: `capture.patchPath` points into the PROJECT's logs and, on
  // a clean pre-turn tree, `recoveryHint` is null — so without this nothing in the result names
  // the tree that was actually mutated.
  if (r.worktree) structured.worktree = r.worktree;
  if (r.rootConflict) structured.rootConflict = r.rootConflict;
  if (r.agentUnverified) structured.agentUnverified = r.agentUnverified;
  if (r.activity) structured.activity = r.activity;
  if (r.approval) structured.approval = r.approval;
  return {
    content: [{ type: "text", text: r.error.message }, ...writeRootBlocks(r.worktree)],
    structuredContent: structured,
    isError: true,
  };
}
