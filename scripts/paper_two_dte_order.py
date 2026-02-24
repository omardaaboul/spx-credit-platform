from __future__ import annotations

import asyncio
import inspect
import json
import os
import sys
from decimal import Decimal, ROUND_HALF_UP
from typing import Any


def _read_payload() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        raise ValueError("Empty payload.")
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise ValueError("Payload must be a JSON object.")
    return parsed


def _session():
    from tastytrade import Session

    secret = os.getenv("TASTY_API_SECRET")
    refresh = os.getenv("TASTY_API_TOKEN")
    is_test = os.getenv("TASTY_IS_TEST", "false").lower() in {"1", "true", "yes", "on"}
    require_test = os.getenv("SPX0DTE_PAPER_REQUIRE_TEST", "true").lower() in {"1", "true", "yes", "on"}

    if require_test and not is_test:
        raise RuntimeError("Paper trading requires TASTY_IS_TEST=true.")

    try:
        params = set(inspect.signature(Session).parameters.keys())
    except Exception:
        params = set()

    oauth_only = {"provider_secret", "refresh_token"}.issubset(params)
    if oauth_only:
        if not (secret and refresh):
            raise RuntimeError(
                "Installed tastytrade SDK requires OAuth credentials. "
                "Set TASTY_API_TOKEN and TASTY_API_SECRET."
            )
        return Session(secret, refresh, is_test=is_test)

    if secret and refresh:
        return Session(secret, refresh, is_test=is_test)
    raise RuntimeError("TASTY_AUTH_FAILED: Missing tasty credentials for paper trading (TASTY_API_TOKEN/TASTY_API_SECRET).")


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


async def _account(session, account_number: str | None):
    from tastytrade import Account

    acct = await _maybe_await(Account.get(session, account_number=account_number))
    if isinstance(acct, list):
        if not acct:
            raise RuntimeError("No account available in tasty session.")
        return acct[0]
    return acct


def _d(value: Any) -> Decimal:
    q = Decimal(str(value))
    return q.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _format_exc(exc: Exception) -> str:
    text = str(exc).strip()
    if text:
        return text
    args_text = " | ".join(str(a).strip() for a in getattr(exc, "args", ()) if str(a).strip())
    if args_text:
        return f"{exc.__class__.__name__}: {args_text}"
    return f"{exc.__class__.__name__}: {repr(exc)}"


def _build_entry_order(short_symbol: str, long_symbol: str, credit: Decimal):
    from tastytrade.order import InstrumentType, Leg, NewOrder, OrderAction, OrderTimeInForce, OrderType

    return NewOrder(
        time_in_force=OrderTimeInForce.DAY,
        order_type=OrderType.LIMIT,
        price=credit,
        legs=[
            Leg(
                instrument_type=InstrumentType.EQUITY_OPTION,
                symbol=short_symbol,
                action=OrderAction.SELL_TO_OPEN,
                quantity=1,
            ),
            Leg(
                instrument_type=InstrumentType.EQUITY_OPTION,
                symbol=long_symbol,
                action=OrderAction.BUY_TO_OPEN,
                quantity=1,
            ),
        ],
    )


def _build_profit_order(short_symbol: str, long_symbol: str, debit: Decimal):
    from tastytrade.order import InstrumentType, Leg, NewOrder, OrderAction, OrderTimeInForce, OrderType

    return NewOrder(
        time_in_force=OrderTimeInForce.GTC,
        order_type=OrderType.LIMIT,
        price=debit,
        legs=[
            Leg(
                instrument_type=InstrumentType.EQUITY_OPTION,
                symbol=short_symbol,
                action=OrderAction.BUY_TO_CLOSE,
                quantity=1,
            ),
            Leg(
                instrument_type=InstrumentType.EQUITY_OPTION,
                symbol=long_symbol,
                action=OrderAction.SELL_TO_CLOSE,
                quantity=1,
            ),
        ],
    )


def _build_stop_order(short_symbol: str, long_symbol: str, stop_debit: Decimal):
    from tastytrade.order import InstrumentType, Leg, NewOrder, OrderAction, OrderTimeInForce, OrderType

    limit_price = (stop_debit + Decimal("0.10")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return NewOrder(
        time_in_force=OrderTimeInForce.DAY,
        order_type=OrderType.STOP_LIMIT,
        price=limit_price,
        stop_trigger=stop_debit,
        legs=[
            Leg(
                instrument_type=InstrumentType.EQUITY_OPTION,
                symbol=short_symbol,
                action=OrderAction.BUY_TO_CLOSE,
                quantity=1,
            ),
            Leg(
                instrument_type=InstrumentType.EQUITY_OPTION,
                symbol=long_symbol,
                action=OrderAction.SELL_TO_CLOSE,
                quantity=1,
            ),
        ],
    )


def _serialize_order_response(resp: Any) -> dict[str, Any]:
    order = getattr(resp, "order", None)
    return {
        "order_id": getattr(order, "id", None),
        "status": str(getattr(order, "status", "")),
        "warnings": [str(w) for w in (getattr(resp, "warnings", None) or [])],
        "errors": [str(e) for e in (getattr(resp, "errors", None) or [])],
    }


async def _run() -> None:
    try:
        payload = _read_payload()
        short_symbol = str(payload.get("short_symbol", "")).strip()
        long_symbol = str(payload.get("long_symbol", "")).strip()
        entry_credit = _d(payload.get("entry_credit", "0"))
        stop_debit = _d(payload.get("stop_debit", "0"))
        profit_take_debit = _d(payload.get("profit_take_debit", "0.05"))
        dry_run = bool(payload.get("dry_run", False))
        account_number = str(payload.get("account_number", "")).strip() or None

        if not short_symbol or not long_symbol:
            raise RuntimeError("Missing option symbols for short/long legs.")
        if entry_credit <= 0:
            raise RuntimeError("Invalid entry credit.")
        if stop_debit <= 0:
            raise RuntimeError("Invalid stop debit.")

        session = _session()
        acct = await _account(session, account_number)

        entry = _build_entry_order(short_symbol, long_symbol, entry_credit)
        entry_resp = await _maybe_await(acct.place_order(session, entry, dry_run=dry_run))
        entry_data = _serialize_order_response(entry_resp)

        result: dict[str, Any] = {
            "ok": True,
            "mode": "paper",
            "dry_run": dry_run,
            "entry": entry_data,
            "profit": None,
            "stop": None,
            "message": "Paper order submitted.",
        }

        has_entry_errors = bool(entry_data.get("errors"))
        if not dry_run and not has_entry_errors:
            profit_order = _build_profit_order(short_symbol, long_symbol, profit_take_debit)
            stop_order = _build_stop_order(short_symbol, long_symbol, stop_debit)
            profit_resp = await _maybe_await(acct.place_order(session, profit_order, dry_run=False))
            stop_resp = await _maybe_await(acct.place_order(session, stop_order, dry_run=False))
            result["profit"] = _serialize_order_response(profit_resp)
            result["stop"] = _serialize_order_response(stop_resp)
            result["message"] = "Paper entry + stop/profit orders submitted."
        elif dry_run:
            result["message"] = "Paper dry-run completed (no live test orders sent)."

        print(json.dumps(result))
    except Exception as exc:
        print(json.dumps({"ok": False, "mode": "paper", "message": _format_exc(exc)}))
        raise SystemExit(1)


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()
