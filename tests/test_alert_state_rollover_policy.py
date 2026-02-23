from __future__ import annotations

import datetime as dt
from pathlib import Path

from storage.state import (
    AlertStateStore,
    ET,
    ROLLOVER_INTRADAY_AUTO_CLOSE,
    ROLLOVER_PERSIST_UNTIL_EXIT,
)


def _entry_iso(date_value: dt.date) -> str:
    return dt.datetime.combine(date_value, dt.time(10, 0), tzinfo=ET).isoformat()


def _build_store(tmp_path: Path, *, state_date: dt.date, trades: list[dict]) -> AlertStateStore:
    path = tmp_path / "alert_state.json"
    store = AlertStateStore(path=str(path))
    store.state["date"] = state_date.isoformat()
    store.state["trades"] = trades
    store.state["next_trade_id"] = len(trades) + 1
    store._save()
    return store


def test_rollover_closes_intraday_auto_close_trade(tmp_path: Path) -> None:
    today = dt.date(2026, 2, 18)
    yesterday = today - dt.timedelta(days=1)
    store = _build_store(
        tmp_path,
        state_date=yesterday,
        trades=[
            {
                "trade_id": "T00001",
                "strategy": "IRON_CONDOR",
                "status": "open",
                "entry_time_et": _entry_iso(yesterday),
                "rolloverPolicy": ROLLOVER_INTRADAY_AUTO_CLOSE,
            }
        ],
    )

    store._roll_date_if_needed(today)
    trade = store.get_trade("T00001")
    assert trade is not None
    assert trade["status"] == "closed"
    assert trade["closed_reason"] == "day rollover auto-close"


def test_rollover_keeps_persist_until_exit_trade_open(tmp_path: Path) -> None:
    today = dt.date(2026, 2, 18)
    yesterday = today - dt.timedelta(days=1)
    store = _build_store(
        tmp_path,
        state_date=yesterday,
        trades=[
            {
                "trade_id": "T00002",
                "strategy": "2-DTE Credit Spread",
                "status": "open",
                "entry_time_et": _entry_iso(yesterday),
                "rolloverPolicy": ROLLOVER_PERSIST_UNTIL_EXIT,
            }
        ],
    )

    store._roll_date_if_needed(today)
    trade = store.get_trade("T00002")
    assert trade is not None
    assert trade["status"] == "open"
    assert trade.get("closed_reason", "") == ""


def test_rollover_missing_policy_defaults_to_intraday_auto_close(tmp_path: Path) -> None:
    today = dt.date(2026, 2, 18)
    yesterday = today - dt.timedelta(days=1)
    store = _build_store(
        tmp_path,
        state_date=yesterday,
        trades=[
            {
                "trade_id": "T00003",
                "strategy": "IRON_FLY",
                "status": "open",
                "entry_time_et": _entry_iso(yesterday),
                # Intentionally missing rolloverPolicy for backward compatibility validation.
            }
        ],
    )

    store._roll_date_if_needed(today)
    trade = store.get_trade("T00003")
    assert trade is not None
    assert trade["rolloverPolicy"] == ROLLOVER_INTRADAY_AUTO_CLOSE
    assert trade["status"] == "closed"
    assert trade["closed_reason"] == "day rollover auto-close"
