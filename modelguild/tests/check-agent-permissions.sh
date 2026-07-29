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

# dup_top_keys  (stdin = frontmatter) : each top-level key that appears more than
# once, printed once. Top level = column 0 (a folded scalar's continuation lines and
# the permission map's entries are indented, so they cannot be mistaken for keys);
# `#` comment lines and lines carrying no `:` are skipped.
dup_top_keys() {
  awk '
    /^[ \t]/{next}
    /^#/{next}
    {
      i=index($0,":"); if(!i) next
      k=substr($0,1,i-1)
      gsub(/^[ \t]+|[ \t]+$/,"",k)
      gsub(/"/,"",k); gsub(/\047/,"",k)
      if(k=="") next
      n[k]++
      if(n[k]==2) print k
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

  # No duplicate top-level key (issue #100). A DUPLICATE IS THE DEFECT, whichever way
  # it resolves — deliberately not a last-match rule. A last-match check would have to
  # assert which of the two values opencode's frontmatter parser honours, and asserting
  # that from assumption is how the hole below got here: `mode: all` was checked by
  # PRESENCE, so a def carrying `mode: all` followed by `mode: subagent` passed while
  # (per this file's own failure text) silently falling back to full-access `build`.
  # Rejecting the duplicate outright means the lint never has to know.
  #
  # PROBED on opencode 1.18.7 (2026-07-29, `opencode agent list` — the resolved config
  # the tool layer enforces, the same source verify-guild-*.sh calls authoritative):
  # a duplicated top-level key is worse than ambiguous. ANY of them — `mode`,
  # `permission`, even `description` — makes opencode apply NONE of the frontmatter:
  # `mode` falls back to its default and the def's permission rules are absent
  # entirely, so the agent resolves with opencode's built-in `"*": allow` and the
  # default-deny floor is simply not there. An otherwise-identical control def with no
  # duplicate resolved with its rules intact. No warning is printed. That is invisible
  # to every other check here, which reads the SOURCE file (where the floor still is).
  local dups; dups="$(printf '%s\n' "$fm" | dup_top_keys)"
  [ -z "$dups" ] \
    || bad "$label" "duplicate top-level frontmatter key(s): $(printf '%s\n' "$dups" | tr '\n' ' ')— opencode 1.18.7 applies NO frontmatter from such a def (probed): the permission map is dropped and the agent resolves to the built-in '\"*\": allow'"

  # With duplicates rejected above, a matching `mode: all` line is the ONLY top-level
  # `mode` there is, so presence is sufficient here — the two checks compose.
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

  # S6. A `"*": allow` appended AFTER guild-build's floor (last-match-wins re-opens
  # everything) -> FAIL. Guards the floor invariant in the direction S4 does not: S4
  # moves the floor after the allows, this one leaves the floor in place and overrides it.
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
