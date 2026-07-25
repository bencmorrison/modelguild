# ModelGuild dev container.
# Node base (Claude Code and opencode are both distributed via npm) with a few CLI
# conveniences preinstalled. The two agents are NOT installed here — postCreate.sh
# installs them at container-create time, because a RUN layer would be cached and
# serve the same version forever across rebuilds.
FROM mcr.microsoft.com/devcontainers/javascript-node:22

# CLI tools the slash commands and general dev work lean on.
#   jq       — /guild:collaborate (--emit-session) and the verify scripts
#   ripgrep  — fast search
#   less     — pager
#   shellcheck — the lint CI enforces over all *.sh; installed here so the same
#               check runs locally before a push (CI installs its own copy).
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get install -y --no-install-recommends jq ripgrep less shellcheck \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Pre-create the home dirs the agents write their persistent state into, owned by
# `node`. Three of them are bind-mount targets (see devcontainer.json); the rest
# are plain image dirs the agents need writable.
RUN mkdir -p /home/node/.local/share/opencode \
             /home/node/.local/state \
             /home/node/.config/opencode \
             /home/node/.config/gh \
             /home/node/.cache \
             /home/node/.claude \
    && chown -R node:node /home/node/.local /home/node/.config /home/node/.cache /home/node/.claude
