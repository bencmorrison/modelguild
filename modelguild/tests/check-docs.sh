#!/usr/bin/env bash
# Token-free checks for user-facing workflow names and command grants.
set -euo pipefail

script_path="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${DOCS_LINT_ROOT:-$repo_root}" || exit 1

failed=0
bad() { printf 'FAIL: %s\n' "$*" >&2; failed=1; }

# Explicitly labelled rename/collision history is retained below. All other
# operational references, including elsewhere in those files, must be namespaced.
user_files=(
  .claude/commands/guild
  .devcontainer/Dockerfile
  .devcontainer/devcontainer.json
  .devcontainer/postCreate.sh
  AGENTS.md
  CONTRIBUTING.md
  README.md
  SECURITY.md
  modelguild/modelguild.conf.example
  modelguild/models.policy
)
obsolete='(^|[^[:alnum:]_.-])/((configure-collab)|(consult|panel|workshop|review|research|delegate|collaborate|witness|configure|consensus))([[:space:]<`"'"'"'(,.:]|$)'
obsolete_matches="$(grep -RInE --exclude=check-docs.sh "$obsolete" "${user_files[@]}" || true)"
obsolete_matches="$(printf '%s\n' "$obsolete_matches" | grep -Ev \
  '^AGENTS\.md:.*(where `/consult`, `/review` and `/panel`|Our `/review` was found colliding|Renamed from `/consensus`)' || true)"
if [ -n "$obsolete_matches" ]; then
  printf '%s\n' "$obsolete_matches" >&2
  bad "obsolete unnamespaced command reference found; use /guild:<name>"
fi

if grep -RIn --include='*.md' 'Bash(bash collab/log\.sh:\*)' .claude/commands/guild README.md; then
  bad "broad log.sh grant found; allow only required subcommands"
fi

# MCP-era command shape (M10): the multi-call workflows drive the MCP tools, not
# `ask.sh`, and touch ZERO collab bash — subagent-voice logging retired with the
# witness (a subagent voice was Claude's own captured:false transcription, testimony
# for the cancelled witness; the log's receipts are the external models' auto-captured
# responses). Assert each grants the MCP tool(s) it invokes. (bash 3.2 has no
# associative arrays — the macOS CI job runs this lint — so use a case, not declare -A.)
for command in panel workshop collaborate configure; do
  file=".claude/commands/guild/$command.md"
  grep -Fq 'allowed-tools:' "$file" || bad "$command has no allowed-tools frontmatter"
  # guild_models (M11) replaced the `Bash(opencode models:*)` binary shell-out in every
  # doc that enumerates models — assert it is granted where it belongs.
  case "$command" in
    panel)       mcp_grants="mcp__modelguild__guild_panel mcp__modelguild__guild_models" ;;
    workshop)    mcp_grants="mcp__modelguild__guild_panel mcp__modelguild__guild_consult mcp__modelguild__guild_models" ;;
    collaborate) mcp_grants="mcp__modelguild__guild_consult mcp__modelguild__guild_models" ;;
    configure)   mcp_grants="mcp__modelguild__guild_models" ;;
    *)           mcp_grants="" ;;
  esac
  fm_line="$(grep -m1 '^allowed-tools:' "$file")"
  for g in $mcp_grants; do
    printf '%s' "$fm_line" | grep -Fq "$g" \
      || bad "$command must grant the MCP tool $g in allowed-tools"
  done
done

# Every command doc must touch ZERO collab bash (M12, bash layer retired): no ask.sh, no
# log.sh, no panel-models.sh, and none of the old env-var invocation forms. The last
# opencode-binary shell-out (`Bash(opencode models:*)`) was replaced by the guild_models
# MCP tool, so a doc must not grant `Bash(opencode` either. (witness.md retired with the
# witness; configure.md was migrated to the MCP tools + `modelguild doctor` at M12.) The
# forbidden bash patterns below name the RETIRED bash layer at its historical path
# (`collab/ask.sh`, `COLLAB_RUN_ID`, …) on purpose — that is exactly the regression to catch.
migrated_cmds=(consult panel research delegate review workshop collaborate configure)
for command in "${migrated_cmds[@]}"; do
  file=".claude/commands/guild/$command.md"
  if grep -nE 'collab/ask\.sh|collab/log\.sh|panel-models\.sh|COLLAB_RUN_ID|COLLAB_CONFIRMED' "$file"; then
    bad "$command still references collab bash; the migrated docs drive the MCP tools only"
  fi
  if grep -nE 'Bash\(opencode' "$file"; then
    bad "$command still grants an opencode-binary Bash shell-out; use the guild_models MCP tool"
  fi
done

delegate=.claude/commands/guild/delegate.md
grep -m1 '^allowed-tools:' "$delegate" | grep -Fq 'Read' || bad "delegate patch review requires Read in allowed-tools"
grep -Fq 'with the `Read` tool' "$delegate" || bad "delegate must review the recorded patch with Read"

review=.claude/commands/guild/review.md
grep -m1 '^allowed-tools:' "$review" | grep -Fq 'Bash(git ls-files:*)' || bad "review uses git ls-files but does not grant it"

lifecycle_files=(
  AGENTS.md
  README.md
  SECURITY.md
  CONTRIBUTING.md
  modelguild/modelguild.conf.example
  .claude/commands/guild
  .opencode/agent
)
if grep -RInE '([Tt]wo|2)[[:space:]]+(entries|writes|records|lines)[[:space:]]+per[[:space:]]+call|3 concurrent calls produce 6|three concurrent calls produce six|started\+completed sharing one' "${lifecycle_files[@]}"; then
  bad "stale two-entry evidence lifecycle claim found; current lifecycle is expected-call + started + completed"
fi
while IFS= read -r lifecycle_line; do
  case "$lifecycle_line" in
    *expected-call*) ;;
    *)
      printf '%s\n' "$lifecycle_line" >&2
      bad "started/completed presented as a complete lifecycle without expected-call"
      ;;
  esac
done < <(grep -RInE 'started[[:space:]]*[/+&][[:space:]]*completed([^[:alnum:]]|$)' "${lifecycle_files[@]}" || true)
for file in AGENTS.md README.md SECURITY.md; do
  grep -Fq 'expected-call' "$file" || bad "$file must document the expected-call lifecycle entry"
done

# Read-path permission claims must match the post-2026-07-22-realignment agent defs
# (issue #35). The read paths — guild-read (consult/panel/review/collaborate/workshop) and
# guild-research (research) — ALLOW read+grep+glob+web and are explicitly NOT confidentiality
# boundaries: they no longer deny grep/glob nor carve secret reads out of `read`. So these
# docs must not resurrect the retired fencing wording. delegate.md is EXCLUDED on purpose —
# it describes guild-build, which really does deny grep/glob and block secret reads, so those
# phrases are TRUE there. This is a NARROW phrase tripwire on unambiguous refuted wording, not
# a semantic proof of every claim against the YAML (that would be brittle — see issue #35).
read_path_docs=(
  .claude/commands/guild/consult.md
  .claude/commands/guild/panel.md
  .claude/commands/guild/research.md
  .claude/commands/guild/review.md
  .claude/commands/guild/workshop.md
  .claude/commands/guild/collaborate.md
)
stale_perm_matches="$(grep -RInE 'non-secret|cannot [`]?grep|denied under [`]?read' "${read_path_docs[@]}" || true)"
if [ -n "$stale_perm_matches" ]; then
  printf '%s\n' "$stale_perm_matches" >&2
  bad "stale read-path permission claim (issue #35): guild-read/guild-research allow grep/glob and can read any file — they do not deny grep/glob or fence secrets"
fi

[ "$failed" -eq 0 ] || exit 1
echo "documentation workflow lint: PASS"

if [ "${1:-}" = "--self-test" ]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  baseline="$tmp/baseline"
  mkdir -p "$baseline/.claude/commands" "$baseline/.devcontainer" \
    "$baseline/.opencode" "$baseline/modelguild"
  cp -a .claude/commands/guild "$baseline/.claude/commands/"
  cp -a .opencode/agent "$baseline/.opencode/"
  cp -a AGENTS.md CONTRIBUTING.md README.md SECURITY.md install.sh "$baseline/"
  cp -a .devcontainer/Dockerfile .devcontainer/devcontainer.json \
    .devcontainer/postCreate.sh "$baseline/.devcontainer/"
  cp -a modelguild/modelguild.conf.example modelguild/models.policy "$baseline/modelguild/"

  self_test_failed=0
  expect_rejected() {
    local name="$1" fixture="$2"
    if DOCS_LINT_ROOT="$fixture" bash "$script_path" >/dev/null 2>&1; then
      printf 'FAIL: self-test accepted %s\n' "$name" >&2
      self_test_failed=1
    else
      printf 'PASS: rejects %s\n' "$name"
    fi
  }

  fixture="$tmp/broad-log-grant"
  cp -a "$baseline" "$fixture"
  printf '\n`Bash(bash collab/log.sh:*)`\n' >> "$fixture/README.md"
  expect_rejected "broad log grant" "$fixture"

  fixture="$tmp/obsolete-command"
  cp -a "$baseline" "$fixture"
  printf '\nRun `/review` for details.\n' >> "$fixture/README.md"
  expect_rejected "obsolete command name" "$fixture"

  fixture="$tmp/missing-mcp-grant"
  cp -a "$baseline" "$fixture"
  cat > "$fixture/.claude/commands/guild/panel.md" <<'EOF'
---
allowed-tools: mcp__modelguild__guild_consult, Task
---
Ask the panel.
EOF
  expect_rejected "panel missing its guild_panel MCP grant" "$fixture"

  fixture="$tmp/migrated-doc-collab-bash"
  cp -a "$baseline" "$fixture"
  # Inject the RETIRED bash invocation form (collab/ask.sh) to prove the lint still
  # catches a doc that regresses to it — the forbidden pattern names the historical path.
  printf '\nRun `COLLAB_COMMAND=/collab:consult bash collab/ask.sh "q"`.\n' \
    >> "$fixture/.claude/commands/guild/consult.md"
  expect_rejected "collab bash in a migrated command doc" "$fixture"

  fixture="$tmp/migrated-doc-opencode-bash"
  cp -a "$baseline" "$fixture"
  cat > "$fixture/.claude/commands/guild/consult.md" <<'EOF'
---
allowed-tools: mcp__modelguild__guild_consult, Bash(opencode models:*), Task
---
Consult.
EOF
  expect_rejected "opencode-binary Bash grant in a migrated command doc" "$fixture"

  fixture="$tmp/stale-lifecycle"
  cp -a "$baseline" "$fixture"
  printf '\nThe current lifecycle has two entries per call.\n' >> "$fixture/README.md"
  expect_rejected "stale current lifecycle wording" "$fixture"

  # All three tripwire phrases must be proven rejected, each in a read-path doc.
  fixture="$tmp/stale-read-path-nonsecret"
  cp -a "$baseline" "$fixture"
  printf '\nThe reviewer can only read non-secret files.\n' \
    >> "$fixture/.claude/commands/guild/consult.md"
  expect_rejected "stale read-path claim: non-secret (issue #35)" "$fixture"

  fixture="$tmp/stale-read-path-nogrep"
  cp -a "$baseline" "$fixture"
  printf '\nThe reviewer cannot `grep` the tree.\n' \
    >> "$fixture/.claude/commands/guild/review.md"
  expect_rejected "stale read-path claim: cannot grep (issue #35)" "$fixture"

  fixture="$tmp/stale-read-path-denied-read"
  cp -a "$baseline" "$fixture"
  printf '\nCredential paths are denied under `read`.\n' \
    >> "$fixture/.claude/commands/guild/research.md"
  expect_rejected "stale read-path claim: denied under read (issue #35)" "$fixture"

  if ! DOCS_LINT_ROOT="$baseline" bash "$script_path" >/dev/null 2>&1; then
    printf 'FAIL: self-test rejected intentional historical passages\n' >&2
    self_test_failed=1
  else
    printf 'PASS: allows narrowly exempt historical passages\n'
  fi

  [ "$self_test_failed" -eq 0 ] || exit 1
  echo "documentation workflow lint self-tests: PASS"
fi
