#!/usr/bin/env bash
# check-agents-size.sh — hold the always-loaded instruction files under the harness limit.
#
# AGENTS.md is loaded into EVERY session of every agent (Claude Code through CLAUDE.md's
# `@AGENTS.md` import, opencode natively), and so are CLAUDE.md and every `.claude/rules/*.md`
# that has no `paths:` scope. Claude Code 2.1.259 shows a start-up warning
# (`large-memory-files`: "<file> is over the <n>-char limit (<m> chars) · /memory to free up
# context") for any memory file whose character count exceeds
#
#     max(40000, round(contextWindowTokens * 0.05 * charsPerToken))
#
# read from its bundle on 2026-09-03. That is 150,000 on a 1M-context model and 40,000 on a
# 200k-context one, so 40,000 is the floor that holds for every model someone might run this
# repo under. Nothing is truncated past it (the only hard cut is a 4 MiB per-file skip); the
# documented cost is adherence — "longer files consume more context and reduce adherence"
# (https://code.claude.com/docs/en/memory). AGENTS.md was 156,804 bytes when this lint was
# added (issue #222), and had crossed the 1M-model limit twice before with no guard.
#
# Bytes, not characters: `wc -c` is portable to the macOS CI job (stock bash 3.2 + BSD tools)
# and UTF-8 bytes >= characters, so the byte count is the conservative side of the limit.
#
# This is a HARNESS limit, not the words-per-item doc lint retired by maintainer decision on
# issue #122: it says nothing about any item, only that the whole always-loaded file fits the
# container that loads it. Where content goes when it does not fit is CONTRIBUTING.md's
# "Where rationale goes".
#
# Usage:
#   bash modelguild/tests/check-agents-size.sh             # check the repo
#   bash modelguild/tests/check-agents-size.sh --self-test # + prove it catches an over-limit file
# Exit 0 = every always-loaded file is under the limit.
set -euo pipefail

script_path="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${AGENTS_SIZE_LINT_ROOT:-$repo_root}" || exit 1

LIMIT=40000

failed=0
bad() { printf 'FAIL: %s\n' "$*" >&2; failed=1; }

check_file() {
  local f="$1" size
  [ -f "$f" ] || return 0
  size="$(wc -c < "$f" | tr -d '[:space:]')"
  if [ "$size" -gt "$LIMIT" ]; then
    bad "$f is $size bytes, over the $LIMIT-byte always-loaded limit (Claude Code's memory-file floor); move module narrative to docs/architecture.md or a module header, path-specific conventions to .claude/rules/, procedures to .claude/skills/ — see CONTRIBUTING.md"
  else
    printf '%s: %s bytes (limit %s)\n' "$f" "$size" "$LIMIT"
  fi
}

check_file AGENTS.md
check_file CLAUDE.md
# Rules without a `paths:` scope load every session too; scoped ones load on demand but are
# still single memory files, so the same per-file limit applies to all of them.
for rule in .claude/rules/*.md; do
  [ -e "$rule" ] || continue
  check_file "$rule"
done

[ "$failed" -eq 0 ] || exit 1
echo "always-loaded size lint: PASS"

if [ "${1:-}" = "--self-test" ]; then
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/modelguild-agentsize.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT
  self_test_failed=0

  fixture="$tmp/over-limit"
  mkdir -p "$fixture"
  cp -a AGENTS.md "$fixture/AGENTS.md"
  # Pad past the limit with plain text; the check is on size alone.
  awk -v n="$LIMIT" 'BEGIN{s=""; while (length(s) <= n) s = s "filler line for the size lint self-test\n"; printf "%s", s}' >> "$fixture/AGENTS.md"
  if AGENTS_SIZE_LINT_ROOT="$fixture" bash "$script_path" >/dev/null 2>&1; then
    printf 'FAIL: self-test accepted an over-limit AGENTS.md\n' >&2
    self_test_failed=1
  else
    printf 'PASS: rejects an over-limit AGENTS.md\n'
  fi

  fixture="$tmp/over-limit-rule"
  mkdir -p "$fixture/.claude/rules"
  cp -a AGENTS.md "$fixture/AGENTS.md"
  awk -v n="$LIMIT" 'BEGIN{s=""; while (length(s) <= n) s = s "filler line for the size lint self-test\n"; printf "%s", s}' > "$fixture/.claude/rules/big.md"
  if AGENTS_SIZE_LINT_ROOT="$fixture" bash "$script_path" >/dev/null 2>&1; then
    printf 'FAIL: self-test accepted an over-limit rule file\n' >&2
    self_test_failed=1
  else
    printf 'PASS: rejects an over-limit .claude/rules file\n'
  fi

  fixture="$tmp/current"
  mkdir -p "$fixture"
  cp -a AGENTS.md CLAUDE.md "$fixture/"
  if [ -d .claude/rules ]; then mkdir -p "$fixture/.claude"; cp -a .claude/rules "$fixture/.claude/"; fi
  if ! AGENTS_SIZE_LINT_ROOT="$fixture" bash "$script_path" >/dev/null 2>&1; then
    printf 'FAIL: self-test rejected the real current files\n' >&2
    self_test_failed=1
  else
    printf 'PASS: accepts the real current files\n'
  fi

  [ "$self_test_failed" -eq 0 ] || exit 1
  echo "always-loaded size lint self-tests: PASS"
fi
