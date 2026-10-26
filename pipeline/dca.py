"""Step 3 — Arps DCA for every usable well (reuses the Midland Basin DCA
Dashboard's arps.py / clustering.py unchanged in method).

Method (identical to midland-basin-dca-dashboard):
  * zero months = shut-in, excluded from the fit; fit starts at the peak-rate month
  * hyperbolic Arps in log space, Di in [0.005, 0.80]/mo, b in [0.05, 2.0], qi <= observed peak
  * terminal exponential at 5%/yr, economic limit 150 bbl/month
  * EUR = cumulative produced + forecast remaining from end of history
  * k-means (k=3) on standardized (Di, b) -> Steep / Moderate / Mild decline

Also computes an "early fit" on ONLY the first 12 producing months after peak.
The early fit is what offset features use in the model, because it is known
~13-18 months after first production and therefore never looks into the future
relative to a later target well (see docs/MODEL_CARD.md, leakage rules).

Writes data/processed/dca_results.csv
"""
from __future__ import annotations

import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pipeline.arps import eur_bbl, fit_hyperbolic  # noqa: E402
from pipeline.clustering import cluster_wells  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROC = os.path.join(ROOT, "data", "processed")
ECON_LIMIT_BPM = 150.0
DMIN_M = 0.05 / 12
EARLY_N = 12


def ym_add(ym: int, k: int) -> int:
    i = (ym // 100) * 12 + (ym % 100) - 1 + k
    return (i // 12) * 100 + i % 12 + 1


def fit_one(g: pd.DataFrame) -> dict:
    g = g.sort_values("mop")
    cum = float(g["oil_bbl"].sum())
    pos = g[g["oil_bbl"] > 0]
    out = {"cum_oil_bbl_check": cum}
    if pos.empty:
        return {**out, "status": "no_production"}
    peak_idx = pos["oil_bbl"].idxmax()
    # Peak search limited to first 12 months so late restarts/refracs don't move the anchor.
    first12 = pos[pos["mop"] <= 12]
    if not first12.empty:
        peak_idx = first12["oil_bbl"].idxmax()
    peak_mop = int(g.loc[peak_idx, "mop"])
    peak_ym = int(g.loc[peak_idx, "ym"])
    fit_df = g[(g["mop"] >= peak_mop) & (g["oil_bbl"] > 0)].copy()
    fit_df["t"] = fit_df["mop"] - peak_mop + 1
    out.update({"peak_mop": peak_mop, "peak_oil_bbl": float(g.loc[peak_idx, "oil_bbl"])})

    # early fit: first EARLY_N producing months from peak
    e = fit_df.head(EARLY_N)
    if len(e) >= EARLY_N:
        ef = fit_hyperbolic(e["t"].to_numpy(), e["oil_bbl"].to_numpy(), Dmin=DMIN_M,
                            qi_max=float(e["oil_bbl"].max()))
        if ef["status"] == "ok":
            out.update({"early_qi": ef["qi"], "early_Di_annual": ef["Di_annual"], "early_b": ef["b"],
                        "early_r2": ef["r_squared"],
                        "early_known_ym": int(g.loc[e.index[-1], "ym"])})

    f = fit_hyperbolic(fit_df["t"].to_numpy(), fit_df["oil_bbl"].to_numpy(), Dmin=DMIN_M,
                       qi_max=float(fit_df["oil_bbl"].max()))
    out["status"] = f["status"]
    if f["status"] != "ok":
        return out
    last_mop = int(g["mop"].max())
    t_now = last_mop - peak_mop + 1
    e2 = eur_bbl(f["qi"], f["Di_monthly"], f["b"], cum, Dmin=DMIN_M,
                 econ_limit_bpm=ECON_LIMIT_BPM, start_t=t_now + 1)
    out.update({"qi": f["qi"], "Di_monthly": f["Di_monthly"], "Di_annual": f["Di_annual"],
                "b": f["b"], "r_squared": f["r_squared"], "fit_points": f["n_points"], **e2})
    return out


def main() -> None:
    wells = pd.read_csv(os.path.join(PROC, "wells.csv"), dtype={"api8": str})
    mon = pd.read_csv(os.path.join(PROC, "monthly.csv"), dtype={"api8": str})
    recs = []
    for api, g in mon.groupby("api8"):
        recs.append({"api8": api, **fit_one(g)})
    r = pd.DataFrame(recs)
    res = wells.merge(r, on="api8", how="left")
    # status on wells whose lease vanished (should not happen) stays NaN -> mark
    res["status"] = res["status"].fillna("no_production")
    res = cluster_wells(res, n_clusters=3)
    res["eur_per_1000ft"] = res["eur_bbl"] / (res["lateral_proxy_ft"] / 1000.0)
    # EUR quality flag: fits on < 24 months are shown but flagged.
    res["eur_confidence"] = np.where(res["status"] != "ok", "none",
                            np.where((res["months_history"] >= 24) & (res["r_squared"] >= 0.6), "high",
                            np.where(res["months_history"] >= 18, "medium", "low")))
    res.to_csv(os.path.join(PROC, "dca_results.csv"), index=False)
    ok = res[res["status"] == "ok"]
    print(res["status"].value_counts().to_string())
    print(f"fitted {len(ok)}/{len(res)}; mean b {ok.b.mean():.2f}; median EUR {ok.eur_bbl.median():,.0f}; "
          f"mean R2 {ok.r_squared.mean():.3f}")
    print(ok.groupby("county")["eur_bbl"].describe().round(0).to_string())
    print(res["eur_confidence"].value_counts().to_string())


if __name__ == "__main__":
    main()
