#!/usr/bin/env bash
# Token-free STRUCTURAL lint of CONTRACT.md. Two assertions, both mechanical; neither
# reads the prose meaning.
#
# 1. COUNTS (issue #36): the command/agent-def counts CONTRACT.md states in prose must
#    match the source of truth in `src/init.ts` (COMMAND_DOCS / AGENT_DEFS). It catches
#    the exact regression that issue fixed — a retirement bumps a count in code but
#    CONTRACT.md keeps the stale number. Anchored patterns keep it robust: "<word>
#    namespaced commands" (C41), "(<n> files" (F oracle), and "<word> hardened agent
#    defs" (C47) are the load-bearing count statements.
# 2. CLAUSE-ID UNIQUENESS (issue #113): every `- **C<n>**` id must appear once. Clause
#    numbers are cited as identifiers — from AGENTS.md, `src/` comments and commit
#    messages — so a number resolving to two clauses makes every citation of it
#    ambiguous in both directions, and prose has no typechecker to catch it (two
#    same-day merges each added a C71, neither conflicting textually). The id INCLUDES
#    any letter suffix: `C32` and `C32a` are DISTINCT ids and both are allowed, so the
#    suffix is never stripped — doing so is what makes a naive grep report the pair as
#    a duplicate.
#
# The file is named for the counts it started as; it is the CONTRACT.md lint.
set -euo pipefail

script_path="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
# Source of truth (the code) is ALWAYS the real repo; the CONTRACT under test may be
# a self-test fixture (CONTRACT_LINT_ROOT) so the mutation probes have somewhere to
# write a mangled copy without touching the tracked file.
init_ts="$repo_root/src/init.ts"
contract="${CONTRACT_LINT_ROOT:-$repo_root}/CONTRACT.md"

failed=0
bad() { printf 'FAIL: %s\n' "$*" >&2; failed=1; }

word_to_num() {
  case "$1" in
    one) echo 1 ;; two) echo 2 ;; three) echo 3 ;; four) echo 4 ;; five) echo 5 ;;
    six) echo 6 ;; seven) echo 7 ;; eight) echo 8 ;; nine) echo 9 ;; ten) echo 10 ;;
    *) echo "" ;;
  esac
}

# Count the quoted entries of a `const NAME = [ ... ]` array in init.ts. Handles both
# the multi-line COMMAND_DOCS and the single-line AGENT_DEFS literal.
count_ts_array() {
  awk -v name="$1" '
    index($0, "const " name " = [") > 0 { grab = 1 }
    grab {
      line = $0
      while (match(line, /"[^"]+"/)) {
        cnt++
        line = substr(line, RSTART + RLENGTH)
      }
      if (index($0, "]") > 0) { grab = 0 }
    }
    END { print cnt + 0 }
  ' "$2"
}

# Strip markdown emphasis (`**eight**`) so it can't break word-adjacency in the
# anchored count patterns below.
contract_text="$(tr -d '*' < "$contract")"

cmd_count="$(count_ts_array COMMAND_DOCS "$init_ts")"
def_count="$(count_ts_array AGENT_DEFS "$init_ts")"
[ "$cmd_count" -ge 1 ] || bad "could not parse COMMAND_DOCS from $init_ts (got '$cmd_count')"
[ "$def_count" -ge 1 ] || bad "could not parse AGENT_DEFS from $init_ts (got '$def_count')"

# --- C41: "<word> namespaced commands" must equal cmd_count ------------------------
found_cmd_word=0
while IFS= read -r word; do
  [ -n "$word" ] || continue
  found_cmd_word=1
  num="$(word_to_num "$word")"
  if [ -z "$num" ]; then
    bad "CONTRACT states '$word namespaced commands' — unrecognized number word"
  elif [ "$num" != "$cmd_count" ]; then
    bad "CONTRACT states '$word namespaced commands' ($num) but src/init.ts COMMAND_DOCS has $cmd_count"
  fi
done < <(printf '%s\n' "$contract_text" \
  | grep -oiE '(one|two|three|four|five|six|seven|eight|nine|ten) namespaced commands' \
  | awk '{print tolower($1)}')
[ "$found_cmd_word" -eq 1 ] || bad "CONTRACT.md has no '<word> namespaced commands' count statement to check (C41 drift?)"

# --- F oracle: "(<n> files" for the command docs must equal cmd_count --------------
found_files=0
while IFS= read -r n; do
  [ -n "$n" ] || continue
  found_files=1
  [ "$n" = "$cmd_count" ] || bad "CONTRACT states '($n files)' for the command docs but src/init.ts COMMAND_DOCS has $cmd_count"
done < <(printf '%s\n' "$contract_text" | grep -oE '\(([0-9]+) files' | grep -oE '[0-9]+')
[ "$found_files" -eq 1 ] || bad "CONTRACT.md has no '(<n> files' count statement to check (F-oracle drift?)"

# --- C47: "<word> hardened agent defs" must equal def_count ------------------------
found_def_word=0
while IFS= read -r word; do
  [ -n "$word" ] || continue
  found_def_word=1
  num="$(word_to_num "$word")"
  if [ -z "$num" ]; then
    bad "CONTRACT states '$word hardened agent defs' — unrecognized number word"
  elif [ "$num" != "$def_count" ]; then
    bad "CONTRACT states '$word hardened agent defs' ($num) but src/init.ts AGENT_DEFS has $def_count"
  fi
done < <(printf '%s\n' "$contract_text" \
  | grep -oiE '(one|two|three|four|five|six|seven|eight|nine|ten) hardened agent defs' \
  | awk '{print tolower($1)}')
[ "$found_def_word" -eq 1 ] || bad "CONTRACT.md has no '<word> hardened agent defs' count statement to check (C47 drift?)"

# --- Clause-id uniqueness: every `- **C<n>**` id appears exactly once ---------------
# The suffix is PART of the id — `C32` and `C32a` are two ids, not one twice — so it is
# kept, not stripped. Read from the raw file (not $contract_text, whose `*` are gone).
clause_ids="$( { grep -E '^- \*\*C[0-9][0-9]*[a-z]*\*\*' "$contract" || true; } \
  | sed -e 's/^- \*\*//' -e 's/\*\*.*$//' )"
if [ -z "$clause_ids" ]; then
  bad "CONTRACT.md has no '- **C<n>**' clause lines to check (clause-id lint drift?)"
else
  clause_id_count="$(printf '%s\n' "$clause_ids" | wc -l | tr -d ' ')"
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    bad "CONTRACT.md defines clause $id more than once — clause ids are cited as identifiers and must be unique"
  done < <(printf '%s\n' "$clause_ids" | sort | uniq -d)
fi

[ "$failed" -eq 0 ] || exit 1
echo "CONTRACT lint: PASS (commands=$cmd_count, agent defs=$def_count, clause ids=${clause_id_count:-0} unique)"

if [ "${1:-}" = "--self-test" ]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  self_test_failed=0
  # A third argument, when given, is a fixed string the failure output must contain —
  # so a fixture rejected for some UNRELATED reason cannot read as the case passing.
  expect_rejected() {
    local name="$1" fixture="$2" because="${3:-}" out
    if out="$(CONTRACT_LINT_ROOT="$fixture" bash "$script_path" 2>&1)"; then
      printf 'FAIL: self-test accepted %s\n' "$name" >&2
      self_test_failed=1
    elif [ -n "$because" ] && ! printf '%s\n' "$out" | grep -qF "$because"; then
      printf 'FAIL: self-test rejected %s for the wrong reason (wanted "%s")\n' "$name" "$because" >&2
      self_test_failed=1
    else
      printf 'PASS: rejects %s\n' "$name"
    fi
  }

  expect_accepted() {
    local name="$1" fixture="$2"
    if CONTRACT_LINT_ROOT="$fixture" bash "$script_path" >/dev/null 2>&1; then
      printf 'PASS: accepts %s\n' "$name"
    else
      printf 'FAIL: self-test rejected %s\n' "$name" >&2
      self_test_failed=1
    fi
  }

  # A copy of the real (already-correct) CONTRACT, then targeted mutations of each
  # count statement to prove the lint bites.
  mkfixture() {
    local dir="$tmp/$1"
    mkdir -p "$dir"
    cp "$repo_root/CONTRACT.md" "$dir/CONTRACT.md"
    echo "$dir"
  }

  # Mutations target the count statements in their real markdown form (numbers are
  # emphasized, e.g. `**eight** namespaced commands`).
  f="$(mkfixture wrong-command-word)"
  sed 's/eight\*\* namespaced commands/nine** namespaced commands/' "$repo_root/CONTRACT.md" > "$f/CONTRACT.md"
  expect_rejected "stale spelled command count (nine)" "$f"

  f="$(mkfixture wrong-files-count)"
  sed 's/(8 files/(9 files/' "$repo_root/CONTRACT.md" > "$f/CONTRACT.md"
  expect_rejected "stale F-oracle files count (9)" "$f"

  # Absence, not just mutation: strip the "(N files" phrase entirely — the guard must
  # fail on a DELETED/reformatted anchor, not pass silently by running zero iterations.
  f="$(mkfixture missing-files-count)"
  sed 's/([0-9][0-9]* files/(command docs/g' "$repo_root/CONTRACT.md" > "$f/CONTRACT.md"
  expect_rejected "removed F-oracle files count anchor" "$f"

  f="$(mkfixture wrong-def-word)"
  sed 's/three\*\* hardened agent defs/four** hardened agent defs/' "$repo_root/CONTRACT.md" > "$f/CONTRACT.md"
  expect_rejected "stale spelled agent-def count (four)" "$f"

  # --- clause-id uniqueness (issue #113) -------------------------------------------
  # Duplicate an existing clause LINE verbatim rather than renaming a specific clause,
  # so the case survives any future renumbering.
  # Bracketed `[*]` rather than `\*` — a backslash escape of an ERE operator is where
  # BSD/GNU awk disagree, and the macOS job runs this same file.
  first_clause="$(awk '/^- [*][*]C[0-9][0-9]*[a-z]*[*][*]/ { print; exit }' "$repo_root/CONTRACT.md")"
  f="$(mkfixture duplicate-clause-id)"
  { cat "$repo_root/CONTRACT.md"; printf '%s\n' "$first_clause"; } > "$f/CONTRACT.md"
  expect_rejected "a clause id defined twice" "$f" "more than once"

  # A `Cnn`/`Cnna` PAIR is two distinct ids and must be ACCEPTED — the suffix is part
  # of the id, so a lint that stripped it would call this pair a duplicate (the trap
  # a naive grep for the collision falls into).
  f="$(mkfixture suffixed-pair)"
  { cat "$repo_root/CONTRACT.md"
    printf '%s\n' '- **C999** — fixture clause.' '- **C999a** — fixture clause, suffixed.'
  } > "$f/CONTRACT.md"
  expect_accepted "a Cnn/Cnna pair as two distinct ids" "$f"

  # And the suffix is not merely ignored in the other direction either.
  f="$(mkfixture duplicate-suffixed-id)"
  { cat "$repo_root/CONTRACT.md"
    printf '%s\n' '- **C999a** — fixture clause, suffixed.' '- **C999a** — fixture clause, suffixed again.'
  } > "$f/CONTRACT.md"
  expect_rejected "a suffixed clause id defined twice" "$f" "defines clause C999a more than once"

  # Absence, not just collision: no clause lines at all must fail, never pass silently.
  f="$(mkfixture no-clause-lines)"
  sed 's/^- \*\*C\([0-9]\)/- C\1/' "$repo_root/CONTRACT.md" > "$f/CONTRACT.md"
  expect_rejected "removed clause-id anchors" "$f" "no '- **C<n>**' clause lines"

  # And the real CONTRACT must PASS.
  if ! bash "$script_path" >/dev/null 2>&1; then
    printf 'FAIL: self-test rejected the real CONTRACT.md\n' >&2
    self_test_failed=1
  else
    printf 'PASS: accepts the real CONTRACT.md\n'
  fi

  [ "$self_test_failed" -eq 0 ] || exit 1
  echo "CONTRACT lint self-tests: PASS"
fi
