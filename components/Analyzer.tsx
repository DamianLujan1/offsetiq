"use client";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { analyze, CSV_COLUMNS, DEFAULT_VINTAGE, fmtInt, fmtK, fmtYm, summarize, toCsv, type Filters, type OffsetRow, type Target } from "@/lib/engine";
import { loadAll, type Bundle } from "@/lib/load";
import WellChart from "./WellChart";

const MapView = dynamic(() => import("./MapView"), { ssr: false, loading: () => <div className="mut" style={{ padding: 20 }}>Loading map…</div> });

const norm = (s: string) => s.replace(/[^0-9]/g, "");

function Band({ label, note, b, actual, unit = "bbl" }: { label: string; note: string; b: { p10: number; p50: number; p90: number }; actual?: number | null; unit?: string }) {
  const lo = Math.min(b.p10, actual ?? b.p10) * 0.8, hi = Math.max(b.p90, actual ?? b.p90) * 1.1;
  const X = (v: number) => `${((v - lo) / (hi - lo)) * 100}%`;
  const err = actual != null ? (b.p50 / actual - 1) * 100 : null;
  return (
    <div className="metric">
      <div className="metric-label">{label} <span>· {note}</span></div>
      <div className="metric-value">{fmtK(b.p50)}<span>{unit} · P50</span></div>
      <div className="range" aria-hidden="true"><i style={{ left: X(b.p10), width: `calc(${X(b.p90)} - ${X(b.p10)})` }} /><b style={{ left: X(b.p50) }} />{actual != null && <u style={{ left: X(actual) }} />}</div>
      <div className="metric-foot">P10 {fmtK(b.p10)} · P90 {fmtK(b.p90)}{actual != null && err !== null && <> · <span className="act">Actual {fmtK(actual)} ({err > 0 ? "+" : ""}{err.toFixed(0)}% error)</span></>}</div>
    </div>
  );
}

const CLUSTER_CLASS: Record<string, string> = { "Steep decline": "cl-steep", "Moderate decline": "cl-moderate", "Mild decline": "cl-mild", "Not fitted": "cl-unfit" };

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
  const [copied, setCopied] = useState(false);
  const [sort, setSort] = useState<{ k: keyof OffsetRow; d: 1 | -1 }>({ k: "dist_mi", d: 1 });

  useEffect(() => { loadAll().then(setB).catch((e) => setErr(String(e))); }, []);

  // restore from shareable URL
  useEffect(() => {
    if (!B) return;
    const r = Number(sp.get("r")); if (r > 0 && r <= 10) setRadius(r);
    if (sp.get("min")) setMinLat(sp.get("min")!); if (sp.get("max")) setMaxLat(sp.get("max")!); if (sp.get("op")) setOp(sp.get("op")!);
    const api = sp.get("api");
    if (api) { pickApi(api, sp.get("mode") === "prospect" ? "prospect" : "backtest"); return; }
    const lat = Number(sp.get("lat")), lon = Number(sp.get("lon")), lf = Number(sp.get("lat_ft")) || 10000;
    if (lat && lon) { setLateral(lf); setLatIn(String(lat)); setLonIn(String(lon)); setTarget({ lat, lon, lateralFt: lf, vintageYear: DEFAULT_VINTAGE, mode: "prospect", label: `Pin ${lat.toFixed(4)}, ${lon.toFixed(4)}` }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [B]);

  // keep the shareable URL in sync with what is on screen (target, lateral, radius, filters)
  useEffect(() => {
    if (!B || !target) return;
    const p = new URLSearchParams();
    if (target.mode === "backtest" && target.wellIdx !== undefined) { p.set("api", B.W.api10[target.wellIdx]); }
    else { p.set("lat", target.lat.toFixed(6)); p.set("lon", target.lon.toFixed(6)); p.set("lat_ft", String(Math.round(lateral))); }
    p.set("r", String(radius)); if (minLat) p.set("min", minLat); if (maxLat) p.set("max", maxLat); if (op) p.set("op", op);
    router.replace(`/analyze?${p.toString()}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [B, target, lateral, radius, minLat, maxLat, op]);

  function setPin(lat: number, lon: number, lf = lateral) {
    const t: Target = { lat, lon, lateralFt: lf, vintageYear: DEFAULT_VINTAGE, mode: "prospect", label: `Pin ${lat.toFixed(4)}, ${lon.toFixed(4)}` };
    setLatIn(lat.toFixed(5)); setLonIn(lon.toFixed(5)); setTarget(t); setSel(null); setMsg(null);
  }
  function backtest(i: number) {
    if (!B) return;
    const W = B.W;
    const t: Target = { lat: W.lat[i], lon: W.lon[i], lateralFt: W.lat_ft[i], vintageYear: Math.floor(W.first[i] / 100), mode: "backtest", wellIdx: i, label: `${W.lease[i]} ${W.well_no[i]} (API ${W.api10[i]})` };
    setLateral(Math.round(W.lat_ft[i])); setTarget(t); setSel(null);
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
    if (h >= 0 && (B.H.lat[h] == null || B.H.lon[h] == null)) {
      setMsg(`API ${a} is an RRC horizontal, but the RRC well layer has no surface location for it (${B.H.labels[B.H.code[h]]}), so it cannot be placed on the map.`);
      return;
    }
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
  function copyLink() {
    const fail = () => setMsg("Could not copy the link. Copy it from the address bar.");
    if (!navigator.clipboard) return fail();
    navigator.clipboard.writeText(location.href).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, fail);
  }
  function randomWell() {
    if (!B) return;
    const c: number[] = []; for (let i = 0; i < B.W.n; i++) if (B.W.first[i] >= 202201 && B.W.cum12[i] !== null) c.push(i);
    const ape = (k: "cum12" | "eur") => Math.round(B.meta.model.targets[k].lightgbm_holdout!.median_ape * 100);
    backtest(c[Math.floor(Math.random() * c.length)]);
    setMsg(`Random well first producing 2022 or later. Typical holdout error is ${ape("cum12")}% for 12-month oil and ${ape("eur")}% for EUR.`);
  }
  const th = (k: keyof OffsetRow, label: string, l = false) => (
    <th className={l ? "l" : ""} aria-sort={sort.k === k ? (sort.d === 1 ? "ascending" : "descending") : undefined} onClick={() => setSort((s) => ({ k, d: s.k === k ? (s.d === 1 ? -1 : 1) : (k === "dist_mi" ? 1 : -1) }))}>{label}{sort.k === k ? (sort.d === 1 ? " ↑" : " ↓") : ""}</th>
  );

  if (err) return <div className="wrap"><div className="warn">Failed to load data: {err}</div></div>;
  if (!B) return <div className="loading">Loading 4,700+ RRC wells, coverage layer and model…</div>;

  const mode = res ? (res.target.mode === "backtest" ? (res.sample === "out_of_sample" ? "Blind backtest · out-of-sample" : "Backtest · in-sample") : "Forecast") : "";
  return (
    <div className="app">
      <aside className="side">
        <div className="printonly side-sec"><h2>OffsetIQ report</h2><div className="small">{new Date().toISOString().slice(0, 10)} · offsetiq · Texas RRC public data</div></div>
        <div className="side-sec noprint">
          <div className="seg" role="tablist" aria-label="Find a location by">
            {([["pin", "Location"], ["api", "API"], ["lease", "Lease"]] as const).map(([k, label]) => (
              <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{label}</button>
            ))}
          </div>
          {tab === "pin" && (<div className="stack">
            <p className="hint">Click the map, or enter the planned lateral midpoint (NAD83).</p>
            <div className="row"><div><label htmlFor="in-lat">Latitude</label><input id="in-lat" inputMode="decimal" value={latIn} onChange={(e) => setLatIn(e.target.value)} placeholder="31.95" /></div><div><label htmlFor="in-lon">Longitude</label><input id="in-lon" inputMode="decimal" value={lonIn} onChange={(e) => setLonIn(e.target.value)} placeholder="-102.05" /></div></div>
            <button className="btn block" onClick={() => { const a = Number(latIn), b = Number(lonIn); if (Number.isFinite(a) && Number.isFinite(b) && a && b) setPin(a, b); }}>Analyze location</button>
          </div>)}
          {tab === "api" && (<div className="stack">
            <div><label htmlFor="in-api">RRC API number</label><input id="in-api" className="mono" value={q} onChange={(e) => setQ(e.target.value)} placeholder="42-317-43171" onKeyDown={(e) => e.key === "Enter" && pickApi(q)} /></div>
            <p className="hint">8, 10 or 14 digits. A backtest scores the well blind, using only offsets online before it.</p>
            <div className="row"><button className="btn" onClick={() => pickApi(q)}>Backtest well</button><button className="btn ghost" onClick={() => pickApi(q, "prospect")}>Use as pin</button></div>
          </div>)}
          {tab === "lease" && (<div>
            <label htmlFor="in-lease">Lease name or RRC lease # (district-lease)</label>
            <input id="in-lease" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. SCHARBAUER, 08-" />
            {leaseHits.length > 0 && <div className="hits">
              {leaseHits.map((i) => <button key={i} onClick={() => backtest(i)}>{B.W.lease[i]} {B.W.well_no[i]}<span>{B.W.operator[i]} · {B.W.county[i]} · {B.W.api10[i]}</span></button>)}
            </div>}
            {q.length >= 3 && !leaseHits.length && <p className="hint" style={{ marginTop: 8 }}>No attributable single-well lease matches. Multi-well leases are not shown (production not allocable per well).</p>}
          </div>)}
          {msg && <div className="note">{msg}</div>}
        </div>

        <div className="side-sec noprint">
          <p className="eyebrow">Parameters</p>
          <div className="row">
            <div><label htmlFor="in-lf">Lateral (ft)</label><input id="in-lf" type="number" value={lateral} disabled={target?.mode === "backtest"} onChange={(e) => setLateral(Number(e.target.value) || 0)} /></div>
            <div><label htmlFor="in-r">Radius (mi)</label><select id="in-r" value={radius} onChange={(e) => setRadius(Number(e.target.value))}>{[1, 1.5, 2, 3, 4, 5, 7.5, 10].map((v) => <option key={v} value={v}>{v}</option>)}</select></div>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <div><label htmlFor="in-min">Offset lat. min</label><input id="in-min" inputMode="numeric" value={minLat} onChange={(e) => setMinLat(e.target.value.replace(/[^0-9]/g, ""))} placeholder="ft" /></div>
            <div><label htmlFor="in-max">Max</label><input id="in-max" inputMode="numeric" value={maxLat} onChange={(e) => setMaxLat(e.target.value.replace(/[^0-9]/g, ""))} placeholder="ft" /></div>
            <div><label htmlFor="in-op">Operator</label><input id="in-op" value={op} onChange={(e) => setOp(e.target.value)} placeholder="Any" /></div>
          </div>
          <p className="hint" style={{ marginTop: 10 }}>Bench/target formation is not in public RRC production data; RRC field name is shown instead. Lateral = SHL→BHL displacement from RRC well layer (proxy).</p>
        </div>

        {!res && <div className="side-sec">
          <p className="eyebrow">Try</p>
          <p className="hint">Drop a pin anywhere in Midland, Ector, Andrews or Martin County, or run a blind backtest on a real well.</p>
          <div className="examples">
            <button onClick={() => pickApi("4232944570")}>Midland County well<span>Backtest · out-of-sample</span></button>
            <button onClick={() => pickApi("4231743553")}>Martin County well, 90+ offsets<span>Backtest</span></button>
            <button onClick={() => pickApi("4200348372")}>Andrews County well<span>Backtest</span></button>
            <button onClick={randomWell}>Random 2022+ well<span>Backtest · out-of-sample</span></button>
            <button onClick={() => setPin(31.86, -102.20)}>Midland County location<span>Prospect pin</span></button>
          </div>
        </div>}

        {res && (<>
          <div className="side-sec">
            <p className="eyebrow">{mode}</p>
            <div className="result-title">{res.target.label}</div>
            <div className="result-meta">{res.county ? `${res.county} County` : "County unknown"} · {fmtInt(res.target.lateralFt)} ft · {res.modelOffsets} model offsets ≤ 3 mi{res.target.mode === "backtest" ? ` known before ${fmtYm(res.actual!.first)}` : ""}</div>
            <Band label="First-12-month oil" note="LightGBM" b={res.cum12} actual={res.actual?.cum12} />
            <Band label="Oil EUR" note="LightGBM vs Arps-DCA targets" b={res.eur} actual={res.actual && res.actual.conf !== "none" ? res.actual.eur : undefined} />
            {res.analogEur && <p className="hint" style={{ marginTop: 12 }}>Offset-analog EUR <b style={{ color: "var(--ink)", fontWeight: 500 }}>{fmtK(res.analogEur.value)}</b> bbl: IDW EUR per 1,000 ft of {res.analogEur.n} fitted offsets × lateral.</p>}
            <p className="hint" style={{ marginTop: 8 }}>Computed in {res.ms.toFixed(0)} ms in your browser. Screening estimate, not a reserves report.</p>
            {res.warnings.map((w, i) => <div key={i} className="warn">{w}</div>)}
            {res.excludedNearby.length > 0 && <div className="gap"><b style={{ fontWeight: 500, color: "var(--ink)" }}>Coverage gaps within {radius} mi</b> · RRC horizontals present but not used<ul>{res.excludedNearby.map((e) => <li key={e.label}>{e.count} — {e.label.replace(/^Excluded: /, "")}</li>)}</ul></div>}
          </div>
          <div className="side-sec">
            <p className="eyebrow">Summary</p>
            <p className="para">{summary}</p>
            <div className="row noprint">
              <button className="btn sm ghost" onClick={downloadCsv}>Export CSV</button>
              <button className="btn sm ghost" onClick={() => window.print()}>Print / PDF</button>
              <button className="btn sm ghost" onClick={copyLink}>{copied ? "Copied" : "Copy link"}</button>
            </div>
          </div>
          <div className="side-sec"><p className="hint">Sources: Texas Railroad Commission PDQ production dump ({meta?.pdq_dump_date}; months through {fmtYm(meta!.last_complete_month)}) and RRC digital map well layers. <a href="/data">Data &amp; model card</a></p></div>
        </>)}
      </aside>
      <section className="main">
        <div className="mapbox">
          <MapView W={B.W} H={B.H} target={res ? { lat: res.target.lat, lon: res.target.lon } : null} radiusMi={radius} offsetIdx={offIdx} selected={sel} onPick={(a, b) => setPin(a, b)} onSelect={(i) => setSel(i)} />
          {sel !== null && <WellChart W={B.W} idx={sel} onClose={() => setSel(null)} />}
        </div>
        <div className="tablebox">
          {res ? (<>
            <div className="toolbar"><b>{rows.length} offsets</b><span>within {radius} mi · sorted by {CSV_COLUMNS.find((c) => c[0] === sort.k)?.[1] ?? sort.k}</span><span className="sp" /><span>— = not available (insufficient history), always sorted last · click a row for its decline curve</span></div>
            <table className="otable">
              <thead><tr>{th("lease", "Lease / well", true)}{th("operator", "Operator", true)}{th("api10", "API", true)}{th("dist_mi", "Dist mi")}{th("lateral_ft", "Lat ft")}{th("first_prod", "1st prod")}{th("months", "Mo")}{th("cum_oil", "Cum oil")}{th("cum12", "12-mo")}{th("Di_annual", "Di/yr")}{th("b", "b")}{th("eur", "EUR")}{th("remaining", "Remain")}{th("eur_per_kft", "EUR/kft")}{th("cluster", "Cluster", true)}{th("confidence", "Conf", true)}{th("field", "RRC field", true)}</tr></thead>
              <tbody>{rows.map((o) => (
                <tr key={o.idx} className={o.idx === sel ? "sel" : ""} onClick={() => setSel(o.idx)}>
                  <td className="l">{o.lease} {o.well_no}</td><td className="l o">{o.operator.slice(0, 26)}</td><td className="l api">{o.api10}</td>
                  <td>{o.dist_mi.toFixed(2)}</td><td>{fmtInt(o.lateral_ft)}</td><td>{fmtYm(o.first_prod)}</td><td>{o.months}</td>
                  <td>{fmtInt(o.cum_oil)}</td><td>{fmtInt(o.cum12)}</td><td>{o.Di_annual?.toFixed(2) ?? "—"}</td><td>{o.b?.toFixed(2) ?? "—"}</td>
                  <td>{fmtInt(o.eur)}</td><td>{fmtInt(o.remaining)}</td><td>{fmtInt(o.eur_per_kft)}</td><td className="l"><span className={`cl ${CLUSTER_CLASS[o.cluster] ?? "cl-unfit"}`}>{o.cluster}</span></td>
                  <td className="l"><span className={`badge b-${o.confidence}`}>{o.confidence}</span></td><td className="l o">{o.field.slice(0, 24)}</td>
                </tr>))}</tbody>
            </table>
            {!rows.length && <div className="empty">No attributable offsets within {radius} mi. Increase the radius, and check the coverage gaps at left.</div>}
          </>) : <div className="empty">Offsets will appear here.</div>}
        </div>
      </section>
    </div>
  );
}
