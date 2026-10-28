"""Screening areas and candidate grids.

A candidate is a proposed lateral MIDPOINT -- the point the model forecasts (training
wells are located by mid_lat/mid_lon). "40-acre spacing" means one candidate per
40 acres on a square lattice of 1,320 ft cells: a screening density, not a well plan.

Lattices are laid out on a local equirectangular plane centred on the area (scale
error under 0.3% across a county at 32 deg N); distances reported anywhere else are
haversine, as in pipeline/features.py. Rings are lists of (lat, lon).
"""
from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass
from functools import lru_cache

import numpy as np

R_FT = 3958.7613 * 5280.0          # same sphere as pipeline/features.haversine_mi
ACRE_FT2 = 43560.0
STANDARD_SPACINGS = (10, 20, 40, 80, 160, 320, 640)   # acres
COUNTIES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "counties.geojson")

Ring = list[tuple[float, float]]


class GeoError(ValueError):
    """An area the agent cannot screen; the message is shown to the user as-is."""


def cell_side_ft(acres: float) -> float:
    return math.sqrt(acres * ACRE_FT2)


@dataclass(frozen=True)
class Plane:
    lat0: float
    lon0: float

    @classmethod
    def around(cls, ring: Ring) -> "Plane":
        la, lo = zip(*ring)
        return cls((min(la) + max(la)) / 2, (min(lo) + max(lo)) / 2)

    def xy(self, lat, lon):
        k = math.pi / 180 * R_FT
        return (np.asarray(lon, float) - self.lon0) * k * math.cos(math.radians(self.lat0)), (np.asarray(lat, float) - self.lat0) * k

    def latlon(self, x, y):
        k = math.pi / 180 * R_FT
        return np.asarray(y, float) / k + self.lat0, np.asarray(x, float) / (k * math.cos(math.radians(self.lat0))) + self.lon0


def clean_ring(ring) -> Ring:
    """Validate a user/LLM/UI supplied polygon: finite coordinates, >= 3 distinct vertices,
    non-zero area, edges that do not cross. Accepts open or closed rings, either winding."""
    pts: Ring = []
    for p in ring:
        try:
            lat, lon = float(p[0]), float(p[1])
        except (TypeError, ValueError, IndexError):
            raise GeoError("polygon corners must be (lat, lon) number pairs.") from None
        if not (math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180):
            raise GeoError(f"corner ({lat}, {lon}) is not a valid latitude/longitude.")
        if not pts or (lat, lon) != pts[-1]:
            pts.append((lat, lon))
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    if len(pts) < 3:
        raise GeoError("a polygon needs at least 3 distinct corners.")
    x, y = Plane.around(pts).xy(*zip(*pts))
    n = len(pts)
    for i in range(n):
        for k in range(i + 1, n):
            if k == i + 1 or (i == 0 and k == n - 1):
                continue  # adjacent edges share a vertex
            if _segments_cross((x[i], y[i]), (x[(i + 1) % n], y[(i + 1) % n]), (x[k], y[k]), (x[(k + 1) % n], y[(k + 1) % n])):
                raise GeoError("its edges cross each other; draw the corners in order around the boundary.")
    if ring_area_acres(pts) < 1.0:
        raise GeoError("the polygon has (almost) no area.")
    return pts


def _segments_cross(a, b, c, d) -> bool:
    o = lambda p, q, r: (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    o1, o2, o3, o4 = o(a, b, c), o(a, b, d), o(c, d, a), o(c, d, b)
    return (o1 > 0) != (o2 > 0) and (o3 > 0) != (o4 > 0) and 0 not in (o1, o2, o3, o4)


def ring_area_acres(ring: Ring) -> float:
    x, y = Plane.around(ring).xy(*zip(*ring))
    return abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))) / 2 / ACRE_FT2


def points_in_ring(px: np.ndarray, py: np.ndarray, rx: np.ndarray, ry: np.ndarray) -> np.ndarray:
    """Even-odd ray casting, vectorized over points."""
    inside = np.zeros(np.shape(px), dtype=bool)
    for i in range(len(rx)):
        x1, y1, x2, y2 = rx[i], ry[i], rx[i - 1], ry[i - 1]
        if y1 == y2:
            continue
        cross = (y1 > py) != (y2 > py)
        xint = x1 + (py - y1) * (x2 - x1) / (y2 - y1)
        inside ^= cross & (px < xint)
    return inside


@dataclass(frozen=True)
class GridPoint:
    lat: float
    lon: float
    row: int        # from the south edge of the area's bounding box
    col: int        # from the west edge


def grid(ring: Ring, spacing_acres: float) -> list[GridPoint]:
    """Cell centres of a square lattice (side = sqrt(spacing acres)) anchored at the area's
    south-west bounding-box corner, kept if strictly inside the polygon. An area smaller
    than one cell yields one interior point, so every area is screened at least once."""
    plane = Plane.around(ring)
    rx, ry = plane.xy(*zip(*ring))
    s = cell_side_ft(spacing_acres)
    nx = int(math.floor((rx.max() - rx.min()) / s)) + 1
    ny = int(math.floor((ry.max() - ry.min()) / s)) + 1
    cols, rows = np.meshgrid(np.arange(nx), np.arange(ny))
    gx, gy = rx.min() + s / 2 + cols * s, ry.min() + s / 2 + rows * s
    m = points_in_ring(gx, gy, rx, ry)
    if not m.any():
        x, y = _interior_point(rx, ry)
        la, lo = plane.latlon(x, y)
        return [GridPoint(float(la), float(lo), 0, 0)]
    la, lo = plane.latlon(gx[m], gy[m])
    return [GridPoint(float(a), float(b), int(r), int(c)) for a, b, r, c in zip(la, lo, rows[m], cols[m])]


def _interior_point(rx: np.ndarray, ry: np.ndarray) -> tuple[float, float]:
    a = rx * np.roll(ry, -1) - np.roll(rx, -1) * ry
    area = a.sum() / 2
    cx = float(((rx + np.roll(rx, -1)) * a).sum() / (6 * area))
    cy = float(((ry + np.roll(ry, -1)) * a).sum() / (6 * area))
    if points_in_ring(np.array([cx]), np.array([cy]), rx, ry)[0]:
        return cx, cy
    # Concave sliver: widest inside span of the horizontal line through the centroid.
    xs = sorted(rx[i] + (cy - ry[i]) * (rx[i - 1] - rx[i]) / (ry[i - 1] - ry[i])
                for i in range(len(rx)) if (ry[i] > cy) != (ry[i - 1] > cy))
    spans = [(xs[k + 1] - xs[k], (xs[k] + xs[k + 1]) / 2) for k in range(0, len(xs) - 1, 2)]
    return max(spans)[1], cy


def buffered_hull(points: list[tuple[float, float]], buffer_ft: float) -> Ring:
    """Convex hull of points grown by ~buffer_ft (each point replaced by an octagon).
    Used for lease-name areas: the RRC publishes no lease boundaries."""
    plane = Plane.around(points)
    x, y = plane.xy(*zip(*points))
    ang = np.arange(8) * np.pi / 4
    bx = (x[:, None] + buffer_ft * np.cos(ang)).ravel()
    by = (y[:, None] + buffer_ft * np.sin(ang)).ravel()
    hx, hy = _hull(bx, by)
    la, lo = plane.latlon(hx, hy)
    return [(float(a), float(b)) for a, b in zip(la, lo)]


def _hull(x: np.ndarray, y: np.ndarray):
    pts = sorted(set(zip(x.round(3).tolist(), y.round(3).tolist())))
    cross = lambda o, a, b: (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    h = lower[:-1] + upper[:-1]
    return np.array([p[0] for p in h]), np.array([p[1] for p in h])


@lru_cache(maxsize=1)
def counties() -> dict[str, Ring]:
    """County boundary rings (lat, lon) for the four v1 counties."""
    with open(COUNTIES_FILE) as fh:
        fc = json.load(fh)
    return {f["properties"]["county"]: [(lat, lon) for lon, lat in f["geometry"]["coordinates"][0][:-1]]
            for f in fc["features"]}  # GeoJSON rings repeat the first vertex at the end
