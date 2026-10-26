"use client";
import { useEffect, useState } from "react";
import { terminalRate, ECON_LIMIT } from "@/lib/arps";
import { fmtInt, fmtK, fmtYm } from "@/lib/engine";
import { loadMonthly } from "@/lib/load";
import type { Wells } from "@/lib/types";

export default function WellChart({ W, idx, onClose }: { W: Wells; idx: number; onClose: () => void }) {
  const [s, setS] = useState<{ oil: number[]; mop: number[]; ym: number[] } | null>(null);
  useEffect(() => { setS(null); loadMonthly(W.county[idx]).then((m) => setS(m[W.api10[idx]] ?? null)); }, [W, idx]);
  const w = 420, h = 200, pl = 44, pb = 22;
  const qi = W.qi[idx], Di = W.Di[idx], b = W.b[idx], pk = W.peak_mop[idx];
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
          <b>{W.lease[idx]} {W.well_no[idx]}</b> <span className="mut small">API {W.api10[idx]}</span>
          <div className="small mut">{W.operator[idx]} · {W.field[idx]} · {W.county[idx]} · first prod {fmtYm(W.first[idx])} · {fmtInt(W.lat_ft[idx])} ft</div>
        </div>
        <button className="btn sm ghost" onClick={onClose}>×</button>
      </div>
      <svg width={w} height={h} style={{ display: "block", marginTop: 6 }}>
        {ticks.map((t) => (<g key={t}><line x1={pl} x2={w - 8} y1={Y(t)} y2={Y(t)} stroke="#24314f" /><text x={pl - 4} y={Y(t) + 3} fontSize={10} fill="#93a1bd" textAnchor="end">{t >= 1000 ? `${t / 1000}k` : t}</text></g>))}
        {[12, 24, 36, 48, 60, 72, 84, 96, 108, 120, 132, 144, 156].filter((m) => m <= horizon).map((m) => <text key={m} x={X(m)} y={h - 6} fontSize={10} fill="#93a1bd" textAnchor="middle">{m}</text>)}
        {fit.length > 1 && <polyline fill="none" stroke="#f5a524" strokeWidth={2} strokeDasharray={undefined} points={fit.filter((p) => p[0] <= maxM).map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")} />}
        {fit.length > 1 && <polyline fill="none" stroke="#f5a524" strokeWidth={2} strokeDasharray="4 3" points={fit.filter((p) => p[0] >= maxM).map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")} />}
        {pts.map((p, i) => <circle key={i} cx={X(p[0])} cy={Y(p[1])} r={2} fill="#38bdf8" />)}
        {!s && <text x={w / 2} y={h / 2} fill="#93a1bd" textAnchor="middle" fontSize={12}>loading monthly RRC volumes…</text>}
      </svg>
      <div className="small mut">Blue: reported monthly oil (bbl, log scale, x = producing month). Orange: Arps fit; dashed = forecast to {ECON_LIMIT} bbl/mo.</div>
      <div className="small" style={{ marginTop: 4 }}>
        Cum {fmtK(W.cum_oil[idx])} · 12-mo {fmtK(W.cum12[idx])} · EUR {fmtK(W.eur[idx])} · remaining {fmtK(W.rem[idx])} · qi {fmtInt(W.qi[idx])} · Di {W.Di[idx]?.toFixed(2) ?? "—"}/yr · b {W.b[idx]?.toFixed(2) ?? "—"} · R² {W.r2[idx]?.toFixed(2) ?? "—"} <span className={`badge b-${W.conf[idx]}`}>{W.conf[idx]}</span>
      </div>
    </div>
  );
}
