---
description: Interactively set up your ModelGuild model policy (deny/ask/allow) and preferred models
argument-hint: (interactive — no arguments needed)
allowed-tools: mcp__modelguild__guild_models, Bash(npx modelguild doctor:*), Bash(modelguild doctor:*), Read, Write, Edit
---
Guide the user through configuring ModelGuild's model policy and preferences. This is **interactive** — ASK the user for their choices, don't assume them, and show the result for confirmation before writing anything.

$ARGUMENTS

1. **Pick the TARGET first (global or project).** ModelGuild's config is **layered**: the global root `~/.claude/modelguild/` is the **baseline**, and a project's own `<repo>/modelguild/` is overlaid **on top** of it. Both bind — the project is not a replacement. Ask which they want to write:
   - **global** (`~/.claude/modelguild/`) — applies in **every** project. The right home for "I never want to use model X" and for a default model/panel you want everywhere. Create the directory if it doesn't exist.
   - **project** (`<repo>/modelguild/`) — applies to **this repo only**, layered over the global baseline. The right home for a repo-specific tightening or a preference just for this codebase.
   Say what layering means for their choice, concretely: a preference key set in the project **wins**, a key they leave unset there still comes from global; a policy rule in the project is evaluated **before** the global rules, so it can add a stricter `deny` or a looser `allow` without disturbing the rest of the baseline. If `$GUILD_ROOT` is set in their environment, say so — it is a **single-root override**, so nothing is layered under it and writing to the other root will have no effect until they unset it.

2. **Show what's available.** Call the `guild_models` MCP tool and present the models grouped by provider, so the user picks from what their auth actually offers (`structuredContent.providers` groups them; each provider's `default` is shown too). If it returns `isError` (e.g. not authenticated), tell them to run `opencode auth login` first, then stop.

3. **Explain the model briefly** (one or two lines each):
   - The **policy** has three tiers over glob patterns, **first-match-wins, default-allow**: `deny` (the guild tools hard-refuse it — the call returns `isError`), `ask` (usable only after you confirm — the tool call carries `confirmed: true`, which represents the user's approval, never yours), `allow` (free to use; the default for anything unmatched). It is enforced by every guild tool (`guild_consult`, `guild_panel`, `guild_research`, `guild_delegate`) on each call.
   - **"Preferred" is not a policy tier** — it's your default single model, used by **every single-model tool** when a call names none (`guild_consult`, `guild_research`, `guild_delegate` — so `/guild:consult`, `/guild:review`, `/guild:collaborate`, `/guild:research` and `/guild:delegate`), and your default panel set, used by `guild_panel` (`/guild:panel`, and `/guild:workshop`'s first round). The two don't substitute for each other: a panel never falls back to `GUILD_MODEL`, and a single-model call never draws from `GUILD_MODELS`. These live in a git-ignored config file `modelguild.conf.local` under the target root (as `GUILD_MODEL=` / `GUILD_MODELS=`), which you'll write here so they persist. (The matching env vars still work as one-off overrides.)
   - **Layering, in one line:** policy rules are evaluated project-first then global, first match wins, default-allow; preference keys overlay project-over-global key by key. Nothing in the global root is lost by having a project root.

4. **Interview** (use AskUserQuestion or plain questions; the user may skip any):
   - Models/providers to **deny** — e.g. one they distrust or that's too expensive. Accept exact ids or globs (`openai/*-terra*`, `*-fast`).
   - Models to gate with **ask** — confirm before each use (e.g. the priciest/slowest).
   - Their **preferred default model** — one key (`GUILD_MODEL`) covering every single-model path (`/guild:consult`, `/guild:review`, `/guild:collaborate`, `/guild:research`, `/guild:delegate`), so say that before they pick. For the opinion paths recommend a **non-Claude** model so opinions are independent; mention that the same default also lands on `/guild:delegate`, where an Anthropic model doing the work is a legitimate choice — a per-call `model` still overrides it either way.
   - Their **preferred panel set** for `/guild:panel` (and `/guild:workshop`) — 2–3 ordered ids from **different providers** (`guild_panel` will warn if the set isn't diverse; you can also eyeball the `guild_models` provider grouping to pick across families).
   - **Scope within the chosen target:** personal (written to git-ignored `models.policy.local`, **recommended** — never committed) or shared (edit the committed `models.policy`, which for a **project** target means the whole repo/team gets it). Within one root the `.local` file layers **above** its committed sibling: a personal rule wins for the ids it names, and committed rules keep binding for the ids it doesn't.

5. **Draft and confirm.** Show the exact policy file you'll write and get a yes before writing. Ordering matters (first-match-wins): put `deny` lines above `ask` lines above any broad rule, so a specific rule beats a broad one. Keep the shipped comment header if editing the committed file. Comments start with `#`.

6. **Write it** — into `<TARGET>/`, the root chosen in step 1 (`~/.claude/modelguild/` for global, `<repo>/modelguild/` for project). These are the exact files the TS config resolver reads (`src/config.ts` reads `modelguild.conf.local`; `src/policy.ts` reads the policy files).
   - Personal → write `<TARGET>/models.policy.local` (git-ignored). The effective chain is `$GUILD_POLICY` when set (a single-file override), otherwise project `.local` → project committed → global `.local` → global committed → default-allow, with the **first matching rule anywhere** winning; a `.local` joins the chain only when it has at least one complete rule.
   - Shared → edit `<TARGET>/models.policy` (for a project target, remind them it's committed — everyone gets it).
   - **Preferred models** → write them to `<TARGET>/modelguild.conf.local` (git-ignored; the guild tools read it). Use `modelguild/modelguild.conf.example` as the template. Two lines (omit either if the user didn't pick one):
     ```
     GUILD_MODEL=<their pick>
     GUILD_MODELS=<id1> <id2> <id3>
     ```
     These take effect immediately (no restart needed) — that's the point of using a file. Do NOT print `export` lines; the file is the durable home now.
   - **Note on the guild root:** resolution is layered — `<cwd>/modelguild/` over `~/.claude/modelguild/`, most-specific first, both binding. `$GUILD_ROOT` overrides that with a **single** root (nothing layered under it). Writes from ModelGuild itself (the evidence log's `logs/`) always go to the most-specific root.

7. **Validate.** Run `npx modelguild doctor` (or `modelguild doctor` if it's on PATH) — a token-free check that the MCP server is registered, the command docs and hardened agent defs are present, the model policy file exists, and — the part that matters here — the **layered config/policy chain**, printed most-specific first with a presence marker per file. Check the file you just wrote appears in that chain. Then confirm intent yourself:
   - The policy is **first-match-wins across the whole chain, default-allow**, and takes effect immediately — re-read the file you wrote AND the other layer's files, then walk the user through which of their models land in `deny` / `ask` / `allow` once both layers are applied. Do not describe the project layer as if it were the only one.
   - If you set a panel, sanity-check that its members come from **different providers** (single-provider sets are "diversity theater"); `guild_panel` will also surface a warning at call time.
   Report what you verified.

8. **Summarize** what you wrote and where — name the **target root** explicitly (global `~/.claude/modelguild/` or project `<repo>/modelguild/`), the files (`models.policy.local` for the policy, `modelguild.conf.local` for preferred models — both git-ignored, both effective immediately), and one line on what the *other* layer still contributes. Keep it short.
