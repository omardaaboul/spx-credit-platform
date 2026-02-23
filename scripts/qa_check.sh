#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[qa] eslint"
npm run lint

echo "[qa] vitest"
npm run test

echo "[qa] next build"
npm run build

echo "[qa] pytest"
PYTHONPATH=. .venv/bin/pytest -q tests

echo "[qa] all checks passed"
