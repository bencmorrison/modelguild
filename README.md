# ModelGuild

Let **Claude Code** collaborate with **other LLMs** (OpenAI, GitHub Copilot's model stack, Google Gemini, or anything else) for a second opinion, a multi-model panel, code review, or delegated coding — using **[opencode](https://opencode.ai)** as the gateway.

Works in any stdio MCP client. **Claude Code is the first-class — and currently the only — driver** (slash commands + the verify-each-finding workflow); support for other drivers is planned.

Claude Code stays the driver. You add ModelGuild to **your own project**, and Claude gains a few slash commands backed by a small local **MCP server**. opencode handles model access and auth, so this works off **whatever providers your opencode auth gives you — paid subscriptions or free tiers — with no API keys stored or managed by this tool**.

## How it works

Claude Code cannot itself run a non-Anthropic model (its agent and subagents are always Claude). So it calls a **local MCP server** — `modelguild`, a small TypeScript stdio server you register with Claude Code (per-project or global, your choice) — which fronts `opencode serve`, model-agnostic, over its HTTP API:

```
Claude Code  ──(MCP tool call)──▶  modelguild MCP server  ──▶  opencode serve  ──▶  GPT / Copilot / Gemini / …
     ▲                                                                                       │
     └────────────────────  reads the other model's answer, then reasons over it  ───────────┘
```

ModelGuild adds to a project:

| What | Where |
|---|---|
| The `modelguild` MCP server | Registered with Claude Code by you (`claude mcp add`, launched on demand as `npx -y modelguild serve`). It exposes the tools the slash commands call: `guild_consult`, `guild_panel`, `guild_research`, `guild_delegate`, `guild_models`. |
| The slash commands | `.claude/commands/guild/*.md` — thin prompts that drive those tools. They appear as `/guild:consult`, `/guild:panel`, `/guild:workshop`, `/guild:review`, `/guild:research`, `/guild:delegate`, `/guild:collaborate`, `/guild:configure` — so they can't clash with commands you already have. |
| Three **hardened** opencode agents | `.opencode/agent/` — `guild-read` (read-only reviewer + web), `guild-build` (the `/guild:delegate` write path), `guild-research` (the `/guild:research` source-backed path). `opencode serve` enforces their permission maps. |
| The model policy + config template | `modelguild/models.policy` and `modelguild/modelguild.conf.example`. |
| The record | `modelguild/logs/` (git-ignored) — every model call, on disk and yours to read (see [The record it keeps](#the-record-it-keeps)). |

- `guild-read` → read-only **ROLE** for opinions and planning (`/guild:consult`, `/guild:panel`, `/guild:workshop`, `/guild:review`): a default-deny allowlist (`"*": deny` at opencode's permission layer) granting exactly a Claude review subagent's tools — `read` + `grep` + `glob` + `webfetch`/`websearch`; mutation and sub-agent spawning (`task`) are denied. **Not a confidentiality boundary: trusted repos only** — it can read any file including your secrets (`.env`, keys, `.aws`/`.ssh`) and reach the web, so a secret can leave to a third-party model. Verified by `modelguild/verify-guild-read.sh`.
- `guild-build` → can edit files for `/guild:delegate`: same allowlist construction, re-allowing only edit/write/patch/bash; everything else is denied. Because `bash` is allowed those non-mutation denies are defense-in-depth, not a guarantee — **review the diff**. Verified by `modelguild/verify-guild-build.sh`.
- `guild-research` → the source-backed `/guild:research` path: **same allow-set as `guild-read`** (`read` + `grep` + `glob` + web); mutation and `task` denied. Same posture — **not a confidentiality boundary, trusted repos only**. Verified by `modelguild/verify-guild-research.sh`.

## Setup

Exactly what you do, start to finish. It's six steps: **(1)** prerequisites, **(2)** install the payload (`init`), **(3)** register the MCP server yourself, **(4)** restart Claude Code so it loads it, **(5)** verify, **(6)** configure which models it uses. Steps 2 and 3 are **separate**: `init` copies the command docs / agent defs / policy template but **does not touch `.mcp.json`** — *you* register the server (step 3), so you choose global vs per-project scope. Step 6 configures *which models* it uses. You want all of them.

### 1. Prerequisites

- **[Node.js](https://nodejs.org)** (ships with `npm`/`npx`) — ModelGuild is a TypeScript CLI + MCP server; you need Node to build and run it.
- **[opencode](https://opencode.ai)** on your PATH, **authenticated to at least one provider**. The MCP server fronts `opencode serve`, so this is what gives Claude access to other models:
  ```bash
  opencode auth login     # interactive OAuth — subscription or free tier, no API keys stored by this tool
  ```
  Repeat it for each provider you want (OpenAI / ChatGPT, GitHub Copilot, Google Gemini, …). `opencode models` lists what your auth actually offers.
- **[Claude Code](https://claude.com/claude-code)** — the driver. ModelGuild is loaded by Claude Code as a project MCP server.
- A **git repo** for the project you install into, so you can review `/guild:delegate` diffs. Not strictly required for the read-only commands.

**Your own MCP servers:** opencode supports MCP, but ModelGuild's hardened agents will **not** use your MCP tools — every agent is a default-deny allowlist (`"*": deny`), and that floor covers MCP tools too (verified: an agent under the floor can't even see them). To let a delegated model reach an MCP tool you must explicitly allow it in the agent def, and that is a security decision, not a convenience one.

### 2. Install the payload (`init`)

This is what makes the `/guild:*` commands exist. `init` copies the command docs / agent defs / policy template into your project, records each written file's SHA-256, and upgrades or removes a file only while its bytes still match that ownership record — files you edited are left alone. **`init` does not write `.mcp.json`** — that's step 3, and it's yours to do. (When it finishes, it prints the exact register command for step 3.)

#### 2a. Recommended — from npm

```bash
cd /path/to/your/project
npx modelguild init
```
Or the one-liner bootstrap (a thin `install.sh` that runs `npx modelguild init` for you, for the classic `curl | bash` habit):
```bash
curl -fsSL https://raw.githubusercontent.com/bencmorrison/modelguild/main/install.sh | bash
```
The bootstrap installs into the current directory; pass `-s -- --dir /path/to/project` to target another. Pin a version with `-s -- --ref 0.5.0` (or `MODELGUILD_REF=0.5.0`).

#### 2b. From source (contributors, or to run an unreleased build)

Clone and build the CLI once:
```bash
git clone https://github.com/bencmorrison/modelguild.git
cd modelguild
npm install && npm run build      # produces dist/cli.js
```
Then place the payload into **your** project:
```bash
node dist/cli.js init --dir /path/to/your/project
```
(Or `cd /path/to/your/project` first and run `node /path/to/modelguild/dist/cli.js init` — `--dir` defaults to the current directory.)

#### 2c. Global (all projects) — one install, no per-project `init`

Instead of installing into each project, install the payload **once** into your global config so `/guild:*` and the hardened agents work in **every** project:
```bash
npx modelguild init --global
# node dist/cli.js init --global      # from a source build
```
This is the payload analogue of a user-scoped MCP registration. It places the same files, only at global locations:
- **Commands** → `~/.claude/commands/guild/*.md` (Claude Code reads user-level slash commands from `~/.claude/commands/`, so `/guild:*` exists in every project).
- **Agent defs** → the opencode **global** agent dir, `${XDG_CONFIG_HOME:-~/.config}/opencode/agent/guild-*.md` (SINGULAR `agent`; opencode resolves `--agent` there from any project).
- **Policy/config** → `~/.claude/modelguild/` (where the server already falls back to read the policy + config when a project has no local `modelguild/`).

It records ownership in a **separate** record (`~/.claude/modelguild/.modelguild-install.json`), so global and per-project installs never disturb each other. `--global` takes no `--dir` (there is no project target) and writes no `.gitignore` block. Uninstall with `npx modelguild init --uninstall --global`. You still register the MCP server once, globally — step 3 with `-s user`. Verify with `npx modelguild doctor --global` (checks the global locations). Keep the per-project install (2a/2b) if you'd rather scope the payload to specific repos.

### 3. Register the MCP server yourself

`init` deliberately leaves `.mcp.json` alone so **you** pick the scope. Register the `modelguild` server with Claude Code's CLI — `-s` chooses the scope:

- **`-s user`** — global: available in *all* your projects (written to `~/.claude.json`). The server resolves the active project from its working directory, so one global registration works everywhere.
- **`-s project`** — committed to *this* repo's `.mcp.json` (shared with anyone who clones it).
- **`-s local`** — this project only, private to you (not committed).

> **Commit `.mcp.json`, or gitignore it? Your call, by scope.** A `-s project` registration (and `--write-mcp`, below) writes `.mcp.json` **to be committed** — that's the point: everyone who clones the repo gets the server. If instead it's a *personal* local registration (a machine-specific launch path, `-s local`, or a hand-placed file you don't want to share), add `.mcp.json` to your `.gitignore` so a stray `git add -A` can't commit it. `init` does **not** gitignore `.mcp.json` for you — it can't know which of the two you intend. (This repo itself gitignores its own `.mcp.json`, because our dogfood registration is personal and path-specific.)

#### 3a. Recommended — from npm

```bash
claude mcp add modelguild -s user -- npx -y modelguild serve
```

#### 3b. From source — absolute launch line

If you installed from source (2b), point the registration at your local build instead:
```bash
claude mcp add modelguild -s user -- node /path/to/modelguild/dist/cli.js serve
```
If you move or delete the ModelGuild checkout, re-run this with the new path.

**The MCP server key must be exactly `modelguild`** — the slash commands grant `mcp__modelguild__*` and won't find the tools under any other key.

**Hand-written alternative** (any scope, no CLI): paste a `modelguild` block into the relevant `.mcp.json` yourself — for a project-scoped file that's the block `init` prints when it finishes:
```json
{
  "mcpServers": {
    "modelguild": {
      "command": "npx",
      "args": ["-y", "modelguild", "serve"],
      "env": { "GUILD_PROJECT_DIR": "/path/to/your/project" }
    }
  }
}
```
(From a source build instead, use `"command": "node"` with `"args": ["/path/to/modelguild/dist/cli.js", "serve"]`.)

**Opt-in shortcut:** if you *want* `init` to write the project `.mcp.json` for you (the old behavior), pass `--write-mcp` — e.g. `npx modelguild init --write-mcp --dir /path/to/your/project`. That writes a project-scoped entry (equivalent to `-s project`) and skips the manual register.

### 4. Restart Claude Code

Claude Code reads its MCP registrations **at session start**, so it will not see the server you just registered until you restart it in that project. Quit and reopen Claude Code (or start a fresh session) in `/path/to/your/project`.

### 5. Verify

Run the token-free `doctor` — it checks opencode is present, the MCP registration, the agent defs, and the policy, without calling any model:
```bash
npx modelguild doctor --dir /path/to/your/project
# node /path/to/modelguild/dist/cli.js doctor --dir <project>   # if you installed from source
```
`doctor` detects the registration in **any** scope by asking the Claude CLI (`claude mcp get modelguild`), so a global (`-s user`) registration passes even though it isn't in the project `.mcp.json`. Plain `doctor` likewise detects a **global payload install** (`init --global`): it counts the command docs, agent defs, and policy as present if they are found in **either** the project location or the global one (`~/.claude/commands/guild/`, the opencode global agent dir, `~/.claude/modelguild/`) — mirroring how each actually resolves at runtime. You do **not** need `--global` unless you want to check *only* the global locations (an explicit "verify my global install"). A healthy result looks like:
```
✓ MCP server 'modelguild' registered (found via `claude mcp get`, any scope)
✓ 8/8 command docs present in .claude/commands/guild/ or ~/.claude/commands/guild/ [found: project]
✓ 3/3 hardened agent defs present in .opencode/agent/ or ~/.config/opencode/agent/ [found: project]
✓ model policy present (modelguild/models.policy or ~/.claude/modelguild/models.policy) [found: project]
✓ config/policy layers (most-specific first): project /repo/modelguild  →  global ~/.claude/modelguild  →  default-allow
  • local     /repo/modelguild/models.policy.local
  • committed /repo/modelguild/models.policy
  - committed ~/.claude/modelguild/models.policy (absent)
✓ no upgrade drift: every installed file matches the version it was written from
✓ opencode present (…)

doctor: OK
```
(The `[found: …]` tag reports whether the payload was located in the project, globally, or a mix. The **layers** line shows the whole config/policy chain that actually binds — see [Global vs project config](#global-vs-project-config) — with `•` for a file that exists and `-` for one that doesn't.)

**Upgrade drift.** Because `init` never overwrites a file you edited, an upgrade *skips* it — so you can end up running a stale command without noticing. Both `init` and `doctor` now tell you:
```
! 1 file(s) you edited are STALE — this release ships a newer version of them, and init never
  overwrites your edits, so your copy stayed behind:
    .claude/commands/guild/consult.md
      diff "<the shipped file>" "<your copy>"
  Keeping your version? Nothing to do. Want the current one? Save your copy, delete the file, and
  re-run `npx modelguild init` (init rewrites a file only while it can prove the file is unedited).
```
It is a **warning, not a failure** — `doctor` still exits OK, because editing a command is a supported thing to do and your file is never touched. If a file differs from the shipped version but no install record covers it (you placed it there by hand, or the record was removed), `doctor` says it *cannot tell* an intentional edit from a stale leftover and names the missing record, rather than guessing.

If the `claude` CLI isn't on PATH, `doctor` can't see a global registration and instead reports a warning (not a failure) telling you to verify with `claude mcp get modelguild`. Inside the restarted Claude Code, the `/guild:*` commands now appear in the slash-command list and the `guild_*` MCP tools are available. **The first time** Claude Code calls one, it asks a one-time permission for that tool (e.g. `mcp__modelguild__guild_consult`) — approve it (see [Skip the permission prompts](#skip-the-permission-prompts) to pre-approve them all).

### 6. Configure which models it uses

Registering the server (step 3) does not choose *which* models it talks to or what your policy allows — that's this step, and it's separate. Two ways, both effective immediately (no restart):

- **Interactive:** run **`/guild:configure`** inside Claude Code. It asks whether you're configuring **globally** or **for this project**, interviews you, and writes your model policy (deny/ask/allow) and preferred-model defaults to the git-ignored config files.
- **By hand:** edit the two git-ignored files under your chosen root (`~/.claude/modelguild/` for global, `<repo>/modelguild/` for this project only):
  - `models.policy.local` — per-model `deny`/`ask`/`allow` rules (the committed `models.policy` is default-allow).
  - `modelguild.conf.local` (copy from `modelguild/modelguild.conf.example`) — your default single model and panel set:
    ```
    GUILD_MODEL=openai/gpt-5
    GUILD_MODELS=openai/gpt-5 google/gemini-2.5-pro
    ```

Prefer a **non-Claude** model for consults so the second opinion is genuinely independent. This step is optional — without it, commands use opencode's default model — but setting a policy and defaults is what makes day-to-day use smooth.

#### Global vs project config

Config is **layered**, not either/or. Your global root `~/.claude/modelguild/` is the **baseline**, and a project's own `<repo>/modelguild/` is overlaid **on top** of it:

- **Preferences** (`modelguild.conf.local`) merge key by key. A key set in the project wins; a key you only set globally still applies in that project.
- **Model policy** rules are evaluated **project first, then global**, first match wins, default-allow. So a project can add a stricter `deny` or a looser `allow` without disturbing the rest of your global policy — and a global `deny` keeps binding in every project that doesn't override it.

Set it once globally and it works everywhere; add a project root only when that repo needs something different. (`$GUILD_ROOT` is the exception: it pins **one** root and layers nothing under it — a deliberate escape hatch for fixtures and CI, not a normal setting. `doctor` tells you when it's leaving a real root unlayered.)

### Updating

Re-run `init` (`npx modelguild init --dir <project>`; from a source build: `node dist/cli.js init --dir <project>`). It's idempotent: it upgrades files you haven't touched (bytes still matching the recorded hash), leaves any file you edited locally alone, and adds new payload files. `init` never touches your MCP registration, so re-running it won't disturb the server you registered in step 3. After a local rebuild (`npm run build`), re-running `init` refreshes the project's payload. There is no separate update mode.

## Usage

Run these inside Claude Code in a project you've installed into:

| Command | What it does |
|---|---|
| `/guild:consult <question>` | Get a second opinion from another LLM on a plan or approach (read-only). Claude weighs it against its own view. |
| `/guild:panel <question>` | Ask 2–3 different models the same question and have Claude synthesize + break ties. Warns if the panel isn't cross-provider. |
| `/guild:workshop <goal>` | A **multi-LLM planning session**: 2–3 models write independent plans, Claude synthesizes, then those same models **critique Claude's synthesis** before Claude dispositions each point into a final plan. ~2 calls per model. |
| `/guild:review <target>` | Findings-first code review by another model, then Claude verifies each finding against the code before reporting. Target a path, the diff, or a branch. |
| `/guild:research <question>` | Source-backed investigation by a **web-capable** model, then Claude fetches the cited sources and verifies each claim before reporting. Fabricated citations get refuted, not repeated. |
| `/guild:delegate <coding task>` | Hand a coding task to another model (it edits files), then Claude reviews the diff. |
| `/guild:collaborate <question>` | Bounded multi-turn peer exchange with another model; Claude dispositions each point (read-only). |
| `/guild:configure` | Interactive setup: writes your model policy and preferred-model defaults to git-ignored config files. |

Examples:
```
/guild:consult Is an actor the right concurrency model here, or should I use a serial queue?
/guild:panel What's the best migration path off Core Data for this app?
/guild:review the uncommitted diff
/guild:delegate Add bounds checking to the ring buffer in src/buffer.c and a test
```

### Picking the model

To see the exact provider/model ids your auth offers, ask Claude to run the `guild_models` tool (or run `opencode models` yourself). Pass a specific model to any command; omit it to use your configured default.

To set **persistent defaults** — a default single model for `/guild:consult` and a default panel set for `/guild:panel` — run **`/guild:configure`** (it walks you through it, including whether to set them globally or per project — see [Global vs project config](#global-vs-project-config)), or copy `modelguild/modelguild.conf.example` to `modelguild.conf.local` in your chosen root (git-ignored) and set:
```
GUILD_MODEL=openai/gpt-5
GUILD_MODELS=openai/gpt-5 google/gemini-2.5-pro
```
These take effect immediately — no restart. (The matching env vars still work as one-off overrides; precedence is arg → env → project config file → global config file → opencode's default.) Prefer a **non-Claude** model for consults so the second opinion is genuinely independent.

If a heavy task on a slow reasoning model aborts with *"operation was aborted due to timeout"* — e.g. a whole-repo review or a long planning session — raise the per-turn HTTP timeout (default 15 minutes) in the same file:
```
GUILD_MESSAGE_TIMEOUT_MS=1800000
```
Only the model-turn call uses it; the fast control-plane calls keep their own short timeout. A value of 0, negative, or non-numeric falls back to the default; the literal `max` uses the longest timeout Node can honour (~24.8 days). This is the default — for a single long-running call, the assistant can also pass a `timeoutMs` (a number of ms, or `"max"`) directly to `guild_consult`/`guild_panel`/`guild_research`/`guild_delegate`, which overrides it for that call.

## Troubleshooting

- **`npx modelguild …` says "package not found".** `modelguild` is published to npm, so check spelling and your network (or a stale npm cache — `npm cache verify`). If you're intentionally running an unreleased build, use the from-source path instead: `npm run build` in the checkout, then `node dist/cli.js init --dir <project>` (see [Setup step 2b](#2b-from-source-contributors-or-to-run-an-unreleased-build)).
- **The `/guild:*` commands don't appear in Claude Code.** Restart Claude Code — it only reads its MCP registrations at session start (Setup step 4). Still missing? Confirm the server is registered — `claude mcp get modelguild` (any scope) — and run `doctor` (step 5) to check registration and payload.
- **A `guild_*` tool call errors about opencode.** opencode isn't installed on PATH or isn't authenticated. Run `opencode auth login`, and `opencode models` to confirm at least one provider answers. If you built locally and moved the checkout, the launch `args` path is stale — re-run `claude mcp add` (or edit the registration) with the new path.
- **A model is denied / not allowed.** That's the model policy. Run `/guild:configure`, or edit `models.policy.local` (Setup step 6). Remember the policy is **layered** — the rule denying it may live in your *global* root even though you're in a project; `doctor` prints the whole chain, and the error names the exact file that decided.
- **Not sure what's wrong.** Run `doctor` — it reports each check with `✓`/`✗` and needs no model call.

## Safety

ModelGuild has real, verifiable guardrails — but it is **not a sandbox**. Use it on trusted repositories. See **[SECURITY.md](SECURITY.md)** for the full threat model; the essentials:

- **Read-only commands (`/guild:consult`, `/guild:panel`, `/guild:workshop`, `/guild:review`, `/guild:collaborate`)** run under a default-deny allowlist agent with a review subagent's tools — read, grep/glob, and the web; it cannot mutate, shell out, or spawn subagents. It is **not a confidentiality boundary**: it can read any repo file **including your secrets** and reach the network, so a secret can leave to a third-party model. **Trusted repos only.** Proven by `modelguild/verify-guild-read.sh`.
- **`/guild:research` is the source-backed web path.** Same read + web exposure and same "trusted repos only" posture; its value is the workflow requiring citations and Claude verification. Proven by `modelguild/verify-guild-research.sh`.
- **`/guild:delegate` can edit files and run shell.** Its non-mutation restrictions are defense-in-depth, not a guarantee (a coding task needs `bash`, and `bash` can reach around them), so **the trust boundary is you reviewing the diff.** The tool snapshots the worktree first and records the model's patch separately, so dirty worktrees are allowed.
- **External model output is treated as data, not instructions** — a consulted model can't smuggle commands into Claude's control flow.
- Run `doctor` (step 5 of [Setup](#setup)) to check your setup before relying on any of this.

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

### Answer before it acts (opt-in, off by default)

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
- **Claude cannot approve on your behalf.** There is no tool argument that grants approval — the decision only ever comes from your terminal or your MCP client's own prompt.
- **Web egress on the read paths** can be gated separately with `GUILD_APPROVE_EGRESS=ask` (also off by default), which puts `webfetch`/`websearch` behind the same prompt for `/guild:consult`, `/guild:panel`, `/guild:research` and friends. It exists because reads on those paths leave your machine for a third-party model — the one asymmetry between them and a Claude subagent that this project treats as real.
- A session's ruleset is fixed when the session is created, so turning the knob on mid-conversation doesn't retro-gate an existing session: continuing one that wasn't created gated is **refused**, not silently run ungated.

## The record it keeps

Every model call is logged to `modelguild/logs/<run_id>/calls.jsonl` as three lifecycle entries sharing one `call_id`: `expected-call` before capture setup, `started` before execution, and `completed` after it. Three calls produce nine lifecycle entries. The record includes the exact prompt sent, the model's full untruncated answer, model, agent, and exit status. It's git-ignored and stays on your machine.

This is **receipts**. When Claude tells you "GPT-5 agreed with my approach", that summary is written by the party you'd be checking up on — the log is the other model's *actual words*, on disk and yours to read, so you can check them yourself, diff them against Claude's account, or keep them for later. It's a plain local file, governed by the privacy knobs below. It earned its keep finding real bugs during this project's own development.

- **See it:** `cat modelguild/logs/latest/calls.jsonl | jq`. Verification (built into the server's evidence layer) checks lifecycle cardinality in both directions, capture completeness, referenced artifacts, every entry's self-hash, and the chain; setup failures and mid-flight gaps do not pass as clean.
- **Privacy:** by default the log keeps the full prompt, which means whatever context Claude pasted in from your repo. Set `GUILD_LOG_PROMPTS=hash` (keep a digest, not the text) or `off` in `modelguild/modelguild.conf.local` if that's not OK for your work. Runs older than 14 days are pruned automatically (`GUILD_LOG_RETENTION_DAYS`), when the MCP server starts and again at each new run; `GUILD_LOG=off` turns the whole thing off (and, because you may have turned it off to freeze what's on disk, also stops the automatic pruning).
- **Clean it up by hand:** `npx modelguild logs clean --dry-run` lists the runs past the window, their age and their size; drop `--dry-run` to delete them, or pass `--days N` for a one-off window. Mostly you won't need it — it's there for when you want the space back now, or want to see what retention is actually doing before trusting it. If retention is disabled or misspelled it refuses instead of guessing: no window is never read as "delete everything".
- **What it is not:** tamper-proofing. The hashes catch accidental corruption; they're not a chain of custody, and anything that can write the log can rewrite them.

## Uninstall

```bash
npx modelguild init --uninstall --dir /path/to/your/project
# node /path/to/modelguild/dist/cli.js init --uninstall --dir <project>   # if you installed from source
```
It removes only the files ModelGuild installed and can still prove it owns (by hash); your own files, config, and `modelguild/logs/` are left in place. The same ownership rule covers `.mcp.json`: uninstall removes the `modelguild` key **only** when it can prove `init` wrote it — a `--write-mcp` install records the entry's hash, and uninstall deletes the key only while it still matches. A registration you made yourself (`claude mcp add`, a hand-placed file), an entry you later edited, or a key from an *older* `--write-mcp` install (predating this ownership record) is **kept** with a warning — it's yours to remove: `claude mcp remove modelguild` (add `-s user`/`-s local`/`-s project` for a non-default scope). Any Claude Code permission grant you added to `.claude/settings*.json` is yours to remove too.

## Skip the permission prompts

The first time Claude Code calls a ModelGuild MCP tool it asks for permission. Choosing "yes, and don't ask again" persists that tool (e.g. `mcp__modelguild__guild_consult`) into your project's `.claude/settings.local.json` (git-ignored) — per tool, per project, across sessions. Worst case is a handful of one-time prompts. To pre-approve them all up front, add the tool names to `.claude/settings.local.json`:
```json
{
  "permissions": {
    "allow": [
      "mcp__modelguild__guild_consult",
      "mcp__modelguild__guild_panel",
      "mcp__modelguild__guild_research",
      "mcp__modelguild__guild_delegate",
      "mcp__modelguild__guild_models"
    ]
  }
}
```

## Notes & limits

- **Cost**: calls run against your opencode-authenticated providers; usage counts against those plans (free tiers included). `opencode stats` shows token usage/cost.
- **Not just for coding**: `/guild:consult` and `/guild:panel` are great for planning and design reviews, which is often where a second model helps most.
- **Always review `/guild:delegate` diffs** — that human review is the trust boundary for the write path.

## Bugs & feedback

Found a bug, hit a rough edge, or want to suggest something? Please open a **[GitHub issue](https://github.com/bencmorrison/modelguild/issues)**.

What helps most in a bug report:
- The output of `doctor` (`npx modelguild doctor`, or `node <repo>/dist/cli.js doctor` for a source build).
- Which command you ran, and the model it used.
- Your OS. macOS and BSD support is newer and less exercised than Linux, so please say if you're on one.

**Security issues are the exception — do not open a public issue for them.** Report those privately via the [Security tab](https://github.com/bencmorrison/modelguild/security), as described in **[SECURITY.md](SECURITY.md)**. That file also documents what this tool deliberately does *not* guarantee: the read-only agents reach the web by design and can read your secrets, and `/guild:delegate` allows `bash`, so neither is an exfiltration boundary.

## Working on ModelGuild itself

Contributing to ModelGuild (not just using it)? The repo ships a dev container that runs Claude Code and opencode in-container with persistent auth, plus the full TypeScript test suite (`npm test`) and the shell lint/verify scripts. See **[CONTRIBUTING.md](CONTRIBUTING.md)** and **[AGENTS.md](AGENTS.md)**.
