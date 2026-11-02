#!/bin/bash
set -euo pipefail

# systemd and launchd do not inherit the user's login PATH.
if [ "${1:-}" != "--azito-login" ]; then
  : "${SHELL:?SHELL must name the user's login shell}"
  exec "$SHELL" -lc 'exec /bin/bash "$1" --azito-login' azito "$0"
fi

NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo "0")
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "ERROR: Node.js v24+ required (found: v${NODE_MAJOR})" >&2
  exit 1
fi

DIR="$(cd "$(dirname "$0")" && pwd)"

export NODE_PATH="${DIR}/node_modules:${NODE_PATH:-}"

exec node "${DIR}/azito-agent.cjs"
