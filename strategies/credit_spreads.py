from __future__ import annotations

import datetime as dt
import math
from typing import Optional, Sequence

from data.tasty import OptionSnapshot


def find_directional_credit_spread_candidate(
    options: Sequence[OptionSnapshot],
    spot: Optional[float],
    emr: Optional[float],
    full_day_em: Optional[float],
    now_et: dt.datetime,
    trend_slope_points_per_min: Optional[float],
    range_15m: Optional[float],
    widths: Sequence[int],
    trend_slope_threshold: float = 0.12,
    max_range_emr_ratio: float = 0.55,
    short_put_delta_min: float = -0.30,
    short_put_delta_max: float = -0.12,
    short_call_delta_min: float = 0.12,
    short_call_delta_max: float = 0.30,
    min_credit_per_width: float = 0.03,
    min_pop: float = 0.60,
    max_liquidity_ratio: float = 0.18,
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
        criteria.append(_criterion("Widths selected", False, "No widths selected"))
        return _not_ready(["No credit spread widths selected."], criteria)
    criteria.append(_criterion("Widths selected", True, f"Widths {list(widths)}"))

    start = now_et.replace(hour=9, minute=45, second=0, microsecond=0)
    end = now_et.replace(hour=14, minute=30, second=0, microsecond=0)
    pass_time = start <= now_et <= end
    criteria.append(_criterion("Entry time 09:45-14:30 ET", pass_time, now_et.strftime("%H:%M:%S ET")))
    if not pass_time:
        reasons.append("Directional spread not allowed outside 09:45-14:30 ET.")

    if trend_slope_points_per_min is None:
        criteria.append(_criterion("Trend slope available", False, "Insufficient candles"))
        reasons.append("Trend slope unavailable.")
        return _not_ready(reasons, criteria)

    if trend_slope_points_per_min > trend_slope_threshold:
        direction = "UP"
    elif trend_slope_points_per_min < -trend_slope_threshold:
        direction = "DOWN"
    else:
        direction = "CHOPPY"

    criteria.append(
        _criterion(
            f"Trend strength |slope| > {trend_slope_threshold:.2f} pts/min",
            direction in {"UP", "DOWN"},
            f"slope {trend_slope_points_per_min:+.3f}",
        )
    )
    if direction == "CHOPPY":
        reasons.append("Trend too weak/choppy for directional spread.")

    vol_pass = range_15m is not None and range_15m < max_range_emr_ratio * emr
    criteria.append(
        _criterion(
            f"15m range < {max_range_emr_ratio:.2f} * EMR",
            vol_pass,
            f"{_fmt(range_15m)} < {_fmt(max_range_emr_ratio * emr)}",
        )
    )
    if not vol_pass:
        reasons.append("15m realized range is too high for directional spread.")

    if reasons:
        return _not_ready(reasons, criteria)

    by_key = {(o.right, round(o.strike, 4)): o for o in options}
    candidates: list[dict] = []

    if direction == "UP":
        # Bull put spread: sell put delta -0.25 to -0.20
        short_legs = [
            o
            for o in options
            if o.right == "P"
            and o.delta is not None
            and short_put_delta_min <= o.delta <= short_put_delta_max
        ]
        criteria.append(
            _criterion(
                f"Bull put short-put delta in [{short_put_delta_min:.2f},{short_put_delta_max:.2f}]",
                bool(short_legs),
                f"{len(short_legs)} candidates",
            )
        )

        for short in short_legs:
            for width in widths:
                long = by_key.get(("P", round(short.strike - width, 4)))
                if long is None:
                    continue
                if None in (short.mid, long.mid):
                    continue
                if not (_is_liquid(short, max_liquidity_ratio) and _is_liquid(long, max_liquidity_ratio)):
                    continue

                credit = float(short.mid - long.mid)
                if credit <= 0:
                    continue
                if credit < min_credit_per_width * width:
                    continue

                max_loss_points = width - credit
                if max_loss_points <= 0:
                    continue

                pop_delta = max(0.0, min(1.0, 1.0 - abs(short.delta)))
                if pop_delta < min_pop:
                    continue

                pop_price = _price_based_pop_vertical(
                    spot=spot,
                    short_strike=short.strike,
                    credit=credit,
                    sigma_points=full_day_em,
                    direction="BULL_PUT_SPREAD",
                )

                candidates.append(
                    {
                        "spread_type": "BULL_PUT_SPREAD",
                        "short_right": "PUT",
                        "long_right": "PUT",
                        "short_strike": short.strike,
                        "short_symbol": short.option_symbol,
                        "long_strike": long.strike,
                        "long_symbol": long.option_symbol,
                        "width": int(width),
                        "credit": credit,
                        "credit_dollars": credit * 100.0,
                        "max_loss_points": max_loss_points,
                        "max_loss_dollars": max_loss_points * 100.0,
                        "short_delta": short.delta,
                        "long_delta": long.delta,
                        "short_put_delta": short.delta,
                        "short_call_delta": None,
                        "long_put_delta": long.delta,
                        "long_call_delta": None,
                        "short_mid": float(short.mid),
                        "long_mid": float(long.mid),
                        "short_iv": short.iv,
                        "long_iv": long.iv,
                        "pop_delta": pop_delta,
                        "pop_price": pop_price,
                        "liquidity_ratio": max(_spread_ratio(short), _spread_ratio(long)),
                        "credit_to_max_loss": credit / max_loss_points,
                        "trend_slope": trend_slope_points_per_min,
                    }
                )
    else:
        # Bear call spread: sell call delta 0.20 to 0.25
        short_legs = [
            o
            for o in options
            if o.right == "C"
            and o.delta is not None
            and short_call_delta_min <= o.delta <= short_call_delta_max
        ]
        criteria.append(
            _criterion(
                f"Bear call short-call delta in [{short_call_delta_min:.2f},{short_call_delta_max:.2f}]",
                bool(short_legs),
                f"{len(short_legs)} candidates",
            )
        )

        for short in short_legs:
            for width in widths:
                long = by_key.get(("C", round(short.strike + width, 4)))
                if long is None:
                    continue
                if None in (short.mid, long.mid):
                    continue
                if not (_is_liquid(short, max_liquidity_ratio) and _is_liquid(long, max_liquidity_ratio)):
                    continue

                credit = float(short.mid - long.mid)
                if credit <= 0:
                    continue
                if credit < min_credit_per_width * width:
                    continue

                max_loss_points = width - credit
                if max_loss_points <= 0:
                    continue

                pop_delta = max(0.0, min(1.0, 1.0 - abs(short.delta)))
                if pop_delta < min_pop:
                    continue

                pop_price = _price_based_pop_vertical(
                    spot=spot,
                    short_strike=short.strike,
                    credit=credit,
                    sigma_points=full_day_em,
                    direction="BEAR_CALL_SPREAD",
                )

                candidates.append(
                    {
                        "spread_type": "BEAR_CALL_SPREAD",
                        "short_right": "CALL",
                        "long_right": "CALL",
                        "short_strike": short.strike,
                        "short_symbol": short.option_symbol,
                        "long_strike": long.strike,
                        "long_symbol": long.option_symbol,
                        "width": int(width),
                        "credit": credit,
                        "credit_dollars": credit * 100.0,
                        "max_loss_points": max_loss_points,
                        "max_loss_dollars": max_loss_points * 100.0,
                        "short_delta": short.delta,
                        "long_delta": long.delta,
                        "short_put_delta": None,
                        "short_call_delta": short.delta,
                        "long_put_delta": None,
                        "long_call_delta": long.delta,
                        "short_mid": float(short.mid),
                        "long_mid": float(long.mid),
                        "short_iv": short.iv,
                        "long_iv": long.iv,
                        "pop_delta": pop_delta,
                        "pop_price": pop_price,
                        "liquidity_ratio": max(_spread_ratio(short), _spread_ratio(long)),
                        "credit_to_max_loss": credit / max_loss_points,
                        "trend_slope": trend_slope_points_per_min,
                    }
                )

    criteria.append(_criterion("Candidate found after filters", bool(candidates), f"{len(candidates)} structures"))

    if not candidates:
        return _not_ready(["No directional spread passed delta/width/credit/POP/liquidity filters."], criteria)

    best = sorted(candidates, key=lambda c: (c["credit_to_max_loss"], c["credit"], c["pop_delta"]), reverse=True)[0]
    criteria.append(_criterion("Candidate selected", True, f"{best['spread_type']}"))
    return {"ready": True, "reasons": [], "candidate": best, "criteria": criteria}


def build_credit_spread_legs(payload: dict) -> list[dict]:
    spread_type = str(payload.get("spread_type", "")).upper()
    right = "PUT" if spread_type == "BULL_PUT_SPREAD" else "CALL"
    return [
        {
            "action": "SELL",
            "type": right,
            "strike": payload.get("short_strike"),
            "delta": payload.get("short_delta"),
        },
        {
            "action": "BUY",
            "type": right,
            "strike": payload.get("long_strike"),
            "delta": payload.get("long_delta"),
        },
    ]


def _not_ready(reasons: list[str], criteria: Optional[list[dict]] = None) -> dict:
    return {"ready": False, "reasons": reasons, "candidate": None, "criteria": criteria or []}


def _criterion(name: str, passed: bool, detail: str) -> dict:
    return {"name": name, "passed": passed, "detail": detail}


def _spread_ratio(option: OptionSnapshot) -> float:
    if option.bid is None or option.ask is None or option.mid in (None, 0):
        return float("inf")
    spread = option.ask - option.bid
    if spread < 0:
        return float("inf")
    return spread / option.mid


def _is_liquid(option: OptionSnapshot, max_ratio: float) -> bool:
    return _spread_ratio(option) <= max_ratio


def _price_based_pop_vertical(
    spot: float,
    short_strike: float,
    credit: float,
    sigma_points: Optional[float],
    direction: str,
) -> Optional[float]:
    if sigma_points in (None, 0):
        return None

    if direction == "BULL_PUT_SPREAD":
        # stay above short_put - credit
        threshold = short_strike - credit
        z = (threshold - spot) / sigma_points
        return max(0.0, min(1.0, 1.0 - _norm_cdf(z)))

    # BEAR_CALL_SPREAD: stay below short_call + credit
    threshold = short_strike + credit
    z = (threshold - spot) / sigma_points
    return max(0.0, min(1.0, _norm_cdf(z)))


def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _fmt(value: Optional[float]) -> str:
    if value is None:
        return "-"
    return f"{value:.2f}"
