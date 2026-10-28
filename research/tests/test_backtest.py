from cortex_research import backtest as B


def bar(t, o, h, l, c):  # noqa: E741
    return B.Bar(t, o, h, l, c)


def test_simulate_is_pessimistic_on_same_bar_touches_and_charges_fees():
    bars = [bar("2026-01-01", 100, 101, 99, 100), bar("2026-01-02", 100, 106, 95, 100)]
    r, j = B.simulate(bars, 0, B.Plan(100, 96, 105, 5), "EQUITIES")
    assert j == 1 and r < -1  # touched both: counted as the stop, minus fees
    up = [bar("2026-01-01", 100, 101, 99, 100), bar("2026-01-02", 101, 106, 100, 105)]
    r2, _ = B.simulate(up, 0, B.Plan(100, 96, 105, 5), "EQUITIES")
    assert 1.2 < r2 < 1.25  # +5 on 4 risk, minus 0.05% per side


def test_turn_of_month_enters_on_the_second_to_last_day():
    bars = [bar(f"2026-01-{d:02d}", 100, 101, 99, 100) for d in range(1, 32)] + [
        bar(f"2026-02-{d:02d}", 100, 101, 99, 100) for d in range(1, 6)
    ]
    entries = B.replay_tom(bars, {"last_days": 2, "exit_day": 3, "atr_stop_multiple": 2, "atr_target_multiple": 3})
    assert [bars[i].t for i, _ in entries] == ["2026-01-30"]
    assert entries[0][1].max_hold_days == 4  # Jan 30 → Feb 3


def test_verdict_needs_edge_significance_and_a_good_latest_third():
    assert B.verdict({"n": 5}) == "TOO FEW TRADES"
    assert B.verdict({"n": 50, "expectancy_r": -0.1}) == "LOSES"
    good = {"n": 50, "expectancy_r": 0.2, "q_value": 0.01, "last_third_r": 0.1, "dsr": 0.97}
    assert B.verdict(good) == "PASS"
    assert B.verdict({**good, "dsr": None}) == "UNPROVEN"  # audit F-B1-04: no DSR, no pass
    assert B.verdict(good, pbo=0.7) == "UNPROVEN"  # the lab looks overfit
    assert "survivorship" in B.SURVIVORSHIP_NOTE
    assert B.verdict({"n": 50, "expectancy_r": 0.2, "q_value": 0.01, "last_third_r": -0.1}) == "UNPROVEN"


def test_indicators_match_the_typescript_versions():
    assert abs(B.ema([5.0] * 30, 20) - 5) < 1e-12 and B.sma([1.0, 2.0, 3.0], 2) == 2.5
    flat = [bar("d", 100, 101, 99, 100)] * 30
    assert abs(B.atr(flat) - 2) < 1e-12 and B.rsi([1.0, 2.0, 3.0, 4.0], 2) == 100.0
