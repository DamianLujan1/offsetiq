// Golden parity tests: TypeScript feature engineering + LightGBM evaluator vs Python.
// Run: npm run test:ts
import { readFileSync } from "node:fs";
import { computeFeatures, FEATURES } from "../lib/features";
import { predictRaw } from "../lib/model";
import type { ModelBundle, Wells } from "../lib/types";

const load = (f: string) => JSON.parse(readFileSync(`public/data/${f}`, "utf8"));
const W: Wells = load("wells.json");
const M: ModelBundle = load("model.json");
const GM = load("golden_model.json");
const MH: ModelBundle = load("model_holdout.json");
const GF = load("golden_features.json");
let fail = 0;

// 1) model evaluator parity on Python feature rows
for (const k of Object.keys(M)) {
  let maxd = 0;
  GM.rows.forEach((row: (number | null)[], i: number) => { maxd = Math.max(maxd, Math.abs(predictRaw(M[k], row) - GM.pred_log[k][i])); });
  const ok = maxd < 1e-9;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} model ${k}: max |TS-Python| log-pred = ${maxd.toExponential(2)} over ${GM.rows.length} rows`);
}

for (const k of Object.keys(MH)) {
  let maxd = 0;
  GM.rows.forEach((row: (number | null)[], i: number) => { maxd = Math.max(maxd, Math.abs(predictRaw(MH[k], row) - GM.pred_log_holdout[k][i])); });
  const ok = maxd < 1e-9;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} holdout model ${k}: max |TS-Python| = ${maxd.toExponential(2)}`);
}

// 2) feature parity: TS features from exported wells.json vs Python training table
const idx = new Map(W.api10.map((a, i) => [a, i]));
let worst = 0, worstName = "", predWorst = 0;
GF.api10.forEach((api: string, r: number) => {
  const i = idx.get(api)!;
  const f = computeFeatures(W, { lat: W.lat[i], lon: W.lon[i], lateralFt: GF.rows[r][0], county: W.county[i],
    vintageYear: Math.floor(W.first[i] / 100), asofYm: W.first[i], excludeIdx: i });
  FEATURES.forEach((k, j) => {
    const py = GF.rows[r][j]; const ts = f[k];
    const bothNan = (py === null) && !Number.isFinite(ts);
    if (bothNan) return;
    const rel = Math.abs(ts - py) / Math.max(1e-3, Math.abs(py));
    if (!(rel <= worst)) { worst = Number.isFinite(rel) ? Math.max(worst, rel) : Infinity; worstName = `${api}:${k}`; }
  });
  const tsx = FEATURES.map((k) => (Number.isFinite(f[k]) ? f[k] : null));
  predWorst = Math.max(predWorst, Math.abs(predictRaw(M.cum12, tsx) - predictRaw(M.cum12, GF.rows[r])));
});
const okF = worst < 1e-4;
if (!okF) fail++;
console.log(`${okF ? "PASS" : "FAIL"} features: max relative diff ${worst.toExponential(2)} (${worstName}) over ${GF.api10.length} wells`);
const okP = predWorst < 1e-6;
if (!okP) fail++;
console.log(`${okP ? "PASS" : "FAIL"} end-to-end cum12 log-pred diff from TS features: ${predWorst.toExponential(2)}`);
process.exit(fail ? 1 : 0);
