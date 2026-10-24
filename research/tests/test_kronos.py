from pathlib import Path

import numpy as np

from cortex_research import kronos_forecast as K

REPO = Path(__file__).resolve().parents[2]


def test_summarize_first_touch_and_pessimistic_ties():
    last, stop, target = 100.0, 97.0, 104.0
    highs = np.array([[101, 105, 101], [101, 102, 102], [105, 101, 101], [101, 101, 101]], dtype=float)
    lows = np.array([[99, 99, 99], [96, 99, 99], [96, 99, 99], [99, 99, 99]], dtype=float)
    closes = np.array([[100, 104, 104], [97, 99, 99], [100, 100, 100], [100, 100, 101]], dtype=float)
    s = K.summarize(highs, lows, closes, last, stop, target)
    # path 0 target first; path 1 stop; path 2 touches both in candle 0 → stop (pessimistic); path 3 neither, ends up
    assert s["p_target_first"] == 0.25 and s["p_stop_first"] == 0.5
    assert s["p_win"] == 0.5 and s["paths"] == 4


def test_vol_scale_widens_tight_samples_and_never_narrows():
    rng = np.random.default_rng(1)
    hist = 100 * np.exp(np.cumsum(rng.normal(0, 0.02, 400)))
    tight = 100 * (1 + rng.normal(0, 0.002, 24))
    k = K.vol_scale(hist, tight, 100.0, 12)
    assert 5 < k <= 10
    wide = 100 * (1 + rng.normal(0, 0.5, 24))
    assert K.vol_scale(hist, wide, 100.0, 12) == 1.0
    assert np.allclose(K.rescale(np.array([101.0, 99.0]), 100.0, 3.0), [103.0, 97.0])


def test_atr_matches_typescript_wilder():
    h = np.full(30, 101.0)
    lo = np.full(30, 99.0)
    c = np.full(30, 100.0)
    assert abs(K.atr(h, lo, c) - 2.0) < 1e-12 and K.atr(h[:5], lo[:5], c[:5]) is None


def test_job_reads_its_levels_from_the_doctrine():
    s = K.strategy(REPO / "config" / "doctrine.yaml")
    p = s["params"]
    assert s["arena"] == "CRYPTO" and p["horizon_hours"] % p["candle_hours"] == 0
    assert p["lookback_hours"] // p["candle_hours"] <= K.MAX_CONTEXT


def test_fan_chart_bands_are_ordered_and_sized():
    rng = np.random.default_rng(3)
    paths = 100 * (1 + np.cumsum(rng.normal(0, 0.01, (24, 12)), axis=1))
    out = K.fan_chart([{"c": 100.0 + i} for i in range(60)], paths)
    assert len(out["hist"]) == 42 and out["hist"][-1] == 159.0
    f = out["fan"]
    assert len(f["p10"]) == len(f["p50"]) == len(f["p90"]) == 12
    assert all(a <= b <= c for a, b, c in zip(f["p10"], f["p50"], f["p90"]))


def test_equity_universe_reads_every_stock_watchlist_once(tmp_path):
    from cortex_research.kronos_forecast import equity_universe

    d = tmp_path / "doctrine.yaml"
    d.write_text("watchlists:\n  crypto: [BTC/USD]\n  crypto_proxies: [COIN, MSTR]\n  equities_core: [SPY]\n"
                 "  equities_catalyst: [NVDA, COIN]\n")
    assert equity_universe(d) == ["COIN", "MSTR", "SPY", "NVDA"]


def test_doctrine_stock_forecast_params_fit_the_kronos_context():
    import yaml
    from pathlib import Path

    doc = yaml.safe_load((Path(__file__).resolve().parents[2] / "config" / "doctrine.yaml").read_text())
    p = next(s for s in doc["strategies"] if s["id"] == "CRYPTO_KRONOS_FORECAST_V1")["params"]
    assert 120 <= p["equity_lookback_days"] <= 512 and 1 <= p["equity_horizon_days"] <= 10
