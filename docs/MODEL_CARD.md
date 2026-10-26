# OffsetIQ Model Card

> Screening tool, not a reserves report.

## What it predicts
For a proposed or existing horizontal oil well in Midland, Ector, Andrews or Martin County, TX:

- **cum12**: first-12-month cumulative oil (bbl). This is an *observed* label (wells with at least 12 producing months).
- **EUR**: Arps-modeled estimated ultimate recovery (bbl). This label is *modeled*: only wells with `eur_confidence == "high"` (at least 24 months of history and fit R² ≥ 0.6) are used.
- **P10 / P50 / P90** for both: P50 comes from a LightGBM regression in log space, and P10/P90 come from LightGBM quantile models (alpha 0.1 / 0.9).

## Data
- Public **Texas Railroad Commission** data only: the PDQ dump (well completions, lease cycle production) and the county well-layer shapefiles. No wells, APIs or volumes are invented.
- Texas reports production by lease, not by well. Only horizontals that are the **only completion on their lease** are kept, so lease production equals well production. Multi-well-lease wells are counted as coverage gaps (`data/processed/coverage.json`) and excluded from DCA and ML.
- Lateral length is a **proxy**: the horizontal displacement from SHL to BHL in the RRC well layer. It includes the curve and heel offset and is not a reported perforated interval.
- Last complete production month in this build: 2026-06. Usable wells by county: Midland 2,060, Martin 1,866, Andrews 669, Ector 121.

## Decline curves (Arps)
- Hyperbolic Arps fit in log space, starting at the peak month (peak searched within the first 12 months). Zero months are treated as shut-ins and excluded.
- Bounds: Di in [0.005, 0.80]/mo, b in [0.05, 2.0], qi ≤ observed peak.
- Terminal exponential decline at 5%/yr, with an economic limit of 150 bbl/month.
- EUR = cumulative produced + forecast remaining from the end of history.
- k-means (k=3) on the standardized early-fit (Di, b) gives the decline clusters Steep, Moderate and Mild.

## Features (14)
`lateral_proxy_ft, mid_lat, mid_lon, county_code, vintage_year, n_off, d_nearest_mi, idw_cum12_per_kft, idw_early_qi, idw_early_Di, idw_early_b, frac_steep, frac_mild, off_cum12_scaled`

Offsets are found within a 3-mile radius and weighted by inverse distance. The same feature code runs in Python for training and in TypeScript for inference, and parity is checked by golden tests (`tests/test_golden.py`, `scripts/golden-ts.test.ts`).

### Leakage rules
1. A target well never contributes to its own features.
2. An offset is visible to a target only if the offset's early-fit window (the first 12 producing months after peak) closed **before** the target's first production month.
3. Offset features use early-window quantities only, never an offset's full-history EUR.
4. The target's own production is never a feature.

## Validation: temporal holdout
Train on wells with first production before 2022-01. Test on wells with first production from 2022-01 onward (to 2025-07 for cum12 and 2024-07 for EUR). The exported models are then refit on all eligible wells.

| Target | Model | n test | R² (log) | Median APE | MAPE | Within ±25% |
|---|---|---|---|---|---|---|
| cum12 | LightGBM | 2,306 | 0.18 | 20.7% | 46.6% | 57.2% |
| cum12 | Offset average baseline | 2,306 | 0.03 | 24.4% | 54.0% | 51.5% |
| cum12 | County median baseline | 2,306 | −0.08 | 26.7% | 54.8% | 46.9% |
| EUR | LightGBM | 1,462 | 0.06 | 31.6% | 45.3% | 39.8% |
| EUR | County median baseline | 1,462 | −0.01 | 30.8% | 43.0% | 43.1% |
| EUR | Offset average baseline | 1,462 | −0.21 | 37.9% | 56.9% | 34.6% |

Quantile coverage on the holdout: cum12 P10 83.2%, cum12 P90 84.1%, EUR P10 81.7%, EUR P90 86.5%. Each one-sided bound is nominally 90%, so the P10–P90 band is somewhat **narrower than nominal**.

Top features by gain (cum12 P50): lateral proxy (48%), longitude (18%), offsets' scaled cum12 (11%).

## Honest limitations
- The cum12 model clearly beats both baselines. The **EUR model does not reliably beat a county median**: its MAPE and within-25% are slightly worse, though its log R² is higher. Treat the EUR P50 as a rough screen.
- The EUR labels are themselves Arps forecasts, so their error adds to the model's error.
- Only single-well-lease horizontals are covered, which biases the sample (many newer multi-well pads are excluded).
- The model has no completion design inputs (proppant, fluid, spacing, landing zone), because these are not reliably in the public RRC data used here.
- Results apply only to the four counties above.
