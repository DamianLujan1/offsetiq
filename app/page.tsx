import Link from "next/link";
import BasinMap from "@/components/BasinMap";
import meta from "@/public/data/meta.json";

// BasinMap reads public/data at build time; keep this page prerendered.
export const dynamic = "force-static";

const pct = (x: number) => `${Math.round(x * 100)}%`;

export default function Home() {
  const t = meta.model.targets;
  const used = Object.values(meta.usable_by_county).reduce((a, b) => a + b, 0);
  const allH = Object.values(meta.horizontals_by_code).reduce((a, b) => a + b, 0);
  const lc = String(meta.last_complete_month);
  const yr = (ym: number) => String(ym).slice(0, 4);
  const models = [t.cum12.lightgbm_holdout!, t.cum12.baseline_offset_average!, t.cum12.baseline_county_median!];
  const eurModels = [t.eur.lightgbm_holdout!, t.eur.baseline_offset_average!, t.eur.baseline_county_median!];
  const row = (label: string, ms: { median_ape: number; within_25pct: number }[], k: "median_ape" | "within_25pct") => (
    <tr key={label}><td className="l">{label}</td>{ms.map((m, i) => <td key={i} className={i === 0 ? "us" : ""}>{pct(m[k])}</td>)}</tr>
  );
  return (
    <main>
      <section className="container hero">
        <div>
          <p className="eyebrow">Permian · Midland, Ector, Andrews &amp; Martin County, TX</p>
          <h1>Permian offsets, decline curves and EUR forecasts in seconds.</h1>
          <p className="lede">Drop a pin or enter an API or lease name. OffsetIQ finds every public horizontal nearby, fits Arps declines to Texas RRC production, and forecasts first-year oil and EUR with a model trained only on public wells. Coverage gaps are shown, not hidden.</p>
          <div className="actions">
            <Link className="btn" href="/analyze">Open the analyzer</Link>
            <Link className="arrow" href="/analyze?api=4232944570">Run a blind backtest on a real well →</Link>
          </div>
        </div>
        <BasinMap />
      </section>

      <section className="container">
        <div className="figures">
          <div><div className="v">{used.toLocaleString()}</div><div className="k">horizontals with well-level production</div></div>
          <div><div className="v">{allH.toLocaleString()}</div><div className="k">RRC horizontals mapped, including gaps</div></div>
          <div><div className="v">{meta.dca.fitted.toLocaleString()}</div><div className="k">Arps decline fits</div></div>
          <div><div className="v">{lc.slice(0, 4)}-{lc.slice(4)}</div><div className="k">RRC production through</div></div>
        </div>
      </section>

      <section className="container split">
        <div>
          <h2>Holdout accuracy</h2>
          <p className="hint">Trained on wells first producing {yr(t.cum12.train_first_prod[0])}–{yr(t.cum12.train_first_prod[1])}, scored on {t.cum12.lightgbm_holdout!.n.toLocaleString()} wells first producing {yr(t.cum12.test_first_prod[0])}–{yr(t.cum12.test_first_prod[1])} ({t.eur.lightgbm_holdout!.n.toLocaleString()} for EUR).</p>
        </div>
        <div>
          <table className="cmp">
            <thead><tr><th className="l" /><th className="us">OffsetIQ</th><th>Offset avg × lateral</th><th>County median</th></tr></thead>
            <tbody>
              {row("12-month oil · median error", models, "median_ape")}
              {row("12-month oil · within ±25%", models, "within_25pct")}
              {row("EUR · median error", eurModels, "median_ape")}
              {row("EUR · within ±25%", eurModels, "within_25pct")}
            </tbody>
          </table>
          <p className="hint">The 12-month forecast beats both baselines. EUR does not beat a county median on held-out wells, so treat it as context, not a forecast.</p>
        </div>
      </section>

      <section className="container split">
        <div>
          <h2>How it works</h2>
          <p className="hint">Texas RRC Production Data Query bulk dump ({meta.pdq_dump_date}) and RRC digital map well layers. <Link href="/data">Data provenance and model card</Link></p>
        </div>
        <div className="steps">
          <div><span className="n">01</span><h3>Offsets are the prior</h3><p>In a factory-mode basin, nearby wells with similar laterals are the best public evidence for a new well. Pulling them lease by lease and fitting declines in spreadsheets takes days per prospect.</p></div>
          <div><span className="n">02</span><h3>Real wells only</h3><p>Texas reports oil by lease, not by well. A horizontal is used only when its lease has exactly one well. Multi-well leases are flagged as coverage gaps, never allocated.</p></div>
          <div><span className="n">03</span><h3>Reproducible</h3><p>Every number traces back to public RRC data through a documented pipeline. A screening tool, not a reserves report.</p></div>
        </div>
      </section>

      <footer className="foot">
        <span>OffsetIQ demo · Texas RRC public data · Not affiliated with the RRC.</span>
        <span>Auth and billing are demo stubs.</span>
      </footer>
    </main>
  );
}
