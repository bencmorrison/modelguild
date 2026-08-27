# Setup — install, register, verify, update, uninstall

Exactly what you do, start to finish, plus every variant off the happy path. Back to [README.md](../README.md).

- [The seven steps](#the-seven-steps)
- [Installation variants](#installation-variants) — from source, `--global`, registering by hand
- [Global vs project config](#global-vs-project-config)
- [Keeping it up to date](#keeping-it-up-to-date) — updating, upgrade drift, payload skew
- [Uninstall](#uninstall)

## The seven steps

> **Installing from source, globally, or into a repo you don't control?** → **[Installation variants](#installation-variants)** covers the from-source build, `init --global`, registering by hand, and `--write-mcp`. The seven steps below are the npm happy path; step 2 hands you `npx modelguild init`, which is the wrong command if you are running an unreleased build.

**(1)** prerequisites, **(2)** install the payload (`init`), **(3)** register the MCP server yourself, **(4)** restart Claude Code so it loads it, **(5)** verify, **(6)** configure which models it uses, **(7)** run a first consult. Steps 2 and 3 are **separate**: `init` copies the command docs / agent defs / policy template but **does not touch `.mcp.json`** — *you* register the server (step 3), so you choose global vs per-project scope. Step 6 configures *which models* it uses. You want all of them.

### 1. Prerequisites

- **[Node.js](https://nodejs.org) 20 or newer** (ships with `npm`/`npx`) — ModelGuild is a TypeScript CLI + MCP server; you need Node to build and run it.
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

```bash
cd /path/to/your/project
npx modelguild init
```
Or the one-liner bootstrap (a thin `install.sh` that runs `npx modelguild init` for you, for the classic `curl | bash` habit):
```bash
curl -fsSL https://raw.githubusercontent.com/bencmorrison/modelguild/main/install.sh | bash
```
The bootstrap installs into the current directory; pass `-s -- --dir /path/to/project` to target another. Pin a version with `-s -- --ref 0.7.1` (or `MODELGUILD_REF=0.7.1`).

Building from a checkout instead, or installing once for every project? → [From source](#from-source-contributors-or-to-run-an-unreleased-build), [Global install](#global-install-all-projects).

### 3. Register the MCP server yourself

`init` deliberately leaves `.mcp.json` alone so **you** pick the scope. Register the `modelguild` server with Claude Code's CLI — `-s` chooses the scope:

- **`-s user`** — global: available in *all* your projects (written to `~/.claude.json`). The server resolves the active project from its working directory, so one global registration works everywhere.
- **`-s project`** — committed to *this* repo's `.mcp.json` (shared with anyone who clones it).
- **`-s local`** — this project only, private to you (not committed).

```bash
claude mcp add modelguild -s user -- npx -y modelguild serve
```

**The MCP server key must be exactly `modelguild`** — the slash commands grant `mcp__modelguild__*` and won't find the tools under any other key.

Registering a source build, pasting the block by hand, letting `init` write it (`--write-mcp`), or deciding whether to commit `.mcp.json` → [Installation variants](#installation-variants).

### 4. Restart Claude Code

Claude Code reads its MCP registrations **at session start**, so it will not see the server you just registered until you restart it in that project. Quit and reopen Claude Code (or start a fresh session) in `/path/to/your/project`.

### 5. Verify

Run the token-free `doctor` — it checks opencode is present (and warns if it finds no credentials), the MCP registration, the agent defs, and the policy, without calling any model:
```bash
npx modelguild doctor --dir /path/to/your/project
```
What a healthy run prints is [below](#a-healthy-doctor-run).

If the `claude` CLI isn't on PATH, `doctor` can't see a global registration and instead reports a warning (not a failure) telling you to verify with `claude mcp get modelguild`. Inside the restarted Claude Code, the `/guild:*` commands now appear in the slash-command list and the `guild_*` MCP tools are available. **The first time** Claude Code calls one, it asks a one-time permission for that tool (e.g. `mcp__modelguild__guild_consult`) — approve it (see [Skip the permission prompts](configuration.md#skip-the-permission-prompts) to pre-approve them all).

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

Prefer a **non-Claude** model for consults so the second opinion is genuinely independent. This step is optional — without it, commands use opencode's default model — but setting a policy and defaults is what makes day-to-day use smooth. The full detail is in [docs/configuration.md](configuration.md).

### 7. Run a first consult

Step 5 is token-free by design: `doctor` never logs in and never queries a provider. It does check whether opencode has any credentials at all — and warns when it finds none — but it cannot tell you whether those credentials are still **valid**, whether the provider is reachable, or whether the model you picked will answer. It also can't see a provider configured directly in `opencode.json`, so it stays quiet in some working setups and warns in others. The only thing that proves the whole path is a real call, so make a small one inside Claude Code:

```
/guild:consult In one sentence, what is a git worktree?
```

The first time it runs, Claude Code asks the one-time tool permission step 5 mentions (`mcp__modelguild__guild_consult`) — approve it. If the call then fails with an auth or provider error, the install is fine and the auth is not: re-run `opencode auth login`, and `opencode models` to see what your auth actually offers.

## Installation variants

### From source (contributors, or to run an unreleased build)

This replaces step 2 (`npx modelguild init`). Clone and build the CLI once:
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

Registering a source build needs a different launch line too — see [Register a source build](#register-a-source-build). Step 5's `doctor` has a source form as well:
```bash
node /path/to/modelguild/dist/cli.js doctor --dir <project>
```

### Global install (all projects)

Instead of installing into each project, install the payload **once** into your global config so `/guild:*` and the hardened agents work in **every** project:
```bash
npx modelguild init --global
# node dist/cli.js init --global      # from a source build
```
This is the payload analogue of a user-scoped MCP registration. It places the same files, only at global locations:
- **Commands** → `~/.claude/commands/guild/*.md` (Claude Code reads user-level slash commands from `~/.claude/commands/`, so `/guild:*` exists in every project).
- **Agent defs** → the opencode **global** agent dir, `${XDG_CONFIG_HOME:-~/.config}/opencode/agent/guild-*.md` (SINGULAR `agent`; opencode resolves `--agent` there from any project).
- **Policy/config** → `~/.claude/modelguild/` (where the server already falls back to read the policy + config when a project has no local `modelguild/`).

It records ownership in a **separate** record (`~/.claude/modelguild/.modelguild-install.json`), so global and per-project installs never disturb each other. `--global` takes no `--dir` (there is no project target) and writes no `.gitignore` block. Uninstall with `npx modelguild init --uninstall --global`.

**Dotfiles-managed config works.** If `~/.claude` or `${XDG_CONFIG_HOME:-~/.config}/opencode` is a symlink — GNU stow, chezmoi, a hand-rolled `ln -s` — `--global` follows it and the files land in your dotfiles backing store, where you can commit them; the link itself is left alone, and `--uninstall --global` removes them back out through it. If you have symlinked an **individual payload file** (say `commands/guild/consult.md` on its own) — which is the shape GNU stow's `--adopt` leaves behind when you bring an existing install under dotfiles management — `init` does **not** write through the link. It skips that file, naming the link, the file it points at, and what would work; the rest of the payload installs normally. Two things work: update the file in your store yourself, or remove the link and re-run `init`, which then writes an ordinary file at that path (so the dotfiles layout would need re-adopting). **`doctor` keeps reporting that file as out of sync until you do one of them** — it reads *through* the link, as everything at runtime does, so it can see the file is behind the release even though `init` will not update it in place. It says so rather than repeating advice that cannot work. **The one exception is ModelGuild's own ownership record** (`~/.claude/modelguild/.modelguild-install.json`): only `init` ever writes it, so if that path is a symlink the record is written *through* the link rather than skipped — `init` warns and names both the link and the file the bytes landed in, so if you had pointed it at a file of your own you will hear about it. `--uninstall --global` removes the link itself and leaves the file it pointed at where it is (a *dangling* record link is removed too — there is nothing behind it to preserve, and leaving it would strand a broken link in your config; a dangling link at a **payload** path is a different case and is left alone) — either way nothing outside your config tree is deleted. **Uninstall tells you when it does that** — it names the link it removed and the file that is still sitting there, and says either that the file currently holds ModelGuild's record (without guessing whether an install wrote it through the link or the link was pointed at a record already written) or that this run could not read a record behind the link, in which case it makes no claim about what the file holds. Nothing there is deleted for you: if the file was originally yours, restoring it is yours to do. A **per-project** install is stricter: it refuses a **live** symlink anywhere in a destination path — including a symlinked `.claude/` or `.opencode/` — and names the path it refused. A **dangling** link is not refused there: a dangling payload file is skipped like any other non-file, while a dangling *directory* component fails the install with a raw `ENOENT` from `mkdir` rather than a message about symlinks. You still register the MCP server once, globally — step 3 with `-s user`. Verify with `npx modelguild doctor --global` (checks the global locations). Keep the per-project install if you'd rather scope the payload to specific repos.

### Register a source build

If you installed from source, point the registration at your local build instead:
```bash
claude mcp add modelguild -s user -- node /path/to/modelguild/dist/cli.js serve
```
If you move or delete the ModelGuild checkout, re-run this with the new path.

### Register by hand

Any scope, no CLI: paste a `modelguild` block into the relevant `.mcp.json` yourself — for a project-scoped file that's the block `init` prints when it finishes:
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

Whichever route you take, the key must be exactly `modelguild` — see [step 3](#3-register-the-mcp-server-yourself).

### Commit the registration, or gitignore it?

**Your call, by scope.** A `-s project` registration (and `--write-mcp`, below) writes `.mcp.json` **to be committed** — that's the point: everyone who clones the repo gets the server. If instead it's a *personal* local registration (a machine-specific launch path, `-s local`, or a hand-placed file you don't want to share), add `.mcp.json` to your `.gitignore` so a stray `git add -A` can't commit it. `init` does **not** gitignore `.mcp.json` for you — it can't know which of the two you intend. (This repo itself gitignores its own `.mcp.json`, because our dogfood registration is personal and path-specific.)

### Letting init write the registration

**Opt-in shortcut:** if you *want* `init` to write the project `.mcp.json` for you (the old behavior), pass `--write-mcp` — e.g. `npx modelguild init --write-mcp --dir /path/to/your/project`. That writes a project-scoped entry (equivalent to `-s project`) and skips the manual register.

### A healthy doctor run

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
✓ approval bridge: OFF (default) — GUILD_APPROVE=off, GUILD_APPROVE_EGRESS=off; no tool call is gated
✓ no payload skew, no upgrade drift: every installed file matches what this release ships
✓ opencode present (…)
✓ opencode authenticated (1 stored credential(s), 0 provider env var(s))

doctor: OK
```
(The `[found: …]` tag reports whether the payload was located in the project, globally, or a mix. The **layers** line shows the whole config/policy chain that actually binds — see [Global vs project config](#global-vs-project-config) — with `•` for a file that exists and `-` for one that doesn't.)

### Reading the glyphs

A `✗` is a broken piece and sets the exit code; a `!` is something `doctor` couldn't judge, or a state that's behind but working. The registration, payload, agent-def and policy `✗`s have always been failures. Issue #151 added **one new hard failure** and **one new warning**:

- **New hard failure — `✗ opencode not found on PATH …`.** Every guild tool call spawns `opencode serve`, so a missing binary is not a degraded state, it is a broken one. (It used to be a `!` under `doctor: OK`.) Two neighbouring shapes get their own message: a binary that *is* on PATH but whose `--version` fails, and one that can't be executed at all (`✗ could not execute opencode (EACCES) …`) — different problems, different fixes.
- **New warning — `! opencode has NO credentials …`.** `opencode --version` only proves the binary exists, so this line runs `opencode auth list` (token-free, no model call) and counts both credential sources it reports: what `opencode auth login` stored, and provider API-key environment variables. It's a **warning, not a failure**, because the check can't see every working setup: a provider configured directly in `opencode.json` — an `apiKey`, or a local endpoint that needs no credential — is invisible to `opencode auth list` while models answer fine. If you're on one of those, this line is a false alarm and `doctor` still exits OK. If the output can't be read at all, doctor says `! could not determine …` rather than guessing.

Payload skew and upgrade drift are always warnings too — being behind a release is not a broken install, and they never change the exit code.

**What `doctor` still can't tell you:** whether your credentials are *valid* or your provider is *reachable*. It never logs in and never calls a model. [Step 7](#7-run-a-first-consult) is what proves the whole path.

## Global vs project config

Config is **layered**, not either/or. Your global root `~/.claude/modelguild/` is the **baseline**, and a project's own `<repo>/modelguild/` is overlaid **on top** of it:

- **Preferences** (`modelguild.conf.local`) merge key by key. A key set in the project wins; a key you only set globally still applies in that project.
- **Model policy** rules are evaluated **project first, then global**, first match wins, default-allow. So a project can add a stricter `deny` or a looser `allow` without disturbing the rest of your global policy — and a global `deny` keeps binding in every project that doesn't override it.

Set it once globally and it works everywhere; add a project root only when that repo needs something different. (`$GUILD_ROOT` is the exception: it pins **one** root and layers nothing under it — a deliberate escape hatch for fixtures and CI, not a normal setting. `doctor` tells you when it's leaving a real root unlayered.)

## Keeping it up to date

### Updating

Re-run `init` (`npx modelguild init --dir <project>`; from a source build: `node dist/cli.js init --dir <project>`). It's idempotent: it upgrades files you haven't touched (bytes still matching the recorded hash), leaves any file you edited locally alone, and adds new payload files. `init` never touches your MCP registration, so re-running it won't disturb the server you registered in step 3. After a local rebuild (`npm run build`), re-running `init` refreshes the project's payload. There is no separate update mode.

### Upgrade drift

Because `init` never overwrites a file you edited, an upgrade *skips* it — so you can end up running a stale command without noticing. Both `init` and `doctor` tell you:
```
! 1 file(s) you edited are STALE — this release ships a newer version of them, and init never
  overwrites your edits, so your copy stayed behind:
    .claude/commands/guild/consult.md
      diff "<the shipped file>" "<your copy>"
  Keeping your version? Nothing to do. Want the current one? Save your copy, delete the file, and
  re-run `npx modelguild init` (init rewrites a file only while it can prove the file is unedited).
```
It is a **warning, not a failure** — `doctor` still exits OK, because editing a command is a supported thing to do and your file is never touched. If a file differs from the shipped version but no install record covers it (you placed it there by hand, or the record was removed), `doctor` says it *cannot tell* an intentional edit from a stale leftover and names the missing record, rather than guessing.

### Payload skew

The MCP *server* updates itself — your registration runs `npx -y modelguild serve`, which resolves the current release on every launch — but the payload above lives in your repo and does **not** move with it, so you can end up running a new server against last release's commands and agent defs without noticing. When the server starts and finds files that are ours, **unedited**, and different from what it ships, it writes one block to stderr naming them, with the fix **pinned to the version running** (`npx modelguild@<version> init` — plain `npx modelguild init` installs the *latest* payload, which doesn't converge if you're deliberately on an older server; the published versions are listed on the [releases page](https://github.com/bencmorrison/modelguild/releases)). It won't claim which side is older: two hashes can't say, and while normally it's your payload that's behind, a pinned older server puts it ahead. `npx modelguild doctor` (and the `guild_status` tool) report the same thing whenever you ask, alongside files you *edited* that have since fallen behind — those are never overwritten. Neither is a failure: being behind a release doesn't make `doctor` exit non-zero.

The start-up line appears **once per server version and skew state**, not once per session: it fires again when the version changes, or when the set of out-of-sync files it named — or the bytes this server ships for them — changes. That is why a republished version, a moving dist-tag, or a source checkout you keep rebuilding brings it back; a shipped change confined to files you *edited* (that is upgrade drift) or to files with no ownership record does not. What it has already said is recorded in `~/.claude/modelguild/`, or under `$GUILD_ROOT` if you pinned one — so nothing untracked appears in your working tree unless you pointed `$GUILD_ROOT` at a repo yourself (delete that file to be told again). `GUILD_PAYLOAD_NOTICE=off` in `modelguild/modelguild.conf.local` turns the line off entirely — `doctor` keeps reporting either way.

## Uninstall

```bash
npx modelguild init --uninstall --dir /path/to/your/project
# node /path/to/modelguild/dist/cli.js init --uninstall --dir <project>   # if you installed from source
# npx modelguild init --uninstall --global                                # for a --global payload install
```
It removes only the files ModelGuild installed and can still prove it owns (by hash); your own files, config, and `modelguild/logs/` are left in place. The same ownership rule covers `.mcp.json`: uninstall removes the `modelguild` key **only** when it can prove `init` wrote it — a `--write-mcp` install records the entry's hash, and uninstall deletes the key only while it still matches. A registration you made yourself (`claude mcp add`, a hand-placed file), an entry you later edited, or a key from an *older* `--write-mcp` install (predating this ownership record) is **kept** with a warning — it's yours to remove: `claude mcp remove modelguild` (add `-s user`/`-s local`/`-s project` for a non-default scope). Any Claude Code permission grant you added to `.claude/settings*.json` is yours to remove too.
