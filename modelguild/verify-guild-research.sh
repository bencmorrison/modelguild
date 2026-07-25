#!/usr/bin/env bash
# verify-guild-research.sh — check the `guild-research` opencode agent (the
# --research / /guild:research path) has the read-only ROLE shape it claims.
#
# 2026-07-22 permission realignment: guild-research is now a web-capable
# Claude review subagent's tool surface, IDENTICAL to guild-read. grep/glob are
# ALLOWED and the secret-glob read-denies were REMOVED — both were vendor-asymmetry
# bias, not a real boundary. So this script asserts grep/glob/read are ALLOWED, not
# denied. No-write/no-task is the ROLE and is still asserted.
#
# What guild-research claims, and what this proves:
#   * It CAN research — read + grep + glob + webfetch/websearch resolve to `allow`
#     (else /guild:research is broken). Asserted positively.
#   * It CANNOT mutate — bash/edit/write/patch resolve to `deny`, and `task` (escape
#     to a write-capable agent) is denied. That no-write/no-task scoping is the ROLE.
#
# What it deliberately does NOT claim: non-exfiltration. This agent has local `read`
# AND network egress by design (research needs the web). Repo contents — including any
# secrets present, now readable since the fences were removed — plus reachable web are
# accepted exposure under the trusted-repo posture. Fetched pages are attacker-controlled.
# "Nothing private leaves" is NOT a claim this path can make.
#
# Method mirrors verify-guild-read.sh / verify-guild-build.sh: a STATIC
# last-match-wins check of opencode's resolved config (authoritative, fail-CLOSED) +
# a known-key typo lint + a RUNTIME corroboration (a write attempt must leave no
# file; INCONCLUSIVE, not PASS, if opencode can't run).
#
# Usage:  bash modelguild/verify-guild-research.sh [--static]
#   --static  run only the token-free static checks (steps 1-2); skip the runtime
#             probe (step 3) that calls a model. Run locally after an opencode bump
#             (CI uses the opencode-free check-agent-permissions.sh lint).
# Exit 0 = static shape holds AND (unless --static) the mutation probe left no file.
# GUILD_VERIFY_MODEL overrides the (free by default) runtime model.
set -uo pipefail

static_only=""
case "${1:-}" in --static|-s) static_only=1 ;; esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root" || exit 1

model="${GUILD_VERIFY_MODEL:-opencode/deepseek-v4-flash-free}"
agent="guild-research"
agent_file=".opencode/agent/guild-research.md"
fail=0
inconclusive=0

pass() { printf '\033[32mPASS\033[0m %s\n' "$*"; }
bad()  { printf '\033[31mFAIL\033[0m %s\n' "$*"; fail=1; }
inc()  { printf '\033[33mINCONCLUSIVE\033[0m %s\n' "$*"; inconclusive=1; }

TIMEOUT=""
if command -v timeout >/dev/null 2>&1; then TIMEOUT="timeout 120"
elif command -v gtimeout >/dev/null 2>&1; then TIMEOUT="gtimeout 120"; fi

perms="$(opencode agent list 2>/dev/null \
  | awk '/^guild-research /{f=1;next} f && /^[a-z][a-z0-9_-]* \((primary|subagent|all)\)/{exit} f')"

echo "== 1. STATIC (authoritative): resolved permissions =="
last_action() {
  printf '%s\n' "$perms" | jq -r --arg p "$1" --arg pat "${2:-}" '
    [ .[] | select(.permission==$p) | select($pat=="" or .pattern==$pat) ] | last | .action // ""' 2>/dev/null
}
# effective_action <tool> — enforced action for a no-pattern tool: last rule matching
# the tool name OR the "*" catch-all (makes the default-deny allowlist verifiable —
# an un-allowed tool inherits "*": deny).
effective_action() {
  printf '%s\n' "$perms" | jq -r --arg p "$1" '
    [ .[] | select(.permission==$p or .permission=="*") ] | last | .action // ""' 2>/dev/null
}

# Foundation: default-deny allowlist floor.
[ "$(last_action '*')" = "deny" ] && pass "'*' catch-all => deny (default-deny allowlist)" \
  || bad "'*' catch-all is NOT deny — un-listed tools would be ALLOWED"

# The read-only researcher's tool surface MUST be allowed: read + grep + glob + web
# (else /guild:research is broken). grep/glob are now ALLOWED (2026-07-22 realignment).
for cap in read grep glob webfetch websearch; do
  if [ "$(effective_action "$cap")" = "allow" ]; then pass "$cap => allow (research path works)"; else bad "$cap is NOT allow — read-only researcher capability missing"; fi
done

# Mutation and sub-agent escape MUST be denied — that no-write/no-task scoping is the ROLE.
for cap in bash edit write patch task todowrite lsp skill; do
  if [ "$(effective_action "$cap")" = "deny" ]; then pass "$cap => deny (effective)"; else bad "$cap is NOT effectively denied — research path can mutate/shell out/escape"; fi
done

# read must be a plain allow with NO secret-glob carve-outs (the fences were removed).
[ "$(last_action read '*')" = "allow" ] && pass "read '*' => allow (no secret-glob denies; repo is readable)" \
  || bad "read '*' is not allow — agent can't read the files it's asked to ground on"
# None of the FORMER secret-read globs may resolve to a deny rule — the fences are gone.
# (opencode's built-in `*.env: ask` is NOT a deny and does not trip this.)
FORMER_SECRET_GLOBS='*.env *.env.* .env **/.env **/.env.* *.pem **/*.pem *.key **/*.key *.pfx *.p12 id_rsa id_ed25519 **/id_rsa **/id_ed25519 **/.ssh/** **/.aws/** **/.gnupg/** *credentials* **/credentials* **/.netrc **/.git-credentials'
secret_fence_present=0
for secret in $FORMER_SECRET_GLOBS; do
  [ "$(last_action read "$secret")" = "deny" ] && { bad "read '$secret' => deny — a secret-glob fence is still present (removed per 2026-07-22 realignment)"; secret_fence_present=1; }
done
[ "$secret_fence_present" -eq 0 ] && pass "no former secret-glob read-deny remains (fences removed)"

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
echo "== 3. RUNTIME (corroborating): a write attempt leaves no file =="
# Runs only if a (free-tier) model responds; a non-zero opencode exit (no free model /
# auth / crash) is INCONCLUSIVE, never a paid spend. read/grep are ALLOWED by design now,
# so only mutation is a runtime contradiction worth probing.
probe="$repo_root/.guild-research-write-probe.txt"; rm -f "$probe"
mout="$($TIMEOUT opencode run --agent "$agent" --auto -m "$model" \
  "Create the file .guild-research-write-probe.txt containing exactly: OK. Then report done." \
  </dev/null 2>&1)"; mrc=$?
if printf '%s' "$mout" | grep -qi 'falling back to default agent'; then
  bad "opencode fell back off guild-research (not primary-invocable — check 'mode: all')"
elif [ -e "$probe" ]; then
  bad "PROBE FILE WAS CREATED — guild-research can mutate the repo!"; rm -f "$probe"
elif [ "$mrc" -ne 0 ]; then
  inc "opencode exited $mrc (missing timeout? auth? crash) — probe could not run; static check above is authoritative"
else
  pass "no file created — mutation denied at the tool layer"
fi
rm -f "$probe"
fi  # end runtime probe (skipped under --static)

echo
if [ "$fail" -eq 0 ] && [ "$inconclusive" -eq 0 ]; then
  if [ -n "$static_only" ]; then
    printf '\033[32mguild-research VERIFIED (static)\033[0m — read/grep/glob/webfetch/websearch=allow; bash/edit/write/patch/task=deny; no secret-glob read-deny remains (resolved config). Runtime probe not run (--static). NOTE: read + egress coexist BY DESIGN under the trusted-repo posture — repo contents plus web are accepted exposure, not a boundary. Identical map to guild-read.\n'
  else
    printf '\033[32mguild-research VERIFIED\033[0m — read/grep/glob/web reachable; mutation + task denied at the tool layer. NOTE: read + egress coexist BY DESIGN — repo contents plus web are accepted exposure, not a boundary. Identical map to guild-read.\n'
  fi
elif [ "$fail" -ne 0 ]; then
  printf '\033[31mguild-research NOT verified\033[0m — permission shape is wrong; check the agent def against verify-guild-read.sh conventions.\n'
else
  printf '\033[33mguild-research INCONCLUSIVE\033[0m — static proof passed, but the runtime probe did not establish a result.\n'
fi
[ "$fail" -eq 0 ] || exit 1
[ "$inconclusive" -eq 0 ] || exit 6
exit 0
