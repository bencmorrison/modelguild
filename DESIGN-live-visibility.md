# DESIGN — Live visibility into external-agent activity (issue #20)

**Status:** design only. Nothing here is implemented; no code changed in this pass.
**Provenance:** the ask is the **maintainer's** day-one request recorded in issue #20 (live visibility
instead of log-everything-and-audit-after, plus an opt-in write-path approval bridge). The permission-API
facts were **banked prior investigation** (issue #20). The opencode API shapes quoted below were
**re-probed live by Claude** against `opencode 1.18.5` on 2026-07-25 (`opencode serve` → `GET /doc`), so
every endpoint, event name, and body schema in this doc is evidence, not recollection. The design
choices, the recommendation, and the parity audit are **Claude's**, offered to the maintainer for
sign-off — in particular, nothing here adds a restriction without his approval.

---

## 1. Goal and non-goals

### Goal

The developer can see, **while it is happening**, what an external model is doing on his repo: which
files it read, what it grepped, what it fetched, what it edited, what shell commands it ran — the same
class of thing Claude Code shows for its own tool calls and for a `Task` subagent's.

Today that information exists but only *after the fact*: `src/log.ts` writes `expected-call` →
`started` → `completed` per call, and `guild_delegate` writes a patch via `captureAndLog()` in
`src/delegate.ts`. A `guild_delegate` on a slow model is a 15-minute black box (default
`MESSAGE_HTTP_MS = 900_000`, `src/client.ts:35`) that ends with a diff. The receipts are good; the
*liveness* is missing.

Secondary goal, **opt-in and default-OFF**: for the write path, turn "see what it did" into "see what
it is **about** to run" — surface `guild-build`'s `edit`/`write`/`patch`/`bash` calls for approval
before opencode executes them.

### Non-goals

- **This is not containment, and not a confidentiality boundary.** `AGENTS.md` already states the
  posture (trusted repo + frontier model; the read paths can read credentials and reach the web; the
  write path allows `bash` by design). Nothing in this design changes that, and this document must not
  be cited later as if it did.
- **The honest bound, stated plainly: an approved `bash` call can do anything.** The approval prompt
  shows a command string. A shell one-liner can `cat .env`, `curl` it out, spawn
  `opencode --agent build`, or rewrite history — and the child processes it spawns produce no further
  approval requests. Approving `bash` is approving a shell, not approving a diff. The human **diff
  review** (`.claude/commands/guild/delegate.md` step 3) remains the real review point; this bridge
  makes the run watchable and interruptible, it does not make it safe.
- **Not a resurrection of the witness.** No model audits another model's account. This is a mechanical
  event stream from opencode to the developer's screen.
- **Not a network firewall.** Unchanged (`AGENTS.md` → Gotchas).
- **Not a change to the model policy** (`src/policy.ts`) or to any agent def's allow-set. The
  hardened defs stay byte-identical; see §3.2 for how an `ask` tier is injected without touching them.

---

## 2. Where a stream can attach — the current call flow

One `guild_*` tool call today (using `guild_delegate` as the richest case):

```
server.ts  CallToolRequestSchema handler          (src/server.ts:453)
  → delegate()                                    (src/delegate.ts:176)
      resolveRootWithConflict / readConfContents   (config root, conf knobs)
      hardenedDefPresentIn("guild-build", …)       (fail-closed def pre-check)
      gateModel(...)                               (policy deny/ask, BEFORE any log write)
      log.newRun() ; snapshotWorktree(repoDir)     (src/snapshot.ts — pre-turn git tree)
      → runAgentLifecycle()                        (src/consult.ts:369)
          log.expect() ; log.started()
          → askViaAgent()                          (src/client.ts:505)
              lifecycle.withServe(h => …)          (src/lifecycle.ts:180 — h.baseUrl/h.port/h.pid)
                createSession()   POST /session            ← session id known HERE
                sendMessage()     POST /session/{id}/message  ← BLOCKS for the whole turn
                fetchHistory()    GET  /session/{id}/message   ← the only capture source
                deleteSession()   DELETE /session/{id}
          log.completed()
      captureAndLog() → captureDelegateDiff() → log.diff()
```

The black box is exactly one line: the blocking `POST /session/{id}/message` inside `sendMessage()`
(`src/client.ts:229`). Everything the model does happens inside that await, and nothing escapes until
`fetchHistory()` reconstructs it afterwards.

### What opencode already emits (probed, 1.18.5)

`GET /event` (`operationId: event.subscribe`, `text/event-stream`) carries a tagged union. The members
that matter here:

| Event `type` | Payload (probed) |
| --- | --- |
| `session.next.tool.called` | `{timestamp, sessionID, assistantMessageID, callID, tool, input, provider}` |
| `session.next.tool.success` | `{… callID, structured, content, outputPaths?, result?}` |
| `session.next.tool.failed` | same shape, failure side |
| `session.next.text.delta` / `.started` / `.ended` | streaming assistant text |
| `session.next.reasoning.delta` | streaming reasoning |
| `file.edited` | `{file}` |
| `permission.asked` | `{id ^per, sessionID, permission, patterns[], metadata, always[], tool?{messageID, callID}}` |
| `permission.replied` | `{sessionID, requestID, reply: once\|always\|reject}` |
| `permission.v2.asked` / `.replied` | v2 shape: `{id, sessionID, action, resources[], save[], metadata, source}` |
| `session.idle` | `{sessionID}` — turn finished |
| `session.error` | `{sessionID, error}` |

Every one carries `sessionID`, so a single stream can be routed to concurrent calls (a `guild_panel`
runs 2–3 sessions on one serve child).

Also probed and relevant:

- `GET /permission` → `PermissionRequest[]` (pending, across sessions) — a recovery/poll path if a
  subscription drops mid-turn.
- `POST /permission/{requestID}/reply`, body `{reply: "once"|"always"|"reject", message?}`.
- `POST /session/{sessionID}/permissions/{permissionID}`, body `{response: "once"|"always"|"reject"}`
  (session-scoped equivalent; prefer this one — it cannot answer another session's request by mistake).
- `POST /session` accepts **`permission: PermissionRuleset`** = `PermissionRule[]`, each
  `{permission: string, pattern: string, action: "allow"|"deny"|"ask"}`. This is the seam in §3.2.
- `POST /session/{id}/prompt_async` → `204`, plus `POST /api/session/{id}/wait` and
  `POST /session/{id}/abort` — a non-blocking turn submission, relevant to §3.5 and §5 slice 5.

---

## 3. Architecture

### 3.1 Consuming the stream

Three options considered.

**Option A — subscribe inside `src/lifecycle.ts`.** `OpencodeLifecycle` owns the child, its `baseUrl`,
crash-revive, and teardown, so a subscription opened at readiness and closed in `shutdown()` matches
the child's lifetime exactly. *Rejected as the primary:* `lifecycle.ts` is deliberately narrow (process
supervision, nothing about sessions, logs, or MCP); giving it a fan-out to the evidence log and the MCP
transport couples the one module whose correctness (the M1 orphan proof) is most load-bearing.

**Option B — subscribe per call inside `askViaAgent`.** The session id exists there, scoping is
automatic, and teardown rides the existing `finally`. *Rejected as the primary:* a `guild_panel` of
three models would open three full-serve SSE subscriptions and each would receive (and discard) the
other two's events. It also puts stream parsing, log fan-out, and approval logic inside the module
whose two documented invariants are about *not* leaking the sync response upward.

**Option C (recommended) — a new `src/activity.ts` owning a shared, refcounted event bus.**

```ts
// src/activity.ts (new)
export interface ActivityEvent {           // normalized, opencode-version-tolerant
  ts: number; sessionId: string; kind: ActivityKind;
  tool?: string; callId?: string; summary: string;   // one-line human text
  detail?: unknown;                                   // the raw event properties
}
export type ActivityKind =
  | "tool-called" | "tool-succeeded" | "tool-failed"
  | "file-edited" | "text-delta" | "permission-asked" | "permission-replied"
  | "session-idle" | "session-error";

export class ServeEventBus {                // one per baseUrl, lazily created
  static acquire(baseUrl: string): ServeEventBus;   // refcount++
  subscribe(sessionId: string, on: (e: ActivityEvent) => void): () => void;
  release(): void;                                   // refcount-- ; close SSE at 0
}
```

- One `GET /event` subscription per serve child, created by the first subscriber, closed when the last
  releases. Routing is by `properties.sessionID`.
- **Unknown event types are normalized to nothing and dropped** — an opencode bump that adds an event
  must never break a call. Conversely a *missing* expected event degrades visibility only.
- **A stream failure is never a call failure.** The bus reconnects with backoff; if it cannot, calls
  proceed with no activity (and the tool result says so — see §3.3, `activity.degraded`). This mirrors
  the existing "logging is best-effort and never fails the call it records" rule (C31).
- `askViaAgent` gains one optional dep — `onActivity?: (e: ActivityEvent) => void` — subscribed
  immediately after `createSession()` (or immediately, when continuing a `sessionId`) and unsubscribed
  in the existing `finally`. That is the **only** change to `src/client.ts`, and it touches neither
  documented invariant.
- One touch in `src/lifecycle.ts`: `shutdown()` closes any bus for the dying child's `baseUrl`. Without
  it, an idle-timeout kill leaves a fetch stream dangling on a dead port.

Testability: `test/fake-opencode-server.ts` is an in-process `node:http` server, so it can serve a
scripted `text/event-stream` — the whole layer stays in the **offline** suite (no opencode, no model,
no credentials), which is what CI can run.

### 3.2 Surfacing it to the developer — four channels, ranked

The issue says *the developer* should see it live. Claude Code's rendering of server-initiated MCP
notifications is the part this design cannot assert from evidence, so the recommendation does not
depend on it.

**Channel 1 (recommended primary) — an activity file plus `modelguild watch`.**
The bus writes each normalized event as one JSON line to `<runDir>/activity.jsonl`, where `runDir` is
`EvidenceLog.dir(runId)` (`src/log.ts:347`). A new CLI verb `modelguild watch` (dispatch beside
`serve`/`init`/`doctor` in `src/cli.ts:344-353`) tails the newest run — `EvidenceLog.latest()` already
resolves it (`src/log.ts:371`) — and prints a live, human-readable line per event. This is guaranteed
to work: it is a file and a terminal, with no dependency on Claude Code's UI or on the MCP spec.
- It must **not** disturb `EvidenceLog.verify()` (`src/log.ts:706`). `activity.jsonl` is a *separate
  file*, is not appended to `calls.jsonl`, and is not referenced by any entry — `verify` validates the
  three-entry cardinality and *referenced* artifacts, so an unreferenced sibling is inert. **No entry
  shape changes**, so `test/log.test.ts` and the byte-exact response guarantees are untouched.
- Honesty about what it is: activity lines are opencode's report of the model's tool calls. They are
  **not** receipts of the model's words (that is `raw_response` in `calls.jsonl`) and they are
  captured by the server, not transcribed — so they are evidence of *actions*, at opencode's fidelity.

**Channel 2 — `structuredContent.activity` on every tool result.** A bounded summary (counts by tool,
first N tool calls with their inputs truncated, every `file.edited` path, any `session.error`) attached
to the existing result shapes via `delegateToToolResult` / `consultToToolResult` / etc. Post-hoc, not
live — but it always works, it costs nothing, and it gives the driver something concrete to report
("it ran 14 tool calls, 3 of them bash, and edited 5 files") instead of only a diff. It is also the
fallback that makes Channel 3 optional.

**Channel 3 — MCP `notifications/progress`.** Live *into the Claude Code session*. Requires the client
to have sent a `progressToken` in the request `_meta`; the SDK then exposes `extra.sendNotification`.
**Gated on an empirical check** (probe P1, §5) that Claude Code both sends a token and renders the
messages. Cheap to add once proven, and harmless when the token is absent (the server simply does not
send). Note: this shows the activity to *Claude*, which is not the same as showing it to the
developer — Claude may or may not relay it. Channel 1 is what the issue actually asks for.

**Channel 4 — MCP `notifications/message` (logging).** Requires declaring `capabilities.logging` in
`new Server(...)` (`src/server.ts:106-109`, currently `{ tools: {} }`). Same rendering uncertainty as
Channel 3, plus it changes the server's advertised capabilities for every client. Recommend **not**
doing this unless P1 shows progress notifications are unrendered and logging ones are.

**Recommendation: Channel 1 + Channel 2 first (they are unconditional), Channel 3 behind probe P1.**

### 3.3 Config knobs

Following the existing precedence — env override > `modelguild/modelguild.conf.local` > default,
parsed by `confGet` (`src/log.ts:139`), documented in `modelguild/modelguild.conf.example`:

| Key | Default | Meaning |
| --- | --- | --- |
| `GUILD_ACTIVITY` | `on` | Write `activity.jsonl` and populate `structuredContent.activity`. `off` disables the bus entirely (no SSE subscription is opened). |
| `GUILD_ACTIVITY_DETAIL` | `summary` | `summary` (tool name + truncated input) or `full` (raw event properties). `full` can capture file contents that pass through tool outputs — same sensitivity class as `GUILD_LOG_PROMPTS=full`, and it must say so in the conf template. |
| `GUILD_APPROVE` | `off` | The write-path approval bridge. `off` \| `write` (gate `edit`/`write`/`patch`) \| `all` (also `bash`). §3.4. |
| `GUILD_APPROVE_TIMEOUT_MS` | `300000` | Unanswered approval → **reject** (fail-closed). |

`activity.degraded: true` is set on the tool result when the bus could not subscribe or dropped
mid-turn — so a quiet activity list is never mistaken for a quiet model.

### 3.4 The approval bridge (opt-in, default OFF)

**Shape.** When `GUILD_APPROVE` is not `off`, `guild_delegate` (only — see the parity audit) creates
its session with a per-session permission ruleset that moves the gated tools from `allow` to `ask`,
subscribes to `permission.asked`, routes each request to a human, and replies over HTTP.

**Injecting `ask` without touching the agent def.** `POST /session` accepts
`permission: PermissionRule[]` (probed). So the bridge passes a ruleset at session creation and
`.opencode/agent/guild-build.md` stays **byte-identical** — which matters, because
`modelguild/tests/check-agent-permissions.sh` asserts that def's exact allow-set, and
`modelguild/verify-guild-build.sh` proves opencode's *resolved* config against it.

Two invariants the implementation must enforce mechanically (a unit test each):

1. **The bridge may only narrow.** It emits rules whose `action` is `"ask"` or `"deny"`, **never
   `"allow"`**. A ruleset that could re-open a denied tool would be a privilege escalation dressed as a
   safety feature. Assert this on the constructed ruleset before it is sent.
2. **It must be safe under both merge semantics.** Whether the session ruleset *merges with* or
   *replaces* the agent's permission map is **unknown** (probe P2, §5). If it replaces, emitting only
   `ask` rules would silently drop the `"*": deny` floor — a capability *widening*. So the bridge emits
   the **complete** ruleset: the `"*": deny` floor first, then the agent's own allows, with the gated
   subset set to `ask`. Correct under replacement, and a no-op-plus-ask under merge. Ship only after
   P2 confirms which it is, and pin it in a test against the fake server plus a live `--static`-style
   check in `verify-guild-build.sh`.

**Fallback design (B), if P2 shows the session ruleset is unusable:** ship a second def,
`.opencode/agent/guild-build-ask.md`, identical to `guild-build` but with
`edit/write/patch/bash: ask`, selected by the tool when the knob is on. Cost, stated: it adds a fourth
agent def, so `src/init.ts` `AGENT_DEFS`, the package `files` list, `check-agent-permissions.sh`,
`check-contract-counts.sh` (the "<word> hardened agent defs" count in CONTRACT.md), and a new
`verify-guild-build-ask.sh` all move together, and the `expectedAgent` mismatch check in
`askViaAgent` must expect the ask-variant name. Prefer A.

**The non-TTY auto-reject problem.** The banked finding — an `ask` tier auto-rejects on a non-TTY — is
what makes `--auto` a proven no-op and is recorded in `AGENTS.md`. Under `opencode serve` the situation
is different in principle: the TUI is just one HTTP client, and the server exposes `GET /permission`,
`permission.asked` on the event stream, and two reply endpoints — machinery that only makes sense if a
detached client is *expected* to answer. **The bridge's answer is to be that client**: it holds the
subscription before the turn starts, so a request never goes unattended.

But "in principle" is not evidence. **Probe P3 (§5) is a hard gate on this whole section**: if
`opencode serve` auto-rejects an `ask` before any HTTP client can reply, no bridge design works and the
feature is not buildable on 1.18.5 — that is a legitimate outcome to report to the maintainer, not
something to paper over.

**Who approves — the approval must reach the human, never Claude.** Preference order:

1. **MCP elicitation** (`elicitation/create`, supported by `@modelcontextprotocol/sdk` ^1.29) — the
   server asks the *client* to collect user input mid-tool-call. Use only if the client advertises the
   capability at initialize (probe P4). This is the only channel that puts the prompt where the
   developer is already looking.
2. **The `modelguild watch` terminal.** The watcher is already tailing; it prompts on its TTY and
   replies through a small local control file or socket in the run dir. Works with any client.
3. **No channel attached ⇒ do not arm.** If `GUILD_APPROVE` is on and neither channel is available,
   `guild_delegate` **refuses at the start of the call** with a structured error (kind
   `approval-channel-missing`), before `log.expect()` and before `snapshotWorktree()` — same gap-parity
   discipline as the existing `agent-def-missing` refusal in `src/delegate.ts:194`. Refusing up front
   is far better than deadlocking mid-turn with a model waiting on a prompt nobody will see.

**Claude must not be able to self-approve.** The existing `confirmed:true` gate is honest about its own
weakness (`src/consult.ts:489-497`: instruction-layer plus audit trail, not prevention). The bridge
must not repeat that pattern: an approval decision is only ever accepted from channel 1 or 2 — there is
**no tool input** by which the driver can pre-approve a permission request. Add no such parameter, and
add a lint or test asserting `guild_delegate`'s input schema carries no approval field.

**Timeout and fail-closed.** An unanswered request is replied `reject` after
`GUILD_APPROVE_TIMEOUT_MS`, logged as a `permission-replied` activity line with `reason:"timeout"`. The
model sees a denied tool call and usually continues; the turn is not aborted. Two costs, stated:
(a) a rejected mid-sequence edit can leave a **partial** change set — which the existing snapshot/diff
capture still records, so it is reviewable and recoverable via `capture.recoveryHint`; (b) the wait
consumes the same `GUILD_MESSAGE_TIMEOUT_MS` budget as the model turn (§3.5).

**`always` is never sent by default.** `reply: "always"` persists (there is a `/api/permission/saved`
surface), so it leaks scope past the current call. Only a human explicitly choosing "always" produces
it, and the choice is recorded in the activity file.

### 3.5 Interaction with the message timeout

The whole turn — including any time spent waiting on a human — runs inside one blocking
`POST /session/{id}/message` bounded by `resolveMessageTimeoutMs()` (`src/config.ts:203-260`, default
15 min). A 5-minute approval wait therefore eats a third of the default budget, and a timeout aborts
the fetch while opencode keeps running the turn server-side.

Two responses, in order of cost:

- **Short term (ship with the bridge):** when `GUILD_APPROVE` is on, extend the effective message
  timeout by the approval time actually spent, or simply document that the knob wants a raised
  `GUILD_MESSAGE_TIMEOUT_MS` and warn once at call start.
- **Later (§5 slice 5):** submit with `POST /session/{id}/prompt_async` (204) and drive completion off
  `session.idle` / `session.error` from the same bus, with `POST /session/{id}/abort` as the cancel
  path. That removes the single-blocking-request coupling entirely — but it changes the core of
  `askViaAgent` for every tool, so it is a separate, evidence-backed change, not a rider.

---

## 4. Parity audit (per `AGENTS.md` → Conventions → PARITY)

**Streaming/visibility (§3.1–§3.3): no parity burden — it is not a restriction.** It removes no
capability from the external path. Claude Code shows its own tool calls and its subagents' tool calls
live; showing an opencode agent's is closing an asymmetry that currently runs *against* the external
path (its work is the only work in this workflow the developer cannot watch). It applies uniformly to
read and write paths — `guild_consult`, `guild_panel`, `guild_research`, `guild_delegate` — because a
visibility feature offered only on the write path would encode "the external write path is the
suspicious one", which is exactly the framing `AGENTS.md` recorded as a bias to remove.

**The approval bridge (§3.4): this IS a restriction, so it carries the burden.**

- **Forcing question — would I impose this on an Anthropic subagent doing the same task?**
  **Yes, and Claude Code already does.** In its default permission mode, a subagent's `Edit`/`Write`/
  `Bash` calls surface to the user for approval unless allowlisted. So per-call approval on the write
  path is the *Claude path's own default*, and offering it here is parity, not a fence.
- **Which direction is the asymmetry, honestly?** With the knob **OFF** (the default this design
  ships), the external write path is **less** gated than the Claude path under its usual settings —
  the asymmetry runs in the permissive direction, which PARITY permits (asymmetry is default-deny only
  for *restrictions*). Turning it ON reaches parity with Claude Code's default. It does not exceed it:
  the gated set (`edit`/`write`/`patch`, plus `bash` at `all`) is the same set Claude Code gates.
- **No new harness difference is claimed.** This design adds nothing to the ratified list in
  `AGENTS.md`, and it must not — that list needs the maintainer's sign-off and Claude does not add to
  it mid-design.
- **Capability cost, stated:**
  - Latency, and the end of unattended delegation: an approval-gated run cannot complete while nobody
    is watching. That is the whole point of the knob and the whole reason it is OFF by default.
  - A timeout-rejected tool call can leave a **partial** edit set (mitigated, not removed, by the
    existing snapshot/diff capture).
  - The gated run costs extra tokens when the model retries around a rejection.
  - **It buys less than it looks like it buys.** With `bash: allow` in `guild-build`, approving one
    `bash` call approves a shell. Anyone reading an approval prompt as a containment guarantee has been
    misled — say so in the command doc and the conf template, not only here.
  - Adding a fourth agent def (fallback design B) costs a permanent widening of the def surface every
    lint and verify script must track.
- **Provenance:** the ask is the maintainer's (issue #20, day one). The permission API facts are banked
  prior investigation, re-confirmed by Claude's probe of 1.18.5 on 2026-07-25. The `POST /session`
  ruleset seam, the choice of default-OFF-with-refuse-if-no-channel, and the never-emit-`allow`
  invariant are **Claude's** proposals and need the maintainer's sign-off before implementation.
- **Guarantee-not-extended check:** none claimed. This design does not assert the external write path
  is contained; §1 states the opposite in the same words the SECURITY doctrine uses.
- **Rejected option, recorded:** making the bridge's default *mirror Claude Code's current permission
  mode* would be the most parity-faithful default — but the MCP protocol gives a server no way to read
  the client's permission mode, so it is not implementable. Default OFF plus an explicit knob is the
  honest substitute.

---

## 5. Delivery plan — smallest shippable slice first

**Slice 0 — evidence gate (no ship; probes only).** Each is a small, bounded experiment; P2 and P3 need
one turn on a free model against a scratch repo.
- **P1:** does Claude Code send a `progressToken` in tool-call `_meta`, and does it render
  `notifications/progress`? (Log `extra._meta` from the `CallToolRequestSchema` handler and emit one
  test notification.) Gates Channel 3.
- **P2:** does `POST /session`'s `permission` ruleset **merge with** or **replace** the agent's map?
  (Create a session on `guild-read` with a ruleset, then read back the resolved permissions / attempt a
  denied tool.) Gates §3.4 design A vs B.
- **P3 (hard gate on the whole bridge):** under `opencode serve`, does an `ask`-tier tool call emit
  `permission.asked` and **wait** for an HTTP reply, or auto-reject with no client attached? Run a
  `read: ask` session on a free model and watch `GET /event`.
- **P4:** does Claude Code advertise the `elicitation` client capability at initialize?
  (`server.getClientCapabilities()`.) Gates approval channel 1.

**Slice 1 — `src/activity.ts` + `activity.jsonl` + `structuredContent.activity`.** The `ServeEventBus`,
the normalizer, the one-line `onActivity` hook in `askViaAgent`, the bus close in
`OpencodeLifecycle.shutdown()`, `GUILD_ACTIVITY`/`GUILD_ACTIVITY_DETAIL` in `src/config.ts` and the conf
template, and a new offline `test/activity.test.ts` driving a scripted SSE fake. **No behavior change
to any existing path; no entry-shape change in `src/log.ts`.** This alone converts every call from a
black box into a reviewable action trace.

**Slice 2 — `modelguild watch`.** The CLI verb in `src/cli.ts`, tailing `EvidenceLog.latest()`'s
`activity.jsonl`. This is the slice that actually delivers the issue's headline ask, and it depends on
nothing uncertain.

**Slice 3 — MCP progress notifications.** Only if P1 is green.

**Slice 4 — the approval bridge.** Only if P2 and P3 are green: `GUILD_APPROVE`,
`GUILD_APPROVE_TIMEOUT_MS`, the ruleset builder with the never-emit-`allow` assertion, the
`permission.asked` router, the elicitation and watch approval channels, the
`approval-channel-missing` up-front refusal, and the fail-closed timeout. Docs move in the same change
(see §6).

**Slice 5 — optional: `prompt_async` + `session.idle` completion.** Decouples the turn from one
blocking HTTP request. Separate design pass; touches every tool.

---

## 6. Documentation that must move with the code

Named here so the next agent does not have to rediscover them (`AGENTS.md`: update in the *same*
change, not "later"):

- **`AGENTS.md`** — the `--auto` bullet currently ends "*See issue #20 for the permission API and what
  per-call approval would cost*". If Slice 4 ships, that sentence is stale and the conventions list
  needs the knob's default and the honest bound.
- **`CONTRACT.md`** — a new area (or clauses under **E. Write-path semantics**) for the approval bridge;
  and if design B is used, the "<word> hardened agent defs" count that
  `modelguild/tests/check-contract-counts.sh` pins against `src/init.ts`'s `AGENT_DEFS`.
- **`modelguild/modelguild.conf.example`** — the four new knobs, with the `GUILD_ACTIVITY_DETAIL=full`
  sensitivity note written in the same register as the existing `GUILD_LOG_PROMPTS` note.
- **`.claude/commands/guild/delegate.md`** — how to read the live activity, and the explicit statement
  that approval is not containment.
- **`SECURITY.md`** — the loopback surface section: the bridge adds a reply path that can *un-block* a
  gated tool, so who can reach that port matters more than it did.
- **`README.md`** — `modelguild watch`.
- **Tests** — `test/activity.test.ts` (offline), plus the approval-bridge ruleset unit tests; if design
  B, `check-agent-permissions.sh` and a new `verify-guild-build-ask.sh`.

---

## 7. Open questions for the maintainer

1. **Is `modelguild watch` (a second terminal) an acceptable primary channel?** It is the only one this
   design can promise works. If you want the activity *inside* the Claude Code session, that depends on
   P1 and on Claude relaying it — Claude Code's own rendering is not something this repo controls.
2. **Default for `GUILD_APPROVE` — really OFF?** OFF leaves the external write path less gated than
   your Claude path under its default permission mode. PARITY permits that direction, but you may
   prefer `write` as the default and `off` as the opt-out. Your call; the issue says OFF.
3. **Should `GUILD_APPROVE=all` (gating `bash`) even exist**, given that approving one `bash` call
   approves a shell? It is the highest-friction, lowest-guarantee setting in the design. Keep it as an
   honest option, or drop it as friction that buys a feeling?
4. **If P3 shows `opencode serve` auto-rejects `ask` with no TTY**, the bridge is not buildable on
   1.18.5. Do you want the visibility slices shipped alone, an upstream issue filed with opencode, or
   the whole of issue #20 narrowed to visibility?
5. **If P2 shows the session ruleset *replaces* the agent map**, do you accept design A with the
   full-ruleset mirror (one more place the `"*": deny` floor is written, which can drift from the def),
   or prefer design B's fourth agent def (more surface, no drift risk)?
6. **Activity detail default.** `summary` truncates tool inputs; `full` records raw event payloads,
   which can include file contents pulled through tool outputs — the same sensitivity trade-off as
   `GUILD_LOG_PROMPTS=full`. Default `summary` proposed. Agree?
7. **Retention.** `activity.jsonl` lives in the run dir, so `EvidenceLog.prune()` already reaps it with
   the run. It is also the bulkiest artifact a run will produce. Separate retention knob, or is riding
   `GUILD_LOG_RETENTION_DAYS` right?
8. **Read-path parity check on the approval bridge.** This design deliberately gates only
   `guild_delegate`, on the reasoning that read tools are not gated for a Claude review subagent
   either. If you would rather have an `ask` option on the read paths' `webfetch` (the egress the
   security scan surfaced), say so — it is the one place where the ratified harness difference could
   justify an *offered, opt-in* gate rather than a fence.
