#!/bin/bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

# Load .env: prefer stable location (parent of current symlink), fall back to bundle dir
ENV_FILE="${DIR}/../.env"
[ ! -f "$ENV_FILE" ] && ENV_FILE="${DIR}/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$ENV_FILE"
  set +a
fi

# SSH agent socket discovery. AZITO reaches remote servers over SSH, and a
# service started by systemd/launchd does not inherit the login session's
# SSH_AUTH_SOCK, so probe the usual locations per platform.
if [ -z "${SSH_AUTH_SOCK:-}" ]; then
  if [ "$(uname -s)" = "Darwin" ]; then
    # launchd hands the agent socket out via this endpoint; the Listeners path
    # under /private/tmp is the fallback when the endpoint is unavailable.
    SOCK=$(launchctl getenv SSH_AUTH_SOCK 2>/dev/null || true)
    [ -n "$SOCK" ] && [ -S "$SOCK" ] && export SSH_AUTH_SOCK="$SOCK"
    if [ -z "${SSH_AUTH_SOCK:-}" ]; then
      for sock in /private/tmp/com.apple.launchd.*/Listeners "$HOME/.ssh/agent.sock"; do
        [ -S "$sock" ] && export SSH_AUTH_SOCK="$sock" && break
      done
    fi
  else
    for sock in "${XDG_RUNTIME_DIR:-}/ssh-agent.socket" "$HOME/.ssh/agent.sock" "/run/user/$(id -u)/keyring/ssh"; do
      [ -S "$sock" ] && export SSH_AUTH_SOCK="$sock" && break
    done
  fi
fi

# Host tool PATH.
# systemd/launchd hand the service a minimal PATH that omits shell-rc setup, so
# package-manager and version-manager locations are invisible. launchd is the
# harshest: it exports no PATH at all, leaving /usr/bin:/bin:/usr/sbin:/sbin,
# which excludes Homebrew entirely. The hub itself runs on the bundled node, but
# it shells out to host tools — tmux (required), `node`/`npx` for the browser
# runtime and the supervisor, plus the claude/codex CLIs — so those have to be
# reachable. Without this the Setup screen reports tmux/Node.js as missing on a
# host where both work fine in a login shell.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" 2>/dev/null
[ -d "$HOME/.anyenv/envs/nodenv/shims" ] && export PATH="$HOME/.anyenv/envs/nodenv/shims:$PATH"
[ -d "$HOME/.nodenv/shims" ] && export PATH="$HOME/.nodenv/shims:$PATH"
# Homebrew: /opt/homebrew on Apple Silicon, /usr/local on Intel and on Linuxbrew
# it is /home/linuxbrew/.linuxbrew. Neither is in the launchd/systemd default.
[ -d /opt/homebrew/bin ] && export PATH="/opt/homebrew/bin:$PATH"
[ -d /usr/local/bin ] && export PATH="/usr/local/bin:$PATH"
[ -d /home/linuxbrew/.linuxbrew/bin ] && export PATH="/home/linuxbrew/.linuxbrew/bin:$PATH"
[ -d "$HOME/.local/bin" ] && export PATH="$HOME/.local/bin:$PATH"
[ -d "$HOME/.claude/local" ] && export PATH="$HOME/.claude/local:$PATH"

# Locale.
# tmux decides UTF-8 support per *client*, from the locale environment of the
# process that attaches. launchd exports no LANG at all (systemd often neither),
# so AZITO's terminal clients attach in non-UTF-8 mode and tmux redraws every
# non-ASCII glyph as '_' for them — the pane content itself is intact, only what
# that client is sent is mangled. Set a UTF-8 locale when the service has none.
# LC_CTYPE rather than LANG: it carries the character encoding without changing
# the message language of anything the hub shells out to.
if [ -z "${LC_ALL:-}" ] && [ -z "${LC_CTYPE:-}" ] && [ -z "${LANG:-}" ]; then
  if [ "$(uname -s)" = Darwin ]; then
    export LC_CTYPE="UTF-8"
  elif locale -a 2>/dev/null | grep -qx "C.UTF-8"; then
    export LC_CTYPE="C.UTF-8"
  else
    export LC_CTYPE="en_US.UTF-8"
  fi
fi

export NODE_PATH="${DIR}/node_modules:${NODE_PATH:-}"

exec "${DIR}/node" "${DIR}/azito-hub.cjs"
