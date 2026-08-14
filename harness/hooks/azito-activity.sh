#!/bin/bash
# Claude Code UserPromptSubmit/Stop hook — notify AZITO of event-driven agent
# activity (Tier 1). Fires "start" on UserPromptSubmit and "stop" on Stop, so
# the hub can flip a window's activity state immediately instead of waiting on
# the Tier 2 sliding-window heuristic (AgentActivityMonitor).
set -euo pipefail

# ── Destination profile resolution ──
# AZITO_URL / AZITO_WEBHOOK_TOKEN / AZITO_SERVER_NAME are always resolved as ONE
# profile, never merged per-variable. Overriding just the URL inline while the
# token still comes from the env file would send another hub's token to that
# inline endpoint — an auth failure *and* a credential disclosure to a hub that
# has no business seeing it.
#
# Resolution rules:
#   1. all three present in the environment → use that set as is (env file not read)
#   2. otherwise → drop whatever partial values are in the environment and take
#      the whole set from the env file selected by AZITO_PREFIX (mode 600, so the
#      token never has to appear in argv)
#
# Rule 2 drops partial values rather than filling the gaps from the file, and it
# is the common path: the hub injects AZITO_URL into every tmux session/window it
# creates (TmuxClient.createSession/createWindow), so "URL only, no token" is the
# normal ambient state. Treating that as a partial profile is exactly the unsafe
# merge — the file's token would be sent to whatever URL happened to be injected.
#
# Switching destinations is therefore done with AZITO_PREFIX
# (`~/.azito/azitoctl-<prefix>.env`), never by overriding individual variables:
# that is how one machine wires hook entries to different hubs while keeping each
# hub's URL, token and server name together. `harness/setup.sh --prefix <name> …`
# writes that env file and embeds the matching AZITO_PREFIX into the hook command
# in settings.json.
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

# AZITO creates a per-tab tmux *linked session* (`tmux new-session -t <src> -s
# _azito_<src>_<ts>`, sharing the same window group). For a pane reached via a
# linked session, #{session_name} resolves to that throwaway `_azito_*` name,
# not the canonical session the `windows` table keys on — so the lookup below
# would silently miss and the Tier 1 signal gets dropped. #{session_group}
# resolves to the *original* session name in both linked and unlinked cases,
# so prefer it whenever the pane's session is grouped.
# The Tier 0 launcher (harness/bin/azs) resolves its supervisor target with the
# same expression — keep both in sync, or the two tiers key differently.
IDENT="$(tmux display-message -p -t "$TMUX_PANE" '#{?session_grouped,#{session_group},#{session_name}}|#{window_index}|#{window_name}|#{pane_index}' 2>/dev/null)" || exit 0
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
