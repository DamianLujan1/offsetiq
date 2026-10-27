"use client";
import { useEffect, useRef, useState } from "react";
import type * as LT from "leaflet";
import "leaflet/dist/leaflet.css";
import { fmtK } from "@/lib/engine";
import { binOf } from "@/lib/screen";
import type { Horizontals, Wells } from "@/lib/types";

// Ordinal amber ramp for 12-month-oil P50 quintiles, low -> high: one hue, monotone lightness,
// darkest step 3.05:1 on the #0b1220 surface (checked with the dataviz palette validator).
export const P50_RAMP = ["#865812", "#ad720d", "#d78c00", "#fea91e", "#ffc947"];
const GAP = "#a78bfa", WELL = "#64748b", SEL = "#38bdf8", MUTED = "#93a1bd", INK = "#e6ebf5";

export interface MapCandidate { id: string; lat: number; lon: number; p50: number | null; rank: number | null; status: string }
export interface Shape { label: string; ring: [number, number][] }
export interface Pin { label: string; lat: number; lon: number }
interface Props {
  W: Wells; H: Horizontals;
  shapes: Shape[]; pins: Pin[]; draft: [number, number][]; mode: "none" | "polygon" | "point";
  regions: Shape[]; candidates: MapCandidate[]; labels: { id: string; n: number }[]; breaks: number[]; cellFt: number | null;
  selected: string | null;
  onMapClick: (lat: number, lon: number) => void; onFinish: () => void; onSelect: (id: string) => void;
}

/** Leaflet tooltips render strings as HTML; user- or link-supplied text goes in as a text node. */
const text = (s: string) => { const el = document.createElement("span"); el.textContent = s; return el; };

export default function ScreenMap(p: Props) {
  const el = useRef<HTMLDivElement>(null);
  const L = useRef<typeof LT | null>(null);
  const map = useRef<LT.Map | null>(null);
  const g = useRef<Record<"regions" | "shapes" | "draft" | "cands" | "labels" | "sel", LT.LayerGroup> | null>(null);
  const marks = useRef<Map<string, LT.CircleMarker>>(new Map());
  const ranked = useRef<Set<string>>(new Set());
  const [ready, setReady] = useState(false);
  const cb = useRef(p);
  cb.current = p;

  useEffect(() => {
    let alive = true;
    let onResize: (() => void) | null = null;
    import("leaflet").then((mod) => {
      if (!alive || !el.current || map.current) return;
      const Lf = (mod as unknown as { default: typeof LT }).default ?? (mod as unknown as typeof LT);
      L.current = Lf;
      const m = Lf.map(el.current, { preferCanvas: true, zoomControl: true }).setView([32.0, -102.15], 9);
      // Same keyless basemaps as the Analyze map.
      const dark = Lf.layerGroup([
        Lf.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", { attribution: "Basemap © Esri, HERE, Garmin, © OpenStreetMap contributors", maxZoom: 16 }),
        Lf.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16 }),
      ]);
      const osm = Lf.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap contributors", maxZoom: 19 });
      const sat = Lf.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { attribution: "Imagery © Esri", maxZoom: 19 });
      dark.addTo(m);
      const rend = Lf.canvas({ padding: 0.5 });
      const gaps = Lf.layerGroup(), wells = Lf.layerGroup();
      for (let i = 0; i < p.H.lat.length; i++) {
        if (p.H.code[i] === 0 || p.H.lat[i] == null || p.H.lon[i] == null) continue;
        Lf.circleMarker([p.H.lat[i], p.H.lon[i]], { renderer: rend, radius: 1.4, stroke: false, fillColor: GAP, fillOpacity: 0.3, interactive: false }).addTo(gaps);
      }
      for (let i = 0; i < p.W.n; i++) {
        Lf.circleMarker([p.W.lat[i], p.W.lon[i]], { renderer: rend, radius: 1.6, stroke: false, fillColor: WELL, fillOpacity: 0.7, interactive: false }).addTo(wells);
      }
      gaps.addTo(m); wells.addTo(m);
      const groups = { regions: Lf.layerGroup(), shapes: Lf.layerGroup(), draft: Lf.layerGroup(), cands: Lf.layerGroup(), labels: Lf.layerGroup(), sel: Lf.layerGroup() };
      Object.values(groups).forEach((x) => x.addTo(m));
      Lf.control.layers({ "Dark (Esri)": dark, "Streets (OpenStreetMap)": osm, "Satellite (Esri)": sat },
        { "Screened locations": groups.cands, "Attributable horizontals": wells, "Coverage gaps (not attributable)": gaps }, { position: "topleft" }).addTo(m);
      m.on("click", (e: LT.LeafletMouseEvent) => cb.current.onMapClick(e.latlng.lat, e.latlng.lng));
      m.on("dblclick", () => { if (cb.current.mode === "polygon") cb.current.onFinish(); });
      m.on("zoomend", () => resize());
      g.current = groups;
      map.current = m;
      setReady(true);
      setTimeout(() => m.invalidateSize(), 50);
      setTimeout(() => m.invalidateSize(), 500);
      onResize = () => m.invalidateSize();
      window.addEventListener("resize", onResize);
    });
    return () => {
      alive = false;
      if (onResize) window.removeEventListener("resize", onResize);
      map.current?.remove(); map.current = null; g.current = null; L.current = null; marks.current.clear();
    };
  }, [p.W, p.H]); // eslint-disable-line react-hooks/exhaustive-deps

  // Marker size follows the lattice: ~40% of a cell at the current zoom, 2-8 px.
  function radius(): number {
    const m = map.current;
    if (!m || !cb.current.cellFt) return 7;
    const mpp = (156543.03392 * Math.cos((m.getCenter().lat * Math.PI) / 180)) / 2 ** m.getZoom();
    return Math.max(2, Math.min(8, (0.42 * cb.current.cellFt * 0.3048) / mpp));
  }
  function resize() {
    const r = radius();
    marks.current.forEach((c, id) => { c.setRadius(r); if (ranked.current.has(id)) c.setStyle({ weight: ring(r) }); });
  }
  // A thin surface ring separates neighbouring dots once they are big enough to touch; on 2-3 px dots it would hide the fill.
  const ring = (r: number) => (r >= 4 ? 1 : 0);

  // drawing affordances
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (p.mode === "polygon") m.doubleClickZoom.disable(); else m.doubleClickZoom.enable();
    m.getContainer().style.cursor = p.mode === "none" ? "" : "crosshair";
  }, [ready, p.mode]);

  // areas: screened regions, drawn tracts and pins, polygon in progress
  useEffect(() => {
    const Lf = L.current, gr = g.current;
    if (!Lf || !gr) return;
    gr.regions.clearLayers(); gr.shapes.clearLayers(); gr.draft.clearLayers();
    for (const r of p.regions) {
      Lf.polygon(r.ring, { color: INK, weight: 1.5, opacity: 0.8, fill: false, dashArray: "6 4", interactive: false }).addTo(gr.regions);
    }
    p.shapes.forEach((s) => {
      Lf.polygon(s.ring, { color: SEL, weight: 2, fillColor: SEL, fillOpacity: 0.06, interactive: false })
        .bindTooltip(text(s.label), { permanent: true, direction: "center", className: "lbl" }).addTo(gr.shapes);
    });
    p.pins.forEach((x) => {
      Lf.circleMarker([x.lat, x.lon], { radius: 6, color: "#111", weight: 2, fillColor: INK, fillOpacity: 1, interactive: false })
        .bindTooltip(text(x.label), { permanent: true, direction: "right", className: "lbl" }).addTo(gr.shapes);
    });
    if (p.draft.length) {
      Lf.polyline(p.draft, { color: SEL, weight: 2, interactive: false }).addTo(gr.draft);
      if (p.draft.length >= 3) Lf.polyline([p.draft[p.draft.length - 1], p.draft[0]], { color: SEL, weight: 1.5, dashArray: "4 4", interactive: false }).addTo(gr.draft);
      p.draft.forEach((v) => Lf.circleMarker(v, { radius: 4, color: SEL, weight: 2, fillColor: "#0b1220", fillOpacity: 1, interactive: false }).addTo(gr.draft));
    }
  }, [ready, p.regions, p.shapes, p.pins, p.draft]);

  // screened locations: amber by P50 quintile when ranked, hollow when not ranked
  useEffect(() => {
    const Lf = L.current, gr = g.current, m = map.current;
    if (!Lf || !gr || !m) return;
    gr.cands.clearLayers(); marks.current.clear(); ranked.current.clear();
    if (!p.candidates.length) return;
    const rend = Lf.canvas({ padding: 0.5 });
    const r = radius();
    for (const c of p.candidates) {
      const isRanked = c.status === "ranked" && c.p50 !== null;
      if (isRanked) ranked.current.add(c.id);
      const mk = Lf.circleMarker([c.lat, c.lon], isRanked
        ? { renderer: rend, radius: r, color: "#0b1220", weight: ring(r), fillColor: P50_RAMP[binOf(p.breaks, c.p50!) + (5 - p.breaks.length)] ?? P50_RAMP[4], fillOpacity: 0.95 }
        : { renderer: rend, radius: r, color: MUTED, weight: 1, fill: false, opacity: 0.8, dashArray: c.status === "outside_coverage" ? "2 2" : undefined });
      mk.bindTooltip(text(isRanked ? `${c.id} · #${c.rank} · 12-mo oil P50 ${fmtK(c.p50)} bbl`
        : `${c.id} · not ranked: ${c.status === "outside_coverage" ? "outside coverage" : "no attributable offsets within 3 mi"}`), { direction: "top" });
      mk.on("click", (e) => { Lf.DomEvent.stopPropagation(e); cb.current.onSelect(c.id); });
      mk.addTo(gr.cands);
      marks.current.set(c.id, mk);
    }
    const b = Lf.latLngBounds(p.candidates.map((c) => [c.lat, c.lon] as [number, number]));
    if (p.candidates.length === 1) m.setView(b.getCenter(), 13); else m.fitBounds(b, { padding: [30, 30], maxZoom: 15 });
  }, [ready, p.candidates, p.breaks, p.cellFt]); // eslint-disable-line react-hooks/exhaustive-deps

  // rank badges for the reviewed list
  useEffect(() => {
    const Lf = L.current, gr = g.current;
    if (!Lf || !gr) return;
    gr.labels.clearLayers();
    const at = new Map(p.candidates.map((c) => [c.id, c]));
    for (const { id, n } of p.labels) {
      const c = at.get(id);
      if (!c) continue;
      Lf.marker([c.lat, c.lon], { icon: Lf.divIcon({ className: "rk", html: `<span>${Number(n)}</span>`, iconSize: [22, 22], iconAnchor: [11, 26] }), keyboard: false })
        .on("click", () => cb.current.onSelect(id)).addTo(gr.labels);
    }
  }, [ready, p.labels, p.candidates]);

  useEffect(() => {
    const Lf = L.current, gr = g.current, m = map.current;
    if (!Lf || !gr || !m) return;
    gr.sel.clearLayers();
    const c = p.selected ? p.candidates.find((x) => x.id === p.selected) : null;
    if (!c) return;
    Lf.circleMarker([c.lat, c.lon], { radius: 12, color: SEL, weight: 2.5, fill: false, interactive: false }).addTo(gr.sel);
    if (!m.getBounds().contains([c.lat, c.lon])) m.panTo([c.lat, c.lon]);
  }, [ready, p.selected, p.candidates]);

  const steps = p.breaks.length;
  const lo = (i: number) => (i === 0 ? null : p.breaks[i - 1]);
  // One decimal when whole thousands would make two bin edges read the same (narrow ranges).
  const fine = p.breaks.some((b, i) => i > 0 && fmtK(b) === fmtK(p.breaks[i - 1]));
  const k = (v: number) => (fine ? `${(v / 1000).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}k` : fmtK(v));
  return (
    <>
      <div className="smap" ref={el} />
      <div className="legend noprint">
        {steps > 0 && <div style={{ marginBottom: 4 }}>12-month oil P50, ranked locations:
          {p.breaks.map((b, i) => <span key={i} className="sw"><i style={{ background: P50_RAMP[i + (5 - steps)] }} />{lo(i) === null ? `≤ ${k(b)}` : `${k(lo(i)!)}–${k(b)}`}</span>)}
        </div>}
        <span className="sw"><i className="hollow" />not ranked</span>
        <span className="sw"><i style={{ background: WELL }} />attributable well</span>
        <span className="sw"><i style={{ background: GAP }} />coverage gap (not used)</span>
        {p.mode === "polygon" && <b style={{ marginLeft: 8, color: SEL }}>Click to add corners · double-click or Finish to close · Esc cancels</b>}
        {p.mode === "point" && <b style={{ marginLeft: 8, color: SEL }}>Click to drop pins · Done when finished</b>}
      </div>
    </>
  );
}
