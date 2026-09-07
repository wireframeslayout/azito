#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${SCRIPT_DIR}/azito.toml"
SESSION_NAME="azito"
HERDR_BIN="${HOME}/.local/bin/herdr"

if [ ! -x "${HERDR_BIN}" ]; then
  echo "ERROR: herdr not found at ${HERDR_BIN}. Run install.sh first." >&2
  exit 1
fi

# Deploy azito.toml to herdr's config directory
HERDR_CONFIG_DIR="${HOME}/.config/herdr"
mkdir -p "${HERDR_CONFIG_DIR}"
if [ -f "${HERDR_CONFIG_DIR}/config.toml" ] && ! cmp -s "${CONFIG}" "${HERDR_CONFIG_DIR}/config.toml"; then
  cp "${HERDR_CONFIG_DIR}/config.toml" "${HERDR_CONFIG_DIR}/config.toml.bak"
fi
cp "${CONFIG}" "${HERDR_CONFIG_DIR}/config.toml"

SOCKET_PATH="${HERDR_CONFIG_DIR}/sessions/${SESSION_NAME}/herdr.sock"
if [ -S "${SOCKET_PATH}" ]; then
  if HERDR_SESSION="${SESSION_NAME}" "${HERDR_BIN}" status server >/dev/null 2>&1; then
    # Reload config on already-running server
    echo '{"jsonrpc":"2.0","method":"server.reload_config","params":{},"id":1}' \
      | socat - UNIX-CONNECT:"${SOCKET_PATH}" 2>/dev/null || true
    echo "herdr session '${SESSION_NAME}' already running (config reloaded)"
    exit 0
  fi
  rm -f "${SOCKET_PATH}"
fi

start_with_systemd() {
  local unit_name="herdr-${SESSION_NAME}"
  local unit_dir="${HOME}/.config/systemd/user"
  local unit_file="${unit_dir}/${unit_name}.service"

  mkdir -p "${unit_dir}"
  cat > "${unit_file}" <<UNIT
[Unit]
Description=herdr server (session: ${SESSION_NAME})

[Service]
Type=simple
Environment=HERDR_SESSION=${SESSION_NAME}
ExecStart=${HERDR_BIN} server
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNIT

  systemctl --user daemon-reload
  systemctl --user enable --now "${unit_name}.service"
  echo "herdr started via systemd user unit '${unit_name}'"
}

start_with_nohup() {
  local log_dir="${HOME}/.local/state/herdr"
  mkdir -p "${log_dir}"
  HERDR_SESSION="${SESSION_NAME}" nohup "${HERDR_BIN}" server \
    > "${log_dir}/server-${SESSION_NAME}.log" 2>&1 &
  local pid=$!
  echo "herdr started via nohup (pid=${pid}, log=${log_dir}/server-${SESSION_NAME}.log)"
}

if systemctl --user status >/dev/null 2>&1; then
  start_with_systemd
else
  start_with_nohup
fi
