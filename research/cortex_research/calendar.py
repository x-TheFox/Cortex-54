"""Equity earnings calendar for the brain's 72 h blackout (ADR-035).

Primary: Nasdaq's public calendar (one keyless request per weekday, full coverage). Backup: FMP free tier
(partial coverage). Events are merged and filtered to the symbols CORTEX can trade. If both sources fail the job
sends nothing, and the brain's calendar ages out and blocks equity entries (fail closed).
"""

from __future__ import annotations

import os
from datetime import date, timedelta

import requests

NASDAQ = "https://api.nasdaq.com/api/calendar/earnings"
FMP = "https://financialmodelingprep.com/stable/earnings-calendar"
UA = {"User-Agent": "Mozilla/5.0 (compatible; cortex-54 research)", "Accept": "application/json"}


def weekdays(start: date, days: int) -> list[date]:
    return [d for d in (start + timedelta(i) for i in range(days)) if d.weekday() < 5]


def merge(events: list[dict], universe: set[str]) -> list[dict]:
    seen: set[tuple[str, str]] = set()
    out = []
    for e in events:
        sym = str(e.get("symbol") or "").upper()
        day = str(e.get("date") or "")[:10]
        if sym in universe and len(day) == 10 and (sym, day) not in seen:
            seen.add((sym, day))
            out.append({"symbol": sym, "date": day})
    return sorted(out, key=lambda x: (x["date"], x["symbol"]))


def earnings_calendar(universe: set[str], today: date, days: int = 8) -> dict:
    events: list[dict] = []
    sources: list[str] = []
    failed: list[str] = []
    nasdaq_days = 0
    for d in weekdays(today, days):
        try:
            r = requests.get(NASDAQ, params={"date": d.isoformat()}, headers=UA, timeout=20)
            r.raise_for_status()
            rows = ((r.json() or {}).get("data") or {}).get("rows") or []
            events += [{"symbol": x.get("symbol"), "date": d.isoformat()} for x in rows]
            nasdaq_days += 1
        except Exception as e:  # noqa: BLE001
            failed.append(f"nasdaq {d}: {str(e)[:80]}")
    if nasdaq_days:
        sources.append(f"nasdaq ({nasdaq_days} days)")
    key = os.environ.get("FMP_API_KEY")
    if key:
        try:
            r = requests.get(FMP, params={"from": today.isoformat(), "to": (today + timedelta(days)).isoformat(), "apikey": key}, timeout=20)
            r.raise_for_status()
            rows = r.json()
            if isinstance(rows, list):
                events += [{"symbol": x.get("symbol"), "date": x.get("date")} for x in rows]
                sources.append("fmp")
        except Exception as e:  # noqa: BLE001
            failed.append(f"fmp: {str(e)[:80]}")
    return {"events": merge(events, universe), "sources": sources, "failed": failed, "from": today.isoformat(), "days": days}
