# Observability

## What is instrumented
- Structured request logs with correlation IDs for:
  - `/api/spx0dte`
  - `/api/market/candles`
- Response headers:
  - `x-request-id`
  - `x-eval-duration-ms`
- Persistent evaluation snapshots:
  - `/Users/omardaaboul/options-log/storage/spx0dte_snapshot_log.jsonl`

## Debug mode
Set:
```bash
SPX0DTE_DEBUG=true
```
This enables structured JSON logs to stdout for API request lifecycle events.

## Recommended local command
```bash
SPX0DTE_DEBUG=true npm run dev
```

## Current metric coverage
- Endpoint latency: available via `x-eval-duration-ms` and debug logs
- Strategy cycle output: captured in snapshot log + API payload
- Data freshness: exposed in payload fields (`staleData`, `dataContract.feeds.*.ageMs`)

## Known gaps
- No Prometheus/OpenTelemetry exporter yet
- No global frontend telemetry sink (only API-level visibility)
- No distributed tracing across Python subprocess boundaries
