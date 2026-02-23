from __future__ import annotations

import datetime as dt
import math
from typing import Optional, Sequence

from data.tasty import OptionSnapshot


def find_iron_fly_candidate(
    options: Sequence[OptionSnapshot],
    spot: Optional[float],
    emr: Optional[float],
    full_day_em: Optional[float],
    now_et: dt.datetime,
    range_15m: Optional[float],
    vwap_distance: Optional[float],
    vix_change_pct: Optional[float],
    widths: Sequence[int],
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
        criteria.append(_criterion("Fly widths selected", False, "No widths selected"))
        return _not_ready(["No fly widths selected."], criteria)
    criteria.append(_criterion("Fly widths selected", True, f"Widths {list(widths)}"))

    cutoff = now_et.replace(hour=13, minute=0, second=0, microsecond=0)
    pass_time = now_et <= cutoff
    criteria.append(_criterion("Entry time <= 13:00 ET", pass_time, now_et.strftime("%H:%M:%S ET")))
    if not pass_time:
        reasons.append("Iron Fly not allowed after 13:00 ET.")

    pass_vwap = vwap_distance is not None and vwap_distance < 0.2 * emr
    criteria.append(
        _criterion(
            "|SPX - VWAP| < 0.2 * EMR",
            pass_vwap,
            f"{_fmt(vwap_distance)} < {_fmt(0.2 * emr)}",
        )
    )
    if not pass_vwap:
        reasons.append("|SPX-VWAP| must be < 0.2 * EMR for fly.")

    pass_range = range_15m is not None and range_15m < 0.25 * emr
    criteria.append(
        _criterion(
            "15m range < 0.25 * EMR",
            pass_range,
            f"{_fmt(range_15m)} < {_fmt(0.25 * emr)}",
        )
    )
    if not pass_range:
        reasons.append("15m range must be < 0.25 * EMR for fly.")

    pass_vix = vix_change_pct is None or vix_change_pct <= 3.0
    vix_detail = "- (ignored)" if vix_change_pct is None else f"{vix_change_pct:+.2f}% <= +3.00%"
    criteria.append(_criterion("VIX change <= +3% (if available)", pass_vix, vix_detail))
    if not pass_vix:
        reasons.append("VIX change must be <= +3% for fly.")

    if reasons:
        return _not_ready(reasons, criteria)

    calls_by_strike = {
        round(o.strike, 4): o for o in options if o.right == "C" and o.mid is not None and o.mid > 0
    }
    puts_by_strike = {
        round(o.strike, 4): o for o in options if o.right == "P" and o.mid is not None and o.mid > 0
    }

    shared_strikes = sorted(set(calls_by_strike.keys()) & set(puts_by_strike.keys()))
    criteria.append(
        _criterion(
            "ATM shared strike exists",
            bool(shared_strikes),
            f"{len(shared_strikes)} shared strikes",
        )
    )
    if not shared_strikes:
        return _not_ready(["No shared strike with valid call/put mids for ATM short legs."], criteria)

    atm_strike = min(shared_strikes, key=lambda s: abs(s - spot))
    short_call = calls_by_strike[atm_strike]
    short_put = puts_by_strike[atm_strike]

    pass_liquidity = _is_liquid(short_call) and _is_liquid(short_put)
    criteria.append(
        _criterion(
            "ATM short-leg liquidity (spread/mid <= 0.12)",
            pass_liquidity,
            f"ratio {_fmt(max(_spread_ratio(short_put), _spread_ratio(short_call)))}",
        )
    )
    if not pass_liquidity:
        return _not_ready(["ATM short legs failed liquidity gate ((ask-bid)/mid <= 0.12)."], criteria)

    candidates: list[dict] = []
    structure_count = 0

    for width in widths:
        long_put = puts_by_strike.get(round(atm_strike - width, 4))
        long_call = calls_by_strike.get(round(atm_strike + width, 4))
        if long_put is None or long_call is None:
            continue

        credit = float(short_call.mid + short_put.mid - long_call.mid - long_put.mid)
        if credit <= 0:
            continue

        max_loss_points = width - credit
        if max_loss_points <= 0:
            continue
        structure_count += 1

        sp_delta = short_put.delta if short_put.delta is not None else -0.50
        sc_delta = short_call.delta if short_call.delta is not None else 0.50
        pop_delta = max(0.0, min(1.0, 1.0 - ((abs(sp_delta) + sc_delta) / 2.0)))

        pop_price = _price_based_pop_fly(
            spot=spot,
            short_strike=atm_strike,
            credit=credit,
            sigma_points=full_day_em,
        )

        candidates.append(
            {
                "short_strike": float(atm_strike),
                "short_put_symbol": short_put.option_symbol,
                "short_call_symbol": short_call.option_symbol,
                "long_put": float(atm_strike - width),
                "long_put_symbol": long_put.option_symbol,
                "long_call": float(atm_strike + width),
                "long_call_symbol": long_call.option_symbol,
                "width": int(width),
                "credit": credit,
                "credit_dollars": credit * 100.0,
                "max_loss_points": max_loss_points,
                "max_loss_dollars": max_loss_points * 100.0,
                "pop_delta": pop_delta,
                "pop_price": pop_price,
                "short_put_delta": sp_delta,
                "short_call_delta": sc_delta,
                "long_put_delta": long_put.delta,
                "long_call_delta": long_call.delta,
                "short_put_mid": float(short_put.mid),
                "short_call_mid": float(short_call.mid),
                "long_put_mid": float(long_put.mid),
                "long_call_mid": float(long_call.mid),
                "short_put_iv": short_put.iv,
                "short_call_iv": short_call.iv,
                "long_put_iv": long_put.iv,
                "long_call_iv": long_call.iv,
                "liquidity_ratio": max(_spread_ratio(short_put), _spread_ratio(short_call)),
                "credit_to_max_loss": credit / max_loss_points,
            }
        )

    criteria.append(
        _criterion(
            "Width structure and positive credit found",
            structure_count > 0,
            f"{structure_count} structures passed",
        )
    )

    if not candidates:
        return _not_ready(["No fly width (20/30) passed structure and pricing checks."], criteria)

    best = sorted(candidates, key=lambda c: (c["credit"], c["credit_to_max_loss"]), reverse=True)[0]
    criteria.append(_criterion("Candidate selected", True, "Highest credit chosen"))
    return {"ready": True, "reasons": [], "candidate": best, "criteria": criteria}


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


def _is_liquid(option: OptionSnapshot) -> bool:
    return _spread_ratio(option) <= 0.12


def _price_based_pop_fly(
    spot: float,
    short_strike: float,
    credit: float,
    sigma_points: Optional[float],
) -> Optional[float]:
    if sigma_points in (None, 0):
        return None

    lower = short_strike - credit
    upper = short_strike + credit
    z_low = (lower - spot) / sigma_points
    z_high = (upper - spot) / sigma_points
    return max(0.0, min(1.0, _norm_cdf(z_high) - _norm_cdf(z_low)))


def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _fmt(value: Optional[float]) -> str:
    if value is None:
        return "-"
    return f"{value:.2f}"


def build_fly_legs(payload: dict) -> list[dict]:
    """Return explicit 4-leg structure for alert formatting."""
    strike = payload.get("short_strike")
    return [
        {
            "action": "SELL",
            "type": "PUT",
            "strike": strike,
            "delta": payload.get("short_put_delta"),
        },
        {
            "action": "BUY",
            "type": "PUT",
            "strike": payload.get("long_put"),
            "delta": payload.get("long_put_delta"),
        },
        {
            "action": "SELL",
            "type": "CALL",
            "strike": strike,
            "delta": payload.get("short_call_delta"),
        },
        {
            "action": "BUY",
            "type": "CALL",
            "strike": payload.get("long_call"),
            "delta": payload.get("long_call_delta"),
        },
    ]
