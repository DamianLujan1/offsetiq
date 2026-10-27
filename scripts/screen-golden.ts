// Cross-language golden for the screening agent: lib/engine.ts analyze() (prospect
// mode, exactly what the Analyze page runs) on a fixed set of locations. The Python
// agent must reproduce it (tests/test_agent_parity.py), so a location screened by
// the agent gets the same numbers it gets on the Analyze page.
// Write: npm run golden:screen   Check (fixture == current analyze()): part of npm run test:ts
import { readFileSync, writeFileSync } from "node:fs";
import { analyze, DEFAULT_VINTAGE, PROSPECT_ASOF, SUPPORTED, type Filters, type Target } from "../lib/engine";
import { FEATURES, RADIUS_MI } from "../lib/features";
import type { Horizontals, ModelBundle, Wells } from "../lib/types";

const OUT = "tests/fixtures/screen_golden.json";
const load = (f: string) => JSON.parse(readFileSync(`public/data/${f}`, "utf8"));
const W: Wells = load("wells.json"), H: Horizontals = load("horizontals.json"), M: ModelBundle = load("model.json");

// Deterministic PRNG (mulberry32) so the case list never changes between runs.
let seed = 20261027;
const rand = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

// Bands by meaning, not by key name: which key holds the low case ("p10" or "p90") depends on the
// P-label convention lib/engine.ts uses, and this golden must hold under either.
const lohi = (b: object) => { const v = Object.values(b) as number[]; return { low: Math.min(...v), p50: (b as { p50: number }).p50, high: Math.max(...v) }; };

const laterals = [10000, 7500, 12500, 3500, 16000];
const radii = [3, 1, 0.5, 5, 1.5, 2];
const filterSets: Omit<Filters, "radiusMi">[] = [
  { minLatFt: null, maxLatFt: null, operator: "" },
  { minLatFt: 8000, maxLatFt: null, operator: "" },
  { minLatFt: null, maxLatFt: 11000, operator: "" },
  { minLatFt: null, maxLatFt: null, operator: "energy" },
  { minLatFt: 7000, maxLatFt: 13000, operator: "o" },
];
const points: [number, number, number?][] = [];
for (let i = 0; i < 40; i++) points.push([31.66 + rand() * 0.86, -103.05 + rand() * 1.35]);
for (let i = 0; i < W.n; i += 470) points.push([W.lat[i] + (rand() - 0.5) * 0.01, W.lon[i] + (rand() - 0.5) * 0.01]);
points.push([W.lat[17], W.lon[17]]);       // exactly on a well midpoint
points.push([33.2, -101.2], [31.0, -102.0]); // outside coverage
points.push([31.85, -102.45, 10]);          // sparse Ector, widest radius the app allows

const cases = points.map(([lat, lon, radius], k) => {
  const f: Filters = { radiusMi: radius ?? radii[k % radii.length], ...filterSets[k % filterSets.length] };
  const t: Target = { lat, lon, lateralFt: laterals[k % laterals.length], vintageYear: DEFAULT_VINTAGE, mode: "prospect", label: `case ${k}` };
  const r = analyze(W, H, M, t, f);
  return {
    input: { lat, lon, lateralFt: t.lateralFt, ...f },
    county: r.county, countyInferredFromMi: r.countyInferredFromMi, inCoverage: r.inCoverage,
    features: FEATURES.map((n) => (Number.isFinite(r.features[n]) ? r.features[n] : null)),
    cum12: lohi(r.cum12), eur: lohi(r.eur), modelOffsets: r.modelOffsets,
    offsets: r.offsets.map((o) => [o.api10, o.dist_mi]),
    excludedNearby: r.excludedNearby.map((e) => [e.label, e.count]),
    analogEur: r.analogEur, warnings: r.warnings,
  };
});
// One case per line keeps diffs readable when the data snapshot is refreshed.
const golden = `{"constants":${JSON.stringify({ PROSPECT_ASOF, DEFAULT_VINTAGE, SUPPORTED, RADIUS_MI, FEATURES })},\n"cases":[\n${cases.map((c) => JSON.stringify(c)).join(",\n")}\n]}\n`;

if (process.argv.includes("--check")) {
  const ok = readFileSync(OUT, "utf8") === golden;
  console.log(`${ok ? "PASS" : "FAIL"} screen golden: ${OUT} ${ok ? "matches" : "is stale vs"} current analyze() over ${cases.length} locations${ok ? "" : " (run npm run golden:screen)"}`);
  process.exit(ok ? 0 : 1);
}
writeFileSync(OUT, golden);
console.log(`wrote ${OUT}: ${cases.length} locations`);
