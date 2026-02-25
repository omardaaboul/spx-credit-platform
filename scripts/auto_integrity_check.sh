#!/usr/bin/env bash
set -euo pipefail

API_URL="${1:-http://127.0.0.1:3000/api/spx0dte}"
LOG_DIR="${SPX0DTE_CHECK_LOG_DIR:-/var/log/spx0dte}"
if ! mkdir -p "${LOG_DIR}" 2>/dev/null; then
  LOG_DIR="/tmp/spx0dte"
  mkdir -p "${LOG_DIR}"
fi

TS_UTC="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
RAW=""
if ! RAW="$(curl -fsS -m 20 "${API_URL}" 2>/tmp/spx0dte_integrity_curl.err)"; then
  ERR_MSG="$(tr '\n' ' ' </tmp/spx0dte_integrity_curl.err | sed 's/"/\\"/g')"
  echo "{\"ts\":\"${TS_UTC}\",\"status\":\"fail\",\"reason\":\"api_unreachable\",\"api\":\"${API_URL}\",\"detail\":\"${ERR_MSG}\"}"
  exit 1
fi

RAW_JSON="${RAW}" TS_UTC="${TS_UTC}" python3 - <<'PY'
import json
import os
import sys

ts = os.environ.get("TS_UTC", "")
try:
    payload = json.loads(os.environ.get("RAW_JSON", ""))
except Exception as exc:
    print(json.dumps({"ts": ts, "status": "fail", "reason": f"json_parse_error: {exc}"}))
    raise SystemExit(2)

market = payload.get("market", {}) or {}
is_open = bool(market.get("isOpen"))
data_mode = str(payload.get("data_mode", "UNKNOWN"))
source = str((market or {}).get("source", "unknown"))
symbol_validation = payload.get("symbolValidation", {}) or {}
checks = symbol_validation.get("checks", {}) if isinstance(symbol_validation, dict) else {}

required_true = [
    "spot_reasonable",
    "chain_has_target_expirations",
    "greeks_match_chain",
]

freshness_true = [
    "spot_age_ok",
    "chain_age_ok",
    "greeks_age_ok",
]

issues = []
if not isinstance(symbol_validation, dict) or not symbol_validation:
    issues.append("missing_symbol_validation")

if is_open and data_mode in {"LIVE", "DELAYED"}:
    for key in required_true:
        if checks.get(key) is not True:
            issues.append(f"{key}=false")
    for key in freshness_true:
        if checks.get(key) is not True:
            issues.append(f"{key}=false")

candidates = payload.get("candidates", []) or []
for cand in candidates:
    if bool(cand.get("ready")) and str(cand.get("reason", "")).startswith("BLOCKED:"):
        issues.append(f"ready_blocked_reason:{cand.get('strategy')}")

status = "pass" if not issues else "fail"
line = {
    "ts": ts,
    "status": status,
    "market_open": is_open,
    "data_mode": data_mode,
    "source": source,
    "issues": issues,
}
print(json.dumps(line))
raise SystemExit(0 if status == "pass" else 1)
PY
