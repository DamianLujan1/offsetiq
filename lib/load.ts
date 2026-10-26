"use client";
import type { Horizontals, ModelBundle, Monthly, Wells } from "./types";

export interface Meta {
  last_complete_month: number; pdq_dump_date: string;
  coverage: Record<string, Record<string, number>>; usable_by_county: Record<string, number>;
  dca: { fitted: number; insufficient: number; median_eur_by_county: Record<string, number>; conf: Record<string, number> };
  model: { targets: Record<string, { lightgbm_holdout?: { median_ape: number; r2_log: number; within_25pct: number; n: number } }> };
  horizontals_by_code: Record<string, number>;
}
export interface Bundle { W: Wells; H: Horizontals; M: ModelBundle; MH: ModelBundle; meta: Meta }

let p: Promise<Bundle> | null = null;
export function loadAll(): Promise<Bundle> {
  if (!p) {
    const j = (f: string) => fetch(`/data/${f}`).then((r) => { if (!r.ok) throw new Error(`${f}: ${r.status}`); return r.json(); });
    p = Promise.all([j("wells.json"), j("horizontals.json"), j("model.json"), j("model_holdout.json"), j("meta.json")]).then(([W, H, M, MH, meta]) => ({ W, H, M, MH, meta }));
  }
  return p;
}
const mcache: Record<string, Promise<Monthly>> = {};
export function loadMonthly(county: string): Promise<Monthly> {
  const c = county.toLowerCase();
  if (!mcache[c]) mcache[c] = fetch(`/data/monthly_${c}.json`).then((r) => r.json());
  return mcache[c];
}
