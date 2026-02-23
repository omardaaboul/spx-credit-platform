import datetime as dt
from zoneinfo import ZoneInfo

from data.tasty import CandleBar
from strategies.two_dte_credit import (
    MMC_STRETCH_MAP,
    Z_THRESHOLD_MAP,
    TwoDteSettings,
    _config_for_target,
    _measured_move_completion_pass,
    _rank_candidates,
    evaluate_two_dte_credit_spread,
)

ET = ZoneInfo("America/New_York")


def _candles(count: int) -> list[CandleBar]:
    start = dt.datetime(2026, 2, 20, 9, 30, tzinfo=ET)
    out: list[CandleBar] = []
    px = 5000.0
    for i in range(count):
        ts = start + dt.timedelta(minutes=i)
        px += 0.2
        out.append(
            CandleBar(
                timestamp=ts,
                open=px - 0.3,
                high=px + 0.6,
                low=px - 0.6,
                close=px,
                volume=1000.0,
                vwap=px,
            )
        )
    return out


def test_config_selection_is_nearest_target_profile() -> None:
    key, cfg = _config_for_target(46)
    assert key == "45"
    assert int(cfg["min_30m_bars"]) == 130


def test_45dte_profile_requires_130_30m_bars() -> None:
    now = dt.datetime(2026, 2, 20, 12, 0, tzinfo=ET)
    # 300 1m bars -> ~10 aggregated 30m bars, intentionally below 130 requirement.
    out = evaluate_two_dte_credit_spread(
        spot=5000.0,
        candles_1m=_candles(300),
        options_2dte=[],
        expiration_2dte=now.date() + dt.timedelta(days=45),
        now_et=now,
        settings=TwoDteSettings(enabled=True),
        target_dte=45,
    )
    assert out["ready"] is False
    assert "Insufficient 30m history" in out["reason"]
    assert any(row.get("name") == "30m data depth" and row.get("status") == "fail" for row in out["checklist"])


def test_catalyst_is_informational_only_and_not_blocking() -> None:
    now = dt.datetime(2026, 2, 20, 12, 0, tzinfo=ET)
    out = evaluate_two_dte_credit_spread(
        spot=5000.0,
        candles_1m=[],
        options_2dte=[],
        expiration_2dte=now.date() + dt.timedelta(days=7),
        now_et=now,
        settings=TwoDteSettings(enabled=True, allow_catalyst=False),
        target_dte=7,
        catalyst_blocked=True,
        catalyst_detail="CPI at 08:30 ET within catalyst window.",
    )
    assert out["ready"] is False
    assert "Blocked by catalyst filter" not in out["reason"]
    assert any(row.get("name") == "Catalyst filter" and row.get("status") == "na" for row in out["checklist"])


def test_gamma_tiebreaker_applies_for_dte_14_and_below() -> None:
    cfg = _config_for_target(14)[1]
    candidates = [
        {"short_delta": -0.16, "credit_pct": 0.15, "net_gamma": 0.08},
        {"short_delta": -0.16, "credit_pct": 0.15, "net_gamma": 0.02},
    ]
    best = _rank_candidates(candidates, cfg, selected_dte=14)
    assert best["net_gamma"] == 0.02


def test_measured_move_is_non_blocking_when_disabled() -> None:
    now = dt.datetime(2026, 2, 20, 12, 0, tzinfo=ET)
    out = evaluate_two_dte_credit_spread(
        spot=5000.0,
        candles_1m=_candles(900),
        options_2dte=[],
        expiration_2dte=now.date() + dt.timedelta(days=2),
        now_et=now,
        settings=TwoDteSettings(enabled=True, require_measured_move=False),
        target_dte=2,
    )
    row = next((r for r in out["checklist"] if r.get("name") == "Measured move near completion"), None)
    assert row is not None
    assert row.get("status") == "na"


def test_measured_move_is_enforced_when_enabled() -> None:
    now = dt.datetime(2026, 2, 20, 12, 0, tzinfo=ET)
    out = evaluate_two_dte_credit_spread(
        spot=5000.0,
        candles_1m=_candles(900),
        options_2dte=[],
        expiration_2dte=now.date() + dt.timedelta(days=2),
        now_et=now,
        settings=TwoDteSettings(enabled=True, require_measured_move=True),
        target_dte=2,
    )
    row = next((r for r in out["checklist"] if r.get("name") == "Measured move near completion"), None)
    assert row is not None
    assert row.get("status") in {"pass", "fail"}


def test_catalyst_override_enabled_still_reports_informational_row() -> None:
    now = dt.datetime(2026, 2, 20, 12, 0, tzinfo=ET)
    out = evaluate_two_dte_credit_spread(
        spot=5000.0,
        candles_1m=[],
        options_2dte=[],
        expiration_2dte=now.date() + dt.timedelta(days=7),
        now_et=now,
        settings=TwoDteSettings(enabled=True, allow_catalyst=True),
        target_dte=7,
        catalyst_blocked=True,
        catalyst_detail="FOMC event window.",
    )
    catalyst_row = next((r for r in out["checklist"] if r.get("name") == "Catalyst filter"), None)
    assert catalyst_row is not None
    assert catalyst_row.get("status") == "na"
    assert "Blocked by catalyst filter" not in out["reason"]


def test_measured_move_completion_passes_when_stretch_and_momentum_confirm() -> None:
    mmc = _measured_move_completion_pass(
        spot=100.0,
        ema20=90.0,
        em1sd=5.0,
        z_score=-2.0,
        macd_hist=-0.1,
        macd_hist_prev=-0.2,
        direction="BULL_PUT",
        dte=7,
        z_threshold_map=Z_THRESHOLD_MAP,
        mmc_stretch_map=MMC_STRETCH_MAP,
        prev_spot=99.0,
        prev_ema20=89.0,
    )
    assert mmc["pass"] is True
    assert mmc["not_still_extending"] is True


def test_measured_move_completion_fails_when_stretch_is_still_extending_for_short_dte() -> None:
    mmc = _measured_move_completion_pass(
        spot=100.0,
        ema20=90.0,
        em1sd=5.0,
        z_score=-2.0,
        macd_hist=-0.1,
        macd_hist_prev=-0.2,
        direction="BULL_PUT",
        dte=7,
        z_threshold_map=Z_THRESHOLD_MAP,
        mmc_stretch_map=MMC_STRETCH_MAP,
        prev_spot=95.0,
        prev_ema20=90.0,
    )
    assert mmc["pass"] is False
    assert mmc["not_still_extending"] is False


def test_measured_move_completion_ignores_extension_rule_for_long_dte() -> None:
    mmc = _measured_move_completion_pass(
        spot=100.0,
        ema20=90.0,
        em1sd=5.0,
        z_score=1.5,
        macd_hist=0.1,
        macd_hist_prev=0.2,
        direction="BEAR_CALL",
        dte=30,
        z_threshold_map=Z_THRESHOLD_MAP,
        mmc_stretch_map=MMC_STRETCH_MAP,
        prev_spot=95.0,
        prev_ema20=90.0,
    )
    assert mmc["pass"] is True
