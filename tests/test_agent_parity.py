"""The agent screens a location exactly like the Analyze page does.

tests/fixtures/screen_golden.json is lib/engine.ts analyze() output (prospect mode)
for 55 fixed locations: random points, points near real wells, outside coverage,
sparse Ector, every lateral/radius/filter combination the cases cycle through.
scripts/screen-golden.ts writes it and `npm run test:ts` fails if it goes stale.
Here the Python engine must reproduce every number, with and without the tile cache.
"""
import json
import math
import os

import pytest

from agent import engine as E
from agent.snapshot import load_snapshot
from pipeline.features import FEATURES, RADIUS_MI

GOLD = json.load(open(os.path.join(os.path.dirname(__file__), "fixtures", "screen_golden.json")))
CASES = GOLD["cases"]


@pytest.fixture(scope="module")
def snap():
    return load_snapshot()


def test_constants_match_lib_engine():
    c = GOLD["constants"]
    assert c["PROSPECT_ASOF"] == E.PROSPECT_ASOF
    assert c["DEFAULT_VINTAGE"] == E.DEFAULT_VINTAGE
    assert tuple(c["SUPPORTED"]) == E.SUPPORTED
    assert c["RADIUS_MI"] == RADIUS_MI
    assert c["FEATURES"] == FEATURES


def test_fixture_covers_edge_cases():
    assert sum(not c["inCoverage"] for c in CASES) >= 3
    assert any(c["modelOffsets"] == 0 for c in CASES)
    assert any(c["input"]["operator"] for c in CASES) and any(c["input"]["minLatFt"] for c in CASES)
    assert {c["input"]["lateralFt"] for c in CASES} >= {3500, 16000}


@pytest.mark.parametrize("case", CASES, ids=[f"{c['input']['lat']:.3f},{c['input']['lon']:.3f}" for c in CASES])
@pytest.mark.parametrize("tiled", [False, True], ids=["full-scan", "tile-cache"])
def test_location_matches_analyze(snap, case, tiled):
    i = case["input"]
    flt = E.Filters(min_lat_ft=i["minLatFt"], max_lat_ft=i["maxLatFt"], operator=i["operator"])
    tiles = E.TileCache(snap, reach_mi=max(E.COVERAGE_MI, i["radiusMi"])) if tiled else None
    r = E.screen_location(snap, i["lat"], i["lon"], i["lateralFt"], i["radiusMi"], flt, tiles)

    assert r.county == case["county"]
    assert r.county_dist_mi == pytest.approx(case["countyInferredFromMi"], rel=1e-9)
    assert r.in_coverage == case["inCoverage"]
    for k, ts in zip(FEATURES, case["features"]):
        if ts is None:
            assert math.isnan(r.features[k]), k
        else:
            assert r.features[k] == pytest.approx(ts, rel=1e-9, abs=1e-12), k
    for band in ("cum12", "eur"):  # the agent labels the low case P90 and the high case P10 (PRMS)
        for ours, theirs in (("p90", "low"), ("p50", "p50"), ("p10", "high")):
            assert getattr(r, band)[ours] == pytest.approx(case[band][theirs], rel=1e-9), f"{band} {ours}"
    assert r.model_offsets == case["modelOffsets"]
    assert [snap.api10[j] for j, _ in r.offsets] == [a for a, _ in case["offsets"]]
    assert [d for _, d in r.offsets] == pytest.approx([d for _, d in case["offsets"]], rel=1e-9)
    assert {snap.h_labels[c]: n for c, n in r.gaps.items()} == dict(case["excludedNearby"])
    if case["analogEur"] is None:
        assert r.analog_eur is None
    else:
        assert r.analog_eur["n"] == case["analogEur"]["n"]
        assert r.analog_eur["value"] == pytest.approx(case["analogEur"]["value"], rel=1e-9)
    w = " ".join(case["warnings"])
    assert ("outside_coverage" in r.flags) == ("outside OffsetIQ v1 coverage" in w)
    assert ("low_model_offsets" in r.flags) == ("treat as low confidence" in w)
    assert ("lateral_outside_training_range" in r.flags) == ("edge of the training distribution" in w)
