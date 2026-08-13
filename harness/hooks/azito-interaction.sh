#!/bin/bash
# Claude Code Notification hook — notify AZITO that this agent is now waiting for
# a user answer (Phase B real-time pending-answer detection). Fires
# POST /api/webhooks/agent-interaction with event "open" so the hub can show a
# banner in the chat view immediately, without waiting for the actual question
# content (which only becomes available after the answer, from transcript logs —
# see TranscriptEntry type: 'interaction'). Sibling script to azito-activity.sh;
# same env/token sourcing and same fire-and-forget curl pattern.
set -euo pipefail

# Source token from env file (mode 600) instead of command-line embedding.
#
# Precedence: values already present in the environment win over the env file.
# The env file assigns unconditionally (`AZITO_URL=...`), so sourcing it would
# otherwise clobber anything the caller set — including values prefixed inline
# on the hook command in settings.json (`AZITO_URL=... azito-interaction.sh`).
# That inline form is how a single machine wires different hook entries to
# different hubs (e.g. a local hub while azitoctl.env points at a remote one),
# so we save the pre-set values first and restore them after sourcing.
# Keep in sync with azito-activity.sh.
SAVED_AZITO_URL="${AZITO_URL:-}"
SAVED_AZITO_WEBHOOK_TOKEN="${AZITO_WEBHOOK_TOKEN:-}"
SAVED_AZITO_SERVER_NAME="${AZITO_SERVER_NAME:-}"

AZITOCTL_ENV="$HOME/.azito/azitoctl${AZITO_PREFIX:+-$AZITO_PREFIX}.env"
if [[ -f "$AZITOCTL_ENV" ]]; then
  set +u
  . "$AZITOCTL_ENV"
  set -u
fi

if [[ -n "$SAVED_AZITO_URL" ]]; then AZITO_URL="$SAVED_AZITO_URL"; fi
if [[ -n "$SAVED_AZITO_WEBHOOK_TOKEN" ]]; then AZITO_WEBHOOK_TOKEN="$SAVED_AZITO_WEBHOOK_TOKEN"; fi
if [[ -n "$SAVED_AZITO_SERVER_NAME" ]]; then AZITO_SERVER_NAME="$SAVED_AZITO_SERVER_NAME"; fi

AZITO_URL="${AZITO_URL:-http://localhost:3001}"
AZITO_WEBHOOK_TOKEN="${AZITO_WEBHOOK_TOKEN:-}"
AZITO_SERVER_NAME="${AZITO_SERVER_NAME:-}"

if [[ -z "$AZITO_WEBHOOK_TOKEN" || -z "$AZITO_SERVER_NAME" ]]; then
  exit 0
fi

# Claude Code sends every Notification event through this hook (no matcher is
# registered — see setup.sh), so this hook fires for far more than "waiting
# for a user answer": `hook_event_name:"Notification"` payloads carry a
# `notification_type` field whose values (found by inspecting the installed
# Claude Code CLI's bundled source; see hook payload verified live below)
# include at least: permission_prompt, idle_prompt, worker_permission_prompt,
# agent_needs_input (all genuine "waiting for input" states — idle_prompt is
# in particular how an open AskUserQuestion actually surfaces here, roughly
# 60s after it opens, since there is no dedicated tool-call event for it) and
# auth_success, agent_completed, elicitation_complete, elicitation_response
# (none of which represent a fresh open-and-waiting state: auth_success is
# unrelated to task interaction, agent_completed/elicitation_complete/
# elicitation_response report something finishing/already-answered — sending
# our hardcoded "open" event for those would be actively wrong, not just
# noisy). Only the latter, clearly-off-topic set is blacklisted below;
# idle_prompt (the primary signal) and every other/unknown/unparseable type
# is allowed through unfiltered (fail open) so a future Claude Code release
# adding new "waiting" types, or a payload we fail to parse, never suppresses
# a real pending-answer notification.
#
# No jq dependency (matches azito-activity.sh's plain-bash approach): read
# stdin once, then pull notification_type out with a defensive grep -o (no
# `set -e`-fatal failure if the field or stdin body is absent/malformed —
# STDIN_JSON simply stays empty and NOTIFICATION_TYPE resolves to "").
STDIN_JSON="$(cat 2>/dev/null || true)"
NOTIFICATION_TYPE="$(grep -o '"notification_type"[[:space:]]*:[[:space:]]*"[^"]*"' <<< "$STDIN_JSON" 2>/dev/null | head -1 | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/' || true)"

case "$NOTIFICATION_TYPE" in
  auth_success | agent_completed | elicitation_complete | elicitation_response)
    exit 0
    ;;
esac

if [[ -z "${TMUX_PANE:-}" ]] || ! command -v tmux >/dev/null 2>&1; then
  exit 0
fi

# AZITO creates a per-tab tmux *linked session* (`tmux new-session -t <src> -s
# _azito_<src>_<ts>`, sharing the same window group). For a pane reached via a
# linked session, #{session_name} resolves to that throwaway `_azito_*` name,
# not the canonical session the `windows` table keys on — so the lookup below
# would silently miss and the signal gets dropped. #{session_group} resolves
# to the *original* session name in both linked and unlinked cases, so prefer
# it whenever the pane's session is grouped.
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
