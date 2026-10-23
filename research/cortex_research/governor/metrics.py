"""Governor math (pure; unit-tested). Docs: docs/ARCHITECTURE.md §9, docs/RISK_DOCTRINE.md §7."""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from typing import Iterable, Sequence

HORIZONS_H = {"24h": 24, "72h": 72, "7d": 168}
PLANNED_EXITS = {"TARGET", "STOP_BROKER", "STOP_SYNTHETIC", "TIME_STOP"}


@dataclass
class Bar:
    t: int  # ms
    h: float
    l: float
    c: float


@dataclass
class Hypo:
    entry: float
    stop: float
    target: float


def hypothetical(h: dict | None) -> Hypo | None:
    """Normalize the different rejection payloads into entry/stop/target (long-only)."""
    if not h:
        return None
    try:
        if {"entry", "stop", "targets"} <= h.keys() and h["targets"]:
            e, s, t = float(h["entry"]), float(h["stop"]), float(h["targets"][0])
        elif {"entry_low", "entry_high", "stop", "targets"} <= h.keys() and h["targets"]:
            e, s, t = (float(h["entry_low"]) + float(h["entry_high"])) / 2, float(h["stop"]), float(h["targets"][0])
        elif {"bid", "atr"} <= h.keys():
            b, a = float(h["bid"]), float(h["atr"])
            e, s, t = b, b - 2 * a, b + 3 * a  # same geometry as the baseline strategy
        else:
            return None
    except (TypeError, ValueError):
        return None
    if not (s < e < t) or s <= 0:
        return None
    return Hypo(e, s, t)


def grade_path(bars: Sequence[Bar], hyp: Hypo, start_ms: int, end_ms: int) -> tuple[str, float | None]:
    """First touch of stop or target after start (a bar touching both counts as STOP — conservative)."""
    risk = hyp.entry - hyp.stop
    last_c = None
    for b in bars:
        if b.t < start_ms or b.t > end_ms:
            continue
        last_c = b.c
        if b.l <= hyp.stop:
            return "STOP", -1.0
        if b.h >= hyp.target:
            return "TARGET", (hyp.target - hyp.entry) / risk
    if last_c is None:
        return "NEITHER", None
    return "NEITHER", (last_c - hyp.entry) / risk


def classify(exit_reason: str, r: float) -> str:
    good_process = exit_reason in PLANNED_EXITS
    if good_process:
        return "GOOD_PROCESS_GOOD_OUTCOME" if r > 0 else "GOOD_PROCESS_BAD_LUCK"
    return "BAD_PROCESS_BAILOUT_LUCK" if r > 0 else "BAD_PROCESS_LOSS"


def brier(pairs: Iterable[tuple[float, int]]) -> float | None:
    p = list(pairs)
    return sum((x - y) ** 2 for x, y in p) / len(p) if p else None


def reliability(pairs: Iterable[tuple[float, int]], bins: int = 5) -> list[dict]:
    buckets: list[list[tuple[float, int]]] = [[] for _ in range(bins)]
    for x, y in pairs:
        buckets[min(bins - 1, int(x * bins))].append((x, y))
    return [
        {"bin": f"{i / bins:.1f}-{(i + 1) / bins:.1f}", "n": len(b), "mean_p": round(sum(x for x, _ in b) / len(b), 3),
         "hit_rate": round(sum(y for _, y in b) / len(b), 3)}
        for i, b in enumerate(buckets) if b
    ]


def isotonic(pairs: Sequence[tuple[float, int]]) -> list[tuple[float, float]]:
    """Pool-adjacent-violators on (x, y) sorted by x → monotone non-decreasing step points (x, ŷ)."""
    pts = sorted(pairs)
    blocks: list[list[float]] = []  # [sum_y, count, max_x]
    for x, y in pts:
        blocks.append([float(y), 1.0, x])
        while len(blocks) > 1 and blocks[-2][0] / blocks[-2][1] > blocks[-1][0] / blocks[-1][1]:
            s, n, mx = blocks.pop()
            blocks[-1][0] += s
            blocks[-1][1] += n
            blocks[-1][2] = mx
    out: list[tuple[float, float]] = []
    for s, n, mx in blocks:
        y = round(s / n, 4)
        x = round(min(1.0, max(0.0, mx)), 4)
        if out and x <= out[-1][0]:
            out[-1] = (out[-1][0], max(out[-1][1], y))
            continue
        out.append((x, max(y, out[-1][1]) if out else y))
    if len(out) == 1:
        out = [(0.0, out[0][1]), (1.0, out[0][1])]
    if out[0][0] > 0:
        out.insert(0, (0.0, out[0][1]))
    if out[-1][0] < 1:
        out.append((1.0, out[-1][1]))
    # strictly increasing x for the TypeScript schema
    dedup: list[tuple[float, float]] = []
    for x, y in out:
        if dedup and x <= dedup[-1][0]:
            continue
        dedup.append((x, y))
    return dedup


def apply_map(points: Sequence[tuple[float, float]], raw: float) -> float:
    """Piecewise-linear, clamped — identical to applyMap in src/contracts/calibration.ts."""
    if raw <= points[0][0]:
        return points[0][1]
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        if raw <= x1:
            return y0 + (raw - x0) / (x1 - x0) * (y1 - y0)
    return points[-1][1]


def max_drawdown_r(rs: Sequence[float]) -> float:
    peak = cum = dd = 0.0
    for r in rs:
        cum += r
        peak = max(peak, cum)
        dd = max(dd, peak - cum)
    return dd


def bootstrap(rs: Sequence[float], n: int = 2000, seed: int = 54) -> dict:
    """Bootstrap trade R: p(mean ≤ 0) and the 95th-percentile max drawdown (in R) under resampling."""
    if len(rs) < 2:
        return {"p_value": None, "dd_p95_r": None}
    rng = random.Random(seed)
    means, dds = [], []
    for _ in range(n):
        s = [rs[rng.randrange(len(rs))] for _ in rs]
        means.append(sum(s) / len(s))
        dds.append(max_drawdown_r(s))
    dds.sort()
    return {"p_value": round(sum(1 for m in means if m <= 0) / n, 4), "dd_p95_r": round(dds[int(0.95 * (n - 1))], 3)}


def bh_fdr(pvals: dict[str, float | None]) -> dict[str, float | None]:
    """Benjamini–Hochberg adjusted p-values (None stays None)."""
    items = sorted(((k, p) for k, p in pvals.items() if p is not None), key=lambda kv: kv[1])
    m = len(items)
    adj: dict[str, float | None] = {k: None for k in pvals}
    prev = 1.0
    for rank in range(m, 0, -1):
        k, p = items[rank - 1]
        prev = min(prev, p * m / rank)
        adj[k] = round(min(1.0, prev), 4)
    return adj


def strategy_stats(rs: Sequence[float]) -> dict:
    wins = [r for r in rs if r > 0]
    losses = [-r for r in rs if r < 0]
    pf = (sum(wins) / sum(losses)) if losses else (math.inf if wins else None)
    return {
        "n": len(rs),
        "win_rate": round(len(wins) / len(rs), 3) if rs else None,
        "expectancy_r": round(sum(rs) / len(rs), 3) if rs else None,
        "profit_factor": (None if pf is None else (round(pf, 3) if pf != math.inf else 99.0)),
        **bootstrap(rs),
    }


GENESIS = "0" * 64


def verify_chain(rows: Sequence[dict]) -> dict:
    """Recompute the journal hash chain (src/journal/Journal.ts rowHash). Constitution U7 / spec §8.8.

    Checks every row's hash, every link, contiguous seq from 1, and that seq 1 links to GENESIS.
    """
    import hashlib

    ordered = sorted(rows, key=lambda r: r["seq"])
    prev_sha = GENESIS
    for i, r in enumerate(ordered):
        if r["seq"] != i + 1:
            return {"ok": False, "rows": len(ordered), "broken_at": r["seq"], "why": f"gap: expected seq {i + 1}"}
        if r["prev_row_sha256"] != prev_sha:
            return {"ok": False, "rows": len(ordered), "broken_at": r["seq"], "why": "link mismatch"}
        h = hashlib.sha256(f"{r['prev_row_sha256']}|{r['seq']}|{r['ts']}|{r['kind']}|{r['payload_json']}".encode()).hexdigest()
        if h != r["row_sha256"]:
            return {"ok": False, "rows": len(ordered), "broken_at": r["seq"], "why": "row hash mismatch"}
        prev_sha = r["row_sha256"]
    return {"ok": True, "rows": len(ordered), "broken_at": None, "why": None, "head": prev_sha}


def twin_divergence(fills: Sequence[dict]) -> dict:
    """Paper-vs-live shadow twin (spec §2.3 / RISK_DOCTRINE R2 gate): for every contract filled on both accounts,
    the live price's deviation from paper in bps, signed against us (buys: live higher is worse; sells: lower)."""
    by: dict[tuple[str, str], dict[str, list[tuple[float, float]]]] = {}
    for f in fills:
        key = (str(f.get("contract")), str(f.get("role")))
        by.setdefault(key, {}).setdefault(f["account"], []).append((float(f["qty"]), float(f["price"])))
    diffs = []
    for (cid, role), accts in by.items():
        if "PAPER" not in accts or "LIVE" not in accts:
            continue
        vw = {a: sum(q * p for q, p in v) / sum(q for q, _ in v) for a, v in accts.items()}
        sign = 1 if role == "ENTRY" else -1
        diffs.append(sign * (vw["LIVE"] - vw["PAPER"]) / vw["PAPER"] * 10_000)
    return {"pairs": len(diffs), "mean_bps": round(sum(diffs) / len(diffs), 2) if diffs else None,
            "worst_bps": round(max(diffs), 2) if diffs else None}

