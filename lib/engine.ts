import { computeFeatures, featureVector, RADIUS_MI } from "./features";
import { haversineMi } from "./geo";
import { predictRaw } from "./model";
import type { Horizontals, ModelBundle, N, Wells } from "./types";

export const PROSPECT_ASOF = 999912;
export const DEFAULT_VINTAGE = 2025; // latest vintage with full 12-month history in training
export const SUPPORTED = ["ANDREWS", "ECTOR", "MIDLAND", "MARTIN"];

export interface Target {
  lat: number; lon: number; lateralFt: number; vintageYear: number;
  mode: "prospect" | "backtest";
  wellIdx?: number;       // set in backtest mode: an existing usable well
  label: string;
}
export interface Filters { radiusMi: number; minLatFt: number | null; maxLatFt: number | null; operator: string }

export interface OffsetRow {
  idx: number; api10: string; lease: string; well_no: string; operator: string; field: string; county: string;
  dist_mi: number; lateral_ft: number; first_prod: number; months: number; cum_oil: number;
  cum12: N; qi: N; Di_annual: N; b: N; r2: N; eur: N; remaining: N; eur_per_kft: N;
  cluster: string; confidence: string; status: string;
}
/** PRMS convention: p90 = low case (90% chance actual >= it), p10 = high case. */
export interface Band { p90: number; p50: number; p10: number }
export interface Result {
  target: Target; county: string; countyInferredFromMi: number; inCoverage: boolean;
  offsets: OffsetRow[]; excludedNearby: { label: string; count: number }[]; modelOffsets: number;
  features: Record<string, number>;
  cum12: Band; eur: Band; analogEur: { value: number; n: number } | null;
  actual?: { cum12: N; eur: N; conf: string; first: number };
  warnings: string[]; ms: number; sample: "prospect" | "out_of_sample" | "in_sample";
}

const band = (lo: number, mid: number, hi: number): Band => {
  const s = [lo, mid, hi].sort((a, b) => a - b);
  return { p90: s[0], p50: mid < s[0] ? s[0] : mid > s[2] ? s[2] : mid, p10: s[2] };
};

export function inferCounty(W: Wells, H: Horizontals, lat: number, lon: number) {
  let best = Infinity, c = "";
  for (let i = 0; i < H.lat.length; i++) {
    const d = haversineMi(lat, lon, H.lat[i], H.lon[i]);
    if (d < best) { best = d; c = H.county[i]; }
  }
  return { county: c, dist: best };
}

export const HOLDOUT_SPLIT_YM = 202201;

/** M = final model (all wells). MH = holdout model trained only on wells first producing before
 *  HOLDOUT_SPLIT_YM; backtests use MH so wells from 2022+ are scored truly out-of-sample. */
export function analyze(W: Wells, H: Horizontals, Mfinal: ModelBundle, t: Target, f: Filters, MH?: ModelBundle): Result {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const warnings: string[] = [];
  const back = t.mode === "backtest" && t.wellIdx !== undefined;
  const M = back && MH ? MH : Mfinal;
  const sample: Result["sample"] = !back ? "prospect" : MH && W.first[t.wellIdx!] >= HOLDOUT_SPLIT_YM ? "out_of_sample" : "in_sample";
  if (sample === "in_sample") warnings.push("This well first produced before 2022, so it was in the model's training set — this backtest is in-sample (optimistic). Wells first producing 2022+ are scored out-of-sample.");
  const asof = back ? W.first[t.wellIdx!] : PROSPECT_ASOF;
  const cty = back ? { county: W.county[t.wellIdx!], dist: 0 } : inferCounty(W, H, t.lat, t.lon);
  const inCoverage = cty.dist <= 5 && SUPPORTED.includes(cty.county);
  if (!inCoverage) warnings.push(`Nearest RRC horizontal in the shipped dataset is ${cty.dist.toFixed(1)} mi away — this point is outside OffsetIQ v1 coverage (Andrews, Ector, Midland, Martin). Forecast is extrapolation.`);

  // ---- offset table (display) ----
  const offsets: OffsetRow[] = [];
  for (let i = 0; i < W.n; i++) {
    if (back && i === t.wellIdx) continue;
    if (back && !(W.first[i] < asof)) continue; // backtest: only wells online before target
    const d = haversineMi(t.lat, t.lon, W.lat[i], W.lon[i]);
    if (d > f.radiusMi) continue;
    if (f.minLatFt !== null && W.lat_ft[i] < f.minLatFt) continue;
    if (f.maxLatFt !== null && W.lat_ft[i] > f.maxLatFt) continue;
    if (f.operator && !W.operator[i].toLowerCase().includes(f.operator.toLowerCase())) continue;
    offsets.push({
      idx: i, api10: W.api10[i], lease: W.lease[i], well_no: W.well_no[i], operator: W.operator[i], field: W.field[i],
      county: W.county[i], dist_mi: d, lateral_ft: W.lat_ft[i], first_prod: W.first[i], months: W.months[i],
      cum_oil: W.cum_oil[i], cum12: W.cum12[i], qi: W.qi[i], Di_annual: W.Di[i], b: W.b[i], r2: W.r2[i],
      eur: W.eur[i], remaining: W.rem[i], eur_per_kft: W.eur_kft[i], cluster: W.cluster[i], confidence: W.conf[i],
      status: W.status[i],
    });
  }
  offsets.sort((a, b) => a.dist_mi - b.dist_mi);

  // horizontals within radius that exist but are excluded (coverage gaps)
  const ex = new Map<number, number>();
  for (let i = 0; i < H.lat.length; i++) {
    if (H.code[i] === 0) continue;
    if (haversineMi(t.lat, t.lon, H.lat[i], H.lon[i]) <= f.radiusMi) ex.set(H.code[i], (ex.get(H.code[i]) ?? 0) + 1);
  }
  const excludedNearby = [...ex.entries()].sort((a, b) => a[0] - b[0]).map(([c, n]) => ({ label: H.labels[c], count: n }));

  // ---- model ----
  const feats = computeFeatures(W, {
    lat: t.lat, lon: t.lon, lateralFt: t.lateralFt, county: cty.county, vintageYear: t.vintageYear,
    asofYm: asof, excludeIdx: back ? t.wellIdx : undefined,
  });
  const x = featureVector(feats);
  const p = (k: string) => Math.exp(predictRaw(M[k], x));
  // Model keys are quantile alphas: "_p10" is the alpha-0.1 (low) model, i.e. the PRMS P90.
  const cum12 = band(p("cum12_p10"), p("cum12"), p("cum12_p90"));
  const eur = band(p("eur_p10"), p("eur"), p("eur_p90"));
  if (feats.n_off < 3) warnings.push(`Only ${feats.n_off} offset(s) with an early decline fit within ${RADIUS_MI} mi${back ? " before this well came online" : ""} — forecast leans on location + lateral length; treat as low confidence.`);
  if (t.lateralFt > 15000 || t.lateralFt < 4000) warnings.push(`Lateral ${Math.round(t.lateralFt).toLocaleString()} ft is near the edge of the training distribution (most wells 7,000–15,000 ft).`);

  // Offset-analog EUR: IDW of offsets' DCA EUR/1,000 ft (high/medium confidence) x lateral. Prospect mode only
  let analogEur: Result["analogEur"] = null;
  if (!back) {
    let ws = 0, v = 0, n = 0;
    for (const o of offsets) {
      if (o.eur_per_kft === null || (o.confidence !== "high" && o.confidence !== "medium")) continue;
      const w = 1 / (o.dist_mi + 0.25) ** 2; ws += w; v += w * o.eur_per_kft; n++;
    }
    if (n > 0) analogEur = { value: (v / ws) * (t.lateralFt / 1000), n };
  }
  const actual = back ? { cum12: W.cum12[t.wellIdx!], eur: W.eur[t.wellIdx!], conf: W.conf[t.wellIdx!], first: W.first[t.wellIdx!] } : undefined;
  const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
  return {
    target: t, county: cty.county, countyInferredFromMi: cty.dist, inCoverage, offsets, excludedNearby,
    modelOffsets: feats.n_off, features: feats, cum12, eur, analogEur, actual, warnings, ms: t1 - t0, sample,
  };
}

// ---------- formatting / report ----------
export const fmtInt = (v: N | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : Math.round(v).toLocaleString("en-US"));
export const fmtK = (v: N | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${(v / 1000).toLocaleString("en-US", { maximumFractionDigits: 0 })}k`);
export const fmtYm = (ym: number) => `${String(ym).slice(0, 4)}-${String(ym).slice(4, 6)}`;
const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

export function summarize(r: Result, radiusMi: number, meta: { last_complete_month: number; cum12MedApe: number; eurMedApe: number }): string {
  const t = r.target, o = r.offsets;
  const fitted = o.filter((x) => x.eur !== null);
  const med = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const exN = r.excludedNearby.reduce((s, e) => s + e.count, 0);
  const parts: string[] = [];
  const where = t.mode === "backtest"
    ? `Backtest of ${t.label}: treating it as undrilled as of ${fmtYm(r.actual!.first)} (only wells online before then are offsets). `
    : `For a ${fmtInt(t.lateralFt)} ft lateral at ${t.lat.toFixed(4)}, ${t.lon.toFixed(4)} (${titleCase(r.county || "unknown")} County): `;
  parts.push(`${where}OffsetIQ found ${o.length} public single-well-lease horizontal${o.length === 1 ? "" : "s"} within ${radiusMi} mi${exN ? `, plus ${exN} more horizontal${exN === 1 ? "" : "s"} whose production the RRC reports at lease level or not at all (mostly multi-well leases) — shown on the map as coverage gaps, not used` : ""}.`);
  if (o.length) parts.push(`The nearest is ${o[0].lease} ${o[0].well_no} (${o[0].operator}) at ${o[0].dist_mi.toFixed(2)} mi.`);
  if (fitted.length) parts.push(`${fitted.length} of them have an Arps decline fit, with a median EUR of ${fmtK(med(fitted.map((x) => x.eur as number)))} bbl oil and median ${fmtInt(med(fitted.filter((x) => x.eur_per_kft !== null).map((x) => x.eur_per_kft as number)))} bbl per 1,000 ft of lateral.`);
  parts.push(`The LightGBM model (trained only on public RRC wells, using offsets known before each well came online) forecasts first-12-month oil of ${fmtK(r.cum12.p50)} bbl (P90–P10 ${fmtK(r.cum12.p90)}–${fmtK(r.cum12.p10)}) and EUR of ${fmtK(r.eur.p50)} bbl (P90–P10 ${fmtK(r.eur.p90)}–${fmtK(r.eur.p10)}).`);
  if (r.analogEur) parts.push(`A simple offset-analog (distance-weighted EUR per foot × lateral) gives ${fmtK(r.analogEur.value)} bbl from ${r.analogEur.n} offsets.`);
  if (r.actual) {
    const a12 = r.actual.cum12, ae = r.actual.eur;
    if (a12 !== null) parts.push(`Actual first-12-month oil was ${fmtK(a12)} bbl (model error ${(((r.cum12.p50 - a12) / a12) * 100).toFixed(0)}%).`);
    if (ae !== null && r.actual.conf !== "none") parts.push(`Its own DCA EUR is ${fmtK(ae)} bbl (${r.actual.conf} confidence; model error ${(((r.eur.p50 - ae) / ae) * 100).toFixed(0)}%).`);
  }
  parts.push(`On wells first producing 2022 or later (held out), typical (median) error was ${(meta.cum12MedApe * 100).toFixed(0)}% for 12-month oil and ${(meta.eurMedApe * 100).toFixed(0)}% for EUR. Data: Texas RRC production through ${fmtYm(meta.last_complete_month)}. Screening estimate only — not a reserves report.`);
  return parts.join(" ");
}

export const CSV_COLUMNS: [keyof OffsetRow, string][] = [
  ["api10", "API"], ["lease", "Lease"], ["well_no", "Well #"], ["operator", "Operator"], ["field", "RRC field"],
  ["county", "County"], ["dist_mi", "Distance (mi)"], ["lateral_ft", "Lateral proxy SHL-BHL (ft)"],
  ["first_prod", "First prod (YYYYMM)"], ["months", "Months reported"], ["cum_oil", "Cum oil (bbl)"],
  ["cum12", "First-12-mo oil (bbl)"], ["qi", "Arps qi (bbl/mo)"], ["Di_annual", "Arps Di (nominal /yr)"], ["b", "Arps b"],
  ["r2", "Fit R2"], ["eur", "EUR (bbl)"], ["remaining", "Remaining (bbl)"], ["eur_per_kft", "EUR per 1,000 ft"],
  ["cluster", "Decline cluster"], ["confidence", "EUR confidence"],
];

/** One CSV cell: blank for missing, integers as-is, other numbers to 4 dp, quoted when needed. */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(4)) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(r: Result): string {
  const esc = csvCell;
  const head = [
    `# OffsetIQ offset report — ${r.target.label}`,
    `# Target lat,lon: ${r.target.lat.toFixed(6)},${r.target.lon.toFixed(6)}; lateral ${Math.round(r.target.lateralFt)} ft; mode ${r.target.mode}`,
    `# Forecast cum12 P90/P50/P10 (bbl; PRMS: P90 low case, P10 high case): ${Math.round(r.cum12.p90)}/${Math.round(r.cum12.p50)}/${Math.round(r.cum12.p10)}`,
    `# Forecast EUR P90/P50/P10 (bbl; PRMS: P90 low case, P10 high case): ${Math.round(r.eur.p90)}/${Math.round(r.eur.p50)}/${Math.round(r.eur.p10)}`,
    `# Source: Texas RRC PDQ dump (production) + RRC well layers. Blank = not available (insufficient history). Not a reserves report.`,
  ];
  const lines = [CSV_COLUMNS.map((c) => c[1]).join(",")];
  for (const o of r.offsets) lines.push(CSV_COLUMNS.map(([k]) => esc(o[k])).join(","));
  return head.join("\n") + "\n" + lines.join("\n") + "\n";
}
