from __future__ import annotations

import datetime as dt
from zoneinfo import ZoneInfo

from alerts.telegram import format_exit_alert, format_option_legs, format_strategy_alert

ET = ZoneInfo("America/New_York")
PARIS = ZoneInfo("Europe/Paris")


def test_format_option_legs_contains_all_legs() -> None:
    legs = [
        {"action": "SELL", "type": "PUT", "strike": 4870, "delta": -0.12},
        {"action": "BUY", "type": "PUT", "strike": 4795, "delta": -0.02},
        {"action": "SELL", "type": "CALL", "strike": 4985, "delta": 0.11},
        {"action": "BUY", "type": "CALL", "strike": 5060, "delta": 0.03},
    ]
    text = format_option_legs(legs)
    assert "Sell 1 PUT 4870" in text
    assert "Buy 1 PUT 4795" in text
    assert "Sell 1 CALL 4985" in text
    assert "Buy 1 CALL 5060" in text


def test_entry_alert_includes_legs_and_reason() -> None:
    candidate = {
        "short_put": 4870,
        "long_put": 4795,
        "short_call": 4985,
        "long_call": 5060,
        "short_put_delta": -0.12,
        "long_put_delta": -0.02,
        "short_call_delta": 0.11,
        "long_call_delta": 0.03,
        "width": 75,
        "credit": 2.65,
        "max_loss_points": 72.35,
        "pop_delta": 0.87,
    }
    now = dt.datetime(2026, 2, 15, 10, 42, tzinfo=ET)
    message = format_strategy_alert(
        strategy="IRON_CONDOR",
        now_et=now,
        candidate=candidate,
        risk_score="LOW",
        vix=18.0,
        ivr=35.0,
        emr=30.0,
        atr_pct_emr=0.2,
        vwap_distance=5.0,
        range_pct_emr=0.29,
        spot=4928.35,
        reason="Entry criteria met.",
    )
    assert "SPX 0DTE IRON CONDOR READY" in message
    assert "🟢 LEGS:" in message
    assert "Sell 1 PUT 4870" in message
    assert "Buy 1 CALL 5060" in message
    assert "Reason: Entry criteria met." in message


def test_exit_alert_includes_credit_debit_and_reason() -> None:
    trade = {
        "strategy": "IRON_CONDOR",
        "entry_time_et": dt.datetime(2026, 2, 15, 10, 15, tzinfo=ET).isoformat(),
        "short_put": 4870,
        "long_put": 4795,
        "short_call": 4985,
        "long_call": 5060,
        "short_put_delta": -0.12,
        "long_put_delta": -0.02,
        "short_call_delta": 0.11,
        "long_call_delta": 0.03,
        "initial_credit": 2.65,
        "pop_delta": 0.87,
    }
    eval_data = {
        "current_debit": 1.05,
        "profit_pct": 0.60,
        "reasons": ["60% profit target reached"],
    }
    now_et = dt.datetime(2026, 2, 15, 13, 15, tzinfo=ET)
    now_paris = now_et.astimezone(PARIS)
    message = format_exit_alert(
        trade=trade,
        evaluation=eval_data,
        now_et=now_et,
        now_paris=now_paris,
        spot=4940.12,
    )
    assert "EXIT ALERT" in message
    assert "Initial Credit: 2.65" in message
    assert "Current Debit: 1.05" in message
    assert "Profit/Loss: 60%" in message
    assert "Reason: 60% profit target reached" in message


def test_bear_call_credit_spread_alerts_include_call_legs_and_subtype() -> None:
    candidate = {
        "spread_type": "BEAR_CALL_SPREAD",
        "short_right": "CALL",
        "long_right": "CALL",
        "short_strike": 5030,
        "long_strike": 5080,
        "short_delta": 0.23,
        "long_delta": 0.07,
        "width": 50,
        "credit": 2.70,
        "max_loss_points": 47.30,
        "pop_delta": 0.77,
    }
    now = dt.datetime(2026, 2, 15, 11, 5, tzinfo=ET)
    entry = format_strategy_alert(
        strategy="CREDIT_SPREAD",
        now_et=now,
        candidate=candidate,
        risk_score="LOW",
        vix=18.0,
        ivr=30.0,
        emr=24.0,
        atr_pct_emr=0.2,
        vwap_distance=4.0,
        range_pct_emr=0.25,
        spot=4978.0,
        reason="Bear call spread trend setup confirmed.",
    )
    assert "BEAR CALL SPREAD" in entry
    assert "Sell 1 CALL 5030" in entry
    assert "Buy 1 CALL 5080" in entry

    trade = {
        "strategy": "CREDIT_SPREAD",
        "spread_type": "BEAR_CALL_SPREAD",
        "entry_time_et": dt.datetime(2026, 2, 15, 10, 35, tzinfo=ET).isoformat(),
        "short_strike": 5030,
        "long_strike": 5080,
        "short_delta": 0.23,
        "long_delta": 0.07,
        "initial_credit": 2.70,
        "pop_delta": 0.77,
    }
    exit_eval = {"current_debit": 1.20, "profit_pct": 0.56, "reasons": ["Profit target hit (56%)."]}
    exit_text = format_exit_alert(
        trade=trade,
        evaluation=exit_eval,
        now_et=now,
        now_paris=now.astimezone(PARIS),
        spot=4970.5,
    )
    assert "Bear Call Spread" in exit_text
    assert "Sell 1 CALL 5030" in exit_text
    assert "Buy 1 CALL 5080" in exit_text
