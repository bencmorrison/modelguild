#!/usr/bin/env bash
# check-agent-permissions.sh — SOURCE-level lint of the hardened agent defs'
# permission maps. Opencode-free (bash/awk only), so CI can run it per-commit
# without installing opencode. It does NOT prove opencode's resolved enforcement
# (that's `verify-guild-*.sh`, which needs the opencode binary) — it guards the
# realistic regression: a human edits `.opencode/agent/*.md` and weakens it.
#
# It asserts the default-deny-allowlist invariants, computed the way opencode
# resolves them (LAST-MATCH-WINS), on the FRONTMATTER ONLY:
#   - NO duplicate top-level frontmatter key (issue #100)
#   - `mode: all` (a `mode: subagent` def silently falls back to full-access build)
#   - the effective floor is deny (an un-listed tool resolves to deny)
#   - every tool's EFFECTIVE action (last rule matching the tool name OR `*`) is
#     allow iff it's in the agent's intended allow-set, else deny
#   - `read` is a PLAIN top-level allow with NO secret-glob submap, on ALL THREE
#     agents — the read paths since the 2026-07-22 realignment, guild-build since
#     the 2026-07-29 maintainer decision (issue #29). The invariant is INVERTED from
#     what it used to be for guild-build: a re-added carve-out is now the regression.
#
# Order-aware + frontmatter-bounded on purpose: earlier presence-only checks on the
# whole file were fooled three ways (found by dogfooding /guild:review 2026-07-15) — an
# unprotected frontmatter passed via a look-alike block in the markdown BODY; a
# `"*": deny` placed AFTER the allows (or a `"*": allow` placed after the re-allows)
# passed while resolving the opposite way. This version reads only the frontmatter
# and computes effective (last-match) actions, so those all fail as they should.
#
# Run:  bash modelguild/tests/check-agent-permissions.sh   (exit 0 = all invariants hold)
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
cd "$repo_root" || exit 1

# Where the hardened agent defs live. Default is the repo-relative .opencode/agent
# (unchanged for CI and the checkout). A --global install places them in opencode's
# global agent dir; doctor.sh passes that here via $GUILD_AGENT_DIR so the SAME lint
# guards the globally-installed defs. An absolute override is cwd-independent.
AGENT_DIR="${GUILD_AGENT_DIR:-.opencode/agent}"

fail=0
pass() { printf '\033[32mok\033[0m   %s\n' "$*"; }
bad()  { printf '\033[31mFAIL\033[0m %s — %s\n' "$1" "$2"; fail=1; }

KNOWN_TOOLS="bash edit write patch grep glob task todowrite webfetch websearch lsp skill"

# frontmatter <file> : the YAML between the first `---` and the next `---`. Anything
# in the markdown body (after the closing fence) is ignored — a look-alike block
# there must not influence the result.
frontmatter() { awk 'NR==1 && $0=="---"{f=1;next} f && $0=="---"{exit} f' "$1"; }

# fm_defects  (stdin = frontmatter) : one short description per structural defect that
# makes opencode unable to parse the def (see check_agent for what that costs). Two are
# detected — a repeated key, and tab indentation. Empty output = none found.
#
# SCOPE-AWARE, not a flat key-name count. `"*"` may legitimately appear once in the
# `permission:` map and again inside a `read:` submap — different mappings, different
# keys — and flagging that would reject a def opencode accepts (probed: such a def
# resolves with its floor and allow-set intact). So each mapping gets its own key
# namespace, identified by a scope id that only ever INCREASES: re-entering a deeper
# indent mints a fresh id rather than reusing the popped one, which is what lets the
# stack unwind without deleting the popped scopes' keys — `delete arr[k]` in a loop is
# the portability trap here (bash 3.2 / BSD awk), and this sidesteps it entirely.
#
# Line numbers are reported as FILE lines: the frontmatter stream starts at file line 2
# (line 1 is the opening `---`, which frontmatter() drops), hence the +1.
#
# Known limits, all noted rather than guessed at:
#   - Block scalars (`key: |` / `key: >-`) are tracked and their CONTENT skipped. Without
#     that, prose in `description: >-` would be read as keys — several of its lines carry
#     a `:` — and could collide into a false duplicate.
#   - A sequence (`- a: 1` / `- a: 2`) would read as one scope and flag a false duplicate.
#     opencode's agent frontmatter schema has no top-level sequence, so this is
#     unreachable from a real def; scope-awareness does not make it fall out for free
#     (each `-` item is its own mapping), so it is left undone deliberately.
#   - Inline flow mappings (`key: {a: 1, a: 2}`) and a quoted key containing a `:` are
#     not parsed. Neither appears in an agent def; both would be missed, not misreported.
fm_defects() {
  awk '
    { line = $0 }
    line ~ /^[ \t]*$/ { next }                        # blank

    # Inside a block scalar: everything more indented than its key is CONTENT. Leading
    # whitespace is measured loosely here (tabs included) so tab-led prose stays content
    # and is not mistaken for tab INDENTATION, which is what actually breaks the parse.
    {
      match(line, /^[ \t]*/); ws = RLENGTH
    }
    inscalar { if (ws > scalar_ind) next; inscalar = 0 }

    # Tab indentation. Invalid YAML, and opencode voids the whole def over it (probed),
    # so it is a defect in its own right rather than a line to skip.
    index(substr(line, 1, ws), "\t") {
      print "tab indentation at line " (FNR + 1) " (YAML indentation must be spaces)"
      next
    }

    {
      match(line, /^ */); ind = RLENGTH
      rest = substr(line, ind + 1)
    }
    rest ~ /^#/ { next }                              # comment: no effect on scope

    {
      i = index(rest, ":"); if (!i) next              # not a mapping key
      k = substr(rest, 1, i - 1)
      v = substr(rest, i + 1)
      gsub(/^[ \t]+|[ \t]+$/, "", k); gsub(/^[ \t]+|[ \t]+$/, "", v)
      gsub(/"/, "", k); gsub(/\047/, "", k)           # \047 = single quote (mawk/BSD-safe)
      if (k == "") next

      # Pop to this indent, or open a new (freshly numbered) scope one level deeper.
      while (sp > 0 && sind[sp] > ind) sp--
      if (sp == 0 || sind[sp] < ind) { sp++; sind[sp] = ind; nextid++; sid[sp] = nextid }

      # Scope-qualified key, joined by hand rather than with awk multi-subscripts:
      # `arr[a, b]` / `(a, b) in arr` are POSIX but are the least-exercised corner of
      # the language, and this repo has never run them on BSD awk. A single subscript
      # needs nothing beyond what every awk does. The separator is a control character
      # so it cannot occur in an indent-derived scope id or a YAML key.
      sk = sid[sp] "\001" k
      if (sk in firstline)
        print "duplicate key \047" k "\047 at line " (FNR + 1) \
              " (already set at line " firstline[sk] ")"
      else
        firstline[sk] = FNR + 1

      if (v ~ /^[|>]/) { inscalar = 1; scalar_ind = ws }
    }'
}

# top_perms  (stdin = frontmatter) : "key|value" for each 2-space-indented entry in
# the permission: block (top level; the 4-space read sub-map is skipped). Quotes
# stripped from the key so `"*"` -> `*`.
top_perms() {
  awk '
    /^permission:/{p=1;next}
    p && /^[^ ]/{p=0}
    p && /^  [^ ]/{
      line=$0; sub(/^  /,"",line)
      i=index(line,":"); if(!i) next
      k=substr(line,1,i-1); v=substr(line,i+1)
      gsub(/^[ \t]+|[ \t]+$/,"",k); gsub(/^[ \t]+|[ \t]+$/,"",v)
      gsub(/"/,"",k); gsub(/\047/,"",k)   # strip quotes (octal \047 = single quote; mawk/BSD-safe)
      print k "|" v
    }'
}
# read_map  (stdin = frontmatter) : "pattern|value" for the 4-space entries under read:.
read_map() {
  awk '
    /^permission:/{p=1}
    p && /^  read:/{r=1;next}
    r && /^  [^ ]/{r=0}
    r && /^    [^ ]/{
      line=$0; sub(/^    /,"",line)
      i=index(line,":"); if(!i) next
      k=substr(line,1,i-1); v=substr(line,i+1)
      gsub(/^[ \t]+|[ \t]+$/,"",k); gsub(/^[ \t]+|[ \t]+$/,"",v)
      gsub(/"/,"",k); gsub(/\047/,"",k)
      print k "|" v
    }'
}

# effective <entries> <key> : action of the LAST entry whose key equals <key> or `*`
# (opencode's last-match-wins). Empty if nothing matched. This is what makes the
# check order-aware — a later `*` rule overrides an earlier tool rule and vice-versa.
effective() {
  local entries="$1" key="$2" k v act=""
  while IFS='|' read -r k v; do
    [ -n "$k" ] || continue
    if [ "$k" = "$key" ] || [ "$k" = '*' ]; then act="$v"; fi
  done <<EOF
$entries
EOF
  printf '%s' "$act"
}

# check_agent <file> <space-separated expected-allow tools>
#
# `read` is checked separately from the tool loop because it is the one permission that
# can carry a sub-map. All three agents now want the SAME shape — a plain top-level
# `read: allow` with no carve-outs — so there is no longer a per-agent read-spec: the
# read paths lost their secret globs in the 2026-07-22 realignment and guild-build lost
# its on 2026-07-29 (issue #29). Keeping one shape means a re-fence anywhere is a fail.
check_agent() {
  local f="$1" expect="$2" label f0="$fail"; label="$(basename "$f")"
  if [ ! -f "$f" ]; then bad "$label" "file not found"; return; fi
  local fm; fm="$(frontmatter "$f")"
  [ -n "$fm" ] || { bad "$label" "no YAML frontmatter block (first line must be '---', closed by '---')"; return; }

  # FRONTMATTER opencode CAN PARSE (issue #100). THE CONDITION IS THE PARSE, NOT THE
  # SYNTAX ERRORS LISTED BELOW — duplicate keys and tab indentation are the two
  # instances this lint detects, not a closed enumeration of what can break it. If
  # another shape turns up, it belongs here too.
  #
  # WHY IT MATTERS, probed on opencode 1.18.7 (2026-07-29, `opencode agent list` — the
  # resolved config the tool layer enforces, the same source verify-guild-*.sh calls
  # authoritative): frontmatter opencode cannot parse is applied in NO part. The def's
  # permission rules are absent entirely and the agent resolves with opencode's
  # built-ins alone, ending at `"*": allow` — the default-deny floor is simply not
  # there. `mode` falls back to its default (`all`) too, so on a NESTED duplicate there
  # is not even a mode tell: `mode: all` reads correctly while guild-read runs with
  # bash/edit/write/task allowed. Probed: a duplicate at top level (`mode`, `permission`
  # or `description`), a duplicate INSIDE the permission map (`read: allow` twice), and
  # a tab-indented line each void the def; an otherwise-identical control resolves with
  # its floor and allow-set intact. Nothing is printed to warn about it, and it is
  # invisible to every other check here, which reads the SOURCE file — where the floor
  # still is, in full, looking correct.
  #
  # A DUPLICATE IS THE DEFECT, whichever way it resolves — deliberately not a last-match
  # rule. A last-match check would have to assert which of the two values opencode's
  # parser honours, and asserting that from assumption is how the hole below got here:
  # `mode: all` was checked by PRESENCE, so `mode: all` followed by `mode: subagent`
  # passed. Rejecting the duplicate outright means the lint never has to know — and the
  # probe above shows it is just as well, since neither value wins.
  # One `bad` per defect: each names the key and line, so a def with two of them reports
  # both rather than only the first. No defect text contains a newline.
  local defect; while IFS= read -r defect; do
    [ -n "$defect" ] || continue
    bad "$label" "frontmatter opencode cannot parse — $defect. Such a def is applied in NO part (probed, 1.18.7): the permission map is dropped and the agent resolves to opencode's built-in '\"*\": allow' with no floor"
  done <<EOF
$(printf '%s\n' "$fm" | fm_defects)
EOF

  # With duplicates rejected above, a matching `mode: all` line is the ONLY `mode` key
  # in the frontmatter's top-level scope, so presence is sufficient here — the two
  # checks compose. (It is also why this check must run FIRST.)
  printf '%s\n' "$fm" | grep -qx 'mode: all' \
    || bad "$label" "frontmatter missing 'mode: all' (a subagent def silently falls back to full-access build)"

  local tp; tp="$(printf '%s\n' "$fm" | top_perms)"

  # Effective floor: any tool with no rule of its own must resolve to deny.
  [ "$(effective "$tp" '__floor_probe__')" = "deny" ] \
    || bad "$label" "no effective '\"*\": deny' floor — un-listed tools resolve to allow (missing floor, or a later '\"*\": allow' re-opens everything)"

  # Build the set of tools to check: the known surface + any tool explicitly named
  # at top level (catches an unknown/new tool set to allow). Then each must resolve
  # to allow iff it's in the intended allow-set.
  local keys="$KNOWN_TOOLS" k v
  while IFS='|' read -r k v; do
    case "$k" in ''|'*'|read) continue ;; esac
    case " $keys " in *" $k "*) ;; *) keys="$keys $k" ;; esac
  done <<EOF
$tp
EOF
  local t effact
  for t in $keys; do
    effact="$(effective "$tp" "$t")"
    case " $expect " in
      *" $t "*) [ "$effact" = "allow" ] || bad "$label" "tool '$t' should be ALLOWED but resolves to '${effact:-deny(floor)}'" ;;
      *)        [ "$effact" = "allow" ] && bad "$label" "tool '$t' resolves to ALLOW but is not in the intended allow-set (unintended capability)" || true ;;
    esac
  done

  # read: a plain top-level `read: allow`, no submap. Both halves are asserted —
  # the effective action (so a later `"*": deny` that kills reads is caught) and the
  # ABSENCE of a carve-out submap (so a re-added secret-glob fence is caught). The
  # second half is the inverted invariant: those fences were removed as vendor-asymmetry
  # bias on the read paths (2026-07-22) and as a fence bash walks through on guild-build
  # (2026-07-29, issue #29), so re-adding one re-implies a boundary that does not exist.
  local rm; rm="$(printf '%s\n' "$fm" | read_map)"
  [ "$(effective "$tp" read)" = "allow" ] \
    || bad "$label" "read resolves to '$(effective "$tp" read)', expected a plain top-level 'read: allow'"
  [ -z "$rm" ] \
    || bad "$label" "read has a submap; every agent expects a plain 'read: allow' with NO secret-glob carve-outs (removed 2026-07-22 on the read paths, 2026-07-29 on guild-build — do not re-fence)"

  [ "$fail" -eq "$f0" ] && pass "$label: allowlist invariants hold (frontmatter-bounded, effective/last-match-aware)"
}

# --self-test: prove THIS lint catches the realistic weakenings a human edit could make
# (ported from the retired run-tests.sh meta-tests; the guild-watch cases went with the
# retired witness agent). It re-invokes the lint against crafted agent dirs and asserts it
# passes the real defs and fails each tampered one. Opencode-free; run in CI + doctor.sh.
if [ "${1:-}" = "--self-test" ]; then
  SELF="$here/$(basename "${BASH_SOURCE[0]}")"
  REAL="$repo_root/.opencode/agent"
  st_fail=0
  st_ok() { printf '\033[32mok\033[0m   self-test: %s\n' "$1"; }
  st_no() { printf '\033[31mFAIL\033[0m self-test: %s\n' "$1"; st_fail=1; }
  run_variant() { GUILD_AGENT_DIR="$1" bash "$SELF" >/dev/null 2>&1; }
  # Same run, but returning the output — for cases that must assert WHICH check fired,
  # not merely that something did (see S13).
  run_variant_out() { GUILD_AGENT_DIR="$1" bash "$SELF" 2>&1; }
  d="$(mktemp -d "${TMPDIR:-/tmp}/modelguild-aplint.XXXXXX")"; mkdir -p "$d/agent"
  seed() { cp "$REAL/guild-read.md" "$REAL/guild-build.md" "$REAL/guild-research.md" "$d/agent/"; }

  # S1. The real defs pass.
  seed
  run_variant "$d/agent" && st_ok "real agents pass" || st_no "lint rejects the real agents (false positive)"

  # S2. `write` re-added to guild-read's allow-set (no-write ROLE broken) -> FAIL.
  seed
  printf '%s\n' '---' 'description: x' 'mode: all' 'permission:' '  "*": deny' \
    '  read: allow' '  grep: allow' '  glob: allow' '  webfetch: allow' '  websearch: allow' \
    '  write: allow' '---' 'body' > "$d/agent/guild-read.md"
  run_variant "$d/agent" && st_no "MISSED write re-added to guild-read" || st_ok "catches write re-added to the read-only guild-read allow-set"

  # S3. Unprotected frontmatter (no floor) with a valid-looking block in the BODY -> FAIL.
  seed
  printf '%s\n' '---' 'description: x' 'mode: all' '---' 'Example (not real frontmatter):' \
    'permission:' '  "*": deny' '  read:' '    "*": allow' > "$d/agent/guild-read.md"
  run_variant "$d/agent" && st_no "MISSED unprotected frontmatter (body block fooled it)" || st_ok "ignores body block, catches missing floor"

  # S4. guild-build with '*': deny placed AFTER the allows (effective = all denied) -> FAIL.
  # Every key here is DISTINCT, so opencode parses the map and last-match-wins genuinely
  # governs — probed on 1.18.7: the resolved config carries `edit: allow`, `bash: allow`
  # and then `"*": deny`, in declaration order. That is what makes `effective()`'s model
  # sound for a well-formed def, and it is the case to contrast with S6 below.
  seed
  printf '%s\n' '---' 'description: x' 'mode: all' 'permission:' '  edit: allow' '  write: allow' \
    '  patch: allow' '  bash: allow' '  "*": deny' '  read:' '    "*": allow' '---' 'body' \
    > "$d/agent/guild-build.md"
  run_variant "$d/agent" && st_no "MISSED guild-build floor-after-allows (edit path dead)" || st_ok "catches '*': deny placed after the allows"

  # S5. A secret-glob read submap RE-ADDED to guild-build -> FAIL. This case is the
  # inverse of the one it replaces (which asserted a glob was PRESENT): the canonical
  # set was dropped on 2026-07-29 (issue #29) because bash `cat` walked through it, so
  # re-fencing the read tool is now the regression — it re-implies a credential boundary
  # bash does not have. Nothing here says the removal made anything safer: it took a layer
  # off, and the layer did refuse a COMPLIANT model (SECURITY.md states that cost). What it
  # never was is a boundary against a determined one.
  seed
  awk '{ if ($0=="  read: allow") { print "  read:"; print "    \"*\": allow"; print "    \"*.env\": deny" } else print }' \
    "$REAL/guild-build.md" > "$d/agent/guild-build.md"
  run_variant "$d/agent" && st_no "MISSED a re-added secret-glob read submap on guild-build" || st_ok "catches a re-added secret-glob read carve-out (guild-build)"

  # S6. A `"*": allow` appended AFTER guild-build's floor -> FAIL. Guards the floor
  # invariant in the direction S4 does not: S4 moves the floor after the allows, this one
  # leaves the floor in place and adds a wider rule below it.
  #
  # CORRECTED (issue #100): this comment used to say last-match-wins re-opens everything.
  # It does not, on 1.18.7 — appending `"*": allow` makes `"*"` appear TWICE, and a
  # duplicate key voids the whole def (probed: resolved config is built-ins only). So the
  # def ends up wide open either way, but by the void, not by last-match. The FAIL verdict
  # is unchanged and the case is still worth keeping — the source-level invariant "no
  # `"*": allow` under the floor" holds regardless of which mechanism opencode applies,
  # and it is the invariant a reader of the def is checking. Contrast S4, where the keys
  # are distinct and last-match genuinely governs.
  seed
  awk '{print} /^  bash: allow$/{print "  \"*\": allow"}' "$REAL/guild-build.md" > "$d/agent/guild-build.md"
  run_variant "$d/agent" && st_no "MISSED a '\"*\": allow' after the floor on guild-build" || st_ok "catches a '\"*\": allow' overriding the deny floor"

  # S7. An extra capability (webfetch) added to guild-build -> FAIL. Guards the
  # allow-set-is-exact invariant: the floor is intact and every intended tool still
  # resolves to allow, so only the "not in the intended allow-set" check can catch this.
  seed
  awk '{print} /^  bash: allow$/{print "  webfetch: allow"}' "$REAL/guild-build.md" > "$d/agent/guild-build.md"
  run_variant "$d/agent" && st_no "MISSED webfetch added to guild-build's allow-set" || st_ok "catches an unintended capability added to the allow-set"

  # S8. `mode: subagent` appended AFTER `mode: all` on guild-read -> FAIL. The issue-#100
  # hole itself: the mode check was by PRESENCE, so `mode: all` still matched and every
  # other invariant still held, leaving nothing to fail the def. A duplicate key is a
  # plausible MERGE ARTIFACT (two branches touching frontmatter, a conflict resolved by
  # keeping both sides) — the "a human edited an agent .md and weakened it" class this
  # lint exists for, with CI green. Only the duplicate-key check can catch this one.
  seed
  awk '{print} /^mode: all$/{print "mode: subagent"}' "$REAL/guild-read.md" > "$d/agent/guild-read.md"
  run_variant "$d/agent" && st_no "MISSED 'mode: subagent' duplicated after 'mode: all'" || st_ok "catches a duplicate mode: key overriding 'mode: all'"

  # S9. The SAME duplicate in the reverse order — `mode: subagent` first, `mode: all`
  # second — also FAILs. A last-match rule would call this file fine; the invariant here
  # is that the def is unambiguous, not that the winning value reads `all`. Which of the
  # two opencode honours is exactly what this lint declines to assume (see check_agent).
  seed
  awk '{ if ($0=="mode: all") { print "mode: subagent"; print "mode: all" } else print }' \
    "$REAL/guild-read.md" > "$d/agent/guild-read.md"
  run_variant "$d/agent" && st_no "MISSED a duplicate mode: key in the 'subagent then all' order" || st_ok "catches a duplicate mode: key in either order"

  # S10. A duplicated `permission:` key -> FAIL. Same hole, worse payoff, which is why
  # the check covers every top-level key rather than `mode` alone: the two blocks here
  # are IDENTICAL, so every effective-action check still passes and only the duplicate
  # catches it — while opencode (probed, 1.18.7) applies neither block and drops the
  # default-deny floor. A second block that differed would be a wide-open agent.
  seed
  printf '%s\n' '---' 'description: x' 'mode: all' \
    'permission:' '  "*": deny' '  read: allow' '  grep: allow' '  glob: allow' \
    '  webfetch: allow' '  websearch: allow' \
    'permission:' '  "*": deny' '  read: allow' '  grep: allow' '  glob: allow' \
    '  webfetch: allow' '  websearch: allow' \
    '---' 'body' > "$d/agent/guild-read.md"
  run_variant "$d/agent" && st_no "MISSED a duplicate permission: key" || st_ok "catches a duplicate permission: key (whole frontmatter voided)"

  # S11. A duplicate NESTED INSIDE the permission map — the real guild-read with
  # `  read: allow` repeated -> FAIL. This is the verified repro, and it is strictly
  # worse than S8/S9: `mode: all` survives intact, so there is no fallback-to-`build`
  # tell at all. opencode (probed, 1.18.7) resolves the def to its built-ins alone —
  # the read-only reviewer running with bash/edit/write/task allowed — while the file
  # on disk still shows a full default-deny allowlist and every source-level check
  # here reads it as correct. Same merge-artifact realism as S8, one indent deeper.
  seed
  awk '{print} /^  read: allow$/{print "  read: allow"}' "$REAL/guild-read.md" > "$d/agent/guild-read.md"
  run_variant "$d/agent" && st_no "MISSED a duplicate key nested inside the permission map" || st_ok "catches a duplicate key nested inside the permission map"

  # S12. A TAB-indented duplicate `mode:` -> FAIL. Tabs are not valid YAML indentation
  # and void the def the same way (probed, 1.18.7), so they are their own defect rather
  # than whitespace to skip over. This case also guards the detector's own scanner: an
  # earlier cut skipped every line matching /^[ \t]/ as "indented", which let a
  # tab-indented duplicate walk straight past while still breaking the parse.
  seed
  awk '{print} /^mode: all$/{printf "\tmode: subagent\n"}' "$REAL/guild-read.md" > "$d/agent/guild-read.md"
  run_variant "$d/agent" && st_no "MISSED a tab-indented duplicate mode: key" || st_ok "catches tab indentation in the frontmatter"

  # S13. SCOPE-CORRECTNESS, the false-positive direction: `"*"` once in the permission
  # map and again inside a `read:` submap is TWO different keys in two different
  # mappings, and must NOT be reported as a duplicate. Probed on 1.18.7: such a def is
  # parsed normally and resolves with its floor and allow-set intact, so flagging it
  # would reject a def opencode accepts.
  #
  # It is asserted on the failure REASON, not the exit code: this fixture re-adds a read
  # submap, so it still fails S5's carve-out assertion. Exit-code-only would pass while
  # the duplicate check was firing for the wrong reason — which is exactly the class of
  # bug this whole change is about.
  seed
  awk '{ if ($0=="  read: allow") { print "  read:"; print "    \"*\": allow" } else print }' \
    "$REAL/guild-read.md" > "$d/agent/guild-read.md"
  s13="$(run_variant_out "$d/agent")"
  case "$s13" in
    *"cannot parse"*) st_no "FALSE POSITIVE: '\"*\"' in two different scopes reported as a duplicate" ;;
    *"read has a submap"*) st_ok "scope-aware: the same key in two mappings is not a duplicate (fails only on the submap)" ;;
    *) st_no "S13 fixture failed for an unexpected reason (neither the submap check nor a duplicate)" ;;
  esac

  rm -rf "$d"
  echo
  if [ "$st_fail" -eq 0 ]; then printf '\033[32magent-permissions self-test: the lint catches every tampered variant\033[0m\n'
  else printf '\033[31magent-permissions self-test: FAILED — the lint missed a regression\033[0m\n'; fi
  exit "$st_fail"
fi

# guild-read: read-only reviewer ROLE (2026-07-22 realignment). read+grep+glob+web
# ALLOWED like a Claude review subagent; read is a plain top-level allow (no secret
# globs). no-write/no-task is the role.
echo "== guild-read (allowlist: read/grep/glob/webfetch/websearch) =="
check_agent "$AGENT_DIR/guild-read.md" "grep glob webfetch websearch"

# guild-build: the write path. edit/write/patch/bash + a plain read. Its secret-glob
# read-denies were dropped 2026-07-29 (issue #29) — bash bypassed them, so they never bound
# a determined model, though they did refuse a compliant one (the stated cost, SECURITY.md).
# The def now states what is true. grep/glob/web/task stay denied.
echo "== guild-build (allowlist: edit/write/patch/bash) =="
check_agent "$AGENT_DIR/guild-build.md" "edit write patch bash"

# guild-research is the source-backed /guild:research path — now IDENTICAL to
# guild-read (2026-07-22 realignment): read+grep+glob+web allowed, no-write/no-task.
# `bash` stays OUT of the allow-set (that no-shell/no-write scoping is the ROLE).
echo "== guild-research (allowlist: read/grep/glob/webfetch/websearch) =="
check_agent "$AGENT_DIR/guild-research.md" "grep glob webfetch websearch"

echo
if [ "$fail" -eq 0 ]; then printf '\033[32magent permissions: allowlist invariants hold\033[0m\n'
else printf '\033[31magent permissions: INVARIANT VIOLATED — do not ship\033[0m\n'; fi
exit "$fail"
