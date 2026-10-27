"""The screening agent loop: prompt -> parse -> lay out candidates -> screen in parallel
-> rank -> explained proposal.

run() is an async generator of events, so the UI can show the agent's work as it
happens:
  {"type": "step", "id", "title", "detail", ...}   a stage finished
  {"type": "progress", "done", "total"}             screening progress
  {"type": "clarify", "question", "intent"}         cannot proceed without the operator
  {"type": "proposal", ...}                         ranked, explained locations for review
  {"type": "error", "message"}

Parallelism. Screening a location is CPU-bound numpy/Python work on the in-memory
snapshot (there is no per-location RRC fetch), so threads only contend for the GIL:
measured on Midland County, 10 threads ran 3x slower than one. Candidates are
therefore screened in small, geographically coherent batches on a pool of worker
processes, and an asyncio.Semaphore bounds how many batches a run has in flight
(back-pressure, and fairness between concurrent runs sharing the pool).

The agent proposes; it never exports, saves or acts. Export happens in the browser
after the operator approves. Nothing about a request is written anywhere: the prompt,
the areas and the results live in this generator; worker processes keep only the
public snapshot, and each batch's tile cache is dropped when the batch returns.
"""
from __future__ import annotations

import asyncio
import math
import multiprocessing
import os
import threading
import time
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool

from agent import geo
from agent.engine import COVERAGE_MI, Filters, TileCache, screen_location
from agent.intent import Intent, parse
from agent.rank import Candidate, kb, miles, plural, rank, row, tracts
from agent.snapshot import load_snapshot

MAX_IN_FLIGHT = 10         # batches a run may have submitted at once
BATCH = 32                 # neighbouring candidates per batch (they share tile lookups)
MAX_CANDIDATES = 8000      # per run; larger areas are screened at a coarser, stated spacing
PREFIX = {"polygon": "T", "lease": "L", "point": "P"}


class TooLarge(Exception):
    pass


# ---- worker pool -----------------------------------------------------------------------------------
def default_workers() -> int:
    env = os.environ.get("OFFSETIQ_AGENT_WORKERS")
    return int(env) if env else min(8, os.cpu_count() or 1)


_pool: ProcessPoolExecutor | None = None
_pool_size = 0
_pool_unavailable = False   # this platform cannot run worker processes (e.g. no POSIX semaphores)
_pool_lock = threading.Lock()


def worker_pool(workers: int) -> ProcessPoolExecutor | None:
    """Shared process pool (None = screen in-process). Workers load the public snapshot once.
    Serverless sandboxes often cannot create one; screening then runs in-process instead of failing."""
    global _pool, _pool_size, _pool_unavailable
    if workers <= 1 or _pool_unavailable:
        return None
    with _pool_lock:
        if _pool is None:
            try:
                _pool = ProcessPoolExecutor(max_workers=workers, mp_context=multiprocessing.get_context("spawn"),
                                            initializer=load_snapshot)
            except (OSError, ImportError, NotImplementedError):
                _pool_unavailable = True
                return None
            _pool_size = workers
        return _pool


def shutdown_pool(unavailable: bool = False) -> None:
    global _pool, _pool_unavailable
    with _pool_lock:
        if _pool is not None:
            _pool.shutdown(wait=False, cancel_futures=True)
            _pool = None
        _pool_unavailable = _pool_unavailable or unavailable


def screen_batch(points: list[tuple[float, float]], lateral_ft: float, radius_mi: float, flt: Filters,
                 reach_mi: float) -> tuple[list, int, int]:
    """Worker entry point: screen neighbouring locations, sharing one batch-local tile cache."""
    snap = load_snapshot()
    tiles = TileCache(snap, reach_mi=reach_mi)
    return [screen_location(snap, la, lo, lateral_ft, radius_mi, flt, tiles) for la, lo in points], tiles.misses, tiles.hits


# ---- planning ----------------------------------------------------------------------------------------
def lay_out(intent: Intent, spacing: float) -> list[Candidate]:
    out, k = [], {"polygon": 0, "lease": 0, "point": 0}
    for r in intent.regions:
        if r.kind == "point":
            k["point"] += 1
            out.append(Candidate(id=f"P{k['point']}", region=r.label, lat=r.point[0], lon=r.point[1]))
            continue
        if r.kind == "county":
            pre = r.label[:3].upper()
        else:
            k[r.kind] += 1
            pre = f"{PREFIX[r.kind]}{k[r.kind]}"
        out.extend(Candidate(id=f"{pre}-r{g.row}c{g.col}", region=r.label, lat=g.lat, lon=g.lon)
                   for g in geo.grid(list(r.ring), spacing))
    return out


def expand(intent: Intent) -> tuple[list[Candidate], float, list[str]]:
    """Candidates at the requested spacing, coarsened step by step (and said so) if over the cap."""
    spacing, notes = intent.spacing_acres, []
    cands = lay_out(intent, spacing)
    first = len(cands)
    for s in [s for s in geo.STANDARD_SPACINGS if s > spacing]:
        if len(cands) <= MAX_CANDIDATES:
            break
        spacing, cands = s, lay_out(intent, s)
    if len(cands) > MAX_CANDIDATES:
        raise TooLarge(f"Even at {spacing:g}-acre spacing this area needs {len(cands):,} locations (cap {MAX_CANDIDATES:,}). "
                       "Name fewer counties or draw a smaller area.")
    if spacing != intent.spacing_acres:
        notes.append(f"{intent.spacing_acres:g}-acre spacing over this area would be {first:,} locations; runs are capped at "
                     f"{MAX_CANDIDATES:,}, so this one used {spacing:g}-acre spacing. Draw a smaller area to screen at "
                     f"{intent.spacing_acres:g}-acre.")
    return cands, spacing, notes


def describe(intent: Intent) -> str:
    verb = {"rank": "Rank", "screen": "Screen", "compare": "Compare"}[intent.action]
    labels = [r.label for r in intent.regions]
    if not labels or intent.clarify:
        return "Could not identify an area to screen yet."
    where = ", ".join(labels[:4]) + (f" and {len(labels) - 4} more" if len(labels) > 4 else "")
    n_areas = sum(r.kind != "point" for r in intent.regions)
    what = (f"{intent.spacing_acres:g}-acre-spaced candidate locations in {where}" if n_areas == len(labels)
            else f"{plural(len(labels), 'location')} ({where})" if n_areas == 0 else f"locations in {where}")
    return (f"{verb} {what} for {intent.lateral_ft:,.0f} ft laterals. Rank by first-12-month oil P50, then EUR P50, then "
            f"offset density; describe evidence within {miles(intent.radius_mi)}; show the top {intent.top_n}.")


def _clean(o):
    """JSON-safe: non-finite floats become null (never a fake number)."""
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    return o


# ---- the loop ----------------------------------------------------------------------------------------------
async def run(prompt: str, context: dict | None = None, *, workers: int | None = None, max_in_flight: int = MAX_IN_FLIGHT,
              snap=None, probe: dict | None = None):
    t0 = time.perf_counter()
    snap = snap or load_snapshot()
    intent = parse(prompt, context, snap)
    ij = intent.to_json()
    yield _clean({"type": "step", "id": "parse", "title": "Read the request", "detail": describe(intent),
                  "notes": intent.notes, "unsupported": intent.unsupported, "intent": ij})
    if intent.clarify:
        yield {"type": "clarify", "question": intent.clarify, "intent": ij}
        return
    try:
        cands, spacing, notes = expand(intent)
    except TooLarge as e:
        yield {"type": "clarify", "question": str(e), "intent": ij}
        return
    per_region = [{"label": r.label, "kind": r.kind, "candidates": sum(c.region == r.label for c in cands), "detail": r.detail}
                  for r in intent.regions]
    yield {"type": "step", "id": "expand", "title": f"Laid out {plural(len(cands), 'candidate location')}",
           "detail": (f"{spacing:g}-acre lattice (cells {geo.cell_side_ft(spacing):,.0f} ft on a side), one candidate lateral "
                      f"midpoint per cell. " if any(r.kind != "point" for r in intent.regions) else "")
                     + "; ".join(f"{p['label']}: {p['candidates']:,}" for p in per_region),
           "notes": notes, "regions": per_region, "spacing_acres": spacing}

    # ---- screen: neighbouring locations batched together, bounded batches in flight -------------------
    keys: dict[tuple[float, float], int] = {}
    slot = [keys.setdefault((round(c.lat, 7), round(c.lon, 7)), len(keys)) for c in cands]
    pts = list(keys)
    order = sorted(range(len(pts)), key=lambda i: (math.floor(pts[i][0] / 0.02), math.floor(pts[i][1] / 0.02), i))
    batches = [order[i:i + BATCH] for i in range(0, len(order), BATCH)]
    results: list = [None] * len(pts)
    reach = max(COVERAGE_MI, intent.radius_mi)
    pool = worker_pool(default_workers() if workers is None else workers)
    loop = asyncio.get_running_loop()
    sem = asyncio.Semaphore(max_in_flight)
    gauge = {"now": 0, "peak": 0, "tiles": 0, "reuse": 0}

    async def one(b: list[int], ex: ProcessPoolExecutor | None) -> int:
        async with sem:
            gauge["now"] += 1
            gauge["peak"] = max(gauge["peak"], gauge["now"])
            try:
                args = ([pts[i] for i in b], intent.lateral_ft, intent.radius_mi, intent.filters, reach)
                out, tl, th = (await loop.run_in_executor(ex, screen_batch, *args)) if ex else screen_batch(*args)
            finally:
                gauge["now"] -= 1
            for i, s in zip(b, out):
                results[i] = s
            gauge["tiles"] += tl
            gauge["reuse"] += th
            return len(b)

    t1 = time.perf_counter()
    fallback = ""
    for ex in ([pool, None] if pool else [None]):
        nworkers = _pool_size if ex else 1  # what actually ran: the shared pool keeps the size it was created with
        tasks = [asyncio.create_task(one(b, ex)) for b in batches]
        try:
            done, last = 0, 0.0
            for fut in asyncio.as_completed(tasks):
                done += await fut
                now = time.perf_counter()
                if done == len(pts) or now - last > 0.2:
                    last = now
                    yield {"type": "progress", "done": done, "total": len(pts)}
            break
        except BrokenProcessPool:  # workers cannot run here; screen this run (and later ones) in-process
            shutdown_pool(unavailable=True)
            fallback = " Worker processes were unavailable, so this run screened in-process."
        finally:
            for t in tasks:
                t.cancel()
    screen_s = time.perf_counter() - t1
    if probe is not None:
        probe.update(peak_in_flight=gauge["peak"], unique=len(pts), batches=len(batches), workers=nworkers)
    yield {"type": "step", "id": "screen", "title": f"Screened {plural(len(pts), 'location')} in {screen_s:.1f} s",
           "detail": (f"{len(batches):,} batch{'' if len(batches) == 1 else 'es'} of up to {BATCH} neighbouring locations on "
                      f"{plural(nworkers, 'worker process')}, at most {max_in_flight} batches in flight. Offsets come "
                      f"from the public RRC snapshot already in memory, so nothing is refetched; each ~1 mi tile's neighbourhood "
                      f"was looked up {gauge['tiles']:,} times and reused {gauge['reuse']:,} times by neighbouring candidates."
                      + (f" {len(cands) - len(pts):,} duplicate locations screened once." if len(cands) > len(pts) else "")
                      + fallback)}

    # ---- rank & explain ------------------------------------------------------------------------------------
    pairs = [(c, results[slot[i]]) for i, c in enumerate(cands)]
    ranked, unranked = rank(pairs)
    top = ranked[:intent.top_n]
    rows = [row(snap, i + 1, c, s, ranked[i + 1][1] if i + 1 < len(ranked) else None, intent.filters)
            for i, (c, s) in enumerate(top)]
    n_out = sum(r == "outside_coverage" for _, _, r in unranked)
    n_none = sum(r == "no_model_offsets" for _, _, r in unranked)
    n_low = sum(1 for _, s in ranked if s.model_offsets < 3)
    gaps_none = len({h for _, s, r in unranked if r == "no_model_offsets" for h in s.multi_well})
    rank_notes = []
    if n_low:
        rank_notes.append(f"{plural(n_low, 'location')} rest on only 1-2 attributable offsets within 3 mi: ranked after every "
                          "better-supported location (low-confidence tier), even where their P50 is higher.")
    if n_none:
        rank_notes.append(f"{plural(n_none, 'location')} not ranked: no attributable offsets within 3 mi, so any forecast there "
                          f"would be extrapolation"
                          + (f" ({plural(gaps_none, 'multi-well-lease horizontal')} near them are coverage gaps, not data)." if gaps_none else "."))
    if n_out:
        rank_notes.append(f"{plural(n_out, 'location')} not ranked: outside OffsetIQ coverage (Andrews, Ector, Midland, Martin; "
                          f"nearest mapped horizontal more than {COVERAGE_MI:g} mi away).")
    yield {"type": "step", "id": "rank", "title": f"Ranked {len(ranked):,} of {len(cands):,} locations",
           "detail": ("Locations with 3+ attributable offsets within 3 mi first, then 1-2; within each, by first-12-month oil "
                      "P50, then EUR P50, then offset density (wells feeding the model), then position."),
           "notes": rank_notes}

    summary = list(rank_notes)
    ape = snap.meta["model"]["targets"]["cum12"]["lightgbm_holdout"]["median_ape"]
    if len(top) >= 2:
        hi, lo = max(s.cum12["p50"] for _, s in top), min(s.cum12["p50"] for _, s in top)
        ties = sum(1 for (_, a), (_, b) in zip(top, top[1:]) if a.cum12["p50"] == b.cum12["p50"])
        summary.append(f"The top {len(top)} span 12-mo oil P50 {kb(hi)} to {kb(lo)} bbl ({(hi - lo) / hi * 100:.0f}% apart). The "
                       f"model's median error on held-out 2022+ wells is {ape * 100:.0f}%, so neighbouring ranks are not "
                       "meaningfully different: use the list to find areas worth an engineer's look, and the rationales to see why.")
        if ties:
            summary.append(f"{plural(ties, 'adjacent pair')} in the top {len(top)} have identical 12-mo forecasts (tree model: "
                           "nearby points land in the same leaves); those are ordered by EUR P50, then offset density, then position.")
    if not ranked:
        summary.append("No location could be ranked. Try an area with attributable single-well-lease offsets nearby "
                       "(the coverage-gap layer on the map shows where public data is thin).")
    labels = [r.label for r in intent.regions]
    multi = sum(r.kind != "point" for r in intent.regions) >= 2
    status = {id(c): ("ranked", i + 1) for i, (c, _) in enumerate(ranked)}
    status.update({id(c): (why, None) for c, _, why in unranked})
    cl = {"id": [], "lat": [], "lon": [], "region": [], "p50": [], "rank": [], "status": []}
    for c, s in pairs:
        st, rk = status[id(c)]
        cl["id"].append(c.id)
        cl["lat"].append(round(c.lat, 6))
        cl["lon"].append(round(c.lon, 6))
        cl["region"].append(labels.index(c.region))
        cl["p50"].append(round(s.cum12["p50"]) if st == "ranked" else None)  # no number shown for unranked spots
        cl["rank"].append(rk)
        cl["status"].append(st)
    meta = snap.meta
    yield _clean({
        "type": "proposal", "prompt": intent.prompt, "intent": ij, "plan": {"spacing_acres": spacing, "regions": per_region},
        "ranked": rows, "ranked_total": len(ranked),
        "unranked": {"outside_coverage": n_out, "no_model_offsets": n_none, "low_confidence_ranked": n_low},
        "tracts": tracts(labels, ranked, unranked) if multi else [],
        "candidates": cl, "summary": summary,
        "model": {"cum12_median_ape": ape, "eur_median_ape": meta["model"]["targets"]["eur"]["lightgbm_holdout"]["median_ape"]},
        "data": {"pdq_dump_date": meta["pdq_dump_date"], "last_complete_month": meta["last_complete_month"],
                 "source": "Texas Railroad Commission public data (PDQ dump + well layers)"},
        "run": {"ms": round((time.perf_counter() - t0) * 1000), "screen_ms": round(screen_s * 1000),
                "workers": nworkers, "max_in_flight": max_in_flight, "batches": len(batches),
                "candidates": len(cands), "unique_locations": len(pts), "tile_lookups": gauge["tiles"],
                "tile_reuses": gauge["reuse"]},
    })
