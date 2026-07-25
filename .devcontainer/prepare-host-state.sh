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
