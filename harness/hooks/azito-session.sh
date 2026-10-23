#!/bin/bash
# Claude Code SessionStart hook — tell AZITO the session ID the agent is now running
# under, so the hub can keep windows.agent_session_id current when the session changes
# mid-conversation (/resume, /subtask, ...). Sends `event: "session"` to the
# agent-activity webhook, which never changes the window's activity state.
set -euo pipefail

# ── Destination profile resolution ──
# Same single-profile rule as azito-activity.sh (see "Destination profile resolution"
# there): URL / token / server name are never merged per-variable.
if [[ -n "${AZITO_URL:-}" && -n "${AZITO_WEBHOOK_TOKEN:-}" && -n "${AZITO_SERVER_NAME:-}" ]]; then
  : # complete profile supplied by the caller — use it untouched
else
  AZITO_URL=""
  AZITO_WEBHOOK_TOKEN=""
  AZITO_SERVER_NAME=""
  AZITOCTL_ENV="$HOME/.azito/azitoctl${AZITO_PREFIX:+-$AZITO_PREFIX}.env"
  if [[ -f "$AZITOCTL_ENV" ]]; then
    set +u
    . "$AZITOCTL_ENV"
    set -u
  fi
fi

EVENT="session"

STDIN_JSON="$(cat 2>/dev/null || true)"
SESSION_ID="$(grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' <<< "$STDIN_JSON" 2>/dev/null | head -1 | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/' || true)"
if [[ ! "$SESSION_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  exit 0
fi
SESSION_FIELD="$(printf ',"sessionId":"%s"' "$SESSION_ID")"

AZITO_URL="${AZITO_URL:-http://localhost:3001}"
AZITO_WEBHOOK_TOKEN="${AZITO_WEBHOOK_TOKEN:-}"
AZITO_SERVER_NAME="${AZITO_SERVER_NAME:-}"

if [[ -z "$AZITO_WEBHOOK_TOKEN" || -z "$AZITO_SERVER_NAME" ]]; then
  exit 0
fi

# A pane run by the misao daemon has no $TMUX_PANE; the hub resolves the window from
# $MISAO_PANE_ID (webhook field `misaoPaneId`). A tmux pane takes the other path.
if [[ -z "${TMUX_PANE:-}" && "${MISAO_PANE_ID:-}" =~ ^p_[0-9A-Z]{26}$ ]]; then
  if [[ "$AZITO_SERVER_NAME" == *'"'* || "$AZITO_SERVER_NAME" == *'\'* ]]; then
    exit 0
  fi
  PAYLOAD=$(printf '{"serverName":"%s","misaoPaneId":"%s","event":"%s"%s}' \
    "$AZITO_SERVER_NAME" "$MISAO_PANE_ID" "$EVENT" "$SESSION_FIELD")
else
  if [[ -z "${TMUX_PANE:-}" ]] || ! command -v tmux >/dev/null 2>&1; then
    exit 0
  fi

  # #{session_group} resolves to the original session name for AZITO's per-tab linked
  # sessions (see azito-activity.sh for the full rationale; keep the expression in sync).
  IDENT="$(tmux display-message -p -t "$TMUX_PANE" '#{?session_grouped,#{session_group},#{session_name}}|#{window_index}|#{window_name}|#{pane_index}' 2>/dev/null)" || exit 0
  [[ -n "$IDENT" ]] || exit 0

  IFS='|' read -r SESSION_NAME WINDOW_INDEX WINDOW_NAME PANE_INDEX <<< "$IDENT"

  # A window name containing `|` would shift the split above — verify both indices.
  if [[ ! "$WINDOW_INDEX" =~ ^[0-9]+$ || ! "$PANE_INDEX" =~ ^[0-9]+$ ]]; then
    exit 0
  fi

  # Skip rather than emit malformed JSON for names with JSON-special characters.
  for value in "$AZITO_SERVER_NAME" "$SESSION_NAME" "$WINDOW_NAME"; do
    if [[ "$value" == *'"'* || "$value" == *'\'* ]]; then
      exit 0
    fi
  done

  PAYLOAD=$(printf '{"serverName":"%s","sessionName":"%s","windowIndex":%s,"windowName":"%s","paneIndex":%s,"event":"%s","muxPaneRef":"%s"%s}' \
    "$AZITO_SERVER_NAME" "$SESSION_NAME" "$WINDOW_INDEX" "$WINDOW_NAME" "$PANE_INDEX" "$EVENT" "${TMUX_PANE:-}" "$SESSION_FIELD")
fi

# Fire-and-forget in the background so this never blocks Claude Code. The token is fed
# via `--config -` (stdin) so it never appears in argv.
( curl -sf --config - -X POST "${AZITO_URL}/api/webhooks/agent-activity" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    --max-time 3 \
    >/dev/null 2>&1 <<CURLCFG || true
header = "Authorization: Bearer ${AZITO_WEBHOOK_TOKEN}"
CURLCFG
) &

exit 0
