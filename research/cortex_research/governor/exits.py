"""Exit grading, the virtual monkey control group and missed-move forensics (ADR-059, ADR-061). Pure; unit-tested.

- Exit scorecard (MLP4-007): exits are graded apart from entries. Capture = realized R / best R the position reached;
  give-back = best R − realized R; after the exit, how much more it would have made (left on the table) or lost
  (saved by the exit) over the next 72 h.
- Monkey control (PSS-017 / MLP6-004): two virtual control groups simulated on the same bars, no orders. "Random
  entries, our exits": the same stop/target/horizon geometry entered at random hours of the prior month. "Our entries,
  random exits": the real entry, the real stop, but a random exit time inside the horizon. If the real record isn't
  better than both, the edge isn't where we think it is.
- Missed moves (MLP4-014): watchlist symbols that moved ≥ 3 ATR in a day while nothing about them reached Tier 0.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Sequence

from .metrics import Bar, Hypo, grade_path


def post_exit_excursion(bars: Sequence[Bar], exit_ts: int, exit_px: float, risk: float, hours: int = 72) -> tuple[float, float] | None:
    """(best high, worst low) after the exit, in R from the exit price. None without bars."""
    window = [b for b in bars if exit_ts < b.t <= exit_ts + hours * 3_600_000]
    if not window or risk <= 0:
        return None
    return (max(b.h for b in window) - exit_px) / risk, (min(b.l for b in window) - exit_px) / risk


def exit_scorecard(rows: Sequence[dict]) -> dict:
    """rows: {r, mfe_r, reason, post: (high_r, low_r) | None}."""
    n = len(rows)
    if n == 0:
        return {"n": 0}
    capt = [x["r"] / x["mfe_r"] for x in rows if x.get("mfe_r") and x["mfe_r"] > 0.25]
    give = [x["mfe_r"] - x["r"] for x in rows if x.get("mfe_r") is not None]
    left = [max(0.0, x["post"][0]) for x in rows if x.get("post")]
    saved = [max(0.0, -x["post"][1]) for x in rows if x.get("post") and x["reason"] not in ("TARGET",)]
    by_reason: dict[str, int] = {}
    for x in rows:
        by_reason[x["reason"]] = by_reason.get(x["reason"], 0) + 1
    avg = lambda xs: round(sum(xs) / len(xs), 3) if xs else None  # noqa: E731
    return {"n": n, "capture": avg(capt), "giveback_r": avg(give), "left_on_table_r": avg(left), "saved_r": avg(saved),
            "by_reason": by_reason}


@dataclass
class Plan:
    entry_ts: int
    entry: float
    stop_frac: float  # (entry − stop) / entry
    target_frac: float  # (target − entry) / entry
    horizon_h: float


def _hypo(px: float, p: Plan) -> Hypo:
    return Hypo(px, px * (1 - p.stop_frac), px * (1 + p.target_frac))


def monkey_entries(bars: Sequence[Bar], p: Plan, n: int, rng: random.Random, lookback_days: int = 30) -> list[float]:
    """Same geometry, entered at random hourly closes in the month before the real entry (ending before it)."""
    hz = int(p.horizon_h * 3_600_000)
    pool = [b for b in bars if p.entry_ts - lookback_days * 86_400_000 <= b.t <= p.entry_ts - hz]
    out: list[float] = []
    for b in rng.sample(pool, min(n, len(pool))):
        _, r = grade_path(bars, _hypo(b.c, p), b.t + 1, b.t + hz)
        if r is not None:
            out.append(r)
    return out


def monkey_exits(bars: Sequence[Bar], p: Plan, n: int, rng: random.Random) -> list[float]:
    """The real entry and stop, but a random exit hour inside the horizon (the stop still applies)."""
    hz = int(p.horizon_h * 3_600_000)
    after = [b for b in bars if p.entry_ts < b.t <= p.entry_ts + hz]
    hyp = Hypo(p.entry, p.entry * (1 - p.stop_frac), float("inf"))
    risk = p.entry - hyp.stop
    out: list[float] = []
    for b in rng.sample(after, min(n, len(after))):
        hit, r = grade_path(bars, hyp, p.entry_ts + 1, b.t)
        out.append(-1.0 if hit == "STOP" else (b.c - p.entry) / risk)
    return out


def monkey_summary(real: Sequence[float], rand_entries: Sequence[float], rand_exits: Sequence[float]) -> dict:
    avg = lambda xs: round(sum(xs) / len(xs), 3) if xs else None  # noqa: E731
    e_real, e_ent, e_ex = avg(real), avg(rand_entries), avg(rand_exits)
    return {
        "n_real": len(real), "real_r": e_real,
        "random_entries_r": e_ent, "entry_edge_r": None if e_real is None or e_ent is None else round(e_real - e_ent, 3),
        "random_exits_r": e_ex, "exit_edge_r": None if e_real is None or e_ex is None else round(e_real - e_ex, 3),
    }


def daily_atr(bars: Sequence[Bar], period: int = 14) -> float | None:
    if len(bars) <= period:
        return None
    trs = [max(b.h - b.l, abs(b.h - a.c), abs(b.l - a.c)) for a, b in zip(bars[:-1], bars[1:])]
    return sum(trs[-period:]) / period


def missed_moves(daily: dict[str, Sequence[Bar]], seen: set[tuple[str, str]], since_ms: int, atr_mult: float = 3.0) -> list[dict]:
    """Days since `since_ms` where |close − prior close| ≥ atr_mult × ATR14 and nothing about the symbol was seen
    within a day of it. `seen` holds (symbol, YYYY-MM-DD)."""
    from datetime import datetime, timedelta, timezone

    out = []
    for sym, bars in daily.items():
        for i in range(15, len(bars)):
            b, prev = bars[i], bars[i - 1]
            if b.t < since_ms:
                continue
            a = daily_atr(bars[: i], 14)
            if not a:
                continue
            move = (b.c - prev.c) / a
            if abs(move) < atr_mult:
                continue
            d = datetime.fromtimestamp(b.t / 1000, timezone.utc).date()
            near = {(sym, (d + timedelta(days=k)).isoformat()) for k in (-1, 0, 1)}
            if not near & seen:
                out.append({"symbol": sym, "date": d.isoformat(), "move_atr": round(move, 2)})
    return sorted(out, key=lambda x: -abs(x["move_atr"]))
