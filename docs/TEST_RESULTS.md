# Test Results

- Timestamp (UTC): 2026-02-22T13:26:52Z

## Lint
```

> options-log@0.1.0 lint
> eslint

```

## Vitest
```

> options-log@0.1.0 test
> vitest run

[33mThe CJS build of Vite's Node API is deprecated. See https://vite.dev/guide/troubleshooting.html#vite-cjs-node-api-deprecated for more details.[39m

 RUN  v2.1.9 /Users/omardaaboul/options-log

 ✓ tests/coach-tips.test.ts (7 tests) 3ms
 ✓ tests/spx0dte-ui.test.ts (3 tests) 2ms
 ✓ tests/payoff.test.ts (6 tests) 3ms
 ✓ tests/data-contract.test.ts (4 tests) 4ms
 ✓ tests/trade-memory.test.ts (2 tests) 5ms
 ✓ tests/adaptive-polling.test.ts (5 tests) 3ms

 Test Files  6 passed (6)
      Tests  27 passed (27)
   Start at  14:26:58
   Duration  435ms (transform 191ms, setup 0ms, collect 289ms, tests 19ms, environment 1ms, prepare 458ms)

```

## Next Build
```

> options-log@0.1.0 build
> next build --webpack

▲ Next.js 16.1.3 (webpack)
- Environments: .env

  Creating an optimized production build ...
✓ Compiled successfully in 1594.1ms
  Running TypeScript ...
  Collecting page data using 7 workers ...
  Generating static pages using 7 workers (0/24) ...
  Generating static pages using 7 workers (6/24) 
  Generating static pages using 7 workers (12/24) 
  Generating static pages using 7 workers (18/24) 
✓ Generating static pages using 7 workers (24/24) in 218.1ms
  Finalizing page optimization ...
  Collecting build traces ...

Route (app)
┌ ○ /
├ ○ /_not-found
├ ○ /airport
├ ○ /airport/matrix
├ ○ /airport/people
├ ƒ /airport/people/[id]
├ ƒ /api/market/candles
├ ƒ /api/spx0dte
├ ƒ /api/spx0dte/candidates
├ ƒ /api/spx0dte/trades
├ ƒ /api/spx0dte/trades/accept
├ ƒ /api/spx0dte/trades/close
├ ƒ /api/spx0dte/trades/reject
├ ○ /cashflows
├ ○ /coach
├ ○ /coach/dashboard
├ ○ /coach/rules
├ ○ /coach/setups
├ ○ /coach/trades
├ ƒ /coach/trades/[id]
├ ○ /coach/trades/new
├ ○ /coach/weekly-review
├ ○ /dashboard
├ ○ /import
├ ○ /settings
├ ○ /spx-0dte
├ ○ /spx-0dte/alerts
├ ○ /spx-0dte/analytics
├ ○ /spx-0dte/settings
├ ○ /spx-0dte/trades
└ ○ /trades


○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand

```

## Pytest
```
.................................................                        [100%]
49 passed in 0.67s
```
