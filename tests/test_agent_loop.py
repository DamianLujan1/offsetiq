"""The agent loop end to end, and its HTTP front."""
import asyncio
import json
import re

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
