from __future__ import annotations

import datetime as dt

from data.tasty import CandleBar, OptionSnapshot
from strategies.convex import find_convex_debit_spread_candidate


def _option(right: str, strike: float, bid: float, ask: float, delta: float | None) -> OptionSnapshot:
    return OptionSnapshot(
        option_symbol=f"SPX_{right}_{strike}",
        streamer_symbol=f".SPX{right}{strike}",
        right=right,
        strike=strike,
        expiration=dt.date(2026, 1, 2),
        bid=bid,
        ask=ask,
        mid=(bid + ask) / 2.0,
        delta=delta,
        gamma=None,
        theta=None,
        iv=None,
    )


def _candles_trending_up(start: dt.datetime) -> list[CandleBar]:
    candles: list[CandleBar] = []
    base = 5985.0
    for i in range(40):
        o = base + (i * 0.8)
        c = o + 0.6
        candles.append(
            CandleBar(
                timestamp=start + dt.timedelta(minutes=i),
                open=o,
                high=c + 0.3,
                low=o - 0.3,
                close=c,
                volume=1000 + i,
                vwap=o + 0.25,
            )
        )
    return candles


def test_convex_call_debit_ready_when_expansion_and_breakout_confirmed() -> None:
    now_et = dt.datetime(2026, 1, 2, 11, 45)
    candles = _candles_trending_up(now_et - dt.timedelta(minutes=39))
    spot = candles[-1].close + 2.0  # confirmed breakout above prior 30m high

    options = [
        _option("C", 6010, 1.30, 1.40, 0.42),  # long call
        _option("C", 6020, 0.31, 0.35, 0.24),  # short call (width 10)
    ]

    out = find_convex_debit_spread_candidate(
        options=options,
        spot=spot,
        emr=20.0,
        full_day_em=28.0,
        now_et=now_et,
        candles_1m=candles,
        trend_slope_points_per_min=0.35,
        widths=[10],
    )
    assert out["ready"] is True
    cand = out["candidate"]
    assert cand["spread_type"] == "CALL_DEBIT_SPREAD"
    assert cand["width"] == 10
    assert 0.50 <= cand["debit"] <= 1.50


def test_convex_requires_breakout_confirmation() -> None:
    now_et = dt.datetime(2026, 1, 2, 11, 45)
    candles = _candles_trending_up(now_et - dt.timedelta(minutes=39))
    spot = candles[-2].close  # no breakout above prior 30m high

    options = [
        _option("C", 6010, 1.30, 1.40, 0.42),
        _option("C", 6020, 0.31, 0.35, 0.24),
    ]

    out = find_convex_debit_spread_candidate(
        options=options,
        spot=spot,
        emr=20.0,
        full_day_em=28.0,
        now_et=now_et,
        candles_1m=candles,
        trend_slope_points_per_min=0.35,
        widths=[10],
    )
    assert out["ready"] is False
    assert any("breakout" in r.lower() for r in out["reasons"])

