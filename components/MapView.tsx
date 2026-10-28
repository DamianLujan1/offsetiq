"use client";
import { useEffect, useRef, useState } from "react";
import type * as LT from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Horizontals, Pads, Wells } from "@/lib/types";
import type { Sel } from "./WellChart";

const PAD = "#22d3ee"; // multi-well pads (lease-level production)

// Keys must match the cluster names written by pipeline/clustering.py.
const CL: Record<string, string> = { "Steep decline": "#f87171", "Moderate decline": "#f5a524", "Mild decline": "#34d399", "Not fitted": "#64748b" };

interface Props {
  W: Wells; H: Horizontals; P: Pads; target: { lat: number; lon: number } | null; radiusMi: number;
  offsetIdx: number[]; padIdx: number[]; selected: Sel | null;
  onPick: (lat: number, lon: number) => void; onSelect: (s: Sel) => void;
}

export default function MapView({ W, H, P, target, radiusMi, offsetIdx, padIdx, selected, onPick, onSelect }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const L = useRef<typeof LT | null>(null);
  const map = useRef<LT.Map | null>(null);
  const dyn = useRef<LT.LayerGroup | null>(null);
  const [ready, setReady] = useState(false);
  const cb = useRef({ onPick, onSelect });
  cb.current = { onPick, onSelect };

  useEffect(() => {
    let alive = true;
    let onResize: (() => void) | null = null;
    import("leaflet").then((mod) => {
      if (!alive || !el.current || map.current) return;
      const Lf = (mod as unknown as { default: typeof LT }).default ?? (mod as unknown as typeof LT);
      L.current = Lf;
      const m = Lf.map(el.current, { preferCanvas: true, zoomControl: true }).setView([32.0, -102.15], 9);
      // Keyless public basemaps only (no Mapbox/Google/CARTO tokens). CARTO now watermarks "API key required", so it is not used.
      const dark = Lf.layerGroup([
        Lf.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", { attribution: "Basemap © Esri, HERE, Garmin, © OpenStreetMap contributors", maxZoom: 16 }),
        Lf.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16 }),
      ]);
      const osm = Lf.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap contributors", maxZoom: 19 });
      const sat = Lf.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { attribution: "Imagery © Esri", maxZoom: 19 });
      dark.addTo(m);
      const rend = Lf.canvas({ padding: 0.5 });
      const gaps = Lf.layerGroup();
      for (let i = 0; i < H.lat.length; i++) {
        if (H.code[i] === 0 || H.code[i] === 7 || H.lat[i] == null || H.lon[i] == null) continue;
        Lf.circleMarker([H.lat[i], H.lon[i]], { renderer: rend, radius: 1.6, stroke: false, fillColor: "#a78bfa", fillOpacity: 0.35, interactive: false }).addTo(gaps);
      }
      const usable = Lf.layerGroup();
      for (let i = 0; i < W.n; i++) {
        const c = Lf.circleMarker([W.lat[i], W.lon[i]], { renderer: rend, radius: 2.6, stroke: false, fillColor: CL[W.cluster[i]] ?? "#64748b", fillOpacity: 0.85 });
        c.on("click", (e) => { Lf.DomEvent.stopPropagation(e); cb.current.onSelect({ kind: "well", idx: i }); });
        c.bindTooltip(`${W.lease[i]} ${W.well_no[i]} · ${W.operator[i]}`, { direction: "top" });
        c.addTo(usable);
      }
      // multi-well pads: square markers (DOM icons), sized by well count
      const pads = Lf.layerGroup();
      for (let j = 0; j < P.n; j++) {
        const sz = Math.min(16, 7 + 1.5 * Math.sqrt(P.wells[j]));
        const mk = Lf.marker([P.lat[j], P.lon[j]], { icon: Lf.divIcon({ className: "padmk", iconSize: [sz, sz] }), keyboard: false });
        mk.on("click", (e) => { Lf.DomEvent.stopPropagation(e); cb.current.onSelect({ kind: "pad", idx: j }); });
        mk.bindTooltip(`${P.lease[j]} · pad (${P.wells[j]} wells) · ${P.operator[j]}`, { direction: "top" });
        mk.addTo(pads);
      }
      gaps.addTo(m); pads.addTo(m); usable.addTo(m);
      Lf.control.layers({ "Dark (Esri)": dark, "Streets (OpenStreetMap)": osm, "Satellite (Esri)": sat }, { "Single-well horizontals (used)": usable, "Multi-well pads (lease-level)": pads, "Coverage gaps (not attributable)": gaps }, { position: "topleft" }).addTo(m);
      dyn.current = Lf.layerGroup().addTo(m);
      m.on("click", (e: LT.LeafletMouseEvent) => cb.current.onPick(e.latlng.lat, e.latlng.lng));
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
      map.current?.remove(); map.current = null; dyn.current = null; L.current = null;
    };
  }, [W, H, P]);

  useEffect(() => {
    const Lf = L.current, m = map.current, g = dyn.current;
    if (!Lf || !m || !g) return;
    g.clearLayers();
    if (!target) return;
    Lf.circle([target.lat, target.lon], { radius: radiusMi * 1609.344, color: "#f5a524", weight: 1.5, fillOpacity: 0.05, interactive: false }).addTo(g);
    const selW = selected?.kind === "well" ? selected.idx : -1, selP = selected?.kind === "pad" ? selected.idx : -1;
    for (const i of offsetIdx) {
      Lf.polyline([[W.slat[i], W.slon[i]], [W.blat[i], W.blon[i]]], { color: CL[W.cluster[i]] ?? "#94a3b8", weight: i === selW ? 4 : 2, opacity: 0.9, interactive: false }).addTo(g);
    }
    const padSet = new Set(padIdx);
    if (selP >= 0) padSet.add(selP);
    if (padSet.size) {
      for (let k = 0; k < P.m_pad.length; k++) {
        const j = P.m_pad[k];
        if (!padSet.has(j)) continue;
        const a = P.m_slat[k], b = P.m_slon[k], c = P.m_blat[k], d = P.m_blon[k];
        if (a === null || b === null || c === null || d === null) continue;
        Lf.polyline([[a, b], [c, d]], { color: PAD, weight: j === selP ? 4 : 2, opacity: 0.9, dashArray: "5 4", interactive: false }).addTo(g);
      }
    }
    if (selW >= 0) Lf.circleMarker([W.lat[selW], W.lon[selW]], { radius: 8, color: "#38bdf8", weight: 2, fill: false, interactive: false }).addTo(g);
    if (selP >= 0) Lf.circleMarker([P.lat[selP], P.lon[selP]], { radius: 10, color: PAD, weight: 2, fill: false, interactive: false }).addTo(g);
    Lf.circleMarker([target.lat, target.lon], { radius: 7, color: "#111", weight: 2, fillColor: "#f5a524", fillOpacity: 1, interactive: false }).addTo(g);
  }, [ready, W, P, target, radiusMi, offsetIdx, padIdx, selected]);

  useEffect(() => {
    const Lf = L.current, m = map.current;
    if (!Lf || !m || !target) return;
    const c = Lf.latLng(target.lat, target.lon).toBounds(radiusMi * 1609.344 * 2);
    m.fitBounds(c, { padding: [20, 20], maxZoom: 13 });
  }, [ready, target?.lat, target?.lon, radiusMi]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div id="map" ref={el} />
      <div className="legend noprint">
        Decline cluster:<span style={{ background: CL["Steep decline"] }} />Steep<span style={{ background: CL["Moderate decline"] }} />Moderate<span style={{ background: CL["Mild decline"] }} />Mild<span style={{ background: CL["Not fitted"] }} />Not fitted
        <span style={{ background: PAD, borderRadius: 2 }} />Multi-well pad (lease total)<span style={{ background: "#a78bfa" }} />Coverage gap · sticks = SHL→BHL · click map to drop a pin
      </div>
    </>
  );
}
