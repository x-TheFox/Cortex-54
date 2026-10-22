import math
from datetime import date, timedelta

from cortex_research.options import bs
from cortex_research.options import structures as S
from cortex_research.options.lab import macd, open_trades, rsi, sma

TODAY = date(2026, 10, 22)


def test_black_scholes_parity_delta_and_iv_roundtrip():
    S0, K, T, r, v = 100.0, 95.0, 0.25, 0.04, 0.3
    c, p = bs.price(S0, K, T, r, v, "call"), bs.price(S0, K, T, r, v, "put")
    assert abs((c - p) - (S0 - K * math.exp(-r * T))) < 1e-9  # put-call parity
    assert abs(c - 9.2500) < 1e-3  # d1 0.4836, d2 0.3336 → 100·N(d1) − 95·e^(−0.01)·N(d2)
    assert 0 < bs.delta(S0, K, T, r, v, "call") < 1 and -1 < bs.delta(S0, K, T, r, v, "put") < 0
    assert abs(bs.implied_vol(c, S0, K, T, r, "call") - v) < 1e-5
    assert bs.implied_vol(0.5, S0, 80, T, r, "call") is None  # below intrinsic


def test_parse_occ_and_snapshot():
    assert S.parse_occ("SPY261106P00510000") == ("SPY", date(2026, 11, 6), "put", 510.0)
    assert S.parse_occ("bad") is None
    q = S.quote_from_snapshot("SPY261106P00510000", {"latestQuote": {"bp": 1.0, "ap": 1.2}, "greeks": {"delta": -0.2}, "impliedVolatility": 0.2})
    assert q.delta == -0.2 and abs(q.mid - 1.1) < 1e-12 and round(q.spread_pct, 1) == 18.2
    # missing greeks → our own Black-Scholes fills delta
    q2 = S.quote_from_snapshot("SPY261106P00510000", {"latestQuote": {"bp": 1.0, "ap": 1.2}}, spot=520, today=TODAY)
    assert q2.delta is not None and -1 < q2.delta < 0


def _q(kind, k, days, bid, ask, d, iv=0.3, oi=500, vol=100):
    exp = TODAY + timedelta(days=days)
    sym = f"XYZ{exp:%y%m%d}{'C' if kind == 'call' else 'P'}{int(k * 1000):08d}"
    return S.Quote(sym, kind, k, exp, bid, ask, d, iv, vol, oi)


P_PUT = {"dte": [21, 45], "short_delta": [0.2, 0.3], "width_pct": 0.05, "min_credit_to_width": 0.18}
P_DEBIT = {"dte": [30, 60], "long_delta": [0.5, 0.62], "width_pct": 0.05, "max_debit_to_width": 0.6}


def test_bull_put_spread_prices_naturally_and_sizes_risk():
    puts = [_q("put", 95, 30, 2.0, 2.1, -0.25), _q("put", 90, 30, 0.9, 1.0, -0.12), _q("put", 85, 30, 0.3, 0.35, -0.05)]
    plan = S.bull_put_spread("OPTIONS_BULL_PUT_SPREAD_V1", "XYZ", 100, puts, TODAY, P_PUT)
    assert not isinstance(plan, str)
    assert [(l.side, l.strike) for l in plan.legs] == [("short", 95), ("long", 90)]
    assert abs(plan.entry_cash - 1.0) < 1e-9  # 2.0 bid − 1.0 ask
    assert plan.max_loss_cents == 40000 + S.fees_cents(2)
    thin = [_q("put", 95, 30, 1.2, 1.3, -0.25), _q("put", 90, 30, 0.9, 1.0, -0.12)]
    assert isinstance(S.bull_put_spread("X", "XYZ", 100, thin, TODAY, P_PUT), str)


def test_bull_call_debit_rejects_expensive_spreads():
    calls = [_q("call", 100, 40, 4.0, 4.2, 0.55), _q("call", 105, 40, 1.8, 1.9, 0.35)]
    plan = S.bull_call_debit("OPTIONS_BULL_CALL_DEBIT_V1", "XYZ", 100, calls, TODAY, P_DEBIT)
    assert not isinstance(plan, str) and abs(plan.entry_cash + 2.4) < 1e-9  # 4.2 ask − 1.8 bid
    pricey = [_q("call", 100, 40, 4.0, 4.2, 0.55), _q("call", 105, 40, 0.9, 1.0, 0.35)]
    assert isinstance(S.bull_call_debit("X", "XYZ", 100, pricey, TODAY, P_DEBIT), str)


def test_pmcc_rubric_and_plan():
    assert S.pmcc_base_score(0.80, 0.20, 200, 600, 3, 5, 0.3, 60) == 11.0
    assert S.trend_score(10, 9, 60, 1, 0) == 2.0 and S.trend_score(8, 9, 40, 0, 1) == -2.0
    assert S.weekly_score([TODAY + timedelta(days=7), TODAY + timedelta(days=14)], TODAY) == 0.0
    assert S.weekly_score([TODAY + timedelta(days=30)], TODAY) == -1.0
    leaps = [_q("call", 80, 300, 24.0, 24.6, 0.80, 0.3, 300)]
    calls = [_q("call", k, d, b, b + 0.05, dl, 0.3, 800) for d in (7, 14) for k, b, dl in ((101, 1.2, 0.4), (102, 0.9, 0.33), (103, 0.8, 0.25), (104, 0.7, 0.2), (105, 0.6, 0.15))]
    p = {"leaps_min_dte": 270, "leaps_delta": 0.8, "short_dte": [7, 21], "short_delta": 0.2, "min_rubric_score": 7}
    plan = S.pmcc("OPTIONS_PMCC_V1", "XYZ", 100, calls, leaps, TODAY, p, 2.0)
    assert not isinstance(plan, str), plan
    assert plan.structure == "diagonal" and plan.legs[0].strike == 80 and plan.legs[1].strike == 104
    assert isinstance(S.pmcc("X", "XYZ", 100, calls, leaps, TODAY, {**p, "min_rubric_score": 99}, 2.0), str)


def _trade(structure, cash, legs, max_loss=10_000):
    return {"trade_id": "t", "strategy": "S", "structure": structure, "underlying": "XYZ", "cash": cash,
            "legs": legs, "max_loss_cents": max_loss, "max_profit_cents": None, "sizer_permits_live": False}


def test_exits_take_profit_stop_time_and_expiry():
    exp = (TODAY + timedelta(days=20)).isoformat()
    legs = [{"symbol": "S1", "side": "short", "kind": "put", "strike": 95, "expiry": exp},
            {"symbol": "L1", "side": "long", "kind": "put", "strike": 90, "expiry": exp}]
    t = _trade("vertical_credit", 1.0, legs, 40_020)
    p = {"take_profit_pct": 0.5, "stop_multiple": 2.0, "exit_dte": 7}
    qs = lambda s_ask, l_bid: {"S1": S.Quote("S1", "put", 95, TODAY, s_ask - 0.05, s_ask), "L1": S.Quote("L1", "put", 90, TODAY, l_bid, l_bid + 0.05)}
    assert S.exit_decision(t, p, qs(0.5, 0.1), 100, TODAY)[0] == "TARGET"  # cost 0.40 ≤ 0.50
    assert S.exit_decision(t, p, qs(2.6, 0.5), 100, TODAY)[0] == "STOP"  # cost 2.10 ≥ 2.0
    assert S.exit_decision(t, p, qs(1.2, 0.4), 100, TODAY) is None
    assert S.exit_decision(t, p, qs(1.2, 0.4), 100, TODAY + timedelta(days=14))[0] == "TIME"
    assert S.exit_decision(t, p, {}, 100, TODAY) is None  # no quotes, not expired → hold
    reason, cc, settled = S.exit_decision(t, p, {}, 92, TODAY + timedelta(days=21))
    assert reason == "EXPIRY" and settled and abs(cc - (-3.0)) < 1e-9  # short 95 put worth 3, long 90 worthless
    ev = S.close_event(t, reason, cc, settled, 1)
    assert ev["pnl_cents"] == round((1.0 - 3.0) * 100 * 100) - S.fees_cents(2, 1)
    assert abs(ev["r"] - ev["pnl_cents"] / 40_020) < 1e-4


def test_indicators_and_ledger():
    xs = [float(i) for i in range(1, 61)]
    assert sma(xs, 50) == sum(xs[-50:]) / 50 and sma(xs[:10], 50) is None
    assert rsi(xs) == 100.0 and rsi(xs[:5]) is None
    m, s = macd(xs)
    assert m is not None and m > 0 and macd(xs[:20]) == (None, None)
    ev = [{"trade_id": "a", "kind": "OPEN", "legs_json": "[]", "sizer_permits_live": 0},
          {"trade_id": "b", "kind": "OPEN", "legs_json": "[]", "sizer_permits_live": 0},
          {"trade_id": "a", "kind": "CLOSE"}]
    assert [t["trade_id"] for t in open_trades(ev)] == ["b"]
