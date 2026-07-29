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
 * opencode's own built-in permission rules, as captured from a live 1.18.7 `GET /agent`
 * (2026-07-29). They are what a VOIDED def resolves to on its own — note the array ENDS with
 * a general `"*": allow`, which is precisely why a def whose frontmatter opencode cannot parse
 * runs with no floor.
 */
const OPENCODE_BUILTINS: Array<{ permission: string; pattern: string; action: string }> = [
  { permission: "*", pattern: "*", action: "allow" },
  { permission: "doom_loop", pattern: "*", action: "ask" },
  { permission: "external_directory", pattern: "*", action: "ask" },
  { permission: "question", pattern: "*", action: "deny" },
  { permission: "plan_enter", pattern: "*", action: "deny" },
  { permission: "plan_exit", pattern: "*", action: "deny" },
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "read", pattern: "*.env", action: "ask" },
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
 * A VOIDED resolution — the def's frontmatter applied in NO part. The built-ins alone, and
 * `description: null` / `mode: "all"`, exactly as the live probe reported for a def carrying a
 * duplicate nested key or a tab-indented line. `mode` reading `all` here is deliberate: it is
 * opencode's default, which is why `mode` cannot be used as the tell.
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
  const eventClients = new Set<import("node:http").ServerResponse>();
  /** Permission requests awaiting a reply, keyed by id → the resolver that unblocks the
   * gated tool. This is the fake's whole model of probe P3: an `ask` blocks the turn. */
  const pendingPerms = new Map<string, (reply: string) => void>();
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
      if (method === "GET" && msgMatch) {
        recorded.historyGets.push(msgMatch[1]);
        if (opts.failHistory) {
          send(500, { error: "forced history failure" });
          return;
        }
        // Optionally stamp info.agent on the assistant messages (agent-mismatch probe).
        const agentField = opts.servedAgent !== undefined ? { agent: opts.servedAgent } : {};
        send(200, [
          {
            info: { id: "msg_user", role: "user", time: { created: 1 } },
            parts: [{ id: "p0", type: "text", text: "the question" }],
          },
          {
            info: {
              id: "msg_asst_tool",
              role: "assistant",
              ...agentField,
              providerID: "openai",
              modelID: "gpt-fake",
              cost: 0.0042,
              tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
              finish: "tool-calls",
            },
            parts: [
              { id: "p1", type: "step-start" },
              {
                id: "p2",
                type: "tool",
                callID: "call_1",
                tool: "read",
                state: {
                  status: "completed",
                  input: { filePath: "/x/marker.txt" },
                  output: "MARKER-FILE-CONTENTS",
                },
              },
              { id: "p3", type: "step-finish" },
            ],
          },
          {
            info: {
              id: "msg_asst_final",
              role: "assistant",
              ...agentField,
              providerID: "openai",
              modelID: "gpt-fake",
              cost: 0.0042,
              tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
              finish: "stop",
            },
            // The REAL final answer, byte-exact. May contain newlines/quotes/unicode.
            parts: [
              { id: "p4", type: "step-start" },
              { id: "p5", type: "text", text: opts.historyText },
              { id: "p6", type: "step-finish" },
            ],
          },
        ]);
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
