#!/usr/bin/env bash
# Regression test for host timezone detection.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/modelguild-host-tz.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
tmp="$(cd "$tmp" && pwd -P)"
out="$tmp/host-timezone"
fake="$tmp/host"
mkdir -p "$fake/etc"

# -u TZ so a runner that exports one cannot mask the probe under test.
run() {
  env -u TZ -u MODELGUILD_TZ \
    MODELGUILD_HOST_TZ_FILE="$out" MODELGUILD_TZ_PROBE_ROOT="$fake" "$@" \
    bash "$here/prepare-host-timezone.sh" >/dev/null 2>&1
}

expect_zone() {
  local label="$1" want="$2" got
  [ -f "$out" ] || { echo "FAIL: $label wrote no timezone file" >&2; exit 1; }
  got="$(cat "$out")"
  [ "$got" = "$want" ] || { echo "FAIL: $label got '$got', want '$want'" >&2; exit 1; }
}

expect_none() {
  local label="$1"
  [ ! -f "$out" ] || { echo "FAIL: $label left '$(cat "$out")' behind" >&2; exit 1; }
}

# Linux shape: /etc/localtime symlinked into a zoneinfo tree (target need not exist).
ln -sfn /usr/share/zoneinfo/Australia/Sydney "$fake/etc/localtime"
run
expect_zone "localtime symlink" "Australia/Sydney"

# macOS puts zoneinfo elsewhere; the cut is at `zoneinfo/`.
ln -sfn /var/db/timezone/zoneinfo/America/Argentina/Buenos_Aires "$fake/etc/localtime"
run
expect_zone "macOS localtime symlink" "America/Argentina/Buenos_Aires"

# Debian/WSL shape: localtime is a copy, the name is in /etc/timezone.
rm -f "$fake/etc/localtime"
printf 'Europe/Berlin\n' > "$fake/etc/timezone"
run
expect_zone "/etc/timezone fallback" "Europe/Berlin"

run env TZ=Etc/GMT+10
expect_zone "TZ env beats the probes" "Etc/GMT+10"

run env TZ=Europe/Berlin MODELGUILD_TZ=Pacific/Auckland
expect_zone "MODELGUILD_TZ beats TZ" "Pacific/Auckland"

# Junk must be refused AND clear a stale file — the value is resolved as a path
# under /usr/share/zoneinfo.
run env MODELGUILD_TZ='../../etc/passwd'
expect_none "path-traversal value"

printf 'Australia/Sydney\n' > "$out"
run env MODELGUILD_TZ='Not A Zone'
expect_none "value with spaces"

printf 'Australia/Sydney\n' > "$out"
run env MODELGUILD_TZ='/absolute/zone'
expect_none "absolute path value"

# A host with neither probe must leave no file.
rm -f "$fake/etc/timezone" "$fake/etc/localtime"
printf 'Australia/Sydney\n' > "$out"
run
expect_none "undetectable host"

echo "host timezone detection: PASS"
