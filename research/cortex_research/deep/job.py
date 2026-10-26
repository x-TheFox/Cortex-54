"""`run dossier`: research one symbol and post the dossier as a `dossier` ingest batch (ADR-051, ADR-057).

With a deep ring the fast dossier is posted the moment it exists (the court is waiting for it) and the deep one
replaces it when the run ends. The arena comes from the dispatch (the brain knows it, including for symbols the scout
hot-ported); the doctrine watchlists are the fallback for manual runs.
"""

from __future__ import annotations

import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import yaml

from .. import payload as P
from .agent import PROMPT_VERSION, Task, limits_for, research

_SYM = re.compile(r"^(?:[A-Z]{1,5}(?:\.[A-Z])?|[A-Z0-9]{2,10}/USD)$")


def arena_for(doctrine_path: Path, symbol: str) -> str | None:
    w = (yaml.safe_load(doctrine_path.read_text()) or {}).get("watchlists", {})
    if symbol in (w.get("crypto") or []):
        return "CRYPTO"
    equities = {*(w.get("crypto_proxies") or []), *(w.get("equities_core") or []), *(w.get("equities_catalyst") or [])}
    return "EQUITIES" if symbol in equities else None


def resolve_arena(doctrine_path: Path, symbol: str, given: str) -> str | None:
    """The dispatch's arena when it is valid for the symbol's shape, else the doctrine watchlists."""
    g = (given or "").strip().upper()
    if g in ("CRYPTO", "EQUITIES") and _SYM.match(symbol) and (("/" in symbol) == (g == "CRYPTO")):
        return g
    return arena_for(doctrine_path, symbol)


def parse_kill(raw: str) -> list[str]:
    return [k.strip()[:200] for k in (raw or "").split("|") if k.strip()][:6]


def dossier_batch(d: dict[str, Any], now_ms: int, run_url: str | None) -> dict[str, Any]:
    raw = P.dumps(d).encode()
    item = P.item("deep-research", PROMPT_VERSION, now_ms, raw, d)
    return P.batch("dossier", now_ms, run_url, [item], None)


def dossier_job(doctrine_path: Path, symbol: str, context: str, now_ms: int, run_url: str | None, *,
                arena: str = "", mode: str = "case", depth: str = "standard", catalyst: str = "", kill: str = "",
                post: Callable[[dict[str, Any]], bool] | None = None) -> dict[str, Any] | None:
    symbol = symbol.strip().upper()
    ar = resolve_arena(doctrine_path, symbol, arena)
    if ar is None:
        print(f"dossier: {symbol!r} has no arena (not a valid symbol or not in the watchlists)", file=sys.stderr)
        return None
    mode = mode if mode in ("case", "watch") else "case"
    depth = "watch" if mode == "watch" else (depth if depth in ("quick", "standard", "deep") else "standard")
    now = datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc)
    ctx = (context or "Court review requested.").strip()[:280]
    task = Task(symbol, ar, ctx, catalyst=(catalyst or "").strip()[:300], mode=mode, kill_criteria=parse_kill(kill))

    def on_fast(fast: dict[str, Any]) -> None:
        if post is None or not (fast["findings"] or fast["summary"]):
            return
        ok = post(dossier_batch(fast, fast["as_of"], run_url))
        print(f"dossier: fast ring posted ({len(fast['findings'])} findings) → {'ok' if ok else 'FAILED'}")

    d = research(task, now, now_ms, limits=limits_for(depth), on_fast=on_fast,
                 now_ms_fn=lambda: int(time.time() * 1000))
    if not d["findings"] and not d["summary"]:
        print(f"dossier: research produced nothing ({d['agent']['stop_reason']})", file=sys.stderr)
        return None
    return dossier_batch(d, d["as_of"], run_url)
