#!/usr/bin/env python3
"""Verify near-realtime tastytrade connectivity (token+secret auth only)."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TT = ROOT / "tt_live_check" / "tt_live_check.py"


def _missing_auth() -> tuple[bool, str]:
    token = (os.getenv("TASTY_API_TOKEN") or "").strip()
    secret = (os.getenv("TASTY_API_SECRET") or "").strip()
    if token and secret:
        return False, ""
    return True, "TASTY_AUTH_FAILED: Missing TASTY_API_TOKEN or TASTY_API_SECRET."


def main() -> int:
    missing, reason = _missing_auth()
    if missing:
        print(json.dumps({"ok": False, "reason_code": "TASTY_AUTH_FAILED", "message": reason}, indent=2))
        return 2

    if not TT.exists():
        print(json.dumps({"ok": False, "reason_code": "VERIFY_SCRIPT_MISSING", "message": f"Missing {TT}"}, indent=2))
        return 2

    proc = subprocess.run(
        [sys.executable, str(TT), "--duration", "25", "--retries", "3"],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    txt = (proc.stdout or "") + ("\n" + proc.stderr if proc.stderr else "")
    ok = ("PASS: Live DXLink streaming is healthy." in txt) and proc.returncode == 0

    reason_code = "OK"
    if not ok:
        low = txt.lower()
        if "tasty_auth_failed" in low or "invalid jwt" in low or "invalid_grant" in low or "login failed" in low:
            reason_code = "TASTY_AUTH_FAILED"
        elif "permission" in low:
            reason_code = "TASTY_PERMISSIONS_MISSING"
        else:
            reason_code = "TASTY_STREAM_UNHEALTHY"

    out = {
        "ok": ok,
        "reason_code": reason_code,
        "returncode": proc.returncode,
        "tail": [ln for ln in txt.splitlines() if ln.strip()][-40:],
    }
    print(json.dumps(out, indent=2))
    return 0 if ok else 2


if __name__ == "__main__":
    raise SystemExit(main())

