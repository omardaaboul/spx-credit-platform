from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
PARIS = ZoneInfo("Europe/Paris")

ROLLOVER_INTRADAY_AUTO_CLOSE = "INTRADAY_AUTO_CLOSE"
ROLLOVER_PERSIST_UNTIL_EXIT = "PERSIST_UNTIL_EXIT"

_MULTI_DAY_STRATEGY_KEYS = {
    "2_DTE_CREDIT_SPREAD",
    "2DTE_CREDIT_SPREAD",
    "TWO_DTE_CREDIT_SPREAD",
    "BROKEN_WING_PUT_BUTTERFLY",
    "BROKENWINGPUTBUTTERFLY",
    "BWB",
}


def _normalize_strategy_key(strategy: object) -> str:
    text = str(strategy or "").strip().upper()
    for char in (" ", "-"):
        text = text.replace(char, "_")
    while "__" in text:
        text = text.replace("__", "_")
    return text


def _strategy_rollover_policy(strategy: object) -> str:
    if _normalize_strategy_key(strategy) in _MULTI_DAY_STRATEGY_KEYS:
        return ROLLOVER_PERSIST_UNTIL_EXIT
    return ROLLOVER_INTRADAY_AUTO_CLOSE


def _trade_rollover_policy(trade: dict) -> str:
    raw = trade.get("rolloverPolicy")
    if isinstance(raw, str):
        normalized = raw.strip().upper()
        if normalized in {ROLLOVER_INTRADAY_AUTO_CLOSE, ROLLOVER_PERSIST_UNTIL_EXIT}:
            return normalized
    # Backward compatibility for existing state files missing rolloverPolicy.
    return _strategy_rollover_policy(trade.get("strategy"))


class AlertStateStore:
    """Persists entry-alert transitions and open-trade lifecycle across reruns."""

    def __init__(self, path: str = "storage/.alert_state.json") -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.state = self._load()

    # ------------------------
    # Entry alert transitions
    # ------------------------
    def evaluate_transition(
        self,
        strategy: str,
        is_ready: bool,
        now_et: dt.datetime,
        cooldown_seconds: int,
        alerts_enabled: bool,
        loss_today: bool,
    ) -> tuple[bool, str]:
        self._roll_date_if_needed(now_et.date())

        strat = self.state["strategies"].setdefault(
            strategy,
            {"ready": False, "last_alert_epoch": 0.0},
        )

        prev_ready = bool(strat.get("ready", False))
        strat["ready"] = bool(is_ready)
        self._save()

        if not alerts_enabled:
            return False, "alerts disabled"
        if loss_today:
            return False, "LOSS_TODAY active"
        if not is_ready:
            return False, "not ready"
        if prev_ready:
            return False, "still ready (no transition)"

        now_epoch = now_et.timestamp()
        last_epoch = float(strat.get("last_alert_epoch", 0.0))
        if now_epoch - last_epoch < cooldown_seconds:
            return False, "cooldown active"

        return True, "transition ready"

    def mark_sent(self, strategy: str, now_et: dt.datetime) -> None:
        self._roll_date_if_needed(now_et.date())
        strat = self.state["strategies"].setdefault(
            strategy,
            {"ready": False, "last_alert_epoch": 0.0},
        )
        strat["last_alert_epoch"] = now_et.timestamp()
        self._save()

    # ------------------------
    # Trade lifecycle
    # ------------------------
    def add_trade(self, strategy: str, now_et: dt.datetime, payload: dict) -> dict:
        self._roll_date_if_needed(now_et.date())
        trade_id = f"T{int(self.state.get('next_trade_id', 1)):05d}"
        self.state["next_trade_id"] = int(self.state.get("next_trade_id", 1)) + 1

        now_et_aware = _as_et(now_et)
        now_paris = now_et_aware.astimezone(PARIS)

        trade = {
            "trade_id": trade_id,
            "strategy": strategy,
            "status": "open",
            "entry_time_et": now_et_aware.isoformat(),
            "entry_time_paris": now_paris.isoformat(),
            "close_time_et": None,
            "close_time_paris": None,
            "closed_reason": "",
            "exit_pending_reason": "",
            "last_exit_alert_epoch": 0.0,
            "last_eval_et": None,
            "current_debit": None,
            "profit_pct": None,
            "time_in_trade_min": None,
            "rolloverPolicy": _strategy_rollover_policy(strategy),
        }
        trade.update(payload)
        trade["rolloverPolicy"] = _trade_rollover_policy(trade)

        self.state["trades"].append(trade)
        self._save()
        return dict(trade)

    def get_trades(self, statuses: Optional[list[str]] = None) -> list[dict]:
        trades = self.state.get("trades", [])
        if not isinstance(trades, list):
            return []
        if not statuses:
            return [self._with_effective_rollover_policy(t) for t in trades if isinstance(t, dict)]

        status_set = set(statuses)
        return [
            self._with_effective_rollover_policy(t)
            for t in trades
            if isinstance(t, dict) and t.get("status") in status_set
        ]

    def update_trade(self, trade_id: str, updates: dict) -> bool:
        idx = self._find_trade_index(trade_id)
        if idx is None:
            return False
        self.state["trades"][idx].update(updates)
        self._save()
        return True

    def mark_exit_pending(self, trade_id: str, now_et: dt.datetime, reason: str) -> bool:
        idx = self._find_trade_index(trade_id)
        if idx is None:
            return False
        trade = self.state["trades"][idx]
        if trade.get("status") == "closed":
            return False
        trade["status"] = "exit_pending"
        trade["exit_pending_reason"] = reason
        trade["last_eval_et"] = _as_et(now_et).isoformat()
        self._save()
        return True

    def close_trade(self, trade_id: str, now_et: dt.datetime, reason: str) -> bool:
        idx = self._find_trade_index(trade_id)
        if idx is None:
            return False

        now_et_aware = _as_et(now_et)
        now_paris = now_et_aware.astimezone(PARIS)
        trade = self.state["trades"][idx]
        trade["status"] = "closed"
        trade["closed_reason"] = reason
        trade["close_time_et"] = now_et_aware.isoformat()
        trade["close_time_paris"] = now_paris.isoformat()
        trade["last_eval_et"] = now_et_aware.isoformat()
        self._save()
        return True

    def can_send_exit_alert(
        self,
        trade_id: str,
        now_et: dt.datetime,
        cooldown_seconds: int,
        alerts_enabled: bool,
        loss_today: bool,
    ) -> tuple[bool, str]:
        if not alerts_enabled:
            return False, "exit alerts disabled"
        if loss_today:
            return False, "LOSS_TODAY active"

        trade = self.get_trade(trade_id)
        if not trade:
            return False, "trade not found"

        last_epoch = float(trade.get("last_exit_alert_epoch", 0.0))
        now_epoch = _as_et(now_et).timestamp()
        if now_epoch - last_epoch < cooldown_seconds:
            return False, "exit alert cooldown active"

        return True, "exit alert allowed"

    def mark_exit_alert_sent(self, trade_id: str, now_et: dt.datetime) -> bool:
        idx = self._find_trade_index(trade_id)
        if idx is None:
            return False
        self.state["trades"][idx]["last_exit_alert_epoch"] = _as_et(now_et).timestamp()
        self._save()
        return True

    def get_trade(self, trade_id: str) -> Optional[dict]:
        idx = self._find_trade_index(trade_id)
        if idx is None:
            return None
        trade = self.state["trades"][idx]
        if not isinstance(trade, dict):
            return None
        return self._with_effective_rollover_policy(trade)

    # ------------------------
    # Internal
    # ------------------------
    def _find_trade_index(self, trade_id: str) -> Optional[int]:
        trades = self.state.get("trades", [])
        for i, trade in enumerate(trades):
            if isinstance(trade, dict) and str(trade.get("trade_id")) == str(trade_id):
                return i
        return None

    def _roll_date_if_needed(self, current_date: dt.date) -> None:
        state_date = self.state.get("date")
        if state_date == current_date.isoformat():
            return

        now_et = dt.datetime.now(ET)
        now_paris = now_et.astimezone(PARIS)
        for trade in self.state.get("trades", []):
            if not isinstance(trade, dict):
                continue
            if trade.get("status") not in {"open", "exit_pending"}:
                continue
            if _trade_rollover_policy(trade) != ROLLOVER_INTRADAY_AUTO_CLOSE:
                continue
            entry_raw = trade.get("entry_time_et")
            entry_date = None
            if isinstance(entry_raw, str):
                try:
                    entry_date = dt.datetime.fromisoformat(entry_raw).date()
                except ValueError:
                    entry_date = None
            if entry_date is not None and entry_date < current_date:
                trade["status"] = "closed"
                trade["closed_reason"] = "day rollover auto-close"
                trade["close_time_et"] = now_et.isoformat()
                trade["close_time_paris"] = now_paris.isoformat()

        self.state["date"] = current_date.isoformat()
        self.state["strategies"] = {
            "IRON_CONDOR": {"ready": False, "last_alert_epoch": 0.0},
            "IRON_FLY": {"ready": False, "last_alert_epoch": 0.0},
            "CREDIT_SPREAD": {"ready": False, "last_alert_epoch": 0.0},
        }
        self._save()

    def _default_state(self) -> dict:
        return {
            "date": dt.datetime.now(ET).date().isoformat(),
            "strategies": {
                "IRON_CONDOR": {"ready": False, "last_alert_epoch": 0.0},
                "IRON_FLY": {"ready": False, "last_alert_epoch": 0.0},
                "CREDIT_SPREAD": {"ready": False, "last_alert_epoch": 0.0},
            },
            "trades": [],
            "next_trade_id": 1,
        }

    def _load(self) -> dict:
        if not self.path.exists():
            return self._default_state()

        try:
            raw = json.loads(self.path.read_text())
            if not isinstance(raw, dict):
                return self._default_state()

            state = self._default_state()
            state.update(raw)

            if not isinstance(state.get("strategies"), dict):
                state["strategies"] = self._default_state()["strategies"]
            if not isinstance(state.get("trades"), list):
                state["trades"] = []
            if not isinstance(state.get("next_trade_id"), int):
                state["next_trade_id"] = 1

            return state
        except Exception:
            return self._default_state()

    def _save(self) -> None:
        self.path.write_text(json.dumps(self.state, indent=2, sort_keys=True))

    def _with_effective_rollover_policy(self, trade: dict) -> dict:
        out = dict(trade)
        out["rolloverPolicy"] = _trade_rollover_policy(out)
        return out


def _as_et(value: dt.datetime) -> dt.datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=ET)
    return value.astimezone(ET)
