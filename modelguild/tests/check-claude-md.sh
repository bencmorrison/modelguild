#!/usr/bin/env bash
# check-claude-md.sh — machine-check the CLAUDE.md thin-pointer invariant.
#
# CLAUDE.md MUST stay a thin pointer at AGENTS.md: its first non-empty line is the
# `@AGENTS.md` import, it stays under a small line ceiling, and it restates NONE of
# AGENTS.md's shared rules — it adds ONLY the four Claude-specific things AGENTS.md
# does not say (prefer-evidence, the Bias Audit procedure, verify-each-consequential-
# claim, preserve-disagreement). See AGENTS.md's intro block and CLAUDE.md's
# "Documentation Discipline" for the why.
#
# History: this was once a SYMLINK to AGENTS.md (drift impossible by construction),
# then a bash doctor.sh checked the import + four guardrails + a 60-line anti-fork
# ceiling; both retired at M12, leaving hand-held discipline. This lint (issue #28)
# regains the mechanical check — the STRUCTURAL half of it. It does NOT and cannot
# catch semantic restatement in novel words (a shared rule paraphrased so no literal
# marker fires); that half stays human judgment in review.
#
# Opencode-free and token-free, so CI (the shell + macOS jobs) runs it. bash-3.2-safe
# (the macOS CI job runs stock bash 3.2 + BSD awk/grep).
#
# Usage:
#   bash modelguild/tests/check-claude-md.sh            # check the repo
#   bash modelguild/tests/check-claude-md.sh --self-test # + prove it catches regressions
# Exit 0 = the thin-pointer invariant holds.
set -euo pipefail

script_path="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${CLAUDE_MD_LINT_ROOT:-$repo_root}" || exit 1

# The line ceiling. The retired doctor.sh used 60; CLAUDE.md is well under it, so the
# historical value stands as an anti-fork ceiling with headroom. Raising it is a real
# decision — a CLAUDE.md that needs more room is usually restating AGENTS.md.
CEILING=60

# Distinctive literal markers of AGENTS.md's SHARED rules. Each is present in AGENTS.md
# and absent from the thin-pointer CLAUDE.md, so a match means someone copied shared
# content down. Chosen to distinguish RESTATEMENT from POINTING: CLAUDE.md legitimately
# NAMES some shared concepts when it points at AGENTS.md (it says "PARITY", "harness
# difference", "provenance recorded", "capability cost stated", and the hyphenated
# "vendor-is-not-a-threat-model" — all pointer references), so those bare nouns are
# deliberately NOT markers. These are full rule-statement phrasings that only appear if
# the rule itself was copied:
#   - "default-deny"                                  the PARITY floor / agent-def shape
#   - "vendor is not a threat model"  (SPACED form)   the posture rule; CLAUDE.md's
#                                                     hyphenated pointer form is fine
#   - "Every script starts with"                      the shebang convention
#   - "would I impose this on an Anthropic subagent"  the PARITY forcing question
#   - "Two transports for two vendors"                the two-transport architecture rule
#   - "Record provenance."                            the PARITY provenance rule (the
#                                                     imperative sentence, NOT CLAUDE.md's
#                                                     "provenance recorded" pointer noun)
#   - "State the capability cost."                    the PARITY capability-cost rule (ditto
#                                                     vs "capability cost stated")
# DELIBERATE, not an oversight — the "vendor is not a threat model" SPACED marker is kept
# over a longer sentence-anchored one: the spaced/hyphenated split is the whole point
# (hyphenated = the sanctioned pointer form). If a future edit un-hyphenates the pointer,
# this marker fires loudly in CI and is trivially resolved — acceptable for a tripwire.
markers=(
  "default-deny"
  "vendor is not a threat model"
  "Every script starts with"
  "would I impose this on an Anthropic subagent"
  "Two transports for two vendors"
  "Record provenance."
  "State the capability cost."
)

failed=0
bad() { printf 'FAIL: %s\n' "$*" >&2; failed=1; }

if [ -L CLAUDE.md ]; then
  bad "CLAUDE.md is a symlink; it must be a regular file (a symlink to AGENTS.md was the OLD construction, retired at M12)"
elif [ ! -f CLAUDE.md ]; then
  bad "CLAUDE.md is missing or is not a regular file"
else
  # First NON-EMPTY line must be exactly the import. awk 'NF' skips blank/whitespace-only
  # lines; the first record with fields is the first non-empty line.
  first_ne="$(awk 'NF{print; exit}' CLAUDE.md)"
  if [ "$first_ne" != "@AGENTS.md" ]; then
    bad "CLAUDE.md's first non-empty line is '$first_ne', expected '@AGENTS.md' (the import that makes it a pointer)"
  fi

  # AGENTS.md must be the ONLY import. A second `@`-import line — moving shared rules into
  # a new file and `@extra.md`-importing it — would pass every other check while gutting
  # the invariant, so any import line other than `@AGENTS.md` fails. Anchor on a line that
  # STARTS with `@` followed by a path-like token (`[A-Za-z0-9._/-]`), so an inline
  # `@AGENTS.md` inside a backticked pointer sentence, a bare email, or a `@decorator` in
  # prose does not false-positive; only a whole-line import directive matches.
  while IFS= read -r import_line; do
    [ -n "$import_line" ] || continue
    if [ "$import_line" != "@AGENTS.md" ]; then
      bad "CLAUDE.md has a second import '$import_line'; @AGENTS.md must be the ONLY import (moving shared rules into another @-imported file defeats the thin-pointer invariant)"
    fi
  done < <(grep -E '^@[A-Za-z0-9._/-]' CLAUDE.md || true)

  # Line ceiling. awk END{NR} counts records robustly even without a trailing newline
  # (wc -l would undercount that case).
  lines="$(awk 'END{print NR}' CLAUDE.md)"
  if [ "$lines" -gt "$CEILING" ]; then
    bad "CLAUDE.md is $lines lines, over the $CEILING-line anti-fork ceiling; a pointer that grows this large is usually restating AGENTS.md"
  fi

  # Anti-restatement tripwires.
  for m in ${markers[@]+"${markers[@]}"}; do
    if grep -Fiq -- "$m" CLAUDE.md; then
      bad "CLAUDE.md contains the shared-rule marker '$m'; that rule belongs in AGENTS.md, not restated here (keep CLAUDE.md a thin pointer)"
    fi
  done
fi

[ "$failed" -eq 0 ] || exit 1
echo "CLAUDE.md thin-pointer lint: PASS"

if [ "${1:-}" = "--self-test" ]; then
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/modelguild-claudemd.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT
  baseline="$tmp/baseline"
  mkdir -p "$baseline"
  cp -a CLAUDE.md "$baseline/"
  # AGENTS.md is only needed so the symlink fixture has a real target to point at.
  cp -a AGENTS.md "$baseline/"

  self_test_failed=0
  expect_rejected() {
    local name="$1" fixture="$2"
    if CLAUDE_MD_LINT_ROOT="$fixture" bash "$script_path" >/dev/null 2>&1; then
      printf 'FAIL: self-test accepted %s\n' "$name" >&2
      self_test_failed=1
    else
      printf 'PASS: rejects %s\n' "$name"
    fi
  }

  fixture="$tmp/missing-import"
  cp -a "$baseline" "$fixture"
  # Drop the @AGENTS.md first line, keep the rest.
  awk 'NR==1{next}1' "$baseline/CLAUDE.md" > "$fixture/CLAUDE.md"
  expect_rejected "CLAUDE.md missing its @AGENTS.md first line" "$fixture"

  fixture="$tmp/over-ceiling"
  cp -a "$baseline" "$fixture"
  { cat "$baseline/CLAUDE.md"; for i in $(seq 1 "$CEILING"); do echo "filler line $i"; done; } > "$fixture/CLAUDE.md"
  expect_rejected "CLAUDE.md over the line ceiling" "$fixture"

  # One fixture per marker — prove EVERY tripwire fires, not just one.
  marker_n=0
  for m in ${markers[@]+"${markers[@]}"}; do
    marker_n=$((marker_n + 1))
    fixture="$tmp/restated-rule-$marker_n"
    cp -a "$baseline" "$fixture"
    printf '\nA restated shared rule: %s\n' "$m" >> "$fixture/CLAUDE.md"
    expect_rejected "CLAUDE.md restating the shared-rule marker '$m'" "$fixture"
  done

  fixture="$tmp/second-import"
  cp -a "$baseline" "$fixture"
  printf '\n@extra.md\n' >> "$fixture/CLAUDE.md"
  expect_rejected "CLAUDE.md with a second @-import" "$fixture"

  fixture="$tmp/symlink"
  cp -a "$baseline" "$fixture"
  # A symlink whose target EXISTS still passes -f; -L is what must catch it.
  ln -sf AGENTS.md "$fixture/CLAUDE.md"
  expect_rejected "CLAUDE.md as a symlink" "$fixture"

  if ! CLAUDE_MD_LINT_ROOT="$baseline" bash "$script_path" >/dev/null 2>&1; then
    printf 'FAIL: self-test rejected the real current CLAUDE.md\n' >&2
    self_test_failed=1
  else
    printf 'PASS: accepts the real current CLAUDE.md\n'
  fi

  [ "$self_test_failed" -eq 0 ] || exit 1
  echo "CLAUDE.md thin-pointer lint self-tests: PASS"
fi
