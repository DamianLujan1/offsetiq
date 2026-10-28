import meta from "@/public/data/meta.json";

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const k = (x: number) => `${Math.round(x / 1000).toLocaleString()}k`;
const ym = (x: number | string) => { const s = String(x); return `${s.slice(0, 4)}-${s.slice(4)}`; };

type Metric = { n: number; r2_log: number; median_ape: number; mape: number; mae: number; within_25pct: number };

export default function DataPage() {
  const T = meta.model.targets as unknown as Record<string, Record<string, unknown>>;
  const counties = Object.keys(meta.coverage) as (keyof typeof meta.coverage)[];
  const labels = Object.keys(meta.horizontals_by_code);
  const row = (group: string, name: string, m: Metric) => (
    <tr key={`${group}-${name}`}><td className="l">{name}</td><td>{m.n.toLocaleString()}</td><td>{pct(m.median_ape)}</td><td>{pct(m.within_25pct)}</td><td>{m.r2_log.toFixed(3)}</td><td>{k(m.mae)} bbl</td></tr>
  );
  const fi = Object.entries(T.cum12.feature_importance_gain as Record<string, number>);
  return (
    <main className="doc">
      <header className="doc-head">
        <p className="eyebrow">Data &amp; model</p>
        <h1>Data provenance and model card</h1>
        <p>Everything in OffsetIQ is computed from Texas Railroad Commission (RRC) public data. No proprietary data, no synthetic wells. Where public data cannot attribute production to a single well, we show the well as a coverage gap instead of guessing.</p>
      </header>

      <section className="doc-sec"><h2>Sources</h2><div><ul>
        <li><b>Production &amp; completions:</b> RRC Production Data Query (PDQ) bulk dump, retrieved via the RRC public download site (MFT/GoAnywhere), dump dated <b>{meta.pdq_dump_date}</b>. Tables: <code>OG_LEASE_CYCLE_DATA_TABLE</code> (monthly lease oil/gas), <code>OG_WELL_COMPLETION_DATA_TABLE</code> (API ↔ lease link).</li>
        <li><b>Well locations &amp; laterals:</b> {meta.well_layer_source}. Lateral length is a proxy: straight-line surface-hole → bottom-hole displacement.</li>
        <li><b>Production window:</b> 2012-01 through <b>{ym(meta.last_complete_month)}</b> (last month treated as complete; RRC filings lag 2–3 months and later months are revised).</li>
        <li><b>Counties:</b> Midland, Ector, Andrews (v1 target) plus Martin. Martin is included because it is geologically continuous and well-covered; it is labelled “Martin” everywhere and is not hidden inside the core-three statistics.</li>
      </ul></div></section>

      <section className="doc-sec"><h2>Attribution rule<br /><span className="mut">Why coverage gaps exist</span></h2><div><p>Texas reports oil production by <b>lease</b>, not by well. A horizontal is used only when its lease has exactly one well (single-well lease), so lease production = well production. Multi-well leases (common for pad development) are excluded rather than allocated, because any allocation would be invented. This is the main coverage gap and is shown on the map as grey dots and listed in every report.</p></div></section>

      <section className="doc-sec"><h2>Coverage by county<br /><span className="mut">RRC well-layer county</span></h2><div>
      <div className="tscroll"><table>
        <thead><tr><th className="l">Status</th>{counties.map((c) => <th key={c}>{c}</th>)}<th>Total</th></tr></thead>
        <tbody>{labels.map((l) => (
          <tr key={l}><td className="l">{l}</td>{counties.map((c) => <td key={c}>{((meta.coverage[c] as Record<string, number>)[l] ?? 0).toLocaleString()}</td>)}<td><b>{(meta.horizontals_by_code as Record<string, number>)[l].toLocaleString()}</b></td></tr>
        ))}</tbody>
      </table></div>
      <p className="small mut">Usable wells by RRC-reported county: {Object.entries(meta.usable_by_county).map(([c, n]) => `${c} ${n.toLocaleString()}`).join(" · ")} (a handful of wells sit in one county’s map layer but report production in another).</p></div></section>

      <section className="doc-sec"><h2>Decline curves<br /><span className="mut">Arps</span></h2><div><p>Hyperbolic Arps fit from the peak month on monthly oil, switching to exponential at a 5%/yr terminal decline; economic limit 150 bbl/month; EUR = cumulative to date + remaining forecast. Same pipeline as the public Midland Basin DCA dashboard. Fits: <b>{meta.dca.fitted.toLocaleString()}</b> wells; <b>{meta.dca.insufficient.toLocaleString()}</b> have too little history (shown without EUR, never as zero). Confidence: high {meta.dca.conf.high.toLocaleString()} · medium {meta.dca.conf.medium.toLocaleString()} · low {meta.dca.conf.low.toLocaleString()}.</p>
      <p className="small mut">Median EUR (bbl oil): {Object.entries(meta.dca.median_eur_by_county).map(([c, v]) => `${c} ${k(v)}`).join(" · ")}</p></div></section>

      <section className="doc-sec"><h2>Model card</h2><div>
        <p><b>Model:</b> LightGBM gradient-boosted trees (log-space targets), plus quantile models for P10/P90. Params: {Object.entries(meta.model.params).filter(([n]) => n !== "verbose").map(([n, v]) => `${n}=${v}`).join(", ")}.</p>
        <p><b>Targets:</b> first-12-producing-month oil (cum12) and Arps EUR (EUR trained on high-confidence fits only).</p>
        <p><b>Features ({meta.model.features.length}):</b> {meta.model.features.join(", ")}. Offset features use wells within 3 miles, inverse-distance weighted (1/(d+0.25 mi)²).</p>
        <p><b>Leakage rules:</b> (1) a well is never its own offset; (2) an offset is visible only if its first 12 producing months were complete before the target first produced; (3) offset features use only those early months; (4) the target’s own production is used only as the label. Known mild leakage: the 3 early-decline cluster centroids are fit on all wells.</p>
        <p><b>Validation:</b> time split at first production {ym(meta.model.split_first_prod_ym)}. Train window {ym((T.cum12.train_first_prod as number[])[0])}–{ym((T.cum12.train_first_prod as number[])[1])}; test {ym((T.cum12.test_first_prod as number[])[0])}–{ym((T.cum12.test_first_prod as number[])[1])} (EUR test to {ym((T.eur.test_first_prod as number[])[1])}). The app’s backtest mode uses this holdout model, so wells first producing 2022+ are scored out-of-sample; older wells are flagged in-sample.</p>
        <div className="tscroll"><table><thead><tr><th className="l">Holdout</th><th>n</th><th>Median APE</th><th>Within ±25%</th><th>R² (log)</th><th>MAE</th></tr></thead>
          <tbody>
            <tr className="grp"><td className="l" colSpan={6}>First-12-month oil</td></tr>
            {row("cum12", "LightGBM", T.cum12.lightgbm_holdout as Metric)}
            {row("cum12", "Baseline: offset average × lateral", T.cum12.baseline_offset_average as Metric)}
            {row("cum12", "Baseline: county median", T.cum12.baseline_county_median as Metric)}
            <tr className="grp"><td className="l" colSpan={6}>EUR</td></tr>
            {row("eur", "LightGBM", T.eur.lightgbm_holdout as Metric)}
            {row("eur", "Baseline: offset average × lateral", T.eur.baseline_offset_average as Metric)}
            {row("eur", "Baseline: county median", T.eur.baseline_county_median as Metric)}
          </tbody></table></div>
        <p className="small">Quantile calibration on holdout: share of actuals ≥ P10 = {pct(T.cum12_p10.holdout_coverage as number)} (cum12), {pct(T.eur_p10.holdout_coverage as number)} (EUR); share ≤ P90 = {pct(T.cum12_p90.holdout_coverage as number)} (cum12), {pct(T.eur_p90.holdout_coverage as number)} (EUR). The P10–P90 band therefore covers ~67–68% of outcomes, narrower than the nominal 80%.</p>
        <p className="small"><b>Feature importance (cum12, gain share):</b> {fi.map(([n, v]) => `${n} ${(v * 100).toFixed(0)}%`).join(" · ")}</p>
        <p><b>Final models</b> are refit on all wells (cum12 n={String(T.cum12.n_final)}, EUR n={String(T.eur.n_final)}) and used for prospect pins.</p>
      </div></section>

      <section className="doc-sec"><h2>Limitations<br /><span className="mut">Read before using a number</span></h2><div><ul>
        <li><b>Not a reserves estimate.</b> Screening and offset-review tool only; not SEC/PRMS reserves and not a substitute for an engineer’s sign-off.</li>
        <li><b>EUR skill is weak.</b> On held-out wells the EUR model is roughly tied with a county median. Treat the 12-month forecast as the primary signal and EUR as context.</li>
        <li><b>Coverage gaps.</b> Multi-well leases (~half of all horizontals) are excluded; areas developed mostly with pads will have few usable offsets. Each report counts the excluded wells in range.</li>
        <li><b>Public-data lag.</b> RRC production lags 2–3 months and is revised; the newest wells have short histories.</li>
        <li><b>Missing completion design.</b> No proppant, fluid, landing zone or spacing data — lateral length is the only design variable, and it is a surface→bottom-hole proxy.</li>
        <li><b>Oil only.</b> Gas/water forecasts, economics, seismic and SCADA are out of scope.</li>
      </ul>
      <p className="small mut" style={{ marginTop: 20 }}>Reproduce: see the README in the GitHub repo (fetch_rrc → build_dataset → dca → train_model → export_web → tests).</p>
      </div></section>
    </main>
  );
}
