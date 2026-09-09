#!/usr/bin/env bash
# mux-e2e.sh — E2E verification for herdr/zellij mux drivers via AZITO hub API.
#
# Usage: scripts/poc/mux-e2e.sh <server> <herdr|zellij> [hub_url]
#
# Switches the server's mux_runtime, exercises sessions listing, pane
# capture/send-keys/split/rename via ref-based routes, then restores
# the runtime to 'system'. Requires jq, curl, and a running hub.
set -euo pipefail

SERVER="${1:?Usage: $0 <server> <herdr|zellij> [hub_url]}"
RUNTIME="${2:?Usage: $0 <server> <herdr|zellij> [hub_url]}"
HUB="${3:-http://localhost:3001}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$RUNTIME" != "herdr" && "$RUNTIME" != "zellij" ]]; then
  echo "ERROR: runtime must be 'herdr' or 'zellij'" >&2
  exit 1
fi

# Resolve UI token
if [ -z "${AZITO_UI_TOKEN:-}" ]; then
  TOKEN_FILE="${AZITO_DATA_DIR:-$(dirname "$(dirname "$SCRIPT_DIR")")}/data/ui-token"
  if [ -f "$TOKEN_FILE" ]; then
    AZITO_UI_TOKEN="$(cat "$TOKEN_FILE")"
  else
    echo "ERROR: AZITO_UI_TOKEN not set and $TOKEN_FILE not found" >&2
    exit 1
  fi
fi

AUTH="Authorization: Bearer ${AZITO_UI_TOKEN}"
ORIGINAL_RUNTIME=""
PASS=0
FAIL=0

cleanup() {
  if [ -n "$ORIGINAL_RUNTIME" ]; then
    echo ""
    echo "=== Restoring runtime to ${ORIGINAL_RUNTIME} ==="
    curl -sf -X PUT "${HUB}/api/servers/${SERVER}" \
      -H "$AUTH" -H "Content-Type: application/json" \
      -d "{\"muxRuntime\":\"${ORIGINAL_RUNTIME}\"}" >/dev/null 2>&1 || true
  fi
  echo ""
  echo "Results: ${PASS} passed, ${FAIL} failed"
  [ "$FAIL" -eq 0 ] && exit 0 || exit 1
}
trap cleanup EXIT

assert_eq() {
  local label="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  PASS: ${label}"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: ${label} (expected=${expected}, actual=${actual})"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_empty() {
  local label="$1" actual="$2"
  if [ -n "$actual" ]; then
    echo "  PASS: ${label}"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: ${label} (empty)"
    FAIL=$((FAIL + 1))
  fi
}

# ── Pre-check: no running tasks ──
echo "=== Pre-check: running operations ==="
OPS=$(curl -sf "${HUB}/api/operations" -H "$AUTH" | jq -r 'length')
if [ "$OPS" != "0" ]; then
  echo "WARNING: ${OPS} running operation(s) on the hub. Mux runtime switch may disrupt them."
  echo "Continue? [y/N]"
  read -r CONFIRM
  [ "$CONFIRM" = "y" ] || exit 1
fi

# ── Save original runtime ──
ORIGINAL_RUNTIME=$(curl -sf "${HUB}/api/servers/${SERVER}" -H "$AUTH" | jq -r '.muxRuntime // "system"')
echo "Original runtime: ${ORIGINAL_RUNTIME}"

# ── Step 1: Switch runtime ──
echo ""
echo "=== Step 1: Switch mux_runtime to ${RUNTIME} ==="
curl -sf -X PUT "${HUB}/api/servers/${SERVER}" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"muxRuntime\":\"${RUNTIME}\"}" >/dev/null

DETAIL=$(curl -sf "${HUB}/api/servers/${SERVER}" -H "$AUTH")
MUX_KIND=$(echo "$DETAIL" | jq -r '.mux.kind')
DRIVER_AVAIL=$(echo "$DETAIL" | jq -r '.mux.driverAvailable')
assert_eq "mux.kind" "$MUX_KIND" "$RUNTIME"
assert_eq "mux.driverAvailable" "$DRIVER_AVAIL" "true"

# ── Step 2: Sessions listing ──
echo ""
echo "=== Step 2: GET /sessions ==="
SESSIONS=$(curl -sf "${HUB}/api/servers/${SERVER}/sessions" -H "$AUTH")
SESSION_COUNT=$(echo "$SESSIONS" | jq -r 'length')
echo "  Sessions: ${SESSION_COUNT}"

if [ "$SESSION_COUNT" -gt 0 ]; then
  FIRST_REF=$(echo "$SESSIONS" | jq -r '.[0].windows[0].ref // empty')
  if [ -n "$FIRST_REF" ]; then
    REF_KIND=$(echo "$FIRST_REF" | jq -r '.kind')
    assert_eq "ref.kind" "$REF_KIND" "$RUNTIME"
  else
    echo "  SKIP: no windows in first session"
  fi
else
  echo "  SKIP: no sessions (mux daemon may not be running)"
fi

# ── Step 2b: Window creation ──
if [ "$SESSION_COUNT" -gt 0 ]; then
  echo ""
  echo "=== Step 2b: Window creation via openWindow ==="
  WORKSPACE=$(echo "$SESSIONS" | jq -r '.[0].name')
  WIN_NAME="e2e-win-$$"
  CREATE=$(curl -sf -X POST "${HUB}/api/servers/${SERVER}/mux/workspaces/${WORKSPACE}/windows" \
    -H "$AUTH" -H "Content-Type: application/json" \
    -d "{\"name\":\"${WIN_NAME}\"}" 2>/dev/null || echo '{"error":"create failed"}')
  CREATE_REF=$(echo "$CREATE" | jq -r '.ref // empty')
  if [ -n "$CREATE_REF" ]; then
    echo "  PASS: window created, ref=$(echo "$CREATE_REF" | jq -c .)"
    PASS=$((PASS + 1))

    # herdr: ref.window should be "main" (workspace-level mapping)
    if [ "$RUNTIME" = "herdr" ]; then
      REF_WINDOW=$(echo "$CREATE_REF" | jq -r '.window')
      assert_eq "herdr ref.window" "$REF_WINDOW" "main"
    fi

    # Verify pane exists in the new window
    NEW_REF_ENC=$(python3 -c "import urllib.parse,json,sys; print(urllib.parse.quote(json.dumps(json.loads(sys.argv[1]))))" "$CREATE_REF")
    if [ "$RUNTIME" = "herdr" ]; then
      # herdr: the new workspace appears as a separate session in the listing
      PANES=$(curl -sf "${HUB}/api/servers/${SERVER}/sessions" -H "$AUTH" | \
        jq --arg w "$WIN_NAME" '[.[] | select(.name == $w) | .windows[].panes | length] | add // 0')
    else
      PANES=$(curl -sf "${HUB}/api/servers/${SERVER}/sessions" -H "$AUTH" | \
        jq --arg w "$WIN_NAME" '[.[0].windows[] | select(.name == $w) | .panes | length] | add // 0')
    fi
    if [ "$PANES" -gt 0 ]; then
      echo "  PASS: window has ${PANES} pane(s)"
      PASS=$((PASS + 1))
    else
      echo "  FAIL: window has 0 panes (driver may not be working)"
      FAIL=$((FAIL + 1))
    fi
    # Clean up the window
    CLOSE=$(curl -sf -X POST "${HUB}/api/servers/${SERVER}/mux/windows/${NEW_REF_ENC}/kill" \
      -H "$AUTH" 2>/dev/null || echo '{"error":"close failed"}')
    CLOSE_OK=$(echo "$CLOSE" | jq -r '.ok // false')
    assert_eq "close created window" "$CLOSE_OK" "true"
  else
    echo "  FAIL: window creation returned no ref: $(echo "$CREATE" | jq -c .)"
    FAIL=$((FAIL + 1))
  fi
fi

# ── Step 3: Capture (if windows exist) ──
echo ""
echo "=== Step 3: Capture / send-keys / split / rename ==="
if [ "$SESSION_COUNT" -gt 0 ] && [ -n "${FIRST_REF:-}" ]; then
  ENCODED_REF=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$FIRST_REF")

  # Capture
  CAPTURE=$(curl -sf "${HUB}/api/servers/${SERVER}/mux/windows/${ENCODED_REF}/panes/1/capture" -H "$AUTH" 2>/dev/null || echo '{"error":"capture failed"}')
  HAS_CONTENT=$(echo "$CAPTURE" | jq -r 'has("content")')
  assert_eq "capture has content" "$HAS_CONTENT" "true"

  # Send-keys
  SEND=$(curl -sf -X POST "${HUB}/api/servers/${SERVER}/mux/windows/${ENCODED_REF}/panes/1/send-keys" \
    -H "$AUTH" -H "Content-Type: application/json" \
    -d '{"keys":["echo AZITO_MUX_E2E_OK","Enter"]}' 2>/dev/null || echo '{"error":"send failed"}')
  SEND_OK=$(echo "$SEND" | jq -r '.ok // false')
  assert_eq "send-keys ok" "$SEND_OK" "true"

  sleep 1

  # Re-capture to verify output
  CAPTURE2=$(curl -sf "${HUB}/api/servers/${SERVER}/mux/windows/${ENCODED_REF}/panes/1/capture" -H "$AUTH" 2>/dev/null || echo '{}')
  ECHO_FOUND=$(echo "$CAPTURE2" | jq -r '.content' | grep -c "AZITO_MUX_E2E_OK" || true)
  if [ "$ECHO_FOUND" -gt 0 ]; then
    echo "  PASS: echo output visible in capture"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: echo output not found in capture"
    FAIL=$((FAIL + 1))
  fi

  # Split
  SPLIT=$(curl -sf -X POST "${HUB}/api/servers/${SERVER}/mux/windows/${ENCODED_REF}/panes" \
    -H "$AUTH" -H "Content-Type: application/json" \
    -d '{"direction":"h"}' 2>/dev/null || echo '{"error":"split failed"}')
  SPLIT_OK=$(echo "$SPLIT" | jq -r '.ok // false')
  assert_eq "split ok" "$SPLIT_OK" "true"

  # Rename
  RENAME=$(curl -sf -X PUT "${HUB}/api/servers/${SERVER}/mux/windows/${ENCODED_REF}/rename" \
    -H "$AUTH" -H "Content-Type: application/json" \
    -d '{"name":"e2e-renamed"}' 2>/dev/null || echo '{"error":"rename failed"}')
  RENAME_OK=$(echo "$RENAME" | jq -r '.ok // false')
  assert_eq "rename ok" "$RENAME_OK" "true"
else
  echo "  SKIP: no sessions/windows to operate on"
fi

# ── Step 4: WebSocket test ──
echo ""
echo "=== Step 4: WebSocket connectivity ==="
if [ -n "${FIRST_REF:-}" ]; then
  WS_SCRIPT="${SCRIPT_DIR}/mux-e2e-ws.cjs"
  if [ -f "$WS_SCRIPT" ]; then
    WS_URL="${HUB/http/ws}/ws?mode=terminal&server=${SERVER}&ref=${ENCODED_REF}&pane=1&cols=80&rows=24"
    WS_RESULT=$(node "$WS_SCRIPT" "$WS_URL" "${AZITO_UI_TOKEN}" 2>&1 || echo "ws_error")
    if echo "$WS_RESULT" | grep -q "connected"; then
      echo "  PASS: WebSocket connected"
      PASS=$((PASS + 1))
    else
      echo "  FAIL: WebSocket connection failed: ${WS_RESULT}"
      FAIL=$((FAIL + 1))
    fi
  else
    echo "  SKIP: mux-e2e-ws.cjs not found"
  fi
else
  echo "  SKIP: no ref for WS test"
fi

echo ""
echo "=== Step 5: Capabilities check ==="
CAPS=$(curl -sf "${HUB}/api/servers/${SERVER}" -H "$AUTH" | jq -r '.mux.caps')
if [ "$RUNTIME" = "herdr" ]; then
  assert_eq "caps.zoom" "$(echo "$CAPS" | jq -r '.zoom')" "true"
  assert_eq "caps.paneTitle" "$(echo "$CAPS" | jq -r '.paneTitle')" "true"
  assert_eq "caps.changeEvents" "$(echo "$CAPS" | jq -r '.changeEvents')" "true"
fi
if [ "$RUNTIME" = "zellij" ]; then
  assert_eq "caps.zoom" "$(echo "$CAPS" | jq -r '.zoom')" "true"
  assert_eq "caps.paneTitle" "$(echo "$CAPS" | jq -r '.paneTitle')" "true"
  assert_eq "caps.outputStream" "$(echo "$CAPS" | jq -r '.outputStream')" "false"
fi

# Runtime is restored in cleanup trap
