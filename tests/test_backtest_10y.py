from __future__ import annotations

import datetime as dt

import pandas as pd

from scripts.backtest_10y import _classify_regime, _compute_indicators, _simulate_portfolio


def _synthetic_history(rows: int = 900) -> pd.DataFrame:
    start = dt.date(2016, 1, 4)
    dates = [start + dt.timedelta(days=i) for i in range(rows)]
    # Keep weekdays only to mimic trading calendar.
    dates = [d for d in dates if d.weekday() < 5][:rows]
    values = []
    price = 2000.0
    for i, d in enumerate(dates):
        drift = 0.0003 if (i // 80) % 2 == 0 else -0.00015
        noise = ((i % 7) - 3) * 0.0004
        ret = drift + noise
        open_px = price
        close_px = max(1000.0, open_px * (1.0 + ret))
        high_px = max(open_px, close_px) * (1.0 + 0.004 + abs(noise))
        low_px = min(open_px, close_px) * (1.0 - 0.004 - abs(noise))
        vix = 16.0 + ((i % 30) - 15) * 0.25 + (3.0 if (i // 120) % 2 else 0.0)
        values.append(
            {
                "date": pd.Timestamp(d),
                "open": open_px,
                "high": high_px,
                "low": low_px,
                "close": close_px,
                "vix_close": max(10.0, vix),
            }
        )
        price = close_px
    return pd.DataFrame(values)


def test_regime_classifier_outputs_known_bucket() -> None:
    row = pd.Series(
        {
            "em_day": 35.0,
            "range_pct_em": 0.24,
            "atr_pct_em": 0.30,
            "slope5_pct": 0.0001,
            "vix_change_pct": 1.2,
        }
    )
    assert _classify_regime(row) == "COMPRESSION"


def test_simulate_portfolio_runs_and_returns_summary() -> None:
    raw = _synthetic_history(1100)
    data = _compute_indicators(raw)
    data["regime"] = data.apply(_classify_regime, axis=1)
    result = _simulate_portfolio(data, years=10, sleeve_capital=10_000)
    assert result["summary"]["trades"] > 0
    assert isinstance(result["byStrategy"], list)
    assert len(result["equityCurve"]) > 50
