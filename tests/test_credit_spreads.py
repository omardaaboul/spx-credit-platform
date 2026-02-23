from __future__ import annotations

import datetime as dt

from data.tasty import CandleBar, OptionSnapshot
from signals.filters import classify_trend_direction, compute_trend_slope_points_per_min
from strategies.credit_spreads import find_directional_credit_spread_candidate


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


def test_trend_slope_up_classifies_up() -> None:
    base = dt.datetime(2026, 1, 2, 10, 0)
    candles = [
        CandleBar(base + dt.timedelta(minutes=i), 5000 + i, 5001 + i, 4999 + i, 5000 + i, 1000, None)
        for i in range(35)
    ]
    slope = compute_trend_slope_points_per_min(candles, lookback=30)
    assert slope is not None
    assert slope > 0.2
    assert classify_trend_direction(slope, threshold=0.2) == "UP"


def test_find_bull_put_credit_spread_candidate() -> None:
    options = [
        _option("P", 5900, 2.70, 2.80, -0.22),  # short put
        _option("P", 5850, 0.22, 0.24, -0.05),  # long put (width 50), liquid
        _option("C", 6100, 0.90, 1.00, 0.15),
    ]
    now_et = dt.datetime(2026, 1, 2, 11, 0)
    out = find_directional_credit_spread_candidate(
        options=options,
        spot=6000.0,
        emr=25.0,
        full_day_em=30.0,
        now_et=now_et,
        trend_slope_points_per_min=0.25,
        range_15m=8.0,
        widths=[25, 50],
    )
    assert out["ready"] is True
    cand = out["candidate"]
    assert cand["spread_type"] == "BULL_PUT_SPREAD"
    assert cand["width"] == 50
    assert cand["credit"] >= 2.5
    assert cand["pop_delta"] >= 0.75


def test_skip_when_trend_is_choppy() -> None:
    options = [_option("P", 5900, 2.70, 2.80, -0.22), _option("P", 5850, 0.22, 0.24, -0.05)]
    now_et = dt.datetime(2026, 1, 2, 11, 0)
    out = find_directional_credit_spread_candidate(
        options=options,
        spot=6000.0,
        emr=25.0,
        full_day_em=30.0,
        now_et=now_et,
        trend_slope_points_per_min=0.05,
        range_15m=8.0,
        widths=[50],
    )
    assert out["ready"] is False
    assert any("weak/choppy" in r.lower() for r in out["reasons"])


def test_find_bear_call_credit_spread_candidate() -> None:
    options = [
        _option("C", 6100, 2.75, 2.85, 0.22),  # short call
        _option("C", 6150, 0.22, 0.24, 0.05),  # long call (width 50), liquid
        _option("P", 5900, 0.85, 0.95, -0.15),
    ]
    now_et = dt.datetime(2026, 1, 2, 11, 0)
    out = find_directional_credit_spread_candidate(
        options=options,
        spot=6000.0,
        emr=25.0,
        full_day_em=30.0,
        now_et=now_et,
        trend_slope_points_per_min=-0.24,
        range_15m=8.0,
        widths=[25, 50],
    )
    assert out["ready"] is True
    cand = out["candidate"]
    assert cand["spread_type"] == "BEAR_CALL_SPREAD"
    assert cand["width"] == 50
    assert cand["credit"] >= 2.5
    assert cand["pop_delta"] >= 0.75


def test_custom_trend_threshold_blocks_weaker_signal() -> None:
    options = [
        _option("P", 5900, 2.70, 2.80, -0.22),
        _option("P", 5850, 0.22, 0.24, -0.05),
    ]
    now_et = dt.datetime(2026, 1, 2, 11, 0)
    out = find_directional_credit_spread_candidate(
        options=options,
        spot=6000.0,
        emr=25.0,
        full_day_em=30.0,
        now_et=now_et,
        trend_slope_points_per_min=0.26,
        range_15m=8.0,
        widths=[50],
        trend_slope_threshold=0.30,
    )
    assert out["ready"] is False
    assert any("weak/choppy" in r.lower() for r in out["reasons"])
