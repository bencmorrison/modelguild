#!/usr/bin/env bash
# verify-guild-build.sh — check the `guild-build` opencode agent (the --edit /
# /guild:delegate write path) has the permission shape it claims.
#
# What guild-build claims, and what this proves:
#   * It CAN edit — edit/write/patch/bash resolve to `allow` (else /guild:delegate is
#     broken). This script asserts that positively.
#   * The tool-native escape/egress paths are REMOVED — task, webfetch, websearch,
#     grep and glob resolve to `deny`, and `read` is a plain allow.
#
# NO SECRET-READ ASSERTION ANY MORE (changed 2026-07-29, maintainer decision, issue
# #29). This script used to assert that the `read` tool denied a canonical list of
# secret globs. Those denies are GONE from the def, so the assertion went with them —
# it now checks the opposite, that no such fence has come back. Be clear about the
# direction: this REMOVES a layer. It was defense-in-depth on the read TOOL only, and
# `bash` — allowed on this agent by design, since a delegated coding task must run
# builds and tests — walked straight through it with `cat`. What the fence bought was
# the appearance of a credential boundary this path has never had. Nothing here got
# safer; the def and this proof now state what is actually true.
#
# What this script therefore does NOT claim, and never could: secret/egress *by
# construction*. bash can `cat .env` or `curl` regardless of the permission map. The
# real trust boundary is the human diff review in /guild:delegate step 3, not this
# script and not the map. Do not oversell it.
#
# Method mirrors verify-guild-read.sh: a STATIC last-match-wins check of opencode's
# resolved config (authoritative, fail-CLOSED) + a known-key typo lint + a RUNTIME
# corroboration (the agent actually writes a probe file => the edit path works;
# reports INCONCLUSIVE, not PASS, if opencode can't run).
#
# Usage:  bash modelguild/verify-guild-build.sh [--static]
#   --static  run only the token-free static checks (steps 1-2); skip the runtime
#             edit probe (step 3) that calls a model. Run locally after an opencode bump
#             (CI uses the opencode-free check-agent-permissions.sh lint).
# Exit 0 = static shape holds AND (unless --static) the edit path works. Non-zero otherwise.
# GUILD_VERIFY_MODEL overrides the (free by default) runtime model.
set -uo pipefail

static_only=""
case "${1:-}" in --static|-s) static_only=1 ;; esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root" || exit 1

model="${GUILD_VERIFY_MODEL:-opencode/deepseek-v4-flash-free}"
agent="guild-build"
agent_file=".opencode/agent/guild-build.md"
fail=0
inconclusive=0

pass() { printf '\033[32mPASS\033[0m %s\n' "$*"; }
bad()  { printf '\033[31mFAIL\033[0m %s\n' "$*"; fail=1; }
inc()  { printf '\033[33mINCONCLUSIVE\033[0m %s\n' "$*"; inconclusive=1; }

TIMEOUT=""
if command -v timeout >/dev/null 2>&1; then TIMEOUT="timeout 120"
elif command -v gtimeout >/dev/null 2>&1; then TIMEOUT="gtimeout 120"; fi

perms="$(opencode agent list 2>/dev/null \
  | awk '/^guild-build /{f=1;next} f && /^[a-z][a-z0-9_-]* \((primary|subagent|all)\)/{exit} f')"

echo "== 1. STATIC (authoritative): resolved permissions =="
last_action() {
  printf '%s\n' "$perms" | jq -r --arg p "$1" --arg pat "${2:-}" '
    [ .[] | select(.permission==$p) | select($pat=="" or .pattern==$pat) ] | last | .action // ""' 2>/dev/null
}
# effective_action <tool> — enforced action for a no-pattern tool: last rule
# matching the tool name OR the "*" catch-all (makes the default-deny allowlist
# verifiable — an un-allowed tool inherits "*": deny).
effective_action() {
  printf '%s\n' "$perms" | jq -r --arg p "$1" '
    [ .[] | select(.permission==$p or .permission=="*") ] | last | .action // ""' 2>/dev/null
}

# Foundation: default-deny allowlist floor.
[ "$(last_action '*')" = "deny" ] && pass "'*' catch-all => deny (default-deny allowlist)" \
  || bad "'*' catch-all is NOT deny — un-listed tools would be ALLOWED"
# The mutation set MUST be allowed (else /guild:delegate can't edit).
for cap in edit write patch bash; do
  if [ "$(effective_action "$cap")" = "allow" ]; then pass "$cap => allow (edit path works)"; else bad "$cap is NOT allow — /guild:delegate cannot edit"; fi
done
# Everything else — escape hatch, egress, AND the tool-native secret-search routes
# (grep/glob) a compliant model would default to — must be effectively denied.
for cap in task webfetch websearch grep glob todowrite lsp skill; do
  if [ "$(effective_action "$cap")" = "deny" ]; then pass "$cap => deny (effective)"; else bad "$cap is NOT effectively denied"; fi
done
# read must be a plain allow with NO secret-glob carve-outs (same shape, and the same
# assertion, as the read paths since their own realignment).
[ "$(last_action read '*')" = "allow" ] && pass "read '*' => allow (agent can read the repo it must edit)" \
  || bad "read '*' is not allow — agent can't read the repo it must edit"
# None of the FORMER secret-read globs may resolve to a deny rule — the fences were
# dropped on 2026-07-29 (issue #29) because bash `cat` bypassed them, so a re-added one
# is a regression toward implying a boundary this agent does not have. Mirrors the same
# assertion in verify-guild-read.sh / verify-guild-research.sh.
FORMER_SECRET_GLOBS='*.env *.env.* .env **/.env **/.env.* *.pem **/*.pem *.key **/*.key *.pfx *.p12 id_rsa id_ed25519 **/id_rsa **/id_ed25519 **/.ssh/** **/.aws/** **/.gnupg/** *credentials* **/credentials* **/.netrc **/.git-credentials'
secret_fence_present=0
for secret in $FORMER_SECRET_GLOBS; do
  [ "$(last_action read "$secret")" = "deny" ] && { bad "read '$secret' => deny — a secret-glob fence is back (removed 2026-07-29, issue #29: bash bypasses it)"; secret_fence_present=1; }
done
[ "$secret_fence_present" -eq 0 ] && pass "no secret-glob read-deny remains (fences removed; bash always bypassed them)"

echo "== 2. STATIC: permission keys are all real (typo => silent fail-open) =="
known=" bash read edit write patch glob grep webfetch task todowrite websearch lsp skill "
badkeys=""
while IFS= read -r k; do
  case "$known" in *" $k "*) ;; *) badkeys="$badkeys $k" ;; esac
done < <(awk '/^permission:/{p=1;next} p&&/^[^ ]/{p=0} p&&/^  [a-z_]+:/{line=$0; sub(/^ +/,"",line); sub(/:.*/,"",line); print line}' "$agent_file")
if [ -z "$badkeys" ]; then pass "all permission keys are known opencode tools"
else bad "unknown permission key(s):$badkeys — a typo'd deny silently fails open"; fi

if [ -n "$static_only" ]; then
  echo "(runtime probe skipped: --static)"
else
echo "== 3. RUNTIME (corroborating): the edit path actually writes a file =="
probe="$repo_root/.guild-build-edit-probe.txt"; rm -f "$probe"
mout="$($TIMEOUT opencode run --agent "$agent" --auto -m "$model" \
  "Use your write/edit tool to create the file .guild-build-edit-probe.txt containing exactly: OK. Then report done." \
  </dev/null 2>&1)"; mrc=$?
if printf '%s' "$mout" | grep -qi 'falling back to default agent'; then
  bad "opencode fell back off guild-build (not primary-invocable — check 'mode: all')"
elif [ "$mrc" -ne 0 ]; then
  inc "opencode exited $mrc (missing timeout? auth? crash) — edit step could not run; static check above is authoritative"
elif [ -e "$probe" ]; then
  pass "probe file created — edit path works under guild-build"; rm -f "$probe"
else
  inc "no file created and opencode exited 0 — model may have declined; static allow above is authoritative"
fi
rm -f "$probe"
fi  # end runtime probe (skipped under --static)

echo
if [ "$fail" -eq 0 ] && [ "$inconclusive" -eq 0 ]; then
  if [ -n "$static_only" ]; then
    printf '\033[32mguild-build VERIFIED (static)\033[0m — edit/write/patch/bash=allow; read=allow; task/grep/glob/webfetch/websearch=deny (resolved config). Runtime edit probe not run (--static).\n'
  else
    printf '\033[32mguild-build VERIFIED\033[0m — edit path works; task/grep/glob/webfetch/websearch are denied at the tool layer.\n'
  fi
  printf '  NOTE: bash is allowed by design, so the remaining denies are defense-in-depth, NOT by construction, and there is no secret-read fence at all (removed 2026-07-29, issue #29 — bash bypassed it). This agent can read any repo file, credentials included; the /guild:delegate diff review is the trust boundary.\n'
elif [ "$fail" -ne 0 ]; then
  printf '\033[31mguild-build NOT verified\033[0m — permission shape is wrong; check the agent def against verify-guild-read.sh conventions.\n'
else
  printf '\033[33mguild-build INCONCLUSIVE\033[0m — static proof passed, but the runtime edit probe did not establish a result.\n'
fi
[ "$fail" -eq 0 ] || exit 1
[ "$inconclusive" -eq 0 ] || exit 6
exit 0
