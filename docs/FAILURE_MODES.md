# Failure Modes

## Observed failure classes
1. Market closed / no live bars
- Symptom: candidates blocked, chart may have no real candles.
- Handling: explicit blocked reasons + no synthetic trading decisions.

2. Missing Tasty credentials / auth errors
- Symptom: snapshot source not live, stale/inactive data contract feeds.
- Handling: startup health and warnings; no live strategy triggers.

3. Telegram disabled or misconfigured
- Symptom: alerts generated in payload but no outbound message.
- Handling: `SPX0DTE_ENABLE_TELEGRAM` gate + `/api/spx0dte` `telegram_test` action.

4. External provider latency/failure
- Symptom: stale data and degraded decision quality.
- Handling: stale data kill switch and non-ready strategy states.

5. Local dev runtime lock conflicts
- Symptom: next dev lock file / port collisions.
- Handling: restart sequence and lock cleanup.

## Degrade behavior expected
- No crash
- Strategies move to blocked/not-ready
- Explicit reason surfaced in payload/UI
