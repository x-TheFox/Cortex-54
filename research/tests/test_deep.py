"""Deep-research harness (ADR-051): JSON extraction, chain failover, the agent loop, and the code-side citation checks."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import requests

from cortex_research.deep.agent import (
    DEPTHS,
    Limits,
    Run,
    Task,
    build_dossier,
    filing_flags,
    near_duplicate,
    query_from_headline,
    research,
    system_prompt,
)
from cortex_research.deep.job import parse_kill, resolve_arena
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
    """Replays agent replies in order; compaction and write-up calls get their own queues."""

    def __init__(self, replies, compact=None, writeups=None):
        super().__init__(hops=())
        self.replies = list(replies)
        self.compact_replies = list(compact or [])
        self.writeups = list(writeups or [])
        self.users: list[str] = []

    def ask(self, system, user, max_out=2500):
        self.tokens += 100
        self.users.append(user)
        if "compress a research notebook" in system:
            return (self.compact_replies.pop(0) if self.compact_replies else None), "fake/model"
        if "write the research dossier" in system:
            return (self.writeups.pop(0) if self.writeups else None), "fake/model"
        return (self.replies.pop(0) if self.replies else None), "fake/model"


class FakeTools(Toolbox):
    def run(self, tool, args):
        with self._lock:
            self.calls += 1
        url = f"https://example.com/{args.get('query', args.get('url', 'x')).replace(' ', '-').split('/')[-1]}"
        self._note(url, f"Title for {args.get('query')}", "2026-10-23", tool)
        if tool == "read_url":
            self._mark_read(args["url"])
        return {"results": [{"title": "t", "url": url}]}


SEED = 5  # market_snapshot, headlines, market news, asset news, company_news (equities, no catalyst)


def test_agent_loop_researches_then_finishes_and_code_checks_citations():
    replies = [
        {"thought": "start", "cruxes": [{"question": "Will Q3 beat?", "answer": None}],
         "actions": [{"tool": "news_search", "args": {"query": "coin news"}}]},
        {"thought": "read", "notes": [{"claim": "Earnings on 2026-10-29", "source_url": "https://example.com/coin-news",
                                       "published": "2026-10-23", "stance": "NEUTRAL", "scope": "ASSET"}],
         "actions": [{"tool": "read_url", "args": {"url": "https://example.com/coin-news"}}]},
        {"thought": "done", "cruxes": [{"question": "Will Q3 beat?", "answer": "Consensus EPS $1.10; unknown"}],
         "final": {
            "summary": "Coinbase reports on Oct 29.", "bull_case": "b", "bear_case": "c",
            "market_context": "Stocks near highs.",
            "catalyst_trace": {"first_reported": "2026-10-22", "original_source_url": "https://made-up.example/x",
                               "story": "Company press release, then wires."},
            "catalysts": [{"event": "Q3 earnings", "date": "2026-10-29", "source_url": "https://example.com/coin-news"}],
            "risks": ["miss"], "open_questions": [],
            "related": [{"symbol": "HOOD", "relation": "competitor"}, {"symbol": "coin", "relation": "peer"},
                        {"symbol": "not a ticker!", "relation": "x"}],
            "findings": [
                {"claim": "Earnings on 2026-10-29", "source_url": "https://example.com/coin-news", "published": "2026-10-23",
                 "stance": "NEUTRAL", "scope": "ASSET"},
                {"claim": "Invented fact", "source_url": "https://made-up.example/x", "published": None, "stance": "BULL"},
            ]}},
    ]
    run = Run(Task("COIN", "EQUITIES", "test"), ScriptedChain(replies), FakeTools(now=NOW),
              Limits(max_steps=10, contra_hunt=False))
    final = run.go(NOW)
    d = build_dossier(run, final, 1, 2.0, "fast", NOW)
    assert run.stop_reason == "agent finished"
    claims = [f["claim"] for f in d["findings"]]
    assert "Invented fact" not in claims  # source no tool ever returned → dropped
    assert d["findings"][0]["verified"] is True  # the agent read that page
    assert d["catalysts"][0]["date"] == "2026-10-29"
    assert d["agent"]["tool_calls"] == SEED + 2 and d["agent"]["steps"] == 3
    assert d["market_context"] == "Stocks near highs."
    assert d["catalyst_trace"]["original_source_url"] is None  # not a URL any tool returned
    assert d["catalyst_trace"]["first_reported"] == "2026-10-22"
    assert [r["symbol"] for r in d["related"]] == ["HOOD"]  # own symbol and junk dropped
    assert d["cruxes"] == [{"question": "Will Q3 beat?", "answer": "Consensus EPS $1.10; unknown"}]
    assert d["stage"] == "fast"


def test_seed_covers_market_catalyst_and_asset_before_the_first_model_step():
    ch = ScriptedChain([{"thought": "x", "final": {"summary": "s"}}])
    run = Run(Task("NVDA", "EQUITIES", "t", catalyst="Nvidia unveils new AI chip at GTC, shares jump 4%"), ch,
              FakeTools(now=NOW), Limits(max_steps=4, contra_hunt=False))
    acts = run.seed_actions()
    tools = [a["tool"] for a in acts]
    assert tools[:2] == ["market_snapshot", "headlines"]
    queries = [a["args"].get("query", "") for a in acts]
    assert any("stock market today" in q for q in queries)  # general market news
    assert any(q.startswith("Nvidia unveils AI chip GTC") for q in queries)  # the catalyst's own story
    assert "company_news" in tools
    run.go(NOW)
    assert "Latest tool results:\n### market_snapshot" in ch.users[0]  # the model starts from the seed


def test_more_than_three_tool_calls_per_step_run_in_parallel_up_to_eight():
    acts = [{"tool": "web_search", "args": {"query": f"q{i}"}} for i in range(11)]
    replies = [{"thought": "wide", "actions": acts}, {"thought": "done", "final": {"summary": "s"}}]

    class SlowTools(FakeTools):
        def run(self, tool, args):
            import time as _t
            _t.sleep(0.05)
            return super().run(tool, args)

    tools = SlowTools(now=NOW)
    run = Run(Task("BTC/USD", "CRYPTO", "t"), ScriptedChain(replies), tools,
              Limits(max_steps=5, contra_hunt=False, tool_workers=8))
    import time as _t
    t0 = _t.monotonic()
    run.go(NOW)
    took = _t.monotonic() - t0
    assert tools.calls == 4 + 8  # crypto seed has 4 calls; the step is capped at 8, not 3
    assert took < 0.05 * 12 * 0.6  # parallel, not sequential


def test_first_finish_is_held_back_for_a_contradiction_hunt():
    final1 = {"summary": "Looks bullish."}
    final2 = {"summary": "Bullish, but a short report exists."}
    replies = [
        {"thought": "done?", "final": final1},
        {"thought": "hunting", "notes": [{"claim": "Short seller report alleges inflated users on 2026-10-20",
                                          "source_url": "https://example.com/short", "scope": "CONTRA", "stance": "BEAR"}],
         "actions": [{"tool": "news_search", "args": {"query": "short report"}}]},
        {"thought": "done", "final": final2},
    ]
    ch = ScriptedChain(replies)
    run = Run(Task("COIN", "EQUITIES", "t"), ch, FakeTools(now=NOW), Limits(max_steps=10))
    assert run.go(NOW) == final2
    assert run.contra_done and "contradiction hunt" in ch.users[1]
    assert run.coverage()["CONTRA"] == 1


WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima",
         "mike", "november", "oscar", "papa", "quebec", "romeo", "sierra", "tango", "uniform", "victor", "whiskey",
         "xray", "yankee", "zulu", "amber", "basil", "cedar", "dune"]


def _notes(n, url="https://example.com/x"):
    return [{"claim": f"Fact {WORDS[i]} {WORDS[-1 - i]}: segment {WORDS[(i * 7) % 30]} grew {i * 3}% to ${i}.5B "
                      f"on 2026-10-{10 + i % 9}",
             "source_url": url, "published": "2026-10-20", "stance": "NEUTRAL", "scope": "ASSET"} for i in range(n)]


def test_compaction_keeps_only_digest_items_whose_urls_and_numbers_are_real():
    run = Run(Task("COIN", "EQUITIES", "t"), ScriptedChain([], compact=[{
        "digest": [
            {"claim": "Segments grew 3% to $1.5B on 2026-10-11", "source_urls": ["https://example.com/x"],
             "scope": "ASSET", "stance": "BULL"},
            {"claim": "Revenue grew 99% (invented number)", "source_urls": ["https://example.com/x"]},
            {"claim": "Segment grew 6% to $2.5B", "source_urls": ["https://invented.example/y"]},
            {"claim": "Segments grew 9% to $3.5B on 2026-10-13", "source_urls": ["https://example.com/x"]},
            {"claim": "Segments grew 12% to $4.5B on 2026-10-14", "source_urls": ["https://example.com/x"]},
        ],
        "history": "Searched earnings and read two articles."}]), FakeTools(now=NOW), Limits())
    run._add_notes(_notes(12))
    run.history = [f"{i}. web_search" for i in range(9)]
    run.compact()
    claims = [d["claim"] for d in run.digest]
    assert "Revenue grew 99% (invented number)" not in claims  # 99 appears in no note
    assert not any("$2.5B" in c for c in claims)  # invented source
    assert len(run.digest) == 3 and run.view_from == 12 and len(run.notes) == 12  # full notes kept for the dossier
    assert run.history == [] and run.history_digest.startswith("Searched")
    assert run.compactions == 1


def test_compaction_falls_back_to_trimming_when_the_model_fails():
    run = Run(Task("COIN", "EQUITIES", "t"), ScriptedChain([]), FakeTools(now=NOW), Limits())
    run._add_notes(_notes(30))
    run.compact()
    assert run.compaction_fallbacks == 1 and 0 < len(run.digest) <= 15
    assert all(len(d["claim"]) <= 160 for d in run.digest)


def test_long_runs_compact_automatically_and_keep_going():
    notes = _notes(30)
    step = lambda i: {"thought": "more", "notes": notes[2 * i: 2 * i + 2],  # noqa: E731
                      "actions": [{"tool": "web_search", "args": {"query": f"q {WORDS[i]}"}}]}
    replies = [step(i) for i in range(14)] + [{"thought": "done", "final": {"summary": "s"}}]
    ch = ScriptedChain(replies)
    run = Run(Task("COIN", "EQUITIES", "t"), ch, FakeTools(now=NOW),
              Limits(max_steps=30, contra_hunt=False, context_tokens=3_000))
    assert run.go(NOW) == {"summary": "s"}
    assert run.compactions >= 1 and len(run.notes) == 28  # nothing lost from the notes behind the digest


def test_budget_exhaustion_writes_the_dossier_from_the_notebook():
    step = {"thought": "more", "notes": [{"claim": "BTC ETF outflow $635M on 2026-10-24",
                                          "source_url": "https://example.com/btc", "stance": "BEAR"}],
            "actions": [{"tool": "web_search", "args": {"query": "btc"}}]}
    write_up = {"final": {"summary": "Outflows.", "findings": []}}
    run = Run(Task("BTC/USD", "CRYPTO", "t"), ScriptedChain([step, step], writeups=[write_up]), FakeTools(now=NOW),
              Limits(max_steps=2))
    final = run.go(NOW)
    d = build_dossier(run, final, 1, 1.0, "fast", NOW)
    assert run.stop_reason == "budget → written from notebook"
    assert d["summary"] == "Outflows."
    assert d["findings"][0]["claim"].startswith("BTC ETF outflow")  # notes back-fill thin findings


def test_fast_dossier_is_handed_over_then_the_deep_ring_replaces_it():
    replies = [
        {"thought": "a", "notes": [{"claim": "ETH unlock on 2026-11-02", "source_url": "https://example.com/eth"}],
         "actions": [{"tool": "news_search", "args": {"query": "eth"}}]},
        {"thought": "fast done", "final": {"summary": "Fast picture."}},
        {"thought": "deeper", "notes": [{"claim": "Foundation sold 10,000 ETH on 2026-10-21",
                                         "source_url": "https://example.com/eth2", "stance": "BEAR"}],
         "actions": [{"tool": "news_search", "args": {"query": "eth2"}}]},
        {"thought": "deep done", "final": {"summary": "Deep picture."}},
    ]
    got = []
    clock = [0.0]
    d = research(Task("ETH/USD", "CRYPTO", "t"), NOW, 5, chain=ScriptedChain(replies), tools=FakeTools(now=NOW),
                 limits=Limits(max_steps=6, deep_steps=6, deep_wall_s=600, contra_hunt=False),
                 on_fast=got.append, clock=lambda: clock[0])
    assert [g["stage"] for g in got] == ["fast"] and got[0]["summary"] == "Fast picture."
    assert d["stage"] == "deep" and d["summary"] == "Deep picture."
    assert d["agent"]["steps"] == 4 and got[0]["agent"]["steps"] == 2


def test_watch_mode_reports_the_thesis_status():
    replies = [{"thought": "checked", "final": {"summary": "Kill criterion fired: price closed below $90k.",
                                                "thesis_status": "BROKEN", "thesis_reason": "Support lost."}}]
    task = Task("BTC/USD", "CRYPTO", "Bought on ETF inflows.", mode="watch", kill_criteria=["daily close below $90k"])
    d = research(task, NOW, 5, chain=ScriptedChain(replies), tools=FakeTools(now=NOW), limits=DEPTHS["watch"])
    assert d["thesis"] == {"status": "BROKEN", "reason": "Support lost."} and d["stage"] == "watch"
    assert "daily close below $90k" in system_prompt(task, NOW, [], 8)


def test_filing_flags_mark_recent_dilution_and_8ks():
    flags = filing_flags([{"form": "424B5", "date": "2026-10-20"}, {"form": "S-3", "date": "2026-08-01"},
                          {"form": "8-K", "date": "2026-10-23"}, {"form": "10-Q", "date": "2026-10-23"}], NOW)
    assert flags == ["dilution_filing:424B5:2026-10-20", "recent_8k:2026-10-23"]


def test_query_from_headline_and_arena_resolution(tmp_path):
    assert query_from_headline("Nvidia to buy Arm for $40B, says the WSJ") == "Nvidia buy Arm $40B WSJ"
    doc = tmp_path / "d.yaml"
    doc.write_text("watchlists:\n  crypto: [BTC/USD]\n  equities_core: [SPY]\n")
    assert resolve_arena(doc, "PLTR", "EQUITIES") == "EQUITIES"  # scout-ported symbol, arena from the dispatch
    assert resolve_arena(doc, "PLTR", "CRYPTO") is None  # shape and arena disagree, not in watchlists
    assert resolve_arena(doc, "BTC/USD", "") == "CRYPTO"
    assert parse_kill("close < 90k | ETF outflows > $1B||") == ["close < 90k", "ETF outflows > $1B"]


def test_read_url_refuses_local_addresses():
    tb = Toolbox(now=NOW, http=lambda *a, **k: (_ for _ in ()).throw(AssertionError("no fetch")))
    assert "refused" in tb.run("read_url", {"url": "http://localhost:8787/admin"})["error"]
    assert "not an http" in tb.run("read_url", {"url": "file:///etc/passwd"})["error"]


def test_near_duplicate_catches_a_restated_fact_with_extra_detail():
    short = "Ethereum staking hit record 43.8M ETH (35.9% of supply) in Q3 2026, yield fell to 2.63%"
    long_ = short + " from 2.81% in Q2; net inflow 7.96M ETH in first 9 months of 2026 (6x YoY)"
    assert near_duplicate(short, long_)


def test_write_up_accepts_a_bare_dossier_reply():
    step = {"thought": "x", "notes": [{"claim": "Devcon 8 runs Nov 3-6, 2026", "source_url": "https://example.com/d"}],
            "actions": [{"tool": "web_search", "args": {"query": "d"}}]}
    bare = {"summary": "Devcon next week.", "bull_case": "b", "findings": []}
    run = Run(Task("ETH/USD", "CRYPTO", "t"), ScriptedChain([step, {"oops": 1}], writeups=[bare]),
              FakeTools(now=NOW), Limits(max_steps=2))
    final = run.go(NOW)
    assert final == bare and run.stop_reason == "budget → written from notebook"


def test_dossier_job_marks_the_early_fast_ring_partial_and_the_final_dossier_complete(monkeypatch):
    """Operator 2026-10-26: the court waits for the deep dossier; only a complete dossier releases it."""
    from cortex_research.deep import job

    def fake_research(task, now, now_ms, limits=None, on_fast=None, now_ms_fn=None):
        base = {"symbol": task.symbol, "as_of": now_ms, "findings": [{"claim": "x"}], "summary": "s",
                "agent": {"stop_reason": "done"}}
        if on_fast:
            on_fast({**base, "stage": "fast"})
        return {**base, "stage": "deep"}

    posted = []
    monkeypatch.setattr(job, "research", fake_research)
    monkeypatch.setattr(job, "resolve_arena", lambda *a, **k: "CRYPTO")
    final = job.dossier_job(Path("x"), "BTC/USD", "ctx", 1_000, None, post=lambda b: posted.append(b) or True)
    assert posted[0]["items"][0]["payload"]["complete"] is False
    assert final["items"][0]["payload"]["complete"] is True


def test_research_desk_uses_the_users_model_pool(monkeypatch):
    """ADR-072: a user with only their own endpoints still has a research desk; order follows their preference."""
    import json as _json

    from cortex_research.deep import llm as L

    pool = {"endpoints": [
        {"id": "box", "name": "Box", "format": "openai", "url": "http://127.0.0.1:8799/v1", "key": "", "models": ["qwen3"],
         "tier": "local", "enabled": True},
        {"id": "claude", "name": "Claude", "format": "anthropic", "url": "https://api.anthropic.com", "key": "sk-ant-x",
         "models": ["claude-opus-5-5"], "tier": "paid", "enabled": True},
        {"id": "off", "name": "Off", "format": "openai", "url": "https://x.example/v1", "models": ["m"], "enabled": False},
    ], "prefs": {"prefer": "paid_first"}}
    for k in ("GEMINI_API_KEY", "GROQ_API_KEY", "NVIDIA_API_KEY", "OPENROUTER_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("LLM_POOL", _json.dumps(pool))
    hops = L.default_chain()
    assert hops[0].provider == "ep:claude" and hops[-1].provider == "ep:box"
    assert [h.provider for h in L.Chain().available()] == ["ep:claude", "ep:box"]  # no free keys, no disabled endpoint
    assert L.pool_hops("not json") == ((), (), "free_first")

    sent = []

    class R:
        def __init__(self, code, body):
            self.status_code, self._b = code, body

        def json(self):
            return self._b

        def raise_for_status(self):
            if self.status_code >= 400:
                raise requests.HTTPError(response=self)

    def post(url, headers=None, json=None, timeout=None):
        sent.append((url, dict(json)))
        if "response_format" in json:
            return R(400, {})  # a server that rejects JSON mode
        return R(200, {"choices": [{"message": {"content": '{"ok": true}'}}], "usage": {"total_tokens": 7}})

    box = L.Chain(hops=(hops[-1],), post=post)
    obj, name = box.ask("sys", "user")
    assert obj == {"ok": True} and name == "ep:box/qwen3"
    assert sent[0][0] == "http://127.0.0.1:8799/v1/chat/completions"
    assert "max_completion_tokens" in sent[1][1] and "response_format" not in sent[1][1]


def test_public_host_checks_resolved_addresses():
    from cortex_research.deep.tools import public_host

    def fake(ip):
        return lambda h, p: [(2, 1, 6, "", (ip, 0))]

    assert public_host("example.com", fake("93.184.216.34"))
    assert not public_host("evil.example", fake("10.0.0.5"))
    assert not public_host("evil.example", fake("169.254.169.254"))
    assert not public_host("evil.example", fake("127.0.0.1"))
    assert not public_host("[::1]", fake("::1"))
