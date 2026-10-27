"""Candidate grids and screening areas (agent/geo.py)."""
import math

import numpy as np
import pytest

from agent import geo
from agent.snapshot import load_snapshot
from pipeline.features import haversine_mi

FT_PER_MI = 5280.0


def square(lat0=31.9, lon0=-102.1, side_ft=5280.0):
    """An exact side x side square (default 1 sq mi = 640 acres) built on the grid's own plane."""
    pl = geo.Plane(lat0, lon0)
    h = side_ft / 2
    la, lo = pl.latlon([-h, h, h, -h], [-h, -h, h, h])
    return [(float(a), float(b)) for a, b in zip(la, lo)]


@pytest.mark.parametrize("acres,expected", [(40, 16), (80, 9), (160, 4), (640, 1)])
def test_known_square_section(acres, expected):
    sq = square()
    assert geo.ring_area_acres(sq) == pytest.approx(640.0, rel=1e-9)
    g = geo.grid(sq, acres)
    assert len(g) == expected
    pl = geo.Plane.around(sq)
    rx, ry = pl.xy(*zip(*sq))
    gx, gy = pl.xy([p.lat for p in g], [p.lon for p in g])
    assert geo.points_in_ring(gx, gy, rx, ry).all()
    assert len({(p.row, p.col) for p in g}) == expected


def test_40_acre_lattice_geometry():
    """16 cell centres, 1,320 ft apart, 660 ft in from every edge of the section."""
    sq = square()
    g = {(p.row, p.col): p for p in geo.grid(sq, 40)}
    assert sorted(g) == [(r, c) for r in range(4) for c in range(4)]
    side = geo.cell_side_ft(40)
    assert side == pytest.approx(1320.0)
    for (r, c), p in g.items():
        if (r, c + 1) in g:
            assert haversine_mi(p.lat, p.lon, g[r, c + 1].lat, g[r, c + 1].lon) * FT_PER_MI == pytest.approx(side, rel=1e-3)
        if (r + 1, c) in g:
            assert haversine_mi(p.lat, p.lon, g[r + 1, c].lat, g[r + 1, c].lon) * FT_PER_MI == pytest.approx(side, rel=1e-3)
    sw = g[0, 0]
    assert haversine_mi(sq[0][0], sw.lon, sw.lat, sw.lon) * FT_PER_MI == pytest.approx(660.0, rel=1e-3)   # from south edge
    assert haversine_mi(sw.lat, sq[0][1], sw.lat, sw.lon) * FT_PER_MI == pytest.approx(660.0, rel=1e-3)   # from west edge


def test_grid_ignores_winding_start_vertex_and_closing_vertex():
    sq = square()
    ref = [(p.lat, p.lon) for p in geo.grid(sq, 40)]
    for ring in (sq[::-1], sq[2:] + sq[:2], sq + [sq[0]]):
        assert [(p.lat, p.lon) for p in geo.grid(geo.clean_ring(ring), 40)] == ref


def test_concave_polygon_excludes_the_notch():
    """2 x 2 mi square minus its north-east quarter: 3 sq mi -> 48 cells of 40 acres, none in the notch."""
    pl = geo.Plane(31.9, -102.1)
    m = FT_PER_MI
    xs, ys = [-m, m, m, 0, 0, -m], [-m, -m, 0, 0, m, m]
    la, lo = pl.latlon(xs, ys)
    ell = list(zip(la.tolist(), lo.tolist()))
    assert geo.ring_area_acres(ell) == pytest.approx(3 * 640, rel=1e-9)
    g = geo.grid(ell, 40)
    assert len(g) == 48
    gx, gy = pl.xy([p.lat for p in g], [p.lon for p in g])
    assert not ((gx > 0) & (gy > 0)).any()


def test_area_smaller_than_one_cell_still_gets_one_interior_point():
    tiny = square(side_ft=600)  # ~8 acres
    g = geo.grid(tiny, 40)
    assert len(g) == 1
    pl = geo.Plane.around(tiny)
    rx, ry = pl.xy(*zip(*tiny))
    assert geo.points_in_ring(*pl.xy([g[0].lat], [g[0].lon]), rx, ry)[0]


def test_sliver_falls_back_to_widest_interior_span():
    # A thin U shape whose centroid lies outside it.
    pl = geo.Plane(31.9, -102.1)
    xs = [-1000, 1000, 1000, 900, 900, -900, -900, -1000]
    ys = [0, 0, 1000, 1000, 100, 100, 1000, 1000]
    la, lo = pl.latlon(xs, ys)
    u = list(zip(la.tolist(), lo.tolist()))
    g = geo.grid(u, 640)
    assert len(g) == 1
    rx, ry = pl.xy(*zip(*u))
    assert geo.points_in_ring(*pl.xy([g[0].lat], [g[0].lon]), rx, ry)[0]


@pytest.mark.parametrize("ring,msg", [
    ([(31.9, -102.1), (31.95, -102.0), (31.95, -102.1), (31.9, -102.0)], "cross"),     # bow-tie
    ([(31.9, -102.1), (31.95, -102.0)], "at least 3"),
    ([(31.9, -102.1), (float("nan"), -102.0), (31.95, -102.1)], "not a valid"),
    ([(131.9, -102.1), (31.95, -102.0), (31.95, -102.1)], "not a valid"),
    ([(31.9, -102.1), (31.9, -102.1), (31.9, -102.1000001)], "at least 3|no area"),
    ([("a", 1), (2, 3), (4, 5)], "number pairs"),
])
def test_invalid_polygons_are_rejected_with_a_reason(ring, msg):
    with pytest.raises(geo.GeoError, match=msg):
        geo.clean_ring(ring)


def test_buffered_hull_of_one_wellbore_contains_it():
    shl, bhl = (31.90, -102.10), (31.93, -102.10)  # ~2 mi N-S lateral
    ring = geo.buffered_hull([shl, bhl], 1320)
    pl = geo.Plane.around(ring)
    rx, ry = pl.xy(*zip(*ring))
    assert geo.points_in_ring(*pl.xy([shl[0], bhl[0], 31.915], [shl[1], bhl[1], -102.1]), rx, ry).all()
    length_ft = haversine_mi(*shl, *bhl) * FT_PER_MI
    approx = (length_ft * 2 * 1320 + math.pi * 1320 ** 2) / 43560  # stadium area
    assert geo.ring_area_acres(ring) == pytest.approx(approx, rel=0.05)


def test_county_polygons_match_census_and_rrc():
    C = geo.counties()
    assert set(C) == {"ANDREWS", "ECTOR", "MIDLAND", "MARTIN"}
    land = {"ANDREWS": 1500.713, "ECTOR": 897.687, "MIDLAND": 900.299, "MARTIN": 914.944}  # Census land sq mi
    for c, ring in C.items():
        assert geo.ring_area_acres(ring) / 640 == pytest.approx(land[c], rel=0.01), c  # polygon includes water
    # Independent check: the RRC well layer's county for each attributable well's surface location.
    s = load_snapshot()
    inside = {c: geo.Plane.around(r) for c, r in C.items()}
    hits = 0
    for c, pl in inside.items():
        rx, ry = pl.xy(*zip(*C[c]))
        m = s.county == c
        hits += int(geo.points_in_ring(*pl.xy(s.slat[m], s.slon[m]), rx, ry).sum())
    assert hits / s.n >= 0.999


def test_county_grid_density_matches_spacing():
    ring = geo.counties()["MIDLAND"]
    acres = geo.ring_area_acres(ring)
    for spacing in (80, 160):
        assert len(geo.grid(ring, spacing)) == pytest.approx(acres / spacing, rel=0.01)
    assert np.isfinite([p.lat for p in geo.grid(ring, 160)]).all()
