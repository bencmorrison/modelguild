#!/usr/bin/env bash
# Create the host directories the dev container bind-mounts its persistent agent
# state into. Runs on the HOST, before container creation (initializeCommand).
#
# These were named Docker volumes until 2026-07-25. A named volume survives a
# container rebuild but NOT `docker volume prune` / `docker system prune
# --volumes` / Docker Desktop's "Clean / Purge data" — and losing it silently
# takes every Claude Code session transcript and every OAuth token with it. A
# host directory survives all of those, and the user can back it up.
#
# Docker creates a missing bind source itself, but ROOT-OWNED, which the non-root
# `node` container user cannot write. Creating them here means they are owned by
# the host user (uid 1000 on the Linux/WSL hosts this targets, matching `node`);
# postCreate.sh still chowns defensively for the cases where it does not line up.
set -euo pipefail

state_root="${MODELGUILD_HOST_STATE:-$HOME/.modelguild}"

for dir in claude opencode gh; do
  mkdir -p "$state_root/$dir"
done

# Tokens live in here. Keep the tree off other local accounts.
chmod 700 "$state_root" "$state_root/claude" "$state_root/opencode" "$state_root/gh"

printf 'host state: %s\n' "$state_root"

# A rebuild stops mounting the old named volumes but does not delete them, so state
# from a pre-bind-mount container is still recoverable. Only ever prints — copying a
# credential store is the user's call.
migration_hint() { # <state-dir> <old-volume>
  local dir="$1" vol="$2"
  [ -z "$(ls -A "$state_root/$dir" 2>/dev/null)" ] || return 0
  docker volume inspect "$vol" >/dev/null 2>&1 || return 0
  printf '  %s is empty, but the old %s volume still exists. To keep its contents:\n' \
    "$state_root/$dir" "$vol" >&2
  printf '    docker run --rm -v %s:/from -v %s:/to alpine sh -c "cp -a /from/. /to/ && chown -R %s:%s /to"\n' \
    "$vol" "$state_root/$dir" "$(id -u)" "$(id -g)" >&2
}

if command -v docker >/dev/null 2>&1; then
  migration_hint claude modelguild-claude
  migration_hint opencode modelguild-opencode
  migration_hint gh modelguild-gh
fi
