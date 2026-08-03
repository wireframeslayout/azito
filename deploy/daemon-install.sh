#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if ss -ltn 2>/dev/null | grep -q ':3001 '; then
  echo "WARNING: Port 3001 is already in use."
  echo "  Stop the dev server or existing daemon first."
  echo "  (systemctl --user stop azito / or kill the dev process)"
  read -rp "Continue anyway? [y/N] " ans
  [[ "$ans" =~ ^[Yy] ]] || exit 1
fi

echo "==> Building server + frontend..."
cd "$ROOT"
npm run build

UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
sed "s|__AZITO_ROOT__|${ROOT}|g" "$ROOT/deploy/azito.service" > "$UNIT_DIR/azito.service"

loginctl enable-linger "$(whoami)" 2>/dev/null || true
systemctl --user daemon-reload
systemctl --user enable azito
systemctl --user restart azito

sleep 2
if curl -sf http://localhost:3001/ >/dev/null 2>&1; then
  echo "==> AZITO is running at http://localhost:3001/"
else
  echo "==> WARNING: Health check failed. Check logs:"
  echo "    journalctl --user -u azito -f"
fi
systemctl --user status azito --no-pager
