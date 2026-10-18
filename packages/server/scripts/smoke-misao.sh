#!/bin/bash
# Smoke test for the misao bundled in an extracted hub release: picks the native binary that fits this host (the bundle
# carries one per target), runs it the way the installed service does (a mode-700 data directory), asks the daemon for
# server.info, opens a pane, and stops it again. It needs no node: misao is a single binary.
# Usage: smoke-misao.sh <extracted hub bundle dir>
set -euo pipefail

BUNDLE="${1:?usage: smoke-misao.sh <extracted hub bundle dir>}"

case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) TARGET=x86_64-unknown-linux-musl ;;
  Linux/aarch64 | Linux/arm64) TARGET=aarch64-unknown-linux-musl ;;
  Darwin/arm64) TARGET=aarch64-apple-darwin ;;
  Darwin/x86_64) TARGET=x86_64-apple-darwin ;;
  *) echo "ERROR: no bundled misao for $(uname -s)/$(uname -m)" >&2; exit 1 ;;
esac
MISAO="${BUNDLE}/misao/${TARGET}/misao"
[ -x "$MISAO" ] || { echo "ERROR: ${MISAO} is missing or not executable" >&2; exit 1; }

"$MISAO" --version

# a short path: unix socket paths are limited to 107 bytes
WORK="$(mktemp -d "${TMPDIR:-/tmp}/azs.XXXXXX")"
chmod 700 "$WORK"
PID=""
cleanup() {
  if [ -n "$PID" ]; then kill "$PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# Isolate from any misao the host already runs: only the temporary socket is used.
unset MISAO_DIR MISAO_CONFIG
export MISAO_SOCKET="$WORK/m.sock"

"$MISAO" serve --socket "$WORK/m.sock" --data "$WORK" >"$WORK/serve.log" 2>&1 &
PID=$!

INFO=""
for _ in $(seq 1 50); do
  if [ -S "$WORK/m.sock" ] && INFO="$("$MISAO" status --json 2>/dev/null)"; then
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

# Open a minimal pane through the same socket, see its output, and close it: this exercises the pty (a binary that
# starts and answers server.info but cannot open a pane fails here).
PANE_JSON="$("$MISAO" new --json -- sh -c 'echo misao-smoke-ok; sleep 30')"
PANE_ID="$(echo "$PANE_JSON" | grep -Eo '"paneId" *: *"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
[ -n "$PANE_ID" ] || { echo "ERROR: could not open a pane: $PANE_JSON" >&2; exit 1; }
SEEN=""
for _ in $(seq 1 50); do
  if "$MISAO" screen "$PANE_ID" 2>/dev/null | grep -q misao-smoke-ok; then SEEN=1; break; fi
  sleep 0.2
done
[ -n "$SEEN" ] || { echo "ERROR: the pane did not show its output" >&2; exit 1; }
"$MISAO" kill --force "$PANE_ID" >/dev/null
echo "bundled misao OK"
