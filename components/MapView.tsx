"use client";
import { useEffect, useRef, useState } from "react";
import type * as LT from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Horizontals, Wells } from "@/lib/types";

const CL: Record<string, string> = { Steep: "#f87171", Moderate: "#f5a524", Mild: "#34d399", "Not fitted": "#64748b" };

interface Props {
  W: Wells; H: Horizontals; target: { lat: number; lon: number } | null; radiusMi: number;
  offsetIdx: number[]; selected: number | null;
  onPick: (lat: number, lon: number) => void; onSelect: (idx: number) => void;
}

export default function MapView({ W, H, target, radiusMi, offsetIdx, selected, onPick, onSelect }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const L = useRef<typeof LT | null>(null);
  const map = useRef<LT.Map | null>(null);
  const dyn = useRef<LT.LayerGroup | null>(null);
  const [ready, setReady] = useState(false);
  const cb = useRef({ onPick, onSelect });
  cb.current = { onPick, onSelect };

  useEffect(() => {
    let alive = true;
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
        if (H.code[i] === 0 || H.lat[i] == null || H.lon[i] == null) continue;
        Lf.circleMarker([H.lat[i], H.lon[i]], { renderer: rend, radius: 1.6, stroke: false, fillColor: "#a78bfa", fillOpacity: 0.35, interactive: false }).addTo(gaps);
      }
      const usable = Lf.layerGroup();
      for (let i = 0; i < W.n; i++) {
        const c = Lf.circleMarker([W.lat[i], W.lon[i]], { renderer: rend, radius: 2.6, stroke: false, fillColor: CL[W.cluster[i]] ?? "#64748b", fillOpacity: 0.85 });
        c.on("click", (e) => { Lf.DomEvent.stopPropagation(e); cb.current.onSelect(i); });
        c.bindTooltip(`${W.lease[i]} ${W.well_no[i]} · ${W.operator[i]}`, { direction: "top" });
        c.addTo(usable);
      }
      gaps.addTo(m); usable.addTo(m);
      Lf.control.layers({ "Dark (Esri)": dark, "Streets (OpenStreetMap)": osm, "Satellite (Esri)": sat }, { "Attributable horizontals (used)": usable, "Coverage gaps (not attributable)": gaps }, { position: "topleft" }).addTo(m);
      dyn.current = Lf.layerGroup().addTo(m);
      m.on("click", (e: LT.LeafletMouseEvent) => cb.current.onPick(e.latlng.lat, e.latlng.lng));
      map.current = m;
      setReady(true);
      setTimeout(() => m.invalidateSize(), 50);
      setTimeout(() => m.invalidateSize(), 500);
      window.addEventListener("resize", () => m.invalidateSize());
    });
    return () => { alive = false; };
  }, [W, H]);

  useEffect(() => {
    const Lf = L.current, m = map.current, g = dyn.current;
    if (!Lf || !m || !g) return;
    g.clearLayers();
    if (!target) return;
    Lf.circle([target.lat, target.lon], { radius: radiusMi * 1609.344, color: "#f5a524", weight: 1.5, fillOpacity: 0.05, interactive: false }).addTo(g);
    for (const i of offsetIdx) {
      Lf.polyline([[W.slat[i], W.slon[i]], [W.blat[i], W.blon[i]]], { color: CL[W.cluster[i]] ?? "#94a3b8", weight: i === selected ? 4 : 2, opacity: 0.9, interactive: false }).addTo(g);
    }
    if (selected !== null) Lf.circleMarker([W.lat[selected], W.lon[selected]], { radius: 8, color: "#38bdf8", weight: 2, fill: false, interactive: false }).addTo(g);
    Lf.circleMarker([target.lat, target.lon], { radius: 7, color: "#111", weight: 2, fillColor: "#f5a524", fillOpacity: 1, interactive: false }).addTo(g);
  }, [ready, W, target, radiusMi, offsetIdx, selected]);

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
        Decline cluster:<span style={{ background: CL.Steep }} />Steep<span style={{ background: CL.Moderate }} />Moderate<span style={{ background: CL.Mild }} />Mild<span style={{ background: CL["Not fitted"] }} />Not fitted
        <span style={{ background: "#a78bfa" }} />Coverage gap · sticks = SHL→BHL · click map to drop a pin
      </div>
    </>
  );
}
