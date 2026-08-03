#!/usr/bin/env bash
set -euo pipefail

MINIO_CONTAINER_NAME="${MINIO_CONTAINER_NAME:-azito-minio}"
MINIO_PORT="${MINIO_PORT:-9000}"
MINIO_CONSOLE_PORT="${MINIO_CONSOLE_PORT:-9001}"
MINIO_ROOT_USER="${MINIO_ROOT_USER:-minioadmin}"
MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-minioadmin}"
MINIO_DATA_DIR="${MINIO_DATA_DIR:-$(cd "$(dirname "$0")/.." && pwd)/minio-data}"

if docker ps --format '{{.Names}}' | grep -qx "$MINIO_CONTAINER_NAME"; then
  echo "MinIO is already running ($MINIO_CONTAINER_NAME)"
  exit 0
fi

if docker ps -a --format '{{.Names}}' | grep -qx "$MINIO_CONTAINER_NAME"; then
  echo "Starting existing MinIO container..."
  docker start "$MINIO_CONTAINER_NAME"
else
  echo "Creating MinIO container..."
  mkdir -p "$MINIO_DATA_DIR"
  docker run -d \
    --name "$MINIO_CONTAINER_NAME" \
    -p "${MINIO_PORT}:9000" \
    -p "${MINIO_CONSOLE_PORT}:9001" \
    -e "MINIO_ROOT_USER=${MINIO_ROOT_USER}" \
    -e "MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD}" \
    -v "${MINIO_DATA_DIR}:/data" \
    minio/minio server /data --console-address ":9001"
fi

echo "MinIO running: API http://localhost:${MINIO_PORT}  Console http://localhost:${MINIO_CONSOLE_PORT}"
echo "Credentials: ${MINIO_ROOT_USER} / ${MINIO_ROOT_PASSWORD}"
