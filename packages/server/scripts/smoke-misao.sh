#!/bin/bash
# Smoke test for the misao bundled in an extracted hub release: runs it the way the installed service does (bundled node,
# bundled node-pty, a mode-700 data directory), asks the daemon for server.info, and stops it again.
# Usage: smoke-misao.sh <extracted hub bundle dir>
set -euo pipefail

BUNDLE="${1:?usage: smoke-misao.sh <extracted hub bundle dir>}"
NODE="${BUNDLE}/node"
MISAO="${BUNDLE}/misao/misao.mjs"

"$NODE" "$MISAO" --version

# a short path: unix socket paths are limited to 107 bytes
WORK="$(mktemp -d "${TMPDIR:-/tmp}/azs.XXXXXX")"
chmod 700 "$WORK"
PID=""
cleanup() {
  [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

"$NODE" "$MISAO" serve --socket "$WORK/m.sock" --data "$WORK" >"$WORK/serve.log" 2>&1 &
PID=$!

INFO=""
for _ in $(seq 1 50); do
  if [ -S "$WORK/m.sock" ] && INFO="$(MISAO_SOCKET="$WORK/m.sock" "$NODE" "$MISAO" status --json 2>/dev/null)"; then
    break
  fi
  INFO=""
  sleep 0.2
done

if [ -z "$INFO" ]; then
  echo "ERROR: the bundled misao did not answer server.info" >&2
  cat "$WORK/serve.log" >&2 || true
  exit 1
fi
echo "$INFO"

# the release version and the protocol version must both be reported
echo "$INFO" | grep -Eq '"version" *: *"[0-9]+\.[0-9]+\.[0-9]+"' || { echo "ERROR: no release version in server.info" >&2; exit 1; }
echo "$INFO" | grep -Eq '"protocolVersion" *: *"[0-9]+\.[0-9]+\.[0-9]+"' || { echo "ERROR: no protocol version in server.info" >&2; exit 1; }

# Open a minimal pane through the same socket, see its output, and close it: this exercises node-pty's native addon
# (a mismatched build passes server.info but fails here).
export MISAO_SOCKET="$WORK/m.sock"
PANE_JSON="$("$NODE" "$MISAO" new --json -- sh -c 'echo misao-smoke-ok; sleep 30')"
PANE_ID="$(echo "$PANE_JSON" | grep -Eo '"paneId" *: *"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
[ -n "$PANE_ID" ] || { echo "ERROR: could not open a pane: $PANE_JSON" >&2; exit 1; }
SEEN=""
for _ in $(seq 1 50); do
  if "$NODE" "$MISAO" screen "$PANE_ID" 2>/dev/null | grep -q misao-smoke-ok; then SEEN=1; break; fi
  sleep 0.2
done
[ -n "$SEEN" ] || { echo "ERROR: the pane did not show its output" >&2; exit 1; }
"$NODE" "$MISAO" kill --force "$PANE_ID" >/dev/null
echo "bundled misao OK"
