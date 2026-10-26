"""Offset features — the single definition shared by training (Python) and
inference (TypeScript port in web/lib/features.ts; golden-tested for parity).

LEAKAGE RULES (enforced here):
  1. A target well never contributes to its own features (self excluded by API).
  2. An offset is visible to a target only if the offset's early-fit window
     (first 12 producing months after peak) closed strictly BEFORE the target's
     first production month: early_known_ym < target_first_prod_ym. So offset
     features use only information that existed when the target was turned online.
  3. Offset features use early-window quantities only (cum12, early qi/Di/b,
     early-fit decline cluster) — never an offset's full-history EUR.
  4. The target's own production (any month) is never a feature; it is only the label.
"""
from __future__ import annotations

import numpy as np

RADIUS_MI = 3.0
MI_FT = 5280.0
FEATURES = [
    "lateral_proxy_ft", "mid_lat", "mid_lon", "county_code", "vintage_year",
    "n_off", "d_nearest_mi", "idw_cum12_per_kft", "idw_early_qi", "idw_early_Di",
    "idw_early_b", "frac_steep", "frac_mild", "off_cum12_scaled",
]
COUNTY_CODE = {"ANDREWS": 0, "ECTOR": 1, "MIDLAND": 2, "MARTIN": 3}


def haversine_mi(lat1, lon1, lat2, lon2):
    R = 3958.7613
    la1, lo1, la2, lo2 = map(np.radians, [lat1, lon1, lat2, lon2])
    d = np.sin((la2 - la1) / 2) ** 2 + np.cos(la1) * np.cos(la2) * np.sin((lo2 - lo1) / 2) ** 2
    return 2 * R * np.arcsin(np.sqrt(np.minimum(1.0, d)))


def offset_features(lat, lon, asof_ym, pool, exclude_api=None, radius_mi=RADIUS_MI, lateral_ft=np.nan):
    """pool: dict of numpy arrays with keys api8, lat, lon, early_known_ym,
    cum12_per_kft, early_qi, early_Di, early_b, early_cluster (0 steep,1 mod,2 mild)."""
    vis = pool["early_known_ym"] < asof_ym
    if exclude_api is not None:
        vis &= pool["api8"] != exclude_api
    d = haversine_mi(lat, lon, pool["lat"], pool["lon"])
    sel = vis & (d <= radius_mi)
    out = {"n_off": float(sel.sum())}
    if not sel.any():
        out.update({k: np.nan for k in ["d_nearest_mi", "idw_cum12_per_kft", "idw_early_qi",
                                        "idw_early_Di", "idw_early_b", "frac_steep", "frac_mild",
                                        "off_cum12_scaled"]})
        return out
    ds = d[sel]
    w = 1.0 / (ds + 0.25) ** 2
    w = w / w.sum()
    out["d_nearest_mi"] = float(ds.min())
    c12 = pool["cum12_per_kft"][sel]
    m = ~np.isnan(c12)
    out["idw_cum12_per_kft"] = float((w[m] * c12[m]).sum() / w[m].sum()) if m.any() else np.nan
    out["idw_early_qi"] = float((w * pool["early_qi"][sel]).sum())
    out["idw_early_Di"] = float((w * pool["early_Di"][sel]).sum())
    out["idw_early_b"] = float((w * pool["early_b"][sel]).sum())
    cl = pool["early_cluster"][sel]
    out["frac_steep"] = float((cl == 0).mean())
    out["frac_mild"] = float((cl == 2).mean())
    out["off_cum12_scaled"] = out["idw_cum12_per_kft"] * lateral_ft / 1000.0
    return out
