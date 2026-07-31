# Installing ModelGuild — variants and maintenance

The six-step happy path — prerequisites, `npx modelguild init`, `claude mcp add`, restart Claude Code, `doctor`, `/guild:configure` — lives in [README.md § Setup](https://github.com/bencmorrison/modelguild/blob/main/README.md#setup). This file holds everything off that path: the from-source build, the global install, registering the MCP server by hand, and what `doctor` tells you when an install falls behind a release.

- [From source (contributors, or to run an unreleased build)](#from-source-contributors-or-to-run-an-unreleased-build)
- [Global install (all projects)](#global-install-all-projects)
- [Register a source build](#register-a-source-build)
- [Register by hand](#register-by-hand)
- [Commit the registration, or gitignore it?](#commit-the-registration-or-gitignore-it)
- [Letting init write the registration](#letting-init-write-the-registration)
- [A healthy doctor run](#a-healthy-doctor-run)
- [Upgrade drift](#upgrade-drift)
- [Payload skew](#payload-skew)

## From source (contributors, or to run an unreleased build)

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

## Global install (all projects)

Instead of installing into each project, install the payload **once** into your global config so `/guild:*` and the hardened agents work in **every** project:
```bash
npx modelguild init --global
# node dist/cli.js init --global      # from a source build
```
This is the payload analogue of a user-scoped MCP registration. It places the same files, only at global locations:
- **Commands** → `~/.claude/commands/guild/*.md` (Claude Code reads user-level slash commands from `~/.claude/commands/`, so `/guild:*` exists in every project).
- **Agent defs** → the opencode **global** agent dir, `${XDG_CONFIG_HOME:-~/.config}/opencode/agent/guild-*.md` (SINGULAR `agent`; opencode resolves `--agent` there from any project).
- **Policy/config** → `~/.claude/modelguild/` (where the server already falls back to read the policy + config when a project has no local `modelguild/`).

It records ownership in a **separate** record (`~/.claude/modelguild/.modelguild-install.json`), so global and per-project installs never disturb each other. `--global` takes no `--dir` (there is no project target) and writes no `.gitignore` block. Uninstall with `npx modelguild init --uninstall --global`. You still register the MCP server once, globally — step 3 with `-s user`. Verify with `npx modelguild doctor --global` (checks the global locations). Keep the per-project install if you'd rather scope the payload to specific repos.

## Register a source build

If you installed from source, point the registration at your local build instead:
```bash
claude mcp add modelguild -s user -- node /path/to/modelguild/dist/cli.js serve
```
If you move or delete the ModelGuild checkout, re-run this with the new path.

## Register by hand

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

Whichever route you take, the key must be exactly `modelguild` — see [README.md § 3. Register the MCP server yourself](https://github.com/bencmorrison/modelguild/blob/main/README.md#3-register-the-mcp-server-yourself).

## Commit the registration, or gitignore it?

**Your call, by scope.** A `-s project` registration (and `--write-mcp`, below) writes `.mcp.json` **to be committed** — that's the point: everyone who clones the repo gets the server. If instead it's a *personal* local registration (a machine-specific launch path, `-s local`, or a hand-placed file you don't want to share), add `.mcp.json` to your `.gitignore` so a stray `git add -A` can't commit it. `init` does **not** gitignore `.mcp.json` for you — it can't know which of the two you intend. (This repo itself gitignores its own `.mcp.json`, because our dogfood registration is personal and path-specific.)

## Letting init write the registration

**Opt-in shortcut:** if you *want* `init` to write the project `.mcp.json` for you (the old behavior), pass `--write-mcp` — e.g. `npx modelguild init --write-mcp --dir /path/to/your/project`. That writes a project-scoped entry (equivalent to `-s project`) and skips the manual register.

## A healthy doctor run

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
(The `[found: …]` tag reports whether the payload was located in the project, globally, or a mix. The **layers** line shows the whole config/policy chain that actually binds — see [Global vs project config](https://github.com/bencmorrison/modelguild/blob/main/README.md#global-vs-project-config) — with `•` for a file that exists and `-` for one that doesn't.)

## Upgrade drift

Because `init` never overwrites a file you edited, an upgrade *skips* it — so you can end up running a stale command without noticing. Both `init` and `doctor` now tell you:
```
! 1 file(s) you edited are STALE — this release ships a newer version of them, and init never
  overwrites your edits, so your copy stayed behind:
    .claude/commands/guild/consult.md
      diff "<the shipped file>" "<your copy>"
  Keeping your version? Nothing to do. Want the current one? Save your copy, delete the file, and
  re-run `npx modelguild init` (init rewrites a file only while it can prove the file is unedited).
```
It is a **warning, not a failure** — `doctor` still exits OK, because editing a command is a supported thing to do and your file is never touched. If a file differs from the shipped version but no install record covers it (you placed it there by hand, or the record was removed), `doctor` says it *cannot tell* an intentional edit from a stale leftover and names the missing record, rather than guessing.

## Payload skew

**And it now tells you when you need to.** The MCP *server* updates itself — your registration runs `npx -y modelguild serve`, which resolves the current release on every launch — but the payload above lives in your repo and does **not** move with it, so you can end up running a new server against last release's commands and agent defs without noticing. When the server starts and finds files that are ours, **unedited**, and different from what it ships, it writes one block to stderr naming them, with the fix **pinned to the version running** (`npx modelguild@<version> init` — plain `npx modelguild init` installs the *latest* payload, which doesn't converge if you're deliberately on an older server; the published versions are listed on the [releases page](https://github.com/bencmorrison/modelguild/releases)). It won't claim which side is older: two hashes can't say, and while normally it's your payload that's behind, a pinned older server puts it ahead. `npx modelguild doctor` (and the `guild_status` tool) report the same thing whenever you ask, alongside files you *edited* that have since fallen behind — those are never overwritten. Neither is a failure: being behind a release doesn't make `doctor` exit non-zero.

The start-up line appears **once per server version**, not once per session; what it has already said is recorded in `~/.claude/modelguild/`, never in your repo, so nothing untracked appears in your working tree (delete that file to be told again). `GUILD_PAYLOAD_NOTICE=off` in `modelguild/modelguild.conf.local` turns the line off entirely — `doctor` keeps reporting either way.
