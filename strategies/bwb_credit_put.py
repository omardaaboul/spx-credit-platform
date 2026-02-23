from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import Optional, Sequence

from data.tasty import OptionSnapshot


@dataclass
class BwbSettings:
    enabled: bool = True
    target_dte: int = 21
    min_dte: int = 14
    max_dte: int = 30
    iv_rank_threshold: float = 50.0
    short_delta_min: float = 0.28
    short_delta_max: float = 0.30
    near_long_delta_target: float = 0.32
    near_long_delta_tolerance: float = 0.04
    far_long_delta_max: float = 0.20
    narrow_wing_min: float = 5.0
    narrow_wing_max: float = 10.0
    wide_to_narrow_min_ratio: float = 2.0
    min_credit_per_narrow: float = 0.10
    max_risk_pct_account: float = 0.01
    max_total_margin_pct_account: float = 0.12
    profit_take_credit_frac: float = 0.50
    profit_take_width_frac: float = 0.02
    stop_loss_credit_frac: float = 0.50
    exit_dte: int = 7
    delta_alert_threshold: float = 0.50
    gamma_alert_threshold: float = 0.08
    allow_adjustments: bool = False
    adjustment_mode: str = "NONE"  # NONE | ROLL | CONVERT_VERTICAL


def evaluate_broken_wing_put_butterfly(
    *,
    spot: Optional[float],
    options: Sequence[OptionSnapshot],
    expiration: Optional[dt.date],
    now_et: dt.datetime,
    iv_rank: Optional[float],
    has_major_event_today: bool,
    major_event_labels: Sequence[str],
    account_equity: float,
    open_margin_risk_dollars: float,
    settings: BwbSettings,
) -> dict:
    rows: list[dict] = []
    recommendation = None

    if not settings.enabled:
        return _result(False, "BWB sleeve disabled.", rows, None, {})
    if spot is None:
        rows.append(_fail("Spot available", "Missing SPX spot."))
        return _result(False, "Missing spot.", rows, None, {})
    if expiration is None:
        rows.append(_fail("Target expiration available", "No 14-30 DTE expiration available."))
        return _result(False, "No BWB expiration available.", rows, None, {})

    dte = (expiration - now_et.date()).days
    rows.append(
        _pass("DTE window (14-30)", f"{dte} DTE")
        if settings.min_dte <= dte <= settings.max_dte
        else _fail("DTE window (14-30)", f"{dte} DTE outside [{settings.min_dte}, {settings.max_dte}]")
    )
    rows.append(
        _pass("Not inside 7 DTE", f"{dte} DTE")
        if dte > settings.exit_dte
        else _fail("Not inside 7 DTE", f"{dte} DTE <= {settings.exit_dte}")
    )

    if has_major_event_today:
        rows.append(
            _fail(
                "No major macro event day",
                ", ".join(major_event_labels) if major_event_labels else "Major event day block.",
            )
        )
    else:
        rows.append(_pass("No major macro event day", "No major macro event configured for today."))

    rows.append(
        _pass("IV Rank >= threshold", f"{iv_rank:.1f}% >= {settings.iv_rank_threshold:.1f}%")
        if iv_rank is not None and iv_rank >= settings.iv_rank_threshold
        else _fail(
            "IV Rank >= threshold",
            f"{iv_rank:.1f}% < {settings.iv_rank_threshold:.1f}%"
            if iv_rank is not None
            else "IV Rank unavailable.",
        )
    )

    pre_checks_ok = all((r["status"] != "fail") for r in rows if r.get("required", True))
    if not pre_checks_ok:
        return _result(False, _first_fail_detail(rows), rows, None, _metrics_payload(iv_rank, dte))

    put_options = [
        o
        for o in options
        if o.expiration == expiration
        and o.right == "P"
        and o.delta is not None
        and o.bid is not None
        and o.ask is not None
        and o.mid is not None
    ]
    if not put_options:
        rows.append(_fail("Option chain quality", "No usable put options for target expiration."))
        return _result(False, _first_fail_detail(rows), rows, None, _metrics_payload(iv_rank, dte))

    candidate = _select_bwb_structure(
        spot=spot,
        puts=put_options,
        settings=settings,
        account_equity=account_equity,
        open_margin_risk_dollars=open_margin_risk_dollars,
    )
    if candidate is None:
        rows.extend(
            [
                _fail("Short put delta 0.28-0.30", "No short put matched required delta band."),
                _fail("Narrow wing width 5-10", "No near long put matched 32Δ profile and width limits."),
                _fail("Wide wing >= 2x narrow", "No far long put matched 20Δ-or-lower and width ratio."),
                _fail("Credit >= 0.10 × narrow width", "No net credit candidate met threshold."),
                _fail("Risk <= 1% account", "No candidate passed account risk cap."),
            ]
        )
        return _result(False, "No BWB candidate matched strict filters.", rows, None, _metrics_payload(iv_rank, dte))

    rows.append(_pass("Short put delta 0.28-0.30", f"{candidate['short_delta']:+.2f}"))
    rows.append(_pass("Narrow wing width 5-10", f"{candidate['narrow_wing_width']:.1f} points"))
    rows.append(
        _pass(
            "Wide wing >= 2x narrow",
            f"{candidate['wide_wing_width']:.1f} >= {settings.wide_to_narrow_min_ratio:.2f} x {candidate['narrow_wing_width']:.1f}",
        )
    )
    rows.append(
        _pass(
            "Credit >= 0.10 × narrow width",
            f"{candidate['credit']:.2f} >= {(settings.min_credit_per_narrow * candidate['narrow_wing_width']):.2f}",
        )
    )
    rows.append(
        _pass(
            "Risk <= 1% account",
            f"${candidate['max_risk_dollars']:.2f} <= ${(settings.max_risk_pct_account * account_equity):.2f}",
        )
    )
    projected_margin = open_margin_risk_dollars + candidate["max_risk_dollars"]
    max_margin = settings.max_total_margin_pct_account * account_equity
    rows.append(
        _pass("Total margin exposure within cap", f"${projected_margin:.2f} <= ${max_margin:.2f}")
        if projected_margin <= max_margin
        else _fail("Total margin exposure within cap", f"${projected_margin:.2f} > ${max_margin:.2f}")
    )

    ready = all((r["status"] != "fail") for r in rows if r.get("required", True))
    if ready:
        recommendation = candidate

    reason = "All BWB criteria met." if ready else _first_fail_detail(rows)
    return _result(ready, reason, rows, recommendation, _metrics_payload(iv_rank, dte))


def monitor_bwb_position(
    *,
    position: Optional[dict],
    options: Sequence[OptionSnapshot],
    spot: Optional[float],
    now_et: dt.datetime,
    settings: BwbSettings,
) -> dict:
    if not position:
        return {"hasPosition": False}

    option_by_symbol = {o.option_symbol: o for o in options}
    near_symbol = str(position.get("near_long_symbol", "")).strip()
    short_symbol = str(position.get("short_symbol", "")).strip()
    far_symbol = str(position.get("far_long_symbol", "")).strip()

    near = option_by_symbol.get(near_symbol)
    short = option_by_symbol.get(short_symbol)
    far = option_by_symbol.get(far_symbol)

    near_mid = near.mid if near is not None else None
    short_mid = short.mid if short is not None else None
    far_mid = far.mid if far is not None else None

    current_debit: Optional[float] = None
    if near_mid is not None and short_mid is not None and far_mid is not None:
        current_debit = max(0.0, 2.0 * float(short_mid) - float(near_mid) - float(far_mid))

    entry_credit = _as_float(position.get("entry_credit")) or 0.0
    narrow_width = _as_float(position.get("narrow_wing_width")) or 0.0
    profit_target_debit = max(
        settings.profit_take_credit_frac * entry_credit,
        settings.profit_take_width_frac * narrow_width,
    )
    stop_loss_debit = entry_credit * (1.0 + settings.stop_loss_credit_frac)

    expiry_text = str(position.get("expiry", "")).strip()
    dte_remaining = None
    try:
        expiry = dt.date.fromisoformat(expiry_text)
        dte_remaining = (expiry - now_et.date()).days
    except Exception:
        expiry = None

    long_put_strike = _as_float(position.get("long_put_strike"))
    loss_points = None if current_debit is None else (current_debit - entry_credit)

    reasons: list[str] = []
    if current_debit is not None and current_debit <= profit_target_debit:
        reasons.append(f"Profit target hit ({current_debit:.2f} <= {profit_target_debit:.2f})")
    if dte_remaining is not None and dte_remaining <= settings.exit_dte:
        reasons.append(f"DTE exit triggered ({dte_remaining} <= {settings.exit_dte})")
    if current_debit is not None and current_debit >= stop_loss_debit:
        reasons.append(f"Stop-loss triggered ({current_debit:.2f} >= {stop_loss_debit:.2f})")
    if spot is not None and long_put_strike is not None and spot <= long_put_strike:
        reasons.append(f"Underlying crossed long put strike ({spot:.2f} <= {long_put_strike:.2f})")

    net_delta = _net_two_sided_greek(near, short, far, field="delta")
    net_gamma = _net_two_sided_greek(near, short, far, field="gamma")
    greek_alert = False
    greek_reason = ""
    if net_delta is not None and abs(net_delta) > settings.delta_alert_threshold:
        greek_alert = True
        greek_reason = f"|Δ| {abs(net_delta):.3f} > {settings.delta_alert_threshold:.3f}"
    if net_gamma is not None and abs(net_gamma) > settings.gamma_alert_threshold:
        greek_alert = True
        greek_reason = (
            f"{greek_reason} |Γ| {abs(net_gamma):.3f} > {settings.gamma_alert_threshold:.3f}"
            if greek_reason
            else f"|Γ| {abs(net_gamma):.3f} > {settings.gamma_alert_threshold:.3f}"
        )

    stop_triggered = any("Stop-loss" in r or "crossed long put strike" in r for r in reasons)
    adjustment_signal = bool(settings.allow_adjustments and stop_triggered)

    return {
        "hasPosition": True,
        "current_debit": current_debit,
        "entry_credit": entry_credit,
        "profit_target_debit": profit_target_debit,
        "stop_loss_debit": stop_loss_debit,
        "loss_points": loss_points,
        "dte_remaining": dte_remaining,
        "should_exit": bool(reasons),
        "exit_reason": " | ".join(reasons),
        "net_delta": net_delta,
        "net_gamma": net_gamma,
        "greek_alert": greek_alert,
        "greek_reason": greek_reason,
        "adjustment_signal": adjustment_signal,
        "adjustment_mode": settings.adjustment_mode if adjustment_signal else "NONE",
    }


def _select_bwb_structure(
    *,
    spot: float,
    puts: Sequence[OptionSnapshot],
    settings: BwbSettings,
    account_equity: float,
    open_margin_risk_dollars: float,
) -> Optional[dict]:
    shorts = [
        p
        for p in puts
        if p.strike < spot and p.delta is not None and settings.short_delta_min <= abs(p.delta) <= settings.short_delta_max
    ]
    if not shorts:
        return None

    best: Optional[dict] = None
    target_near_delta = settings.near_long_delta_target
    near_min = max(0.01, target_near_delta - settings.near_long_delta_tolerance)
    near_max = target_near_delta + settings.near_long_delta_tolerance

    for short in shorts:
        near_longs = [
            p
            for p in puts
            if p.strike > short.strike
            and p.delta is not None
            and near_min <= abs(p.delta) <= near_max
            and settings.narrow_wing_min <= (p.strike - short.strike) <= settings.narrow_wing_max
        ]
        if not near_longs:
            continue

        far_longs = [
            p
            for p in puts
            if p.strike < short.strike and p.delta is not None and abs(p.delta) <= settings.far_long_delta_max
        ]
        if not far_longs:
            continue

        for near in near_longs:
            narrow = near.strike - short.strike
            for far in far_longs:
                wide = short.strike - far.strike
                if wide < settings.wide_to_narrow_min_ratio * narrow:
                    continue

                credit = 2.0 * float(short.bid) - float(near.ask) - float(far.ask)
                if credit <= 0:
                    continue
                if credit < settings.min_credit_per_narrow * narrow:
                    continue

                max_risk_points = (wide - narrow) - credit
                if max_risk_points <= 0:
                    continue
                max_risk_dollars = max_risk_points * 100.0
                per_trade_cap = settings.max_risk_pct_account * account_equity
                total_margin_cap = settings.max_total_margin_pct_account * account_equity
                if max_risk_dollars > per_trade_cap:
                    continue
                if open_margin_risk_dollars + max_risk_dollars > total_margin_cap:
                    continue

                liquidity_ratio = _max_liq_ratio((short, near, far))
                if liquidity_ratio is None:
                    continue

                candidate = {
                    "type": "Broken-Wing Put Butterfly",
                    "right": "PUT",
                    "expiry": short.expiration.isoformat(),
                    "long_put_strike": near.strike,
                    "short_put_strike": short.strike,
                    "far_long_put_strike": far.strike,
                    "near_long_symbol": near.option_symbol,
                    "short_symbol": short.option_symbol,
                    "far_long_symbol": far.option_symbol,
                    "long_put_delta": near.delta,
                    "short_delta": short.delta,
                    "far_long_delta": far.delta,
                    "narrow_wing_width": narrow,
                    "wide_wing_width": wide,
                    "credit": credit,
                    "max_risk_points": max_risk_points,
                    "max_risk_dollars": max_risk_dollars,
                    "liquidity_ratio": liquidity_ratio,
                    "profit_target_debit": max(
                        settings.profit_take_credit_frac * credit,
                        settings.profit_take_width_frac * narrow,
                    ),
                    "stop_loss_debit": credit * (1.0 + settings.stop_loss_credit_frac),
                    "exit_dte": settings.exit_dte,
                    "legs": [
                        {
                            "role": "near_long",
                            "action": "BUY",
                            "type": "PUT",
                            "strike": near.strike,
                            "delta": near.delta,
                            "qty": 1,
                            "premium": near.ask,
                            "symbol": near.option_symbol,
                        },
                        {
                            "role": "short",
                            "action": "SELL",
                            "type": "PUT",
                            "strike": short.strike,
                            "delta": short.delta,
                            "qty": 2,
                            "premium": short.bid,
                            "symbol": short.option_symbol,
                        },
                        {
                            "role": "far_long",
                            "action": "BUY",
                            "type": "PUT",
                            "strike": far.strike,
                            "delta": far.delta,
                            "qty": 1,
                            "premium": far.ask,
                            "symbol": far.option_symbol,
                        },
                    ],
                }

                if best is None:
                    best = candidate
                    continue

                # Conservative tie-break: higher credit, tighter narrow wing, cleaner liquidity, closer short delta to 0.29.
                best_key = (
                    float(best["credit"]),
                    -float(best["narrow_wing_width"]),
                    -float(best["wide_wing_width"]),
                    -float(best["liquidity_ratio"]),
                    -abs(abs(float(best["short_delta"])) - 0.29),
                )
                cand_key = (
                    float(candidate["credit"]),
                    -float(candidate["narrow_wing_width"]),
                    -float(candidate["wide_wing_width"]),
                    -float(candidate["liquidity_ratio"]),
                    -abs(abs(float(candidate["short_delta"])) - 0.29),
                )
                if cand_key > best_key:
                    best = candidate

    return best


def _max_liq_ratio(legs: Sequence[OptionSnapshot]) -> Optional[float]:
    ratios: list[float] = []
    for leg in legs:
        if leg.bid is None or leg.ask is None or leg.mid in (None, 0):
            return None
        ratios.append(max(0.0, (leg.ask - leg.bid) / leg.mid))
    return max(ratios) if ratios else None


def _net_two_sided_greek(
    near: Optional[OptionSnapshot],
    short: Optional[OptionSnapshot],
    far: Optional[OptionSnapshot],
    *,
    field: str,
) -> Optional[float]:
    if near is None or short is None or far is None:
        return None
    near_v = _as_float(getattr(near, field, None))
    short_v = _as_float(getattr(short, field, None))
    far_v = _as_float(getattr(far, field, None))
    if near_v is None or short_v is None or far_v is None:
        return None
    return near_v + far_v - (2.0 * short_v)


def _metrics_payload(iv_rank: Optional[float], dte: Optional[int]) -> dict:
    return {
        "iv_rank": iv_rank,
        "dte": dte,
    }


def _as_float(value: object) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _result(ready: bool, reason: str, checklist: list[dict], recommendation: Optional[dict], metrics: dict) -> dict:
    return {
        "ready": ready,
        "reason": reason,
        "checklist": checklist,
        "recommendation": recommendation,
        "metrics": metrics,
    }


def _first_fail_detail(rows: Sequence[dict]) -> str:
    for row in rows:
        if row.get("required", True) and row.get("status") == "fail":
            return str(row.get("detail") or row.get("name") or "Blocked")
    return "Blocked"


def _pass(name: str, detail: str, required: bool = True) -> dict:
    return {"name": name, "status": "pass", "detail": detail, "required": required}


def _fail(name: str, detail: str, required: bool = True) -> dict:
    return {"name": name, "status": "fail", "detail": detail, "required": required}

