"""Step 2 — normalize RRC data into a well-level horizontal-oil dataset.

Joins three public RRC sources:
  * county well-layer shapefiles  -> API, surface lat/lon (NAD83), and the
    surface->bottom-hole line for horizontal wellbores (STCODE H*). The line
    length is the SHL->BHL horizontal displacement, used as a lateral-length
    PROXY (it includes the curve/heel offset; it is not a reported perf interval).
  * PDQ OG_WELL_COMPLETION_DATA_TABLE -> API -> (district, oil lease, well no)
  * PDQ OG_LEASE_CYCLE_DATA_TABLE     -> monthly lease oil / casinghead gas

Texas reports production by LEASE, not by well. To keep numbers honest we only
keep horizontals that are the ONLY completion on their lease (single-well
lease, which is how most Permian allocation/PSA horizontals are permitted), so
lease production == well production. Multi-well-lease horizontals are counted
in the coverage report but excluded from DCA/ML.

Outputs (data/processed/):
  wells_all_horizontals.csv  every horizontal wellbore found in the layers, with
                             join status (coverage accounting)
  wells.csv                  usable wells (single-well lease, production found)
  monthly.csv                monthly oil/gas for usable wells
"""
from __future__ import annotations

import glob
import json
import os
import zipfile

import numpy as np
import pandas as pd
import shapefile  # pyshp
from pyproj import Transformer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
OUT = os.path.join(ROOT, "data", "processed")
COUNTIES = {"003": "ANDREWS", "135": "ECTOR", "329": "MIDLAND", "317": "MARTIN"}
LAST_COMPLETE_MONTH = 202606   # RRC filings lag; 2026-07 was only ~86% filed in the Sep-2026 dump
FIRST_ALLOWED_PROD = 201301    # extract starts 2012-01; require first prod >= 2013 so we see the true start

_t27 = Transformer.from_crs("EPSG:4267", "EPSG:4269", always_xy=True)


def _ft_haversine(lon1, lat1, lon2, lat2):
    R = 20902231.0
    la1, lo1, la2, lo2 = map(np.radians, [lat1, lon1, lat2, lon2])
    d = np.sin((la2 - la1) / 2) ** 2 + np.cos(la1) * np.cos(la2) * np.sin((lo2 - lo1) / 2) ** 2
    return 2 * R * np.arcsin(np.sqrt(d))


def load_layers() -> pd.DataFrame:
    rows = []
    for code, cname in COUNTIES.items():
        d = os.path.join(RAW, f"w{code}")
        if not os.path.isdir(d):
            zipfile.ZipFile(os.path.join(RAW, f"well{code}.zip")).extractall(d)
        surf = shapefile.Reader(os.path.join(d, f"well{code}s"))
        s = pd.DataFrame(surf.records(), columns=[f[0] for f in surf.fields[1:]])
        s = s.drop_duplicates("API").set_index("API")
        lines = shapefile.Reader(os.path.join(d, f"well{code}l"))
        for sr in lines.iterShapeRecords():
            rec = sr.record
            if not str(rec["STCODE"]).startswith("H"):
                continue  # D* = directional, not horizontal
            pts = sr.shape.points
            (x0, y0), (x1, y1) = pts[0], pts[-1]
            bx, by = _t27.transform(x1, y1)
            api = str(rec["API"])
            sl = s.loc[api] if api in s.index else None
            rows.append({
                "api8": api,
                "api10": "42" + api,
                "stcode": rec["STCODE"],
                "layer_county": cname,
                "surf_lat": float(sl["LAT83"]) if sl is not None else np.nan,
                "surf_lon": float(sl["LONG83"]) if sl is not None else np.nan,
                "bhl_lat": by, "bhl_lon": bx,
                "lateral_proxy_ft": float(rec["SHAPE_LEN"]),
            })
    df = pd.DataFrame(rows)
    # Wellbores with several laterals (H1,H2..): keep the longest leg per API.
    df = df.sort_values("lateral_proxy_ft", ascending=False).drop_duplicates("api8")
    df["mid_lat"] = (df["surf_lat"] + df["bhl_lat"]) / 2
    df["mid_lon"] = (df["surf_lon"] + df["bhl_lon"]) / 2
    az = np.degrees(np.arctan2((df["bhl_lon"] - df["surf_lon"]) * np.cos(np.radians(df["surf_lat"])),
                               df["bhl_lat"] - df["surf_lat"])) % 360
    df["azimuth_deg"] = az
    return df


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    hz = load_layers()
    comp = pd.read_csv(os.path.join(RAW, "wellcomp.dsv"), sep="}", dtype=str, encoding="latin-1")
    comp["api8"] = comp["API_COUNTY_CODE"] + comp["API_UNIQUE_NO"]
    oil = comp[comp["OIL_GAS_CODE"] == "O"].copy()
    oil["lease_key"] = oil["DISTRICT_NO"] + "-" + oil["LEASE_NO"]
    wells_per_lease = oil.groupby("lease_key")["api8"].nunique()
    oil["wells_on_lease"] = oil["lease_key"].map(wells_per_lease)
    gas_apis = set(comp.loc[comp["OIL_GAS_CODE"] == "G", "api8"])
    o1 = oil.drop_duplicates("api8")[["api8", "lease_key", "DISTRICT_NO", "LEASE_NO", "WELL_NO",
                                      "COUNTY_NAME", "wells_on_lease"]]
    hz = hz.merge(o1, on="api8", how="left")
    hz["join_status"] = np.select(
        [hz["lease_key"].isna() & hz["api8"].isin(gas_apis), hz["lease_key"].isna(),
         hz["wells_on_lease"] > 1],
        ["gas_well_out_of_scope", "no_pdq_completion (permit/DUC/not yet producing or plugged)",
         "multi_well_lease (lease-level prod not allocable)"],
        default="single_well_lease")

    # ---- production ----
    p = pd.read_csv(os.path.join(RAW, "lease_cycle_target.dsv"), sep="}", dtype=str,
                    usecols=["DISTRICT_NO", "LEASE_NO", "CYCLE_YEAR_MONTH", "LEASE_OIL_PROD_VOL",
                             "LEASE_CSGD_PROD_VOL", "LEASE_NAME", "OPERATOR_NAME", "FIELD_NAME"],
                    encoding="latin-1")
    p["lease_key"] = p["DISTRICT_NO"] + "-" + p["LEASE_NO"]
    p["ym"] = p["CYCLE_YEAR_MONTH"].astype(int)
    p = p[p["ym"] <= LAST_COMPLETE_MONTH]
    p["oil_bbl"] = pd.to_numeric(p["LEASE_OIL_PROD_VOL"], errors="coerce").fillna(0.0)
    p["gas_mcf"] = pd.to_numeric(p["LEASE_CSGD_PROD_VOL"], errors="coerce").fillna(0.0)
    single = hz[hz["join_status"] == "single_well_lease"]
    p = p[p["lease_key"].isin(set(single["lease_key"]))]
    # Some leases report multiple rows per month (field transfers): sum them.
    names = p.sort_values("ym").groupby("lease_key")[["LEASE_NAME", "OPERATOR_NAME", "FIELD_NAME"]].last()
    m = p.groupby(["lease_key", "ym"], as_index=False)[["oil_bbl", "gas_mcf"]].sum()
    first_pos = m[m["oil_bbl"] > 0].groupby("lease_key")["ym"].min()
    m = m.merge(first_pos.rename("first_ym"), on="lease_key")
    m = m[m["ym"] >= m["first_ym"]]
    ym_to_idx = lambda ym: (ym // 100) * 12 + (ym % 100) - 1
    m["mop"] = ym_to_idx(m["ym"]) - ym_to_idx(m["first_ym"]) + 1
    m = m.sort_values(["lease_key", "ym"])

    usable = single.merge(names, left_on="lease_key", right_index=True, how="inner")
    usable = usable.merge(first_pos.rename("first_prod_ym"), left_on="lease_key", right_index=True)
    hz.loc[hz["join_status"].eq("single_well_lease") & ~hz["lease_key"].isin(usable["lease_key"]),
           "join_status"] = "no_oil_production_reported_2012_2026"
    old = usable["first_prod_ym"] < FIRST_ALLOWED_PROD
    hz.loc[hz["lease_key"].isin(usable.loc[old, "lease_key"]), "join_status"] = "first_prod_before_2013 (start not observed)"
    usable = usable[~old]
    hz.loc[hz["lease_key"].isin(usable["lease_key"]), "join_status"] = "usable"
    usable = usable.dropna(subset=["surf_lat", "bhl_lat"])
    m = m[m["lease_key"].isin(usable["lease_key"])]
    agg = m.groupby("lease_key").agg(months_history=("mop", "max"), cum_oil_bbl=("oil_bbl", "sum"),
                                     cum_gas_mcf=("gas_mcf", "sum"), last_ym=("ym", "max"))
    usable = usable.merge(agg, left_on="lease_key", right_index=True)
    for k in (6, 12, 24):
        c = m[m["mop"] <= k].groupby("lease_key")["oil_bbl"].sum()
        usable[f"cum{k}_oil_bbl"] = usable["lease_key"].map(c)
        usable.loc[usable["months_history"] < k, f"cum{k}_oil_bbl"] = np.nan
    pk = m[m["mop"] <= 6].groupby("lease_key")["oil_bbl"].max()
    usable["peak_month_oil_bbl_first6"] = usable["lease_key"].map(pk)
    usable["county"] = usable["COUNTY_NAME"].str.upper().fillna(usable["layer_county"])
    usable = usable.rename(columns={"LEASE_NAME": "lease_name", "OPERATOR_NAME": "operator",
                                    "FIELD_NAME": "field", "WELL_NO": "well_no",
                                    "LEASE_NO": "lease_no", "DISTRICT_NO": "district_code"})
    usable["well_no"] = usable["well_no"].str.strip()
    usable.to_csv(os.path.join(OUT, "wells.csv"), index=False)
    m.merge(usable[["lease_key", "api8"]], on="lease_key")[["api8", "ym", "mop", "oil_bbl", "gas_mcf"]] \
        .to_csv(os.path.join(OUT, "monthly.csv"), index=False)
    hz.to_csv(os.path.join(OUT, "wells_all_horizontals.csv"), index=False)

    cov = (hz.groupby(["layer_county", "join_status"]).size().unstack(fill_value=0))
    print(cov.to_string())
    cov_json = {c: {k: int(v) for k, v in row.items()} for c, row in cov.iterrows()}
    json.dump({"last_complete_month": LAST_COMPLETE_MONTH, "coverage": cov_json,
               "usable_by_county": usable["county"].value_counts().to_dict()},
              open(os.path.join(OUT, "coverage.json"), "w"), indent=2)
    print(usable["county"].value_counts())


if __name__ == "__main__":
    main()
