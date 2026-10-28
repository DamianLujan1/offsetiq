"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { fmtInt, fmtK, fmtYm } from "@/lib/engine";
import { loadAll, type Bundle } from "@/lib/load";
import {
  analyzeHref, approve, buildReport, decodeReport, edited, encodeReport, included, move, ndjson, quintileBreaks, reportCsv,
  resetOrder, ringAcres, startReview, toggle, type AgentEvent, type Proposal, type Report, type Review, type Row, type Step,
} from "@/lib/screen";
import type { MapCandidate, Pin, Shape } from "./ScreenMap";

const ScreenMap = dynamic(() => import("./ScreenMap"), { ssr: false, loading: () => <div className="mut" style={{ padding: 20 }}>Loading map…</div> });

const EXAMPLES = [
  "Rank the best spots in Midland County",
  "Screen every location in this lease block",
  "Compare these three tracts",
  "Top 10 in Martin County with 2-mile laterals, offsets within 1.5 miles",
];
const TIER = { supported: "3+ offsets", low_confidence: "1–2 offsets" } as const;
type Ring = [number, number][];
const dedupe = (d: Ring) => d.filter((v, i) => i === 0 || Math.abs(v[0] - d[i - 1][0]) > 1e-7 || Math.abs(v[1] - d[i - 1][1]) > 1e-7);

function Own() {
  return (
    <div className="own">
      <b>Your data, your export.</b> Screening runs only on public Texas RRC data. OffsetIQ does not save your prompts, drawn areas
      or results: the screening service computes each run in memory and discards it, and the results live only in this tab and in
      the CSV, PDF or link you export. A share link carries the report inside the link itself (after the #). Browsers don’t send that
      part to our servers, but anyone you give the link to can read it.
    </div>
  );
}

/** What prints (Print / PDF): the approved report only. Unapproved lists print as a notice, not as results. */
function PrintReport({ rep }: { rep: Report | null }) {
  if (!rep) return <div className="printonly"><h2>OffsetIQ screening — draft</h2><p>Not approved by the operator. Approve the list in OffsetIQ before exporting a report.</p></div>;
  return (
    <div className="printonly rep">
      <h2 style={{ marginTop: 0 }}>OffsetIQ screening report</h2>
      <div className="small">Request: “{rep.prompt}”</div>
      <div className="small">{rep.plan}</div>
      <div className="small">Approved by the operator {rep.approvedAt.replace("T", " ").slice(0, 16)} UTC · {rep.rows.length} of {rep.proposed} proposed locations kept{rep.edited ? " · order or selection edited by the operator" : ""}</div>
      <div className="small">Texas RRC public data (PDQ dump {rep.data.pdq_dump_date}; production through {fmtYm(rep.data.last_complete_month)}). P90 = low case, P10 = high case (PRMS). Model median error on held-out 2022+ wells: {Math.round(rep.model.cum12_median_ape * 100)}% (12-mo oil), {Math.round(rep.model.eur_median_ape * 100)}% (EUR). Multi-well-lease wells are counted as coverage gaps, never given volumes. Screening estimate, not a reserves report.</div>
      <table style={{ marginTop: 8 }}>
        <thead><tr><th>#</th><th className="l">Location</th><th>12-mo oil P90 / P50 / P10</th><th>EUR P50</th><th className="l">Rationale (agent)</th></tr></thead>
        <tbody>{rep.rows.map((r) => (
          <tr key={r.id}><td>{r.rank}</td><td className="l">{r.id}<br />{r.region}<br />{r.lat.toFixed(5)}, {r.lon.toFixed(5)}</td>
            <td>{fmtK(r.cum12.p90)} / <b>{fmtK(r.cum12.p50)}</b> / {fmtK(r.cum12.p10)}</td><td>{fmtK(r.eur.p50)}</td>
            <td className="rat"><b>{r.headline}</b><ul>{r.details.map((d, i) => <li key={i}>{d}</li>)}</ul><div className="w">{r.why}{r.agentRank !== r.rank ? ` (agent rank #${r.agentRank}; re-ranked by the operator)` : ""}</div></td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}

export default function ScreenAgent() {
  const [B, setB] = useState<Bundle | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [shapes, setShapes] = useState<Ring[]>([]);
  const [pins, setPins] = useState<Ring>([]);
  const [draft, setDraft] = useState<Ring>([]);
  const draftRef = useRef<Ring>([]);
  const [mode, setMode] = useState<"none" | "polygon" | "point">("none");
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [clarify, setClarify] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [shared, setShared] = useState<Report | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [manualLink, setManualLink] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => { loadAll().then(setB).catch((e) => setLoadErr(String(e))); }, []);
  useEffect(() => {
    // A share link carries the whole approved report after '#r='. Pasting another link into an open tab only
    // changes the fragment (no reload), so re-read it on every hashchange too.
    const read = () => {
      const h = window.location.hash;
      if (!h.startsWith("#r=")) { setShared(null); return; }
      decodeReport(h.slice(3)).then((r) => {
        setShared(r); setSelected(null);
        setError(r ? null : "This share link is damaged or incomplete, so no report could be shown.");
      });
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { draftRef.current = []; setDraft([]); setMode("none"); } };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  const tracts: Shape[] = useMemo(() => shapes.map((ring, i) => ({ label: `Tract ${i + 1}`, ring })), [shapes]);
  const pinList: Pin[] = useMemo(() => pins.map(([lat, lon], i) => ({ label: `Pin ${i + 1}`, lat, lon })), [pins]);

  function onMapClick(lat: number, lon: number) {
    if (mode === "polygon") { draftRef.current = [...draftRef.current, [lat, lon]]; setDraft(draftRef.current); }
    else if (mode === "point") setPins((p) => [...p, [lat, lon]]);
  }
  function finishPolygon() {
    const ring = dedupe(draftRef.current);
    if (ring.length >= 3) setShapes((s) => [...s, ring]);
    else if (ring.length) setMsg("A tract needs at least 3 corners.");
    draftRef.current = []; setDraft([]); setMode("none");
  }
  function startDrawing(m: "polygon" | "point") { draftRef.current = []; setDraft([]); setMode(mode === m ? "none" : m); setMsg(null); }

  function handle(ev: AgentEvent) {
    if (ev.type === "step") setSteps((s) => [...s, ev]);
    else if (ev.type === "progress") setProgress({ done: ev.done, total: ev.total });
    else if (ev.type === "clarify") setClarify(ev.question);
    else if (ev.type === "error") setError(ev.message);
    else if (ev.type === "proposal") { setProposal(ev); setReview(startReview(ev)); }
  }

  async function run(text = prompt) {
    if (!text.trim() || running) return;
    const pending = mode === "polygon" ? dedupe(draftRef.current) : [];  // a tract still being drawn counts
    if (mode === "polygon") finishPolygon(); else setMode("none");
    const polys = [...tracts, ...(pending.length >= 3 ? [{ label: `Tract ${tracts.length + 1}`, ring: pending }] : [])];
    const ctl = new AbortController();
    abort.current = ctl;
    setRunning(true); setSteps([]); setProgress(null); setClarify(null); setError(null); setProposal(null); setReview(null);
    setSelected(null); setMsg(null); setManualLink(null);
    try {
      // The agent runs in this deployment (api/screening.py); nothing about the request is logged or stored.
      const res = await fetch("/api/agent/screen", {
        method: "POST", headers: { "content-type": "application/json" }, signal: ctl.signal,
        body: JSON.stringify({ prompt: text.trim(), context: { polygons: polys, points: pinList } }),
      });
      if (!res.ok || !res.body || !(res.headers.get("content-type") ?? "").startsWith("application/x-ndjson")) {
        const j = await res.json().catch(() => null);
        const hint = process.env.NODE_ENV === "development" ? " Start it with: npm run agent" : " Please retry.";
        throw new Error(j?.error ?? (res.status >= 500 || res.ok ? `The screening agent is unavailable (HTTP ${res.status}).${hint}` : `Request failed (${res.status}).`));
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let rest = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const r = ndjson(rest + value);
        rest = r.rest;
        r.events.forEach(handle);
      }
    } catch (e) {
      setError((e as Error).name === "AbortError" ? "Run cancelled. Nothing was saved." : (e as Error).message);
    } finally {
      setRunning(false); setProgress(null);
    }
  }

  // ---- review state (the agent proposes; the operator decides) ----
  const rowsById = useMemo(() => new Map((proposal?.ranked ?? []).map((r) => [r.id, r])), [proposal]);
  const keep = review ? included(review) : [];
  const yourRank = new Map(keep.map((id, i) => [id, i + 1]));
  const planText = steps.find((s) => s.id === "parse")?.detail ?? "";
  const rep: Report | null = shared ?? (proposal && review?.approved ? buildReport(proposal, review, planText) : null);
  const setR = (f: (r: Review) => Review) => setReview((r) => (r ? f(r) : r));

  const candidates: MapCandidate[] = useMemo(() => {
    if (proposal) {
      const c = proposal.candidates;
      return c.id.map((id, i) => ({ id, lat: c.lat[i], lon: c.lon[i], p50: c.p50[i], rank: c.rank[i], status: c.status[i] }));
    }
    return shared ? shared.rows.map((r) => ({ id: r.id, lat: r.lat, lon: r.lon, p50: r.cum12.p50, rank: r.rank, status: "ranked" })) : [];
  }, [proposal, shared]);
  const breaks = useMemo(() => quintileBreaks(candidates.filter((c) => c.status === "ranked").map((c) => c.p50 as number)), [candidates]);
  const labelKey = review ? keep.slice(0, 25).join() : "";
  const labels = useMemo(() => (shared ? shared.rows.slice(0, 25).map((r) => ({ id: r.id, n: r.rank })) : labelKey ? labelKey.split(",").map((id, i) => ({ id, n: i + 1 })) : []),
    [shared, labelKey]);
  const regions: Shape[] = useMemo(() => (shared ? shared.regions
    : (proposal?.intent.regions ?? []).filter((r) => r.ring.length >= 3 && r.source !== "drawn").map((r) => ({ label: r.label, ring: r.ring }))), [proposal, shared]);
  const cellFt = shared ? Math.sqrt(shared.spacingAcres * 43560)
    : proposal && proposal.intent.regions.some((r) => r.kind !== "point") ? Math.sqrt(proposal.plan.spacing_acres * 43560) : null;

  function downloadCsv() {
    if (!rep) return;
    const url = URL.createObjectURL(new Blob([reportCsv(rep, window.location.origin)], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = `offsetiq_screen_${rep.approvedAt.slice(0, 10)}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function copyLink() {
    if (!rep) return;
    const url = `${window.location.origin}/screen#r=${await encodeReport(rep)}`;
    const note = `The report travels inside the link (${Math.max(1, Math.round(url.length / 1024))} KB); nothing is stored on OffsetIQ servers.`;
    try { await navigator.clipboard.writeText(url); setMsg(`Share link copied. ${note}`); setManualLink(null); }
    catch { setMsg(`Copy this link: ${note}`); setManualLink(url); }
  }
  function leaveShared() { window.history.replaceState(null, "", "/screen"); setShared(null); setError(null); }

  const sel: Row | null = selected ? rowsById.get(selected) ?? null : null;
  const selShared = selected && shared ? shared.rows.find((r) => r.id === selected) ?? null : null;
  const pref = proposal?.intent.formats ?? [];
  const isEdited = !!(proposal && review && edited(review, proposal));

  if (loadErr) return <div className="wrap"><div className="warn">Failed to load data: {loadErr}</div></div>;
  if (!B) return <div className="wrap mut">Loading 4,700+ RRC wells and the coverage layer…</div>;

  const exportButtons = (
    <div className="row" style={{ marginTop: 8, flexWrap: "wrap" }}>
      <button className={`btn sm${pref.includes("csv") ? "" : " ghost"}`} disabled={!rep} onClick={downloadCsv}>Export CSV</button>
      <button className={`btn sm${pref.includes("pdf") ? "" : " ghost"}`} disabled={!rep} onClick={() => window.print()}>Print / PDF</button>
      <button className={`btn sm${pref.includes("link") ? "" : " ghost"}`} disabled={!rep} onClick={copyLink}>Copy share link</button>
    </div>
  );

  return (
    <div className="app">
      <aside className="side">
        <PrintReport rep={rep} />
        <div className="noprint">
          {shared ? (<>
            <h3 style={{ marginTop: 0 }}>Shared screening report</h3>
            <div className="para">“{shared.prompt}”<div className="small mut" style={{ marginTop: 4 }}>{shared.plan}</div></div>
            <div className="small" style={{ marginTop: 8 }}>Approved by the operator {shared.approvedAt.replace("T", " ").slice(0, 16)} UTC · {shared.rows.length} of {shared.proposed} proposed locations kept{shared.edited ? " · edited by the operator" : ""}.</div>
            <div className="small mut">Texas RRC public data, PDQ dump {shared.data.pdq_dump_date}, production through {fmtYm(shared.data.last_complete_month)}. Screening estimate, not a reserves report.</div>
            {shared.summary.length > 0 && <ul className="small" style={{ paddingLeft: 16 }}>{shared.summary.map((s, i) => <li key={i}>{s}</li>)}</ul>}
            {exportButtons}
            <button className="btn sm ghost" style={{ marginTop: 8 }} onClick={leaveShared}>Start your own screen</button>
            {msg && <div className="small" style={{ marginTop: 8 }}>{msg}</div>}
            {manualLink && <input readOnly value={manualLink} onFocus={(e) => e.target.select()} style={{ marginTop: 6 }} />}
            <Own />
          </>) : (<>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <h3 style={{ margin: 0 }}>Screening agent</h3><span className="pill">proposes · you decide</span>
            </div>
            <label htmlFor="screen-prompt">Ask in plain English</label>
            <textarea id="screen-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3}
              placeholder="e.g. Rank the best spots in Midland County, or draw tracts and ask to compare them"
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); run(); } }} />
            <div className="row" style={{ marginTop: 6 }}>
              {running ? <button className="btn sm ghost" onClick={() => abort.current?.abort()}>Cancel</button>
                : <button className="btn sm" disabled={!prompt.trim()} onClick={() => run()}>Run screen</button>}
            </div>
            <div className="chips">{EXAMPLES.map((x) => <button key={x} className="chip" onClick={() => setPrompt(x)}>{x}</button>)}</div>

            <div className="card" style={{ marginTop: 12, padding: 10 }}>
              <div className="small mut" style={{ marginBottom: 6 }}>Draw what “this lease block” or “these tracts” means — or paste lat/lon in the prompt.</div>
              <div className="row">
                <button className={`btn sm${mode === "polygon" ? "" : " ghost"}`} onClick={() => startDrawing("polygon")}>{mode === "polygon" ? "Drawing…" : "Draw tract"}</button>
                {mode === "polygon" && <button className="btn sm" disabled={draft.length < 3} onClick={finishPolygon}>Finish ({draft.length})</button>}
                <button className={`btn sm${mode === "point" ? "" : " ghost"}`} onClick={() => startDrawing("point")}>{mode === "point" ? "Done" : "Drop pins"}</button>
                <button className="btn sm ghost" disabled={!shapes.length && !pins.length && !draft.length} onClick={() => { setShapes([]); setPins([]); draftRef.current = []; setDraft([]); setMode("none"); }}>Clear</button>
              </div>
              {(tracts.length > 0 || pinList.length > 0) && <div className="small" style={{ marginTop: 6 }}>
                {tracts.map((t, i) => <div key={`t${i}`}>{t.label} · ~{fmtInt(ringAcres(t.ring))} acres <a href="#" onClick={(e) => { e.preventDefault(); setShapes((s) => s.filter((_, k) => k !== i)); }}>remove</a></div>)}
                {pinList.map((p, i) => <div key={`p${i}`}>{p.label} · {p.lat.toFixed(4)}, {p.lon.toFixed(4)} <a href="#" onClick={(e) => { e.preventDefault(); setPins((s) => s.filter((_, k) => k !== i)); }}>remove</a></div>)}
              </div>}
            </div>
            <Own />

            {(steps.length > 0 || running || clarify) && <>
              <h3 style={{ marginTop: 12 }}>What the agent did</h3>
              <ol className="trace">
                {steps.map((s, i) => (
                  <li key={i}><div className="t">{s.title}</div><div className="d">{s.detail}</div>
                    {(s.unsupported?.length ?? 0) > 0 && <div className="warn"><b>Not applied:</b><ul>{s.unsupported!.map((u, k) => <li key={k}>{u}</li>)}</ul></div>}
                    {(s.notes?.length ?? 0) > 0 && <ul>{s.notes!.map((n, k) => <li key={k}>{n}</li>)}</ul>}
                  </li>))}
                {running && <li><div className="t">{progress ? `Screening ${fmtInt(progress.done)} / ${fmtInt(progress.total)} locations…` : "Working…"}</div>
                  {progress && <div className="prog"><i style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} /></div>}</li>}
              </ol>
              {clarify && <div className="ask"><b>The agent needs one thing from you:</b> {clarify}</div>}
            </>}
            {error && <div className="warn">{error}</div>}

            {proposal && review && <>
              {proposal.summary.length > 0 && <><h3 style={{ marginTop: 12 }}>Read before you approve</h3>
                <ul className="small" style={{ paddingLeft: 16, marginTop: 4 }}>{proposal.summary.map((s, i) => <li key={i} style={{ marginBottom: 4 }}>{s}</li>)}</ul></>}
              {proposal.tracts.length > 0 && <><h3 style={{ marginTop: 12 }}>Area comparison</h3>
                {proposal.tracts.map((t) => <div key={t.region} className="para" style={{ marginBottom: 6 }}>{t.rationale}</div>)}</>}
              <div className="appr">
                <div className="small"><b>Your review:</b> {keep.length} of {proposal.ranked.length} proposed locations kept{isEdited ? " · order or selection edited" : " · agent order"}.
                  {proposal.ranked_total > proposal.ranked.length && <span className="mut"> {fmtInt(proposal.ranked_total - proposal.ranked.length)} more ranked locations are on the map (ask for “top N” to review more).</span>}</div>
                {review.approved
                  ? <div className="small ok" style={{ marginTop: 6 }}>✓ Approved {review.approved.at.slice(11, 16)} UTC. Exports contain exactly this list; editing it clears the approval.</div>
                  : <button className="btn sm" style={{ marginTop: 8 }} disabled={!keep.length} onClick={() => setR((r) => approve(r))}>Approve {keep.length} location{keep.length === 1 ? "" : "s"} for export</button>}
                {exportButtons}
                {!review.approved && <div className="small mut" style={{ marginTop: 6 }}>Exports unlock after you approve. The agent never exports or acts on its own.</div>}
                {msg && <div className="small" style={{ marginTop: 6 }}>{msg}</div>}
                {manualLink && <input readOnly value={manualLink} onFocus={(e) => e.target.select()} style={{ marginTop: 6 }} />}
              </div>
              <div className="small mut">Run: {fmtInt(proposal.run.candidates)} locations screened in {(proposal.run.screen_ms / 1000).toFixed(1)} s on {proposal.run.workers} worker process{proposal.run.workers === 1 ? "" : "es"}. Texas RRC public data, PDQ dump {proposal.data.pdq_dump_date}, production through {fmtYm(proposal.data.last_complete_month)}. Screening estimate, not a reserves report. <Link href="/data">Data &amp; model card →</Link></div>
            </>}
            {!steps.length && !running && !proposal && msg && <div className="small" style={{ marginTop: 8 }}>{msg}</div>}
          </>)}
        </div>
      </aside>

      <section className="main noprint">
        <div className="mapbox">
          <ScreenMap W={B.W} H={B.H} shapes={shared ? [] : tracts} pins={shared ? [] : pinList} draft={draft} mode={mode} regions={regions}
            candidates={candidates} labels={labels} breaks={breaks} cellFt={cellFt} selected={selected}
            onMapClick={onMapClick} onFinish={finishPolygon} onSelect={(id) => setSelected(id)} />
          {(sel || selShared) && (() => {
            const head = sel ? sel.rationale.headline : selShared!.headline, details = sel ? sel.rationale.details : selShared!.details, why = sel ? sel.rationale.why : selShared!.why;
            const r = sel ?? null, s = selShared;
            const lat = r ? r.lat : s!.lat, lon = r ? r.lon : s!.lon;
            const href = r ? analyzeHref(r.lat, r.lon, proposal!.intent.lateral_ft, proposal!.intent.radius_mi, proposal!.intent.filters)
              : analyzeHref(s!.lat, s!.lon, shared!.lateralFt, shared!.radiusMi, shared!.filters);
            return (
              <div className="chart detail">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 8 }}>
                  <div><b>{r ? r.id : s!.id}</b> <span className="mut small">{r ? r.region : s!.region} · {lat.toFixed(5)}, {lon.toFixed(5)}</span></div>
                  <button className="btn sm ghost" onClick={() => setSelected(null)}>×</button>
                </div>
                <div style={{ marginTop: 6, fontWeight: 600 }}>{head}</div>
                <ul className="small" style={{ paddingLeft: 16, margin: "6px 0" }}>{details.map((d, i) => <li key={i}>{d}</li>)}</ul>
                <div className="small mut">{why}</div>
                <a className="btn sm ghost" style={{ marginTop: 8 }} href={href} target="_blank" rel="noreferrer">Open in Analyze: offsets &amp; decline curves →</a>
              </div>
            );
          })()}
        </div>
        <div className="tablebox">
          {shared ? (<>
            <div className="toolbar small"><b>{shared.rows.length} approved locations</b><span className="mut">read-only shared report · click a row for its full rationale</span></div>
            <table>
              <thead><tr><th>Rank</th><th className="l">Location</th><th className="l">Area</th><th title="PRMS: P90 = low case, P10 = high case">12-mo oil P50 (P90–P10)</th><th>EUR P50</th><th>Offsets ≤ {shared.radiusMi} mi</th><th>Model wells</th><th>Multi-well gaps</th><th className="l">Rationale</th></tr></thead>
              <tbody>{shared.rows.map((r) => (
                <tr key={r.id} className={r.id === selected ? "sel" : ""} onClick={() => setSelected(r.id)}>
                  <td>{r.rank}{r.agentRank !== r.rank && <div className="mut" style={{ fontSize: 10 }}>agent #{r.agentRank}</div>}</td><td className="l">{r.id}</td><td className="l">{r.region}</td>
                  <td><b>{fmtK(r.cum12.p50)}</b> <span className="mut">({fmtK(r.cum12.p90)}–{fmtK(r.cum12.p10)})</span></td><td>{fmtK(r.eur.p50)}</td>
                  <td>{r.offsets}</td><td>{r.modelOffsets}</td><td>{r.multiWell}</td>
                  <td className="rat">{r.headline}<div className="w">{r.why}</div></td>
                </tr>))}</tbody>
            </table>
          </>) : proposal && review ? (<>
            <div className="toolbar small"><b>{proposal.ranked.length} proposed</b><span className="mut">of {fmtInt(proposal.ranked_total)} ranked · ☐ to exclude · ▲▼ to re-rank · click a row for its full rationale</span>
              <span style={{ flex: 1 }} /><button className="btn sm ghost" disabled={!isEdited} onClick={() => setR((r) => resetOrder({ ...r, excluded: [] }, proposal))}>Reset to agent list</button></div>
            <table>
              <thead><tr><th>Keep</th><th>#</th><th>Move</th><th className="l">Location</th><th className="l">Area</th><th title="PRMS: P90 = low case, P10 = high case">12-mo oil P50 (P90–P10)</th><th>EUR P50</th>
                <th>Offsets ≤ {proposal.intent.radius_mi} mi</th><th>Model wells</th><th>Multi-well gaps</th><th className="l">Evidence</th><th className="l">Rationale (agent)</th><th className="l">Analyze</th></tr></thead>
              <tbody>{review.order.map((id) => {
                const r = rowsById.get(id)!, out = review.excluded.includes(id), yr = yourRank.get(id);
                return (
                  <tr key={id} className={`${id === selected ? "sel" : ""}${out ? " excl" : ""}`} onClick={() => setSelected(id)}>
                    <td className="keep" onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Keep ${id}`} checked={!out} onChange={() => setR((v) => toggle(v, id))} style={{ width: "auto" }} /></td>
                    <td>{out ? "—" : yr}{yr !== r.rank && !out && <div className="mut" style={{ fontSize: 10 }}>agent #{r.rank}</div>}</td>
                    <td className="mv" onClick={(e) => e.stopPropagation()}>
                      <button aria-label={`Move ${id} up`} onClick={() => setR((v) => move(v, id, -1))}>▲</button>{" "}
                      <button aria-label={`Move ${id} down`} onClick={() => setR((v) => move(v, id, 1))}>▼</button></td>
                    <td className="l">{id}<div className="mut" style={{ fontSize: 10 }}>{r.lat.toFixed(4)}, {r.lon.toFixed(4)}</div></td>
                    <td className="l">{r.region}</td>
                    <td><b>{fmtK(r.cum12.p50)}</b> <span className="mut">({fmtK(r.cum12.p90)}–{fmtK(r.cum12.p10)})</span></td>
                    <td>{fmtK(r.eur.p50)}</td>
                    <td>{r.evidence.n}{r.evidence.median_cum12 !== null && <div className="mut" style={{ fontSize: 10 }}>median {fmtK(r.evidence.median_cum12)}</div>}</td>
                    <td>{r.model_offsets}</td><td>{r.gaps.multi_well}</td>
                    <td className="l"><span className={`badge b-${r.tier}`}>{TIER[r.tier]}</span></td>
                    <td className="rat">{r.rationale.headline}<div className="w">{r.rationale.why}</div></td>
                    <td className="l" onClick={(e) => e.stopPropagation()}><a href={analyzeHref(r.lat, r.lon, proposal.intent.lateral_ft, proposal.intent.radius_mi, proposal.intent.filters)} target="_blank" rel="noreferrer">Open →</a></td>
                  </tr>
                );
              })}</tbody>
            </table>
            {!proposal.ranked.length && <div className="mut" style={{ padding: 14 }}>No location could be ranked. See the agent’s notes at left.</div>}
          </>) : (
            <div className="mut" style={{ padding: 14 }}>Ranked locations and the agent’s rationale for each will appear here. The agent screens and ranks; nothing is exported until you approve.</div>
          )}
        </div>
      </section>
    </div>
  );
}
