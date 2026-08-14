#!/usr/bin/env bash
# check-frontmatter.sh — validate the YAML frontmatter of the repo's command and
# agent definition files. Cheap structural lint (no YAML parser dependency): it
# asserts each file opens with a `---` fence, closes it, and carries the keys that
# make the file do its job. Catches a dropped fence or a renamed/typo'd key before
# it silently breaks a slash command or an agent's permission map.
#
# Run:  bash modelguild/tests/check-frontmatter.sh              (exit 0 = all valid)
#       bash modelguild/tests/check-frontmatter.sh --self-test  (proves the lint bites)
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
# FRONTMATTER_LINT_ROOT lets the self-test point this same lint at a fixture tree
# instead of the real repo (same override shape as check-docs.sh's DOCS_LINT_ROOT) —
# so the self-test never has to touch .claude/commands/ or .opencode/agent/ for real.
cd "${FRONTMATTER_LINT_ROOT:-$repo_root}" || exit 1

fail=0
pass() { printf '\033[32mok\033[0m   %s\n' "$*"; }
bad()  { printf '\033[31mFAIL\033[0m %s — %s\n' "$1" "$2"; fail=1; }

# has_frontmatter <file> : true if line 1 is `---` and a closing `---` exists after it.
has_frontmatter() {
  [ "$(sed -n '1p' "$1")" = "---" ] || return 1
  # ONE process reading the file directly — NOT `sed … | grep -qxF`. `grep -q` exits at
  # the closing fence (line 5 of a command doc) while sed still has the whole rest of the
  # file to write; once that remainder exceeds the pipe buffer sed blocks, then takes
  # SIGPIPE, and `pipefail` reports the pipeline as failed. delegate.md is 17,490 bytes
  # against macOS's 16 KiB initial pipe buffer, so it failed CI there while passing on
  # Linux's 64 KiB — a false "unterminated frontmatter fence" on a file that is fine, and
  # one that gets likelier as any doc grows.
  awk 'NR > 1 && $0 == "---" { found = 1; exit } END { exit found ? 0 : 1 }' "$1"
}
# fm_has_key <file> <key> : true if `key:` appears within the frontmatter block only.
fm_has_key() {
  awk -v k="$2" '
    NR==1 && $0=="---" {inb=1; next}
    inb && $0=="---" {exit}
    inb && $0 ~ "^" k ":" {found=1; exit}
    END{exit(found?0:1)}' "$1"
}

check() {  # <file> <key1> [key2 ...]
  local f="$1"; shift
  if [ ! -f "$f" ]; then bad "$f" "file not found"; return; fi
  if ! has_frontmatter "$f"; then bad "$f" "missing or unterminated '---' frontmatter fence"; return; fi
  local missing=""
  for k in "$@"; do fm_has_key "$f" "$k" || missing="$missing $k"; done
  if [ -n "$missing" ]; then bad "$f" "frontmatter missing key(s):$missing"; else pass "$f"; fi
}

# --self-test: prove THIS lint catches the regressions it exists to catch, asserting
# on the failure REASON (not merely a non-zero exit) — the bar check-agent-permissions.sh
# and check-contract-counts.sh set. Hermetic: every fixture lives under a mktemp dir and
# is torn down on exit; the real .claude/commands/ and .opencode/agent/ are never written.
if [ "${1:-}" = "--self-test" ]; then
  SELF="$here/$(basename "${BASH_SOURCE[0]}")"
  st_fail=0
  st_ok() { printf '\033[32mok\033[0m   self-test: %s\n' "$1"; }
  st_no() { printf '\033[31mFAIL\033[0m self-test: %s\n' "$1"; st_fail=1; }

  tmp="$(mktemp -d "${TMPDIR:-/tmp}/modelguild-fmlint.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT

  # seed <dir> : a full copy of the REAL command docs and agent defs into <dir>, laid
  # out the way the lint expects to find them (.claude/commands/guild/*.md,
  # .opencode/agent/*.md). Every fixture starts from a full known-good set so that
  # overwriting ONE file is the only source of failure, and the reported reason can be
  # attributed to that file rather than guessed at.
  seed() {
    local dir="$1"
    mkdir -p "$dir/.claude/commands/guild" "$dir/.opencode/agent"
    cp "$repo_root"/.claude/commands/guild/*.md "$dir/.claude/commands/guild/"
    cp "$repo_root"/.opencode/agent/*.md "$dir/.opencode/agent/"
  }

  # run <dir> : the plain lint against fixture <dir>, output captured (stdout+stderr).
  run() { FRONTMATTER_LINT_ROOT="$1" bash "$SELF" 2>&1; }

  # expect_reason <name> <dir> <needle> : the lint must FAIL against <dir>, and its
  # output must contain <needle> — the specific failure reason this case exists to
  # prove, not just a non-zero exit. A wrong-reason failure is exactly the kind of bug
  # a self-test scoped to exit-code-only would miss.
  expect_reason() {
    local name="$1" dir="$2" needle="$3" out
    out="$(run "$dir")"
    case "$out" in
      *"$needle"*) st_ok "$name" ;;
      *)
        if printf '%s' "$out" | grep -q 'FAIL'; then
          st_no "$name — lint failed for the WRONG reason (expected to see: $needle)"
        else
          st_no "$name — MISSED: lint passed a fixture it should have rejected"
        fi
        ;;
    esac
  }

  # S1. The real, unmodified command docs and agent defs pass — the false-positive
  # direction. Run against the actual repo (no override), so this is a claim about the
  # live files, not a claim about a copy of them.
  if out="$(bash "$SELF" 2>&1)"; then
    st_ok "the real command docs and agent defs pass"
  else
    st_no "MISSED: the real command docs and agent defs were rejected — $out"
  fi

  # S2/S3. Missing opening `---` fence, in a command doc and an agent def.
  d="$tmp/s2"; seed "$d"
  printf '%s\n' 'description: no opening fence' '---' 'body' > "$d/.claude/commands/guild/consult.md"
  expect_reason "missing opening fence (command doc)" "$d" \
    "consult.md — missing or unterminated '---' frontmatter fence"

  d="$tmp/s3"; seed "$d"
  printf '%s\n' 'description: no opening fence' 'mode: all' 'permission:' '  "*": deny' '---' 'body' \
    > "$d/.opencode/agent/guild-read.md"
  expect_reason "missing opening fence (agent def)" "$d" \
    "guild-read.md — missing or unterminated '---' frontmatter fence"

  # S4/S5. Missing closing `---` fence, in a command doc and an agent def.
  d="$tmp/s4"; seed "$d"
  printf '%s\n' '---' 'description: no closing fence' 'body' > "$d/.claude/commands/guild/consult.md"
  expect_reason "missing closing fence (command doc)" "$d" \
    "consult.md — missing or unterminated '---' frontmatter fence"

  d="$tmp/s5"; seed "$d"
  printf '%s\n' '---' 'description: no closing fence' 'mode: all' 'permission:' '  "*": deny' 'body' \
    > "$d/.opencode/agent/guild-read.md"
  expect_reason "missing closing fence (agent def)" "$d" \
    "guild-read.md — missing or unterminated '---' frontmatter fence"

  # S6. Command doc missing `description`.
  d="$tmp/s6"; seed "$d"
  printf '%s\n' '---' 'argument-hint: [q]' '---' 'body' > "$d/.claude/commands/guild/consult.md"
  expect_reason "command doc missing description" "$d" \
    "consult.md — frontmatter missing key(s): description"

  # S7/S8/S9. Agent def missing each of description, mode, permission — one key
  # dropped per fixture, so each case proves that ONE key check independently.
  d="$tmp/s7"; seed "$d"
  printf '%s\n' '---' 'mode: all' 'permission:' '  "*": deny' '---' 'body' \
    > "$d/.opencode/agent/guild-read.md"
  expect_reason "agent def missing description" "$d" \
    "guild-read.md — frontmatter missing key(s): description"

  d="$tmp/s8"; seed "$d"
  printf '%s\n' '---' 'description: x' 'permission:' '  "*": deny' '---' 'body' \
    > "$d/.opencode/agent/guild-read.md"
  expect_reason "agent def missing mode" "$d" \
    "guild-read.md — frontmatter missing key(s): mode"

  d="$tmp/s9"; seed "$d"
  printf '%s\n' '---' 'description: x' 'mode: all' '---' 'body' \
    > "$d/.opencode/agent/guild-read.md"
  expect_reason "agent def missing permission" "$d" \
    "guild-read.md — frontmatter missing key(s): permission"

  echo
  if [ "$st_fail" -eq 0 ]; then printf '\033[32mfrontmatter self-test: the lint catches every regression\033[0m\n'
  else printf '\033[31mfrontmatter self-test: FAILED — the lint missed a regression\033[0m\n'; fi
  exit "$st_fail"
fi

echo "== slash commands (.claude/commands/**/*.md) =="
shopt -s nullglob
# Recursive on purpose: the commands live in .claude/commands/guild/. A flat glob
# would match nothing and this lint would "pass" by checking zero files — a green
# tick for an empty set is worse than a red one. The count assertion below is what
# makes that impossible.
cmds=()
while IFS= read -r _f; do cmds+=("$_f"); done < <(find .claude/commands -name '*.md' -type f | sort)
if [ "${#cmds[@]}" -eq 0 ]; then
  printf '\033[31mFAIL\033[0m no slash commands found under .claude/commands/ — this lint would otherwise pass vacuously\n'
  exit 1
fi
# Guard the array expansion with the count: `"${arr[@]}"` on an empty array under
# `set -u` errors on bash < 4.4 (macOS system bash 3.2), so only loop when non-empty.
if [ ${#cmds[@]} -eq 0 ]; then echo "  (none found)"
else for f in "${cmds[@]}"; do check "$f" description; done; fi

echo "== opencode agents (.opencode/agent/*.md) =="
agents=(.opencode/agent/*.md)
if [ ${#agents[@]} -eq 0 ]; then echo "  (none found)"
else for f in "${agents[@]}"; do check "$f" description mode permission; done; fi

echo
if [ "$fail" -eq 0 ]; then printf '\033[32mfrontmatter: all valid\033[0m\n'
else printf '\033[31mfrontmatter: problems above\033[0m\n'; fi
exit "$fail"
