# Debug / Fix Log

## 2026-02-22

1. Added reproducible audit harness
- Files: `Makefile`, `scripts/dev.sh`, `scripts/test.sh`, `scripts/smoke_e2e.sh`, `scripts/stress.sh`, `scripts/audit.sh`
- Reason: one-command runbook + repeatable evidence capture
- Verification: scripts execute and write docs artifacts

2. Added API request correlation + latency headers
- Files:
  - `/Users/omardaaboul/options-log/app/api/spx0dte/route.ts`
  - `/Users/omardaaboul/options-log/app/api/market/candles/route.ts`
- Reason: observability requirement (request IDs, endpoint timing, debug logs)
- Verification: lint/build pass; headers available on responses

3. Chart source hardening (prior pass)
- Removed synthetic emergency chart candles and enforced real-source-only charting.
- Added explicit “no real data” behavior when unavailable.
