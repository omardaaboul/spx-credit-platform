# Smoke Results

- Base URL: http://127.0.0.1:3100
- Timestamp (UTC): 2026-02-22T13:27:11Z

## Endpoint Checks
- GET /api/spx0dte ✅
- GET /spx-0dte ✅
- GET /api/spx0dte/candidates ✅
- GET /api/spx0dte/trades ✅

## Summary
```
market_source= market-closed
candidates= 5
alerts= 0
candidates_endpoint_ok= True
trades_endpoint_ok= True
```

## Dev Log Tail
```

> options-log@0.1.0 dev
> next dev --port 3100

▲ Next.js 16.1.3 (Turbopack)
- Local:         http://localhost:3100
- Network:       http://192.168.1.19:3100
- Environments: .env

✓ Starting...
✓ Ready in 2.9s
 GET /api/spx0dte 200 in 2.7s (compile: 1763ms, render: 925ms)
 GET /api/spx0dte 200 in 7ms (compile: 1710µs, render: 5ms)
 GET /spx-0dte 200 in 1954ms (compile: 1875ms, render: 79ms)
 GET /api/spx0dte/candidates?limit=3 200 in 277ms (compile: 274ms, render: 3ms)
 GET /api/spx0dte/trades?status=OPEN&limit=3 200 in 215ms (compile: 212ms, render: 2ms)
```
