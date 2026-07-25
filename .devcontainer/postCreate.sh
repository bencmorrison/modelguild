#!/usr/bin/env bash
# Runs once after the container is created. Installs the agents, ensures the
# persistent volumes are writable by `node`, verifies the toolchain, and reports
# auth status.
set -euo pipefail

# Claude Code and opencode are installed HERE rather than in the Dockerfile: a RUN
# layer is cached, so a rebuild would keep reinstalling nothing and serve the image's
# original versions indefinitely. This runs on every container create, so a rebuild
# gets the current release of each. `|| true` because a registry hiccup must not fail
# container creation — the version report below prints MISSING if it does.
# Note: opencode's `run` flags are verified at the version recorded in AGENTS.md; a
# newer one landing here is expected, not pinned.
sudo npm install -g @anthropic-ai/claude-code@latest opencode-ai@latest 2>&1 | tail -1 || true

# The bind sources are created host-user-owned by prepare-host-state.sh, which
# lines up with `node` (uid 1000) on the hosts this targets. chown defensively for
# the hosts where it does not — Docker creates a missing bind source root-owned.
sudo chown node:node "$HOME/.claude" "$HOME/.local/share/opencode" "$HOME/.config/gh" 2>/dev/null || true
# Keep the surviving shell (the verify/lint scripts) executable — the bash wrapper
# layer was retired at M12; the product is the TypeScript/MCP server (npm).
chmod +x modelguild/verify-guild-*.sh modelguild/tests/*.sh 2>/dev/null || true

# Link the selected host Claude config snapshot into the active ~/.claude.
# settings.json is copied only on a fresh volume because host hooks/statusLine/
# paths may need container-specific changes.
host_claude="$(pwd)/.devcontainer/.host-config"
if [ -d "$host_claude" ]; then
  # prepare-host-config.sh dereferences host symlinks, so no host dotfiles tree is
  # needed in the container.
  [ -e "$host_claude/CLAUDE.md" ]             && ln -sfn "$host_claude/CLAUDE.md"             "$HOME/.claude/CLAUDE.md"
  [ -e "$host_claude/statusline-command.sh" ] && ln -sfn "$host_claude/statusline-command.sh" "$HOME/.claude/statusline-command.sh"
  for sub in commands agents; do
    [ -d "$host_claude/$sub" ] && ln -sfn "$host_claude/$sub" "$HOME/.claude/$sub"
  done
  # Activate host settings.json on a fresh volume (won't clobber once it exists).
  [ -f "$HOME/.claude/settings.json" ] || { [ -e "$host_claude/settings.json" ] && cp -f "$host_claude/settings.json" "$HOME/.claude/settings.json"; }
  echo "host config: imported selected paths from .devcontainer/.host-config"
fi

# Persist ~/.claude.json (Claude Code account/onboarding state). It lives in HOME,
# OUTSIDE the mounted ~/.claude, so a rebuild wipes it and forces a re-login even
# though the tokens (~/.claude/.credentials.json) persist. Keep the real file inside
# the mount and symlink it back so login survives rebuilds.
persist="$HOME/.claude/home-dot-claude.json"
if [ ! -L "$HOME/.claude.json" ]; then
  [ -f "$HOME/.claude.json" ] && [ ! -f "$persist" ] && mv "$HOME/.claude.json" "$persist"
  [ -f "$persist" ] || echo '{}' > "$persist"
  ln -sfn "$persist" "$HOME/.claude.json"
fi

echo "== ModelGuild dev container =="
printf 'node:     %s\n' "$(node --version 2>/dev/null || echo MISSING)"
printf 'claude:   %s\n' "$(claude --version 2>/dev/null || echo MISSING)"
printf 'opencode: %s\n' "$(opencode --version 2>/dev/null || echo MISSING)"

echo
echo "-- auth status --"
if claude -p "ok" >/dev/null 2>&1; then
  echo "claude:   logged in"
else
  echo "claude:   NOT logged in — run 'claude' then '/login' inside this container"
fi
if opencode auth list 2>/dev/null | grep -qiE '[1-9][0-9]* credential|: '; then
  echo "opencode: has credentials"
else
  echo "opencode: no credentials — run 'opencode auth login' inside this container"
fi
if gh auth status >/dev/null 2>&1; then
  echo "gh:       logged in"
else
  echo "gh:       NOT logged in — run 'gh auth login' inside this container"
fi
# Commit signing uses the 1Password SSH agent forwarded in by VS Code (SSH_AUTH_SOCK).
if [ -n "${SSH_AUTH_SOCK:-}" ] && ssh-add -l 2>/dev/null | grep -qi 'signing'; then
  echo "signing:  1Password signing key available via forwarded agent"
else
  echo "signing:  no forwarded signing key — commits may prompt on host or need -c commit.gpgsign=false"
fi

echo
echo "Log in once (persists in ~/.modelguild on the host, across rebuilds AND prunes), then try:"
echo "  /guild:consult <question>   |   /guild:panel <question>   |   /guild:delegate <task>   |   /guild:collaborate <problem>"
