#!/usr/bin/env bash
set -euo pipefail

ZELLIJ_VERSION="0.45.1"
ZELLIJ_SHA256="d006c521dcb475a6005d741e9dd7c5758e5a23b28dd60a5c10cebfa4876319dd"

INSTALL_DIR="${HOME}/.local/bin"
BINARY="${INSTALL_DIR}/zellij"
DOWNLOAD_URL="https://github.com/zellij-org/zellij/releases/download/v${ZELLIJ_VERSION}/zellij-x86_64-unknown-linux-musl.tar.gz"

if [ -x "${BINARY}" ]; then
  current="$("${BINARY}" --version 2>/dev/null | awk '{print $2}' || true)"
  if [ "${current}" = "${ZELLIJ_VERSION}" ]; then
    echo "zellij v${ZELLIJ_VERSION} already installed at ${BINARY}"
    exit 0
  fi
fi

mkdir -p "${INSTALL_DIR}"

tmpdir="$(mktemp -d)"
trap 'rm -rf "${tmpdir}"' EXIT

echo "Downloading zellij v${ZELLIJ_VERSION}..."
curl -fsSL -o "${tmpdir}/zellij.tar.gz" "${DOWNLOAD_URL}"

echo "Extracting..."
tar -xzf "${tmpdir}/zellij.tar.gz" -C "${tmpdir}"

echo "Verifying sha256..."
actual="$(sha256sum "${tmpdir}/zellij" | awk '{print $1}')"
if [ "${actual}" != "${ZELLIJ_SHA256}" ]; then
  echo "ERROR: sha256 mismatch" >&2
  echo "  expected: ${ZELLIJ_SHA256}" >&2
  echo "  actual:   ${actual}" >&2
  exit 1
fi

mv "${tmpdir}/zellij" "${BINARY}"
chmod +x "${BINARY}"

echo "zellij v${ZELLIJ_VERSION} installed to ${BINARY}"
