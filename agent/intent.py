"""Turn a natural-language screening request into explicit, auditable parameters.

Deterministic on purpose. The parse is shown back to the operator before any
result ("I understood ..."), every interpretation is written to `notes`, and
anything public RRC data cannot support (depth, bench, completion design,
multi-well-lease volumes, gas, economics) is reported in `unsupported` -- never
silently dropped. When no screenable area can be identified the agent asks a
question (`clarify`) instead of guessing.

Areas, in order of precedence:
  1. lat/lon typed in the prompt: points, or a polygon when the prompt says so;
  2. shapes drawn on the map, when the prompt points at them ("this lease block",
     "these three tracts") -- or when the prompt names no other area;
  3. an attributable lease by name or RRC lease number, approximated by the
     buffered hull of its wellbores (the RRC publishes no lease boundaries);
  4. a supported county ("Midland County"), or all four for "the Midland Basin".
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

from agent import geo
from agent.engine import SUPPORTED, Filters
from agent.snapshot import Snapshot

DEFAULT_SPACING_ACRES = 40.0
DEFAULT_LATERAL_FT = 10000.0      # same default as the Analyze page
DEFAULT_RADIUS_MI = 1.0           # "nearby offsets" radius used in rationales
DEFAULT_TOP_N = 25
MAX_TOP_N = 200
LEASE_BUFFER_FT = 1320.0          # 1/4 mi around matched wellbores
LEASE_MAX_WELLS = 60
LEASE_MAX_SQ_MI = 60.0
FIRST_PROD_RANGE = (2013, 2026)   # first-production years present in the snapshot

# Permian-area counties OffsetIQ v1 does not cover (named so they are refused, not misread).
OTHER_COUNTIES = (
    "howard", "glasscock", "upton", "reagan", "crane", "ward", "winkler", "loving", "reeves", "pecos",
    "gaines", "dawson", "borden", "scurry", "mitchell", "sterling", "irion", "crockett", "culberson",
    "yoakum", "terry", "lynn", "garza", "lea", "eddy", "jeff davis", "terrell", "schleicher", "coke", "nolan",
)
WORDNUM = {"a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
           "eight": 8, "nine": 9, "ten": 10, "twelve": 12, "fifteen": 15, "twenty": 20, "thirty": 30,
           "forty": 40, "fifty": 50, "half": 0.5, "half a": 0.5}
_W = r"(?:\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|forty|fifty|half(?: a)?)"
_FT = r"(\d{1,2},\d{3}|\d+(?:\.\d+)?\s*k\b|\d{3,6}(?:\.\d+)?)"
_UNIT_FT = r"\s*(?:ft\b|feet\b|foot\b|')?"
_AREA_NOUN = r"(?:lease|block|section|tract|unit|area|acreage|parcel|polygon|prospect|ranch|pad)"
_STOP = {"screen", "rank", "compare", "the", "in", "on", "at", "for", "every", "all", "best", "top", "show", "find",
         "me", "my", "a", "an", "of", "and", "within", "locations", "location", "spots", "please", "evaluate", "this",
         "that", "these", "those", "whole", "entire", "across", "inside", "around", "near", "from", "with"}


@dataclass(frozen=True)
class Region:
    label: str
    kind: str                     # county | polygon | point | lease
    ring: tuple = ()              # ((lat, lon), ...) for areas
    point: tuple = ()             # (lat, lon) for kind == "point"
    source: str = ""              # named | drawn | typed | lease
    detail: str = ""


@dataclass
class Intent:
    prompt: str
    action: str = "rank"          # rank | screen | compare
    regions: list = field(default_factory=list)
    spacing_acres: float = DEFAULT_SPACING_ACRES
    spacing_explicit: bool = False
    lateral_ft: float = DEFAULT_LATERAL_FT
    lateral_explicit: bool = False
    radius_mi: float = DEFAULT_RADIUS_MI
    filters: Filters = field(default_factory=Filters)
    top_n: int = DEFAULT_TOP_N
    formats: list = field(default_factory=list)
    notes: list = field(default_factory=list)
    unsupported: list = field(default_factory=list)
    clarify: str | None = None

    def to_json(self) -> dict:
        f = self.filters
        return {
            "action": self.action, "spacing_acres": self.spacing_acres, "spacing_explicit": self.spacing_explicit,
            "lateral_ft": self.lateral_ft, "lateral_explicit": self.lateral_explicit, "radius_mi": self.radius_mi,
            "filters": {"min_lat_ft": f.min_lat_ft, "max_lat_ft": f.max_lat_ft, "operator": f.operator,
                        "min_first_ym": f.min_first_ym, "max_first_ym": f.max_first_ym},
            "top_n": self.top_n, "formats": self.formats, "notes": self.notes, "unsupported": self.unsupported,
            "clarify": self.clarify,
            "regions": [{"label": r.label, "kind": r.kind, "ring": [list(p) for p in r.ring], "point": list(r.point),
                         "source": r.source, "detail": r.detail} for r in self.regions],
        }


class _Text:
    """Working copy of the prompt; matched spans are blanked so nothing is read twice."""

    def __init__(self, s: str):
        self.s = s

    def take(self, pattern: str, flags: int = re.I) -> list[re.Match]:
        ms = list(re.finditer(pattern, self.s, flags))
        for m in ms:
            self.blank(m.start(), m.end())
        return ms

    def blank(self, a: int, b: int) -> None:
        self.s = self.s[:a] + " " * (b - a) + self.s[b:]

    def has(self, pattern: str) -> bool:
        return re.search(pattern, self.s, re.I) is not None


def _n(s: str) -> float:
    s = s.strip().lower().replace(",", "")
    if s in WORDNUM:
        return float(WORDNUM[s])
    if s.endswith("k"):
        return float(s[:-1].strip()) * 1000
    return float(s)


def _fmt_ft(v: float) -> str:
    return f"{v:,.0f} ft"


def parse(prompt: str, context: dict | None, snap: Snapshot) -> Intent:
    context = context or {}
    raw = (prompt or "").strip()
    norm = (raw.replace("–", "-").replace("—", "-").replace("−", "-")
            .replace("“", '"').replace("”", '"').replace("’", "'").replace("‘", "'"))
    it = Intent(prompt=raw)
    t = _Text(re.sub(r"\b(?:lat(?:itude)?|lon(?:gitude)?|lng)\b\s*[:=]?\s*", " ", norm, flags=re.I))
    low = norm.lower()

    # ---- coordinates (typed points / polygons) --------------------------------------------
    coords: list[tuple[float, float, int]] = []
    base = t.s
    for m in t.take(r"(?<![\w.])([-+]?\d{1,3}\.\d+)\s*°?\s*([nsNS])?\s*(?:[,;/]\s*|\s+)?([-+]?\d{1,3}\.\d+)\s*°?\s*([ewEW])?(?![\w.])"):
        c = _coord(m, it)
        if c:
            coords.append((c[0], c[1], m.start()))
    polygon_words = re.search(r"\b(polygon|boundary|outline|corners?|vertices|vertex|perimeter|bounded by)\b", low)
    box_words = re.search(r"\b(box|rectangle|bbox|bounding box)\b", low)
    typed: list[Region] = []
    if coords and box_words and len(coords) == 2:
        (a, b, _), (c, d, _) = coords
        ring = [(min(a, c), min(b, d)), (min(a, c), max(b, d)), (max(a, c), max(b, d)), (max(a, c), min(b, d))]
        typed.append(_polygon_region("Box", ring, "typed", it))
    elif coords and polygon_words:
        # Several polygons may be separated by newlines, '|' or labels like "tract B:".
        cuts = sorted({0, len(base)} | {m.start() for m in re.finditer(r"\n|\||\b(?:tract|block|polygon|area)\s+[a-z0-9]+\s*:", base, re.I)})
        groups = [[(la, lo) for la, lo, pos in coords if a <= pos < b] for a, b in zip(cuts, cuts[1:])]
        groups = [g for g in groups if g]
        if any(len(g) < 3 for g in groups):
            it.clarify = "A polygon needs at least 3 corners. Paste each corner as lat, lon (e.g. 31.90, -102.10), in order around the boundary."
        else:
            word = "Tract" if re.search(r"\btracts?\b", low) else "Polygon"
            for i, g in enumerate(groups):
                typed.append(_polygon_region(f"{word} {i + 1}" if len(groups) > 1 else word, g, "typed", it))
    elif coords:
        typed = [Region(label=f"Point {i + 1}", kind="point", point=(la, lo), source="typed") for i, (la, lo, _) in enumerate(coords)]

    # ---- things public RRC data cannot do: say so, never drop silently -----------------------
    if re.search(r"\b(depth|tvd|true vertical|deeper|shallower|landing (?:zone|depth)|ft deep|feet deep)\b", low):
        asked = t.take(r"\b(?:depths?|tvd)\b[^.;,]*?\d[\d,]*\s*(?:ft|feet|')?(?:\s*(?:-|to|and)\s*\d[\d,]*\s*(?:ft|feet|')?)?")
        what = f" ('{asked[0].group(0).strip()}')" if asked else ""
        it.unsupported.append(f"Depth / TVD{what}: not in the public RRC data OffsetIQ uses, so no depth filter was applied.")
    if re.search(r"\b(wolfcamp|spraberry|jo ?mill|dean|cline|strawn|atoka|barnett|bench|formation|target zone|landing)\b", low):
        it.unsupported.append("Target bench / formation: not in public RRC production data, so it was not applied "
                              "(the RRC field name is shown per offset instead).")
    if re.search(r"\b(proppant|frac(?:k?ing)?|fluid|stages?|completion design|lbs?/ft)\b", low):
        it.unsupported.append("Completion design (proppant, fluid, stages): not in the public data used; not applied.")
    if re.search(r"\b(gas|boe|mcf|ngl)\b", low):
        it.unsupported.append("Gas / BOE: OffsetIQ forecasts oil only (bbl).")
    if re.search(r"\b(npv|irr|economics?|breakeven|pv-?10|price deck)\b", low):
        it.unsupported.append("Economics (NPV, IRR, breakeven): out of scope; results are oil volumes only.")
    if re.search(r"\b(include|includ|using|use|count|with)\w*\b[^.;]*\bmulti[- ]?well", low):
        it.unsupported.append("Multi-well-lease volumes: the RRC reports them per lease, not per well, so they are "
                              "never used as volumes; those wells are counted as coverage gaps.")
    if re.search(r"\b(upload|my own data|private data|proprietary|internal data)\b", low):
        it.unsupported.append("Private data: this version screens public RRC data only.")
    if re.search(r"\bsingle[- ]?well\b", low):
        it.notes.append("Single-well leases only: always applied. OffsetIQ only uses wells whose production the RRC attributes to one well.")
    if re.search(r"\b(horizontals?|hz)\b(?:\s+(?:wells?\s+)?only)?|\bonly\s+horizontals?\b", low) and "horizontal" in low:
        it.notes.append("Horizontal wells only: always applied (OffsetIQ covers horizontals only).")

    # ---- offset-lateral filters ("offsets longer than 8,000 ft") come before the candidate lateral
    for m in re.finditer(r"[^.;\n]+", t.s):
        clause = m.group(0)
        if not re.search(r"offsets?|wells?", clause, re.I) or not re.search(r"laterals?|long|length", clause, re.I):
            continue
        for b in re.finditer(r"between\s+" + _FT + _UNIT_FT + r"\s*(?:and|-|to)\s*" + _FT + _UNIT_FT, clause, re.I):
            lo_, hi_ = sorted([_n(b.group(1)), _n(b.group(2))])
            it.filters = _with(it.filters, min_lat_ft=lo_, max_lat_ft=hi_)
            t.blank(m.start() + b.start(), m.start() + b.end())
        for c in re.finditer(r"(over|above|greater than|longer than|more than|at least|min(?:imum)?|>=?|under|below|less than|shorter than|at most|max(?:imum)?|<=?)\s*" + _FT + _UNIT_FT, clause, re.I):
            v, op = _n(c.group(2)), c.group(1).lower()
            if op in ("under", "below", "less than", "shorter than", "at most", "max", "maximum", "<", "<="):
                it.filters = _with(it.filters, max_lat_ft=v)
            else:
                it.filters = _with(it.filters, min_lat_ft=v)
            t.blank(m.start() + c.start(), m.start() + c.end())
    if it.filters.min_lat_ft is not None or it.filters.max_lat_ft is not None:
        lo_, hi_ = it.filters.min_lat_ft, it.filters.max_lat_ft
        rng = (f"{_fmt_ft(lo_)} to {_fmt_ft(hi_)}" if lo_ is not None and hi_ is not None
               else f"at least {_fmt_ft(lo_)}" if lo_ is not None else f"at most {_fmt_ft(hi_)}")
        it.notes.append(f"Offset lateral filter: {rng}. Filters narrow the offset evidence listed and counted; "
                        "the model forecast always uses every attributable well within 3 mi (same as Analyze).")

    # ---- candidate lateral -----------------------------------------------------------------------
    lat_ft = None
    for m in t.take(r"(" + _W + r")\s*-?\s*mile\s*-?\s*(?:long\s+)?laterals?\b"):
        lat_ft = _n(m.group(1)) * 5280
        it.notes.append(f"'{m.group(0).strip()}' read as {_fmt_ft(lat_ft)} laterals.")
    for m in t.take(_FT + _UNIT_FT + r"\s*-?\s*(?:long\s+)?laterals?\b"):
        lat_ft = _n(m.group(1))
    for m in t.take(r"\blaterals?\s*(?:length\s*)?(?:of|=|:|at|around|about|is)?\s*(" + _W + r")\s*-?\s*miles?\b"):
        lat_ft = _n(m.group(1)) * 5280
        it.notes.append(f"'{m.group(0).strip()}' read as {_fmt_ft(lat_ft)} laterals.")
    for m in t.take(r"\blaterals?\s*(?:length\s*)?(?:of|=|:|at|around|about|is)?\s*" + _FT + _UNIT_FT):
        lat_ft = _n(m.group(1))
    if lat_ft is not None:
        if 1000 <= lat_ft <= 25000:
            it.lateral_ft, it.lateral_explicit = float(lat_ft), True
        else:
            it.notes.append(f"Ignored a lateral length of {_fmt_ft(lat_ft)} (outside 1,000-25,000 ft); used {_fmt_ft(DEFAULT_LATERAL_FT)}.")

    # ---- evidence radius -------------------------------------------------------------------------
    for m in t.take(r"\b(?:within|inside|in)\s+(?:a\s+)?(" + _W + r")\s*-?\s*(?:mi\b|miles?\b)(?:\s+radius)?|\b(" + _W + r")\s*-?\s*(?:mi|mile)\s+radius\b"):
        r = _n(m.group(1) or m.group(2))
        r2 = min(10.0, max(0.5, r))
        it.radius_mi = r2
        if r2 != r:
            it.notes.append(f"Offset radius {r:g} mi is outside 0.5-10 mi (the Analyze page's range); used {r2:g} mi.")

    # ---- spacing (vs. an area size like "this 640-acre lease block") ---------------------------------
    for m in t.take(r"(\d+(?:\.\d+)?)\s*-?\s*ac(?:res?)?\b(\s*-?\s*" + _AREA_NOUN + r")?"):
        v = float(m.group(1))
        if m.group(2):
            it.notes.append(f"Area size mentioned ({v:g} acres); candidate count follows the area actually screened.")
        elif 5 <= v <= 640:
            it.spacing_acres, it.spacing_explicit = v, True
        else:
            it.notes.append(f"Ignored {v:g}-acre spacing (outside 5-640 acres); used {DEFAULT_SPACING_ACRES:g}-acre.")
    if t.has(r"\bquarter[- ]section"):
        it.spacing_acres, it.spacing_explicit = 160.0, True

    # ---- how many to rank ------------------------------------------------------------------------
    count = r"(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|forty|fifty)"
    for m in t.take(r"\btop\s+" + count + r"\b|\b" + count + r"\s+best\b|\bbest\s+" + count + r"\b"):
        try:
            n = int(_n(next(g for g in m.groups() if g)))
        except ValueError:
            continue
        it.top_n = max(1, min(MAX_TOP_N, n))
        if n > MAX_TOP_N:
            it.notes.append(f"Showing the top {MAX_TOP_N} (maximum).")

    # ---- offset vintage --------------------------------------------------------------------------
    for m in t.take(r"\b(since|from|starting|on or after|after|newer than)\s+(20\d\d)\b(?!\s*(?:-|to)\s*20\d\d)"):
        y = int(m.group(2)) + (1 if m.group(1).lower() in ("after", "newer than") else 0)
        it.filters = _with(it.filters, min_first_ym=y * 100 + 1)
    for m in t.take(r"\b(before|prior to|older than|until|through|thru|up to)\s+(20\d\d)\b"):
        y = int(m.group(2)) - (1 if m.group(1).lower() in ("before", "prior to", "older than") else 0)
        it.filters = _with(it.filters, max_first_ym=y * 100 + 12)
    for m in t.take(r"\b(20\d\d)\s*(?:-|to|through)\s*(20\d\d)\b"):
        a, b = sorted([int(m.group(1)), int(m.group(2))])
        it.filters = _with(it.filters, min_first_ym=a * 100 + 1, max_first_ym=b * 100 + 12)
    for m in t.take(r"\b(20\d\d)\s*(?:\+|or later|and later|or newer|and newer|onwards?)"):
        it.filters = _with(it.filters, min_first_ym=int(m.group(1)) * 100 + 1)
    f = it.filters
    if f.min_first_ym or f.max_first_ym:
        lo_y, hi_y = (f.min_first_ym or 0) // 100, (f.max_first_ym or 999999) // 100
        if hi_y < FIRST_PROD_RANGE[0] or lo_y > FIRST_PROD_RANGE[1] or lo_y > hi_y:
            it.unsupported.append(f"Offset vintage {lo_y or ''}-{hi_y if hi_y < 9999 else ''}: no attributable wells first produced "
                                  f"then (the snapshot covers {FIRST_PROD_RANGE[0]}-{FIRST_PROD_RANGE[1]}); filter not applied.")
            it.filters = _with(it.filters, min_first_ym=None, max_first_ym=None)
        else:
            span = (f"{lo_y}-{hi_y}" if f.min_first_ym and f.max_first_ym else f"{lo_y} or later" if f.min_first_ym else f"{hi_y} or earlier")
            it.notes.append(f"Offset vintage filter: first production {span} (evidence only; the forecast uses all wells).")

    # ---- operator filter ---------------------------------------------------------------------------
    for m in t.take(r"\b(?:operator(?:\s+is)?|operated by|wells? (?:operated )?by|offsets? (?:from|by))\s*[:=]?\s*[\"']?([A-Za-z0-9][A-Za-z0-9&.\-' ]{1,40}?)[\"']?(?=\s*(?:$|[,.;\n]|\b(?:wells?|offsets?|only|in|with|and|within|at|for|using|laterals?|since|from|before|after|top|export|as)\b))"):
        _operator(m.group(1).strip(), snap, it)

    # ---- lease by RRC number or name -------------------------------------------------------------------
    lease_q = None
    for m in t.take(r"\blease\s*(?:no\.?|number|#)?\s*(?:([0-9]{1,2}[a-c]?)\s*-\s*)?(\d{5,6})\b"):
        lease_q = ("number", m.group(2), m.group(1))
    if lease_q is None:
        for pat in (r"[\"]([^\"]{2,40})[\"]\s*leases?\b", r"\b[Ll]eases?\s+(?:named|called)?\s*[\"]([^\"]{2,40})[\"]",
                    r"\b([A-Z][A-Za-z0-9\-&']*(?:\s+[A-Z0-9][A-Za-z0-9\-&']*){0,4})\s+leases?\b(?!\s*block)",
                    r"\b[Ll]eases?\s+(?:named\s+|called\s+)?([A-Z][A-Za-z0-9\-&']*(?:\s+[A-Z0-9][A-Za-z0-9\-&']*){0,4})"):
            for m in re.finditer(pat, t.s, 0):
                words = m.group(1).split()
                while words and words[0].lower() in _STOP:
                    words.pop(0)
                name = " ".join(words)
                if name and name.lower() not in _STOP and not re.fullmatch(r"(?i)(andrews|ector|midland|martin)(\s+county)?", name):
                    lease_q = ("name", name, None)
                    t.blank(m.start(), m.end())
                    break
            if lease_q:
                break

    # ---- counties ------------------------------------------------------------------------------------
    named = []
    for m in t.take(r"\b(andrews|ector|midland|martin)\b(?!\s+basin)(\s+(?:county|counties|co\b\.?|cty\b))?"):
        c = m.group(1).upper()
        if c not in named:
            named.append(c)
            if not m.group(2) and not re.search(r"\b(?:andrews|ector|midland|martin)\s+(?:and|&|,)\s+[a-z]+\s+counties\b", low):
                it.notes.append(f"Read '{m.group(1)}' as {c.title()} County.")
    others = []
    for m in t.take(r"\b(" + "|".join(OTHER_COUNTIES) + r")\s+(?:county|counties|co\b\.?)"):
        c = m.group(1).title()
        if c not in others:
            others.append(c)
    # "Midland and Howard counties": the plural applies to both names.
    for m in re.finditer(r"\b(" + "|".join(OTHER_COUNTIES) + r")\s+(?:and|&|,)\s+(?:andrews|ector|midland|martin)\s+counties\b", low):
        if m.group(1).title() not in others:
            others.append(m.group(1).title())
    for c in others:
        it.unsupported.append(f"{c} County: outside OffsetIQ v1 coverage (Andrews, Ector, Midland, Martin); not screened.")
    basinwide = re.search(r"\b(midland basin|permian|all (?:four |4 )?(?:covered )?counties|everywhere|whole (?:coverage|dataset|basin))\b", low)

    # ---- references to what is drawn on the map ----------------------------------------------------------
    drawn_polys = [p for p in (context.get("polygons") or []) if isinstance(p, dict)]
    drawn_pts = [p for p in (context.get("points") or []) if isinstance(p, dict)]
    deictic = re.search(r"\b(this|that|my|selected|drawn|highlighted)\s+(?:\d+[- ]acre\s+)?"
                        r"(lease[- ]?block|block|area|polygon|tract|acreage|section|unit|lease|shape|region|outline|box|prospect)s?\b"
                        r"|\b(these|those|my)\s+(?:(\w+)\s+)?(tracts|areas|polygons|blocks|lease blocks|sections|units|leases|locations|points|pins|spots|shapes|prospects)\b"
                        r"|\b(here|what i drew|i drew|i(?:'ve| have) drawn|on the map|drawn)\b", low)
    expected = None
    if deictic and deictic.group(3):
        if deictic.group(4) and deictic.group(4) in WORDNUM:
            expected = int(WORDNUM[deictic.group(4)])
        elif deictic.group(4) and deictic.group(4).isdigit():
            expected = int(deictic.group(4))

    # ---- action & output preferences ---------------------------------------------------------------------
    if re.search(r"\b(compare|comparison|versus|vs\.?|side[- ]by[- ]side|which (?:tract|block|area|lease|one)s?)\b", low):
        it.action = "compare"
    elif re.search(r"\b(rank|best|top|highest|sweet ?spots?|optimal|where should)\b", low):
        it.action = "rank"
    elif re.search(r"\b(screen|every|all (?:the )?locations|scan|evaluate|assess)\b", low):
        it.action = "screen"
    for k, pat in (("csv", r"\b(csv|spreadsheet|excel|xlsx)\b"), ("pdf", r"\b(pdf|print(?:able)?|report)\b"),
                   ("link", r"\b(share(?:able)?|link|url)\b")):
        if re.search(pat, low):
            it.formats.append(k)

    # Every span understood above has been blanked, so a quantity with a unit still left was not understood.
    for m in re.finditer(r"(?<![\w.])(\d[\d,]*(?:\.\d+)?\s*(?:k\b)?\s*(?:ft\b|feet\b|foot\b|'|mi\b|miles?\b|ac(?:res?)?\b))", t.s, re.I):
        it.notes.append(f"Did not use '{m.group(1).strip()}': unclear what it refers to. Say e.g. '12,000 ft laterals', "
                        "'offsets longer than 8,000 ft', 'offsets within 1.5 miles' or '80-acre spacing'.")

    # ---- resolve the area ------------------------------------------------------------------------------------
    if it.clarify:
        return it
    if typed:
        it.regions = typed
        if drawn_polys or drawn_pts:
            it.notes.append("Used the coordinates in your message; shapes drawn on the map were not screened.")
    elif deictic and (drawn_polys or drawn_pts):
        it.regions = _drawn(drawn_polys, drawn_pts, it)
        if expected is not None and expected != len(it.regions):
            it.notes.append(f"You mentioned {expected}; {len(it.regions)} {'is' if len(it.regions) == 1 else 'are'} drawn, so all drawn shapes were screened.")
        if named:
            it.notes.append(f"{', '.join(c.title() for c in named)} County mentioned as context; screening the drawn shape(s).")
    elif deictic and not lease_q and not named:
        it.clarify = (f"You referred to '{deictic.group(0).strip()}', but nothing is drawn on the map. Use Draw area to outline it "
                      "(one shape per tract), or paste its corners as lat, lon pairs.")
    elif lease_q:
        _lease(lease_q, snap, it)
    elif named:
        it.regions = [_county(c) for c in named]
        if drawn_polys or drawn_pts:
            it.notes.append("Screened the named county; the shape(s) drawn on the map were not used (refer to them as 'this area' to screen them).")
    elif basinwide:
        it.regions = [_county(c) for c in SUPPORTED]
        it.notes.append("OffsetIQ covers Andrews, Ector, Midland and Martin counties; screening all four.")
    elif drawn_polys or drawn_pts:
        it.regions = _drawn(drawn_polys, drawn_pts, it)
        it.notes.append(f"No area named in the prompt; screening the {len(it.regions)} shape(s) drawn on the map.")
    elif others:
        it.clarify = (f"{' and '.join(others)} County {'is' if len(others) == 1 else 'are'} outside OffsetIQ v1 coverage. "
                      "Screen Andrews, Ector, Midland or Martin County, or draw an area inside them.")
    else:
        it.clarify = ("Which area should I screen? Name a county (Andrews, Ector, Midland or Martin), draw a lease block or "
                      "tracts on the map, or paste lat/lon points.")
    seen: dict[str, int] = {}
    for i, r in enumerate(it.regions):  # labels identify areas downstream, so they must be unique
        seen[r.label] = seen.get(r.label, 0) + 1
        if seen[r.label] > 1:
            it.regions[i] = Region(**{**r.__dict__, "label": f"{r.label} ({seen[r.label]})"})
    if it.action == "compare" and len(it.regions) < 2 and not it.clarify:
        it.notes.append("Only one area to compare; ranking the locations inside it instead.")
        it.action = "rank"
    return it


def _with(f: Filters, **kw) -> Filters:
    d = {k: getattr(f, k) for k in ("min_lat_ft", "max_lat_ft", "operator", "min_first_ym", "max_first_ym")}
    d.update(kw)
    return Filters(**d)


def _coord(m: re.Match, it: Intent) -> tuple[float, float] | None:
    a, ns, b, ew = float(m.group(1)), (m.group(2) or "").lower(), float(m.group(3)), (m.group(4) or "").lower()
    if ns == "s":
        a = -abs(a)
    if ew == "w":
        b = -abs(b)
    if 90 < abs(a) <= 180 and abs(b) <= 90:
        a, b = b, a
        it.notes.append(f"Read ({m.group(0).strip()}) as longitude, latitude and swapped it.")
    if not (-90 <= a <= 90 and -180 <= b <= 180):
        return None
    if b > 0 and not ew and 93 <= b <= 107 and 25 <= a <= 37:
        b = -b
        it.notes.append(f"Read longitude {abs(b)} as {abs(b)} W (Texas).")
    return a, b


def _polygon_region(label: str, ring, source: str, it: Intent) -> Region:
    try:
        clean = geo.clean_ring(ring)
    except geo.GeoError as e:
        it.clarify = f"{label}: {e}"
        return Region(label=label, kind="polygon", source=source)
    acres = geo.ring_area_acres(clean)
    return Region(label=label, kind="polygon", ring=tuple(clean), source=source, detail=f"{acres:,.0f} acres")


def _drawn(polys: list[dict], pts: list[dict], it: Intent) -> list[Region]:
    out = []
    for i, p in enumerate(polys):
        out.append(_polygon_region(str(p.get("label") or f"Tract {i + 1}")[:40], p.get("ring") or [], "drawn", it))
    for i, p in enumerate(pts):
        try:
            la, lo = float(p["lat"]), float(p["lon"])
        except (KeyError, TypeError, ValueError):
            continue
        if math.isfinite(la) and math.isfinite(lo):
            out.append(Region(label=str(p.get("label") or f"Point {i + 1}")[:40], kind="point", point=(la, lo), source="drawn"))
    return out


def _county(c: str) -> Region:
    ring = geo.counties()[c]
    return Region(label=f"{c.title()} County", kind="county", ring=tuple(ring), source="named",
                  detail=f"{geo.ring_area_acres(ring) / 640:,.0f} sq mi (Census county boundary)")


def _operator(q: str, snap: Snapshot, it: Intent) -> None:
    ops = sorted(set(snap.operator))
    words = q.split()
    while words:  # longest leading phrase that matches an operator name ("Pioneer Natural Resources" -> "PIONEER NATURAL")
        cand = " ".join(words)
        hits = [o for o in ops if cand.lower() in o.lower()]
        if hits:
            it.filters = _with(it.filters, operator=cand)
            shown = ", ".join(hits[:3]) + ("..." if len(hits) > 3 else "")
            it.notes.append(f"Operator filter '{cand}': matches {len(hits)} operator name(s) ({shown}). Evidence only; the forecast uses all wells.")
            return
        words.pop()
    it.unsupported.append(f"Operator '{q}': no attributable single-well-lease wells from an operator with that name; filter not applied.")


def _lease(q: tuple, snap: Snapshot, it: Intent) -> None:
    kind, val, district = q
    if kind == "number":
        idx = [i for i in range(snap.n) if snap.lease_no[i].endswith("-" + val)]
        label = f"RRC lease {val}"
        if district:
            it.notes.append(f"Matched lease number {val} in any district: the public dump numbers districts differently from RRC's '{district}'.")
    else:
        idx = [i for i in range(snap.n) if val.lower() in snap.lease[i].lower()]
        label = f"Lease '{val}'"
    if not idx:
        it.clarify = (f"No attributable single-well lease matches {label.split(' ', 1)[1]}. Multi-well leases can't be looked up by "
                      "name here (their production isn't attributable per well). Draw the lease on the map instead.")
        return
    names = sorted({snap.lease[i] for i in idx})
    pts = [(snap.slat[i], snap.slon[i]) for i in idx] + [(snap.blat[i], snap.blon[i]) for i in idx]
    ring = geo.buffered_hull(pts, LEASE_BUFFER_FT)
    sq_mi = geo.ring_area_acres(ring) / 640
    if len(idx) > LEASE_MAX_WELLS or sq_mi > LEASE_MAX_SQ_MI:
        it.clarify = (f"{label} matches {len(idx)} wellbores on {len(names)} leases spread over {sq_mi:,.0f} sq mi -- too broad to "
                      f"treat as one lease block. Be more specific (e.g. {', '.join(names[:3])}) or draw the block on the map.")
        return
    it.regions = [Region(label=label, kind="lease", ring=tuple(ring), source="lease",
                         detail=(f"approximate: RRC publishes no lease boundaries; hull of {len(idx)} matching wellbore(s) "
                                 f"({', '.join(names[:4])}{'...' if len(names) > 4 else ''}) grown by 1/4 mi, {sq_mi * 640:,.0f} acres"))]
