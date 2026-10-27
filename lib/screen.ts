// Screen mode: the browser half of the screening agent. Types for the agent's NDJSON
// events (agent/loop.py), the operator's review (exclude / re-rank / approve), and the
// approved report's exports: CSV (csvCell from engine.ts), print/PDF, and a share link
// that carries the report itself after the '#', so nothing is stored anywhere.
import { csvCell, fmtYm } from "./engine";

export interface Band { p10: number; p50: number; p90: number }
export interface Rationale { headline: string; details: string[]; why: string }
export interface Row {
  id: string; rank: number; region: string; lat: number; lon: number; county: string;
  tier: "supported" | "low_confidence"; cum12: Band; eur: Band; model_offsets: number; nearest_model_offset_mi: number | null;
  evidence: { radius_mi: number; n: number; median_cum12: number | null; n_cum12: number; median_eur: number | null; n_eur: number;
    nearest: { api10: string; lease: string; well_no: string; operator: string; dist_mi: number } | null; apis: string[] };
  gaps: { multi_well: number; other: number }; analog_eur: { value: number; n: number } | null; flags: string[];
  rationale: Rationale; analyze_url: string;
}
export interface Region { label: string; kind: "county" | "polygon" | "point" | "lease"; ring: [number, number][]; point: [number, number] | []; source: string; detail: string }
export interface Intent {
  action: "rank" | "screen" | "compare"; spacing_acres: number; lateral_ft: number; radius_mi: number; top_n: number;
  filters: { min_lat_ft: number | null; max_lat_ft: number | null; operator: string; min_first_ym: number | null; max_first_ym: number | null };
  formats: ("csv" | "pdf" | "link")[]; notes: string[]; unsupported: string[]; clarify: string | null; regions: Region[];
}
export interface Tract { region: string; candidates: number; ranked: number; unranked: number; best_rank: number | null; best_cum12_p50: number | null;
  median_cum12_p50: number | null; median_eur_p50: number | null; median_model_offsets: number | null; distinct_multi_well_gaps: number; rationale: string }
export interface Proposal {
  type: "proposal"; prompt: string; intent: Intent; plan: { spacing_acres: number; regions: { label: string; kind: string; candidates: number; detail: string }[] };
  ranked: Row[]; ranked_total: number; unranked: { outside_coverage: number; no_model_offsets: number; low_confidence_ranked: number };
  tracts: Tract[]; summary: string[];
  candidates: { id: string[]; lat: number[]; lon: number[]; region: number[]; p50: (number | null)[]; rank: (number | null)[]; status: string[] };
  model: { cum12_median_ape: number; eur_median_ape: number }; data: { pdq_dump_date: string; last_complete_month: number; source: string };
  run: { ms: number; screen_ms: number; workers: number; max_in_flight: number; batches: number; candidates: number; unique_locations: number };
}
export interface Step { type: "step"; id: string; title: string; detail: string; notes?: string[]; unsupported?: string[]; intent?: Intent }
export type AgentEvent = Step | { type: "progress"; done: number; total: number } | { type: "clarify"; question: string; intent: Intent }
  | Proposal | { type: "error"; message: string };

/** Split a growing NDJSON buffer into complete events and the unfinished tail. */
export function ndjson(buf: string): { events: AgentEvent[]; rest: string } {
  const events: AgentEvent[] = [];
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) events.push(JSON.parse(line) as AgentEvent);
  }
  return { events, rest: buf };
}

// ---------- operator review: the agent proposes, the operator decides ----------
export interface Review { order: string[]; excluded: string[]; approved: { at: string; ids: string[] } | null }

export const startReview = (p: Proposal): Review => ({ order: p.ranked.map((r) => r.id), excluded: [], approved: null });
/** Every edit clears the approval: an approval covers exactly the list that was approved. */
export function move(r: Review, id: string, dir: -1 | 1): Review {
  const i = r.order.indexOf(id), j = i + dir;
  if (i < 0 || j < 0 || j >= r.order.length) return r;
  const order = [...r.order];
  [order[i], order[j]] = [order[j], order[i]];
  return { ...r, order, approved: null };
}
export function toggle(r: Review, id: string): Review {
  const excluded = r.excluded.includes(id) ? r.excluded.filter((x) => x !== id) : [...r.excluded, id];
  return { ...r, excluded, approved: null };
}
export const resetOrder = (r: Review, p: Proposal): Review => ({ ...r, order: p.ranked.map((x) => x.id), approved: null });
export const included = (r: Review): string[] => r.order.filter((id) => !r.excluded.includes(id));
export const approve = (r: Review, at = new Date().toISOString()): Review => ({ ...r, approved: { at, ids: included(r) } });
export const edited = (r: Review, p: Proposal): boolean => r.excluded.length > 0 || r.order.some((id, i) => id !== p.ranked[i]?.id);

// ---------- the approved report (what every export contains) ----------
export interface ReportRow {
  rank: number; agentRank: number; id: string; region: string; lat: number; lon: number; county: string; tier: string;
  cum12: Band; eur: Band; offsets: number; medianCum12: number | null; modelOffsets: number; multiWell: number; otherGaps: number;
  flags: string[]; headline: string; details: string[]; why: string;
}
export interface Report {
  v: 1; prompt: string; plan: string; approvedAt: string; spacingAcres: number; lateralFt: number; radiusMi: number;
  filters: Intent["filters"]; data: { pdq_dump_date: string; last_complete_month: number };
  model: { cum12_median_ape: number; eur_median_ape: number }; proposed: number; edited: boolean; summary: string[];
  regions: { label: string; ring: [number, number][] }[]; rows: ReportRow[];
}

export function buildReport(p: Proposal, r: Review, plan: string): Report {
  if (!r.approved) throw new Error("Approve the list before exporting.");
  const byId = new Map(p.ranked.map((x) => [x.id, x]));
  const rows = r.approved.ids.map((id, i): ReportRow => {
    const x = byId.get(id)!;
    return { rank: i + 1, agentRank: x.rank, id: x.id, region: x.region, lat: x.lat, lon: x.lon, county: x.county, tier: x.tier,
      cum12: x.cum12, eur: x.eur, offsets: x.evidence.n, medianCum12: x.evidence.median_cum12, modelOffsets: x.model_offsets,
      multiWell: x.gaps.multi_well, otherGaps: x.gaps.other, flags: x.flags, headline: x.rationale.headline,
      details: x.rationale.details, why: x.rationale.why };
  });
  const i = p.intent;
  return { v: 1, prompt: p.prompt, plan, approvedAt: r.approved.at, spacingAcres: p.plan.spacing_acres, lateralFt: i.lateral_ft,
    radiusMi: i.radius_mi, filters: i.filters, data: { pdq_dump_date: p.data.pdq_dump_date, last_complete_month: p.data.last_complete_month },
    model: p.model, proposed: p.ranked.length, edited: edited(r, p), summary: p.summary,
    regions: i.regions.filter((g) => g.ring.length >= 3).map((g) => ({ label: g.label, ring: g.ring })), rows };
}

/** Analyze-page deep link for a location (the existing shareable-link format), rebuilt from numbers only. */
export function analyzeHref(lat: number, lon: number, lateralFt: number, radiusMi: number, f?: Intent["filters"]): string {
  const q = new URLSearchParams({ lat: lat.toFixed(6), lon: lon.toFixed(6), lat_ft: String(Math.round(lateralFt)), r: String(radiusMi) });
  if (f?.min_lat_ft != null) q.set("min", String(Math.round(f.min_lat_ft)));
  if (f?.max_lat_ft != null) q.set("max", String(Math.round(f.max_lat_ft)));
  if (f?.operator) q.set("op", f.operator);
  return `/analyze?${q.toString()}`;
}

export const REPORT_COLUMNS = [
  "Your rank", "Agent rank", "Location ID", "Area", "Lat (NAD83)", "Lon (NAD83)", "County", "Evidence tier",
  "12-mo oil P10 (bbl)", "12-mo oil P50 (bbl)", "12-mo oil P90 (bbl)", "EUR P10 (bbl)", "EUR P50 (bbl)", "EUR P90 (bbl)",
  "Offsets within radius", "Median actual 12-mo oil of those (bbl)", "Wells feeding the model (3 mi)",
  "Multi-well-lease gaps within radius (not used)", "Other unused horizontals within radius", "Flags",
  "Rationale", "Rationale details", "Why this rank (agent)", "Open in Analyze",
];

export function reportCsv(rep: Report, origin = ""): string {
  const r = Math.round;
  const head = [
    `# OffsetIQ screening report: ${rep.prompt.replace(/\s+/g, " ")}`,
    `# Approved by the operator ${rep.approvedAt}: ${rep.rows.length} of ${rep.proposed} proposed locations kept${rep.edited ? "; order or selection edited by the operator" : "; agent order unchanged"}.`,
    `# Plan: ${rep.plan} Spacing ${rep.spacingAcres} acres; lateral ${r(rep.lateralFt)} ft; offset radius ${rep.radiusMi} mi.`,
    `# Source: Texas RRC public data (PDQ dump ${rep.data.pdq_dump_date}; production through ${fmtYm(rep.data.last_complete_month)}). Multi-well-lease wells are counted as coverage gaps, never given volumes. Blank = not available.`,
    `# Model median error on held-out 2022+ wells: ${r(rep.model.cum12_median_ape * 100)}% (12-mo oil), ${r(rep.model.eur_median_ape * 100)}% (EUR). Screening estimate, not a reserves report.`,
  ];
  const lines = [REPORT_COLUMNS.map(csvCell).join(",")];
  for (const x of rep.rows) {
    lines.push([x.rank, x.agentRank, x.id, x.region, x.lat.toFixed(6), x.lon.toFixed(6), x.county, x.tier === "supported" ? "3+ offsets" : "1-2 offsets (low confidence)",
      r(x.cum12.p10), r(x.cum12.p50), r(x.cum12.p90), r(x.eur.p10), r(x.eur.p50), r(x.eur.p90), x.offsets,
      x.medianCum12 === null ? null : r(x.medianCum12), x.modelOffsets, x.multiWell, x.otherGaps, x.flags.join("; "),
      x.headline, x.details.join(" "), x.why, origin + analyzeHref(x.lat, x.lon, rep.lateralFt, rep.radiusMi, rep.filters),
    ].map(csvCell).join(","));
  }
  return head.join("\n") + "\n" + lines.join("\n") + "\n";
}

/** Approximate area of a drawn ring in acres (local equirectangular plane; for display only). */
export function ringAcres(ring: [number, number][]): number {
  if (ring.length < 3) return 0;
  const lat0 = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const k = (Math.PI / 180) * 3958.7613 * 5280, c = Math.cos((lat0 * Math.PI) / 180);
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [y1, x1] = ring[i], [y2, x2] = ring[(i + 1) % ring.length];
    a += x1 * c * k * (y2 * k) - x2 * c * k * (y1 * k);
  }
  return Math.abs(a) / 2 / 43560;
}

/** Upper bounds of up to five equal-count bins (quintiles) for the map's P50 color steps. */
export function quintileBreaks(values: number[]): number[] {
  const v = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return [];
  const bins = Math.min(5, v.length);
  const out: number[] = [];
  for (let k = 1; k < bins; k++) out.push(v[Math.floor((k * v.length) / bins) - 1]);
  out.push(v[v.length - 1]);
  return out.filter((b, i) => i === 0 || b > out[i - 1]);
}
export const binOf = (breaks: number[], x: number): number => { const i = breaks.findIndex((b) => x <= b); return i < 0 ? breaks.length - 1 : i; };

// ---------- share link: the report travels inside the URL fragment ----------
const MAX_LINK_CHARS = 400_000;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}
async function pipe(bytes: Uint8Array, t: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(t)).arrayBuffer());
}

/** "z." + deflate when the browser has CompressionStream, else "j." + plain JSON. */
export async function encodeReport(rep: Report): Promise<string> {
  const raw = new TextEncoder().encode(JSON.stringify(rep));
  if (typeof CompressionStream !== "undefined") return "z." + b64url(await pipe(raw, new CompressionStream("deflate")));
  return "j." + b64url(raw);
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown, max = 4000): v is string => typeof v === "string" && v.length <= max;
const isBand = (b: unknown): b is Band => !!b && typeof b === "object" && ["p10", "p50", "p90"].every((k) => isNum((b as Record<string, unknown>)[k]));

/** Decode and validate a shared report; null for anything malformed. Rendered as text only. */
export async function decodeReport(s: string): Promise<Report | null> {
  try {
    if (s.length > MAX_LINK_CHARS) return null;
    const [kind, body] = [s.slice(0, 2), s.slice(2)];
    let bytes = unb64url(body);
    if (kind === "z.") bytes = await pipe(bytes, new DecompressionStream("deflate"));
    else if (kind !== "j.") return null;
    const r = JSON.parse(new TextDecoder().decode(bytes)) as Report;
    const ok = r && r.v === 1 && isStr(r.prompt) && isStr(r.plan) && isStr(r.approvedAt, 40) && isNum(r.lateralFt) && isNum(r.radiusMi)
      && isNum(r.spacingAcres) && Array.isArray(r.rows) && r.rows.length <= 200 && Array.isArray(r.summary) && r.summary.every((x) => isStr(x))
      && Array.isArray(r.regions) && r.regions.length <= 50
      && r.regions.every((g) => isStr(g.label, 80) && Array.isArray(g.ring) && g.ring.length <= 2000 && g.ring.every((p) => Array.isArray(p) && isNum(p[0]) && isNum(p[1])))
      && r.data && isStr(r.data.pdq_dump_date, 20) && isNum(r.data.last_complete_month) && r.model && isNum(r.model.cum12_median_ape) && isNum(r.model.eur_median_ape)
      && r.rows.every((x) => isNum(x.rank) && isNum(x.agentRank) && isStr(x.id, 40) && isStr(x.region, 80) && isNum(x.lat) && isNum(x.lon)
        && isStr(x.county, 20) && isStr(x.tier, 20) && isBand(x.cum12) && isBand(x.eur) && isNum(x.offsets) && (x.medianCum12 === null || isNum(x.medianCum12))
        && isNum(x.modelOffsets) && isNum(x.multiWell) && isNum(x.otherGaps) && Array.isArray(x.flags) && x.flags.every((f) => isStr(f, 60))
        && isStr(x.headline) && Array.isArray(x.details) && x.details.every((d) => isStr(d)) && isStr(x.why))
      && (!r.filters || (typeof r.filters === "object" && (r.filters.operator === undefined || isStr(r.filters.operator, 80))
        && (["min_lat_ft", "max_lat_ft", "min_first_ym", "max_first_ym"] as const).every((k) => r.filters[k] == null || isNum(r.filters[k]))));
    return ok ? r : null;
  } catch {
    return null;
  }
}
