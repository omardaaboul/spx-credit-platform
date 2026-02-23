from __future__ import annotations

import datetime as dt
from typing import Optional, Sequence

from data.tasty import CandleBar, OptionSnapshot


def find_convex_debit_spread_candidate(
    options: Sequence[OptionSnapshot],
    spot: Optional[float],
    emr: Optional[float],
    full_day_em: Optional[float],
    now_et: dt.datetime,
    candles_1m: Sequence[CandleBar],
    trend_slope_points_per_min: Optional[float],
    widths: Sequence[int] = (10, 15, 20),
    slope_threshold: float = 0.30,
    expansion_ratio_15m: float = 0.45,
    expansion_ratio_day: float = 0.60,
    min_debit: float = 0.50,
    max_debit: float = 1.50,
    min_reward_to_risk: float = 1.50,
    max_liquidity_ratio: float = 0.15,
) -> dict:
    reasons: list[str] = []
    criteria: list[dict] = []

    if spot is None:
        criteria.append(_criterion("SPX spot available", False, "Missing spot"))
        return _not_ready(["Missing SPX spot."], criteria)
    criteria.append(_criterion("SPX spot available", True, f"Spot {spot:.2f}"))

    if emr in (None, 0):
        criteria.append(_criterion("EMR available", False, "Missing EMR"))
        return _not_ready(["Missing EMR."], criteria)
    criteria.append(_criterion("EMR available", True, f"EMR {emr:.2f}"))

    if not widths:
        criteria.append(_criterion("Debit spread widths selected", False, "No widths selected"))
        return _not_ready(["No debit spread widths selected."], criteria)
    criteria.append(_criterion("Debit spread widths selected", True, f"Widths {list(widths)}"))

    start = now_et.replace(hour=10, minute=0, second=0, microsecond=0)
    end = now_et.replace(hour=15, minute=0, second=0, microsecond=0)
    pass_time = start <= now_et <= end
    criteria.append(_criterion("Entry time 10:00-15:00 ET", pass_time, now_et.strftime("%H:%M:%S ET")))
    if not pass_time:
        reasons.append("Convex debit spread only allowed 10:00-15:00 ET.")

    if trend_slope_points_per_min is None:
        criteria.append(_criterion("Trend slope available", False, "Insufficient candles"))
        reasons.append("Trend slope unavailable.")
        return _not_ready(reasons, criteria)

    pass_trend_strength = abs(trend_slope_points_per_min) >= slope_threshold
    criteria.append(
        _criterion(
            f"Trend strength |slope| >= {slope_threshold:.2f} pts/min",
            pass_trend_strength,
            f"Slope {trend_slope_points_per_min:+.3f}",
        )
    )
    if not pass_trend_strength:
        reasons.append("Trend slope below convex trigger threshold.")

    if len(candles_1m) < 31:
        criteria.append(_criterion("30m breakout context available", False, "Need >= 31 one-minute candles"))
        reasons.append("Insufficient candles for 30m breakout check.")
        return _not_ready(reasons, criteria)

    window_15 = list(candles_1m)[-15:]
    range_15m = max(c.high for c in window_15) - min(c.low for c in window_15)
    day_range = max(c.high for c in candles_1m) - min(c.low for c in candles_1m)
    expansion_from_15 = range_15m > expansion_ratio_15m * emr
    expansion_from_day = (
        full_day_em is not None
        and full_day_em > 0
        and day_range > expansion_ratio_day * full_day_em
    )
    pass_expansion = expansion_from_15 or expansion_from_day
    criteria.append(
        _criterion(
            "Expansion regime confirmed",
            pass_expansion,
            f"15m {range_15m:.2f}/{(expansion_ratio_15m * emr):.2f}, Day {day_range:.2f}",
        )
    )
    if not pass_expansion:
        reasons.append("No expansion regime trigger for convex debit spread.")

    prior_30 = list(candles_1m)[-31:-1]
    prior_30_high = max(c.high for c in prior_30)
    prior_30_low = min(c.low for c in prior_30)

    direction: Optional[str]
    if trend_slope_points_per_min >= slope_threshold:
        direction = "UP"
    elif trend_slope_points_per_min <= -slope_threshold:
        direction = "DOWN"
    else:
        direction = None

    if direction == "UP":
        pass_breakout = spot > prior_30_high
        breakout_detail = f"{spot:.2f} > prior30H {prior_30_high:.2f}"
    elif direction == "DOWN":
        pass_breakout = spot < prior_30_low
        breakout_detail = f"{spot:.2f} < prior30L {prior_30_low:.2f}"
    else:
        pass_breakout = False
        breakout_detail = "Direction unresolved"

    criteria.append(_criterion("30m breakout confirmation", pass_breakout, breakout_detail))
    if not pass_breakout:
        reasons.append("Breakout not confirmed against prior 30m range.")

    if reasons:
        return _not_ready(reasons, criteria)

    by_key = {(o.right, round(o.strike, 4)): o for o in options}
    candidates: list[dict] = []

    if direction == "UP":
        # Buy call + sell higher call
        long_legs = [
            o
            for o in options
            if o.right == "C"
            and o.delta is not None
            and 0.30 <= o.delta <= 0.60
            and o.mid is not None
            and o.mid > 0
        ]
        criteria.append(
            _criterion(
                "Long call delta in [0.30, 0.60]",
                bool(long_legs),
                f"{len(long_legs)} candidates",
            )
        )
        long_legs = sorted(long_legs, key=lambda o: abs((o.delta or 0.0) - 0.40))

        for long_leg in long_legs:
            for width in widths:
                short_leg = by_key.get(("C", round(long_leg.strike + width, 4)))
                if short_leg is None:
                    continue
                _append_candidate_if_valid(
                    candidates=candidates,
                    spread_type="CALL_DEBIT_SPREAD",
                    long_leg=long_leg,
                    short_leg=short_leg,
                    width=width,
                    min_debit=min_debit,
                    max_debit=max_debit,
                    min_reward_to_risk=min_reward_to_risk,
                    max_liquidity_ratio=max_liquidity_ratio,
                )
    else:
        # Buy put + sell lower put
        long_legs = [
            o
            for o in options
            if o.right == "P"
            and o.delta is not None
            and -0.60 <= o.delta <= -0.30
            and o.mid is not None
            and o.mid > 0
        ]
        criteria.append(
            _criterion(
                "Long put delta in [-0.60, -0.30]",
                bool(long_legs),
                f"{len(long_legs)} candidates",
            )
        )
        long_legs = sorted(long_legs, key=lambda o: abs(abs(o.delta or 0.0) - 0.40))

        for long_leg in long_legs:
            for width in widths:
                short_leg = by_key.get(("P", round(long_leg.strike - width, 4)))
                if short_leg is None:
                    continue
                _append_candidate_if_valid(
                    candidates=candidates,
                    spread_type="PUT_DEBIT_SPREAD",
                    long_leg=long_leg,
                    short_leg=short_leg,
                    width=width,
                    min_debit=min_debit,
                    max_debit=max_debit,
                    min_reward_to_risk=min_reward_to_risk,
                    max_liquidity_ratio=max_liquidity_ratio,
                )

    criteria.append(_criterion("Candidate found after debit/risk/liquidity filters", bool(candidates), f"{len(candidates)} structures"))

    if not candidates:
        return _not_ready(["No convex debit spread passed strict debit, risk, and liquidity filters."], criteria)

    best = sorted(
        candidates,
        key=lambda c: (c["reward_to_risk"], c["pop_delta"], -c["debit"]),
        reverse=True,
    )[0]
    criteria.append(_criterion("Candidate selected", True, str(best["spread_type"])))
    return {"ready": True, "reasons": [], "candidate": best, "criteria": criteria}


def _append_candidate_if_valid(
    candidates: list[dict],
    spread_type: str,
    long_leg: OptionSnapshot,
    short_leg: OptionSnapshot,
    width: int,
    min_debit: float,
    max_debit: float,
    min_reward_to_risk: float,
    max_liquidity_ratio: float,
) -> None:
    if long_leg.mid is None or short_leg.mid is None:
        return
    if long_leg.delta is None or short_leg.delta is None:
        return
    if not (_is_liquid(long_leg, max_liquidity_ratio) and _is_liquid(short_leg, max_liquidity_ratio)):
        return

    debit = float(long_leg.mid - short_leg.mid)
    if debit <= 0:
        return
    if debit < min_debit or debit > max_debit:
        return

    max_profit_points = float(width) - debit
    if max_profit_points <= 0:
        return

    reward_to_risk = max_profit_points / debit
    if reward_to_risk < min_reward_to_risk:
        return

    long_right = "CALL" if long_leg.right == "C" else "PUT"
    short_right = "CALL" if short_leg.right == "C" else "PUT"

    candidates.append(
        {
            "spread_type": spread_type,
            "long_right": long_right,
            "short_right": short_right,
            "long_strike": long_leg.strike,
            "long_symbol": long_leg.option_symbol,
            "short_strike": short_leg.strike,
            "short_symbol": short_leg.option_symbol,
            "long_delta": long_leg.delta,
            "short_delta": short_leg.delta,
            "long_mid": float(long_leg.mid),
            "short_mid": float(short_leg.mid),
            "long_iv": long_leg.iv,
            "short_iv": short_leg.iv,
            "width": int(width),
            "debit": debit,
            "credit": debit,  # UI card uses shared premium field; label is switched to Debit in frontend.
            "max_loss_points": debit,
            "max_loss_dollars": debit * 100.0,
            "max_profit_points": max_profit_points,
            "max_profit_dollars": max_profit_points * 100.0,
            "reward_to_risk": reward_to_risk,
            "pop_delta": max(0.0, min(1.0, abs(long_leg.delta))),
            "liquidity_ratio": max(_spread_ratio(long_leg), _spread_ratio(short_leg)),
        }
    )


def _spread_ratio(option: OptionSnapshot) -> float:
    if option.bid is None or option.ask is None or option.mid in (None, 0):
        return float("inf")
    spread = option.ask - option.bid
    if spread < 0:
        return float("inf")
    return spread / option.mid


def _is_liquid(option: OptionSnapshot, max_ratio: float) -> bool:
    return _spread_ratio(option) <= max_ratio


def _not_ready(reasons: list[str], criteria: Optional[list[dict]] = None) -> dict:
    return {"ready": False, "reasons": reasons, "candidate": None, "criteria": criteria or []}


def _criterion(name: str, passed: bool, detail: str) -> dict:
    return {"name": name, "passed": passed, "detail": detail}
