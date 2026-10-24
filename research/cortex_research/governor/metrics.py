"""Governor math (pure; unit-tested). Docs: docs/ARCHITECTURE.md §9, docs/RISK_DOCTRINE.md §7."""

from __future__ import annotations

import json
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


def platt(pairs: Sequence[tuple[float, int]], grid: int = 21) -> list[tuple[float, float]]:
    """Two-parameter logistic calibration on logit(p), fitted by Newton's method, serialized as a dense monotone
    point map for the existing TypeScript schema (audit W2-19: unsmoothed isotonic overfits at n≈50–300).
    Falls back to a flat map at the base rate if the fitted slope is not positive."""
    eps = 1e-4
    xs = [math.log(min(1 - eps, max(eps, p)) / (1 - min(1 - eps, max(eps, p)))) for p, _ in pairs]
    ys = [float(y) for _, y in pairs]
    a, b = 1.0, 0.0
    for _ in range(50):
        ga = gb = haa = hab = hbb = 0.0
        for x, y in zip(xs, ys):
            q = 1 / (1 + math.exp(-(a * x + b)))
            w = q * (1 - q)
            ga += (q - y) * x
            gb += q - y
            haa += w * x * x + 1e-9
            hab += w * x
            hbb += w + 1e-9
        det = haa * hbb - hab * hab
        if abs(det) < 1e-12:
            break
        da = (hbb * ga - hab * gb) / det
        db = (haa * gb - hab * ga) / det
        a, b = a - da, b - db
        if abs(da) + abs(db) < 1e-9:
            break
    base = sum(ys) / len(ys) if ys else 0.5
    out: list[tuple[float, float]] = []
    for i in range(grid):
        p = i / (grid - 1)
        if a <= 0:
            y = base
        else:
            x = math.log(min(1 - eps, max(eps, p)) / (1 - min(1 - eps, max(eps, p))))
            y = 1 / (1 + math.exp(-(a * x + b)))
        y = round(y, 4)
        out.append((round(p, 4), max(y, out[-1][1]) if out else y))
    return out


def calibration_map(pairs: Sequence[tuple[float, int]]) -> tuple[str, list[tuple[float, float]]]:
    """The ladder: Platt below 300 outcomes, isotonic from 300 (where the step map stops being noise)."""
    return ("isotonic", isotonic(pairs)) if len(pairs) >= 300 else ("platt", platt(pairs))


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



# ---- ADR-055: audit round 3 (learning loop rigor) -------------------------------------------------------------------

def brier_decomposition(pairs: Sequence[tuple[float, int]], bins: int = 10) -> dict | None:
    """Murphy (1973): Brier = reliability − resolution + uncertainty (audit W2-21). Reliability is the part a better
    calibration map can fix; resolution is real skill at telling outcomes apart; uncertainty is the base rate's own
    noise. Binned, so the identity holds up to within-bin spread."""
    p = list(pairs)
    if not p:
        return None
    n = len(p)
    base = sum(y for _, y in p) / n
    buckets: list[list[tuple[float, int]]] = [[] for _ in range(bins)]
    for x, y in p:
        buckets[min(bins - 1, int(x * bins))].append((x, y))
    rel = res = 0.0
    for b in buckets:
        if not b:
            continue
        fk = sum(x for x, _ in b) / len(b)
        ok = sum(y for _, y in b) / len(b)
        rel += len(b) * (fk - ok) ** 2
        res += len(b) * (ok - base) ** 2
    return {"reliability": round(rel / n, 4), "resolution": round(res / n, 4), "uncertainty": round(base * (1 - base), 4),
            "brier": round(brier(p) or 0, 4)}


def _norm_cdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def deflated_sharpe(rs: Sequence[float], n_trials: int) -> dict | None:
    """Bailey & López de Prado (2014) deflated Sharpe ratio (audit W2-28): the probability that the per-trade Sharpe
    beats the best Sharpe expected by luck across `n_trials` variants, adjusted for skew and fat tails. > 0.95 is the
    usual bar; the backtest lab requires it on top of BH-FDR before a PASS."""
    n = len(rs)
    if n < 10 or n_trials < 1:
        return None
    mu = sum(rs) / n
    sd = math.sqrt(sum((r - mu) ** 2 for r in rs) / (n - 1))
    if sd <= 0:
        return None
    sr = mu / sd
    skew = sum(((r - mu) / sd) ** 3 for r in rs) / n
    kurt = sum(((r - mu) / sd) ** 4 for r in rs) / n
    # expected max Sharpe of n_trials unskilled variants (variance of SR estimates ≈ 1/(n−1))
    gamma = 0.5772156649
    v = 1 / (n - 1)
    if n_trials > 1:
        from statistics import NormalDist

        z = NormalDist()
        sr0 = math.sqrt(v) * ((1 - gamma) * z.inv_cdf(1 - 1 / n_trials) + gamma * z.inv_cdf(1 - 1 / (n_trials * math.e)))
    else:
        sr0 = 0.0
    denom = math.sqrt(max(1e-12, 1 - skew * sr + (kurt - 1) / 4 * sr * sr))
    dsr = _norm_cdf((sr - sr0) * math.sqrt(n - 1) / denom)
    return {"sharpe_per_trade": round(sr, 4), "sharpe_luck_bar": round(sr0, 4), "dsr": round(dsr, 4), "trials": n_trials}


def pbo_cscv(perf: dict[str, Sequence[float]], blocks: int = 8) -> float | None:
    """Probability of backtest overfitting by combinatorially symmetric cross-validation (Bailey et al., audit W2-27).
    perf: strategy → per-period returns on a common calendar (same length). For every split of the `blocks` time
    blocks into equal halves, pick the in-sample best strategy and see where it ranks out of sample; PBO is the share of
    splits where it lands in the bottom half. Needs ≥ 2 strategies."""
    from itertools import combinations

    names = [k for k, v in perf.items() if len(v) >= blocks]
    if len(names) < 2:
        return None
    t = min(len(perf[k]) for k in names)
    size = t // blocks
    if size < 1:
        return None
    chunks = {k: [sum(perf[k][i * size:(i + 1) * size]) for i in range(blocks)] for k in names}
    below = total = 0
    for ins in combinations(range(blocks), blocks // 2):
        outs = [i for i in range(blocks) if i not in ins]
        is_score = {k: sum(chunks[k][i] for i in ins) for k in names}
        oos_score = {k: sum(chunks[k][i] for i in outs) for k in names}
        best = max(names, key=lambda k: is_score[k])
        rank = sorted(names, key=lambda k: oos_score[k]).index(best)  # 0 = worst
        rel = (rank + 0.5) / len(names)
        below += 1 if rel <= 0.5 else 0
        total += 1
    return round(below / total, 4) if total else None


def purge_overlaps(items: Sequence[dict], key: str = "symbol", window_ms: int = 3 * 86_400_000) -> list[dict]:
    """Audit W2-24: holds of 1–3 days overlap, so consecutive labels on one symbol share most of their price path and
    inflate apparent sample size. Keep the first item of each symbol per window (items need `ts`)."""
    last: dict[str, int] = {}
    out: list[dict] = []
    for it in sorted(items, key=lambda x: x["ts"]):
        k = str(it.get(key))
        if k in last and it["ts"] - last[k] < window_ms:
            continue
        last[k] = it["ts"]
        out.append(it)
    return out


def map_beats_incumbent(pairs: Sequence[tuple[float, int]], fit, incumbent: Sequence[tuple[float, float]] | None,
                        holdout: float = 0.3) -> dict:
    """Audit W2-25: fit a candidate map on the older 70% of pairs (time order), score both maps' Brier on the newest
    30%. A proposal is only written when it is no worse than the incumbent (or the identity when there is none)."""
    p = list(pairs)
    cut = max(1, int(len(p) * (1 - holdout)))
    train, test = p[:cut], p[cut:]
    if len(test) < 5:
        return {"ok": True, "why": "too few pairs for a holdout; accepted on schema checks"}
    _method, cand = fit(train)
    inc = list(incumbent) if incumbent else [(0.0, 0.0), (1.0, 1.0)]
    b_new = brier([(apply_map(cand, x), y) for x, y in test]) or 0
    b_old = brier([(apply_map(inc, x), y) for x, y in test]) or 0
    return {"ok": b_new <= b_old + 1e-9, "brier_new": round(b_new, 4), "brier_incumbent": round(b_old, 4),
            "holdout": len(test)}


def panel_vs_judge(rows: Sequence[dict]) -> dict:
    """Audit W2-01: rows of {panel: [{stance, confidence}], win_used, r}. Did the panel's majority call the outcome
    better than the judge's probability? Reports hit rates; a panel that adds nothing over the judge is a candidate
    for `panel_mode: off` (three fewer LLM calls per hearing)."""
    judged = [r for r in rows if r.get("r") is not None]
    if not judged:
        return {"n": 0}
    pm = jm = 0
    for r in judged:
        votes = [1 if s.get("stance") == "support" else -1 if s.get("stance") == "oppose" else 0 for s in r.get("panel", [])]
        panel_long = sum(votes) > 0
        judge_long = (r.get("win_used") or 0) >= 0.5
        won = r["r"] > 0
        pm += 1 if panel_long == won else 0
        jm += 1 if judge_long == won else 0
    n = len(judged)
    return {"n": n, "panel_hit": round(pm / n, 3), "judge_hit": round(jm / n, 3)}


def slippage_summary(fills: Sequence[dict]) -> dict:
    """Audit W2-36: realized slippage (bps, positive = worse) from FILL journal rows that carry slip_bps."""
    xs = sorted(float(f["slip_bps"]) for f in fills if f.get("slip_bps") is not None)
    if not xs:
        return {"n": 0}
    return {"n": len(xs), "mean_bps": round(sum(xs) / len(xs), 2), "p90_bps": xs[min(len(xs) - 1, int(0.9 * len(xs)))],
            "worst_bps": xs[-1]}


def scar_veto_cost(rejections: Sequence[dict], grades: Sequence[dict]) -> dict[str, dict]:
    """Audit W2-14: what each scar's vetoes would have earned (72 h grades of SCAR-stage rejections). Positive means
    the scar is costing money and is a candidate for `expires`."""
    by_id = {g["rejection_id"]: g for g in grades if g.get("horizon") == "72h" and g.get("outcome_r") is not None}
    out: dict[str, list[float]] = {}
    for rj in rejections:
        if rj.get("stage") != "SCAR" or rj["id"] not in by_id:
            continue
        reasons = rj.get("reason_codes", rj.get("reasons"))
        if isinstance(reasons, str):
            try:
                reasons = json.loads(reasons)
            except ValueError:
                reasons = [reasons]
        for reason in reasons or []:
            m = str(reason).split(":", 1)[0].strip()
            if m.startswith("SCAR-"):
                out.setdefault(m, []).append(float(by_id[rj["id"]]["outcome_r"]))
    return {k: {"n": len(v), "avg_r": round(sum(v) / len(v), 3)} for k, v in out.items()}
