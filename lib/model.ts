import type { CompactModel } from "./types";

/**
 * Evaluates a LightGBM model exported by pipeline/train_model.py (dump_compact).
 * Node = [feature, threshold, left, right, flags, leafValue]; feature -1 => leaf.
 * flags bit0 = default_left, flags>>1 = missing_type (0 None, 1 Zero, 2 NaN).
 * Matches LightGBM numerical-split semantics; parity is golden-tested against Python.
 */
export function predictRaw(model: CompactModel, x: (number | null)[]): number {
  let s = 0;
  for (const nodes of model.trees) {
    let i = 0;
    for (;;) {
      const n = nodes[i];
      if (n[0] === -1) { s += n[5]; break; }
      const defLeft = (n[4] & 1) === 1;
      const mt = n[4] >> 1;
      let v = x[n[0]];
      const isNan = v === null || v === undefined || Number.isNaN(v);
      let goLeft: boolean;
      if (mt === 2 && isNan) goLeft = defLeft;
      else if (mt === 1 && (isNan || Math.abs(v as number) <= 1e-35)) goLeft = defLeft;
      else {
        if (isNan) v = 0;
        goLeft = (v as number) <= n[1];
      }
      i = goLeft ? n[2] : n[3];
    }
  }
  return s;
}
