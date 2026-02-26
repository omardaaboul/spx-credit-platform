from __future__ import annotations

import math
from typing import Optional, Sequence

from data.tasty import OptionSnapshot


def find_iron_condor_candidate(
    options: Sequence[OptionSnapshot],
    spot: Optional[float],
    emr: Optional[float],
    full_day_em: Optional[float],
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
        criteria.append(_criterion("Condor widths selected", False, "No widths selected"))
        return _not_ready(["No condor widths selected."], criteria)
    criteria.append(_criterion("Condor widths selected", True, f"Widths {list(widths)}"))

    by_key = {(o.right, round(o.strike, 4)): o for o in options}
    puts = [o for o in options if o.right == "P" and o.delta is not None and -0.25 <= o.delta <= -0.08]
    calls = [o for o in options if o.right == "C" and o.delta is not None and 0.08 <= o.delta <= 0.25]
    criteria.append(_criterion("Short put delta in [-0.25, -0.08]", bool(puts), f"{len(puts)} candidates"))
    criteria.append(_criterion("Short call delta in [0.08, 0.25]", bool(calls), f"{len(calls)} candidates"))

    if not puts:
        reasons.append("No short put in delta band [-0.18, -0.12].")
    if not calls:
        reasons.append("No short call in delta band [0.12, 0.18].")
    if reasons:
        return _not_ready(reasons, criteria)

    pairs = [(sp, sc) for sp in puts for sc in calls]
    symmetry_pairs = [(sp, sc) for sp, sc in pairs if abs(abs(sp.delta) - sc.delta) <= 0.06]
    criteria.append(
        _criterion(
            "Delta symmetry abs(|put|-call) <= 0.06",
            bool(symmetry_pairs),
            f"{len(symmetry_pairs)}/{len(pairs)} pairs",
        )
    )

    distance_pairs = [
        (sp, sc)
        for sp, sc in symmetry_pairs
        if (spot - sp.strike) >= (1.0 * emr) and (sc.strike - spot) >= (1.0 * emr)
    ]
    criteria.append(
        _criterion(
            "Short strikes >= 1.0 * EMR from spot",
            bool(distance_pairs),
            f"{len(distance_pairs)}/{len(symmetry_pairs)} pairs",
        )
    )

    liquid_pairs = [(sp, sc) for sp, sc in distance_pairs if _is_liquid(sp) and _is_liquid(sc)]
    criteria.append(
        _criterion(
            "Short-leg liquidity (spread/mid <= 0.18)",
            bool(liquid_pairs),
            f"{len(liquid_pairs)}/{len(distance_pairs)} pairs",
        )
    )

    candidates: list[dict] = []
    structure_count = 0
    credit_pass_count = 0

    for sp, sc in liquid_pairs:
        for width in widths:
            lp = by_key.get(("P", round(sp.strike - width, 4)))
            lc = by_key.get(("C", round(sc.strike + width, 4)))
            if lp is None or lc is None:
                continue
            if None in (sp.mid, sc.mid, lp.mid, lc.mid):
                continue

            structure_count += 1
            credit = float(sp.mid + sc.mid - lp.mid - lc.mid)
            if credit <= 0:
                continue
            if credit < 0.02 * width:
                continue

            max_loss_points = width - credit
            if max_loss_points <= 0:
                continue

            credit_pass_count += 1
            pop_delta = max(0.0, min(1.0, 1.0 - ((abs(sp.delta) + sc.delta) / 2.0)))
            pop_price = _price_based_pop_condor(
                spot=spot,
                short_put=sp.strike,
                short_call=sc.strike,
                credit=credit,
                sigma_points=full_day_em,
            )

            candidates.append(
                {
                    "short_put": sp.strike,
                    "short_put_symbol": sp.option_symbol,
                    "long_put": lp.strike,
                    "long_put_symbol": lp.option_symbol,
                    "short_call": sc.strike,
                    "short_call_symbol": sc.option_symbol,
                    "long_call": lc.strike,
                    "long_call_symbol": lc.option_symbol,
                    "width": int(width),
                    "credit": credit,
                    "credit_dollars": credit * 100.0,
                    "max_loss_points": max_loss_points,
                    "max_loss_dollars": max_loss_points * 100.0,
                    "pop_delta": pop_delta,
                    "pop_price": pop_price,
                    "short_put_delta": sp.delta,
                    "long_put_delta": lp.delta,
                    "short_call_delta": sc.delta,
                    "long_call_delta": lc.delta,
                    "short_put_mid": float(sp.mid),
                    "long_put_mid": float(lp.mid),
                    "short_call_mid": float(sc.mid),
                    "long_call_mid": float(lc.mid),
                    "short_put_iv": sp.iv,
                    "long_put_iv": lp.iv,
                    "short_call_iv": sc.iv,
                    "long_call_iv": lc.iv,
                    "liquidity_ratio": max(_spread_ratio(sp), _spread_ratio(sc)),
                    "credit_to_max_loss": credit / max_loss_points,
                }
            )

    criteria.append(
        _criterion(
            "Wing structures available for selected widths",
            structure_count > 0,
            f"{structure_count} valid structures",
        )
    )
    criteria.append(
        _criterion(
            "Credit filter (credit >= 0.02 * width)",
            credit_pass_count > 0,
            f"{credit_pass_count} structures passed",
        )
    )

    if not candidates:
        return _not_ready(
            [
                "No condor candidate passed symmetry, distance, width, credit, and liquidity filters.",
            ]
            ,
            criteria,
        )

    best = sorted(
        candidates,
        key=lambda c: (c["credit_to_max_loss"], c["credit"], c["pop_delta"]),
        reverse=True,
    )[0]
    criteria.append(_criterion("Candidate selected", True, "Best credit/max-loss found"))

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
    return _spread_ratio(option) <= 0.18


def _price_based_pop_condor(
    spot: float,
    short_put: float,
    short_call: float,
    credit: float,
    sigma_points: Optional[float],
) -> Optional[float]:
    if sigma_points in (None, 0):
        return None

    lower = short_put - credit
    upper = short_call + credit
    z_low = (lower - spot) / sigma_points
    z_high = (upper - spot) / sigma_points
    return max(0.0, min(1.0, _norm_cdf(z_high) - _norm_cdf(z_low)))


def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def build_condor_legs(payload: dict) -> list[dict]:
    """Return explicit 4-leg structure for alert formatting."""
    return [
        {
            "action": "SELL",
            "type": "PUT",
            "strike": payload.get("short_put"),
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
            "strike": payload.get("short_call"),
            "delta": payload.get("short_call_delta"),
        },
        {
            "action": "BUY",
            "type": "CALL",
            "strike": payload.get("long_call"),
            "delta": payload.get("long_call_delta"),
        },
    ]
