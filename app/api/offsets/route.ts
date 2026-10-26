import { NextResponse } from "next/server";
import { analyze, summarize, toCsv } from "@/lib/engine";
import type { Wells, Horizontals, ModelBundle } from "@/lib/types";
import type { Meta } from "@/lib/load";

// JSON API: GET /api/offsets?lat=..&lon=..[&lat_ft=10000][&r=3][&min=&max=][&api=42329...][&format=csv]
// Data files are the same static, versioned JSON the UI uses; cached per warm instance.
type B = { W: Wells; H: Horizontals; M: ModelBundle; MH: ModelBundle; meta: Meta };
let cache: Promise<B> | null = null;
function load(origin: string): Promise<B> {
  if (!cache) {
    const j = (f: string) => fetch(`${origin}/data/${f}`).then((r) => { if (!r.ok) throw new Error(`${f}: ${r.status}`); return r.json(); });
    cache = Promise.all([j("wells.json"), j("horizontals.json"), j("model.json"), j("model_holdout.json"), j("meta.json")])
      .then(([W, H, M, MH, meta]) => ({ W, H, M, MH, meta }))
      .catch((e) => { cache = null; throw e; });
  }
  return cache;
}

export async function GET(req: Request) {
  const t0 = Date.now();
  const u = new URL(req.url), q = u.searchParams;
  const num = (k: string) => (q.get(k) === null || q.get(k) === "" ? null : Number(q.get(k)));
  try {
    const { W, H, M, MH, meta } = await load(u.origin);
    const tLoad = Date.now() - t0;
    const radius = Math.min(10, Math.max(0.5, num("r") ?? 3));
    const filters = { radiusMi: radius, minLatFt: num("min"), maxLatFt: num("max"), operator: q.get("op") ?? "" };
    let target;
    const api = (q.get("api") ?? "").replace(/\D/g, "");
    if (api) {
      const a10 = api.length >= 10 ? api.slice(0, 10) : `42${api}`.slice(0, 10);
      const i = W.api10.indexOf(a10);
      if (i < 0) return NextResponse.json({ error: `API ${a10} is not in the usable well set (it may be a coverage gap: multi-well lease, no completion, gas, or outside the counties).` }, { status: 404 });
      target = { lat: W.lat[i], lon: W.lon[i], lateralFt: W.lat_ft[i], vintageYear: Math.floor(W.first[i] / 100), mode: "backtest" as const, wellIdx: i, label: `${W.lease[i]} ${W.well_no[i]} (${a10})` };
    } else {
      const lat = num("lat"), lon = num("lon");
      if (lat === null || lon === null || !isFinite(lat) || !isFinite(lon)) return NextResponse.json({ error: "Provide lat & lon, or api" }, { status: 400 });
      target = { lat, lon, lateralFt: num("lat_ft") ?? 10000, vintageYear: 2025, mode: "prospect" as const, label: `Pin ${lat.toFixed(5)}, ${lon.toFixed(5)}` };
    }
    const r = analyze(W, H, M, target, filters, MH);
    if (q.get("format") === "csv") {
      return new NextResponse(toCsv(r), { headers: { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=offsetiq_offsets.csv" } });
    }
    return NextResponse.json({
      summary: summarize(r, radius, { last_complete_month: meta.last_complete_month, cum12MedApe: meta.model.targets.cum12.lightgbm_holdout!.median_ape, eurMedApe: meta.model.targets.eur.lightgbm_holdout!.median_ape }),
      result: r,
      timing_ms: { load: tLoad, total: Date.now() - t0 },
      sources: { pdq_dump_date: meta.pdq_dump_date, last_complete_month: meta.last_complete_month, provider: "Texas Railroad Commission (public data)" },
      disclaimer: "Screening estimate from public data; not a reserves report.",
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
