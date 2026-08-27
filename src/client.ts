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

// --- resolved agents (issue #111) ------------------------------------------
/**
 * One entry of `GET /agent` — an agent as opencode RESOLVED it, not as its def file reads.
 *
 * `permission` is the resolved rule ARRAY, in declaration order, evaluated last-match-wins.
 * PROBED on opencode 1.18.7 (2026-07-29, live serve + `opencode agent list`, which prints the
 * same structure): a hardened `guild-read` ends
 * `[…builtins…, '*:*:deny', 'read:*:allow', 'grep:*:allow', 'glob:*:allow',
 * 'webfetch:*:allow', 'websearch:*:allow', …]`, while the same def with ONE unparseable
 * frontmatter defect resolves to the built-ins alone — no `*:deny` anywhere, so the last `*`
 * rule is opencode's own `*:allow`. `description` comes back `null` on such a def and `mode`
 * falls back to `all`, which is why neither field can be used as the tell.
 *
 * The fields are typed loosely on purpose: this is a diagnostic read of another project's
 * schema, and the one consumer (`src/agentfloor.ts`) must be able to say "opencode answered
 * in a shape I do not understand" rather than crash on it.
 */
export interface ResolvedAgent {
  name?: unknown;
  mode?: unknown;
  description?: unknown;
  permission?: unknown;
}

export interface ListAgentsOpts {
  baseUrl: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * `GET /agent` — every agent opencode resolved for this serve child, with its resolved
 * permission array.
 *
 * A CONTROL-PLANE call (`SHORT_HTTP_MS`, never the model-turn budget). It THROWS on a
 * transport failure, a non-2xx, or a body that is not an array; the caller turns that into an
 * "unverified" note, never into a call failure (see `src/agentfloor.ts` for why that
 * direction).
 *
 * PER SERVE CHILD, and that is load-bearing: opencode resolves agents from the serve's CWD
 * (probed for issue #96), so the answer for a worktree-rooted child is genuinely a different
 * answer than the project-rooted one. Anything that caches this must key on the child.
 */
export async function listAgents(opts: ListAgentsOpts): Promise<ResolvedAgent[]> {
  const ctx: RequestCtx = {
    baseUrl: opts.baseUrl,
    path: "/agent",
    method: "GET",
    timeoutMs: opts.timeoutMs ?? SHORT_HTTP_MS,
  };
  if (opts.signal !== undefined) ctx.signal = opts.signal;
  if (opts.fetchImpl !== undefined) ctx.fetchImpl = opts.fetchImpl;
  const raw = await requestJson(ctx);
  if (!Array.isArray(raw)) {
    throw new OpencodeHttpError(
      `GET /agent did not return an array (got ${typeof raw}) — refusing to guess what opencode ` +
        `resolved`,
      { method: "GET", path: "/agent" },
    );
  }
  return raw as ResolvedAgent[];
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
 * WHERE THIS TURN STARTS — the index just past the last `user` message THE CALLER SENT
 * (issue #117 review; compaction-aware since issue #189).
 *
 * `fetchHistory` returns the WHOLE session, and every extractor below walks it backwards.
 * Unbounded, that walk crosses turn boundaries, which on a `sessionId` continuation is not a
 * near-miss but a wrong answer to a different question: a turn that produced nothing let the
 * walk fall through to the PREVIOUS turn's text, and the caller got a confident, correct-
 * looking answer to the question it asked last time (reproduced live 2026-07-30 —
 * `deepseek-v4-flash-free` answered `"BANANA"`, a quota-exhausted `gpt-5.6-terra` was asked
 * something else on the same session, and `"BANANA"` came back as the new answer with
 * `ok:true`, recorded as this call's byte-exact `raw_response` with `exit_code: 0`).
 * **DO NOT UNBOUND THIS WALK.** Bounding KEEPS the reason the backward walk exists — opencode
 * splits one turn into a tool-call-only assistant message followed by a text-bearing one, and
 * the walk is what skips the former — while removing its reach into anything the caller did
 * not just ask.
 *
 * **A `user` message is the only delimiter opencode's history has, and NOT EVERY ONE OF THEM
 * IS THE CALLER'S** (issue #189). The former version of this comment asserted that a turn is
 * exactly one `POST /session/{id}/message` and that POST is what appends the user message; the
 * second half is false. opencode's auto-compaction runs INSIDE one POST: on context overflow
 * it appends a `user` message carrying a `compaction` part, and its autocontinue path appends
 * a second `user` message carrying a `synthetic` text part. Treating either as the boundary
 * silently truncates "this turn" to the post-compaction remainder, and every consumer below
 * then UNDER-reports — `turnToolCallCount` (C74's deciding column on the write path, and
 * #168's headline diagnostic on the read path) counts only what happened after the compaction,
 * which on the write path is a FALSE `empty-delegation` refusal.
 *
 * **THE SKIP IS EVIDENCE-BASED, AND ITS DEFAULT IS THE OLD BEHAVIOUR** — a `user` message is
 * a delimiter unless the payload positively marks it as opencode's own, so an opencode bump
 * that renames or drops a marker degrades to the pre-#189 bound rather than to an unbounded
 * walk. No parts at all, or parts of types this does not recognize, is a delimiter.
 *
 * Markers, from opencode 1.18.18's `GET /doc` (re-probed 2026-08-27):
 *   - `CompactionPart` — `type: "compaction"`, `auto` required, `overflow`/`tail_start_id`
 *     optional. A member of the `Part` union that `GET /session/{sessionID}/message` returns.
 *     No caller-sent message carries one, so ONE such part is enough.
 *   - `TextPart.synthetic` — an optional `boolean`, plus a free-form `metadata` object, where
 *     the autocontinue path records `compaction_continue: true`. Weaker evidence than a
 *     compaction part (a caller's own message is text too), so this leg requires that EVERY
 *     part of the message be marked: a message holding any unmarked part is still a delimiter.
 *
 * STATED RESIDUAL: the other compaction branch replays the retained tail as a fresh `user`
 * message, copying real parts across — those carry no marker, and this cannot tell them from
 * the caller's own message. It is bounded there exactly as it was before #189.
 *
 * No `user` message at all — or only compaction-appended ones — ⇒ index 0, i.e. the whole
 * history is the turn. That is the honest reading of a payload with no caller delimiter, and
 * it keeps every low-level fixture that serves assistant messages alone behaving as before.
 */
export function turnStartIndex(history: SessionHistory): number {
  for (let i = history.messages.length - 1; i >= 0; i--) {
    const m = history.messages[i];
    if (m.role !== "user") continue;
    if (isCompactionAppendedUser(m)) continue;
    return i + 1;
  }
  return 0;
}

/** A `compaction` part — opencode's own marker, on a message it created for it alone. */
function isCompactionPart(p: Record<string, unknown>): boolean {
  return p.type === "compaction";
}

/** A text part opencode wrote rather than the caller: `synthetic: true`, or the autocontinue
 * path's `metadata.compaction_continue: true`. Both are read defensively — `metadata` is an
 * untyped object in the schema, so anything but the literal `true` is not evidence. */
function isSyntheticTextPart(p: Record<string, unknown>): boolean {
  if (p.type !== "text") return false;
  if (p.synthetic === true) return true;
  const meta = typeof p.metadata === "object" && p.metadata !== null ? (p.metadata as Record<string, unknown>) : {};
  return meta.compaction_continue === true;
}

/**
 * Was this `user` message appended by opencode's compaction machinery rather than by the
 * caller's `POST /session/{id}/message`? (issue #189)
 *
 * Fails toward "the caller sent it", which is the pre-#189 bound: absent evidence this returns
 * `false` and the message delimits the turn, so no marker change can widen the walk.
 */
function isCompactionAppendedUser(m: HistoryMessage): boolean {
  if (m.parts.length === 0) return false;
  if (m.parts.some(isCompactionPart)) return true;
  return m.parts.every(isSyntheticTextPart);
}

/** The `type` parts of `m` carrying a string `text`, concatenated verbatim in order with NO
 * separator, trim or normalization — the byte-exact reconstruction (invariant 2), kept in one
 * place so "which parts carry an answer, and how they join" has a single definition. */
function joinPartText(m: HistoryMessage, type: string): string {
  return m.parts
    .filter((p) => p.type === type && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
}

/**
 * THE ONE DEFINITION OF "THIS STRING SAYS NOTHING" (issue #195, folding in #204).
 *
 * Every gate that decides whether a turn ANSWERED reads this: `answerSource`'s passes 1–2
 * below, and `requireAnswer`'s refusal in `askViaAgent`. The invariant those two share is
 * stated above `answerSource` — *every string a later pass can return is one `requireAnswer`
 * refuses* — and it is true only while both sides ask the same question. They were two
 * hand-written `trim() === ""` expressions 900 lines apart, coupled by that comment alone, so
 * widening one and not the other made a blank-looking string fall through to the byte-preserving
 * tier and then PASS the refusal: a success whose whole answer is one invisible character, with
 * no signal on any channel (issue #204 reproduced it by construction). One exported predicate
 * is what makes that desynchronization unwriteable rather than merely discouraged.
 *
 * **THIS DOES NOT COLLAPSE THE TIERS**, and the guard above `answerSource` forbidding that
 * still stands — it is about the GATE STRUCTURE (blank-insensitive passes choose the message,
 * byte-preserving passes keep the bytes), not about where "blank" is defined.
 *
 * **THE ALPHABET IS `trim()`'S PLUS UNICODE CATEGORIES `Cf`, `Cc` AND `Cs`, AND ITS EDGES ARE
 * MEASURED RATHER THAN ASSUMED (issue #195).** ECMA-262's `WhiteSpace`/`LineTerminator`
 * productions stop at `Zs` (so U+00A0, U+3000), U+FEFF and the four line terminators. Three
 * categories sit outside them and each reached this gate as a real "answer":
 *   - `Cf` (Format) — U+200B, U+180E, U+202E, U+00AD, U+2060, U+061C, U+200E;
 *   - `Cc` (Control) — U+0000 NUL, U+007F DEL and **U+0085 NEL**, which Unicode's own
 *     `White_Space=Yes` property DOES include while ECMA-262's `WhiteSpace` production does
 *     not, so `trim()` returns it unchanged;
 *   - `Cs` (Surrogate) — a LONE surrogate half. `\p{Cs}` matches one under the `u` flag
 *     (probed: `/\p{Cs}/u.test("\uD800") === true`), and a well-formed PAIR is a single astral
 *     code point which is NOT `Cs`, so an emoji-only answer stays an answer.
 *
 * **THE STATED RESIDUAL IS A CLASS, NOT A CHARACTER: render-blank code points OUTSIDE `Cf`/`Cc`/
 * `Cs` are still answers.** Measured, all returned as answers today: U+2800 BRAILLE PATTERN
 * BLANK (`So`, an ordinary PRINTING character whose glyph renders as nothing), the variation
 * selectors U+FE0F/U+FE00 and U+034F CGJ (`Mn`), the Hangul fillers U+3164/U+115F/U+FFA0
 * (`Lo` — letters that render as blank), U+17B4 (`Mn`) and U+2065 (`Cn`, unassigned). U+2800 is
 * the pinned exemplar in the tests, with U+FE0F and U+3164 beside it so the CLASS is asserted
 * rather than the one character. "The reader sees nothing" is a different question from "these
 * code points carry no text", and only the second is answered here — enumerating render-blank
 * glyphs is not a job for this predicate, and a category-based one cannot do it in any case.
 *
 * **THE GATE IS NOT A FILTER, and that is what keeps it clear of the evidence layer.** Nothing
 * is ever stripped from a returned string: a turn whose only output is one of these characters
 * is still captured BYTE-EXACT by passes 3–4 into `raw_response` (invariant 2) and then refused
 * by `requireAnswer`. So `src/canonical.ts`'s U+007F rule and `src/log.ts`'s lone-surrogate
 * uncleanliness rule are untouched — they govern how bytes are WRITTEN, this governs whether a
 * turn ANSWERED, and widening the second cannot rewrite what the first records. Do not reach
 * for this to normalize an answer's bytes.
 */
export function isBlank(s: string): boolean {
  return /^[\s\p{Cf}\p{Cc}\p{Cs}]*$/u.test(s);
}

/**
 * THE MESSAGE OF THIS TURN THAT PRODUCED THE ANSWER, and the answer it produced.
 *
 * Four passes over the turn — two GATES × two CHANNELS — in strict priority order, and the
 * priority is the whole design:
 *
 *   1. a message whose `text` parts join to something NON-BLANK
 *   2. …else one whose `reasoning` parts join to something NON-BLANK
 *   3. …else one whose `text` parts join to anything NON-EMPTY, returned verbatim
 *   4. …else one whose `reasoning` parts join to anything NON-EMPTY, returned verbatim
 *
 * Each pass walks the turn BACKWARDS, so a trailing assistant message that carries no answer
 * can't blank a real one. Nothing about a normal answer — its bytes, its `raw_response`, its
 * serving agent — is touched by the later passes' existence: pass 1 fires on every turn that
 * produced real text, and it fires on the same message it always did.
 *
 * **THE `reasoning` CHANNEL (issue #168).** opencode's `Part` union carries `ReasoningPart`
 * with its own `text` of identical type, and opencode's own TUI renders it. A turn whose
 * visible output arrived that way reconstructed to `""` here and was refused as `empty-answer`
 * — the guild path returning nothing where opencode directly returned a full answer, which is
 * exactly the contrast issue #168 reports. Reading it as the answer is a FALLBACK and never a
 * merge: a message carrying BOTH kinds returns its `text` alone, so chain-of-thought never
 * lands beside an answer the model also wrote.
 *
 * **THE GATE IS ON THE JOINED STRING, NOT ON PART PRESENCE, AND THAT IS LOAD-BEARING.**
 * Requiring merely that a text PART exist made an `{type:"text", text:""}` part satisfy pass 1
 * and block the fallback — and an empty text part is precisely how this repo's own fixture
 * models the reported turn (`tools-then-silent`). So the shape the fallback exists for — a turn
 * that emitted reasoning AND an empty text part — went on being refused, in all three
 * arrangements (same message, either message order).
 *
 * **WHY THE GATE IS SPLIT IN TWO (issue #185), and it is the same defect twice.** One gate of
 * `length > 0` accepted a trailing message carrying only whitespace — `"\n"`, `"  "` — and so
 * DISCARDED a real answer emitted earlier in the same turn, which `requireAnswer` then read as
 * blank and refused. One gate of `!isBlank(text)` would instead drop those bytes from
 * `raw_response` on a turn whose whole answer was blank, breaking invariant 2. That is a
 * false dichotomy between the GATE and the RETURNED VALUE: passes 1–2 decide **which message
 * answered** on a blank-insensitive test, passes 3–4 keep **the bytes** of a turn that produced
 * nothing else. A blank-only answer is still captured verbatim and still refused by
 * `requireAnswer`, which reads the SAME `isBlank`; nothing that used to be recorded is now
 * recorded as `""`.
 * **Do not collapse the two gates back into one** — either direction reopens one of the two.
 * That is about the TIER STRUCTURE and is untouched by the two gates sharing one definition of
 * blank (issue #195, folding in #204): see `isBlank` above.
 *
 * Nothing observable is given up by a pass falling through: every string a later pass can
 * return is one `requireAnswer` refuses, so a later pass can only turn a refusal into an
 * answer or a blank receipt into a byte-exact one — never change one answer into another.
 *
 * **The remaining cost is stated, not engineered around.** Where the reasoning channel fires,
 * `raw_response` — the byte-exact evidence record — holds reasoning text. That is what the
 * model emitted, and the receipt gains content only where it previously recorded `""`, never in
 * place of an answer. The turn this cannot tell apart is one TRUNCATED mid-reasoning: that used
 * to be refused and is now returned as an answer. Which channel the answer came from is
 * recorded rather than left implicit — see `AskResult.answerChannel`.
 *
 * TURN-SCOPED since issue #117's review — EVERY pass stops at `turnStartIndex`, so a turn that
 * said nothing on either channel yields nothing rather than the previous turn's answer.
 */
function answerSource(
  history: SessionHistory,
): { message: HistoryMessage; text: string; channel: AnswerChannel } | undefined {
  const start = turnStartIndex(history);
  // `false` = the answering gate (non-blank); `true` = the byte-preserving one (non-empty).
  for (const verbatim of [false, true] as const) {
    for (const channel of ["text", "reasoning"] as const) {
      for (let i = history.messages.length - 1; i >= start; i--) {
        const m = history.messages[i];
        if (m.role !== "assistant") continue;
        const text = joinPartText(m, channel);
        if (text.length === 0) continue;
        if (!verbatim && isBlank(text)) continue;
        return { message: m, text, channel };
      }
    }
  }
  return undefined;
}

/**
 * WHICH CHANNEL THIS TURN'S ANSWER CAME OFF (issue #168).
 *
 * `"text"` is the ordinary case and is never recorded — C29's optional-field discipline, so a
 * normal turn's result and receipt are byte-identical to what they were before the fallback
 * existed. `"reasoning"` means the model produced no text at all and this promoted its
 * reasoning; see `answerSource`.
 */
export type AnswerChannel = "text" | "reasoning";

/**
 * The final assistant text, reconstructed BYTE-EXACT from history (invariant 2).
 *
 * A turn that produced nothing on either channel yields `""`, which is then the caller's to
 * interpret — `requireAnswer` turns it into an `EmptyAnswerError`.
 */
export function finalAssistantText(history: SessionHistory): string {
  return answerSource(history)?.text ?? "";
}

/**
 * The channel `finalAssistantText`'s answer came off, `undefined` when it was the ordinary
 * `text` one or when the turn answered nothing (issue #168). Absent rather than `"text"` so
 * every consumer can write it out under C29's optional-field rule without a second condition.
 */
export function finalAssistantChannel(history: SessionHistory): AnswerChannel | undefined {
  const src = answerSource(history);
  return src !== undefined && src.channel !== "text" ? src.channel : undefined;
}

/**
 * The agent that actually SERVED the answer, read from the answer-producing assistant
 * message's `info.agent` (opencode 1.18.2 populates it — verified live: a `guild-read`
 * call reports `info.agent === "guild-read"`). Returns `undefined` when opencode does
 * not report an agent (older/other builds), so a caller can DISTINGUISH "served a
 * different agent" (a real mismatch to fail closed on) from "opencode didn't say" (which
 * must not be treated as a mismatch — the check is only as strong as the field's
 * presence, and inventing a mismatch on absence would break on a build that drops it).
 *
 * TURN-SCOPED for the same reason as `finalAssistantText`, and it matters just as much here:
 * unbounded, a round-2 continuation validated the agent against ROUND ONE's message, so a
 * silent fallback to a full-access agent on the new turn would have been checked against the
 * hardened agent that served the old one. A turn with no answer-bearing assistant message now
 * answers `undefined` — "opencode didn't say", the documented fail-open (issue #78) — rather
 * than an answer borrowed from a turn this check is not about.
 *
 * IT READS `answerSource`, THE SAME MESSAGE `finalAssistantText` RETURNED, and that coupling is
 * required rather than tidy (issue #168). The two used to duplicate one `type === "text"`
 * filter; when the reasoning fallback was added to the text extractor alone, a reasoning-only
 * turn's output was returned while this answered `undefined`, so the masquerade check went
 * blind on precisely the turns the fallback newly admits. One source, one message, one agent.
 */
export function servingAgent(history: SessionHistory): string | undefined {
  const agent = answerSource(history)?.message.info.agent;
  return typeof agent === "string" && agent.length > 0 ? agent : undefined;
}

/** Longest provider-error string quoted into a refusal. Untrusted third-party text on its way
 * into an error message a human reads: bounded, one line, no control characters. */
const PROVIDER_ERROR_MAX = 300;

/**
 * THE PROVIDER'S OWN DIAGNOSIS for this turn, when opencode carried one (issue #117 review).
 *
 * A turn that answers nothing is exactly the turn whose cause you cannot see: the activity
 * layer's `session error:` line is the usual channel and it is EMPTY under `GUILD_ACTIVITY=off`,
 * so the refusal used to send the reader to a place that could be blank. The history itself
 * carries the answer — a rejected turn's assistant message has `info.error` populated. Captured
 * live from opencode 1.18.7 on 2026-07-30:
 *
 *   {name:"APIError", data:{message:"You have exceeded your monthly quota", statusCode:402,
 *                           isRetryable:false, responseHeaders:{…}, responseBody:"…"}}
 *
 * Only `name`, `data.message` and `data.statusCode` are read. `data` also carries the full
 * response headers and body — routing those into an error string would put provider tokens and
 * quota telemetry somewhere nobody asked for them, so the extraction is a whitelist, not a
 * stringify. The result is truncated, flattened to one line and stripped of control characters:
 * it is third-party text, and this is a message a human reads.
 *
 * TURN-SCOPED like its neighbours, and searching the LAST assistant message of the turn first —
 * the error belongs to the message that failed. `undefined` when opencode reported nothing,
 * which is a normal outcome and never an inference that all was well.
 */
export function finalAssistantError(history: SessionHistory): string | undefined {
  const start = turnStartIndex(history);
  for (let i = history.messages.length - 1; i >= start; i--) {
    const m = history.messages[i];
    if (m.role !== "assistant") continue;
    const err = m.info.error;
    if (err === null || typeof err !== "object") continue;
    const e = err as Record<string, unknown>;
    const data = (typeof e.data === "object" && e.data !== null ? e.data : {}) as Record<
      string,
      unknown
    >;
    const name = typeof e.name === "string" && e.name.length > 0 ? e.name : undefined;
    const message =
      typeof data.message === "string" && data.message.length > 0
        ? data.message
        : typeof e.message === "string" && e.message.length > 0
          ? e.message
          : undefined;
    const status = typeof data.statusCode === "number" ? data.statusCode : undefined;
    if (name === undefined && message === undefined && status === undefined) continue;
    const head = name !== undefined && message !== undefined ? `${name}: ${message}` : (name ?? message ?? "");
    const withStatus = status !== undefined ? `${head}${head.length > 0 ? " " : ""}(HTTP ${status})` : head;
    // Control characters are stripped rather than escaped: this string is going into a
    // one-line error message, and a provider that returns a newline must not reshape it.
    const flat = withStatus.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
    if (flat.length === 0) continue;
    return flat.length > PROVIDER_ERROR_MAX ? `${flat.slice(0, PROVIDER_ERROR_MAX)}\u2026` : flat;
  }
  return undefined;
}

/**
 * THE PROVIDER'S COMPLETION METADATA for this turn (issue #168).
 *
 * A turn that answered nothing and a turn whose answer the provider truncated look IDENTICAL
 * from `raw_response` alone — both are the empty string, both hash to e3b0c442…. opencode
 * carries the distinguishing facts on the assistant message itself and this repo was throwing
 * them away: the OpenAPI document the running serve publishes (`GET /doc`, opencode 1.18.18)
 * declares `AssistantMessage` with `tokens` and `cost` REQUIRED and `finish` optional —
 * `tokens` being `{input, output, reasoning, cache:{read,write}, total?}`. Nothing here is
 * inferred from a provider's own API: these are opencode's own field names, read off the same
 * history envelope every other extractor in this file reads.
 *
 * `finish` is deliberately typed as an opaque `string`. opencode's schema does not constrain
 * it to an enum, so no vocabulary is asserted — a value is reported verbatim, and reading
 * meaning into a particular one is the human's job.
 */
export interface TurnTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
}

export interface TurnCompletion {
  /** opencode's `info.finish` verbatim; absent when opencode did not record one. */
  finish?: string;
  tokens?: TurnTokens;
  cost?: number;
}

/** The facts issue #168 asked for, travelling together: what the turn DID before it went
 * quiet, and what the provider said about the completion that ended it. */
export interface TurnDiagnostics {
  /** Turn-scoped — `turnToolCallCount`, never the session-wide walk. */
  toolCallCount: number;
  completion?: TurnCompletion;
  /**
   * PART TYPES the turn's assistant messages carried, counted (issue #168).
   *
   * Beyond the two the issue asked for, and here because it is the one column that separates
   * "the provider emitted nothing" from "the provider emitted something this extractor does
   * not read as an answer". opencode 1.18.18's `Part` union (probed at `GET /doc`) has twelve
   * members and the census names whichever ones showed up.
   *
   * **The specific gap it was written for is now CLOSED, and this survives the fix.**
   * `reasoning` — a `Part` carrying its own `text` of identical type — used to reconstruct to
   * `""` while opencode's own TUI rendered it as a full answer; `answerSource` now falls back
   * to it, so a reasoning-only turn is answered rather than refused. The census stays because
   * the class of failure is not specific to `reasoning`: a turn refused here while some OTHER
   * unread part type carried the output is the same defect wearing a different name, and this
   * is the column that would say so. Absent when the turn carried no assistant parts at all.
   */
  partTypes?: Record<string, number>;
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * The completion metadata of the assistant message THAT ENDED THIS TURN (issue #168).
 *
 * TURN-SCOPED like every other extractor here, and taking the turn's LAST assistant message
 * rather than its last TEXT-BEARING one — the two differ precisely in the case this exists
 * for. On an empty answer there is no text-bearing message at all, and the message that ended
 * the turn is the one carrying the provider's verdict (`finish: null` plus `info.error` on the
 * probed rejection shape). Reading `finalAssistantText`'s message would report nothing.
 *
 * Returns `undefined` when the turn's last assistant message carries none of the three fields
 * — "opencode did not say", never a fabricated zero. A zero token count is a real observation
 * and must stay distinguishable from an absent one.
 */
export function finalAssistantCompletion(history: SessionHistory): TurnCompletion | undefined {
  const start = turnStartIndex(history);
  for (let i = history.messages.length - 1; i >= start; i--) {
    const m = history.messages[i];
    if (m.role !== "assistant") continue;
    const finish = typeof m.info.finish === "string" && m.info.finish.length > 0 ? m.info.finish : undefined;
    const cost = numberOrUndefined(m.info.cost);
    const raw = (typeof m.info.tokens === "object" && m.info.tokens !== null ? m.info.tokens : {}) as Record<
      string,
      unknown
    >;
    const cache = (typeof raw.cache === "object" && raw.cache !== null ? raw.cache : {}) as Record<
      string,
      unknown
    >;
    const tokens: TurnTokens = {};
    const input = numberOrUndefined(raw.input);
    const output = numberOrUndefined(raw.output);
    const reasoning = numberOrUndefined(raw.reasoning);
    const total = numberOrUndefined(raw.total);
    const cacheRead = numberOrUndefined(cache.read);
    const cacheWrite = numberOrUndefined(cache.write);
    if (input !== undefined) tokens.input = input;
    if (output !== undefined) tokens.output = output;
    if (reasoning !== undefined) tokens.reasoning = reasoning;
    if (total !== undefined) tokens.total = total;
    if (cacheRead !== undefined) tokens.cacheRead = cacheRead;
    if (cacheWrite !== undefined) tokens.cacheWrite = cacheWrite;
    const hasTokens = Object.keys(tokens).length > 0;
    if (finish === undefined && cost === undefined && !hasTokens) return undefined;
    const out: TurnCompletion = {};
    if (finish !== undefined) out.finish = finish;
    if (hasTokens) out.tokens = tokens;
    if (cost !== undefined) out.cost = cost;
    return out;
  }
  return undefined;
}

/**
 * THE TURN'S ASSISTANT PART TYPES, counted (issue #168).
 *
 * TURN-SCOPED like its neighbours. Assistant messages only: a `user` message's parts are the
 * caller's own prompt and say nothing about what the model produced.
 *
 * The type is read verbatim off the wire and NOT validated against a known set — opencode's
 * `Part` union has twelve members on 1.18.18 and a bump may add more, and the whole value of
 * this field is naming a type the extractor did not expect. A non-string `type` is counted
 * under `"(unknown)"` rather than dropped, for the same reason.
 */
export function turnAssistantPartTypes(history: SessionHistory): Record<string, number> {
  const start = turnStartIndex(history);
  const out: Record<string, number> = {};
  for (let i = start; i < history.messages.length; i++) {
    const m = history.messages[i];
    if (m.role !== "assistant") continue;
    for (const p of m.parts) {
      const t = typeof p.type === "string" && p.type.length > 0 ? p.type : "(unknown)";
      out[t] = (out[t] ?? 0) + 1;
    }
  }
  return out;
}

/**
 * One line a human reads, rendered from `TurnDiagnostics` (issue #168).
 *
 * It is appended to the refusal MESSAGE as well as attached structurally, because the reporter
 * of #168 read the message and the structured record separately and neither carried either
 * fact. "Read five files then said nothing" and "said nothing at all" have to be one glance
 * apart, and a zero-token completion has to be distinguishable from a truncated one.
 *
 * An ABSENT number is never rendered as 0 — the whole point is that a real zero is evidence.
 */
export function describeTurnDiagnostics(d: TurnDiagnostics): string {
  const calls =
    d.toolCallCount === 0
      ? "the turn made NO tool calls"
      : `the turn made ${d.toolCallCount} tool call${d.toolCallCount === 1 ? "" : "s"} before it ended`;
  // Rendered last in both branches: it is the column that says WHERE the output went, and it
  // is only ever a hint — naming the part types, never interpreting them.
  const shape =
    d.partTypes === undefined || Object.keys(d.partTypes).length === 0
      ? ""
      : ` Parts this turn: ${Object.keys(d.partTypes)
          .sort()
          .map((k) => `${k}=${d.partTypes![k]}`)
          .join(" ")}.`;
  const c = d.completion;
  if (c === undefined) {
    return `Turn diagnostics: ${calls}; opencode recorded no completion metadata for it.${shape}`;
  }
  const bits: string[] = [];
  bits.push(c.finish !== undefined ? `finish=${JSON.stringify(c.finish)}` : "finish=(not recorded)");
  if (c.tokens !== undefined) {
    const t = c.tokens;
    const parts: string[] = [];
    if (t.input !== undefined) parts.push(`input=${t.input}`);
    if (t.output !== undefined) parts.push(`output=${t.output}`);
    if (t.reasoning !== undefined) parts.push(`reasoning=${t.reasoning}`);
    if (t.total !== undefined) parts.push(`total=${t.total}`);
    if (t.cacheRead !== undefined) parts.push(`cacheRead=${t.cacheRead}`);
    if (t.cacheWrite !== undefined) parts.push(`cacheWrite=${t.cacheWrite}`);
    if (parts.length > 0) bits.push(`tokens ${parts.join(" ")}`);
  }
  if (c.cost !== undefined) bits.push(`cost=${c.cost}`);
  return `Turn diagnostics: ${calls}; opencode recorded ${bits.join(", ")}.${shape}`;
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

/**
 * HOW MANY TOOL CALLS THIS TURN MADE (issue #121) — the signal that separates "the model did
 * nothing" from "the model did something the capture could not measure".
 *
 * TURN-SCOPED, like `finalAssistantText` and `finalAssistantError` and for the same reason. It
 * is deliberately NOT `toolParts(history).length`: that walk is unbounded and counts the WHOLE
 * session, so on a continuation an earlier turn's tool calls would make this turn look busy —
 * the exact shape of the BANANA defect issue #117's review found on the text extractor, and it
 * would fail OPEN here (a silent turn inheriting a previous turn's tool calls escapes the
 * refusal). `guild_delegate` mints a fresh session per call and takes no `sessionId`, so the two
 * are equal TODAY; the bound is what keeps them equal if that ever changes. Do not unbound it.
 *
 * Every tool part is counted whatever its `state.status` — a `pending`/`error` call still means
 * the model reached for a tool, which is all this needs to answer.
 *
 * This reads the HISTORY payload's `part.type === "tool"` shape, and doing so carries a stated
 * dependency on an opencode bump — recorded once, in CONTRACT.md C74, not restated here.
 */
export function turnToolCallCount(history: SessionHistory): number {
  const start = turnStartIndex(history);
  let n = 0;
  for (let i = start; i < history.messages.length; i++) {
    for (const p of history.messages[i].parts) if (p.type === "tool") n++;
  }
  return n;
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
 * A PRE-TURN CHECK RUN INSIDE THE SERVE LEASE (issue #111, review A3).
 *
 * Structurally identical to `ActivityAttachable`/`ApprovalAttachable` and kept separate for the
 * same reason: this module imports nothing from `src/agentfloor.ts` and stays the thin typed
 * transport it is. What makes it a distinct seam rather than a caller-side gate is *when* it
 * runs — inside the very `withServe` lease that will carry the session and the message, so the
 * child it inspects is provably the child that serves the turn.
 *
 * WHY THAT MATTERS, and it is the whole of A3. The tools also check BEFORE the policy/approval
 * gates, on a lease of their own, which is what keeps a refusal free of any evidence-log
 * footprint. Under `GUILD_SERVE_PER_CALL=1` that early lease is torn down when it is released,
 * so the turn then ran on a child that had never been checked — the verdict still transferred
 * in practice (same cwd, same files) but the design claims soundness *by construction*, and in
 * that mode it did not hold. On the shared long-lived child this second call is a cache hit and
 * costs nothing.
 *
 * It MUST NOT throw for a "cannot tell" outcome — only a positive "the agent is not hardened"
 * result may stop the turn, and everything else is the caller's problem to surface.
 */
export interface PreTurnAgentCheck {
  verify(handle: ServeHandle): Promise<{ ok: true } | { ok: false; message: string }>;
}

/**
 * Raised when the child that is about to serve the turn does NOT have the hardened agent's
 * default-deny floor in force (issue #111, review A3).
 *
 * Thrown from inside `askViaAgent`'s serve lease, BEFORE the session is created and before any
 * message is posted, so no model is ever called. It is a distinct class from
 * `AgentMismatchError` because it is a different failure: that one is "opencode served a
 * different agent than we asked for", this one is "the agent we asked for is not the hardened
 * thing its def describes".
 */
export class AgentFloorNotInForceError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "AgentFloorNotInForceError";
  }
}

/**
 * Raised when the turn completed and the model produced NO ANSWER (issue #117, C74).
 *
 * Opt-in per call (`AskViaAgentOpts.requireAnswer`): the READ paths set it, `guild_delegate`
 * does not — an empty report beside a real patch is a successful delegation, so the same
 * text means opposite things on the two paths.
 *
 * THAT IS STILL TRUE AND IS NOT THE WHOLE STORY SINCE ISSUE #121. The write path refuses the
 * NARROWER combination — an empty report AND a turn that made NO TOOL CALLS — as
 * `empty-delegation`, decided in `src/delegate.ts`. It stays read-path-only by construction:
 * this class throws before the after-snapshot, so opting `guild_delegate` in here would fail
 * the terse-but-productive delegation whose edits are already on disk. The write path's own
 * inputs (`toolCallCount`, `providerError`) ride out on the SUCCESS result instead.
 *
 * Thrown from INSIDE `askViaAgent`'s try, before `succeeded` is set, exactly like
 * `AgentMismatchError` — so the existing ownership × outcome deletion matrix tears a
 * session we created down rather than orphaning it, and no second cleanup path exists.
 *
 * `text` is the byte-exact final text as read from history (`""`, or blank per `isBlank` — see
 * that predicate for the alphabet). It is carried so the evidence layer can still record what
 * was actually produced: C25's byte-exact rule does not get a hole cut in it just because the
 * bytes turned out to be blank.
 *
 * `providerError` is the turn's own `info.error`, whitelisted and bounded by
 * `finalAssistantError`. When opencode carried one it is QUOTED, because the alternative the
 * first cut offered — "check the call's activity errors" — points at a channel that is empty
 * whenever `GUILD_ACTIVITY=off`, i.e. it could send the reader to a blank file. Absent, the
 * message stays useful by naming what to check instead of asserting a cause it does not have.
 */
export class EmptyAnswerError extends Error {
  constructor(
    readonly sessionId: string,
    readonly text: string,
    readonly providerError?: string,
    /**
     * WHAT THE TURN DID AND WHAT THE PROVIDER SAID (issue #168). Carried and rendered into the
     * message because the two states this refusal cannot otherwise tell apart — a model that
     * read five files and then said nothing, versus one that said nothing at all — reached the
     * reporter as the same sentence. Optional so the low-level client tests that construct
     * this class directly are unaffected; absent ⇒ the message is exactly what it was.
     */
    readonly diagnostics?: TurnDiagnostics,
  ) {
    super(
      "the model completed its turn and produced NO ANSWER (this turn's final assistant " +
        "text is empty, or holds nothing but whitespace, format, control or surrogate code " +
        "points) — refusing to return silence as an answer. " +
        (providerError !== undefined
          ? `The provider reported: ${providerError}`
          : "opencode reported no error for the turn, so the cause is not in the history — " +
            "check the model id (a provider can reject a configured id) and, if the activity " +
            "layer is on, the call's activity errors.") +
        (diagnostics !== undefined ? ` ${describeTurnDiagnostics(diagnostics)}` : ""),
    );
    this.name = "EmptyAnswerError";
  }
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
   * REQUIRE AN ANSWER (issue #117, C74). When set, a turn whose final assistant text is
   * BLANK per `isBlank` — empty, or nothing but whitespace/format/control/surrogate code
   * points — throws `EmptyAnswerError` instead of returning `text: ""`.
   * Left unset (the default, and `guild_delegate`'s deliberate choice — issue #121 did not
   * change it; the write path judges the same turn one layer up, after this spine returns, from
   * `toolCallCount` and `providerError`, which is the only place an empty report can be told
   * apart from an empty DELEGATION) the empty text is returned as before.
   */
  requireAnswer?: boolean;
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
  /**
   * Re-verify the hardened agent's floor INSIDE this lease, before any session work (issue
   * #111, review A3). Absent ⇒ nothing extra happens. See `PreTurnAgentCheck`.
   */
  preTurnCheck?: PreTurnAgentCheck;
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
  /**
   * THE TURN'S OWN `info.error`, whitelisted and bounded by `finalAssistantError` — present
   * only when opencode carried one for this turn.
   *
   * It rides on the SUCCESS result because of issue #121: `guild_delegate` does not set
   * `requireAnswer` (its answer is the patch), so a provider-rejected turn reaches it as a
   * NORMAL result with `text: ""` and never becomes an `EmptyAnswerError` whose `providerError`
   * it could read. Without this field the write path's own empty-delegation refusal would have
   * to say "opencode reported nothing" while the history held the provider's exact words.
   *
   * Computed unconditionally rather than only for a blank turn: a turn that produced text CAN
   * also carry an error (a partial failure), and a field whose presence depended on the text
   * being empty would be a second rule to remember. Nothing on the read paths reads it.
   */
  providerError?: string;
  /**
   * TOOL CALLS MADE BY THIS TURN (issue #121), turn-scoped — see `turnToolCallCount`.
   *
   * Distinct from `toolParts.length`, which is session-wide, and the difference is the point.
   * `guild_delegate` uses this to tell "produced nothing at all" from "did something the
   * capture could not measure": zero tool calls means the model cannot have edited a file or
   * run a command, whatever the capture's own representability state turned out to be.
   */
  toolCallCount: number;
  /**
   * COMPLETION METADATA OF THE TURN'S LAST ASSISTANT MESSAGE (issue #168), from HISTORY.
   *
   * Deliberately NOT a reuse of `metadata` below, which comes off the sync POST envelope: that
   * body is not a capture source (invariant 1), and on a `sessionId` continuation it describes
   * the message opencode chose to echo rather than the turn this call is judging. This is read
   * with the same turn bound as `text`, `providerError` and `toolCallCount`, so all four
   * describe one turn. Absent when opencode recorded none.
   */
  completion?: TurnCompletion;
  /** The turn's assistant part types, counted (issue #168) — see `TurnDiagnostics.partTypes`.
   * Absent when the turn carried no assistant parts. */
  partTypes?: Record<string, number>;
  /**
   * WHICH CHANNEL `text` CAME OFF (issue #168), present ONLY when it was not the ordinary one.
   *
   * `"reasoning"` says the model produced no text at all and `answerSource` promoted its
   * reasoning to be the answer. Recorded rather than left implicit because the promotion is
   * otherwise invisible: `raw_response` would render "the model's answer" and "the model's
   * chain-of-thought, promoted because there was no answer" identically, and the evidence log
   * exists so a claim can be checked. It also makes the fallback's one real cost — a turn
   * truncated mid-reasoning is now answered rather than refused — observable instead of
   * theoretical. Absent on every ordinary turn, so a normal result and receipt are
   * byte-identical to pre-#168 (C29's optional-field rule).
   */
  answerChannel?: AnswerChannel;
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
    // THE FLOOR RE-CHECK, INSIDE THIS LEASE (issue #111, review A3). First thing in the
    // callback: before the session exists, before any message, so a refusal calls no model.
    // `h` is by construction the handle this turn will use, which is the entire point — the
    // caller's earlier check ran on a lease that `GUILD_SERVE_PER_CALL=1` has since torn down.
    if (opts.preTurnCheck !== undefined) {
      const verdict = await opts.preTurnCheck.verify(h);
      if (!verdict.ok) throw new AgentFloorNotInForceError(verdict.message);
    }
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

      const text = finalAssistantText(history);
      // NO ANSWER ⇒ NOT A SUCCESS (issue #117, C74). Thrown here, beside the mismatch check
      // and for the same mechanical reason: `succeeded` is still false, so the deletion
      // matrix below cleans up a session we created instead of leaking it.
      //
      // BLANK, not `=== ""`: a turn that produced only a newline, a run of spaces or one
      // zero-width, control or lone-surrogate character has said nothing either, and treating
      // that as an answer would leave the exact hole this closes open to a one-character,
      // invisible difference.
      // The predicate is `isBlank` — THE SAME ONE `answerSource`'s passes 1–2 fall through on,
      // which is what makes its invariant ("every string a later pass can return is one
      // `requireAnswer` refuses") structural rather than a promise between two comments; do not
      // re-inline a test here (issues #195/#204). The byte-exact text still travels on the
      // error, so nothing is lost from the record.
      //
      // THIS CHECK IS ONLY AS GOOD AS `finalAssistantText`'S BOUND. Before that walk was
      // turn-scoped it reached back across turn boundaries, so on a `sessionId` continuation a
      // silent turn inherited the PREVIOUS turn's answer, the text was non-blank, and this
      // line never fired — the guard failed open on exactly the drivers that continue sessions
      // (`/guild:collaborate`, `/guild:workshop` round 2). Do not unbound that walk.
      const providerError = finalAssistantError(history);
      // Issue #168: all three are computed BEFORE the refusal, not after, because the refusal
      // is the one caller that most needs them. Same turn bound as the text — `toolCallCount`
      // reuses `turnToolCallCount` rather than introducing a second counter, so the BANANA
      // bound it carries is inherited, not re-derived.
      const toolCallCount = turnToolCallCount(history);
      const completion = finalAssistantCompletion(history);
      const partTypes = turnAssistantPartTypes(history);
      const hasPartTypes = Object.keys(partTypes).length > 0;
      // Issue #168: absent unless the answer was PROMOTED off a non-text channel, so an
      // ordinary result carries no new field at all (C29's optional-field rule).
      const answerChannel = finalAssistantChannel(history);
      if (opts.requireAnswer === true && isBlank(text)) {
        throw new EmptyAnswerError(sessionId, text, providerError, {
          toolCallCount,
          ...(completion !== undefined ? { completion } : {}),
          ...(hasPartTypes ? { partTypes } : {}),
        });
      }

      const result: AskResult = {
        text,
        sessionId,
        metadata,
        toolParts: toolParts(history),
        toolCallCount,
        ...(completion !== undefined ? { completion } : {}),
        ...(hasPartTypes ? { partTypes } : {}),
        ...(answerChannel !== undefined ? { answerChannel } : {}),
        history,
        // OPTIONAL-FIELD DISCIPLINE (C29's rule, applied to a wire-adjacent shape): written only
        // when opencode carried an error, so a normal turn's result is shaped exactly as it was
        // before issue #121.
        ...(providerError !== undefined ? { providerError } : {}),
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
      //
      // ISSUE #117 GAVE THAT LAST ROW A NEW WAY TO FIRE, and the shift is documented rather
      // than engineered around: a CONTINUED session with `keepSession:false` whose turn answers
      // nothing is now KEPT, where before #117 that turn succeeded with `text:""` and the
      // session was deleted as the documented final turn. The rule is unchanged and right — the
      // id belongs to the caller and an `empty-answer` is retryable — but the observable
      // behaviour did move, so say it: a continuation that fails this way leaves its session
      // alive on the serve child, for whoever owns the id to retry or drop.
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
