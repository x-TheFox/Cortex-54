"""Read-only research tools for the deep-research agent. Every tool is keyless (or uses keys the research jobs already
hold), returns plain JSON-able data, never raises (errors come back as {"error": ...}), and records every URL it
surfaced so code can later check that the agent only cites sources it actually saw.

Free sources verified 2026-10-24: DuckDuckGo HTML, Bing News RSS, Google News RSS, Wikipedia REST, Jina reader
(r.jina.ai), SEC EDGAR (needs a contact User-Agent), Alpaca market data + news (paper keys).
"""

from __future__ import annotations

import html
import json
import os
import re
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Callable
from urllib.parse import parse_qs, quote_plus, unquote, urlparse

import requests

BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
BOT_UA = "CORTEX-54 research agent (github.com/x-TheFox/Cortex-54)"
TIMEOUT = 20
MAX_PAGE_CHARS = 7000
ALPACA_DATA = "https://data.alpaca.markets"


def _clean(s: str | None, n: int = 400) -> str:
    s = html.unescape(re.sub(r"<[^>]+>", " ", s or ""))
    s = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", s)
    return re.sub(r"\s+", " ", s).strip()[:n]


def _iso(dt: datetime | None) -> str | None:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%d") if dt else None


def _rfc822(s: str | None) -> str | None:
    try:
        return _iso(parsedate_to_datetime(s)) if s else None
    except (TypeError, ValueError):
        return None


def html_to_text(raw: str) -> tuple[str, str]:
    """(title, text) from an HTML page without third-party parsers: drop scripts/styles/nav, keep paragraphs."""
    title = _clean((re.search(r"<title[^>]*>(.*?)</title>", raw, re.S | re.I) or [None, ""])[1], 200)
    body = re.sub(r"(?is)<(script|style|noscript|svg|nav|footer|header|form|aside)[^>]*>.*?</\1>", " ", raw)
    body = re.sub(r"(?i)<br\s*/?>|</(p|div|li|h[1-6]|tr|section|article)>", "\n", body)
    text = html.unescape(re.sub(r"<[^>]+>", " ", body))
    lines = [re.sub(r"[ \t\r\f\v]+", " ", ln).strip() for ln in text.split("\n")]
    # keep lines that look like prose or data, drop menu crumbs
    keep = [ln for ln in lines if len(ln) >= 40 or re.search(r"\d", ln) and len(ln) >= 12]
    return title, "\n".join(keep)


@dataclass
class Toolbox:
    """The agent's tools. `seen` = every URL any tool surfaced; `read` = pages whose text the agent received."""

    now: datetime
    http: Callable[..., requests.Response] = requests.get
    seen: dict[str, dict[str, Any]] = field(default_factory=dict)
    read_urls: set[str] = field(default_factory=set)
    calls: int = 0

    # ---- registry -------------------------------------------------------------------------------------------------
    def specs(self) -> list[dict[str, str]]:
        return [
            {"name": "web_search", "args": '{"query": str}',
             "does": "General web search (DuckDuckGo). Use for company facts, earnings dates, guidance, analyst views, protocol news."},
            {"name": "news_search", "args": '{"query": str, "days": int (1-30, default 7)}',
             "does": "Recent news headlines with dates (Google News + Bing News). Use first to learn what happened lately."},
            {"name": "read_url", "args": '{"url": str}',
             "does": f"Fetch a page and return its text (≤{MAX_PAGE_CHARS} chars). Only pages you read count as verified sources."},
            {"name": "wikipedia", "args": '{"topic": str}', "does": "Wikipedia summary for background (company, protocol, person)."},
            {"name": "sec_filings", "args": '{"ticker": str}',
             "does": "Recent SEC filings (8-K, 10-Q, 10-K, S-1, 4) with dates and links. Equities only."},
            {"name": "market_snapshot", "args": '{"symbol": str}',
             "does": "Real current price and 1/5/20/60-day % change, 60-day range, avg volume (Alpaca). Ground truth for prices."},
            {"name": "company_news", "args": '{"symbol": str}', "does": "Last 7 days of wire headlines for the symbol (Alpaca/Benzinga)."},
        ]

    def run(self, tool: str, args: dict[str, Any]) -> dict[str, Any]:
        self.calls += 1
        fn = {
            "web_search": lambda a: self.web_search(str(a.get("query", ""))),
            "news_search": lambda a: self.news_search(str(a.get("query", "")), int(a.get("days", 7) or 7)),
            "read_url": lambda a: self.read_url(str(a.get("url", ""))),
            "wikipedia": lambda a: self.wikipedia(str(a.get("topic", ""))),
            "sec_filings": lambda a: self.sec_filings(str(a.get("ticker", ""))),
            "market_snapshot": lambda a: self.market_snapshot(str(a.get("symbol", ""))),
            "company_news": lambda a: self.company_news(str(a.get("symbol", ""))),
        }.get(tool)
        if fn is None:
            return {"error": f"unknown tool {tool!r}"}
        try:
            return fn(args if isinstance(args, dict) else {})
        except Exception as e:  # noqa: BLE001 — a tool must never crash the agent
            return {"error": f"{type(e).__name__}: {str(e)[:200]}"}

    def _note(self, url: str, title: str, published: str | None, via: str) -> None:
        if url and url.startswith("http") and url not in self.seen:
            self.seen[url] = {"title": title[:160], "published": published, "via": via}

    # ---- search ---------------------------------------------------------------------------------------------------
    def web_search(self, query: str) -> dict[str, Any]:
        if not query.strip():
            return {"error": "empty query"}
        r = self.http("https://html.duckduckgo.com/html/", params={"q": query}, headers={"user-agent": BROWSER_UA},
                      timeout=TIMEOUT)
        hits = []
        for m in re.finditer(r'class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>(.*?)(?=class="result__a"|$)', r.text, re.S):
            href, title, rest = m.group(1), _clean(m.group(2), 160), m.group(3)
            if "uddg=" in href:
                href = unquote(parse_qs(urlparse(href if href.startswith("http") else "https:" + href).query)["uddg"][0])
            if "duckduckgo.com/y.js" in href or not href.startswith("http"):
                continue  # ads
            snip = _clean((re.search(r'class="result__snippet"[^>]*>(.*?)</a>', rest, re.S) or [None, ""])[1], 300)
            hits.append({"title": title, "url": href, "snippet": snip})
            self._note(href, title, None, "web_search")
            if len(hits) >= 8:
                break
        return {"query": query, "results": hits} if hits else {"query": query, "results": [], "note": "no results"}

    def news_search(self, query: str, days: int = 7) -> dict[str, Any]:
        days = max(1, min(30, days))
        out: list[dict[str, Any]] = []
        try:
            g = self.http("https://news.google.com/rss/search",
                          params={"q": f"{query} when:{days}d", "hl": "en-US", "gl": "US", "ceid": "US:en"},
                          headers={"user-agent": BOT_UA}, timeout=TIMEOUT)
            for it in ET.fromstring(g.content).iter("item"):
                title = _clean(it.findtext("title"), 200)
                src = _clean(it.findtext("source"), 60)
                out.append({"title": title, "source": src, "published": _rfc822(it.findtext("pubDate")),
                            "url": it.findtext("link") or "", "engine": "google-news"})
        except (requests.RequestException, ET.ParseError):
            pass
        try:
            b = self.http("https://www.bing.com/news/search", params={"q": query, "format": "rss"},
                          headers={"user-agent": BROWSER_UA}, timeout=TIMEOUT)
            for it in ET.fromstring(b.content).iter("item"):
                link = it.findtext("link") or ""
                q = parse_qs(urlparse(link).query)
                if "url" in q:
                    link = q["url"][0]
                out.append({"title": _clean(it.findtext("title"), 200), "source": "", "url": link,
                            "published": _rfc822(it.findtext("pubDate")), "engine": "bing-news",
                            "snippet": _clean(it.findtext("description"), 240)})
        except (requests.RequestException, ET.ParseError):
            pass
        cutoff = _iso(self.now - timedelta(days=days))
        dedup: dict[str, dict[str, Any]] = {}
        for h in out:
            key = re.sub(r"\W+", "", h["title"].lower())[:60]
            if key and key not in dedup and (h["published"] is None or cutoff is None or h["published"] >= cutoff):
                dedup[key] = h
        hits = sorted(dedup.values(), key=lambda h: h["published"] or "", reverse=True)[:12]
        for h in hits:
            self._note(h["url"], h["title"], h["published"], "news_search")
        return {"query": query, "days": days, "results": hits,
                "tip": "google-news links are redirects; to read one, web_search its title or read the bing/publisher URL"}

    # ---- reading --------------------------------------------------------------------------------------------------
    def read_url(self, url: str) -> dict[str, Any]:
        p = urlparse(url)
        if p.scheme not in ("http", "https") or not p.netloc:
            return {"error": "not an http(s) URL"}
        if p.hostname in ("localhost", "127.0.0.1", "0.0.0.0") or (p.hostname or "").endswith((".internal", ".local")):
            return {"error": "refused: local address"}
        title, text = "", ""
        try:
            r = self.http(url, headers={"user-agent": BROWSER_UA, "accept": "text/html,*/*"}, timeout=TIMEOUT,
                          allow_redirects=True)
            ctype = r.headers.get("content-type", "")
            if r.ok and "html" in ctype:
                title, text = html_to_text(r.text)
            elif r.ok and ("json" in ctype or "text/plain" in ctype):
                text = r.text
        except requests.RequestException:
            pass
        if len(text) < 600:  # paywall / JS page / block → Jina's reader renders it server-side
            try:
                j = self.http(f"https://r.jina.ai/{url}", headers={"user-agent": BOT_UA, "x-return-format": "text"},
                              timeout=TIMEOUT + 10)
                if j.ok and len(j.text) > len(text):
                    text = j.text
                    title = title or _clean((re.search(r"^Title:\s*(.+)$", j.text, re.M) or [None, ""])[1], 200)
            except requests.RequestException:
                pass
        if len(text) < 200:
            return {"url": url, "error": "could not extract readable text (paywall, block or empty page)"}
        text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)
        published = None
        m = re.search(r"(20\d\d-[01]\d-[0-3]\d)", text[:3000])
        if m:
            published = m.group(1)
        self._note(url, title, published, "read_url")
        self.read_urls.add(url)
        return {"url": url, "title": title, "published_hint": published, "chars": len(text),
                "text": text[:MAX_PAGE_CHARS] + ("…[truncated]" if len(text) > MAX_PAGE_CHARS else "")}

    def wikipedia(self, topic: str) -> dict[str, Any]:
        r = self.http(f"https://en.wikipedia.org/api/rest_v1/page/summary/{quote_plus(topic.replace(' ', '_'))}",
                      headers={"user-agent": BOT_UA}, timeout=TIMEOUT)
        if not r.ok:
            return {"error": f"no Wikipedia page for {topic!r}"}
        d = r.json()
        url = (d.get("content_urls") or {}).get("desktop", {}).get("page", "")
        self._note(url, d.get("title", topic), None, "wikipedia")
        self.read_urls.add(url)
        return {"title": d.get("title"), "url": url, "summary": _clean(d.get("extract"), 1800),
                "note": "Wikipedia is background only; it can be months stale."}

    # ---- primary data ---------------------------------------------------------------------------------------------
    def sec_filings(self, ticker: str) -> dict[str, Any]:
        ua = os.environ.get("SEC_USER_AGENT")
        if not ua:
            return {"error": "SEC access not configured"}
        t = ticker.upper().split("/")[0]
        m = self.http("https://www.sec.gov/files/company_tickers.json", headers={"user-agent": ua}, timeout=TIMEOUT).json()
        cik = next((v["cik_str"] for v in m.values() if v.get("ticker") == t), None)
        if cik is None:
            return {"error": f"{t} not found in SEC ticker map (crypto assets have no filings)"}
        sub = self.http(f"https://data.sec.gov/submissions/CIK{int(cik):010d}.json", headers={"user-agent": ua},
                        timeout=TIMEOUT).json()
        rec = sub.get("filings", {}).get("recent", {})
        rows = []
        for form, date, acc, doc, desc in zip(rec.get("form", []), rec.get("filingDate", []), rec.get("accessionNumber", []),
                                             rec.get("primaryDocument", []), rec.get("primaryDocDescription", [])):
            if form not in ("8-K", "10-Q", "10-K", "S-1", "S-3", "4", "SC 13D", "SC 13G", "424B5", "6-K", "DEF 14A"):
                continue
            url = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc.replace('-', '')}/{doc}"
            rows.append({"form": form, "date": date, "description": _clean(desc, 120), "url": url})
            self._note(url, f"{t} {form} {date}", date, "sec_filings")
            if len(rows) >= 12:
                break
        return {"company": sub.get("name"), "cik": cik, "filings": rows,
                "tip": "read_url on an 8-K to see what it announced (earnings, deals, executive changes)."}

    def _alpaca_headers(self) -> dict[str, str] | None:
        k, s = os.environ.get("ALPACA_KEY_ID"), os.environ.get("ALPACA_SECRET")
        return {"APCA-API-KEY-ID": k, "APCA-API-SECRET-KEY": s} if k and s else None

    def market_snapshot(self, symbol: str) -> dict[str, Any]:
        h = self._alpaca_headers()
        if not h:
            return {"error": "market data not configured"}
        sym = symbol.upper()
        start = (self.now - timedelta(days=100)).strftime("%Y-%m-%d")
        if "/" in sym:
            r = self.http(f"{ALPACA_DATA}/v1beta3/crypto/us/bars", params={"symbols": sym, "timeframe": "1Day", "start": start,
                          "limit": 120}, headers=h, timeout=TIMEOUT).json()
            bars = (r.get("bars") or {}).get(sym, [])
        else:
            r = self.http(f"{ALPACA_DATA}/v2/stocks/{sym}/bars", params={"timeframe": "1Day", "start": start, "limit": 120,
                          "feed": "iex", "adjustment": "split"}, headers=h, timeout=TIMEOUT).json()
            bars = r.get("bars") or []
        if len(bars) < 5:
            return {"error": f"no daily bars for {sym}"}
        c = [float(b["c"]) for b in bars]
        last = c[-1]

        def chg(n: int) -> float | None:
            return round((last / c[-1 - n] - 1) * 100, 2) if len(c) > n else None

        tail = bars[-60:]
        return {"symbol": sym, "last_close": last, "last_bar_date": str(bars[-1]["t"])[:10],
                "change_pct": {"1d": chg(1), "5d": chg(5), "20d": chg(20), "60d": chg(60)},
                "range_60d": [min(float(b["l"]) for b in tail), max(float(b["h"]) for b in tail)],
                "avg_volume_20d": round(sum(float(b["v"]) for b in bars[-20:]) / min(20, len(bars)), 2),
                "note": "Daily bars, free IEX feed for stocks. Trust these numbers over any price quoted in an article."}

    def company_news(self, symbol: str) -> dict[str, Any]:
        h = self._alpaca_headers()
        if not h:
            return {"error": "news not configured"}
        sym = symbol.upper()
        r = self.http(f"{ALPACA_DATA}/v1beta1/news", params={"symbols": sym, "limit": 15,
                      "start": (self.now - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")}, headers=h, timeout=TIMEOUT).json()
        rows = []
        for n in r.get("news", []):
            url = n.get("url") or ""
            rows.append({"headline": _clean(n.get("headline"), 200), "published": str(n.get("created_at", ""))[:10],
                         "source": n.get("source"), "summary": _clean(n.get("summary"), 300), "url": url})
            self._note(url, n.get("headline") or "", str(n.get("created_at", ""))[:10], "company_news")
        return {"symbol": sym, "headlines": rows}


def compact(result: dict[str, Any], limit: int = MAX_PAGE_CHARS + 600) -> str:
    """Tool result as the text the model sees (bounded)."""
    s = json.dumps(result, ensure_ascii=False)
    return s if len(s) <= limit else s[:limit] + "…"


def pace(seconds: float) -> None:
    time.sleep(seconds)
