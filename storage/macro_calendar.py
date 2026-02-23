from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from typing import Any

DEFAULT_MACRO_CALENDAR_PATH = "storage/macro_events.json"


def load_macro_events(path: str = DEFAULT_MACRO_CALENDAR_PATH) -> list[dict[str, Any]]:
    """
    Loads macro events from JSON and normalizes shape.

    File format:
    {
      "events": [
        {"date": "2026-03-11", "name": "CPI", "time_et": "08:30"},
        {"date": "2026-03-06", "name": "NFP / Jobs", "time_et": "08:30"}
      ]
    }
    """
    file_path = Path(path)
    file_path.parent.mkdir(parents=True, exist_ok=True)
    if not file_path.exists():
        file_path.write_text(json.dumps({"events": []}, indent=2))
        return []

    try:
        raw = json.loads(file_path.read_text())
    except Exception:
        return []

    if isinstance(raw, dict):
        rows = raw.get("events", [])
    elif isinstance(raw, list):
        rows = raw
    else:
        rows = []

    normalized: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        event_date = _parse_date(row.get("date"))
        name = str(row.get("name", "")).strip()
        time_et = str(row.get("time_et", "")).strip()

        if not event_date or not name:
            continue

        normalized.append({"date": event_date, "name": name, "time_et": time_et})

    normalized.sort(key=lambda x: (x["date"], x["time_et"], x["name"]))
    return normalized


def events_for_date(events: list[dict[str, Any]], target_date: dt.date) -> list[str]:
    labels: list[str] = []
    for event in events:
        if event.get("date") != target_date:
            continue
        name = str(event.get("name", "")).strip()
        time_et = str(event.get("time_et", "")).strip()
        if not name:
            continue
        labels.append(f"{name} ({time_et} ET)" if time_et else name)
    return labels


def upcoming_events(
    events: list[dict[str, Any]],
    start_date: dt.date,
    limit: int = 6,
) -> list[str]:
    out: list[str] = []
    for event in events:
        event_date = event.get("date")
        if not isinstance(event_date, dt.date):
            continue
        if event_date < start_date:
            continue
        name = str(event.get("name", "")).strip()
        time_et = str(event.get("time_et", "")).strip()
        if not name:
            continue
        label = f"{event_date.isoformat()} - {name}"
        if time_et:
            label += f" ({time_et} ET)"
        out.append(label)
        if len(out) >= limit:
            break
    return out


def _parse_date(value: Any) -> dt.date | None:
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
