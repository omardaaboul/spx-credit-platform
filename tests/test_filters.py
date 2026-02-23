from __future__ import annotations

import datetime as dt

from data.tasty import CandleBar
from signals.filters import compute_atr_1m, compute_emr, compute_full_day_em


def test_compute_emr_positive() -> None:
    emr = compute_emr(spot=5000.0, iv=0.18, minutes_remaining=180.0)
    assert emr is not None
    assert 15.0 < emr < 30.0


def test_compute_full_day_em_positive() -> None:
    em = compute_full_day_em(spot=5000.0, iv=0.18)
    assert em is not None
    assert 20.0 < em < 30.0


def test_compute_atr_1m_lookback5() -> None:
    base = dt.datetime(2026, 1, 2, 10, 0)
    candles = [
        CandleBar(base + dt.timedelta(minutes=i), 5000 + i, 5002 + i, 4998 + i, 5001 + i, 1000, None)
        for i in range(6)
    ]
    atr = compute_atr_1m(candles, lookback=5)
    assert atr is not None
    assert atr > 0


if __name__ == "__main__":
    test_compute_emr_positive()
    test_compute_full_day_em_positive()
    test_compute_atr_1m_lookback5()
    print("tests/test_filters.py: OK")
