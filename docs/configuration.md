# Configuration — models, policy, timeouts, prompts

Everything you can set, and where it lives. Back to [README.md](../README.md).

- [Picking the model](#picking-the-model)
- [Native Codex workers](#native-codex-workers)
- [Persistent defaults](#persistent-defaults)
- [Model policy](#model-policy)
- [Timeouts](#timeouts)
- [Skip the permission prompts](#skip-the-permission-prompts)

Most of what follows lives in two files under your chosen **guild root** — `~/.claude/modelguild/` for global, `<repo>/modelguild/` for one project: `modelguild.conf.local` (preferences and knobs) and `models.policy.local` (per-model rules). Both are **git-ignored** and both take effect **immediately — no restart**; roots are layered, so see [Global vs project config](setup.md#global-vs-project-config). The exceptions are named where they appear: the committed `models.policy` is tracked, not git-ignored, and [Skip the permission prompts](#skip-the-permission-prompts) is a Claude Code setting in a different file entirely.

## Picking the model

To list model IDs, ask your driver to run `guild_models`: `backend: "opencode"` is the default; `"codex"` lists native Codex models; `"both"` combines them. Listing is configuration/catalog information, not proof that a model call will succeed. `opencode models` lists only the opencode route. Pass a specific model to any command; omit it to use your configured default.

For independent opinions, prefer a different model family from the actual driver when choosing models. Honor explicit model choices and persistent defaults. A hosting provider can serve several families; provider diversity alone does not establish model diversity (issue #225).

## Native Codex workers

The reserved `codex/` prefix selects a runtime: `codex/<native-model>` runs through
Codex App Server. It is not a provider or model-family claim. All other
`provider/model` IDs keep the opencode route, and policy rules match the full ID
including the prefix. Both types can appear in `GUILD_MODEL` and `GUILD_MODELS`.
A custom opencode provider named `codex` collides with this reserved namespace;
the catalog omits it with a warning to rename that provider.

Codex inherits its normal user/project configuration and login. ModelGuild sends
the selected model and caller's task prompt; it does not override the native
sandbox or approval policy to emulate opencode's hardened agents. A read-only request
in a workflow or task prompt remains an instruction, not a native permission fence. Results report
Codex's echoed policy and configured model/provider. Choose native settings in Codex's
configuration, not in an opencode agent definition.

ModelGuild's `GUILD_APPROVE` and `GUILD_APPROVE_EGRESS` gates currently require
opencode's verifiable per-session rules. A native Codex call with either gate enabled
refuses before running; native approval policy does not silently substitute for an
explicitly requested ModelGuild gate. Nonempty `readPaths` also refuses for Codex:
the adapter cannot attach and verify those scoped grants. Configure native access
through Codex instead; omitting `readPaths` is not a claim that external reads are fenced.

## Persistent defaults

To set a default single model for `/guild:consult` and a default panel set for `/guild:panel`, run **`/guild:configure`** in Claude Code or **`$guild-configure`** in Codex — it walks you through it, including whether to set them globally or per project. By hand, copy `modelguild/modelguild.conf.example` to `modelguild.conf.local` in your chosen root and set:

```
GUILD_MODEL=openai/gpt-5
GUILD_MODELS=openai/gpt-5 google/gemini-2.5-pro
```

The matching env vars still work as one-off overrides. Precedence is **arg → env → project config file → global config file → opencode's default**.

The same file carries the knobs for the operating features: `GUILD_ACTIVITY` / `GUILD_ACTIVITY_DETAIL` for the live trace, `GUILD_APPROVE` / `GUILD_APPROVE_TIMEOUT_MS` / `GUILD_APPROVE_EGRESS` for the approval bridge, and `GUILD_LOG` / `GUILD_LOG_PROMPTS` / `GUILD_LOG_RETENTION_DAYS` for the evidence log. Each is documented where the feature is, in [docs/operations.md](operations.md). `GUILD_PAYLOAD_NOTICE` is in [docs/setup.md § Payload skew](setup.md#payload-skew).

## Model policy

`models.policy.local` in your chosen root holds per-model `deny`/`ask`/`allow` rules; the committed `models.policy` is default-allow. `/guild:configure` writes it for you, or edit it directly.

Rules are first-match globs, and resolution is **layered analogously to preferences but merged differently** — preferences overlay key by key, whereas the policy is one chain: project rules are evaluated before global ones and the **first match anywhere wins**, falling through to default-allow if nothing matches. It is **fail-closed chain-wide**: a malformed or unreadable policy file in *any* layer denies, naming the file. `npx modelguild doctor` prints the whole chain, so what actually binds is visible rather than guessed; a refusal names the exact file that decided. A `deny` model is refused outright; an `ask` model requires your explicit approval before the call proceeds.

## Timeouts

If a heavy task on a slow reasoning model aborts with *"operation was aborted due to timeout"* — e.g. a whole-repo review or a long planning session — raise the per-turn timeout (default 15 minutes) in `modelguild.conf.local`:

```
GUILD_MESSAGE_TIMEOUT_MS=1800000
```

Only the model-turn call uses it; the fast control-plane calls keep their own short timeout. A value of 0, negative, or non-numeric falls back to the default; the literal `max` uses the longest timeout Node can honour (~24.8 days). This is the default — for a single long-running call, the assistant can also pass a `timeoutMs` (a number of ms, or `"max"`) directly to `guild_consult`/`guild_panel`/`guild_research`/`guild_delegate`, which overrides it for that call.

Codex also has an outer MCP deadline. Set `tool_timeout_sec = 2100` in its
`[mcp_servers.modelguild]` table for default ModelGuild turns and a possible panel retry;
increase it for longer configured/per-call deadlines. `doctor --driver codex` warns
when that setting is missing or shorter. `startup_timeout_sec = 60` accommodates a cold
server launch. Progress notifications do not replace these settings.

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

This is Claude Code's own tool-permission layer, and it is unrelated to ModelGuild's [approval bridge](operations.md#answer-before-it-acts-opt-in-off-by-default), which gates what the *other* model does.
