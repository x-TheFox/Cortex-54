"""Kronos companions (ADR-069): a second, different forecaster run beside Kronos as a SHADOW opinion.

Research 2026-10-26: Timer-S1 (Tsinghua/ByteDance, arXiv 2603.04791) is an 8.3B-parameter MoE under a non-commercial
paper licence: too heavy for CPU runners and a licensing risk for a sold product. Chronos-2 (Amazon, Apache-2.0, 120M;
28M "small") leads the open models on GIFT-Eval in its own paper, runs on CPU and is commercially usable, so it is the
companion. Its numbers are logged next to Kronos' and shown on the FCST page; they never reach the court or a trade
until the Governor has graded both on the same outcomes (FUTURE_PLANS W2-31).
"""

from __future__ import annotations

import os
from typing import Any

MODEL_ID = os.environ.get("CHRONOS_MODEL", "amazon/chronos-2")
QUANTILES = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95]


def view(final_quantiles: dict[float, float], last: float) -> dict[str, float]:
    """Summary of the last forecast step's quantiles relative to the last close. p_up interpolates the CDF at `last`."""
    qs = sorted(final_quantiles.items())
    if not qs or last <= 0:
        return {}
    xs = [v for _, v in qs]
    ps = [q for q, _ in qs]
    if last <= xs[0]:
        p_below = ps[0] * (last / xs[0]) if xs[0] > 0 else 0.0
    elif last >= xs[-1]:
        p_below = 1 - (1 - ps[-1]) * (xs[-1] / last)
    else:
        p_below = ps[0]
        for (q0, v0), (q1, v1) in zip(qs, qs[1:]):
            if v0 <= last <= v1:
                p_below = q0 + (q1 - q0) * ((last - v0) / (v1 - v0) if v1 > v0 else 0.5)
                break
    r = lambda q: round(final_quantiles[q] / last - 1, 5) if q in final_quantiles else None  # noqa: E731
    return {"p_up": round(1 - min(max(p_below, 0.0), 1.0), 4), "q10_ret": r(0.1), "q50_ret": r(0.5), "q90_ret": r(0.9)}


def load() -> Any | None:
    """The Chronos-2 pipeline on CPU, or None when the `chronos` group isn't installed (the job then runs Kronos only)."""
    try:
        from chronos import Chronos2Pipeline  # type: ignore[import-not-found]

        return Chronos2Pipeline.from_pretrained(MODEL_ID, device_map="cpu")
    except Exception as e:  # noqa: BLE001
        print(f"chronos companion unavailable: {str(e)[:120]}")
        return None


def forecast(pipeline: Any, bars: list[dict], steps: int, freq: str) -> dict[str, Any] | None:
    """Chronos-2 quantiles for the step `steps` ahead → view(), tagged with the model id."""
    import pandas as pd

    closes = [float(b["c"]) for b in bars]
    if len(closes) < 30:
        return None
    df = pd.DataFrame({"id": "s", "timestamp": pd.to_datetime([b["t"] for b in bars], utc=True).tz_localize(None),
                       "target": closes})
    pred = pipeline.predict_df(df, prediction_length=steps, quantile_levels=QUANTILES, id_column="id",
                               timestamp_column="timestamp", target="target")
    row = pred.iloc[-1]
    q = {lvl: float(row[str(lvl)]) for lvl in QUANTILES if str(lvl) in row}
    v = view(q, closes[-1])
    return {"model": MODEL_ID, **v} if v else None
