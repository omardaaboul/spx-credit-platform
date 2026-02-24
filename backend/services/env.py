from __future__ import annotations

import os
from typing import Dict, List


def _truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def simulation_mode() -> bool:
    return _truthy(os.getenv("SIMULATION_MODE"))


def alerts_enabled() -> bool:
    return _truthy(os.getenv("SPX0DTE_ENABLE_TELEGRAM"))


def telegram_configured() -> bool:
    token = os.getenv("TELEGRAM_BOT_TOKEN") or os.getenv("TELEGRAM_TOKEN")
    chat_id = os.getenv("TELEGRAM_CHAT_ID")
    return bool(token and chat_id)


def tasty_credentials_present() -> bool:
    return bool(os.getenv("TASTY_API_TOKEN") and os.getenv("TASTY_API_SECRET"))


def required_env_issues() -> List[str]:
    issues: List[str] = []
    if not simulation_mode() and not tasty_credentials_present():
        issues.append(
            "Missing broker credentials. Set TASTY_API_TOKEN and TASTY_API_SECRET."
        )
    if alerts_enabled() and not telegram_configured():
        issues.append(
            "Telegram is enabled but TELEGRAM_BOT_TOKEN (or TELEGRAM_TOKEN) / TELEGRAM_CHAT_ID is missing."
        )
    return issues


def runtime_summary() -> Dict[str, object]:
    sim = simulation_mode()
    return {
        "mode": "SIM" if sim else "LIVE",
        "dataMode": "HISTORICAL" if sim else "LIVE",
        "simulationMode": sim,
        "alertsEnabled": alerts_enabled(),
        "telegramConfigured": telegram_configured(),
        "tastyCredentialsPresent": tasty_credentials_present(),
        "issues": required_env_issues(),
    }
