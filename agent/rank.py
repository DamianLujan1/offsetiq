"""Rank screened locations and explain every position.

Order: first-12-month oil P50 (primary), EUR P50 (secondary), offset-data density
(tertiary: attributable wells with an early decline fit within 3 mi -- exactly the
wells that feed the model), then a fixed geographic tie-break (north to south, then
west to east). The order therefore never depends on input order or on which
screening task finished first. Exact ties are common: the model is a tree ensemble,
so neighbouring locations often fall in the same leaves and get identical forecasts.

Two deliberate additions to that order, both about evidence:
  * Not ranked: outside coverage, or no attributable offset within 3 mi. There the
    forecast is pure location-and-lateral extrapolation; ranking it beside
    data-backed locations would present a guess as evidence. Multi-well-lease
    horizontals near them are counted as coverage gaps -- never given volumes.
  * Low-confidence tier: 1-2 offsets within 3 mi (the Analyze page's own
    low-confidence threshold) rank after every location with 3+. Without this,
    sparse areas top the list because the model extrapolates high where it is least
    constrained: in Andrews County 80% of a pure-P50 top 25 rested on <3 offsets.

Rationales are filled from computed numbers only, so they cannot state a number
the screen did not produce.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from statistics import median
from urllib.parse import urlencode

from agent.engine import LOW_OFFSETS, MULTI_WELL, Screen
from agent.snapshot import Snapshot


@dataclass(frozen=True)
class Candidate:
    id: str           # e.g. "T2-r03c07", "MID-r41c12", "P1"
    region: str       # label of the area it came from
    lat: float
    lon: float


def kb(v: float | None) -> str:
    """bbl in thousands, the way the Analyze page prints them (fmtK)."""
    return "n/a" if v is None or not math.isfinite(v) else f"{v / 1000:,.0f}k"


def miles(r: float) -> str:
    return f"{r:g} mile" if r == 1 else f"{r:g} miles"


def plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def not_ranked_reason(s: Screen) -> str | None:
    if not s.in_coverage:
        return "outside_coverage"
    if s.model_offsets == 0:
        return "no_model_offsets"
    return None


def tier(s: Screen) -> int:
    return 0 if s.model_offsets >= LOW_OFFSETS else 1


def sort_key(c: Candidate, s: Screen) -> tuple:
    return (tier(s), -s.cum12["p50"], -s.eur["p50"], -s.model_offsets, -round(c.lat, 9), round(c.lon, 9))


def bbl(a: float, b: float) -> tuple[str, str]:
    """Two volumes for a comparison: in k unless that rounds them equal, then in full."""
    return (kb(a), kb(b)) if kb(a) != kb(b) else (f"{a:,.0f}", f"{b:,.0f}")


def rank(pairs: list[tuple[Candidate, Screen]]):
    """-> (ranked [(cand, screen)] best first, unranked [(cand, screen, reason)])."""
    ranked, unranked = [], []
    for c, s in pairs:
        why = not_ranked_reason(s)
        if why:
            unranked.append((c, s, why))
        else:
            ranked.append((c, s))
    ranked.sort(key=lambda cs: sort_key(*cs))
    unranked.sort(key=lambda x: (x[2], -round(x[0].lat, 9), round(x[0].lon, 9)))
    return ranked, unranked


def evidence(snap: Snapshot, s: Screen) -> dict:
    """Observed facts about the attributable offsets within the screening radius."""
    c12 = [float(snap.cum12[i]) for i, _ in s.offsets if math.isfinite(snap.cum12[i])]
    eur = [float(snap.eur[i]) for i, _ in s.offsets if math.isfinite(snap.eur[i])]
    near = None
    if s.offsets:
        i, d = s.offsets[0]
        near = {"api10": str(snap.api10[i]), "lease": str(snap.lease[i]), "well_no": str(snap.well_no[i]),
                "operator": str(snap.operator[i]), "dist_mi": d}
    return {"radius_mi": s.radius_mi, "n": len(s.offsets), "median_cum12": median(c12) if c12 else None,
            "n_cum12": len(c12), "median_eur": median(eur) if eur else None, "n_eur": len(eur), "nearest": near,
            "apis": [str(snap.api10[i]) for i, _ in s.offsets[:10]]}


def why_above(r: int, s: Screen, nxt: Screen | None) -> str:
    if nxt is None:
        return "Last ranked location."
    a, b = s.cum12["p50"], nxt.cum12["p50"]
    if tier(s) < tier(nxt):
        x, y = bbl(a, b)
        return (f"Ahead of #{r + 1} on evidence: #{r + 1} rests on only {plural(nxt.model_offsets, 'attributable offset')} within "
                f"3 mi (low-confidence tier), so it ranks below every better-supported location"
                + (f" despite a higher 12-mo P50 ({y} vs {x} bbl)." if b > a else "."))
    if a > b:
        x, y = bbl(a, b)
        return f"Ahead of #{r + 1} on 12-mo oil P50 ({x} vs {y} bbl)."
    if s.eur["p50"] > nxt.eur["p50"]:
        x, y = bbl(s.eur["p50"], nxt.eur["p50"])
        return f"Tied with #{r + 1} on 12-mo oil P50 ({a:,.0f} bbl); ahead on EUR P50 ({x} vs {y} bbl)."
    if s.model_offsets > nxt.model_offsets:
        return (f"Tied with #{r + 1} on 12-mo and EUR P50; ahead on offset data "
                f"({s.model_offsets} vs {nxt.model_offsets} wells within 3 mi feeding the model).")
    return f"Same forecast and offset count as #{r + 1}; listed first by position (north to south, then west to east)."


FLAG_TEXT = {
    "low_model_offsets": lambda s, e: (f"Low confidence: the model sees only {plural(s.model_offsets, 'attributable well')} "
                                       "with an early decline fit within 3 mi."),
    "lateral_outside_training_range": lambda s, e: (f"{s.lateral_ft:,.0f} ft lateral is near the edge of the training data "
                                                    "(most wells 7,000-15,000 ft)."),
    "gaps_dominate": lambda s, e: (f"Multi-well-lease horizontals ({s.gaps.get(MULTI_WELL, 0)}) far outnumber attributable "
                                   f"offsets ({e['n']}) within {miles(s.radius_mi)}: this is mostly pad development, so the "
                                   "public evidence is a thin single-well-lease slice of it."),
}


def rationale(r: int, s: Screen, e: dict, nxt: Screen | None) -> dict:
    mw = s.gaps.get(MULTI_WELL, 0)
    other = sum(v for c, v in s.gaps.items() if c != MULTI_WELL)
    evid = (f"{plural(e['n'], 'nearby offset')} within {miles(s.radius_mi)}" if e["n"]
            else f"no attributable offsets within {miles(s.radius_mi)}")
    if e["median_cum12"] is not None:
        evid += f", median 12-mo oil {kb(e['median_cum12'])} bbl"
    headline = (f"Rank #{r}: {evid}, 12-mo oil P50 {kb(s.cum12['p50'])} bbl, EUR P50 {kb(s.eur['p50'])} bbl, "
                f"{mw} multi-well gap{'' if mw == 1 else 's'} excluded.")
    d = [f"Forecast (same LightGBM model as Analyze): first-12-month oil P50 {kb(s.cum12['p50'])} bbl "
         f"(P90-P10 {kb(s.cum12['p90'])}-{kb(s.cum12['p10'])}); EUR P50 {kb(s.eur['p50'])} bbl "
         f"(P90-P10 {kb(s.eur['p90'])}-{kb(s.eur['p10'])}) for a {s.lateral_ft:,.0f} ft lateral. "
         "P90 is the low case, P10 the high case (PRMS)."]
    if e["nearest"]:
        n = e["nearest"]
        line = f"Nearest offset: {n['lease']} {n['well_no']} ({n['operator']}) at {n['dist_mi']:.2f} mi."
        if e["n_cum12"] < e["n"]:
            line += f" {e['n_cum12']} of {e['n']} nearby offsets have 12 producing months."
        if e["median_eur"] is not None:
            line += f" Median Arps EUR of the {e['n_eur']} fitted: {kb(e['median_eur'])} bbl."
        d.append(line)
    else:
        d.append(f"No attributable offsets within {miles(s.radius_mi)}; the forecast rests on wells farther out (up to 3 mi).")
    near = s.features.get("d_nearest_mi")
    d.append(f"Wells feeding the model: {s.model_offsets} attributable with an early decline fit within 3 mi"
             + (f" (nearest {near:.2f} mi)." if near is not None and math.isfinite(near) else "."))
    if mw:
        d.append(f"{plural(mw, 'multi-well-lease horizontal')} within {miles(s.radius_mi)} excluded: the RRC reports their "
                 "production by lease, so no per-well volumes exist and none are assigned.")
    if other:
        d.append(f"{plural(other, 'other mapped horizontal')} within {miles(s.radius_mi)} not used "
                 "(no completion record yet, gas, or no reported oil).")
    if s.analog_eur:
        d.append(f"Cross-check: distance-weighted EUR per 1,000 ft of {plural(s.analog_eur['n'], 'fitted offset')} "
                 f"x lateral = {kb(s.analog_eur['value'])} bbl.")
    d.extend(FLAG_TEXT[f](s, e) for f in s.flags if f in FLAG_TEXT)
    return {"headline": headline, "details": d, "why": why_above(r, s, nxt)}


def row(snap: Snapshot, r: int, c: Candidate, s: Screen, nxt: Screen | None, filters) -> dict:
    e = evidence(snap, s)
    q = {"lat": f"{c.lat:.6f}", "lon": f"{c.lon:.6f}", "lat_ft": str(round(s.lateral_ft)), "r": f"{s.radius_mi:g}"}
    if filters.min_lat_ft is not None:
        q["min"] = str(round(filters.min_lat_ft))
    if filters.max_lat_ft is not None:
        q["max"] = str(round(filters.max_lat_ft))
    if filters.operator:
        q["op"] = filters.operator
    near = s.features.get("d_nearest_mi")
    return {
        "id": c.id, "rank": r, "region": c.region, "lat": c.lat, "lon": c.lon, "county": s.county,
        "tier": "supported" if tier(s) == 0 else "low_confidence",
        "cum12": s.cum12, "eur": s.eur, "model_offsets": s.model_offsets,
        "nearest_model_offset_mi": near if near is not None and math.isfinite(near) else None,
        "evidence": e, "gaps": {"multi_well": s.gaps.get(MULTI_WELL, 0),
                                "other": sum(v for k, v in s.gaps.items() if k != MULTI_WELL)},
        "analog_eur": s.analog_eur, "flags": s.flags, "rationale": rationale(r, s, e, nxt),
        "analyze_url": "/analyze?" + urlencode(q),
    }


def tracts(region_labels: list[str], ranked: list, unranked: list) -> list[dict]:
    """Per-area rollup for 'compare these tracts': ordered by median 12-mo P50 of ranked locations."""
    out = []
    for label in region_labels:
        rk = [(i + 1, c, s) for i, (c, s) in enumerate(ranked) if c.region == label]
        ur = [x for x in unranked if x[0].region == label]
        gaps = {h for _, _, s in rk for h in s.multi_well} | {h for _, s, _ in ur for h in s.multi_well}
        rec = {"region": label, "candidates": len(rk) + len(ur), "ranked": len(rk), "unranked": len(ur),
               "distinct_multi_well_gaps": len(gaps), "best_rank": None, "best_cum12_p50": None,
               "median_cum12_p50": None, "median_eur_p50": None, "median_model_offsets": None}
        if rk:
            rec.update(best_rank=rk[0][0], best_cum12_p50=rk[0][2].cum12["p50"],
                       median_cum12_p50=median(s.cum12["p50"] for _, _, s in rk),
                       median_eur_p50=median(s.eur["p50"] for _, _, s in rk),
                       median_model_offsets=median(s.model_offsets for _, _, s in rk))
        out.append(rec)
    out.sort(key=lambda t: (t["median_cum12_p50"] is None, -(t["median_cum12_p50"] or 0), -(t["best_cum12_p50"] or 0), t["region"]))
    for i, t in enumerate(out):
        if t["ranked"]:
            k1 = lambda v: f"{v / 1000:,.1f}k"  # one decimal: tract medians are often within 1k of each other
            t["rationale"] = (f"#{i + 1} {t['region']}: median 12-mo oil P50 {k1(t['median_cum12_p50'])} bbl across "
                              f"{plural(t['ranked'], 'ranked location')} (best is overall #{t['best_rank']} at "
                              f"{k1(t['best_cum12_p50'])}); median EUR P50 {kb(t['median_eur_p50'])} bbl; median "
                              f"{t['median_model_offsets']:g} wells feeding the model; "
                              f"{plural(t['distinct_multi_well_gaps'], 'multi-well-lease horizontal')} nearby excluded as coverage gaps.")
        else:
            t["rationale"] = (f"#{i + 1} {t['region']}: no rankable locations ({t['candidates']} screened: outside coverage "
                              "or no attributable offsets within 3 mi). Not ranked rather than ranked on extrapolation.")
    return out
