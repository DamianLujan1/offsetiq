"""Agent engine internals: LightGBM evaluator parity, the snapshot pool, the tile cache."""
import json
import os

import numpy as np
import pytest

from agent.engine import TileCache
from agent.forest import Forest
from agent.snapshot import DATA_DIR, load_snapshot
from pipeline.features import haversine_mi


def _j(f):
    with open(os.path.join(DATA_DIR, f)) as fh:
        return json.load(fh)


@pytest.mark.parametrize("bundle,key", [("model.json", "pred_log"), ("model_holdout.json", "pred_log_holdout")])
def test_forest_matches_lightgbm_bit_for_bit(bundle, key):
    """golden_model.json holds LightGBM's own predictions (pipeline/train_model.py) on 200 rows incl. NaNs."""
    g = _j("golden_model.json")
    X = np.array([[np.nan if v is None else v for v in r] for r in g["rows"]])
    pred = Forest(_j(bundle)).predict_raw(X)
    for k, want in g[key].items():
        assert np.array_equal(pred[k], np.array(want)), k


def test_forest_single_rows_equal_batch():
    g = _j("golden_model.json")
    X = np.array([[np.nan if v is None else v for v in r] for r in g["rows"]])
    f = Forest(_j("model.json"))
    batch = f.predict_raw(X)
    for i in range(0, len(X), 17):
        one = f.predict_raw(X[i])
        assert all(one[k][0] == batch[k][i] for k in batch)


def test_pool_is_the_wells_with_an_early_fit():
    s = load_snapshot()
    W = _j("wells.json")
    want = [i for i in range(W["n"]) if W["e_Di"][i] is not None and W["e_known"][i] is not None]
    assert s.pool_idx.tolist() == want
    i = want[5]
    assert s.pool["cum12_per_kft"][5] == pytest.approx(W["cum12"][i] / (W["lat_ft"][i] / 1000) if W["cum12"][i] else np.nan, nan_ok=True)
    assert set(s.pool) == {"api8", "lat", "lon", "early_known_ym", "cum12_per_kft", "early_qi", "early_Di", "early_b", "early_cluster"}


@pytest.mark.parametrize("reach", [5.0, 10.0])
def test_tile_neighbourhood_contains_everything_within_reach(reach):
    s = load_snapshot()
    tc = TileCache(s, reach_mi=reach)
    rnd = np.random.default_rng(1)
    for lat, lon in zip(rnd.uniform(31.66, 32.52, 60), rnd.uniform(-103.05, -101.7, 60)):
        t = tc.get(lat, lon)
        assert set(np.flatnonzero(haversine_mi(lat, lon, s.lat, s.lon) <= reach)) <= set(t.w.tolist())
        assert set(np.flatnonzero(haversine_mi(lat, lon, s.h_lat, s.h_lon) <= reach)) <= set(t.h.tolist())
        pd = haversine_mi(lat, lon, s.pool["lat"], s.pool["lon"])
        assert (pd <= reach).sum() == (haversine_mi(lat, lon, t.pool["lat"], t.pool["lon"]) <= reach).sum()
    assert tc.misses + tc.hits == 60
