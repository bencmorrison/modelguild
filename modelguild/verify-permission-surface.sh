#!/usr/bin/env bash
# verify-permission-surface.sh — make issue #93's "re-probe before migrating" question
# EXECUTABLE. Sibling of verify-guild-read.sh / verify-guild-build.sh /
# verify-guild-research.sh: same conventions, same reason for existing (a claim about
# what opencode DOES is only honest if something can run it), same place in the workflow —
# run it LOCALLY after an opencode bump, never in CI (CI is credential-free and
# opencode-free).
#
# THE QUESTION IT ANSWERS. The approval bridge (src/approve.ts, CONTRACT C65-C69) gates tools
# with a per-session **v1** ruleset (`POST /session` -> `permission`). opencode also exposes a
# **v2** permission surface (`POST`/`GET /api/session/{id}/permission`, `/api/permission/…`)
# that looks like the natural modernization target and is not, so the bridge is PINNED to v1
# by decision — CONTRACT **C69a**, with the full evidence in the **V1 PIN** block in
# `src/client.ts`. That block is the single copy on purpose and is NOT restated here.
# This script re-asks the underlying question against whatever opencode is installed:
# **does the v1 ruleset stored on a session change what the v2 evaluator answers?**
#
# HOW IT ASKS — DIFFERENTIALLY, WHICH IS THE WHOLE DESIGN. "v2 answered `ask`" is NOT
# evidence that the session ruleset was honoured: `ask` is reachable on v2 for entirely
# unrelated reasons (probed 2026-07-29 — opencode's built-in `*.env` rule makes
# `read .env` answer `ask` on the stock `build` agent), and v2 demonstrably DOES evaluate
# the agent def (`bash` answers `deny` for guild-read and `allow` for build). So the probe
# runs the SAME evaluation against two sessions on the SAME agent — one carrying a v1 `ask`
# ruleset, one carrying none — and the verdict is whether the ruleset CHANGES the answer.
# That is the only thing a migration would depend on.
#
# IT PROBES EVERY TOOL FAMILY THE BRIDGE CAN ARM, not just one. A verdict from `bash` alone
# would generalize past its evidence: a future v2 could honour the session rule for `edit`
# while still ignoring it for `bash`, and a one-permission probe would report PIN HOLDS
# straight through that. So the default matrix covers the gated tiers — edit/patch and bash
# on `guild-build`, webfetch/websearch on `guild-read` — each against its own control session
# on the same agent. (`write` is omitted deliberately: 1.18.7's `write` permission key is
# inert and `edit` gates the write/patch family — CONTRACT C69.) A pair is only probed where
# the agent def ALLOWS the tool, since that is the only set the bridge may gate at all (C66
# invariant 2); a pair whose control does not answer `allow` is reported NOT INFORMATIVE and
# excluded from the verdict rather than silently counted as agreement.
#
# NO MODEL IS CALLED, so unlike the verify-guild-*.sh runtime probes this needs opencode
# installed but not necessarily logged in (the 2026-07-29 probe ran unauthenticated). If a
# future build requires auth to create a session, that surfaces as INCONCLUSIVE.
#
# There is no --static split: every question here is about the RUNNING serve's behaviour,
# and a static read of the config cannot answer any of it.
#
# Usage:  bash modelguild/verify-permission-surface.sh
#   GUILD_VERIFY_BASE_URL   use an already-running serve instead of spawning one
#   GUILD_VERIFY_MATRIX     space-separated `agent:permission` pairs (default: the armable
#                           tiers). Each permission must be one that agent's def ALLOWS, or
#                           the pair reports NOT INFORMATIVE and is excluded.
#   GUILD_VERIFY_ROUNDS     evaluations per session per pair (default 3; >1 on purpose, and
#                           rounds that DISAGREE are INCONCLUSIVE — see section 3)
#
# Exit 0 = THE PIN HOLDS (the v1 ruleset does not change v2's answer) — the expected
#          result on 1.18.7, reported as a result, not as a failure.
# Exit 7 = ATTENTION, revisit #93: the ruleset now changes v2's answer, so the precondition
#          for migrating may be met. It is NOT sufficient on its own — C69a also requires
#          the live proof to be extended before anything moves.
# Exit 6 = INCONCLUSIVE (no opencode/jq/curl, serve would not start, the ruleset was not
#          stored intact, rounds disagreed, no pair was informative, an endpoint answered
#          unusably) — deliberately distinct from both real results, because "could not
#          establish" must never read as "pin holds".
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root" || exit 1

# The armable tiers: GUILD_APPROVE=write gates edit/write/patch, `all` adds bash, and
# GUILD_APPROVE_EGRESS=ask gates webfetch/websearch on the read paths.
matrix="${GUILD_VERIFY_MATRIX:-guild-build:bash guild-build:edit guild-build:patch guild-read:webfetch guild-read:websearch}"
rounds="${GUILD_VERIFY_ROUNDS:-3}"
base_url="${GUILD_VERIFY_BASE_URL:-}"
serve_pid=""
all_sessions=""

pass() { printf '\033[32mPASS\033[0m %s\n' "$*"; }
note() { printf '     %s\n' "$*"; }
inc()  { printf '\033[33mINCONCLUSIVE\033[0m %s\n' "$*"; }
att()  { printf '\033[31mATTENTION\033[0m %s\n' "$*"; }

cleanup() {
  if [ -n "$base_url" ]; then
    for _s in $all_sessions; do
      curl -sS -m 5 -X DELETE "$base_url/session/$_s" -o /dev/null 2>/dev/null
    done
  fi
  [ -n "$serve_pid" ] && kill "$serve_pid" 2>/dev/null
  return 0
}
trap cleanup EXIT

finish_inconclusive() {
  echo
  inc "$1"
  printf '\033[33mpermission surface INCONCLUSIVE\033[0m — no result established. The v1 pin (CONTRACT C69a) stands unchanged; "could not check" is never evidence that it stopped mattering.\n'
  exit 6
}

# --- 0. tooling ------------------------------------------------------------
for tool in curl jq; do
  command -v "$tool" >/dev/null 2>&1 || finish_inconclusive "$tool is not installed — this probe speaks raw HTTP + JSON"
done

# Validate the knob HERE, naming the knob. An unvalidated value used to surface downstream as
# "the CONTROL session answered []" — an accurate-sounding verdict pointing at the wrong knob
# entirely (the agent matrix), which is worse than the error it was hiding. A non-integer
# additionally leaked a bash integer-expression error on the way.
case "$rounds" in
  ''|*[!0-9]*) finish_inconclusive "GUILD_VERIFY_ROUNDS='$rounds' is not a whole number — set it to 1 or more (default 3)" ;;
esac
[ "$rounds" -ge 1 ] \
  || finish_inconclusive "GUILD_VERIFY_ROUNDS=$rounds would evaluate nothing — the differential needs at least one round per session (default 3, and >1 is deliberate: see the one-off first-call effect in issue #93)"

echo "== 0. serve =="
if [ -n "$base_url" ]; then
  note "using GUILD_VERIFY_BASE_URL=$base_url (not spawning a serve)"
else
  command -v opencode >/dev/null 2>&1 || finish_inconclusive "opencode is not on PATH — nothing to probe"
  note "opencode $(opencode --version 2>/dev/null || echo '(version unknown)')"
  # A free-ish loopback port. The window between picking and binding is the same one
  # src/lifecycle.ts documents; a collision surfaces as "serve did not answer", i.e.
  # INCONCLUSIVE, never as a wrong verdict.
  port=$(( 40000 + (RANDOM % 20000) ))
  serve_log="$(mktemp)"
  opencode serve --port "$port" --hostname 127.0.0.1 >"$serve_log" 2>&1 &
  serve_pid=$!
  base_url="http://127.0.0.1:$port"
  ready=""
  for _ in $(seq 1 60); do
    curl -sf -m 2 "$base_url/doc" -o /dev/null 2>/dev/null && { ready=1; break; }
    kill -0 "$serve_pid" 2>/dev/null || break
    sleep 0.5
  done
  if [ -z "$ready" ]; then
    printf '  serve output: %s\n' "$(tail -5 "$serve_log" 2>/dev/null | tr '\n' ' ')"
    rm -f "$serve_log"
    finish_inconclusive "opencode serve did not answer GET /doc on $base_url"
  fi
  rm -f "$serve_log"
  note "serve up on $base_url"
fi

# --- 1. is there even a v2 surface on this build? --------------------------
echo "== 1. does this build expose a v2 permission surface? =="
doc="$(curl -sS -m 15 "$base_url/doc" 2>/dev/null)"
[ -n "$doc" ] || finish_inconclusive "GET /doc returned nothing — cannot tell which endpoints exist"
v2_paths="$(printf '%s' "$doc" | jq -r '.paths | keys[]' 2>/dev/null | grep '^/api/.*permission' || true)"
if [ -z "$v2_paths" ]; then
  echo
  pass "this opencode exposes NO /api/ permission surface — there is nothing to migrate onto"
  printf '\033[32mpermission surface: PIN HOLDS (vacuously)\033[0m — CONTRACT C69a unchanged.\n'
  exit 0
fi
note "v2 paths present:"
printf '%s\n' "$v2_paths" | sed 's/^/       /'
v2_eval_path="$(printf '%s\n' "$v2_paths" | grep -E '/api/session/\{[A-Za-z]+\}/permission$' | head -1)"
[ -n "$v2_eval_path" ] || finish_inconclusive "no /api/session/{id}/permission evaluate endpoint in /doc — the v2 shape has changed; re-read the API before judging #93"


# --- 2. one gated + one control session per agent in the matrix -------------
# Validate the matrix and derive the distinct agents (bash 3.2: no associative arrays, so
# membership is a space-delimited string test).
agents=""
for pair in $matrix; do
  case "$pair" in
    *:*) ;;
    *) finish_inconclusive "GUILD_VERIFY_MATRIX entry '$pair' is not in 'agent:permission' form" ;;
  esac
  a="${pair%%:*}"; p="${pair#*:}"
  { [ -n "$a" ] && [ -n "$p" ]; } \
    || finish_inconclusive "GUILD_VERIFY_MATRIX entry '$pair' has an empty agent or permission"
  case " $agents " in *" $a "*) ;; *) agents="$agents $a" ;; esac
done
agents="${agents# }"
[ -n "$agents" ] || finish_inconclusive "GUILD_VERIFY_MATRIX is empty — nothing to probe"

echo "== 2. sessions per agent ($agents) — one carrying a v1 ask ruleset, one carrying none =="
mk_session() { # mk_session <json-body>
  curl -sS -m 20 -X POST "$base_url/session" -H 'content-type: application/json' -d "$1" 2>/dev/null \
    | jq -r '.id // empty' 2>/dev/null
}
perms_for() { # perms_for <agent> — the permissions this agent contributes to the matrix
  _out=""
  for _pair in $matrix; do
    [ "${_pair%%:*}" = "$1" ] || continue
    _out="$_out ${_pair#*:}"
  done
  printf '%s' "${_out# }"
}
ruleset_json() { # ruleset_json <agent> — an ask rule per probed permission
  _first=1; _out="["
  for _p in $(perms_for "$1"); do
    [ "$_first" -eq 1 ] || _out="$_out,"
    _out="$_out{\"permission\":\"$_p\",\"pattern\":\"*\",\"action\":\"ask\"}"
    _first=0
  done
  printf '%s]' "$_out"
}
# STRUCTURAL, NOT SUBSTRING. A `case "$stored" in *'"bash"'*'"ask"'*)` match is satisfied by
# a ruleset that denies bash and asks about something else entirely — the probe would then
# proceed on a premise that never held, and equal `allow`s would be reported as PIN HOLDS
# from a stored ruleset that never contained the ask rule. jq is already a dependency here,
# so require the EXACT entry: {permission:<p>, pattern:"*", action:"ask"}.
stored_has_rule() { # stored_has_rule <stored-json> <permission>
  printf '%s' "$1" | jq -e --arg p "$2" '
    if type == "array"
    then any(.[]; (.permission? == $p) and (.pattern? == "*") and (.action? == "ask"))
    else false end' >/dev/null 2>&1
}

sessions=""   # one "agent gated control" record per agent
for a in $agents; do
  g="$(mk_session "{\"agent\":\"$a\",\"title\":\"issue93 gated\",\"permission\":$(ruleset_json "$a")}")"
  c="$(mk_session "{\"agent\":\"$a\",\"title\":\"issue93 control\"}")"
  [ -n "$g" ] && [ -n "$c" ] \
    || finish_inconclusive "could not create both sessions for agent '$a' (auth? agent def missing? POST /session changed?)"
  # THE ONLY ROUTE TO A FALSE GREEN, closed explicitly: with one id for both creates the
  # differential compares a session with itself and can only ever report "nothing changed".
  [ "$g" != "$c" ] \
    || finish_inconclusive "POST /session returned the SAME id for both creates on '$a' ($g) — there is no control session, so the differential is a session compared with itself and can only produce a false 'pin holds'"
  all_sessions="$all_sessions $g $c"
  stored="$(curl -sS -m 15 "$base_url/session/$g" 2>/dev/null | jq -c '.permission // empty' 2>/dev/null)"
  for p in $(perms_for "$a"); do
    stored_has_rule "$stored" "$p" \
      || finish_inconclusive "the gated session for '$a' does not carry {permission:\"$p\", pattern:\"*\", action:\"ask\"} in its stored ruleset (got: ${stored:-null}) — the ruleset was never stored, so v2's answer proves nothing either way"
  done
  pass "$a: ruleset stored and echoed structurally intact ($(perms_for "$a"))"
  note "$a: gated=$g  control=$c"
  sessions="$sessions
$a $g $c"
done

# --- 3. ask v2 the same question about both, for every probed permission ----
echo "== 3. evaluate each probed permission on the v2 surface, $rounds rounds per session =="
# MORE THAN ONE ROUND, AND INSTABILITY IS INCONCLUSIVE — NOT A NOTE. Issue #93 records a
# one-off: the first v2 evaluation after serve startup returned `deny` where every later
# attempt returned `allow`, never reproduced and not diagnosed. A verdict drawn from a sample
# that moved under us is not a verdict, in EITHER direction, so a session whose rounds
# disagree ends the run at INCONCLUSIVE rather than being noted and then concluded from.
evaluate() { # evaluate <sessionId> <agent> <permission>
  curl -sS -m 20 -X POST "$base_url${v2_eval_path%%\{*}$1/permission" \
    -H 'content-type: application/json' \
    -d "{\"action\":\"$3\",\"resources\":[\"issue-93-probe\"],\"agent\":\"$2\"}" 2>/dev/null \
    | jq -r '.data.effect // "unreadable"' 2>/dev/null
}
stable_value() { # stable_value <effects…> — echoes the value if all agree, else empty
  _first="${1%% *}"
  for _e in $1; do [ "$_e" = "$_first" ] || { printf ''; return 1; }; done
  printf '%s' "$_first"
}

informative=0
differing=""
tested=""
for pair in $matrix; do
  a="${pair%%:*}"; p="${pair#*:}"
  g=""; c=""
  while read -r sa sg sc; do
    [ "$sa" = "$a" ] || continue
    g="$sg"; c="$sc"
  done <<EOF
$sessions
EOF
  [ -n "$g" ] && [ -n "$c" ] || continue
  ge=""; ce=""
  i=0
  while [ "$i" -lt "$rounds" ]; do
    i=$(( i + 1 ))
    ge="$ge $(evaluate "$g" "$a" "$p")"
    ce="$ce $(evaluate "$c" "$a" "$p")"
  done
  ge="${ge# }"; ce="${ce# }"
  note "$a/$p: gated=[$ge] control=[$ce]"
  case " $ge $ce " in
    *unreadable*) finish_inconclusive "$a/$p: a v2 evaluation returned no readable effect — the response shape may have changed (expected {\"data\":{\"effect\":\"allow|deny|ask\"}})" ;;
  esac
  gs="$(stable_value "$ge")" \
    || finish_inconclusive "$a/$p: the GATED rounds disagreed with each other ([$ge]) — the sample moved under the probe, so neither 'pin holds' nor 'revisit' can be concluded from it. Re-run; if it persists, that instability is itself the finding and belongs on issue #93 (which records a one-off of exactly this shape)."
  cs="$(stable_value "$ce")" \
    || finish_inconclusive "$a/$p: the CONTROL rounds disagreed with each other ([$ce]) — same reason: an unstable control cannot establish what the ruleset did or did not change."
  # A match only means something if the UNGATED case was `allow`: the bridge may gate only a
  # tool the agent ALREADY allows (C66 invariant 2), so there has to have been something for
  # the ask rule to narrow. A control that denies means this agent never allowed the tool —
  # a stale matrix or an edited def — and would otherwise green from an evaluation that
  # never engaged.
  if [ "$cs" != "allow" ]; then
    note "$a/$p: NOT INFORMATIVE — the control answered '$cs', so this agent does not allow the tool and an ask rule had nothing to narrow. Skipped, not counted."
    continue
  fi
  informative=$(( informative + 1 ))
  tested="$tested $a/$p"
  [ "$gs" = "$cs" ] || differing="$differing $a/$p(gated=$gs,control=$cs)"
done
tested="${tested# }"

# --- 4. verdict: did the ruleset change the answer? -------------------------
echo "== 4. verdict =="
[ "$informative" -gt 0 ] \
  || finish_inconclusive "no probed (agent, permission) pair was informative — every control answered something other than 'allow', so nothing here could have been narrowed by an ask rule. Check that the agent defs still allow these tools, or set GUILD_VERIFY_MATRIX."

if [ -z "$differing" ]; then
  echo
  pass "the v1 ruleset changed NOTHING on v2, for every informative pair: $tested"
  printf '\033[32mpermission surface: PIN HOLDS\033[0m — for the evaluations actually run (%s), a stored v1 ask rule did not change what the v2 evaluator answered, so migrating the approval bridge onto it would gate nothing while reporting itself armed. This is a statement about THOSE evaluations on THIS build, not about the v2 surface in general. CONTRACT C69a stands; keep the bridge on the v1 endpoints.\n' "$tested"
  exit 0
fi

# The answers differ. Report WHAT differs and where a request (if any) landed — a migration
# has to answer in the right store, and on 1.18.7 the two stores are separate.
echo
att "the v1 ruleset CHANGED v2's answer for:$differing"
first_diff="${differing# }"; first_diff="${first_diff%%(*}"
diff_agent="${first_diff%%/*}"
diff_gated=""
while read -r sa sg sc; do
  [ "$sa" = "$diff_agent" ] || continue
  diff_gated="$sg"
done <<EOF
$sessions
EOF
if [ -n "$diff_gated" ]; then
  v1_pending="$(curl -sS -m 15 "$base_url/permission" 2>/dev/null | jq -c "[.[]? | select(.sessionID==\"$diff_gated\")] | length" 2>/dev/null)"
  v2_pending="$(curl -sS -m 15 "$base_url/api/session/$diff_gated/permission" 2>/dev/null | jq -c '.data | length' 2>/dev/null)"
  note "pending requests for the gated session of '$diff_agent' — v1 GET /permission: ${v1_pending:-unreadable}; v2 GET /api/session/{id}/permission: ${v2_pending:-unreadable}"
  note "(on 1.18.7 these were SEPARATE stores, and the v1 reply endpoints 404 on a v2 request id — see the V1 PIN block in src/client.ts.)"
fi
echo
printf '\033[31mpermission surface: REVISIT #93\033[0m — the v2 evaluator now behaves differently on this build. That is the FIRST of C69a'"'"'s two preconditions, not permission to migrate: the live proof must also be extended to cover the v2 path (test/approve.test.ts drives a v1-behaving fake and would go green on a bridge that gates nothing), and C66'"'"'s two invariants must be re-derived for the v2 rule shape rather than assumed to carry over.\n'
exit 7
