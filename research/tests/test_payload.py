import json

from cortex_research import payload as P


def test_crypto_posture_gate_and_funding_note():
    s = P.summarize_crypto_regime(
        {"composite": {"score": 66.8, "zone": "NEUTRAL", "guidance": "Mixed", "components_available": 5, "components_total": 6}}
    )
    assert s["headline"].startswith("NEUTRAL 66.8/100 (5/6")
    p = P.crypto_posture(s, {"max_annualized": 0.123})
    assert p["posture"] == "NEW_ENTRY_ALLOWED" and p["arena"] == "CRYPTO" and p["ceiling"] is None
    assert "12.3% annualized" in p["summary"]
    low = P.crypto_posture({"score": 39.9, "zone": "RISK_OFF", "guidance": ""}, None)
    assert low["posture"] == "REDUCE_ONLY"


def test_equity_posture_maps_exposure_coach_and_fails_closed():
    e = {"recommendation": "REDUCE_ONLY", "exposure_ceiling_pct": 49, "confidence": "MEDIUM", "composite_score": 41.2,
         "bias": "NEUTRAL", "participation": "NARROW", "rationale": "x"}
    p = P.equity_posture(e)
    assert p == {**p, "posture": "REDUCE_ONLY", "ceiling": 0.49, "confidence": "MEDIUM", "score": 41.2}
    weird = P.equity_posture({"recommendation": "YOLO", "exposure_ceiling_pct": 300, "confidence": "??"})
    assert weird["posture"] == "REDUCE_ONLY" and weird["ceiling"] == 1.0 and weird["confidence"] is None


def test_batch_shape_and_deterministic_dump():
    raw = b'{"x":1}'
    it = P.item("market-breadth-analyzer", "sha", 1, raw, {"headline": "ok"})
    assert it["inputs_sha256"] == P.sha256_bytes(raw) and len(it["inputs_sha256"]) == 64
    b = P.batch("equity-posture", 2, None, [it], P.equity_posture({"recommendation": "CASH_PRIORITY"}))
    assert b["schema_version"] == 1 and b["items"][0]["skill_id"] == "market-breadth-analyzer"
    assert P.dumps(b) == P.dumps(json.loads(P.dumps(b)))
