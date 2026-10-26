// Arps hyperbolic with terminal exponential decline — TS port of pipeline/arps.py
export const DMIN = 0.05 / 12;
export const ECON_LIMIT = 150;

export function hyperbolic(t: number, qi: number, Di: number, b: number) {
  return qi / Math.pow(1 + b * Di * t, 1 / b);
}
export function switchTime(Di: number, b: number, Dmin = DMIN) {
  return Di <= Dmin ? 0 : (Di / Dmin - 1) / (b * Di);
}
/** Monthly rate at peak-relative month t (t=1 is the peak month). Di is nominal MONTHLY. */
export function terminalRate(t: number, qi: number, Di: number, b: number, Dmin = DMIN) {
  const ts = switchTime(Di, b, Dmin);
  if (t <= ts) return hyperbolic(t, qi, Di, b);
  return hyperbolic(ts, qi, Di, b) * Math.exp(-Dmin * (t - ts));
}
