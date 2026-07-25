#!/usr/bin/env bash
# Detect the host timezone and write it to .devcontainer/.host-timezone for
# postCreate.sh to apply. Runs on the HOST (initializeCommand).
#
# Not `"TZ": "${localEnv:TZ}"`: TZ is unset on most desktops, so it expands to
# empty and the container silently stays UTC. Not .host-config/: prepare-host-config.sh
# rm -rf's that directory and skips it entirely when the host has no ~/.claude.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
out="${MODELGUILD_HOST_TZ_FILE:-$repo_root/.devcontainer/.host-timezone}"
probe="${MODELGUILD_TZ_PROBE_ROOT:-}"   # test-only: re-roots the /etc probes

# No dots and no leading slash: postCreate.sh resolves this as a path under
# /usr/share/zoneinfo.
valid_zone() {
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9+_-]+(/[A-Za-z0-9+_-]+)*$'
}

zone=""
if [ -n "${MODELGUILD_TZ:-}" ]; then
  zone="$MODELGUILD_TZ"
elif [ -n "${TZ:-}" ]; then
  zone="${TZ#:}"
else
  # Cut at zoneinfo/ rather than `readlink -f` (GNU-only): covers Linux
  # /usr/share/zoneinfo/... and macOS /var/db/timezone/zoneinfo/... alike.
  link=""
  if [ -L "$probe/etc/localtime" ]; then
    link="$(readlink "$probe/etc/localtime")" || link=""
  fi
  case "$link" in
    *zoneinfo/*) zone="${link#*zoneinfo/}" ;;
  esac
  # Debian/WSL keep the name here even when /etc/localtime is a plain copy.
  if [ -z "$zone" ] && [ -f "$probe/etc/timezone" ]; then
    zone="$(tr -d '[:space:]' < "$probe/etc/timezone")" || zone=""
  fi
fi

if [ -n "$zone" ] && valid_zone "$zone"; then
  mkdir -p "$(dirname "$out")"
  printf '%s\n' "$zone" > "$out"
  printf 'host timezone: %s\n' "$zone"
else
  # Drop any stale file so the container is not pinned to a zone the host no
  # longer reports.
  rm -f "$out"
  if [ -n "$zone" ]; then
    printf 'host timezone: ignoring unusable value; container stays UTC\n' >&2
  else
    printf 'host timezone: not detected; container stays UTC\n'
  fi
fi
