---
paths:
  - ".opencode/agent/**"
  - "modelguild/verify-guild-*.sh"
  - "modelguild/tests/check-agent-permissions.sh"
---

# Hardened agent defs

Loaded by Claude Code when it touches `.opencode/agent/`, and by opencode on every session through `opencode.json`. The defs are described in [docs/architecture.md](../../docs/architecture.md#the-hardened-agent-defs--opencodeagentguild-md) and proven by `modelguild/verify-guild-*.sh`; the source-level lint is `modelguild/tests/check-agent-permissions.sh`.

- All three defs are allowlists with a `"*": deny` floor and `mode: all`; a denylist, a floor placed after the allows, or a `mode: subagent` silently changes what opencode runs. `check-agent-permissions.sh` pins the shape.
- **A def's frontmatter must be frontmatter opencode can PARSE, and that is a stronger requirement than it sounds** (issue #100). Frontmatter it cannot parse is applied in **no part**. Two shapes are probed to do this and are what `check-agent-permissions.sh` rejects: a **duplicate key** — at top level (`mode`, `permission`, even `description`) *or* nested inside the permission map — and **tab indentation**. Those two are the instances known, **not a closed list**: the condition is the parse, so treat another shape that breaks it the same way.
- **KEEP no-write and no-`task`: that is the read-only ROLE** (the same scoping a Claude reviewer gets; `task` would escape to a write-capable agent), not a floor.
- Before adding **any** restriction to a def, answer the PARITY forcing question in [AGENTS.md § Conventions](../../AGENTS.md#conventions) and run CLAUDE.md's Bias Audit; loosening is the default direction, and a new harness difference needs the maintainer's sign-off.
- After any opencode or agent-def bump, run `bash modelguild/verify-guild-read.sh`, `verify-guild-build.sh` and `verify-guild-research.sh`, then `verify-permission-surface.sh`; they need a logged-in opencode and never run in CI.
- The MCP tools refuse when a def is missing or not in force; never add a fallback to opencode's built-in `build` or `plan` agents.
