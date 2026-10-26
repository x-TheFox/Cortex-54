from datetime import date

from cortex_research.calendar import merge, weekdays


def test_weekdays_skip_weekends():
    assert [d.isoformat() for d in weekdays(date(2026, 10, 23), 4)] == ["2026-10-23", "2026-10-26"]


def test_merge_filters_dedupes_and_sorts():
    ev = [{"symbol": "aapl", "date": "2026-11-02"}, {"symbol": "AAPL", "date": "2026-11-02T00:00"},
          {"symbol": "FUBO", "date": "2026-11-02"}, {"symbol": "NVDA", "date": "2026-10-29"}, {"symbol": "MSFT", "date": None}]
    assert merge(ev, {"AAPL", "NVDA", "MSFT"}) == [{"symbol": "NVDA", "date": "2026-10-29"}, {"symbol": "AAPL", "date": "2026-11-02"}]


def test_screener_candidates_filter_and_map_symbols():
    from cortex_research.screeners import candidates, to_key

    rep = {"candidates": [
        {"symbol": "SOLUSD", "setup_score": 81, "state": "ACTIONABLE_DAY1", "date": "2026-10-22", "trigger_tags": ["four_pct"], "day_gain_pct": 5.1, "volume_ratio_20d": 2.2, "entry_reference": 100, "stop_reference": 95},
        {"symbol": "AAPL", "setup_score": 60, "state": "WATCH_ONLY", "date": "2026-10-22"},
        {"symbol": "NVDA", "setup_score": 90, "state": "REJECTED", "date": "2026-10-22"},
    ]}
    out = candidates("stockbee-momentum-burst-screener", rep, {to_key("SOL/USD"): "SOL/USD", "AAPL": "AAPL", "NVDA": "NVDA"}, 1)
    assert [c["symbol"] for c in out] == ["SOL/USD"] and out[0]["score"] == 81 and "momentum burst" in out[0]["headline"]


def test_merge_covers_every_us_ticker_inside_the_blackout_window():
    ev = [{"symbol": "PLTR", "date": "2026-10-28"}, {"symbol": "PLTR", "date": "2026-11-05"},
          {"symbol": "9434", "date": "2026-10-28"}, {"symbol": "BRK.B", "date": "2026-10-27"},
          {"symbol": "AAPL", "date": "2026-11-05"}]
    got = merge(ev, {"AAPL"}, all_until="2026-10-30")
    assert got == [{"symbol": "BRK.B", "date": "2026-10-27"}, {"symbol": "PLTR", "date": "2026-10-28"},
                   {"symbol": "AAPL", "date": "2026-11-05"}]  # far-off non-watch rows and foreign codes dropped


def test_calendar_claims_full_coverage_only_when_nasdaq_answered_every_day(monkeypatch):
    from cortex_research import calendar as C

    class R:
        def __init__(self, rows):
            self.rows = rows

        def raise_for_status(self):
            pass

        def json(self):
            return {"data": {"rows": self.rows}}

    calls = []

    def get(url, params=None, **kw):
        calls.append(params["date"])
        if len(calls) == 3:
            raise C.requests.ConnectionError("blip")
        return R([{"symbol": "PLTR"}])

    monkeypatch.setattr(C.requests, "get", get)
    monkeypatch.delenv("FMP_API_KEY", raising=False)
    out = C.earnings_calendar(set(), date(2026, 10, 26), 8)
    assert out["coverage"] == "watchlist"  # one day missing → hot-ported stocks stay uncovered (fail closed)
    calls.clear()
    monkeypatch.setattr(C.requests, "get", lambda url, params=None, **kw: R([{"symbol": "PLTR"}]))
    assert C.earnings_calendar(set(), date(2026, 10, 26), 8)["coverage"] == "all"
