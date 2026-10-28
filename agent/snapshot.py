"""The public-data snapshot the agent screens against.

The agent never calls the RRC while screening. pipeline/fetch_rrc.py pulls the RRC
bulk dumps once per data refresh, pipeline/build_dataset.py does the single-well-lease
attribution, and pipeline/export_web.py freezes the result into public/data/*.json --
the same files the Analyze page reads (on Vercel, a copy made by agent/bundle.py).
This module loads that snapshot once per process and exposes it as numpy arrays, plus
the offset pool in exactly the shape pipeline.features.offset_features expects
(cf. pipeline/train_model.build_pool).

Only public data is cached here; nothing about a user's request is.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from functools import lru_cache

import numpy as np

from agent import bundle
from agent.forest import Forest

DATA_DIR = bundle.data_dir()


def _num(a: list) -> np.ndarray:
    return np.array([np.nan if v is None else v for v in a], dtype=float)


@dataclass(frozen=True)
class Snapshot:
    # attributable wells (single-well leases), in wells.json order
    n: int
    api10: np.ndarray
    lease: np.ndarray
    lease_no: np.ndarray
    well_no: np.ndarray
    operator: np.ndarray
    field: np.ndarray
    county: np.ndarray
    lat: np.ndarray            # lateral midpoint (the model's location)
    lon: np.ndarray
    slat: np.ndarray           # surface / bottom-hole locations
    slon: np.ndarray
    blat: np.ndarray
    blon: np.ndarray
    lat_ft: np.ndarray         # SHL->BHL displacement (lateral proxy)
    first: np.ndarray          # first production YYYYMM
    cum12: np.ndarray          # NaN = fewer than 12 producing months (never zero-filled)
    eur: np.ndarray            # NaN = no Arps fit
    eur_kft: np.ndarray
    conf: np.ndarray
    pool_idx: np.ndarray       # wells with an early decline fit = model offsets
    pool: dict                 # pipeline.features.offset_features pool, rows = pool_idx
    # every mapped RRC horizontal (coverage layer): code 0 usable, 1 multi-well lease, ...
    h_lat: np.ndarray          # NaN where the RRC layer has no location
    h_lon: np.ndarray
    h_code: np.ndarray
    h_county: np.ndarray
    h_labels: list
    forest: Forest
    meta: dict


@lru_cache(maxsize=1)
def load_snapshot(data_dir: str = DATA_DIR) -> Snapshot:
    def j(f: str):
        with open(os.path.join(data_dir, f)) as fh:
            return json.load(fh)

    W, H, M, meta = (j(f) for f in bundle.FILES)
    s = lambda k: np.array(W[k], dtype=object)
    lat_ft, cum12 = _num(W["lat_ft"]), _num(W["cum12"])
    e_di, e_known = _num(W["e_Di"]), _num(W["e_known"])
    pool_idx = np.flatnonzero(~np.isnan(e_di) & ~np.isnan(e_known))
    api10 = s("api10")
    pool = {
        "api8": np.array([a[2:] for a in api10[pool_idx]], dtype=object),
        "lat": _num(W["lat"])[pool_idx], "lon": _num(W["lon"])[pool_idx],
        "early_known_ym": e_known[pool_idx].astype(np.int64),
        "cum12_per_kft": (cum12 / (lat_ft / 1000.0))[pool_idx],
        "early_qi": _num(W["e_qi"])[pool_idx], "early_Di": e_di[pool_idx],
        "early_b": _num(W["e_b"])[pool_idx], "early_cluster": _num(W["e_cl"])[pool_idx].astype(np.int64),
    }
    return Snapshot(
        n=int(W["n"]), api10=api10, lease=s("lease"), lease_no=s("lease_no"), well_no=s("well_no"),
        operator=s("operator"), field=s("field"), county=s("county"),
        lat=_num(W["lat"]), lon=_num(W["lon"]), slat=_num(W["slat"]), slon=_num(W["slon"]),
        blat=_num(W["blat"]), blon=_num(W["blon"]), lat_ft=lat_ft,
        first=np.array(W["first"], dtype=np.int64), cum12=cum12, eur=_num(W["eur"]),
        eur_kft=_num(W["eur_kft"]), conf=s("conf"), pool_idx=pool_idx, pool=pool,
        h_lat=_num(H["lat"]), h_lon=_num(H["lon"]), h_code=np.array(H["code"], dtype=np.int64),
        h_county=np.array(H["county"], dtype=object), h_labels=list(H["labels"]),
        forest=Forest(M), meta=meta,
    )
