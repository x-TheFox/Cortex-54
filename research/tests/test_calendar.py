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
