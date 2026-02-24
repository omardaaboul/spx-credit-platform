#!/usr/bin/env python3
"""Live connectivity check (safe: no order placement)."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TT = ROOT / "tt_live_check" / "tt_live_check.py"


def main() -> int:
    out = {
        "env": {
            "tasty_auth_present": bool(os.getenv("TASTY_API_TOKEN") and os.getenv("TASTY_API_SECRET")),
            "telegram_configured": bool(
                (os.getenv("TELEGRAM_BOT_TOKEN") or os.getenv("TELEGRAM_TOKEN")) and os.getenv("TELEGRAM_CHAT_ID")
            ),
            "telegram_enabled": os.getenv("SPX0DTE_ENABLE_TELEGRAM") == "true",
        },
        "tt_live_check": {"ran": False, "ok": False, "output_tail": []},
    }

    if not TT.exists():
        print(json.dumps({**out, "error": f"missing {TT}"}, indent=2))
        return 1

    proc = subprocess.run(
        [sys.executable, str(TT), "--duration", "20", "--retries", "2"],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    txt = (proc.stdout or "") + ("\n" + proc.stderr if proc.stderr else "")
    tail = [ln for ln in txt.splitlines() if ln.strip()][-40:]
    out["tt_live_check"] = {
        "ran": True,
        "ok": ("PASS: Live DXLink streaming is healthy." in txt),
        "returncode": proc.returncode,
        "output_tail": tail,
    }

    print(json.dumps(out, indent=2))
    return 0 if out["tt_live_check"]["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
