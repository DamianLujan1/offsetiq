# Screen mode: the screening agent

> The agent proposes; the operator decides. Screening estimate, not a reserves report.

`/screen` puts one prompt box in front of the whole offset-screening workflow. "Rank the best
spots in Midland County", "screen every location in this lease block" (with the block drawn on
the map) or "compare these three tracts" runs end to end:

1. **Parse** the request into explicit parameters, and show the interpretation back.
2. **Lay out** a grid of candidate lateral midpoints over the area (40-acre by default).
3. **Screen** every candidate in parallel with the same features and LightGBM models as Analyze.
4. **Rank** them and **explain** each rank from the computed numbers.
5. **Hand the list to the operator**, who excludes and re-ranks rows, then approves. Only an
   approved list can be exported (CSV, print/PDF, or a share link).

Nothing is stored. Analyze is unchanged; Screen is a separate tab.

## Architecture

```
browser /screen (components/ScreenAgent.tsx, ScreenMap.tsx, lib/screen.ts)
   │  POST /api/screen {prompt, drawn polygons/points}          NDJSON events, streamed
   ▼
app/api/screen/route.ts  ── proxy, logs nothing ──►  agent/server.py (FastAPI, POST /screen)
                                                         │
                                agent/loop.py  run(): parse ─► expand ─► screen ─► rank ─► proposal
                                                 │          │          │          │
                                     agent/intent.py  agent/geo.py  agent/engine.py  agent/rank.py
                                                                     │  ▲
                              pipeline/features.py (offset_features) ┘  │ agent/forest.py (model.json)
                              agent/snapshot.py ◄── public/data/*.json (the pipeline's export)
```

### Reuse, not reimplementation

There is no per-location RRC fetch to reuse. `pipeline/fetch_rrc.py` pulls the RRC bulk dumps
once per data refresh. `build_dataset.py` does the single-well-lease attribution once.
`export_web.py` freezes the result into `public/data/*.json`, and the Analyze page reads the same
files. The agent loads that snapshot once per process (`agent/snapshot.py`), so offsets are never
fetched again for overlapping candidates. Per candidate, `agent/engine.py` then works as follows:

- **Features** come from `pipeline/features.offset_features`, the single definition training uses.
  It is called directly with the same pool shape `train_model.build_pool` builds, so the leakage
  rules come with it.
- **Forecasts** evaluate the exported LightGBM trees (`public/data/model.json`) with `agent/forest.py`.
  `tests/test_agent_engine.py` checks it **bit for bit** against LightGBM's own predictions in
  `golden_model.json`, final and holdout models.
- **Everything else** about a location mirrors `lib/engine.ts analyze()` in prospect mode: the county,
  the coverage check, offsets within the radius with the Analyze filters, coverage gaps, and the
  offset-analog EUR.

`scripts/screen-golden.ts` runs the real `analyze()` on 55 fixed locations into
`tests/fixtures/screen_golden.json`. These cover random points, near-well points, outside
coverage, sparse Ector, and every lateral, radius and filter the cases cycle through.
`tests/test_agent_parity.py` requires the Python engine to reproduce every number to 1e-9, with and
without the tile cache. `npm run test:ts` fails if the fixture goes stale. So a location screened
by the agent gets the forecast the Analyze page shows for it.

### Parallelism (measured, and why it is processes)

Screening a location is CPU-bound numpy/Python on in-memory arrays, with no I/O to overlap. Under
the GIL, threads only add contention. Results for Midland County at 80-acre spacing (7,225
locations, 4 vCPU):

| How candidates were run | Time | Locations/s |
|---|---|---|
| asyncio + semaphore, 10 threads | 23.9 s | 303 |
| asyncio + 1 thread | 8.0 s | 905 |
| In process, batched | 4.5 s | 1,622 |
| **4 worker processes, batched (shipped)** | **1.4 s** | **5,300** |

The loop keeps the shape the brief asked for. An `asyncio.Semaphore` bounds work in flight: at
most 10 batches per run, which gives back-pressure and fairness between concurrent runs. The unit
of work is a batch of up to 32 neighbouring candidates, sent to a shared `ProcessPoolExecutor`.
Each worker loads the public snapshot once. Batches are grouped by map tile, and every batch builds
a small tile cache ("which wells could be near this ~1 mi tile"), so neighbouring candidates share
their offset lookups. That cache is dropped when the batch returns. Duplicate locations are
screened once. The ranking is identical in every mode (inline, 1–10 in flight, 2–4 workers,
reruns), and `tests/test_agent_rank.py` checks this. Tuning: `OFFSETIQ_AGENT_WORKERS` (default
min(8, CPUs); `0` or `1` = in-process).

### Intent parsing (`agent/intent.py`)

The parser is deterministic on purpose. The interpretation is shown back before results, every
reading of an ambiguous phrase is written to `notes`, and nothing is guessed silently. Even a
quantity it could not attach to anything ("laterals over 12,000 ft") is reported back.

**Areas**, in order of precedence:
1. **Typed coordinates.** These become points, or a polygon or box when the prompt says so.
   Lon/lat order and missing minus signs are fixed, and the fix is said.
2. **Shapes drawn on the map**, when the prompt points at them ("this lease block", "these three
   tracts", "what I drew"), or when it names no other area. If the prompt points at a drawing
   that isn't there, the agent asks instead of guessing.
3. **An attributable lease by name or RRC lease number.** The RRC publishes no lease boundaries,
   so the area is the hull of the matching wellbores grown by ¼ mi, and the plan says so. Names
   matching too many wells ("MABEE": 347 wellbores over 314 sq mi) get a question back. The
   public dump numbers districts differently from RRC's "08-", so lease numbers match on the number.
4. **A county.** Census county polygons are kept in `agent/data/counties.geojson`, and 4,715 of
   4,716 attributable wells fall inside their RRC county. "Midland Basin" screens all four
   counties; a county outside coverage is refused by name.

**Parameters:**
- **Candidate lateral**: "2-mile laterals", "12,500 ft laterals".
- **Spacing**: "80-acre spacing", told apart from an area size like "this 640-acre lease block".
- **Offset radius**: "within 1.5 miles", 0.5–10 mi as on Analyze.
- **Top N.**
- **Output preference**: csv/pdf/link. These pre-select export buttons and never auto-export.
- **Offset-evidence filters**: offset lateral range, operator (validated against RRC operator
  names), and first-production vintage.

Filters behave exactly as on Analyze. They narrow the evidence listed and counted, never the
forecast, which always uses every attributable well within 3 mi.

**Not supported by public RRC data, so reported and never dropped:**
- depth / TVD, bench / formation;
- completion design;
- multi-well-lease volumes;
- gas / BOE, economics;
- private data.

"Single-well leases only" and "horizontals only" are acknowledged as always on.

**Why not an LLM here.** A model-written parse can invent a polygon or a county. A model-written
rationale can state a number nobody computed. Both would break "never invent volumes". Sending
operators' areas to a third party would also break "your data, your export". A model-backed parser
can be added behind `parse()` later, as long as its output goes through the same validation
(`geo.clean_ring`, coverage checks) and the same show-it-back step.

### Grid (`agent/geo.py`)

A candidate is a proposed **lateral midpoint**, because that is the point the model forecasts. The
grid works like this:
- "40-acre spacing" means one candidate per 40 acres, on a square lattice of 1,320 ft cells,
  anchored at the area's south-west corner.
- A cell is kept only if its centre is strictly inside the polygon. An area smaller than one cell
  still gets one interior point.
- This is a screening density, not a development plan.
- Runs are capped at 8,000 locations. A larger area is coarsened step by step (40 → 80 → 160 → 320
  → 640 acres), and the plan says so. For example, Midland County at 40 acres would be 14,400
  locations, so it runs at 80.

### Ranking and rationale (`agent/rank.py`)

Ranking follows the brief: first-12-month oil P50, then EUR P50, then offset density (attributable
wells with an early decline fit within 3 mi, i.e. the wells feeding the model), then a fixed
position tie-break. Exact ties are common, because tree-model neighbours share leaves. The order
never depends on input order or on which task finished first.

**Two deliberate additions, both about evidence:**
- **Not ranked.** Locations outside coverage, or with no attributable offset within 3 mi, are not
  ranked. There the "forecast" is location-and-lateral extrapolation. They are listed with the
  reason, and the multi-well-lease wells around them are counted as gaps.
- **Low-confidence tier.** Locations with only 1–2 offsets (the threshold at which Analyze already
  warns "low confidence") rank after every location with 3+. Without this, sparse areas top the
  list because the model extrapolates high where it is least constrained. In Andrews County, 80%
  of a pure-P50 top 25 rested on fewer than 3 offsets (median 1, none within a mile). With the
  tier, the same top 25 has a median of 62.

**Rationale.** Each location's rationale is filled only from computed numbers. Its headline follows
the brief, with the primary sort key added: *"Rank #3: 4 nearby offsets within 1 mile, median 12-mo
oil 38k bbl, 12-mo oil P50 41k bbl, EUR P50 210k bbl, 2 multi-well gaps excluded."* Details give:
- the P90 (low case) to P10 (high case) range, in the PRMS convention the Analyze page uses;
- the nearest offset;
- the wells feeding the model;
- the gaps, and why they carry no volumes;
- an offset-analog EUR cross-check;
- any flags;
- "why above the next", naming the key that decided it.

The run summary also states the uncomfortable part. The model's median error on held-out wells is
21% for 12-month oil, while a top 25 typically spans 3–15%. Neighbouring ranks are therefore not
meaningfully different: the list finds areas worth an engineer's look; it does not pick wells.

### Coverage gaps on multi-well leases

Texas reports production per lease. A horizontal on a multi-well lease has no per-well volume, so
the agent only counts it. `tests/test_agent_coverage_gaps.py` checks three things:
- **No overlap**: no attributable well is a multi-well-lease horizontal.
- **Only the count changes**: planting 12 extra multi-well horizontals next to a location changes
  its gap count and nothing else (features, forecast, evidence, median).
- **Gap-only locations are reported, not ranked**: a real location surrounded only by gaps is never
  ranked, and no forecast number for it reaches the browser.

### Review, approval, export (`lib/screen.ts`)

- **Review.** The operator can exclude rows and move them up or down. Excluded rows stay visible,
  struck through.
- **Approval.** **Approve** snapshots the kept rows in order. Any later edit clears the approval.
  Export buttons stay disabled until there is one.
- **CSV.** The CSV reuses `csvCell` from `lib/engine.ts`, the exact escaping the Analyze CSV
  uses; extracting it left Analyze's output byte-identical. It holds operator and agent rank, the
  numbers, the rationale and an Analyze deep link per row, under header lines with the prompt,
  approval time, data dates and data rules.
- **Print / PDF.** This uses the app's print stylesheet, and only the approved report prints. An
  unapproved list prints as a draft notice.
- **Share link.** The link is `/screen#r=…`: the approved report, deflate-compressed, inside the
  URL fragment. About 4 KB for 10 rows. Opening it shows a read-only report.
  - Decoding validates every field.
  - Links are rebuilt from numbers, never taken from the payload.
  - Tooltips render text, never HTML.
  - A damaged or tampered link shows an error, not a report.

### Data ownership: what "nothing is stored" means here

- **No storage.** There is no database and no file write. The agent holds a request only for the
  duration of its stream. Worker processes hold only the public snapshot, and tile caches live and
  die with a batch.
- **No logs.** The agent's access log is off. Failures log the exception type and file:line frames
  only, never messages or source lines that could carry a prompt or coordinates; a test enforces
  this. The Next.js proxy logs nothing.
- **Share links.** The fragment of a share link is not sent to any server by browsers. Anyone who
  has the link can read it, and the UI says so.
- **No autonomous action.** The agent never exports, saves or acts. Every export is a browser
  action after approval.

### Deploying (Vercel)

Two Vercel projects deploy from this repository:

- **`offsetiq`** is the Next.js app, unchanged.
- **`offsetiq-agent`** is the screening agent: the FastAPI preset at the repository root, with the
  entrypoint `agent.server:app` and its dependencies in `pyproject.toml`. Its Ignored Build Step skips
  builds unless `agent/`, `pipeline/`, `public/data/` or `pyproject.toml` changed.

| Project | Variable | Value |
|---|---|---|
| `offsetiq-agent` | `OFFSETIQ_AGENT_TOKEN` | Shared secret (sensitive). `/screen` then accepts only callers that send it. |
| `offsetiq-agent` | `OFFSETIQ_AGENT_WORKERS` | `0`: Vercel functions can't run process pools, so screening runs in-process. |
| `offsetiq` | `OFFSETIQ_AGENT_URL` | The agent's production URL. |
| `offsetiq` | `OFFSETIQ_AGENT_TOKEN` | The same secret. |

The token is a key between the two services, not user authentication. Without `OFFSETIQ_AGENT_URL`,
Screen mode reports that it is not connected and Analyze keeps working. `next dev` defaults to
`http://127.0.0.1:8765`, and a local agent with no token set accepts any caller.

`GET /health?deep=1` on the agent runs a fixed three-location screen (no user data) and returns its
P50s. They must equal the values pinned in `tests/test_agent_loop.py`, which shows a deployment
computes exactly what the tests do. Elsewhere, the agent runs anywhere `python -m agent.server`
runs. With several cores it uses worker processes; a full county takes about 1–2 s on 4 cores.

### Event protocol (NDJSON, one object per line)

| `type` | Fields | Meaning |
|---|---|---|
| `step` | `id` (`parse`, `expand`, `screen`, `rank`), `title`, `detail`, `notes`, `unsupported`, `intent` | A stage finished; this is the agent's visible "thinking". |
| `progress` | `done`, `total` | Screening progress. |
| `clarify` | `question`, `intent` | Cannot proceed without the operator (no area, a too-broad lease, a bad polygon, an area too large even at 640 acres). |
| `proposal` | `ranked[]` (rows + `rationale`), `ranked_total`, `unranked`, `tracts[]`, `candidates{}` (every location, compact), `summary[]`, `intent`, `plan`, `data`, `model`, `run` | The result for review. `tests/fixtures/proposal_tracts.json` is a real one, and the TS tests run against it. |
| `error` | `message` | Nothing was saved; retry. |

### Limits and follow-ups

- **Coverage** is the same as Analyze: four counties, single-well-lease horizontals only. Pad-heavy
  areas have thin evidence, and rationales flag it.
- **Lease-name areas** are wellbore hulls. A real lease boundary needs a drawn polygon (or a future
  plat/abstract layer).
- **The parser is grammar-based.** It covers the phrasings in `tests/test_agent_intent.py`, and
  anything else either asks or reports what it did not use. An LLM front-end is a follow-up, with
  the constraints above.
- **Review is limited to the top N (≤ 200).** Every screened location is on the map, but only the
  top N appear in the table.
- **Basemap tiles** come from the same keyless Esri/OSM servers as Analyze.
