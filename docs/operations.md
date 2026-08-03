# Operations — watching, approving, receipts, troubleshooting

What a guild call looks like while it runs, what it leaves behind, and what to do when one fails. Back to [README.md](../README.md).

- [Watch it live](#watch-it-live)
- [Answer before it acts](#answer-before-it-acts-opt-in-off-by-default)
- [The record it keeps](#the-record-it-keeps)
- [Troubleshooting](#troubleshooting) — including [common failures by name](#common-failures-by-name)

## Watch it live

`/guild:delegate` on a slow model is otherwise a fifteen-minute black box that ends with a diff. Open a second terminal and run:

```bash
npx modelguild watch
```

It tails what the external model is doing **as it happens** — which files it read, what it grepped, what it fetched, what it edited, which shell commands it ran — for every guild call, read paths included. With no arguments it follows the newest run, so you can start it *before* the call; `--run ID` pins one run, `--no-follow` prints what is already there and exits, `--json` gives you the raw lines, and `--approve` additionally lets this terminal answer gated tool calls (see below).

The same trace is written to `modelguild/logs/<run_id>/activity.jsonl` and summarised on each tool result (`structuredContent.activity`: counts by tool, files edited, errors, the first few actions), so Claude can tell you "it ran 14 tool calls, 3 of them shell, and edited 5 files" instead of only handing you a diff.

- **It is visibility, not containment.** Seeing a command scroll past does not gate it — nothing here asks your permission before the model acts. The diff review is still the review point.
- **It is not the receipts either.** These lines are opencode's report of the model's *actions*, at opencode's fidelity. The model's actual *words* are in `calls.jsonl` (below).
- **If the stream drops, it says so.** `activity.degraded` is set on the result, so a quiet trace is never mistaken for a quiet model.
- **Knobs:** `GUILD_ACTIVITY=off` turns it off entirely; `GUILD_ACTIVITY_DETAIL=full` records each event's raw payload, which can include file contents the model read — same sensitivity trade-off as `GUILD_LOG_PROMPTS=full`. Both live in `modelguild/modelguild.conf.local`.

## Answer before it acts (opt-in, off by default)

Watching is not gating. If you want the model to **ask first**, arm the approval bridge — it moves the chosen tools to `ask` for that one session, and each request comes to you before opencode runs it.

```bash
# in modelguild/modelguild.conf.local (or as env vars for one session)
GUILD_APPROVE=write          # off (default) | write | all
GUILD_APPROVE_TIMEOUT_MS=120000
```

- `write` gates `edit`/`write`/`patch` on `/guild:delegate`. `all` also gates `bash`.
- **Approving `bash` approves a *shell*, not a diff.** That command can read any file, reach the network, and start processes that never ask you again. This buys **attention and an interrupt**, not containment — the diff review is still the review point. If that trade isn't worth it to you, leave it off; that is why it *is* off.
- **You must be able to answer, or the call is refused up front.** Run `npx modelguild watch --approve` in another terminal (same project) before the call. Without a live one — or an MCP client that can prompt you itself — the tool refuses rather than arming, because an unanswered request doesn't fail safe under `opencode serve`: it *hangs* the turn. (A headless `claude -p` auto-cancels its own prompt in milliseconds; that cancel defers to your terminal when one is live, so it can't close your window before you see it.)
- **It only ever gates what the agent could already do.** The gated set is the intersection with the agent definition's own allow-set, read from the file in force — so it can never put a tool your definition *denies* in front of you as something approvable. Prompts show one request at a time; a second arriving while you're deciding is announced immediately, and its own clock is already running.
- **No answer in time ⇒ rejected.** The model is told why and carries on; it is not aborted. A rejected mid-sequence edit can leave a partial change set, which the delegate snapshot still captures and `capture.recoveryHint` still recovers.
- **If the bridge loses opencode's event stream, it rejects what's open and goes looking for the rest when the stream comes back.** Open requests are rejected on the spot and the result is marked `degraded`. A request the model raises while the bridge is blind can't arrive on the stream at all — there's no replay — so on reconnect the bridge asks opencode what's still waiting and puts it to you then, with its clock starting there. What that fixes is the pause: a stall of seconds rather than the turn's own 15-minute timeout. What it doesn't do is promise nothing was missed — opencode only lists what's still *open*, so a request that got answered another way while the bridge was blind leaves no trace, and `blindWindows` on the result is there to tell you a window happened even after `degraded` clears. Nothing runs in the meantime either way: a blind bridge is a long pause, never something slipping past the prompt. A `degraded` run showing no requests means the gate stopped seeing, not that the model stopped asking.
- **If your "yes" doesn't get through, the result says so.** opencode refuses a reply to a request it has already settled — which is what a healthy race looks like when your terminal and your MCP client both answer, and also what a *broken* approval path would look like. So whenever opencode refuses a reply — whatever the status, not just a 404 — the bridge asks a second question: is that request still open? Still open means nobody's decision landed, and it shows up as `unsettled` on the result with a plain-language reason, instead of as a stall you have to guess at. (`unsettled` also covers the rarer case where opencode *accepted* the reply and it still did not take effect; a reply merely still in flight is never counted as one.) Refused with nothing left open is `contested` if it was a 404 (the race) and `refused` otherwise — reported, not diagnosed; only a reply that never reached opencode at all is `undelivered`. Each request lands in exactly one of those four. (The endpoint that delivers an *approval* is the one opencode has marked deprecated; when it goes, approvals will fail while rejections keep working, and that is the failure this exists to name — it need not present as a 404, which is why the check is not keyed on one.) It will not quietly convert your approval into a rejection to get the turn moving again.
- **Claude cannot approve on your behalf.** There is no tool argument that grants approval — the decision only ever comes from your terminal or your MCP client's own prompt.
- **Web egress on the read paths** can be gated separately with `GUILD_APPROVE_EGRESS=ask` (also off by default), which puts `webfetch`/`websearch` behind the same prompt for `/guild:consult`, `/guild:panel`, `/guild:research` and friends. It exists because reads on those paths leave your machine for a third-party model — the one asymmetry between them and a Claude subagent that this project treats as real.
- A session's ruleset is fixed when the session is created, so turning the knob on mid-conversation doesn't retro-gate an existing session: continuing one that wasn't created gated is **refused** (`approval-not-applied`), not silently run ungated.

## The record it keeps

Every model call is logged to `modelguild/logs/<run_id>/calls.jsonl` as three lifecycle entries sharing one `call_id`: `expected-call` before capture setup, `started` before execution, and `completed` after it. Three calls produce nine lifecycle entries. The record includes the exact prompt sent, the model's full untruncated answer, model, agent, and exit status. It's git-ignored and stays on your machine.

This is **receipts**. When Claude tells you "GPT-5 agreed with my approach", that summary is written by the party you'd be checking up on — the log is the other model's *actual words*, on disk and yours to read, so you can check them yourself, diff them against Claude's account, or keep them for later. It's a plain local file, governed by the privacy knobs below. It earned its keep finding real bugs during this project's own development.

- **See it:** `cat modelguild/logs/latest/calls.jsonl | jq`. Verification (built into the server's evidence layer) checks lifecycle cardinality in both directions, capture completeness, referenced artifacts, every entry's self-hash, and the chain; setup failures and mid-flight gaps do not pass as clean.
- **Privacy:** by default the log keeps the full prompt, which means whatever context Claude pasted in from your repo. Set `GUILD_LOG_PROMPTS=hash` (keep a digest, not the text) or `off` in `modelguild/modelguild.conf.local` if that's not OK for your work. Runs older than 14 days are pruned automatically (`GUILD_LOG_RETENTION_DAYS`), when the MCP server starts and again at each new run; `GUILD_LOG=off` turns the whole thing off (and, because you may have turned it off to freeze what's on disk, also stops the automatic pruning).
- **Clean it up by hand:** `npx modelguild logs clean --dry-run` lists the runs past the window, their age and their size; drop `--dry-run` to delete them, or pass `--days N` for a one-off window. Mostly you won't need it — it's there for when you want the space back now, or want to see what retention is actually doing before trusting it. If retention is disabled or misspelled it refuses instead of guessing: no window is never read as "delete everything".
- **What it is not:** tamper-proofing. The hashes catch accidental corruption; they're not a chain of custody, and anything that can write the log can rewrite them.

## Troubleshooting

- **`npx modelguild …` says "package not found".** `modelguild` is published to npm, so check spelling and your network (or a stale npm cache — `npm cache verify`). If you're intentionally running an unreleased build, use the from-source path instead: `npm run build` in the checkout, then `node dist/cli.js init --dir <project>` (see [docs/setup.md § From source](setup.md#from-source-contributors-or-to-run-an-unreleased-build)).
- **The `/guild:*` commands don't appear in Claude Code.** Restart Claude Code — it only reads its MCP registrations at session start ([Setup step 4](setup.md#4-restart-claude-code)). Still missing? Confirm the server is registered — `claude mcp get modelguild` (any scope) — and run `doctor` ([step 5](setup.md#5-verify)) to check registration and payload.
- **A `guild_*` tool call errors about opencode.** opencode isn't installed on PATH or isn't authenticated. Run `opencode auth login`, and `opencode models` to confirm at least one provider answers. If you built locally and moved the checkout, the launch `args` path is stale — re-run `claude mcp add` (or edit the registration) with the new path.
- **A model is denied / not allowed.** That's the model policy. Run `/guild:configure`, or edit `models.policy.local` ([Setup step 6](setup.md#6-configure-which-models-it-uses)). Remember the policy is **layered** — the rule denying it may live in your *global* root even though you're in a project; `doctor` prints the whole chain, and the error names the exact file that decided.
- **Not sure what's wrong.** Run `doctor` — it reports each check with `✓`/`✗` and needs no model call.

### Common failures by name

A refused or stalled call names its failure. Search for the name you were given:

| Name | What it means | Detail |
|---|---|---|
| `agent-def-missing` | The hardened agent def isn't in a directory opencode resolves from, and the tool refuses rather than falling back to an unrestricted agent. Re-run `init`. | [SECURITY.md](../SECURITY.md#what-is-guaranteed-and-how) |
| `agent-unhardened` | The def file is there, but opencode did not resolve its permission floor (usually frontmatter opencode can't parse). Fixing the def is not enough — a running `opencode serve` never re-reads it, so you need a fresh one. | [SECURITY.md](../SECURITY.md#what-is-guaranteed-and-how) |
| `worktree-invalid` | The `worktree` path passed to a command isn't in `git worktree list` for this repository. Refused by name rather than silently falling back to the project root. | [CONTRACT.md § C](../CONTRACT.md#c-agent-selection) |
| `approval-not-applied` | The approval bridge is armed but the session's `ask` ruleset isn't in force — typically continuing a session created before you armed it. Refused rather than run ungated. | [Answer before it acts](#answer-before-it-acts-opt-in-off-by-default) |
| `empty-answer` | A read-path turn produced no answer at all. Refused rather than returned as a blank success. | [CONTRACT.md § D](../CONTRACT.md#d-evidence-layer) |
| `empty-delegation` | A delegation produced nothing on any channel — no report **and** no tool calls. Usually a provider rejecting a model id your auth lists but can't actually reach. An empty report on its own is *not* this: the answer is the patch, and a silent turn that ran commands did work too. | [CONTRACT.md § D](../CONTRACT.md#d-evidence-layer) |
| `policy-deny` / `policy-ask` | Your model policy denies this model, or gates it behind your approval and you weren't asked. Edit it with `/guild:configure`. | [Model policy](configuration.md#model-policy) |
| `model-id` | The `provider/model` id is malformed. `npx modelguild doctor` and `guild_models` list what your auth actually reaches. | [Picking the model](configuration.md#picking-the-model) |
| `agent-mismatch` | opencode served the turn with a different agent than the one asked for. | [SECURITY.md](../SECURITY.md#other-guardrails) |
| `approval-config` / `approval-channel-missing` | `GUILD_APPROVE` has an unrecognised value, or the bridge is armed with no way to ask you. Refused up front rather than hanging the turn. | [Answer before it acts](#answer-before-it-acts-opt-in-off-by-default) |
| `unsettled` / `contested` / `refused` / `undelivered` | How an approval reply that didn't land is reported. `unsettled` means nobody's decision took effect and the request is still open — that is the one that explains a hung call. | [Answer before it acts](#answer-before-it-acts-opt-in-off-by-default) |
