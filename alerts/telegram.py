from __future__ import annotations

import datetime as dt
import time
from typing import Any, Optional
from zoneinfo import ZoneInfo

import requests

from strategies.condor import build_condor_legs
from strategies.credit_spreads import build_credit_spread_legs
from strategies.fly import build_fly_legs

ET = ZoneInfo("America/New_York")
PARIS = ZoneInfo("Europe/Paris")
APP_NAME = "SPX 0DTE Dashboard"


def format_option_legs(legs: list[dict]) -> str:
    """Format explicit option legs for Telegram alerts."""
    lines = ["🟢 LEGS:"]
    for leg in legs:
        action = str(leg.get("action", "-")).strip().upper()
        right = str(leg.get("type", "-")).strip().upper()
        strike = _fmt_strike(leg.get("strike"))
        delta = _fmt_delta(leg.get("delta"))

        action_label = "Sell" if action == "SELL" else "Buy" if action == "BUY" else action.title()
        lines.append(f"{action_label} 1 {right} {strike} (Δ {delta})")
    return "\n".join(lines)


def format_condor_entry_alert(
    candidate: dict,
    now_et: dt.datetime,
    spot: Optional[float],
    risk_score: str,
    vix: Optional[float],
    ivr: Optional[float],
    emr: Optional[float],
    atr_pct_emr: Optional[float],
    vwap_distance: Optional[float],
    range_pct_emr: Optional[float],
    reason: str,
    checklist_summary: Optional[str] = None,
) -> str:
    legs = build_condor_legs(candidate)
    return _format_entry_alert(
        strategy_name="Iron Condor",
        now_et=now_et,
        spot=spot,
        legs=legs,
        width=candidate.get("width"),
        credit=candidate.get("credit"),
        max_risk_points=candidate.get("max_loss_points"),
        pop_estimate=candidate.get("pop_delta"),
        risk_score=risk_score,
        vix=vix,
        ivr=ivr,
        emr=emr,
        atr_pct_emr=atr_pct_emr,
        vwap_distance=vwap_distance,
        range_pct_emr=range_pct_emr,
        reason=reason,
        checklist_summary=checklist_summary,
    )


def format_fly_entry_alert(
    candidate: dict,
    now_et: dt.datetime,
    spot: Optional[float],
    risk_score: str,
    vix: Optional[float],
    ivr: Optional[float],
    emr: Optional[float],
    atr_pct_emr: Optional[float],
    vwap_distance: Optional[float],
    range_pct_emr: Optional[float],
    reason: str,
    checklist_summary: Optional[str] = None,
) -> str:
    legs = build_fly_legs(candidate)
    return _format_entry_alert(
        strategy_name="Iron Fly",
        now_et=now_et,
        spot=spot,
        legs=legs,
        width=candidate.get("width"),
        credit=candidate.get("credit"),
        max_risk_points=candidate.get("max_loss_points"),
        pop_estimate=candidate.get("pop_delta"),
        risk_score=risk_score,
        vix=vix,
        ivr=ivr,
        emr=emr,
        atr_pct_emr=atr_pct_emr,
        vwap_distance=vwap_distance,
        range_pct_emr=range_pct_emr,
        reason=reason,
        checklist_summary=checklist_summary,
    )


def format_credit_spread_entry_alert(
    candidate: dict,
    now_et: dt.datetime,
    spot: Optional[float],
    risk_score: str,
    vix: Optional[float],
    ivr: Optional[float],
    emr: Optional[float],
    atr_pct_emr: Optional[float],
    vwap_distance: Optional[float],
    range_pct_emr: Optional[float],
    reason: str,
    checklist_summary: Optional[str] = None,
) -> str:
    legs = build_credit_spread_legs(candidate)
    spread_type = _pretty_spread_type(candidate.get("spread_type"))
    return _format_entry_alert(
        strategy_name=f"Directional Credit Spread ({spread_type})",
        now_et=now_et,
        spot=spot,
        legs=legs,
        width=candidate.get("width"),
        credit=candidate.get("credit"),
        max_risk_points=candidate.get("max_loss_points"),
        pop_estimate=candidate.get("pop_delta"),
        risk_score=risk_score,
        vix=vix,
        ivr=ivr,
        emr=emr,
        atr_pct_emr=atr_pct_emr,
        vwap_distance=vwap_distance,
        range_pct_emr=range_pct_emr,
        reason=reason,
        checklist_summary=checklist_summary,
    )


def format_strategy_alert(
    strategy: str,
    now_et: dt.datetime,
    candidate: dict,
    risk_score: str,
    vix: Optional[float],
    ivr: Optional[float],
    emr: Optional[float],
    atr_pct_emr: Optional[float],
    vwap_distance: Optional[float],
    range_pct_emr: Optional[float] = None,
    spot: Optional[float] = None,
    reason: str = "Entry criteria met (NOT READY → READY).",
    checklist_summary: Optional[str] = None,
) -> str:
    strategy_upper = strategy.replace(" ", "_").upper()
    if strategy_upper == "IRON_CONDOR":
        return format_condor_entry_alert(
            candidate=candidate,
            now_et=now_et,
            spot=spot,
            risk_score=risk_score,
            vix=vix,
            ivr=ivr,
            emr=emr,
            atr_pct_emr=atr_pct_emr,
            vwap_distance=vwap_distance,
            range_pct_emr=range_pct_emr,
            reason=reason,
            checklist_summary=checklist_summary,
        )
    if strategy_upper == "IRON_FLY":
        return format_fly_entry_alert(
            candidate=candidate,
            now_et=now_et,
            spot=spot,
            risk_score=risk_score,
            vix=vix,
            ivr=ivr,
            emr=emr,
            atr_pct_emr=atr_pct_emr,
            vwap_distance=vwap_distance,
            range_pct_emr=range_pct_emr,
            reason=reason,
            checklist_summary=checklist_summary,
        )
    return format_credit_spread_entry_alert(
        candidate=candidate,
        now_et=now_et,
        spot=spot,
        risk_score=risk_score,
        vix=vix,
        ivr=ivr,
        emr=emr,
        atr_pct_emr=atr_pct_emr,
        vwap_distance=vwap_distance,
        range_pct_emr=range_pct_emr,
        reason=reason,
        checklist_summary=checklist_summary,
    )


def format_exit_alert(
    trade: dict,
    evaluation: dict,
    now_et: dt.datetime,
    now_paris: Optional[dt.datetime] = None,
    spot: Optional[float] = None,
) -> str:
    strategy = str(trade.get("strategy", "IRON_CONDOR")).replace("_", " ").title()
    strategy_key = str(trade.get("strategy", "IRON_CONDOR")).upper()
    spread_type = _pretty_spread_type(trade.get("spread_type"))
    reasons = evaluation.get("reasons") or []
    primary_reason = str(reasons[0]) if reasons else "Exit condition triggered."

    if strategy_key == "IRON_CONDOR":
        legs = build_condor_legs(trade)
    elif strategy_key == "IRON_FLY":
        legs = build_fly_legs(trade)
    else:
        legs = build_credit_spread_legs(trade)

    entry_time_et = _format_time_et(trade.get("entry_time_et"))
    now_et_label = _as_et(now_et).strftime("%H:%M:%S ET")
    now_paris_label = "-"
    if now_paris is not None:
        now_paris_label = _as_paris(now_paris).strftime("%H:%M:%S Paris")

    strategy_line = strategy
    if strategy_key == "CREDIT_SPREAD":
        strategy_line = f"{strategy} ({spread_type})"

    lines = [
        "*🔔 EXIT ALERT*",
        f"Strategy: {_escape_markdown(strategy_line)}",
        f"Time: {_escape_markdown(now_et_label)}",
        f"Paris: {_escape_markdown(now_paris_label)}",
        f"Entry: {_escape_markdown(entry_time_et)}",
        f"Spot: {_fmt_num(spot)}",
        "",
        format_option_legs(legs),
        "",
        f"Initial Credit: {_fmt_num(_to_float(trade.get('initial_credit')))}",
        f"Current Debit: {_fmt_num(_to_float(evaluation.get('current_debit')))}",
        f"Profit/Loss: {_fmt_pct(_to_float(evaluation.get('profit_pct')))}",
        f"POP: {_fmt_pct(_to_float(trade.get('pop_delta')))}",
        f"Reason: {_escape_markdown(primary_reason)}",
        "",
        _footer(now_et),
    ]
    return "\n".join(lines)


def _pretty_spread_type(spread_type: object) -> str:
    raw = str(spread_type or "CREDIT_SPREAD").strip().upper()
    if raw == "BULL_PUT_SPREAD":
        return "Bull Put Spread"
    if raw == "BEAR_CALL_SPREAD":
        return "Bear Call Spread"
    return raw.replace("_", " ").title()


def send_telegram_message(
    token: str,
    chat_id: str,
    text: str,
    parse_mode: str = "Markdown",
    timeout_s: float = 10.0,
    max_retries: int = 2,
) -> tuple[bool, Optional[str]]:
    if not token:
        return False, "missing TELEGRAM_BOT_TOKEN (or TELEGRAM_TOKEN)"
    if not chat_id:
        return False, "missing TELEGRAM_CHAT_ID"

    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {
        "chat_id": str(chat_id),
        "text": text,
        "parse_mode": parse_mode,
        "disable_web_page_preview": True,
    }

    attempt = 0
    while attempt <= max_retries:
        try:
            response = requests.post(url, json=payload, timeout=timeout_s)
        except requests.RequestException as exc:
            return False, f"request error: {exc}"

        if response.status_code == 200:
            try:
                data = response.json()
            except ValueError:
                return False, "invalid Telegram JSON response"
            if bool(data.get("ok")):
                return True, None
            return False, str(data.get("description", "Telegram API error"))

        if response.status_code == 429:
            retry_after = _extract_retry_after_seconds(response)
            if attempt >= max_retries:
                return False, f"rate limited (retry_after={retry_after}s)"
            time.sleep(max(1, retry_after))
            attempt += 1
            continue

        body = response.text.strip()
        return False, f"HTTP {response.status_code}: {body[:180]}"

    return False, "unknown Telegram send error"


def _format_entry_alert(
    strategy_name: str,
    now_et: dt.datetime,
    spot: Optional[float],
    legs: list[dict],
    width: Any,
    credit: Any,
    max_risk_points: Any,
    pop_estimate: Any,
    risk_score: str,
    vix: Optional[float],
    ivr: Optional[float],
    emr: Optional[float],
    atr_pct_emr: Optional[float],
    vwap_distance: Optional[float],
    range_pct_emr: Optional[float],
    reason: str,
    checklist_summary: Optional[str] = None,
) -> str:
    lines = [
        f"*🟢 SPX 0DTE {_escape_markdown(strategy_name.upper())} READY*",
        f"Time: {_escape_markdown(_as_et(now_et).strftime('%H:%M:%S ET'))}",
        f"Spot: {_fmt_num(spot)}",
        "",
        format_option_legs(legs),
        "",
        f"Width: {_fmt_width(width)}",
        f"Credit: {_fmt_num(_to_float(credit))}",
        f"Current Debit: -",
        f"Profit/Loss: -",
        f"Max Risk: {_fmt_num(_to_float(max_risk_points))}",
        f"POP: {_fmt_pct(_to_float(pop_estimate))}",
        "Volatility:",
        f"15m Range/EM: {_fmt_ratio(range_pct_emr)} {_check_mark(range_pct_emr, upper=0.35)}",
        f"VWAP Dist/EM: {_fmt_ratio(_ratio(vwap_distance, emr))} {_check_mark(_ratio(vwap_distance, emr), upper=0.40)}",
        f"ATR(1m)/EMR: {_fmt_ratio(atr_pct_emr)} {_check_mark(atr_pct_emr, upper=0.40)}",
        f"VIX: {_fmt_num(vix)} | IVR: {_fmt_num(ivr)} | EMR: {_fmt_num(emr)}",
        f"Risk Score: {_escape_markdown(str(risk_score).upper())}",
        f"Reason: {_escape_markdown(reason)}",
        f"Checklist: {_escape_markdown(checklist_summary or 'All strict required checks passed.')}",
        "",
        _footer(now_et),
    ]
    return "\n".join(lines)


def _extract_retry_after_seconds(response: requests.Response) -> int:
    try:
        payload = response.json()
    except ValueError:
        return 1

    params = payload.get("parameters") if isinstance(payload, dict) else None
    if isinstance(params, dict):
        retry_after = params.get("retry_after")
        try:
            return max(1, int(retry_after))
        except (TypeError, ValueError):
            return 1
    return 1


def _format_time_et(value: Any) -> str:
    if isinstance(value, str):
        try:
            parsed = dt.datetime.fromisoformat(value)
            return _as_et(parsed).strftime("%H:%M:%S ET")
        except ValueError:
            return "-"
    return "-"


def _footer(now_et: dt.datetime) -> str:
    ts_et = _as_et(now_et).strftime("%Y-%m-%d %H:%M:%S ET")
    ts_paris = _as_et(now_et).astimezone(PARIS).strftime("%Y-%m-%d %H:%M:%S Paris")
    return f"_Generated {ts_et} | {ts_paris} | {APP_NAME}_"


def _escape_markdown(value: Any) -> str:
    text = "" if value is None else str(value)
    text = text.replace("\\", "\\\\")
    for ch in ("_", "*", "[", "`"):
        text = text.replace(ch, f"\\{ch}")
    return text


def _to_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _fmt_num(value: Optional[float]) -> str:
    if value is None:
        return "-"
    return f"{value:.2f}"


def _fmt_width(value: Any) -> str:
    number = _to_float(value)
    if number is None:
        return "-"
    if abs(number - round(number)) < 1e-9:
        return f"{int(round(number))}"
    return f"{number:.2f}"


def _fmt_strike(value: Any) -> str:
    strike = _to_float(value)
    if strike is None:
        return "-"
    if abs(strike - round(strike)) < 1e-9:
        return f"{int(round(strike))}"
    return f"{strike:.2f}"


def _fmt_delta(value: Any) -> str:
    delta = _to_float(value)
    if delta is None:
        return "-"
    return f"{delta:+.2f}"


def _fmt_pct(value: Optional[float]) -> str:
    if value is None:
        return "-"
    return f"{value * 100.0:.0f}%"


def _fmt_ratio(value: Optional[float]) -> str:
    if value is None:
        return "-"
    return f"{value:.2f}"


def _check_mark(value: Optional[float], upper: float) -> str:
    if value is None:
        return "-"
    return "✔" if value < upper else "✖"


def _ratio(numerator: Optional[float], denominator: Optional[float]) -> Optional[float]:
    if numerator is None or denominator in (None, 0):
        return None
    return numerator / denominator


def _as_et(value: dt.datetime) -> dt.datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=ET)
    return value.astimezone(ET)


def _as_paris(value: dt.datetime) -> dt.datetime:
    return _as_et(value).astimezone(PARIS)
