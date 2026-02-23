#!/usr/bin/env bash
set -euo pipefail

API_URL="${1:-http://localhost:3000/api/spx0dte}"

echo "[live-check] Fetching: ${API_URL}"
RAW="$(curl -fsS -m 20 "${API_URL}")"

RAW_JSON="${RAW}" python3 - <<'PY'
import json
import os
import sys

try:
    payload = json.loads(os.environ.get("RAW_JSON", ""))
except Exception as exc:
    print(f"[FAIL] Could not parse API payload: {exc}")
    raise SystemExit(2)

def yn(v: bool) -> str:
    return "YES" if v else "NO"

market = payload.get("market", {})
stale = payload.get("staleData", {})
contract = payload.get("dataContract", {})
feeds = contract.get("feeds", {}) if isinstance(contract, dict) else {}
targets = (payload.get("multiDte", {}) or {}).get("targets", []) or []
alerts = payload.get("alerts", []) or []
events = payload.get("upcomingMacroEvents", []) or []
startup = payload.get("startupHealth", {}) or {}

is_open = bool(market.get("isOpen"))
status = str(contract.get("status", "unknown"))

print("=== SPX Live Session Checklist ===")
print(f"Market open: {yn(is_open)}")
print(f"Source: {market.get('source', '-')}")
print(f"Data contract: {status}")
print(f"Stale active: {yn(bool(stale.get('active')))} | detail: {stale.get('detail', '-')}")

for key, label in [("underlying_price", "Spot"), ("option_chain", "Chain"), ("greeks", "Greeks")]:
    f = feeds.get(key, {}) if isinstance(feeds, dict) else {}
    age_ms = f.get("ageMs", None)
    age_s = "-" if age_ms is None else f"{round(float(age_ms)/1000)}s"
    print(
        f"{label}: valid={yn(bool(f.get('isValid')))} "
        f"age={age_s} source={f.get('source', '-')} "
        f"error={f.get('error', '-')}"
    )

ready_targets = [
    f"{t.get('target_dte')}D(selected={t.get('selected_dte')})"
    for t in targets
    if bool(t.get("ready"))
]
print(f"Ready DTE targets: {', '.join(ready_targets) if ready_targets else 'none'}")

blocking_events = [e for e in events if e.get("inMarketHours")]
print(f"Upcoming macro events (7d): {len(events)} | blocking-in-hours: {len(blocking_events)}")

telegram_cfg = bool(market.get("telegramEnabled"))
telegram_ok = bool((startup.get("telegram", {}) or {}).get("ok"))
print(f"Telegram enabled flag: {yn(telegram_cfg)} | startup telegram OK: {yn(telegram_ok)}")

entry_alerts = [a for a in alerts if a.get("type") == "ENTRY"]
print(f"Entry alerts in payload: {len(entry_alerts)}")

critical_fail = False
if is_open:
    if status != "healthy":
        print("[FAIL] Market is open but data contract is not healthy.")
        critical_fail = True
    for key in ("underlying_price", "option_chain", "greeks"):
        f = feeds.get(key, {}) if isinstance(feeds, dict) else {}
        if not bool(f.get("isValid")):
            print(f"[FAIL] Required feed invalid during open market: {key}")
            critical_fail = True

if critical_fail:
    raise SystemExit(1)

print("[PASS] Live session checks passed.")
PY
