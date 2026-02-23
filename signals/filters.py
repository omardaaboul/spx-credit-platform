from __future__ import annotations

import datetime as dt
import math
from dataclasses import dataclass
from typing import Optional
from zoneinfo import ZoneInfo

from data.tasty import CandleBar

ET = ZoneInfo("America/New_York")


@dataclass
class GateCheck:
    group: str
    name: str
    passed: bool
    detail: str


def now_et() -> dt.datetime:
    return dt.datetime.now(ET)


def minutes_to_close(current: dt.datetime) -> float:
    close_dt = current.replace(hour=16, minute=0, second=0, microsecond=0)
    if current >= close_dt:
        return 0.0
    return max(0.0, (close_dt - current).total_seconds() / 60.0)


def compute_emr(spot: Optional[float], iv: Optional[float], minutes_remaining: float) -> Optional[float]:
    if spot is None or iv is None or spot <= 0 or iv <= 0 or minutes_remaining <= 0:
        return None
    return float(spot * iv * math.sqrt(minutes_remaining / 525600.0))


def compute_full_day_em(spot: Optional[float], iv: Optional[float]) -> Optional[float]:
    if spot is None or iv is None or spot <= 0 or iv <= 0:
        return None
    return float(spot * iv * math.sqrt(390.0 / 525600.0))


def compute_vwap(candles: list[CandleBar]) -> Optional[float]:
    if not candles:
        return None

    total_pv = 0.0
    total_v = 0.0
    for c in candles:
        price = c.vwap if c.vwap is not None else c.close
        vol = max(0.0, float(c.volume))
        total_pv += price * vol
        total_v += vol

    if total_v == 0:
        return float(sum(c.close for c in candles) / len(candles))
    return total_pv / total_v


def compute_15m_range(candles: list[CandleBar]) -> Optional[float]:
    # Use up to the latest 15 bars; allow partial windows early in the session.
    if len(candles) < 3:
        return None
    window = candles[-min(15, len(candles)) :]
    return max(c.high for c in window) - min(c.low for c in window)


def compute_atr_1m(candles: list[CandleBar], lookback: int = 5) -> Optional[float]:
    if len(candles) < lookback + 1:
        return None

    trs: list[float] = []
    relevant = candles[-(lookback + 1) :]
    for idx in range(1, len(relevant)):
        prev_close = relevant[idx - 1].close
        cur = relevant[idx]
        tr = max(
            cur.high - cur.low,
            abs(cur.high - prev_close),
            abs(cur.low - prev_close),
        )
        trs.append(tr)

    if not trs:
        return None
    return sum(trs) / len(trs)


def compute_day_range(candles: list[CandleBar]) -> Optional[float]:
    if not candles:
        return None
    return max(c.high for c in candles) - min(c.low for c in candles)


def compute_trend_slope_points_per_min(candles: list[CandleBar], lookback: int = 30) -> Optional[float]:
    """
    Linear-regression slope of close vs minute index.
    Returns points per minute.
    """
    if lookback < 3:
        return None

    effective_lookback = min(lookback, len(candles))
    if effective_lookback < 10:
        return None
    window = candles[-effective_lookback:]
    xs = list(range(len(window)))
    ys = [float(c.close) for c in window]
    n = float(len(window))

    sum_x = sum(xs)
    sum_y = sum(ys)
    sum_xy = sum(x * y for x, y in zip(xs, ys))
    sum_x2 = sum(x * x for x in xs)
    denom = (n * sum_x2) - (sum_x * sum_x)
    if denom == 0:
        return None
    return ((n * sum_xy) - (sum_x * sum_y)) / denom


def classify_trend_direction(slope_points_per_min: Optional[float], threshold: float = 0.2) -> str:
    if slope_points_per_min is None:
        return "UNKNOWN"
    if slope_points_per_min > threshold:
        return "UP"
    if slope_points_per_min < -threshold:
        return "DOWN"
    return "CHOPPY"


def build_global_gates(
    current_et: dt.datetime,
    loss_today: bool,
    vix: Optional[float],
    vix_change_pct: Optional[float],
    open_price: Optional[float],
    prior_close: Optional[float],
    macro_events_today: Optional[list[str]] = None,
) -> list[GateCheck]:
    checks: list[GateCheck] = []
    macro_events_today = macro_events_today or []

    start = current_et.replace(hour=10, minute=0, second=0, microsecond=0)
    end = current_et.replace(hour=13, minute=30, second=0, microsecond=0)
    pass_time = start <= current_et <= end
    checks.append(
        GateCheck(
            group="Global",
            name="Time gate (10:00-13:30 ET)",
            passed=pass_time,
            detail=f"Now {current_et.strftime('%H:%M:%S ET')}",
        )
    )

    if vix is None:
        checks.append(
            GateCheck(
                group="Global",
                name="VIX regime 14-21",
                passed=True,
                detail="VIX unavailable (gate ignored)",
            )
        )
    else:
        pass_vix = 14.0 <= vix <= 21.0
        checks.append(
            GateCheck(
                group="Global",
                name="VIX regime 14-21",
                passed=pass_vix,
                detail=f"VIX {vix:.2f}",
            )
        )

    if vix_change_pct is None:
        checks.append(
            GateCheck(
                group="Global",
                name="VIX up-day <= +6%",
                passed=True,
                detail="VIX change unavailable (gate ignored)",
            )
        )
    else:
        pass_vix_change = vix_change_pct <= 6.0
        checks.append(
            GateCheck(
                group="Global",
                name="VIX up-day <= +6%",
                passed=pass_vix_change,
                detail=f"{vix_change_pct:+.2f}%",
            )
        )

    if open_price is None or prior_close in (None, 0):
        checks.append(
            GateCheck(
                group="Global",
                name="Overnight gap < 0.6%",
                passed=False,
                detail="Open/prior close unavailable",
            )
        )
    else:
        gap_pct = abs(open_price - prior_close) / prior_close * 100.0
        pass_gap = gap_pct < 0.6
        checks.append(
            GateCheck(
                group="Global",
                name="Overnight gap < 0.6%",
                passed=pass_gap,
                detail=f"Gap {gap_pct:.3f}%",
            )
        )

    checks.append(
        GateCheck(
            group="Global",
            name="No CPI / Jobs / FOMC macro release today",
            passed=len(macro_events_today) == 0,
            detail="None" if not macro_events_today else "; ".join(macro_events_today[:4]),
        )
    )

    checks.append(
        GateCheck(
            group="Risk",
            name="LOSS_TODAY unchecked",
            passed=not loss_today,
            detail="Alerts disabled for day" if loss_today else "Active",
        )
    )

    return checks


def build_intraday_gates(
    spot: Optional[float],
    emr: Optional[float],
    full_day_em: Optional[float],
    candles: list[CandleBar],
) -> tuple[dict[str, Optional[float]], list[GateCheck]]:
    stats: dict[str, Optional[float]] = {
        "range_15m": compute_15m_range(candles),
        "atr_1m": compute_atr_1m(candles, lookback=5),
        "vwap": compute_vwap(candles),
        "day_range": compute_day_range(candles),
        "vwap_distance": None,
        "atr_pct_emr": None,
    }

    if spot is not None and stats["vwap"] is not None:
        stats["vwap_distance"] = abs(spot - stats["vwap"])
    if emr not in (None, 0) and stats["atr_1m"] is not None:
        stats["atr_pct_emr"] = stats["atr_1m"] / emr

    checks: list[GateCheck] = []
    checks.append(
        _threshold_gate(
            group="Intraday",
            name="15m range < 0.35 * EMR",
            value=stats["range_15m"],
            threshold=(0.35 * emr) if emr is not None else None,
            fmt="{value:.2f} < {threshold:.2f}",
        )
    )
    checks.append(
        _threshold_gate(
            group="Intraday",
            name="1m ATR(5) < 8 points",
            value=stats["atr_1m"],
            threshold=8.0,
            fmt="{value:.2f} < {threshold:.2f}",
        )
    )
    checks.append(
        _threshold_gate(
            group="Intraday",
            name="|SPX-VWAP| < 0.4 * EMR",
            value=stats["vwap_distance"],
            threshold=(0.4 * emr) if emr is not None else None,
            fmt="{value:.2f} < {threshold:.2f}",
        )
    )
    checks.append(
        _threshold_gate(
            group="Intraday",
            name="High-Low since open < 0.60 * full-day EM",
            value=stats["day_range"],
            threshold=(0.60 * full_day_em) if full_day_em is not None else None,
            fmt="{value:.2f} < {threshold:.2f}",
        )
    )

    return stats, checks


def risk_score(
    atr_1m: Optional[float],
    emr: Optional[float],
    vwap_distance: Optional[float],
    pop_delta: Optional[float],
) -> str:
    if atr_1m is None or emr in (None, 0) or vwap_distance is None or pop_delta is None:
        return "HIGH"

    atr_pct = atr_1m / emr
    vwap_pct = vwap_distance / emr

    if atr_pct < 0.18 and vwap_pct < 0.18 and pop_delta >= 0.84:
        return "LOW"
    if atr_pct < 0.32 and vwap_pct < 0.32 and pop_delta >= 0.70:
        return "MED"
    return "HIGH"


def all_pass(checks: list[GateCheck]) -> bool:
    return all(c.passed for c in checks)


def _threshold_gate(
    group: str,
    name: str,
    value: Optional[float],
    threshold: Optional[float],
    fmt: str,
) -> GateCheck:
    if value is None or threshold is None:
        return GateCheck(group=group, name=name, passed=False, detail="Insufficient data")

    passed = value < threshold
    detail = fmt.format(value=value, threshold=threshold)
    return GateCheck(group=group, name=name, passed=passed, detail=detail)
