from cortex_research.governor import metrics as M
from cortex_research.governor.run import build_trades, calibration_pairs, gate_status


def test_hypothetical_shapes():
    assert M.hypothetical({"entry": 100, "stop": 96, "targets": [110]}) == M.Hypo(100, 96, 110)
    assert M.hypothetical({"entry_low": 99, "entry_high": 101, "stop": 95, "targets": [108]}) == M.Hypo(100, 95, 108)
    assert M.hypothetical({"bid": 100, "atr": 2}) == M.Hypo(100, 96, 106)
    assert M.hypothetical({}) is None and M.hypothetical({"entry": 100, "stop": 101, "targets": [110]}) is None


def test_grade_path_first_touch_and_conservative_tie():
    h = M.Hypo(100, 96, 106)
    bars = [M.Bar(1, 101, 99, 100), M.Bar(2, 107, 98, 105), M.Bar(3, 108, 95, 100)]
    assert M.grade_path(bars, h, 0, 10) == ("TARGET", 1.5)
    tie = [M.Bar(1, 107, 95, 100)]
    assert M.grade_path(tie, h, 0, 10) == ("STOP", -1.0)
    assert M.grade_path([M.Bar(1, 102, 99, 102)], h, 0, 10) == ("NEITHER", 0.5)
    assert M.grade_path([], h, 0, 10) == ("NEITHER", None)


def test_classify_brier_reliability():
    assert M.classify("TARGET", 1.2) == "GOOD_PROCESS_GOOD_OUTCOME"
    assert M.classify("STOP_BROKER", -1) == "GOOD_PROCESS_BAD_LUCK"
    assert M.classify("FLATTEN: operator", 0.4) == "BAD_PROCESS_BAILOUT_LUCK"
    assert M.brier([(0.8, 1), (0.2, 0)]) == 0.04 * 1 or abs(M.brier([(0.8, 1), (0.2, 0)]) - 0.04) < 1e-12
    rel = M.reliability([(0.1, 0), (0.15, 0), (0.9, 1)])
    assert rel[0]["n"] == 2 and rel[-1]["hit_rate"] == 1.0


def test_isotonic_is_monotone_and_spans_0_1():
    pairs = [(0.1, 0), (0.2, 1), (0.3, 0), (0.6, 1), (0.7, 0), (0.9, 1)]
    pts = M.isotonic(pairs)
    xs = [x for x, _ in pts]
    ys = [y for _, y in pts]
    assert xs[0] == 0.0 and xs[-1] == 1.0
    assert all(b > a for a, b in zip(xs, xs[1:]))
    assert all(b >= a for a, b in zip(ys, ys[1:]))


def test_bootstrap_and_bh():
    s = M.strategy_stats([1, -1, 2, -1, 1.5, -1, 2, 1])
    assert s["n"] == 8 and s["expectancy_r"] > 0 and s["profit_factor"] > 1 and 0 <= s["p_value"] <= 1
    assert M.max_drawdown_r([1, -1, -1, 2]) == 2
    adj = M.bh_fdr({"a": 0.01, "b": 0.04, "c": None})
    assert adj["c"] is None and adj["a"] <= adj["b"] and adj["b"] == 0.04


def _j(seq, kind, account="PAPER", ref=None, payload="{}", ts=0):
    return {"seq": seq, "kind": kind, "account": account, "ref_id": ref, "payload_json": payload, "ts": ts}


def test_build_trades_and_pairs_and_gate():
    cid = "01928f4e-7b2a-7c3d-8e4f-5a6b7c8d9e0f"
    contracts = {
        cid: {
            "contract_id": cid, "strategy_id": "CRYPTO_CATALYST_COURT_V1", "origin": "COURT", "symbol": "BTC/USD",
            "invalidation_criteria": '{"stop_price":"96"}', "entry_plan": '{"zone_low":"99","zone_high":"101","targets":["108"]}',
            "clef_probabilities": '{"raw":{"win_prob":0.7},"calibrated_win_prob":0.56}',
        }
    }
    journal = [
        _j(1, "BOOT", "SYSTEM", ts=0),
        _j(2, "FILL", ref="c54-P-7c8d9e0f-E-1", payload='{"qty":0.5,"price":100,"role":"ENTRY"}', ts=1),
        _j(3, "EXIT", ref=cid, payload='{"symbol":"BTC/USD","reason":"TARGET","pnl_cents":400}', ts=2),
        _j(4, "DAY_ROLL", "SYSTEM", payload='{"max_gap_s":330}', ts=3),
    ]
    trades = build_trades(journal, contracts)
    assert trades == [{**trades[0], "r": 2.0, "reason": "TARGET", "origin": "COURT", "win_prob_raw": 0.7}]
    rej = [{"id": 5, "contract_id": cid, "stage": "VALIDATOR", "symbol": "BTC/USD", "ts": 0, "hypothetical": "{}", "reason_codes": "[]"}]
    pairs = calibration_pairs(trades, rej, [{"rejection_id": 5, "horizon": "72h", "hit": "STOP"}], contracts)
    assert pairs == [(0.7, 1), (0.7, 0)]
    gate = {g["criterion"]: g for g in gate_status(journal, trades, rej, 0.2, 2, 31 * 86_400_000)}
    assert gate["(b) ≥30 days fully autonomous"]["status"] == "PASS"
    assert gate["(b) ≥25 closed PAPER trades"]["status"] == "FAIL"
    assert gate["(b) heartbeat (max daily gap ≤ 10 min)"]["status"] == "PASS"
    assert gate["(b) calibrated Brier < 0.25 (≥20 pairs)"]["status"] == "WAIT"


def test_apply_map_matches_typescript_semantics():
    pts = [(0.0, 0.2), (0.5, 0.4), (1.0, 0.9)]
    assert M.apply_map(pts, -1) == 0.2 and M.apply_map(pts, 2) == 0.9
    assert abs(M.apply_map(pts, 0.25) - 0.3) < 1e-12 and abs(M.apply_map(pts, 0.75) - 0.65) < 1e-12


def test_options_gate_and_summary():
    from cortex_research.governor.run import options_gate, options_summary

    ev = [{"trade_id": "a", "kind": "OPEN", "strategy": "OPTIONS_PMCC_V1", "sizer_permits_live": 0},
          {"trade_id": "a", "kind": "CLOSE", "strategy": "OPTIONS_PMCC_V1", "r": 0.5},
          {"trade_id": "b", "kind": "OPEN", "strategy": "OPTIONS_PMCC_V1", "sizer_permits_live": 0}]
    g = options_gate(ev)
    assert g[0]["status"] == "FAIL" and g[0]["value"] == 1
    assert "1 open · 1 closed" in options_summary(ev)


def test_verify_chain_detects_edits_and_gaps():
    import hashlib

    rows, prev = [], M.GENESIS
    for seq in range(1, 4):
        r = {"seq": seq, "ts": seq * 10, "kind": "K", "payload_json": f'{{"n":{seq}}}', "prev_row_sha256": prev}
        r["row_sha256"] = hashlib.sha256(f"{prev}|{seq}|{seq * 10}|K|{r['payload_json']}".encode()).hexdigest()
        prev = r["row_sha256"]
        rows.append(r)
    assert M.verify_chain(rows)["ok"] and M.verify_chain(rows)["rows"] == 3
    tampered = [dict(r) for r in rows]
    tampered[1]["payload_json"] = '{"n":999}'
    assert M.verify_chain(tampered) == {**M.verify_chain(tampered), "ok": False, "broken_at": 2, "why": "row hash mismatch"}
    assert M.verify_chain([rows[0], rows[2]])["why"].startswith("gap")


def test_twin_divergence_signs_against_us():
    fills = [{"account": "PAPER", "contract": "k1", "role": "ENTRY", "qty": 1, "price": 100},
             {"account": "LIVE", "contract": "k1", "role": "ENTRY", "qty": 1, "price": 100.1},
             {"account": "PAPER", "contract": "k1", "role": "EXIT", "qty": 1, "price": 110},
             {"account": "LIVE", "contract": "k1", "role": "EXIT", "qty": 1, "price": 109.89},
             {"account": "PAPER", "contract": "k2", "role": "ENTRY", "qty": 1, "price": 50}]
    t = M.twin_divergence(fills)
    assert t["pairs"] == 2 and t["mean_bps"] == 10.0 and M.twin_divergence([])["mean_bps"] is None


def test_gate_cost_grades_regime_refusals():
    from cortex_research.governor.run import gate_cost

    rej = [{"id": 1, "reason_codes": '["equity posture REDUCE_ONLY"]'}, {"id": 2, "reason_codes": '["crypto regime gate closed (score 30)"]'},
           {"id": 3, "reason_codes": '["already held"]'}]
    grades = [{"rejection_id": 1, "horizon": "72h", "outcome_r": 1.5}, {"rejection_id": 2, "horizon": "72h", "outcome_r": -1.0},
              {"rejection_id": 3, "horizon": "72h", "outcome_r": 3.0}]
    out = gate_cost(rej, grades)
    assert "2 graded" in out and "avg R +0.25" in out and "1 would have won" in out
    assert "none graded" in gate_cost(rej, [])
