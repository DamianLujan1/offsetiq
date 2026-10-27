"""HTTP front for the screening agent: POST /screen streams the loop's events as NDJSON.

Run:  python -m agent.server [--host 127.0.0.1] [--port 8765]
The Next.js app proxies /api/screen here (OFFSETIQ_AGENT_URL). When this service is
reachable from the internet, set OFFSETIQ_AGENT_TOKEN on both sides: /screen then
requires "Authorization: Bearer <token>", so only the app's proxy can run screens.
That is a key between two services, not user authentication.

On Vercel (FastAPI preset) the entrypoint is agent.server:app, set in pyproject.toml.

Privacy: a request is processed in memory and dropped when its stream ends. Nothing
is stored, and nothing about a request is logged: the access log is off (it would
record client IPs), and failures are logged as exception type + file:line frames only,
never messages or source lines that could carry a prompt or coordinates.
"""
from __future__ import annotations

import argparse
import hmac
import json
import logging
import os
import time
import traceback
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from agent.loop import default_workers, run, shutdown_pool, worker_pool
from agent.snapshot import load_snapshot

log = logging.getLogger("offsetiq.agent")


class DrawnPolygon(BaseModel):
    label: str = Field(default="", max_length=40)
    ring: list[tuple[float, float]] = Field(min_length=3, max_length=500)


class DrawnPoint(BaseModel):
    label: str = Field(default="", max_length=40)
    lat: float
    lon: float


class Context(BaseModel):
    polygons: list[DrawnPolygon] = Field(default_factory=list, max_length=20)
    points: list[DrawnPoint] = Field(default_factory=list, max_length=500)


class ScreenRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=2000)
    context: Context = Field(default_factory=Context)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    load_snapshot()
    workers = default_workers()
    pool = worker_pool(workers)
    if pool is not None:  # start every worker now so the first operator doesn't wait for it
        list(pool.map(int, range(workers * 2)))
    yield
    shutdown_pool()


app = FastAPI(title="OffsetIQ screening agent", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)

# A fixed request with no user data: two locations in coverage and one outside it. Its numbers are pinned
# by tests/test_agent_loop.py, so /health?deep=1 shows a deployment computes exactly what the tests expect.
DEEP_CHECK = "screen 31.86,-102.20 and 32.30,-101.90 and 33.20,-101.20"


def require_token(authorization: str | None = Header(default=None)) -> None:
    token = os.environ.get("OFFSETIQ_AGENT_TOKEN", "")
    if token and not hmac.compare_digest((authorization or "").encode(), f"Bearer {token}".encode()):
        raise HTTPException(status_code=401, detail="Missing or invalid service token.")


@app.get("/health")
async def health(deep: bool = False) -> dict:
    snap = load_snapshot()
    out = {"ok": True, "wells": snap.n, "pdq_dump_date": snap.meta["pdq_dump_date"],
           "last_complete_month": snap.meta["last_complete_month"], "workers": default_workers()}
    if deep:
        t0 = time.perf_counter()
        p = [ev async for ev in run(DEEP_CHECK, None, workers=0)][-1]
        ok = p.get("type") == "proposal" and p["ranked_total"] == 2 and p["unranked"]["outside_coverage"] == 1
        out["deep"] = {"ok": ok, "ms": round((time.perf_counter() - t0) * 1000),
                       "cum12_p50": [r["cum12"]["p50"] for r in p.get("ranked", [])]}
        out["ok"] = ok
    return out


def _json(o) -> str:
    return json.dumps(o, separators=(",", ":"), default=lambda v: v.item() if hasattr(v, "item") else str(v)) + "\n"


@app.post("/screen", dependencies=[Depends(require_token)])
async def screen(req: ScreenRequest) -> StreamingResponse:
    async def events():
        try:
            async for ev in run(req.prompt, req.context.model_dump()):
                yield _json(ev)
        except Exception as e:  # noqa: BLE001 -- the stream must end with an event the UI can show
            frames = " <- ".join(f"{os.path.basename(f.filename)}:{f.lineno}:{f.name}" for f in reversed(traceback.extract_tb(e.__traceback__)))
            log.error("screen run failed: %s at %s", type(e).__name__, frames)
            yield _json({"type": "error", "message": "The screening agent hit an internal error. Nothing was saved; please retry."})

    return StreamingResponse(events(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


def main() -> None:
    import uvicorn

    ap = argparse.ArgumentParser(description="OffsetIQ screening agent")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    uvicorn.run(app, host=a.host, port=a.port, access_log=False, log_level="warning")


if __name__ == "__main__":
    main()
