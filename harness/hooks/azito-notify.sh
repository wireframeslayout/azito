#!/bin/bash
# Claude Code Stop hook — notify AZITO when agent work completes
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

if [[ -z "$AZITO_WEBHOOK_TOKEN" ]]; then
  exit 0
fi

# The Authorization header is fed via `--config -` (stdin) so the token never
# appears in the process argv (readable by any local user through ps).
curl -sf --config - -X POST "${AZITO_URL}/api/webhooks/agent-done" \
  -H "Content-Type: application/json" \
  -d "{\"server\":\"$(hostname)\",\"summary\":\"Agent task completed\"}" \
  --max-time 5 \
  >/dev/null 2>&1 <<CURLCFG || true
header = "Authorization: Bearer ${AZITO_WEBHOOK_TOKEN}"
CURLCFG
