"""Deep-research harness (ADR-051): JSON extraction, chain failover, the agent loop, and the code-side citation checks."""

from __future__ import annotations

from datetime import datetime, timezone

import requests

from cortex_research.deep.agent import Limits, Run, Task, build_dossier, near_duplicate
from cortex_research.deep.llm import Chain, Hop, extract_json
from cortex_research.deep.tools import Toolbox, html_to_text

NOW = datetime(2026, 10, 24, 12, 0, tzinfo=timezone.utc)


def test_extract_json_handles_fences_prose_and_think_blocks():
    assert extract_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert extract_json('Sure! {"a": {"b": "x}y"}} trailing') == {"a": {"b": "x}y"}}
    assert extract_json("<think>{not json}</think>{\"ok\": true}") == {"ok": True}
    assert extract_json("no json here") is None
    assert extract_json("[1, 2]") is None


def test_near_duplicate():
    a = "SEC dismissed civil enforcement action against Coinbase on February 27, 2025"
    assert near_duplicate(a, a + " (undated report).")
    assert not near_duplicate(a, "Coinbase Q3 2026 earnings scheduled for October 29, 2026 after market close")


def test_html_to_text_drops_scripts_and_menus():
    title, text = html_to_text(
        "<html><title>Big News</title><script>var x=1</script><nav>Home | About</nav>"
        "<p>Coinbase reported third-quarter revenue of $1.2 billion on October 29, 2026.</p></html>"
    )
    assert title == "Big News"
    assert "revenue of $1.2 billion" in text and "var x" not in text and "Home | About" not in text


class FakeResp:
    def __init__(self, status: int, body: dict):
        self.status_code, self._body = status, body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(response=self)

    def json(self):
        return self._body


def test_chain_fails_over_and_cools_down_a_throttled_provider(monkeypatch):
    for k in ("NVIDIA_API_KEY", "GROQ_API_KEY"):
        monkeypatch.setenv(k, "x")
    calls: list[str] = []

    def post(url, **kw):
        calls.append(url)
        if "nvidia" in url:
            return FakeResp(429, {})
        return FakeResp(200, {"choices": [{"message": {"content": '{"thought": "ok"}'}}], "usage": {"total_tokens": 9}})

    t = [0.0]
    ch = Chain(hops=(Hop("nim", "m1", 60_000), Hop("groq", "m2", 60_000)), post=post, clock=lambda: t[0])
    assert ch.ask("s", "u") == ({"thought": "ok"}, "groq/m2")
    assert ch.ask("s", "u")[1] == "groq/m2"
    assert sum("nvidia" in c for c in calls) == 1  # cooling: not retried within the cooldown
    t[0] = 1_000
    ch.ask("s", "u")
    assert sum("nvidia" in c for c in calls) == 2


def test_chain_skips_hops_whose_prompt_cap_is_too_small(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "x")
    ch = Chain(hops=(Hop("groq", "small", 10),), post=lambda *a, **k: FakeResp(200, {}))
    assert ch.ask("s" * 400, "u") == (None, None)


class ScriptedChain(Chain):
    def __init__(self, replies):
        super().__init__(hops=())
        self.replies = list(replies)

    def ask(self, system, user, max_out=2500):
        self.tokens += 100
        return (self.replies.pop(0) if self.replies else None), "fake/model"


class FakeTools(Toolbox):
    def run(self, tool, args):
        self.calls += 1
        url = f"https://example.com/{args.get('query', 'x').replace(' ', '-')}"
        self._note(url, f"Title for {args.get('query')}", "2026-10-23", tool)
        if tool == "read_url":
            self.read_urls.add(args["url"])
        return {"results": [{"title": "t", "url": url}]}


def test_agent_loop_researches_then_finishes_and_code_checks_citations():
    replies = [
        {"thought": "start", "actions": [{"tool": "news_search", "args": {"query": "coin news"}}]},
        {"thought": "read", "notes": [{"claim": "Earnings on 2026-10-29", "source_url": "https://example.com/coin-news",
                                       "published": "2026-10-23", "stance": "NEUTRAL"}],
         "actions": [{"tool": "read_url", "args": {"url": "https://example.com/coin-news"}}]},
        {"thought": "done", "final": {
            "summary": "Coinbase reports on Oct 29.", "bull_case": "b", "bear_case": "c",
            "catalysts": [{"event": "Q3 earnings", "date": "2026-10-29", "source_url": "https://example.com/coin-news"}],
            "risks": ["miss"], "open_questions": [],
            "findings": [
                {"claim": "Earnings on 2026-10-29", "source_url": "https://example.com/coin-news", "published": "2026-10-23",
                 "stance": "NEUTRAL"},
                {"claim": "Invented fact", "source_url": "https://made-up.example/x", "published": None, "stance": "BULL"},
            ]}},
    ]
    run = Run(Task("COIN", "EQUITIES", "test"), ScriptedChain(replies), FakeTools(now=NOW), Limits(max_steps=10))
    final = run.go(NOW)
    d = build_dossier(run, final, 1, 2.0)
    assert run.stop_reason == "agent finished"
    claims = [f["claim"] for f in d["findings"]]
    assert "Invented fact" not in claims  # source no tool ever returned → dropped
    assert d["findings"][0]["verified"] is True  # the agent read that page
    assert d["catalysts"][0]["date"] == "2026-10-29"
    assert d["agent"]["tool_calls"] == 2 and d["agent"]["steps"] == 3


def test_budget_exhaustion_writes_the_dossier_from_the_notebook():
    step = {"thought": "more", "notes": [{"claim": "BTC ETF outflow $635M on 2026-10-24",
                                          "source_url": "https://example.com/btc", "stance": "BEAR"}],
            "actions": [{"tool": "web_search", "args": {"query": "btc"}}]}
    write_up = {"final": {"summary": "Outflows.", "findings": []}}
    run = Run(Task("BTC/USD", "CRYPTO", "t"), ScriptedChain([step, step, write_up]), FakeTools(now=NOW), Limits(max_steps=3))
    final = run.go(NOW)
    d = build_dossier(run, final, 1, 1.0)
    assert run.stop_reason == "budget → written from notebook"
    assert d["summary"] == "Outflows."
    assert d["findings"][0]["claim"].startswith("BTC ETF outflow")  # notes back-fill thin findings


def test_read_url_refuses_local_addresses():
    tb = Toolbox(now=NOW, http=lambda *a, **k: (_ for _ in ()).throw(AssertionError("no fetch")))
    assert "refused" in tb.run("read_url", {"url": "http://localhost:8787/admin"})["error"]
    assert "not an http" in tb.run("read_url", {"url": "file:///etc/passwd"})["error"]
