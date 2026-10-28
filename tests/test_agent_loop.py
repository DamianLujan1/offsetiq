"""The agent loop end to end, and its HTTP front."""
import asyncio
import json
import re

import numpy as np
import pytest
from fastapi.testclient import TestClient

from agent import loop as L
from agent.rank import kb

SQ = [[31.90, -102.10], [31.90, -102.08], [31.915, -102.08], [31.915, -102.10]]
ONE = {"polygons": [{"label": "Tract 1", "ring": SQ}]}


def events(prompt, ctx=None, **kw):
    async def go():
        return [ev async for ev in L.run(prompt, ctx, **kw)]
    return asyncio.run(go())


def test_event_sequence_and_progress():
    evs = events("screen every location in this lease block", ONE, workers=0)
    kinds = [e["type"] if e["type"] != "step" else e["id"] for e in evs]
    assert kinds[:2] == ["parse", "expand"] and kinds[-3:] == ["screen", "rank", "proposal"]
    prog = [e for e in evs if e["type"] == "progress"]
    assert prog and prog[-1]["done"] == prog[-1]["total"] == 20
    assert [p["done"] for p in prog] == sorted(p["done"] for p in prog)


def test_clarify_stops_before_screening():
    evs = events("screen every location in this lease block", None, workers=0)
    assert [e["type"] for e in evs] == ["step", "clarify"]
    assert "nothing is drawn" in evs[-1]["question"]


def test_proposal_is_strict_json_and_rationales_match_their_numbers():
    evs = events("compare these tracts, top 10", {"polygons": [{"label": "N", "ring": SQ}, {"label": "S", "ring": [[31.80, -102.0], [31.80, -101.98], [31.815, -101.98], [31.815, -102.0]]}]}, workers=0)
    p = evs[-1]
    json.dumps(p, allow_nan=False)  # raises on NaN/Infinity
    assert len(p["ranked"]) == 10 and p["ranked_total"] == 40 and len(p["tracts"]) == 2
    for r in p["ranked"]:
        h = r["rationale"]["headline"]
        assert h.startswith(f"Rank #{r['rank']}:")
        assert f"12-mo oil P50 {kb(r['cum12']['p50'])} bbl" in h and f"EUR P50 {kb(r['eur']['p50'])} bbl" in h
        assert f"{r['gaps']['multi_well']} multi-well gap" in h
        n = r["evidence"]["n"]
        assert (f"{n} nearby offset" in h) if n else ("no attributable offsets" in h)
        if r["evidence"]["median_cum12"] is not None:
            assert f"median 12-mo oil {kb(r['evidence']['median_cum12'])} bbl" in h
        assert f"Wells feeding the model: {r['model_offsets']} " in " ".join(r["rationale"]["details"])
        assert r["analyze_url"].startswith("/analyze?lat=") and "lat_ft=10000" in r["analyze_url"]
    assert len(p["candidates"]["lat"]) == 40 and set(p["candidates"]["status"]) <= {"ranked", "no_model_offsets", "outside_coverage"}


def test_large_area_is_coarsened_and_says_so():
    evs = events("rank Andrews County", None, workers=0)
    exp = next(e for e in evs if e.get("id") == "expand")
    assert exp["spacing_acres"] == 160 and any("40-acre spacing over this area would be" in n for n in exp["notes"])
    assert evs[-1]["run"]["candidates"] <= L.MAX_CANDIDATES


def test_area_too_large_even_when_coarsened_asks(monkeypatch):
    monkeypatch.setattr(L, "MAX_CANDIDATES", 50)
    evs = events("rank Midland County", None, workers=0)
    assert evs[-1]["type"] == "clarify" and "Even at 640-acre spacing" in evs[-1]["question"]


def test_bounded_in_flight_with_worker_processes():
    probe = {}
    try:
        evs = events("rank Ector County at 160-acre spacing", None, workers=2, max_in_flight=3, probe=probe)
    finally:
        L.shutdown_pool()
    assert probe["batches"] > 3 and probe["workers"] == 2
    assert probe["peak_in_flight"] == 3          # the semaphore is the bound, and it is reached
    assert evs[-1]["run"]["max_in_flight"] == 3


def test_inline_mode_runs_one_batch_at_a_time():
    probe = {}
    events("rank Ector County at 640-acre spacing", None, workers=0, probe=probe)
    assert probe["peak_in_flight"] == 1 and probe["workers"] == 1


def test_duplicate_locations_are_screened_once():
    probe = {}
    evs = events("screen 31.95,-102.05 and 31.95,-102.05 and 31.90,-102.10", None, workers=0, probe=probe)
    assert probe["unique"] == 2 and evs[-1]["run"]["candidates"] == 3


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("OFFSETIQ_AGENT_WORKERS", "0")
    from agent.server import app
    with TestClient(app) as c:
        yield c


def test_server_streams_ndjson(client):
    assert client.get("/health").json()["ok"] is True
    with client.stream("POST", "/screen", json={"prompt": "screen this lease block", "context": ONE}) as r:
        assert r.status_code == 200 and r.headers["content-type"].startswith("application/x-ndjson")
        assert r.headers["cache-control"] == "no-store"
        evs = [json.loads(line) for line in r.iter_lines() if line]
    assert evs[0]["id"] == "parse" and evs[-1]["type"] == "proposal"


@pytest.mark.parametrize("body", [{"prompt": ""}, {"prompt": "x" * 2001}, {},
                                  {"prompt": "go", "context": {"polygons": [{"ring": [[1, 2]]}]}},
                                  {"prompt": "go", "context": {"points": [{"lat": "north", "lon": 1}]}}])
def test_server_rejects_bad_requests(client, body):
    assert client.post("/screen", json=body).status_code == 422


def test_server_internal_error_ends_stream_with_error_event(client, monkeypatch, caplog):
    async def boom(*a, **k):
        yield {"type": "step", "id": "parse"}
        raise RuntimeError("secret prompt text 31.9,-102.1")
    import agent.server as S
    monkeypatch.setattr(S, "run", boom)
    with client.stream("POST", "/screen", json={"prompt": "secret prompt text"}) as r:
        evs = [json.loads(line) for line in r.iter_lines() if line]
    assert evs[-1]["type"] == "error"
    assert "RuntimeError" in caplog.text and not re.search(r"secret|31\.9", caplog.text)  # nothing about the request is logged


def test_service_token_is_enforced_only_when_configured(client, monkeypatch):
    body = {"prompt": "screen 31.95,-102.05"}
    assert client.post("/screen", json=body).status_code == 200            # unset: local development
    monkeypatch.setenv("OFFSETIQ_AGENT_TOKEN", "s3cret-token")
    assert client.post("/screen", json=body).status_code == 401
    assert client.post("/screen", json=body, headers={"authorization": "Bearer wrong"}).status_code == 401
    assert client.post("/screen", json={"prompt": ""}).status_code == 401   # checked before the body is read
    ok = client.post("/screen", json=body, headers={"authorization": "Bearer s3cret-token"})
    assert ok.status_code == 200 and ok.text.strip().splitlines()[-1].startswith('{"type":"proposal"')
    assert client.get("/health").status_code == 200                         # health stays open


def test_deep_health_pins_the_numbers_a_deployment_must_reproduce(client):
    h = client.get("/health", params={"deep": 1}).json()
    assert h["ok"] and h["deep"]["ok"]
    assert h["deep"]["cum12_p50"] == pytest.approx([141711.83616015807, 133937.85897050393], rel=1e-9)


def test_bundled_snapshot_copy_is_all_the_agent_needs(tmp_path, monkeypatch):
    from agent import bundle
    from agent.snapshot import load_snapshot
    bundle.main(str(tmp_path))                     # the Vercel build step, into a scratch dir
    copy, live = load_snapshot.__wrapped__(str(tmp_path)), load_snapshot()
    assert copy.n == live.n and copy.meta == live.meta
    assert all(np.array_equal(getattr(copy, k), getattr(live, k), equal_nan=True) for k in ("lat", "lon", "cum12", "eur", "h_code"))
    monkeypatch.delenv("OFFSETIQ_DATA_DIR", raising=False)
    monkeypatch.setattr(bundle, "PUBLIC", str(tmp_path / "absent"))   # a function bundle has no public/
    assert bundle.data_dir() == bundle.BUNDLED
    monkeypatch.setenv("OFFSETIQ_DATA_DIR", str(tmp_path))
    assert bundle.data_dir() == str(tmp_path)


def test_runs_in_process_when_worker_processes_are_unavailable(monkeypatch):
    def no_pool(*a, **k):
        raise OSError(38, "Function not implemented")  # what a sandbox without POSIX semaphores raises
    monkeypatch.setattr(L, "ProcessPoolExecutor", no_pool)
    monkeypatch.setattr(L, "_pool_unavailable", False)
    L.shutdown_pool()
    probe = {}
    evs = events("rank Ector County at 640-acre spacing", None, workers=4, probe=probe)
    assert evs[-1]["type"] == "proposal" and probe["workers"] == 1
    assert L.worker_pool(4) is None   # remembered: later runs go straight to in-process
