"""Ranking stability (agent/rank.py, agent/loop.py).

The order must depend only on the screened numbers: never on input order, on which
parallel task finished first, on how many workers ran, or on what else was screened
alongside. Ties (common with a tree model) are broken by documented keys.
"""
import asyncio
import random

import pytest

from agent.engine import Screen
from agent.loop import run, shutdown_pool
from agent.rank import Candidate, rank, sort_key

SQ = [[31.90, -102.10], [31.90, -102.08], [31.915, -102.08], [31.915, -102.10]]
SQ2 = [[31.80, -102.00], [31.80, -101.98], [31.815, -101.98], [31.815, -102.00]]


def fake(id_, p50, eur=400e3, n_off=10, lat=31.9, lon=-102.1, in_cov=True):
    s = Screen(lat=lat, lon=lon, lateral_ft=10000, radius_mi=1.0, county="MIDLAND", county_dist_mi=0.1,
               in_coverage=in_cov, features={}, cum12={"p10": p50 * 0.8, "p50": p50, "p90": p50 * 1.3},
               eur={"p10": eur * 0.6, "p50": eur, "p90": eur * 1.6}, model_offsets=n_off, offsets=[], gaps={},
               analog_eur=None)
    return Candidate(id=id_, region="A", lat=lat, lon=lon), s


def ids(ranked):
    return [c.id for c, _ in ranked]


def test_keys_in_order_primary_secondary_tertiary_position():
    pairs = [
        fake("p50-low", 150e3),
        fake("p50-high", 160e3),
        fake("tie-eur-low", 155e3, eur=390e3),
        fake("tie-eur-high", 155e3, eur=410e3),
        fake("tie-dense", 152e3, n_off=40),
        fake("tie-sparse", 152e3, n_off=12),
        fake("tie-all-south", 151e3, lat=31.80),
        fake("tie-all-north", 151e3, lat=31.95),
        fake("tie-all-north-east", 151e3, lat=31.95, lon=-102.0),
    ]
    ranked, unranked = rank(pairs)
    assert unranked == []
    assert ids(ranked) == ["p50-high", "tie-eur-high", "tie-eur-low", "tie-dense", "tie-sparse",
                           "tie-all-north", "tie-all-north-east", "tie-all-south", "p50-low"]


def test_low_evidence_tier_and_not_ranked():
    pairs = [
        fake("supported", 150e3, n_off=3),
        fake("sparse-but-higher", 199e3, n_off=2),
        fake("sparse-lower", 140e3, n_off=1),
        fake("no-offsets", 250e3, n_off=0),
        fake("outside", 300e3, in_cov=False),
    ]
    ranked, unranked = rank(pairs)
    assert ids(ranked) == ["supported", "sparse-but-higher", "sparse-lower"]
    assert {c.id: why for c, _, why in unranked} == {"no-offsets": "no_model_offsets", "outside": "outside_coverage"}


def random_pairs(n=300, seed=7):
    rnd = random.Random(seed)
    # Coarse values on purpose so exact ties on every key happen often.
    return [fake(f"c{i}", rnd.choice([150e3, 151e3, 152e3]), eur=rnd.choice([390e3, 400e3]),
                 n_off=rnd.choice([0, 1, 2, 3, 10, 40]), lat=31.9 + rnd.randrange(20) * 0.001,
                 lon=-102.1 + rnd.randrange(20) * 0.001) for i in range(n)]


def test_permutation_invariance():
    pairs = random_pairs()
    ref_r, ref_u = rank(pairs)
    for seed in range(20):
        shuffled = pairs[:]
        random.Random(seed).shuffle(shuffled)
        r, u = rank(shuffled)
        # Candidates at the same position with identical numbers are interchangeable; compare what is observable.
        assert [sort_key(c, s) for c, s in r] == [sort_key(c, s) for c, s in ref_r]
        assert sorted(c.id for c, _, _ in u) == sorted(c.id for c, _, _ in ref_u)


def test_order_is_pairwise_consistent_subsets_and_exclusions():
    """Ranking a subset (or excluding a row in review) never reorders the rest."""
    pairs = [p for p in random_pairs() if p[1].model_offsets > 0]
    full = ids(rank(pairs)[0])
    rnd = random.Random(3)
    for _ in range(20):
        keep = set(rnd.sample(full, 120))
        assert ids(rank([p for p in pairs if p[0].id in keep])[0]) == [i for i in full if i in keep]


def test_monotone_within_each_tier():
    ranked, _ = rank(random_pairs())
    keys = [sort_key(c, s) for c, s in ranked]
    assert keys == sorted(keys)
    for (_, a), (_, b) in zip(ranked, ranked[1:]):
        if (a.model_offsets >= 3) == (b.model_offsets >= 3):
            assert a.cum12["p50"] >= b.cum12["p50"]


def collect(prompt, ctx=None, **kw):
    async def go():
        return [ev async for ev in run(prompt, ctx, **kw)]
    evs = asyncio.run(go())
    return next(e for e in evs if e["type"] == "proposal")


def observable(p):
    return [(r["id"], r["rank"], r["cum12"], r["eur"], r["model_offsets"], r["rationale"]) for r in p["ranked"]], p["candidates"]


def test_identical_across_workers_in_flight_and_reruns():
    ctx = {"polygons": [{"label": "North", "ring": SQ}, {"label": "South", "ring": SQ2}]}
    prompt = "compare these two tracts, top 40"
    ref = collect(prompt, ctx, workers=0)
    assert ref["ranked_total"] == 40
    try:
        for kw in ({"workers": 0, "max_in_flight": 1}, {"workers": 2, "max_in_flight": 1}, {"workers": 2, "max_in_flight": 10}):
            assert observable(collect(prompt, ctx, **kw)) == observable(ref), kw
    finally:
        shutdown_pool()
    assert observable(collect(prompt, ctx, workers=0)) == observable(ref)


def test_screening_a_tract_alone_or_with_others_gives_the_same_order():
    alone = collect("screen this tract, top 20", {"polygons": [{"label": "North", "ring": SQ}]}, workers=0)
    both = collect("compare these two tracts, top 40",
                   {"polygons": [{"label": "North", "ring": SQ}, {"label": "South", "ring": SQ2}]}, workers=0)
    north_in_both = [r["id"] for r in both["ranked"] if r["region"] == "North"]
    assert [r["id"] for r in alone["ranked"]] == north_in_both


@pytest.mark.parametrize("prompt", ["rank the best spots in Ector County, top 50"])
def test_county_ranking_respects_tiers_and_keys(prompt):
    p = collect(prompt, workers=0)
    rows = p["ranked"]
    tiers = [r["tier"] for r in rows]
    assert tiers == sorted(tiers, key=lambda t: t != "supported")
    for a, b in zip(rows, rows[1:]):
        if a["tier"] == b["tier"]:
            assert (a["cum12"]["p50"], a["eur"]["p50"], a["model_offsets"]) >= (b["cum12"]["p50"], b["eur"]["p50"], b["model_offsets"])
