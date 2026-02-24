#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[1/6] Stopping existing Next.js processes..."
pkill -9 -f "next start" || true
pkill -9 -f "next-server" || true
sleep 1

echo "[2/6] Verifying port 3000 is free..."
if lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port 3000 is still in use:"
  lsof -nP -iTCP:3000 -sTCP:LISTEN
  exit 1
fi

echo "[3/6] Building app..."
npm run build

echo "[4/6] Starting app on :3000..."
nohup npm run start -- --port 3000 > /tmp/next.log 2>&1 &
sleep 8

echo "[5/6] Listener check..."
lsof -nP -iTCP:3000 -sTCP:LISTEN || {
  echo "No process listening on 3000. Last logs:";
  tail -n 120 /tmp/next.log || true
  exit 1
}

echo "[6/6] Health and payload checks..."
echo "--- /api/health ---"
curl -s http://127.0.0.1:3000/api/health | jq

echo "--- /api/spx0dte (compact) ---"
curl -s http://127.0.0.1:3000/api/spx0dte | jq '{source:.market.source,isOpen:.market.isOpen,data_mode:.data_mode,dataContract:.dataContract.status,auth_status:.auth_status,provider_status:.provider_status,warnings:.warnings}'

echo "Done."
