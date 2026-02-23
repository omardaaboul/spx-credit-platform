from __future__ import annotations

import datetime as dt
from zoneinfo import ZoneInfo

from scripts.spx0dte_snapshot import (
    _classify_regime,
    _default_execution_model_settings,
    _execution_time_bucket,
    _put_call_ratio_proxy,
    _regime_confidence,
    _slippage_value,
    _strategy_rows_convex,
    _trend_alignment_from_slopes,
)
from data.tasty import OptionSnapshot


ET = ZoneInfo("America/New_York")


def test_execution_time_bucket_boundaries() -> None:
    assert _execution_time_bucket(dt.datetime(2026, 2, 17, 10, 30, tzinfo=ET)) == "open"
    assert _execution_time_bucket(dt.datetime(2026, 2, 17, 11, 0, tzinfo=ET)) == "midday"
    assert _execution_time_bucket(dt.datetime(2026, 2, 17, 13, 45, tzinfo=ET)) == "late"
    assert _execution_time_bucket(dt.datetime(2026, 2, 17, 15, 0, tzinfo=ET)) == "close"


def test_time_bucket_slippage_multiplier_applied() -> None:
    settings = _default_execution_model_settings()
    open_now = dt.datetime(2026, 2, 17, 10, 10, tzinfo=ET)
    midday_now = dt.datetime(2026, 2, 17, 11, 30, tzinfo=ET)
    open_slip = _slippage_value(40.0, open_now, settings)
    midday_slip = _slippage_value(40.0, midday_now, settings)
    assert open_slip > midday_slip
    assert round(open_slip, 4) == round(0.15 * 1.2, 4)


def test_trend_alignment_requires_directional_vote_majority() -> None:
    aligned_up = _trend_alignment_from_slopes(
        {
            "1m_30m": 0.32,
            "5m_30m": 0.22,
            "15m_90m": 0.14,
        }
    )
    assert aligned_up["aligned"] is True
    assert aligned_up["direction"] == "UP"
    assert aligned_up["score"] >= 0.67

    mixed = _trend_alignment_from_slopes(
        {
            "1m_30m": 0.25,
            "5m_30m": -0.19,
            "15m_90m": 0.02,
        }
    )
    assert mixed["aligned"] is False
    assert mixed["direction"] in {"MIXED", "UNKNOWN"}


def test_trend_regime_blocks_when_mtf_alignment_mixed() -> None:
    trend_like_metrics = dict(
        emr=25.0,
        full_day_em=30.0,
        range_15m=8.0,
        atr_1m=4.2,
        slope_5m=0.29,
        vwap_distance=7.0,
        day_range=11.0,
        vol_expansion_flag=False,
    )
    regime, _ = _classify_regime(
        **trend_like_metrics,
        trend_alignment={"aligned": False, "direction": "MIXED", "score": 0.33},
    )
    assert regime == "UNCLASSIFIED"

    regime_up, _ = _classify_regime(
        **trend_like_metrics,
        trend_alignment={"aligned": True, "direction": "UP", "score": 0.67},
    )
    assert regime_up == "TREND_UP"


def test_regime_confidence_outputs_medium_or_higher_for_clean_trend() -> None:
    confidence = _regime_confidence(
        regime="TREND_UP",
        emr=24.0,
        full_day_em=30.0,
        range_15m=9.0,
        atr_1m=5.0,
        slope_5m=0.31,
        vwap_distance=8.0,
        day_range=12.0,
        vol_expansion_flag=False,
        trend_alignment={"score": 0.67},
    )
    assert confidence["confidence_pct"] >= 60.0
    assert confidence["tier"] in {"medium", "high"}


def test_put_call_ratio_proxy_uses_premium_weighting() -> None:
    options = [
        OptionSnapshot("P1", "P1", "P", 5000.0, dt.date(2026, 2, 17), 2.9, 3.1, 3.0, -0.2, None, None, 0.2),
        OptionSnapshot("P2", "P2", "P", 4990.0, dt.date(2026, 2, 17), 1.9, 2.1, 2.0, -0.15, None, None, 0.2),
        OptionSnapshot("C1", "C1", "C", 5010.0, dt.date(2026, 2, 17), 1.4, 1.6, 1.5, 0.2, None, None, 0.2),
        OptionSnapshot("C2", "C2", "C", 5020.0, dt.date(2026, 2, 17), 0.9, 1.1, 1.0, 0.15, None, None, 0.2),
    ]
    ratio = _put_call_ratio_proxy(options, 5005.0)
    assert ratio == 2.0


def test_put_call_ratio_proxy_fallback_to_counts_when_mid_missing() -> None:
    options = [
        OptionSnapshot("P1", "P1", "P", 5000.0, dt.date(2026, 2, 17), None, None, None, -0.2, None, None, 0.2),
        OptionSnapshot("P2", "P2", "P", 4990.0, dt.date(2026, 2, 17), None, None, None, -0.15, None, None, 0.2),
        OptionSnapshot("C1", "C1", "C", 5010.0, dt.date(2026, 2, 17), None, None, None, 0.2, None, None, 0.2),
    ]
    ratio = _put_call_ratio_proxy(options, 5005.0)
    assert ratio == 2.0


def test_convex_risk_and_rr_are_na_until_candidate_exists() -> None:
    ctx = {
        "emr": 30.0,
        "intraday": {"range_15m": 20.0},
        "vol_expansion": True,
        "vol_detail": "IV +12%",
        "trend_slope": 0.35,
        "spot": 5000.0,
        "prior_30_high": 4995.0,
        "prior_30_low": 4975.0,
        "sleeve_capital": 10_000.0,
        "open_trades": [],
    }
    rows = _strategy_rows_convex(candidate=None, ctx=ctx)
    by_name = {row["name"]: row for row in rows}
    assert by_name["Convex debit candidate exists"]["status"] == "fail"
    assert by_name["Risk between 0.5%–1.5% sleeve ($50–$150)"]["status"] == "na"
    assert by_name["Reward >= 1.5R"]["status"] == "na"
