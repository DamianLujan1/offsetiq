"use client";
import type { Horizontals, ModelBundle, Monthly, Pads, Wells } from "./types";

export interface Metric { n: number; median_ape: number; r2_log: number; within_25pct: number; mape?: number; mae?: number }
export interface Meta {
  last_complete_month: number; pdq_dump_date: string;
  coverage: Record<string, Record<string, number>>; usable_by_county: Record<string, number>;
  dca: { fitted: number; insufficient: number; median_eur_by_county: Record<string, number>; conf: Record<string, number> };
  model: {
    split_first_prod_ym: number;
    targets: Record<string, { n_train?: number; train_first_prod?: number[]; test_first_prod?: number[];
      lightgbm_holdout?: Metric; baseline_county_median?: Metric; baseline_offset_average?: Metric }>;
  };
  pads?: { pads: number; wells_in_pads: number; fitted: number } | null;
  horizontals_by_code: Record<string, number>;
}
export interface Bundle { W: Wells; H: Horizontals; M: ModelBundle; MH: ModelBundle; meta: Meta; P: Pads }

let p: Promise<Bundle> | null = null;
export function loadAll(): Promise<Bundle> {
  if (!p) {
    const j = (f: string) => fetch(`/data/${f}`).then((r) => { if (!r.ok) throw new Error(`${f}: ${r.status}`); return r.json(); });
    p = Promise.all([j("wells.json"), j("horizontals.json"), j("model.json"), j("model_holdout.json"), j("meta.json"), j("pads.json")])
      .then(([W, H, M, MH, meta, P]) => ({ W, H, M, MH, meta, P }))
      .catch((e) => { p = null; throw e; }); // don't cache a failed load; allow retry
  }
  return p;
}
const mcache: Record<string, Promise<Monthly>> = {};
export function loadMonthly(county: string): Promise<Monthly> {
  const c = county.toLowerCase();
  if (!mcache[c]) {
    mcache[c] = fetch(`/data/monthly_${c}.json`)
      .then((r) => { if (!r.ok) throw new Error(`monthly_${c}.json: ${r.status}`); return r.json(); })
      .catch((e) => { delete mcache[c]; throw e; });
  }
  return mcache[c];
}
let pm: Promise<Monthly> | null = null;
export function loadPadMonthly(): Promise<Monthly> {
  if (!pm) pm = fetch("/data/pads_monthly.json").then((r) => { if (!r.ok) throw new Error(`pads_monthly.json: ${r.status}`); return r.json(); })
    .catch((e) => { pm = null; throw e; });
  return pm;
}
