"use client";
import { useEffect, useState } from "react";
import { terminalRate, ECON_LIMIT } from "@/lib/arps";
import { fmtInt, fmtK, fmtYm } from "@/lib/engine";
import { loadMonthly } from "@/lib/load";
import type { Wells } from "@/lib/types";

export default function WellChart({ W, idx, onClose }: { W: Wells; idx: number; onClose: () => void }) {
  const [s, setS] = useState<{ oil: number[]; mop: number[]; ym: number[] } | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "missing" | "error">("loading");
  useEffect(() => {
    let alive = true; // ignore responses for a well that is no longer selected
    setS(null); setState("loading");
    loadMonthly(W.county[idx])
      .then((m) => { if (!alive) return; const v = m[W.api10[idx]] ?? null; setS(v); setState(v ? "ok" : "missing"); })
      .catch(() => { if (alive) setState("error"); });
    return () => { alive = false; };
  }, [W, idx]);
  const w = 420, h = 180, pl = 44, pb = 22;
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
  const stat = (k: string, v: React.ReactNode) => <div><dt>{k}</dt><dd>{v}</dd></div>;
  return (
    <div className="chart">
      <div className="chart-head">
        <div>
          <div className="chart-title">{W.lease[idx]} {W.well_no[idx]}</div>
          <div className="small mut">API <span className="mono">{W.api10[idx]}</span> · {W.operator[idx]}</div>
          <div className="small mut">{W.field[idx]} · {W.county[idx]} · first prod {fmtYm(W.first[idx])} · {fmtInt(W.lat_ft[idx])} ft</div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close decline curve">×</button>
      </div>
      <div className="chart-legend">
        <span><i className="obs" />Reported monthly oil</span><span><i className="fit" />Arps fit</span><span><i className="fc" />Forecast to {ECON_LIMIT} bbl/mo</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Monthly oil and Arps decline fit for ${W.lease[idx]} ${W.well_no[idx]}`}>
        {ticks.map((t) => (<g key={t}><line className="grid" x1={pl} x2={w - 8} y1={Y(t)} y2={Y(t)} /><text className="tick" x={pl - 6} y={Y(t) + 3} textAnchor="end">{t >= 1000 ? `${t / 1000}k` : t}</text></g>))}
        {[12, 24, 36, 48, 60, 72, 84, 96, 108, 120, 132, 144, 156].filter((m) => m <= horizon).map((m) => <text key={m} className="tick" x={X(m)} y={h - 6} textAnchor="middle">{m}</text>)}
        {fit.length > 1 && <polyline className="fit" points={fit.filter((p) => p[0] <= maxM).map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")} />}
        {fit.length > 1 && <polyline className="fit" strokeDasharray="4 3" points={fit.filter((p) => p[0] >= maxM).map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")} />}
        {pts.map((p, i) => <circle key={i} className="obs" cx={X(p[0])} cy={Y(p[1])} r={2} />)}
        {!s && <text className="msg" x={w / 2} y={h / 2} textAnchor="middle">{state === "loading" ? "Loading monthly RRC volumes…" : state === "missing" ? "No monthly RRC volumes for this well" : "Could not load monthly RRC volumes"}</text>}
      </svg>
      <div className="small mut">bbl/month, log scale · x = producing month</div>
      <dl className="stats">
        {stat("Cum oil", fmtK(W.cum_oil[idx]))}{stat("12-mo", fmtK(W.cum12[idx]))}{stat("EUR", fmtK(W.eur[idx]))}{stat("Remaining", fmtK(W.rem[idx]))}
        {stat("qi", fmtInt(W.qi[idx]))}{stat("Di", `${W.Di[idx]?.toFixed(2) ?? "—"}/yr`)}{stat("b", W.b[idx]?.toFixed(2) ?? "—")}{stat("R²", W.r2[idx]?.toFixed(2) ?? "—")}
        {stat("Confidence", <span className={`badge b-${W.conf[idx]}`}>{W.conf[idx]}</span>)}
      </dl>
    </div>
  );
}
