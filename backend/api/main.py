from __future__ import annotations

from datetime import datetime, timezone

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from backend.services.env import runtime_summary

app = FastAPI(title="SPX Credit Spread Backend", version="1.0.0")


@app.get("/health")
def health() -> JSONResponse:
    summary = runtime_summary()
    issues = summary.get("issues", [])
    status = "ok" if not issues else "error"
    payload = {
        "status": status,
        "mode": summary["mode"],
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "dataMode": summary["dataMode"],
        "issues": issues,
    }
    return JSONResponse(payload, status_code=200 if status == "ok" else 503)
