"""Pads integrity: lease-level only, no overlap with single-well offsets, no invented per-well volumes."""
import json
from collections import Counter
from pathlib import Path

D = Path(__file__).resolve().parents[1] / "public" / "data"


def test_pads_consistent():
    P = json.loads((D / "pads.json").read_text())
    W = json.loads((D / "wells.json").read_text())
    n = P["n"]
    assert n > 0 and len(P["id"]) == n and len(set(P["id"])) == n
    cnt = Counter(P["m_pad"])
    assert all(cnt[j] == P["wells"][j] and P["wells"][j] >= 2 for j in range(n))
    # a pad member is never also a single-well offset
    assert not set(P["m_api10"]) & set(W["api10"])
    # no per-well volume columns exist for members
    assert {k for k in P if k.startswith("m_")} == {"m_pad", "m_api10", "m_well_no", "m_slat", "m_slon", "m_blat", "m_blon", "m_lat_ft"}
    for j in range(n):
        if P["cum12"][j] is not None:
            assert P["cum12"][j] <= P["cum_oil"][j] + 1
        assert P["first"][j] >= 201301
    meta = json.loads((D / "meta.json").read_text())
    assert meta["pads"]["pads"] == n and meta["pads"]["wells_in_pads"] == len(P["m_api10"])
