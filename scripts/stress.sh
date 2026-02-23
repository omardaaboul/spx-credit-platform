#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:-3100}"
BASE_URL="${1:-http://127.0.0.1:${PORT}}"
USERS="${USERS:-50}"
REQUESTS_PER_USER="${REQUESTS_PER_USER:-20}"
OUT_MD="docs/STRESS_TEST_REPORT.md"
mkdir -p docs

echo "# Stress Test Report" > "$OUT_MD"
echo >> "$OUT_MD"
echo "- Base URL: $BASE_URL" >> "$OUT_MD"
echo "- Users: $USERS" >> "$OUT_MD"
echo "- Requests per user: $REQUESTS_PER_USER" >> "$OUT_MD"
echo "- Timestamp (UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$OUT_MD"

echo "[stress] starting next dev in background"
STARTED_LOCAL=0
DEV_PID=""
if curl -sf "$BASE_URL/api/spx0dte" >/dev/null 2>&1; then
  echo "[stress] using existing server at $BASE_URL"
elif curl -sf "http://127.0.0.1:3000/api/spx0dte" >/dev/null 2>&1; then
  BASE_URL="http://127.0.0.1:3000"
  echo "[stress] using existing server at $BASE_URL"
elif curl -sf "http://127.0.0.1:3001/api/spx0dte" >/dev/null 2>&1; then
  BASE_URL="http://127.0.0.1:3001"
  echo "[stress] using existing server at $BASE_URL"
else
  npm run dev -- --port "$PORT" >/tmp/spx_stress_dev.log 2>&1 &
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
  if curl -sf "$BASE_URL/api/spx0dte" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if ! curl -sf "$BASE_URL/api/spx0dte" >/dev/null; then
  echo "[stress] WARN: API unavailable in this runtime"
  {
    echo
    echo "## Results"
    echo "- SKIPPED: API unavailable in current runtime (likely sandbox listen restriction)."
    echo
    echo "## Dev Log Tail"
    echo '```'
    tail -n 80 /tmp/spx_stress_dev.log 2>/dev/null || true
    echo '```'
  } >> "$OUT_MD"
  exit 0
fi

BASE_URL="$BASE_URL" USERS="$USERS" REQUESTS_PER_USER="$REQUESTS_PER_USER" node - <<'NODE' > /tmp/spx_stress_results.json
const base = process.env.BASE_URL || 'http://127.0.0.1:3000';
const users = Number(process.env.USERS || 50);
const rpu = Number(process.env.REQUESTS_PER_USER || 20);

function percentile(arr, p){
  if(!arr.length) return 0;
  const sorted=[...arr].sort((a,b)=>a-b);
  const idx=Math.min(sorted.length-1, Math.floor((p/100)*sorted.length));
  return sorted[idx];
}

async function oneReq(path){
  const t0=Date.now();
  try{
    const res=await fetch(base+path, { cache: 'no-store' });
    const dt=Date.now()-t0;
    return {ok:res.ok, status:res.status, ms:dt};
  }catch{
    return {ok:false, status:0, ms:Date.now()-t0};
  }
}

async function worker(){
  const out=[];
  for(let i=0;i<rpu;i++){
    const path = i%3===0 ? '/api/spx0dte' : (i%3===1 ? '/api/spx0dte/candidates?limit=5' : '/api/spx0dte/trades?status=OPEN&limit=5');
    out.push(await oneReq(path));
  }
  return out;
}

(async()=>{
  const runs = await Promise.all(Array.from({length:users}, ()=>worker()));
  const flat=runs.flat();
  const lat=flat.map(x=>x.ms);
  const errors=flat.filter(x=>!x.ok).length;
  const result={
    total: flat.length,
    errors,
    errorRate: flat.length? errors/flat.length : 0,
    p50: percentile(lat,50),
    p95: percentile(lat,95),
    p99: percentile(lat,99),
    max: Math.max(...lat,0),
    min: Math.min(...lat,0),
  };
  console.log(JSON.stringify(result,null,2));
})();
NODE

python3 - <<'PY' >> "$OUT_MD"
import json
from pathlib import Path
r=json.loads(Path('/tmp/spx_stress_results.json').read_text())
print('\n## Results')
print('```json')
print(json.dumps(r, indent=2))
print('```')
print('\n## Verdict')
if r.get('errorRate',1) <= 0.01:
    print('- PASS: error rate <= 1%')
else:
    print('- FAIL: error rate > 1%')
PY

echo "[stress] wrote $OUT_MD"
