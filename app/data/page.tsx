import meta from "@/public/data/meta.json";

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const k = (x: number) => `${Math.round(x / 1000).toLocaleString()}k`;
const ym = (x: number | string) => { const s = String(x); return `${s.slice(0, 4)}-${s.slice(4)}`; };

type Metric = { n: number; r2_log: number; median_ape: number; mape: number; mae: number; within_25pct: number };

export default function DataPage() {
  const T = meta.model.targets as unknown as Record<string, Record<string, unknown>>;
  const counties = Object.keys(meta.coverage) as (keyof typeof meta.coverage)[];
  const labels = Object.keys(meta.horizontals_by_code);
  const row = (name: string, m: Metric) => (
    <tr key={name}><td>{name}</td><td>{m.n.toLocaleString()}</td><td>{pct(m.median_ape)}</td><td>{pct(m.within_25pct)}</td><td>{m.r2_log.toFixed(3)}</td><td>{k(m.mae)} bbl</td></tr>
  );
  const fi = Object.entries(T.cum12.feature_importance_gain as Record<string, number>);
  return (
    <main><div className="wrap" style={{ maxWidth: 1050 }}>
      <h1>Data provenance &amp; model card</h1>
      <p className="mut">Everything in OffsetIQ is computed from Texas Railroad Commission (RRC) public data. No proprietary data, no synthetic wells. Where public data reports production only for a whole multi-well lease, we show that lease as one <b>pad</b> with its lease-total production; where production cannot be attributed at all, we show a coverage gap. We never invent a per-well split.</p>

      <h2>Sources</h2>
      <div className="card"><ul>
        <li><b>Production &amp; completions:</b> RRC Production Data Query (PDQ) bulk dump, retrieved via the RRC public download site (MFT/GoAnywhere), dump dated <b>{meta.pdq_dump_date}</b>. Tables: <code>OG_LEASE_CYCLE_DATA_TABLE</code> (monthly lease oil/gas), <code>OG_WELL_COMPLETION_DATA_TABLE</code> (API ↔ lease link).</li>
        <li><b>Well locations &amp; laterals:</b> {meta.well_layer_source}. Lateral length is a proxy: straight-line surface-hole → bottom-hole displacement.</li>
        <li><b>Production window:</b> 2012-01 through <b>{ym(meta.last_complete_month)}</b> (last month treated as complete; RRC filings lag 2–3 months and later months are revised).</li>
        <li><b>Counties:</b> Midland, Ector, Andrews (v1 target) plus Martin. Martin is included because it is geologically continuous and well-covered; it is labelled “Martin” everywhere and is not hidden inside the core-three statistics.</li>
      </ul></div>

      <h2>Attribution rule (why coverage gaps exist)</h2>
      <div className="card"><p>Texas reports oil production by <b>lease</b>, not by well. Three cases:</p>
        <ul>
          <li><b>Single-well lease</b> → lease production = well production. These {(meta.horizontals_by_code as Record<string, number>)["Usable: single-well lease, oil production attributable"]?.toLocaleString()} wells are the only ones used to train the model and the only ones used as model features.</li>
          <li><b>Multi-well horizontal lease (pad)</b> → every completion on the lease is a horizontal, first production 2013 or later. Shown as one pad{meta.pads ? <> ({meta.pads.pads.toLocaleString()} pads covering {meta.pads.wells_in_pads.toLocaleString()} wells; {meta.pads.fitted.toLocaleString()} with an Arps fit)</> : null}: lease-total monthly oil, total lateral = sum of member laterals, Arps fit on the lease stream, centroid of the member laterals. Pads appear in reports and on the map (cyan squares) as offsets labelled “pad (N wells)”, with the well count. <b>No per-well allocation is invented</b>, and pads are not fed into the forecast model.</li>
          <li><b>Mixed lease</b> (horizontals sharing a lease with vertical or other completions, or pads that started before 2013) → still a coverage gap: lease volumes would mix unrelated wells. Shown on the map in purple and counted in every report.</li>
        </ul></div>

      <h2>Coverage by county (RRC well-layer county)</h2>
      <div className="card" style={{ overflowX: "auto" }}><table>
        <thead><tr><th>Status</th>{counties.map((c) => <th key={c}>{c}</th>)}<th>Total</th></tr></thead>
        <tbody>{labels.map((l) => (
          <tr key={l}><td>{l}</td>{counties.map((c) => <td key={c}>{((meta.coverage[c] as Record<string, number>)[l] ?? 0).toLocaleString()}</td>)}<td><b>{(meta.horizontals_by_code as Record<string, number>)[l].toLocaleString()}</b></td></tr>
        ))}</tbody>
      </table>
      <p className="small mut">Usable wells by RRC-reported county: {Object.entries(meta.usable_by_county).map(([c, n]) => `${c} ${n.toLocaleString()}`).join(" · ")} (a handful of wells sit in one county’s map layer but report production in another).</p></div>

      <h2>Decline curves (Arps)</h2>
      <div className="card"><p>Hyperbolic Arps fit from the peak month on monthly oil, switching to exponential at a 5%/yr terminal decline; economic limit 150 bbl/month; EUR = cumulative to date + remaining forecast. Same pipeline as the public Midland Basin DCA dashboard. Fits: <b>{meta.dca.fitted.toLocaleString()}</b> wells; <b>{meta.dca.insufficient.toLocaleString()}</b> have too little history (shown without EUR, never as zero). Confidence: high {meta.dca.conf.high.toLocaleString()} · medium {meta.dca.conf.medium.toLocaleString()} · low {meta.dca.conf.low.toLocaleString()}.</p>
      <p className="small mut">Median EUR (bbl oil): {Object.entries(meta.dca.median_eur_by_county).map(([c, v]) => `${c} ${k(v)}`).join(" · ")}</p></div>

      <h2>Model card</h2>
      <div className="card">
        <p><b>Model:</b> LightGBM gradient-boosted trees (log-space targets), plus quantile models for the P90 (low) and P10 (high) cases. P90/P50/P10 follow the PRMS convention: P90 is the value the actual has a 90% chance of reaching or exceeding. Params: {Object.entries(meta.model.params).filter(([n]) => n !== "verbose").map(([n, v]) => `${n}=${v}`).join(", ")}.</p>
        <p><b>Targets:</b> first-12-producing-month oil (cum12) and Arps EUR (EUR trained on high-confidence fits only).</p>
        <p><b>Features ({meta.model.features.length}):</b> {meta.model.features.join(", ")}. Offset features use wells within 3 miles, inverse-distance weighted (1/(d+0.25 mi)²).</p>
        <p><b>Leakage rules:</b> (1) a well is never its own offset; (2) an offset is visible only if its first 12 producing months were complete before the target first produced; (3) offset features use only those early months; (4) the target’s own production is used only as the label. Known mild leakage: the 3 early-decline cluster centroids are fit on all wells.</p>
        <p><b>Validation:</b> time split at first production {ym(meta.model.split_first_prod_ym)}. Train window {ym((T.cum12.train_first_prod as number[])[0])}–{ym((T.cum12.train_first_prod as number[])[1])}; test {ym((T.cum12.test_first_prod as number[])[0])}–{ym((T.cum12.test_first_prod as number[])[1])} (EUR test to {ym((T.eur.test_first_prod as number[])[1])}). The app’s backtest mode uses this holdout model, so wells first producing 2022+ are scored out-of-sample; older wells are flagged in-sample.</p>
        <table><thead><tr><th>Holdout</th><th>n</th><th>Median APE</th><th>Within ±25%</th><th>R² (log)</th><th>MAE</th></tr></thead>
          <tbody>
            <tr><td colSpan={6}><b>First-12-month oil</b></td></tr>
            {row("LightGBM", T.cum12.lightgbm_holdout as Metric)}
            {row("Baseline: offset average × lateral", T.cum12.baseline_offset_average as Metric)}
            {row("Baseline: county median", T.cum12.baseline_county_median as Metric)}
            <tr><td colSpan={6}><b>EUR</b></td></tr>
            {row("LightGBM", T.eur.lightgbm_holdout as Metric)}
            {row("Baseline: offset average × lateral", T.eur.baseline_offset_average as Metric)}
            {row("Baseline: county median", T.eur.baseline_county_median as Metric)}
          </tbody></table>
        <p className="small">Quantile calibration on holdout: share of actuals ≥ P90 (low case) = {pct(T.cum12_p10.holdout_coverage as number)} (cum12), {pct(T.eur_p10.holdout_coverage as number)} (EUR); share ≤ P10 (high case) = {pct(T.cum12_p90.holdout_coverage as number)} (cum12), {pct(T.eur_p90.holdout_coverage as number)} (EUR). The P90–P10 range therefore covers ~67–68% of outcomes, narrower than the nominal 80%.</p>
        <p className="small"><b>Feature importance (cum12, gain share):</b> {fi.map(([n, v]) => `${n} ${(v * 100).toFixed(0)}%`).join(" · ")}</p>
        <p><b>Final models</b> are refit on all wells (cum12 n={String(T.cum12.n_final)}, EUR n={String(T.eur.n_final)}) and used for prospect pins.</p>
      </div>

      <h2 id="wrong">What the model gets wrong</h2>
      <div className="card"><ul>
        <li><b>EUR is no better than a county median.</b> On {(T.eur.lightgbm_holdout as Metric).n.toLocaleString()} held-out wells (first production ≥ {ym(meta.model.split_first_prod_ym)}) the EUR model’s median error is {pct((T.eur.lightgbm_holdout as Metric).median_ape)} vs {pct((T.eur.baseline_county_median as Metric).median_ape)} for simply using the county median. EUR labels are themselves Arps extrapolations of short histories, and public data has no completion design. The app therefore shows first-12-month oil as the primary forecast ({pct((T.cum12.lightgbm_holdout as Metric).median_ape)} median error vs {pct((T.cum12.baseline_offset_average as Metric).median_ape)} for an offset average; {pct((T.cum12.lightgbm_holdout as Metric).within_25pct)} within ±25%, n={(T.cum12.lightgbm_holdout as Metric).n.toLocaleString()}) and EUR as secondary context.</li>
        <li><b>Even the 12-month forecast misses often.</b> About {pct(1 - (T.cum12.lightgbm_holdout as Metric).within_25pct)} of held-out wells land outside ±25%, and the P90–P10 band covers only ~two-thirds of outcomes (see calibration above), not the nominal 80%.</li>
        <li><b>Multi-well development is shown as pads, not wells.</b> Pads carry lease-level production only; you cannot read a single pad well’s performance from them, and pad volumes are not comparable 1:1 with a single well (compare per 1,000 ft of total lateral). Pads are not used to train or drive the model, so in pad-dominated areas the forecast still rests on the nearby single-well leases.</li>
        <li><b>Remaining gaps.</b> Mixed leases, permits/DUCs without production records, and wells with no location stay as coverage gaps (counts above).</li>
        <li><b>Screening, not reserves.</b> Not SEC/PRMS reserves; no economics, gas, water, landing zone, proppant or spacing.</li>
      </ul></div>

      <h2>Limitations — read before using a number</h2>
      <div className="card"><ul>
        <li><b>Not a reserves estimate.</b> Screening and offset-review tool only; not SEC/PRMS reserves and not a substitute for an engineer’s sign-off.</li>
        <li><b>EUR skill is weak.</b> On held-out wells the EUR model is roughly tied with a county median. Treat the 12-month forecast as the primary signal and EUR as context.</li>
        <li><b>Coverage gaps.</b> Pure-horizontal multi-well leases are shown as pads with lease-level production (no per-well split); mixed leases and wells without production records are excluded. Each report lists pads and counts the excluded wells in range.</li>
        <li><b>Public-data lag.</b> RRC production lags 2–3 months and is revised; the newest wells have short histories.</li>
        <li><b>Missing completion design.</b> No proppant, fluid, landing zone or spacing data — lateral length is the only design variable, and it is a surface→bottom-hole proxy.</li>
        <li><b>Oil only.</b> Gas/water forecasts, economics, seismic and SCADA are out of scope.</li>
      </ul></div>
      <p className="small mut">Reproduce: see the README in the GitHub repo (fetch_rrc → build_dataset → dca → train_model → export_web → tests).</p>
    </div></main>
  );
}
