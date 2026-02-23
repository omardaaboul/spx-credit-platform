#!/usr/bin/env python3
"""Minimal live connectivity check for SPX option quotes/greeks via tastytrade DXLink."""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import inspect
import os
import sys
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional
from zoneinfo import ZoneInfo

try:
    from dotenv import load_dotenv
except Exception:  # pragma: no cover
    load_dotenv = None


ET = ZoneInfo("America/New_York")
UTC = ZoneInfo("UTC")


@dataclass(frozen=True)
class ContractRef:
    right: str  # CALL/PUT
    strike: float
    option_symbol: str
    streamer_symbol: str
    expiration: dt.date


class LiveState:
    def __init__(self, symbols: list[str], start_mono: float) -> None:
        self.symbols = symbols
        self.start_mono = start_mono
        self.quote_times: deque[float] = deque()
        self.greeks_times: deque[float] = deque()
        self.total_quotes_10s = 0
        self.quote_after_first_second = False
        self.latest_quote: dict[str, dict[str, Optional[float]]] = {}
        self.latest_greeks: dict[str, dict[str, Optional[float]]] = {}

    def on_quote(self, symbol: str, bid: Optional[float], ask: Optional[float]) -> None:
        now = asyncio.get_running_loop().time()
        self.quote_times.append(now)
        if now - self.start_mono <= 10.0:
            self.total_quotes_10s += 1
        if now - self.start_mono > 1.0:
            self.quote_after_first_second = True
        mid = None
        if bid is not None and ask is not None:
            mid = (bid + ask) / 2.0
        self.latest_quote[symbol] = {"bid": bid, "ask": ask, "mid": mid}

    def on_greeks(self, symbol: str, delta: Optional[float], theta: Optional[float], iv: Optional[float]) -> None:
        now = asyncio.get_running_loop().time()
        self.greeks_times.append(now)
        self.latest_greeks[symbol] = {"delta": delta, "theta": theta, "iv": iv}

    def count_1s(self, q: deque[float]) -> int:
        now = asyncio.get_running_loop().time()
        cutoff = now - 1.0
        while q and q[0] < cutoff:
            q.popleft()
        return len(q)


def _obj_get(obj: Any, *names: str) -> Any:
    for name in names:
        if obj is None:
            return None
        if isinstance(obj, dict) and name in obj:
            return obj.get(name)
        if hasattr(obj, name):
            return getattr(obj, name)
    return None


def _to_float(value: Any) -> Optional[float]:
    try:
        if value is None:
            return None
        v = float(value)
        return v if v == v else None
    except Exception:
        return None


def _to_date(value: Any) -> Optional[dt.date]:
    if value is None:
        return None
    if isinstance(value, dt.date):
        return value
    if isinstance(value, str):
        for fmt in ("%Y-%m-%d", "%Y/%m/%d"):
            try:
                return dt.datetime.strptime(value[:10], fmt).date()
            except Exception:
                continue
    return None


async def _maybe_await(value: Any) -> Any:
    if asyncio.iscoroutine(value):
        return await value
    return value


async def _call_variants(fn: Any, arg_variants: list[tuple[list[Any], dict[str, Any]]]) -> Any:
    last_exc: Optional[Exception] = None
    for args, kwargs in arg_variants:
        try:
            return await _maybe_await(fn(*args, **kwargs))
        except Exception as exc:
            last_exc = exc
    if last_exc is not None:
        raise last_exc
    raise RuntimeError("No call variants available")


def _load_env() -> None:
    if load_dotenv is None:
        return
    load_dotenv()
    root_env = Path(__file__).resolve().parents[1] / ".env"
    if root_env.exists():
        load_dotenv(root_env)


def _build_session(Session: Any) -> Any:
    params = list(inspect.signature(Session).parameters.keys())
    # tastytrade>=12 uses OAuth provider_secret + refresh_token.
    if "provider_secret" in params and "refresh_token" in params:
        provider_secret = os.getenv("TASTY_CLIENT_SECRET") or os.getenv("TASTYTRADE_CLIENT_SECRET")
        refresh_token = os.getenv("TASTY_REFRESH_TOKEN") or os.getenv("TASTYTRADE_REFRESH_TOKEN")
        if not provider_secret or not refresh_token:
            raise RuntimeError(
                "This tastytrade SDK version requires OAuth credentials. "
                "Set TASTY_CLIENT_SECRET and TASTY_REFRESH_TOKEN."
            )
        variants: list[tuple[list[Any], dict[str, Any]]] = [
            ([provider_secret, refresh_token], {"is_test": False}),
            ([provider_secret, refresh_token], {}),
        ]
    else:
        username = os.getenv("TASTYTRADE_USERNAME") or os.getenv("TASTY_USERNAME")
        password = os.getenv("TASTYTRADE_PASSWORD") or os.getenv("TASTY_PASSWORD")
        if not username or not password:
            raise RuntimeError(
                "Missing credentials. Set TASTYTRADE_USERNAME and TASTYTRADE_PASSWORD "
                "(or TASTY_USERNAME/TASTY_PASSWORD)."
            )
        variants = [
            ([username, password], {"is_test": False}),
            ([username, password], {}),
        ]

    last_exc: Optional[Exception] = None
    for args, kwargs in variants:
        try:
            return Session(*args, **kwargs)
        except Exception as exc:
            last_exc = exc
    raise RuntimeError(f"Login failed: {last_exc}")


def _chain_rows(chain: Any) -> list[Any]:
    if chain is None:
        return []
    if isinstance(chain, list):
        return [row for row in chain if row is not None]
    return [chain]


def _chain_expirations(chain: Any) -> list[Any]:
    out: list[Any] = []
    for row in _chain_rows(chain):
        expirations = _obj_get(row, "expirations")
        if isinstance(expirations, list):
            out.extend(expirations)
    return out


def _expiration_strikes(chain: Any, expiration: dt.date) -> list[Any]:
    for row in _chain_rows(chain):
        expirations = _obj_get(row, "expirations")
        if not isinstance(expirations, list):
            continue
        for exp in expirations:
            exp_date = _to_date(_obj_get(exp, "expiration_date", "date"))
            if exp_date == expiration:
                strikes = _obj_get(exp, "strikes")
                if isinstance(strikes, list):
                    return strikes
    return []


def _choose_expiration(chain: Any, today: dt.date) -> dt.date:
    candidates: list[dt.date] = []
    for exp in _chain_expirations(chain):
        exp_date = _to_date(_obj_get(exp, "expiration_date", "date"))
        if exp_date is None:
            continue
        if exp_date >= today:
            candidates.append(exp_date)
    if not candidates:
        raise RuntimeError("No expiration >= today found in SPX chain.")
    candidates = sorted(set(candidates))
    if today in candidates:
        return today
    return candidates[0]


def _extract_contracts(chain: Any, expiration: dt.date, spot: float) -> list[ContractRef]:
    strikes = _expiration_strikes(chain, expiration)
    if not strikes:
        raise RuntimeError(f"No strikes found for expiration {expiration.isoformat()}.")

    calls: list[ContractRef] = []
    puts: list[ContractRef] = []

    for row in strikes:
        strike = _to_float(_obj_get(row, "strike_price", "strike"))
        if strike is None:
            continue

        call_symbol = str(_obj_get(row, "call") or "")
        put_symbol = str(_obj_get(row, "put") or "")
        call_streamer = str(_obj_get(row, "call_streamer_symbol") or call_symbol or "")
        put_streamer = str(_obj_get(row, "put_streamer_symbol") or put_symbol or "")

        if call_symbol and call_streamer:
            calls.append(
                ContractRef(
                    right="CALL",
                    strike=float(strike),
                    option_symbol=call_symbol,
                    streamer_symbol=call_streamer,
                    expiration=expiration,
                )
            )
        if put_symbol and put_streamer:
            puts.append(
                ContractRef(
                    right="PUT",
                    strike=float(strike),
                    option_symbol=put_symbol,
                    streamer_symbol=put_streamer,
                    expiration=expiration,
                )
            )

    calls.sort(key=lambda c: (abs(c.strike - spot), c.strike))
    puts.sort(key=lambda p: (abs(p.strike - spot), p.strike))

    if len(calls) < 3 or len(puts) < 3:
        raise RuntimeError(
            f"Insufficient contracts near ATM (calls={len(calls)}, puts={len(puts)})."
        )

    selected = calls[:3] + puts[:3]
    return selected


async def _fetch_spot(session: Any) -> float:
    from tastytrade.market_data import get_market_data_by_type

    # Keep this aligned with the known-working pattern used elsewhere in this repo.
    rows = await _call_variants(
        get_market_data_by_type,
        [
            ([session], {"indices": ["SPX"]}),
        ],
    )
    if not isinstance(rows, list):
        raise RuntimeError("SPX market data response is not a list.")
    for row in rows:
        symbol = str(_obj_get(row, "symbol") or "").upper()
        if symbol != "SPX":
            continue
        for key in ("last", "last_price", "mark", "mark_price", "close"):
            value = _to_float(_obj_get(row, key))
            if value is not None and value > 0:
                return value
    raise RuntimeError("Unable to derive SPX spot from market data.")


async def _fetch_chain(session: Any) -> Any:
    from tastytrade.instruments import NestedOptionChain

    chain = await _call_variants(
        NestedOptionChain.get,
        [
            ([session, "SPX"], {}),
            ([session], {"symbol": "SPX"}),
        ],
    )
    if chain is None:
        raise RuntimeError("NestedOptionChain.get returned None.")
    return chain


async def _subscribe(streamer: Any, event_cls: Any, symbols: list[str]) -> None:
    await _call_variants(
        streamer.subscribe,
        [
            ([event_cls, symbols], {"refresh_interval": 0.2}),
            ([event_cls, symbols], {}),
        ],
    )


def _fmt_num(value: Optional[float], digits: int = 2) -> str:
    if value is None:
        return "-"
    return f"{value:.{digits}f}"


async def _consume_quotes(
    streamer: Any,
    Quote: Any,
    state: LiveState,
    stop_event: asyncio.Event,
    disconnect_event: asyncio.Event,
    disconnect_reason: dict[str, str],
) -> None:
    while not stop_event.is_set():
        try:
            event = await asyncio.wait_for(streamer.get_event(Quote), timeout=1.0)
        except asyncio.TimeoutError:
            continue
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            disconnect_reason["error"] = f"Quote stream error: {exc}"
            disconnect_event.set()
            return

        symbol = str(_obj_get(event, "event_symbol", "symbol") or "")
        if not symbol:
            continue
        bid = _to_float(_obj_get(event, "bid_price", "bid"))
        ask = _to_float(_obj_get(event, "ask_price", "ask"))
        state.on_quote(symbol, bid, ask)


async def _consume_greeks(
    streamer: Any,
    Greeks: Any,
    state: LiveState,
    stop_event: asyncio.Event,
    disconnect_event: asyncio.Event,
    disconnect_reason: dict[str, str],
) -> None:
    while not stop_event.is_set():
        try:
            event = await asyncio.wait_for(streamer.get_event(Greeks), timeout=1.0)
        except asyncio.TimeoutError:
            continue
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            disconnect_reason["error"] = f"Greeks stream error: {exc}"
            disconnect_event.set()
            return

        symbol = str(_obj_get(event, "event_symbol", "symbol") or "")
        if not symbol:
            continue
        delta = _to_float(_obj_get(event, "delta"))
        theta = _to_float(_obj_get(event, "theta"))
        iv = _to_float(_obj_get(event, "volatility", "implied_volatility", "iv"))
        state.on_greeks(symbol, delta, theta, iv)


async def _run_stream_once(session: Any, contracts: list[ContractRef], duration_s: int) -> bool:
    from tastytrade import DXLinkStreamer
    from tastytrade.dxfeed import Greeks, Quote

    symbols = [c.streamer_symbol for c in contracts]
    print(f"Subscribing {len(symbols)} symbols to Quote + Greeks ...")

    start_mono = asyncio.get_running_loop().time()
    state = LiveState(symbols=symbols, start_mono=start_mono)
    stop_event = asyncio.Event()
    disconnect_event = asyncio.Event()
    disconnect_reason: dict[str, str] = {}

    warned_zero_updates = False

    async with DXLinkStreamer(session) as streamer:
        await _subscribe(streamer, Quote, symbols)
        await _subscribe(streamer, Greeks, symbols)

        q_task = asyncio.create_task(_consume_quotes(streamer, Quote, state, stop_event, disconnect_event, disconnect_reason))
        g_task = asyncio.create_task(_consume_greeks(streamer, Greeks, state, stop_event, disconnect_event, disconnect_reason))

        try:
            for sec in range(1, duration_s + 1):
                await asyncio.sleep(1)
                qps = state.count_1s(state.quote_times)
                gps = state.count_1s(state.greeks_times)
                print(f"[{sec:02d}s] quotes_1s={qps} greeks_1s={gps}")

                for c in contracts:
                    q = state.latest_quote.get(c.streamer_symbol, {})
                    g = state.latest_greeks.get(c.streamer_symbol, {})
                    print(
                        "  "
                        f"{c.right:<4} {c.strike:>7.2f} | "
                        f"bid={_fmt_num(q.get('bid'))} ask={_fmt_num(q.get('ask'))} mid={_fmt_num(q.get('mid'))} | "
                        f"delta={_fmt_num(g.get('delta'), 3)} theta={_fmt_num(g.get('theta'), 3)} iv={_fmt_num(g.get('iv'), 4)}"
                    )

                if sec >= 10 and state.total_quotes_10s == 0 and not warned_zero_updates:
                    warned_zero_updates = True
                    print("WARNING: No quote updates received in first 10 seconds.")

                if disconnect_event.is_set():
                    raise RuntimeError(disconnect_reason.get("error", "DXLink disconnected."))

        finally:
            stop_event.set()
            q_task.cancel()
            g_task.cancel()
            await asyncio.gather(q_task, g_task, return_exceptions=True)

    pass_quotes = state.total_quotes_10s >= 5
    pass_streaming = state.quote_after_first_second

    print("\nSummary:")
    print(f"  quote_updates_first_10s = {state.total_quotes_10s}")
    print(f"  quote_update_after_1s  = {state.quote_after_first_second}")

    if pass_quotes and pass_streaming:
        print("PASS: Live DXLink streaming is healthy.")
        return True

    print("FAIL: Streaming criteria not met.")
    print("Likely causes:")
    print("  - Contract symbol used instead of DXLink streamer_symbol.")
    print("  - Market data permissions are missing for SPX options.")
    print("  - Session/quote token expired or websocket disconnected.")
    return False


async def run(duration_s: int, retries: int) -> int:
    try:
        from tastytrade import Session
    except Exception as exc:
        print(f"FAIL: Unable to import tastytrade SDK: {exc}")
        return 2

    _load_env()

    try:
        session = _build_session(Session)
    except Exception as exc:
        print(f"FAIL: {exc}")
        return 2

    print("Login OK.")

    try:
        spot = await _fetch_spot(session)
        chain = await _fetch_chain(session)
    except Exception as exc:
        print(f"FAIL: Unable to fetch SPX market/chain data: {exc}")
        return 2

    today_et = dt.datetime.now(tz=ET).date()
    try:
        expiration = _choose_expiration(chain, today_et)
        contracts = _extract_contracts(chain, expiration, spot)
    except Exception as exc:
        print(f"FAIL: Unable to build ATM contract set: {exc}")
        return 2

    dte = (expiration - today_et).days
    print(f"Spot={spot:.2f} | expiration={expiration.isoformat()} (DTE={dte})")
    for c in contracts:
        print(f"  {c.right:<4} strike={c.strike:.2f} opt={c.option_symbol} stream={c.streamer_symbol}")

    attempts = max(1, retries)
    backoff = 1.0

    for attempt in range(1, attempts + 1):
        try:
            ok = await _run_stream_once(session=session, contracts=contracts, duration_s=duration_s)
            return 0 if ok else 1
        except KeyboardInterrupt:
            print("Interrupted by user.")
            return 130
        except Exception as exc:
            if attempt >= attempts:
                print(f"FAIL: Stream failed after {attempt} attempt(s): {exc}")
                print("Likely causes:")
                print("  - websocket disconnect / network instability")
                print("  - expired auth/session")
                print("  - missing real-time options permissions")
                return 1
            print(f"Stream error (attempt {attempt}/{attempts}): {exc}")
            print(f"Retrying in {backoff:.1f}s ...")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2.0, 8.0)

    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description="tastytrade DXLink live check for SPX options")
    parser.add_argument("--duration", type=int, default=30, help="Heartbeat duration in seconds (default: 30)")
    parser.add_argument("--retries", type=int, default=3, help="Max reconnect retries on stream disconnect (default: 3)")
    args = parser.parse_args()

    if args.duration < 5:
        print("--duration must be >= 5")
        return 2

    try:
        return asyncio.run(run(duration_s=args.duration, retries=args.retries))
    except KeyboardInterrupt:
        print("Interrupted by user.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
