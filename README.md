# OffsetIQ

Offset analysis for Permian operators in **Midland, Ector and Andrews County, TX** (Martin County is also included and is labelled as Martin). Drop a pin, enter lat/lon, an API, or a lease name. OffsetIQ then:

- finds public horizontal offsets within a radius, with lateral-length and operator filters;
- shows Arps decline / EUR / remaining for each offset;
- forecasts first-12-month oil and EUR (P10/P50/P90) with a LightGBM model trained only on public Texas RRC wells;
- exports the report as CSV or as a printable PDF, and gives a shareable link.

**Data:** Texas Railroad Commission public data only. Wells, APIs and volumes are never invented. Wells whose production can't be attributed to a single well are shown as coverage gaps. See `/data` in the app and `docs/`.

> Screening tool, not a reserves report.

## Refresh the data
```
pip install pandas numpy scipy lightgbm scikit-learn pyshp pyproj requests pytest
python pipeline/fetch_rrc.py      # RRC PDQ dump + well-layer shapefiles -> data/raw (not committed)
python pipeline/build_dataset.py  # single-well-lease attribution -> data/processed
python pipeline/dca.py            # Arps fits
python pipeline/train_model.py    # LightGBM + holdout metrics, exports public/data/model*.json
python pipeline/export_web.py     # public/data/*.json used by the app
pytest -q                         # Arps unit tests + golden data tests
npm ci && npm run test:ts         # TS model/feature parity vs Python
```
Commit `public/data/*.json`. Vercel then redeploys automatically.

## App
Next.js (App Router) at the repo root. Static JSON lives in `public/data`, and all analysis runs in `lib/engine.ts` (in the browser, and in `GET /api/offsets` for the JSON/CSV API).
