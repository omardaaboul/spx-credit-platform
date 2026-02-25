#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_SRC="${ROOT_DIR}/deploy/systemd/spx0dte-integrity-check.service"
TIMER_SRC="${ROOT_DIR}/deploy/systemd/spx0dte-integrity-check.timer"

if [[ ! -f "${SERVICE_SRC}" || ! -f "${TIMER_SRC}" ]]; then
  echo "[FAIL] Missing systemd unit templates under deploy/systemd"
  exit 2
fi

sudo mkdir -p /var/log/spx0dte
sudo cp "${SERVICE_SRC}" /etc/systemd/system/spx0dte-integrity-check.service
sudo cp "${TIMER_SRC}" /etc/systemd/system/spx0dte-integrity-check.timer
sudo systemctl daemon-reload
sudo systemctl enable --now spx0dte-integrity-check.timer

echo "[OK] Integrity timer installed and started."
echo "Timer status:"
sudo systemctl status --no-pager spx0dte-integrity-check.timer | sed -n '1,12p'
echo
echo "Recent logs:"
sudo tail -n 20 /var/log/spx0dte/integrity-check.log || true

