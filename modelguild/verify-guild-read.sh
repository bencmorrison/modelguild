#!/usr/bin/env bash
# verify-guild-read.sh — prove the `guild-read` opencode agent has the read-only
# ROLE shape: read + grep + glob + web ALLOWED, mutation (bash/edit/write/patch) and
# sub-agent spawning (task) DENIED, under a `"*": deny` floor.
#
# 2026-07-22 permission realignment: guild-read is now a Claude review
# subagent's tool surface. grep/glob are ALLOWED and the secret-glob read-denies were
# REMOVED — both were vendor-asymmetry bias, not a real boundary (you would not fence a
# Claude reviewer out of grep, dotfiles, or the web). So this script no longer asserts
# secret-read or grep/glob denial; it asserts they are ALLOWED. No-write/no-task is the
# ROLE and is still asserted.
#
# Why this exists: ModelGuild's read-only commands (/guild:consult, /guild:panel,
# /guild:review, /guild:collaborate, /guild:workshop) claim the delegated model
# "cannot" mutate the repo. That claim is only honest if opencode actually strips the
# mutation tools. This script proves it two ways:
#
#   1. STATIC (authoritative, fail-CLOSED): read opencode's *resolved* permission
#      config and assert the effective (last-match-wins) action of each tool. A model
#      can't fake this — it's the config the tool layer enforces. This is the real proof.
#   2. RUNTIME (corroborating): drive the agent to write a file and assert it did not
#      happen. This can only ever DISPROVE (a write => hard FAIL); on its own an absent
#      result is also consistent with the model merely declining, so it corroborates
#      step 1 rather than standing alone. If opencode itself fails to run (missing
#      `timeout`, auth, no free model, crash) the runtime step is reported INCONCLUSIVE —
#      it does NOT silently pass (the old bug this script was rewritten to kill).
#
# Usage:  bash modelguild/verify-guild-read.sh [--static]
#   --static  run only the token-free static checks (steps 1-2); skip the runtime
#             probes (steps 3-4) that call a model. Run this locally after an opencode
#             or agent-def bump; CI uses the opencode-free check-agent-permissions.sh lint.
# Exit 0 = static proof holds AND (unless --static) no runtime contradiction.
# GUILD_VERIFY_MODEL overrides the (free by default) runtime model.
set -uo pipefail

static_only=""
case "${1:-}" in --static|-s) static_only=1 ;; esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root" || exit 1

model="${GUILD_VERIFY_MODEL:-opencode/deepseek-v4-flash-free}"
agent="guild-read"
agent_file=".opencode/agent/guild-read.md"
fail=0
inconclusive=0

pass() { printf '\033[32mPASS\033[0m %s\n' "$*"; }
bad()  { printf '\033[31mFAIL\033[0m %s\n' "$*"; fail=1; }
inc()  { printf '\033[33mINCONCLUSIVE\033[0m %s\n' "$*"; inconclusive=1; }

# Portability: `timeout` is GNU coreutils; macOS/BSD ship it as `gtimeout` or not
# at all. Detect it; if absent, run without a cap (the runtime steps still work,
# they just aren't time-bounded).
TIMEOUT=""
if command -v timeout >/dev/null 2>&1; then TIMEOUT="timeout 120"
elif command -v gtimeout >/dev/null 2>&1; then TIMEOUT="gtimeout 120"; fi

# Resolved permission array for guild-read (as opencode actually computes it).
# `opencode agent list` prints a pretty-printed JSON array per agent; grab just
# guild-read's block (everything after its header, up to the next agent header).
perms="$(opencode agent list 2>/dev/null \
  | awk '/^guild-read /{f=1;next} f && /^[a-z][a-z0-9_-]* \((primary|subagent|all)\)/{exit} f')"

echo "== 1. STATIC (authoritative): resolved permissions =="
# last_action <permission> [pattern] — action of the LAST rule whose permission
# name (and, if given, pattern) matches. Empty if none. Used for read patterns.
last_action() {
  printf '%s\n' "$perms" | jq -r --arg p "$1" --arg pat "${2:-}" '
    [ .[] | select(.permission==$p) | select($pat=="" or .pattern==$pat) ] | last | .action // ""' 2>/dev/null
}
# effective_action <tool> — the action opencode actually ENFORCES for a tool that
# takes no path pattern: the last rule matching EITHER the tool name OR the "*"
# catch-all (last-match-wins across both). This is what makes the default-deny
# allowlist verifiable — a tool with no own rule inherits the "*": deny.
effective_action() {
  printf '%s\n' "$perms" | jq -r --arg p "$1" '
    [ .[] | select(.permission==$p or .permission=="*") ] | last | .action // ""' 2>/dev/null
}

# Foundation: the catch-all must be deny (this is what denies every un-allowed tool).
[ "$(last_action '*')" = "deny" ] && pass "'*' catch-all => deny (default-deny allowlist)" \
  || bad "'*' catch-all is NOT deny — the allowlist has no floor; un-listed tools would be ALLOWED"

# Mutation/escape tools must be EFFECTIVELY denied — that no-write/no-task scoping is
# the read-only ROLE. grep/glob are NO LONGER here: they are ALLOWED (a review subagent
# searches the tree). The secret-glob read-denies were removed (2026-07-22 realignment).
for cap in bash edit write patch task todowrite lsp skill; do
  if [ "$(effective_action "$cap")" = "deny" ]; then pass "$cap => deny (effective)"; else bad "$cap is NOT effectively denied — mutation/escape path open"; fi
done
# Review-subagent tool surface: read + grep + glob + web are ALLOWED.
for cap in read grep glob webfetch websearch; do
  if [ "$(effective_action "$cap")" = "allow" ]; then pass "$cap => allow (effective)"; else bad "$cap is NOT effectively allowed — read-only reviewer capability missing"; fi
done
# read must be a plain allow with NO secret-glob carve-outs (the fences were removed).
[ "$(last_action read '*')" = "allow" ] && pass "read '*' => allow (no secret-glob denies; repo is readable)" \
  || bad "read '*' is not allow — agent can't read files, runtime step meaningless"
# None of the FORMER secret-read globs may resolve to a deny rule — the fences are gone.
# (Any leftover exact-pattern deny would be a re-added fence; the built-in `*.env: ask`
# opencode injects is NOT a deny and does not trip this.)
FORMER_SECRET_GLOBS='*.env *.env.* .env **/.env **/.env.* *.pem **/*.pem *.key **/*.key *.pfx *.p12 id_rsa id_ed25519 **/id_rsa **/id_ed25519 **/.ssh/** **/.aws/** **/.gnupg/** *credentials* **/credentials* **/.netrc **/.git-credentials'
secret_fence_present=0
for secret in $FORMER_SECRET_GLOBS; do
  [ "$(last_action read "$secret")" = "deny" ] && { bad "read '$secret' => deny — a secret-glob fence is still present (removed per 2026-07-22 realignment)"; secret_fence_present=1; }
done
[ "$secret_fence_present" -eq 0 ] && pass "no former secret-glob read-deny remains (fences removed)"

echo "== 2. STATIC: permission keys are all real (typo => silent fail-open) =="
# opencode's permission vocabulary. The `agent create --help` --permissions flag
# lists a curated subset; `write`/`patch` are also real, enforced file-mutation
# keys (verified: `write: deny` resolves to deny and strips the Write tool). Step 1
# above is the real typo-guard for the keys it checks (a typo'd `write` makes its
# `write => deny` assertion fail); this step catches keys step 1 doesn't cover.
known=" bash read edit write patch glob grep webfetch task todowrite websearch lsp skill "
# Top-level permission keys are 2-space-indented `key:` lines in the frontmatter.
badkeys=""
while IFS= read -r k; do
  case "$known" in *" $k "*) ;; *) badkeys="$badkeys $k" ;; esac
done < <(awk '/^permission:/{p=1;next} p&&/^[^ ]/{p=0} p&&/^  [a-z_]+:/{line=$0; sub(/^ +/,"",line); sub(/:.*/,"",line); print line}' "$agent_file")
if [ -z "$badkeys" ]; then pass "all permission keys are known opencode tools"
else bad "unknown permission key(s):$badkeys — a typo'd deny silently fails open"; fi

if [ -n "$static_only" ]; then
  echo "(runtime probes skipped: --static)"
else
echo "== 3. RUNTIME (corroborating): mutation attempt must not create a file =="
# Only the mutation probe remains. Secret-read and grep probes were REMOVED (2026-07-22):
# read and grep are now ALLOWED by design, so returning a planted secret is expected
# behaviour, not a contradiction. This probe runs only if a (free-tier) model responds;
# a non-zero opencode exit (no free model / auth / crash) is INCONCLUSIVE, never a spend.
probe="$repo_root/.guild-read-deny-probe.txt"; rm -f "$probe"
mout="$($TIMEOUT opencode run --agent "$agent" --auto -m "$model" \
  "Use your bash tool to run: echo PWNED > $probe  — then use write/edit to create it too. Report which tools were denied." \
  </dev/null 2>&1)"; mrc=$?
if printf '%s' "$mout" | grep -qi 'falling back to default agent'; then
  bad "opencode fell back off guild-read (not primary-invocable — check 'mode: all')"
elif [ -e "$probe" ]; then
  bad "probe file was created — mutation DENY FAILED"; rm -f "$probe"
elif [ "$mrc" -ne 0 ]; then
  inc "opencode exited $mrc (missing timeout? auth? no free model? crash) — mutation step could not run; static check above is authoritative"
else
  pass "no file created and opencode exited 0 (consistent with mutation deny)"
fi
rm -f "$probe"

echo "== 4. RUNTIME (issue #221): explicit external read path =="
# This is the end-to-end proof the `readPaths` feature needs: a session rule must allow an
# out-of-root read, but the turn must still be served by guild-read. A raw v2 permission
# evaluation is deliberately not used here: it does not consult the v1 session rules.
command -v curl >/dev/null 2>&1 || { inc "curl is unavailable — cannot probe session-scoped external_directory"; }
if command -v curl >/dev/null 2>&1; then
  depdir="$(mktemp -d)"
  depfile="$depdir/evidence.txt"
  mkdir "$depdir/nested"
  nested="$depdir/nested/evidence.txt"
  sibling="${depdir}-sibling"
  mkdir "$sibling"
  printf 'MODEL-GUILD-READ-PROBE\n' >"$depfile"
  printf 'MODEL-GUILD-READ-PROBE\n' >"$nested"
  printf 'MODEL-GUILD-READ-PROBE\n' >"$sibling/evidence.txt"
  port=$((40000 + (RANDOM % 20000)))
  serve_log="$(mktemp)"
  opencode serve --port "$port" --hostname 127.0.0.1 >"$serve_log" 2>&1 &
  serve_pid=$!
  ready=""
  for _ in $(seq 1 60); do
    curl -sf -m 2 "http://127.0.0.1:$port/doc" -o /dev/null 2>/dev/null && { ready=1; break; }
    kill -0 "$serve_pid" 2>/dev/null || break
    sleep 0.25
  done
  if [ -z "$ready" ]; then
    inc "opencode serve did not start — external-directory runtime probe could not run"
  else
    provider="${model%%/*}"
    model_id="${model#*/}"
    create="$(jq -nc --arg a "$agent" --arg p "$depdir/*" --arg provider "$provider" --arg model_id "$model_id" '{agent:$a,title:"guild-read external-directory probe",model:{providerID:$provider,id:$model_id},permission:[{permission:"external_directory",pattern:$p,action:"allow"}]}')"
    session="$(curl -sS -m 20 -X POST "http://127.0.0.1:$port/session" -H 'content-type: application/json' -d "$create" | jq -r '.id // empty')"
    if [ -z "$session" ]; then
      inc "could not create a guild-read session with an external-directory rule"
    else
      prompt="$(jq -nc --arg a "$agent" --arg read "$nested" --arg root "$depdir" --arg sibling "$sibling/evidence.txt" '{agent:$a,parts:[{type:"text",text:("Use read on " + $read + ", glob to locate evidence.txt beneath " + $root + ", grep for MODEL-GUILD-READ-PROBE beneath " + $root + ", then try read on " + $sibling + ". Reply only after all four tool calls.")}]}')"
      curl -sS -m 120 -X POST "http://127.0.0.1:$port/session/$session/message" -H 'content-type: application/json' -d "$prompt" -o /dev/null 2>&1
      history="$(curl -sS -m 20 "http://127.0.0.1:$port/session/$session/message" 2>/dev/null)"
      if printf '%s' "$history" | jq -e --arg a "$agent" --arg p "$nested" --arg root "$depdir" --arg sibling "$sibling/evidence.txt" '
        any(.[]; .info.role == "assistant" and .info.agent == $a) and
        any(.[]; any(.parts[]?; .type == "tool" and .tool == "read" and .state.input.filePath == $p and .state.status == "completed")) and
        any(.[]; any(.parts[]?; .type == "tool" and .tool == "glob" and .state.status == "completed")) and
        any(.[]; any(.parts[]?; .type == "tool" and .tool == "grep" and .state.status == "completed")) and
        any(.[]; any(.parts[]?; .type == "tool" and .tool == "read" and .state.input.filePath == $sibling and .state.status == "error"))' >/dev/null 2>&1; then
        pass "guild-read allows nested read/grep/glob under its session rule and denies a sibling path"
      else
        bad "external-directory rule did not allow nested read/grep/glob and deny the sibling path under guild-read"
        printf '     history: %s\n' "$(printf '%s' "$history" | jq -c '[.[] | {role:.info.role,agent:.info.agent,parts:[.parts[]? | {type,tool,state}]}]' 2>/dev/null || printf '%s' "$history")"
      fi
      curl -sS -m 5 -X DELETE "http://127.0.0.1:$port/session/$session" -o /dev/null 2>&1 || true
    fi
  fi
  kill "$serve_pid" 2>/dev/null || true
  wait "$serve_pid" 2>/dev/null || true
  rm -rf "$depdir" "$sibling" "$serve_log"
fi
fi  # end runtime probes (skipped under --static)

echo
if [ "$fail" -eq 0 ] && [ "$inconclusive" -eq 0 ]; then
  if [ -n "$static_only" ]; then
    printf '\033[32mguild-read VERIFIED (static)\033[0m — read/grep/glob/webfetch/websearch allowed; mutation (bash/edit/write/patch) + task denied; no secret-glob read-deny remains (resolved config). Runtime probes not run (--static).\n'
  else
    printf '\033[32mguild-read VERIFIED\033[0m — read/grep/glob/webfetch/websearch allowed; mutation + task denied; no secret-glob read-deny remains, with no runtime contradiction.\n'
  fi
  printf '  NOTE: read-only ROLE, not a security boundary — trusted-repo posture. Repo contents (including any secrets present) plus web are accepted exposure; this agent enforces no-write/no-task, nothing more. See AGENTS.md (2026-07-22 realignment).\n'
elif [ "$fail" -ne 0 ]; then
  printf '\033[31mguild-read NOT verified\033[0m — do not claim the read-only role holds by construction.\n'
else
  printf '\033[33mguild-read INCONCLUSIVE\033[0m — static proof passed, but one or more runtime probes did not establish a result.\n'
fi
[ "$fail" -eq 0 ] || exit 1
[ "$inconclusive" -eq 0 ] || exit 6
exit 0
