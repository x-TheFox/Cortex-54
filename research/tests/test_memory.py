from datetime import date

from cortex_research.governor import memory as MEM

DAY = 86_400_000
NOW = 100 * DAY


def test_contract_source():
    k = {"bull_case_receipts": '[{"evidence_id":"close","metric_value":1},{"evidence_id":"catalyst_source","metric_value":"news:benzinga"}]'}
    assert MEM.contract_source(k) == "news:benzinga" and MEM.contract_source({"bull_case_receipts": "[]"}) is None


def test_reputation_shrinks_and_bounds():
    good = [{"source": "news:a", "r": 1.0, "ts": NOW - DAY, "p": 0.6, "win": True} for _ in range(30)]
    few = [{"source": "filing", "r": -1.0, "ts": NOW - DAY, "p": None, "win": False} for _ in range(5)]
    old = [{"source": "news:old", "r": 5.0, "ts": NOW - 40 * DAY, "p": None, "win": True}]
    rep = {r["source"]: r for r in MEM.reputation(good + few + old, NOW)}
    assert rep["news:a"]["signals"] == 30 and rep["news:a"]["weight"] == 1.2  # 1 + 0.5·1·30/50 = 1.3 → capped
    assert rep["filing"]["weight"] == 1.0  # below min signals
    assert "news:old" not in rep and rep["news:a"]["brier_30d"] == 0.16
    bad = [{"source": "news:b", "r": -2.0, "ts": NOW, "p": None, "win": False} for _ in range(40)]
    assert MEM.reputation(bad, NOW)[0]["weight"] == 0.5


def _t(cid, sym, r, ts=NOW, sid="CRYPTO_CATALYST_COURT_V1"):
    return {"contract_id": cid, "symbol": sym, "arena": "CRYPTO", "strategy_id": sid, "r": r, "ts": ts}


def test_beliefs():
    trades = [_t(f"k{i}", "SOL/USD", 0.5) for i in range(3)] + [_t("x", "BTC/USD", 1.0)]
    b = {x["belief_id"]: x for x in MEM.beliefs(trades, NOW)}
    assert "sym:SOL/USD:CRYPTO" in b and "sym:BTC/USD:CRYPTO" not in b
    assert b["strat:CRYPTO:CRYPTO_CATALYST_COURT_V1"]["validations"] == 4
    assert 0 < b["sym:SOL/USD:CRYPTO"]["c0"] <= 0.9


def test_scar_proposals_cite_evidence_and_dedupe():
    today = date.fromtimestamp(NOW / 1000)
    trades = [_t(f"k{i}", "DOGE/USD", -1.0) for i in range(3)]
    facts = {f"k{i}": {"posture": "REDUCE_ONLY"} for i in range(3)}
    props = MEM.scar_proposals(trades, facts, [], today)
    assert [p["id"] for p in props] == ["SCAR-001", "SCAR-002"]
    assert props[0]["expression"]["all"] == [{"field": "symbol", "op": "==", "value": "DOGE/USD"}] and "expires" in props[0]
    assert len(props[0]["evidence"]) >= 3 and props[1]["expression"]["all"][1]["value"] == "REDUCE_ONLY"
    again = MEM.scar_proposals(trades, facts, props, today)
    assert again == []
    assert MEM.scar_proposals(trades[:2], facts, [], today) == []
