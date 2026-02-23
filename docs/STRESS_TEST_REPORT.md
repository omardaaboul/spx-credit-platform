# Stress Test Report

- Base URL: http://127.0.0.1:3100
- Users: 50
- Requests per user: 20
- Timestamp (UTC): 2026-02-22T13:27:19Z

## Results
```json
{
  "total": 1000,
  "errors": 0,
  "errorRate": 0,
  "p50": 125,
  "p95": 337,
  "p99": 504,
  "max": 524,
  "min": 0
}
```

## Verdict
- PASS: error rate <= 1%
