"""Vectorized evaluator for the compact LightGBM dumps in public/data/model.json.

pipeline/train_model.py (dump_compact) writes each tree as a node list
[feature, threshold, left, right, flags, leaf_value]; feature -1 marks a leaf,
flags bit0 = missing values go left, flags >> 1 = missing type (0 None, 1 Zero,
2 NaN). This is the same contract lib/model.ts implements; parity with LightGBM's
own predictions is golden-tested (tests/test_agent_engine.py vs golden_model.json).

All models' trees are stacked into flat arrays and every tree is walked at once,
one numpy gather per level. Leaves loop to themselves (threshold +inf), so walking
`depth` levels lands every tree on its leaf without masking. Leaf values are summed
sequentially per model (cumsum), the order lib/model.ts uses, so locations that
fall in the same leaves stay exactly tied.
"""
from __future__ import annotations

import numpy as np


class Forest:
    def __init__(self, bundle: dict[str, dict]):
        self.keys = list(bundle)
        self.features = bundle[self.keys[0]]["features"]
        trees: list[list[list[float]]] = []
        self.slices: dict[str, slice] = {}
        for k in self.keys:
            start = len(trees)
            trees.extend(bundle[k]["trees"])
            self.slices[k] = slice(start, len(trees))
        T, N = len(trees), max(len(t) for t in trees)
        feat = np.zeros((T, N), dtype=np.int64)
        thr = np.full((T, N), np.inf)
        left = np.tile(np.arange(N), (T, 1)) + np.arange(T)[:, None] * N  # unused slots and leaves self-loop
        right = left.copy()
        nan_left = np.ones((T, N), dtype=bool)
        zero_type = np.zeros((T, N), dtype=bool)
        leaf = np.zeros((T, N))
        self.depth = 0
        for ti, nodes in enumerate(trees):
            base = ti * N
            for ni, (f, th, lo, hi, fl, lv) in enumerate(nodes):
                if int(f) == -1:
                    leaf[ti, ni] = lv
                    continue
                fl = int(fl)
                default_left, missing_type = bool(fl & 1), fl >> 1
                feat[ti, ni], thr[ti, ni] = int(f), th
                left[ti, ni], right[ti, ni] = base + int(lo), base + int(hi)
                # NaN routing: default direction for missing types Zero/NaN; type None treats NaN as 0.0
                nan_left[ti, ni] = default_left if missing_type in (1, 2) else 0.0 <= th
                zero_type[ti, ni] = missing_type == 1
            self.depth = max(self.depth, _depth(nodes, 0))
        self._feat, self._thr, self._left, self._right = feat.ravel(), thr.ravel(), left.ravel(), right.ravel()
        self._nan_left, self._zero_type, self._leaf = nan_left.ravel(), zero_type.ravel(), leaf.ravel()
        self._any_zero = bool(zero_type.any())
        self._roots = np.arange(T) * N

    def predict_raw(self, X: np.ndarray) -> dict[str, np.ndarray]:
        """X: (n, n_features) float, NaN = missing. Returns raw (log-space) score per model."""
        X = np.atleast_2d(np.asarray(X, dtype=float))
        n, nf = X.shape
        flatx = X.ravel()
        rows = (np.arange(n) * nf)[:, None]
        node = np.broadcast_to(self._roots, (n, len(self._roots))).copy()
        for _ in range(self.depth):
            v = flatx[rows + self._feat[node]]
            nan = np.isnan(v)
            go_left = np.where(nan, self._nan_left[node], v <= self._thr[node])
            if self._any_zero:
                z = self._zero_type[node] & ~nan & (np.abs(v) <= 1e-35)
                go_left = np.where(z, self._nan_left[node], go_left)
            node = np.where(go_left, self._left[node], self._right[node])
        vals = self._leaf[node]
        return {k: vals[:, s].cumsum(axis=1)[:, -1] for k, s in self.slices.items()}


def _depth(nodes: list, i: int) -> int:
    if nodes[i][0] == -1:
        return 0
    return 1 + max(_depth(nodes, int(nodes[i][2])), _depth(nodes, int(nodes[i][3])))
