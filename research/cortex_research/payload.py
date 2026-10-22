"""Pure mapping from upstream skill JSON to the /ingest/batch payload (mirrors src/contracts/batch.ts).

No I/O here so it is unit-testable with fixtures.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

POSTURES = {"NEW_ENTRY_ALLOWED", "REDUCE_ONLY", "CASH_PRIORITY"}
CRYPTO_MIN_SCORE_FOR_LONGS = 40.0  # mirrors config/doctrine.yaml regime_gates.crypto_composite_min_for_longs


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _num(x: Any) -> float | None:
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def item(skill_id: str, version: str, as_of_ms: int, raw: bytes, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "skill_id": skill_id,
        "version": version[:80],
        "as_of": as_of_ms,
        "inputs_sha256": sha256_bytes(raw),
        "payload": payload,
    }


def summarize_crypto_regime(d: dict[str, Any]) -> dict[str, Any]:
    comp = d.get("composite", {})
    components = {
        k: {"score": _num(v.get("score")), "available": v.get("available", v.get("score") is not None)}
        for k, v in (d.get("components") or {}).items()
        if isinstance(v, dict)
    }
    score = _num(comp.get("score")) or 0.0
    return {
        "headline": f"{comp.get('zone', '?')} {score:.1f}/100 "
        f"({comp.get('components_available', '?')}/{comp.get('components_total', '?')} components)",
        "score": score,
        "zone": comp.get("zone"),
        "guidance": comp.get("guidance"),
        "components": components,
    }


def crypto_posture(summary: dict[str, Any], funding: dict[str, Any] | None) -> dict[str, Any]:
    score = float(summary["score"])
    posture = "NEW_ENTRY_ALLOWED" if score >= CRYPTO_MIN_SCORE_FOR_LONGS else "REDUCE_ONLY"
    note = ""
    if funding and funding.get("max_annualized") is not None:
        note = f" Max perp funding (OKX) {funding['max_annualized'] * 100:.1f}% annualized."
    return {
        "arena": "CRYPTO",
        "posture": posture,
        "score": max(0.0, min(100.0, score)),
        "ceiling": None,
        "confidence": None,
        "summary": f"{summary.get('zone')}: {summary.get('guidance') or ''}{note}"[:600],
    }


def summarize_composite(d: dict[str, Any], label: str) -> dict[str, Any]:
    comp = d.get("composite", {})
    score = _num(comp.get("composite_score"))
    return {
        "headline": f"{label} {comp.get('zone', '?')} {score if score is None else round(score, 1)}",
        "score": score,
        "zone": comp.get("zone"),
        "guidance": comp.get("guidance") or comp.get("exposure_guidance"),
    }


def summarize_ftd(d: dict[str, Any]) -> dict[str, Any]:
    ms = d.get("market_state", {})
    q = d.get("quality_score", {})
    return {
        "headline": f"FTD {ms.get('combined_state', '?')} · quality {q.get('total_score', '?')} ({q.get('signal', '?')})",
        "combined_state": ms.get("combined_state"),
        "quality": _num(q.get("total_score")),
        "signal": q.get("signal"),
    }


def summarize_macro(d: dict[str, Any]) -> dict[str, Any]:
    r = d.get("regime", {})
    base = summarize_composite(d, "Macro")
    base["regime"] = r.get("current_regime")
    base["headline"] = f"Macro regime {r.get('regime_label') or r.get('current_regime', '?')} ({r.get('confidence', '?')})"
    return base


def equity_posture(exposure: dict[str, Any]) -> dict[str, Any]:
    rec = exposure.get("recommendation")
    posture = rec if rec in POSTURES else "REDUCE_ONLY"  # unknown → fail closed
    ceiling = _num(exposure.get("exposure_ceiling_pct"))
    conf = exposure.get("confidence")
    return {
        "arena": "EQUITIES",
        "posture": posture,
        "score": max(0.0, min(100.0, _num(exposure.get("composite_score")) or 0.0)),
        "ceiling": None if ceiling is None else max(0.0, min(1.0, ceiling / 100.0)),
        "confidence": conf if conf in {"LOW", "MEDIUM", "HIGH"} else None,
        "summary": (
            f"{posture} · bias {exposure.get('bias', '?')} · participation {exposure.get('participation', '?')}. "
            f"{exposure.get('rationale', '')}"
        )[:600],
    }


def batch(job: str, produced_at_ms: int, run_url: str | None, items: list[dict], posture: dict | None) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "job": job,
        "produced_at": produced_at_ms,
        "run_url": run_url,
        "items": items,
        "posture": posture,
    }


def dumps(obj: Any) -> str:
    """Compact, deterministic JSON (the exact bytes are what gets signed)."""
    return json.dumps(obj, separators=(",", ":"), sort_keys=True, ensure_ascii=False, default=str)
