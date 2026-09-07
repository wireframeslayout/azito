#!/usr/bin/env bash
set -euo pipefail

HERDR_VERSION="0.8.2"
# TODO: replace with the real sha256 from the GitHub release page
# https://github.com/herdr/herdr/releases/tag/v0.8.2
HERDR_SHA256="PLACEHOLDER_REPLACE_WITH_REAL_SHA256_FROM_GITHUB_RELEASE"

INSTALL_DIR="${HOME}/.local/bin"
BINARY="${INSTALL_DIR}/herdr"
DOWNLOAD_URL="https://github.com/herdr/herdr/releases/download/v${HERDR_VERSION}/herdr-linux-x86_64"

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
