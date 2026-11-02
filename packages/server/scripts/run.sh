#!/bin/bash
set -euo pipefail

# systemd and launchd do not inherit the user's login PATH.
if [ "${1:-}" != "--azito-login" ]; then
  login_shell="${SHELL:-}"
  if [ -z "$login_shell" ]; then
    if command -v getent >/dev/null 2>&1; then
      login_shell="$(getent passwd "$(id -u)" | cut -d: -f7)"
    elif [ -x /usr/bin/dscl ]; then
      login_shell="$(/usr/bin/dscl . -read "/Users/$(id -un)" UserShell | cut -d' ' -f2-)"
    fi
  fi
  : "${login_shell:?Could not find the user's login shell}"
  exec "$login_shell" -lc 'exec /bin/bash "$1" --azito-login' azito "$0"
fi

NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo "0")
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "ERROR: Node.js v24+ required (found: v${NODE_MAJOR})" >&2
  exit 1
fi

DIR="$(cd "$(dirname "$0")" && pwd)"

export NODE_PATH="${DIR}/node_modules:${NODE_PATH:-}"

exec node "${DIR}/azito-agent.cjs"
