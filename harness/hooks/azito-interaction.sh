#!/bin/bash
# Claude Code Notification hook — notify AZITO that this agent is now waiting for
# a user answer (Phase B real-time pending-answer detection). Fires
# POST /api/webhooks/agent-interaction with event "open" so the hub can show a
# banner in the chat view immediately, without waiting for the actual question
# content (which only becomes available after the answer, from transcript logs —
# see TranscriptEntry type: 'interaction'). Sibling script to azito-activity.sh;
# same env/token sourcing and same fire-and-forget curl pattern.
set -euo pipefail

# Source token from env file (mode 600) instead of command-line embedding
AZITOCTL_ENV="$HOME/.azito/azitoctl${AZITO_PREFIX:+-$AZITO_PREFIX}.env"
if [[ -f "$AZITOCTL_ENV" ]]; then
  set +u
  . "$AZITOCTL_ENV"
  set -u
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

PAYLOAD=$(printf '{"serverName":"%s","sessionName":"%s","windowIndex":%s,"windowName":"%s","paneIndex":%s,"event":"open"}' \
  "$AZITO_SERVER_NAME" "$SESSION_NAME" "$WINDOW_INDEX" "$WINDOW_NAME" "$PANE_INDEX")

# Fire-and-forget in the background so this never blocks Claude's turn.
# The Authorization header is fed via `--config -` (stdin) so the token never
# appears in the process argv (readable by any local user through ps).
( curl -sf --config - -X POST "${AZITO_URL}/api/webhooks/agent-interaction" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    --max-time 3 \
    >/dev/null 2>&1 <<CURLCFG || true
header = "Authorization: Bearer ${AZITO_WEBHOOK_TOKEN}"
CURLCFG
) &

exit 0
