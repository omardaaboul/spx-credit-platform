from __future__ import annotations

import datetime as dt
from typing import Optional
from zoneinfo import ZoneInfo

from data.tasty import OptionSnapshot

ET = ZoneInfo("America/New_York")


def build_option_lookup(options: list[OptionSnapshot]) -> dict[tuple[str, float], OptionSnapshot]:
    lookup: dict[tuple[str, float], OptionSnapshot] = {}
    for option in options:
        lookup[(option.right.upper(), round(option.strike, 4))] = option
    return lookup


def evaluate_trade_exit(
    trade: dict,
    now_et: dt.datetime,
    spot: Optional[float],
    option_lookup: dict[tuple[str, float], OptionSnapshot],
    emr: Optional[float],
    intraday_stats: dict,
    config: dict,
) -> dict:
    now_et = _as_et(now_et)
    strategy = str(trade.get("strategy", "")).upper()
    entry_time_et = _parse_iso_et(trade.get("entry_time_et")) or now_et
    time_in_trade_min = max(0.0, (now_et - entry_time_et).total_seconds() / 60.0)
    initial_credit = _to_float(trade.get("initial_credit"))

    if strategy == "IRON_CONDOR":
        return _evaluate_condor_exit(
            trade=trade,
            now_et=now_et,
            spot=spot,
            option_lookup=option_lookup,
            emr=emr,
            intraday_stats=intraday_stats,
            config=config,
            initial_credit=initial_credit,
            time_in_trade_min=time_in_trade_min,
        )
    if strategy == "IRON_FLY":
        return _evaluate_fly_exit(
            trade=trade,
            now_et=now_et,
            spot=spot,
            option_lookup=option_lookup,
            emr=emr,
            intraday_stats=intraday_stats,
            config=config,
            initial_credit=initial_credit,
            time_in_trade_min=time_in_trade_min,
        )
    if strategy == "CREDIT_SPREAD":
        return _evaluate_credit_spread_exit(
            trade=trade,
            now_et=now_et,
            spot=spot,
            option_lookup=option_lookup,
            emr=emr,
            intraday_stats=intraday_stats,
            config=config,
            initial_credit=initial_credit,
            time_in_trade_min=time_in_trade_min,
        )

    return {
        "should_exit": False,
        "reasons": ["Unknown strategy"],
        "criteria": [_criterion("Known strategy", False, strategy or "-")],
        "current_debit": None,
        "profit_pct": None,
        "time_in_trade_min": time_in_trade_min,
        "next_exit_reason": "Unknown strategy",
        "severity": "AMBER",
    }


def _evaluate_condor_exit(
    trade: dict,
    now_et: dt.datetime,
    spot: Optional[float],
    option_lookup: dict[tuple[str, float], OptionSnapshot],
    emr: Optional[float],
    intraday_stats: dict,
    config: dict,
    initial_credit: Optional[float],
    time_in_trade_min: float,
) -> dict:
    short_put = _to_float(trade.get("short_put"))
    long_put = _to_float(trade.get("long_put"))
    short_call = _to_float(trade.get("short_call"))
    long_call = _to_float(trade.get("long_call"))
    width = _to_float(trade.get("width"))

    criteria: list[dict] = []
    reasons: list[str] = []

    current_debit = _condor_close_debit(option_lookup, short_put, long_put, short_call, long_call)
    criteria.append(
        _criterion(
            "Live debit available",
            current_debit is not None,
            f"Current debit {_fmt(current_debit)}",
        )
    )

    profit_pct = _profit_pct(initial_credit, current_debit)
    target_profit = float(config.get("profit_threshold_condor", 0.60))
    trigger_profit = profit_pct is not None and profit_pct >= target_profit
    criteria.append(
        _criterion(
            f"Profit capture >= {target_profit * 100:.0f}%",
            trigger_profit,
            f"{_fmt_pct(profit_pct)}",
        )
    )
    if trigger_profit:
        reasons.append(f"Profit target hit ({_fmt_pct(profit_pct)} >= {target_profit * 100:.0f}%).")

    max_hold_min = int(config.get("max_hold_condor_min", 90))
    trigger_max_hold = time_in_trade_min >= max_hold_min
    criteria.append(
        _criterion(
            f"Time in trade >= {max_hold_min}m",
            trigger_max_hold,
            f"{time_in_trade_min:.0f}m",
        )
    )
    if trigger_max_hold:
        reasons.append(f"Max hold reached ({time_in_trade_min:.0f}m >= {max_hold_min}m).")

    trigger_time_cutoff = now_et >= _cutoff(now_et, 14, 30)
    criteria.append(
        _criterion(
            "Reached 14:30 ET cutoff",
            trigger_time_cutoff,
            now_et.strftime("%H:%M:%S ET"),
        )
    )
    if trigger_time_cutoff:
        reasons.append("Reached 14:30 ET time-based exit.")

    trigger_final_30 = now_et >= _cutoff(now_et, 15, 30)
    criteria.append(
        _criterion(
            "Final 30-minute gamma window (>=15:30 ET)",
            trigger_final_30,
            now_et.strftime("%H:%M:%S ET"),
        )
    )
    if trigger_final_30:
        reasons.append("Entered final 30 minutes of session (gamma risk).")

    distance_mult = float(config.get("condor_distance_mult", 0.80))
    trigger_short_strike_proximity = _condor_proximity_stop(spot, short_put, short_call, width, distance_mult)
    criteria.append(
        _criterion(
            f"Spot within {distance_mult:.2f} x width of short strike",
            trigger_short_strike_proximity,
            _condor_proximity_detail(spot, short_put, short_call, width, distance_mult),
        )
    )
    if trigger_short_strike_proximity:
        reasons.append("Spot is too close to a short strike (price-risk stop).")

    enable_ten_cent = bool(config.get("enable_ten_cent_bid_exit", True))
    trigger_ten_cent = enable_ten_cent and current_debit is not None and current_debit <= 0.10
    criteria.append(
        _criterion(
            "10-cent buyback check enabled and debit <= 0.10",
            trigger_ten_cent,
            f"Debit {_fmt(current_debit)}",
        )
    )
    if trigger_ten_cent:
        reasons.append("10-cent buyback available (Henry Schwartz style close).")

    range_mult = float(config.get("condor_range_exit_mult", 0.60))
    day_range = _to_float(intraday_stats.get("day_range"))
    trigger_range = day_range is not None and emr not in (None, 0) and day_range > range_mult * emr
    criteria.append(
        _criterion(
            f"Day range > {range_mult:.2f} x EMR",
            trigger_range,
            f"{_fmt(day_range)} > {_fmt((range_mult * emr) if emr is not None else None)}",
        )
    )
    if trigger_range:
        reasons.append("Intraday realized range exceeded 60% of EMR.")

    atr_spike_points = float(config.get("atr_spike_points", 8.0))
    atr_1m = _to_float(intraday_stats.get("atr_1m"))
    trigger_atr = atr_1m is not None and atr_1m > atr_spike_points
    criteria.append(
        _criterion(
            f"ATR spike > {atr_spike_points:.1f}",
            trigger_atr,
            f"ATR {_fmt(atr_1m)}",
        )
    )
    if trigger_atr:
        reasons.append("ATR spike detected; risk mitigation exit.")

    enable_peg_exit = bool(config.get("enable_peg_exit", True))
    trigger_peg = _peg_exit_condor(
        enable_peg_exit=enable_peg_exit,
        now_et=now_et,
        spot=spot,
        short_put=short_put,
        short_call=short_call,
        profit_pct=profit_pct,
    )
    criteria.append(
        _criterion(
            "Late-day peg safeguard",
            trigger_peg,
            "Enabled" if enable_peg_exit else "Disabled",
        )
    )
    if trigger_peg:
        reasons.append("Late-day peg condition: avoid picking up pennies near close.")

    should_exit = len(reasons) > 0
    severity = _severity(should_exit, reasons, profit_pct)

    next_reason = _next_reason_condor(
        should_exit=should_exit,
        reasons=reasons,
        time_in_trade_min=time_in_trade_min,
        max_hold_min=max_hold_min,
        now_et=now_et,
        profit_pct=profit_pct,
        target_profit=target_profit,
    )

    return {
        "should_exit": should_exit,
        "reasons": reasons,
        "criteria": criteria,
        "current_debit": current_debit,
        "profit_pct": profit_pct,
        "time_in_trade_min": time_in_trade_min,
        "next_exit_reason": next_reason,
        "severity": severity,
    }


def _evaluate_fly_exit(
    trade: dict,
    now_et: dt.datetime,
    spot: Optional[float],
    option_lookup: dict[tuple[str, float], OptionSnapshot],
    emr: Optional[float],
    intraday_stats: dict,
    config: dict,
    initial_credit: Optional[float],
    time_in_trade_min: float,
) -> dict:
    short_strike = _to_float(trade.get("short_strike"))
    long_put = _to_float(trade.get("long_put"))
    long_call = _to_float(trade.get("long_call"))

    criteria: list[dict] = []
    reasons: list[str] = []

    current_debit = _fly_close_debit(option_lookup, short_strike, long_put, long_call)
    criteria.append(
        _criterion(
            "Live debit available",
            current_debit is not None,
            f"Current debit {_fmt(current_debit)}",
        )
    )

    profit_pct = _profit_pct(initial_credit, current_debit)
    target_profit = float(config.get("profit_threshold_fly", 0.40))
    trigger_profit = profit_pct is not None and profit_pct >= target_profit
    criteria.append(
        _criterion(
            f"Profit capture >= {target_profit * 100:.0f}%",
            trigger_profit,
            f"{_fmt_pct(profit_pct)}",
        )
    )
    if trigger_profit:
        reasons.append(f"Profit target hit ({_fmt_pct(profit_pct)} >= {target_profit * 100:.0f}%).")

    max_hold_min = int(config.get("max_hold_fly_min", 60))
    trigger_max_hold = time_in_trade_min >= max_hold_min
    criteria.append(
        _criterion(
            f"Time in trade >= {max_hold_min}m",
            trigger_max_hold,
            f"{time_in_trade_min:.0f}m",
        )
    )
    if trigger_max_hold:
        reasons.append(f"Max hold reached ({time_in_trade_min:.0f}m >= {max_hold_min}m).")

    trigger_time_cutoff = now_et >= _cutoff(now_et, 13, 45)
    criteria.append(
        _criterion(
            "Reached 13:45 ET cutoff",
            trigger_time_cutoff,
            now_et.strftime("%H:%M:%S ET"),
        )
    )
    if trigger_time_cutoff:
        reasons.append("Reached 13:45 ET time-based exit.")

    trigger_final_30 = now_et >= _cutoff(now_et, 15, 30)
    criteria.append(
        _criterion(
            "Final 30-minute gamma window (>=15:30 ET)",
            trigger_final_30,
            now_et.strftime("%H:%M:%S ET"),
        )
    )
    if trigger_final_30:
        reasons.append("Entered final 30 minutes of session (gamma risk).")

    trigger_wing_touch = _fly_wing_touch(spot, long_put, long_call)
    criteria.append(
        _criterion(
            "Spot touched long wing (stop-loss)",
            trigger_wing_touch,
            _fly_wing_detail(spot, long_put, long_call),
        )
    )
    if trigger_wing_touch:
        reasons.append("Underlying touched long wing stop-loss.")

    should_exit = len(reasons) > 0
    severity = _severity(should_exit, reasons, profit_pct)
    next_reason = _next_reason_fly(
        should_exit=should_exit,
        reasons=reasons,
        time_in_trade_min=time_in_trade_min,
        max_hold_min=max_hold_min,
        now_et=now_et,
        profit_pct=profit_pct,
        target_profit=target_profit,
    )

    return {
        "should_exit": should_exit,
        "reasons": reasons,
        "criteria": criteria,
        "current_debit": current_debit,
        "profit_pct": profit_pct,
        "time_in_trade_min": time_in_trade_min,
        "next_exit_reason": next_reason,
        "severity": severity,
    }


def _evaluate_credit_spread_exit(
    trade: dict,
    now_et: dt.datetime,
    spot: Optional[float],
    option_lookup: dict[tuple[str, float], OptionSnapshot],
    emr: Optional[float],
    intraday_stats: dict,
    config: dict,
    initial_credit: Optional[float],
    time_in_trade_min: float,
) -> dict:
    spread_type = str(trade.get("spread_type", "")).upper()
    short_right = str(trade.get("short_right", "")).upper()
    long_right = str(trade.get("long_right", "")).upper()
    short_strike = _to_float(trade.get("short_strike"))
    long_strike = _to_float(trade.get("long_strike"))
    width = _to_float(trade.get("width"))

    criteria: list[dict] = []
    reasons: list[str] = []

    current_debit = _credit_spread_close_debit(
        option_lookup=option_lookup,
        short_right=short_right,
        long_right=long_right,
        short_strike=short_strike,
        long_strike=long_strike,
    )
    criteria.append(
        _criterion(
            "Live debit available",
            current_debit is not None,
            f"Current debit {_fmt(current_debit)}",
        )
    )

    profit_pct = _profit_pct(initial_credit, current_debit)
    target_profit = float(config.get("profit_threshold_credit", 0.60))
    trigger_profit = profit_pct is not None and profit_pct >= target_profit
    criteria.append(
        _criterion(
            f"Profit capture >= {target_profit * 100:.0f}%",
            trigger_profit,
            f"{_fmt_pct(profit_pct)}",
        )
    )
    if trigger_profit:
        reasons.append(f"Profit target hit ({_fmt_pct(profit_pct)} >= {target_profit * 100:.0f}%).")

    max_hold_min = int(config.get("max_hold_credit_min", 90))
    trigger_max_hold = time_in_trade_min >= max_hold_min
    criteria.append(_criterion(f"Time in trade >= {max_hold_min}m", trigger_max_hold, f"{time_in_trade_min:.0f}m"))
    if trigger_max_hold:
        reasons.append(f"Max hold reached ({time_in_trade_min:.0f}m >= {max_hold_min}m).")

    trigger_cutoff_14 = now_et >= _cutoff(now_et, 14, 0)
    criteria.append(_criterion("Reached 14:00 ET cutoff", trigger_cutoff_14, now_et.strftime("%H:%M:%S ET")))
    if trigger_cutoff_14:
        reasons.append("Reached 14:00 ET time stop.")

    trigger_final_30 = now_et >= _cutoff(now_et, 15, 30)
    criteria.append(_criterion("Final 30-minute gamma window (>=15:30 ET)", trigger_final_30, now_et.strftime("%H:%M:%S ET")))
    if trigger_final_30:
        reasons.append("Entered final 30 minutes of session (gamma risk).")

    buffer_mult = float(config.get("credit_short_buffer_mult", 0.20))
    trigger_short_buffer = _credit_short_buffer_stop(
        spread_type=spread_type,
        spot=spot,
        short_strike=short_strike,
        width=width,
        buffer_mult=buffer_mult,
    )
    criteria.append(
        _criterion(
            f"Spot within {buffer_mult:.2f} x width of short strike",
            trigger_short_buffer,
            _credit_short_buffer_detail(spread_type, spot, short_strike, width, buffer_mult),
        )
    )
    if trigger_short_buffer:
        reasons.append("Spot moved too close to short strike (directional stop-loss).")

    day_range = _to_float(intraday_stats.get("day_range"))
    trigger_range = day_range is not None and emr not in (None, 0) and day_range > 0.60 * emr
    criteria.append(
        _criterion(
            "Day range > 0.60 x EMR",
            trigger_range,
            f"{_fmt(day_range)} > {_fmt((0.60 * emr) if emr is not None else None)}",
        )
    )
    if trigger_range:
        reasons.append("Intraday realized range exceeded 60% of EMR.")

    atr_spike_points = float(config.get("atr_spike_points", 8.0))
    atr_1m = _to_float(intraday_stats.get("atr_1m"))
    trigger_atr = atr_1m is not None and atr_1m > atr_spike_points
    criteria.append(_criterion(f"ATR spike > {atr_spike_points:.1f}", trigger_atr, f"ATR {_fmt(atr_1m)}"))
    if trigger_atr:
        reasons.append("ATR spike detected; risk mitigation exit.")

    should_exit = len(reasons) > 0
    severity = _severity(should_exit, reasons, profit_pct)
    next_reason = reasons[0] if reasons else f"Next likely: {target_profit * 100:.0f}% profit target ({_fmt_pct(profit_pct)} now)"

    return {
        "should_exit": should_exit,
        "reasons": reasons,
        "criteria": criteria,
        "current_debit": current_debit,
        "profit_pct": profit_pct,
        "time_in_trade_min": time_in_trade_min,
        "next_exit_reason": next_reason,
        "severity": severity,
    }


def _condor_close_debit(
    option_lookup: dict[tuple[str, float], OptionSnapshot],
    short_put: Optional[float],
    long_put: Optional[float],
    short_call: Optional[float],
    long_call: Optional[float],
) -> Optional[float]:
    if None in (short_put, long_put, short_call, long_call):
        return None

    sp = option_lookup.get(("P", round(short_put, 4)))
    lp = option_lookup.get(("P", round(long_put, 4)))
    sc = option_lookup.get(("C", round(short_call, 4)))
    lc = option_lookup.get(("C", round(long_call, 4)))
    if None in (sp, lp, sc, lc):
        return None

    put_debit = _close_vertical_debit(sp, lp)
    call_debit = _close_vertical_debit(sc, lc)
    if put_debit is None or call_debit is None:
        return None
    return max(0.0, put_debit + call_debit)


def _fly_close_debit(
    option_lookup: dict[tuple[str, float], OptionSnapshot],
    short_strike: Optional[float],
    long_put: Optional[float],
    long_call: Optional[float],
) -> Optional[float]:
    if None in (short_strike, long_put, long_call):
        return None

    sp = option_lookup.get(("P", round(short_strike, 4)))
    lp = option_lookup.get(("P", round(long_put, 4)))
    sc = option_lookup.get(("C", round(short_strike, 4)))
    lc = option_lookup.get(("C", round(long_call, 4)))
    if None in (sp, lp, sc, lc):
        return None

    put_debit = _close_vertical_debit(sp, lp)
    call_debit = _close_vertical_debit(sc, lc)
    if put_debit is None or call_debit is None:
        return None
    return max(0.0, put_debit + call_debit)


def _credit_spread_close_debit(
    option_lookup: dict[tuple[str, float], OptionSnapshot],
    short_right: str,
    long_right: str,
    short_strike: Optional[float],
    long_strike: Optional[float],
) -> Optional[float]:
    if None in (short_strike, long_strike):
        return None
    if short_right not in {"P", "PUT", "C", "CALL"} or long_right not in {"P", "PUT", "C", "CALL"}:
        return None

    s_right = "P" if short_right.startswith("P") else "C"
    l_right = "P" if long_right.startswith("P") else "C"
    short_leg = option_lookup.get((s_right, round(short_strike, 4)))
    long_leg = option_lookup.get((l_right, round(long_strike, 4)))
    if short_leg is None or long_leg is None:
        return None
    return _close_vertical_debit(short_leg, long_leg)


def _close_vertical_debit(short_leg: OptionSnapshot, long_leg: OptionSnapshot) -> Optional[float]:
    if short_leg.ask is not None and long_leg.bid is not None:
        return max(0.0, short_leg.ask - long_leg.bid)
    if short_leg.mid is not None and long_leg.mid is not None:
        return max(0.0, short_leg.mid - long_leg.mid)
    return None


def _condor_proximity_stop(
    spot: Optional[float],
    short_put: Optional[float],
    short_call: Optional[float],
    width: Optional[float],
    distance_mult: float,
) -> bool:
    if None in (spot, short_put, short_call, width):
        return False
    threshold = distance_mult * width
    distance_to_put = abs(spot - short_put)
    distance_to_call = abs(short_call - spot)
    return min(distance_to_put, distance_to_call) <= threshold


def _condor_proximity_detail(
    spot: Optional[float],
    short_put: Optional[float],
    short_call: Optional[float],
    width: Optional[float],
    distance_mult: float,
) -> str:
    if None in (spot, short_put, short_call, width):
        return "Insufficient data"
    threshold = distance_mult * width
    distance_to_put = abs(spot - short_put)
    distance_to_call = abs(short_call - spot)
    min_dist = min(distance_to_put, distance_to_call)
    return f"distance {_fmt(min_dist)} <= {_fmt(threshold)}"


def _peg_exit_condor(
    enable_peg_exit: bool,
    now_et: dt.datetime,
    spot: Optional[float],
    short_put: Optional[float],
    short_call: Optional[float],
    profit_pct: Optional[float],
) -> bool:
    if not enable_peg_exit:
        return False
    if now_et < _cutoff(now_et, 15, 0):
        return False
    if None in (spot, short_put, short_call):
        return False

    # Conservative proxy: near close, trade is safely OTM by >= 0.30%, and already profitable.
    min_dist = min(abs(spot - short_put), abs(short_call - spot))
    otm_pct = min_dist / spot if spot else 0.0
    return otm_pct >= 0.003 and (profit_pct is not None and profit_pct > 0)


def _fly_wing_touch(spot: Optional[float], long_put: Optional[float], long_call: Optional[float]) -> bool:
    if None in (spot, long_put, long_call):
        return False
    return spot <= long_put or spot >= long_call


def _fly_wing_detail(spot: Optional[float], long_put: Optional[float], long_call: Optional[float]) -> str:
    if None in (spot, long_put, long_call):
        return "Insufficient data"
    return f"spot {_fmt(spot)} vs wings {_fmt(long_put)} / {_fmt(long_call)}"


def _credit_short_buffer_stop(
    spread_type: str,
    spot: Optional[float],
    short_strike: Optional[float],
    width: Optional[float],
    buffer_mult: float,
) -> bool:
    if None in (spot, short_strike, width):
        return False
    buffer_points = width * buffer_mult
    if spread_type == "BULL_PUT_SPREAD":
        return spot <= (short_strike + buffer_points)
    if spread_type == "BEAR_CALL_SPREAD":
        return spot >= (short_strike - buffer_points)
    return False


def _credit_short_buffer_detail(
    spread_type: str,
    spot: Optional[float],
    short_strike: Optional[float],
    width: Optional[float],
    buffer_mult: float,
) -> str:
    if None in (spot, short_strike, width):
        return "Insufficient data"
    buffer_points = width * buffer_mult
    if spread_type == "BULL_PUT_SPREAD":
        threshold = short_strike + buffer_points
        return f"spot {_fmt(spot)} <= {_fmt(threshold)}"
    if spread_type == "BEAR_CALL_SPREAD":
        threshold = short_strike - buffer_points
        return f"spot {_fmt(spot)} >= {_fmt(threshold)}"
    return "Unknown spread type"


def _profit_pct(initial_credit: Optional[float], current_debit: Optional[float]) -> Optional[float]:
    if initial_credit in (None, 0) or current_debit is None:
        return None
    return (initial_credit - current_debit) / initial_credit


def _next_reason_condor(
    should_exit: bool,
    reasons: list[str],
    time_in_trade_min: float,
    max_hold_min: int,
    now_et: dt.datetime,
    profit_pct: Optional[float],
    target_profit: float,
) -> str:
    if should_exit and reasons:
        return reasons[0]

    hold_left = max(0, int(max_hold_min - time_in_trade_min))
    until_cutoff = max(0, int((_cutoff(now_et, 14, 30) - now_et).total_seconds() / 60.0))
    if profit_pct is None:
        return f"Waiting for live debit quote (time left {hold_left}m, cutoff {until_cutoff}m)"
    return f"Next likely: {target_profit * 100:.0f}% profit target ({_fmt_pct(profit_pct)} now)"


def _next_reason_fly(
    should_exit: bool,
    reasons: list[str],
    time_in_trade_min: float,
    max_hold_min: int,
    now_et: dt.datetime,
    profit_pct: Optional[float],
    target_profit: float,
) -> str:
    if should_exit and reasons:
        return reasons[0]

    hold_left = max(0, int(max_hold_min - time_in_trade_min))
    until_cutoff = max(0, int((_cutoff(now_et, 13, 45) - now_et).total_seconds() / 60.0))
    if profit_pct is None:
        return f"Waiting for live debit quote (time left {hold_left}m, cutoff {until_cutoff}m)"
    return f"Next likely: {target_profit * 100:.0f}% profit target ({_fmt_pct(profit_pct)} now)"


def _severity(should_exit: bool, reasons: list[str], profit_pct: Optional[float]) -> str:
    if should_exit:
        stop_words = ("stop", "wing", "gamma", "range", "atr")
        if any(any(word in reason.lower() for word in stop_words) for reason in reasons):
            return "RED"
        return "AMBER"
    if profit_pct is not None and profit_pct >= 0:
        return "GREEN"
    return "AMBER"


def _criterion(name: str, passed: bool, detail: str) -> dict:
    return {"name": name, "passed": passed, "detail": detail}


def _parse_iso_et(value: object) -> Optional[dt.datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value)
    except ValueError:
        return None
    return _as_et(parsed)


def _as_et(value: dt.datetime) -> dt.datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=ET)
    return value.astimezone(ET)


def _cutoff(now_et: dt.datetime, hour: int, minute: int) -> dt.datetime:
    return now_et.replace(hour=hour, minute=minute, second=0, microsecond=0)


def _to_float(value: object) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _fmt(value: Optional[float]) -> str:
    if value is None:
        return "-"
    return f"{value:.2f}"


def _fmt_pct(value: Optional[float]) -> str:
    if value is None:
        return "-"
    return f"{value * 100.0:.1f}%"
