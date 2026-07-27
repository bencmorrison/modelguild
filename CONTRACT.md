# ModelGuild — Behavioral Contract (the TS/MCP reference spec)

This began (M0) as the **frozen behavioral contract of the bash layer**, captured so the
TypeScript/MCP rewrite could be verified against it. **The rewrite is complete and the bash layer
retired at M12 (2026-07-23).** These C-items are no longer a bash-parity target — they are the
**behavioral specification the TypeScript implementation holds**, now verified by the TS test suite
under `test/` (the reference).
Milestone history is in git history.

- **The TypeScript implementation and `test/*.test.ts` are the reference.** Where this document and the
  code disagree, the code wins; fix the document.
- **Reading the `Oracle:` citations below.** Each group cites the *retired bash sources* (`ask.sh`,
  `log.sh`, `panel-models.sh`) the item was originally derived from — kept as provenance, not as a live
  file to consult. The behavior each item names now lives in `src/` and is asserted by the TS suite:
  policy → `src/policy.ts` (`test/policy.test.ts`); config/panel → `src/config.ts`
  (`test/config.test.ts`); evidence layer → `src/log.ts` (`test/log.test.ts`); the tools →
  `src/{consult,panel,research,delegate}.ts` and their tests.
- Item counts: 8 areas, C1–C58, plus the layered-resolution additions **C2b** and **C9b** (issue #19, 2026-07-25 — numbered as suffixes so no existing C-number shifts). **Retired items:** the witness path (C18–C21 `--watch`, and the
  witness parts of C29/C45) shipped in bash but the automated witness was retired at M12; those items
  are historical. The **`guild-watch` agent def** and the **`/guild:witness` command** retired with the
  witness (M12), so three counts stated across this file were stale and are **amended inline** (issue
  #36, 2026-07-23): C41's command count is **eight**, not nine (`witness` gone — matches `src/init.ts`
  `COMMAND_DOCS` and the F-oracle "(8 files)"); C47's def count is **three**, not four (`guild-watch`
  gone); and the `guild-watch`/`--watch` rows of C15/C48/C49/C57 are marked historical. **C46's forward-looking "mixed transport is a surfaced error" sentence was deleted
  (maintainer-ratified 2026-07-22 — both bash and TS snapshot per CALL, so mixed transport breaks no
  guarantee).** Exit-code items (area H) described `ask.sh`; the MCP tools express the same verdicts as
  structured `isError` results with the exit code carried as an analogue (see `test/consult.test.ts`).

---

## A. Model policy semantics
*Oracle: `modelguild/ask.sh` (`_has_rules`, `policy_tier`, policy enforcement block); `run-tests.sh` cases 11, 12, 20, 20b, 20c; `modelguild/models.policy`.*

- **C1** (amended 2026-07-25, issue #19 — resolution is now **LAYERED**) — Policy resolution walks an ordered chain of files, **most-specific first**, and the **first matching rule anywhere in the chain wins**: project `modelguild/models.policy.local` → project `modelguild/models.policy` → global `~/.claude/modelguild/models.policy.local` → global `~/.claude/modelguild/models.policy` → default-allow. A `models.policy.local` joins the chain **only if it has ≥1 complete rule** (the `_has_rules` gate is kept). `$GUILD_POLICY` is a **single-FILE override**: when set it is the entire chain, with nothing layered beneath it. The pre-#19 behaviour — one root wins and its single file is the whole policy, so a project `modelguild/` shadowed the global one entirely — is **superseded**: the global install is the **baseline** and the project adds a stricter deny or a looser allow on top of it. (`resolvePolicyLayers` / `policyTierAcross` in `src/policy.ts`; `policyTier` remains the single-root view.)
- **C2** (amended 2026-07-25, issue #19) — An empty or comment-only `.local` (a `deny` with no pattern is not a rule) does **not** shadow the committed policy: it is excluded from the chain entirely, so it neither displaces a committed rule nor fails the chain closed as a malformed layer. A **ruleful** `.local` no longer *replaces* the committed file either — it sits **above** it, so a personal rule wins for the ids it names while committed rules keep binding for the ids it does not.
- **C2b** (new 2026-07-25, issue #19) — Fail-closed is **chain-wide**: every existing layer is parsed even after a rule has matched (as C6 already requires within one file), so a malformed active line or an existing-but-unreadable file in **any** consulted layer resolves to **deny** with the loud reason naming that file. Stated cost: a broken *global* policy denies in every project, not only in the global one — the fail-closed direction, with the offending file and line named.
- **C3** — Tiers are `deny` / `ask` / `allow`. Patterns are shell globs matched against the full `provider/model` id. **First matching rule wins**, top to bottom.
- **C4** — Default is **allow**: no policy file, empty model id, or no matching rule all resolve to `allow` (policy only ever restricts).
- **C5** — Fail-closed: an existing-but-unreadable policy file resolves to **deny**.
- **C6** — Fail-closed: any malformed active line (unknown tier, missing pattern, trailing non-comment token) resolves to **deny** — even when `-m` was omitted, the whole file is still parsed. A final line lacking a trailing newline is still read.
- **C7** — A `deny` model exits **3** before opencode is invoked (no argv reaches opencode). An `ask` model without `GUILD_CONFIRMED=1` exits **4**; with it, proceeds. Enforced as a hard backstop independent of Claude's own check.

## B. Model & config resolution
*Oracle: `modelguild/ask.sh` (`conf_get`, model precedence); `modelguild/panel-models.sh`; `run-tests.sh` cases 2, 15, 21, 21b, 21c, 21d, 21e.*

- **C8** — Default-model precedence: `-m` flag > `$GUILD_MODEL` env > `modelguild.conf.local` `GUILD_MODEL` > opencode's own default (empty).
- **C9** (amended 2026-07-25, issue #19 — resolution is now **LAYERED**) — Config file resolution: `$GUILD_CONF` if set is a **single-FILE override** (the whole answer, nothing layered under it); otherwise **every** layer's git-ignored `modelguild.conf.local` contributes — the global `~/.claude/modelguild/` read first as the baseline, the project's `modelguild/` overlaid on top. A key set in the project **wins**; a key the project leaves unset **falls through** to global. The overlay is C10's last-assignment-wins applied to the concatenated layers, so there is one parser and no second merge rule (`resolveConfFiles` / `readLayeredConfContents` in `src/config.ts`). Parsed, **never sourced** (no code execution).
- **C9b** (new 2026-07-25, issue #19) — Guild-root resolution is layered: the read layers are `<cwd>/modelguild/` (when present) over `~/.claude/modelguild/` (when present), most-specific first. `$GUILD_ROOT` is a **single-root override** — exactly one layer, no global baseline beneath it — so an explicitly pinned root stays hermetic; `guild_status`/`doctor` report the roots on disk it leaves unlayered. The **primary** root (`layeredRoots()[0]`) is unchanged in meaning and is where **writes** go: the evidence log's `logs/` directory (`layeredRoots` / `resolveCollabRoot` in `src/config.ts`).
- **C10** — Config parsing: only `KEY=value` lines; comments/blanks ignored; leading whitespace on key stripped; last assignment wins; one layer of surrounding single/double quotes stripped; a trailing `  # comment` on the value is stripped.
- **C11** — `conf_get` semantics are **byte-identical** across `ask.sh`, `panel-models.sh`, and `doctor.sh` (regression-pinned).
- **C12** — A model id beginning with `-` (from env or config, bypassing `-m`'s `need_arg`) is refused with exit **2** — it must not be emitted as an opencode flag. A value-taking flag whose value is missing or starts with `-` is a usage error (exit 1).
- **C13** — Panel set resolution (`panel-models.sh`): explicit args > `$GUILD_MODELS` env > `modelguild.conf.local` `GUILD_MODELS`; comma- or space-separated; order preserved.
- **C14** — Panel de-duplicates (first-seen order kept, each dropped dup warned); warns on `<2` distinct models; warns if all models share one provider prefix ("diversity theater"); warns on a token that is not `provider/model`; exit **2** if no models at all. It does **not** consult the policy (that is per-call in `ask.sh`).

## C. Agent selection
*Oracle: `modelguild/ask.sh` (flag parsing, watch block, fallback blocks); `AGENTS.md` agent notes; `run-tests.sh` cases 1, 3, 3b–3h, 4, 14, 14b–14e.*

- **C15** (amended 2026-07-23, issue #36 — `--watch`/`guild-watch` retired at M12) — Default agent is `guild-read`. `--edit` → `guild-build`; `--research` → `guild-research`; `--watch` → `guild-watch` (**retired** with the witness at M12 — no watch agent ships; historical). `-a <agent>` overrides; an unrecognized agent runs as-is with a stderr note.
- **C16** (amended 2026-07-23, issue #34 — supersedes the bash-era fallback) — **A missing hardened def is a REFUSAL, never a fallback.** All four model-calling tools — `guild_consult`, `guild_panel`, `guild_research`, `guild_delegate` — refuse **unconditionally** when their hardened def (`guild-read` for consult/panel; `guild-research`; `guild-build`) is absent from **both** the project `.opencode/agent/` **and** the global `${XDG_CONFIG_HOME:-~/.config}/opencode/agent/` (`resolveAgentDefDirs` + `hardenedDefPresentIn` in `src/config.ts`, mirroring opencode's own `--agent` resolution order; fail-closed if absent in both). The refusal is a structured `agent-def-missing` result, **exit-analogue 5** (C57), **no model call, nothing logged** (gap parity). There is **no** silent downgrade to a weaker/unrestricted agent: the bash-era fallbacks (`guild-read`/`guild-research` → `plan`, `guild-build` → `build`, loud warning) are **removed** — a probe confirmed opencode also hard-errors on a message naming an absent agent, but the pre-flight refusal is the version-independent guarantee. The presence check governs **only** the tool's refusal decision, not opencode's own `--agent` resolution. `guild_panel` refuses the whole panel with one check (every member uses `guild-read`); `guild_consult` refuses even on a `sessionId` continuation (the def governs the agent regardless of session reuse).
- **C17** (amended 2026-07-23 — superseded by C16's unconditional refusal) — The bash-era `GUILD_REQUIRE_HARDENED=1` opt-in (which turned a fallback into a hard exit-5) **no longer exists** and is read by no code in `src/`: with refusal now unconditional there is nothing to opt into. Historical.
- **C18** — `--watch` has **NO fallback**: a missing `guild-watch.md` is exit **5** always (even without `GUILD_REQUIRE_HARDENED`), because any weaker agent could read the source and "audit" that.
- **C19** — `--watch` requires the watcher model be named explicitly; if unresolved (no `-m`, `$GUILD_WATCH_MODEL`, or `$GUILD_MODEL`) exit **8** — an empty id would let opencode pick its own default, possibly Claude, unchecked.
- **C20** — `--watch` refuses a Claude model (`anthropic/*`, `*claude*`, `*Claude*`) with exit **8** unless `GUILD_CONFIRMED=1` (then warns). Watcher model prefers `$GUILD_WATCH_MODEL` (env/config) unless `-m` was explicit.
- **C21** — `--watch` refuses to run when the effective `GUILD_LOG_DIR` resolves outside `<install>/logs/**` (exit 5) — the watch agent cannot read outside that scope, so an evidence-free audit is refused rather than produced.

## D. Evidence layer
*Oracle: `modelguild/log.sh`; `modelguild/ask.sh` (logging hooks); `run-tests.sh` log block (~L994–1620); `AGENTS.md`.*

- **C22** — Every model call writes **exactly three** lifecycle entries sharing one `call_id`: `expected-call` (before capture setup) → `started` (before the call) → `completed` (after). Three calls ⇒ nine entries.
- **C23** — Entries are paired by `call_id`, never by run_id+turn (retries and concurrent panel calls break turn-based pairing). `turn` is recorded for readability only.
- **C24** — `verify` requires, per `call_id`, **exactly one** of each of expected/started/completed — checked in **both directions** (a lone `completed` fails; duplicates fail; set-membership is insufficient).
- **C25** — `raw_response` is recorded **in full, always**, byte-exact via `jq --rawfile` (a `$(...)` capture that strips trailing newlines is a contract violation). `completed` carries `capture_state` ∈ {`complete`,`failed`}; a `complete` with a missing/absent response file downgrades to `failed`.
- **C26** — Prompt privacy `GUILD_LOG_PROMPTS` ∈ {`full` (default), `hash`, `off`}: `full` stores prompt text + digest; `hash` stores only a 64-hex digest; `off` stores neither. `verify` enforces each mode's shape.
- **C27** — Integrity is a hash chain (`prev_hash` = sha256 of prior line) **plus** a per-entry self-hash (`entry_hash` over the payload) covering the tail line the chain cannot. Hashes catch accidental corruption only — **not** adversarial rewriting.
- **C28** — `verify` also checks: valid JSONL, unique non-empty `expected-call` call_ids, capture completeness, prompt-mode/hash consistency, and referenced `delegate-diff` patch present + hash-matching. Integrity failure exits **7**.
- **C29** — Entry types and claim flags: `claude-final` (the summary the developer read); `claude-disposition` **`claim:true`** (Adopt/Adapt/Reject/Defer, self-report to audit); `subagent-voice` **`claim:true, captured:false`** (a Claude subagent's turn, text in `claimed_response` not `raw_response`); `delegate-diff` **`claim:false`** (machine evidence, patch hash verified). Verdicts are validated to the four-value set.
- **C30** — A run of only well-formed `subagent-voice` entries verifies as non-empty (all-Anthropic collab). Completeness bound: an unlogged subagent voice is undetectable (no durable pre-spawn marker), unlike a crashed opencode call which leaves its `expected-call`.
- **C31** — Logging is best-effort and **must never fail the call it records**: every hook (including `mktemp`s) is guarded; the response `tee`'s status is read from `PIPESTATUS[0]`. A lost entry surfaces as a `verify` gap, never as a non-zero call exit or a silent success.
- **C32** — Retention: `new-run` prunes run dirs older than `GUILD_LOG_RETENTION_DAYS` (default 14; 0 disables); prune only touches directories matching a minted run-id shape.
- **C33** — Partitioning: `GUILD_LOG_PARTITION=1` narrows the root to `<base>/<project-key>/<run>` (key = git top-level else CWD, base + short path-hash); stays under `modelguild/logs/`; disabled when `GUILD_LOG_DIR` is set explicitly. Default OFF ⇒ byte-identical to today.
- **C34** — Concurrency: appends are serialized by a portable `mkdir` lock (stale-lock steal after ~1 min; drop-the-entry after ~10s rather than a torn unlocked append). `latest` symlink points at the most recent run.
- **C35** — Config knobs resolve **env override > `modelguild.conf.local` > default**, identically to `ask.sh`. Subcommands: `new-run`, `latest`, `dir`, `path`, `expect`, `started`, `completed`, `final`, `disposition`, `subagent-voice`, `diff`, `verify`, `prune` (usage error exits 2).

## E. Write-path semantics (`--edit` / `guild-build`, `build`)
*Oracle: `modelguild/ask.sh` (`_snapshot_tree`, `record_delegate_diff`, `_ignored_fingerprint`, `_submodule_state`); `run-tests.sh` cases 3c and delegate-diff block.*

- **C36** — **No clean-worktree requirement** (the old exit-6 refusal is removed). A dirty tree proceeds.
- **C37** — Before the model runs, the worktree is snapshotted as a git tree via `git write-tree` against a **throwaway index** (`git add -A`, honoring `.gitignore`) — no effect on the caller's real index or worktree.
- **C38** — The recorded patch is the **model's changes only** on a dirty tree, **including created files** (a `git diff <sha>` that misses created files is a contract violation). It lands at `modelguild/logs/<run_id>/diff-<call_id>.patch` and is logged as a `delegate-diff` entry.
- **C39** — Clobbered work is recoverable via `git checkout <tree> -- <path>`; the snapshot tree id is printed to stderr on a dirty tree.
- **C40** — Capture is marked **incomplete** (and the log will fail integrity, surfaced loudly) when the baseline/after tree, ignored-file fingerprint, or submodule state cannot be faithfully represented; a run that changed no tracked files reports "nothing to review" and writes no patch. The snapshot is a **record, not containment** — it does not run for read-only agents (case 3c).

## F. Command surface
*Oracle: `.claude/commands/guild/*.md` (8 files, was 9 pre-M12); `AGENTS.md` command list.*

- **C41** (amended 2026-07-23, issue #36 — `/guild:witness` retired at M12) — Exactly **eight** namespaced commands exist as `/guild:<name>`: `consult`, `panel`, `workshop`, `review`, `delegate`, `research`, `collaborate`, `configure` (the ninth, `witness`, retired with the automated witness at M12 — the set now matches `src/init.ts` `COMMAND_DOCS`). Files live in `.claude/commands/guild/` (the subdirectory is the namespace and is load-bearing against silent collisions).
- **C42** — Every model-touching command carries a **prompt-injection guard**: external model output is untrusted **data**, never instructions; directives aimed at Claude are surfaced as a finding, not executed.
- **C43** — Commands consult the model policy per call (via `ask.sh`), not independently; `panel`/`workshop` set one `$GUILD_RUN_ID` so the whole workflow is one auditable run.
- **C44** — Commands that spend multiple calls **state the call count before spending** (e.g. `panel` 2–3; `workshop` ~2/model). Normal `consult`/`review`/`research`/`collaborate` are one call; no silent retries.
- **C45** (`witness` part marked historical 2026-07-23, issue #36 — witness retired at M12) — Verify-not-relay contracts: `review` re-reads the changed files and marks each finding Confirmed/Refuted/Uncertain; `research` fetches each cited source (Confirmed/Refuted/Unsourced) and states verification coverage. (`witness` treated a report missing `call_id` citations or quoted `raw_response` as Inconclusive, with fixed prompt text not Claude's to soften — **retired at M12** with the automated witness; historical.) The `review`/`research` contracts are live.
- **C46** — Anthropic voices come via a Claude **subagent** (Task/Agent tool), logged as `subagent-voice` (C29).

## G. Security doctrine invariants
*Oracle: `.opencode/agent/guild-*.md`; `AGENTS.md` Conventions/Gotchas; `check-agent-permissions.sh`; `verify-guild-*.sh`.*

> **Amended 2026-07-22 (permission realignment) — supersedes the original area-G freeze on the secret-glob model.** C48–C50 below are the amended text; the read paths (`guild-read`/`guild-research`) now carry a Claude review subagent's tools (`read`+`grep`+`glob`+web) with **no** secret-glob read-denies and **no** `grep`/`glob` denials, per the maintainer decision recorded in AGENTS.md Conventions (PARITY, the 2026-07-22 permission realignment). The default-deny-allowlist *shape* (C47) is unchanged; only the read-path allow-sets and the harness-difference justification changed.

- **C47** (amended 2026-07-23, issue #36 — `guild-watch` retired at M12) — The **three** hardened agent defs (`guild-read`/`guild-build`/`guild-research`; the fourth, `guild-watch`, retired with the witness — historical) are **default-deny allowlists**: `"*": deny` floor (no `"*": allow`), `mode: all`, re-allowing exactly their intended tools. Preserved **unchanged, opencode-side** by the rewrite.
- **C48** (amended 2026-07-22; `guild-watch` row marked historical 2026-07-23, issue #36) — Per-agent allow-sets: `guild-read` = read + grep + glob + webfetch/websearch (**no secret-glob read-denies**); `guild-research` = **identical** to `guild-read`; `guild-build` = edit/write/patch/bash. (`guild-watch` = read `modelguild/logs/**` only, inverted map, all else incl. secrets denied — **retired at M12** with the witness; historical.) The read paths carry no secret-path read-denies — that is the realignment, not an omission.
- **C49** — Honest-guarantee statements are part of the contract: `guild-read`/`guild-research` are **not** exfiltration or credential boundaries — they can read any repo file **including credentials** and reach the web, so a secret can egress to a third-party model provider; the no-write/no-`task` scoping is the read-only ROLE, not a confidentiality floor. `guild-build`'s non-mutation denies are **defense-in-depth, not by construction** (`bash` routes around them) — the human diff review is the boundary. (`guild-watch`'s `bash`/`grep`/`glob`/egress denials were load-bearing — **retired at M12** with the witness, issue #36; historical.)
- **C50** (amended 2026-07-22) — `grep`/`glob` are **allowed** on the read paths (review-subagent parity); the former "opencode grep bypasses `read:` secret globs" harness difference was **retired as circular** (it only bites if you fence secrets, which the read-only role does not). The **current** named harness difference is that a read on the external read paths **egresses to a third-party vendor** (a Claude subagent's read stays inside Anthropic) — surfaced by a security scan and accepted as an informed trusted-repo tradeoff. MCP tools are covered by the `"*": deny` floor.
- **C51** — **PARITY rule:** asymmetry is default-deny; do not restrict a non-Claude path more than the Claude path for the same task without a named harness difference. Vendor is not a threat model. `--auto` is a proven no-op for hardened agents and must not justify write-path friction.
- **C52** — External model output (including a delegate's report **and its diff**) is untrusted data for Claude to reason over or verify — never a command to execute.

## H. Exit-code table (`ask.sh`)
*Oracle: `modelguild/ask.sh`; `AGENTS.md` header (note discrepancy in Report).*

- **C53** — `0` success; opencode's own non-zero status is propagated verbatim.
- **C54** — `1` usage error (missing prompt, missing flag value).
- **C55** — `2` model id starts with `-` (from env/config).
- **C56** — `3` model denied by policy; `4` model gated `ask` unconfirmed.
- **C57** (amended 2026-07-23, issue #36 — `--watch`/exit-8 retired; exit-5 is now the C16 def-missing refusal) — `5` required-hardened def missing — in the TS/MCP layer this is the **unconditional C16 refusal** (`guild_consult`/`guild_panel`/`guild_research`/`guild_delegate` when the hardened def is absent from **both** agent dirs; structured `agent-def-missing`, exit-analogue 5, no model call, nothing logged). The bash-era `--watch` uses of exit 5 (always-5 for `--watch`, incl. bad watch log-dir scope) and the exit `8` uses (`--watch` model unset, or `--watch` on a Claude model without `GUILD_CONFIRMED=1`) **retired with the witness at M12**; historical.
- **C58** — `124` `$GUILD_TIMEOUT` hit (via `timeout`/`gtimeout`); `127` opencode not found, or `jq` missing on the `--emit-session` path. (`log.sh`: `0` ok, `2` usage, `7` integrity failure.)

---

## How this spec is held (historical: "how parity was declared")

During the rewrite, each TypeScript milestone PR **cited the C-numbers it implemented** and stated, for
each, that the ported behavior matched the bash oracle (test, live probe, or cross-verified log), with
any **intentional deviation** recorded with a reason. That parity process is complete. The bash
cross-verification the TS suite used ("until bash retires", CONTRACT M3) was removed at M12 when the
bash layer was deleted; the TS verifier now stands alone as the reference.

**Going forward**, a change to any behavior an item names must keep this document and the TS suite in
agreement — the code wins, and the document is fixed to match. Recorded deviations from the original
bash behavior (transport artifacts and superseded items) are noted inline above.
