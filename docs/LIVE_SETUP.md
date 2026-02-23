# Live Setup Notes

## Decision Modes

The API returns one canonical `data_mode`:

- `LIVE`
- `DELAYED`
- `HISTORICAL`
- `FIXTURE`

This mode is computed from source priority + freshness:

`fresh LIVE > stale LIVE/DELAYED > HISTORICAL > FIXTURE`

## Session and Simulation Flags

Use these env flags:

```bash
SIMULATION_MODE=false
ALLOW_SIM_ALERTS=false
STRICT_LIVE_BLOCKS=true
FEATURE_0DTE=false
```

Backward compatibility:

- `ALLOW_MARKET_CLOSED` is still accepted as a legacy alias if `SIMULATION_MODE` is unset.

## Required Environment Variables

Use `.env.example` as the source of truth. Minimum runtime requirements:

- `SIMULATION_MODE` (`true|false`)
- `FEATURE_0DTE` (`false` by default)
- Broker auth:
  - `TASTY_USERNAME` + `TASTY_PASSWORD`, or
  - `TASTY_CLIENT_SECRET` + `TASTY_REFRESH_TOKEN`
- Telegram (only if `SPX0DTE_ENABLE_TELEGRAM=true`):
  - `TELEGRAM_BOT_TOKEN` (or legacy `TELEGRAM_TOKEN`)
  - `TELEGRAM_CHAT_ID`

Health endpoint:

```bash
curl -s http://localhost:3000/api/health | jq
```

The endpoint returns a 503 with explicit `issues` when required env is missing for the selected mode.

## Behavior

- `SIMULATION_MODE=false` and market closed:
  - market remains closed (`market.isOpen=false`)
  - decision includes block code `MARKET_CLOSED`
  - entry alerts are suppressed
  - `data_mode` resolves to `FIXTURE` unless fresh delayed/historical source is explicitly available

- `SIMULATION_MODE=true` and market closed:
  - evaluation continues for diagnostics/simulation
  - response includes `market_closed_override=true`
  - decision includes warning `SIMULATION_ACTIVE`
  - entry alerts remain suppressed unless `ALLOW_SIM_ALERTS=true`

## Freshness SLA

Configured by:

```bash
SPX0DTE_SPOT_MAX_AGE_S=2
SPX0DTE_CHAIN_MAX_AGE_S=5
SPX0DTE_GREEKS_MAX_AGE_S=5
STRICT_LIVE_BLOCKS=true
```

If live data breaches SLA, decision status is promoted to `DEGRADED`/`BLOCKED` with explicit reason codes (`SPOT_STALE`, `CHAIN_STALE`, `GREEKS_STALE`, `DATA_INCOMPLETE`).

## Example curl output

### 1) Market closed, simulation disabled

```bash
curl -s http://localhost:3000/api/spx0dte | jq '{isOpen:.market.isOpen,data_mode,market_closed_override,decision_status:(.decision.status // null),block_codes:((.decision.blocks // [])|map(.code))}'
```

Example:

```json
{
  "isOpen": false,
  "data_mode": "FIXTURE",
  "market_closed_override": false,
  "decision_status": "BLOCKED",
  "block_codes": ["MARKET_CLOSED"]
}
```

### 2) Market closed, simulation enabled

```bash
SIMULATION_MODE=true curl -s http://localhost:3000/api/spx0dte | jq '{isOpen:.market.isOpen,data_mode,market_closed_override,decision_status:(.decision.status // null),warning_codes:((.decision.warnings // [])|map(.code))}'
```

Example:

```json
{
  "isOpen": false,
  "data_mode": "HISTORICAL",
  "market_closed_override": true,
  "decision_status": "NO_CANDIDATE",
  "warning_codes": ["SIMULATION_ACTIVE", "ALERTS_SUPPRESSED_SIMULATION"]
}
```
