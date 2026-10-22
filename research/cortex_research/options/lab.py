"""Options shadow lab run (research.yml job=options). ADR-031.

    python -m cortex_research.options.lab [--dry-run]

Reads the shadow ledger from the brain (signed /governor/export, table options_shadow), marks open trades on the
Alpaca indicative options feed, closes them by rule, opens new defined-risk structures when the market is open and
the Tier 0 gates pass, and sends OPEN/CLOSE events back as a signed `options-lab` batch. Nothing here ever talks
to a broker order endpoint.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests
import yaml

from .. import payload as P
from ..governor.run import _sign, export
from . import structures as S

REPO = Path(__file__).resolve().parents[3]
DATA = "https://data.alpaca.markets"
TRADING = "https://paper-api.alpaca.markets"  # clock + contract metadata only (read-only)
MAX_OPEN = 15
MAX_OPENS_PER_RUN = 6


def _h() -> dict[str, str]:
    return {"APCA-API-KEY-ID": os.environ["ALPACA_KEY_ID"], "APCA-API-SECRET-KEY": os.environ["ALPACA_SECRET"]}


def _get(url: str, params: dict | None = None) -> dict:
    r = requests.get(url, params=params, headers=_h(), timeout=30)
    r.raise_for_status()
    return r.json()


def _paged(url: str, params: dict, key: str) -> dict:
    out: dict = {}
    params = dict(params)
    for _ in range(10):
        d = _get(url, params)
        out.update(d.get(key) or {})
        tok = d.get("next_page_token")
        if not tok:
            break
        params["page_token"] = tok
    return out


# ------------------------------------------------------------------ indicators (pure)


def sma(xs: list[float], n: int) -> float | None:
    return sum(xs[-n:]) / n if len(xs) >= n else None


def rsi(xs: list[float], n: int = 14) -> float | None:
    if len(xs) <= n:
        return None
    gains = [max(0.0, b - a) for a, b in zip(xs, xs[1:])]
    losses = [max(0.0, a - b) for a, b in zip(xs, xs[1:])]
    g, l = sum(gains[:n]) / n, sum(losses[:n]) / n
    for gi, li in zip(gains[n:], losses[n:]):
        g, l = (g * (n - 1) + gi) / n, (l * (n - 1) + li) / n
    return 100.0 if l == 0 else 100 - 100 / (1 + g / l)


def ema_series(xs: list[float], n: int) -> list[float]:
    k = 2 / (n + 1)
    out = [xs[0]]
    for x in xs[1:]:
        out.append(x * k + out[-1] * (1 - k))
    return out


def macd(xs: list[float]) -> tuple[float | None, float | None]:
    if len(xs) < 35:
        return None, None
    line = [a - b for a, b in zip(ema_series(xs, 12), ema_series(xs, 26))]
    return line[-1], ema_series(line, 9)[-1]


# ------------------------------------------------------------------ ledger


def open_trades(events: list[dict]) -> list[dict]:
    closed = {e["trade_id"] for e in events if e["kind"] == "CLOSE"}
    out = []
    for e in events:
        if e["kind"] == "OPEN" and e["trade_id"] not in closed:
            t = dict(e)
            t["legs"] = json.loads(e["legs_json"]) if isinstance(e.get("legs_json"), str) else e.get("legs", [])
            t["sizer_permits_live"] = bool(e.get("sizer_permits_live"))
            out.append(t)
    return out


def chain(und: str, kind: str, today: date, lo_days: int, hi_days: int | None, k_lo: float, k_hi: float,
          spot: float) -> list[S.Quote]:
    params = {"feed": "indicative", "type": kind, "limit": 1000,
              "expiration_date_gte": (today + timedelta(days=lo_days)).isoformat(),
              "strike_price_gte": round(k_lo, 2), "strike_price_lte": round(k_hi, 2)}
    if hi_days is not None:
        params["expiration_date_lte"] = (today + timedelta(days=hi_days)).isoformat()
    snaps = _paged(f"{DATA}/v1beta1/options/snapshots/{und}", params, "snapshots")
    return [q for sym, s in snaps.items() if (q := S.quote_from_snapshot(sym, s, spot, today))]


def with_oi(und: str, quotes: list[S.Quote], today: date, lo_days: int, hi_days: int | None) -> list[S.Quote]:
    params = {"underlying_symbols": und, "type": "call", "limit": 10000,
              "expiration_date_gte": (today + timedelta(days=lo_days)).isoformat()}
    if hi_days is not None:
        params["expiration_date_lte"] = (today + timedelta(days=hi_days)).isoformat()
    try:
        cs = _get(f"{TRADING}/v2/options/contracts", params).get("option_contracts") or []
    except requests.RequestException:
        return quotes
    oi = {c["symbol"]: int(float(c.get("open_interest") or 0)) for c in cs}
    return [S.Quote(**{**q.__dict__, "oi": oi.get(q.symbol, 0)}) for q in quotes]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    now = int(time.time() * 1000)
    today = datetime.now(timezone.utc).date()
    doctrine = yaml.safe_load((REPO / "config" / "doctrine.yaml").read_text())
    constitution = json.loads((REPO / "config" / "constitution.json").read_text())
    allowed = set(constitution["allowed"]["options_structures_paper"])
    strategies = [s for s in doctrine["strategies"] if s["arena"] == "OPTIONS" and s["status"] in ("SHADOW", "ACTIVE")
                  and s["params"]["structure"] in allowed]
    params = {s["id"]: s["params"] for s in strategies}
    risk_cap_cents = round(doctrine["accounts"]["LIVE"]["starting_equity_usd"] * 100 * doctrine["rungs"]["R1"]["per_trade_risk"])

    clock = _get(f"{TRADING}/v2/clock")
    market_open = bool(clock.get("is_open"))
    events = export("options_shadow", 200)
    opened = open_trades(events)

    unds = sorted({u for s in strategies for u in s.get("universe", [])} | {t["underlying"] for t in opened})
    start = (today - timedelta(days=160)).isoformat()
    bars = _paged(f"{DATA}/v2/stocks/bars", {"symbols": ",".join(unds), "timeframe": "1Day", "start": start,
                                              "feed": "iex", "limit": 10000, "adjustment": "split"}, "bars")
    latest = _get(f"{DATA}/v2/stocks/trades/latest", {"symbols": ",".join(unds), "feed": "iex"}).get("trades") or {}
    closes = {u: [b["c"] for b in bars.get(u, [])] for u in unds}
    spot = {u: float((latest.get(u) or {}).get("p") or (closes[u][-1] if closes[u] else 0)) or None for u in unds}

    out: list[dict] = []
    notes: list[str] = []

    # 1. Marks and exits on open trades.
    legsyms = sorted({leg["symbol"] for t in opened for leg in t["legs"]})
    qmap: dict[str, S.Quote] = {}
    for i in range(0, len(legsyms), 100):
        snaps = _paged(f"{DATA}/v1beta1/options/snapshots", {"symbols": ",".join(legsyms[i:i + 100]), "feed": "indicative"}, "snapshots")
        qmap.update({sym: q for sym, s in snaps.items() if (q := S.quote_from_snapshot(sym, s))})
    for t in opened:
        p = params.get(t["strategy"])
        if p is None:
            continue
        settle_spot = closes[t["underlying"]][-1] if closes.get(t["underlying"]) else None
        d = S.exit_decision(t, p, qmap if market_open else {}, settle_spot, today)
        if d:
            ev = S.close_event(t, d[0], d[1], d[2], now)
            out.append(ev)
            notes.append(f"CLOSE {t['strategy']} {t['underlying']} {d[0]} R={ev['r']:+.2f} (${ev['pnl_cents'] / 100:+.2f})")

    # 2. New structures (market hours only; the indicative feed is stale otherwise).
    still_open = {(t["strategy"], t["underlying"]) for t in opened if t["trade_id"] not in {e["trade_id"] for e in out}}
    n_open = len(still_open)
    opens = 0
    if market_open:
        for und in unds:
            px, cl = spot.get(und), closes.get(und) or []
            s50 = sma(cl, 50)
            if not px or s50 is None:
                continue
            if px <= s50:
                notes.append(f"skip {und}: below SMA50 (bullish structures only)")
                continue
            todo = [s for s in strategies if und in s.get("universe", []) and (s["id"], und) not in still_open]
            if not todo or n_open >= MAX_OPEN or opens >= MAX_OPENS_PER_RUN:
                continue
            try:
                puts = chain(und, "put", today, 14, 50, px * 0.80, px, px)
                calls = chain(und, "call", today, 5, 65, px * 0.95, px * 1.15, px)
                leaps = chain(und, "call", today, 260, None, px * 0.50, px * 1.0, px)
                calls, leaps = with_oi(und, calls, today, 5, 25), with_oi(und, leaps, today, 260, None)
            except requests.RequestException as e:
                notes.append(f"chain {und}: {e}")
                continue
            m, sig = macd(cl)
            trend = S.trend_score(px, s50, rsi(cl), m, sig)
            for s in todo:
                if n_open >= MAX_OPEN or opens >= MAX_OPENS_PER_RUN:
                    break
                p = s["params"]
                plan = (
                    S.bull_put_spread(s["id"], und, px, puts, today, p) if p["structure"] == "vertical_credit"
                    else S.bull_call_debit(s["id"], und, px, calls, today, p) if p["structure"] == "vertical_debit"
                    else S.pmcc(s["id"], und, px, calls, leaps, today, p, trend)
                )
                if isinstance(plan, str):
                    notes.append(f"skip {s['id']} {und}: {plan}")
                    continue
                tid = f"{s['id']}|{und}|{'/'.join(x.symbol for x in plan.legs)}|{today.isoformat()}"
                out.append(plan.as_event(now, tid, plan.max_loss_cents <= risk_cap_cents))
                n_open += 1
                opens += 1
                notes.append(f"OPEN {s['id']} {und} max loss ${plan.max_loss_cents / 100:.2f} " +
                             ("credit" if plan.entry_cash > 0 else "debit") + f" {abs(plan.entry_cash):.2f}")
    else:
        notes.append("market closed: marks/opens skipped (expiries still settle)")

    for n in notes:
        print(n)
    card = {
        "title": f"🧪 Options shadow lab · {today.isoformat()}",
        "sections": [{"name": "Events", "value": "\n".join(n for n in notes if n.startswith(("OPEN", "CLOSE")))[:1000] or "none"},
                     {"name": "Book", "value": f"{n_open} open · {sum(1 for e in events if e['kind'] == 'CLOSE') + sum(1 for e in out if e['kind'] == 'CLOSE')} closed (virtual, never sent to a broker)"}],
        "post": any(e for e in out),
    }
    raw = P.dumps(out).encode()
    items = [P.item("spread-structurer", "lab-v1", now, raw, {"events": out, "card": card})]
    body = P.dumps(P.batch("options-lab", now, os.environ.get("RUN_URL") or None, items, None))
    print(f"options-lab: {sum(1 for e in out if e['kind'] == 'OPEN')} open, {sum(1 for e in out if e['kind'] == 'CLOSE')} close, {len(body)} bytes")
    if a.dry_run:
        print(json.dumps(out, indent=1)[:3000])
        return 0
    url = os.environ["CORTEX_URL"].rstrip("/") + "/ingest/batch"
    r = requests.post(url, data=body.encode(), headers=_sign(body), timeout=60)
    print(f"ingest → HTTP {r.status_code}: {r.text[:300]}")
    return 0 if r.ok else 1


if __name__ == "__main__":
    sys.exit(main())
