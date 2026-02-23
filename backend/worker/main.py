from __future__ import annotations

import signal
import sys
import time
from datetime import datetime, timezone

from backend.services.env import alerts_enabled, runtime_summary, simulation_mode

RUNNING = True


def _stop(*_: object) -> None:
    global RUNNING
    RUNNING = False


def _log(message: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{ts}] worker {message}", flush=True)


def main() -> int:
    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    summary = runtime_summary()
    _log(f"start mode={summary['mode']} dataMode={summary['dataMode']}")

    if simulation_mode() and alerts_enabled():
        _log("SIMULATION_MODE=true -> operational alerts are disabled unless explicitly allowed by API policy")

    if summary["issues"]:
        _log(f"config issues: {summary['issues']}")
        if not simulation_mode():
            _log("fatal: required env is missing in LIVE mode; exiting")
            return 1

    interval_s = 30
    while RUNNING:
        # Placeholder worker heartbeat for VPS supervision.
        _log("heartbeat")
        time.sleep(interval_s)

    _log("shutdown")
    return 0


if __name__ == "__main__":
    sys.exit(main())
