import { haversineMi } from "./geo";
import type { Wells } from "./types";

/** Keep in lock-step with pipeline/features.py (golden-tested). */
export const RADIUS_MI = 3.0;
export const FEATURES = [
  "lateral_proxy_ft", "mid_lat", "mid_lon", "county_code", "vintage_year",
  "n_off", "d_nearest_mi", "idw_cum12_per_kft", "idw_early_qi", "idw_early_Di",
  "idw_early_b", "frac_steep", "frac_mild", "off_cum12_scaled",
] as const;
export const COUNTY_CODE: Record<string, number> = { ANDREWS: 0, ECTOR: 1, MIDLAND: 2, MARTIN: 3 };

export interface FeatureInput {
  lat: number; lon: number; lateralFt: number; county: string; vintageYear: number;
  asofYm: number;          // offsets visible only if early_known_ym < asofYm (leakage rule 2)
  excludeIdx?: number;     // target's own index is never an offset (leakage rule 1)
}

export function computeFeatures(W: Wells, inp: FeatureInput): Record<string, number> {
  let n = 0, wsum = 0, dmin = Infinity;
  let c12w = 0, c12ws = 0, qiw = 0, diw = 0, bw = 0, steep = 0, mild = 0;
  const raw: { d: number; i: number }[] = [];
  for (let i = 0; i < W.n; i++) {
    if (W.e_Di[i] === null || W.e_known[i] === null) continue;
    if (i === inp.excludeIdx) continue;
    if (!((W.e_known[i] as number) < inp.asofYm)) continue;
    const d = haversineMi(inp.lat, inp.lon, W.lat[i], W.lon[i]);
    if (d <= RADIUS_MI) raw.push({ d, i });
  }
  for (const { d, i } of raw) {
    const w = 1 / (d + 0.25) ** 2;
    wsum += w; n++; dmin = Math.min(dmin, d);
  }
  for (const { d, i } of raw) {
    const w = 1 / (d + 0.25) ** 2 / wsum;
    const c12 = W.cum12[i];
    if (c12 !== null) { const v = c12 / (W.lat_ft[i] / 1000); c12w += w * v; c12ws += w; }
    qiw += w * (W.e_qi[i] as number); diw += w * (W.e_Di[i] as number); bw += w * (W.e_b[i] as number);
    if (W.e_cl[i] === 0) steep++;
    if (W.e_cl[i] === 2) mild++;
  }
  const f: Record<string, number> = {
    lateral_proxy_ft: inp.lateralFt, mid_lat: inp.lat, mid_lon: inp.lon,
    county_code: COUNTY_CODE[inp.county] ?? NaN, vintage_year: inp.vintageYear, n_off: n,
  };
  if (n === 0) {
    for (const k of ["d_nearest_mi", "idw_cum12_per_kft", "idw_early_qi", "idw_early_Di", "idw_early_b", "frac_steep", "frac_mild", "off_cum12_scaled"]) f[k] = NaN;
    return f;
  }
  f.d_nearest_mi = dmin;
  f.idw_cum12_per_kft = c12ws > 0 ? c12w / c12ws : NaN;
  f.idw_early_qi = qiw; f.idw_early_Di = diw; f.idw_early_b = bw;
  f.frac_steep = steep / n; f.frac_mild = mild / n;
  f.off_cum12_scaled = f.idw_cum12_per_kft * inp.lateralFt / 1000;
  return f;
}

export function featureVector(f: Record<string, number>): (number | null)[] {
  return FEATURES.map((k) => (Number.isFinite(f[k]) ? f[k] : null));
}
