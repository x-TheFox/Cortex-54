"""Setup screeners (research.yml job=screeners, ADR-035).

Runs the pinned tradermonty Stockbee screeners (momentum burst, exhaustion hammer) in offline mode on Alpaca daily
bars for CORTEX's tradeable universe. Hits scoring ≥ 70 go to the brain as Tier 2 candidates. The screeners
only *propose*: Clef 27B, the court, scar tissue and every risk rail still decide.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
import yaml

from . import payload as P

DATA = "https://data.alpaca.markets"
SCREENERS = {
    # skill → (script, output pattern, actionable states)
    "stockbee-momentum-burst-screener": ("screen_momentum_burst.py", "stockbee_momentum_burst_*.json"),
    "stockbee-exhaustion-hammer-screener": ("screen_exhaustion_hammer.py", "stockbee_exhaustion_hammer_*.json"),
}
MIN_SCORE = 70


def universe(doctrine_path: Path) -> tuple[list[str], list[str]]:
    d = yaml.safe_load(doctrine_path.read_text())
    eq = sorted({u for s in d["strategies"] if s["arena"] == "EQUITIES" and s["status"] == "ACTIVE" for u in s.get("universe", [])})
    cr = sorted({u for s in d["strategies"] if s["arena"] == "CRYPTO" and s["status"] == "ACTIVE" for u in s.get("universe", [])})
    return eq, cr


def _h() -> dict[str, str]:
    return {"APCA-API-KEY-ID": os.environ["ALPACA_KEY_ID"], "APCA-API-SECRET-KEY": os.environ["ALPACA_SECRET"]}


def daily_bars(symbols: list[str], crypto: bool, days: int = 120) -> dict[str, list[dict]]:
    """{symbol: [{date, open, high, low, close, volume}]} in the shape the upstream screeners read."""
    if not symbols:
        return {}
    url = f"{DATA}/v1beta3/crypto/us/bars" if crypto else f"{DATA}/v2/stocks/bars"
    start = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT00:00:00Z")
    params = {"symbols": ",".join(symbols), "timeframe": "1Day", "start": start, "limit": 10000}
    if not crypto:
        params.update({"feed": "iex", "adjustment": "split"})
    out: dict[str, list[dict]] = {}
    for _ in range(20):
        r = requests.get(url, params=params, headers=_h(), timeout=30)
        r.raise_for_status()
        d = r.json()
        for sym, bars in (d.get("bars") or {}).items():
            out.setdefault(sym, []).extend(
                {"date": b["t"][:10], "open": b["o"], "high": b["h"], "low": b["l"], "close": b["c"], "volume": int(b["v"])}
                for b in bars
            )
        tok = d.get("next_page_token")
        if not tok:
            break
        params["page_token"] = tok
    return out


def to_key(sym: str) -> str:
    return sym.replace("/", "")


def candidates(skill: str, report: dict, keymap: dict[str, str], as_of_ms: int) -> list[dict]:
    out = []
    for c in report.get("candidates") or []:
        score = int(c.get("setup_score") or 0)
        sym = keymap.get(str(c.get("symbol", "")).upper())
        if not sym or score < MIN_SCORE or c.get("state") in ("REJECTED", None):
            continue
        name = "momentum burst" if "momentum" in skill else "exhaustion hammer"
        tags = ", ".join(c.get("trigger_tags") or [])
        out.append({
            "id": f"{skill}:{sym}:{c.get('date')}",
            "screener": skill,
            "symbol": sym,
            "bar_date": str(c.get("date")),
            "score": score,
            "state": str(c.get("state")),
            "headline": f"{sym}: {name} setup on {c.get('date')} (score {score}, {c.get('state')}"
                        + (f"; {tags}" if tags else "") + f"; day {c.get('day_gain_pct')}%, vol×{c.get('volume_ratio_20d')})",
            "entry_reference": c.get("entry_reference"),
            "stop_reference": c.get("stop_reference"),
            "as_of": as_of_ms,
        })
    return out


def screener_job(upstream: Path, version: str, run_skill, newest, now_ms: int, doctrine_path: Path) -> dict | None:
    eq, cr = universe(doctrine_path)
    if datetime.now(timezone.utc).weekday() >= 5:
        eq = []  # equity entries need a session; weekends screen crypto only
    items: list[dict] = []
    found: list[dict] = []
    with tempfile.TemporaryDirectory() as tmp:
        tmpd = Path(tmp)
        for crypto, syms in ((False, eq), (True, cr)):
            try:
                bars = daily_bars(syms, crypto)
            except Exception as e:  # noqa: BLE001
                print(f"bars ({'crypto' if crypto else 'equities'}): {e}", file=sys.stderr)
                continue
            keymap = {to_key(s): s for s in syms}
            prices = tmpd / f"prices_{'crypto' if crypto else 'eq'}.json"
            prices.write_text(json.dumps({to_key(s): v for s, v in bars.items()}))
            extra = ["--min-price", "0.01", "--min-volume", "0"] if crypto else []
            for skill, (script, pattern) in SCREENERS.items():
                out = tmpd / f"{skill}_{'c' if crypto else 'e'}"
                out.mkdir()
                try:
                    run_skill(skill, script, ["--prices-json", str(prices), "--symbols", *keymap.keys(), "--output-dir", str(out), *extra], out)
                    rep = json.loads(newest(out, pattern).read_text())
                except Exception as e:  # noqa: BLE001
                    print(f"{skill} ({'crypto' if crypto else 'eq'}): {e}", file=sys.stderr)
                    continue
                hits = candidates(skill, rep, keymap, now_ms)
                found += hits
                print(f"{skill} ({'crypto' if crypto else 'equities'}): {len(rep.get('candidates') or [])} scanned → {len(hits)} candidate(s)")
    summary = {"candidates": found, "universe": {"equities": len(eq), "crypto": len(cr)}}
    items.append(P.item("setup-screeners", version, now_ms, P.dumps(found).encode(), summary))
    return P.batch("screeners", now_ms, os.environ.get("RUN_URL") or None, items, None)
