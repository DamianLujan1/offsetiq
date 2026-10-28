import fs from "node:fs";
import path from "node:path";
import type { Horizontals, Wells } from "@/lib/types";

// Landing-page figure, rendered at build time from the same public/data files the analyzer loads:
// every attributable horizontal is drawn as its SHL→BHL stick, every located coverage-gap horizontal as a grey dot.
const read = <T,>(f: string) => JSON.parse(fs.readFileSync(path.join(process.cwd(), "public", "data", f), "utf8")) as T;
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const MI_PER_DEG_LAT = 69.05;

export default function BasinMap() {
  const W = read<Wells>("wells.json"), H = read<Horizontals>("horizontals.json");
  const located = H.lat.map((_, i) => i).filter((i) => H.lat[i] != null && H.lon[i] != null);
  const lats = located.map((i) => H.lat[i]).concat(W.slat, W.blat), lons = located.map((i) => H.lon[i]).concat(W.slon, W.blon);
  const lat0 = lats.reduce((a, b) => Math.min(a, b)), lat1 = lats.reduce((a, b) => Math.max(a, b));
  const lon0 = lons.reduce((a, b) => Math.min(a, b)), lon1 = lons.reduce((a, b) => Math.max(a, b));

  // equirectangular, scaled by cos(mid-latitude) so a mile is the same length on both axes
  const VW = 1000, PAD = 16, k = Math.cos((((lat0 + lat1) / 2) * Math.PI) / 180);
  const s = (VW - 2 * PAD) / ((lon1 - lon0) * k); // px per degree of latitude
  const VH = Math.round((lat1 - lat0) * s + 2 * PAD);
  const X = (lon: number) => PAD + (lon - lon0) * k * s, Y = (lat: number) => PAD + (lat1 - lat) * s;

  let wells = "";
  for (let i = 0; i < W.n; i++) {
    const x = Math.round(X(W.slon[i])), y = Math.round(Y(W.slat[i]));
    wells += `M${x} ${y}l${Math.round(X(W.blon[i])) - x} ${Math.round(Y(W.blat[i])) - y}`;
  }
  // gap dots snap to a 3px grid and are de-duplicated: same picture, a fraction of the markup
  const seen = new Set<number>();
  let gaps = "", nGap = 0;
  for (const i of located) {
    if (H.code[i] === 0) continue;
    nGap++;
    const x = Math.round(X(H.lon[i]) / 3) * 3, y = Math.round(Y(H.lat[i]) / 3) * 3;
    if (seen.has(y * 4096 + x)) continue;
    seen.add(y * 4096 + x);
    gaps += `M${x} ${y}h0`;
  }
  const counties = [...new Set(located.map((i) => H.county[i]))].map((c) => {
    const ix = located.filter((i) => H.county[i] === c);
    return { c, x: X(median(ix.map((i) => H.lon[i]))), y: Y(median(ix.map((i) => H.lat[i]))) };
  });
  const tenMi = (10 / MI_PER_DEG_LAT) * s;

  return (
    <figure className="basin">
      <svg viewBox={`0 0 ${VW} ${VH}`} role="img" aria-label={`Map of ${W.n.toLocaleString()} attributable horizontal wells and ${nGap.toLocaleString()} coverage-gap horizontals in Andrews, Ector, Martin and Midland County, Texas`}>
        <path className="gaps" d={gaps} />
        <path className="wells" d={wells} />
        {counties.map(({ c, x, y }) => <text key={c} x={x.toFixed(0)} y={y.toFixed(0)} textAnchor="middle">{c}</text>)}
        <g transform={`translate(${PAD} ${VH - PAD})`}>
          <path className="scale" d={`M0 -5V0H${tenMi.toFixed(1)}V-5`} />
          <text className="scale-t" x={(tenMi / 2).toFixed(1)} y={-9} textAnchor="middle">10 mi</text>
        </g>
      </svg>
      <figcaption>
        <i className="k-well" />{W.n.toLocaleString()} horizontals with well-level production, drawn surface hole to bottom hole.{" "}
        <i className="k-gap" />{nGap.toLocaleString()} located horizontals that are coverage gaps. Texas RRC well layers.
      </figcaption>
    </figure>
  );
}
