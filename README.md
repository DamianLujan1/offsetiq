# OffsetIQ

Offset analysis for Permian operators in **Midland, Ector and Andrews County, TX** (Martin County is also included and is labelled as Martin). Drop a pin, enter lat/lon, an API, or a lease name. OffsetIQ then:

- finds public horizontal offsets within a radius, with lateral-length and operator filters;
- shows Arps decline / EUR / remaining for each offset;
- forecasts first-12-month oil (primary) and EUR (secondary — does not beat a county median on holdout) (P90/P50/P10, PRMS convention: P90 = low case, P10 = high case) with a LightGBM model trained only on public Texas RRC wells;
- exports the report as CSV or as a printable PDF, and gives a shareable link.

**Data:** Texas Railroad Commission public data only. Wells, APIs and volumes are never invented. Pure-horizontal multi-well leases are shown as pads with lease-level production (no per-well split); other wells whose production can't be attributed are shown as coverage gaps. See `/data` in the app and `docs/`.

> Screening tool, not a reserves report.

## Refresh the data
```
pip install pandas numpy scipy lightgbm scikit-learn pyshp pyproj requests pytest
python pipeline/fetch_rrc.py      # RRC PDQ dump + well-layer shapefiles -> data/raw (not committed)
python pipeline/build_dataset.py  # single-well-lease attribution -> data/processed
python pipeline/dca.py            # Arps fits
python pipeline/pads.py           # multi-well horizontal leases -> pads (lease-level Arps)
python pipeline/train_model.py    # LightGBM + holdout metrics, exports public/data/model*.json
python pipeline/export_web.py     # public/data/*.json used by the app
pytest -q                         # Arps unit tests + golden data tests
npm ci && npm run test:ts         # TS model/feature parity vs Python
```
Commit `public/data/*.json`. Vercel then redeploys automatically.

## App
Next.js (App Router) at the repo root. Static JSON lives in `public/data`, and all analysis runs in `lib/engine.ts` (in the browser, and in `GET /api/offsets` for the JSON/CSV API).
