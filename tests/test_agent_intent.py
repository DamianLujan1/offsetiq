"""Intent parsing (agent/intent.py): varied phrasings -> explicit, auditable parameters."""
import pytest

from agent.intent import DEFAULT_LATERAL_FT, DEFAULT_RADIUS_MI, DEFAULT_SPACING_ACRES, DEFAULT_TOP_N, parse
from agent.snapshot import load_snapshot

SQ = [[31.90, -102.10], [31.90, -102.08], [31.915, -102.08], [31.915, -102.10]]
SQ2 = [[31.95, -102.05], [31.95, -102.03], [31.965, -102.03], [31.965, -102.05]]
SQ3 = [[32.20, -101.90], [32.20, -101.88], [32.215, -101.88], [32.215, -101.90]]
ONE = {"polygons": [{"label": "Tract 1", "ring": SQ}]}
THREE = {"polygons": [{"label": "Tract 1", "ring": SQ}, {"label": "Tract 2", "ring": SQ2}, {"label": "Tract 3", "ring": SQ3}]}
PINS = {"points": [{"label": "Pin A", "lat": 31.9, "lon": -102.1}, {"label": "Pin B", "lat": 32.3, "lon": -101.9}]}


@pytest.fixture(scope="module")
def snap():
    return load_snapshot()


def P(prompt, ctx=None, snap=None):
    return parse(prompt, ctx, snap or load_snapshot())


def areas(it):
    return [(r.kind, r.label) for r in it.regions]


# ---- the three prompts from the brief, plus paraphrases ---------------------------------------------
@pytest.mark.parametrize("prompt", [
    "screen every location in this lease block",
    "Screen every spot in the lease block I drew",
    "evaluate all locations inside this block",
    "what's in this polygon?",
    "screen my acreage",
    "run the selected area",
])
def test_lease_block_binds_to_the_drawn_shape(prompt):
    it = P(prompt, ONE)
    assert it.clarify is None
    assert areas(it) == [("polygon", "Tract 1")]
    assert it.regions[0].source == "drawn"


@pytest.mark.parametrize("prompt", [
    "rank the best spots in Midland County",
    "Rank the best locations in midland co.",
    "where should I drill in Midland?",
    "top spots, Midland county",
    "MIDLAND COUNTY - best 25 locations",
])
def test_county(prompt):
    it = P(prompt)
    assert it.clarify is None
    assert areas(it) == [("county", "Midland County")]
    assert it.action == "rank"
    assert len(it.regions[0].ring) >= 4


@pytest.mark.parametrize("prompt", [
    "compare these three tracts",
    "Compare these 3 tracts",
    "which tract is best? compare the tracts I drew",
    "tracts side by side",
    "these three tracts: which one wins?",
])
def test_compare_tracts(prompt):
    it = P(prompt, THREE)
    assert it.clarify is None
    assert [r.label for r in it.regions] == ["Tract 1", "Tract 2", "Tract 3"]
    assert it.action == "compare"


def test_compare_count_mismatch_is_noted_not_guessed():
    it = P("compare these three tracts", {"polygons": THREE["polygons"][:2]})
    assert len(it.regions) == 2
    assert any("You mentioned 3; 2 are drawn" in n for n in it.notes)


def test_reference_without_drawing_asks_instead_of_guessing():
    it = P("screen every location in this lease block")
    assert it.regions == [] and "nothing is drawn" in it.clarify


@pytest.mark.parametrize("prompt", ["hello", "rank the best spots", "go", "what can you do?"])
def test_no_area_asks_a_question(prompt):
    it = P(prompt)
    assert it.regions == [] and it.clarify.startswith("Which area")


# ---- coordinates --------------------------------------------------------------------------------------
@pytest.mark.parametrize("prompt", [
    "screen 31.95,-102.05 and 31.90, -102.10",
    "screen (31.95, -102.05); (31.90, -102.10)",
    "screen 31.95 -102.05 31.90 -102.10",
    "lat 31.95 lon -102.05 and lat 31.90 lon -102.10",
    "screen 31.95N 102.05W and 31.90N 102.10W",
    "screen 31.95, 102.05 and 31.90, 102.10",            # west assumed (Texas), and said so
    "screen -102.05, 31.95 and -102.10, 31.90",           # lon, lat order fixed, and said so
])
def test_points(prompt):
    it = P(prompt)
    assert [r.point for r in it.regions] == [(31.95, -102.05), (31.90, -102.10)]
    assert all(r.kind == "point" for r in it.regions)


def test_typed_polygon_box_and_bad_polygons():
    it = P("screen polygon 31.9 -102.1, 31.95 -102.1, 31.95 -102.0, 31.9 -102.0 at 160-acre spacing")
    assert areas(it) == [("polygon", "Polygon")] and it.spacing_acres == 160
    it = P("box 31.80,-102.20 to 31.85,-102.15")
    assert areas(it) == [("polygon", "Box")] and len(it.regions[0].ring) == 4
    assert "at least 3 corners" in P("polygon 31.9 -102.1, 31.95 -102.1").clarify
    assert "edges cross" in P("polygon 31.9 -102.1, 31.95 -102.0, 31.95 -102.1, 31.9 -102.0").clarify
    two = P("tract A: polygon 31.9 -102.1, 31.95 -102.1, 31.95 -102.0\ntract B: polygon 32.0 -102.1, 32.05 -102.1, 32.05 -102.0")
    assert [r.label for r in two.regions] == ["Tract 1", "Tract 2"]


def test_typed_coordinates_win_over_drawn_shapes():
    it = P("screen 31.95,-102.05", ONE)
    assert areas(it) == [("point", "Point 1")]
    assert any("coordinates in your message" in n for n in it.notes)


def test_named_county_wins_over_an_unreferenced_drawing():
    it = P("rank the best spots in Midland County", ONE)
    assert areas(it) == [("county", "Midland County")]
    assert any("not used" in n for n in it.notes)


def test_drawn_points_and_implicit_drawing():
    assert [r.label for r in P("rank the best spots on the map", PINS).regions] == ["Pin A", "Pin B"]
    it = P("rank them", ONE)
    assert areas(it) == [("polygon", "Tract 1")] and any("No area named" in n for n in it.notes)


# ---- coverage ------------------------------------------------------------------------------------------
def test_counties_outside_coverage_are_refused_or_reported():
    it = P("best spots in Reeves County")
    assert it.regions == [] and "outside OffsetIQ v1 coverage" in it.clarify
    it = P("rank Midland and Howard counties")
    assert areas(it) == [("county", "Midland County")]
    assert any(u.startswith("Howard County") for u in it.unsupported)
    it = P("rank Midland and Martin counties")
    assert [r.label for r in it.regions] == ["Midland County", "Martin County"]


def test_midland_basin_means_all_four_counties_not_midland_county():
    it = P("Rank the Midland Basin, top 5, csv")
    assert [r.label for r in it.regions] == ["Andrews County", "Ector County", "Midland County", "Martin County"]
    assert it.top_n == 5 and it.formats == ["csv"]


# ---- parameters ------------------------------------------------------------------------------------------
@pytest.mark.parametrize("prompt,lateral", [
    ("rank Martin County with 2-mile laterals", 10560),
    ("rank Martin County, two mile laterals", 10560),
    ("rank Martin County with 1.5-mile laterals", 7920),
    ("rank Martin County, laterals of 1.5 miles", 7920),
    ("rank Martin County for 12,500 ft laterals", 12500),
    ("rank Martin County for 12500' laterals", 12500),
    ("rank Martin County for 10k laterals", 10000),
    ("rank Martin County, lateral length 7,500 ft", 7500),
    ("rank Martin County", DEFAULT_LATERAL_FT),
])
def test_lateral_length(prompt, lateral):
    it = P(prompt)
    assert it.lateral_ft == lateral
    assert it.lateral_explicit == ("lateral" in prompt)


def test_spacing_radius_top_n_formats_and_defaults():
    it = P("rank Ector County")
    assert (it.spacing_acres, it.radius_mi, it.top_n, it.formats) == (DEFAULT_SPACING_ACRES, DEFAULT_RADIUS_MI, DEFAULT_TOP_N, [])
    it = P("Top 10 locations in martin co. with 2-mile laterals, 80 acre spacing, offsets within 1.5 miles, export pdf and a share link")
    assert (it.top_n, it.spacing_acres, it.radius_mi, it.lateral_ft) == (10, 80, 1.5, 10560)
    assert it.formats == ["pdf", "link"]
    it = P("screen this 640-acre lease block at 40-acre spacing", ONE)
    assert it.spacing_acres == 40 and any("Area size mentioned (640 acres)" in n for n in it.notes)
    assert P("rank Ector, quarter-section spacing").spacing_acres == 160
    assert P("rank the ten best spots in Ector").top_n == 10
    assert P("find a best spot in Ector").top_n == DEFAULT_TOP_N      # "a best" is not a count
    it = P("rank Ector within half a mile")
    assert it.radius_mi == 0.5
    it = P("rank Ector, offsets within 25 miles")
    assert it.radius_mi == 10 and any("outside 0.5-10 mi" in n for n in it.notes)


def test_offset_filters_are_evidence_filters():
    it = P("rank Martin County using only offsets with laterals over 9,000 ft and first production since 2020, operator Diamondback")
    f = it.filters
    assert (f.min_lat_ft, f.max_lat_ft, f.min_first_ym, f.operator) == (9000, None, 202001, "Diamondback")
    assert it.lateral_ft == DEFAULT_LATERAL_FT          # an offset filter is not the candidate's lateral
    assert any("the model forecast always uses every attributable well" in n for n in it.notes)
    f = P("rank Martin, offset wells between 7,000 and 11,000 ft long, 2018-2021 vintage").filters
    assert (f.min_lat_ft, f.max_lat_ft, f.min_first_ym, f.max_first_ym) == (7000, 11000, 201801, 202112)
    f = P("rank Martin, offsets after 2019 and before 2024").filters
    assert (f.min_first_ym, f.max_first_ym) == (202001, 202312)
    it = P("rank Martin, offsets from 2005 to 2009")
    assert it.filters.min_first_ym is None and any("no attributable wells first produced" in u for u in it.unsupported)
    it = P("operated by Pioneer Natural Resources, rank Midland")
    assert it.filters.operator == "Pioneer Natural"     # longest phrase that matches an RRC operator name
    it = P("rank Midland, operator Acme Petroleum Unicorns")
    assert it.filters.operator == "" and any("Acme" in u for u in it.unsupported)


def test_unsupported_requests_are_reported_never_dropped():
    it = P("rank Midland County, depth 9,000-10,500 ft TVD, Wolfcamp B, 2,000 lb/ft proppant, include multi-well leases, "
           "gas too, and the NPV; also use my private data")
    text = " ".join(it.unsupported)
    for needle in ("Depth / TVD ('depth 9,000-10,500 ft')", "Target bench", "Completion design", "Multi-well-lease volumes",
                   "Gas / BOE", "Economics", "Private data"):
        assert needle in text, needle
    assert areas(it) == [("county", "Midland County")]  # the screen still runs on what is supported


def test_always_on_filters_are_acknowledged():
    it = P("single well leases only, horizontals only, best spots in Ector")
    assert any(n.startswith("Single-well leases only: always applied") for n in it.notes)
    assert any(n.startswith("Horizontal wells only: always applied") for n in it.notes)


# ---- leases (the RRC publishes no lease boundaries) ----------------------------------------------------------------
def test_lease_by_name_and_number(snap):
    it = P("screen the SCHARBAUER RANCH 19 lease", snap=snap)
    assert [r.kind for r in it.regions] == ["lease"] and "no lease boundaries" in it.regions[0].detail
    it = P("rank lease 31613", snap=snap)
    assert it.regions[0].label == "RRC lease 31613"
    it = P("rank lease 08-31613", snap=snap)
    assert it.regions and any("numbers districts differently" in n for n in it.notes)
    assert "too broad" in P("screen the MABEE lease", snap=snap).clarify
    assert "No attributable single-well lease matches" in P('screen the "ZZZ NOT A LEASE" lease', snap=snap).clarify


def test_region_labels_are_unique():
    it = P("compare these tracts", {"polygons": [{"label": "A", "ring": SQ}, {"label": "A", "ring": SQ2}]})
    assert [r.label for r in it.regions] == ["A", "A (2)"]


def test_to_json_round_trips_the_essentials():
    j = P("compare these three tracts, top 5, csv", THREE).to_json()
    assert j["action"] == "compare" and j["top_n"] == 5 and j["formats"] == ["csv"]
    assert [r["label"] for r in j["regions"]] == ["Tract 1", "Tract 2", "Tract 3"]
    assert j["regions"][0]["ring"][0] == [31.90, -102.10]


def test_quantities_the_parser_did_not_understand_are_reported():
    it = P("rank the best spots in Midland County for laterals over 12,000 ft")
    assert it.lateral_ft == DEFAULT_LATERAL_FT
    assert any(n.startswith("Did not use '12,000 ft'") for n in it.notes)
    for understood in ("Top 10 in martin co. with 2-mile laterals, 80 acre spacing, offsets within 1.5 miles",
                       "rank Martin, offset wells between 7,000 and 11,000 ft long",
                       "rank Midland County, depth 9,000-10,500 ft TVD"):
        assert not any(n.startswith("Did not use") for n in P(understood).notes), understood
