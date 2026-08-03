#!/bin/bash
# Claude Code UserPromptSubmit/Stop hook — notify AZITO of event-driven agent
# activity (Tier 1). Fires "start" on UserPromptSubmit and "stop" on Stop, so
# the hub can flip a window's activity state immediately instead of waiting on
# the Tier 2 sliding-window heuristic (AgentActivityMonitor).
set -euo pipefail

# Source token from env file (mode 600) instead of command-line embedding
AZITOCTL_ENV="$HOME/.azito/azitoctl${AZITO_PREFIX:+-$AZITO_PREFIX}.env"
if [[ -f "$AZITOCTL_ENV" ]]; then
  set +u
  . "$AZITOCTL_ENV"
  set -u
fi

EVENT="${1:-}"
if [[ "$EVENT" != "start" && "$EVENT" != "stop" ]]; then
  exit 0
fi

AZITO_URL="${AZITO_URL:-http://localhost:3001}"
AZITO_WEBHOOK_TOKEN="${AZITO_WEBHOOK_TOKEN:-}"
AZITO_SERVER_NAME="${AZITO_SERVER_NAME:-}"

if [[ -z "$AZITO_WEBHOOK_TOKEN" || -z "$AZITO_SERVER_NAME" ]]; then
  exit 0
fi

if [[ -z "${TMUX_PANE:-}" ]] || ! command -v tmux >/dev/null 2>&1; then
  exit 0
fi

IDENT="$(tmux display-message -p -t "$TMUX_PANE" '#{session_name}|#{window_index}|#{window_name}|#{pane_index}' 2>/dev/null)" || exit 0
[[ -n "$IDENT" ]] || exit 0

IFS='|' read -r SESSION_NAME WINDOW_INDEX WINDOW_NAME PANE_INDEX <<< "$IDENT"

# A window name containing `|` would shift the IFS split above and corrupt
# the numeric fields — verify both indices are pure digits before sending.
if [[ ! "$WINDOW_INDEX" =~ ^[0-9]+$ || ! "$PANE_INDEX" =~ ^[0-9]+$ ]]; then
  exit 0
fi

# NOTE (v1): session/window names containing JSON-special characters (`"`,
# `\`) are a theoretical gap — AZITO-generated tmux names never contain them,
# so this is intentionally out of scope for now. As a minimal safety guard,
# skip sending rather than emit malformed JSON if one ever does.
for value in "$AZITO_SERVER_NAME" "$SESSION_NAME" "$WINDOW_NAME"; do
  if [[ "$value" == *'"'* || "$value" == *'\'* ]]; then
    exit 0
  fi
done

PAYLOAD=$(printf '{"serverName":"%s","sessionName":"%s","windowIndex":%s,"windowName":"%s","paneIndex":%s,"event":"%s"}' \
  "$AZITO_SERVER_NAME" "$SESSION_NAME" "$WINDOW_INDEX" "$WINDOW_NAME" "$PANE_INDEX" "$EVENT")

# Fire-and-forget in the background so this never blocks Claude's turn.
# The Authorization header is fed via `--config -` (stdin) so the token never
# appears in the process argv (readable by any local user through ps).
( curl -sf --config - -X POST "${AZITO_URL}/api/webhooks/agent-activity" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    --max-time 3 \
    >/dev/null 2>&1 <<CURLCFG || true
header = "Authorization: Bearer ${AZITO_WEBHOOK_TOKEN}"
CURLCFG
) &

exit 0
