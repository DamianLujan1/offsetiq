"""Step 4 — train LightGBM models on real public wells and export them for the web app.

Targets (log-space regression):
  * cum12  — first-12-month cumulative oil (OBSERVED; wells with >= 12 months)
  * eur    — Arps EUR (MODELED; only wells with eur_confidence == 'high':
             >= 24 months history and fit R^2 >= 0.6)
  * eur_p10 / eur_p90 — quantile models for an EUR range

Validation: temporal holdout. Train on wells first producing before 2022-01;
test on wells first producing 2022-01 onward. Baselines: county median and the
classic "offset average" (IDW offsets' cum12 per 1,000 ft x target lateral).
Final exported models are refit on all eligible wells.

Writes:
  data/processed/training_table.csv
  data/processed/model_metrics.json
  web/public/data/model.json        compact tree dump for the TS evaluator
  web/public/data/golden_model.json feature rows + Python predictions (parity test)
"""
from __future__ import annotations

import json
import os
import sys

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.cluster import KMeans
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pipeline.features import COUNTY_CODE, FEATURES, offset_features  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROC = os.path.join(ROOT, "data", "processed")
WEBDATA = os.path.join(ROOT, "public", "data")
SPLIT_YM = 202201
PARAMS = dict(n_estimators=300, learning_rate=0.03, num_leaves=7, min_child_samples=60,
              subsample=0.8, subsample_freq=1, colsample_bytree=0.7, reg_lambda=5.0,
              random_state=42, verbose=-1)


def early_clusters(df: pd.DataFrame) -> tuple[np.ndarray, dict]:
    ok = df["early_Di_annual"].notna()
    X = df.loc[ok, ["early_Di_annual", "early_b"]].to_numpy()
    sc = StandardScaler().fit(X)
    km = KMeans(n_clusters=3, n_init=10, random_state=42).fit(sc.transform(X))
    cent = sc.inverse_transform(km.cluster_centers_)
    order = np.argsort(-cent[:, 0])  # steepest first
    remap = {int(order[i]): i for i in range(3)}
    lab = np.full(len(df), -1)
    lab[ok.to_numpy()] = [remap[int(x)] for x in km.labels_]
    info = {"centroids_Di_annual_b": cent[order].round(4).tolist(), "names": ["Steep", "Moderate", "Mild"]}
    return lab, info


def build_pool(df: pd.DataFrame) -> dict:
    p = df[df["early_Di_annual"].notna()]
    return {
        "api8": p["api8"].to_numpy(), "lat": p["mid_lat"].to_numpy(), "lon": p["mid_lon"].to_numpy(),
        "early_known_ym": p["early_known_ym"].to_numpy().astype(int),
        "cum12_per_kft": (p["cum12_oil_bbl"] / (p["lateral_proxy_ft"] / 1000)).to_numpy(),
        "early_qi": p["early_qi"].to_numpy(), "early_Di": p["early_Di_annual"].to_numpy(),
        "early_b": p["early_b"].to_numpy(), "early_cluster": p["early_cluster"].to_numpy(),
    }


def metrics(y_true, y_pred) -> dict:
    y_true, y_pred = np.asarray(y_true), np.asarray(y_pred)
    lt, lp = np.log(y_true), np.log(y_pred)
    ape = np.abs(y_pred - y_true) / y_true
    ss = ((lt - lt.mean()) ** 2).sum()
    return {"n": int(len(y_true)), "r2_log": float(1 - ((lt - lp) ** 2).sum() / ss),
            "mape": float(ape.mean()), "median_ape": float(np.median(ape)),
            "mae": float(np.abs(y_pred - y_true).mean()),
            "within_25pct": float((ape <= 0.25).mean())}


def dump_compact(booster: lgb.Booster) -> dict:
    d = booster.dump_model()
    trees = []
    for t in d["tree_info"]:
        nodes = []
        def walk(n):
            if "leaf_value" in n:
                nodes.append([-1, 0, 0, 0, 0, n["leaf_value"]])
                return len(nodes) - 1
            idx = len(nodes)
            nodes.append(None)
            l = walk(n["left_child"]); r = walk(n["right_child"])
            # [feature, threshold, left, right, flags, 0]; flags bit0 = missing goes left
            ml = 1 if n.get("default_left", True) else 0
            mt = {"None": 0, "Zero": 1, "NaN": 2}[n.get("missing_type", "None")]
            nodes[idx] = [n["split_feature"], n["threshold"], l, r, ml + 2 * mt, 0]
            return idx
        walk(t["tree_structure"])
        trees.append(nodes)
    return {"features": d["feature_names"], "trees": trees}


def main() -> None:
    df = pd.read_csv(os.path.join(PROC, "dca_results.csv"), dtype={"api8": str})
    df["early_cluster"], cinfo = early_clusters(df)
    df["county_code"] = df["county"].map(COUNTY_CODE)
    df["vintage_year"] = (df["first_prod_ym"] // 100).astype(int)
    pool = build_pool(df)
    feats = [offset_features(r.mid_lat, r.mid_lon, int(r.first_prod_ym), pool, exclude_api=r.api8,
                             lateral_ft=r.lateral_proxy_ft)
             for r in df.itertuples()]
    df = pd.concat([df.reset_index(drop=True), pd.DataFrame(feats)], axis=1)
    df.to_csv(os.path.join(PROC, "training_table.csv"), index=False)

    out = {"split_first_prod_ym": SPLIT_YM, "features": FEATURES, "params": PARAMS,
           "early_clusters": cinfo, "targets": {}}
    models = {}
    holdout_models = {}
    specs = {
        "cum12": (df["cum12_oil_bbl"].notna() & (df["cum12_oil_bbl"] > 1000), "cum12_oil_bbl", {}),
        "cum12_p10": (df["cum12_oil_bbl"].notna() & (df["cum12_oil_bbl"] > 1000), "cum12_oil_bbl", {"objective": "quantile", "alpha": 0.1}),
        "cum12_p90": (df["cum12_oil_bbl"].notna() & (df["cum12_oil_bbl"] > 1000), "cum12_oil_bbl", {"objective": "quantile", "alpha": 0.9}),
        "eur": (df["eur_confidence"].eq("high"), "eur_bbl", {}),
        "eur_p10": (df["eur_confidence"].eq("high"), "eur_bbl", {"objective": "quantile", "alpha": 0.1}),
        "eur_p90": (df["eur_confidence"].eq("high"), "eur_bbl", {"objective": "quantile", "alpha": 0.9}),
    }
    for name, (mask, ycol, extra) in specs.items():
        d = df[mask]
        X, y = d[FEATURES], np.log(d[ycol])
        tr, te = d["first_prod_ym"] < SPLIT_YM, d["first_prod_ym"] >= SPLIT_YM
        mdl = lgb.LGBMRegressor(**PARAMS, **extra).fit(X[tr], y[tr])
        holdout_models[name] = mdl.booster_
        pred = np.exp(mdl.predict(X[te]))
        rec = {"n_train": int(tr.sum()), "n_test": int(te.sum()),
               "train_first_prod": [int(d.loc[tr, "first_prod_ym"].min()), int(d.loc[tr, "first_prod_ym"].max())],
               "test_first_prod": [int(d.loc[te, "first_prod_ym"].min()), int(d.loc[te, "first_prod_ym"].max())]}
        if not extra:
            rec["lightgbm_holdout"] = metrics(d.loc[te, ycol], pred)
            # baseline 1: county median from training wells
            cm = d[tr].groupby("county")[ycol].median()
            rec["baseline_county_median"] = metrics(d.loc[te, ycol], d.loc[te, "county"].map(cm).fillna(d.loc[tr, ycol].median()))
            # baseline 2: offset average (cum12 per kft) scaled by lateral, ratio-calibrated on train
            ob = d["idw_cum12_per_kft"] * d["lateral_proxy_ft"] / 1000
            okb = ob.notna()
            k = float(np.exp(np.median(np.log(d.loc[tr & okb, ycol] / ob[tr & okb]))))
            bl = (ob * k).where(okb, d["county"].map(cm))
            bl = bl.fillna(d.loc[tr, ycol].median())
            rec["baseline_offset_average"] = metrics(d.loc[te, ycol], bl[te])
            rec["holdout_with_offsets_only"] = metrics(d.loc[te & (d["n_off"] > 0), ycol], np.exp(mdl.predict(X[te & (d["n_off"] > 0)])))
        else:
            cover = (d.loc[te, ycol] <= pred) if extra["alpha"] > 0.5 else (d.loc[te, ycol] >= pred)
            rec["holdout_coverage"] = float(cover.mean())
        final = lgb.LGBMRegressor(**PARAMS, **extra).fit(X, y)
        rec["n_final"] = int(len(d))
        imp = final.booster_.feature_importance("gain")
        rec["feature_importance_gain"] = dict(sorted(zip(FEATURES, (imp / imp.sum()).round(4).tolist()), key=lambda t: -t[1]))
        out["targets"][name] = rec
        models[name] = final.booster_
        print(name, json.dumps({k: v for k, v in rec.items() if k != "feature_importance_gain"}, indent=1))

    os.makedirs(WEBDATA, exist_ok=True)
    json.dump(out, open(os.path.join(PROC, "model_metrics.json"), "w"), indent=2)
    json.dump({k: dump_compact(b) for k, b in models.items()}, open(os.path.join(WEBDATA, "model.json"), "w"),
              separators=(",", ":"))
    # holdout models (trained only on wells first producing before SPLIT_YM): used by the app's
    # backtest mode so wells first producing >= 2022 are scored truly out-of-sample.
    json.dump({k: dump_compact(b) for k, b in holdout_models.items()},
              open(os.path.join(WEBDATA, "model_holdout.json"), "w"), separators=(",", ":"))
    # golden parity rows: 200 wells incl. some with no offsets (NaNs)
    g = df.sample(200, random_state=1)
    rows = g[FEATURES].astype(float).replace({np.nan: None}).values.tolist()
    preds = {k: models[k].predict(g[FEATURES]).tolist() for k in models}
    hpreds = {k: holdout_models[k].predict(g[FEATURES]).tolist() for k in holdout_models}
    json.dump({"features": FEATURES, "rows": rows, "pred_log": preds, "pred_log_holdout": hpreds}, open(os.path.join(WEBDATA, "golden_model.json"), "w"))
    df[["api8", "early_cluster"]].to_csv(os.path.join(PROC, "early_clusters.csv"), index=False)


if __name__ == "__main__":
    main()
