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

## Screen mode (screening agent)
`/screen` takes one plain-English request and runs the whole screen. Example requests: "rank the best spots in Midland County", "screen every location in this lease block" (with the block drawn on the map), "compare these three tracts".

- It parses the request into explicit parameters and shows them back. Anything the public data can't support, such as depth or bench, is reported rather than dropped.
- It lays a 40-acre grid of candidate lateral midpoints over the area, coarsening it on very large areas and saying so.
- It screens every candidate in parallel with the same features and LightGBM models as Analyze.
- It ranks the candidates and explains each rank from the computed numbers.

The operator excludes and re-ranks rows, then approves. Only then can the list be exported as CSV, print/PDF, or a share link that carries the report inside the URL fragment. Nothing is stored.
```
pip install -r agent/requirements.txt
python3 -m agent.server     # the agent, on 127.0.0.1:8765 (or: npm run agent)
npm run dev                 # /screen calls it through /api/screen
```
In production, set `OFFSETIQ_AGENT_URL` to wherever the agent service runs. Without it, Screen mode says it is not connected, and Analyze is unaffected.

Tests:
- `python3 -m pytest -q` covers the agent: intent phrasings, grids, ranking stability, multi-well coverage gaps, Python/TypeScript parity, and the loop and server.
- `npm run test:ts` adds the parity-golden freshness check and the review/export tests.
- After a data refresh, regenerate the fixtures with `npm run golden:screen` and `python3 -m tests.test_agent_contract`.

Design, measurements and limits are in `docs/SCREENING_AGENT.md`.
