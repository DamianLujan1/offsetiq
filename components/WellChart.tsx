"use client";
import { useEffect, useState } from "react";
import { terminalRate, ECON_LIMIT } from "@/lib/arps";
import { fmtInt, fmtK, fmtYm } from "@/lib/engine";
import { loadMonthly, loadPadMonthly } from "@/lib/load";
import type { Pads, Wells } from "@/lib/types";

export type Sel = { kind: "well" | "pad"; idx: number };

/** Decline chart for a single well (well-level RRC volumes) or a multi-well pad (lease-level RRC volumes). */
export default function WellChart({ W, P, sel, onClose }: { W: Wells; P: Pads; sel: Sel; onClose: () => void }) {
  const pad = sel.kind === "pad", idx = sel.idx;
  const D = pad
    ? { key: P.id[idx], county: P.county[idx], qi: P.qi[idx], Di: P.Di[idx], b: P.b[idx], pk: P.peak_mop[idx], cum: P.cum_oil[idx], c12: P.cum12[idx], eur: P.eur[idx], rem: P.rem[idx], r2: P.r2[idx], conf: P.conf[idx],
        title: `${P.lease[idx]} — pad (${P.wells[idx]} wells)`, id: `RRC lease ${P.id[idx]}`, op: P.operator[idx], field: P.field[idx], first: P.first[idx], lat: P.lat_ft[idx] }
    : { key: W.api10[idx], county: W.county[idx], qi: W.qi[idx], Di: W.Di[idx], b: W.b[idx], pk: W.peak_mop[idx], cum: W.cum_oil[idx], c12: W.cum12[idx], eur: W.eur[idx], rem: W.rem[idx], r2: W.r2[idx], conf: W.conf[idx],
        title: `${W.lease[idx]} ${W.well_no[idx]}`, id: `API ${W.api10[idx]}`, op: W.operator[idx], field: W.field[idx], first: W.first[idx], lat: W.lat_ft[idx] };
  const [s, setS] = useState<{ oil: number[]; mop: number[]; ym: number[] } | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "missing" | "error">("loading");
  useEffect(() => {
    let alive = true; // ignore responses for a well that is no longer selected
    setS(null); setState("loading");
    (pad ? loadPadMonthly() : loadMonthly(D.county))
      .then((m) => { if (!alive) return; const v = m[D.key] ?? null; setS(v); setState(v ? "ok" : "missing"); })
      .catch(() => { if (alive) setState("error"); });
    return () => { alive = false; };
  }, [pad, D.key, D.county]);
  const w = 420, h = 200, pl = 44, pb = 22;
  const { qi, Di, b, pk } = D;
  let fit: [number, number][] = [];
  const maxM = s ? Math.max(...s.mop) : 1;
  const horizon = Math.max(maxM + 36, 60);
  if (qi !== null && Di !== null && b !== null && pk !== null) {
    for (let m = pk; m <= horizon; m++) { const q = terminalRate(m - pk + 1, qi, Di / 12, b); if (q < ECON_LIMIT) break; fit.push([m, q]); }
  }
  const pts = s ? s.mop.map((m, i) => [m, s.oil[i]] as [number, number]).filter((p) => p[1] > 0) : [];
  const all = [...pts.map((p) => p[1]), ...fit.map((p) => p[1])];
  const ymax = Math.max(1000, ...all), ymin = 100;
  const X = (m: number) => pl + ((m - 1) / (horizon - 1)) * (w - pl - 8);
  const Y = (q: number) => 6 + (1 - (Math.log10(Math.max(q, ymin)) - Math.log10(ymin)) / (Math.log10(ymax) - Math.log10(ymin))) * (h - pb - 6);
  const ticks = [100, 1000, 10000, 100000].filter((t) => t <= ymax * 1.01);
  return (
    <div className="chart">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
        <div>
          <b>{D.title}</b> <span className="mut small">{D.id}</span>
          <div className="small mut">{D.op} · {D.field} · {D.county} · first prod {fmtYm(D.first)} · {fmtInt(D.lat)} ft{pad ? " total lateral" : ""}</div>
        </div>
        <button className="btn sm ghost" onClick={onClose}>×</button>
      </div>
      <svg width={w} height={h} style={{ display: "block", marginTop: 6 }}>
        {ticks.map((t) => (<g key={t}><line x1={pl} x2={w - 8} y1={Y(t)} y2={Y(t)} stroke="#24314f" /><text x={pl - 4} y={Y(t) + 3} fontSize={10} fill="#93a1bd" textAnchor="end">{t >= 1000 ? `${t / 1000}k` : t}</text></g>))}
        {[12, 24, 36, 48, 60, 72, 84, 96, 108, 120, 132, 144, 156].filter((m) => m <= horizon).map((m) => <text key={m} x={X(m)} y={h - 6} fontSize={10} fill="#93a1bd" textAnchor="middle">{m}</text>)}
        {fit.length > 1 && <polyline fill="none" stroke="#f5a524" strokeWidth={2} strokeDasharray={undefined} points={fit.filter((p) => p[0] <= maxM).map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")} />}
        {fit.length > 1 && <polyline fill="none" stroke="#f5a524" strokeWidth={2} strokeDasharray="4 3" points={fit.filter((p) => p[0] >= maxM).map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")} />}
        {pts.map((p, i) => <circle key={i} cx={X(p[0])} cy={Y(p[1])} r={2} fill="#38bdf8" />)}
        {!s && <text x={w / 2} y={h / 2} fill="#93a1bd" textAnchor="middle" fontSize={12}>{state === "loading" ? "loading monthly RRC volumes…" : state === "missing" ? `no monthly RRC volumes for this ${pad ? "pad" : "well"}` : "could not load monthly RRC volumes"}</text>}
      </svg>
      {pad && <div className="small" style={{ color: "#a5f3fc" }}>Pad = RRC lease total for all {P.wells[idx]} wells (lease-level production; no per-well split). Members: {P.m_api10.filter((_, k) => P.m_pad[k] === idx).join(", ")}</div>}
      <div className="small mut">Blue: reported monthly oil (bbl, log scale, x = producing month). Orange: Arps fit; dashed = forecast to {ECON_LIMIT} bbl/mo.</div>
      <div className="small" style={{ marginTop: 4 }}>
        {pad ? "Pad total: " : ""}Cum {fmtK(D.cum)} · 12-mo {fmtK(D.c12)} · EUR {fmtK(D.eur)} · remaining {fmtK(D.rem)} · qi {fmtInt(D.qi)} · Di {D.Di?.toFixed(2) ?? "—"}/yr · b {D.b?.toFixed(2) ?? "—"} · R² {D.r2?.toFixed(2) ?? "—"} <span className={`badge b-${D.conf}`}>{D.conf}</span>
      </div>
    </div>
  );
}
