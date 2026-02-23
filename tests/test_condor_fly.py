from __future__ import annotations

import datetime as dt

from data.tasty import OptionSnapshot
from strategies.condor import find_iron_condor_candidate
from strategies.fly import find_iron_fly_candidate


def _option(right: str, strike: float, bid: float, ask: float, delta: float | None) -> OptionSnapshot:
    return OptionSnapshot(
        option_symbol=f"SPX_{right}_{strike}",
        streamer_symbol=f".SPX{right}{strike}",
        right=right,
        strike=strike,
        expiration=dt.date(2026, 1, 2),
        bid=bid,
        ask=ask,
        mid=(bid + ask) / 2.0,
        delta=delta,
        gamma=None,
        theta=None,
        iv=None,
    )


def test_find_iron_condor_candidate_with_strict_delta_band() -> None:
    options = [
        _option("P", 5960, 1.55, 1.65, -0.12),  # short put
        _option("P", 5910, 0.25, 0.35, -0.03),  # long put (50w)
        _option("C", 6040, 1.55, 1.65, 0.12),   # short call
        _option("C", 6090, 0.25, 0.35, 0.03),   # long call (50w)
    ]
    out = find_iron_condor_candidate(
        options=options,
        spot=6000.0,
        emr=20.0,
        full_day_em=26.0,
        widths=[50],
    )
    assert out["ready"] is True
    cand = out["candidate"]
    assert cand["width"] == 50
    assert cand["credit"] >= 1.5
    assert cand["pop_delta"] >= 0.75


def test_find_iron_fly_candidate_with_atm_shorts() -> None:
    options = [
        _option("P", 6000, 3.95, 4.05, -0.50),  # ATM short put
        _option("C", 6000, 3.95, 4.05, 0.50),   # ATM short call
        _option("P", 5980, 1.15, 1.25, -0.20),  # long put (20w)
        _option("C", 6020, 1.15, 1.25, 0.20),   # long call (20w)
    ]
    out = find_iron_fly_candidate(
        options=options,
        spot=6000.0,
        emr=24.0,
        full_day_em=28.0,
        now_et=dt.datetime(2026, 1, 2, 11, 0),
        range_15m=5.0,
        vwap_distance=2.0,
        vix_change_pct=1.0,
        widths=[20],
    )
    assert out["ready"] is True
    cand = out["candidate"]
    assert cand["short_strike"] == 6000.0
    assert cand["width"] == 20
    assert cand["credit"] > 0

