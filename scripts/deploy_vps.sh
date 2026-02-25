#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/spx}"
SERVICE_NAME="${SERVICE_NAME:-spx-dashboard}"
PORT="${PORT:-3000}"
HOST="${HOST:-127.0.0.1}"

on_error() {
  local exit_code=$?
  echo "[ERROR] deploy failed (exit=${exit_code}). Hint: build failed or service restart failed; see output above."
  exit "${exit_code}"
}
trap on_error ERR

echo "[INFO] Deploy starting: APP_DIR=${APP_DIR} SERVICE_NAME=${SERVICE_NAME} HOST=${HOST} PORT=${PORT}"

if [[ ! -d "${APP_DIR}" ]]; then
  echo "[ERROR] APP_DIR does not exist: ${APP_DIR}"
  exit 10
fi

cd "${APP_DIR}"
echo "[STEP] git pull --ff-only"
git pull --ff-only

echo "[STEP] npm ci"
npm ci

echo "[STEP] npm run build"
npm run build

echo "[STEP] sudo systemctl daemon-reload"
sudo systemctl daemon-reload

echo "[STEP] sudo systemctl restart ${SERVICE_NAME}"
sudo systemctl restart "${SERVICE_NAME}"

echo "[STEP] service status"
sudo systemctl status "${SERVICE_NAME}" --no-pager -n 25

echo "[STEP] recent service logs"
sudo journalctl -u "${SERVICE_NAME}" -n 60 --no-pager

echo "[SUCCESS] Deploy completed for ${SERVICE_NAME} at ${HOST}:${PORT}"
