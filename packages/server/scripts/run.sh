#!/bin/bash
set -euo pipefail

# Ensure Node.js is on PATH (systemd has minimal PATH)
# nvm
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" 2>/dev/null
# nodenv / anyenv
[ -d "$HOME/.anyenv/envs/nodenv/shims" ] && export PATH="$HOME/.anyenv/envs/nodenv/shims:$PATH"
[ -d "$HOME/.nodenv/shims" ] && export PATH="$HOME/.nodenv/shims:$PATH"
# ~/.local/bin
[ -d "$HOME/.local/bin" ] && export PATH="$HOME/.local/bin:$PATH"

NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo "0")
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "ERROR: Node.js v24+ required (found: v${NODE_MAJOR})" >&2
  exit 1
fi

DIR="$(cd "$(dirname "$0")" && pwd)"

export NODE_PATH="${DIR}/node_modules:${NODE_PATH:-}"

exec node "${DIR}/azito-agent.cjs"
