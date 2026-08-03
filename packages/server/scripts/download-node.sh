#!/bin/bash
set -euo pipefail

# Download a Node.js binary for the specified platform/arch.
# Usage: download-node.sh <node-version> <platform> <arch> <output-dir>
# Example: download-node.sh v24.14.0 linux x64 ./stage

if [ $# -ne 4 ]; then
  echo "Usage: $0 <node-version> <platform> <arch> <output-dir>" >&2
  exit 1
fi

NODE_VERSION="$1"
PLATFORM="$2"
ARCH="$3"
OUTPUT_DIR="$4"

TMPDIR_DL=$(mktemp -d)
trap 'rm -rf "$TMPDIR_DL"' EXIT

FILENAME="node-${NODE_VERSION}-${PLATFORM}-${ARCH}.tar.gz"
if [ "$PLATFORM" = "darwin" ]; then
  FILENAME="node-${NODE_VERSION}-${PLATFORM}-${ARCH}.tar.gz"
fi

URL="https://nodejs.org/dist/${NODE_VERSION}/${FILENAME}"
SHASUMS_URL="https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt"

echo "[download-node] Downloading ${URL}..."
curl -fsSL -o "${TMPDIR_DL}/${FILENAME}" "$URL"
curl -fsSL -o "${TMPDIR_DL}/SHASUMS256.txt" "$SHASUMS_URL"

echo "[download-node] Verifying SHA256..."
EXPECTED=$(grep "${FILENAME}" "${TMPDIR_DL}/SHASUMS256.txt" | awk '{print $1}')
if [ -z "$EXPECTED" ]; then
  echo "ERROR: Could not find SHA256 for ${FILENAME} in SHASUMS256.txt" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL=$(sha256sum "${TMPDIR_DL}/${FILENAME}" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL=$(shasum -a 256 "${TMPDIR_DL}/${FILENAME}" | awk '{print $1}')
else
  echo "ERROR: No sha256sum or shasum found" >&2
  exit 1
fi

if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "ERROR: SHA256 mismatch: expected ${EXPECTED}, got ${ACTUAL}" >&2
  exit 1
fi

echo "[download-node] Extracting node binary..."
mkdir -p "$OUTPUT_DIR"
tar xzf "${TMPDIR_DL}/${FILENAME}" -C "$TMPDIR_DL"
cp "${TMPDIR_DL}/node-${NODE_VERSION}-${PLATFORM}-${ARCH}/bin/node" "${OUTPUT_DIR}/node"
chmod +x "${OUTPUT_DIR}/node"

echo "[download-node] Done → ${OUTPUT_DIR}/node"
