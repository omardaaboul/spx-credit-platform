from __future__ import annotations

import datetime as dt
import os
from typing import Optional
from zoneinfo import ZoneInfo

import pandas as pd
import streamlit as st

try:
    from dotenv import load_dotenv
except Exception:
    def load_dotenv() -> bool:
        return False

from alerts.telegram import format_exit_alert, format_strategy_alert, send_telegram_message
from data.tasty import MarketSnapshot, TastyDataClient
from signals.filters import (
    GateCheck,
    all_pass,
    build_global_gates,
    build_intraday_gates,
    classify_trend_direction,
    compute_emr,
    compute_full_day_em,
    compute_trend_slope_points_per_min,
    minutes_to_close,
    risk_score,
)
from storage.state import AlertStateStore
from storage.macro_calendar import events_for_date, load_macro_events, upcoming_events
from strategies.condor import find_iron_condor_candidate
from strategies.credit_spreads import find_directional_credit_spread_candidate
from strategies.exit import build_option_lookup, evaluate_trade_exit
from strategies.fly import find_iron_fly_candidate

st.set_page_config(page_title="SPX 0DTE Sustainable Alerts", page_icon="📉", layout="wide")
load_dotenv()

ET = ZoneInfo("America/New_York")
PARIS = ZoneInfo("Europe/Paris")


@st.cache_resource
def get_client() -> TastyDataClient:
    return TastyDataClient(symbol="SPX")


def get_state_store() -> AlertStateStore:
    return AlertStateStore(path="storage/.alert_state.json")


def main() -> None:
    st.title("SPX Credit Spreads")
    st.caption("Manual execution only. Minimal directional credit spread dashboard.")

    st.markdown(
        """
        <style>
            header, footer {display: none;}
            .stApp {background-color: #f5f7fa; font-family: 'Segoe UI', sans-serif;}
        </style>
        """,
        unsafe_allow_html=True,
    )

    controls = render_sidebar()
    store = get_state_store()
    client = get_client()

    with st.spinner("Fetching tastytrade snapshot..."):
        snapshot = client.fetch_snapshot(symbol="SPX", candle_lookback_minutes=420)

    now_et = snapshot.timestamp_et.astimezone(ET)
    now_paris = now_et.astimezone(PARIS)
    iv_input = snapshot.atm_iv if snapshot.atm_iv is not None else snapshot.expiration_iv
    minutes_remaining = minutes_to_close(now_et)
    emr = compute_emr(snapshot.spot, iv_input, minutes_remaining)
    full_day_em = compute_full_day_em(snapshot.spot, iv_input)

    global_checks = build_global_gates(
        current_et=now_et,
        loss_today=controls["loss_today"],
        vix=snapshot.vix,
        vix_change_pct=snapshot.vix_change_pct,
        open_price=snapshot.open_price,
        prior_close=snapshot.prior_close,
        macro_events_today=[],
    )
    intraday_stats, intraday_checks = build_intraday_gates(
        spot=snapshot.spot,
        emr=emr,
        full_day_em=full_day_em,
        candles=snapshot.candles_1m,
    )

    trend_slope = compute_trend_slope_points_per_min(snapshot.candles_1m, lookback=30)
    trend_direction = classify_trend_direction(trend_slope, threshold=controls["slope_threshold"])

    credit_eval = find_directional_credit_spread_candidate(
        options=snapshot.options,
        spot=snapshot.spot,
        emr=emr,
        full_day_em=full_day_em,
        now_et=now_et,
        trend_slope_points_per_min=trend_slope,
        range_15m=intraday_stats.get("range_15m"),
        widths=controls["widths"],
        trend_slope_threshold=controls["slope_threshold"],
    )

    if not (all_pass(global_checks) and all_pass(intraday_checks)):
        fail_reasons = [f"{g.name}: {g.detail}" for g in (global_checks + intraday_checks) if not g.passed]
        credit_eval = force_not_ready(credit_eval, fail_reasons)

    candidate = credit_eval.get("candidate") if isinstance(credit_eval, dict) else None
    candidate_ready = bool(credit_eval.get("ready") and candidate)
    reasons = list(credit_eval.get("reasons", [])) if isinstance(credit_eval, dict) else ["Candidate unavailable."]

    # Top metrics bar: time, spot, EMR, VIX
    col_time, col_spot, col_emr, col_vix = st.columns(4)
    col_time.metric("Time (Paris)", now_paris.strftime("%H:%M:%S"))
    col_spot.metric("SPX Spot", f"{snapshot.spot:,.2f}" if snapshot.spot is not None else "-")
    col_emr.metric("EMR (pts)", f"{emr:.2f}" if emr is not None else "-")
    col_vix.metric("VIX", f"{snapshot.vix:.2f}" if snapshot.vix is not None else "-")

    # Direction overview
    with st.container():
        st.subheader("Market Trend")
        c1, c2, c3 = st.columns(3)
        c1.metric("Trend", trend_direction)
        c2.metric("Slope", f"{trend_slope:.2f} pts/min" if trend_slope is not None else "-")
        recommendation = "Bull Put" if trend_direction == "UP" else "Bear Call" if trend_direction == "DOWN" else "None"
        c3.metric("Recommended", recommendation)
        st.caption(f"Slope threshold: {controls['slope_threshold']:.2f} pts/min")

    # Candidate card
    with st.container():
        st.subheader("Credit Spread Candidate")
        if candidate_ready and isinstance(candidate, dict):
            spread_type = str(candidate.get("spread_type", "CREDIT_SPREAD")).upper()
            spread_label = "Bull Put Spread" if spread_type == "BULL_PUT_SPREAD" else "Bear Call Spread"
            short_strike = _to_float(candidate.get("short_strike"))
            long_strike = _to_float(candidate.get("long_strike"))
            credit = _to_float(candidate.get("credit")) or 0.0
            width = int(_to_float(candidate.get("width")) or 0)
            max_loss = _to_float(candidate.get("max_loss_dollars")) or 0.0
            pop_delta = _to_float(candidate.get("pop_delta")) or 0.0
            breakeven = None
            if short_strike is not None:
                breakeven = short_strike - credit if spread_type == "BULL_PUT_SPREAD" else short_strike + credit

            st.write(f"**Spread Type:** {spread_label}")
            st.write(f"**Strikes:** Short {fmt(short_strike)} / Long {fmt(long_strike)}")
            st.write(f"**Credit:** {credit:.2f} pts  |  **Width:** {width} pts")
            st.write(f"**Max Loss:** ${max_loss:,.0f}  |  **POP:** {pop_delta * 100:.1f}%")
            st.write(f"**Breakeven:** {fmt(breakeven)}")

            if st.button("Confirm Entry", type="primary", use_container_width=False):
                trade = store.add_trade(
                    strategy="CREDIT_SPREAD",
                    now_et=now_et,
                    payload=build_trade_payload("CREDIT_SPREAD", candidate),
                )
                st.success(f"Trade confirmed: {trade['trade_id']} ({spread_label})")
        else:
            st.info("No valid credit spread candidate at the moment.")
            for reason in reasons[:3]:
                st.write(f"- {reason}")

    # Open trades summary
    st.subheader("Open Trades")
    open_trades = _store_get_trades(store, statuses=["open", "exit_pending"])
    if not open_trades:
        st.write("You have no open trades.")
    else:
        rows: list[dict] = []
        for trade in open_trades:
            rows.append(
                {
                    "Trade ID": trade.get("trade_id", "-"),
                    "Type": trade.get("strategy", "-"),
                    "Entry": _format_iso_time(trade.get("entry_time_et")),
                    "P/L %": fmt_pct(_to_float(trade.get("profit_pct"))),
                    "Time (min)": "-" if _to_float(trade.get("time_in_trade_min")) is None else f"{_to_float(trade.get('time_in_trade_min')):.0f}",
                    "Status": trade.get("status", "-"),
                }
            )
        open_trades_df = pd.DataFrame(rows)
        st.table(open_trades_df[["Trade ID", "Type", "Entry", "P/L %", "Time (min)", "Status"]])

    st.caption(f"Last refresh: {now_et.strftime('%H:%M:%S')} ET / {now_paris.strftime('%H:%M:%S')} Paris")


def render_sidebar() -> dict:
    st.sidebar.header("Settings")
    nlv = st.sidebar.number_input("Account NLV ($)", min_value=1_000.0, value=100_000.0, step=1_000.0)
    risk_pct = st.sidebar.slider("Risk per trade (%)", 0.1, 5.0, 1.0, 0.1)
    widths = st.sidebar.multiselect("Spread widths (pts)", [25, 50, 75], default=[25, 50])
    slope_threshold = st.sidebar.slider("Trend slope threshold", 0.05, 0.50, 0.20, 0.05)
    loss_today = st.sidebar.checkbox("LOSS_TODAY", value=False)
    st.sidebar.caption("Only essential controls are shown. Advanced options are intentionally hidden.")

    return {
        "nlv": nlv,
        "risk_pct": float(risk_pct),
        "widths": widths or [25, 50],
        "slope_threshold": float(slope_threshold),
        "loss_today": bool(loss_today),
    }


def render_warnings(snapshot: MarketSnapshot) -> None:
    if not snapshot.warnings:
        return
    for warning in snapshot.warnings:
        st.warning(warning)


def render_top_banner(
    snapshot: MarketSnapshot,
    now_et: dt.datetime,
    now_paris: dt.datetime,
    emr: Optional[float],
    atm_iv: Optional[float],
    full_day_em: Optional[float],
    intraday_stats: dict,
) -> None:
    vix_text = "-"
    if snapshot.vix is not None:
        vix_text = f"{snapshot.vix:.2f}"
        if snapshot.vix_change_pct is not None:
            vix_text += f" ({snapshot.vix_change_pct:+.2f}%)"

    cols = st.columns(4)
    cols[0].metric("Time (Paris)", now_paris.strftime("%H:%M:%S"))
    cols[1].metric("SPX Spot", fmt(snapshot.spot))
    cols[2].metric("EMR", fmt(emr))
    cols[3].metric("VIX", vix_text)
    st.caption(f"Market time reference: {now_et.strftime('%H:%M:%S ET')}")

    with st.expander("Market Detail", expanded=False):
        d1, d2, d3, d4 = st.columns(4)
        d1.metric("VWAP", fmt(intraday_stats.get("vwap")))
        d2.metric("15m Range", fmt(intraday_stats.get("range_15m")))
        d3.metric("ATR(1m,5)", fmt(intraday_stats.get("atr_1m")))
        d4.metric("ATM IV (annualized)", fmt_pct(atm_iv))

        if snapshot.spot not in (None, 0) and full_day_em is not None:
            exp_move_pct = full_day_em / snapshot.spot
        else:
            exp_move_pct = None

        e1, e2 = st.columns(2)
        e1.metric("Expected Move (full day, pts)", fmt(full_day_em))
        e2.metric("Expected Move (full day, %)", fmt_pct(exp_move_pct))


def render_candidate_panel(
    title: str,
    strategy_key: str,
    result: dict,
    risk_budget: float,
    exit_text: str,
) -> bool:
    confirm_clicked = False
    with st.container(border=True):
        st.subheader(title)
        if result.get("ready") and result.get("candidate"):
            candidate = result["candidate"]
            st.success("READY")
            if candidate.get("spread_type") in {"BULL_PUT_SPREAD", "BEAR_CALL_SPREAD"}:
                right = "PUT" if candidate.get("spread_type") == "BULL_PUT_SPREAD" else "CALL"
                strike_text = f"{right} {candidate.get('short_strike')}/{candidate.get('long_strike')}"
                lower_be = None
                upper_be = None
            elif "short_put" in candidate:
                strike_text = (
                    f"P {candidate['long_put']}/{candidate['short_put']} | "
                    f"C {candidate['short_call']}/{candidate['long_call']}"
                )
                lower_be = (candidate["short_put"] - candidate["credit"]) if candidate.get("credit") is not None else None
                upper_be = (candidate["short_call"] + candidate["credit"]) if candidate.get("credit") is not None else None
            else:
                strike_text = (
                    f"P {candidate['long_put']}/{candidate['short_strike']} | "
                    f"C {candidate['short_strike']}/{candidate['long_call']}"
                )
                lower_be = (candidate["short_strike"] - candidate["credit"]) if candidate.get("credit") is not None else None
                upper_be = (candidate["short_strike"] + candidate["credit"]) if candidate.get("credit") is not None else None

            st.write(f"Strikes: {strike_text}")
            if candidate.get("spread_type") in {"BULL_PUT_SPREAD", "BEAR_CALL_SPREAD"}:
                st.write(
                    "Short/Long deltas: "
                    f"{fmt(candidate.get('short_delta'))} / {fmt(candidate.get('long_delta'))}"
                )
                st.write(f"Spread type: {candidate.get('spread_type')}")
            else:
                st.write(
                    "Short-leg deltas: "
                    f"Put {fmt(candidate.get('short_put_delta'))} | "
                    f"Call {fmt(candidate.get('short_call_delta'))}"
                )
                st.write(f"Breakevens (approx): {fmt(lower_be)} to {fmt(upper_be)}")

            k1, k2, k3, k4, k5 = st.columns(5)
            k1.metric("Credit (pts)", fmt(candidate.get("credit")))
            k2.metric("Width", str(candidate.get("width", "-")))
            k3.metric("Max Loss ($/1-lot)", f"${candidate.get('max_loss_dollars', 0.0):,.0f}")
            k4.metric("POP (delta %)", fmt_pct(candidate.get("pop_delta")))
            k5.metric("POP (price %)", fmt_pct(candidate.get("pop_price")))

            with st.expander("More setup details", expanded=False):
                st.write(f"Liquidity ratio: {fmt(candidate.get('liquidity_ratio'))}")
                st.write(f"Credit / Max Loss: {fmt(candidate.get('credit_to_max_loss'))}")

            max_loss_dollars = float(candidate.get("max_loss_dollars", 0.0))
            contracts = int(risk_budget // max_loss_dollars) if max_loss_dollars > 0 else 0
            st.write(f"Position size (informational): up to {contracts} contracts by risk budget")
            confirm_clicked = st.button(
                "Confirm Entry",
                key=f"confirm_entry_{strategy_key}",
                help="Click only after you manually entered this trade.",
            )
        else:
            st.error("NOT READY")
            reasons = result.get("reasons") or ["No candidate."]
            for reason in reasons[:3]:
                st.write(f"- {reason}")
            if len(reasons) > 3:
                with st.expander("Show all reasons", expanded=False):
                    for reason in reasons:
                        st.write(f"- {reason}")

        criteria = result.get("criteria", [])
        if criteria:
            with st.expander("Live strategy criteria", expanded=False):
                for item in criteria:
                    st.write(
                        f"{status_icon(bool(item.get('passed')))} "
                        f"{item.get('name', 'criterion')} - {item.get('detail', '')}"
                    )

        st.caption(exit_text)
    return confirm_clicked


def handle_entry_alerts(
    store: AlertStateStore,
    now_et,
    snapshot: MarketSnapshot,
    emr: Optional[float],
    intraday_stats: dict,
    condor_eval: dict,
    fly_eval: dict,
    credit_spread_eval: dict,
    alerts_enabled: bool,
    loss_today: bool,
) -> None:
    token = os.getenv("TELEGRAM_BOT_TOKEN", "") or os.getenv("TELEGRAM_TOKEN", "")
    chat_id = os.getenv("TELEGRAM_CHAT_ID", "")
    has_telegram = bool(token and chat_id)

    strategy_payloads = [
        ("IRON_CONDOR", "IRON CONDOR", condor_eval),
        ("IRON_FLY", "IRON FLY", fly_eval),
        ("CREDIT_SPREAD", "DIRECTIONAL CREDIT SPREAD", credit_spread_eval),
    ]

    for strategy_key, strategy_name, result in strategy_payloads:
        is_ready = bool(result.get("ready") and result.get("candidate"))
        should_send, reason = store.evaluate_transition(
            strategy=strategy_key,
            is_ready=is_ready,
            now_et=now_et,
            cooldown_seconds=300,
            alerts_enabled=alerts_enabled and has_telegram,
            loss_today=loss_today,
        )
        if not should_send:
            continue

        candidate = result["candidate"]
        score = risk_score(
            atr_1m=intraday_stats.get("atr_1m"),
            emr=emr,
            vwap_distance=intraday_stats.get("vwap_distance"),
            pop_delta=candidate.get("pop_delta"),
        )
        reason_text = "Entry criteria met (NOT READY → READY)."
        if strategy_key == "CREDIT_SPREAD":
            spread_type = str(candidate.get("spread_type", "CREDIT_SPREAD")).replace("_", " ")
            reason_text = f"{spread_type}: trend filter and directional spread rules passed."
        alert_text = format_strategy_alert(
            strategy=strategy_name,
            now_et=now_et,
            candidate=candidate,
            risk_score=score,
            vix=snapshot.vix,
            ivr=snapshot.iv_rank,
            emr=emr,
            atr_pct_emr=intraday_stats.get("atr_pct_emr"),
            vwap_distance=intraday_stats.get("vwap_distance"),
            range_pct_emr=(
                _to_float(intraday_stats.get("range_15m")) / emr
                if emr not in (None, 0) and _to_float(intraday_stats.get("range_15m")) is not None
                else None
            ),
            spot=snapshot.spot,
            reason=reason_text,
        )

        sent, err = send_telegram_message(token=token, chat_id=chat_id, text=alert_text)
        if sent:
            store.mark_sent(strategy=strategy_key, now_et=now_et)
            st.success(f"Telegram alert sent for {strategy_name}.")
        else:
            st.warning(f"Telegram alert failed for {strategy_name}: {err} ({reason})")


def build_trade_payload(strategy: str, candidate: dict) -> dict:
    payload = {
        "initial_credit": candidate.get("credit"),
        "width": candidate.get("width"),
        "short_put_delta": candidate.get("short_put_delta"),
        "short_call_delta": candidate.get("short_call_delta"),
        "long_put_delta": candidate.get("long_put_delta"),
        "long_call_delta": candidate.get("long_call_delta"),
        "short_delta": candidate.get("short_delta"),
        "long_delta": candidate.get("long_delta"),
        "spread_type": candidate.get("spread_type"),
        "pop_delta": candidate.get("pop_delta"),
    }
    if strategy in {"IRON_CONDOR", "IRON_FLY", "CREDIT_SPREAD"}:
        payload["rolloverPolicy"] = "INTRADAY_AUTO_CLOSE"
    elif strategy in {"2_DTE_CREDIT_SPREAD", "TWO_DTE_CREDIT_SPREAD", "BROKEN_WING_PUT_BUTTERFLY", "BWB"}:
        payload["rolloverPolicy"] = "PERSIST_UNTIL_EXIT"

    if strategy == "IRON_CONDOR":
        payload.update(
            {
                "short_put": candidate.get("short_put"),
                "long_put": candidate.get("long_put"),
                "short_call": candidate.get("short_call"),
                "long_call": candidate.get("long_call"),
            }
        )
    elif strategy == "IRON_FLY":
        payload.update(
            {
                "short_strike": candidate.get("short_strike"),
                "short_put": candidate.get("short_strike"),
                "short_call": candidate.get("short_strike"),
                "long_put": candidate.get("long_put"),
                "long_call": candidate.get("long_call"),
            }
        )
    elif strategy == "CREDIT_SPREAD":
        payload.update(
            {
                "short_right": candidate.get("short_right"),
                "long_right": candidate.get("long_right"),
                "short_strike": candidate.get("short_strike"),
                "long_strike": candidate.get("long_strike"),
            }
        )
    return payload


def monitor_open_trades(
    store: AlertStateStore,
    now_et: dt.datetime,
    now_paris: dt.datetime,
    snapshot: MarketSnapshot,
    emr: Optional[float],
    intraday_stats: dict,
    controls: dict,
) -> None:
    token = os.getenv("TELEGRAM_BOT_TOKEN", "") or os.getenv("TELEGRAM_TOKEN", "")
    chat_id = os.getenv("TELEGRAM_CHAT_ID", "")
    has_telegram = bool(token and chat_id)

    open_trades = _store_get_trades(store, statuses=["open", "exit_pending"])
    if not open_trades:
        st.caption("No open trades. Confirm an entry from a READY setup to start exit monitoring.")
        return

    option_lookup = build_option_lookup(snapshot.options)
    exit_config = {
        "profit_threshold_condor": controls["profit_threshold_condor"],
        "profit_threshold_fly": controls["profit_threshold_fly"],
        "profit_threshold_credit": controls["profit_threshold_credit"],
        "max_hold_condor_min": controls["max_hold_condor_min"],
        "max_hold_fly_min": controls["max_hold_fly_min"],
        "max_hold_credit_min": controls["max_hold_credit_min"],
        "enable_ten_cent_bid_exit": controls["enable_ten_cent_bid_exit"],
        "enable_peg_exit": controls["enable_peg_exit"],
        "condor_distance_mult": 0.80,
        "credit_short_buffer_mult": 0.20,
        "condor_range_exit_mult": 0.60,
        "atr_spike_points": 8.0,
    }

    evaluations: dict[str, dict] = {}
    rows: list[dict] = []

    for trade in open_trades:
        trade_id = str(trade.get("trade_id"))
        evaluation = evaluate_trade_exit(
            trade=trade,
            now_et=now_et,
            spot=snapshot.spot,
            option_lookup=option_lookup,
            emr=emr,
            intraday_stats=intraday_stats,
            config=exit_config,
        )
        evaluations[trade_id] = evaluation

        store.update_trade(
            trade_id,
            {
                "current_debit": evaluation.get("current_debit"),
                "profit_pct": evaluation.get("profit_pct"),
                "time_in_trade_min": evaluation.get("time_in_trade_min"),
                "last_eval_et": now_et.isoformat(),
                "next_exit_reason": evaluation.get("next_exit_reason"),
            },
        )

        trade_status = str(trade.get("status", "open"))
        if evaluation.get("should_exit") and trade_status == "open":
            reason = "; ".join(evaluation.get("reasons", [])[:3])
            store.mark_exit_pending(trade_id=trade_id, now_et=now_et, reason=reason)
            trade_status = "exit_pending"

            can_send, note = store.can_send_exit_alert(
                trade_id=trade_id,
                now_et=now_et,
                cooldown_seconds=int(controls["exit_alert_cooldown_min"]) * 60,
                alerts_enabled=controls["enable_exit_alerts"] and has_telegram,
                loss_today=controls["loss_today"],
            )
            if can_send:
                msg = format_exit_alert(
                    trade=store.get_trade(trade_id) or trade,
                    evaluation=evaluation,
                    now_et=now_et,
                    now_paris=now_paris,
                    spot=snapshot.spot,
                )
                sent, err = send_telegram_message(token=token, chat_id=chat_id, text=msg)
                if sent:
                    store.mark_exit_alert_sent(trade_id=trade_id, now_et=now_et)
                    st.warning(f"Exit alert sent for {trade_id}.")
                else:
                    st.warning(f"Exit alert failed for {trade_id}: {err}")
            else:
                st.caption(f"Exit alert skipped for {trade_id}: {note}")

        entry_paris = _format_iso_time(trade.get("entry_time_paris"))
        status_label = _status_label(trade_status, evaluation)

        rows.append(
            {
                "Trade ID": trade_id,
                "Strategy": str(trade.get("strategy", "")).replace("_", " "),
                "Entry (Paris)": entry_paris,
                "P/L %": fmt_pct(_to_float(evaluation.get("profit_pct"))),
                "Time (min)": int(_to_float(evaluation.get("time_in_trade_min")) or 0),
                "Status": status_label,
                "Next Exit Reason": evaluation.get("next_exit_reason", "-"),
            }
        )

    st.dataframe(pd.DataFrame(rows), width="stretch", hide_index=True)

    st.markdown("**Manual Trade Controls**")
    for trade in open_trades:
        trade_id = str(trade.get("trade_id"))
        cols = st.columns([3, 2, 2, 2])
        cols[0].write(f"{trade_id} - {str(trade.get('strategy', '')).replace('_', ' ')}")
        close_clicked = cols[1].button("Mark Closed", key=f"close_{trade_id}")
        if close_clicked:
            store.close_trade(trade_id=trade_id, now_et=now_et, reason="manual close")
            st.success(f"{trade_id} marked as closed.")
            st.rerun()
        if str(trade.get("status")) == "exit_pending":
            cols[2].write("Exit pending")
        else:
            cols[2].write("Open")

    selected = st.selectbox(
        "Selected trade exit gates",
        options=[row["Trade ID"] for row in rows],
        key="selected_trade_exit_gates",
    )
    if selected in evaluations:
        st.markdown("**Exit Gates (selected trade)**")
        for crit in evaluations[selected].get("criteria", []):
            st.write(
                f"{status_icon(bool(crit.get('passed')))} "
                f"{crit.get('name', 'criterion')} - {crit.get('detail', '-')}"
            )


def force_not_ready(result: dict, extra_reasons: list[str]) -> dict:
    reasons = list(result.get("reasons", []))
    reasons.extend(extra_reasons)

    deduped: list[str] = []
    seen: set[str] = set()
    for reason in reasons:
        if reason not in seen:
            seen.add(reason)
            deduped.append(reason)

    return {
        "ready": False,
        "candidate": None,
        "reasons": deduped,
        "criteria": result.get("criteria", []),
    }


def _directional_exposure_block_reason(store: AlertStateStore) -> Optional[str]:
    open_trades = _store_get_trades(store, statuses=["open", "exit_pending"])
    directional = [
        t for t in open_trades if str(t.get("strategy", "")).upper() == "CREDIT_SPREAD"
    ]
    if directional:
        return "Directional exposure already open; skip overlapping directional bet."
    return None


def _directional_recommendation(trend_direction: str) -> str:
    if trend_direction == "UP":
        return "Bull Put Spread"
    if trend_direction == "DOWN":
        return "Bear Call Spread"
    return "None (trend not strong enough)"


def _directional_status(base_ready: bool, directional_eval: dict, trend_direction: str) -> str:
    if directional_eval.get("ready"):
        return "READY"
    if not base_ready:
        return "NO TRADE"
    if trend_direction in {"UP", "DOWN"}:
        return "WAIT"
    return "NO TRADE"


def render_gate_checklist(title: str, checks: list[GateCheck]) -> None:
    st.markdown(f"**{title}**")
    for gate in checks:
        st.write(f"{status_icon(gate.passed)} {gate.name} - {gate.detail}")


def status_icon(passed: bool) -> str:
    return "✅" if passed else "❌"


def _status_label(trade_status: str, evaluation: dict) -> str:
    if trade_status == "exit_pending":
        if evaluation.get("severity") == "RED":
            return "🔴 EXIT NOW"
        return "🟠 EXIT PENDING"
    if evaluation.get("severity") == "RED":
        return "🔴 RISK"
    if evaluation.get("severity") == "AMBER":
        return "🟠 WATCH"
    return "🟢 OPEN"


def _format_iso_time(value: object) -> str:
    if not isinstance(value, str) or not value:
        return "-"
    try:
        parsed = dt.datetime.fromisoformat(value)
    except ValueError:
        return "-"
    return parsed.strftime("%H:%M:%S")


def _to_float(value: object) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _store_get_trades(store: AlertStateStore, statuses: list[str]) -> list[dict]:
    getter = getattr(store, "get_trades", None)
    if callable(getter):
        try:
            return getter(statuses=statuses)
        except Exception:
            return []

    # Backward-compatible fallback for stale in-memory objects.
    raw_state = getattr(store, "state", {})
    if not isinstance(raw_state, dict):
        return []
    trades = raw_state.get("trades", [])
    if not isinstance(trades, list):
        return []
    allowed = set(statuses)
    return [t for t in trades if isinstance(t, dict) and t.get("status") in allowed]


def fmt(value: Optional[float]) -> str:
    if value is None:
        return "-"
    return f"{value:.2f}"


def fmt_pct(value: Optional[float]) -> str:
    if value is None:
        return "-"
    return f"{value * 100.0:.1f}%"


if __name__ == "__main__":
    main()
