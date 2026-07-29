/**
 * Typed opencode HTTP client.
 *
 * A thin, typed layer over `opencode serve`'s session API — the layer every later
 * milestone (M3 capture, M5+ tools, M8 delegate) builds on. Deliberately uses raw
 * `fetch` (like `lifecycle.ts` and the spike) rather than the `@opencode-ai/sdk`
 * client: the generated `SessionCreateData` type omits the `agent`/`model` body
 * fields the *running* server actually accepts (verified live in the spike), so
 * hand-rolled request bodies are the only way to encode what the server wants and
 * to let the tests assert the exact wire shapes.
 *
 * TWO LOAD-BEARING INVARIANTS, each traced to a proven finding:
 *
 *   1. THE SYNC MESSAGE RESPONSE IS NOT A CAPTURE SOURCE. `POST /session/{id}/message`
 *      returns only the final assistant message with NO tool parts (spike-proven).
 *      The final text and the full exchange are extracted EXCLUSIVELY from
 *      `GET /session/{id}/message`. `sendMessage` therefore returns only completion
 *      metadata (cost/tokens/ids/finish) — its result type has NO text/parts field,
 *      so a higher layer *cannot* reach the sync body's text through this module.
 *
 *   2. BYTE-EXACTNESS. The final text is reconstructed from the history's text parts
 *      by plain concatenation — no trimming, no newline normalization, no re-encoding.
 *      This is M3's evidence-layer input, so a lost trailing newline here is a
 *      contract violation downstream (CONTRACT.md area D, C25). JSON.parse round-trips
 *      string bytes exactly, so the value returned equals what the model produced.
 */

import type { ServeHandle } from "./lifecycle.js";

// --- HTTP timeout defaults (ms) --------------------------------------------
/** Session create/list/delete/history: fast control-plane calls. */
export const SHORT_HTTP_MS = 15_000;
/** A model turn — generous; a real call can be slow. 15 min default (raised from 3 min
 * for long-running planning/review work); override per-install with GUILD_MESSAGE_TIMEOUT_MS. */
export const MESSAGE_HTTP_MS = 900_000;

// --- Model id -------------------------------------------------------------
/** The message-send model shape: `{providerID, modelID}` (verified live). */
export interface MessageModel {
  providerID: string;
  modelID: string;
}

/** The session-create model shape: `{id, providerID}` (verified live) — note the
 * different key (`id`, not `modelID`). Encoded distinctly so the two can't be
 * accidentally swapped; the offline fixture asserts the exact keys of each. */
export interface SessionCreateModel {
  id: string;
  providerID: string;
}

/**
 * Split a `"provider/model"` spec into its parts. A bare id (no slash) defaults
 * the provider to `opencode`, matching the wrapper convention. An empty
 * spec is a caller error — callers that want "opencode's own default" omit the
 * model entirely rather than passing "".
 */
export function splitModel(spec: string): MessageModel {
  if (spec === "") {
    throw new Error("empty model spec — omit the model to use opencode's default");
  }
  const idx = spec.indexOf("/");
  if (idx === -1) return { providerID: "opencode", modelID: spec };
  return { providerID: spec.slice(0, idx), modelID: spec.slice(idx + 1) };
}

// --- Errors ---------------------------------------------------------------
/** An HTTP/transport failure carrying enough context to diagnose (C-transport). */
export class OpencodeHttpError extends Error {
  constructor(
    message: string,
    readonly detail: {
      method: string;
      path: string;
      status?: number;
      sessionId?: string;
    },
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "OpencodeHttpError";
  }
}

/** Compose the effective abort signal: a per-call timeout, plus the caller's own
 * signal if supplied (either firing aborts the request). */
function effectiveSignal(timeoutMs: number, caller?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return caller ? AbortSignal.any([caller, timeout]) : timeout;
}

interface RequestCtx {
  baseUrl: string;
  path: string;
  method: string;
  timeoutMs: number;
  sessionId?: string;
  signal?: AbortSignal;
  body?: unknown;
  /** Test seam only (the approval bridge already carries one for its reply path). Production
   * callers omit it and get the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Issue one bounded request, throwing an `OpencodeHttpError` with context on any
 * transport failure or non-2xx status. Returns the parsed JSON body. */
async function requestJson(ctx: RequestCtx): Promise<unknown> {
  const { baseUrl, path, method, timeoutMs, sessionId } = ctx;
  const init: RequestInit = { method, signal: effectiveSignal(timeoutMs, ctx.signal) };
  if (ctx.body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(ctx.body);
  }

  let res: Response;
  try {
    res = await (ctx.fetchImpl ?? fetch)(`${baseUrl}${path}`, init);
  } catch (err) {
    // Timeout aborts and connection failures both land here — annotate the DURATION only
    // when the failure was actually the timeout firing, so a too-small configured value
    // (e.g. a seconds-vs-ms typo, 600 → 600ms) is self-evident, without mislabelling a
    // connection-refused error as a timeout. `AbortSignal.timeout` rejects fetch with a
    // DOMException whose name is "TimeoutError" (verified live, Node v22: a caller abort
    // is "AbortError", a connection failure a TypeError "fetch failed"); it survives the
    // `AbortSignal.any` wrap in `effectiveSignal`.
    const timedOut = (err as Error)?.name === "TimeoutError";
    throw new OpencodeHttpError(
      `${method} ${path} failed${timedOut ? ` after ${timeoutMs}ms (timeout)` : ""}${
        sessionId ? ` (session=${sessionId})` : ""
      }: ${(err as Error).message}`,
      { method, path, sessionId },
      { cause: err },
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new OpencodeHttpError(
      `${method} ${path} → ${res.status} ${res.statusText}${
        sessionId ? ` (session=${sessionId})` : ""
      }${text ? ` ${text}` : ""}`,
      { method, path, status: res.status, sessionId },
    );
  }
  return res.json();
}

// --- session permission ruleset (issue #20 slice 4) ------------------------
/**
 * V1 PERMISSION SURFACE — PINNED BY DECISION (issue #93; maintainer, 2026-07-29).
 *
 * Everything the approval bridge touches is opencode's **v1** permission surface, and it
 * stays there deliberately. This is a recorded decision, not an artefact of when the code
 * happened to be written. The v1 seam is: the ruleset sent as `POST /session`'s `permission`
 * field (`createSession`, below), the copy echoed back by `GET /session/{id}`
 * (`fetchSession`), the open-request snapshot `GET /permission` (`listPendingPermissions`),
 * and the two replies in `src/approve.ts` / `src/cli.ts` — `POST
 * /session/{id}/permissions/{permId}` and `POST /permission/{id}/reply`.
 *
 * THE GROUND IS MOVING UNDER ONE OF THOSE FOUR, AND THE PIN SAYS SO RATHER THAN OMITTING IT.
 * `POST /session/{sessionID}/permissions/{permissionID}` (operationId `permission.respond`,
 * the APPROVE half) is marked **`deprecated: true`** in 1.18.7's `/doc` — and it is the ONLY
 * deprecated operation in the entire document (verified: one hit across every path and
 * method). That is not an argument for migrating: a deprecated endpoint that WORKS beats a
 * live one that silently gates nothing. But it is a real **expiry condition** on this pin, and
 * a reader of this record is entitled to know it. **When that endpoint is removed** — every
 * approval refused while rejections still work — the bridge does not quietly degrade into
 * "approvals never land". **Since issue #97 it DETECTS it rather than merely recording it:**
 * ANY non-2xx opencode answers, deliberately not the 404 alone (a removed route can equally
 * give 405/410/501, and keying on 404 would have let those fall into the transport counter), is
 * followed by `GET /permission` — this file's `listPendingPermissions`, the same v1 snapshot the
 * #91 re-list reads — and a request still open after a refused reply is counted under
 * **`unsettled`**: distinct from `contested` (a 404 race the bridge went and looked for), from
 * `refused` (any other refusal that left nothing open), and from `undelivered` (nothing came
 * back at all). An `unsettledReason` names this deprecation and the status observed **whenever
 * the detection came from an approve-path refusal** — the field keeps the most informative
 * reason rather than the first, precisely so a weaker detection cannot hold it while this
 * condition goes unreported. The removal therefore reads as a diagnosis rather than a rise in a
 * quiet counter, whatever status it presents as.
 * The correct response at that point is to move the APPROVE
 * reply to whatever opencode offers then, re-verify with the probe script below, and update
 * this record and C69a together — NOT to take that removal as licence to move the ruleset
 * itself onto v2, which is a separate question this pin answers on its own evidence.
 *
 * opencode 1.18.7 ALSO exposes a v2 surface: `POST /api/session/{id}/permission` ("evaluate
 * and, when approval is required, create a permission request for a session") and `GET
 * /api/session/{id}/permission`. Those are the obvious modernization target, and they are
 * the wrong one. **Do not migrate onto them.**
 *
 * THE PROBE (live `opencode serve`, opencode 1.18.7, 2026-07-29 — the coordinating session's
 * own observation; `allow` was first noticed by the agent implementing #91, which is why that
 * PR stayed on v1, and it was re-probed independently before this was written). A session
 * created with `{"permission":[{"permission":"bash","pattern":"*","action":"ask"}]}` — echoed
 * back as STORED by `GET /session/{id}` — answers the v2 evaluator with
 * `{"data":{"id":"per_…","effect":"allow"}}`. `allow`, not `ask`. The same for `edit` and
 * `read`, the same when the request body names the `agent` explicitly, and identical to a
 * control session created with NO ruleset at all: **the v2 evaluator does not consult the v1
 * ruleset stored on the session.** `GET /permission` stays `[]` throughout, so no request is
 * ever raised and no human is ever prompted.
 *
 * FURTHER FINDINGS THAT SHARPEN THAT, ALL FROM THE SAME 1.18.7 PROBE, AND EACH ONE MAKES THE
 * MIGRATION WORSE RATHER THAN MERELY DIFFERENT:
 *   - **v2 is not inert — it evaluates the AGENT DEF, just not the session ruleset.** `bash`
 *     answers `deny` for `guild-read`/`guild-research` and `allow` for `build`. So the tools
 *     v2 waves through are precisely the ones this bridge would gate: C66 invariant 2 lets it
 *     gate only tools the agent ALREADY allows, and those are exactly the ones v2 answers
 *     `allow` for. The gate would be a no-op over its entire domain, not a partial one.
 *   - **The two surfaces keep SEPARATE pending stores.** A v2 `ask` (reachable via opencode's
 *     built-in `*.env` rule) put three requests on `GET /api/session/{id}/permission` and
 *     `/api/permission/request` while `GET /permission` stayed `[]` — so the #91 re-list, which
 *     reads the v1 list, would keep answering "nothing is open".
 *   - **A v2 ask IS seen, IS promptable, and CANNOT BE ANSWERED — which is worse than being
 *     missed.** `src/activity.ts` has handled `permission.v2.asked` since #20 (`31800c4`), and
 *     a REAL frame captured off `GET /event` on 1.18.7 normalizes to a fully populated
 *     `{kind:"permission-asked", permissionId:"per_…", permissionTool:"read"}`, which
 *     `handleEvent` routes straight into `#onAsked`. So the bridge WOULD prompt the developer
 *     and start the approval clock — and then **both** pinned v1 reply endpoints reject the
 *     v2 request id with **404 `PermissionNotFoundError`**. Verified against a live pending v2
 *     request: `POST /permission/{id}/reply` and `POST /session/{id}/permissions/{id}` both
 *     404, while `POST /api/session/{id}/permission/{id}/reply` answers 400 on body shape —
 *     i.e. the request genuinely exists, in the other store. A human decision would therefore
 *     be taken and dropped, and the turn would then block to `GUILD_MESSAGE_TIMEOUT_MS`
 *     (15 min) rather than the 120 s approval deadline. It would no longer be dropped
 *     *silently*: since issue #97 `#settle` re-checks a 404 against `GET /permission` and books
 *     a still-open request as **`unsettled`**, not as the race `contested` means. (The v1 list
 *     is the wrong store for a v2 request, so it would answer "not open" — and the entry lands
 *     in `contested` with `still_open: false`. The detection this record relies on is therefore
 *     the DEPRECATION shape above, where the request really is on the v1 list; a half-migration
 *     is caught by C69's stored-ruleset check and this pin, not by that counter.) **An earlier
 *     version of this record claimed the event
 *     was dropped as an unknown type. That was WRONG** — refutable from `src/activity.ts:325`
 *     in seconds — and is corrected here rather than quietly deleted, because a false claim
 *     in a record whose whole purpose is to be trusted later is the worst thing it can carry.
 * A corollary for anyone re-probing: an `ask` from v2 is NOT evidence that the ruleset was
 * honoured (the built-in `*.env` rule produces one on a session with no ruleset at all). The
 * question is whether the ruleset CHANGES the answer, which is why
 * `modelguild/verify-permission-surface.sh` is differential — gated session vs control
 * session, same agent, same action.
 *
 * WHAT BREAKS IF SOMEBODY MIGRATES ANYWAY. The bridge would report itself **armed** — the
 * ruleset is accepted, echoed back, and passes C69's stored-ruleset check — while opencode
 * waved the gated tool straight through. Running ungated while the caller believes the turn
 * is gated is the single outcome CONTRACT C69 says this feature must never produce, and it
 * fails SILENTLY: a clean run reporting `requests: 0` looks exactly like a model that asked
 * for nothing. C66's two narrowing invariants are expressed as v1 rules, so they would go on
 * being enforced — against a ruleset nothing evaluates.
 *
 * ONE OBSERVATION, NOT A DIAGNOSIS. The very FIRST v2 evaluation after serve startup returned
 * `effect:"deny"` for a body that returned `allow` on every later attempt, including on that
 * same session re-probed three times. Not reproduced — the 2026-07-29 re-probe's own first
 * post-startup evaluation answered `allow` — and no cause is claimed here. It is recorded
 * because "the first call after startup differs" is exactly the shape of thing that makes a
 * migration look fine in testing, and it is why the probe script evaluates several rounds
 * and prints them all rather than trusting one.
 *
 * WHAT WOULD HAVE TO BE TRUE TO REVISIT — a PRECONDITION for any migration, not an
 * alternative to this pin:
 *   1. A FRESH probe on a LATER opencode showing that the v2 evaluator honours the ruleset
 *      stored on the session (this build does not, and an old probe proves nothing about a
 *      new build in either direction); OR the ruleset re-expressed in v2's own terms, with
 *      C66's invariants (`ask` only, never gate a tool the def denies) re-derived for that
 *      shape rather than assumed to carry over. **That probe is RUNNABLE, not a plan:**
 *      `bash modelguild/verify-permission-surface.sh` — exit 0 "pin holds", exit 7
 *      "ATTENTION, revisit #93", exit 6 inconclusive. Run it after an opencode bump, the way
 *      the `verify-guild-*.sh` proofs are run; it calls no model.
 *   2. The `verify-guild-*.sh`-style proof extended to cover it — live serve, a genuinely
 *      blocked tool call, a real answer. `test/approve.test.ts` runs against a fake that
 *      implements the v1 behaviour, so it would go GREEN on a v2 bridge that gates nothing.
 * Anything short of both is a change that reports itself armed on evidence it does not have.
 *
 * `modelguild/tests/check-v1-permission-pin.sh` (CI) holds the mechanical half, and its reach
 * is stated honestly because overstating it is how a check gets trusted past its evidence: it
 * greps for a **literal** v2 PERMISSION path (`/api/permission…`, `/api/session/…/permission`)
 * in non-comment lines of `src/`, and requires this record to still be here. It is scoped to
 * the permission surface deliberately — the rest of opencode's `/api/` tree is not covered by
 * this decision and blocking it would tax an unrelated migration into deleting the check.
 * Being a literal grep, it does NOT catch the same prefix split or computed
 * (`"/api" + "/permission"`, a `const V2 = "/api"` template, `join("/")`, or `/api` folded
 * into the base URL), nor a future permission surface under a different prefix. Those stay
 * review judgment against C69a.
 */

/**
 * One `PermissionRule` for `POST /session`'s `permission` field — verified against opencode
 * 1.18.7's `/doc` (`{permission, pattern, action}`; the ruleset is `PermissionRule[]`).
 *
 * Typed with `action: "ask"` ONLY, at the transport, on purpose. The session ruleset MERGES
 * over the agent def's resolved array (probe P2) and can override in BOTH directions, so an
 * `allow` line here would re-open a tool a hardened def denies — probe P2 proved exactly
 * that by handing a working shell to `guild-read` with one rule. The type makes the illegal
 * value unrepresentable in TypeScript and `assertAskOnlyRuleset` makes it unrepresentable at
 * runtime, for a caller who casts.
 */
export interface SessionPermissionRuleWire {
  permission: string;
  pattern: string;
  action: "ask";
}

/** Thrown when a caller tries to send anything but `ask` rules. */
export class SessionPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionPermissionError";
  }
}

/**
 * THE WIRE BOUNDARY for BOTH approval invariants. `src/approve.ts` asserts them at
 * construction; this asserts them again at the only place a ruleset can actually leave the
 * process, so no future caller can route around that module.
 *
 *   1. **Only `ask`.** A session ruleset merges over the agent def (last-match-wins), so an
 *      `allow` here could re-open a tool the def denies.
 *   2. **Only tools the agent already allows** (review finding M4 — the wire used to check
 *      invariant 1 alone, and happily accepted `{bash,*,ask}` for `guild-read`). An `ask` on
 *      a DENIED tool converts it into an approvable one, which is a widening too. The
 *      allow-set is passed in by the caller (the bridge reads it from the def in force);
 *      when it is omitted the check cannot run, so the ruleset must be empty.
 */
export function assertAskOnlyRuleset(
  rules: readonly { action: string; permission: string }[],
  allowedTools?: readonly string[],
): void {
  for (const r of rules) {
    if (r.action !== "ask") {
      throw new SessionPermissionError(
        `refusing to POST a session permission rule with action '${r.action}' for ` +
          `'${r.permission}'. A session ruleset MERGES over the agent def (last-match-wins), ` +
          `so anything but 'ask' could WIDEN a hardened agent. Only the approval bridge may ` +
          `send rules, and only 'ask' ones.`,
      );
    }
  }
  if (rules.length === 0) return;
  if (allowedTools === undefined) {
    throw new SessionPermissionError(
      "refusing to POST a session permission ruleset with no agent allow-set to check it " +
        "against: an 'ask' on a tool the agent def DENIES would convert a denied tool into " +
        "an approvable one. Pass `allowedTools` (the def's own allow-set) with any ruleset.",
    );
  }
  const allowed = new Set(allowedTools);
  for (const r of rules) {
    if (!allowed.has(r.permission)) {
      throw new SessionPermissionError(
        `refusing to POST an 'ask' rule for '${r.permission}': the agent def does NOT allow ` +
          `that tool, and gating a denied tool would make it approvable — a widening wearing ` +
          `a safety feature's clothes. Allowed here: ${[...allowed].join(", ") || "(nothing)"}.`,
      );
    }
  }
}

// --- createSession --------------------------------------------------------
export interface CreateSessionOpts {
  baseUrl: string;
  agent?: string;
  title?: string;
  /** Optional `"provider/model"`. When given it is encoded as the session-create
   * shape `{id, providerID}` (distinct from the message-send shape). */
  model?: string;
  /**
   * Per-session permission ruleset (the approval bridge's seam — issue #20 slice 4). Sent
   * verbatim as `permission`; `ask` rules only, asserted before the request is built.
   */
  permission?: readonly SessionPermissionRuleWire[];
  /** The agent def's own allow-set, so the wire can enforce invariant 2 (see
   * `assertAskOnlyRuleset`). Required whenever `permission` is non-empty. */
  allowedTools?: readonly string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** A minimal reference to a created session. `permission` is the ruleset opencode ECHOED
 * back on create — the only evidence that the ruleset actually took, which is what lets a
 * caller refuse rather than run ungated against a build that ignored the field. */
export interface SessionRef {
  id: string;
  permission?: unknown;
}

/** `POST /session` — create a session bound to `agent`. */
export async function createSession(opts: CreateSessionOpts): Promise<SessionRef> {
  const body: {
    title?: string;
    agent?: string;
    model?: SessionCreateModel;
    permission?: readonly SessionPermissionRuleWire[];
  } = {};
  if (opts.title !== undefined) body.title = opts.title;
  if (opts.agent !== undefined) body.agent = opts.agent;
  if (opts.model !== undefined) {
    const { providerID, modelID } = splitModel(opts.model);
    body.model = { id: modelID, providerID }; // session-create shape: {id, providerID}
  }
  if (opts.permission !== undefined && opts.permission.length > 0) {
    // THIS FIELD IS THE v1 GATE, AND IT IS PINNED THERE BY DECISION (issue #93): opencode's
    // v2 evaluator does not consult what is stored here, so moving the gate onto it would
    // leave the bridge reporting itself armed while the tool ran. See the V1 PIN above.
    assertAskOnlyRuleset(opts.permission, opts.allowedTools);
    body.permission = opts.permission;
  }

  const raw = (await requestJson({
    baseUrl: opts.baseUrl,
    path: "/session",
    method: "POST",
    timeoutMs: opts.timeoutMs ?? SHORT_HTTP_MS,
    signal: opts.signal,
    body,
  })) as { id?: unknown; permission?: unknown };

  if (typeof raw.id !== "string" || raw.id.length === 0) {
    throw new OpencodeHttpError(`session create returned no id: ${JSON.stringify(raw)}`, {
      method: "POST",
      path: "/session",
    });
  }
  const ref: SessionRef = { id: raw.id };
  if (raw.permission !== undefined) ref.permission = raw.permission;
  return ref;
}

export interface FetchSessionOpts {
  baseUrl: string;
  sessionId: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** `GET /session/{id}` — the session record, including the `permission` ruleset it was
 * CREATED with (verified on 1.18.7: create and get both echo it). A per-session ruleset is
 * fixed at creation, so this is the only honest way to answer "is this continuation gated?".
 *
 * v1 BY DECISION (issue #93; see the V1 PIN above). What this endpoint proves is that the
 * ruleset was STORED — the 1.18.7 probe found a session whose stored `ask` rule was echoed
 * back here and still evaluated `allow` on the v2 surface, so "stored" is only evidence of
 * gating for the v1 evaluator that actually reads it. v2's `GET /api/session/{id}/permission`
 * is a different surface and was NOT probed for equivalence; do not swap it in.
 *
 * It also carries `directory` — the cwd of the serve child the session was CREATED in
 * (verified on 1.18.7: both `POST /session` and this endpoint report it). That is the
 * authority for issue #96's read root on a continuation: opencode keys sessions by PROJECT,
 * and a git worktree and its main checkout are the same project, so a session created on a
 * worktree-rooted child is happily served by a repo-rooted one — the transport does not
 * object, while the read fence differs. `directory` is the only thing that says which tree
 * the conversation was actually held against. */
export async function fetchSession(
  opts: FetchSessionOpts,
): Promise<{ permission?: unknown; directory?: unknown }> {
  const raw = (await requestJson({
    baseUrl: opts.baseUrl,
    path: `/session/${opts.sessionId}`,
    method: "GET",
    timeoutMs: opts.timeoutMs ?? SHORT_HTTP_MS,
    sessionId: opts.sessionId,
    signal: opts.signal,
  })) as { permission?: unknown; directory?: unknown };
  return raw;
}

// --- pending permission requests (issue #91) -------------------------------
/**
 * One entry of `GET /permission` — a permission request opencode is still holding open,
 * waiting for a reply.
 *
 * PROBED LIVE on opencode 1.18.7 (2026-07-28, this worktree, against a real `opencode serve`
 * with a genuinely blocked `bash` tool call): the endpoint's own `/doc` summary is "List
 * pending permissions" and its description is **"Get all pending permission requests across
 * all sessions"** — it is GLOBAL to the serve child, which is why `listPendingPermissions`
 * takes the session id as a REQUIRED argument rather than an optional filter (see there).
 * An empty list is `[]` with a 200, so there is no error path to special-case, and a request
 * that has been replied to leaves the list at once (a second reply to it is a 404).
 *
 * The fields are exactly the `PermissionRequest` schema — and, verified from a capture of the
 * same serve, field-for-field IDENTICAL to the `properties` payload of a `permission.asked`
 * SSE frame. That identity is load-bearing for the approval bridge: it routes a re-listed
 * request through the SAME normalizer as a streamed one instead of inventing a second shape
 * that could drift from the one the stream path is tested against.
 */
export interface PendingPermission {
  id: string;
  sessionID: string;
  /** The TOOL the request is about (`bash`, `edit`, …) — opencode's `permission` field. */
  permission?: string;
  patterns?: unknown;
  metadata?: unknown;
  always?: unknown;
  tool?: unknown;
  /** Anything a future opencode adds: carried through untouched, never interpreted here. */
  [key: string]: unknown;
}

export interface ListPendingPermissionsResult {
  /** Requests open for the session that was asked about, in the order opencode listed them. */
  pending: PendingPermission[];
  /** Entries dropped for want of a usable `id`/`sessionID`. REPORTED rather than silently
   * skipped: a caller deciding "have I now seen everything?" must not read a silent drop as
   * an empty list.
   *
   * SCOPED TO THE SESSION ASKED ABOUT, ON PURPOSE (review finding 3). It used to be counted
   * BEFORE the session filter, so on a panel sharing one serve child another member's broken
   * entry landed in this caller's count — and because the approval bridge refuses to clear
   * `degraded` while this is non-zero, one member's malformed entry could keep a sibling
   * bridge degraded for the rest of its call. That is a cross-session dependency in the one
   * function whose entire design point is that sessions do not affect one another. */
  malformed: number;
  /** Open requests belonging to OTHER sessions on this serve child — counted, never returned,
   * whatever else may be wrong with them. Visible so the global-ness of the endpoint is a fact
   * on the result, not folklore. */
  otherSessions: number;
  /**
   * Entries attributable to NO session: not an object, or carrying no `sessionID` (which
   * opencode's own schema marks required, so this is a protocol violation rather than an
   * expected shape).
   *
   * Kept apart from `malformed` because the two deserve different treatment. One of these
   * might be the caller's own, so a caller deciding "have I seen everything?" should still
   * treat it as a gap — whereas a KNOWN other-session entry never is one.
   */
  unattributable: number;
}

export interface ListPendingPermissionsOpts {
  baseUrl: string;
  /**
   * REQUIRED, and required on purpose. `GET /permission` is global to the serve child, so on
   * a panel sharing one child it returns other members' requests too; answering one of those
   * would be this process replying on behalf of a session it does not own. Making the filter
   * a mandatory argument rather than an optional one means a caller cannot forget it — there
   * is no unfiltered form of this function to reach for.
   */
  sessionId: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * `GET /permission` — the requests opencode is still holding open, narrowed to one session.
 *
 * A CONTROL-PLANE call, so it uses `SHORT_HTTP_MS`, never the model-turn budget: it must
 * answer promptly or fail, since the only caller runs it on a stream re-attach while a turn
 * is already blocked.
 *
 * It THROWS on a transport failure, a non-2xx, or a body that is not an array — the caller
 * (`src/approve.ts`) turns that into a degradation, never into a call failure.
 *
 * v1 BY DECISION (issue #93; see the V1 PIN above). This is the list the bridge's own replies
 * settle, and during the 2026-07-29 probe a v2 evaluation raised nothing into it — so a
 * bridge half-migrated onto the v2 endpoints would re-list an empty set forever and read it
 * as "the model asked for nothing".
 */
export async function listPendingPermissions(
  opts: ListPendingPermissionsOpts,
): Promise<ListPendingPermissionsResult> {
  const ctx: RequestCtx = {
    baseUrl: opts.baseUrl,
    path: "/permission",
    method: "GET",
    timeoutMs: opts.timeoutMs ?? SHORT_HTTP_MS,
  };
  if (opts.signal !== undefined) ctx.signal = opts.signal;
  if (opts.fetchImpl !== undefined) ctx.fetchImpl = opts.fetchImpl;
  const raw = await requestJson(ctx);
  if (!Array.isArray(raw)) {
    throw new OpencodeHttpError(
      `GET /permission did not return an array (got ${typeof raw}) — refusing to guess what ` +
        `is still pending`,
      { method: "GET", path: "/permission" },
    );
  }
  const pending: PendingPermission[] = [];
  let malformed = 0;
  let otherSessions = 0;
  let unattributable = 0;
  // THE SESSION FILTER RUNS FIRST, and everything else is judged inside it (review finding 3):
  // an entry belongs to this caller, to somebody else, or to nobody identifiable, and only the
  // first two of those can be decided at all. Counting brokenness before attribution let one
  // session's bad data become another's problem.
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      unattributable += 1;
      continue;
    }
    const rec = entry as Record<string, unknown>;
    const sessionID = typeof rec.sessionID === "string" ? rec.sessionID : "";
    if (sessionID.length === 0) {
      // No session named at all — it could be anyone's, including ours.
      unattributable += 1;
      continue;
    }
    if (sessionID !== opts.sessionId) {
      // Somebody else's, broken or not. Not this caller's business either way.
      otherSessions += 1;
      continue;
    }
    // Ours. `id` is what a reply is addressed to, so without one there is nothing to be done
    // with the entry beyond reporting that we saw something we could not use.
    const id = typeof rec.id === "string" ? rec.id : "";
    if (id.length === 0) {
      malformed += 1;
      continue;
    }
    pending.push(rec as PendingPermission);
  }
  return { pending, malformed, otherSessions, unattributable };
}

// --- sendMessage ----------------------------------------------------------
/** An input message part. Only `text` is needed for the guild flows; the type is
 * left open for the file/agent/subtask parts opencode also accepts. */
export interface TextPartInput {
  type: "text";
  text: string;
}
export type MessagePartInput = TextPartInput;

export interface SendMessageOpts {
  baseUrl: string;
  sessionId: string;
  agent?: string;
  /** `"provider/model"`, encoded as the message-send shape `{providerID, modelID}`. */
  model?: string;
  parts: MessagePartInput[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Completion metadata from the sync message response — DELIBERATELY carries no
 * text or parts. The sync body's text is incomplete (no tool parts) and is not a
 * capture source (invariant 1); the only honest use for it is a "the turn finished"
 * signal plus cost/token/id metadata. Read the actual answer via `fetchHistory`.
 */
export interface SendResult {
  messageId?: string;
  providerID?: string;
  modelID?: string;
  cost?: number;
  tokens?: unknown;
  finish?: string;
}

/** `POST /session/{id}/message` — send a turn and block until it completes. */
export async function sendMessage(opts: SendMessageOpts): Promise<SendResult> {
  const body: {
    agent?: string;
    model?: MessageModel;
    parts: MessagePartInput[];
  } = { parts: opts.parts };
  if (opts.agent !== undefined) body.agent = opts.agent;
  if (opts.model !== undefined) {
    body.model = splitModel(opts.model); // message-send shape: {providerID, modelID}
  }

  const raw = (await requestJson({
    baseUrl: opts.baseUrl,
    path: `/session/${opts.sessionId}/message`,
    method: "POST",
    timeoutMs: opts.timeoutMs ?? MESSAGE_HTTP_MS,
    sessionId: opts.sessionId,
    signal: opts.signal,
    body,
  })) as { info?: Record<string, unknown> };

  // Read ONLY metadata off the sync envelope; the text/parts are intentionally
  // discarded here so they can never leak upward (invariant 1).
  const info = raw.info ?? {};
  return {
    messageId: typeof info.id === "string" ? info.id : undefined,
    providerID: typeof info.providerID === "string" ? info.providerID : undefined,
    modelID: typeof info.modelID === "string" ? info.modelID : undefined,
    cost: typeof info.cost === "number" ? info.cost : undefined,
    tokens: info.tokens,
    finish: typeof info.finish === "string" ? info.finish : undefined,
  };
}

// --- history + extraction -------------------------------------------------
/** Normalized tool status (the four opencode `ToolState` statuses). */
export type ToolStatus = "pending" | "running" | "completed" | "error";

/** A tool invocation from history, flattened to the shape M3 capture and M8
 * delegate consume: the tool name plus the union-collapsed state. `output` is
 * present on `completed`, `error` on `error`; both are undefined otherwise. */
export interface ToolPartView {
  tool: string;
  state: {
    status: ToolStatus;
    input?: unknown;
    error?: string;
    output?: string;
  };
}

/** One message in the ordered history, kept close to the raw envelope so nothing
 * is lost before M3 decides what to persist. */
export interface HistoryMessage {
  role: string;
  info: Record<string, unknown>;
  parts: Array<Record<string, unknown>>;
}

export interface SessionHistory {
  messages: HistoryMessage[];
}

export interface FetchHistoryOpts {
  baseUrl: string;
  sessionId: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** `GET /session/{id}/message` — the full ordered exchange, tool parts included.
 * This is the ONLY sanctioned source of the final text and the tool record. */
export async function fetchHistory(opts: FetchHistoryOpts): Promise<SessionHistory> {
  const raw = (await requestJson({
    baseUrl: opts.baseUrl,
    path: `/session/${opts.sessionId}/message`,
    method: "GET",
    timeoutMs: opts.timeoutMs ?? SHORT_HTTP_MS,
    sessionId: opts.sessionId,
    signal: opts.signal,
  })) as unknown;

  if (!Array.isArray(raw)) {
    throw new OpencodeHttpError(`history was not an array: ${JSON.stringify(raw).slice(0, 200)}`, {
      method: "GET",
      path: `/session/${opts.sessionId}/message`,
      sessionId: opts.sessionId,
    });
  }

  const messages: HistoryMessage[] = raw.map((entry) => {
    const e = (entry ?? {}) as { info?: Record<string, unknown>; parts?: unknown };
    const info = e.info ?? {};
    const parts = Array.isArray(e.parts) ? (e.parts as Array<Record<string, unknown>>) : [];
    return { role: typeof info.role === "string" ? info.role : "", info, parts };
  });
  return { messages };
}

/**
 * The final assistant text, reconstructed BYTE-EXACT from history (invariant 2).
 *
 * The "final answer" is the last assistant message that carries text parts —
 * the one the sync response also returns — so a trailing pure-tool-call assistant
 * message can't blank the answer. Text parts are concatenated verbatim in order
 * with NO separator, trim, or normalization, so newlines (including a trailing
 * one), quotes, and unicode survive intact.
 */
export function finalAssistantText(history: SessionHistory): string {
  for (let i = history.messages.length - 1; i >= 0; i--) {
    const m = history.messages[i];
    if (m.role !== "assistant") continue;
    const textParts = m.parts.filter(
      (p) => p.type === "text" && typeof p.text === "string",
    );
    if (textParts.length === 0) continue;
    return textParts.map((p) => p.text as string).join("");
  }
  return "";
}

/**
 * The agent that actually SERVED the answer, read from the answer-producing assistant
 * message's `info.agent` (opencode 1.18.2 populates it — verified live: a `guild-read`
 * call reports `info.agent === "guild-read"`). Returns `undefined` when opencode does
 * not report an agent (older/other builds), so a caller can DISTINGUISH "served a
 * different agent" (a real mismatch to fail closed on) from "opencode didn't say" (which
 * must not be treated as a mismatch — the check is only as strong as the field's
 * presence, and inventing a mismatch on absence would break on a build that drops it).
 */
export function servingAgent(history: SessionHistory): string | undefined {
  for (let i = history.messages.length - 1; i >= 0; i--) {
    const m = history.messages[i];
    if (m.role !== "assistant") continue;
    const textParts = m.parts.filter(
      (p) => p.type === "text" && typeof p.text === "string",
    );
    if (textParts.length === 0) continue;
    const agent = m.info.agent;
    return typeof agent === "string" && agent.length > 0 ? agent : undefined;
  }
  return undefined;
}

/**
 * Raised when opencode served a DIFFERENT agent than the one requested — e.g. a silent
 * fallback to the full-access built-in `build` when a hardened def didn't resolve, which
 * would be full-access output masquerading as the read-only/hardened agent's. Thrown from
 * `askViaAgent` right after the history read (`expectedAgent` set), so the session-deletion
 * matrix cleans up correctly (a mismatch is treated as a failed turn). Carries the served
 * session id so a higher layer can record which session produced the wrong-agent output.
 */
export class AgentMismatchError extends Error {
  constructor(
    readonly requested: string,
    readonly actual: string,
    readonly sessionId: string,
  ) {
    super(
      `agent mismatch: requested '${requested}' but opencode served '${actual}' — ` +
        `refusing to return the wrong agent's output as if it were the requested one ` +
        `(a silent fallback to a weaker/full-access agent is a masquerade).`,
    );
    this.name = "AgentMismatchError";
  }
}

/** Every tool invocation across the exchange, flattened to `ToolPartView`. */
export function toolParts(history: SessionHistory): ToolPartView[] {
  const out: ToolPartView[] = [];
  for (const m of history.messages) {
    for (const p of m.parts) {
      if (p.type !== "tool") continue;
      const state = (p.state ?? {}) as Record<string, unknown>;
      out.push({
        tool: typeof p.tool === "string" ? p.tool : "",
        state: {
          status: (typeof state.status === "string" ? state.status : "pending") as ToolStatus,
          input: state.input,
          error: typeof state.error === "string" ? state.error : undefined,
          output: typeof state.output === "string" ? state.output : undefined,
        },
      });
    }
  }
  return out;
}

// --- deleteSession --------------------------------------------------------
export interface DeleteSessionOpts {
  baseUrl: string;
  sessionId: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** `DELETE /session/{id}`. Throws (with context) on a non-2xx status so a caller
 * that wants best-effort cleanup can choose to swallow it; `askViaAgent` does. */
export async function deleteSession(opts: DeleteSessionOpts): Promise<void> {
  await requestJson({
    baseUrl: opts.baseUrl,
    path: `/session/${opts.sessionId}`,
    method: "DELETE",
    timeoutMs: opts.timeoutMs ?? SHORT_HTTP_MS,
    sessionId: opts.sessionId,
    signal: opts.signal,
  });
}

// --- askViaAgent (composed through the M1 lifecycle) ----------------------
/** The slice of `OpencodeLifecycle` this module needs: run a fn against a ready
 * serve. Narrowed to an interface so the offline fixture can drive `askViaAgent`
 * against a fake HTTP server without spawning opencode. */
export interface ServeProvider {
  withServe<T>(fn: (h: ServeHandle) => Promise<T>): Promise<T>;
}

/**
 * A source of serve providers keyed by READ ROOT (issue #96).
 *
 * `opencode serve` fixes its cwd at spawn and opencode's `external_directory` rule fences
 * the read tools inside it, so reviewing a sibling git worktree needs a child rooted there.
 * The tools depend on this two-method interface rather than on `src/servepool.ts` so a test
 * can hand them a spy — and so this module keeps its "no lifecycle import" shape.
 *
 * `forRoot` is the MECHANISM only. Which roots are permissible is decided in exactly one
 * place, `resolveWorktreeTarget` in `src/worktree.ts`; nothing here re-checks it.
 */
export interface ServeRouter {
  /** The default root — the project the server itself was launched in. */
  readonly projectDir: string;
  /**
   * Roots OTHER than the project's that this router has been asked for. Empty means the
   * primary child is the only one there is, which is what makes a continuation's routing
   * unambiguous without asking opencode anything (see `resolveReadRoot`).
   */
  readonly extraRoots: readonly string[];
  forRoot(root: string): ServeProvider;
}

/**
 * LIVE-ACTIVITY ATTACHMENT (issue #20). The one seam this module gains: something that
 * can attach itself to a session's event stream for the duration of the turn.
 *
 * Deliberately STRUCTURAL — `client.ts` imports nothing from `src/activity.ts`. This file's
 * two documented invariants are about NOT leaking the sync response upward, and it stays
 * the thin typed transport it was: it knows only "attach before the turn, call the returned
 * detach afterwards". `ActivityRecorder` satisfies this shape; a test fake satisfies it too.
 *
 * `attach` MUST NOT reject — a visibility failure is never a call failure — and it resolves
 * only once the stream is attached (or has definitively failed), so events emitted at the
 * very start of the turn are not missed.
 */
export interface ActivityAttachable {
  attach(baseUrl: string, sessionId: string): Promise<() => void>;
}

/**
 * The APPROVAL bridge's seam (issue #20 slice 4) — structurally identical to
 * `ActivityAttachable`, named separately because it means something different: this one is
 * what ANSWERS a `permission.asked` while the turn blocks. Kept as its own type so a reader
 * of `askViaAgent` can see that two distinct things attach to the session, and so a caller
 * cannot pass an activity recorder where an approver is required.
 *
 * `src/approve.ts` `ApprovalBridge` satisfies it; a test fake satisfies it too. This module
 * imports nothing from `approve.ts` — it stays the thin typed transport it was.
 */
export interface ApprovalAttachable {
  attach(baseUrl: string, sessionId: string): Promise<() => void>;
}

/**
 * Raised when the approval bridge is armed but the session this turn will run in is NOT
 * carrying the required `ask` rules — i.e. the gate the caller believes is on is not on.
 *
 * Two ways it happens, both fail-closed here rather than running ungated:
 *   - a CONTINUED session (`sessionId`) created before the bridge was armed. A per-session
 *     ruleset is fixed at creation; opencode offers no way to add one later, so this turn
 *     cannot be gated;
 *   - a session we just created whose echoed `permission` does not carry our rules — an
 *     opencode build that ignored the field. That is precisely the case a "silently ungated"
 *     run would be worst, so it is checked rather than assumed.
 */
export class SessionPermissionMismatchError extends Error {
  constructor(
    readonly sessionId: string,
    readonly continued: boolean,
    detail: string,
  ) {
    super(
      `the approval bridge is armed but session '${sessionId}' is not carrying the required ` +
        `'ask' rules — ${detail}. Refusing to run the turn UNGATED while the caller believes ` +
        `it is gated.`,
    );
    this.name = "SessionPermissionMismatchError";
  }
}

export interface AskViaAgentOpts {
  agent: string;
  /** `"provider/model"`; omit to let opencode use its own default. */
  model?: string;
  /** Convenience: a single text turn. Ignored if `parts` is given. */
  prompt?: string;
  parts?: MessagePartInput[];
  title?: string;
  messageTimeoutMs?: number;
  shortTimeoutMs?: number;
  signal?: AbortSignal;
  /**
   * SESSION CONTINUATION (M7 / Option B). Continue an EXISTING opencode session
   * instead of creating a fresh one: the session already carries the peer's prior
   * turns, so the ONLY new bytes sent are `prompt`/`parts` — the driver never
   * re-transmits another model's words (the "Option B" construction guarantee).
   * When set, `createSession` is NOT called; the id is used as-is.
   */
  sessionId?: string;
  /**
   * Keep the session alive for further continuation: skip the `finally`-delete and
   * return the id in `AskResult.sessionId`. Default (unset/false) deletes the session
   * after the turn — the single-shot behaviour M5/M6 relied on. This expresses INTENT;
   * ownership (created-here vs continued) and outcome (success vs throw) also decide
   * deletion — see the matrix in `askViaAgent`.
   */
  keepSession?: boolean;
  /**
   * The agent name that MUST have served the answer. When set, `askViaAgent` reads the
   * served agent from history after the turn and throws `AgentMismatchError` if opencode
   * served a different one — closing the "silent fallback to a weaker agent" hole. Left
   * unset (e.g. low-level client tests), no check is done.
   */
  expectedAgent?: string;
  /**
   * LIVE ACTIVITY (issue #20). Attached immediately after the session id is known — a
   * fresh session's, or the continued `sessionId`'s — and BEFORE the turn is sent, so the
   * model's first tool call is already being watched. Detached in the same `finally` that
   * handles session deletion. Optional and failure-tolerant: an attach that throws is
   * swallowed, and the turn proceeds unwatched rather than failing.
   */
  activity?: ActivityAttachable;
  /**
   * APPROVAL BRIDGE (issue #20 slice 4). `permission` is the per-session `ask` ruleset sent
   * at session creation; `approval` is the thing that answers the resulting requests.
   *
   * UNLIKE `activity`, THIS IS NOT FAILURE-TOLERANT, and the difference is deliberate: a
   * visibility failure costs you a trace, but an approval failure would run a gated turn
   * UNGATED. So when `permission` is set, the ruleset is VERIFIED to be on the session
   * (echoed on create, or read back on a continuation) and a mismatch throws
   * `SessionPermissionMismatchError` BEFORE the turn is sent.
   */
  permission?: readonly SessionPermissionRuleWire[];
  /** The agent def's allow-set — forwarded to `createSession` for the wire-boundary check. */
  allowedTools?: readonly string[];
  /**
   * THE predicate for "is the session this turn will run in genuinely gated?", supplied by
   * `src/approve.ts`. Injected rather than implemented here for two reasons: this module
   * keeps importing nothing from the bridge, and there is exactly ONE implementation, so the
   * one the tests pin is the one that ships (review finding M10 — there used to be two, and
   * only the unused one was tested).
   */
  permissionCheck?: (stored: unknown) => { ok: true } | { ok: false; reason: string };
  approval?: ApprovalAttachable;
}

export interface AskResult {
  /** Byte-exact final text, from history (never the sync body). */
  text: string;
  sessionId: string;
  /** Completion metadata from the sync response (cost/tokens/ids/finish). */
  metadata: SendResult;
  /** Flattened tool invocations from history (M3/M8 input). */
  toolParts: ToolPartView[];
  /** The full parsed history, for capture layers that want the raw exchange. */
  history: SessionHistory;
}

/**
 * The composed happy path: ensure a serve is up (M1 lifecycle), obtain a session on
 * `agent` (create a fresh one, OR continue `opts.sessionId` when given — M7 Option B),
 * send the turn, read the answer from history, and — UNLESS `keepSession` — delete the
 * session even when the send or history read throws. Teardown is in a `finally`; a
 * failed delete is swallowed (best-effort) so it never masks the real error.
 *
 * When continuing (`sessionId` set), `createSession` is NOT called: the peer's earlier
 * turns live in opencode's session, so only this turn's `parts` are transmitted — the
 * fidelity guarantee is by construction, not by the driver re-quoting the peer.
 */
export async function askViaAgent(serve: ServeProvider, opts: AskViaAgentOpts): Promise<AskResult> {
  const parts: MessagePartInput[] =
    opts.parts ?? [{ type: "text", text: opts.prompt ?? "" }];
  const shortMs = opts.shortTimeoutMs ?? SHORT_HTTP_MS;
  const messageMs = opts.messageTimeoutMs ?? MESSAGE_HTTP_MS;

  // Ownership: did WE create this session, or are we continuing the caller's?
  const continued = opts.sessionId !== undefined;

  const gated = opts.permission !== undefined && opts.permission.length > 0;
  if (gated) assertAskOnlyRuleset(opts.permission!, opts.allowedTools);

  return serve.withServe(async (h) => {
    // Continue an existing session (no create) or mint a fresh one. The approval ruleset can
    // ONLY be applied at creation (opencode stores it on the session), so a continuation
    // carries whatever it was created with — verified below rather than assumed.
    let createdPermission: unknown;
    const sessionId =
      opts.sessionId ??
      (await (async () => {
        const created = await createSession({
          baseUrl: h.baseUrl,
          agent: opts.agent,
          title: opts.title,
          model: opts.model,
          ...(gated
            ? { permission: opts.permission, allowedTools: opts.allowedTools }
            : {}),
          timeoutMs: shortMs,
          signal: opts.signal,
        });
        createdPermission = created.permission;
        return created;
      })()).id;

    // EVERYTHING from here is inside the try, so the teardown `finally` runs on EVERY path.
    // That matters more since slice 4: the gate verification and the approval attach can both
    // THROW (unlike the activity attach, which is swallowed), and outside the try a throw
    // would have left the session we just created undeleted — a durable on-disk orphan
    // produced by the very feature meant to make the run safer to watch.
    let detachActivity: (() => void) | undefined;
    let detachApproval: (() => void) | undefined;
    let succeeded = false;
    try {
      // GATE VERIFICATION, before anything is sent. Fail closed: running ungated while the
      // caller believes the turn is gated is the one outcome this feature must never produce.
      if (gated) {
        const stored = continued
          ? (
              await fetchSession({
                baseUrl: h.baseUrl,
                sessionId,
                timeoutMs: shortMs,
                signal: opts.signal,
              })
            ).permission
          : createdPermission;
        // ONE predicate, injected (see `permissionCheck`). It checks both that the required
        // `ask` rules are present AND that the stored ruleset carries nothing that WIDENS
        // the agent — a subset check alone passed a session that also held `{bash,*,allow}`
        // (review finding M7, probed).
        const verdict = opts.permissionCheck?.(stored) ?? {
          ok: false as const,
          reason:
            "no permission check was supplied with the ruleset, so the gate cannot be verified",
        };
        if (!verdict.ok) {
          throw new SessionPermissionMismatchError(
            sessionId,
            continued,
            continued
              ? `${verdict.reason}. A session's permission ruleset is fixed when the session ` +
                "is CREATED: this one was created before the bridge was armed, or by " +
                "something else. Start a fresh session — drop sessionId — or turn the " +
                "approval knob off"
              : `${verdict.reason} — opencode did not store the ruleset as sent, so the gate ` +
                "did not take (a build that ignores the `permission` field would leave the " +
                "turn silently ungated)",
          );
        }
      }

      // Attach the activity stream BEFORE the turn (issue #20). A failure here is swallowed:
      // the call runs unwatched rather than failing over a visibility feature.
      if (opts.activity !== undefined) {
        try {
          detachActivity = await opts.activity.attach(h.baseUrl, sessionId);
        } catch {
          /* never fail the call over activity */
        }
      }
      // Attach the APPROVER before the turn too — a `permission.asked` can land on the model's
      // first tool call, and a bridge that attached late would miss it and let it hang. NOT
      // swallowed: a blind approver would never answer, and an unanswered request hangs the
      // turn rather than failing closed (probe P3).
      if (opts.approval !== undefined) {
        detachApproval = await opts.approval.attach(h.baseUrl, sessionId);
      }

      const metadata = await sendMessage({
        baseUrl: h.baseUrl,
        sessionId,
        agent: opts.agent,
        model: opts.model,
        parts,
        timeoutMs: messageMs,
        signal: opts.signal,
      });

      const history = await fetchHistory({
        baseUrl: h.baseUrl,
        sessionId,
        timeoutMs: shortMs,
        signal: opts.signal,
      });

      // Fail closed if opencode served a DIFFERENT agent than requested (a masquerade).
      // Thrown here — BEFORE `succeeded` is set — so the deletion matrix treats a
      // mismatch as a failed turn (a created-here session gets cleaned up, not orphaned).
      if (opts.expectedAgent !== undefined) {
        const actual = servingAgent(history);
        if (actual !== undefined && actual !== opts.expectedAgent) {
          throw new AgentMismatchError(opts.expectedAgent, actual, sessionId);
        }
      }

      const result: AskResult = {
        text: finalAssistantText(history),
        sessionId,
        metadata,
        toolParts: toolParts(history),
        history,
      };
      succeeded = true;
      return result;
    } finally {
      // Detach the APPROVER first: closing it rejects any request still open, so the model
      // is never left waiting on a prompt whose listener has gone away.
      try {
        detachApproval?.();
      } catch {
        /* best-effort */
      }
      // Then the activity stream — it is scoped to the turn, and unsubscribing
      // before the session delete keeps the bus refcount tidy on every path.
      try {
        detachActivity?.();
      } catch {
        /* best-effort */
      }
      // DELETION MATRIX (ownership × outcome × intent). Deletion means "we tear this
      // session down"; a delete failure is swallowed so it never masks a real error.
      //
      //   created here + success + keepSession   → KEEP  (return the id for reuse)
      //   created here + success + !keepSession  → DELETE (single-shot default)
      //   created here + THROW   (any keep)      → DELETE (id is unreturnable — keeping
      //                                             it would be a durable on-disk orphan)
      //   continued + success + keepSession      → KEEP  (caller wants more turns)
      //   continued + success + !keepSession     → DELETE (documented final-turn behaviour)
      //   continued + THROW     (any keep)       → KEEP  (the CALLER owns the id and may
      //                                             retry; deleting destroys e.g. workshop
      //                                             round-1 state we did not create)
      const shouldDelete = continued
        ? succeeded && !opts.keepSession
        : !succeeded || !opts.keepSession;
      if (shouldDelete) {
        await deleteSession({
          baseUrl: h.baseUrl,
          sessionId,
          timeoutMs: shortMs,
        }).catch(() => {});
      }
    }
  });
}
