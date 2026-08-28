# Backend requirements — what ModelGuild needs to run a model

What a backend has to provide for ModelGuild's published guarantees to hold, and what each tool does when it cannot. **opencode is the reference backend**: every requirement below is stated in the abstract and then, on one line, as the thing opencode actually does, with the file that reads it. This is an inventory of requirements, not an evaluation — **no CLI is assessed here**, and nothing below claims a second backend exists. Back to [README.md](../README.md).

- [The requirements](#the-requirements) — [lifecycle](#1-process-lifecycle), [the turn](#2-the-model-turn), [transcript](#3-transcript-readback), [permissions](#4-permission-model-with-readback), [events and gating](#5-event-stream-and-gating), [enumeration](#6-model-enumeration), [auth](#7-auth)
- [When a requirement is missing](#when-a-requirement-is-missing)
- [Not a backend concern](#not-a-backend-concern)

## The requirements

In dependency order: each one assumes the ones above it.

### 1. Process lifecycle

**Used by** every model-calling tool, plus the no-orphaned-process guarantee and the worktree read and write roots (C70/C71).

**opencode** is a binary on PATH, spawned as `serve --port N --hostname H` with its cwd fixed at spawn (`src/lifecycle.ts:783`); readiness is polling `GET /doc` until it answers (`src/lifecycle.ts:898`); teardown is keyed on stdin EOF and MCP transport close, not on signals (`src/lifecycle.ts:585`); and because opencode fences a model's reads at that cwd, a second root means a second supervised child, pooled per root (`src/servepool.ts:65`).

**Minimum for a substitute:** a way to start it, a way to know it is ready, and a way to stop it that leaves nothing running once Claude Code closes the transport. Plus a way to fix the directory the model's reads and edits resolve against — per child or per call, either is fine, but a backend that cannot be rooted at a caller-named directory cannot serve the `worktree` input at all. The fence itself is `git worktree list` membership (`src/worktree.ts:123`) and is backend-neutral; what must survive verbatim is the coupling C71 states — the root the model edits and the root the capture snapshots are one value, never two.

### 2. The model turn

**Used by** `guild_consult`, `guild_panel`, `guild_research`, `guild_delegate`.

**opencode** creates a session naming the agent, the model and any per-session permission ruleset (`POST /session`, `src/client.ts:383`), runs the turn with a POST that blocks until it ends (`src/client.ts:710`), answers a continuation's stored ruleset and directory from `GET /session/{id}` (`src/client.ts:448`), and deletes a session on request (`src/client.ts:1574`). The per-turn timeout applies to that one POST and nothing else (`src/config.ts:383`).

**Minimum for a substitute:** one call that runs a turn to completion under a caller-supplied deadline, and one identifier the caller can hand back to continue it. Blocking is not required; an unambiguous completion signal is, because the tools return a finished answer rather than a stream. A backend with no server-side continuation must declare continuation unsupported rather than quietly start a fresh conversation — `/guild:workshop` and `/guild:collaborate` are built on the model remembering its own turns without Claude re-transmitting them.

### 3. Transcript readback

**Used by** the evidence log's byte-exact `raw_response` (C25), the refusal of a turn that produces no answer (C74), and the tool-call counts on every result.

**opencode** returns the full ordered history with each message's `info` and `parts` from `GET /session/{id}/message` — the only sanctioned capture source, because the message POST's own body omits tool parts (`src/client.ts:782`). The turn is bounded backwards to the last caller `user` message (`src/client.ts:868`), the answer is the ordered text — or, when those join to blank, reasoning — parts of the last answering assistant message (`src/client.ts:1126`), and the tool-call count is the turn's `tool` parts (`src/client.ts:1531`).

**Minimum for a substitute:** an authoritative post-turn transcript carrying every part type — text, reasoning, and tool calls with their inputs and outputs — with the answer's bytes unmodified, and **a per-turn delimiter**. The delimiter is a hard conformance requirement, not a nicety: without one the backward walk that assembles an answer reaches into the previous turn and records it as this one, with `exit_code: 0` and a confident answer to a different question. It must also be a delimiter the backend marks as the *caller's* — opencode's own compaction appends `user` messages mid-turn, and reading those as boundaries truncates the turn and under-counts its tool calls. A backend that streams tokens and keeps no transcript can still be supported, but byte-exactness then becomes a property of the adapter's reassembly rather than of the wire, which is a weaker claim than the receipts make today and has to be labelled as one.

### 4. Permission model, with readback

**Used by** the four hardened tools, and it is what C16, C47/C48 and C73 are about.

**opencode** resolves an agent definition from the serve cwd's `.opencode/agent/` or the global opencode agent dir, whose presence is checked before the call (`src/config.ts:243`); `GET /agent` then returns every agent **as opencode resolved it**, with its permission rule array (`src/client.ts:506`), and the effective action for a sentinel tool no definition grants must come back `deny` (`src/agentfloor.ts:180`, probe name at `src/agentfloor.ts:103`).

**Minimum for a substitute:** three things, and all three together. (a) The backend enforces a declarative per-agent permission map itself. (b) It will report what it **resolved**, not what the file said. (c) The map can express a catch-all, so a default-deny floor is representable at all. (a) without (b) is a configuration that fails silently — the entire reason the check has a second stage is that a presence test cannot answer whether the floor is in force. Absent any of the three, `agent-def-missing` and `agent-unhardened` have nothing to check.

### 5. Event stream and gating

**Used by** the live activity trace (C59–C64) and the opt-in approval bridge (C65–C69).

**opencode** serves one `GET /event` SSE subscription per child with no replay (`src/activity.ts:660`), normalized from a probed event set — tool parts, file edits, permission requests, session idle and error. Gating adds a per-session `ask` ruleset supplied at session creation (`src/client.ts:396`) which may only ever narrow (`src/client.ts:320`), a list of still-open requests to recover what was raised while the stream was down (`src/client.ts:618`), and separate endpoints to approve and to reject one request (`src/approve.ts:1990`).

**Minimum for events:** any push channel carrying tool calls, file edits and permission requests, attributable to a session. Build the normalizer from **observed** events, not a documented union — opencode's union carries names that never fire, and the fixtures were once written from a design table and were wrong in production while green in test.

**Minimum for gating**, which is a strictly larger ask: a ruleset attachable to one session or turn that the backend **echoes back**, so "did the gate take?" is answerable without trusting it; a signal that a request was raised; an endpoint that settles one; and the load-bearing one — the backend must genuinely **block** the tool call until the request is settled. A backend that runs the tool while the prompt is still outstanding cannot be gated, and a bridge reporting itself armed over it is exactly the outcome C69 exists to forbid.

### 6. Model enumeration

**Used by** `guild_models` and `/guild:configure`.

**opencode** answers `GET /config/providers` with the authed provider configuration (`src/models.ts:162`) — per provider, not per model, so a listed id can still be rejected at call time.

**Minimum for a substitute:** a list of ids the user's auth can actually reach, in the same `provider/model` shape the policy layer matches on. A backend without it can still run a model the user names, so this is the one requirement whose absence costs a convenience rather than a guarantee — but `/guild:configure` has nothing to interview the user about.

### 7. Auth

**Used by** nothing on the model path: ModelGuild reads no credential to make a call.

**opencode** holds its own credentials from a login the user performs once; `doctor` probes the binary (`src/cli.ts:663`) and reports what `opencode auth list` can see (`src/cli.ts:332`), warning rather than failing because that probe has known blind spots.

**Minimum for a substitute:** the backend holds its own credentials. ModelGuild stores, forwards and reads no API key, so a backend that requires one to be handed to ModelGuild does not meet this requirement as it is currently stated — changing that is a product decision about the no-API-keys claim, not an adapter detail. A backend whose auth state cannot be probed costs `doctor` a check, not a call: report *unknown*, never *unauthenticated*.

## When a requirement is missing

Three tiers, and the boundaries between them are deliberate.

**Hard refuse.** No permission model with readback (§4) ⇒ the four hardened tools refuse on that backend, with a named kind, before any model turn, any session and any evidence entry. Every published guarantee about those tools is a permission-model guarantee; offering them unenforced converts what SECURITY.md calls *verified* into model compliance. One exception is worth arguing rather than assuming: a backend with **no tool surface at all** is trivially read-only, and could serve the read tools with the capability difference stated — that is a capability reduction, not an unenforced claim, and it is a maintainer's call.

**Degrade loudly.** No event stream (§5) ⇒ `activity.degraded` carrying a reason that names the cause, never a silently empty trace. No lifecycle control (§1) — a remote or in-process backend with nothing to kill — ⇒ the no-orphan guarantee reported *not applicable*, not quietly claimed. Degradation is for visibility; it is never a substitute for enforcement.

**Refuse to arm.** `GUILD_APPROVE` or `GUILD_APPROVE_EGRESS` set on a backend that cannot gate (§5) ⇒ refuse the call up front. Never silently un-arm: a user who set the knob believes edits are gated, and a typo in that knob is already an error rather than a quiet `off`.

**What exists today, and what does not.** All three tiers exist as *shapes* — but as refusals inside the one backend, not as a backend-capability branch. `agent-def-missing` (C16, `src/consult.ts:1401` and its three siblings) and `agent-unhardened` (C73, `src/panel.ts:394`) are the hard-refuse shape; `activity.degraded` (C61) is the degrade-loudly shape; C67's refusal when no channel can answer, and C65's error on an unrecognized knob value, are the refuse-to-arm shape. **The per-backend rules above are not implemented** — there is one backend, and no capability declaration to branch on. Treat this section as the specification a second backend would have to satisfy, and do not cite it as behaviour.

## Not a backend concern

- **Model policy** — `src/policy.ts` matches `provider/model` strings. That is a naming convention, not an API.
- **The evidence log** — `src/log.ts`: the `expected-call` → `started` → `completed` lifecycle, the hash chain, run-id grammar and retention are all backend-independent, and the fields that name a backend concept (`agent`, `session_id`) are already optional.
- **Progress notifications** — `src/progress.ts` speaks MCP to the client above, never to the backend below.
- **The installer** — `src/init.ts`'s ownership, never-clobber, uninstall, drift and skew machinery is backend-agnostic. Its **payload** is not: the hardened agent definitions it ships are opencode artifacts, so a second backend brings a second payload, not a second installer.
