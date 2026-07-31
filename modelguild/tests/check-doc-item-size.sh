#!/usr/bin/env bash
# Words-per-ITEM reporter for the normative docs (issue #126, child of #122).
#
# WHY ITEM AND NOT LINE. The defect #122 measures is words per item. Line length is a
# proxy that only coincides with it where an item happens to be one physical line —
# reflow a clause to 80 columns and a line-length lint reports success while the item
# is byte-identical. That is not hypothetical here: measured at 935f8f1, the LARGEST
# item in each file is invisible to a line-length check.
#     CONTRACT.md  C73                  2958 words over 7 lines, 288 on its first
#     AGENTS.md    `src/init.ts`        3601 words over 10 lines,  27 on its first
# So an item runs from its start line to the next start line: `- **C<n>**` in
# CONTRACT.md, a top-level `- ` bullet elsewhere. Blank and indented lines (nested
# sub-bullets, continuation paragraphs) belong to the open item; the first non-blank
# column-0 line closes it. Words are whitespace-separated tokens, as `wc -w` counts.
# The --self-test asserts a reflowed item reports its true count; that assertion is
# what stops this degrading into a formatter.
#
# THRESHOLDS (measured at 935f8f1; re-measure before changing either).
#   CONTRACT.md 700 — curve-fitted to the six clauses #122 targets, and it holds under
#     item measurement: over-threshold is C73 2958, C68 2289, C69a 1483, C71 1283,
#     C72 1133, C70 970, C33a 752; next largest C37 654, a 46-word margin. It is a
#     TRIPWIRE FITTED TO SEVEN POINTS, not a law — hence the escape hatch below.
#   AGENTS.md 700 — PROVISIONAL. That file has no target set to fit, so this is not an
#     independent derivation and is not presented as one. What the distribution says:
#     56 items, median 145, mean 410, p75 376, p90 909, max 3601. 700 sits at the 82nd
#     percentile and inside a real gap (any value in 638..708 selects the same 10
#     bullets), which is why it is tolerable rather than why it is right. RE-DERIVE
#     from the then-current distribution once AGENTS.md extraction lands.
#
# ESCAPE HATCH. An item may cite an issue to be exempted: put `doc-size-exempt: #<n>`
# anywhere in it, conventionally an HTML comment so it does not render. Requiring an
# explicit marker is deliberate — nearly every clause already cites an issue number,
# so "cites an issue" would exempt everything. Exempt items are still PRINTED with
# their size and their issue; an escape hatch that hides the item kills the tripwire.
#
# PROMOTION TRIGGER (the condition for becoming an error — concrete, in the same
# commit as the warning, because a warning with no stated promotion condition is a
# convention with a shell script attached, which is the failure #122 exists to avoid):
#   This is warn-only (exit 0) until the #122 pilot extraction, issue #127, MERGES.
#   The PR that merges #127 sets STRICT_DEFAULT=1 below, in that same PR; from then on
#   an over-threshold, unexempted item is exit 1 and the escape hatch is the marker.
#   If #127 is closed unmerged, this script is DELETED rather than left warning forever.
#   `--strict` runs the promoted behaviour today, so the flip is a tested one-line change.
# Two things are hard failures NOW, warn-only or not: a file that yields zero items
# (the start-line anchor drifted and this lint has gone vacuous), and an unreadable file.
set -euo pipefail

STRICT_DEFAULT=0   # PROMOTION TRIGGER: set to 1 in the PR that merges #127.

CONTRACT_THRESHOLD=700
AGENTS_THRESHOLD=700   # provisional; see header

script_path="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
root="${DOC_ITEM_SIZE_ROOT:-$repo_root}"

strict="$STRICT_DEFAULT"
self_test=0
files=()
nfiles=0
for arg in "$@"; do
  case "$arg" in
    --self-test) self_test=1 ;;
    --strict) strict=1 ;;
    -*) echo "usage: $(basename "$0") [--strict] [--self-test] [file...]" >&2; exit 2 ;;
    # Indexed assignment, not `+=`: bash 3.2 has it and it needs no empty-array guard.
    *) files[nfiles]="$arg"; nfiles=$((nfiles + 1)) ;;
  esac
done
if [ "$nfiles" -eq 0 ]; then
  files=("$root/CONTRACT.md" "$root/AGENTS.md")
fi

# Emit one TSV row per item: words <TAB> lines <TAB> start-line <TAB> exempt-issue <TAB> label.
# Bracketed [*] rather than \* throughout: a backslash-escaped ERE operator is where
# BSD and GNU awk disagree, and the macOS CI job runs this same file.
measure() {
  awk -v mode="$2" -v startpat="$3" '
    function acc() { words += NF; nlines++; buf = buf " " $0 }
    function mklabel(l,   t, i, n, out, arr) {
      if (mode == "clause") { t = l; sub(/^- [*][*]/, "", t); sub(/[*][*].*/, "", t); return t }
      t = l
      sub(/^-[ \t]+/, "", t)
      gsub(/[*`]/, "", t)
      n = split(t, arr, /[ \t]+/)
      out = ""
      for (i = 1; i <= n && i <= 9; i++) out = out (i > 1 ? " " : "") arr[i]
      return out
    }
    function flush(   s, ex) {
      if (!open) return
      ex = "-"
      s = tolower(buf)
      if (match(s, /doc-size-exempt:[ \t]*#[0-9]+/)) {
        ex = substr(s, RSTART, RLENGTH); sub(/.*#/, "", ex)
      }
      printf "%d\t%d\t%d\t%s\t%s\n", words, nlines, at, ex, label
      open = 0
    }
    BEGIN { open = 0; fence = 0 }
    {
      # A fenced block belongs to the item that opened it, at ANY indentation. Without
      # this, a column-0 line inside a fence looks like the start of the next item and
      # SILENTLY TRUNCATES the count — in the permissive direction, so an oversized item
      # passes. was_fence keeps the closing ``` inside too, since the toggle above has
      # already cleared the flag by the time the close branch runs.
      was_fence = fence
      if ($0 ~ /^[ \t]*```/) { fence = 1 - fence }
      if (!fence && !was_fence && $0 ~ startpat) {
        flush(); open = 1; words = 0; nlines = 0; buf = ""; at = NR
        label = mklabel($0); acc(); next
      }
      if (open) {
        if (fence || was_fence) { acc(); next }
        if ($0 ~ /^[ \t]*$/) next
        if ($0 ~ /^[ \t]/) { acc(); next }
        flush()
      }
    }
    END { flush() }
  ' "$1"
}

failed=0
warned=0
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

report_file() {
  local path="$1" base mode startpat threshold rows n over exempt
  base="$(basename "$path")"
  if [ "$base" = "CONTRACT.md" ]; then
    mode=clause
    startpat='^- [*][*]C[0-9][0-9]*[a-z]*[*][*]'
    threshold="$CONTRACT_THRESHOLD"
  else
    mode=bullet
    startpat='^- '
    threshold="$AGENTS_THRESHOLD"
  fi

  if [ ! -r "$path" ]; then
    printf 'FAIL: cannot read %s\n' "$path" >&2
    failed=1
    return
  fi

  rows="$tmp/$base.tsv"
  measure "$path" "$mode" "$startpat" | sort -rn > "$rows"
  n="$(awk 'END { print NR + 0 }' "$rows")"
  if [ "$n" -eq 0 ]; then
    printf 'FAIL: %s yielded ZERO items for pattern %s — the start-line anchor drifted and this lint is vacuous\n' \
      "$path" "$startpat" >&2
    failed=1
    return
  fi

  printf '\n%s — %s items (%s), threshold %s words\n' "$base" "$n" \
    "$([ "$mode" = clause ] && echo 'clause `- **C<n>**` to next clause' || echo 'top-level `- ` bullet to next')" \
    "$threshold"
  awk -F'\t' '
    { w[NR] = $1; s += $1 }
    END {
      med = (NR % 2) ? w[int((NR + 1) / 2)] : int((w[NR / 2] + w[NR / 2 + 1]) / 2)
      printf "  mean %d  median %d  max %d  total %d\n", s / NR, med, w[1], s
    }
  ' "$rows"

  over="$(awk -F'\t' -v t="$threshold" '$1 >= t && $4 == "-" { c++ } END { print c + 0 }' "$rows")"
  exempt="$(awk -F'\t' -v t="$threshold" '$1 >= t && $4 != "-" { c++ } END { print c + 0 }' "$rows")"

  if [ "$over" -gt 0 ] || [ "$exempt" -gt 0 ]; then
    printf '    WORDS  LINES  AT     ITEM\n'
    awk -F'\t' -v t="$threshold" '$1 >= t {
      printf "  %7d  %5d  %-5d  %s%s\n", $1, $2, $3, $5, ($4 == "-" ? "" : "   [exempt: #" $4 "]")
    }' "$rows"
  fi
  awk -F'\t' -v t="$threshold" '$1 < t { printf "  largest under threshold: %s at %d words (margin %d)\n", $5, $1, t - $1; exit }' "$rows"

  if [ "$over" -gt 0 ]; then
    printf '  %s: %d item(s) over %d words%s\n' \
      "$([ "$strict" -eq 1 ] && echo FAIL || echo WARN)" "$over" "$threshold" \
      "$([ "$exempt" -gt 0 ] && echo " ($exempt exempt, listed above)" || echo "")"
    if [ "$strict" -eq 1 ]; then failed=1; else warned=1; fi
  else
    printf '  OK: no unexempted item over %d words%s\n' "$threshold" \
      "$([ "$exempt" -gt 0 ] && echo " ($exempt exempt, listed above)" || echo "")"
  fi
}

for f in "${files[@]}"; do
  report_file "$f"
done

echo
if [ "$failed" -ne 0 ]; then
  echo "doc item-size: FAIL"
  exit 1
fi
if [ "$warned" -ne 0 ]; then
  echo "doc item-size: WARN (reporting only — becomes an error in the PR that merges #127; see this script's header)"
else
  echo "doc item-size: PASS"
fi

if [ "$self_test" -eq 1 ]; then
  echo
  echo "--- self-test ---"
  st_failed=0
  st="$tmp/selftest"
  mkdir -p "$st"

  # N words of filler, space-separated on one line.
  filler() { awk -v n="$1" 'BEGIN { for (i = 1; i <= n; i++) printf "w%d ", i; printf "\n" }'; }
  # The same N words, reflowed at 10 per line, each continuation line indented.
  filler_reflowed() {
    awk -v n="$1" 'BEGIN {
      for (i = 1; i <= n; i++) {
        if (i > 1 && (i - 1) % 10 == 0) printf "\n  "
        printf "w%d ", i
      }
      printf "\n"
    }'
  }
  run() { DOC_ITEM_SIZE_ROOT="$st" bash "$script_path" "$@" 2>&1; }
  ok() { printf 'PASS: %s\n' "$1"; }
  no() { printf 'FAIL: %s\n' "$1" >&2; st_failed=1; }

  # --- THE LOAD-BEARING ASSERTION: counts by ITEM, not by LINE ----------------------
  # Two fixtures with the SAME clause words: one physical line, and the same text
  # reflowed across many short lines. A line-length lint passes the second. This must
  # report the same true count for both, and flag both.
  { printf -- '- **C1** — '; filler 800; } > "$st/one-line.md"
  { printf -- '- **C1** — '; filler_reflowed 800; } > "$st/reflowed.md"
  flat_words="$(run "$st/one-line.md" | awk '$0 ~ /^  *[0-9]+ / { print $1; exit }')"
  reflow_words="$(run "$st/reflowed.md" | awk '$0 ~ /^  *[0-9]+ / { print $1; exit }')"
  # Independent oracle: each fixture is exactly one item, so `wc -w` of the whole file
  # is that item's word count without reusing this script's own parser.
  oracle="$(wc -w < "$st/one-line.md" | tr -d ' ')"
  longest_line="$(awk '{ if (length($0) > m) m = length($0) } END { print m + 0 }' "$st/reflowed.md")"
  if [ "$flat_words" = "$oracle" ] && [ "$reflow_words" = "$oracle" ]; then
    ok "counts by ITEM not by line: one-line and reflowed both report $oracle words (wc -w oracle)"
  else
    no "by-item assertion: one-line=$flat_words reflowed=$reflow_words oracle=$oracle"
  fi
  if [ "$longest_line" -lt 120 ]; then
    ok "the reflowed fixture's longest line is $longest_line chars — a line-length lint would pass it, this does not"
  else
    no "reflowed fixture is not actually reflowed (longest line $longest_line)"
  fi
  if run "$st/reflowed.md" | grep -q 'WARN: 1 item(s) over'; then
    ok "the reflowed over-threshold item is reported"
  else
    no "the reflowed over-threshold item was not reported"
  fi

  # --- a fenced block belongs to the item that opened it ---------------------------
  # A column-0 line inside a ``` fence is not a new item. Getting this wrong truncates
  # the count SILENTLY and in the permissive direction, so an oversized item passes.
  # The oracle is `wc -w` of a file that is exactly one item, again not this parser.
  {
    printf -- '- **C1** — '; filler 400
    printf '  ```\n'; printf 'flush left inside the fence\n'; printf '  ```\n'
    printf '  tail after the fence\n'
  } > "$st/fenced.md"
  fence_oracle="$(wc -w < "$st/fenced.md" | tr -d ' ')"
  fence_items="$(run "$st/fenced.md" | awk '/^fenced\.md/ { print $3; exit }')"
  fence_words="$(run "$st/fenced.md" | awk '/largest under threshold/ { print $(NF-3); exit }')"
  if [ "$fence_items" = "1" ] && [ "$fence_words" = "$fence_oracle" ]; then
    ok "a fenced block's column-0 lines stay in the open item ($fence_oracle words, 1 item)"
  else
    no "fence handling: items=$fence_items words=$fence_words oracle=$fence_oracle (expected 1 item)"
  fi

  # --- under threshold is not flagged ----------------------------------------------
  { printf -- '- **C1** — '; filler 300; } > "$st/small.md"
  if run "$st/small.md" | grep -q 'OK: no unexempted item'; then
    ok "an item under the threshold is not flagged"
  else
    no "an under-threshold item was flagged"
  fi

  # --- escape hatch: cite an issue --------------------------------------------------
  { printf -- '- **C1** — <!-- doc-size-exempt: #126 --> '; filler 800; } > "$st/exempt.md"
  out="$(run "$st/exempt.md")"
  if printf '%s\n' "$out" | grep -q 'OK: no unexempted item' \
     && printf '%s\n' "$out" | grep -q '\[exempt: #126\]'; then
    ok "an item citing an issue is exempted AND still printed with its size"
  else
    no "the escape hatch did not exempt-and-print"
  fi
  # And a bare issue reference is NOT an exemption (otherwise every clause is exempt).
  { printf -- '- **C1** — (issue #126) '; filler 800; } > "$st/bare-issue.md"
  if run "$st/bare-issue.md" | grep -q 'WARN: 1 item(s) over'; then
    ok "a bare issue reference does not exempt"
  else
    no "a bare issue reference wrongly exempted the item"
  fi

  # --- bullet mode: nested sub-bullets belong to their parent item -------------------
  { printf -- '- top level bullet with a short first line\n'
    printf -- '  - nested: '; filler 400
    printf -- '  - nested: '; filler 400
  } > "$st/nested.md"
  if run "$st/nested.md" | grep -q 'WARN: 1 item(s) over'; then
    ok "a top-level bullet carries its nested sub-bullets' words"
  else
    no "nested sub-bullets were not counted into the parent item"
  fi
  # ...and the next top-level bullet starts a new item rather than extending it.
  { printf -- '- first bullet: '; filler 400
    printf -- '- second bullet: '; filler 400
  } > "$st/two-bullets.md"
  if run "$st/two-bullets.md" | grep -q 'OK: no unexempted item'; then
    ok "a following top-level bullet closes the previous item"
  else
    no "two 400-word bullets were merged into one item"
  fi

  # --- vacuity guard: zero items is a hard FAIL even in warn-only mode ---------------
  printf 'no items here at all, just a paragraph.\n' > "$st/CONTRACT.md"
  if run "$st/CONTRACT.md" >/dev/null 2>&1; then
    no "a file with zero items passed (the lint would be silently vacuous)"
  else
    ok "a file with zero items is a hard FAIL (anchor-drift guard)"
  fi

  # --- warn-only today, exit 1 under --strict ---------------------------------------
  if run "$st/reflowed.md" >/dev/null 2>&1; then
    ok "warn-only: an over-threshold item exits 0 today"
  else
    no "warn-only mode exited non-zero"
  fi
  if run --strict "$st/reflowed.md" >/dev/null 2>&1; then
    no "--strict accepted an over-threshold item"
  else
    ok "--strict exits 1 on an over-threshold item (the promoted behaviour, tested today)"
  fi

  # --- the real documents parse ------------------------------------------------------
  if bash "$script_path" >/dev/null 2>&1; then
    ok "the real CONTRACT.md and AGENTS.md parse and report"
  else
    no "the real documents did not report cleanly"
  fi

  [ "$st_failed" -eq 0 ] || { echo "doc item-size self-tests: FAIL" >&2; exit 1; }
  echo "doc item-size self-tests: PASS"
fi
