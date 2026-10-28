import Link from "next/link";
import meta from "@/public/data/meta.json";

const pct = (x: number) => `${Math.round(x * 100)}%`;

export default function Home() {
  const t = meta.model.targets;
  const used = Object.values(meta.usable_by_county).reduce((a, b) => a + b, 0);
  const allH = Object.values(meta.horizontals_by_code).reduce((a, b) => a + b, 0);
  const lc = String(meta.last_complete_month);
  return (
    <main>
      <div className="wrap">
        <section className="hero">
          <span className="pill">Permian · Midland, Ector, Andrews (+ Martin) County, TX</span>
          <h1>Drop a pin. Get your <em>offsets, decline curves and first-year oil forecast</em> in seconds.</h1>
          <p>OffsetIQ finds every public horizontal near your location — single wells and multi-well pads — fits Arps decline curves to Texas RRC production, and forecasts first-12-month oil with a model trained only on real public wells. EUR is shown as secondary context only: on held-out wells it does not beat a county median. Coverage gaps are shown, not hidden.</p>
          <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
            <Link className="btn" href="/analyze">Open the analyzer →</Link>
            <Link className="btn ghost" href="/analyze?api=4232944570">See a blind backtest on a real well</Link>
          </div>
        </section>
        <div className="grid g4">
          <div className="card stat"><div className="v">{used.toLocaleString()}</div><div className="k">horizontals with well-level production</div>{meta.pads && <div className="small mut">+ {meta.pads.pads.toLocaleString()} multi-well pads ({meta.pads.wells_in_pads.toLocaleString()} wells, lease-level)</div>}</div>
          <div className="card stat"><div className="v">{allH.toLocaleString()}</div><div className="k">RRC horizontals mapped (incl. gaps)</div></div>
          <div className="card stat"><div className="v">{meta.dca.fitted.toLocaleString()}</div><div className="k">Arps decline fits</div></div>
          <div className="card stat"><div className="v">{lc.slice(0, 4)}-{lc.slice(4)}</div><div className="k">RRC production through</div></div>
        </div>

        <h2>Why offsets</h2>
        <div className="grid g3">
          <div className="card"><h3>The problem</h3><div className="mut">Every location decision starts with “what did the wells around it do?” Today that means pulling RRC data lease by lease, fixing APIs, fitting declines in spreadsheets — days of an engineer’s time per prospect.</div></div>
          <div className="card"><h3>Offsets are the prior</h3><div className="mut">In a factory-mode basin, nearby wells with similar laterals are the best public evidence for a new well. OffsetIQ makes that evidence instant, quantitative and auditable.</div></div>
          <div className="card"><h3>Honest by design</h3><div className="mut">Only real RRC wells. Multi-well horizontal leases (where Texas reports production at lease level) are shown as pads with lease-total production — never split into invented per-well volumes. Leases that mix horizontals with vertical wells are flagged as coverage gaps. Every number is reproducible from the public pipeline.</div></div>
        </div>

        <h2>Proof on real wells (held-out 2022+ wells)</h2>
        <div className="grid g3">
          <div className="card stat"><div className="small" style={{ color: "var(--acc)", fontWeight: 800, letterSpacing: ".06em" }}>PRIMARY FORECAST</div><div className="v">{pct(t.cum12.lightgbm_holdout!.median_ape)}</div><div className="k">median error, first-12-month oil</div><div className="small mut">vs {pct(t.cum12.baseline_offset_average!.median_ape)} for a naive offset average and {pct(t.cum12.baseline_county_median!.median_ape)} for county median · n = {t.cum12.lightgbm_holdout!.n.toLocaleString()}</div></div>
          <div className="card stat"><div className="v">{pct(t.cum12.lightgbm_holdout!.within_25pct)}</div><div className="k">of wells within ±25% (12-mo oil)</div><div className="small mut">trained on 2013–2021 wells only, tested on 2022–2025 wells</div></div>
          <div className="card stat" style={{ opacity: 0.75 }}><div className="small mut" style={{ fontWeight: 800, letterSpacing: ".06em" }}>SECONDARY</div><div className="v" style={{ fontSize: 20 }}>{pct(t.eur.lightgbm_holdout!.median_ape)}</div><div className="k">median error, EUR</div><div className="small mut">vs {pct(t.eur.baseline_county_median!.median_ape)} for a county median · n = {t.eur.lightgbm_holdout!.n.toLocaleString()}</div></div>
        </div>
        <p className="small" style={{ marginTop: 10 }}><b>Limitation:</b> EUR forecasts do not beat a simple county median on held-out wells — use OffsetIQ for first-year oil and offsets; treat EUR as context, not a number to bank. <Link href="/data#wrong">What the model gets wrong →</Link></p>
        <p className="mut small" style={{ marginTop: 14 }}>Sources: Texas Railroad Commission Production Data Query bulk dump ({meta.pdq_dump_date}) and RRC digital map well layers. Screening tool — not a reserves report. <Link href="/data">Full data provenance and model card →</Link></p>
      </div>
      <footer>OffsetIQ demo · Texas RRC public data · Auth and billing are demo stubs · Not affiliated with the RRC.</footer>
    </main>
  );
}
