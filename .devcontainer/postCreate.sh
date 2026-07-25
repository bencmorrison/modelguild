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

# The repo's own dependencies: `npm test`, `npx tsc --noEmit` and `npm start` need
# tsx/typescript from devDependencies, and nothing installed them before. Non-fatal
# like the line above — the tooling report at the end says so instead.
if [ -f package-lock.json ]; then
  npm ci 2>&1 | tail -1 || echo "npm ci FAILED — run it before npm test"
else
  npm install 2>&1 | tail -1 || echo "npm install FAILED — run it before npm test"
fi

# The bind sources are created host-user-owned by prepare-host-state.sh, which
# lines up with `node` (uid 1000) on the hosts this targets. chown defensively for
# the hosts where it does not — Docker creates a missing bind source root-owned.
sudo chown node:node "$HOME/.claude" "$HOME/.local/share/opencode" "$HOME/.config/gh" 2>/dev/null || true
# Keep the verify/lint scripts executable. They are all tracked 755, so this is a
# no-op safety net rather than a source of mode-only diffs in the worktree.
chmod +x modelguild/verify-guild-*.sh modelguild/tests/*.sh 2>/dev/null || true

# Adopt the host timezone prepare-host-timezone.sh detected; the image is UTC.
tz_file="$(pwd)/.devcontainer/.host-timezone"
if [ -f "$tz_file" ]; then
  tz="$(tr -d '[:space:]' < "$tz_file")"
  # Re-validate: the file sits in the workspace and this resolves as a path.
  if printf '%s' "$tz" | grep -Eq '^[A-Za-z0-9+_-]+(/[A-Za-z0-9+_-]+)*$' && [ -f "/usr/share/zoneinfo/$tz" ]; then
    sudo ln -snf "/usr/share/zoneinfo/$tz" /etc/localtime
    printf '%s\n' "$tz" | sudo tee /etc/timezone >/dev/null
  else
    echo "timezone: refusing unusable value from .host-timezone; staying UTC" >&2
  fi
fi

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

# Report every tool the documented workflows invoke, so a gap shows up here rather
# than at the first `npm test`. Non-fatal, matching the installs above.
missing=""
report_tool() { # <label> <binary> [version-args...]
  local label="$1" bin="$2" out
  shift 2
  if ! command -v "$bin" >/dev/null 2>&1; then
    printf '%-11s %s\n' "$label:" "MISSING"
    missing="$missing $bin"
    return
  fi
  # No version args for tools whose --version prints a banner.
  if [ "$#" -eq 0 ]; then printf '%-11s %s\n' "$label:" "present"; return; fi
  out="$("$bin" "$@" 2>/dev/null | head -1)" || out=""
  printf '%-11s %s\n' "$label:" "${out:-present}"
}

report_tool node      node     --version
report_tool npm       npm      --version
report_tool claude    claude   --version
report_tool opencode  opencode --version
report_tool git       git      --version
report_tool gh        gh       --version
report_tool jq        jq       --version
report_tool ripgrep   rg       --version
report_tool shellcheck shellcheck   # banner, not a version
report_tool sudo      sudo     --version

if [ -d node_modules ]; then
  printf '%-11s %s\n' "deps:" "node_modules present"
else
  printf '%-11s %s\n' "deps:" "MISSING — run 'npm ci'"
  missing="$missing node_modules"
fi

printf '%-11s %s\n' "time:" "$(date)"

if [ -n "$missing" ]; then
  echo
  echo "!! missing tooling:$missing"
  echo "   This container did NOT land in a working state. Re-run this script, or"
  echo "   rebuild the container. See AGENTS.md -> 'Dev container & auth'."
fi

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
# Nothing here sets a git identity; some editors copy the host ~/.gitconfig in.
if git config user.email >/dev/null 2>&1; then
  echo "git:      identity set"
else
  echo "git:      NO identity — set user.name / user.email before committing"
fi
if [ -n "${SSH_AUTH_SOCK:-}" ] && ssh-add -l >/dev/null 2>&1; then
  echo "ssh agent: forwarded, has keys"
else
  echo "ssh agent: none forwarded — anything needing a key (signing, remotes) won't work"
fi

echo
echo "Log in once (persists in ~/.modelguild on the host, across rebuilds AND prunes), then try:"
echo "  /guild:consult <question>   |   /guild:panel <question>   |   /guild:delegate <task>   |   /guild:collaborate <problem>"
