#!/usr/bin/env bash
set -euo pipefail

HERDR_VERSION="0.8.2"
HERDR_SHA256="976150a14d490c94b243ea2e1a7eb2dfb67f12e36b182db90936f6728e6aecf4"

INSTALL_DIR="${HOME}/.local/bin"
BINARY="${INSTALL_DIR}/herdr"
DOWNLOAD_URL="https://github.com/herdrdev/herdr/releases/download/v${HERDR_VERSION}/herdr-linux-x86_64"

if [ -x "${BINARY}" ]; then
  current="$("${BINARY}" --version 2>/dev/null | grep -oP '\d+\.\d+\.\d+' || true)"
  if [ "${current}" = "${HERDR_VERSION}" ]; then
    echo "herdr v${HERDR_VERSION} already installed at ${BINARY}"
    exit 0
  fi
fi

mkdir -p "${INSTALL_DIR}"

tmpfile="$(mktemp)"
trap 'rm -f "${tmpfile}"' EXIT

echo "Downloading herdr v${HERDR_VERSION}..."
curl -fsSL -o "${tmpfile}" "${DOWNLOAD_URL}"

echo "Verifying sha256..."
actual="$(sha256sum "${tmpfile}" | awk '{print $1}')"
if [ "${actual}" != "${HERDR_SHA256}" ]; then
  echo "ERROR: sha256 mismatch" >&2
  echo "  expected: ${HERDR_SHA256}" >&2
  echo "  actual:   ${actual}" >&2
  exit 1
fi

mv "${tmpfile}" "${BINARY}"
chmod +x "${BINARY}"
trap - EXIT

echo "herdr v${HERDR_VERSION} installed to ${BINARY}"
