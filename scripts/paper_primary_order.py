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


def _build_entry_order(legs: list[dict[str, Any]], price: Decimal):
    from tastytrade.order import InstrumentType, Leg, NewOrder, OrderAction, OrderTimeInForce, OrderType

    action_map = {
        "BUY_TO_OPEN": OrderAction.BUY_TO_OPEN,
        "SELL_TO_OPEN": OrderAction.SELL_TO_OPEN,
        "BUY_TO_CLOSE": OrderAction.BUY_TO_CLOSE,
        "SELL_TO_CLOSE": OrderAction.SELL_TO_CLOSE,
    }

    built_legs: list[Leg] = []
    for leg in legs:
        symbol = str(leg.get("symbol", "")).strip()
        action = str(leg.get("action", "")).upper()
        qty = int(leg.get("qty", 1) or 1)
        if not symbol:
            raise RuntimeError("Missing option symbol in one or more legs.")
        if action not in action_map:
            raise RuntimeError(f"Unsupported leg action for entry: {action}")
        built_legs.append(
            Leg(
                instrument_type=InstrumentType.EQUITY_OPTION,
                symbol=symbol,
                action=action_map[action],
                quantity=qty,
            )
        )

    order_type = OrderType.LIMIT
    return NewOrder(
        time_in_force=OrderTimeInForce.DAY,
        order_type=order_type,
        price=price,
        legs=built_legs,
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
        legs = payload.get("legs")
        if not isinstance(legs, list) or not legs:
            raise RuntimeError("Missing legs payload for paper order.")

        order_side = str(payload.get("order_side", "CREDIT")).upper()
        limit_price = _d(payload.get("limit_price", "0"))
        dry_run = bool(payload.get("dry_run", False))
        account_number = str(payload.get("account_number", "")).strip() or None
        strategy = str(payload.get("strategy", "Primary Strategy")).strip()

        if limit_price <= 0:
            raise RuntimeError("Invalid limit price.")
        if order_side not in {"CREDIT", "DEBIT"}:
            raise RuntimeError("order_side must be CREDIT or DEBIT.")

        session = _session()
        acct = await _account(session, account_number)

        entry = _build_entry_order(legs, limit_price)
        entry_resp = await _maybe_await(acct.place_order(session, entry, dry_run=dry_run))
        entry_data = _serialize_order_response(entry_resp)

        result: dict[str, Any] = {
            "ok": not bool(entry_data.get("errors")),
            "mode": "paper",
            "dry_run": dry_run,
            "strategy": strategy,
            "order_side": order_side,
            "entry": entry_data,
            "message": "Paper order submitted." if not dry_run else "Paper dry-run completed.",
        }
        print(json.dumps(result))
    except Exception as exc:
        print(json.dumps({"ok": False, "mode": "paper", "message": _format_exc(exc)}))
        raise SystemExit(1)


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()
