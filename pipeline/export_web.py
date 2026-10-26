"""Step 5 — export compact, static JSON artifacts for the Next.js app (web/public/data).

All numbers in the app come from these files, which come from data/processed/*.csv.
tests/test_golden.py re-derives them from the CSVs to guarantee display == computed.
"""
from __future__ import annotations

import json
import math
import os

import numpy as np
import pandas as pd
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROC = os.path.join(ROOT, "data", "processed")
OUT = os.path.join(ROOT, "public", "data")

STATUS_CODES = {
    "usable": 0, "single_well_lease": 0,
    "multi_well_lease": 1, "no_pdq_completion": 2, "gas_well_out_of_scope": 3,
    "no_oil_production_reported_2012_2026": 4, "first_prod_before_2013": 5,
}
STATUS_LABELS = [
    "Usable: single-well lease, oil production attributable",
    "Excluded: multi-well lease (RRC reports production by lease; not allocable to this well)",
    "Excluded: no PDQ completion record (permit / DUC / not yet producing / plugged)",
    "Excluded: gas well (out of scope)",
    "Excluded: no oil production reported 2012-2026",
    "Excluded: first production before 2013 (start not observed)",
    "Excluded: RRC well layer has no surface location (lateral cannot be located)",
]


def r(x, nd=0):
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return None
    v = round(float(x), nd)
    return int(v) if nd == 0 else v


def col(s: pd.Series, nd=0):
    return [r(v, nd) for v in s.tolist()]


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    d = pd.read_csv(os.path.join(PROC, "training_table.csv"), dtype={"api8": str, "api10": str, "well_no": str})
    d = d.sort_values("api8").reset_index(drop=True)
    d["remaining_bbl"] = d["remaining_bbl"].where(d["status"].eq("ok"))
    wells = {
        "n": len(d),
        "api10": d["api10"].tolist(),
        "lease": d["lease_name"].fillna("").tolist(),
        "lease_no": d["lease_key"].fillna("").tolist(),
        "well_no": d["well_no"].fillna("").astype(str).tolist(),
        "operator": d["operator"].fillna("").tolist(),
        "field": d["field"].fillna("").tolist(),
        "county": d["county"].tolist(),
        "lat": col(d["mid_lat"], 9), "lon": col(d["mid_lon"], 9),
        "slat": col(d["surf_lat"], 6), "slon": col(d["surf_lon"], 6),
        "blat": col(d["bhl_lat"], 6), "blon": col(d["bhl_lon"], 6),
        "lat_ft": col(d["lateral_proxy_ft"], 3), "az": col(d["azimuth_deg"]),
        "first": col(d["first_prod_ym"]), "last": col(d["last_ym"]), "months": col(d["months_history"]),
        "cum_oil": col(d["cum_oil_bbl"]), "cum_gas": col(d["cum_gas_mcf"]),
        "cum6": col(d["cum6_oil_bbl"]), "cum12": col(d["cum12_oil_bbl"]), "cum24": col(d["cum24_oil_bbl"]),
        "status": d["status"].tolist(),
        "qi": col(d["qi"], 1), "peak_mop": col(d["peak_mop"]), "Di": col(d["Di_annual"], 4), "b": col(d["b"], 4), "r2": col(d["r_squared"], 4),
        "eur": col(d["eur_bbl"]), "rem": col(d["remaining_bbl"]), "eur_kft": col(d["eur_per_1000ft"], 1),
        "cluster": d["cluster"].fillna("Not fitted").tolist(), "conf": d["eur_confidence"].tolist(),
        # leakage-safe feature inputs (early-window only)
        "e_known": col(d["early_known_ym"]), "e_qi": col(d["early_qi"], 6), "e_Di": col(d["early_Di_annual"], 9),
        "e_b": col(d["early_b"], 9), "e_cl": col(d["early_cluster"]),
    }
    json.dump(wells, open(os.path.join(OUT, "wells.json"), "w"), separators=(",", ":"))

    # monthly series sharded by county
    m = pd.read_csv(os.path.join(PROC, "monthly.csv"), dtype={"api8": str}).sort_values(["api8", "ym"])
    cmap = dict(zip(d["api8"], d["county"]))
    a10 = dict(zip(d["api8"], d["api10"]))
    shards: dict[str, dict] = {}
    for api8, g in m.groupby("api8"):
        c = cmap.get(api8)
        if c is None:
            continue
        shards.setdefault(c, {})[a10[api8]] = {"oil": g["oil_bbl"].astype(int).tolist(), "mop": g["mop"].astype(int).tolist(),
                                               "ym": g["ym"].astype(int).tolist()}
    for c, s in shards.items():
        json.dump(s, open(os.path.join(OUT, f"monthly_{c.lower()}.json"), "w"), separators=(",", ":"))

    # all horizontals (coverage layer)
    h = pd.read_csv(os.path.join(PROC, "wells_all_horizontals.csv"), dtype={"api8": str, "api10": str})
    def code(s):
        for k, v in STATUS_CODES.items():
            if str(s).startswith(k):
                return v
        return 2
    h["code"] = h["join_status"].map(code)
    # usable == in training table; anything else 'usable' by status but filtered later -> keep code from table
    h.loc[h["api8"].isin(d["api8"]), "code"] = 0
    h.loc[(h["code"] == 0) & ~h["api8"].isin(d["api8"]) & h["surf_lat"].isna(), "code"] = 6
    h.loc[(h["code"] == 0) & ~h["api8"].isin(d["api8"]), "code"] = 4
    coverage_by_county = {c: {STATUS_LABELS[k]: int(v) for k, v in g["code"].value_counts().sort_index().items()}
                          for c, g in h.groupby("layer_county")}
    allh = {"api10": h["api10"].tolist(), "lat": col(h["mid_lat"], 5), "lon": col(h["mid_lon"], 5),
            "lat_ft": col(h["lateral_proxy_ft"]), "code": h["code"].astype(int).tolist(),
            "county": h["layer_county"].tolist(), "labels": STATUS_LABELS}
    json.dump(allh, open(os.path.join(OUT, "horizontals.json"), "w"), separators=(",", ":"))

    # golden features for TS parity (rows from the training table, exactly as used in training)
    from pipeline.features import FEATURES
    g = d.sample(300, random_state=7)
    json.dump({"api10": g["api10"].tolist(), "features": FEATURES,
               "rows": g[FEATURES].astype(float).replace({np.nan: None}).values.tolist()},
              open(os.path.join(OUT, "golden_features.json"), "w"))

    cov = json.load(open(os.path.join(PROC, "coverage.json")))
    metrics = json.load(open(os.path.join(PROC, "model_metrics.json")))
    meta = {
        "last_complete_month": cov["last_complete_month"],
        "pdq_dump_date": "2026-09-26",
        "well_layer_source": "RRC digital map well layers (wellNNNs/b/l shapefiles), counties 003/135/317/329",
        "coverage": coverage_by_county, "usable_by_county": cov["usable_by_county"],
        "dca": {
            "fitted": int((d["status"] == "ok").sum()), "insufficient": int((d["status"] != "ok").sum()),
            "median_eur_by_county": {k: r(v) for k, v in d[d.status == "ok"].groupby("county")["eur_bbl"].median().items()},
            "conf": d["eur_confidence"].value_counts().to_dict(),
        },
        "model": metrics,
        "horizontals_by_code": {STATUS_LABELS[k]: int(v) for k, v in h["code"].value_counts().sort_index().items()},
    }
    json.dump(meta, open(os.path.join(OUT, "meta.json"), "w"), indent=1)
    for f in sorted(os.listdir(OUT)):
        print(f, os.path.getsize(os.path.join(OUT, f)) // 1024, "KB")


if __name__ == "__main__":
    main()
