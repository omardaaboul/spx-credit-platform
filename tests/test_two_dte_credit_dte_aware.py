import datetime as dt
from zoneinfo import ZoneInfo

from data.tasty import CandleBar, OptionSnapshot
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


def _candles_down(count: int) -> list[CandleBar]:
    start = dt.datetime(2026, 2, 20, 9, 30, tzinfo=ET)
    out: list[CandleBar] = []
    px = 5050.0
    for i in range(count):
        ts = start + dt.timedelta(minutes=i)
        px -= 0.18
        out.append(
            CandleBar(
                timestamp=ts,
                open=px + 0.3,
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
    for c in candidates:
        c.update({"short_strike": 5000.0, "long_strike": 4990.0})
    best = _rank_candidates(
        candidates,
        cfg,
        selected_dte=14,
        z_edge_ok=True,
        z_edge_mode="soft",
        z_edge_penalty=0.25,
        macd_soft_mismatch=False,
        macd_soft_penalty=0.10,
    )
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


def test_soft_z_edge_penalty_affects_rank_order() -> None:
    cfg = _config_for_target(7)[1]
    candidates = [
        {"short_delta": -0.11, "credit_pct": 0.12, "net_gamma": 0.04, "short_strike": 5100.0, "long_strike": 5090.0},
        {"short_delta": -0.11, "credit_pct": 0.12, "net_gamma": 0.04, "short_strike": 5110.0, "long_strike": 5100.0},
    ]
    best_z_ok = _rank_candidates(
        [dict(candidates[0]), dict(candidates[1])],
        cfg,
        selected_dte=7,
        z_edge_ok=True,
        z_edge_mode="soft",
        z_edge_penalty=0.30,
        macd_soft_mismatch=False,
        macd_soft_penalty=0.10,
    )
    best_z_soft_fail = _rank_candidates(
        [dict(candidates[0]), dict(candidates[1])],
        cfg,
        selected_dte=7,
        z_edge_ok=False,
        z_edge_mode="soft",
        z_edge_penalty=0.30,
        macd_soft_mismatch=False,
        macd_soft_penalty=0.10,
    )
    assert best_z_ok["rank_score"] < best_z_soft_fail["rank_score"]


def test_balanced_soft_z_can_return_ready_with_soft_fail_note(monkeypatch) -> None:
    monkeypatch.setenv("STRATEGY_PRESET", "balanced")
    monkeypatch.setenv("Z_EDGE_MODE", "soft")
    monkeypatch.setenv("MACD_HARD_DTES", "2,7")

    now = dt.datetime(2026, 2, 20, 12, 0, tzinfo=ET)
    expiry = now.date() + dt.timedelta(days=14)

    candles = _candles_down(2400)
    options = [
        OptionSnapshot(
            option_symbol="SPX C 5250",
            streamer_symbol="C5250",
            right="C",
            strike=5250.0,
            expiration=expiry,
            bid=1.35,
            ask=1.45,
            mid=1.40,
            delta=0.18,
            gamma=0.02,
            theta=-0.035,
            vega=0.09,
            iv=0.19,
        ),
        OptionSnapshot(
            option_symbol="SPX C 5260",
            streamer_symbol="C5260",
            right="C",
            strike=5260.0,
            expiration=expiry,
            bid=0.18,
            ask=0.22,
            mid=0.20,
            delta=0.11,
            gamma=0.01,
            theta=-0.010,
            vega=0.05,
            iv=0.20,
        ),
        OptionSnapshot(
            option_symbol="SPX C 5000",
            streamer_symbol="C5000",
            right="C",
            strike=5000.0,
            expiration=expiry,
            bid=50.0,
            ask=50.3,
            mid=50.15,
            delta=0.50,
            gamma=0.03,
            theta=-0.05,
            vega=0.12,
            iv=0.20,
        ),
        OptionSnapshot(
            option_symbol="SPX P 5000",
            streamer_symbol="P5000",
            right="P",
            strike=5000.0,
            expiration=expiry,
            bid=48.0,
            ask=48.3,
            mid=48.15,
            delta=-0.50,
            gamma=0.03,
            theta=-0.05,
            vega=0.12,
            iv=0.20,
        ),
    ]

    out = evaluate_two_dte_credit_spread(
        spot=5000.0,
        candles_1m=candles,
        options_2dte=options,
        expiration_2dte=expiry,
        now_et=now,
        settings=TwoDteSettings(enabled=True, require_measured_move=False),
        target_dte=14,
    )
    assert out["ready"] is True
    assert out["recommendation"] is not None
    assert any("SOFT FAIL: Z-edge not met (soft)" in (row.get("detail") or "") for row in out["checklist"])
    assert float(out["recommendation"].get("soft_penalty_total", 0.0)) > 0.0


def test_blocks_when_selected_expiry_missing_from_chain_presence_list(monkeypatch) -> None:
    monkeypatch.setenv("STRATEGY_PRESET", "balanced")
    monkeypatch.setenv("Z_EDGE_MODE", "soft")
    monkeypatch.setenv("MACD_HARD_DTES", "2,7")
    now = dt.datetime(2026, 2, 20, 12, 0, tzinfo=ET)
    expiry = now.date() + dt.timedelta(days=14)
    wrong_expiry = expiry + dt.timedelta(days=1)
    candles = _candles_down(2400)

    options = [
        OptionSnapshot(
            option_symbol="SPX C 5250",
            streamer_symbol="C5250",
            right="C",
            strike=5250.0,
            expiration=expiry,
            bid=1.35,
            ask=1.45,
            mid=1.40,
            delta=0.18,
            gamma=0.02,
            theta=-0.035,
            vega=0.09,
            iv=0.19,
        ),
        OptionSnapshot(
            option_symbol="SPX C 5260",
            streamer_symbol="C5260",
            right="C",
            strike=5260.0,
            expiration=expiry,
            bid=0.18,
            ask=0.22,
            mid=0.20,
            delta=0.11,
            gamma=0.01,
            theta=-0.010,
            vega=0.05,
            iv=0.20,
        ),
    ]

    out = evaluate_two_dte_credit_spread(
        spot=5000.0,
        candles_1m=candles,
        options_2dte=options,
        expiration_2dte=expiry,
        now_et=now,
        settings=TwoDteSettings(enabled=True, require_measured_move=False),
        target_dte=14,
        chain_expirations_present=[wrong_expiry],
    )
    assert out["ready"] is False
    assert str(out["reason"]).startswith("BLOCKED: Chain missing selected expiry")
    assert any(row.get("name") == "Chain expiry presence" and row.get("status") == "fail" for row in out["checklist"])


def test_blocks_when_strike_spot_sanity_exceeded(monkeypatch) -> None:
    monkeypatch.setenv("STRATEGY_PRESET", "balanced")
    monkeypatch.setenv("Z_EDGE_MODE", "soft")
    monkeypatch.setenv("SPX0DTE_MAX_REL_STRIKE_DISTANCE", "0.08")
    monkeypatch.setenv("SPX0DTE_MAX_ABS_STRIKE_DISTANCE", "100")

    now = dt.datetime(2026, 2, 20, 12, 0, tzinfo=ET)
    expiry = now.date() + dt.timedelta(days=14)
    candles = _candles_down(2400)

    options = [
        OptionSnapshot(
            option_symbol="SPX C 5250",
            streamer_symbol="C5250",
            right="C",
            strike=5250.0,
            expiration=expiry,
            bid=1.35,
            ask=1.45,
            mid=1.40,
            delta=0.18,
            gamma=0.02,
            theta=-0.035,
            vega=0.09,
            iv=0.19,
        ),
        OptionSnapshot(
            option_symbol="SPX C 5260",
            streamer_symbol="C5260",
            right="C",
            strike=5260.0,
            expiration=expiry,
            bid=0.18,
            ask=0.22,
            mid=0.20,
            delta=0.11,
            gamma=0.01,
            theta=-0.010,
            vega=0.05,
            iv=0.20,
        ),
        OptionSnapshot(
            option_symbol="SPX C 5000",
            streamer_symbol="C5000",
            right="C",
            strike=5000.0,
            expiration=expiry,
            bid=70.0,
            ask=70.3,
            mid=70.15,
            delta=0.50,
            gamma=0.03,
            theta=-0.05,
            vega=0.12,
            iv=0.20,
        ),
        OptionSnapshot(
            option_symbol="SPX P 5000",
            streamer_symbol="P5000",
            right="P",
            strike=5000.0,
            expiration=expiry,
            bid=69.0,
            ask=69.3,
            mid=69.15,
            delta=-0.50,
            gamma=0.03,
            theta=-0.05,
            vega=0.12,
            iv=0.20,
        ),
    ]

    out = evaluate_two_dte_credit_spread(
        spot=5000.0,
        candles_1m=candles,
        options_2dte=options,
        expiration_2dte=expiry,
        now_et=now,
        settings=TwoDteSettings(enabled=True, require_measured_move=False),
        target_dte=14,
        chain_expirations_present=[expiry],
        spot_timestamp_iso=now.isoformat(),
        chain_timestamp_iso=now.isoformat(),
        greeks_timestamp_iso=now.isoformat(),
    )
    assert out["ready"] is False
    assert str(out["reason"]).startswith("BLOCKED: Strike/spot mismatch")
    assert any(row.get("name") == "Strike sanity" and row.get("status") == "fail" for row in out["checklist"])
