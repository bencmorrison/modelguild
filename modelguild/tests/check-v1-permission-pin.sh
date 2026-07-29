#!/usr/bin/env bash
# check-v1-permission-pin.sh — mechanical half of the issue #93 decision: the approval
# bridge speaks opencode's **v1** permission surface, and stays there (CONTRACT C69a).
#
# WHY A LINT AND NOT JUST A COMMENT. The v2 permission endpoints look like the natural
# modernization target and are not. **The evidence is deliberately NOT restated here** — it
# lives in ONE place, the `V1 PIN` block in `src/client.ts`, and this header points at it
# rather than carrying a copy that can drift. That is not a hypothetical: a claim about the
# v2 event being invisible to the bridge was written into five files at once and was false in
# all five. A comment alone is only as good as whoever reads it; this fails the build.
#
# WHAT IT MATCHES, AND WHY IT IS NARROW. Only opencode's v2 PERMISSION paths —
# `/api/permission…` and `/api/session/<id>/permission…` — in non-comment lines of
# `src/**/*.ts`. It is NOT a ban on `/api/` at large, and that scoping is the difference
# between a check that survives and one that gets deleted: 1.18.7 exposes ~51 `/api/` paths
# (`/api/agent`, `/api/model`, `/api/event`, `/api/session/{id}/message`, `/api/fs/*`, …) and
# ModelGuild already speaks the v1 counterparts of several of them. A maintainer moving
# `guild_models` onto `GET /api/model` has nothing to do with C69a, and a CI failure lecturing
# them about the approval bridge gets answered by deleting the lint. C69a is about the
# permission surface; so is this.
#
# Non-comment, because the pin record quotes the v2 paths on purpose: full-line comments are
# skipped, a trailing `// …` is stripped before matching (a `://` in a URL survives), and a
# match must begin at a path boundary so a docs URL like
# `https://opencode.ai/docs/api/permission` does not trip it.
#
# STATED LIMITS — a check trusted past its evidence is worse than no check. It is a LITERAL
# grep: `"/api" + "/permission"`, a `const V2 = "/api"` template, `["","api",…].join("/")`, or
# `/api` folded into the base URL all evade it, as does a future permission surface under a
# different prefix. Those stay review judgment against C69a. The behavioural question — does
# v2 honour the ruleset on THIS opencode? — is `modelguild/verify-permission-surface.sh`,
# which needs a running serve and is run locally after an opencode bump.
#
# Run:  bash modelguild/tests/check-v1-permission-pin.sh [--self-test]
set -uo pipefail

script_path="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${V1_PIN_LINT_ROOT:-$repo_root}" || exit 1

failed=0
bad() { printf 'FAIL: %s\n' "$*" >&2; failed=1; }

# --- 1. no v2 PERMISSION path may be CONSTRUCTED in src/ --------------------
# Comments are removed by a STATE MACHINE, not by a leading-token heuristic. The heuristic
# was wrong in three shapes that all occur in real code — a `/* … */` on the same line as
# code, a block-comment body line that does not begin with `*`, and a trailing `// …` — and
# "the lint inspects non-comment lines" has to be TRUE rather than approximately true: the
# pin record itself quotes the v2 paths, and a false positive is exactly what gets a check
# deleted rather than read. So: strip `/* … */` ACROSS line boundaries, strip `//` to end of
# line (never a `://` inside a URL), and emit `file:line:code` for whatever text survives.
strip_comments_awk='
function firstLineComment(s,   i, n) {
  i = 1
  while (1) {
    n = index(substr(s, i), "//")
    if (n == 0) return 0
    n = n + i - 1
    if (n > 1 && substr(s, n - 1, 1) == ":") { i = n + 2; continue }
    return n
  }
}
FNR == 1 { inblock = 0 }
{
  line = $0; res = ""
  while (1) {
    if (inblock) {
      p = index(line, "*/")
      if (p == 0) break
      line = substr(line, p + 2); inblock = 0; continue
    }
    a = index(line, "/*")
    b = firstLineComment(line)
    if (a > 0 && (b == 0 || a < b)) {
      res = res substr(line, 1, a - 1); line = substr(line, a + 2); inblock = 1; continue
    }
    if (b > 0) { res = res substr(line, 1, b - 1); break }
    res = res line; break
  }
  if (res ~ /[^ \t]/) printf "%s:%d:%s\n", FILENAME, FNR, res
}'
# The boundary class excludes an alphanumeric/._- immediately before `/api/`, which is what
# keeps a documentation URL such as `https://opencode.ai/docs/api/permission` out.
V2_PERMISSION_RE='(^|[^A-Za-z0-9._-])/api/(permission|session/[^"'"'"'`[:space:]]*/permission)'
if [ -d src ]; then
  ts_files="$(find src -name '*.ts' -type f 2>/dev/null | sort)"
  offenders=""
  if [ -n "$ts_files" ]; then
    # shellcheck disable=SC2086
    offenders="$(awk "$strip_comments_awk" $ts_files 2>/dev/null | grep -E "$V2_PERMISSION_RE" || true)"
  fi
  if [ -n "$offenders" ]; then
    printf '%s\n' "$offenders" >&2
    bad "src/ constructs an opencode v2 PERMISSION path. That surface is off limits by decision (issue #93, CONTRACT C69a).
      Short version: the v2 evaluator does not consult the v1 ruleset the approval bridge stores on the session, so a
      bridge moved onto it reports itself ARMED while the gated tool runs — the one outcome C69 says this feature must
      never produce, and it fails silently. The full evidence is the V1 PIN block in src/client.ts; it is not repeated
      here on purpose.
      This check is scoped to the PERMISSION surface only — /api/model, /api/event and the rest of opencode's v2 tree
      are not covered by C69a and are not blocked here. If you are hitting this for an unrelated migration, that is a
      bug in this lint, not in your change.
      If you believe the permission behaviour has changed on a newer opencode, DO NOT delete this check: run
      'bash modelguild/verify-permission-surface.sh' and take its verdict to CONTRACT C69a, which also requires the
      live proof to be extended before anything moves."
  fi
fi

# --- 2. the in-code record must still be there ------------------------------
# The lint catches a migration; only the record explains why not to attempt one. Losing it
# to a tidy-up is how a decision degrades back into an unexplained oddity.
#
# LOCATED BY CONTENT, NOT BY FILENAME. Guarding this on `[ -f src/client.ts ]` meant DELETING
# or RENAMING that file made the whole check vacuous — the lint went green with the record
# gone entirely, which is the one failure a record-presence check exists to prevent. The
# record may live in any src file; it just has to exist somewhere and still cite the issue.
if [ -d src ]; then
  record_file="$(grep -rl 'V1 PERMISSION SURFACE' src --include='*.ts' 2>/dev/null | head -1)"
  if [ -z "$record_file" ]; then
    bad "the V1 PIN record is GONE from src/ (no file contains 'V1 PERMISSION SURFACE') — the endpoints are pinned by decision (issue #93, CONTRACT C69a) and the reason has to travel with them. Moving it to another src file is fine; deleting it is not."
  elif ! grep -Fq 'issue #93' "$record_file"; then
    bad "$record_file holds the V1 PIN record but no longer cites issue #93 — the record has to name the decision it records"
  fi
fi
# The files that must POINT at the record are DISCOVERED, not listed: any src file that
# constructs a v1 permission reply path needs the pointer, wherever that code lives. A
# hard-coded list would fail with an untrue statement the day `replyToPermission` moves out
# of `cli.ts` — asserting a file's contents about code it no longer holds.
if [ -d src ]; then
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    grep -Fq 'issue #93' "$f" \
      || bad "$f constructs a v1 permission reply endpoint but does not point at the V1 PIN record (issue #93)"
  done <<EOF
$(grep -rlE '/permissions/|/permission/[^"'"'"'`]*/reply|permission/\$\{' src --include='*.ts' 2>/dev/null | grep -vFx "${record_file:-}" || true)
EOF
fi

# --- 3. the re-probe must stay runnable -------------------------------------
# CONTRACT C69a, AGENTS.md and the src comments all send a future maintainer to this script.
# A dangling pointer turns "re-probe first" back into prose nobody can act on.
[ -f modelguild/verify-permission-surface.sh ] \
  || bad "modelguild/verify-permission-surface.sh is missing — CONTRACT C69a's re-probe precondition is documented as runnable and must stay runnable"

[ "$failed" -eq 0 ] || exit 1
echo "v1 permission-surface pin lint: PASS"

if [ "${1:-}" = "--self-test" ]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  baseline="$tmp/baseline"
  mkdir -p "$baseline/modelguild"
  cp -a src "$baseline/src"
  cp -a modelguild/verify-permission-surface.sh "$baseline/modelguild/"

  self_test_failed=0
  expect_rejected() {
    name="$1"; fixture="$2"
    if V1_PIN_LINT_ROOT="$fixture" bash "$script_path" >/dev/null 2>&1; then
      printf 'FAIL: self-test accepted %s\n' "$name" >&2
      self_test_failed=1
    else
      printf 'PASS: rejects %s\n' "$name"
    fi
  }
  expect_accepted() {
    name="$1"; fixture="$2"
    if V1_PIN_LINT_ROOT="$fixture" bash "$script_path" >/dev/null 2>&1; then
      printf 'PASS: accepts %s\n' "$name"
    else
      printf 'FAIL: self-test rejected %s\n' "$name" >&2
      self_test_failed=1
    fi
  }

  # The real tree, with every v1 endpoint it constructs and every v2 path its comments
  # quote, must pass — the "cannot fire on the code it protects" half of the claim.
  expect_accepted "the current tree (v1 endpoints + the pin record quoting v2 paths)" "$baseline"

  fixture="$tmp/v2-migration"
  cp -a "$baseline" "$fixture"
  printf '\nconst evaluate = (id: string) => `/api/session/${id}/permission`;\n' \
    >> "$fixture/src/approve.ts"
  expect_rejected "a v2 evaluate path constructed in src/" "$fixture"

  fixture="$tmp/v2-request-list"
  cp -a "$baseline" "$fixture"
  printf '\nconst pending = "/api/permission/request";\n' >> "$fixture/src/client.ts"
  expect_rejected "the v2 pending-request list constructed in src/" "$fixture"

  # The v1 endpoints the bridge really uses must NOT trip it — a lint that fires on the
  # code it protects gets disabled, so this direction is asserted, not assumed.
  fixture="$tmp/v1-endpoints-are-fine"
  cp -a "$baseline" "$fixture"
  cat >> "$fixture/src/client.ts" <<'EOF'

const approve = (s: string, p: string) => `/session/${s}/permissions/${p}`;
const reject = (p: string) => `/permission/${p}/reply`;
const list = "/permission";
const create = "/session";
EOF
  expect_accepted "the v1 permission endpoints (none of which contain /api/)" "$fixture"

  # THE SCOPING CLAIM, ASSERTED. C69a covers the PERMISSION surface; the rest of opencode's
  # v2 tree is somebody else's migration and must not fail this check, or the first person
  # moving guild_models onto /api/model deletes the lint instead of reading it.
  fixture="$tmp/unrelated-api-paths"
  cp -a "$baseline" "$fixture"
  cat >> "$fixture/src/client.ts" <<'EOF'

export const MODELS_PATH = "/api/model";
export const AGENTS_PATH = "/api/agent";
export const EVENTS_PATH = "/api/event";
const message = (id: string) => `/api/session/${id}/message`;
const readFile = (p: string) => `/api/fs/read/${p}`;
EOF
  expect_accepted "unrelated v2 paths (/api/model, /api/event, /api/session/{id}/message)" "$fixture"

  fixture="$tmp/v2-in-a-comment"
  cp -a "$baseline" "$fixture"
  printf '\n// see /api/session/{id}/permission — the v2 surface we do NOT use\n' \
    >> "$fixture/src/cli.ts"
  expect_accepted "a comment naming the v2 surface (the record has to be able to say it)" "$fixture"

  # Trailing comment after real code: the token is in a comment, so it must not fire.
  fixture="$tmp/v2-in-a-trailing-comment"
  cp -a "$baseline" "$fixture"
  printf '\nconst n = 1; // never /api/permission/request — see the V1 PIN\n' \
    >> "$fixture/src/cli.ts"
  expect_accepted "a v2 path in a TRAILING comment after code" "$fixture"

  # The false positive most likely to land by accident: a documentation URL.
  fixture="$tmp/docs-url"
  cp -a "$baseline" "$fixture"
  printf '\nexport const DOCS = "https://opencode.ai/docs/api/permission";\n' \
    >> "$fixture/src/cli.ts"
  expect_accepted "a docs URL containing docs/api/permission" "$fixture"

  # …but the same shape as a real constructed path must still bite.
  fixture="$tmp/v2-reply-endpoint"
  cp -a "$baseline" "$fixture"
  printf '\nconst reply = (s: string, p: string) => `/api/session/${s}/permission/${p}/reply`;\n' \
    >> "$fixture/src/approve.ts"
  expect_rejected "the v2 reply endpoint constructed in src/" "$fixture"

  # The pointer requirement follows the CODE, not a hard-coded file list.
  fixture="$tmp/pointer-dropped"
  cp -a "$baseline" "$fixture"
  grep -v 'issue #93' "$baseline/src/approve.ts" > "$fixture/src/approve.ts"
  expect_rejected "a v1-reply-constructing file that dropped its pointer to the record" "$fixture"

  # Every comment shape the state machine exists for. The inline `/* … */` and the
  # block-comment BODY line are the two the earlier leading-token heuristic got wrong.
  fixture="$tmp/v2-in-an-inline-block-comment"
  cp -a "$baseline" "$fixture"
  printf '\nexport const note = 1; /* v2: /api/permission */\n' >> "$fixture/src/config.ts"
  expect_accepted "a v2 path in an INLINE /* … */ after code" "$fixture"

  fixture="$tmp/v2-in-a-block-comment-body"
  cp -a "$baseline" "$fixture"
  cat >> "$fixture/src/config.ts" <<'EOF'

/*
v2: /api/session/{id}/permission — a body line that does not start with a star
*/
EOF
  expect_accepted "a v2 path on a block-comment BODY line with no leading star" "$fixture"

  # …and the state machine must not swallow real code around those comments.
  fixture="$tmp/code-after-block-comment"
  cp -a "$baseline" "$fixture"
  printf '\n/* harmless */ const evaluate = (id: string) => `/api/session/${id}/permission`;\n' \
    >> "$fixture/src/config.ts"
  expect_rejected "a v2 path in CODE that follows an inline comment on the same line" "$fixture"

  fixture="$tmp/record-deleted"
  cp -a "$baseline" "$fixture"
  grep -v 'V1 PERMISSION SURFACE' "$baseline/src/client.ts" > "$fixture/src/client.ts"
  expect_rejected "the V1 PIN record deleted from src/client.ts" "$fixture"

  # Deleting the FILE must not be a way to make the record check vacuous.
  fixture="$tmp/record-file-removed"
  cp -a "$baseline" "$fixture"
  rm -f "$fixture/src/client.ts"
  expect_rejected "src/client.ts removed entirely (record gone, not merely edited)" "$fixture"

  # Moving the record to another src file is legitimate and must still pass.
  fixture="$tmp/record-moved"
  cp -a "$baseline" "$fixture"
  cat "$baseline/src/client.ts" > "$fixture/src/pin-record.ts"
  grep -v 'V1 PERMISSION SURFACE' "$baseline/src/client.ts" > "$fixture/src/client.ts"
  expect_accepted "the record MOVED to another src file (located by content, not filename)" "$fixture"

  fixture="$tmp/probe-deleted"
  cp -a "$baseline" "$fixture"
  rm -f "$fixture/modelguild/verify-permission-surface.sh"
  expect_rejected "the re-probe script deleted" "$fixture"

  # KNOWN ESCAPES, ASSERTED AS ESCAPES. These are the documented limits of a literal grep,
  # and they are exercised so the coverage claim is precise rather than aspirational: each
  # one reaches the v2 permission surface and is ACCEPTED. They are not a to-do list — a
  # lint that tried to chase computed strings would false-positive on ordinary code, which
  # costs more than it buys. They are here so nobody has to discover the hole by accident,
  # and so "review judgment, against C69a" names something concrete.
  fixture="$tmp/known-escape-concatenated"
  cp -a "$baseline" "$fixture"
  cat >> "$fixture/src/config.ts" <<'EOF'

const V2_PREFIX = "/api";
export const escapeA = V2_PREFIX + "/permission/request";
export const escapeB = ["", "api", "permission", "saved"].join("/");
export const escapeC = (id: string) => `${V2_PREFIX}/session/${id}/permission`;
EOF
  expect_accepted "KNOWN ESCAPE: split/computed v2 paths (documented limit, not a regression)" "$fixture"

  [ "$self_test_failed" -eq 0 ] || exit 1
  echo "v1 permission-surface pin lint self-tests: PASS"
fi
