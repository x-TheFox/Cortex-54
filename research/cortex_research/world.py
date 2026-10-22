"""World-intel job: GDELT GKG world pulse + wire press releases + SEC EDGAR filings → `world-intel` batch → Tier 1 triage queue.

GDELT GKG 2.1 bulk files (free, no rate limit), 15-minute cadence, published with up to ~45 min lag.
EDGAR (free): SEC requires a User-Agent with a contact email (SEC_USER_AGENT secret). Without it, EDGAR is skipped.
"""

from __future__ import annotations

import csv
import hashlib
import io
import os
import re
import sys
import time
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests
import yaml

GDELT_BULK = "https://data.gdeltproject.org/gdeltv2"
GKG_FILES_PER_RUN = 4  # ≈ 1 hour of 15-minute files

# The DOC 2.0 API is rate-limited per IP and GitHub's shared runners are throttled on every call, and the GKG
# corpus is mostly local outlets, so GDELT is used as an aggregate *world risk pulse* from the bulk 15-minute GKG
# files (no rate limit), plus press releases that name watched companies (ADR-028).
# Pattern rules: "X" matches theme X and its sub-themes X_*; "*X" matches any theme containing X.
THEME_GROUPS: dict[str, tuple[str, ...]] = {
    "conflict": ("ARMEDCONFLICT", "MILITARY", "TERROR", "WB_2433_CONFLICT_AND_VIOLENCE", "PROTEST", "KILL"),
    "policy_uncertainty": ("EPU_POLICY", "EPU_UNCERTAINTY"),
    "monetary": ("ECON_INTEREST_RATES", "ECON_CENTRALBANK", "ECON_INFLATION", "TAX_ECON_PRICE", "ECON_DEBT"),
    "markets": ("ECON_STOCKMARKET", "ECON_WORLDCURRENCIES", "ECON_BANKRUPTCY", "WB_1104_MACROECONOMIC_VULNERABILITY_AND_DEBT"),
    "crypto": ("*CRYPTO", "*BITCOIN", "*BLOCKCHAIN"),
}


def theme_matches(theme: str, pattern: str) -> bool:
    if pattern.startswith("*"):
        return pattern[1:] in theme
    return theme == pattern or theme.startswith(pattern + "_")


WIRES = ("prnewswire.com", "globenewswire.com", "businesswire.com", "accessnewswire.com", "newsfilecorp.com")
# organization / title keyword → tradeable symbol (watchlists in config/doctrine.yaml)
COMPANY_SYMBOLS: dict[str, str] = {
    "coinbase": "COIN",
    "microstrategy": "MSTR",
    "strategy inc": "MSTR",
    "ishares bitcoin": "IBIT",
}


def gkg_urls(lastupdate_text: str, n: int = GKG_FILES_PER_RUN, max_back: int = 10) -> list[str]:
    """Candidate GKG URLs, newest first, stepping back 15 min from the latest export timestamp."""
    m = re.search(r"/(\d{14})\.export\.CSV\.zip", lastupdate_text)
    if not m:
        return []
    t = datetime.strptime(m.group(1), "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
    return [
        f"{GDELT_BULK}/{(t - timedelta(minutes=15 * k)).strftime('%Y%m%d%H%M%S')}.gkg.csv.zip"
        for k in range(max_back)
    ][: max(n, max_back)]


def parse_gkg(raw_csv: bytes) -> list[list[str]]:
    csv.field_size_limit(10**9)
    text = raw_csv.decode("latin-1")
    return [r for r in csv.reader(io.StringIO(text), delimiter="\t") if len(r) >= 16]


def _themes(r: list[str]) -> set[str]:
    return {t.split(",")[0] for t in r[7].split(";") if t}


def _tone(r: list[str]) -> float | None:
    try:
        return float(r[15].split(",")[0])
    except (ValueError, IndexError):
        return None


def world_pulse(rows: list[list[str]]) -> dict[str, Any]:
    """Share of articles and mean tone per theme group (pure)."""
    total = len(rows)
    groups: dict[str, Any] = {}
    for g, prefixes in THEME_GROUPS.items():
        hit = [r for r in rows if any(theme_matches(t, p) for t in _themes(r) for p in prefixes)]
        tones = [x for r in hit if (x := _tone(r)) is not None]
        groups[g] = {
            "articles": len(hit),
            "share": round(len(hit) / total, 4) if total else 0.0,
            "tone": round(sum(tones) / len(tones), 3) if tones else None,
        }
    all_tones = [x for r in rows if (x := _tone(r)) is not None]
    return {
        "articles": total,
        "tone": round(sum(all_tones) / len(all_tones), 3) if all_tones else None,
        "groups": groups,
        "headline": "World pulse: "
        + ", ".join(f"{g} {v['share'] * 100:.1f}% (tone {v['tone']})" for g, v in groups.items()),
    }


def press_release_candidates(rows: list[list[str]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for r in rows:
        if r[3] not in WIRES:
            continue
        title_m = re.search(r"<PAGE_TITLE>(.*?)</PAGE_TITLE>", r[26] if len(r) > 26 else "")
        title = clean(title_m.group(1) if title_m else "", 380)
        hay = (title + " " + r[13]).lower()
        symbols = sorted({sym for k, sym in COMPANY_SYMBOLS.items() if k in hay})
        if not symbols or not title:
            continue
        url = r[4] if r[4].startswith("https://") else None
        out.append(
            {
                "id": hashlib.sha1(r[4].encode()).hexdigest()[:24],
                "kind": "gdelt",
                "title": title,
                "url": url,
                "symbols": symbols,
                "source": r[3],
                "published_at": int(datetime.strptime(r[1], "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc).timestamp() * 1000),
                "topic": "press release",
            }
        )
    return out


def fetch_gdelt() -> tuple[list[list[str]], list[str]]:
    failed: list[str] = []
    try:
        last = requests.get(f"{GDELT_BULK}/lastupdate.txt", timeout=30).text
    except Exception as e:  # noqa: BLE001
        return [], [f"lastupdate: {str(e)[:80]}"]
    rows: list[list[str]] = []
    got = 0
    for url in gkg_urls(last):
        if got >= GKG_FILES_PER_RUN:
            break
        try:
            r = requests.get(url, timeout=120)
            if r.status_code == 404:
                continue  # GKG files publish with a lag; step back
            r.raise_for_status()
            with zipfile.ZipFile(io.BytesIO(r.content)) as z:
                rows += parse_gkg(z.read(z.namelist()[0]))
            got += 1
        except Exception as e:  # noqa: BLE001
            failed.append(f"{url.rsplit('/', 1)[-1]}: {str(e)[:60]}")
    if got == 0:
        failed.append("no GKG files available")
    return rows, failed


EDGAR_FORMS = {"8-K", "4", "6-K", "SC 13D", "SC 13G", "SC 13D/A", "SC 13G/A"}


def clean(s: str, n: int) -> str:
    return " ".join("".join(ch if ch.isprintable() else " " for ch in s).split())[:n]


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

    rows, gfail = fetch_gdelt()
    ed, efail = fetch_edgar(watch_tickers(repo_root / "config" / "doctrine.yaml"), now_ms - 26 * 3_600_000)
    items = []
    if rows:
        pulse = world_pulse(rows)
        prs = press_release_candidates(rows)
        items.append(
            P.item("gdelt-world-pulse", version_gdelt, now_ms, P.dumps(pulse).encode(), {**pulse, "candidates": prs, "failed": gfail})
        )
    if ed:
        items.append(P.item("insider-form4-watcher", "edgar-v1", now_ms, P.dumps(ed).encode(), {"candidates": ed, "failed": efail}))
    for f in gfail + efail:
        print(f"world: {f}", file=sys.stderr)
    return items, gfail + efail
