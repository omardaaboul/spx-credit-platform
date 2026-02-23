# Troubleshooting Data and Chart Reliability

## 1) `/api/spx0dte` shows `DEGRADED` or `BLOCKED`

Check:

```bash
curl -s http://localhost:3000/api/spx0dte | jq '{data_mode,decision:.decision.status,blocks:((.decision.blocks // [])|map(.code)),warnings:((.decision.warnings // [])|map(.code)),ages:.data_age_ms,source:.market.source}'
```

Common causes:

- `SPOT_STALE` / `CHAIN_STALE` / `GREEKS_STALE`: feed timestamp beyond SLA.
- `DATA_INCOMPLETE`: strict live blocks enabled (`STRICT_LIVE_BLOCKS=true`) with stale live feeds.
- `MARKET_CLOSED`: simulation disabled while session is closed.

## 2) Chart endpoint returns no candles

Run:

```bash
curl -s "http://localhost:3000/api/market/candles?symbol=SPX&tf=5m&limit=300" | jq '{ok,message,source,dataMode,diagnostics}'
```

If `ok=false`, inspect:

- `diagnostics.attemptedSources`: ordered fallback chain attempted.
- `message`: typed failure reason.

The chart endpoint never silently succeeds with empty candles.

## 3) Market-closed simulation behavior

Set:

```bash
SIMULATION_MODE=true
```

Expected:

- API evaluates with explicit simulation warning.
- UI shows non-live mode banner.
- Alerts remain suppressed unless `ALLOW_SIM_ALERTS=true`.

## 4) Verify freshness SLAs

Tune:

```bash
SPX0DTE_SPOT_MAX_AGE_S=2
SPX0DTE_CHAIN_MAX_AGE_S=5
SPX0DTE_GREEKS_MAX_AGE_S=5
```

Then verify:

```bash
curl -s http://localhost:3000/api/spx0dte | jq '.decision.debug.freshnessAges, .decision.debug.freshnessPolicy'
```

## 5) Quick local confidence check

```bash
npm test
npm run build
```

Both must pass before trusting any runtime decision changes.

