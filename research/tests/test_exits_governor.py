"""Exit scorecard, virtual monkey control, missed-move forensics (ADR-059, ADR-061)."""

from __future__ import annotations

import random

from cortex_research.governor.exits import (
    Plan,
    exit_scorecard,
    missed_moves,
    monkey_entries,
    monkey_exits,
    monkey_summary,
    post_exit_excursion,
)
from cortex_research.governor.metrics import Bar

H = 3_600_000
T0 = 1_761_000_000_000


def bars(prices, start=T0):
    return [Bar(start + i * H, p + 0.5, p - 0.5, p) for i, p in enumerate(prices)]


def test_post_exit_excursion_in_r():
    b = bars([100, 101, 104, 99], T0)
    assert post_exit_excursion(b, T0, 100, 2) == ((104.5 - 100) / 2, (98.5 - 100) / 2)
    assert post_exit_excursion([], T0, 100, 2) is None


def test_exit_scorecard_capture_giveback_left_and_saved():
    rows = [
        {"r": 1.0, "mfe_r": 2.0, "reason": "TARGET", "post": (1.5, -0.5)},
        {"r": -1.0, "mfe_r": 0.1, "reason": "STOP_BROKER", "post": (0.2, -2.0)},
    ]
    c = exit_scorecard(rows)
    assert c["n"] == 2 and c["capture"] == 0.5  # mfe 0.1 is too small to count toward capture
    assert c["giveback_r"] == round(((2 - 1) + (0.1 + 1)) / 2, 3)
    assert c["left_on_table_r"] == round((1.5 + 0.2) / 2, 3)
    assert c["saved_r"] == 2.0  # only non-target exits can "save"
    assert exit_scorecard([]) == {"n": 0}


def test_monkey_groups_use_the_same_geometry_on_the_same_bars():
    # a month of drifting-down bars, then a strong rally right after the real entry
    prior = [100 - 0.01 * i for i in range(30 * 24)]
    rally = [prior[-1] + i for i in range(1, 49)]
    b = bars(prior + rally, T0 - 30 * 24 * H)
    entry_ts = T0 - H
    p = Plan(entry_ts, prior[-1], 0.02, 0.04, 48)
    rng = random.Random(1)
    ents = monkey_entries(b, p, 20, rng)
    exs = monkey_exits(b, p, 20, rng)
    assert len(ents) == 20 and len(exs) == 20
    assert sum(ents) / len(ents) < 0.5  # random entries in a falling month don't make the target
    assert all(x > 0 for x in exs)  # every random exit after this entry is in profit
    s = monkey_summary([2.0], ents, exs)
    assert s["entry_edge_r"] > 1 and s["n_real"] == 1


def test_missed_moves_skip_symbols_the_funnel_saw():
    quiet = [100.0] * 20
    b = [Bar(T0 + i * 86_400_000, p + 1, p - 1, p) for i, p in enumerate(quiet + [110.0])]
    since = T0
    got = missed_moves({"NVDA": b, "AMD": b}, set(), since)
    day = got[0]["date"]
    assert [m["symbol"] for m in got] == ["NVDA", "AMD"] and got[0]["move_atr"] == 5.0
    seen = {("AMD", day)}
    assert [m["symbol"] for m in missed_moves({"NVDA": b, "AMD": b}, seen, since)] == ["NVDA"]
