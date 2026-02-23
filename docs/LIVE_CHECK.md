# Live Connectivity Check

This check validates live market data connectivity only (no order placement).

## Run
```bash
python3 scripts/live_check.py
```

## Latest Run (UTC)
- Timestamp: 2026-02-22T13:48:00Z
- Result: **FAIL in this runtime**
- Reason:
  - `tastytrade` package not importable in current Python runtime
  - Tasty auth env not loaded in this shell

Output snippet:
```json
{
  "env": {
    "tasty_auth_present": false,
    "telegram_configured": false,
    "telegram_enabled": false
  },
  "tt_live_check": {
    "ran": true,
    "ok": false,
    "returncode": 2,
    "output_tail": [
      "FAIL: Unable to import tastytrade SDK: No module named 'tastytrade'"
    ]
  }
}
```

## What it verifies
- Tasty auth env is present
- Telegram env/config state
- DXLink quote/greeks stream receives ongoing updates (`tt_live_check.py`)

## Pass criteria
- `PASS: Live DXLink streaming is healthy.` appears in output

## Safety
- No order API call is made in this script
- Intended for connectivity validation only
