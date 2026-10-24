"""`run dossier`: research one tradeable symbol and package the dossier as a `dossier` ingest batch (ADR-051)."""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

from .. import payload as P
from .agent import PROMPT_VERSION, Task, research


def arena_for(doctrine_path: Path, symbol: str) -> str | None:
    w = (yaml.safe_load(doctrine_path.read_text()) or {}).get("watchlists", {})
    if symbol in (w.get("crypto") or []):
        return "CRYPTO"
    equities = {*(w.get("crypto_proxies") or []), *(w.get("equities_core") or []), *(w.get("equities_catalyst") or [])}
    return "EQUITIES" if symbol in equities else None


def dossier_job(doctrine_path: Path, symbol: str, context: str, now_ms: int, run_url: str | None) -> dict[str, Any] | None:
    symbol = symbol.strip().upper()
    arena = arena_for(doctrine_path, symbol)
    if arena is None:
        print(f"dossier: {symbol!r} is not in the doctrine watchlists", file=sys.stderr)
        return None
    now = datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc)
    ctx = (context or "Court review requested.").strip()[:280]
    d = research(Task(symbol, arena, ctx), now, now_ms)
    if not d["findings"] and not d["summary"]:
        print(f"dossier: research produced nothing ({d['agent']['stop_reason']})", file=sys.stderr)
        return None
    raw = P.dumps(d).encode()
    item = P.item("deep-research", PROMPT_VERSION, now_ms, raw, d)
    return P.batch("dossier", now_ms, run_url, [item], None)
