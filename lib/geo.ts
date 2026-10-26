export const EARTH_MI = 3958.7613;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in statute miles (identical formula to pipeline/features.py). */
export function haversineMi(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const la1 = rad(lat1), la2 = rad(lat2);
  const d = Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((rad(lon2) - rad(lon1)) / 2) ** 2;
  return 2 * EARTH_MI * Math.asin(Math.sqrt(Math.min(1, d)));
}
