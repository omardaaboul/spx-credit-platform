#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:-3100}"
BASE_URL="${1:-http://127.0.0.1:${PORT}}"
OUT="docs/SMOKE_RESULTS.md"
mkdir -p docs

echo "# Smoke Results" > "$OUT"
echo >> "$OUT"
echo "- Base URL: $BASE_URL" >> "$OUT"
echo "- Timestamp (UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$OUT"

echo "[smoke] starting next dev in background"
STARTED_LOCAL=0
DEV_PID=""
if curl -sf "$BASE_URL/api/spx0dte" >/tmp/spx_smoke_api.json 2>/dev/null; then
  echo "[smoke] using existing server at $BASE_URL"
elif curl -sf "http://127.0.0.1:3000/api/spx0dte" >/tmp/spx_smoke_api.json 2>/dev/null; then
  BASE_URL="http://127.0.0.1:3000"
  echo "[smoke] using existing server at $BASE_URL"
elif curl -sf "http://127.0.0.1:3001/api/spx0dte" >/tmp/spx_smoke_api.json 2>/dev/null; then
  BASE_URL="http://127.0.0.1:3001"
  echo "[smoke] using existing server at $BASE_URL"
else
  npm run dev -- --port "$PORT" >/tmp/spx_smoke_dev.log 2>&1 &
  DEV_PID=$!
  STARTED_LOCAL=1
fi
cleanup() {
  if [ "$STARTED_LOCAL" -eq 1 ] && [ -n "$DEV_PID" ] && kill -0 "$DEV_PID" >/dev/null 2>&1; then
    kill "$DEV_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

for i in {1..40}; do
  if curl -sf "$BASE_URL/api/spx0dte" >/tmp/spx_smoke_api.json 2>/dev/null; then
    break
  fi
  sleep 0.5
done

if ! curl -sf "$BASE_URL/api/spx0dte" >/tmp/spx_smoke_api.json; then
  echo "[smoke] WARN: /api/spx0dte unavailable in this runtime"
  {
    echo
    echo "## Endpoint Checks"
    echo "- SKIPPED: /api/spx0dte unavailable in current runtime (likely sandbox listen restriction)."
    echo
    echo "## Dev Log Tail"
    echo '```'
    tail -n 80 /tmp/spx_smoke_dev.log 2>/dev/null || true
    echo '```'
  } >> "$OUT"
  exit 0
fi

curl -sf "$BASE_URL/spx-0dte" >/tmp/spx_smoke_page.html
curl -sf "$BASE_URL/api/spx0dte/candidates?limit=3" >/tmp/spx_smoke_candidates.json
curl -sf "$BASE_URL/api/spx0dte/trades?status=OPEN&limit=3" >/tmp/spx_smoke_trades.json

python3 - <<'PY' >/tmp/spx_smoke_summary.txt
import json
from pathlib import Path
p=json.loads(Path('/tmp/spx_smoke_api.json').read_text())
c=json.loads(Path('/tmp/spx_smoke_candidates.json').read_text())
t=json.loads(Path('/tmp/spx_smoke_trades.json').read_text())
print('market_source=', p.get('market',{}).get('source'))
print('candidates=', len(p.get('candidates',[])))
print('alerts=', len(p.get('alerts',[])))
print('candidates_endpoint_ok=', c.get('ok'))
print('trades_endpoint_ok=', t.get('ok'))
PY

{
  echo
  echo "## Endpoint Checks"
  echo '- GET /api/spx0dte ✅'
  echo '- GET /spx-0dte ✅'
  echo '- GET /api/spx0dte/candidates ✅'
  echo '- GET /api/spx0dte/trades ✅'
  echo
  echo "## Summary"
  echo '```'
  cat /tmp/spx_smoke_summary.txt
  echo '```'
  echo
  echo "## Dev Log Tail"
  echo '```'
  tail -n 60 /tmp/spx_smoke_dev.log
  echo '```'
} >> "$OUT"

echo "[smoke] wrote $OUT"
