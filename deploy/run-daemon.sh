#!/bin/bash
set -euo pipefail

# systemd user unit has minimal PATH — resolve Node.js manager shims
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" 2>/dev/null
[ -d "$HOME/.anyenv/envs/nodenv/shims" ] && export PATH="$HOME/.anyenv/envs/nodenv/shims:$PATH"
[ -d "$HOME/.nodenv/shims" ] && export PATH="$HOME/.nodenv/shims:$PATH"
[ -d "$HOME/.local/bin" ] && export PATH="$HOME/.local/bin:$PATH"
[ -d "$HOME/.claude/local" ] && export PATH="$HOME/.claude/local:$PATH"

NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo "0")
[ "$NODE_MAJOR" -lt 24 ] && { echo "ERROR: Node.js v24+ required (found: v${NODE_MAJOR})" >&2; exit 1; }

if [ -z "${SSH_AUTH_SOCK:-}" ]; then
  for sock in "$XDG_RUNTIME_DIR/ssh-agent.socket" "$HOME/.ssh/agent.sock" "/run/user/$(id -u)/keyring/ssh"; do
    [ -S "$sock" ] && export SSH_AUTH_SOCK="$sock" && break
  done
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/packages/server/dist/main.js"
