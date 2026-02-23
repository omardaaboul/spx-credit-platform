from __future__ import annotations

import datetime as dt
from zoneinfo import ZoneInfo

from data.tasty import OptionSnapshot
from strategies.bwb_credit_put import (
    BwbSettings,
    evaluate_broken_wing_put_butterfly,
    monitor_bwb_position,
)


ET = ZoneInfo("America/New_York")


def _put(
    symbol: str,
    strike: float,
    *,
    delta: float,
    bid: float,
    ask: float,
    expiration: dt.date,
) -> OptionSnapshot:
    return OptionSnapshot(
        option_symbol=symbol,
        streamer_symbol=symbol,
        right="P",
        strike=float(strike),
        expiration=expiration,
        bid=float(bid),
        ask=float(ask),
        mid=(float(bid) + float(ask)) / 2.0,
        delta=float(delta),
        gamma=0.02,
        theta=-0.1,
        iv=0.2,
    )


def test_bwb_candidate_passes_strict_filters() -> None:
    now_et = dt.datetime(2026, 2, 17, 11, 0, tzinfo=ET)
    expiration = now_et.date() + dt.timedelta(days=21)
    options = [
        _put("NEAR", 5000, delta=-0.32, bid=11.0, ask=11.2, expiration=expiration),
        _put("SHORT", 4993, delta=-0.29, bid=10.0, ask=10.2, expiration=expiration),
        _put("FAR", 4979, delta=-0.18, bid=6.0, ask=6.2, expiration=expiration),
    ]

    out = evaluate_broken_wing_put_butterfly(
        spot=5015.0,
        options=options,
        expiration=expiration,
        now_et=now_et,
        iv_rank=62.0,
        has_major_event_today=False,
        major_event_labels=[],
        account_equity=160_000.0,
        open_margin_risk_dollars=2_000.0,
        settings=BwbSettings(),
    )

    assert out["ready"] is True
    rec = out["recommendation"]
    assert isinstance(rec, dict)
    assert rec["credit"] > 0
    assert rec["narrow_wing_width"] == 7
    assert rec["wide_wing_width"] == 14


def test_bwb_candidate_fails_on_low_iv_rank() -> None:
    now_et = dt.datetime(2026, 2, 17, 11, 0, tzinfo=ET)
    expiration = now_et.date() + dt.timedelta(days=21)
    options = [
        _put("NEAR", 5000, delta=-0.32, bid=11.0, ask=11.2, expiration=expiration),
        _put("SHORT", 4993, delta=-0.29, bid=10.0, ask=10.2, expiration=expiration),
        _put("FAR", 4979, delta=-0.18, bid=6.0, ask=6.2, expiration=expiration),
    ]

    out = evaluate_broken_wing_put_butterfly(
        spot=5015.0,
        options=options,
        expiration=expiration,
        now_et=now_et,
        iv_rank=24.0,
        has_major_event_today=False,
        major_event_labels=[],
        account_equity=160_000.0,
        open_margin_risk_dollars=0.0,
        settings=BwbSettings(iv_rank_threshold=50.0),
    )

    assert out["ready"] is False
    assert "< 50.0%" in out["reason"]


def test_bwb_monitor_profit_and_greek_alert() -> None:
    now_et = dt.datetime(2026, 2, 17, 12, 0, tzinfo=ET)
    expiration = now_et.date() + dt.timedelta(days=14)
    options = [
        _put("NEAR", 5000, delta=-0.42, bid=8.0, ask=8.2, expiration=expiration),
        _put("SHORT", 4993, delta=-0.65, bid=4.0, ask=4.2, expiration=expiration),
        _put("FAR", 4979, delta=-0.10, bid=0.6, ask=0.8, expiration=expiration),
    ]
    position = {
        "entry_credit": 2.60,
        "narrow_wing_width": 7.0,
        "long_put_strike": 5000.0,
        "short_put_strike": 4993.0,
        "far_long_put_strike": 4979.0,
        "near_long_symbol": "NEAR",
        "short_symbol": "SHORT",
        "far_long_symbol": "FAR",
        "expiry": expiration.isoformat(),
    }

    out = monitor_bwb_position(
        position=position,
        options=options,
        spot=5006.0,
        now_et=now_et,
        settings=BwbSettings(delta_alert_threshold=0.5),
    )

    assert out["hasPosition"] is True
    assert out["current_debit"] is not None
    assert out["should_exit"] is True
    assert "Profit target" in str(out["exit_reason"])
    assert out["greek_alert"] is True
