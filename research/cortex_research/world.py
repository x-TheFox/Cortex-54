"""World-intel job: GDELT articles + SEC EDGAR filings → `world-intel` batch → Tier 1 triage queue.

GDELT DOC 2.0 (free, keyless): at most one request every 5 s, so calls are spaced 6 s and a 429 backs off once.
EDGAR (free): SEC requires a User-Agent with a contact email (SEC_USER_AGENT secret). Without it, EDGAR is skipped.
"""

from __future__ import annotations

import hashlib
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
import yaml

GDELT_URL = "https://api.gdeltproject.org/api/v2/doc/doc"
GDELT_SPACING_S = 6.0

# (topic, GDELT query, symbols the topic maps to)
TOPICS: list[tuple[str, str, list[str]]] = [
    ("federal reserve", '("federal reserve" OR "interest rates" OR FOMC)', ["SPY", "QQQ"]),
    ("inflation", "(inflation OR CPI OR PCE)", ["SPY", "QQQ"]),
    ("trade and tariffs", "(tariffs OR \"trade war\")", ["SPY"]),
    ("geopolitics", "(war OR missile OR sanctions OR invasion)", ["SPY"]),
    ("bitcoin", "bitcoin", ["BTCUSD"]),
    ("ethereum", "ethereum", ["ETHUSD"]),
    ("solana", "solana", ["SOLUSD"]),
    ("crypto regulation", "((SEC OR CFTC) AND crypto)", ["BTCUSD", "COIN"]),
]

# Major financial / crypto outlets. Unfiltered keyword hits were mostly noise (food banks, local law firms,
# share consolidations); restricting the source is cheaper than triaging it (ADR-027).
DOMAINS = [
    "reuters.com",
    "apnews.com",
    "cnbc.com",
    "marketwatch.com",
    "bloomberg.com",
    "wsj.com",
    "ft.com",
    "barrons.com",
    "finance.yahoo.com",
    "coindesk.com",
    "theblock.co",
    "decrypt.co",
    "cointelegraph.com",
]


def domain_clause(domains: list[str] = DOMAINS) -> str:
    return "(" + " OR ".join(f"domainis:{d}" for d in domains) + ")"


EDGAR_FORMS = {"8-K", "4", "6-K", "SC 13D", "SC 13G", "SC 13D/A", "SC 13G/A"}


def clean(s: str, n: int) -> str:
    return " ".join("".join(ch if ch.isprintable() else " " for ch in s).split())[:n]


def parse_seendate(s: str) -> int:
    """GDELT seendate '20261022T191500Z' → epoch ms."""
    return int(datetime.strptime(s, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc).timestamp() * 1000)


def gdelt_candidate(article: dict[str, Any], topic: str, symbols: list[str]) -> dict[str, Any] | None:
    url = article.get("url") or ""
    title = clean(article.get("title") or "", 380)
    if not title or not url.startswith("http"):
        return None
    return {
        "id": hashlib.sha1(url.encode()).hexdigest()[:24],
        "kind": "gdelt",
        "title": title,
        "url": url if url.startswith("https://") else None,
        "symbols": symbols,
        "source": clean(article.get("domain") or "", 70),
        "published_at": parse_seendate(article["seendate"]) if article.get("seendate") else int(time.time() * 1000),
        "topic": topic,
    }


def fetch_gdelt(timespan: str = "75min", per_topic: int = 8) -> tuple[list[dict], list[str]]:
    out: list[dict] = []
    failed: list[str] = []
    for n, (topic, query, symbols) in enumerate(TOPICS):
        if n:
            time.sleep(GDELT_SPACING_S)
        params = {
            "query": f"{query} {domain_clause()} sourcelang:english",
            "mode": "artlist",
            "format": "json",
            "maxrecords": per_topic,
            "timespan": timespan,
            "sort": "datedesc",
        }
        for attempt in range(2):
            try:
                r = requests.get(GDELT_URL, params=params, timeout=30)
                if r.status_code == 429 and attempt == 0:
                    time.sleep(30)
                    continue
                r.raise_for_status()
                arts = (r.json() or {}).get("articles") or []
                out += [c for a in arts if (c := gdelt_candidate(a, topic, symbols))]
                break
            except Exception as e:  # noqa: BLE001 - one topic failing never fails the job
                if attempt == 1 or not str(e).startswith("429"):
                    failed.append(f"{topic}: {str(e)[:80]}")
                    break
    seen: set[str] = set()
    unique = [c for c in out if not (c["id"] in seen or seen.add(c["id"]))]
    return unique, failed


def watch_tickers(doctrine_path: Path) -> list[str]:
    d = yaml.safe_load(doctrine_path.read_text())
    w = d.get("watchlists", {})
    return sorted({t for k in ("crypto_proxies", "equities_core") for t in w.get(k, []) if "/" not in t})


def fetch_edgar(tickers: list[str], since_ms: int) -> tuple[list[dict], list[str]]:
    ua = os.environ.get("SEC_USER_AGENT")
    if not ua:
        return [], ["SEC_USER_AGENT not set; EDGAR skipped"]
    h = {"User-Agent": ua, "Accept-Encoding": "gzip, deflate"}
    failed: list[str] = []
    try:
        cik_map = {
            v["ticker"].upper(): int(v["cik_str"])
            for v in requests.get("https://www.sec.gov/files/company_tickers.json", headers=h, timeout=30).json().values()
        }
    except Exception as e:  # noqa: BLE001
        return [], [f"ticker map: {str(e)[:80]}"]
    out: list[dict] = []
    for t in tickers:
        cik = cik_map.get(t)
        if cik is None:
            continue  # ETFs/trusts without a mapped CIK are fine to skip
        time.sleep(0.2)  # ≤ 5 req/s, well under SEC's 10
        try:
            sub = requests.get(f"https://data.sec.gov/submissions/CIK{cik:010d}.json", headers=h, timeout=30).json()
        except Exception as e:  # noqa: BLE001
            failed.append(f"{t}: {str(e)[:80]}")
            continue
        out += edgar_candidates(t, cik, sub, since_ms)
    return out, failed


def edgar_candidates(ticker: str, cik: int, sub: dict, since_ms: int) -> list[dict]:
    r = (sub.get("filings") or {}).get("recent") or {}
    forms = r.get("form", [])
    res: list[dict] = []
    for i, form in enumerate(forms):
        if form not in EDGAR_FORMS:
            continue
        accepted = r.get("acceptanceDateTime", [None] * len(forms))[i]
        if not accepted:
            continue
        ts = int(datetime.fromisoformat(accepted.replace("Z", "+00:00")).timestamp() * 1000)
        if ts < since_ms:
            continue
        acc = r["accessionNumber"][i]
        doc = (r.get("primaryDocument") or [""] * len(forms))[i]
        desc = (r.get("primaryDocDescription") or [""] * len(forms))[i] or ""
        items = (r.get("items") or [""] * len(forms))[i] or ""
        res.append(
            {
                "id": acc,
                "kind": "edgar",
                "title": clean(f"{ticker} filed {form}" + (f" (items {items})" if items else "") + (f": {desc}" if desc else ""), 380),
                "url": f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc.replace('-', '')}/{doc}" if doc else None,
                "symbols": [ticker],
                "source": "sec.gov",
                "published_at": ts,
                "topic": f"filing {form}",
            }
        )
    return res


def world_items(version_gdelt: str, now_ms: int, repo_root: Path) -> tuple[list[dict], list[str]]:
    from . import payload as P

    gd, gfail = fetch_gdelt()
    ed, efail = fetch_edgar(watch_tickers(repo_root / "config" / "doctrine.yaml"), now_ms - 26 * 3_600_000)
    items = []
    if gd:
        items.append(P.item("gdelt-world-pulse", version_gdelt, now_ms, P.dumps(gd).encode(), {"candidates": gd, "failed": gfail}))
    if ed:
        items.append(P.item("insider-form4-watcher", "edgar-v1", now_ms, P.dumps(ed).encode(), {"candidates": ed, "failed": efail}))
    for f in gfail + efail:
        print(f"world: {f}", file=sys.stderr)
    return items, gfail + efail
