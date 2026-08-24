/**
 * Offline fixture for the M2 client tests: a minimal `node:http` server that
 * implements exactly the session endpoints the recipe uses, and RECORDS every
 * request body so a test can assert the exact wire shapes.
 *
 * It is deliberately adversarial about the history-vs-sync distinction: it can be
 * told to serve DIFFERENT text in the synchronous `POST .../message` response than
 * in the `GET .../message` history, so a client that (wrongly) read the sync body
 * would return the wrong string and the test would catch it.
 *
 * It also serves a SCRIPTED `GET /event` SSE stream (issue #20) so the live-activity
 * layer is testable entirely offline: `eventScript` is emitted to every attached client
 * when a turn is sent, and `emit()` pushes an arbitrary frame on demand. The frames are
 * raw opencode-shaped `{type, properties}` objects — the tests assert the NORMALIZER
 * against real observed shapes, not against a convenience shape of our own invention.
 *
 * No opencode, no model, no network beyond loopback — this is a pure protocol fake.
 */

import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

export interface FakeOpencodeOpts {
  /** The byte-exact final answer to serve in the GET history. */
  historyText: string;
  /** Text served in the SYNC POST response. When different from `historyText`,
   * proves the client reads history, not the sync body. Defaults to a fixed
   * wrong-marker so "the sync body must not be the source" is always exercised. */
  syncText?: string;
  /**
   * PER-TURN HISTORY SHAPES (issue #117 review), 1-based; a turn past the end of the array
   * reuses the LAST element, so `["rejected"]` means "every turn is rejected" and
   * `["text", "rejected"]` means "turn 1 answered, every later turn said nothing".
   *
   * The second form is the whole point. The history used to be turn-INDEPENDENT — one canned
   * block served for every session and every turn — which is exactly why the continuation test
   * passed while being structurally incapable of catching the cross-turn defect: the fixture
   * could not express "turn 1 answered, turn 2 said nothing" at all.
   *
   * The shapes:
   *  - `"text"` — the normal multi-message turn: a tool-call-only assistant message, then a
   *    text-bearing one carrying `historyText`. The backward walk exists for this shape.
   *  - `"rejected"` — REBUILT FROM A REAL CAPTURE (opencode 1.18.7, `GET /session/{id}/message`,
   *    2026-07-30). The first cut invented it as `step-start`/`step-finish` with `finish:"stop"`
   *    and no error — a plausible fiction, and this repo has been burned by exactly that before
   *    (the activity fixtures were written from the design's table and stayed green while
   *    production was broken). What a provider-rejected turn ACTUALLY contributes is ONE
   *    assistant message with **zero parts**, `finish: null`, and a populated **`info.error`**:
   *    `{name:"APIError", data:{message:"You have exceeded your monthly quota", statusCode:402,
   *    isRetryable:false, …}}`. `historyText: ""` is the neighbouring shape (a text part present
   *    and empty); both must reach the same outcome, so both are fixtured.
   *  - `"non-string-text"` — the final message's text part is present but its `text` is not a
   *    string. opencode's parts are wire data, so the product's type guard can legitimately
   *    reject one; when it does, the walk must stop at the turn boundary rather than reach back.
   *  - `"preamble-then-textless"` — a text-bearing assistant message followed by a second one
   *    that carries nothing and an `info.error`, both inside ONE turn. This is C74's stated
   *    BOUND, fixtured: the preamble IS this turn's text and is returned.
   */
  turnShapes?: TurnShape[];
  /**
   * PER-TURN ANSWER TEXT, 1-based, falling back to `historyText` for turns past the end. Only
   * needed where a test must prove WHICH turn the extracted text came from — with one shared
   * `historyText` a continuation's answer is indistinguishable from the previous turn's, which
   * is precisely the confusion the turn-scoping fix is about.
   */
  turnTexts?: string[];
  /**
   * The `info.error` a rejected turn carries. Defaults to the captured quota rejection above.
   * A test that asserts the provider's own words reach the refusal message sets its own.
   */
  rejectionError?: { name?: string; message?: string; statusCode?: number };
  /**
   * Serve an EMPTY final answer only for the request whose body model id
   * (`providerID/modelID`) equals this — the `failMessageForModel` shape for issue #117, so a
   * panel can have exactly ONE silent member while its siblings answer against the same fake.
   * That is the case the issue reports: a 3-model panel that came back with 2 answers.
   *
   * Keyed on the SESSION the turn was posted to (the history GET carries no model), so it
   * needs `distinctSessions` to tell members apart.
   */
  emptyAnswerForModel?: string;
  /**
   * ISSUE #168, the reported panel: serve the `tools-then-silent` shape only for the member
   * whose body model id equals this. Its sibling answers normally against the same fake, which
   * is what makes the per-member diagnostics assertion meaningful rather than trivial.
   */
  toolsThenSilentForModel?: string;
  /** Delay (ms) before the POST message response — used to trigger a timeout abort. */
  messageDelayMs?: number;
  /** Return 500 on the GET history (drive an error path with the session created). */
  failHistory?: boolean;
  /** Return 500 on the POST message. */
  failMessage?: boolean;
  /** Return 500 on the POST message ONLY when the request body's model id
   * (`providerID/modelID`) equals this — so a panel can fail exactly ONE member while its
   * siblings succeed against the same fake. */
  failMessageForModel?: string;
  /** Session id to hand back from POST /session. */
  sessionId?: string;
  /** Stamp `info.agent` on the served assistant messages (history). Used to prove the
   * post-call agent-mismatch check: set it to a DIFFERENT agent than requested to force a
   * mismatch, or to the SAME agent to prove the match case still passes. Unset ⇒ no agent
   * field (older-opencode behaviour; the check is then skipped). */
  servedAgent?: string;
  /**
   * Session-reuse mode (M7): when true, each POST /session returns a DISTINCT id
   * (`<sessionId>-1`, `<sessionId>-2`, …) instead of a constant, so a panel's per-member
   * `keepSessions` ids can be asserted distinct. The message/history/delete routes match
   * any id, so continuation (`GET`/`POST /session/<id>/message`) still works unchanged.
   */
  distinctSessions?: boolean;
  /**
   * SSE script (issue #20): raw `{type, properties}` frames pushed to every attached
   * `GET /event` client when a turn is POSTed, before the sync response is sent. The
   * default is no script (the stream attaches and stays silent). A FUNCTION receives the
   * session id the turn was sent to, so a panel fixture can script each member's own
   * session and prove the per-member summaries do not cross-contaminate.
   */
  eventScript?: unknown[] | ((sessionId: string) => unknown[]);
  /**
   * COMPLETION METADATA on every assistant `info` (issue #168). The default is the shape
   * opencode's own OpenAPI document declares for `AssistantMessage` — `cost` plus
   * `tokens: {input, output, reasoning, cache:{read,write}}` — and a test that sets this
   * proves the reported numbers are READ from the payload rather than constants baked into
   * the product. Set `assistantTokens: null` together with `omitCompletionMetadata` for the
   * "opencode recorded nothing" branch.
   */
  assistantTokens?: unknown;
  /** Serve assistant messages with NO `finish`, `tokens` or `cost` at all — an opencode that
   * recorded no completion metadata. The product must say so rather than invent zeroes. */
  omitCompletionMetadata?: boolean;
  /** Delay (ms) between scripted frames. Default 0 (emit them back to back). */
  eventDelayMs?: number;
  /** Refuse `GET /event` with a 500 — drives the `activity.degraded` path. */
  failEvents?: boolean;
  /** Accept `GET /event` and NEVER answer — a black hole. Drives the "attach must not hang
   * the call" guarantee: without a bounded wait this wedges the whole turn. */
  hangEvents?: boolean;
  /**
   * APPROVAL BRIDGE (issue #20 slice 4). When set, a turn does NOT answer immediately:
   * before the sync response the fake emits a `permission.asked` event for this tool and
   * BLOCKS — exactly as `opencode serve` does under an `ask` rule (probe P3: it waits
   * indefinitely for an HTTP reply, it does NOT auto-reject) — until a reply lands on one
   * of the two reply endpoints, or `gateTimeoutMs` elapses. That makes "the tool part
   * really is gated on the reply" a property the offline suite can assert, rather than a
   * behaviour we assume of the real server.
   */
  gateTool?: string;
  /** Metadata carried on the gated `permission.asked` (e.g. `{command: "rm -rf /"}`), so a
   * test can assert what the developer would actually have been shown. */
  gateMetadata?: Record<string, unknown>;
  /** Give up waiting for a reply after this long, so a wedged test cannot hang forever.
   * Default 5000ms. The PRODUCT has no such fallback — that is the point of P3. */
  gateTimeoutMs?: number;
  /**
   * RAISE THE GATED REQUEST WHILE THE SUBSCRIBER IS BLIND (issue #91). Before emitting
   * `permission.asked`, drop every attached `GET /event` client and wait until none is
   * attached — so the `permission.asked` frame is emitted to nobody, exactly as it is when a
   * real serve raises a request during a stream outage. The request is still registered and
   * the turn still BLOCKS on it, so the only way the turn can complete is if the bridge finds
   * it another way: `GET /permission` on re-attach.
   *
   * Deterministic on purpose: the alternative (the test racing a `dropEventClients()` against
   * the turn) would make a timing accident look like a passing recovery.
   */
  gateBlind?: boolean;
  /** Serve `GET /permission` with a 500 (or, with `listPermissionsGarbage`, with a body that
   * is not an array) — drives "a failed re-list DEGRADES, it does not throw into the call".
   * It ALSO drives issue #97's third shape: a 404 whose still-open check cannot be made, which
   * must be recorded as unconfirmed rather than classified as a race. */
  failListPermissions?: boolean;
  listPermissionsGarbage?: boolean;
  /**
   * THE APPROVE ENDPOINT IS GONE (issue #97). `POST /session/{id}/permissions/{permId}` answers
   * a refusal and leaves the request OPEN — the shape the deprecation of `permission.respond`
   * will eventually produce, byte-identical at the reply to a lost race and distinguishable
   * only by re-listing. Rejections (`POST /permission/{id}/reply`) keep working, so this
   * reproduces an APPROVAL-ONLY outage rather than a dead server.
   *
   * **The STATUS is parameterized on purpose** (review, 2026-07-29): a removed route need not
   * answer 404 — a path that still matches the method table gives 405, a retired endpoint 410,
   * a proxy or rewritten API 501 — and the product has to reach the same verdict for all of
   * them. `true` means 404; a number is sent verbatim.
   */
  approveEndpointGone?: boolean | number;
  /** The same for `POST /permission/{id}/reply` — the REJECT endpoint, which opencode does NOT
   * mark deprecated. It exists so the product's "the check is not restricted to the approve
   * path" claim is ASSERTED rather than merely written down: a refused reject that leaves the
   * request open blocks the model in exactly the same way. `true` means 404. */
  rejectEndpointGone?: boolean | number;
  /** Delay (ms) before the two reply endpoints answer — with the request left OPEN until they
   * do, exactly as a slow serve behaves. Drives the in-flight window a re-list must NOT read as
   * a dropped decision (review, 2026-07-29). */
  replyDelayMs?: number;
  /** Reject session-create when a `permission` ruleset is present, and echo NOTHING back —
   * models an opencode build that silently ignores the field, which must be caught rather
   * than run ungated. */
  ignoreSessionPermission?: boolean;
  /**
   * RESOLVED AGENTS (issue #111) — what `GET /agent` serves. Default: all three hardened defs
   * resolved WITH their default-deny floor, so every pre-existing suite behaves exactly as it
   * did before the resolved-agent check existed.
   *
   * Build the entries with `hardenedAgent()` / `voidedAgent()` so a test states which
   * RESOLUTION it is fixturing rather than hand-assembling rule arrays — the voided shape is
   * the probed one (opencode's built-ins alone, no `*:deny` anywhere), not an invention.
   */
  agents?: ResolvedAgentFixture[];
  /** Answer `GET /agent` with a non-2xx (`true` = 500, a number is sent verbatim) — the
   * "opencode cannot be asked" direction. */
  failAgentList?: boolean | number;
  /** Answer `GET /agent` 200 with a body that is not an array — an opencode whose shape moved. */
  agentListGarbage?: boolean;
  /**
   * Listen on a SPECIFIC port instead of an ephemeral one (issue #111, review C2).
   *
   * The only reason this exists: a loopback port is reusable, so a dead serve child's base URL
   * can be taken by a later one at a different root with a different agent def. Reproducing
   * that needs a second fake on the FIRST fake's port after it has closed — which two
   * concurrently-listening fakes can never model, and which is the shape that actually bites a
   * cache keyed on a URL.
   */
  port?: number;
}

/** The shape `GET /agent` serves per agent (loosely typed, like the real schema read). */
export interface ResolvedAgentFixture {
  name: string;
  mode?: unknown;
  description?: unknown;
  permission?: unknown;
}

/**
 * opencode's own built-in permission rules — a REAL CAPTURE from a live 1.18.7 `GET /agent`,
 * all **13** entries in order, taken from a serve rooted at a scratch project holding a VOIDED
 * `guild-read.md` (2026-07-30; the same 13 the probe recorded on 2026-07-29).
 *
 * The first cut of this array had **8** entries while the prose two paragraphs down said 13,
 * and still called itself a capture (review R6). It is a full capture now. Note where the
 * general catch-all sits: `"*": allow` is entry 0 and nothing later overrides it, which is
 * exactly why a def whose frontmatter opencode cannot parse runs with **no floor**.
 *
 * Two entries carry MACHINE-SPECIFIC absolute paths (this dev container's opencode data dir and
 * `/tmp`). They are reproduced verbatim rather than tidied, because the point of a capture is
 * that it is what was observed; nothing in the product reads them, and no assertion depends on
 * their values. The duplicated `external_directory` tool-output entry at the end is in the real
 * payload too — it is not a transcription slip.
 */
const OPENCODE_BUILTINS: Array<{ permission: string; pattern: string; action: string }> = [
  { permission: "*", pattern: "*", action: "allow" },
  { permission: "doom_loop", pattern: "*", action: "ask" },
  { permission: "external_directory", pattern: "*", action: "ask" },
  {
    permission: "external_directory",
    pattern: "/home/node/.local/share/opencode/tool-output/*",
    action: "allow",
  },
  { permission: "external_directory", pattern: "/tmp/opencode/*", action: "allow" },
  { permission: "question", pattern: "*", action: "deny" },
  { permission: "plan_enter", pattern: "*", action: "deny" },
  { permission: "plan_exit", pattern: "*", action: "deny" },
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "read", pattern: "*.env", action: "ask" },
  { permission: "read", pattern: "*.env.*", action: "ask" },
  { permission: "read", pattern: "*.env.example", action: "allow" },
  {
    permission: "external_directory",
    pattern: "/home/node/.local/share/opencode/tool-output/*",
    action: "allow",
  },
];

/**
 * A HARDENED resolution: the built-ins, then the def's `"*": deny` floor, then its allow-set —
 * the exact ordering a control def produced on the live probe.
 */
export function hardenedAgent(name: string, allow: string[]): ResolvedAgentFixture {
  return {
    name,
    mode: "all",
    description: `fixture ${name}`,
    permission: [
      ...OPENCODE_BUILTINS,
      { permission: "*", pattern: "*", action: "deny" },
      ...allow.map((t) => ({ permission: t, pattern: "*", action: "allow" })),
    ],
  };
}

/**
 * A VOIDED resolution — the def's frontmatter applied in NO part: the 13 built-ins alone, plus
 * `description: null` / `mode: "all"`, exactly as the live probe reported for a def carrying a
 * duplicate nested key or a tab-indented line. `mode` reading `all` here is deliberate: it is
 * opencode's own default, which is why `mode` cannot be used as the tell.
 */
export function voidedAgent(name: string): ResolvedAgentFixture {
  return { name, mode: "all", description: null, permission: [...OPENCODE_BUILTINS] };
}

/** The default `GET /agent` payload: every hardened def, resolved correctly. */
export function defaultResolvedAgents(): ResolvedAgentFixture[] {
  return [
    hardenedAgent("guild-read", ["read", "grep", "glob", "webfetch", "websearch"]),
    hardenedAgent("guild-research", ["read", "grep", "glob", "webfetch", "websearch"]),
    hardenedAgent("guild-build", ["read", "edit", "write", "patch", "bash"]),
    // opencode's own unrestricted agent is always listed too; it has no floor, and nothing
    // should ever consult it — its presence here is what keeps "find the named agent" honest.
    { name: "build", mode: "primary", permission: [...OPENCODE_BUILTINS] },
  ];
}

export interface FakeOpencode {
  baseUrl: string;
  /** Recorded request bodies / ids, in arrival order. */
  recorded: {
    createBodies: Array<Record<string, unknown>>;
    messageBodies: Array<Record<string, unknown>>;
    deletes: string[];
    historyGets: string[];
    /** How many times `GET /event` was subscribed — proves the ONE-bus-per-serve-child
     * refcounting, and proves `GUILD_ACTIVITY=off` opens no subscription at all. */
    eventSubscribes: number;
    /** How many times `GET /agent` was read (issue #111) — proves the resolved-agent check is
     * cached per serve child, so a 3-model panel asks ONCE, not three times. */
    agentGets: number;
  };
  /** Push one raw SSE frame to every attached client. */
  emit(event: unknown): void;
  /** Abruptly end every attached `GET /event` response — simulates a stream that attaches
   * and then drops mid-turn (serve restart, idle kill, network blip). */
  dropEventClients(): void;
  /** How many `GET /event` clients are attached right now. */
  attachedEventClients(): number;
  /** Every permission reply the fake received, in arrival order — the assertion surface for
   * "who answered, how, and with what message". */
  permissionReplies(): Array<{
    permissionId: string;
    via: "session" | "global";
    response: string;
    message?: string;
    sessionId?: string;
  }>;
  /** The permission ids currently awaiting a reply (a gated tool is blocking on each). */
  pendingPermissions(): string[];
  /**
   * Register an open permission request with NO turn blocked on it, so it appears in
   * `GET /permission` (issue #91). Used to plant a request belonging to ANOTHER session on
   * the same serve child, and to plant one this bridge has already answered. Emits no event:
   * these exist precisely to be found by a re-list, not seen on the stream.
   */
  addPendingPermission(req: {
    id: string;
    sessionID: string;
    permission?: string;
    metadata?: Record<string, unknown>;
  }): void;
  /**
   * Run `fn` at the START of the next and every `POST /session/{id}/message` — i.e. AT THE
   * TURN, which is where a real model's file edits happen (issue #111).
   *
   * It exists because the write-path fixtures used to model the model's edits by hooking
   * `ServeProvider.withServe`, and a tool may legitimately enter `withServe` more than once
   * per call — the resolved-agent check does, before the baseline snapshot. Mutating on every
   * ENTRY therefore applied the "model's" edits before the snapshot and the diff came out
   * empty: a fixture artifact, not a product defect, but one that would have been "fixed" by
   * moving the product's check after the snapshot, which is exactly where it must not go.
   * Hooking the message POST makes the fixture independent of how many control-plane calls a
   * tool makes. It fires BEFORE any failure/delay branch, so "even a failing turn leaves the
   * mutation on disk" (the partial-capture contract) still holds.
   */
  setOnMessage(fn: (() => void) | undefined): void;
  /**
   * Run `fn` at the START of the next and every `GET /agent` (issue #111 review R2).
   *
   * It exists to reproduce ONE probed behaviour of the real server: `GET /agent` alone
   * materializes opencode's plugin runtime into a serve cwd that contains `.opencode/`
   * (1.18.7, 2026-07-30). The resolved-agent gate issues exactly that request before the turn,
   * so without this hook no offline test could tell whether the scaffold tamper baseline is
   * captured before or after the gate — and "before" is the whole of the fix.
   */
  setOnAgentList(fn: (() => void) | undefined): void;
  /** For each gated turn, the reply the blocked tool actually observed — `"once"`,
   * `"reject"`, or the sentinel `"(never answered)"`. This is what proves the gate BLOCKED,
   * not merely that a reply was sent somewhere. */
  gateOutcomes(): string[];
  close(): Promise<void>;
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/**
 * THE HISTORY IS TURN-DEPENDENT (issue #117 review). It used to be a fixed three-message array
 * served for every session and every turn, which is why the continuation test could pass while
 * being structurally incapable of catching the cross-turn defect: the fake could not represent
 * "turn 1 answered, turn 2 said nothing" at all.
 *
 * One record per `POST /session/{id}/message`, keyed by session, in order. `GET .../message`
 * renders the whole list — user message + assistant message(s) per turn — so a continuation
 * really does read a payload containing an earlier turn's answer. A session with no recorded
 * turn still renders ONE default turn, so the low-level fixtures that call `fetchHistory`
 * without posting anything are unchanged.
 */
export type TurnShape =
  | "text"
  | "rejected"
  | "silent"
  | "non-string-text"
  | "preamble-then-textless"
  /**
   * ISSUE #168's REPORTED SHAPE: tool calls that all SUCCEEDED, then a final assistant message
   * whose text is empty and which carries NO `info.error`. Distinct from `silent` (which makes
   * no tool call) and from `rejected` (which also carries a provider error) — and the whole
   * point of #168 is that the product used to render all three identically.
   */
  | "tools-then-silent"
  /**
   * ISSUE #168's LEADING ROOT-CAUSE CANDIDATE, fixtured so it is testable rather than merely
   * argued. The turn's tool calls succeed and the final assistant message carries a
   * `reasoning` part with real text and NO `text` part. `finalAssistantText` reads
   * `type === "text"` only, so this reconstructs to `""` and is refused — while opencode's own
   * TUI, rendering reasoning, would show the user a full answer. `ReasoningPart` is a real
   * member of opencode 1.18.18's `Part` union carrying its own `text` (probed at `GET /doc`).
   */
  | "reasoning-only"
  /**
   * THE NO-MERGE CONTROL for the issue-#168 fallback: the final assistant message carries a
   * `reasoning` part AND a `text` part, in that order. The reasoning fallback must never fire
   * here — the text wins outright — so a turn that already worked keeps returning exactly what
   * it returned before, `raw_response` included. Without this shape "the fallback is a fallback"
   * would be an argument rather than an assertion.
   */
  | "reasoning-then-text"
  /**
   * THE SHAPE THE FIRST CUT OF THE #168 FIX DID NOT COVER, and it is `tools-then-silent` — this
   * repo's own model of the REPORTED turn — with a reasoning part beside it. The ending message
   * carries `{type:"text", text:""}` AND a `reasoning` part. A fallback gated on "does a text
   * PART exist" is satisfied by the empty one and never reaches the reasoning, so the turn goes
   * on being refused; the gate has to be on the joined STRING. The reporter's evidence
   * (`raw_response: ""`) is equally consistent with no text part and an empty one, so this
   * arrangement is no less likely to be what was hit than `reasoning-only` is.
   */
  | "reasoning-and-empty-text"
  /**
   * ISSUE #185: the turn answers, and then a LATER assistant message in the SAME turn carries
   * nothing but whitespace. #168's `length > 0` gate accepted that trailing message, so the
   * real answer was discarded and `requireAnswer` refused the turn — the same defect a trailing
   * EMPTY text message caused, in the shape one space character reaches. It has to be a
   * separate MESSAGE (not another part of the answering one) because that is what the backward
   * walk decides between.
   */
  | "text-then-whitespace";
interface TurnRecord {
  question: string;
  shape: TurnShape;
  text: string;
}

/** The first text part of a message POST body, so a rendered turn echoes what was asked. */
function firstTextPart(body: Record<string, unknown>): string | undefined {
  const parts = Array.isArray(body.parts) ? (body.parts as Array<Record<string, unknown>>) : [];
  for (const p of parts) {
    if (p.type === "text" && typeof p.text === "string") return p.text;
  }
  return undefined;
}

/** Which shape this turn serves. Decided at POST time: the model id and the turn number are
 * both only knowable there, and the history GET carries neither. */
function turnShapeFor(opts: FakeOpencodeOpts, modelId: string, turnNo: number): TurnShape {
  if (
    opts.toolsThenSilentForModel !== undefined &&
    modelId === opts.toolsThenSilentForModel
  ) {
    return "tools-then-silent";
  }
  if (opts.emptyAnswerForModel !== undefined && modelId === opts.emptyAnswerForModel) return "rejected";
  const shapes = opts.turnShapes;
  if (shapes === undefined || shapes.length === 0) return "text";
  return shapes[Math.min(turnNo, shapes.length) - 1];
}

/** This turn's answer text: `turnTexts[n-1]` when supplied, else `historyText`. */
function turnTextFor(opts: FakeOpencodeOpts, turnNo: number): string {
  const texts = opts.turnTexts;
  if (texts === undefined || texts.length === 0) return opts.historyText;
  return texts[Math.min(turnNo, texts.length) - 1];
}

/**
 * The `info.error` of a rejected turn, byte-shaped like the live capture (1.18.7, 2026-07-30).
 * `data` on the real payload also carries `responseHeaders`/`responseBody`; those are omitted
 * here on purpose — the product whitelists three fields, and a fixture that supplied the rest
 * would let a stringify-everything regression pass unnoticed.
 */
function rejectionError(opts: FakeOpencodeOpts): Record<string, unknown> {
  const e = opts.rejectionError ?? {};
  return {
    name: e.name ?? "APIError",
    data: {
      message: e.message ?? "You have exceeded your monthly quota",
      statusCode: e.statusCode ?? 402,
      isRetryable: false,
    },
  };
}

/** One turn → the messages opencode would have appended for it. */
function renderTurn(turn: TurnRecord, n: number, opts: FakeOpencodeOpts): unknown[] {
  // Optionally stamp info.agent on the assistant messages (agent-mismatch probe).
  const agentField = opts.servedAgent !== undefined ? { agent: opts.servedAgent } : {};
  // Issue #168: `omitCompletionMetadata` drops `cost`/`tokens` from the base AND `finish` from
  // whatever `extra` the shape supplies, so the "opencode recorded nothing" branch is reachable
  // without every shape growing a variant.
  const asst = (id: string, extra: Record<string, unknown>): Record<string, unknown> => {
    const base: Record<string, unknown> = {
      id,
      role: "assistant",
      ...agentField,
      providerID: "openai",
      modelID: "gpt-fake",
    };
    if (opts.omitCompletionMetadata === true) {
      const { finish: _dropped, ...rest } = extra;
      return { ...base, ...rest };
    }
    return {
      ...base,
      cost: 0.0042,
      tokens:
        "assistantTokens" in opts
          ? opts.assistantTokens
          : { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      ...extra,
    };
  };
  const user = {
    info: { id: `msg_user_${n}`, role: "user", time: { created: n } },
    parts: [{ id: `t${n}p0`, type: "text", text: turn.question }],
  };
  // A REJECTED turn contributes ONE assistant message with zero parts, `finish: null` and a
  // populated `info.error` — the captured shape, not an invented step-start/step-finish pair.
  // No tool message either: the turn never got far enough to call anything.
  if (turn.shape === "rejected") {
    return [
      user,
      { info: asst(`msg_asst_${n}`, { finish: null, error: rejectionError(opts) }), parts: [] },
    ];
  }
  // A SILENT turn (issue #121): zero parts and zero tool calls like `rejected`, but NO
  // `info.error` — the model simply said nothing and opencode reported no reason. It exists to
  // fixture the branch of `guild_delegate`'s empty-delegation message that fires when there is
  // no provider error to quote, which `rejected` can never reach because it always carries one.
  if (turn.shape === "silent") {
    return [user, { info: asst(`msg_asst_${n}`, { finish: "stop" }), parts: [] }];
  }
  // Every other shape keeps the MULTI-MESSAGE turn the backward walk exists for: a tool-call
  // assistant message with no text, then the text-bearing one.
  const toolMsg = {
    info: asst(`msg_asst_tool_${n}`, { finish: "tool-calls" }),
    parts: [
      { id: `t${n}p1`, type: "step-start" },
      {
        id: `t${n}p2`,
        type: "tool",
        callID: `call_${n}`,
        tool: "read",
        state: {
          status: "completed",
          input: { filePath: "/x/marker.txt" },
          output: "MARKER-FILE-CONTENTS",
        },
      },
      { id: `t${n}p3`, type: "step-finish" },
    ],
  };
  // ISSUE #168's LEADING CANDIDATE: output arrived, as `reasoning`, and the extractor reads
  // only `text` — so the receipts say "empty" while the model demonstrably produced tokens.
  if (turn.shape === "reasoning-only") {
    return [
      user,
      toolMsg,
      {
        info: asst(`msg_asst_final_${n}`, { finish: "stop" }),
        parts: [
          { id: `t${n}p4`, type: "step-start" },
          { id: `t${n}p5`, type: "reasoning", text: turn.text },
          { id: `t${n}p6`, type: "step-finish" },
        ],
      },
    ];
  }
  // REASONING BESIDE AN EMPTY TEXT PART (issue #168): the reported shape plus reasoning. The
  // empty text part is deliberately LAST, so a fallback that stops at the first text part it
  // sees is not accidentally rescued by ordering.
  if (turn.shape === "reasoning-and-empty-text") {
    return [
      user,
      toolMsg,
      {
        info: asst(`msg_asst_final_${n}`, { finish: "stop" }),
        parts: [
          { id: `t${n}p4`, type: "step-start" },
          { id: `t${n}p5`, type: "reasoning", text: turn.text },
          { id: `t${n}p6`, type: "text", text: "" },
          { id: `t${n}p7`, type: "step-finish" },
        ],
      },
    ];
  }
  // THE NO-MERGE CONTROL (issue #168): reasoning AND text in the one ending message. The
  // reasoning part is FIRST, which is the order that would expose a merge as a prefix.
  if (turn.shape === "reasoning-then-text") {
    return [
      user,
      toolMsg,
      {
        info: asst(`msg_asst_final_${n}`, { finish: "stop" }),
        parts: [
          { id: `t${n}p4`, type: "step-start" },
          { id: `t${n}p5`, type: "reasoning", text: "CHAIN-OF-THOUGHT-THAT-MUST-NOT-APPEAR" },
          { id: `t${n}p6`, type: "text", text: turn.text },
          { id: `t${n}p7`, type: "step-finish" },
        ],
      },
    ];
  }
  // ISSUE #168's REPORTED SHAPE: the tool calls landed and succeeded, and the message that
  // ended the turn carries an empty text part with NO `info.error`. `finish` is a normal
  // completion — which is exactly why the refusal could not tell this from a model that never
  // reached for anything.
  if (turn.shape === "tools-then-silent") {
    return [
      user,
      toolMsg,
      {
        info: asst(`msg_asst_final_${n}`, { finish: "stop" }),
        parts: [
          { id: `t${n}p4`, type: "step-start" },
          { id: `t${n}p5`, type: "text", text: "" },
          { id: `t${n}p6`, type: "step-finish" },
        ],
      },
    ];
  }
  // ISSUE #185: a real answer, then a trailing whitespace-only assistant message.
  if (turn.shape === "text-then-whitespace") {
    return [
      user,
      toolMsg,
      {
        info: asst(`msg_asst_final_${n}`, { finish: "stop" }),
        parts: [
          { id: `t${n}p4`, type: "step-start" },
          { id: `t${n}p5`, type: "text", text: turn.text },
          { id: `t${n}p6`, type: "step-finish" },
        ],
      },
      {
        info: asst(`msg_asst_trailing_${n}`, { finish: "stop" }),
        parts: [{ id: `t${n}p7`, type: "text", text: "\n  " }],
      },
    ];
  }
  if (turn.shape === "preamble-then-textless") {
    return [
      user,
      toolMsg,
      {
        info: asst(`msg_asst_pre_${n}`, { finish: "stop" }),
        parts: [{ id: `t${n}p4`, type: "text", text: turn.text }],
      },
      { info: asst(`msg_asst_${n}`, { finish: null, error: rejectionError(opts) }), parts: [] },
    ];
  }
  // A text part whose `text` is not a string: present, and correctly rejected by the type
  // guard — so this turn reconstructs to "" without any part being missing.
  const textPart =
    turn.shape === "non-string-text"
      ? { id: `t${n}p5`, type: "text", text: 42 }
      : { id: `t${n}p5`, type: "text", text: turn.text };
  return [
    user,
    toolMsg,
    {
      info: asst(`msg_asst_final_${n}`, { finish: "stop" }),
      // The REAL final answer, byte-exact. May contain newlines/quotes/unicode.
      parts: [
        { id: `t${n}p4`, type: "step-start" },
        textPart,
        { id: `t${n}p6`, type: "step-finish" },
      ],
    },
  ];
}

export function startFakeOpencode(opts: FakeOpencodeOpts): Promise<FakeOpencode> {
  const sessionId = opts.sessionId ?? "ses_fake";
  const syncText = opts.syncText ?? "SYNC-BODY-TEXT-THAT-MUST-NOT-BE-RETURNED";
  const recorded: FakeOpencode["recorded"] = {
    createBodies: [],
    messageBodies: [],
    deletes: [],
    historyGets: [],
    eventSubscribes: 0,
    agentGets: 0,
  };

  let createCount = 0;
  let permCount = 0;
  /** Fired at the start of every message POST — see `FakeOpencode.setOnMessage`. */
  let onMessage: (() => void) | undefined;
  /** Fired at the start of every `GET /agent` — see `FakeOpencode.setOnAgentList`. */
  let onAgentList: (() => void) | undefined;
  const eventClients = new Set<import("node:http").ServerResponse>();
  /** Permission requests awaiting a reply, keyed by id → the resolver that unblocks the
   * gated tool. This is the fake's whole model of probe P3: an `ask` blocks the turn. */
  const pendingPerms = new Map<string, (reply: string) => void>();
  /** This session's turns, in order — see `TurnRecord`. */
  const turns = new Map<string, TurnRecord[]>();
  /**
   * The REQUEST RECORD for each open id, so `GET /permission` can serve it (issue #91).
   *
   * The shape is the one captured from a live opencode 1.18.7 (`{id, sessionID, permission,
   * patterns, metadata, always, tool}`) — and it is the SAME object the fake emits as the
   * `permission.asked` frame's `properties`, because on the real server those two payloads
   * are field-for-field identical. Serving a different shape here would let the product's
   * re-list path pass against a fixture the real endpoint would not satisfy.
   */
  const permRequests = new Map<string, Record<string, unknown>>();
  const replies: Array<{
    permissionId: string;
    via: "session" | "global";
    response: string;
    message?: string;
    sessionId?: string;
  }> = [];
  /** permission id → the session its request belongs to (the global reply endpoint carries
   * no session, but the `permission.replied` event does). */
  const permSessions = new Map<string, string>();
  /** Stored per-session rulesets, so `GET /session/{id}` can echo them like the real one. */
  const sessionPermissions = new Map<string, unknown>();
  /** What each gated turn's blocked tool ultimately observed. */
  const gateOutcomes: string[] = [];
  const emit = (event: unknown): void => {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of eventClients) {
      try {
        res.write(frame);
      } catch {
        /* a closed client is dropped on its own 'close' handler */
      }
    }
  };

  const server: Server = createServer(async (req, res) => {
    const url = req.url ?? "";
    const method = req.method ?? "GET";
    const send = (status: number, obj: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    try {
      // GET /event — the SSE stream the activity layer subscribes to.
      if (method === "GET" && (url === "/event" || url.startsWith("/event?"))) {
        recorded.eventSubscribes += 1;
        if (opts.failEvents) {
          send(500, { error: "forced event-stream failure" });
          return;
        }
        if (opts.hangEvents) {
          // Headers never sent, connection never closed: the fetch stays pending forever.
          req.on("close", () => {});
          return;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        // A first frame flushes the headers and proves attachment; it normalizes to
        // nothing, so it can never pollute what a test asserts.
        res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
        eventClients.add(res);
        req.on("close", () => eventClients.delete(res));
        return;
      }

      // GET /agent — the RESOLVED agents (issue #111). This is the endpoint the floor check
      // reads: the def SOURCE is irrelevant to it, so a suite fixtures the RESOLUTION here.
      if (method === "GET" && (url === "/agent" || url.startsWith("/agent?"))) {
        recorded.agentGets += 1;
        // The real 1.18.7 behaviour this stands in for: reading the agent list loads the
        // project's plugin runtime, which writes `.opencode/node_modules` + manifests.
        if (onAgentList !== undefined) onAgentList();
        if (opts.failAgentList) {
          const status = typeof opts.failAgentList === "number" ? opts.failAgentList : 500;
          send(status, { error: "forced agent-list failure" });
          return;
        }
        if (opts.agentListGarbage) {
          send(200, { not: "an array" });
          return;
        }
        send(200, opts.agents ?? defaultResolvedAgents());
        return;
      }

      // GET /permission — every request still awaiting a reply, ACROSS ALL SESSIONS, exactly
      // as the real endpoint documents itself ("Get all pending permission requests across all
      // sessions", probed on 1.18.7). The fake serves other sessions' requests too, on purpose:
      // it is what makes the bridge's session filter testable rather than assumed.
      if (method === "GET" && (url === "/permission" || url.startsWith("/permission?"))) {
        if (opts.failListPermissions) {
          send(500, { error: "forced permission-list failure" });
          return;
        }
        if (opts.listPermissionsGarbage) {
          send(200, { not: "an array" });
          return;
        }
        send(200, [...pendingPerms.keys()].map((id) => permRequests.get(id) ?? { id }));
        return;
      }

      // POST /session
      if (method === "POST" && url === "/session") {
        const createBody = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
        recorded.createBodies.push(createBody);
        createCount += 1;
        const id = opts.distinctSessions ? `${sessionId}-${createCount}` : sessionId;
        const created: Record<string, unknown> = { id, title: "fake", time: { created: Date.now() } };
        // Real opencode 1.18.7 ECHOES the stored ruleset back on create (verified against a
        // live serve). That echo is the only proof the ruleset took, so the fake reproduces
        // it — and `ignoreSessionPermission` reproduces a build that does NOT.
        if (createBody.permission !== undefined && !opts.ignoreSessionPermission) {
          created.permission = createBody.permission;
          sessionPermissions.set(id, createBody.permission);
        }
        send(200, created);
        return;
      }

      // GET /session/{id} — the session record, including its stored ruleset.
      const getSessionMatch = url.match(/^\/session\/([^/]+)$/);
      if (method === "GET" && getSessionMatch) {
        const id = getSessionMatch[1];
        const rec: Record<string, unknown> = { id, title: "fake" };
        const perm = sessionPermissions.get(id);
        if (perm !== undefined) rec.permission = perm;
        send(200, rec);
        return;
      }

      // POST /session/{id}/permissions/{permId}  — the session-scoped reply (approve path).
      const sessPermMatch = url.match(/^\/session\/([^/]+)\/permissions\/([^/]+)$/);
      if (method === "POST" && sessPermMatch) {
        const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
        const permId = sessPermMatch[2];
        // A SLOW reply, with the request left OPEN while it is in flight — the real shape of a
        // wedged serve, and the window a concurrent re-list must not read as a dropped decision.
        if (opts.replyDelayMs) await new Promise((r) => setTimeout(r, opts.replyDelayMs));
        if (opts.approveEndpointGone) {
          // The endpoint no longer exists — and, the whole point, the request is NOT settled,
          // so `GET /permission` still lists it. Indistinguishable from a lost race at the
          // reply; distinguishable only by asking what is still open (issue #97). The status is
          // whatever the caller asked for, defaulting to 404.
          const status =
            typeof opts.approveEndpointGone === "number" ? opts.approveEndpointGone : 404;
          send(status, { error: "no longer available" });
          return;
        }
        const resolve = pendingPerms.get(permId);
        if (resolve === undefined) {
          // Verified against opencode 1.18.7: an unknown/already-settled id is a 404. That is
          // what makes "first reply wins, opencode is the arbiter" observable.
          send(404, { error: `no pending permission ${permId}` });
          return;
        }
        const response = String(body.response ?? "");
        replies.push({ permissionId: permId, via: "session", response, sessionId: sessPermMatch[1] });
        pendingPerms.delete(permId);
        resolve(response);
        emit({
          type: "permission.replied",
          properties: { sessionID: sessPermMatch[1], requestID: permId, reply: response },
        });
        send(200, {});
        return;
      }

      // POST /permission/{id}/reply — the global reply, the only one carrying a MESSAGE
      // (which reaches the model verbatim; the bridge uses it for rejects).
      const globalPermMatch = url.match(/^\/permission\/([^/]+)\/reply$/);
      if (method === "POST" && globalPermMatch) {
        const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
        const permId = globalPermMatch[1];
        if (opts.replyDelayMs) await new Promise((r) => setTimeout(r, opts.replyDelayMs));
        if (opts.rejectEndpointGone) {
          // Same shape as `approveEndpointGone`, on the endpoint opencode does NOT deprecate —
          // so "the check is not restricted to the approve path" is asserted, not assumed.
          const status =
            typeof opts.rejectEndpointGone === "number" ? opts.rejectEndpointGone : 404;
          send(status, { error: "no longer available" });
          return;
        }
        const resolve = pendingPerms.get(permId);
        if (resolve === undefined) {
          send(404, { error: `no pending permission ${permId}` });
          return;
        }
        const response = String(body.reply ?? "");
        const entry: {
          permissionId: string;
          via: "session" | "global";
          response: string;
          message?: string;
        } = { permissionId: permId, via: "global", response };
        if (typeof body.message === "string") entry.message = body.message;
        replies.push(entry);
        pendingPerms.delete(permId);
        resolve(response);
        emit({
          type: "permission.replied",
          properties: { sessionID: permSessions.get(permId) ?? "", requestID: permId, reply: response },
        });
        send(200, {});
        return;
      }

      // POST /session/{id}/message
      const msgMatch = url.match(/^\/session\/([^/]+)\/message$/);
      if (method === "POST" && msgMatch) {
        const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
        recorded.messageBodies.push(body);
        // THE TURN ITSELF. Anything modelling what the model DOES (file edits on the write
        // path) runs here, before every failure/delay branch below.
        if (onMessage !== undefined) onMessage();
        // Play the scripted activity BEFORE answering, exactly as a real turn does: the
        // events stream while the message POST is still blocking.
        const script =
          typeof opts.eventScript === "function"
            ? opts.eventScript(msgMatch[1])
            : (opts.eventScript ?? []);
        for (const ev of script) {
          emit(ev);
          if (opts.eventDelayMs) await new Promise((r) => setTimeout(r, opts.eventDelayMs));
        }
        // GATED TOOL (issue #20 slice 4): emit `permission.asked` and BLOCK the turn until
        // somebody replies — the behaviour probe P3 found in `opencode serve`. Without this,
        // an offline test could only assert that a reply was POSTed, never that the tool
        // actually waited for it.
        if (opts.gateTool) {
          const turnSession = msgMatch[1];
          permCount += 1;
          const permId = `per_fake${permCount}`;
          permSessions.set(permId, turnSession);
          const waited = new Promise<string>((resolve) => {
            pendingPerms.set(permId, resolve);
            const t = setTimeout(() => {
              if (pendingPerms.delete(permId)) resolve("(never answered)");
            }, opts.gateTimeoutMs ?? 5_000);
            if (typeof t.unref === "function") t.unref();
          });
          const request: Record<string, unknown> = {
            id: permId,
            sessionID: turnSession,
            permission: opts.gateTool,
            patterns: ["*"],
            metadata: opts.gateMetadata ?? {},
            always: [],
            tool: { messageID: "msg_asst", callID: "call_gated" },
          };
          permRequests.set(permId, request);
          // BLIND MODE (issue #91): make sure nobody is listening before raising it, so the
          // frame below is emitted into the void exactly as it is during a real outage. The
          // request is still open and the turn still blocks — the only route to it is the
          // re-list.
          if (opts.gateBlind) {
            for (const res of eventClients) {
              try {
                res.destroy();
              } catch {
                /* best-effort */
              }
            }
            eventClients.clear();
          }
          // The frame's `properties` IS the request record — identical payloads on a real
          // serve, so a fixture must not let them diverge.
          emit({ type: "permission.asked", properties: request });
          const outcome = await waited;
          permRequests.delete(permId);
          gateOutcomes.push(outcome);
        }
        // Yield once so the client's stream reader drains before the POST resolves.
        await new Promise((r) => setTimeout(r, 10));
        if (opts.messageDelayMs) await new Promise((r) => setTimeout(r, opts.messageDelayMs));
        // RECORD THE TURN (issue #117 review) so the history GET can render this session's
        // whole exchange rather than one canned turn. Shape is decided here, at post time,
        // because that is when the model id and the turn number are both known.
        {
          const list = turns.get(msgMatch[1]) ?? [];
          const model = (body.model ?? {}) as Record<string, unknown>;
          const modelId = `${model.providerID ?? ""}/${model.modelID ?? ""}`;
          const turnNo = list.length + 1;
          list.push({
            question: firstTextPart(body) ?? "the question",
            shape: turnShapeFor(opts, modelId, turnNo),
            text: turnTextFor(opts, turnNo),
          });
          turns.set(msgMatch[1], list);
        }
        // Per-model failure: 500 only for the targeted model (siblings still succeed).
        if (opts.failMessageForModel) {
          const m = (body.model ?? {}) as Record<string, unknown>;
          const id = `${m.providerID ?? ""}/${m.modelID ?? ""}`;
          if (id === opts.failMessageForModel) {
            send(500, { error: `forced message failure for ${id}` });
            return;
          }
        }
        if (opts.failMessage) {
          send(500, { error: "forced message failure" });
          return;
        }
        // The SYNC envelope: only the final assistant message, NO tool parts, and
        // deliberately the WRONG text. Metadata is real so `SendResult` populates.
        send(200, {
          info: {
            id: "msg_asst",
            role: "assistant",
            providerID: "openai",
            modelID: "gpt-fake",
            cost: 0.0042,
            tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: "stop",
          },
          parts: [{ type: "text", text: syncText }],
        });
        return;
      }

      // GET /session/{id}/message  → the full history (the sanctioned source)
      //
      // TURN-DEPENDENT since issue #117's review: rendered from this session's recorded turns
      // rather than from one canned block, so a continuation reads a payload that genuinely
      // contains the earlier turn's answer AND the new turn's silence.
      if (method === "GET" && msgMatch) {
        recorded.historyGets.push(msgMatch[1]);
        if (opts.failHistory) {
          send(500, { error: "forced history failure" });
          return;
        }
        const recordedTurns = turns.get(msgMatch[1]);
        // A session nobody posted to still renders ONE turn — the shape every pre-#117
        // fixture that calls `fetchHistory` directly has always seen.
        const list: TurnRecord[] =
          recordedTurns !== undefined && recordedTurns.length > 0
            ? recordedTurns
            : [{ question: "the question", shape: turnShapeFor(opts, "", 1), text: turnTextFor(opts, 1) }];
        const messages: unknown[] = [];
        list.forEach((turn, i) => {
          messages.push(...renderTurn(turn, i + 1, opts));
        });
        send(200, messages);
        return;
      }

      // DELETE /session/{id}
      const delMatch = url.match(/^\/session\/([^/]+)$/);
      if (method === "DELETE" && delMatch) {
        recorded.deletes.push(delMatch[1]);
        send(200, {});
        return;
      }

      send(404, { error: `no route for ${method} ${url}` });
    } catch (err) {
      send(500, { error: (err as Error).message });
    }
  });

  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        recorded,
        emit,
        dropEventClients: () => {
          for (const res of eventClients) {
            try {
              res.destroy();
            } catch {
              /* best-effort */
            }
          }
          eventClients.clear();
        },
        attachedEventClients: () => eventClients.size,
        setOnMessage: (fn) => {
          onMessage = fn;
        },
        setOnAgentList: (fn) => {
          onAgentList = fn;
        },
        permissionReplies: () => [...replies],
        pendingPermissions: () => [...pendingPerms.keys()],
        addPendingPermission: (req) => {
          permSessions.set(req.id, req.sessionID);
          permRequests.set(req.id, {
            id: req.id,
            sessionID: req.sessionID,
            permission: req.permission ?? "bash",
            patterns: ["*"],
            metadata: req.metadata ?? {},
            always: [],
          });
          // No turn is blocked on it, so the resolver is a no-op — but it must still be in
          // `pendingPerms`, because that is the map `GET /permission` and the reply endpoints
          // both read: an open request must be listable AND repliable.
          pendingPerms.set(req.id, () => {});
        },
        gateOutcomes: () => [...gateOutcomes],
        close: () =>
          new Promise<void>((r) => {
            // An attached SSE response keeps the server alive; end them first.
            for (const res of eventClients) {
              try {
                res.end();
              } catch {
                /* best-effort */
              }
            }
            eventClients.clear();
            server.close(() => r());
          }),
      });
    });
  });
}
