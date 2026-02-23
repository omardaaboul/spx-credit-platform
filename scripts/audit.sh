#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

mkdir -p docs

echo "[audit] running tests"
bash scripts/test.sh

echo "[audit] running smoke"
bash scripts/smoke_e2e.sh

echo "[audit] running stress"
bash scripts/stress.sh

echo "[audit] assembling final report"
python3 - <<'PY'
from pathlib import Path
from datetime import datetime, timezone

ts = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
out = Path('docs/FINAL_AUDIT_REPORT.md')
parts = []
for name in ['SYSTEM_MAP.md','OBSERVABILITY.md','TEST_RESULTS.md','SMOKE_RESULTS.md','STRESS_TEST_REPORT.md','FAILURE_MODES.md','DEBUG_FIX_LOG.md','LIVE_CHECK.md']:
    p=Path('docs')/name
    if p.exists():
        parts.append((name,p.read_text()))

text = [f"# Final Audit Report\n\n- Generated (UTC): {ts}\n"]
for name, body in parts:
    text.append(f"\n## Source: {name}\n\n")
    text.append(body)
out.write_text(''.join(text))
print('wrote', out)
PY

echo "[audit] done"
