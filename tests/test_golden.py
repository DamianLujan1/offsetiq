"""Golden tests: numbers the app displays == numbers computed in data/processed CSVs.

The app renders only public/data/*.json; these tests re-derive every displayed
field from the pipeline CSVs, check rankings never contain silent NaNs, and
cross-check our direct RRC pull against an independent public republish.
"""
import json
import math
import os

import numpy as np
import pandas as pd
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROC = os.path.join(ROOT, "data", "processed")
PUB = os.path.join(ROOT, "public", "data")
needs_data = pytest.mark.skipif(not os.path.exists(os.path.join(PROC, "dca_results.csv")),
                                reason="run the pipeline first")


@pytest.fixture(scope="module")
def W():
    return json.load(open(os.path.join(PUB, "wells.json")))


@pytest.fixture(scope="module")
def D():
    d = pd.read_csv(os.path.join(PROC, "dca_results.csv"), dtype={"api8": str, "api10": str})
    return d.sort_values("api8").reset_index(drop=True)


@needs_data
def test_display_matches_csv(W, D):
    assert W["n"] == len(D)
    assert W["api10"] == D["api10"].tolist()
    pairs = {"cum_oil": ("cum_oil_bbl", 0), "cum12": ("cum12_oil_bbl", 0), "eur": ("eur_bbl", 0),
             "qi": ("qi", 1), "Di": ("Di_annual", 4), "b": ("b", 4), "eur_kft": ("eur_per_1000ft", 1),
             "first": ("first_prod_ym", 0), "months": ("months_history", 0)}
    for jk, (ck, nd) in pairs.items():
        for a, b in zip(W[jk], D[ck].tolist()):
            if b is None or (isinstance(b, float) and math.isnan(b)):
                assert a is None, jk
            else:
                assert a == pytest.approx(round(b, nd), abs=10 ** -nd), jk


@needs_data
def test_remaining_only_for_fitted_and_consistent(W):
    for st, e, r, c in zip(W["status"], W["eur"], W["rem"], W["cum_oil"]):
        if st == "ok":
            assert e is not None and r is not None
            assert e == pytest.approx(c + r, abs=2)
        else:
            assert e is None and r is None


@needs_data
def test_no_silent_nans_in_rankings(W):
    # every value that can be sorted/ranked in the UI is either a finite number or explicit null
    for k in ["lat", "lon", "lat_ft", "first", "months", "cum_oil"]:
        assert all(isinstance(v, (int, float)) and math.isfinite(v) for v in W[k]), k
    for k in ["eur", "eur_kft", "cum12", "qi", "Di", "b", "r2", "rem"]:
        assert all(v is None or math.isfinite(v) for v in W[k]), k
    # confidence label is explicit for every well; 'none' <=> no EUR
    for c, e in zip(W["conf"], W["eur"]):
        assert c in {"high", "medium", "low", "none"}
        assert (c == "none") == (e is None)


@needs_data
def test_monthly_sums_match_cum(W):
    for c in ["andrews", "ector", "midland", "martin"]:
        m = json.load(open(os.path.join(PUB, f"monthly_{c}.json")))
        idx = {a: i for i, a in enumerate(W["api10"])}
        for api, s in m.items():
            assert sum(s["oil"]) == W["cum_oil"][idx[api]]


@needs_data
def test_only_v1_counties_and_real_apis(W):
    assert set(W["county"]) <= {"ANDREWS", "ECTOR", "MIDLAND", "MARTIN"}
    assert all(a.startswith("42") and len(a) == 10 for a in W["api10"])
    assert all(a[2:5] in {"003", "135", "317", "329"} for a in W["api10"])


REPUB = os.path.join(ROOT, "..", "midland-basin-dca-dashboard", "data",
                     "martin_selected_30_monthly_production_normalized.csv")


@needs_data
@pytest.mark.skipif(not os.path.exists(REPUB), reason="independent republish not on this machine")
def test_cross_check_against_independent_republish():
    """30 Martin wells from the Dansaad/permian-basin-data republish of RRC data
    must match our direct PDQ pull month-for-month where both report a month."""
    ref = pd.read_csv(REPUB, dtype={"api8": str})
    mine = pd.read_csv(os.path.join(PROC, "monthly.csv"), dtype={"api8": str})
    j = ref.rename(columns={"cycle_year_month": "ym"}).merge(mine, on=["api8", "ym"], suffixes=("_ref", ""))
    j = j[j["oil_bbl_ref"] > 0]  # republish shows 0 for months not yet filed at its retrieval date
    assert j["api8"].nunique() == 30 and len(j) > 1000
    assert (j["oil_bbl_ref"] == j["oil_bbl"]).all()
