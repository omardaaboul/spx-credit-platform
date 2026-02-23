#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

mkdir -p docs
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
OUT="docs/TEST_RESULTS.md"

echo "# Test Results" > "$OUT"
echo >> "$OUT"
echo "- Timestamp (UTC): $TS" >> "$OUT"
echo >> "$OUT"

echo "[test] eslint"
{ npm run lint; } 2>&1 | tee /tmp/spx_lint.log

echo "[test] vitest"
{ npm run test; } 2>&1 | tee /tmp/spx_vitest.log

echo "[test] next build"
{ npm run build; } 2>&1 | tee /tmp/spx_build.log

echo "[test] pytest"
{ PYTHONPATH=. .venv/bin/pytest -q tests; } 2>&1 | tee /tmp/spx_pytest.log

{
  echo "## Lint"
  echo '```'
  tail -n 40 /tmp/spx_lint.log
  echo '```'
  echo
  echo "## Vitest"
  echo '```'
  tail -n 80 /tmp/spx_vitest.log
  echo '```'
  echo
  echo "## Next Build"
  echo '```'
  tail -n 80 /tmp/spx_build.log
  echo '```'
  echo
  echo "## Pytest"
  echo '```'
  tail -n 80 /tmp/spx_pytest.log
  echo '```'
} >> "$OUT"

echo "[test] wrote $OUT"
