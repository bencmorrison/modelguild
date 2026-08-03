# ModelGuild

Let **Claude Code** collaborate with **other LLMs** (OpenAI, GitHub Copilot's model stack, Google Gemini, or anything else) for a second opinion, a multi-model panel, code review, or delegated coding — using **[opencode](https://opencode.ai)** as the gateway.

Claude Code stays the driver. You add ModelGuild to **your own project**, and Claude gains a few slash commands backed by a small local **MCP server**. opencode handles model access and auth, so this works off **whatever providers your opencode auth gives you — paid subscriptions or free tiers — with no API keys stored or managed by this tool**.

Works in any stdio MCP client. **Claude Code is the first-class — and currently the only — driver** (slash commands + the verify-each-finding workflow); support for other drivers is planned.

## Quickstart

Needs [Node.js](https://nodejs.org) 20 or newer, [Claude Code](https://claude.com/claude-code), and [opencode](https://opencode.ai) already on your PATH — details in [Prerequisites](https://github.com/bencmorrison/modelguild/blob/main/docs/setup.md#1-prerequisites).

```bash
opencode auth login
cd /path/to/your/project
npx modelguild init
claude mcp add modelguild -s user -- npx -y modelguild serve
npx modelguild doctor
```

Restart Claude Code, run `/guild:configure` inside it, then try a first `/guild:consult` — `doctor` warns when opencode has no credentials at all, but it calls no model, so that consult is what proves your opencode auth actually works. What each command does, why installing the payload and registering the server are separate steps, and every variant (from source, `--global`, by hand): **[docs/setup.md](https://github.com/bencmorrison/modelguild/blob/main/docs/setup.md)**.

## Contents

- [How it works](#how-it-works) — the architecture, and what gets added to your project
- [Usage](#usage) — the eight `/guild:*` commands
- [Safety](#safety) — the short version; **[SECURITY.md](https://github.com/bencmorrison/modelguild/blob/main/SECURITY.md)** is the full threat model
- **[docs/setup.md](https://github.com/bencmorrison/modelguild/blob/main/docs/setup.md)** — install, register, verify, update, uninstall
- **[docs/configuration.md](https://github.com/bencmorrison/modelguild/blob/main/docs/configuration.md)** — picking models, the policy and config files, timeouts, permission prompts
- **[docs/operations.md](https://github.com/bencmorrison/modelguild/blob/main/docs/operations.md)** — watching a call live, approving before it acts, the evidence log, troubleshooting
- [Notes & limits](#notes--limits) · [Bugs & feedback](#bugs--feedback)
- [Working on ModelGuild itself](#working-on-modelguild-itself) — and **[CONTRIBUTING.md](https://github.com/bencmorrison/modelguild/blob/main/CONTRIBUTING.md)**

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
| The record | `modelguild/logs/` (git-ignored) — every model call, on disk and yours to read (see [The record it keeps](https://github.com/bencmorrison/modelguild/blob/main/docs/operations.md#the-record-it-keeps)). |

## Usage

Run these inside Claude Code in a project you've installed into:

| Command | What it does |
|---|---|
| `/guild:consult <question>` | Second opinion from another LLM on a plan or approach (read-only). Claude weighs it against its own view. |
| `/guild:panel <question>` | Ask 2–3 different models the same question; Claude synthesizes and breaks ties. Warns if the panel isn't cross-provider. |
| `/guild:workshop <goal>` | A **multi-LLM planning session**: 2–3 models write independent plans, Claude synthesizes, then those same models **critique Claude's synthesis** before Claude dispositions each point into a final plan. ~2 calls per model. |
| `/guild:review <target>` | Findings-first code review by another model, then Claude verifies each finding against the code before reporting. Target a path, the diff, or a branch — including a branch checked out in a sibling git worktree, if you pass that worktree's path (without it, reads of the sibling tree are denied). |
| `/guild:research <question>` | Source-backed investigation by a **web-capable** model, then Claude fetches the cited sources and verifies each claim. Fabricated citations get refuted, not repeated. |
| `/guild:delegate <coding task>` | Hand a coding task to another model (it edits files and can run your tooling), then Claude reviews the diff. It can work in a **sibling git worktree** of the same repo when you pass that worktree's path — the change-capture is rooted there too, so the patch you review is of that tree. |
| `/guild:collaborate <question>` | Bounded multi-turn peer exchange with another model; Claude dispositions each point (read-only). |
| `/guild:configure` | Interactive setup: writes your model policy and preferred-model defaults to git-ignored config files. |

Examples:
```
/guild:consult Is an actor the right concurrency model here, or should I use a serial queue?
/guild:panel What's the best migration path off Core Data for this app?
/guild:review the uncommitted diff
/guild:delegate Add bounds checking to the ring buffer in src/buffer.c and a test
```

Pass a specific `provider/model` id to any command, or omit it to use your configured default. `/guild:configure` sets persistent defaults; to see the ids your auth actually offers, ask Claude to run the `guild_models` tool (or run `opencode models` yourself). Prefer a **non-Claude** model for consults so the second opinion is genuinely independent. Model choice, the policy file, and the per-turn timeout are covered in **[docs/configuration.md](https://github.com/bencmorrison/modelguild/blob/main/docs/configuration.md)**.

While a call runs you can [tail what the other model is doing](https://github.com/bencmorrison/modelguild/blob/main/docs/operations.md#watch-it-live) (`npx modelguild watch`), optionally make it [ask before it acts](https://github.com/bencmorrison/modelguild/blob/main/docs/operations.md#answer-before-it-acts-opt-in-off-by-default), and read the [receipts](https://github.com/bencmorrison/modelguild/blob/main/docs/operations.md#the-record-it-keeps) it leaves in `modelguild/logs/`. A refused or stalled call is [named and explained](https://github.com/bencmorrison/modelguild/blob/main/docs/operations.md#common-failures-by-name) on the same page.

## Safety

ModelGuild has real, verifiable guardrails — but it is **not a sandbox**. The read paths (`/guild:consult`, `/guild:panel`, `/guild:workshop`, `/guild:review`, `/guild:collaborate`, `/guild:research`) run under default-deny allowlist agents that cannot mutate your repo or shell out, but they **can read any file including your secrets and reach the web**, so they are not confidentiality boundaries. `/guild:delegate` can edit files and run shell, so **the trust boundary is you reviewing the diff**. External model output is treated as data, not instructions. **Use it on trusted repositories**, and read **[SECURITY.md](https://github.com/bencmorrison/modelguild/blob/main/SECURITY.md)** — the full threat model, what each hardened agent may do, and how each guarantee is verified.

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

**Security issues are the exception — do not open a public issue for them.** Report those privately via the [Security tab](https://github.com/bencmorrison/modelguild/security), as described in **[SECURITY.md](https://github.com/bencmorrison/modelguild/blob/main/SECURITY.md)**. That file also documents what this tool deliberately does *not* guarantee.

## Working on ModelGuild itself

Contributing to ModelGuild (not just using it)? The repo ships a dev container that runs Claude Code and opencode in-container with persistent auth, plus the full TypeScript test suite (`npm test`) and the shell lint/verify scripts. See **[CONTRIBUTING.md](https://github.com/bencmorrison/modelguild/blob/main/CONTRIBUTING.md)** and **[AGENTS.md](https://github.com/bencmorrison/modelguild/blob/main/AGENTS.md)**.
