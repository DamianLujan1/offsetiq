"use client";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { analyze, CSV_COLUMNS, DEFAULT_VINTAGE, fmtInt, fmtK, fmtYm, summarize, toCsv, type Filters, type OffsetRow, type Target } from "@/lib/engine";
import { loadAll, type Bundle } from "@/lib/load";
import WellChart from "./WellChart";

const MapView = dynamic(() => import("./MapView"), { ssr: false, loading: () => <div className="mut" style={{ padding: 20 }}>Loading map…</div> });

const norm = (s: string) => s.replace(/[^0-9]/g, "");

function Band({ label, b, actual, unit = "bbl" }: { label: string; b: { p10: number; p50: number; p90: number }; actual?: number | null; unit?: string }) {
  const lo = Math.min(b.p10, actual ?? b.p10) * 0.8, hi = Math.max(b.p90, actual ?? b.p90) * 1.1;
  const X = (v: number) => `${((v - lo) / (hi - lo)) * 100}%`;
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="small mut">{label}</div>
      <div className="big">{fmtK(b.p50)} <span className="small mut">{unit} (P50)</span></div>
      <div className="bar"><i style={{ left: X(b.p10), width: `calc(${X(b.p90)} - ${X(b.p10)})` }} /><b style={{ left: X(b.p50) }} />{actual != null && <u style={{ left: X(actual) }} title="actual" />}</div>
      <div className="rng">P10 {fmtK(b.p10)} · P90 {fmtK(b.p90)}{actual != null && <> · <span style={{ color: "var(--good)" }}>actual {fmtK(actual)} ({((b.p50 / actual - 1) * 100).toFixed(0)}% error)</span></>}</div>
    </div>
  );
}

export default function Analyzer() {
  const sp = useSearchParams();
  const router = useRouter();
  const [B, setB] = useState<Bundle | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"pin" | "api" | "lease">("pin");
  const [target, setTarget] = useState<Target | null>(null);
  const [latIn, setLatIn] = useState(""); const [lonIn, setLonIn] = useState("");
  const [lateral, setLateral] = useState(10000);
  const [radius, setRadius] = useState(3);
  const [minLat, setMinLat] = useState(""); const [maxLat, setMaxLat] = useState(""); const [op, setOp] = useState("");
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [sort, setSort] = useState<{ k: keyof OffsetRow; d: 1 | -1 }>({ k: "dist_mi", d: 1 });

  useEffect(() => { loadAll().then(setB).catch((e) => setErr(String(e))); }, []);

  // restore from shareable URL
  useEffect(() => {
    if (!B) return;
    const r = Number(sp.get("r")); if (r > 0 && r <= 10) setRadius(r);
    if (sp.get("min")) setMinLat(sp.get("min")!); if (sp.get("max")) setMaxLat(sp.get("max")!);
    const api = sp.get("api");
    if (api) { pickApi(api, sp.get("mode") === "prospect" ? "prospect" : "backtest"); return; }
    const lat = Number(sp.get("lat")), lon = Number(sp.get("lon")), lf = Number(sp.get("lat_ft")) || 10000;
    if (lat && lon) { setLateral(lf); setLatIn(String(lat)); setLonIn(String(lon)); setTarget({ lat, lon, lateralFt: lf, vintageYear: DEFAULT_VINTAGE, mode: "prospect", label: `Pin ${lat.toFixed(4)}, ${lon.toFixed(4)}` }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [B]);

  function share(t: Target, extra: Record<string, string> = {}) {
    const p = new URLSearchParams();
    if (t.mode === "backtest" && t.wellIdx !== undefined && B) { p.set("api", B.W.api10[t.wellIdx]); }
    else { p.set("lat", t.lat.toFixed(6)); p.set("lon", t.lon.toFixed(6)); p.set("lat_ft", String(Math.round(t.lateralFt))); }
    p.set("r", String(radius)); if (minLat) p.set("min", minLat); if (maxLat) p.set("max", maxLat);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    router.replace(`/analyze?${p.toString()}`, { scroll: false });
  }
  function setPin(lat: number, lon: number, lf = lateral) {
    const t: Target = { lat, lon, lateralFt: lf, vintageYear: DEFAULT_VINTAGE, mode: "prospect", label: `Pin ${lat.toFixed(4)}, ${lon.toFixed(4)}` };
    setLatIn(lat.toFixed(5)); setLonIn(lon.toFixed(5)); setTarget(t); setSel(null); setMsg(null); share(t);
  }
  function backtest(i: number) {
    if (!B) return;
    const W = B.W;
    const t: Target = { lat: W.lat[i], lon: W.lon[i], lateralFt: W.lat_ft[i], vintageYear: Math.floor(W.first[i] / 100), mode: "backtest", wellIdx: i, label: `${W.lease[i]} ${W.well_no[i]} (API ${W.api10[i]})` };
    setLateral(Math.round(W.lat_ft[i])); setTarget(t); setSel(null); share(t);
  }
  function pickApi(raw: string, mode: "backtest" | "prospect" = "backtest") {
    if (!B) return;
    let a = norm(raw); if (a.length === 8) a = "42" + a; if (a.length === 14) a = a.slice(0, 10);
    const i = B.W.api10.indexOf(a);
    if (i >= 0) {
      if (mode === "backtest") { backtest(i); setMsg(`Found ${B.W.lease[i]} ${B.W.well_no[i]} — running a blind backtest (only offsets online before ${fmtYm(B.W.first[i])}). Use "Use as pin" for a forward-looking view.`); }
      else { setLateral(Math.round(B.W.lat_ft[i])); setPin(B.W.lat[i], B.W.lon[i], B.W.lat_ft[i]); }
      return;
    }
    const h = B.H.api10.indexOf(a);
    if (h >= 0) {
      const lf = B.H.lat_ft[h] ?? 10000; setLateral(Math.round(lf)); setPin(B.H.lat[h], B.H.lon[h], lf);
      setMsg(`API ${a} is an RRC horizontal but its production is not attributable (${B.H.labels[B.H.code[h]]}). Treated as a prospect location at its lateral midpoint.`);
      return;
    }
    setMsg(`API ${raw} not found among ${B.H.api10.length.toLocaleString()} RRC horizontals in Andrews/Ector/Midland/Martin. OffsetIQ never invents wells.`);
  }

  const filters: Filters = { radiusMi: radius, minLatFt: minLat ? Number(minLat) : null, maxLatFt: maxLat ? Number(maxLat) : null, operator: op };
  const res = useMemo(() => {
    if (!B || !target) return null;
    const t = target.mode === "prospect" ? { ...target, lateralFt: lateral } : target;
    return analyze(B.W, B.H, B.M, t, filters, B.MH);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [B, target, lateral, radius, minLat, maxLat, op]);

  const rows = useMemo(() => {
    if (!res) return [];
    const r = [...res.offsets];
    r.sort((a, b) => {
      const x = a[sort.k], y = b[sort.k];
      if (x === null && y === null) return 0; if (x === null) return 1; if (y === null) return -1; // nulls always last, never ranked
      return (x < y ? -1 : x > y ? 1 : 0) * sort.d;
    });
    return r;
  }, [res, sort]);

  const offIdx = useMemo(() => (res ? res.offsets.map((o) => o.idx) : []), [res]);
  const leaseHits = useMemo(() => {
    if (!B || q.length < 3 || tab !== "lease") return [];
    const s = q.toLowerCase(); const out: number[] = [];
    for (let i = 0; i < B.W.n && out.length < 25; i++) if (B.W.lease[i].toLowerCase().includes(s) || B.W.lease_no[i].includes(q)) out.push(i);
    return out;
  }, [B, q, tab]);

  const meta = B?.meta;
  const summary = res && meta ? summarize(res, radius, { last_complete_month: meta.last_complete_month, cum12MedApe: meta.model.targets.cum12.lightgbm_holdout!.median_ape, eurMedApe: meta.model.targets.eur.lightgbm_holdout!.median_ape }) : "";

  function downloadCsv() {
    if (!res) return;
    const blob = new Blob([toCsv(res)], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = `offsetiq_${res.target.mode}_${res.target.lat.toFixed(4)}_${res.target.lon.toFixed(4)}.csv`; a.click();
  }
  const th = (k: keyof OffsetRow, label: string, l = false) => (
    <th className={l ? "l" : ""} onClick={() => setSort((s) => ({ k, d: s.k === k ? (s.d === 1 ? -1 : 1) : (k === "dist_mi" ? 1 : -1) }))}>{label}{sort.k === k ? (sort.d === 1 ? " ▲" : " ▼") : ""}</th>
  );

  if (err) return <div className="wrap"><div className="warn">Failed to load data: {err}</div></div>;
  if (!B) return <div className="wrap mut">Loading 4,700+ RRC wells, coverage layer and model…</div>;

  return (
    <div className="app">
      <aside className="side">
        <div className="printonly"><h2 style={{ marginTop: 0 }}>OffsetIQ report</h2><div className="small">{new Date().toISOString().slice(0, 10)} · offsetiq · Texas RRC public data</div></div>
        <div className="tabs noprint">
          <button className={tab === "pin" ? "on" : ""} onClick={() => setTab("pin")}>Map / lat-lon</button>
          <button className={tab === "api" ? "on" : ""} onClick={() => setTab("api")}>API #</button>
          <button className={tab === "lease" ? "on" : ""} onClick={() => setTab("lease")}>Lease</button>
        </div>
        <div className="noprint">
          {tab === "pin" && (<>
            <div className="small mut" style={{ marginBottom: 6 }}>Click the map, or enter the planned lateral midpoint (NAD83):</div>
            <div className="row"><div><label>Lat</label><input value={latIn} onChange={(e) => setLatIn(e.target.value)} placeholder="31.95" /></div><div><label>Lon</label><input value={lonIn} onChange={(e) => setLonIn(e.target.value)} placeholder="-102.05" /></div></div>
            <button className="btn sm" style={{ marginTop: 8 }} onClick={() => { const a = Number(latIn), b = Number(lonIn); if (Number.isFinite(a) && Number.isFinite(b) && a && b) setPin(a, b); }}>Analyze location</button>
          </>)}
          {tab === "api" && (<>
            <label>RRC API (8, 10 or 14 digits)</label>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="42-317-43171" onKeyDown={(e) => e.key === "Enter" && pickApi(q)} />
            <div className="row" style={{ marginTop: 8 }}><button className="btn sm" onClick={() => pickApi(q)}>Backtest well</button><button className="btn sm ghost" onClick={() => pickApi(q, "prospect")}>Use as pin</button></div>
          </>)}
          {tab === "lease" && (<>
            <label>Lease name or RRC lease # (district-lease)</label>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. SCHARBAUER, 08-" />
            <div style={{ maxHeight: 180, overflow: "auto", marginTop: 6 }}>
              {leaseHits.map((i) => <div key={i} className="small" style={{ padding: "4px 0", borderBottom: "1px solid var(--line)", cursor: "pointer" }} onClick={() => { backtest(i); }}><b>{B.W.lease[i]} {B.W.well_no[i]}</b> <span className="mut">· {B.W.operator[i]} · {B.W.county[i]} · {B.W.api10[i]}</span></div>)}
              {q.length >= 3 && !leaseHits.length && <div className="small mut">No attributable single-well lease matches. Multi-well leases are not shown (production not allocable per well).</div>}
            </div>
          </>)}
          {msg && <div className="warn">{msg}</div>}
          <div className="row" style={{ marginTop: 12 }}>
            <div><label>Lateral (ft)</label><input type="number" value={lateral} disabled={target?.mode === "backtest"} onChange={(e) => setLateral(Number(e.target.value) || 0)} /></div>
            <div><label>Radius (mi)</label><select value={radius} onChange={(e) => setRadius(Number(e.target.value))}>{[1, 1.5, 2, 3, 4, 5, 7.5, 10].map((v) => <option key={v} value={v}>{v}</option>)}</select></div>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <div><label>Offset lateral min</label><input value={minLat} onChange={(e) => setMinLat(e.target.value.replace(/[^0-9]/g, ""))} placeholder="ft" /></div>
            <div><label>max</label><input value={maxLat} onChange={(e) => setMaxLat(e.target.value.replace(/[^0-9]/g, ""))} placeholder="ft" /></div>
            <div><label>Operator</label><input value={op} onChange={(e) => setOp(e.target.value)} placeholder="any" /></div>
          </div>
          <div className="small mut" style={{ marginTop: 6 }}>Bench/target formation is not in public RRC production data; RRC field name is shown instead. Lateral = SHL→BHL displacement from RRC well layer (proxy).</div>
        </div>

        {!res && <div className="card" style={{ marginTop: 14 }}><h3>Start here</h3><div className="small mut">Drop a pin anywhere in Midland, Ector, Andrews or Martin County — or try a blind backtest on a real well:</div>
          <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
            <button className="btn sm ghost" onClick={() => pickApi("4232944570")}>Backtest: Midland Co. well (out-of-sample)</button>
            <button className="btn sm ghost" onClick={() => pickApi("4231743553")}>Backtest: Martin Co. well, 90+ offsets</button>
            <button className="btn sm ghost" onClick={() => pickApi("4200348372")}>Backtest: Andrews Co. well</button>
            <button className="btn sm ghost" onClick={() => { const c: number[] = []; for (let i = 0; i < B.W.n; i++) if (B.W.first[i] >= 202201 && B.W.cum12[i] !== null) c.push(i); backtest(c[Math.floor(Math.random() * c.length)]); setMsg("Random 2022+ well — no cherry-picking. Typical holdout error is ~20% (12-mo oil) and ~32% (EUR)."); }}>🎲 Random out-of-sample well</button>
            <button className="btn sm ghost" onClick={() => setPin(31.86, -102.20)}>Prospect pin: Midland County</button>
          </div></div>}

        {res && (<>
          <div className="fc">
            <div className="small" style={{ marginBottom: 6 }}><b>{res.target.mode === "backtest" ? (res.sample === "out_of_sample" ? "Blind backtest · out-of-sample" : "Backtest · in-sample") : "Forecast"}</b> · {res.target.label}<br /><span className="mut">{res.county || "?"} County · {fmtInt(res.target.lateralFt)} ft · {res.modelOffsets} model offsets ≤ 3 mi{res.target.mode === "backtest" ? ` known before ${fmtYm(res.actual!.first)}` : ""}</span></div>
            <Band label="First-12-month oil (LightGBM)" b={res.cum12} actual={res.actual?.cum12} />
            <Band label="Oil EUR (LightGBM, vs Arps-DCA targets)" b={res.eur} actual={res.actual && res.actual.conf !== "none" ? res.actual.eur : undefined} />
            {res.analogEur && <div className="small">Offset-analog EUR: <b>{fmtK(res.analogEur.value)}</b> bbl <span className="mut">(IDW EUR/1,000 ft of {res.analogEur.n} fitted offsets × lateral)</span></div>}
            <div className="small mut" style={{ marginTop: 6 }}>Computed in {res.ms.toFixed(0)} ms in your browser. Screening estimate, not a reserves report.</div>
          </div>
          {res.warnings.map((w, i) => <div key={i} className="warn">{w}</div>)}
          {res.excludedNearby.length > 0 && <div className="gap"><b>Coverage gaps within {radius} mi</b> (RRC horizontals present but not used):<ul style={{ margin: "4px 0 0 16px", padding: 0 }}>{res.excludedNearby.map((e) => <li key={e.label}>{e.count} — {e.label.replace(/^Excluded: /, "")}</li>)}</ul></div>}
          <h3 style={{ marginTop: 12 }}>Plain-English read</h3>
          <div className="para">{summary}</div>
          <div className="row noprint" style={{ marginTop: 10 }}>
            <button className="btn sm" onClick={downloadCsv}>Export CSV</button>
            <button className="btn sm ghost" onClick={() => window.print()}>Print / PDF</button>
            <button className="btn sm ghost" onClick={() => { navigator.clipboard?.writeText(location.href); setMsg("Shareable link copied."); }}>Copy link</button>
          </div>
          <div className="small mut" style={{ marginTop: 12 }}>Sources: Texas Railroad Commission PDQ production dump ({meta?.pdq_dump_date}; months through {fmtYm(meta!.last_complete_month)}) and RRC digital map well layers. <a href="/data">Data &amp; model card →</a></div>
        </>)}
      </aside>
      <section className="main">
        <div className="mapbox">
          <MapView W={B.W} H={B.H} target={res ? { lat: res.target.lat, lon: res.target.lon } : null} radiusMi={radius} offsetIdx={offIdx} selected={sel} onPick={(a, b) => setPin(a, b)} onSelect={(i) => setSel(i)} />
          {sel !== null && <WellChart W={B.W} idx={sel} onClose={() => setSel(null)} />}
        </div>
        <div className="tablebox">
          {res ? (<>
            <div className="toolbar small"><b>{rows.length} offsets</b><span className="mut">within {radius} mi · sorted by {CSV_COLUMNS.find((c) => c[0] === sort.k)?.[1] ?? sort.k} · “—” = not available (insufficient history), always sorted last · click a row for its decline curve</span></div>
            <table>
              <thead><tr>{th("lease", "Lease / well", true)}{th("operator", "Operator", true)}{th("api10", "API", true)}{th("dist_mi", "Dist mi")}{th("lateral_ft", "Lat ft")}{th("first_prod", "1st prod")}{th("months", "Mo")}{th("cum_oil", "Cum oil")}{th("cum12", "12-mo")}{th("Di_annual", "Di/yr")}{th("b", "b")}{th("eur", "EUR")}{th("remaining", "Remain")}{th("eur_per_kft", "EUR/kft")}{th("cluster", "Cluster", true)}{th("confidence", "Conf", true)}{th("field", "RRC field", true)}</tr></thead>
              <tbody>{rows.map((o) => (
                <tr key={o.idx} className={o.idx === sel ? "sel" : ""} onClick={() => setSel(o.idx)}>
                  <td className="l">{o.lease} {o.well_no}</td><td className="l">{o.operator.slice(0, 26)}</td><td className="l">{o.api10}</td>
                  <td>{o.dist_mi.toFixed(2)}</td><td>{fmtInt(o.lateral_ft)}</td><td>{fmtYm(o.first_prod)}</td><td>{o.months}</td>
                  <td>{fmtInt(o.cum_oil)}</td><td>{fmtInt(o.cum12)}</td><td>{o.Di_annual?.toFixed(2) ?? "—"}</td><td>{o.b?.toFixed(2) ?? "—"}</td>
                  <td>{fmtInt(o.eur)}</td><td>{fmtInt(o.remaining)}</td><td>{fmtInt(o.eur_per_kft)}</td><td className="l">{o.cluster}</td>
                  <td className="l"><span className={`badge b-${o.confidence}`}>{o.confidence}</span></td><td className="l">{o.field.slice(0, 24)}</td>
                </tr>))}</tbody>
            </table>
            {!rows.length && <div className="mut" style={{ padding: 14 }}>No attributable offsets within {radius} mi. Increase the radius — and see coverage gaps at left.</div>}
          </>) : <div className="mut" style={{ padding: 14 }}>Offsets will appear here.</div>}
        </div>
      </section>
    </div>
  );
}
