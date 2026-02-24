# SPX Credit Spread Platform (Multi-DTE)

A local-first SPX decision-support platform focused on **multi-DTE credit spreads**:
- **2 DTE**
- **7 DTE**
- **14 DTE**
- **30 DTE**
- **45 DTE**

Primary UI is **Next.js + React + Tailwind** at `/spx-0dte`.  
No live auto-trading. Paper-routing only when explicitly enabled.

## Features

- Multi-DTE credit spread engine for target buckets `2/7/14/30/45`.
- Nearest-expiry bucket resolution + deterministic ranking.
- Directional spread selection:
  - Bull Put Spread in bullish regimes.
  - Bear Call Spread in bearish regimes.
- DTE-aware checks:
  - delta bands
  - expected move distance fit
  - width rules
  - credit/width bands
  - positive theta
  - z-score + measured-move logic
- Trade lifecycle tracking:
  - Confirm entry from UI.
  - Persist open / exit_pending / closed status in local state.
  - Monitor open trades every poll cycle.
- DTE-aware management plans (profit target, stop multiple, delta stop, time stop).
- Telegram alert dedupe + cooldown:
  - entry debounce + cooldown + daily caps
  - dedupe by candidate/alert id
  - includes DTE + expiry + strikes + spread type + spot
- Local state persistence for readiness transitions and open trades.
- Graceful degradation when data fields are unavailable.
- Primary Decision card focuses on the current eligible multi-DTE candidate.
- Pre-submit live symbol validation:
  - Paper submits are blocked if option symbols are malformed, stale, or not present in the latest live chain for that sleeve.
  - Multi-DTE flows validate against the selected nearest expiry chain.
- Replay QA + alert ACK:
  - Snapshot logs are written to `storage/spx0dte_snapshot_log.jsonl` for deterministic readiness replay.
  - Alerts can be acknowledged; acknowledged alerts are suppressed until their reason/legs materially change.
- Additional risk modules:
  - Stale-data kill switch blocks new entries when live bars are too old.
  - Execution realism model applies conservative fill offsets (mid -> adjusted premium) with confidence labels.
  - Per-strategy alert policy with cooldown + daily lockouts.
  - Open-risk heatmap by side/strategy.
  - Daily preflight GO/NO-GO checklist.
  - Analytics scorecard by strategy/regime/macro/vol tags.
  - Walk-forward replay mode for rolling-window QA.

## Active Strategy Set

- **Enabled by default**:
  - Multi-DTE SPX credit spreads: `2 DTE`, `7 DTE`, `14 DTE`, `30 DTE`, `45 DTE`
- **Disabled by default**:
  - 0DTE sleeves (`FEATURE_0DTE=false`)
  - optional legacy/experimental sleeves (feature-gated)

## Project Structure

- `app.py` - Streamlit dashboard app
- `data/tasty.py` - tastytrade client + polling/streaming snapshot normalization
- `signals/filters.py` - EMR/ATR/VWAP math and gate logic
- `strategies/two_dte_credit.py` - 2-DTE selection + checklist rules
- `strategies/credit_spreads.py` - shared multi-DTE directional spread logic
- `strategies/exit.py` - exit evaluation engine for open trades
- `strategies/condor.py` - legacy 0DTE module (feature-gated)
- `strategies/fly.py` - legacy 0DTE module (feature-gated)
- `strategies/bwb_credit_put.py` - optional legacy/experimental module (feature-gated)
- `alerts/telegram.py` - Telegram formatting + send + 429 handling
- `storage/state.py` - transition/cooldown + open-trade persistence
- `storage/macro_calendar.py` - local macro event calendar loader
- `storage/macro_events.json` - editable CPI/jobs/FOMC calendar
- `storage/.bwb_settings.json` - persisted BWB settings
- `storage/.bwb_state.json` - persisted BWB open-position state
- `storage/bwb_trade_log.jsonl` - append-only BWB entry/exit/adjustment log
- `tests/test_filters.py` - minimal math tests
- `tests/test_exit_logic.py` - exit condition tests
- `tests/test_credit_spreads.py` - trend + directional spread tests
- `tests/test_telegram_formatting.py` - Telegram message formatting tests
- `tests/test_bwb_credit.py` - BWB strike-selection and monitor tests
- `app/spx-0dte/page.tsx` - redesigned multi-DTE UI (React)
- `app/api/spx0dte/route.ts` - lightweight dashboard data endpoint
- `app/components/spx0dte/*` - reusable UI components (TopBar, cards, charts, alerts, table, toasts)
- `lib/spx0dte.ts` - typed dashboard models + UI formatting helpers
- `tests/spx0dte-ui.test.ts` - UI helper tests
- `requirements.txt`

## Requirements

- Python 3.11+
- Local execution

## Environment Variables

Set in your shell or `.env`:

```bash
# tastytrade credentials (token+secret only)
TASTY_API_TOKEN=...
TASTY_API_SECRET=...

# optional test environment toggle
TASTY_IS_TEST=false

# Telegram
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...

# Optional paper-trading (all paper-enabled place actions)
SPX0DTE_PAPER_TRADING=false
SPX0DTE_PAPER_DRY_RUN=false
SPX0DTE_PAPER_REQUIRE_TEST=true
SPX0DTE_PAPER_ACCOUNT_NUMBER=...

# Optional Python executable override for API scripts
# (useful if your active interpreter is not `python3`)
SPX0DTE_PYTHON_BIN=python3

# Optional stale-data freshness threshold in seconds
SPX0DTE_STALE_MAX_SECONDS=90
```

### Modes and Simulation Policy

The decision engine now exposes a canonical data mode contract:

- `LIVE`
- `DELAYED`
- `HISTORICAL`
- `FIXTURE`

Session policy is controlled with:

```bash
SIMULATION_MODE=false
ALLOW_SIM_ALERTS=false
STRICT_LIVE_BLOCKS=true
FEATURE_0DTE=false
```

Behavior summary:

- `SIMULATION_MODE=false` and market closed:
  - engine returns `BLOCKED` with `MARKET_CLOSED`
  - no entry alerts
- `SIMULATION_MODE=true` and market closed:
  - engine evaluates using non-live policy (`HISTORICAL`/`FIXTURE`)
  - response includes simulation warnings
  - alerts stay suppressed unless `ALLOW_SIM_ALERTS=true`
- `STRICT_LIVE_BLOCKS=true`:
  - stale live feeds promote decision state to `DEGRADED/BLOCKED` (freshness SLA enforced)

### Volatility Regime

The decision engine now includes a dedicated volatility stage before DTE bucket selection.

Inputs used:

- `spot`
- `iv_atm` (required)
- optional: `iv_term` (per-bucket IV), realized-vol proxy, `vix`, rolling IV cache history
- freshness ages for vol-critical fields

Classifier output:

- `VOL_SUPPRESSED | VOL_NORMAL | VOL_EXPANDING | VOL_EXTREME | UNKNOWN`
- confidence: `HIGH | MED | LOW`
- features: IV percentile, IV-vs-realized ratio, term-slope, shock flag

Shock detector:

- `SHOCK_MOVE_PCT_EM1SD` (default `0.35`)
- `SHOCK_VIX_JUMP` (default `2.0`)
- emits `VOL_SHOCK` (strict-live block) or `VOL_SHOCK_WARN`

Primary tuning envs:

- `VOL_LOOKBACK_DAYS`, `VOL_MIN_SAMPLES`
- `VOL_PCTL_LOW`, `VOL_PCTL_HIGH`, `VOL_PCTL_EXTREME`
- `VOL_IV_MAX_AGE_MS`, `VOL_IV_RV_SUPPRESSED`, `VOL_IV_RV_EXPANDING`, `VOL_TERM_SLOPE_EXPANDING`
- `SHOCK_MOVE_PCT_EM1SD`, `SHOCK_VIX_JUMP`
- `VOL_POLICY_EXPANDING_ALLOW_2DTE`, `VOL_POLICY_EXTREME_BLOCK_ALL`

Policy overlay on DTE buckets:

- `VOL_NORMAL`: `[2,7,14,30,45]`
- `VOL_SUPPRESSED`: de-prioritize long bucket (default disables `45`)
- `VOL_EXPANDING`: default disables `2` (override via `VOL_POLICY_EXPANDING_ALLOW_2DTE=true`)
- `VOL_EXTREME`: default allows only `[30,45]` (or all blocked if `VOL_POLICY_EXTREME_BLOCK_ALL=true`)

Codes you will see in `decision.blocks[]/warnings[]`:

- `VOL_REGIME_UNKNOWN`
- `VOL_CACHE_INSUFFICIENT`
- `VOL_SHOCK` / `VOL_SHOCK_WARN`
- `VOL_POLICY_BUCKET_DISABLED`

Notes:
- Do not hardcode secrets in code.
- If Telegram vars are missing, alerts are skipped without crashing.
- Paper trading is disabled by default.
- For safety, keep `SPX0DTE_PAPER_REQUIRE_TEST=true` and `TASTY_IS_TEST=true`.

## Deploy on VPS (Ubuntu 22.04)

1. Install Python + Git (and Node.js 20 for Next.js UI):
```bash
sudo apt update
sudo apt install -y git python3 python3-venv python3-pip curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

2. Copy project to `/opt/spx`:
```bash
sudo mkdir -p /opt/spx
sudo chown -R $USER:$USER /opt/spx
git clone <YOUR_REPO_URL> /opt/spx
cd /opt/spx
```

3. Create `.env` from `.env.example`:
```bash
cp .env.example .env
nano .env
```

4. Create data directory:
```bash
sudo mkdir -p /opt/spx/data
sudo chown -R $USER:$USER /opt/spx/data
```

5. Install Python requirements:
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

6. Start API:
```bash
uvicorn backend.api.main:app --host 0.0.0.0 --port 8000
```

7. Start worker:
```bash
python -m backend.worker.main
```

8. Start Next.js UI/API in production (separate shell):
```bash
npm install
npm run build
npm run start
```

9. Verify health checks:
```bash
curl -s http://127.0.0.1:8000/health | jq
curl -s http://127.0.0.1:3000/api/health | jq
```

`/api/health` includes provider auth/runtime fields:
- `auth_status`: `ok | refreshing | failed`
- `provider_status`: `tastytrade-live | tastytrade-partial | down`
- `last_auth_ok_ts`: last successful tasty auth timestamp (UTC)

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run

```bash
streamlit run app.py
```

Open the local URL Streamlit prints (usually [http://localhost:8501](http://localhost:8501)).

## Redesigned React UI (Fortune-500 style)

Run the modern dashboard:

```bash
npm install
npm run dev
```

Open [http://localhost:3000/spx-0dte](http://localhost:3000/spx-0dte).

Notes:
- The React UI polls `/api/spx0dte` every 5 seconds.
- Endpoint now attempts to fetch **live tastytrade** data via `scripts/spx0dte_snapshot.py` and overlays open trades from `storage/.alert_state.json`.
- If live fetch fails, the UI shows **Live data unavailable** with succinct warning text (no synthetic market values).
- All alert cards and open-trade rows explicitly show all 4 option legs.
- Market-hours gate is enforced in ET (`09:30-16:00`, Mon-Fri). When closed, UI signals are suppressed.
- Optional Telegram dispatch from React API route can be enabled with `SPX0DTE_ENABLE_TELEGRAM=true`.
- Optional local testing override for market-hours gate: `SPX0DTE_FORCE_MARKET_OPEN=true` (disabled by default).
- Option Graph (Payoff):
  - Click `Payoff` in the Decision Card to open a right drawer.
  - Expiration curve shows deterministic payoff at expiry (max profit/loss, breakevens, spot marker).
  - Optional `T+0 curve (model)` uses Black-Scholes with leg IV/time inputs when available; toggle is disabled when inputs are missing.

React-only Telegram notes:
- The classic Streamlit app already sends Telegram alerts from Python.
- The React route can also send Telegram if enabled, using dedupe state in `storage/.spx0dte_telegram_state.json`.

### Theme Customization

- Theme toggle is in the top bar (dark/light).
- Core design tokens live in `app/globals.css` under `.spx-shell[data-theme=\"dark\"]` and `.spx-shell[data-theme=\"light\"]`:
  - `--spx-bg`, `--spx-surface`, `--spx-panel`
  - `--spx-text`, `--spx-muted`, `--spx-border`
  - `--spx-accent`, `--spx-grid`
- Adjust these values to change the palette without rewriting components.

## Dashboard Behavior

- Sidebar controls:
  - Strategy/DTE filters and runtime controls
  - Telegram alert toggles
  - Polling and simulation settings
- Top banner metrics:
  - ET time, SPX, EMR, VIX, IV, expected move
- Candidate panels:
  - Multi-DTE credit spread candidates for `2/7/14/30/45`
  - Directional status with trend strength and recommendation
- Live entry gates:
  - pass/fail + detail for each gate
- Open trades section:
  - trade table (P/L %, time in trade, status, next exit reason)
  - selected trade exit-gate checklist
  - manual close controls
- DTE behavior:
  - Nearest available expiry is selected for each target bucket (2/7/14/30/45).
  - Width and delta bands are auto-selected from DTE-specific policy.
  - Alerts trigger only when strict checklist rules pass.

### Replay QA

- In the `REVIEW` tab:
  - `Strategy Monitors` provides a consistent monitor row for all sleeves (Condor/Fly/Directional/Convex/2-DTE/BWB) with setup status, position status, and current monitor reason.
  - Use `Replay QA` to run a deterministic summary over recent snapshot logs.
  - Use `Walk-forward` to run rolling-window checks (window + step sizes) and review stability across slices.
  - Configure replay window size and run on demand.
  - Review per-strategy readiness rates and readiness transition counts.
- API endpoint:
  - `POST /api/spx0dte` with `{"action":"replay_summary","limit":300}`
  - `POST /api/spx0dte` with `{"action":"replay_walk_forward","limit":800,"windowSize":180,"stepSize":60}`

### Historical Backtest (10Y+)

- In `REVIEW`, use `Historical Backtest (Approx)` to run multi-year (2-50 years) strategy testing.
- API endpoint:
  - `POST /api/spx0dte` with `{"action":"run_historical_backtest","years":10,"sleeveCapital":10000}`
- Data source priority:
  1. Local CSV: `storage/historical/spx_daily.csv` and `storage/historical/vix_daily.csv`
  2. Fallback download from Stooq (if network is available)
- CSV format (required columns): `Date,Open,High,Low,Close`
- Terminal run (without UI):
  - `python3 scripts/backtest_10y.py <<<'{\"years\":10,\"sleeveCapital\":10000}'`
- Output:
  - Summary metrics (trades, win rate, net P/L, CAGR, max drawdown)
  - Per-strategy breakdown
  - Saved result JSON under `storage/backtests/`
- Important:
  - This is a conservative **daily-bar approximation** engine (not tick-level options replay).
  - Use it for strategy filtering and robustness checks, then validate with broker-grade options history before production sizing.

### Risk Modules

- Stale-data kill switch:
  - If market is open and data age exceeds threshold or bars are unavailable, all new entry setups are forced BLOCKED.
  - UI badge: `DATA STALE`.
- Execution realism:
  - Candidate premiums display slippage-adjusted execution values.
  - Paper submit uses adjusted premium by default.
  - Slippage is now time-bucket aware (Open/Midday/Late/Close ET multipliers).
- Regime confidence + MTF confirmation:
  - Regime classification now includes a confidence score/tier.
  - Trend regimes require multi-timeframe slope confirmation (1m/5m/15m vote alignment).
  - Regime confidence below 60% blocks entries.
- Alert policy:
  - Per-strategy cooldown and max alerts/day are persisted in local storage files.
  - Suppressed count is shown in the Alerts panel.
- Risk drawer controls:
  - `Risk & Sleeve` drawer now includes editable controls for execution model (slippage offsets/mark impact + time-bucket multipliers) and alert policy (cooldown + max alerts/day per strategy).
- Preflight:
  - `NOW` tab includes GO/NO-GO preflight status and one-click rerun.
  - API endpoint: `POST /api/spx0dte` with `{"action":"run_preflight"}`.
- Open-risk heatmap + analytics scorecard:
  - `REVIEW` tab shows open risk by bullish/bearish/neutral side plus strategy/regime expectancy summaries from local logs.

### Alert ACK

- In `Alerts (Last 5)` and `All Alerts`, click `Ack` to acknowledge an alert.
- Acknowledged alerts are suppressed until the same alert fingerprint changes materially (strategy/type/legs + reason).
- API endpoints:
  - `POST /api/spx0dte` with `{"action":"ack_alert","alert":{...}}`
  - `POST /api/spx0dte` with `{"action":"clear_alert_acks"}`

## Alert Logic

- Entry alerts:
  - Fire only on **NOT READY -> READY** transitions.
  - Cooldown is 5 minutes per strategy.
- Exit alerts:
  - Fire when an open trade transitions from `open` -> `exit_pending`.
  - Cooldown is configurable per trade (default 2 minutes).
  - Include strategy, ET/Paris times, spot, full 4-leg detail with deltas, credit/debit, P/L %, POP, and reason.
- Telegram 429 is handled via `retry_after`.

## Exit Configuration Notes

- Use **Confirm Entry** on a READY candidate to start monitoring exits.
- Condor exits are intentionally conservative:
  - profit capture target 50-70%
  - max hold around 90 minutes
  - hard time exit at 14:30 ET
  - optional 10-cent buyback near close
  - volatility/price-risk exits (range, ATR, short-strike proximity)
- Fly exits are intentionally conservative:
  - profit capture target 30-50%
  - max hold 60 minutes
  - hard time exit at 13:45 ET
  - wing-touch stop-loss exit
- Additional late-day rule avoids holding through final 30 minutes where gamma/volatility risk rises and incremental premium capture is often not worth it.

### Directional Spread Settings (Conservative Safe Ranges)

In the sidebar, directional spreads expose bounded controls:
- Trend slope threshold (0.10 to 0.50 pts/min)
- Max 15m range / EMR (0.25 to 0.50)
- Bull put short delta band (bounded sliders)
- Bear call short delta band (bounded sliders)
- Min credit/width (0.03 to 0.10)
- Min POP (0.70 to 0.90)
- Max bid/ask spread-to-mid ratio (0.08 to 0.20)

Research rationale:
- Use directional credit spreads only when intraday trend is clear and sustained.
- Keep short strikes in conservative delta bands and collect enough credit for defined risk.
- Prefer earlier exits (profit capture or time stop) to avoid late-day gamma instability.

## Testing

```bash
pytest tests/test_filters.py tests/test_exit_logic.py tests/test_telegram_formatting.py
```

React/UI helper tests:

```bash
npm test -- tests/spx0dte-ui.test.ts
```

## Troubleshooting

1. No market data / empty candidates:
   - Verify tastytrade credentials and session validity.
   - Confirm SPX market is open and same-day expiration exists.
2. VIX/IVR missing:
   - Some sessions/data feeds may not return these fields every poll. App degrades safely.
3. Telegram alerts not sending:
   - Verify `TELEGRAM_BOT_TOKEN` (or `TELEGRAM_TOKEN`) and `TELEGRAM_CHAT_ID`.
   - Ensure bot can message that chat.
   - If `LOSS_TODAY` is checked, alerts are intentionally suppressed.
4. App runs but shows NOT READY all day:
   - Check `LOSS_TODAY` and manual macro-release selections.
   - Check time gate windows (10:00-13:30 ET; Fly cutoff 13:00 ET).
5. Open trades do not appear:
   - Click **Confirm Entry** on a READY setup first.
6. Package issues:
   - Recreate venv and reinstall `requirements.txt`.

## Safety

- Live trading is not auto-routed by this dashboard.
- Paper-only routing is supported when `SPX0DTE_PAPER_TRADING=true` and safety checks pass.

## Next.js + API Audit Commands

For the current Next.js SPX platform in this repo:

```bash
make dev      # start UI + API routes locally
make test     # lint + vitest + next build + pytest
make smoke    # boots app and validates core endpoints
make stress   # concurrent endpoint load test (local)
make audit    # test -> smoke -> stress and produce docs/FINAL_AUDIT_REPORT.md
```

Environment template:

```bash
cp .env.example .env
```
