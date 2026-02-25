from __future__ import annotations

import datetime as dt
import hashlib
import math
import os
from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Optional, Sequence

from data.tasty import CandleBar, OptionSnapshot


CONFIG_STRICT: dict[str, dict[str, Any]] = {
    "45": {
        "min_30m_bars": 130,
        "short_abs_delta_band": [0.18, 0.28],
        "target_sd_multiple": [0.9, 1.2],
        "strike_dist_vs_em": [0.80, 1.35],
        "width_rule": {"type": "em_fraction", "fraction": 0.10, "round_to": 5, "min": 15, "max": 35},
        "credit_pct_width": [0.15, 0.30],
        "z_threshold": 0.80,
        "sr_buffer_em_mult": 0.20,
        "profit_take_pct_credit": 0.50,
        "stop_mult_credit": 2.0,
        "delta_stop_abs": 0.40,
        "time_stop_remaining_dte": 21,
    },
    "30": {
        "min_30m_bars": 104,
        "short_abs_delta_band": [0.16, 0.26],
        "target_sd_multiple": [1.0, 1.35],
        "strike_dist_vs_em": [0.90, 1.50],
        "width_rule": {"type": "em_fraction", "fraction": 0.09, "round_to": 5, "min": 10, "max": 30},
        "credit_pct_width": [0.12, 0.25],
        "z_threshold": 0.90,
        "sr_buffer_em_mult": 0.25,
        "profit_take_pct_credit": 0.50,
        "stop_mult_credit": 2.0,
        "delta_stop_abs": 0.35,
        "time_stop_remaining_dte": 15,
    },
    "14": {
        "min_30m_bars": 78,
        "short_abs_delta_band": [0.12, 0.20],
        "target_sd_multiple": [1.25, 1.60],
        "strike_dist_vs_em": [1.10, 1.80],
        "width_rule": {"type": "em_fraction", "fraction": 0.08, "round_to": 5, "min": 10, "max": 25},
        "credit_pct_width": [0.10, 0.20],
        "z_threshold": 0.90,
        "sr_buffer_em_mult": 0.30,
        "profit_take_pct_credit": 0.55,
        "stop_mult_credit": 1.8,
        "delta_stop_abs": 0.32,
        "time_stop_remaining_dte": 7,
    },
    "7": {
        "min_30m_bars": 52,
        "short_abs_delta_band": [0.06, 0.12],
        "target_sd_multiple": [1.60, 2.00],
        "strike_dist_vs_em": [1.40, 2.30],
        "width_rule": {"type": "em_fraction", "fraction": 0.07, "round_to": 5, "min": 5, "max": 15},
        "credit_pct_width": [0.08, 0.15],
        "z_threshold": 0.90,
        "sr_buffer_em_mult": 0.35,
        "profit_take_pct_credit": 0.70,
        "stop_mult_credit": 1.5,
        "delta_stop_abs": 0.26,
        "time_stop_remaining_dte": 3,
    },
    "2": {
        "min_30m_bars": 26,
        "short_abs_delta_band": [0.03, 0.07],
        "target_sd_multiple": [1.80, 2.30],
        "strike_dist_vs_em": [1.60, 3.00],
        "width_rule": {"type": "fixed_prefer_small", "choices": [5, 10]},
        "credit_pct_width": [0.05, 0.12],
        "z_threshold": 0.95,
        "sr_buffer_em_mult": 0.45,
        "profit_take_pct_credit": 0.85,
        "profit_take_buyback_abs": 0.05,
        "stop_mult_credit": 1.25,
        "delta_stop_abs": 0.22,
        "time_stop_remaining_dte": 1,
    },
}

DTE_PROFILE_BALANCED: dict[int, dict[str, float]] = {
    2: {
        "delta_min": 0.04,
        "delta_max": 0.16,
        "sd_min": 0.85,
        "sd_max": 2.50,
        "dist_min_em": 0.65,
        "dist_max_em": 2.80,
        "credit_pct_min": 0.03,
        "credit_pct_max": 0.14,
        "z_threshold": 0.55,
        "sr_buffer_em_mult": 0.18,
    },
    7: {
        "delta_min": 0.08,
        "delta_max": 0.18,
        "sd_min": 0.75,
        "sd_max": 2.10,
        "dist_min_em": 0.60,
        "dist_max_em": 2.20,
        "credit_pct_min": 0.05,
        "credit_pct_max": 0.16,
        "z_threshold": 0.50,
        "sr_buffer_em_mult": 0.20,
    },
    14: {
        "delta_min": 0.12,
        "delta_max": 0.24,
        "sd_min": 0.70,
        "sd_max": 1.75,
        "dist_min_em": 0.55,
        "dist_max_em": 1.85,
        "credit_pct_min": 0.08,
        "credit_pct_max": 0.22,
        "z_threshold": 0.50,
        "sr_buffer_em_mult": 0.18,
    },
    30: {
        "delta_min": 0.16,
        "delta_max": 0.28,
        "sd_min": 0.70,
        "sd_max": 1.45,
        "dist_min_em": 0.65,
        "dist_max_em": 1.45,
        "credit_pct_min": 0.10,
        "credit_pct_max": 0.26,
        "z_threshold": 0.45,
        "sr_buffer_em_mult": 0.22,
    },
    45: {
        "delta_min": 0.18,
        "delta_max": 0.30,
        "sd_min": 0.65,
        "sd_max": 1.30,
        "dist_min_em": 0.60,
        "dist_max_em": 1.30,
        "credit_pct_min": 0.12,
        "credit_pct_max": 0.30,
        "z_threshold": 0.40,
        "sr_buffer_em_mult": 0.20,
    },
}

Z_THRESHOLD_MAP: dict[int, float] = {int(k): float(v.get("z_threshold", 0.0)) for k, v in CONFIG_STRICT.items()}

MMC_STRETCH_MAP: dict[int, float] = {
    45: 0.85,
    30: 1.00,
    14: 1.25,
    7: 1.55,
    2: 1.90,
}

Z_EDGE_PENALTY_BY_DTE: dict[int, float] = {
    2: 0.35,
    7: 0.30,
    14: 0.25,
    30: 0.20,
    45: 0.15,
}

MACD_HARD_DTES_DEFAULT: set[int] = {2, 7}
MACD_SOFT_PENALTY_DEFAULT = 0.10
THETA_EPSILON_LONG_DTE_DEFAULT = -0.01
SR_BUFFER_MULT_BY_DTE: dict[int, float] = {2: 0.5, 7: 0.75, 14: 1.0, 30: 1.0, 45: 1.0}


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return float(default)
    try:
        return float(raw.strip())
    except Exception:
        return float(default)


def _env_int_set(name: str, default: set[int]) -> set[int]:
    raw = os.getenv(name, "").strip()
    if not raw:
        return set(default)
    values: set[int] = set()
    for token in raw.split(","):
        token = token.strip()
        if not token:
            continue
        try:
            values.add(int(token))
        except Exception:
            continue
    return values or set(default)


def _build_config_for_preset(preset: str) -> dict[str, dict[str, Any]]:
    config = deepcopy(CONFIG_STRICT)
    if preset != "balanced":
        return config
    for dte, profile in DTE_PROFILE_BALANCED.items():
        key = str(int(dte))
        if key not in config:
            continue
        cfg = config[key]
        cfg["short_abs_delta_band"] = [float(profile["delta_min"]), float(profile["delta_max"])]
        cfg["target_sd_multiple"] = [float(profile["sd_min"]), float(profile["sd_max"])]
        cfg["strike_dist_vs_em"] = [float(profile["dist_min_em"]), float(profile["dist_max_em"])]
        cfg["credit_pct_width"] = [float(profile["credit_pct_min"]), float(profile["credit_pct_max"])]
        cfg["z_threshold"] = float(profile["z_threshold"])
        cfg["sr_buffer_em_mult"] = float(profile["sr_buffer_em_mult"])
    return config


def _runtime_policy() -> dict[str, Any]:
    preset = str(os.getenv("STRATEGY_PRESET", "balanced")).strip().lower()
    if preset not in {"balanced", "strict"}:
        preset = "balanced"

    z_mode_env = os.getenv("Z_EDGE_MODE")
    if z_mode_env is None or not z_mode_env.strip():
        z_edge_mode = "hard" if preset == "strict" else "soft"
    else:
        z_edge_mode = z_mode_env.strip().lower()
        if z_edge_mode not in {"soft", "hard"}:
            z_edge_mode = "soft"

    config = _build_config_for_preset(preset)
    z_threshold_map = {int(k): float(v.get("z_threshold", 0.0)) for k, v in config.items()}
    return {
        "preset": preset,
        "config": config,
        "z_edge_mode": z_edge_mode,
        "z_threshold_map": z_threshold_map,
        "z_edge_penalty_by_dte": dict(Z_EDGE_PENALTY_BY_DTE),
        "macd_hard_dtes": _env_int_set("MACD_HARD_DTES", MACD_HARD_DTES_DEFAULT),
        "macd_soft_penalty": _env_float("MACD_SOFT_PENALTY", MACD_SOFT_PENALTY_DEFAULT),
        "theta_epsilon_long_dte": _env_float("THETA_EPSILON_LONG_DTE", THETA_EPSILON_LONG_DTE_DEFAULT),
    }


@dataclass
class TwoDteSettings:
    enabled: bool = True
    width: int = 10
    short_delta_min: float = 0.10
    short_delta_max: float = 0.20
    auto_select_params: bool = True
    min_strike_distance: float = 30.0
    max_strike_distance: float = 50.0
    min_credit: float = 0.80
    max_credit: float = 1.00
    use_delta_stop: bool = True
    delta_stop: float = 0.40
    stop_multiple: float = 3.0
    profit_take_debit: float = 0.05
    require_measured_move: bool = False
    min_30m_bars: int = 10
    allow_catalyst: bool = False


def aggregate_30m(candles_1m: Sequence[CandleBar]) -> list[CandleBar]:
    if not candles_1m:
        return []
    bars: list[CandleBar] = []
    bucket: list[CandleBar] = []
    current_key: Optional[tuple[int, int, int, int, int]] = None

    for c in candles_1m:
        minute = (c.timestamp.minute // 30) * 30
        key = (c.timestamp.year, c.timestamp.month, c.timestamp.day, c.timestamp.hour, minute)
        if current_key is None:
            current_key = key
        if key != current_key and bucket:
            bars.append(_agg_bucket(bucket))
            bucket = []
            current_key = key
        bucket.append(c)
    if bucket:
        bars.append(_agg_bucket(bucket))
    return bars


def evaluate_two_dte_credit_spread(
    spot: Optional[float],
    candles_1m: Sequence[CandleBar],
    options_2dte: Sequence[OptionSnapshot],
    expiration_2dte: Optional[dt.date],
    now_et: dt.datetime,
    settings: TwoDteSettings,
    *,
    target_dte: int = 2,
    nearest_support: Optional[float] = None,
    nearest_resistance: Optional[float] = None,
    catalyst_blocked: bool = False,
    catalyst_detail: str | None = None,
    chain_expirations_present: Optional[Sequence[dt.date]] = None,
    spot_timestamp_iso: Optional[str] = None,
    chain_timestamp_iso: Optional[str] = None,
    greeks_timestamp_iso: Optional[str] = None,
) -> dict:
    policy = _runtime_policy()
    rows: list[dict] = []
    selected_dte = max(0, (expiration_2dte - now_et.date()).days) if expiration_2dte is not None else int(target_dte)
    cfg_key, cfg = _config_for_target(target_dte, policy["config"])
    bucket = int(cfg_key)
    rows.append(_pass("Target DTE profile", f"target={target_dte}, selected={selected_dte}, profile={cfg_key}-DTE"))
    rows.append(_pass("Strategy preset", f"{policy['preset']} (z-edge mode: {policy['z_edge_mode']})", required=False))

    if not settings.enabled:
        return _result(
            False,
            f"{target_dte}-DTE sleeve disabled.",
            rows,
            None,
            _metrics_payload({}, cfg_key, target_dte, selected_dte),
        )
    if spot is None:
        rows.append(_fail("Spot available", "Missing SPX spot."))
        return _result(
            False,
            "Missing spot.",
            rows,
            None,
            _metrics_payload({}, cfg_key, target_dte, selected_dte),
        )
    if expiration_2dte is None:
        rows.append(_fail("Target expiration available", f"No expiration near {target_dte}-DTE."))
        return _result(
            False,
            f"No expiration near {target_dte}-DTE.",
            rows,
            None,
            _metrics_payload({}, cfg_key, target_dte, selected_dte),
        )
    present_expiries = {
        exp for exp in (chain_expirations_present or []) if isinstance(exp, dt.date)
    }
    expiry_present_ok = not present_expiries or expiration_2dte in present_expiries
    rows.append(
        _pass("Chain expiry presence", f"Selected expiry {expiration_2dte.isoformat()} found in chain expirations.")
        if expiry_present_ok
        else _fail("Chain expiry presence", f"Selected expiry {expiration_2dte.isoformat()} missing from chain expirations.")
    )
    if not expiry_present_ok:
        return _result(
            False,
            f"BLOCKED: Chain missing selected expiry {expiration_2dte.isoformat()} for target {target_dte}",
            rows,
            None,
            _metrics_payload(
                {
                    "spot_ts": spot_timestamp_iso,
                    "chain_ts": chain_timestamp_iso,
                    "greeks_ts": greeks_timestamp_iso,
                    "chain_expirations_present": sorted(exp.isoformat() for exp in present_expiries),
                },
                cfg_key,
                target_dte,
                selected_dte,
            ),
        )

    if catalyst_blocked:
        detail = catalyst_detail or "Known catalyst window active."
        rows.append(_na("Catalyst filter", f"Informational only: {detail}"))
    else:
        rows.append(_pass("Catalyst filter", "No active catalyst block."))

    bars_30m = aggregate_30m(candles_1m)
    min_bars = int(cfg["min_30m_bars"])
    if len(bars_30m) < min_bars:
        rows.append(_fail("30m data depth", f"Need >= {min_bars} bars, got {len(bars_30m)}"))
        return _result(False, "Insufficient 30m history.", rows, None, _metrics_payload({}, cfg_key, target_dte, selected_dte))

    closes = [b.close for b in bars_30m]
    ema8 = _ema(closes, 8)
    ema20 = _ema(closes, 20)
    ema21 = _ema(closes, 21)
    macd_line, signal_line, hist = _macd_histogram(closes)
    std_lookback = min(60, max(20, len(closes)))
    basis, sigma = _std_channel(closes, lookback=std_lookback)
    if None in (ema8[-1], ema20[-1], ema21[-1], hist[-1], basis, sigma) or sigma in (None, 0):
        rows.append(_fail("Indicators ready", "EMA/MACD/StdDev not available."))
        return _result(False, "Indicator computation failed.", rows, None, _metrics_payload({}, cfg_key, target_dte, selected_dte))

    cur_close = closes[-1]
    ema8_last = float(ema8[-1])
    ema20_last = float(ema20[-1])
    ema20_prev = float(ema20[-2]) if len(ema20) > 1 else ema20_last
    prev_close = float(closes[-2]) if len(closes) > 1 else cur_close
    ema21_last = float(ema21[-1])
    ema21_slope = _slope(ema21[-6:])
    macd_hist = float(hist[-1])
    macd_hist_prev = float(hist[-2]) if len(hist) > 1 else macd_hist
    macd_signal = float(signal_line[-1]) if signal_line else 0.0
    signed_z = (cur_close - float(basis)) / float(sigma)
    measured_move, measured_ratio = _measured_move_completion(closes)

    ema_bull = ema8_last > ema21_last and ema21_slope > 0
    ema_bear = ema8_last < ema21_last and ema21_slope < 0
    macd_bull = macd_hist >= 0 or macd_line[-1] > macd_signal
    macd_bear = macd_hist <= 0 or macd_line[-1] < macd_signal
    macd_hard = bucket in policy["macd_hard_dtes"]

    if macd_hard:
        bullish = ema_bull and macd_bull
        bearish = ema_bear and macd_bear
    else:
        bullish = ema_bull
        bearish = ema_bear
    macd_soft_mismatch = (bullish and not macd_bull) or (bearish and not macd_bear)
    rows.append(
        _pass("Bullish regime", f"EMA8 {ema8_last:.2f} > EMA21 {ema21_last:.2f}, slope {ema21_slope:+.4f}", required=False)
        if bullish
        else _fail("Bullish regime", f"EMA8 {ema8_last:.2f}, EMA21 {ema21_last:.2f}, slope {ema21_slope:+.4f}", required=False)
    )
    rows.append(
        _pass("Bearish regime", f"EMA8 {ema8_last:.2f} < EMA21 {ema21_last:.2f}, slope {ema21_slope:+.4f}", required=False)
        if bearish
        else _fail("Bearish regime", f"EMA8 {ema8_last:.2f}, EMA21 {ema21_last:.2f}, slope {ema21_slope:+.4f}", required=False)
    )
    if not macd_hard:
        rows.append(
            _fail("MACD mismatch (soft)", f"MACD disagrees with EMA/slope direction; penalty={policy['macd_soft_penalty']:.2f}", required=False)
            if macd_soft_mismatch
            else _pass("MACD mismatch (soft)", "MACD agrees or no directional regime conflict.", required=False)
        )

    iv_atm = _compute_atm_iv(options_2dte, spot, selected_dte)
    if iv_atm is None or iv_atm <= 0:
        rows.append(_fail("ATM IV available", "Unable to compute ATM IV for selected expiration."))
        rows.append(
            _fail("Measured move near completion", "ATM IV/EM unavailable for measured-move stretch check.")
            if settings.require_measured_move
            else _na("Measured move near completion", "Disabled by user settings. ATM IV/EM unavailable.")
        )
        return _result(False, "ATM IV unavailable.", rows, None, _metrics_payload({
            "ema8": ema8_last,
            "ema20": ema20_last,
            "ema21": ema21_last,
            "ema21_slope": ema21_slope,
            "macd_hist": macd_hist,
            "macd_hist_prev": macd_hist_prev,
            "zscore": signed_z,
            "measured_move": measured_move,
            "measured_ratio": measured_ratio,
        }, cfg_key, target_dte, selected_dte))

    em_1sd = spot * iv_atm * math.sqrt(max(1, selected_dte) / 365.0)
    rows.append(_pass("Expected move (1 SD)", f"EM_1SD {em_1sd:.2f} pts (IV_ATM {iv_atm:.2%})"))

    sr = _derive_support_resistance(bars_30m, cur_close)
    support = nearest_support if nearest_support is not None else sr["support"]
    resistance = nearest_resistance if nearest_resistance is not None else sr["resistance"]

    direction = "NONE"
    z_threshold = float(cfg["z_threshold"])
    if bullish and not bearish:
        direction = "BULL_PUT"
    elif bearish and not bullish:
        direction = "BEAR_CALL"

    z_edge_ok = False
    if direction == "BULL_PUT":
        z_edge_ok = signed_z <= -z_threshold
    elif direction == "BEAR_CALL":
        z_edge_ok = signed_z >= z_threshold
    z_penalty = float(policy["z_edge_penalty_by_dte"].get(bucket, 0.0))

    if direction == "NONE":
        rows.append(_fail("Std-dev channel edge", f"z={signed_z:+.2f}, threshold ±{z_threshold:.2f}"))
    elif z_edge_ok:
        rows.append(_pass("Std-dev channel edge", f"z={signed_z:+.2f}, threshold ±{z_threshold:.2f}"))
    elif policy["z_edge_mode"] == "hard":
        rows.append(_fail("Std-dev channel edge", f"z={signed_z:+.2f}, threshold ±{z_threshold:.2f}"))
    else:
        rows.append(_fail("Std-dev channel edge", f"SOFT FAIL: Z-edge not met (soft): z={signed_z:+.2f}, threshold ±{z_threshold:.2f} -> penalty={z_penalty:.2f}", required=False))

    mmc_direction = direction if direction in {"BULL_PUT", "BEAR_CALL"} else ("BULL_PUT" if signed_z <= 0 else "BEAR_CALL")
    mmc = _measured_move_completion_pass(
        spot=cur_close,
        ema20=ema20_last,
        em1sd=em_1sd,
        z_score=signed_z,
        macd_hist=macd_hist,
        macd_hist_prev=macd_hist_prev,
        direction=mmc_direction,
        dte=int(cfg_key),
        z_threshold_map=policy["z_threshold_map"],
        mmc_stretch_map=MMC_STRETCH_MAP,
        prev_spot=prev_close,
        prev_ema20=ema20_prev,
    )
    mmc_detail = _format_mmc_detail(mmc)
    if direction == "NONE":
        rows.append(_na("Measured move near completion", f"Awaiting directional edge. {mmc_detail}"))
    elif settings.require_measured_move:
        rows.append(
            _pass("Measured move near completion", mmc_detail)
            if mmc["pass"]
            else _fail("Measured move near completion", mmc_detail)
        )
    else:
        rows.append(_na("Measured move near completion", f"Disabled by user settings. {mmc_detail}"))

    if direction == "NONE":
        rows.append(_fail("Direction resolved", "Neither bullish nor bearish DTE edge is active."))
        return _result(
            False,
            "No trade: directional regime + zscore edge not aligned.",
            rows,
            None,
            _metrics_payload(
                {
                    "ema8": ema8_last,
                    "ema20": ema20_last,
                    "ema21": ema21_last,
                    "ema21_slope": ema21_slope,
                    "macd_hist": macd_hist,
                    "macd_hist_prev": macd_hist_prev,
                    "zscore": signed_z,
                    "iv_atm": iv_atm,
                    "em_1sd": em_1sd,
                    "support": support,
                    "resistance": resistance,
                    "measured_move": measured_move,
                    "measured_ratio": measured_ratio,
                    "measuredMoveCompletion": mmc["stretch"],
                    "measuredMovePass": mmc["pass"],
                    "measuredMoveDetail": mmc_detail,
                },
                cfg_key,
                target_dte,
                selected_dte,
            ),
        )

    if policy["z_edge_mode"] == "hard" and not z_edge_ok:
        return _result(
            False,
            "No trade: directional regime + zscore edge not aligned.",
            rows,
            None,
            _metrics_payload(
                {
                    "ema8": ema8_last,
                    "ema20": ema20_last,
                    "ema21": ema21_last,
                    "ema21_slope": ema21_slope,
                    "macd_hist": macd_hist,
                    "macd_hist_prev": macd_hist_prev,
                    "zscore": signed_z,
                    "z_edge_ok": z_edge_ok,
                    "z_edge_mode": policy["z_edge_mode"],
                    "z_edge_penalty": 0.0,
                    "iv_atm": iv_atm,
                    "em_1sd": em_1sd,
                    "support": support,
                    "resistance": resistance,
                    "direction": direction,
                    "measured_move": measured_move,
                    "measured_ratio": measured_ratio,
                    "measuredMoveCompletion": mmc["stretch"],
                    "measuredMovePass": mmc["pass"],
                    "measuredMoveDetail": mmc_detail,
                },
                cfg_key,
                target_dte,
                selected_dte,
            ),
        )

    if settings.require_measured_move and not mmc["pass"]:
        return _result(
            False,
            "Measured-move completion not confirmed for selected DTE.",
            rows,
            None,
            _metrics_payload(
                {
                    "ema8": ema8_last,
                    "ema20": ema20_last,
                    "ema21": ema21_last,
                    "ema21_slope": ema21_slope,
                    "macd_hist": macd_hist,
                    "macd_hist_prev": macd_hist_prev,
                    "zscore": signed_z,
                    "z_edge_ok": z_edge_ok,
                    "z_edge_mode": policy["z_edge_mode"],
                    "z_edge_penalty": 0.0 if z_edge_ok else (z_penalty if policy["z_edge_mode"] == "soft" else 0.0),
                    "iv_atm": iv_atm,
                    "em_1sd": em_1sd,
                    "support": support,
                    "resistance": resistance,
                    "direction": direction,
                    "measured_move": measured_move,
                    "measured_ratio": measured_ratio,
                    "measuredMoveCompletion": mmc["stretch"],
                    "measuredMovePass": mmc["pass"],
                    "measuredMoveDetail": mmc_detail,
                },
                cfg_key,
                target_dte,
                selected_dte,
            ),
        )

    width_choices = _width_choices(cfg, em_1sd)
    rows.append(_pass("Width rule", f"choices={width_choices}"))

    theta_epsilon = 0.0 if selected_dte <= 7 else float(policy["theta_epsilon_long_dte"])
    candidates, candidate_meta = _collect_vertical_candidates(
        direction=direction,
        options=options_2dte,
        expiration=expiration_2dte,
        spot=spot,
        em_1sd=em_1sd,
        widths=width_choices,
        cfg=cfg,
        support=support,
        resistance=resistance,
        selected_dte=selected_dte,
        theta_epsilon=theta_epsilon,
    )
    rows.append(
        _pass(
            "S/R buffer scaling",
            f"base={candidate_meta['sr_buffer_base']:.2f}, scaled={candidate_meta['sr_buffer_scaled']:.2f}, factor={candidate_meta['sr_buffer_factor']:.2f}",
            required=False,
        )
    )
    rows.append(
        _pass(
            "Theta gate",
            f"selected_dte={selected_dte}, threshold net_theta >= {theta_epsilon:+.4f}",
            required=False,
        )
    )

    if not candidates:
        reject_counts = candidate_meta.get("reject_counts", {}) if isinstance(candidate_meta, dict) else {}
        ranked_rejects = sorted(
            [(str(k), int(v)) for k, v in reject_counts.items() if isinstance(v, (int, float)) and int(v) > 0],
            key=lambda row: row[1],
            reverse=True,
        )
        top_rejects = ", ".join(f"{name}={count}" for name, count in ranked_rejects[:3]) if ranked_rejects else "none"
        rows.append(
            _fail(
                "Spread candidate",
                (
                    "No spread matched delta/EM/width/credit/theta constraints. "
                    f"S/R buffer base={candidate_meta['sr_buffer_base']:.2f}, scaled={candidate_meta['sr_buffer_scaled']:.2f}. "
                    f"Top rejects: {top_rejects}."
                ),
            )
        )
        return _result(
            False,
            f"No {target_dte}-DTE spread matched strict criteria.",
            rows,
            None,
            _metrics_payload(
                {
                    "ema8": ema8_last,
                    "ema20": ema20_last,
                    "ema21": ema21_last,
                    "ema21_slope": ema21_slope,
                    "macd_hist": macd_hist,
                    "macd_hist_prev": macd_hist_prev,
                    "zscore": signed_z,
                    "z_edge_ok": z_edge_ok,
                    "z_edge_mode": policy["z_edge_mode"],
                    "z_edge_penalty": 0.0 if z_edge_ok else (z_penalty if policy["z_edge_mode"] == "soft" else 0.0),
                    "iv_atm": iv_atm,
                    "em_1sd": em_1sd,
                    "support": support,
                    "resistance": resistance,
                    "sr_buffer_base": candidate_meta["sr_buffer_base"],
                    "sr_buffer_scaled": candidate_meta["sr_buffer_scaled"],
                    "sr_buffer_factor": candidate_meta["sr_buffer_factor"],
                    "spreadRejectCounts": candidate_meta.get("reject_counts", {}),
                    "direction": direction,
                    "measured_move": measured_move,
                    "measured_ratio": measured_ratio,
                    "measuredMoveCompletion": mmc["stretch"],
                    "measuredMovePass": mmc["pass"],
                    "measuredMoveDetail": mmc_detail,
                },
                cfg_key,
                target_dte,
                selected_dte,
            ),
        )

    best = _rank_candidates(
        candidates,
        cfg,
        selected_dte,
        z_edge_ok=z_edge_ok,
        z_edge_mode=policy["z_edge_mode"],
        z_edge_penalty=z_penalty,
        macd_soft_mismatch=macd_soft_mismatch and not macd_hard,
        macd_soft_penalty=float(policy["macd_soft_penalty"]),
    )

    profit_take_pct = float(cfg["profit_take_pct_credit"])
    profit_take_debit = best["credit"] * (1.0 - profit_take_pct)
    if "profit_take_buyback_abs" in cfg:
        profit_take_debit = min(profit_take_debit, float(cfg["profit_take_buyback_abs"]))

    stop_mult = float(cfg["stop_mult_credit"])
    stop_debit = best["credit"] * stop_mult
    delta_stop = float(cfg["delta_stop_abs"])
    time_stop = int(cfg["time_stop_remaining_dte"])

    management_plan = {
        "profit_take_pct_credit": profit_take_pct,
        "profit_take_buyback_debit": round(profit_take_debit, 4),
        "stop_multiple_credit": stop_mult,
        "stop_debit": round(stop_debit, 4),
        "delta_stop_abs": delta_stop,
        "time_stop_remaining_dte": time_stop,
    }

    rows.append(_pass("Candidate selected", f"{best['type']} | Δ {best['short_delta']:+.3f} | width {best['width']}"))
    max_rel_strike_distance = _env_float("SPX0DTE_MAX_REL_STRIKE_DISTANCE", 0.08)
    max_abs_strike_distance = _env_float("SPX0DTE_MAX_ABS_STRIKE_DISTANCE", 600.0)
    short_strike = float(best["short_strike"])
    abs_distance = abs(short_strike - float(spot))
    rel_distance = abs_distance / max(float(spot), 1e-9)
    strike_sanity_ok = rel_distance <= max_rel_strike_distance and abs_distance <= max_abs_strike_distance
    rows.append(
        _pass(
            "Strike sanity",
            f"spot={spot:.2f}, short={short_strike:.2f}, rel={rel_distance:.4f}, abs={abs_distance:.2f}",
        )
        if strike_sanity_ok
        else _fail(
            "Strike sanity",
            f"spot={spot:.2f}, short={short_strike:.2f}, rel={rel_distance:.4f}, abs={abs_distance:.2f}, limits(rel<={max_rel_strike_distance:.4f}, abs<={max_abs_strike_distance:.2f})",
        )
    )
    if not strike_sanity_ok:
        return _result(
            False,
            (
                "BLOCKED: Strike/spot mismatch "
                f"(spot={spot:.2f}, short={short_strike:.2f}, rel={rel_distance:.4f}, "
                f"chain_ts={chain_timestamp_iso or 'n/a'}, spot_ts={spot_timestamp_iso or 'n/a'})"
            ),
            rows,
            None,
            _metrics_payload(
                {
                    "spot_ts": spot_timestamp_iso,
                    "chain_ts": chain_timestamp_iso,
                    "greeks_ts": greeks_timestamp_iso,
                    "strike_abs_distance": abs_distance,
                    "strike_rel_distance": rel_distance,
                },
                cfg_key,
                target_dte,
                selected_dte,
            ),
        )

    right = "P" if direction == "BULL_PUT" else "C"
    by_key = {(o.right, round(o.strike, 4), o.expiration): o for o in options_2dte}
    short_key = (right, round(float(best["short_strike"]), 4), expiration_2dte)
    long_key = (right, round(float(best["long_strike"]), 4), expiration_2dte)
    leg_presence_ok = short_key in by_key and long_key in by_key
    rows.append(
        _pass(
            "Leg presence",
            f"Both legs found in chain for expiry {expiration_2dte.isoformat()} ({right}).",
        )
        if leg_presence_ok
        else _fail(
            "Leg presence",
            f"Missing leg in chain for expiry {expiration_2dte.isoformat()} ({right}).",
        )
    )
    if not leg_presence_ok:
        return _result(
            False,
            "BLOCKED: Leg not found in chain.",
            rows,
            None,
            _metrics_payload(
                {
                    "spot_ts": spot_timestamp_iso,
                    "chain_ts": chain_timestamp_iso,
                    "greeks_ts": greeks_timestamp_iso,
                },
                cfg_key,
                target_dte,
                selected_dte,
            ),
        )

    rows.append(_pass("Credit/width band", f"{best['credit_pct']:.3f} in [{cfg['credit_pct_width'][0]:.2f}, {cfg['credit_pct_width'][1]:.2f}]"))
    rows.append(_pass("Spread net theta", f"net_theta={best['net_theta']:+.4f}, threshold={theta_epsilon:+.4f}"))
    rows.append(_pass("Spread Greeks", f"Δ {best['net_delta']:+.4f}, Γ {best['net_gamma']:+.6f}, Θ {best['net_theta']:+.4f}, ν {best['net_vega']:+.4f}"))
    if best.get("soft_penalty_total", 0.0) > 0:
        rows.append(_fail("Soft penalties", f"SOFT FAIL aggregate penalty applied: {best['soft_penalty_total']:.2f}", required=False))

    recommendation = {
        **best,
        "candidate_id": _build_candidate_id(
            target_dte=int(target_dte),
            direction=direction,
            expiry=expiration_2dte.isoformat(),
            short_strike=float(best["short_strike"]),
            long_strike=float(best["long_strike"]),
            width=int(best["width"]),
        ),
        "expiry": expiration_2dte.isoformat(),
        "target_dte": int(target_dte),
        "selected_dte": int(selected_dte),
        "iv_atm": iv_atm,
        "em_1sd": em_1sd,
        "management_plan": management_plan,
        "profit_take_debit": round(profit_take_debit, 4),
        "delta_stop": delta_stop,
        "use_delta_stop": True,
        "stop_debit": round(stop_debit, 4),
        "stop_multiple": stop_mult,
        "time_stop_remaining_dte": time_stop,
    }

    metrics = _metrics_payload(
        {
            "ema8": ema8_last,
            "ema20": ema20_last,
            "ema21": ema21_last,
            "ema21_slope": ema21_slope,
            "macd_hist": macd_hist,
            "macd_hist_prev": macd_hist_prev,
            "zscore": signed_z,
            "z_edge_ok": z_edge_ok,
            "z_edge_mode": policy["z_edge_mode"],
            "z_edge_penalty": 0.0 if z_edge_ok else (z_penalty if policy["z_edge_mode"] == "soft" else 0.0),
            "iv_atm": iv_atm,
            "em_1sd": em_1sd,
            "support": support,
            "resistance": resistance,
            "sr_buffer_base": candidate_meta["sr_buffer_base"],
            "sr_buffer_scaled": candidate_meta["sr_buffer_scaled"],
            "sr_buffer_factor": candidate_meta["sr_buffer_factor"],
            "direction": direction,
            "measured_move": measured_move,
            "measured_ratio": measured_ratio,
            "measuredMoveCompletion": mmc["stretch"],
            "measuredMovePass": mmc["pass"],
            "measuredMoveDetail": mmc_detail,
            "net_delta": best["net_delta"],
            "net_gamma": best["net_gamma"],
            "net_theta": best["net_theta"],
            "net_vega": best["net_vega"],
            "sd_multiple": best["sd_multiple"],
            "rank_score": best.get("rank_score"),
            "soft_penalty_total": best.get("soft_penalty_total"),
            "macd_soft_penalty_applied": best.get("penalty_macd", 0.0),
            "z_soft_penalty_applied": best.get("penalty_z", 0.0),
        },
        cfg_key,
        target_dte,
        selected_dte,
    )

    return _result(True, f"All {target_dte}-DTE criteria met.", rows, recommendation, metrics)


def _result(ready: bool, reason: str, checklist: list[dict], recommendation: Optional[dict], metrics: dict) -> dict:
    return {
        "ready": ready,
        "reason": reason,
        "checklist": checklist,
        "recommendation": recommendation,
        "metrics": metrics,
    }


def _metrics_payload(base: dict[str, Any], cfg_key: str, target_dte: int, selected_dte: int) -> dict:
    payload = {
        "configProfile": f"{cfg_key}-DTE",
        "targetDte": target_dte,
        "selectedDte": selected_dte,
    }
    payload.update(base)
    return payload


def _config_for_target(target_dte: int, config: Optional[dict[str, dict[str, Any]]] = None) -> tuple[str, dict[str, Any]]:
    source = config if config is not None else CONFIG_STRICT
    keys = sorted(int(k) for k in source.keys())
    nearest = min(keys, key=lambda k: abs(k - int(target_dte)))
    key = str(nearest)
    return key, source[key]


def _compute_atm_iv(options: Sequence[OptionSnapshot], spot: float, dte: int) -> Optional[float]:
    if not options:
        return None

    calls = sorted(
        [o for o in options if o.right == "C" and o.iv is not None],
        key=lambda o: abs(o.strike - spot),
    )
    puts = sorted(
        [o for o in options if o.right == "P" and o.iv is not None],
        key=lambda o: abs(o.strike - spot),
    )

    call_iv = _normalize_iv(calls[0].iv) if calls else None
    put_iv = _normalize_iv(puts[0].iv) if puts else None

    if call_iv is not None and put_iv is not None:
        return (call_iv + put_iv) / 2.0
    if call_iv is not None:
        return call_iv
    if put_iv is not None:
        return put_iv

    # Optional fallback: ATM straddle approximation.
    by_strike: dict[float, dict[str, OptionSnapshot]] = {}
    for o in options:
        if o.mid is None:
            continue
        strike_key = round(o.strike, 4)
        bucket = by_strike.setdefault(strike_key, {})
        bucket[o.right] = o

    nearest_strike = None
    nearest_abs = None
    for strike in by_strike:
        dist = abs(strike - spot)
        if nearest_abs is None or dist < nearest_abs:
            nearest_abs = dist
            nearest_strike = strike

    if nearest_strike is None:
        return None
    pair = by_strike.get(nearest_strike, {})
    call = pair.get("C")
    put = pair.get("P")
    if call is None or put is None or call.mid is None or put.mid is None:
        return None

    t = max(1, dte) / 365.0
    if t <= 0:
        return None
    straddle = float(call.mid) + float(put.mid)
    approx = straddle / (0.8 * spot * math.sqrt(t))
    if approx <= 0:
        return None
    return max(0.01, min(2.5, approx))


def _normalize_iv(iv: Optional[float]) -> Optional[float]:
    if iv is None:
        return None
    val = float(iv)
    if not math.isfinite(val) or val <= 0:
        return None
    # Accept both decimal (0.18) and percent (18.0) representations.
    if val > 3.0:
        val = val / 100.0
    return max(0.01, min(2.5, val))


def _width_choices(cfg: dict[str, Any], em_1sd: float) -> list[int]:
    rule = cfg["width_rule"]
    if rule.get("type") == "fixed_prefer_small":
        return sorted({int(v) for v in rule.get("choices", []) if int(v) > 0})

    round_to = int(rule.get("round_to", 5))
    width_min = int(rule.get("min", 5))
    width_max = int(rule.get("max", 50))
    frac = float(rule.get("fraction", 0.1))

    raw = em_1sd * frac
    base = int(round(raw / round_to) * round_to) if round_to > 0 else int(round(raw))
    base = min(width_max, max(width_min, base))
    choices = {base}
    if round_to > 0:
        choices.add(min(width_max, max(width_min, base - round_to)))
        choices.add(min(width_max, max(width_min, base + round_to)))
    return sorted(v for v in choices if v > 0)


def _derive_support_resistance(bars_30m: Sequence[CandleBar], close: float) -> dict[str, Optional[float]]:
    recent = list(bars_30m[-40:]) if bars_30m else []
    lows = sorted({float(b.low) for b in recent if b.low <= close})
    highs = sorted({float(b.high) for b in recent if b.high >= close})
    support = lows[-1] if lows else None
    resistance = highs[0] if highs else None
    return {"support": support, "resistance": resistance}


def _collect_vertical_candidates(
    *,
    direction: str,
    options: Sequence[OptionSnapshot],
    expiration: dt.date,
    spot: float,
    em_1sd: float,
    widths: Sequence[int],
    cfg: dict[str, Any],
    support: Optional[float],
    resistance: Optional[float],
    selected_dte: int,
    theta_epsilon: float,
) -> tuple[list[dict[str, Any]], dict[str, float]]:
    if direction not in {"BULL_PUT", "BEAR_CALL"}:
        return [], {"sr_buffer_base": 0.0, "sr_buffer_scaled": 0.0, "sr_buffer_factor": 1.0}

    right = "P" if direction == "BULL_PUT" else "C"
    abs_delta_min, abs_delta_max = [float(v) for v in cfg["short_abs_delta_band"]]
    dist_min_em, dist_max_em = [float(v) for v in cfg["strike_dist_vs_em"]]
    sd_min, sd_max = [float(v) for v in cfg["target_sd_multiple"]]
    credit_pct_min, credit_pct_max = [float(v) for v in cfg["credit_pct_width"]]
    sr_buffer_base = float(cfg["sr_buffer_em_mult"]) * em_1sd
    sr_buffer_factor = float(SR_BUFFER_MULT_BY_DTE.get(int(selected_dte), 1.0))
    sr_buffer = sr_buffer_base * sr_buffer_factor

    by_key = {(o.right, round(o.strike, 4), o.expiration): o for o in options}
    shorts = [o for o in options if o.expiration == expiration and o.right == right and o.mid is not None and o.delta is not None]

    reject_counts: dict[str, int] = {
        "delta_band": 0,
        "wrong_side_spot": 0,
        "sr_buffer": 0,
        "dist_vs_em": 0,
        "sd_multiple": 0,
        "long_leg_missing": 0,
        "credit_nonpositive": 0,
        "credit_pct": 0,
        "liquidity": 0,
        "greeks_missing": 0,
        "theta": 0,
        "max_loss": 0,
    }
    candidates: list[dict[str, Any]] = []
    for short in shorts:
        abs_delta = abs(float(short.delta))
        if abs_delta < abs_delta_min or abs_delta > abs_delta_max:
            reject_counts["delta_band"] += 1
            continue

        if right == "P":
            if short.strike >= spot:
                reject_counts["wrong_side_spot"] += 1
                continue
            dist = spot - short.strike
            if support is not None and not (short.strike < (support - sr_buffer)):
                reject_counts["sr_buffer"] += 1
                continue
        else:
            if short.strike <= spot:
                reject_counts["wrong_side_spot"] += 1
                continue
            dist = short.strike - spot
            if resistance is not None and not (short.strike > (resistance + sr_buffer)):
                reject_counts["sr_buffer"] += 1
                continue

        if em_1sd <= 0:
            continue
        sd_multiple = dist / em_1sd
        if not (dist_min_em * em_1sd <= dist <= dist_max_em * em_1sd):
            reject_counts["dist_vs_em"] += 1
            continue
        if not (sd_min <= sd_multiple <= sd_max):
            reject_counts["sd_multiple"] += 1
            continue

        for width in widths:
            if width <= 0:
                continue
            long_strike = short.strike - width if right == "P" else short.strike + width
            long_leg = by_key.get((right, round(long_strike, 4), expiration))
            if long_leg is None or long_leg.mid is None or long_leg.delta is None:
                reject_counts["long_leg_missing"] += 1
                continue

            credit = float(short.mid) - float(long_leg.mid)
            if credit <= 0:
                reject_counts["credit_nonpositive"] += 1
                continue
            credit_pct = credit / float(width)
            if credit_pct < credit_pct_min or credit_pct > credit_pct_max:
                reject_counts["credit_pct"] += 1
                continue

            liq = _liq_ratio(short, long_leg)
            if liq is None or liq > 0.30:
                reject_counts["liquidity"] += 1
                continue

            if any(v is None for v in (short.delta, short.gamma, short.theta, short.vega, long_leg.delta, long_leg.gamma, long_leg.theta, long_leg.vega)):
                reject_counts["greeks_missing"] += 1
                continue

            net_delta = -float(short.delta) + float(long_leg.delta)
            net_gamma = -float(short.gamma) + float(long_leg.gamma)
            net_theta = -float(short.theta) + float(long_leg.theta)
            net_vega = -float(short.vega) + float(long_leg.vega)
            if net_theta < float(theta_epsilon):
                reject_counts["theta"] += 1
                continue

            max_loss_points = float(width) - credit
            if max_loss_points <= 0:
                reject_counts["max_loss"] += 1
                continue

            candidates.append(
                {
                    "type": "Bull Put Credit Spread" if right == "P" else "Bear Call Credit Spread",
                    "right": "PUT" if right == "P" else "CALL",
                    "short_strike": float(short.strike),
                    "long_strike": float(long_leg.strike),
                    "short_symbol": short.option_symbol,
                    "long_symbol": long_leg.option_symbol,
                    "short_delta": float(short.delta),
                    "long_delta": float(long_leg.delta),
                    "short_gamma": float(short.gamma),
                    "long_gamma": float(long_leg.gamma),
                    "short_theta": float(short.theta),
                    "long_theta": float(long_leg.theta),
                    "short_vega": float(short.vega),
                    "long_vega": float(long_leg.vega),
                    "distance_points": float(dist),
                    "sd_multiple": float(sd_multiple),
                    "width": int(width),
                    "credit": float(credit),
                    "credit_pct": float(credit_pct),
                    "max_loss_points": float(max_loss_points),
                    "max_loss_dollars": float(max_loss_points) * 100.0,
                    "liquidity_ratio": float(liq),
                    "net_delta": float(net_delta),
                    "net_gamma": float(net_gamma),
                    "net_theta": float(net_theta),
                    "net_vega": float(net_vega),
                    "legs": [
                        {
                            "action": "SELL",
                            "type": "PUT" if right == "P" else "CALL",
                            "strike": float(short.strike),
                            "delta": float(short.delta),
                            "qty": 1,
                            "premium": float(short.mid),
                            "impliedVol": short.iv,
                            "symbol": short.option_symbol,
                        },
                        {
                            "action": "BUY",
                            "type": "PUT" if right == "P" else "CALL",
                            "strike": float(long_leg.strike),
                            "delta": float(long_leg.delta),
                            "qty": 1,
                            "premium": float(long_leg.mid),
                            "impliedVol": long_leg.iv,
                            "symbol": long_leg.option_symbol,
                        },
                    ],
                }
            )
    return candidates, {
        "sr_buffer_base": float(sr_buffer_base),
        "sr_buffer_scaled": float(sr_buffer),
        "sr_buffer_factor": float(sr_buffer_factor),
        "reject_counts": reject_counts,
    }


def _rank_candidates(
    candidates: list[dict[str, Any]],
    cfg: dict[str, Any],
    selected_dte: int,
    *,
    z_edge_ok: bool,
    z_edge_mode: str,
    z_edge_penalty: float,
    macd_soft_mismatch: bool,
    macd_soft_penalty: float,
) -> dict[str, Any]:
    delta_mid = (float(cfg["short_abs_delta_band"][0]) + float(cfg["short_abs_delta_band"][1])) / 2.0
    for candidate in candidates:
        delta_fit = abs(abs(float(candidate["short_delta"])) - delta_mid)
        credit_component = -float(candidate["credit_pct"])
        gamma_component = abs(float(candidate["net_gamma"])) if selected_dte <= 14 else 0.0
        base_rank_score = delta_fit + credit_component + gamma_component

        penalty_z = float(z_edge_penalty) if (z_edge_mode == "soft" and not z_edge_ok) else 0.0
        penalty_macd = float(macd_soft_penalty) if bool(macd_soft_mismatch) else 0.0
        soft_penalty_total = penalty_z + penalty_macd
        rank_score = base_rank_score + soft_penalty_total

        candidate["base_rank_score"] = float(base_rank_score)
        candidate["penalty_z"] = float(penalty_z)
        candidate["penalty_macd"] = float(penalty_macd)
        candidate["soft_penalty_total"] = float(soft_penalty_total)
        candidate["rank_score"] = float(rank_score)

    if selected_dte <= 14:
        candidates.sort(
            key=lambda c: (
                float(c.get("rank_score", 0.0)),
                abs(abs(float(c["short_delta"])) - delta_mid),
                -float(c["credit_pct"]),
                abs(float(c["net_gamma"])),
                float(c["short_strike"]),
                float(c["long_strike"]),
            )
        )
    else:
        candidates.sort(
            key=lambda c: (
                float(c.get("rank_score", 0.0)),
                abs(abs(float(c["short_delta"])) - delta_mid),
                -float(c["credit_pct"]),
                float(c["short_strike"]),
                float(c["long_strike"]),
            )
        )
    return candidates[0]


def _build_candidate_id(
    *,
    target_dte: int,
    direction: str,
    expiry: str,
    short_strike: float,
    long_strike: float,
    width: int,
) -> str:
    raw = "|".join(
        [
            str(int(target_dte)),
            str(direction).upper(),
            str(expiry),
            f"{float(short_strike):.2f}",
            f"{float(long_strike):.2f}",
            str(int(width)),
        ]
    )
    digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]
    return f"cand_{digest}"


def _liq_ratio(short: OptionSnapshot, long: OptionSnapshot) -> Optional[float]:
    ratios = []
    for opt in (short, long):
        if opt.bid is None or opt.ask is None or opt.mid in (None, 0):
            return None
        ratios.append(max(0.0, (opt.ask - opt.bid) / opt.mid))
    return max(ratios)


def _agg_bucket(bucket: Sequence[CandleBar]) -> CandleBar:
    first = bucket[0]
    last = bucket[-1]
    hi = max(b.high for b in bucket)
    lo = min(b.low for b in bucket)
    vol = sum(float(b.volume) for b in bucket)
    vwap = sum((b.vwap if b.vwap is not None else b.close) * float(b.volume) for b in bucket) / vol if vol > 0 else last.close
    return CandleBar(timestamp=last.timestamp, open=first.open, high=hi, low=lo, close=last.close, volume=vol, vwap=vwap)


def _ema(values: Sequence[float], length: int) -> list[float]:
    out: list[float] = []
    if not values:
        return out
    alpha = 2 / (length + 1)
    running = float(values[0])
    out.append(running)
    for value in values[1:]:
        running = alpha * float(value) + (1 - alpha) * running
        out.append(running)
    return out


def _macd_histogram(values: Sequence[float]) -> tuple[list[float], list[float], list[float]]:
    ema12 = _ema(values, 12)
    ema26 = _ema(values, 26)
    macd = [a - b for a, b in zip(ema12, ema26)]
    signal = _ema(macd, 9)
    hist = [m - s for m, s in zip(macd, signal)]
    return macd, signal, hist


def _std_channel(values: Sequence[float], lookback: int = 30) -> tuple[Optional[float], Optional[float]]:
    if len(values) < lookback:
        return None, None
    window = [float(v) for v in values[-lookback:]]
    mean = sum(window) / lookback
    var = sum((x - mean) ** 2 for x in window) / lookback
    return mean, math.sqrt(var)


def _slope(values: Sequence[float]) -> float:
    if len(values) < 2:
        return 0.0
    xs = list(range(len(values)))
    ys = [float(v) for v in values]
    n = float(len(values))
    sx = sum(xs)
    sy = sum(ys)
    sxy = sum(x * y for x, y in zip(xs, ys))
    sxx = sum(x * x for x in xs)
    denom = n * sxx - sx * sx
    if denom == 0:
        return 0.0
    return (n * sxy - sx * sy) / denom


def _nearest_profile_value(dte: int, mapping: dict[int, float]) -> float:
    if not mapping:
        return 0.0
    key = min(mapping.keys(), key=lambda k: abs(int(k) - int(dte)))
    return float(mapping[key])


def _measured_move_completion_pass(
    *,
    spot: float,
    ema20: float,
    em1sd: float,
    z_score: float,
    macd_hist: float,
    macd_hist_prev: float,
    direction: str,
    dte: int,
    z_threshold_map: dict[int, float],
    mmc_stretch_map: dict[int, float],
    prev_spot: float | None = None,
    prev_ema20: float | None = None,
) -> dict[str, Any]:
    if em1sd <= 0:
        return {
            "pass": False,
            "stretch": 0.0,
            "z_ok": False,
            "stretch_ok": False,
            "momentum_ok": False,
            "z_sign_ok": False,
            "not_still_extending": False,
            "z_threshold": _nearest_profile_value(dte, z_threshold_map),
            "stretch_threshold": _nearest_profile_value(dte, mmc_stretch_map),
        }

    z_threshold = _nearest_profile_value(dte, z_threshold_map)
    stretch_threshold = _nearest_profile_value(dte, mmc_stretch_map)

    stretch = abs(float(spot) - float(ema20)) / float(em1sd)
    z_ok = abs(float(z_score)) >= z_threshold
    stretch_ok = stretch >= stretch_threshold

    if direction == "BULL_PUT":
        momentum_ok = float(macd_hist) > float(macd_hist_prev)
        z_sign_ok = float(z_score) <= 0
    else:
        momentum_ok = float(macd_hist) < float(macd_hist_prev)
        z_sign_ok = float(z_score) >= 0

    not_still_extending = True
    if int(dte) <= 7 and prev_spot is not None and prev_ema20 is not None:
        stretch_now_pts = abs(float(spot) - float(ema20))
        stretch_prev_pts = abs(float(prev_spot) - float(prev_ema20))
        not_still_extending = stretch_now_pts <= stretch_prev_pts

    passed = z_ok and stretch_ok and momentum_ok and z_sign_ok and not_still_extending
    return {
        "pass": bool(passed),
        "stretch": float(stretch),
        "z_ok": bool(z_ok),
        "stretch_ok": bool(stretch_ok),
        "momentum_ok": bool(momentum_ok),
        "z_sign_ok": bool(z_sign_ok),
        "not_still_extending": bool(not_still_extending),
        "z_threshold": float(z_threshold),
        "stretch_threshold": float(stretch_threshold),
    }


def _format_mmc_detail(mmc: dict[str, Any]) -> str:
    return (
        f"stretch {float(mmc.get('stretch', 0.0)):.2f}≥{float(mmc.get('stretch_threshold', 0.0)):.2f}, "
        f"|z| gate {'ok' if bool(mmc.get('z_ok')) else 'fail'} (>= {float(mmc.get('z_threshold', 0.0)):.2f}), "
        f"momentum {'ok' if bool(mmc.get('momentum_ok')) else 'fail'}, "
        f"z-sign {'ok' if bool(mmc.get('z_sign_ok')) else 'fail'}, "
        f"deceleration {'ok' if bool(mmc.get('not_still_extending')) else 'fail'}"
    )


def _measured_move_completion(closes: Sequence[float]) -> tuple[float, float]:
    if len(closes) < 20:
        return 0.0, 0.0
    recent = [float(c) for c in closes[-20:]]
    swings = [abs(recent[i] - recent[i - 1]) for i in range(1, len(recent))]
    avg = sum(swings) / len(swings) if swings else 0.0
    last_move = abs(recent[-1] - recent[-6]) if len(recent) >= 6 else 0.0
    ratio = 0.0 if avg == 0 else min(2.0, last_move / avg)
    return last_move, ratio


def _pass(name: str, detail: str, required: bool = True) -> dict:
    return {"name": name, "status": "pass", "detail": detail, "required": required}


def _fail(name: str, detail: str, required: bool = True) -> dict:
    return {"name": name, "status": "fail", "detail": detail, "required": required}


def _na(name: str, detail: str) -> dict:
    return {"name": name, "status": "na", "detail": detail, "required": False}
