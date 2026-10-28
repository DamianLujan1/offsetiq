"""Step 2b — multi-well pads (lease-level aggregation).

Texas reports oil production by LEASE. When several horizontals share one oil
lease, the RRC volume cannot be split per well from public data, so those wells
were previously excluded from the product. Operators drill exactly these pads,
so we now show them as PADS: one record per lease, using the lease's reported
monthly oil as the pad's production series.

What a pad is (and is not):
  * pad = an RRC oil lease (district + lease no.) whose oil completions are ALL
    horizontals in the RRC well layers (well_count >= 2). Leases that also carry
    vertical / non-horizontal completions are NOT turned into pads, because the
    lease volume would mix in those wells; they stay coverage gaps.
  * production = reported lease oil, summed per month, from the first month with
    oil > 0. Wells on a pad usually come online at different times, so the pad
    series is an aggregate; we do NOT invent a per-well allocation.
  * pad lateral = sum of member lateral proxies (total pad footage); max is kept too.
  * Arps fit = same method as single wells (pipeline/dca.fit_one) on the lease series.
  * pads are offsets for display / reports only. They are NOT used to train the
    model or to build model features (those still use single-well leases only).

Inputs : data/processed/wells_all_horizontals.csv, data/raw/lease_cycle_target.dsv
Outputs: data/processed/pads.csv, data/processed/pad_members.csv, data/processed/pad_monthly.csv
"""
from __future__ import annotations

import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pipeline.build_dataset import FIRST_ALLOWED_PROD, LAST_COMPLETE_MONTH  # noqa: E402
from pipeline.dca import fit_one  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
PROC = os.path.join(ROOT, "data", "processed")


def main() -> None:
    h = pd.read_csv(os.path.join(PROC, "wells_all_horizontals.csv"), dtype={"api8": str, "api10": str, "lease_key": str, "WELL_NO": str})
    mw = h[h["join_status"].astype(str).str.startswith("multi_well_lease")].copy()
    nh = mw.groupby("lease_key")["api8"].transform("size")
    mw["n_horiz"] = nh
    # pure-horizontal leases only: every oil completion on the lease is a horizontal we can see
    cand = mw[mw["n_horiz"] >= mw["wells_on_lease"]].copy()
    keys = set(cand["lease_key"])

    p = pd.read_csv(os.path.join(RAW, "lease_cycle_target.dsv"), sep="}", dtype=str,
                    usecols=["DISTRICT_NO", "LEASE_NO", "CYCLE_YEAR_MONTH", "LEASE_OIL_PROD_VOL",
                             "LEASE_CSGD_PROD_VOL", "LEASE_NAME", "OPERATOR_NAME", "FIELD_NAME"],
                    encoding="latin-1")
    p["lease_key"] = p["DISTRICT_NO"] + "-" + p["LEASE_NO"]
    p = p[p["lease_key"].isin(keys)]
    p["ym"] = p["CYCLE_YEAR_MONTH"].astype(int)
    p = p[p["ym"] <= LAST_COMPLETE_MONTH]
    p["oil_bbl"] = pd.to_numeric(p["LEASE_OIL_PROD_VOL"], errors="coerce").fillna(0.0)
    p["gas_mcf"] = pd.to_numeric(p["LEASE_CSGD_PROD_VOL"], errors="coerce").fillna(0.0)
    names = p.sort_values("ym").groupby("lease_key")[["LEASE_NAME", "OPERATOR_NAME", "FIELD_NAME"]].last()
    m = p.groupby(["lease_key", "ym"], as_index=False)[["oil_bbl", "gas_mcf"]].sum()
    first_pos = m[m["oil_bbl"] > 0].groupby("lease_key")["ym"].min().rename("first_ym")
    m = m.merge(first_pos, on="lease_key")
    m = m[m["ym"] >= m["first_ym"]]
    idx = lambda ym: (ym // 100) * 12 + (ym % 100) - 1
    m["mop"] = idx(m["ym"]) - idx(m["first_ym"]) + 1
    m = m.sort_values(["lease_key", "ym"])

    ok_keys = set(first_pos[first_pos >= FIRST_ALLOWED_PROD].index)
    located = cand.dropna(subset=["mid_lat", "mid_lon"])
    ok_keys &= set(located["lease_key"])
    m = m[m["lease_key"].isin(ok_keys)]

    recs = []
    for key, g in m.groupby("lease_key"):
        mem = cand[cand["lease_key"] == key]
        loc = mem.dropna(subset=["mid_lat", "mid_lon"])
        mh = int(g["mop"].max())
        rec = {
            "pad_id": key, "lease_key": key, "well_count": len(mem), "located_wells": len(loc),
            "lease_name": names.loc[key, "LEASE_NAME"], "operator": names.loc[key, "OPERATOR_NAME"],
            "field": names.loc[key, "FIELD_NAME"],
            "county": str(mem["layer_county"].mode().iloc[0]),
            "mid_lat": loc["mid_lat"].mean(), "mid_lon": loc["mid_lon"].mean(),
            "lateral_sum_ft": mem["lateral_proxy_ft"].sum(), "lateral_max_ft": mem["lateral_proxy_ft"].max(),
            "first_prod_ym": int(g["ym"].min()), "last_ym": int(g["ym"].max()), "months_history": mh,
            "cum_oil_bbl": float(g["oil_bbl"].sum()), "cum_gas_mcf": float(g["gas_mcf"].sum()),
        }
        for k in (12, 24):
            rec[f"cum{k}_oil_bbl"] = float(g.loc[g["mop"] <= k, "oil_bbl"].sum()) if mh >= k else np.nan
        f = fit_one(g)
        for k in ("status", "peak_mop", "qi", "Di_annual", "b", "r_squared", "eur_bbl", "remaining_bbl"):
            rec[k] = f.get(k, np.nan)
        recs.append(rec)
    pads = pd.DataFrame(recs)
    pads["eur_per_1000ft"] = pads["eur_bbl"] / (pads["lateral_sum_ft"] / 1000.0)
    pads["eur_confidence"] = np.where(pads["status"] != "ok", "none",
                             np.where((pads["months_history"] >= 24) & (pads["r_squared"] >= 0.6), "high",
                             np.where(pads["months_history"] >= 18, "medium", "low")))
    pads = pads.sort_values("pad_id").reset_index(drop=True)
    pads.to_csv(os.path.join(PROC, "pads.csv"), index=False)
    mem = cand[cand["lease_key"].isin(set(pads["pad_id"]))][
        ["lease_key", "api8", "api10", "WELL_NO", "surf_lat", "surf_lon", "bhl_lat", "bhl_lon", "mid_lat", "mid_lon", "lateral_proxy_ft"]]
    mem.rename(columns={"lease_key": "pad_id", "WELL_NO": "well_no"}).to_csv(os.path.join(PROC, "pad_members.csv"), index=False)
    m[m["lease_key"].isin(set(pads["pad_id"]))].rename(columns={"lease_key": "pad_id"})[
        ["pad_id", "ym", "mop", "oil_bbl", "gas_mcf"]].to_csv(os.path.join(PROC, "pad_monthly.csv"), index=False)
    print(f"multi-well horizontals {len(mw)} on {mw.lease_key.nunique()} leases; pure-horizontal leases {len(keys)}; "
          f"pads {len(pads)} covering {int(pads.well_count.sum())} wells")
    print(pads["status"].value_counts().to_string())
    print(pads["eur_confidence"].value_counts().to_string())
    print(pads.groupby("county")["well_count"].agg(["size", "sum"]).to_string())


if __name__ == "__main__":
    main()
