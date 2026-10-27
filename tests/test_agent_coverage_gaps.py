"""Coverage gaps on multi-well leases: counted, shown, never given volumes.

Texas reports production by lease. On a multi-well lease no per-well volume exists,
so the agent may only count such wells. These tests check that they never feed a
feature, a forecast, an evidence median or a rank -- and that a location whose only
neighbours are multi-well wells is reported, not ranked on invented numbers.
"""
import asyncio
import dataclasses
import json
import math
import os
from statistics import median

import numpy as np
import pytest

from agent import geo
from agent.engine import MULTI_WELL, Filters, TileCache, screen_location
from agent.loop import run
from agent.rank import Candidate, evidence, rank, row
from agent.snapshot import DATA_DIR, load_snapshot
from pipeline.features import haversine_mi


@pytest.fixture(scope="module")
def snap():
    return load_snapshot()


@pytest.fixture(scope="module")
def gap_only_location(snap):
    """A real in-coverage location with multi-well-lease horizontals around it but no attributable offset within 3 mi."""
    tiles = TileCache(snap, reach_mi=5.0)
    for g in geo.grid(geo.counties()["MIDLAND"], 160):
        s = screen_location(snap, g.lat, g.lon, 10000, 1.0, tiles=tiles)
        if s.in_coverage and s.model_offsets == 0 and s.gaps.get(MULTI_WELL, 0) >= 2:
            return g.lat, g.lon
    pytest.fail("no gap-only location found in Midland County")


def test_no_attributable_well_is_a_multi_well_lease_horizontal(snap):
    with open(os.path.join(DATA_DIR, "horizontals.json")) as fh:
        H = json.load(fh)
    multi = {a for a, c in zip(H["api10"], H["code"]) if c == MULTI_WELL}
    assert multi and not (multi & set(snap.api10.tolist()))


def with_extra_multi_well(snap, lat, lon, n=12):
    """Plant n extra multi-well-lease horizontals within ~0.3 mi of a point."""
    rnd = np.random.default_rng(0)
    la = lat + rnd.uniform(-0.004, 0.004, n)
    lo = lon + rnd.uniform(-0.004, 0.004, n)
    return dataclasses.replace(
        snap, h_lat=np.concatenate([snap.h_lat, la]), h_lon=np.concatenate([snap.h_lon, lo]),
        h_code=np.concatenate([snap.h_code, np.full(n, MULTI_WELL)]),
        h_county=np.concatenate([snap.h_county, np.array(["MIDLAND"] * n, dtype=object)]))


@pytest.mark.parametrize("lat,lon", [(31.906, -102.09), (32.0, -101.95), (31.75, -102.05)])
def test_adding_multi_well_horizontals_changes_only_the_gap_count(snap, lat, lon):
    base = screen_location(snap, lat, lon, 10000, 1.0)
    more = screen_location(with_extra_multi_well(snap, lat, lon), lat, lon, 10000, 1.0)
    assert more.gaps[MULTI_WELL] == base.gaps.get(MULTI_WELL, 0) + 12
    assert more.cum12 == base.cum12 and more.eur == base.eur
    assert more.model_offsets == base.model_offsets and more.offsets == base.offsets
    assert all((math.isnan(a) and math.isnan(b)) or a == b for a, b in zip(base.features.values(), more.features.values()))
    assert evidence(snap, more)["median_cum12"] == evidence(snap, base)["median_cum12"]


def test_gap_only_location_is_reported_not_ranked(snap, gap_only_location):
    lat, lon = gap_only_location
    s = screen_location(snap, lat, lon, 10000, 1.0)
    assert s.model_offsets == 0 and s.offsets == [] and s.gaps[MULTI_WELL] >= 2
    ranked, unranked = rank([(Candidate("X", "A", lat, lon), s)])
    assert ranked == [] and unranked[0][2] == "no_model_offsets"

    async def go():
        return [ev async for ev in run(f"screen {lat:.6f}, {lon:.6f}", None, workers=0)]
    p = next(e for e in asyncio.run(go()) if e["type"] == "proposal")
    assert p["ranked"] == [] and p["ranked_total"] == 0
    assert p["unranked"]["no_model_offsets"] == 1
    assert p["candidates"]["p50"] == [None] and p["candidates"]["status"] == ["no_model_offsets"]  # no number shown
    assert any("coverage gaps, not data" in x for x in p["summary"])


def test_evidence_uses_only_attributable_wells(snap):
    lat, lon, r = 31.906, -102.09, 1.0
    s = screen_location(snap, lat, lon, 10000, r)
    e = evidence(snap, s)
    d = haversine_mi(lat, lon, snap.lat, snap.lon)
    near = np.flatnonzero(d <= r)
    assert e["n"] == len(near) and set(e["apis"]) <= set(snap.api10[near].tolist())
    c12 = [v for v in snap.cum12[near] if math.isfinite(v)]
    assert e["median_cum12"] == pytest.approx(median(c12))


def test_rationale_states_the_gap_count_and_assigns_no_volume(snap):
    lat, lon = 31.906, -102.09
    s = screen_location(with_extra_multi_well(snap, lat, lon, 3), lat, lon, 10000, 1.0)
    r = row(snap, 1, Candidate("T1-r0c0", "Tract 1", lat, lon), s, None, Filters())
    g = s.gaps[MULTI_WELL]
    assert r["gaps"]["multi_well"] == g
    assert f"{g} multi-well gaps excluded" in r["rationale"]["headline"]
    assert any(f"{g} multi-well-lease horizontals within 1 mile excluded" in d and "none are assigned" in d
               for d in r["rationale"]["details"])
