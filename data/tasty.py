from __future__ import annotations

import asyncio
import datetime as dt
import inspect
import os
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Optional
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
UTC = dt.timezone.utc


@dataclass
class CandleBar:
    timestamp: dt.datetime
    open: float
    high: float
    low: float
    close: float
    volume: float
    vwap: Optional[float]


@dataclass
class OptionSnapshot:
    option_symbol: str
    streamer_symbol: str
    right: str
    strike: float
    expiration: dt.date
    bid: Optional[float]
    ask: Optional[float]
    mid: Optional[float]
    delta: Optional[float]
    gamma: Optional[float]
    theta: Optional[float]
    iv: Optional[float]
    vega: Optional[float] = None


@dataclass
class MarketSnapshot:
    timestamp_et: dt.datetime
    spot: Optional[float] = None
    open_price: Optional[float] = None
    prior_close: Optional[float] = None
    vix: Optional[float] = None
    vix_prior_close: Optional[float] = None
    vix_change_pct: Optional[float] = None
    iv_rank: Optional[float] = None
    atm_iv: Optional[float] = None
    expiration_iv: Optional[float] = None
    options: list[OptionSnapshot] = field(default_factory=list)
    options_2dte: list[OptionSnapshot] = field(default_factory=list)
    expiration_2dte: Optional[dt.date] = None
    options_by_target_dte: dict[int, list[OptionSnapshot]] = field(default_factory=dict)
    expirations_by_target_dte: dict[int, dt.date] = field(default_factory=dict)
    options_bwb: list[OptionSnapshot] = field(default_factory=list)
    expiration_bwb: Optional[dt.date] = None
    candles_1m: list[CandleBar] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


class TastyDataClient:
    """Polling-oriented market-data client for local Streamlit use."""

    def __init__(self, symbol: str = "SPX") -> None:
        self.symbol = symbol
        # Keep trading-mode compatibility but allow market-data mode to be controlled separately.
        # If override is not set, default market-data to live (is_test=False) for reliable SPX/SPXW chain access.
        self._is_test = os.getenv("TASTY_IS_TEST", "false").lower() in {"1", "true", "yes", "on"}
        md_override = os.getenv("TASTY_MARKETDATA_IS_TEST")
        self._marketdata_override_explicit = md_override is not None
        if md_override is None:
            self._marketdata_is_test = False
        else:
            self._marketdata_is_test = md_override.lower() in {"1", "true", "yes", "on"}

    def fetch_snapshot(self, symbol: Optional[str] = None, candle_lookback_minutes: int = 420) -> MarketSnapshot:
        symbol = symbol or self.symbol
        now_et = dt.datetime.now(ET)

        if not self._has_any_tasty_credentials():
            return MarketSnapshot(
                timestamp_et=now_et,
                warnings=[
                    "Missing tastytrade credentials. Set TASTY_USERNAME/TASTY_PASSWORD "
                    "(or TASTYTRADE_USERNAME/TASTYTRADE_PASSWORD) or "
                    "TASTY_CLIENT_SECRET/TASTY_REFRESH_TOKEN."
                ],
            )

        try:
            return self._run_async(self._fetch_snapshot_async(symbol=symbol, now_et=now_et, candle_lookback_minutes=candle_lookback_minutes))
        except Exception as exc:
            return MarketSnapshot(
                timestamp_et=now_et,
                warnings=[f"tastytrade fetch failed: {exc}"],
            )

    async def _fetch_snapshot_async(
        self,
        symbol: str,
        now_et: dt.datetime,
        candle_lookback_minutes: int,
    ) -> MarketSnapshot:
        primary = await self._fetch_snapshot_with_mode(
            symbol=symbol,
            now_et=now_et,
            candle_lookback_minutes=candle_lookback_minutes,
            is_test_mode=self._marketdata_is_test,
        )
        if self._marketdata_override_explicit:
            return primary
        if self._has_usable_chain(primary):
            return primary

        alt_mode = not self._marketdata_is_test
        alternate = await self._fetch_snapshot_with_mode(
            symbol=symbol,
            now_et=now_et,
            candle_lookback_minutes=candle_lookback_minutes,
            is_test_mode=alt_mode,
        )
        if self._snapshot_score(alternate) > self._snapshot_score(primary):
            alternate.warnings.append(f"Market-data fallback selected is_test={str(alt_mode).lower()}.")
            return alternate
        return primary

    async def _fetch_snapshot_with_mode(
        self,
        symbol: str,
        now_et: dt.datetime,
        candle_lookback_minutes: int,
        is_test_mode: bool,
    ) -> MarketSnapshot:
        snapshot = MarketSnapshot(timestamp_et=now_et)

        try:
            from tastytrade import DXLinkStreamer, Session
            from tastytrade.dxfeed import Candle, Greeks, Quote
            from tastytrade.instruments import NestedOptionChain
            from tastytrade.market_data import get_market_data_by_type
            from tastytrade.metrics import get_market_metrics
        except Exception as exc:
            snapshot.warnings.append(
                f"`tastytrade` package import failed: {exc}. Install dependencies from requirements.txt."
            )
            return snapshot

        session = self._build_sdk_session(Session, is_test_mode=is_test_mode)
        if session is None:
            snapshot.warnings.append(
                f"Unable to authenticate to tastytrade in is_test={str(is_test_mode).lower()} mode."
            )
            return snapshot

        market_task = self._safe_call_with_error(
            get_market_data_by_type,
            session,
            kwargs_variants=[{"indices": [symbol, "VIX"]}],
            default=[],
        )
        metrics_task = self._safe_call_with_error(
            get_market_metrics,
            session,
            kwargs_variants=[{"symbols": [symbol]}],
            default=[],
        )
        chain_task = self._safe_call_with_error(
            NestedOptionChain.get,
            session,
            args_variants=[[symbol]],
            default=None,
        )
        (market_data, market_data_err), (metrics, metrics_err), (chain, chain_err) = await asyncio.gather(
            market_task,
            metrics_task,
            chain_task,
        )

        if market_data_err:
            snapshot.warnings.append(
                f"Index snapshot request failed (is_test={str(is_test_mode).lower()}): {market_data_err}"
            )
        self._apply_market_data(snapshot, market_data)

        if metrics_err:
            snapshot.warnings.append(f"Market metrics request failed: {metrics_err}")
        self._apply_market_metrics(snapshot, metrics, now_et.date())

        if chain_err:
            snapshot.warnings.append(
                f"Option chain request failed for {symbol} (is_test={str(is_test_mode).lower()}): {chain_err}"
            )
        strike_rows = self._extract_today_strikes(chain, now_et.date(), snapshot.spot)
        strike_rows_2dte, exp_2dte = self._extract_2dte_strikes(chain, now_et.date(), snapshot.spot)
        target_dtes = [2, 7, 14, 30, 45]
        strike_rows_by_target: dict[int, list[dict[str, Any]]] = {}
        expirations_by_target: dict[int, dt.date] = {}
        for target in target_dtes:
            rows_target, exp_target = self._extract_target_dte_strikes(chain, now_et.date(), snapshot.spot, target)
            strike_rows_by_target[target] = rows_target
            if exp_target is not None:
                expirations_by_target[target] = exp_target
        strike_rows_bwb, exp_bwb = self._extract_bwb_strikes(chain, now_et.date(), snapshot.spot)

        # Some accounts/sessions may return no same-day strikes on SPX, while SPXW has the weekly 0DTE set.
        # Fill any missing sleeves from SPXW before declaring chain-unavailable.
        fallback_notes: list[str] = []
        if symbol.upper() == "SPX" and (
            not strike_rows
            or not strike_rows_2dte
            or not strike_rows_bwb
            or any(not strike_rows_by_target.get(target) for target in target_dtes)
        ):
            chain_spxw, chain_spxw_err = await self._safe_call_with_error(
                NestedOptionChain.get,
                session,
                args_variants=[["SPXW"]],
                default=None,
            )
            if chain_spxw_err:
                snapshot.warnings.append(f"Option chain request failed for SPXW: {chain_spxw_err}")
            if chain_spxw is not None:
                if not strike_rows:
                    rows = self._extract_today_strikes(chain_spxw, now_et.date(), snapshot.spot)
                    if rows:
                        strike_rows = rows
                        fallback_notes.append("0DTE from SPXW")
                if not strike_rows_2dte:
                    rows_2dte, exp_spxw_2dte = self._extract_2dte_strikes(chain_spxw, now_et.date(), snapshot.spot)
                    if rows_2dte:
                        strike_rows_2dte = rows_2dte
                        exp_2dte = exp_spxw_2dte
                        fallback_notes.append("2-DTE from SPXW")
                for target in target_dtes:
                    if strike_rows_by_target.get(target):
                        continue
                    rows_target, exp_spxw_target = self._extract_target_dte_strikes(
                        chain_spxw,
                        now_et.date(),
                        snapshot.spot,
                        target,
                    )
                    if rows_target:
                        strike_rows_by_target[target] = rows_target
                        if exp_spxw_target is not None:
                            expirations_by_target[target] = exp_spxw_target
                        fallback_notes.append(f"{target}-DTE target from SPXW")
                if not strike_rows_bwb:
                    rows_bwb, exp_spxw_bwb = self._extract_bwb_strikes(chain_spxw, now_et.date(), snapshot.spot)
                    if rows_bwb:
                        strike_rows_bwb = rows_bwb
                        exp_bwb = exp_spxw_bwb
                        fallback_notes.append("BWB window from SPXW")

        snapshot.expiration_2dte = exp_2dte
        snapshot.expiration_bwb = exp_bwb
        snapshot.expirations_by_target_dte = expirations_by_target
        if fallback_notes:
            snapshot.warnings.append(f"Chain fallback active: {', '.join(fallback_notes)}.")
        if not strike_rows:
            snapshot.warnings.append("No same-day expiration strikes returned for SPX/SPXW.")
        if not strike_rows_2dte:
            snapshot.warnings.append("No 2-DTE expiration strikes returned for SPX.")
        for target in target_dtes:
            if not strike_rows_by_target.get(target):
                snapshot.warnings.append(f"No target expiration near {target}-DTE returned for SPX/SPXW.")
        if not strike_rows_bwb:
            snapshot.warnings.append("No 14-30 DTE expiration strikes returned for BWB sleeve.")
        if not strike_rows and not strike_rows_2dte and not strike_rows_bwb and is_test_mode:
            snapshot.warnings.append(
                "Market-data test mode may be limiting SPX chain. Set TASTY_MARKETDATA_IS_TEST=false."
            )
        if (
            not strike_rows
            and not strike_rows_2dte
            and not strike_rows_bwb
            and not any(strike_rows_by_target.get(target) for target in target_dtes)
        ):
            return snapshot

        streamer_symbols = self._select_streamer_symbols(
            rows=[
                *strike_rows,
                *strike_rows_2dte,
                *strike_rows_bwb,
                *[row for rows in strike_rows_by_target.values() for row in rows],
            ],
            spot=snapshot.spot,
            max_symbols=self._env_int("SPX0DTE_MAX_STREAM_SYMBOLS", 220),
        )

        quotes: dict[str, Any] = {}
        greeks: dict[str, Any] = {}
        candles: list[Any] = []
        verify_seconds = max(0, min(self._env_int("SPX0DTE_DXLINK_VERIFY_SECONDS", 0), 120))
        verify_enabled = verify_seconds > 0
        stream_retries = max(1, min(self._env_int("SPX0DTE_DXLINK_RETRIES", 3), 3))
        quote_timeout = self._env_float("SPX0DTE_STREAM_TIMEOUT_QUOTES", 1.4)
        candle_timeout = max(3.0, self._env_float("SPX0DTE_STREAM_TIMEOUT_CANDLES", 3.0))
        candle_retry_timeout = max(2.0, self._env_float("SPX0DTE_STREAM_TIMEOUT_CANDLES_RETRY", 2.5))
        min_candle_events = max(15, min(self._env_int("SPX0DTE_MIN_CANDLE_EVENTS", 120), 1400))
        max_quote_events = self._env_int("SPX0DTE_MAX_QUOTE_EVENTS", 140)
        backoff_s = 1.0

        if streamer_symbols:
            non_stream = [s for s in streamer_symbols if not self._looks_like_dxlink_symbol(s)]
            if non_stream:
                snapshot.warnings.append(
                    "Potential non-DXLink symbols detected (fallback to option_symbol). Verify streamer_symbol mapping."
                )

        for attempt in range(1, stream_retries + 1):
            try:
                async with DXLinkStreamer(session) as streamer:
                    if streamer_symbols:
                        _, quote_sub_err = await self._safe_call_with_error(
                            streamer.subscribe,
                            Quote,
                            # streamer.subscribe(event_cls, symbols, ...)
                            # symbols must be passed as a single positional list.
                            args_variants=[[streamer_symbols]],
                            kwargs_variants=[{"refresh_interval": 0.2}, {}],
                            default=None,
                        )
                        _, greeks_sub_err = await self._safe_call_with_error(
                            streamer.subscribe,
                            Greeks,
                            # streamer.subscribe(event_cls, symbols, ...)
                            # symbols must be passed as a single positional list.
                            args_variants=[[streamer_symbols]],
                            kwargs_variants=[{"refresh_interval": 0.2}, {}],
                            default=None,
                        )
                        if quote_sub_err:
                            snapshot.warnings.append(f"DXLink quote subscribe failed: {quote_sub_err}")
                        if greeks_sub_err:
                            snapshot.warnings.append(f"DXLink greeks subscribe failed: {greeks_sub_err}")
                        if verify_enabled:
                            verify = await self._verify_live_stream(
                                streamer=streamer,
                                quote_cls=Quote,
                                greeks_cls=Greeks,
                                symbols=streamer_symbols,
                                seconds=verify_seconds,
                                now_et=now_et,
                            )
                            quotes = verify["quotes"]
                            greeks = verify["greeks"]
                            status = "PASS" if verify["passed"] else "FAIL"
                            print(
                                f"DXLINK_VERIFY {status}: quote_updates_first_10s={verify['quote_updates_first_10s']} "
                                f"quote_update_after_first_second={verify['quote_update_after_first_second']} "
                                f"checks={verify.get('checks')}",
                                flush=True,
                                file=os.sys.stderr,
                            )
                            if not verify["passed"]:
                                snapshot.warnings.append(
                                    "DXLink verify failed: "
                                    + ", ".join(verify.get("failed_reasons") or ["unknown verification failure"])
                                )
                        else:
                            quotes = await self._collect_events(
                                streamer,
                                Quote,
                                streamer_symbols,
                                timeout_s=quote_timeout,
                                max_events=max_quote_events,
                            )
                            greeks = await self._collect_events(
                                streamer,
                                Greeks,
                                streamer_symbols,
                                timeout_s=quote_timeout,
                                max_events=max_quote_events,
                            )

                    start_time = (now_et - dt.timedelta(minutes=candle_lookback_minutes)).astimezone(UTC)
                    await self._safe_call(
                        streamer.subscribe_candle,
                        [symbol],
                        kwargs_variants=[
                            {
                                "interval": "1m",
                                "start_time": start_time,
                                "extended_trading_hours": False,
                                "refresh_interval": 0.2,
                            }
                        ],
                        default=None,
                    )
                    candles = await self._collect_candles(
                        streamer,
                        Candle,
                        timeout_s=candle_timeout,
                        max_events=1400,
                        min_events=min_candle_events,
                    )
                    if len(candles) < min_candle_events and candle_retry_timeout > 0:
                        extra = await self._collect_candles(
                            streamer,
                            Candle,
                            timeout_s=candle_retry_timeout,
                            max_events=1400,
                            min_events=min_candle_events,
                        )
                        if extra:
                            candles.extend(extra)
                break
            except KeyboardInterrupt:
                raise
            except Exception as exc:
                if attempt >= stream_retries:
                    snapshot.warnings.append(f"DXLink streaming unavailable after {attempt} attempts: {exc}")
                    break
                snapshot.warnings.append(
                    f"DXLink disconnected (attempt {attempt}/{stream_retries}): {exc}. Retrying in {backoff_s:.1f}s."
                )
                await asyncio.sleep(backoff_s)
                backoff_s = min(backoff_s * 2.0, 8.0)

        options = self._merge_option_data(strike_rows, quotes, greeks)
        options_2dte = self._merge_option_data(strike_rows_2dte, quotes, greeks)
        options_by_target = {
            target: self._merge_option_data(rows, quotes, greeks)
            for target, rows in strike_rows_by_target.items()
        }
        options_bwb = self._merge_option_data(strike_rows_bwb, quotes, greeks)
        snapshot.options = options
        snapshot.options_2dte = options_2dte
        snapshot.options_by_target_dte = options_by_target
        snapshot.options_bwb = options_bwb
        snapshot.candles_1m = self._normalize_candles(candles)

        atm_iv = self._derive_atm_iv(options, snapshot.spot)
        snapshot.atm_iv = atm_iv if atm_iv is not None else snapshot.expiration_iv

        if snapshot.vix is not None and snapshot.vix_prior_close not in (None, 0):
            snapshot.vix_change_pct = ((snapshot.vix - snapshot.vix_prior_close) / snapshot.vix_prior_close) * 100.0

        return snapshot

    @staticmethod
    def _has_usable_chain(snapshot: MarketSnapshot) -> bool:
        return bool(
            snapshot.options
            or snapshot.options_2dte
            or snapshot.options_bwb
            or any(snapshot.options_by_target_dte.values())
        )

    @staticmethod
    def _snapshot_score(snapshot: MarketSnapshot) -> int:
        score = 0
        if snapshot.spot is not None and snapshot.spot > 0:
            score += 2
        if snapshot.vix is not None and snapshot.vix > 0:
            score += 1
        if snapshot.options:
            score += 3
        if snapshot.options_2dte:
            score += 2
        if snapshot.options_bwb:
            score += 2
        if snapshot.options_by_target_dte:
            score += sum(1 for rows in snapshot.options_by_target_dte.values() if rows)
        if snapshot.candles_1m:
            score += 2
        return score

    @staticmethod
    def _env_int(name: str, default: int) -> int:
        raw = os.getenv(name)
        if raw is None:
            return default
        try:
            value = int(raw)
        except (TypeError, ValueError):
            return default
        return value if value > 0 else default

    @staticmethod
    def _env_float(name: str, default: float) -> float:
        raw = os.getenv(name)
        if raw is None:
            return default
        try:
            value = float(raw)
        except (TypeError, ValueError):
            return default
        return value if value > 0 else default

    @staticmethod
    def _select_streamer_symbols(rows: list[dict[str, Any]], spot: Optional[float], max_symbols: int) -> list[str]:
        if not rows:
            return []
        max_symbols = max(1, max_symbols)

        def _dedupe(sample_rows: list[dict[str, Any]]) -> list[str]:
            seen: set[str] = set()
            out: list[str] = []
            for row in sample_rows:
                sym = str(row.get("streamer_symbol") or "")
                if not sym or sym in seen:
                    continue
                seen.add(sym)
                out.append(sym)
                if len(out) >= max_symbols:
                    break
            return out

        if spot is None:
            return _dedupe(rows)

        ranked = sorted(
            rows,
            key=lambda row: abs(float(row.get("strike") or spot) - spot),
        )
        return _dedupe(ranked)

    @staticmethod
    def _run_async(coro: Any) -> Any:
        try:
            return asyncio.run(coro)
        except RuntimeError:
            loop = asyncio.new_event_loop()
            try:
                return loop.run_until_complete(coro)
            finally:
                loop.close()

    @staticmethod
    def _has_any_tasty_credentials() -> bool:
        username = os.getenv("TASTY_USERNAME") or os.getenv("TASTYTRADE_USERNAME")
        password = os.getenv("TASTY_PASSWORD") or os.getenv("TASTYTRADE_PASSWORD")
        have_user = bool(username and password)
        have_oauth = bool(os.getenv("TASTY_CLIENT_SECRET") and os.getenv("TASTY_REFRESH_TOKEN"))
        return have_user or have_oauth

    def _build_sdk_session(self, Session: Any, is_test_mode: bool) -> Any:
        secret = os.getenv("TASTY_CLIENT_SECRET")
        refresh = os.getenv("TASTY_REFRESH_TOKEN")
        username = os.getenv("TASTY_USERNAME") or os.getenv("TASTYTRADE_USERNAME")
        password = os.getenv("TASTY_PASSWORD") or os.getenv("TASTYTRADE_PASSWORD")

        try:
            param_names = list(inspect.signature(Session).parameters.keys())
        except Exception:
            param_names = []

        # tastytrade>=12 uses OAuth-style provider_secret + refresh_token.
        requires_oauth = "provider_secret" in param_names and "refresh_token" in param_names

        attempts: list[tuple[str, str]] = []
        if secret and refresh:
            attempts.append((secret, refresh))
        if not requires_oauth and username and password:
            attempts.append((username, password))

        kwargs_priority: list[dict[str, Any]] = [{"is_test": is_test_mode}, {}]

        for first, second in attempts:
            for kwargs in kwargs_priority:
                try:
                    return Session(first, second, **kwargs)
                except TypeError:
                    continue
                except Exception:
                    continue
        return None

    async def _safe_call(
        self,
        fn: Any,
        *leading_args: Any,
        args_variants: Optional[list[list[Any]]] = None,
        kwargs_variants: Optional[list[dict[str, Any]]] = None,
        default: Any = None,
    ) -> Any:
        args_variants = args_variants or [[]]
        kwargs_variants = kwargs_variants or [{}]
        last_exc: Optional[Exception] = None

        for av in args_variants:
            for kv in kwargs_variants:
                try:
                    result = fn(*leading_args, *av, **kv)
                    if asyncio.iscoroutine(result):
                        return await result
                    return result
                except Exception as exc:
                    last_exc = exc
                    continue
        if last_exc:
            return default
        return default

    async def _safe_call_with_error(
        self,
        fn: Any,
        *leading_args: Any,
        args_variants: Optional[list[list[Any]]] = None,
        kwargs_variants: Optional[list[dict[str, Any]]] = None,
        default: Any = None,
    ) -> tuple[Any, Optional[str]]:
        args_variants = args_variants or [[]]
        kwargs_variants = kwargs_variants or [{}]
        last_exc: Optional[Exception] = None

        for av in args_variants:
            for kv in kwargs_variants:
                try:
                    result = fn(*leading_args, *av, **kv)
                    if asyncio.iscoroutine(result):
                        return await result, None
                    return result, None
                except Exception as exc:
                    last_exc = exc
                    continue

        if last_exc is None:
            return default, None
        exc_name = last_exc.__class__.__name__
        exc_text = str(last_exc).strip()
        if len(exc_text) > 180:
            exc_text = exc_text[:177] + "..."
        if exc_text:
            return default, f"{exc_name}: {exc_text}"
        return default, exc_name

    @staticmethod
    def _looks_like_dxlink_symbol(symbol: str) -> bool:
        s = str(symbol or "").strip()
        if not s:
            return False
        return s.startswith(".") or ":" in s

    @staticmethod
    def _prune_times(q: deque[float], now: float, window_s: float = 1.0) -> int:
        cutoff = now - window_s
        while q and q[0] < cutoff:
            q.popleft()
        return len(q)

    @staticmethod
    def _is_us_rth_et(now_et: dt.datetime) -> bool:
        if now_et.tzinfo is None:
            now_et = now_et.replace(tzinfo=ET)
        else:
            now_et = now_et.astimezone(ET)
        if now_et.weekday() >= 5:
            return False
        minutes = now_et.hour * 60 + now_et.minute
        open_min = 9 * 60 + 30
        close_min = 16 * 60
        return open_min <= minutes < close_min

    async def _verify_live_stream(
        self,
        streamer: Any,
        quote_cls: Any,
        greeks_cls: Any,
        symbols: list[str],
        seconds: int,
        now_et: Optional[dt.datetime] = None,
    ) -> dict[str, Any]:
        target = set(symbols)
        latest_quotes: dict[str, Any] = {}
        latest_greeks: dict[str, Any] = {}
        quote_times: deque[float] = deque()
        greeks_times: deque[float] = deque()

        quote_updates_first_10s = 0
        quote_update_after_first_second = False
        verify_now_et = now_et.astimezone(ET) if isinstance(now_et, dt.datetime) else dt.datetime.now(ET)
        strict_rth = self._is_us_rth_et(verify_now_et)
        window_seconds = max(10, min(seconds, 20))
        min_quotes_window = 5 if strict_rth else 1
        require_update_after_first_second = True if strict_rth else False
        loop = asyncio.get_running_loop()
        start = loop.time()
        stop_event = asyncio.Event()
        disconnect_reason: dict[str, str] = {}

        async def consume_quotes() -> None:
            nonlocal quote_updates_first_10s, quote_update_after_first_second
            while not stop_event.is_set():
                try:
                    event = await asyncio.wait_for(streamer.get_event(quote_cls), timeout=1.0)
                except asyncio.TimeoutError:
                    continue
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    disconnect_reason["reason"] = f"Quote stream error: {exc}"
                    stop_event.set()
                    return
                key = str(_obj_get(event, "event_symbol", "symbol") or "")
                if key not in target:
                    continue
                now = asyncio.get_running_loop().time()
                quote_times.append(now)
                if now - start <= float(window_seconds):
                    quote_updates_first_10s += 1
                if now - start > 1.0:
                    quote_update_after_first_second = True
                latest_quotes[key] = event

        async def consume_greeks() -> None:
            while not stop_event.is_set():
                try:
                    event = await asyncio.wait_for(streamer.get_event(greeks_cls), timeout=1.0)
                except asyncio.TimeoutError:
                    continue
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    disconnect_reason["reason"] = f"Greeks stream error: {exc}"
                    stop_event.set()
                    return
                key = str(_obj_get(event, "event_symbol", "symbol") or "")
                if key not in target:
                    continue
                now = asyncio.get_running_loop().time()
                greeks_times.append(now)
                latest_greeks[key] = event

        quote_task = asyncio.create_task(consume_quotes())
        greeks_task = asyncio.create_task(consume_greeks())
        warned_no_updates = False

        try:
            for sec in range(1, seconds + 1):
                await asyncio.sleep(1.0)
                now = asyncio.get_running_loop().time()
                qps = self._prune_times(quote_times, now)
                gps = self._prune_times(greeks_times, now)
                print(f"[{sec:02d}s] quotes_1s={qps} greeks_1s={gps}", flush=True, file=os.sys.stderr)
                if sec >= window_seconds and quote_updates_first_10s == 0 and not warned_no_updates:
                    warned_no_updates = True
                    print(
                        f"WARNING: no quote updates received within first {window_seconds} seconds.",
                        flush=True,
                        file=os.sys.stderr,
                    )
                if stop_event.is_set() and disconnect_reason:
                    raise RuntimeError(disconnect_reason.get("reason", "DXLink disconnected"))
        finally:
            stop_event.set()
            quote_task.cancel()
            greeks_task.cancel()
            await asyncio.gather(quote_task, greeks_task, return_exceptions=True)

        checks = {
            "session": "RTH" if strict_rth else "OFF_HOURS",
            "window_seconds": window_seconds,
            "min_quotes_window": min_quotes_window,
            "require_update_after_first_second": require_update_after_first_second,
        }
        failed_reasons: list[str] = []
        if quote_updates_first_10s < min_quotes_window:
            failed_reasons.append(
                f"quote updates in first {window_seconds}s below threshold "
                f"({quote_updates_first_10s} < {min_quotes_window})"
            )
        if require_update_after_first_second and not quote_update_after_first_second:
            failed_reasons.append("no quote update after first second")

        passed = not failed_reasons
        if not passed:
            print("FAIL: live stream verification criteria not met.", flush=True, file=os.sys.stderr)
            print(
                f"Verification mode={checks['session']} checks={checks} reasons={failed_reasons}",
                flush=True,
                file=os.sys.stderr,
            )
        return {
            "quotes": latest_quotes,
            "greeks": latest_greeks,
            "quote_updates_first_10s": quote_updates_first_10s,
            "quote_update_after_first_second": quote_update_after_first_second,
            "checks": checks,
            "failed_reasons": failed_reasons,
            "passed": passed,
        }

    @staticmethod
    async def _collect_events(
        streamer: Any,
        event_cls: Any,
        symbols: list[str],
        timeout_s: float,
        max_events: int,
    ) -> dict[str, Any]:
        if not symbols:
            return {}

        target = set(symbols)
        out: dict[str, Any] = {}
        target_count = min(len(target), max(1, max_events))
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_s

        while loop.time() < deadline and len(out) < target_count:
            remaining = deadline - loop.time()
            per_wait = max(0.05, min(0.8, remaining))
            try:
                event = await asyncio.wait_for(streamer.get_event(event_cls), timeout=per_wait)
            except asyncio.TimeoutError:
                break
            except Exception:
                break

            key = str(_obj_get(event, "event_symbol", "symbol") or "")
            if key:
                out[key] = event

        return out

    @staticmethod
    async def _collect_candles(
        streamer: Any,
        event_cls: Any,
        timeout_s: float,
        max_events: int,
        min_events: int = 1,
    ) -> list[Any]:
        out: dict[tuple[str, int], Any] = {}
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_s
        timeout_hits = 0
        min_events = max(1, min(min_events, max_events))

        while loop.time() < deadline and len(out) < max_events:
            remaining = deadline - loop.time()
            per_wait = max(0.05, min(0.6, remaining))
            try:
                event = await asyncio.wait_for(streamer.get_event(event_cls), timeout=per_wait)
            except asyncio.TimeoutError:
                timeout_hits += 1
                if len(out) >= min_events:
                    if timeout_hits >= 2:
                        break
                elif timeout_hits >= 8:
                    break
                continue
            except Exception:
                break
            timeout_hits = 0

            symbol = str(_obj_get(event, "event_symbol", "symbol") or "")
            t_raw = _obj_get(event, "time")
            t_ms = _to_epoch_ms(t_raw)
            if symbol and t_ms is not None:
                out[(symbol, t_ms)] = event

        return list(out.values())

    def _apply_market_data(self, snapshot: MarketSnapshot, market_data: Any) -> None:
        data_list = market_data if isinstance(market_data, list) else []
        for row in data_list:
            symbol = str(_obj_get(row, "symbol") or "").upper()
            last = _as_float(_obj_get(row, "last", "last_price", "mark", "mark_price"))
            open_price = _as_float(_obj_get(row, "open", "open_price", "day_open_price"))
            prior_close = _as_float(_obj_get(row, "previous_close", "prior_close", "prev_close", "close"))

            if symbol == "SPX":
                snapshot.spot = last if last is not None else snapshot.spot
                snapshot.open_price = open_price if open_price is not None else snapshot.open_price
                snapshot.prior_close = prior_close if prior_close is not None else snapshot.prior_close
            if symbol == "VIX":
                snapshot.vix = last if last is not None else snapshot.vix
                snapshot.vix_prior_close = prior_close if prior_close is not None else snapshot.vix_prior_close

    def _apply_market_metrics(self, snapshot: MarketSnapshot, metrics: Any, today: dt.date) -> None:
        metrics_list = metrics if isinstance(metrics, list) else []
        if not metrics_list:
            return

        metric = metrics_list[0]
        snapshot.iv_rank = _as_float(
            _obj_get(
                metric,
                "tw_implied_volatility_index_rank",
                "tos_implied_volatility_index_rank",
                "implied_volatility_index_rank",
            )
        )

        exp_ivs = _obj_get(metric, "option_expiration_implied_volatilities") or []
        for item in exp_ivs:
            exp = _as_date(_obj_get(item, "expiration_date", "date"))
            if exp == today:
                snapshot.expiration_iv = _as_float(_obj_get(item, "implied_volatility", "iv"))
                break

    def _extract_today_strikes(self, chain: Any, today: dt.date, spot: Optional[float]) -> list[dict[str, Any]]:
        return self._extract_expiration_strikes(chain, today, spot)

    def _extract_2dte_strikes(
        self,
        chain: Any,
        today: dt.date,
        spot: Optional[float],
    ) -> tuple[list[dict[str, Any]], Optional[dt.date]]:
        target = self._pick_2dte_expiration(chain, today)
        if target is None:
            return [], None
        return self._extract_expiration_strikes(chain, target, spot), target

    def _extract_target_dte_strikes(
        self,
        chain: Any,
        today: dt.date,
        spot: Optional[float],
        target_dte: int,
    ) -> tuple[list[dict[str, Any]], Optional[dt.date]]:
        target = self._pick_expiration_in_dte_window(
            chain=chain,
            today=today,
            min_dte=1,
            max_dte=60,
            target_dte=target_dte,
        )
        if target is None:
            return [], None
        return self._extract_expiration_strikes(chain, target, spot), target

    def _extract_bwb_strikes(
        self,
        chain: Any,
        today: dt.date,
        spot: Optional[float],
    ) -> tuple[list[dict[str, Any]], Optional[dt.date]]:
        target = self._pick_expiration_in_dte_window(
            chain=chain,
            today=today,
            min_dte=7,
            max_dte=30,
            target_dte=21,
        )
        if target is None:
            return [], None
        return self._extract_expiration_strikes(chain, target, spot), target

    def _pick_2dte_expiration(self, chain: Any, today: dt.date) -> Optional[dt.date]:
        if chain is None:
            return None
        expirations = self._chain_expirations(chain)
        candidates: list[tuple[int, int, dt.date]] = []
        for exp in expirations:
            exp_date = _as_date(_obj_get(exp, "expiration_date", "date"))
            if exp_date is None:
                continue
            dte = (exp_date - today).days
            if dte <= 0:
                continue
            pm_rank = 0 if self._is_pm_settled_expiration(exp) else 1
            candidates.append((abs(dte - 2), pm_rank, exp_date))
        if not candidates:
            return None
        candidates.sort(key=lambda x: (x[0], x[1], x[2]))
        return candidates[0][2]

    def _pick_expiration_in_dte_window(
        self,
        chain: Any,
        today: dt.date,
        min_dte: int,
        max_dte: int,
        target_dte: int,
    ) -> Optional[dt.date]:
        if chain is None:
            return None
        expirations = self._chain_expirations(chain)
        candidates: list[tuple[int, int, int, dt.date]] = []
        for exp in expirations:
            exp_date = _as_date(_obj_get(exp, "expiration_date", "date"))
            if exp_date is None:
                continue
            dte = (exp_date - today).days
            if dte < min_dte or dte > max_dte:
                continue
            pm_rank = 0 if self._is_pm_settled_expiration(exp) else 1
            candidates.append((abs(dte - target_dte), pm_rank, dte, exp_date))
        if not candidates:
            return None
        candidates.sort(key=lambda x: (x[0], x[1], x[2], x[3]))
        return candidates[0][3]

    @staticmethod
    def _is_pm_settled_expiration(exp_row: Any) -> bool:
        settlement = str(_obj_get(exp_row, "settlement_type", "settlement", "expiration_type") or "").strip().upper()
        if settlement in {"PM", "P"}:
            return True
        if settlement in {"AM", "A"}:
            return False
        name_hint = str(_obj_get(exp_row, "name", "description", "symbol") or "").upper()
        if " PM" in name_hint or name_hint.endswith("PM"):
            return True
        if " AM" in name_hint or name_hint.endswith("AM"):
            return False
        # Default to PM preference when metadata is absent.
        return True

    def _extract_expiration_strikes(
        self,
        chain: Any,
        expiration: dt.date,
        spot: Optional[float],
    ) -> list[dict[str, Any]]:
        if chain is None:
            return []
        strikes = self._expiration_strikes(chain=chain, expiration=expiration)
        if not strikes:
            return []
        out: list[dict[str, Any]] = []

        for strike_row in strikes:
            strike = _as_float(_obj_get(strike_row, "strike_price", "strike"))
            if strike is None:
                continue

            if spot is not None and abs(strike - spot) > 550:
                continue

            call_symbol = str(_obj_get(strike_row, "call") or "")
            put_symbol = str(_obj_get(strike_row, "put") or "")
            call_stream = str(_obj_get(strike_row, "call_streamer_symbol") or call_symbol or "")
            put_stream = str(_obj_get(strike_row, "put_streamer_symbol") or put_symbol or "")

            if call_symbol and call_stream:
                out.append(
                    {
                        "right": "C",
                        "strike": strike,
                        "expiration": expiration,
                        "option_symbol": call_symbol,
                        "streamer_symbol": call_stream,
                    }
                )
            if put_symbol and put_stream:
                out.append(
                    {
                        "right": "P",
                        "strike": strike,
                        "expiration": expiration,
                        "option_symbol": put_symbol,
                        "streamer_symbol": put_stream,
                    }
                )

        return out

    @staticmethod
    def _chain_rows(chain: Any) -> list[Any]:
        if chain is None:
            return []
        if isinstance(chain, list):
            return [row for row in chain if row is not None]
        return [chain]

    def _chain_expirations(self, chain: Any) -> list[Any]:
        expirations: list[Any] = []
        for row in self._chain_rows(chain):
            exp_rows = _obj_get(row, "expirations") or []
            if isinstance(exp_rows, list):
                expirations.extend(exp_rows)
        return expirations

    def _expiration_strikes(self, chain: Any, expiration: dt.date) -> list[Any]:
        for row in self._chain_rows(chain):
            expirations = _obj_get(row, "expirations") or []
            if not isinstance(expirations, list):
                continue
            matches: list[Any] = []
            for exp in expirations:
                exp_date = _as_date(_obj_get(exp, "expiration_date", "date"))
                if exp_date == expiration:
                    matches.append(exp)
            if matches:
                matches.sort(key=lambda exp: 0 if self._is_pm_settled_expiration(exp) else 1)
                strikes = _obj_get(matches[0], "strikes") or []
                return strikes if isinstance(strikes, list) else []
        return []

    @staticmethod
    def _merge_option_data(strike_rows: list[dict[str, Any]], quotes: dict[str, Any], greeks: dict[str, Any]) -> list[OptionSnapshot]:
        out: list[OptionSnapshot] = []
        for row in strike_rows:
            key = row["streamer_symbol"]
            q = quotes.get(key)
            g = greeks.get(key)

            bid = _as_float(_obj_get(q, "bid_price", "bid"))
            ask = _as_float(_obj_get(q, "ask_price", "ask"))
            mid = _mid(bid, ask)

            out.append(
                OptionSnapshot(
                    option_symbol=row["option_symbol"],
                    streamer_symbol=key,
                    right=row["right"],
                    strike=row["strike"],
                    expiration=row["expiration"],
                    bid=bid,
                    ask=ask,
                    mid=mid,
                    delta=_as_float(_obj_get(g, "delta")),
                    gamma=_as_float(_obj_get(g, "gamma")),
                    theta=_as_float(_obj_get(g, "theta")),
                    iv=_as_float(_obj_get(g, "volatility", "implied_volatility", "iv")),
                    vega=_as_float(_obj_get(g, "vega")),
                )
            )
        return out

    @staticmethod
    def _normalize_candles(candle_events: list[Any]) -> list[CandleBar]:
        out: list[CandleBar] = []

        for c in candle_events:
            ts_raw = _obj_get(c, "time")
            ts_ms = _to_epoch_ms(ts_raw)
            if ts_ms is None:
                continue
            ts = dt.datetime.fromtimestamp(ts_ms / 1000.0, tz=UTC).astimezone(ET)

            o = _as_float(_obj_get(c, "open", "open_price"))
            h = _as_float(_obj_get(c, "high", "high_price"))
            l = _as_float(_obj_get(c, "low", "low_price"))
            close = _as_float(_obj_get(c, "close", "close_price"))
            v = _as_float(_obj_get(c, "volume"))
            vwap = _as_float(_obj_get(c, "vwap"))

            if None in (o, h, l, close):
                continue
            out.append(
                CandleBar(
                    timestamp=ts,
                    open=float(o),
                    high=float(h),
                    low=float(l),
                    close=float(close),
                    volume=float(v or 0.0),
                    vwap=vwap,
                )
            )

        out.sort(key=lambda x: x.timestamp)

        dedup: dict[dt.datetime, CandleBar] = {}
        for bar in out:
            dedup[bar.timestamp] = bar
        return [dedup[t] for t in sorted(dedup)]

    @staticmethod
    def _derive_atm_iv(options: list[OptionSnapshot], spot: Optional[float]) -> Optional[float]:
        if spot is None or not options:
            return None

        with_iv = [o for o in options if o.iv is not None]
        if not with_iv:
            return None

        with_iv.sort(key=lambda o: abs(o.strike - spot))
        nearest = with_iv[:8]
        if not nearest:
            return None

        values = [o.iv for o in nearest if o.iv is not None]
        if not values:
            return None
        return float(sum(values) / len(values))


def _obj_get(obj: Any, *names: str) -> Any:
    if obj is None:
        return None

    if isinstance(obj, dict):
        for name in names:
            if name in obj:
                return obj[name]
            alt = name.replace("_", "-")
            if alt in obj:
                return obj[alt]
        return None

    for name in names:
        if hasattr(obj, name):
            return getattr(obj, name)
    return None


def _as_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _as_date(value: Any) -> Optional[dt.date]:
    if value is None:
        return None
    if isinstance(value, dt.date) and not isinstance(value, dt.datetime):
        return value
    if isinstance(value, dt.datetime):
        return value.date()
    if isinstance(value, str):
        try:
            return dt.date.fromisoformat(value[:10])
        except ValueError:
            return None
    return None


def _mid(bid: Optional[float], ask: Optional[float]) -> Optional[float]:
    if bid is None or ask is None:
        return None
    if bid < 0 or ask < 0:
        return None
    return (bid + ask) / 2.0


def _to_epoch_ms(value: Any) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        if value > 10_000_000_000:
            return int(value)
        return int(float(value) * 1000)
    if isinstance(value, dt.datetime):
        return int(value.timestamp() * 1000)
    return None
