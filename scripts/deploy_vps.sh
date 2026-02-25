#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/spx}"
SERVICE_NAME="${SERVICE_NAME:-spx-dashboard}"
PORT="${PORT:-3000}"
HOST="${HOST:-127.0.0.1}"
FORCE_KILL_PORT="${FORCE_KILL_PORT:-false}"

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

if [[ -d "${APP_DIR}/.git" ]]; then
  cd "${APP_DIR}"
elif [[ -d "${APP_DIR}/spx-credit-platform/.git" ]]; then
  echo "[WARN] APP_DIR is a parent directory; using ${APP_DIR}/spx-credit-platform"
  cd "${APP_DIR}/spx-credit-platform"
else
  echo "[ERROR] No git repo found at APP_DIR=${APP_DIR} (or APP_DIR/spx-credit-platform)"
  exit 11
fi
echo "[STEP] git pull --ff-only"
git pull --ff-only

echo "[STEP] npm ci"
npm ci

echo "[STEP] npm run build"
npm run build

echo "[STEP] pre-restart port guard (${PORT})"
LISTEN_PID="$(lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t | head -n1 || true)"
SERVICE_MAIN_PID="$(systemctl show -p MainPID --value "${SERVICE_NAME}.service" 2>/dev/null || true)"
if [[ -n "${LISTEN_PID}" && "${LISTEN_PID}" != "${SERVICE_MAIN_PID}" ]]; then
  echo "[WARN] Port ${PORT} is owned by PID ${LISTEN_PID}, not ${SERVICE_NAME}.service MainPID (${SERVICE_MAIN_PID:-none})."
  if [[ "${FORCE_KILL_PORT}" == "true" ]]; then
    echo "[STEP] Killing rogue PID ${LISTEN_PID} (FORCE_KILL_PORT=true)"
    sudo kill "${LISTEN_PID}" || true
    sleep 1
  else
    echo "[ERROR] Rogue process is holding port ${PORT}. Refusing deploy restart."
    echo "[HINT] Re-run with FORCE_KILL_PORT=true to auto-kill, or run: sudo kill ${LISTEN_PID}"
    exit 12
  fi
fi

echo "[STEP] sudo systemctl daemon-reload"
sudo systemctl daemon-reload

echo "[STEP] sudo systemctl restart ${SERVICE_NAME}"
sudo systemctl restart "${SERVICE_NAME}"

echo "[STEP] service status"
sudo systemctl status "${SERVICE_NAME}" --no-pager -n 25

echo "[STEP] recent service logs"
sudo journalctl -u "${SERVICE_NAME}" -n 60 --no-pager

echo "[SUCCESS] Deploy completed for ${SERVICE_NAME} at ${HOST}:${PORT}"
