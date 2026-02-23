from __future__ import annotations

import datetime as dt
import json
import os
from pathlib import Path
import sys
from typing import Any, Optional
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from data.tasty import CandleBar, TastyDataClient
from signals.filters import (
    build_intraday_gates,
    compute_emr,
    compute_full_day_em,
    compute_trend_slope_points_per_min,
    minutes_to_close,
)
from storage.macro_calendar import load_macro_events
from strategies.condor import find_iron_condor_candidate
from strategies.convex import find_convex_debit_spread_candidate
from strategies.credit_spreads import find_directional_credit_spread_candidate
from strategies.fly import find_iron_fly_candidate
from strategies.bwb_credit_put import (
    BwbSettings,
    evaluate_broken_wing_put_butterfly,
    monitor_bwb_position,
)
from strategies.two_dte_credit import TwoDteSettings, evaluate_two_dte_credit_spread

ET = ZoneInfo("America/New_York")
PARIS = ZoneInfo("Europe/Paris")

STATE_PATH = Path("storage/.alert_state.json")
VOL_STATE_PATH = Path("storage/.vol_expansion_state.json")
SLEEVE_SETTINGS_PATH = Path("storage/.sleeve_settings.json")
EXECUTION_MODEL_PATH = Path("storage/.execution_model.json")
TWO_DTE_SETTINGS_PATH = Path("storage/.two_dte_settings.json")
TWO_DTE_STATE_PATH = Path("storage/.two_dte_state.json")
BWB_SETTINGS_PATH = Path("storage/.bwb_settings.json")
BWB_STATE_PATH = Path("storage/.bwb_state.json")

VALID_REGIMES = {"COMPRESSION", "CHOP", "TREND_UP", "TREND_DOWN", "EXPANSION"}


def _default_execution_model_settings() -> dict:
    return {
        "enabled": True,
        "narrowWidthCutoff": 50.0,
        "creditOffsetNarrow": 0.15,
        "creditOffsetWide": 0.20,
        "debitOffsetNarrow": 0.10,
        "debitOffsetWide": 0.15,
        "markImpactPct": 0.03,
        "openBucketMultiplier": 1.20,
        "midBucketMultiplier": 1.00,
        "lateBucketMultiplier": 1.15,
        "closeBucketMultiplier": 1.30,
    }


def _load_execution_model_settings(path: Path = EXECUTION_MODEL_PATH) -> dict:
    defaults = _default_execution_model_settings()
    if not path.exists():
        return defaults
    try:
        raw = json.loads(path.read_text())
    except Exception:
        return defaults
    if not isinstance(raw, dict):
        return defaults

    out = dict(defaults)
    for key in (
        "narrowWidthCutoff",
        "creditOffsetNarrow",
        "creditOffsetWide",
        "debitOffsetNarrow",
        "debitOffsetWide",
        "markImpactPct",
        "openBucketMultiplier",
        "midBucketMultiplier",
        "lateBucketMultiplier",
        "closeBucketMultiplier",
    ):
        parsed = _to_float(raw.get(key))
        if parsed is not None:
            out[key] = parsed
    if isinstance(raw.get("enabled"), bool):
        out["enabled"] = bool(raw.get("enabled"))

    out["narrowWidthCutoff"] = max(10.0, min(150.0, float(out["narrowWidthCutoff"])))
    out["creditOffsetNarrow"] = max(0.01, min(2.0, float(out["creditOffsetNarrow"])))
    out["creditOffsetWide"] = max(0.01, min(3.0, float(out["creditOffsetWide"])))
    out["debitOffsetNarrow"] = max(0.01, min(2.0, float(out["debitOffsetNarrow"])))
    out["debitOffsetWide"] = max(0.01, min(3.0, float(out["debitOffsetWide"])))
    out["markImpactPct"] = max(0.0, min(0.5, float(out["markImpactPct"])))
    out["openBucketMultiplier"] = max(0.5, min(2.0, float(out["openBucketMultiplier"])))
    out["midBucketMultiplier"] = max(0.5, min(2.0, float(out["midBucketMultiplier"])))
    out["lateBucketMultiplier"] = max(0.5, min(2.0, float(out["lateBucketMultiplier"])))
    out["closeBucketMultiplier"] = max(0.5, min(2.5, float(out["closeBucketMultiplier"])))
    return out


def _default_sleeve_settings() -> dict:
    sleeve_capital = _env_float("SPX0DTE_SLEEVE_CAPITAL", 10_000.0)
    return {
        "sleeve_capital": sleeve_capital,
        "total_account": _env_float("SPX0DTE_TOTAL_ACCOUNT", 160_000.0),
        "max_drawdown_pct": _env_float("SPX0DTE_MAX_DRAWDOWN_PCT", 15.0),
        "daily_realized_pnl": _env_float("SPX0DTE_DAILY_REALIZED_PNL", 0.0),
        "weekly_realized_pnl": _env_float("SPX0DTE_WEEKLY_REALIZED_PNL", 0.0),
        "daily_lock": _env_bool("SPX0DTE_DAILY_LOCK", False),
        "weekly_lock": _env_bool("SPX0DTE_WEEKLY_LOCK", False),
    }


def _load_sleeve_settings(path: Path = SLEEVE_SETTINGS_PATH) -> dict:
    settings = _default_sleeve_settings()
    if not path.exists():
        return settings
    try:
        raw = json.loads(path.read_text())
    except Exception:
        return settings
    if not isinstance(raw, dict):
        return settings

    sleeve_cap = _to_float(raw.get("sleeve_capital"))
    total_account = _to_float(raw.get("total_account"))
    max_dd = _to_float(raw.get("max_drawdown_pct"))
    daily_pnl = _to_float(raw.get("daily_realized_pnl"))
    weekly_pnl = _to_float(raw.get("weekly_realized_pnl"))

    if sleeve_cap is not None and sleeve_cap > 0:
        settings["sleeve_capital"] = sleeve_cap
    if total_account is not None and total_account > 0:
        settings["total_account"] = total_account
    if max_dd is not None and max_dd >= 0:
        settings["max_drawdown_pct"] = max_dd
    if daily_pnl is not None:
        settings["daily_realized_pnl"] = daily_pnl
    if weekly_pnl is not None:
        settings["weekly_realized_pnl"] = weekly_pnl
    if isinstance(raw.get("daily_lock"), bool):
        settings["daily_lock"] = bool(raw.get("daily_lock"))
    if isinstance(raw.get("weekly_lock"), bool):
        settings["weekly_lock"] = bool(raw.get("weekly_lock"))
    return settings


def _to_float(value: object) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _to_int(value: object, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _load_two_dte_settings(path: Path = TWO_DTE_SETTINGS_PATH) -> TwoDteSettings:
    defaults = TwoDteSettings()
    if not path.exists():
        return defaults
    try:
        raw = json.loads(path.read_text())
    except Exception:
        return defaults
    if not isinstance(raw, dict):
        return defaults
    try:
        return TwoDteSettings(
            enabled=bool(raw.get("enabled", defaults.enabled)),
            width=max(5, _to_int(raw.get("width"), defaults.width)),
            short_delta_min=float(raw.get("short_delta_min", defaults.short_delta_min)),
            short_delta_max=float(raw.get("short_delta_max", defaults.short_delta_max)),
            auto_select_params=bool(raw.get("auto_select_params", defaults.auto_select_params)),
            min_strike_distance=float(raw.get("min_strike_distance", defaults.min_strike_distance)),
            max_strike_distance=float(raw.get("max_strike_distance", defaults.max_strike_distance)),
            min_credit=float(raw.get("min_credit", defaults.min_credit)),
            max_credit=float(raw.get("max_credit", defaults.max_credit)),
            use_delta_stop=bool(raw.get("use_delta_stop", defaults.use_delta_stop)),
            delta_stop=float(raw.get("delta_stop", defaults.delta_stop)),
            stop_multiple=float(raw.get("stop_multiple", defaults.stop_multiple)),
            profit_take_debit=float(raw.get("profit_take_debit", defaults.profit_take_debit)),
            require_measured_move=bool(raw.get("require_measured_move", defaults.require_measured_move)),
            min_30m_bars=min(18, max(6, _to_int(raw.get("min_30m_bars"), defaults.min_30m_bars))),
            allow_catalyst=bool(raw.get("allow_catalyst", defaults.allow_catalyst)),
        )
    except Exception:
        return defaults


def _load_two_dte_orders(path: Path = TWO_DTE_STATE_PATH) -> list[dict]:
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text())
    except Exception:
        return []
    orders = raw.get("orders") if isinstance(raw, dict) else None
    return [o for o in orders if isinstance(o, dict)] if isinstance(orders, list) else []


def _load_bwb_settings(path: Path = BWB_SETTINGS_PATH) -> BwbSettings:
    defaults = BwbSettings()
    if not path.exists():
        return defaults
    try:
        raw = json.loads(path.read_text())
    except Exception:
        return defaults
    if not isinstance(raw, dict):
        return defaults
    try:
        return BwbSettings(
            enabled=bool(raw.get("enabled", defaults.enabled)),
            target_dte=max(7, _to_int(raw.get("target_dte"), defaults.target_dte)),
            min_dte=max(7, _to_int(raw.get("min_dte"), defaults.min_dte)),
            max_dte=max(8, _to_int(raw.get("max_dte"), defaults.max_dte)),
            iv_rank_threshold=float(raw.get("iv_rank_threshold", defaults.iv_rank_threshold)),
            short_delta_min=float(raw.get("short_delta_min", defaults.short_delta_min)),
            short_delta_max=float(raw.get("short_delta_max", defaults.short_delta_max)),
            near_long_delta_target=float(raw.get("near_long_delta_target", defaults.near_long_delta_target)),
            near_long_delta_tolerance=float(raw.get("near_long_delta_tolerance", defaults.near_long_delta_tolerance)),
            far_long_delta_max=float(raw.get("far_long_delta_max", defaults.far_long_delta_max)),
            narrow_wing_min=float(raw.get("narrow_wing_min", defaults.narrow_wing_min)),
            narrow_wing_max=float(raw.get("narrow_wing_max", defaults.narrow_wing_max)),
            wide_to_narrow_min_ratio=float(raw.get("wide_to_narrow_min_ratio", defaults.wide_to_narrow_min_ratio)),
            min_credit_per_narrow=float(raw.get("min_credit_per_narrow", defaults.min_credit_per_narrow)),
            max_risk_pct_account=float(raw.get("max_risk_pct_account", defaults.max_risk_pct_account)),
            max_total_margin_pct_account=float(raw.get("max_total_margin_pct_account", defaults.max_total_margin_pct_account)),
            profit_take_credit_frac=float(raw.get("profit_take_credit_frac", defaults.profit_take_credit_frac)),
            profit_take_width_frac=float(raw.get("profit_take_width_frac", defaults.profit_take_width_frac)),
            stop_loss_credit_frac=float(raw.get("stop_loss_credit_frac", defaults.stop_loss_credit_frac)),
            exit_dte=max(3, _to_int(raw.get("exit_dte"), defaults.exit_dte)),
            delta_alert_threshold=float(raw.get("delta_alert_threshold", defaults.delta_alert_threshold)),
            gamma_alert_threshold=float(raw.get("gamma_alert_threshold", defaults.gamma_alert_threshold)),
            allow_adjustments=bool(raw.get("allow_adjustments", defaults.allow_adjustments)),
            adjustment_mode=str(raw.get("adjustment_mode", defaults.adjustment_mode) or defaults.adjustment_mode).upper(),
        )
    except Exception:
        return defaults


def _load_bwb_open_position(path: Path = BWB_STATE_PATH) -> Optional[dict]:
    if not path.exists():
        return None
    try:
        raw = json.loads(path.read_text())
    except Exception:
        return None
    if not isinstance(raw, dict):
        return None
    pos = raw.get("position")
    return pos if isinstance(pos, dict) else None


def _symbol_validation_payload(snapshot) -> dict:
    def _symbols(rows) -> list[str]:
        out = sorted({str(getattr(o, "option_symbol", "")).strip() for o in rows if getattr(o, "option_symbol", None)})
        return [s for s in out if s]

    targets: dict[str, dict[str, object]] = {}
    for target_dte, rows in sorted((snapshot.options_by_target_dte or {}).items(), key=lambda item: int(item[0])):
        exp = (snapshot.expirations_by_target_dte or {}).get(target_dte)
        targets[str(int(target_dte))] = {
            "expiration": exp.isoformat() if isinstance(exp, dt.date) else None,
            "symbols": _symbols(rows),
        }

    return {
        "dte0": _symbols(snapshot.options),
        "dte2": _symbols(snapshot.options_2dte),
        "bwb": _symbols(snapshot.options_bwb),
        "targets": targets,
    }


def _put_call_ratio_proxy(options: list, spot: Optional[float]) -> Optional[float]:
    if not options:
        return None

    filtered: list = []
    for opt in options:
        right = str(getattr(opt, "right", "")).upper()
        strike = _to_float(getattr(opt, "strike", None))
        mid = _to_float(getattr(opt, "mid", None))
        if right not in {"P", "C"}:
            continue
        if strike is None:
            continue
        if mid is None or mid <= 0:
            continue
        if spot is not None and abs(strike - spot) > 250:
            continue
        filtered.append(opt)

    sample = filtered if filtered else options
    puts = 0.0
    calls = 0.0
    put_count = 0
    call_count = 0

    for opt in sample:
        right = str(getattr(opt, "right", "")).upper()
        mid = _to_float(getattr(opt, "mid", None))
        if right == "P":
            put_count += 1
            if mid is not None and mid > 0:
                puts += mid
        elif right == "C":
            call_count += 1
            if mid is not None and mid > 0:
                calls += mid

    if calls > 0 and puts > 0:
        return max(0.1, min(5.0, puts / calls))
    if call_count > 0 and put_count > 0:
        return max(0.1, min(5.0, put_count / call_count))
    return None


def _major_event_day(now_et: dt.datetime) -> tuple[bool, list[str]]:
    keywords = ("cpi", "fomc", "powell", "nfp", "jobs", "pce", "ism", "gdp", "fed")
    hits: list[str] = []
    for event in load_macro_events():
        if event.get("date") != now_et.date():
            continue
        name = str(event.get("name", "")).strip()
        if not name:
            continue
        lower = name.lower()
        if any(k in lower for k in keywords):
            time_et = str(event.get("time_et", "")).strip()
            hits.append(f"{name} ({time_et} ET)" if time_et else name)
    return (len(hits) > 0), hits


def _mark_2dte_orders(orders: list[dict], options_2dte: list, measured_move_ratio: Optional[float], now_et: dt.datetime) -> list[dict]:
    by_key = {(o.right, round(o.strike, 4), o.expiration): o for o in options_2dte}
    out: list[dict] = []
    for order in orders:
        if str(order.get("status", "")).upper() not in {"OPEN", "EXIT_PENDING"}:
            out.append(order)
            continue
        right = "C" if str(order.get("right", "")).upper() == "CALL" else "P"
        exp = order.get("expiry")
        try:
            exp_date = dt.date.fromisoformat(str(exp))
        except Exception:
            exp_date = None
        short = by_key.get((right, round(float(order.get("short_strike", 0.0)), 4), exp_date))
        long = by_key.get((right, round(float(order.get("long_strike", 0.0)), 4), exp_date))
        if short is None or long is None or short.mid is None or long.mid is None:
            order["mark_debit"] = None
            order["status"] = str(order.get("status", "OPEN")).upper()
            out.append(order)
            continue
        mark_debit = max(0.0, float(short.mid - long.mid))
        order["mark_debit"] = mark_debit
        order["updated_et"] = now_et.strftime("%H:%M:%S")
        credit = float(order.get("entry_credit", 0.0))
        stop_debit = float(order.get("stop_debit", credit * 3.0))
        profit_take = float(order.get("profit_take_debit", 0.05))
        delta_stop = float(order.get("delta_stop", 0.40)) if order.get("use_delta_stop", True) else None
        short_delta = abs(float(short.delta)) if short.delta is not None else None

        reason = ""
        if mark_debit >= stop_debit:
            reason = f"3x stop hit ({mark_debit:.2f} >= {stop_debit:.2f})"
        elif mark_debit <= profit_take:
            reason = f"Profit target hit ({mark_debit:.2f} <= {profit_take:.2f})"
        elif delta_stop is not None and short_delta is not None and short_delta > delta_stop:
            reason = f"Delta stop hit (|Δ| {short_delta:.2f} > {delta_stop:.2f})"
        elif measured_move_ratio is not None and measured_move_ratio < 0.45:
            reason = f"Measured-move reversal ({measured_move_ratio:.0%})"
        if reason:
            order["status"] = "EXIT_PENDING"
            order["exit_reason"] = reason
        else:
            order["status"] = "OPEN"
            order["exit_reason"] = ""
        out.append(order)
    return out


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _market_open_et(now_et: dt.datetime) -> bool:
    if now_et.weekday() >= 5:
        return False
    minutes = now_et.hour * 60 + now_et.minute
    return (9 * 60 + 30) <= minutes < (16 * 60)


def _session_candles_today(candles: list[CandleBar], now_et: dt.datetime) -> list[CandleBar]:
    if not candles:
        return []
    open_min = 9 * 60 + 30
    close_min = 16 * 60
    session: list[CandleBar] = []
    for bar in candles:
        ts = bar.timestamp.astimezone(ET)
        if ts.date() != now_et.date():
            continue
        minute = ts.hour * 60 + ts.minute
        if open_min <= minute < close_min:
            session.append(bar)
    return session


def _status(name: str, status: str, detail: str, required: bool = True) -> dict:
    if status not in {"pass", "fail", "na"}:
        status = "fail"
    return {"name": name, "status": status, "detail": detail, "required": required}


def _pass(name: str, detail: str, required: bool = True) -> dict:
    return _status(name, "pass", detail, required)


def _fail(name: str, detail: str, required: bool = True) -> dict:
    return _status(name, "fail", detail, required)


def _na(name: str, detail: str) -> dict:
    return _status(name, "na", detail, required=False)


def _all_required_pass(rows: list[dict]) -> bool:
    return all(r.get("status") == "pass" for r in rows if bool(r.get("required", True)))


def _first_required_fail(rows: list[dict]) -> Optional[dict]:
    for row in rows:
        if not bool(row.get("required", True)):
            continue
        if row.get("status") != "pass":
            return row
    return None


def _legacy_criteria(rows: list[dict]) -> list[dict]:
    return [{"name": r.get("name", ""), "passed": r.get("status") == "pass", "detail": r.get("detail", "")} for r in rows]


def _format_leg(
    action: str,
    right: str,
    strike: object,
    delta: object,
    premium: object = None,
    implied_vol: object = None,
    symbol: object = None,
) -> dict:
    return {
        "action": action,
        "type": right,
        "strike": _to_float(strike) or 0.0,
        "delta": _to_float(delta) or 0.0,
        "qty": 1,
        "premium": _to_float(premium),
        "impliedVol": _to_float(implied_vol),
        "symbol": str(symbol or "").strip() or None,
    }


def _candidate_legs(strategy: str, candidate: Optional[dict]) -> list[dict]:
    if not candidate:
        return []
    if strategy == "Iron Condor":
        return [
            _format_leg(
                "SELL",
                "PUT",
                candidate.get("short_put"),
                candidate.get("short_put_delta"),
                candidate.get("short_put_mid"),
                candidate.get("short_put_iv"),
                candidate.get("short_put_symbol"),
            ),
            _format_leg(
                "BUY",
                "PUT",
                candidate.get("long_put"),
                candidate.get("long_put_delta"),
                candidate.get("long_put_mid"),
                candidate.get("long_put_iv"),
                candidate.get("long_put_symbol"),
            ),
            _format_leg(
                "SELL",
                "CALL",
                candidate.get("short_call"),
                candidate.get("short_call_delta"),
                candidate.get("short_call_mid"),
                candidate.get("short_call_iv"),
                candidate.get("short_call_symbol"),
            ),
            _format_leg(
                "BUY",
                "CALL",
                candidate.get("long_call"),
                candidate.get("long_call_delta"),
                candidate.get("long_call_mid"),
                candidate.get("long_call_iv"),
                candidate.get("long_call_symbol"),
            ),
        ]
    if strategy == "Iron Fly":
        short = candidate.get("short_strike")
        return [
            _format_leg(
                "SELL",
                "PUT",
                short,
                candidate.get("short_put_delta"),
                candidate.get("short_put_mid"),
                candidate.get("short_put_iv"),
                candidate.get("short_put_symbol"),
            ),
            _format_leg(
                "BUY",
                "PUT",
                candidate.get("long_put"),
                candidate.get("long_put_delta"),
                candidate.get("long_put_mid"),
                candidate.get("long_put_iv"),
                candidate.get("long_put_symbol"),
            ),
            _format_leg(
                "SELL",
                "CALL",
                short,
                candidate.get("short_call_delta"),
                candidate.get("short_call_mid"),
                candidate.get("short_call_iv"),
                candidate.get("short_call_symbol"),
            ),
            _format_leg(
                "BUY",
                "CALL",
                candidate.get("long_call"),
                candidate.get("long_call_delta"),
                candidate.get("long_call_mid"),
                candidate.get("long_call_iv"),
                candidate.get("long_call_symbol"),
            ),
        ]
    if strategy == "Directional Spread":
        return [
            _format_leg(
                "SELL",
                str(candidate.get("short_right", "")).upper(),
                candidate.get("short_strike"),
                candidate.get("short_delta"),
                candidate.get("short_mid"),
                candidate.get("short_iv"),
                candidate.get("short_symbol"),
            ),
            _format_leg(
                "BUY",
                str(candidate.get("long_right", "")).upper(),
                candidate.get("long_strike"),
                candidate.get("long_delta"),
                candidate.get("long_mid"),
                candidate.get("long_iv"),
                candidate.get("long_symbol"),
            ),
        ]
    return [
        _format_leg(
            "BUY",
            str(candidate.get("long_right", "")).upper(),
            candidate.get("long_strike"),
            candidate.get("long_delta"),
            candidate.get("long_mid"),
            candidate.get("long_iv"),
            candidate.get("long_symbol"),
        ),
        _format_leg(
            "SELL",
            str(candidate.get("short_right", "")).upper(),
            candidate.get("short_strike"),
            candidate.get("short_delta"),
            candidate.get("short_mid"),
            candidate.get("short_iv"),
            candidate.get("short_symbol"),
        ),
    ]


def _load_state_trades(path: Path = STATE_PATH) -> list[dict]:
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text())
    except Exception:
        return []
    trades = raw.get("trades") if isinstance(raw, dict) else None
    if not isinstance(trades, list):
        return []
    return [t for t in trades if isinstance(t, dict)]


def _open_trades(trades: list[dict]) -> list[dict]:
    return [t for t in trades if str(t.get("status")) in {"open", "exit_pending"}]


def _trade_max_risk_dollars(trade: dict) -> float:
    strategy = str(trade.get("strategy", "")).upper()
    width = _to_float(trade.get("width"))
    initial_credit = _to_float(trade.get("initial_credit"))
    if strategy in {"IRON_CONDOR", "IRON_FLY", "CREDIT_SPREAD"} and width is not None and initial_credit is not None:
        return max(0.0, (width - initial_credit) * 100.0)
    if strategy == "CONVEX_DEBIT":
        debit = _to_float(trade.get("initial_debit"))
        if debit is not None:
            return max(0.0, debit * 100.0)
    return 0.0


def _open_risk_dollars(trades: list[dict]) -> float:
    return sum(_trade_max_risk_dollars(t) for t in _open_trades(trades))


def _candidate_risk_dollars(candidate: Optional[dict], strategy: str) -> Optional[float]:
    if not candidate:
        return None
    if strategy == "Convex Debit Spread":
        debit = _to_float(candidate.get("debit"))
        if debit is None:
            return None
        return max(0.0, debit * 100.0)
    max_loss_points = _to_float(candidate.get("max_loss_points"))
    if max_loss_points is None:
        return None
    return max(0.0, max_loss_points * 100.0)


def _candidate_net_delta(strategy: str, candidate: Optional[dict]) -> Optional[float]:
    if not candidate:
        return None
    if strategy == "Iron Condor":
        sp = _to_float(candidate.get("short_put_delta"))
        sc = _to_float(candidate.get("short_call_delta"))
        lp = _to_float(candidate.get("long_put_delta"))
        lc = _to_float(candidate.get("long_call_delta"))
        if None in (sp, sc, lp, lc):
            return None
        return (sp + sc) - (lp + lc)
    if strategy == "Iron Fly":
        sp = _to_float(candidate.get("short_put_delta"))
        sc = _to_float(candidate.get("short_call_delta"))
        lp = _to_float(candidate.get("long_put_delta"))
        lc = _to_float(candidate.get("long_call_delta"))
        if None in (sp, sc, lp, lc):
            return None
        return (sp + sc) - (lp + lc)
    if strategy == "Directional Spread":
        s = _to_float(candidate.get("short_delta"))
        l = _to_float(candidate.get("long_delta"))
        if None in (s, l):
            return None
        return s - l
    l = _to_float(candidate.get("long_delta"))
    s = _to_float(candidate.get("short_delta"))
    if None in (l, s):
        return None
    return l - s


def _open_net_delta_proxy(trades: list[dict]) -> float:
    net = 0.0
    for trade in _open_trades(trades):
        strategy = str(trade.get("strategy", "")).upper()
        if strategy == "IRON_CONDOR":
            sp = _to_float(trade.get("short_put_delta"))
            sc = _to_float(trade.get("short_call_delta"))
            lp = _to_float(trade.get("long_put_delta"))
            lc = _to_float(trade.get("long_call_delta"))
            if None not in (sp, sc, lp, lc):
                net += (sp + sc) - (lp + lc)
        elif strategy == "IRON_FLY":
            sp = _to_float(trade.get("short_put_delta"))
            sc = _to_float(trade.get("short_call_delta"))
            lp = _to_float(trade.get("long_put_delta"))
            lc = _to_float(trade.get("long_call_delta"))
            if None not in (sp, sc, lp, lc):
                net += (sp + sc) - (lp + lc)
        elif strategy == "CREDIT_SPREAD":
            s = _to_float(trade.get("short_delta"))
            l = _to_float(trade.get("long_delta"))
            if None not in (s, l):
                net += s - l
        elif strategy == "CONVEX_DEBIT":
            l = _to_float(trade.get("long_delta"))
            s = _to_float(trade.get("short_delta"))
            if None not in (l, s):
                net += l - s
    return net


def _count_open_credit_spread_direction(trades: list[dict], spread_type: str) -> int:
    normalized = spread_type.upper()
    count = 0
    for trade in _open_trades(trades):
        if str(trade.get("strategy", "")).upper() != "CREDIT_SPREAD":
            continue
        if str(trade.get("spread_type", "")).upper() == normalized:
            count += 1
    return count


def _count_open_convex(trades: list[dict]) -> int:
    count = 0
    for trade in _open_trades(trades):
        if str(trade.get("strategy", "")).upper() == "CONVEX_DEBIT":
            count += 1
    return count


def _parse_time_et(value: object) -> Optional[tuple[int, int]]:
    text = str(value or "").strip()
    if not text:
        return None
    parts = text.split(":")
    if len(parts) != 2:
        return None
    try:
        hh = int(parts[0])
        mm = int(parts[1])
    except ValueError:
        return None
    if hh < 0 or hh > 23 or mm < 0 or mm > 59:
        return None
    return hh, mm


def _macro_block(now_et: dt.datetime) -> tuple[bool, str]:
    events = load_macro_events()
    today_events = [e for e in events if e.get("date") == now_et.date()]
    if not today_events:
        return False, "No macro event in configured calendar today."

    nearest_detail = "Outside macro block window."
    for event in today_events:
        name = str(event.get("name", "")).strip() or "Macro event"
        parsed = _parse_time_et(event.get("time_et"))
        if parsed is None:
            return True, f"{name} has missing/invalid ET time."
        hh, mm = parsed
        event_time = now_et.replace(hour=hh, minute=mm, second=0, microsecond=0)
        delta_min = abs((now_et - event_time).total_seconds() / 60.0)
        if delta_min <= 30:
            return True, f"{name} at {event_time.strftime('%H:%M')} ET within ±30m."
        nearest_detail = f"Nearest: {name} at {event_time.strftime('%H:%M')} ET."
    return False, nearest_detail


def _load_vol_state(path: Path = VOL_STATE_PATH) -> dict:
    if not path.exists():
        return {"date": "", "baseline_iv": None, "baseline_vix": None}
    try:
        raw = json.loads(path.read_text())
        if not isinstance(raw, dict):
            return {"date": "", "baseline_iv": None, "baseline_vix": None}
        return {
            "date": str(raw.get("date", "")),
            "baseline_iv": _to_float(raw.get("baseline_iv")),
            "baseline_vix": _to_float(raw.get("baseline_vix")),
        }
    except Exception:
        return {"date": "", "baseline_iv": None, "baseline_vix": None}


def _save_vol_state(state: dict, path: Path = VOL_STATE_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2))


def _detect_vol_expansion(now_et: dt.datetime, atm_iv: Optional[float], vix: Optional[float]) -> tuple[bool, str, Optional[float]]:
    state = _load_vol_state()
    today = now_et.date().isoformat()
    if state.get("date") != today:
        state = {"date": today, "baseline_iv": None, "baseline_vix": None}

    baseline_iv = _to_float(state.get("baseline_iv"))
    baseline_vix = _to_float(state.get("baseline_vix"))

    ten_et = now_et.replace(hour=10, minute=0, second=0, microsecond=0)
    if now_et >= ten_et and baseline_iv is None and atm_iv is not None:
        baseline_iv = atm_iv
        state["baseline_iv"] = baseline_iv
        if vix is not None:
            baseline_vix = vix
            state["baseline_vix"] = baseline_vix
        _save_vol_state(state)

    if baseline_iv in (None, 0) or atm_iv is None:
        return False, "Baseline IV unavailable.", None

    iv_change_pct = ((atm_iv - baseline_iv) / baseline_iv) * 100.0
    vix_jump = None
    if baseline_vix is not None and vix is not None:
        vix_jump = vix - baseline_vix

    trigger_iv = iv_change_pct >= 10.0
    trigger_vix = vix_jump is not None and vix_jump >= 4.0
    if trigger_iv or trigger_vix:
        detail = f"IV {iv_change_pct:+.2f}% from baseline"
        if vix_jump is not None:
            detail += f", VIX Δ {vix_jump:+.2f}"
        return True, detail, iv_change_pct

    detail = f"IV {iv_change_pct:+.2f}% from baseline"
    if vix_jump is not None:
        detail += f", VIX Δ {vix_jump:+.2f}"
    return False, detail, iv_change_pct


def _execution_time_bucket(now_et: dt.datetime) -> str:
    minutes = now_et.hour * 60 + now_et.minute
    if minutes <= 10 * 60 + 45:
        return "open"
    if minutes <= 12 * 60 + 30:
        return "midday"
    if minutes <= 14 * 60 + 30:
        return "late"
    return "close"


def _time_bucket_multiplier(settings: dict, bucket: str) -> float:
    mapping = {
        "open": "openBucketMultiplier",
        "midday": "midBucketMultiplier",
        "late": "lateBucketMultiplier",
        "close": "closeBucketMultiplier",
    }
    key = mapping.get(bucket, "midBucketMultiplier")
    raw = _to_float(settings.get(key))
    if raw is None:
        return 1.0
    return max(0.5, min(2.5, raw))


def _linreg_slope(values: list[float]) -> Optional[float]:
    if len(values) < 3:
        return None
    xs = list(range(len(values)))
    n = float(len(values))
    sum_x = float(sum(xs))
    sum_y = float(sum(values))
    sum_xy = float(sum(x * y for x, y in zip(xs, values)))
    sum_x2 = float(sum(x * x for x in xs))
    denom = (n * sum_x2) - (sum_x * sum_x)
    if denom == 0:
        return None
    return ((n * sum_xy) - (sum_x * sum_y)) / denom


def _slope_for_timeframe(candles: list[CandleBar], interval_min: int, lookback_min: int) -> Optional[float]:
    if interval_min <= 1:
        return compute_trend_slope_points_per_min(candles, lookback=lookback_min)
    if len(candles) < lookback_min:
        return None
    window = candles[-lookback_min:]
    sampled: list[float] = [float(window[idx].close) for idx in range(interval_min - 1, len(window), interval_min)]
    if sampled and sampled[-1] != float(window[-1].close):
        sampled.append(float(window[-1].close))
    if len(sampled) < 4:
        return None
    slope_per_interval = _linreg_slope(sampled)
    if slope_per_interval is None:
        return None
    return slope_per_interval / float(interval_min)


def _compute_multi_timeframe_slopes(candles: list[CandleBar], base_slope_1m: Optional[float]) -> dict:
    return {
        "1m_30m": base_slope_1m,
        "5m_30m": _slope_for_timeframe(candles, interval_min=5, lookback_min=30),
        "15m_90m": _slope_for_timeframe(candles, interval_min=15, lookback_min=90),
    }


def _trend_alignment_from_slopes(slopes: dict) -> dict:
    thresholds = {
        "1m_30m": 0.20,
        "5m_30m": 0.15,
        "15m_90m": 0.10,
    }
    up_votes = 0
    down_votes = 0
    neutral_votes = 0
    available = 0
    details: list[str] = []
    for key, threshold in thresholds.items():
        slope = _to_float(slopes.get(key))
        if slope is None:
            details.append(f"{key}=n/a")
            continue
        available += 1
        if slope >= threshold:
            up_votes += 1
            details.append(f"{key}={slope:+.3f}↑")
        elif slope <= -threshold:
            down_votes += 1
            details.append(f"{key}={slope:+.3f}↓")
        else:
            neutral_votes += 1
            details.append(f"{key}={slope:+.3f}~")

    dominant_votes = max(up_votes, down_votes)
    score = (dominant_votes / available) if available > 0 else 0.0
    if available >= 2 and dominant_votes >= 2 and score >= 0.67:
        direction = "UP" if up_votes > down_votes else "DOWN"
    elif available == 0:
        direction = "UNKNOWN"
    else:
        direction = "MIXED"
    aligned = direction in {"UP", "DOWN"}
    summary = ", ".join(details) if details else "No slope samples."
    return {
        "direction": direction,
        "score": score,
        "aligned": aligned,
        "available": available,
        "up_votes": up_votes,
        "down_votes": down_votes,
        "neutral_votes": neutral_votes,
        "summary": summary,
    }


def _confidence_ratio(value: Optional[float], threshold: Optional[float], upper_is_good: bool) -> float:
    if value is None or threshold in (None, 0):
        return 0.0
    if upper_is_good:
        if value >= threshold:
            return 1.0
        return max(0.0, value / threshold)
    if value <= threshold:
        return 1.0
    return max(0.0, threshold / value)


def _regime_confidence(
    regime: str,
    emr: Optional[float],
    full_day_em: Optional[float],
    range_15m: Optional[float],
    atr_1m: Optional[float],
    slope_5m: Optional[float],
    vwap_distance: Optional[float],
    day_range: Optional[float],
    vol_expansion_flag: bool,
    trend_alignment: dict,
) -> dict:
    score = 0.0
    components: list[float] = []

    if regime == "COMPRESSION":
        components = [
            _confidence_ratio(range_15m, (0.30 * emr) if emr not in (None, 0) else None, upper_is_good=False),
            _confidence_ratio(atr_1m, 6.0, upper_is_good=False),
            _confidence_ratio(abs(slope_5m) if slope_5m is not None else None, 0.15, upper_is_good=False),
            _confidence_ratio(vwap_distance, (0.20 * emr) if emr not in (None, 0) else None, upper_is_good=False),
        ]
    elif regime == "CHOP":
        lower_band = (0.30 * emr) if emr not in (None, 0) else None
        upper_band = (0.45 * emr) if emr not in (None, 0) else None
        range_score = 0.0
        if range_15m is not None and lower_band is not None and upper_band not in (None, 0):
            if lower_band < range_15m <= upper_band:
                range_score = 1.0
            elif range_15m <= lower_band:
                range_score = max(0.0, range_15m / lower_band)
            else:
                range_score = max(0.0, upper_band / range_15m)
        components = [
            range_score,
            _confidence_ratio(abs(slope_5m) if slope_5m is not None else None, 0.20, upper_is_good=False),
            _confidence_ratio(vwap_distance, (0.40 * emr) if emr not in (None, 0) else None, upper_is_good=False),
        ]
    elif regime in {"TREND_UP", "TREND_DOWN"}:
        slope_mag = abs(slope_5m) if slope_5m is not None else None
        components = [
            _confidence_ratio(slope_mag, 0.20, upper_is_good=True),
            _confidence_ratio(vwap_distance, (0.60 * emr) if emr not in (None, 0) else None, upper_is_good=False),
            _confidence_ratio(range_15m, (0.60 * emr) if emr not in (None, 0) else None, upper_is_good=False),
            float(max(0.0, min(1.0, _to_float(trend_alignment.get("score")) or 0.0))),
        ]
    elif regime == "EXPANSION":
        range_ratio = (
            (range_15m / (0.45 * emr))
            if range_15m is not None and emr not in (None, 0)
            else 0.0
        )
        day_ratio = (
            (day_range / (0.60 * full_day_em))
            if day_range is not None and full_day_em not in (None, 0)
            else 0.0
        )
        components = [
            1.0 if vol_expansion_flag else 0.0,
            max(0.0, min(1.0, range_ratio)),
            max(0.0, min(1.0, day_ratio)),
        ]
    else:
        components = [0.0]

    if components:
        score = float(sum(components) / len(components))
    confidence_pct = round(max(0.0, min(1.0, score)) * 100.0, 1)
    if confidence_pct >= 80:
        tier = "high"
    elif confidence_pct >= 60:
        tier = "medium"
    else:
        tier = "low"
    return {
        "score": max(0.0, min(1.0, score)),
        "confidence_pct": confidence_pct,
        "tier": tier,
    }


def _classify_regime(
    emr: Optional[float],
    full_day_em: Optional[float],
    range_15m: Optional[float],
    atr_1m: Optional[float],
    slope_5m: Optional[float],
    vwap_distance: Optional[float],
    day_range: Optional[float],
    vol_expansion_flag: bool,
    trend_alignment: dict,
) -> tuple[str, str]:
    if emr in (None, 0) or full_day_em in (None, 0) or range_15m is None or atr_1m is None or slope_5m is None or vwap_distance is None or day_range is None:
        return "UNCLASSIFIED", "Missing required data for regime classification."

    if range_15m > 0.45 * emr or vol_expansion_flag or day_range > 0.60 * full_day_em:
        return "EXPANSION", "Range/volatility expansion conditions met."

    if (
        range_15m <= 0.30 * emr
        and atr_1m <= 6.0
        and abs(slope_5m) <= 0.15
        and vwap_distance <= 0.20 * emr
    ):
        return "COMPRESSION", "Low range + low ATR + flat slope."

    if (
        0.30 * emr < range_15m <= 0.45 * emr
        and abs(slope_5m) <= 0.20
        and vwap_distance <= 0.40 * emr
    ):
        return "CHOP", "Moderate range with non-directional slope."

    if (
        abs(slope_5m) >= 0.20
        and vwap_distance <= 0.60 * emr
        and range_15m <= 0.60 * emr
        and bool(trend_alignment.get("aligned"))
    ):
        direction = str(trend_alignment.get("direction", "MIXED"))
        alignment_score = float(_to_float(trend_alignment.get("score")) or 0.0)
        if direction == "UP":
            return "TREND_UP", f"Uptrend slope + MTF alignment ({alignment_score:.0%})."
        if direction == "DOWN":
            return "TREND_DOWN", f"Downtrend slope + MTF alignment ({alignment_score:.0%})."
        return "UNCLASSIFIED", "Trend slope present but MTF alignment is mixed."

    return "UNCLASSIFIED", "Metrics did not fit strict regime buckets."


def _favored_strategy_from_regime(regime: str) -> str:
    mapping = {
        "COMPRESSION": "Iron Fly",
        "CHOP": "Iron Condor",
        "TREND_UP": "Directional Spread (Bull Put)",
        "TREND_DOWN": "Directional Spread (Bear Call)",
        "EXPANSION": "Convex Debit Spread",
    }
    return mapping.get(regime, "None")


def _strategy_allowed_by_regime(strategy: str, regime: str, candidate: Optional[dict]) -> tuple[bool, str]:
    if regime == "COMPRESSION":
        return strategy == "Iron Fly", "Compression -> Iron Fly only."
    if regime == "CHOP":
        return strategy == "Iron Condor", "Chop -> Iron Condor only."
    if regime == "TREND_UP":
        if strategy != "Directional Spread":
            return False, "Trend Up -> Bull Put spread only."
        spread_type = str((candidate or {}).get("spread_type", "")).upper()
        return spread_type == "BULL_PUT_SPREAD", f"Need BULL_PUT_SPREAD, got {spread_type or 'none'}."
    if regime == "TREND_DOWN":
        if strategy != "Directional Spread":
            return False, "Trend Down -> Bear Call spread only."
        spread_type = str((candidate or {}).get("spread_type", "")).upper()
        return spread_type == "BEAR_CALL_SPREAD", f"Need BEAR_CALL_SPREAD, got {spread_type or 'none'}."
    if regime == "EXPANSION":
        return strategy == "Convex Debit Spread", "Expansion -> Debit spread hedge only."
    return False, "Regime unclassified."


def _slippage_value(width: Optional[float], now_et: dt.datetime, execution_settings: dict) -> float:
    if not bool(execution_settings.get("enabled", True)):
        return 0.0
    if width is None:
        base = float(_to_float(execution_settings.get("creditOffsetWide")) or 0.20)
    else:
        cutoff = float(_to_float(execution_settings.get("narrowWidthCutoff")) or 50.0)
        if width <= cutoff:
            base = float(_to_float(execution_settings.get("creditOffsetNarrow")) or 0.15)
        else:
            base = float(_to_float(execution_settings.get("creditOffsetWide")) or 0.20)
    bucket = _execution_time_bucket(now_et)
    return base * _time_bucket_multiplier(execution_settings, bucket)


def _credit_adj_threshold(strategy: str, candidate: Optional[dict], ctx: dict) -> tuple[Optional[float], Optional[float], float, str]:
    if not candidate:
        return None, None, 0.0, "midday"
    width = _to_float(candidate.get("width"))
    credit = _to_float(candidate.get("credit"))
    if width is None or credit is None:
        return None, None, 0.0, "midday"
    now_et: dt.datetime = ctx["now_et"]
    execution_settings: dict = ctx.get("execution_settings", _default_execution_model_settings())
    bucket = _execution_time_bucket(now_et)
    slippage = _slippage_value(width, now_et=now_et, execution_settings=execution_settings)
    credit_adj = credit - slippage
    if strategy == "Directional Spread":
        threshold = 0.05 * width
    else:
        threshold = 0.03 * width
    return credit_adj, threshold, slippage, bucket


def _chain_liquidity_ratio(options: list, spot: Optional[float]) -> Optional[float]:
    if not options:
        return None
    scored: list[tuple[float, float]] = []
    for opt in options:
        strike = _to_float(getattr(opt, "strike", None))
        bid = _to_float(getattr(opt, "bid", None))
        ask = _to_float(getattr(opt, "ask", None))
        if strike is None or bid is None or ask is None:
            continue
        mid = (bid + ask) / 2.0
        if mid <= 0:
            continue
        ratio = (ask - bid) / mid
        if ratio < 0:
            continue
        dist = abs(strike - (spot if spot is not None else strike))
        scored.append((dist, ratio))
    if not scored:
        return None
    scored.sort(key=lambda t: t[0])
    nearest = [ratio for _, ratio in scored[: min(24, len(scored))]]
    if not nearest:
        return None
    nearest.sort()
    mid_idx = len(nearest) // 2
    if len(nearest) % 2 == 1:
        return float(nearest[mid_idx])
    return float((nearest[mid_idx - 1] + nearest[mid_idx]) / 2.0)


def _threshold_fail_detail(value: Optional[float], threshold: Optional[float], comparator: str = "<=") -> str:
    if value is None:
        return "Metric unavailable."
    if threshold is None:
        return "Threshold unavailable."
    if comparator == "<=":
        return f"{value:.2f} > {threshold:.2f}"
    if comparator == ">=":
        return f"{value:.2f} < {threshold:.2f}"
    return f"{value:.2f} vs {threshold:.2f}"


def _build_global_overview(ctx: dict) -> list[dict]:
    rows: list[dict] = []
    now_et: dt.datetime = ctx["now_et"]
    time_ge_10 = now_et >= now_et.replace(hour=10, minute=0, second=0, microsecond=0)
    time_le_1330 = now_et <= now_et.replace(hour=13, minute=30, second=0, microsecond=0)
    rows.append(_pass("Time >= 10:00 ET", now_et.strftime("%H:%M:%S ET")) if time_ge_10 else _fail("Time >= 10:00 ET", now_et.strftime("%H:%M:%S ET")))
    rows.append(_pass("Time <= 13:30 ET (short premium)", now_et.strftime("%H:%M:%S ET")) if time_le_1330 else _fail("Time <= 13:30 ET (short premium)", now_et.strftime("%H:%M:%S ET")))
    rows.append(_fail("Not within 30 min of macro event", ctx["macro_detail"]) if ctx["macro_block"] else _pass("Not within 30 min of macro event", ctx["macro_detail"]))
    rows.append(_fail("Not in weekly/daily loss lock", ctx["loss_lock_detail"]) if ctx["loss_lock"] else _pass("Not in weekly/daily loss lock", ctx["loss_lock_detail"]))
    rows.append(
        _pass("Sleeve open risk < 6%", f"${ctx['open_risk']:.0f} < ${ctx['max_open_risk']:.0f}")
        if ctx["open_risk"] < ctx["max_open_risk"]
        else _fail("Sleeve open risk < 6%", f"${ctx['open_risk']:.0f} >= ${ctx['max_open_risk']:.0f}")
    )
    rows.append(_fail("Volatility Expansion flag = FALSE", ctx["vol_detail"]) if ctx["vol_expansion"] else _pass("Volatility Expansion flag = FALSE", ctx["vol_detail"]))
    rows.append(_na("Candidate max risk <= 3% sleeve", "Evaluated per strategy candidate."))
    chain_liq = _to_float(ctx.get("chain_liquidity_ratio"))
    if chain_liq is None:
        rows.append(_fail("Liquidity OK (bid/ask <= 12% of mid)", "Market-wide liquidity unavailable."))
    elif chain_liq <= 0.12:
        rows.append(_pass("Liquidity OK (bid/ask <= 12% of mid)", f"{chain_liq:.3f} <= 0.120 (chain median)"))
    else:
        rows.append(_fail("Liquidity OK (bid/ask <= 12% of mid)", f"{chain_liq:.3f} > 0.120 (chain median)"))
    rows.append(_na("Slippage-adjusted credit >= minimum threshold", "Evaluated per strategy candidate."))
    return rows


def _primary_strategy_for_regime(regime: str) -> str:
    if regime == "COMPRESSION":
        return "Iron Fly"
    if regime == "CHOP":
        return "Iron Condor"
    if regime in {"TREND_UP", "TREND_DOWN"}:
        return "Directional Spread"
    if regime == "EXPANSION":
        return "Convex Debit Spread"
    return "Iron Condor"


def _global_rows_for_strategy(strategy: str, candidate: Optional[dict], ctx: dict) -> list[dict]:
    rows: list[dict] = []
    now_et: dt.datetime = ctx["now_et"]
    is_short_premium = strategy in {"Iron Condor", "Iron Fly", "Directional Spread"}

    time_ge_10 = now_et >= now_et.replace(hour=10, minute=0, second=0, microsecond=0)
    rows.append(_pass("Time >= 10:00 ET", now_et.strftime("%H:%M:%S ET")) if time_ge_10 else _fail("Time >= 10:00 ET", now_et.strftime("%H:%M:%S ET")))

    if is_short_premium:
        time_le_1330 = now_et <= now_et.replace(hour=13, minute=30, second=0, microsecond=0)
        rows.append(_pass("Time <= 13:30 ET (short premium)", now_et.strftime("%H:%M:%S ET")) if time_le_1330 else _fail("Time <= 13:30 ET (short premium)", now_et.strftime("%H:%M:%S ET")))
    else:
        rows.append(_na("Time <= 13:30 ET (short premium)", "Not applicable for convex debit spread."))

    rows.append(_fail("Not within 30 min of macro event", ctx["macro_detail"]) if ctx["macro_block"] else _pass("Not within 30 min of macro event", ctx["macro_detail"]))
    rows.append(_fail("Not in weekly/daily loss lock", ctx["loss_lock_detail"]) if ctx["loss_lock"] else _pass("Not in weekly/daily loss lock", ctx["loss_lock_detail"]))

    if ctx["open_risk"] < ctx["max_open_risk"]:
        rows.append(_pass("Sleeve open risk < 6%", f"${ctx['open_risk']:.0f} < ${ctx['max_open_risk']:.0f}"))
    else:
        rows.append(_fail("Sleeve open risk < 6%", f"${ctx['open_risk']:.0f} >= ${ctx['max_open_risk']:.0f}"))

    cand_risk = _candidate_risk_dollars(candidate, strategy)
    if is_short_premium:
        if cand_risk is None:
            rows.append(_fail("Candidate max risk <= 3% sleeve", "Candidate risk unavailable."))
        elif cand_risk <= ctx["max_risk_per_trade"]:
            rows.append(_pass("Candidate max risk <= 3% sleeve", f"${cand_risk:.0f} <= ${ctx['max_risk_per_trade']:.0f}"))
        else:
            rows.append(_fail("Candidate max risk <= 3% sleeve", f"${cand_risk:.0f} > ${ctx['max_risk_per_trade']:.0f}"))
    else:
        rows.append(_na("Candidate max risk <= 3% sleeve", "Convex uses separate 0.5%-1.5% risk band."))

    if is_short_premium:
        rows.append(_fail("Volatility Expansion flag = FALSE", ctx["vol_detail"]) if ctx["vol_expansion"] else _pass("Volatility Expansion flag = FALSE", ctx["vol_detail"]))
    else:
        rows.append(_na("Volatility Expansion flag = FALSE", "Convex debit spread can run only in expansion regime."))

    liq = _to_float((candidate or {}).get("liquidity_ratio"))
    if liq is None:
        liq = _to_float(ctx.get("chain_liquidity_ratio"))
    if liq is None:
        rows.append(_fail("Liquidity OK (bid/ask <= 12% of mid)", "Liquidity ratio unavailable."))
    elif liq <= 0.12:
        suffix = "candidate" if _to_float((candidate or {}).get("liquidity_ratio")) is not None else "chain median"
        rows.append(_pass("Liquidity OK (bid/ask <= 12% of mid)", f"{liq:.3f} <= 0.120 ({suffix})"))
    else:
        suffix = "candidate" if _to_float((candidate or {}).get("liquidity_ratio")) is not None else "chain median"
        rows.append(_fail("Liquidity OK (bid/ask <= 12% of mid)", f"{liq:.3f} > 0.120 ({suffix})"))

    if is_short_premium:
        credit_adj, threshold, slippage, bucket = _credit_adj_threshold(strategy, candidate, ctx)
        if credit_adj is None or threshold is None:
            rows.append(_fail("Slippage-adjusted credit >= minimum threshold", "Credit/width unavailable."))
        elif credit_adj >= threshold:
            rows.append(
                _pass(
                    "Slippage-adjusted credit >= minimum threshold",
                    f"{credit_adj:.2f} >= {threshold:.2f} (slip {slippage:.2f}, {bucket})",
                )
            )
        else:
            rows.append(
                _fail(
                    "Slippage-adjusted credit >= minimum threshold",
                    f"{credit_adj:.2f} < {threshold:.2f} (slip {slippage:.2f}, {bucket})",
                )
            )
    else:
        rows.append(_na("Slippage-adjusted credit >= minimum threshold", "Not used for debit spreads."))

    return rows


def _regime_rows(strategy: str, regime: str, regime_reason: str, candidate: Optional[dict], ctx: dict) -> list[dict]:
    rows: list[dict] = []
    rows.append(_pass("Regime classified", f"{regime}: {regime_reason}") if regime in VALID_REGIMES else _fail("Regime classified", regime_reason))
    trend_alignment = ctx.get("trend_alignment") if isinstance(ctx.get("trend_alignment"), dict) else {}
    trend_available = int(_to_float(trend_alignment.get("available")) or 0)
    trend_summary = str(trend_alignment.get("summary", "Slope alignment unavailable."))
    rows.append(
        _pass("Multi-timeframe trend confirmation available", trend_summary)
        if trend_available >= 2
        else _fail("Multi-timeframe trend confirmation available", trend_summary)
    )
    regime_confidence = ctx.get("regime_confidence") if isinstance(ctx.get("regime_confidence"), dict) else {}
    confidence_pct = _to_float(regime_confidence.get("confidence_pct"))
    confidence_tier = str(regime_confidence.get("tier", "")).upper() or "LOW"
    rows.append(
        _pass("Regime confidence >= 60%", f"{confidence_pct:.1f}% ({confidence_tier})")
        if confidence_pct is not None and confidence_pct >= 60.0
        else _fail("Regime confidence >= 60%", f"{(confidence_pct if confidence_pct is not None else 0.0):.1f}% ({confidence_tier})")
    )
    allowed, detail = _strategy_allowed_by_regime(strategy, regime, candidate)
    rows.append(_pass("Strategy allowed in this regime", detail) if allowed else _fail("Strategy allowed in this regime", detail))
    return rows


def _cand_or_fail(candidate: Optional[dict], name: str) -> tuple[Optional[dict], dict]:
    if candidate is None:
        return None, _fail(name, "No strategy candidate generated.")
    return candidate, _pass(name, "Candidate generated.")


def _strategy_rows_condor(candidate: Optional[dict], ctx: dict) -> list[dict]:
    rows: list[dict] = []
    cand, candidate_row = _cand_or_fail(candidate, "Condor candidate exists")
    rows.append(candidate_row)
    cand_data = cand or {}

    emr = _to_float(ctx.get("emr"))
    full_day_em = _to_float(ctx.get("full_day_em"))
    range_15m = _to_float(ctx["intraday"].get("range_15m"))
    atr_1m = _to_float(ctx["intraday"].get("atr_1m"))
    vwap_distance = _to_float(ctx["intraday"].get("vwap_distance"))
    day_range = _to_float(ctx["intraday"].get("day_range"))
    spot = _to_float(ctx.get("spot"))

    rows.append(
        _pass("15m Realized Range <= 45% EMR", f"{range_15m:.2f} <= {(0.45 * emr):.2f}")
        if range_15m is not None and emr not in (None, 0) and range_15m <= 0.45 * emr
        else _fail("15m Realized Range <= 45% EMR", _threshold_fail_detail(range_15m, (0.45 * emr) if emr not in (None, 0) else None))
    )
    rows.append(
        _pass("ATR(1m,5) <= 8 pts", f"{atr_1m:.2f} <= 8.00")
        if atr_1m is not None and atr_1m <= 8.0
        else _fail("ATR(1m,5) <= 8 pts", _threshold_fail_detail(atr_1m, 8.0))
    )
    rows.append(
        _pass("VWAP Distance <= 40% EMR", f"{vwap_distance:.2f} <= {(0.40 * emr):.2f}")
        if vwap_distance is not None and emr not in (None, 0) and vwap_distance <= 0.40 * emr
        else _fail("VWAP Distance <= 40% EMR", _threshold_fail_detail(vwap_distance, (0.40 * emr) if emr not in (None, 0) else None))
    )
    rows.append(
        _pass("High/Low since open <= 60% full-day EM", f"{day_range:.2f} <= {(0.60 * full_day_em):.2f}")
        if day_range is not None and full_day_em not in (None, 0) and day_range <= 0.60 * full_day_em
        else _fail("High/Low since open <= 60% full-day EM", _threshold_fail_detail(day_range, (0.60 * full_day_em) if full_day_em not in (None, 0) else None))
    )

    spd = _to_float(cand_data.get("short_put_delta"))
    scd = _to_float(cand_data.get("short_call_delta"))
    short_delta_ok = spd is not None and scd is not None and 0.12 <= abs(spd) <= 0.18 and 0.12 <= abs(scd) <= 0.18
    rows.append(
        _pass("Short deltas between ±0.12–0.18", f"put {spd:+.2f}, call {scd:+.2f}")
        if short_delta_ok
        else _fail("Short deltas between ±0.12–0.18", "Missing delta or out of band.")
    )
    symmetry_ok = spd is not None and scd is not None and abs(abs(spd) - abs(scd)) <= 0.03
    rows.append(
        _pass("Delta symmetry difference <= 0.03", f"diff {abs(abs(spd) - abs(scd)):.3f}")
        if symmetry_ok
        else _fail("Delta symmetry difference <= 0.03", "Missing delta or symmetry exceeded.")
    )

    short_put = _to_float(cand_data.get("short_put"))
    short_call = _to_float(cand_data.get("short_call"))
    distance_ok = (
        spot is not None
        and emr not in (None, 0)
        and short_put is not None
        and short_call is not None
        and (spot - short_put) >= 1.2 * emr
        and (short_call - spot) >= 1.2 * emr
    )
    rows.append(
        _pass("Short strikes >= 1.2 × EMR away", f"put {spot - short_put:.2f}, call {short_call - spot:.2f}")
        if distance_ok
        else _fail("Short strikes >= 1.2 × EMR away", "Distance check failed or data missing.")
    )

    width = _to_float(cand_data.get("width"))
    rows.append(_pass("Width 30–50 pts", f"{width:.0f}") if width is not None and 30 <= width <= 50 else _fail("Width 30–50 pts", "Width out of range."))

    credit_adj, threshold, slippage, bucket = _credit_adj_threshold("Iron Condor", cand_data if cand is not None else None, ctx)
    rows.append(
        _pass("Credit_adj >= 0.03 × width", f"{credit_adj:.2f} >= {threshold:.2f} (slip {slippage:.2f}, {bucket})")
        if credit_adj is not None and threshold is not None and credit_adj >= threshold
        else _fail("Credit_adj >= 0.03 × width", "Adjusted credit below threshold.")
    )

    pop_delta = _to_float(cand_data.get("pop_delta"))
    rows.append(_pass("POP (delta est) >= 75%", f"{pop_delta:.2%}") if pop_delta is not None and pop_delta >= 0.75 else _fail("POP (delta est) >= 75%", "POP below threshold or missing."))

    open_net = _to_float(ctx.get("open_net_delta"))
    cand_net = _candidate_net_delta("Iron Condor", cand_data if cand is not None else None)
    exposure_ok = open_net is not None and cand_net is not None and abs(open_net + cand_net) <= 0.25
    rows.append(
        _pass("No existing same-direction exposure", f"Projected net delta {open_net + cand_net:+.3f}")
        if exposure_ok
        else _fail("No existing same-direction exposure", "Projected net delta exceeds 0.25 or missing.")
    )
    return rows


def _strategy_rows_fly(candidate: Optional[dict], ctx: dict) -> list[dict]:
    rows: list[dict] = []
    cand, candidate_row = _cand_or_fail(candidate, "Fly candidate exists")
    rows.append(candidate_row)
    cand_data = cand or {}

    emr = _to_float(ctx.get("emr"))
    range_15m = _to_float(ctx["intraday"].get("range_15m"))
    atr_1m = _to_float(ctx["intraday"].get("atr_1m"))
    slope = _to_float(ctx.get("trend_slope"))
    vwap_distance = _to_float(ctx["intraday"].get("vwap_distance"))
    now_et: dt.datetime = ctx["now_et"]

    rows.append(
        _pass("15m Realized Range <= 30% EMR", f"{range_15m:.2f} <= {(0.30 * emr):.2f}")
        if range_15m is not None and emr not in (None, 0) and range_15m <= 0.30 * emr
        else _fail("15m Realized Range <= 30% EMR", _threshold_fail_detail(range_15m, (0.30 * emr) if emr not in (None, 0) else None))
    )
    rows.append(
        _pass("ATR(1m,5) <= 6 pts", f"{atr_1m:.2f} <= 6.00")
        if atr_1m is not None and atr_1m <= 6.0
        else _fail("ATR(1m,5) <= 6 pts", _threshold_fail_detail(atr_1m, 6.0))
    )
    rows.append(
        _pass("abs(slope_5m) <= 0.15", f"{abs(slope):.3f} <= 0.150")
        if slope is not None and abs(slope) <= 0.15
        else _fail("abs(slope_5m) <= 0.15", "Slope missing or threshold exceeded.")
    )
    rows.append(
        _pass("VWAP Distance <= 20% EMR", f"{vwap_distance:.2f} <= {(0.20 * emr):.2f}")
        if vwap_distance is not None and emr not in (None, 0) and vwap_distance <= 0.20 * emr
        else _fail("VWAP Distance <= 20% EMR", _threshold_fail_detail(vwap_distance, (0.20 * emr) if emr not in (None, 0) else None))
    )

    width = _to_float(cand_data.get("width"))
    rows.append(_pass("Wings 20–30 pts", f"{width:.0f}") if width is not None and 20 <= width <= 30 else _fail("Wings 20–30 pts", "Width out of range."))

    credit_adj, threshold, slippage, bucket = _credit_adj_threshold("Iron Fly", cand_data if cand is not None else None, ctx)
    rows.append(
        _pass("Credit_adj >= minimum threshold", f"{credit_adj:.2f} >= {threshold:.2f} (slip {slippage:.2f}, {bucket})")
        if credit_adj is not None and threshold is not None and credit_adj >= threshold
        else _fail("Credit_adj >= minimum threshold", "Adjusted credit below threshold.")
    )

    cutoff = now_et.replace(hour=13, minute=0, second=0, microsecond=0)
    rows.append(_pass("Entry time <= 13:00 ET", now_et.strftime("%H:%M:%S ET")) if now_et <= cutoff else _fail("Entry time <= 13:00 ET", now_et.strftime("%H:%M:%S ET")))

    cand_risk = _candidate_risk_dollars(cand_data if cand is not None else None, "Iron Fly")
    projected = ctx["open_risk"] + (cand_risk or 0.0)
    sleeve_ok = cand_risk is not None and projected <= ctx["max_open_risk"] and cand_risk <= ctx["max_risk_per_trade"]
    rows.append(
        _pass("Sleeve open risk check passes", f"Projected ${projected:.0f} <= ${ctx['max_open_risk']:.0f}")
        if sleeve_ok
        else _fail("Sleeve open risk check passes", "Projected/open risk cap failed.")
    )
    return rows


def _strategy_rows_directional(candidate: Optional[dict], ctx: dict) -> list[dict]:
    rows: list[dict] = []
    cand, candidate_row = _cand_or_fail(candidate, "Directional spread candidate exists")
    rows.append(candidate_row)
    cand_data = cand or {}

    regime = str(ctx.get("regime", ""))
    is_up = regime == "TREND_UP"
    is_down = regime == "TREND_DOWN"
    slope = _to_float(ctx.get("trend_slope"))
    vwap = _to_float(ctx["intraday"].get("vwap"))
    spot = _to_float(ctx.get("spot"))
    range_15m = _to_float(ctx["intraday"].get("range_15m"))
    emr = _to_float(ctx.get("emr"))
    spread_type = str(cand_data.get("spread_type", "")).upper()
    short_delta = _to_float(cand_data.get("short_delta"))
    width = _to_float(cand_data.get("width"))
    pop_delta = _to_float(cand_data.get("pop_delta"))
    trend_alignment = ctx.get("trend_alignment") if isinstance(ctx.get("trend_alignment"), dict) else {}
    trend_dir = str(trend_alignment.get("direction", "UNKNOWN"))
    trend_score = float(_to_float(trend_alignment.get("score")) or 0.0)
    trend_summary = str(trend_alignment.get("summary", "Multi-timeframe slope data unavailable."))

    if is_up:
        rows.append(_pass("slope_5m >= +0.20", f"{slope:+.3f}") if slope is not None and slope >= 0.20 else _fail("slope_5m >= +0.20", "Slope missing or below threshold."))
        rows.append(
            _pass("MTF trend confirms uptrend", f"{trend_dir} {trend_score:.0%} | {trend_summary}")
            if trend_dir == "UP" and trend_score >= 0.67
            else _fail("MTF trend confirms uptrend", f"{trend_dir} {trend_score:.0%} | {trend_summary}")
        )
        rows.append(_pass("Price above VWAP", f"{spot:.2f} > {vwap:.2f}") if spot is not None and vwap is not None and spot > vwap else _fail("Price above VWAP", "Spot/VWAP missing or not above VWAP."))
        rows.append(
            _pass("15m Range <= 60% EMR", f"{range_15m:.2f} <= {(0.60 * emr):.2f}")
            if range_15m is not None and emr not in (None, 0) and range_15m <= 0.60 * emr
            else _fail("15m Range <= 60% EMR", _threshold_fail_detail(range_15m, (0.60 * emr) if emr not in (None, 0) else None))
        )
        rows.append(
            _pass("Short delta 0.20–0.25 (bull put)", f"{short_delta:+.2f}")
            if short_delta is not None and short_delta < 0 and 0.20 <= abs(short_delta) <= 0.25 and spread_type == "BULL_PUT_SPREAD"
            else _fail("Short delta 0.20–0.25 (bull put)", "Short delta/sign or spread type mismatch.")
        )
    elif is_down:
        rows.append(_pass("slope_5m <= -0.20", f"{slope:+.3f}") if slope is not None and slope <= -0.20 else _fail("slope_5m <= -0.20", "Slope missing or above threshold."))
        rows.append(
            _pass("MTF trend confirms downtrend", f"{trend_dir} {trend_score:.0%} | {trend_summary}")
            if trend_dir == "DOWN" and trend_score >= 0.67
            else _fail("MTF trend confirms downtrend", f"{trend_dir} {trend_score:.0%} | {trend_summary}")
        )
        rows.append(_pass("Price below VWAP", f"{spot:.2f} < {vwap:.2f}") if spot is not None and vwap is not None and spot < vwap else _fail("Price below VWAP", "Spot/VWAP missing or not below VWAP."))
        rows.append(
            _pass("15m Range <= 60% EMR", f"{range_15m:.2f} <= {(0.60 * emr):.2f}")
            if range_15m is not None and emr not in (None, 0) and range_15m <= 0.60 * emr
            else _fail("15m Range <= 60% EMR", _threshold_fail_detail(range_15m, (0.60 * emr) if emr not in (None, 0) else None))
        )
        rows.append(
            _pass("Short delta -0.20 to -0.25 (bear call mirror)", f"{short_delta:+.2f}")
            if short_delta is not None and short_delta > 0 and 0.20 <= abs(short_delta) <= 0.25 and spread_type == "BEAR_CALL_SPREAD"
            else _fail("Short delta -0.20 to -0.25 (bear call mirror)", "Short delta/sign or spread type mismatch.")
        )
    else:
        rows.append(_fail("Trend regime requirement", f"Directional spreads require TREND_UP/TREND_DOWN, got {regime}."))

    rows.append(_pass("Width 25–50 pts", f"{width:.0f}") if width is not None and 25 <= width <= 50 else _fail("Width 25–50 pts", "Width out of range."))

    credit_adj, threshold, slippage, bucket = _credit_adj_threshold("Directional Spread", cand_data if cand is not None else None, ctx)
    rows.append(
        _pass("Credit_adj >= 0.05 × width", f"{credit_adj:.2f} >= {threshold:.2f} (slip {slippage:.2f}, {bucket})")
        if credit_adj is not None and threshold is not None and credit_adj >= threshold
        else _fail("Credit_adj >= 0.05 × width", "Adjusted credit below threshold.")
    )
    rows.append(_pass("POP >= 75%", f"{pop_delta:.2%}") if pop_delta is not None and pop_delta >= 0.75 else _fail("POP >= 75%", "POP below threshold or missing."))

    open_same_dir = _count_open_credit_spread_direction(ctx["open_trades"], spread_type)
    rows.append(
        _pass("No same-direction spread already open", f"Open {spread_type}: {open_same_dir}")
        if open_same_dir == 0
        else _fail("No same-direction spread already open", f"Open {spread_type}: {open_same_dir}")
    )
    return rows


def _strategy_rows_convex(candidate: Optional[dict], ctx: dict) -> list[dict]:
    rows: list[dict] = []
    cand, candidate_row = _cand_or_fail(candidate, "Convex debit candidate exists")
    rows.append(candidate_row)
    cand_data = cand or {}

    emr = _to_float(ctx.get("emr"))
    range_15m = _to_float(ctx["intraday"].get("range_15m"))
    slope = _to_float(ctx.get("trend_slope"))
    spot = _to_float(ctx.get("spot"))
    prior_30_high = _to_float(ctx.get("prior_30_high"))
    prior_30_low = _to_float(ctx.get("prior_30_low"))
    spread_type = str(cand_data.get("spread_type", "")).upper()

    expansion_ok = bool(ctx["vol_expansion"]) or (range_15m is not None and emr not in (None, 0) and range_15m > 0.45 * emr)
    rows.append(
        _pass("Vol Expansion TRUE OR 15m Range > 45% EMR", ctx["vol_detail"])
        if expansion_ok
        else _fail("Vol Expansion TRUE OR 15m Range > 45% EMR", "Expansion trigger missing.")
    )

    if spread_type == "CALL_DEBIT_SPREAD":
        breakout_ok = spot is not None and prior_30_high is not None and spot > prior_30_high
        breakout_detail = f"{spot:.2f} > {prior_30_high:.2f}" if spot is not None and prior_30_high is not None else "Spot/prior high missing."
    elif spread_type == "PUT_DEBIT_SPREAD":
        breakout_ok = spot is not None and prior_30_low is not None and spot < prior_30_low
        breakout_detail = f"{spot:.2f} < {prior_30_low:.2f}" if spot is not None and prior_30_low is not None else "Spot/prior low missing."
    else:
        breakout_ok = False
        breakout_detail = "Spread type missing."
    rows.append(_pass("Confirmed breakout (prior 30m high/low)", breakout_detail) if breakout_ok else _fail("Confirmed breakout (prior 30m high/low)", breakout_detail))

    rows.append(
        _pass("slope_5m magnitude >= 0.30", f"|{slope:+.3f}| >= 0.300")
        if slope is not None and abs(slope) >= 0.30
        else _fail("slope_5m magnitude >= 0.30", "Slope missing or below threshold.")
    )

    min_risk = 0.005 * ctx["sleeve_capital"]
    max_risk = 0.015 * ctx["sleeve_capital"]
    if cand is None:
        rows.append(_na("Risk between 0.5%–1.5% sleeve ($50–$150)", "Evaluated only after convex candidate exists."))
        rows.append(_na("Reward >= 1.5R", "Evaluated only after convex candidate exists."))
    else:
        risk = _candidate_risk_dollars(cand_data, "Convex Debit Spread")
        rows.append(
            _pass("Risk between 0.5%–1.5% sleeve ($50–$150)", f"${risk:.0f} in [{min_risk:.0f}, {max_risk:.0f}]")
            if risk is not None and min_risk <= risk <= max_risk
            else _fail("Risk between 0.5%–1.5% sleeve ($50–$150)", "Risk outside convex band.")
        )

        rr = _to_float(cand_data.get("reward_to_risk"))
        rows.append(_pass("Reward >= 1.5R", f"{rr:.2f}R") if rr is not None and rr >= 1.5 else _fail("Reward >= 1.5R", "Reward/risk below 1.5R."))

    open_convex = _count_open_convex(ctx["open_trades"])
    rows.append(_pass("Only 1 convex trade open at a time", f"Open convex trades: {open_convex}") if open_convex == 0 else _fail("Only 1 convex trade open at a time", f"Open convex trades: {open_convex}"))
    return rows


def _evaluate_strategy_card(strategy: str, raw_eval: dict, ctx: dict) -> dict:
    candidate = raw_eval.get("candidate") if isinstance(raw_eval, dict) else None

    global_rows = _global_rows_for_strategy(strategy, candidate, ctx)
    regime_rows = _regime_rows(strategy, ctx["regime"], ctx["regime_reason"], candidate, ctx)
    if strategy == "Iron Condor":
        strategy_rows = _strategy_rows_condor(candidate, ctx)
    elif strategy == "Iron Fly":
        strategy_rows = _strategy_rows_fly(candidate, ctx)
    elif strategy == "Directional Spread":
        strategy_rows = _strategy_rows_directional(candidate, ctx)
    else:
        strategy_rows = _strategy_rows_convex(candidate, ctx)

    all_rows = [*global_rows, *regime_rows, *strategy_rows]
    ready = candidate is not None and _all_required_pass(all_rows)
    fail_item = _first_required_fail(all_rows)
    blocked_reason = ""
    if fail_item:
        blocked_reason = f"{fail_item.get('name')}: {fail_item.get('detail')}"
    elif not ready:
        blocked_reason = "Checklist incomplete."

    legs = _candidate_legs(strategy, candidate)
    width = int(_to_float((candidate or {}).get("width")) or 0)
    if strategy == "Convex Debit Spread":
        premium = _to_float((candidate or {}).get("debit")) or 0.0
    else:
        premium = _to_float((candidate or {}).get("credit")) or 0.0
    max_risk = _to_float((candidate or {}).get("max_loss_points")) or 0.0
    pop_pct = _to_float((candidate or {}).get("pop_delta")) or 0.0

    reason = "READY TO TRADE" if ready else (blocked_reason or str((raw_eval.get("reasons") or ["Blocked"])[0]))
    if strategy == "Directional Spread" and candidate is not None:
        spread_type = str(candidate.get("spread_type", "")).replace("_", " ").title()
        reason = spread_type if ready else reason
    if strategy == "Convex Debit Spread" and candidate is not None:
        spread_type = str(candidate.get("spread_type", "")).replace("_", " ").title()
        reason = spread_type if ready else reason

    return {
        "strategy": strategy,
        "ready": ready,
        "width": width,
        "credit": premium,
        "maxRisk": max_risk,
        "popPct": pop_pct,
        "reason": reason,
        "blockedReason": blocked_reason,
        "legs": legs,
        "checklist": {
            "global": global_rows,
            "regime": regime_rows,
            "strategy": strategy_rows,
        },
        "criteria": _legacy_criteria(all_rows),
    }


def _price_series(candles: list[CandleBar]) -> list[dict]:
    out: list[dict] = []
    for c in candles[-36:]:
        out.append(
            {
                "t": c.timestamp.strftime("%H:%M"),
                "price": float(c.close),
                "vwap": float(c.vwap if c.vwap is not None else c.close),
            }
        )
    return out


def _atr_last5(window: list[CandleBar]) -> Optional[float]:
    if len(window) < 6:
        return None
    relevant = window[-6:]
    trs: list[float] = []
    for idx in range(1, len(relevant)):
        prev_close = relevant[idx - 1].close
        cur = relevant[idx]
        tr = max(cur.high - cur.low, abs(cur.high - prev_close), abs(cur.low - prev_close))
        trs.append(tr)
    if not trs:
        return None
    return sum(trs) / len(trs)


def _vol_series(candles: list[CandleBar], emr: Optional[float]) -> list[dict]:
    if emr in (None, 0):
        return []
    series: list[dict] = []
    for i in range(max(0, len(candles) - 24), len(candles)):
        cur = candles[: i + 1]
        if len(cur) < 15:
            continue
        w15 = cur[-15:]
        range_15 = max(c.high for c in w15) - min(c.low for c in w15)
        atr = _atr_last5(cur)
        series.append(
            {
                "t": cur[-1].timestamp.strftime("%H:%M"),
                "emr": float(emr),
                "rangePctEm": float(range_15 / emr),
                "atr": float(atr if atr is not None else 0.0),
            }
        )
    return series


def _strategy_eligibility(regime: str) -> list[dict]:
    mapping = {
        "COMPRESSION": {"Iron Fly"},
        "CHOP": {"Iron Condor"},
        "TREND_UP": {"Directional Spread"},
        "TREND_DOWN": {"Directional Spread"},
        "EXPANSION": {"Convex Debit Spread"},
    }
    allowed = mapping.get(regime, set())
    output: list[dict] = []
    for strategy in ("Iron Condor", "Iron Fly", "Directional Spread", "Convex Debit Spread"):
        if regime not in VALID_REGIMES:
            output.append({"strategy": strategy, "status": "fail", "reason": "Regime unclassified."})
            continue
        if strategy in allowed:
            output.append({"strategy": strategy, "status": "pass", "reason": f"Allowed in {regime} regime."})
        else:
            output.append({"strategy": strategy, "status": "fail", "reason": f"Disabled in {regime} regime."})
    return output


def main() -> None:
    now_et = dt.datetime.now(ET)
    now_paris = now_et.astimezone(PARIS)

    client = TastyDataClient(symbol="SPX")
    # Pull enough 1m history to satisfy the longest 30m-bar requirement (45-DTE profile).
    snapshot = client.fetch_snapshot(symbol="SPX", candle_lookback_minutes=6000)
    all_candles = snapshot.candles_1m
    session_candles = _session_candles_today(all_candles, now_et)

    iv_input = snapshot.atm_iv if snapshot.atm_iv is not None else snapshot.expiration_iv
    emr = compute_emr(snapshot.spot, iv_input, minutes_to_close(now_et))
    full_day_em = compute_full_day_em(snapshot.spot, iv_input)
    intraday_stats, _ = build_intraday_gates(
        spot=snapshot.spot,
        emr=emr,
        full_day_em=full_day_em,
        candles=session_candles,
    )
    trend_slope = compute_trend_slope_points_per_min(session_candles, lookback=30)
    trend_slopes = _compute_multi_timeframe_slopes(session_candles, trend_slope)
    trend_alignment = _trend_alignment_from_slopes(trend_slopes)
    execution_settings = _load_execution_model_settings()

    open_trades_all = _load_state_trades()
    open_trades = _open_trades(open_trades_all)
    open_risk = _open_risk_dollars(open_trades_all)
    open_net_delta = _open_net_delta_proxy(open_trades_all)

    macro_block, macro_detail = _macro_block(now_et)
    vol_expansion, vol_detail, _ = _detect_vol_expansion(now_et, iv_input, snapshot.vix)

    sleeve_settings = _load_sleeve_settings()
    sleeve_capital = float(sleeve_settings["sleeve_capital"])
    max_open_risk = 0.06 * sleeve_capital
    max_risk_per_trade = 0.03 * sleeve_capital
    max_daily_loss = 0.04 * sleeve_capital
    max_weekly_loss = 0.08 * sleeve_capital
    daily_pnl = float(sleeve_settings["daily_realized_pnl"])
    weekly_pnl = float(sleeve_settings["weekly_realized_pnl"])
    daily_lock = bool(sleeve_settings["daily_lock"]) or daily_pnl <= -max_daily_loss
    weekly_lock = bool(sleeve_settings["weekly_lock"]) or weekly_pnl <= -max_weekly_loss
    loss_lock = daily_lock or weekly_lock
    loss_lock_detail = (
        f"daily_lock={daily_lock}, weekly_lock={weekly_lock}, daily_pnl={daily_pnl:.2f}, weekly_pnl={weekly_pnl:.2f}"
    )

    regime, regime_reason = _classify_regime(
        emr=emr,
        full_day_em=full_day_em,
        range_15m=_to_float(intraday_stats.get("range_15m")),
        atr_1m=_to_float(intraday_stats.get("atr_1m")),
        slope_5m=trend_slope,
        vwap_distance=_to_float(intraday_stats.get("vwap_distance")),
        day_range=_to_float(intraday_stats.get("day_range")),
        vol_expansion_flag=vol_expansion,
        trend_alignment=trend_alignment,
    )
    regime_confidence = _regime_confidence(
        regime=regime,
        emr=emr,
        full_day_em=full_day_em,
        range_15m=_to_float(intraday_stats.get("range_15m")),
        atr_1m=_to_float(intraday_stats.get("atr_1m")),
        slope_5m=trend_slope,
        vwap_distance=_to_float(intraday_stats.get("vwap_distance")),
        day_range=_to_float(intraday_stats.get("day_range")),
        vol_expansion_flag=vol_expansion,
        trend_alignment=trend_alignment,
    )

    condor_raw = find_iron_condor_candidate(
        options=snapshot.options,
        spot=snapshot.spot,
        emr=emr,
        full_day_em=full_day_em,
        widths=[30, 40, 50],
    )
    fly_raw = find_iron_fly_candidate(
        options=snapshot.options,
        spot=snapshot.spot,
        emr=emr,
        full_day_em=full_day_em,
        now_et=now_et,
        range_15m=intraday_stats.get("range_15m"),
        vwap_distance=intraday_stats.get("vwap_distance"),
        vix_change_pct=snapshot.vix_change_pct,
        widths=[20, 30],
    )
    directional_raw = find_directional_credit_spread_candidate(
        options=snapshot.options,
        spot=snapshot.spot,
        emr=emr,
        full_day_em=full_day_em,
        now_et=now_et,
        trend_slope_points_per_min=trend_slope,
        range_15m=intraday_stats.get("range_15m"),
        widths=[25, 30, 40, 50],
    )
    convex_raw = find_convex_debit_spread_candidate(
        options=snapshot.options,
        spot=snapshot.spot,
        emr=emr,
        full_day_em=full_day_em,
        now_et=now_et,
        candles_1m=session_candles,
        trend_slope_points_per_min=trend_slope,
        widths=[10, 15, 20],
    )
    two_dte_settings = _load_two_dte_settings()
    two_dte_raw = evaluate_two_dte_credit_spread(
        spot=snapshot.spot,
        candles_1m=all_candles,
        options_2dte=snapshot.options_2dte,
        expiration_2dte=snapshot.expiration_2dte,
        now_et=now_et,
        settings=two_dte_settings,
        target_dte=2,
        catalyst_blocked=macro_block,
        catalyst_detail=macro_detail,
    )
    multi_dte_targets = [2, 7, 14, 30, 45]
    multi_dte_raw: list[dict] = []
    for target_dte in multi_dte_targets:
        if target_dte == 2:
            target_eval = dict(two_dte_raw)
            exp_date = snapshot.expiration_2dte
        else:
            target_options = (snapshot.options_by_target_dte or {}).get(target_dte, [])
            exp_date = (snapshot.expirations_by_target_dte or {}).get(target_dte)
            target_eval = evaluate_two_dte_credit_spread(
                spot=snapshot.spot,
                candles_1m=all_candles,
                options_2dte=target_options,
                expiration_2dte=exp_date,
                now_et=now_et,
                settings=two_dte_settings,
                target_dte=target_dte,
                catalyst_blocked=macro_block,
                catalyst_detail=macro_detail,
            )

        selected_dte = None
        if isinstance(exp_date, dt.date):
            selected_dte = (exp_date - now_et.date()).days

        recommendation = target_eval.get("recommendation")
        if isinstance(recommendation, dict):
            recommendation = {
                **recommendation,
                "target_dte": int(target_dte),
                "selected_dte": selected_dte,
                "expiry": exp_date.isoformat() if isinstance(exp_date, dt.date) else recommendation.get("expiry"),
            }

        multi_dte_raw.append(
            {
                "strategy_label": f"{int(target_dte)}-DTE Credit Spread",
                "target_dte": int(target_dte),
                "selected_dte": selected_dte,
                "expiration": exp_date.isoformat() if isinstance(exp_date, dt.date) else None,
                "ready": bool(target_eval.get("ready")),
                "reason": str(target_eval.get("reason", "")),
                "checklist": target_eval.get("checklist", []),
                "recommendation": recommendation,
                "metrics": target_eval.get("metrics", {}),
            }
        )

    two_dte_orders = _mark_2dte_orders(
        _load_two_dte_orders(),
        snapshot.options_2dte,
        _to_float((two_dte_raw.get("metrics") or {}).get("measuredMoveCompletion")),
        now_et,
    )

    bwb_settings = _load_bwb_settings()
    bwb_open_position = _load_bwb_open_position()
    major_event_today, major_event_labels = _major_event_day(now_et)
    bwb_raw = evaluate_broken_wing_put_butterfly(
        spot=snapshot.spot,
        options=snapshot.options_bwb,
        expiration=snapshot.expiration_bwb,
        now_et=now_et,
        iv_rank=snapshot.iv_rank,
        has_major_event_today=major_event_today,
        major_event_labels=major_event_labels,
        account_equity=float(sleeve_settings["total_account"]),
        open_margin_risk_dollars=open_risk,
        settings=bwb_settings,
    )
    bwb_monitor = monitor_bwb_position(
        position=bwb_open_position,
        options=snapshot.options_bwb,
        spot=snapshot.spot,
        now_et=now_et,
        settings=bwb_settings,
    )

    prior_30_high = None
    prior_30_low = None
    if len(session_candles) >= 31:
        prior_30 = session_candles[-31:-1]
        prior_30_high = max(c.high for c in prior_30)
        prior_30_low = min(c.low for c in prior_30)

    ctx = {
        "now_et": now_et,
        "spot": snapshot.spot,
        "chain_liquidity_ratio": _chain_liquidity_ratio(snapshot.options, snapshot.spot),
        "emr": emr,
        "full_day_em": full_day_em,
        "intraday": intraday_stats,
        "trend_slope": trend_slope,
        "trend_slopes": trend_slopes,
        "trend_alignment": trend_alignment,
        "regime": regime,
        "regime_reason": regime_reason,
        "regime_confidence": regime_confidence,
        "macro_block": macro_block,
        "macro_detail": macro_detail,
        "vol_expansion": vol_expansion,
        "vol_detail": vol_detail,
        "execution_settings": execution_settings,
        "sleeve_capital": sleeve_capital,
        "max_open_risk": max_open_risk,
        "max_risk_per_trade": max_risk_per_trade,
        "open_risk": open_risk,
        "loss_lock": loss_lock,
        "loss_lock_detail": loss_lock_detail,
        "open_trades": open_trades,
        "open_net_delta": open_net_delta,
        "prior_30_high": prior_30_high,
        "prior_30_low": prior_30_low,
    }

    condor_card = _evaluate_strategy_card("Iron Condor", condor_raw, ctx)
    fly_card = _evaluate_strategy_card("Iron Fly", fly_raw, ctx)
    directional_card = _evaluate_strategy_card("Directional Spread", directional_raw, ctx)
    convex_card = _evaluate_strategy_card("Convex Debit Spread", convex_raw, ctx)

    primary_strategy = _primary_strategy_for_regime(regime)
    primary_candidate = None
    if primary_strategy == "Iron Condor":
        primary_candidate = condor_raw.get("candidate") if isinstance(condor_raw, dict) else None
    elif primary_strategy == "Iron Fly":
        primary_candidate = fly_raw.get("candidate") if isinstance(fly_raw, dict) else None
    elif primary_strategy == "Directional Spread":
        primary_candidate = directional_raw.get("candidate") if isinstance(directional_raw, dict) else None
    elif primary_strategy == "Convex Debit Spread":
        primary_candidate = convex_raw.get("candidate") if isinstance(convex_raw, dict) else None
    global_overview_rows = _global_rows_for_strategy(primary_strategy, primary_candidate, ctx)

    warnings = list(snapshot.warnings)
    if _market_open_et(now_et) and len(session_candles) < 15:
        warnings.append(
            f"Intraday bars incomplete ({len(session_candles)}): waiting for stable candle stream."
        )
    if regime == "UNCLASSIFIED" or snapshot.spot is None or emr is None:
        warnings.append("Data incomplete - blocking trade.")

    source = "tastytrade-live"
    if warnings:
        source = "tastytrade-partial"

    quote_ts_iso = now_et.isoformat()
    last_candle_ts_iso = (
        session_candles[-1].timestamp.astimezone(ET).isoformat()
        if session_candles
        else None
    )
    greek_count = sum(
        1
        for o in snapshot.options
        if o.delta is not None or o.gamma is not None or o.theta is not None
    )
    data_feeds = {
        "underlying_price": {
            "value": _to_float(snapshot.spot),
            "timestampIso": quote_ts_iso if snapshot.spot is not None else None,
            "source": source,
            "error": None if snapshot.spot is not None else "SPX spot unavailable.",
        },
        "option_chain": {
            "value": len(snapshot.options),
            "timestampIso": quote_ts_iso if snapshot.options else None,
            "source": source,
            "error": None if snapshot.options else "0DTE option chain unavailable.",
        },
        "greeks": {
            "value": greek_count,
            "timestampIso": quote_ts_iso if greek_count > 0 else None,
            "source": source,
            "error": None if greek_count > 0 else "Greeks unavailable on active chain.",
        },
        "intraday_candles": {
            "value": len(session_candles),
            "timestampIso": last_candle_ts_iso,
            "source": "tastytrade-candles",
            "error": None if session_candles else "No intraday candles.",
        },
        "vwap": {
            "value": _to_float(intraday_stats.get("vwap")),
            "timestampIso": last_candle_ts_iso,
            "source": "derived-candles",
            "error": None if _to_float(intraday_stats.get("vwap")) is not None else "VWAP unavailable.",
        },
        "atr_1m_5": {
            "value": _to_float(intraday_stats.get("atr_1m")),
            "timestampIso": last_candle_ts_iso,
            "source": "derived-candles",
            "error": None if _to_float(intraday_stats.get("atr_1m")) is not None else "ATR(1m,5) unavailable.",
        },
        "realized_range_15m": {
            "value": _to_float(intraday_stats.get("range_15m")),
            "timestampIso": last_candle_ts_iso,
            "source": "derived-candles",
            "error": None if _to_float(intraday_stats.get("range_15m")) is not None else "15m range unavailable.",
        },
        "expected_move": {
            "value": _to_float(emr),
            "timestampIso": quote_ts_iso if _to_float(emr) is not None else None,
            "source": "derived-iv",
            "error": None if _to_float(emr) is not None else "EMR unavailable.",
        },
        "regime": {
            "value": regime if regime in VALID_REGIMES else None,
            "timestampIso": quote_ts_iso if regime in VALID_REGIMES else None,
            "source": "derived-regime",
            "error": None if regime in VALID_REGIMES else "Regime unclassified.",
        },
    }

    payload = {
        "generatedAtEt": now_et.strftime("%H:%M:%S"),
        "generatedAtParis": now_paris.strftime("%H:%M:%S"),
        "market": {
            "isOpen": _market_open_et(now_et),
            "hoursEt": "09:30-16:00 ET (Mon-Fri)",
            "source": source,
            "telegramEnabled": False,
        },
        "metrics": {
            "spx": _to_float(snapshot.spot) or 0.0,
            "emr": _to_float(emr) or 0.0,
            "vix": _to_float(snapshot.vix) or 0.0,
            "vwap": _to_float(intraday_stats.get("vwap")) or 0.0,
            "range15mPctEm": (_to_float(intraday_stats.get("range_15m")) or 0.0) / (_to_float(emr) or 1.0),
            "atr1m": _to_float(intraday_stats.get("atr_1m")) or 0.0,
            "putCallRatio": _put_call_ratio_proxy(snapshot.options, snapshot.spot),
            "iv": _to_float(iv_input) or 0.0,
        },
        "globalChecklist": global_overview_rows,
        "regimeSummary": {
            "regime": regime,
            "favoredStrategy": _favored_strategy_from_regime(regime),
            "reason": regime_reason,
            "confidencePct": regime_confidence["confidence_pct"],
            "confidenceTier": regime_confidence["tier"],
            "trendDirection": trend_alignment["direction"],
            "trendAlignmentScore": round(float(trend_alignment["score"]) * 100.0, 1),
        },
        "strategyEligibility": _strategy_eligibility(regime),
        "sleeveSettings": {
            "sleeveCapital": sleeve_capital,
            "totalAccount": float(sleeve_settings["total_account"]),
            "maxDrawdownPct": float(sleeve_settings["max_drawdown_pct"]),
            "dailyRealizedPnl": daily_pnl,
            "weeklyRealizedPnl": weekly_pnl,
            "dailyLock": daily_lock,
            "weeklyLock": weekly_lock,
        },
        "sleeveLimits": {
            "maxRiskPerTrade": max_risk_per_trade,
            "maxOpenRisk": max_open_risk,
            "maxDailyLoss": max_daily_loss,
            "maxWeeklyLoss": max_weekly_loss,
        },
        "candidates": [condor_card, fly_card, directional_card, convex_card],
        "alerts": [],
        "openTrades": [],
        "priceSeries": _price_series(session_candles),
        "volSeries": _vol_series(session_candles, emr),
        "symbolValidation": _symbol_validation_payload(snapshot),
        "warnings": warnings[:3],
        "dataFeeds": data_feeds,
        "twoDte": {
            "ready": bool(two_dte_raw.get("ready")),
            "reason": str(two_dte_raw.get("reason", "")),
            "checklist": two_dte_raw.get("checklist", []),
            "recommendation": two_dte_raw.get("recommendation"),
            "metrics": two_dte_raw.get("metrics", {}),
            "settings": {
                "enabled": two_dte_settings.enabled,
                "width": two_dte_settings.width,
                "short_delta_min": two_dte_settings.short_delta_min,
                "short_delta_max": two_dte_settings.short_delta_max,
                "auto_select_params": two_dte_settings.auto_select_params,
                "min_strike_distance": two_dte_settings.min_strike_distance,
                "max_strike_distance": two_dte_settings.max_strike_distance,
                "min_credit": two_dte_settings.min_credit,
                "max_credit": two_dte_settings.max_credit,
                "use_delta_stop": two_dte_settings.use_delta_stop,
                "delta_stop": two_dte_settings.delta_stop,
                "stop_multiple": two_dte_settings.stop_multiple,
                "profit_take_debit": two_dte_settings.profit_take_debit,
                "require_measured_move": two_dte_settings.require_measured_move,
                "min_30m_bars": two_dte_settings.min_30m_bars,
                "allow_catalyst": two_dte_settings.allow_catalyst,
            },
            "openTrades": two_dte_orders,
        },
        "multiDte": {
            "targets": multi_dte_raw,
        },
        "bwb": {
            "ready": bool(bwb_raw.get("ready")),
            "reason": str(bwb_raw.get("reason", "")),
            "checklist": bwb_raw.get("checklist", []),
            "recommendation": bwb_raw.get("recommendation"),
            "metrics": bwb_raw.get("metrics", {}),
            "settings": {
                "enabled": bwb_settings.enabled,
                "target_dte": bwb_settings.target_dte,
                "min_dte": bwb_settings.min_dte,
                "max_dte": bwb_settings.max_dte,
                "iv_rank_threshold": bwb_settings.iv_rank_threshold,
                "short_delta_min": bwb_settings.short_delta_min,
                "short_delta_max": bwb_settings.short_delta_max,
                "near_long_delta_target": bwb_settings.near_long_delta_target,
                "near_long_delta_tolerance": bwb_settings.near_long_delta_tolerance,
                "far_long_delta_max": bwb_settings.far_long_delta_max,
                "narrow_wing_min": bwb_settings.narrow_wing_min,
                "narrow_wing_max": bwb_settings.narrow_wing_max,
                "wide_to_narrow_min_ratio": bwb_settings.wide_to_narrow_min_ratio,
                "min_credit_per_narrow": bwb_settings.min_credit_per_narrow,
                "max_risk_pct_account": bwb_settings.max_risk_pct_account,
                "max_total_margin_pct_account": bwb_settings.max_total_margin_pct_account,
                "profit_take_credit_frac": bwb_settings.profit_take_credit_frac,
                "profit_take_width_frac": bwb_settings.profit_take_width_frac,
                "stop_loss_credit_frac": bwb_settings.stop_loss_credit_frac,
                "exit_dte": bwb_settings.exit_dte,
                "delta_alert_threshold": bwb_settings.delta_alert_threshold,
                "gamma_alert_threshold": bwb_settings.gamma_alert_threshold,
                "allow_adjustments": bwb_settings.allow_adjustments,
                "adjustment_mode": bwb_settings.adjustment_mode,
            },
            "openPosition": bwb_open_position,
            "monitor": bwb_monitor,
            "majorEventToday": major_event_today,
            "majorEventLabels": major_event_labels,
        },
    }

    print(json.dumps(payload))


if __name__ == "__main__":
    main()
