"""Screen one candidate location: the agent's unit of work.

This is lib/engine.ts analyze() in prospect mode, run in Python against the same
snapshot, so a location screened by the agent gets the same forecast it gets on the
Analyze page (tests/test_agent_parity.py checks this against analyze() output).
The model features are computed by pipeline/features.offset_features -- the single
definition training uses -- not by a port of it.

Never invents volumes: wells on multi-well leases (RRC reports their production at
lease level) are only ever counted, as coverage gaps. Their volumes are never
read, and they never feed a feature, a median or a forecast.
"""
from __future__ import annotations

import math
import threading
from dataclasses import dataclass, field

import numpy as np

from agent.snapshot import Snapshot
from pipeline.features import COUNTY_CODE, FEATURES, RADIUS_MI, haversine_mi, offset_features

# Mirrors of lib/engine.ts constants (pinned by tests/test_agent_parity.py).
PROSPECT_ASOF = 999912        # prospect: every offset's early window is already known
DEFAULT_VINTAGE = 2025        # latest vintage with full 12-month history in training
SUPPORTED = ("ANDREWS", "ECTOR", "MIDLAND", "MARTIN")
COVERAGE_MI = 5.0             # nearest mapped horizontal farther than this = outside coverage
LOW_OFFSETS = 3               # fewer model offsets than this = low-confidence forecast
LATERAL_RANGE_FT = (4000.0, 15000.0)
MULTI_WELL = 1                # horizontals.json code: multi-well lease, production not allocable


@dataclass(frozen=True)
class Filters:
    """Narrow the offset *evidence* (what is listed and counted), exactly like the
    Analyze page filters. The model forecast always uses every attributable well
    within 3 mi, so filters never change a forecast."""
    min_lat_ft: float | None = None
    max_lat_ft: float | None = None
    operator: str = ""
    min_first_ym: int | None = None   # agent-only: first production on/after (YYYYMM)
    max_first_ym: int | None = None


class TileCache:
    """Which wells and mapped horizontals could be within `reach_mi` of a ~1.4 x 1.2 mi tile.

    Neighbouring candidates share most of their offsets, so each tile's neighbourhood
    is computed once and reused by every candidate inside it: overlapping offset sets
    are never rescanned. One cache per screening run, dropped with the run, so no trace
    of where a user screened outlives it."""

    def __init__(self, snap: Snapshot, reach_mi: float, tile_deg: float = 0.02):
        self.snap, self.reach, self.deg = snap, reach_mi, tile_deg
        self._tiles: dict[tuple[int, int], Tile] = {}
        self._lock = threading.Lock()
        self.hits = self.misses = 0

    def get(self, lat: float, lon: float) -> "Tile":
        key = (math.floor(lat / self.deg), math.floor(lon / self.deg))
        with self._lock:
            t = self._tiles.get(key)
            if t is not None:
                self.hits += 1
                return t
            self.misses += 1
            t = self._tiles[key] = self._build(key)
            return t

    def _build(self, key: tuple[int, int]) -> "Tile":
        s, d = self.snap, self.deg
        # Conservative lat/lon box: haversine distance >= R*|dlat| and >= R*cos(maxlat)*|dlon|.
        dlat = self.reach / 69.0 * 1.02
        lat0, lat1 = key[0] * d - dlat, (key[0] + 1) * d + dlat
        dlon = self.reach / (69.0 * math.cos(math.radians(max(abs(lat0), abs(lat1))))) * 1.02
        lon0, lon1 = key[1] * d - dlon, (key[1] + 1) * d + dlon
        inbox = lambda la, lo: np.flatnonzero((la >= lat0) & (la <= lat1) & (lo >= lon0) & (lo <= lon1))
        p = inbox(s.pool["lat"], s.pool["lon"])
        return Tile(w=inbox(s.lat, s.lon), pool={k: v[p] for k, v in s.pool.items()}, h=inbox(s.h_lat, s.h_lon))


@dataclass(frozen=True)
class Tile:
    w: np.ndarray       # well indices (ascending, like analyze()'s scan order)
    pool: dict          # offset_features pool restricted to the tile neighbourhood
    h: np.ndarray       # horizontal indices


def everything(snap: Snapshot) -> Tile:
    return Tile(w=np.arange(snap.n), pool=snap.pool, h=np.arange(len(snap.h_lat)))


@dataclass
class Screen:
    lat: float
    lon: float
    lateral_ft: float
    radius_mi: float
    county: str
    county_dist_mi: float
    in_coverage: bool
    features: dict
    cum12: dict                 # {"p10","p50","p90"} bbl, first 12 producing months
    eur: dict                   # {"p10","p50","p90"} bbl
    model_offsets: int          # attributable wells with an early fit within 3 mi (= n_off feature)
    offsets: list               # evidence: [(well index, distance mi)] within radius_mi, nearest first
    gaps: dict                  # horizontals.json code -> count within radius_mi (code != 0)
    analog_eur: dict | None
    flags: list = field(default_factory=list)
    multi_well: tuple = ()      # indices of multi-well-lease horizontals within radius_mi (counted, never valued)


def _band(lo: float, mid: float, hi: float) -> dict:
    s = sorted([lo, mid, hi])
    return {"p10": s[0], "p50": min(max(mid, s[0]), s[2]), "p90": s[2]}


def screen_location(snap: Snapshot, lat: float, lon: float, lateral_ft: float, radius_mi: float = RADIUS_MI,
                    flt: Filters = Filters(), tiles: TileCache | None = None) -> Screen:
    tile = tiles.get(lat, lon) if tiles is not None else everything(snap)

    # County = county of the nearest mapped horizontal (analyze()/inferCounty). The tile holds every
    # horizontal within its reach, so a nearest one inside COVERAGE_MI is always found in it.
    dh = haversine_mi(lat, lon, snap.h_lat[tile.h], snap.h_lon[tile.h])
    if len(dh) and np.nanmin(dh, initial=np.inf) <= COVERAGE_MI:
        j = int(np.nanargmin(dh))
        county, cdist = str(snap.h_county[tile.h[j]]), float(dh[j])
    else:
        da = haversine_mi(lat, lon, snap.h_lat, snap.h_lon)
        j = int(np.nanargmin(da))
        county, cdist = str(snap.h_county[j]), float(da[j])
    in_cov = cdist <= COVERAGE_MI and county in SUPPORTED

    # Model: pipeline features (leakage rules included) -> LightGBM P10/P50/P90.
    f = offset_features(lat, lon, PROSPECT_ASOF, tile.pool, radius_mi=RADIUS_MI, lateral_ft=lateral_ft)
    f.update(lateral_proxy_ft=float(lateral_ft), mid_lat=float(lat), mid_lon=float(lon),
             county_code=float(COUNTY_CODE.get(county, np.nan)), vintage_year=float(DEFAULT_VINTAGE))
    raw = snap.forest.predict_raw(np.array([[f[k] for k in FEATURES]], dtype=float))
    p = {k: math.exp(float(v[0])) for k, v in raw.items()}
    n_off = int(f["n_off"])

    # Evidence offsets within the screening radius, with the Analyze filters applied.
    dw = haversine_mi(lat, lon, snap.lat[tile.w], snap.lon[tile.w])
    m = dw <= radius_mi
    w = tile.w
    if flt.min_lat_ft is not None:
        m &= snap.lat_ft[w] >= flt.min_lat_ft
    if flt.max_lat_ft is not None:
        m &= snap.lat_ft[w] <= flt.max_lat_ft
    if flt.operator:
        op = flt.operator.lower()
        m &= np.array([op in o.lower() for o in snap.operator[w]], dtype=bool)
    if flt.min_first_ym is not None:
        m &= snap.first[w] >= flt.min_first_ym
    if flt.max_first_ym is not None:
        m &= snap.first[w] <= flt.max_first_ym
    order = np.argsort(dw[m], kind="stable")
    offsets = [(int(i), float(d)) for i, d in zip(w[m][order], dw[m][order])]

    # Coverage gaps: mapped horizontals in range whose production is not attributable. Counted only.
    gm = (dh <= radius_mi) & (snap.h_code[tile.h] != 0)
    codes, counts = np.unique(snap.h_code[tile.h][gm], return_counts=True)
    gaps = {int(c): int(k) for c, k in zip(codes, counts)}
    multi_well = tuple(int(h) for h in tile.h[gm & (snap.h_code[tile.h] == MULTI_WELL)])

    # Offset-analog EUR: IDW of fitted offsets' EUR per 1,000 ft x lateral (high/medium confidence).
    ws = v = 0.0
    na = 0
    for i, d in offsets:
        if not np.isnan(snap.eur_kft[i]) and snap.conf[i] in ("high", "medium"):
            wt = 1.0 / (d + 0.25) ** 2
            ws, v, na = ws + wt, v + wt * snap.eur_kft[i], na + 1
    analog = {"value": float(v / ws * (lateral_ft / 1000.0)), "n": na} if na else None

    flags = []
    if not in_cov:
        flags.append("outside_coverage")
    if n_off < LOW_OFFSETS:
        flags.append("low_model_offsets")
    if lateral_ft > LATERAL_RANGE_FT[1] or lateral_ft < LATERAL_RANGE_FT[0]:
        flags.append("lateral_outside_training_range")
    if gaps.get(MULTI_WELL, 0) >= 5 and gaps.get(MULTI_WELL, 0) >= 3 * max(1, len(offsets)):
        flags.append("gaps_dominate")
    return Screen(
        lat=float(lat), lon=float(lon), lateral_ft=float(lateral_ft), radius_mi=float(radius_mi),
        county=county, county_dist_mi=cdist, in_coverage=bool(in_cov), features=f,
        cum12=_band(p["cum12_p10"], p["cum12"], p["cum12_p90"]), eur=_band(p["eur_p10"], p["eur"], p["eur_p90"]),
        model_offsets=n_off, offsets=offsets, gaps=gaps, analog_eur=analog, flags=flags, multi_well=multi_well,
    )
