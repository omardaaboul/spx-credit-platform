from __future__ import annotations

import datetime as dt
import json
import math
import os
from pathlib import Path
from typing import Any, Optional

import pandas as pd
import requests


ROOT = Path(__file__).resolve().parents[1]
BACKTEST_DIR = ROOT / "storage" / "backtests"
DEFAULT_SPX_CSV = ROOT / "storage" / "historical" / "spx_daily.csv"
DEFAULT_VIX_CSV = ROOT / "storage" / "historical" / "vix_daily.csv"


def _to_float(value: object) -> Optional[float]:
    if value is None:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(out) or math.isinf(out):
        return None
    return out


def _read_stdin_json() -> dict[str, Any]:
    try:
        import sys

        raw = sys.stdin.read().strip()
        if not raw:
            return {}
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def _response(ok: bool, **kwargs: Any) -> dict[str, Any]:
    out = {"ok": ok}
    out.update(kwargs)
    return out


def _normalize_ohlc(df: pd.DataFrame, symbol: str) -> pd.DataFrame:
    rename_map = {c.lower().strip(): c for c in df.columns}
    required = {"date", "open", "high", "low", "close"}
    if not required.issubset(set(rename_map.keys())):
        missing = sorted(list(required - set(rename_map.keys())))
        raise ValueError(f"{symbol}: missing columns {missing}")

    out = pd.DataFrame(
        {
            "date": pd.to_datetime(df[rename_map["date"]], errors="coerce").dt.tz_localize(None),
            "open": pd.to_numeric(df[rename_map["open"]], errors="coerce"),
            "high": pd.to_numeric(df[rename_map["high"]], errors="coerce"),
            "low": pd.to_numeric(df[rename_map["low"]], errors="coerce"),
            "close": pd.to_numeric(df[rename_map["close"]], errors="coerce"),
        }
    )
    out = out.dropna().sort_values("date").drop_duplicates("date")
    if out.empty:
        raise ValueError(f"{symbol}: no valid OHLC rows")
    return out


def _read_csv_ohlc(path: Path, symbol: str) -> pd.DataFrame:
    if not path.exists():
        raise FileNotFoundError(f"{symbol}: CSV not found at {path}")
    return _normalize_ohlc(pd.read_csv(path), symbol=symbol)


def _download_stooq(symbol: str) -> pd.DataFrame:
    url = f"https://stooq.com/q/d/l/?s={symbol}&i=d"
    response = requests.get(url, timeout=20)
    response.raise_for_status()
    df = pd.read_csv(pd.io.common.StringIO(response.text))
    return _normalize_ohlc(df, symbol=symbol)


def _load_spx_vix(years: int, spx_csv_path: Optional[str], vix_csv_path: Optional[str]) -> tuple[pd.DataFrame, dict[str, str], list[str]]:
    warnings: list[str] = []
    sources: dict[str, str] = {"spx": "", "vix": ""}

    spx_df: Optional[pd.DataFrame] = None
    vix_df: Optional[pd.DataFrame] = None

    spx_candidates = []
    if spx_csv_path:
        spx_candidates.append(Path(spx_csv_path).expanduser())
    spx_candidates.append(DEFAULT_SPX_CSV)
    for candidate in spx_candidates:
        try:
            spx_df = _read_csv_ohlc(candidate, "SPX")
            sources["spx"] = f"csv:{candidate}"
            break
        except Exception:
            continue
    if spx_df is None:
        for ticker in ["^spx", "spx.us", "^gspc"]:
            try:
                spx_df = _download_stooq(ticker)
                sources["spx"] = f"stooq:{ticker}"
                break
            except Exception:
                continue

    vix_candidates = []
    if vix_csv_path:
        vix_candidates.append(Path(vix_csv_path).expanduser())
    vix_candidates.append(DEFAULT_VIX_CSV)
    for candidate in vix_candidates:
        try:
            vix_df = _read_csv_ohlc(candidate, "VIX")
            sources["vix"] = f"csv:{candidate}"
            break
        except Exception:
            continue
    if vix_df is None:
        for ticker in ["^vix", "vix.us"]:
            try:
                vix_df = _download_stooq(ticker)
                sources["vix"] = f"stooq:{ticker}"
                break
            except Exception:
                continue

    if spx_df is None:
        raise RuntimeError(
            "Unable to load SPX daily history. Provide CSV at storage/historical/spx_daily.csv "
            "or set SPX0DTE_BT_SPX_CSV."
        )
    if vix_df is None:
        warnings.append("VIX history unavailable. Backtest will use realized-vol proxy.")

    if vix_df is not None:
        vix_close = vix_df[["date", "close"]].rename(columns={"close": "vix_close"})
        merged = spx_df.merge(vix_close, on="date", how="left")
    else:
        merged = spx_df.copy()
        merged["vix_close"] = pd.NA

    merged = merged.sort_values("date").reset_index(drop=True)
    max_date = merged["date"].max()
    if pd.isna(max_date):
        raise RuntimeError("No valid dates in historical data.")
    start_date = pd.Timestamp(max_date) - pd.Timedelta(days=int(max(2, years)) * 366)
    merged = merged[merged["date"] >= start_date].reset_index(drop=True)
    if len(merged) < 750:
        raise RuntimeError(
            f"Insufficient rows for {years}y backtest (found {len(merged)}). "
            "Need longer history CSV."
        )
    return merged, sources, warnings


def _compute_indicators(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    out["prev_close"] = out["close"].shift(1)
    out["ret1"] = out["close"].pct_change()
    out["rv20"] = out["ret1"].rolling(20).std() * math.sqrt(252)
    out["vix"] = pd.to_numeric(out["vix_close"], errors="coerce")
    out["iv_proxy"] = (out["vix"] / 100.0).where(out["vix"] > 0, out["rv20"].fillna(0.18))
    out["iv_proxy"] = out["iv_proxy"].clip(lower=0.05, upper=1.00)
    out["em_day"] = out["close"] * out["iv_proxy"] / math.sqrt(252.0)
    tr = pd.concat(
        [
            (out["high"] - out["low"]).abs(),
            (out["high"] - out["prev_close"]).abs(),
            (out["low"] - out["prev_close"]).abs(),
        ],
        axis=1,
    ).max(axis=1)
    out["tr"] = tr
    out["atr14"] = out["tr"].rolling(14).mean()
    out["range"] = (out["high"] - out["low"]).abs()
    out["range_pct_em"] = out["range"] / out["em_day"].clip(lower=1e-6)
    out["atr_pct_em"] = out["atr14"] / out["em_day"].clip(lower=1e-6)
    out["slope5_pct"] = (out["close"] / out["close"].shift(5) - 1.0) / 5.0
    out["vix_change_pct"] = out["vix"].pct_change() * 100.0
    out["ema8"] = out["close"].ewm(span=8, adjust=False).mean()
    out["ema21"] = out["close"].ewm(span=21, adjust=False).mean()
    ema12 = out["close"].ewm(span=12, adjust=False).mean()
    ema26 = out["close"].ewm(span=26, adjust=False).mean()
    out["macd"] = ema12 - ema26
    out["macd_signal"] = out["macd"].ewm(span=9, adjust=False).mean()
    out["macd_hist"] = out["macd"] - out["macd_signal"]
    ma20 = out["close"].rolling(20).mean()
    std20 = out["close"].rolling(20).std()
    out["z20"] = (out["close"] - ma20) / std20.replace(0, pd.NA)
    vix_min = out["vix"].rolling(252).min()
    vix_max = out["vix"].rolling(252).max()
    out["iv_rank"] = ((out["vix"] - vix_min) / (vix_max - vix_min).replace(0, pd.NA) * 100.0).clip(lower=0, upper=100)
    return out


def _classify_regime(row: pd.Series) -> str:
    em = _to_float(row.get("em_day"))
    range_pct = _to_float(row.get("range_pct_em"))
    atr_pct = _to_float(row.get("atr_pct_em"))
    slope = _to_float(row.get("slope5_pct"))
    vix_jump = _to_float(row.get("vix_change_pct"))
    if em is None or em <= 0 or range_pct is None or atr_pct is None or slope is None:
        return "UNCLASSIFIED"
    if (vix_jump is not None and vix_jump >= 10.0) or range_pct > 0.60:
        return "EXPANSION"
    if range_pct <= 0.30 and atr_pct <= 0.45 and abs(slope) <= 0.0008:
        return "COMPRESSION"
    if range_pct <= 0.45 and abs(slope) <= 0.0012:
        return "CHOP"
    if slope >= 0.0012 and range_pct <= 0.60:
        return "TREND_UP"
    if slope <= -0.0012 and range_pct <= 0.60:
        return "TREND_DOWN"
    return "UNCLASSIFIED"


def _strategy_for_regime(regime: str) -> Optional[str]:
    mapping = {
        "COMPRESSION": "Iron Fly",
        "CHOP": "Iron Condor",
        "TREND_UP": "Directional Spread",
        "TREND_DOWN": "Directional Spread",
        "EXPANSION": "Convex Debit Spread",
    }
    return mapping.get(regime)


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _build_primary_candidate(df: pd.DataFrame, i: int, regime: str) -> Optional[dict[str, Any]]:
    if i + 1 >= len(df):
        return None
    strategy = _strategy_for_regime(regime)
    if not strategy:
        return None
    cur = df.iloc[i]
    nxt = df.iloc[i + 1]
    entry = float(cur["close"])
    em = max(1.0, float(cur["em_day"]))
    high = float(nxt["high"])
    low = float(nxt["low"])
    close = float(nxt["close"])

    if strategy == "Iron Condor":
        width = 40.0
        credit = _clamp(0.06 * em, 1.2, 3.8)
        dist = 1.2 * em
        down = max(0.0, entry - low)
        up = max(0.0, high - entry)
        breach = max(down, up) >= dist
        max_loss = width - credit
        if not breach:
            pnl = 0.60 * credit
        else:
            severity = max(down, up) / max(1e-6, dist)
            if severity < 1.15:
                pnl = -0.50 * credit
            elif severity < 1.35:
                pnl = -1.00 * credit
            else:
                pnl = -min(max_loss, 2.20 * credit)
        return {
            "strategy": strategy,
            "hold_days": 1,
            "credit_points": credit,
            "max_risk_points": max_loss,
            "pnl_points": pnl,
            "direction": 0,
            "reason": "Regime CHOP primary setup.",
        }

    if strategy == "Iron Fly":
        width = 25.0
        credit = _clamp(0.11 * em, 2.0, 7.5)
        max_loss = width - credit
        down = max(0.0, entry - low)
        up = max(0.0, high - entry)
        touch = max(down, up) >= width
        if touch:
            pnl = -0.90 * max_loss
        else:
            prox = abs(close - entry) / max(1e-6, em)
            if prox <= 0.10:
                pnl = 0.45 * credit
            elif prox <= 0.25:
                pnl = 0.30 * credit
            elif prox <= 0.40:
                pnl = 0.10 * credit
            else:
                pnl = -0.60 * credit
        return {
            "strategy": strategy,
            "hold_days": 1,
            "credit_points": credit,
            "max_risk_points": max_loss,
            "pnl_points": pnl,
            "direction": 0,
            "reason": "Regime COMPRESSION primary setup.",
        }

    if strategy == "Directional Spread":
        side = 1 if regime == "TREND_UP" else -1
        width = 30.0
        credit = _clamp(0.05 * em, 1.5, 3.5)
        max_loss = width - credit
        short_dist = _clamp(0.90 * em, 30.0, 50.0)
        if side > 0:
            adverse = max(0.0, entry - low)
            favorable = max(0.0, high - entry)
        else:
            adverse = max(0.0, high - entry)
            favorable = max(0.0, entry - low)
        breach = adverse >= short_dist
        if breach:
            severity = adverse / max(1e-6, short_dist)
            pnl = -max_loss if severity >= 1.20 else -1.20 * credit
        else:
            if favorable >= 0.40 * em:
                pnl = 0.55 * credit
            elif favorable >= 0.20 * em:
                pnl = 0.35 * credit
            else:
                pnl = 0.15 * credit
        return {
            "strategy": strategy,
            "hold_days": 1,
            "credit_points": credit,
            "max_risk_points": max_loss,
            "pnl_points": pnl,
            "direction": side,
            "reason": f"Regime {regime} primary setup.",
        }

    # Convex debit spread
    side = 1 if float(cur.get("slope5_pct", 0.0)) >= 0 else -1
    debit = _clamp(0.03 * em, 0.5, 1.5)
    if side > 0:
        favorable = max(0.0, high - entry)
        adverse = max(0.0, entry - low)
    else:
        favorable = max(0.0, entry - low)
        adverse = max(0.0, high - entry)
    if favorable >= 0.80 * em:
        pnl = 1.50 * debit
    elif favorable >= 0.40 * em:
        pnl = 0.70 * debit
    elif adverse >= 0.60 * em:
        pnl = -1.00 * debit
    else:
        pnl = -0.40 * debit
    return {
        "strategy": "Convex Debit Spread",
        "hold_days": 1,
        "credit_points": -debit,
        "max_risk_points": debit,
        "pnl_points": pnl,
        "direction": side,
        "reason": "Regime EXPANSION primary setup.",
    }


def _build_two_dte_candidate(df: pd.DataFrame, i: int) -> Optional[dict[str, Any]]:
    if i + 2 >= len(df):
        return None
    cur = df.iloc[i]
    em = _to_float(cur.get("em_day"))
    z20 = _to_float(cur.get("z20"))
    ema8 = _to_float(cur.get("ema8"))
    ema21 = _to_float(cur.get("ema21"))
    hist = _to_float(cur.get("macd_hist"))
    hist_prev = _to_float(df.iloc[i - 1].get("macd_hist")) if i > 0 else None
    if em is None or z20 is None or ema8 is None or ema21 is None or hist is None or hist_prev is None:
        return None

    side = 0
    if z20 <= -1.0 and ema8 >= ema21 and hist > hist_prev:
        side = 1
    elif z20 >= 1.0 and ema8 <= ema21 and hist < hist_prev:
        side = -1
    if side == 0:
        return None

    window = df.iloc[i + 1 : i + 3]
    entry = float(cur["close"])
    high = float(window["high"].max())
    low = float(window["low"].min())
    dist = _clamp(0.80 * em, 30.0, 50.0)
    width = 10.0
    credit = _clamp(0.015 * em, 0.8, 1.0)
    max_loss = width - credit

    if side > 0:
        adverse = max(0.0, entry - low)
        favorable = max(0.0, high - entry)
    else:
        adverse = max(0.0, high - entry)
        favorable = max(0.0, entry - low)

    if adverse >= dist:
        pnl = -min(max_loss, 2.00 * credit)
    elif favorable >= 0.45 * em:
        pnl = 0.70 * credit
    elif favorable >= 0.20 * em:
        pnl = 0.45 * credit
    else:
        pnl = 0.15 * credit

    return {
        "strategy": "2-DTE Credit Spread",
        "hold_days": 2,
        "credit_points": credit,
        "max_risk_points": max_loss,
        "pnl_points": pnl,
        "direction": side,
        "reason": "2-DTE momentum/mean-reversion checklist proxy passed.",
    }


def _build_bwb_candidate(df: pd.DataFrame, i: int, bwb_open: bool) -> Optional[dict[str, Any]]:
    if bwb_open or i + 10 >= len(df):
        return None
    cur = df.iloc[i]
    iv_rank = _to_float(cur.get("iv_rank"))
    em = _to_float(cur.get("em_day"))
    regime = str(cur.get("regime", "UNCLASSIFIED"))
    if iv_rank is None or em is None:
        return None
    if iv_rank < 50.0:
        return None
    if regime in {"EXPANSION", "UNCLASSIFIED"}:
        return None

    entry = float(cur["close"])
    future = df.iloc[i + 1 : i + 11]
    high = float(future["high"].max())
    low = float(future["low"].min())
    close_end = float(future["close"].iloc[-1])

    narrow = 5.0
    wide = 15.0
    credit = _clamp(0.02 * em, 0.5, 1.2)
    max_loss = (wide - narrow) - credit
    range_ratio = (high - low) / max(1e-6, em * 3.0)
    drift = (close_end - entry) / max(1e-6, entry)

    if range_ratio <= 0.90 and drift >= -0.01:
        pnl = 0.50 * credit
    elif range_ratio <= 1.30:
        pnl = 0.25 * credit
    else:
        pnl = -min(max_loss, 1.40 * credit)

    return {
        "strategy": "Broken-Wing Put Butterfly",
        "hold_days": 10,
        "credit_points": credit,
        "max_risk_points": max_loss,
        "pnl_points": pnl,
        "direction": 0,
        "reason": "BWB IV-rank + structure proxy passed.",
    }


def _max_drawdown_pct(values: list[float]) -> float:
    if not values:
        return 0.0
    peak = values[0]
    worst = 0.0
    for v in values:
        if v > peak:
            peak = v
        dd = ((peak - v) / peak) if peak > 0 else 0.0
        if dd > worst:
            worst = dd
    return worst * 100.0


def _simulate_portfolio(df: pd.DataFrame, years: int, sleeve_capital: float) -> dict[str, Any]:
    per_trade_cap = 0.03 * sleeve_capital
    max_open_risk = 0.06 * sleeve_capital
    daily_stop = 0.04 * sleeve_capital
    weekly_stop = 0.08 * sleeve_capital

    equity = sleeve_capital
    equity_curve: list[dict[str, Any]] = []
    open_positions: list[dict[str, Any]] = []
    closed_trades: list[dict[str, Any]] = []
    trade_id = 0
    last_bwb_entry_idx = -9999
    gross_win = 0.0
    gross_loss = 0.0

    # Skip early rows until indicators are populated and enough lookahead remains.
    start_idx = max(260, 25)
    end_idx = len(df) - 2
    if end_idx <= start_idx:
        raise RuntimeError("Not enough rows after indicator warmup.")

    current_week_key: Optional[str] = None
    week_realized = 0.0

    for i in range(start_idx, end_idx + 1):
        cur = df.iloc[i]
        cur_date = pd.Timestamp(cur["date"]).date()
        week_key = f"{cur_date.isocalendar().year}-W{cur_date.isocalendar().week:02d}"
        if week_key != current_week_key:
            current_week_key = week_key
            week_realized = 0.0
        day_realized = 0.0

        # Realize exits first.
        still_open: list[dict[str, Any]] = []
        for pos in open_positions:
            if int(pos["exit_idx"]) <= i:
                pnl_dollars = float(pos["pnl_dollars"])
                equity += pnl_dollars
                day_realized += pnl_dollars
                week_realized += pnl_dollars
                if pnl_dollars >= 0:
                    gross_win += pnl_dollars
                else:
                    gross_loss += abs(pnl_dollars)
                closed_trades.append(
                    {
                        "trade_id": pos["trade_id"],
                        "strategy": pos["strategy"],
                        "entry_date": pos["entry_date"],
                        "exit_date": str(cur_date),
                        "regime": pos["regime"],
                        "hold_days": pos["hold_days"],
                        "qty": pos["qty"],
                        "risk_dollars": pos["risk_dollars"],
                        "pnl_dollars": pnl_dollars,
                        "pnl_r": (pnl_dollars / pos["risk_dollars"]) if pos["risk_dollars"] > 0 else 0.0,
                        "reason": pos["reason"],
                    }
                )
            else:
                still_open.append(pos)
        open_positions = still_open

        daily_lock = day_realized <= -daily_stop
        weekly_lock = week_realized <= -weekly_stop
        open_risk_dollars = float(sum(float(p["risk_dollars"]) for p in open_positions))

        regime = str(cur.get("regime", "UNCLASSIFIED"))
        candidates: list[dict[str, Any]] = []
        primary = _build_primary_candidate(df, i, regime)
        if primary is not None:
            primary["regime"] = regime
            candidates.append(primary)

        two_dte = _build_two_dte_candidate(df, i)
        if two_dte is not None:
            two_dte["regime"] = regime
            candidates.append(two_dte)

        bwb_open = any(str(p.get("strategy")) == "Broken-Wing Put Butterfly" for p in open_positions)
        if i - last_bwb_entry_idx >= 5:
            bwb = _build_bwb_candidate(df, i, bwb_open=bwb_open)
            if bwb is not None:
                bwb["regime"] = regime
                candidates.append(bwb)

        for cand in candidates:
            strategy = str(cand["strategy"])
            hold_days = int(cand["hold_days"])
            if i + hold_days >= len(df):
                continue
            max_risk_points = max(0.01, float(cand["max_risk_points"]))
            risk_per_contract = max_risk_points * 100.0
            if risk_per_contract > per_trade_cap:
                continue
            if daily_lock or weekly_lock:
                continue

            qty = int(per_trade_cap // risk_per_contract)
            if qty < 1:
                continue
            risk_total = risk_per_contract * qty
            if (open_risk_dollars + risk_total) > max_open_risk:
                continue

            direction = int(cand.get("direction", 0))
            if direction != 0:
                directional_open = [
                    int(p.get("direction", 0))
                    for p in open_positions
                    if int(p.get("direction", 0)) != 0
                ]
                if any(d == direction for d in directional_open):
                    continue

            trade_id += 1
            pnl_points = float(cand["pnl_points"])
            pnl_dollars = pnl_points * 100.0 * qty
            pos = {
                "trade_id": trade_id,
                "strategy": strategy,
                "entry_date": str(cur_date),
                "exit_idx": i + hold_days,
                "hold_days": hold_days,
                "qty": qty,
                "risk_dollars": risk_total,
                "pnl_dollars": pnl_dollars,
                "regime": str(cand.get("regime", regime)),
                "direction": direction,
                "reason": str(cand.get("reason", "Model signal.")),
            }
            open_positions.append(pos)
            open_risk_dollars += risk_total
            if strategy == "Broken-Wing Put Butterfly":
                last_bwb_entry_idx = i

        equity_curve.append({"date": str(cur_date), "equity": round(equity, 2)})

    # Force settle leftover trades at final mark as zero P/L change (conservative no-lookahead).
    final_date = str(pd.Timestamp(df.iloc[-1]["date"]).date())
    if open_positions:
        for pos in open_positions:
            closed_trades.append(
                {
                    "trade_id": pos["trade_id"],
                    "strategy": pos["strategy"],
                    "entry_date": pos["entry_date"],
                    "exit_date": final_date,
                    "regime": pos["regime"],
                    "hold_days": pos["hold_days"],
                    "qty": pos["qty"],
                    "risk_dollars": pos["risk_dollars"],
                    "pnl_dollars": 0.0,
                    "pnl_r": 0.0,
                    "reason": f"{pos['reason']} (forced settle at sample end).",
                }
            )

    if not equity_curve:
        raise RuntimeError("No simulated rows produced.")

    trades_df = pd.DataFrame(closed_trades)
    if trades_df.empty:
        raise RuntimeError("No simulated trades generated. Expand sample or relax filters.")

    net_pnl = float(trades_df["pnl_dollars"].sum())
    wins = int((trades_df["pnl_dollars"] > 0).sum())
    total = int(len(trades_df))
    win_rate = (wins / total) * 100.0 if total else 0.0
    end_equity = float(equity_curve[-1]["equity"])
    start_date = pd.to_datetime(equity_curve[0]["date"])
    end_date = pd.to_datetime(equity_curve[-1]["date"])
    span_years = max(1e-6, (end_date - start_date).days / 365.25)
    cagr = ((end_equity / sleeve_capital) ** (1.0 / span_years) - 1.0) * 100.0 if sleeve_capital > 0 else 0.0
    max_dd = _max_drawdown_pct([float(x["equity"]) for x in equity_curve])
    profit_factor = gross_win / gross_loss if gross_loss > 0 else None

    by_strategy_rows = []
    for strategy, group in trades_df.groupby("strategy"):
        trades = int(len(group))
        pnl_sum = float(group["pnl_dollars"].sum())
        win_rate_s = float((group["pnl_dollars"] > 0).mean() * 100.0) if trades else 0.0
        avg_pnl = float(group["pnl_dollars"].mean()) if trades else 0.0
        avg_risk = float(group["risk_dollars"].mean()) if trades else 0.0
        expectancy_pct = (avg_pnl / avg_risk * 100.0) if avg_risk > 0 else 0.0
        by_strategy_rows.append(
            {
                "strategy": str(strategy),
                "trades": trades,
                "winRatePct": round(win_rate_s, 2),
                "netPnl": round(pnl_sum, 2),
                "avgPnl": round(avg_pnl, 2),
                "expectancyPctOfRisk": round(expectancy_pct, 2),
            }
        )

    by_strategy_rows = sorted(by_strategy_rows, key=lambda x: x["netPnl"], reverse=True)
    return {
        "summary": {
            "trades": total,
            "winRatePct": round(win_rate, 2),
            "netPnl": round(net_pnl, 2),
            "endEquity": round(end_equity, 2),
            "cagrPct": round(cagr, 2),
            "maxDrawdownPct": round(max_dd, 2),
            "profitFactor": None if profit_factor is None else round(float(profit_factor), 2),
        },
        "byStrategy": by_strategy_rows,
        "equityCurve": equity_curve[-400:],
        "trades": closed_trades[-500:],
        "dateRange": {"start": str(start_date.date()), "end": str(end_date.date())},
    }


def main() -> None:
    payload = _read_stdin_json()
    years_raw = _to_float(payload.get("years"))
    years = int(years_raw) if years_raw is not None else 10
    years = max(2, min(50, years))
    sleeve_raw = _to_float(payload.get("sleeveCapital"))
    sleeve_capital = sleeve_raw if sleeve_raw is not None and sleeve_raw > 0 else 10_000.0

    spx_csv_path = str(payload.get("spxCsvPath") or os.getenv("SPX0DTE_BT_SPX_CSV") or "").strip()
    vix_csv_path = str(payload.get("vixCsvPath") or os.getenv("SPX0DTE_BT_VIX_CSV") or "").strip()

    try:
        data, sources, warnings = _load_spx_vix(years, spx_csv_path or None, vix_csv_path or None)
        data = _compute_indicators(data)
        data["regime"] = data.apply(_classify_regime, axis=1)
        sim = _simulate_portfolio(data, years=years, sleeve_capital=sleeve_capital)

        assumptions = [
            "Historical approximation backtest (daily bars), not tick-accurate options replay.",
            "Option premiums are modeled from EM/IV proxy and conservative strategy rules.",
            "Risk governance enforced: per-trade cap, max-open-risk cap, daily/weekly circuit breakers.",
            "Use as research filter; validate with broker-grade options data before production sizing.",
        ]

        BACKTEST_DIR.mkdir(parents=True, exist_ok=True)
        stamp = dt.datetime.utcnow().strftime("%Y%m%d_%H%M%S")
        out_path = BACKTEST_DIR / f"backtest_approx_{years}y_{stamp}.json"
        output = _response(
            True,
            mode="historical-approximation",
            years=years,
            sleeveCapital=round(float(sleeve_capital), 2),
            source=sources,
            rows=int(len(data)),
            assumptions=assumptions,
            warnings=warnings,
            **sim,
            savedTo=str(out_path),
        )
        out_path.write_text(json.dumps(output, indent=2))
        print(json.dumps(output))
    except Exception as exc:
        fail = _response(
            False,
            mode="historical-approximation",
            years=years,
            message=str(exc),
            hint=(
                "Provide daily CSV files at "
                "storage/historical/spx_daily.csv and storage/historical/vix_daily.csv "
                "or set SPX0DTE_BT_SPX_CSV / SPX0DTE_BT_VIX_CSV."
            ),
        )
        print(json.dumps(fail))


if __name__ == "__main__":
    main()
