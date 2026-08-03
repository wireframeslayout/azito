#!/bin/bash
set -euo pipefail

systemctl --user disable --now azito 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/azito.service"
systemctl --user daemon-reload
echo "AZITO daemon uninstalled."
