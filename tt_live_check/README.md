# tt_live_check
Minimal live connectivity check for SPX option quotes/greeks using `tastytrade` + `DXLinkStreamer`.

## What it does
- Logs in with `TASTY_API_TOKEN` + `TASTY_API_SECRET`
- Finds nearest SPX expiration (prefers 0DTE if available)
- Selects 6 contracts around ATM (3 calls + 3 puts)
- Subscribes to `Quote` + `Greeks` via DXLink
- Prints 1-second heartbeat for 30 seconds
- Reports `PASS` or `FAIL`

## Install
```bash
cd /Users/omardaaboul/options-log/tt_live_check
python3 -m pip install -r requirements.txt
```

## Run
From project root (so `.env` is found automatically):
```bash
cd /Users/omardaaboul/options-log
python3 tt_live_check/tt_live_check.py
```

Optional:
```bash
python3 tt_live_check/tt_live_check.py --duration 30 --retries 3
```

## Required env vars
For `tastytrade>=12.x`:
```bash
export TASTY_API_TOKEN="..."
export TASTY_API_SECRET="..."
```

## Expected PASS output (example)
```text
Login OK.
Spot=5021.45 | expiration=2026-02-18 (DTE=0)
Subscribing 6 symbols to Quote + Greeks ...
[01s] quotes_1s=3 greeks_1s=2
...
Summary:
  quote_updates_first_10s = 14
  quote_update_after_1s  = True
PASS: Live DXLink streaming is healthy.
```

## PASS criteria
- `quote_updates_first_10s >= 5`
- `quote_update_after_1s == True`

If `FAIL`, likely causes include wrong symbol (using option symbol instead of streamer symbol), missing market data permissions, or expired/disconnected stream token.
