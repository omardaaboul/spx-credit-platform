from __future__ import annotations

import datetime as dt
from zoneinfo import ZoneInfo

from data.tasty import OptionSnapshot
from strategies.exit import build_option_lookup, evaluate_trade_exit

ET = ZoneInfo("America/New_York")


def _option(right: str, strike: float, bid: float, ask: float) -> OptionSnapshot:
    return OptionSnapshot(
        option_symbol=f"SPX_{right}_{strike}",
        streamer_symbol=f".SPX{right}{strike}",
        right=right,
        strike=strike,
        expiration=dt.date(2026, 1, 2),
        bid=bid,
        ask=ask,
        mid=(bid + ask) / 2.0,
        delta=None,
        gamma=None,
        theta=None,
        iv=None,
    )


def base_config() -> dict:
    return {
        "profit_threshold_condor": 0.60,
        "profit_threshold_fly": 0.40,
        "profit_threshold_credit": 0.60,
        "max_hold_condor_min": 90,
        "max_hold_fly_min": 60,
        "max_hold_credit_min": 90,
        "enable_ten_cent_bid_exit": True,
        "enable_peg_exit": True,
        "condor_distance_mult": 0.80,
        "credit_short_buffer_mult": 0.20,
        "condor_range_exit_mult": 0.60,
        "atr_spike_points": 8.0,
    }


def test_condor_profit_target_trigger() -> None:
    options = [
        _option("P", 5900, bid=0.40, ask=0.45),  # long put
        _option("P", 5950, bid=0.95, ask=1.00),  # short put
        _option("C", 6050, bid=0.95, ask=1.00),  # short call
        _option("C", 6100, bid=0.80, ask=0.85),  # long call
    ]
    lookup = build_option_lookup(options)
    trade = {
        "trade_id": "T00001",
        "strategy": "IRON_CONDOR",
        "entry_time_et": dt.datetime(2026, 1, 2, 10, 0, tzinfo=ET).isoformat(),
        "initial_credit": 2.0,
        "width": 50,
        "short_put": 5950,
        "long_put": 5900,
        "short_call": 6050,
        "long_call": 6100,
    }
    now_et = dt.datetime(2026, 1, 2, 10, 35, tzinfo=ET)
    result = evaluate_trade_exit(
        trade=trade,
        now_et=now_et,
        spot=6000,
        option_lookup=lookup,
        emr=20.0,
        intraday_stats={"day_range": 8.0, "atr_1m": 2.0},
        config=base_config(),
    )
    assert result["should_exit"] is True
    assert any("Profit target hit" in r for r in result["reasons"])


def test_condor_ten_cent_trigger() -> None:
    options = [
        _option("P", 5900, bid=0.00, ask=0.02),
        _option("P", 5950, bid=0.03, ask=0.04),
        _option("C", 6050, bid=0.03, ask=0.04),
        _option("C", 6100, bid=0.00, ask=0.02),
    ]
    lookup = build_option_lookup(options)
    trade = {
        "trade_id": "T00002",
        "strategy": "IRON_CONDOR",
        "entry_time_et": dt.datetime(2026, 1, 2, 10, 0, tzinfo=ET).isoformat(),
        "initial_credit": 1.0,
        "width": 50,
        "short_put": 5950,
        "long_put": 5900,
        "short_call": 6050,
        "long_call": 6100,
    }
    now_et = dt.datetime(2026, 1, 2, 11, 0, tzinfo=ET)
    result = evaluate_trade_exit(
        trade=trade,
        now_et=now_et,
        spot=6000,
        option_lookup=lookup,
        emr=20.0,
        intraday_stats={"day_range": 5.0, "atr_1m": 1.0},
        config=base_config(),
    )
    assert result["should_exit"] is True
    assert any("10-cent buyback" in r for r in result["reasons"])


def test_fly_time_trigger() -> None:
    options = [
        _option("P", 5980, bid=0.20, ask=0.25),  # long put
        _option("P", 6000, bid=1.50, ask=1.55),  # short put
        _option("C", 6000, bid=1.50, ask=1.55),  # short call
        _option("C", 6020, bid=0.20, ask=0.25),  # long call
    ]
    lookup = build_option_lookup(options)
    trade = {
        "trade_id": "T00003",
        "strategy": "IRON_FLY",
        "entry_time_et": dt.datetime(2026, 1, 2, 10, 0, tzinfo=ET).isoformat(),
        "initial_credit": 3.0,
        "width": 20,
        "short_strike": 6000,
        "long_put": 5980,
        "long_call": 6020,
    }
    now_et = dt.datetime(2026, 1, 2, 11, 10, tzinfo=ET)
    result = evaluate_trade_exit(
        trade=trade,
        now_et=now_et,
        spot=6001,
        option_lookup=lookup,
        emr=20.0,
        intraday_stats={"day_range": 6.0, "atr_1m": 2.0},
        config=base_config(),
    )
    assert result["should_exit"] is True
    assert any("Max hold reached" in r for r in result["reasons"])


def test_fly_wing_touch_stop_trigger() -> None:
    options = [
        _option("P", 5980, bid=0.10, ask=0.15),
        _option("P", 6000, bid=2.00, ask=2.10),
        _option("C", 6000, bid=0.30, ask=0.35),
        _option("C", 6020, bid=0.02, ask=0.04),
    ]
    lookup = build_option_lookup(options)
    trade = {
        "trade_id": "T00004",
        "strategy": "IRON_FLY",
        "entry_time_et": dt.datetime(2026, 1, 2, 10, 0, tzinfo=ET).isoformat(),
        "initial_credit": 2.0,
        "width": 20,
        "short_strike": 6000,
        "long_put": 5980,
        "long_call": 6020,
    }
    now_et = dt.datetime(2026, 1, 2, 10, 20, tzinfo=ET)
    result = evaluate_trade_exit(
        trade=trade,
        now_et=now_et,
        spot=6021,  # wing touch
        option_lookup=lookup,
        emr=20.0,
        intraday_stats={"day_range": 10.0, "atr_1m": 3.0},
        config=base_config(),
    )
    assert result["should_exit"] is True
    assert any("wing stop-loss" in r.lower() for r in result["reasons"])


def test_credit_spread_profit_target_trigger() -> None:
    options = [
        _option("P", 5950, bid=1.20, ask=1.30),  # short put to buy back
        _option("P", 5900, bid=0.10, ask=0.12),  # long put to sell
    ]
    lookup = build_option_lookup(options)
    trade = {
        "trade_id": "T00005",
        "strategy": "CREDIT_SPREAD",
        "spread_type": "BULL_PUT_SPREAD",
        "entry_time_et": dt.datetime(2026, 1, 2, 10, 0, tzinfo=ET).isoformat(),
        "initial_credit": 3.0,
        "width": 50,
        "short_right": "PUT",
        "long_right": "PUT",
        "short_strike": 5950,
        "long_strike": 5900,
    }
    now_et = dt.datetime(2026, 1, 2, 11, 0, tzinfo=ET)
    result = evaluate_trade_exit(
        trade=trade,
        now_et=now_et,
        spot=6010,
        option_lookup=lookup,
        emr=20.0,
        intraday_stats={"day_range": 6.0, "atr_1m": 1.5},
        config=base_config(),
    )
    assert result["should_exit"] is True
    assert any("Profit target hit" in r for r in result["reasons"])
