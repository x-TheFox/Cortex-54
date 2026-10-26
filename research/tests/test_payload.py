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


def test_world_candidates():
    from cortex_research import world as W

    sub = {
        "filings": {
            "recent": {
                "form": ["8-K", "10-Q", "4"],
                "acceptanceDateTime": ["2026-10-22T20:00:00.000Z", "2026-10-22T20:00:00.000Z", "2026-10-01T20:00:00.000Z"],
                "accessionNumber": ["0001-26-000001", "0001-26-000002", "0001-26-000003"],
                "primaryDocument": ["a.htm", "b.htm", "c.xml"],
                "items": ["2.02", "", ""],
            }
        }
    }
    out = W.edgar_candidates("COIN", 1679788, sub, since_ms=1792627200000)  # 2026-10-21
    assert [x["id"] for x in out] == ["0001-26-000001"]
    assert out[0]["title"] == "COIN filed 8-K (items 2.02)"
    assert out[0]["url"] == "https://www.sec.gov/Archives/edgar/data/1679788/000126000001/a.htm"


def _gkg_row(domain, themes, tone, orgs="", title="", url="https://x.com/a", date="20261022214500"):
    r = [""] * 27
    r[1], r[3], r[4], r[7], r[13], r[15] = date, domain, url, themes, orgs, f"{tone},1,2,3"
    r[26] = f"<PAGE_TITLE>{title}</PAGE_TITLE>" if title else ""
    return r


def test_world_pulse_and_press_releases():
    from cortex_research import world as W

    rows = [
        _gkg_row("a.com", "ARMEDCONFLICT,10;MILITARY,20", -6.0),
        _gkg_row("b.com", "EPU_POLICY_GOVERNMENT,5;EPU_ECONOMY_HISTORIC,9;TAX_MILITARY_TITLE,2", -2.0),
        _gkg_row("c.com", "ECON_STOCKMARKET,1;ECON_INTEREST_RATES,3", 1.0),
        _gkg_row("prnewswire.com", "ECON_STOCKMARKET,1", 2.0, orgs="coinbase,1", title="Coinbase announces Q3 results",
                 url="https://www.prnewswire.com/x"),
        _gkg_row("prnewswire.com", "", 0.0, title="Local bakery opens"),
    ]
    p = W.world_pulse(rows)
    assert p["articles"] == 5
    assert p["groups"]["conflict"] == {"articles": 1, "share": 0.2, "tone": -6.0}
    assert p["groups"]["policy_uncertainty"]["articles"] == 1
    assert p["groups"]["markets"]["articles"] == 2 and p["groups"]["monetary"]["articles"] == 1
    prs = W.press_release_candidates(rows)
    assert [(c["symbols"], c["title"]) for c in prs] == [(["COIN"], "Coinbase announces Q3 results")]
    assert prs[0]["published_at"] == 1792705500000


def test_gkg_urls_step_back_from_latest_export():
    from cortex_research import world as W

    last = "72984 abc http://data.gdeltproject.org/gdeltv2/20261022223000.export.CSV.zip\n"
    urls = W.gkg_urls(last, n=4, max_back=3)
    assert urls[0].endswith("/20261022223000.gkg.csv.zip") and urls[2].endswith("/20261022220000.gkg.csv.zip")


def test_theme_matching_is_exact_or_subtheme():
    from cortex_research.world import theme_matches

    assert theme_matches("MILITARY", "MILITARY") and theme_matches("EPU_POLICY_GOVERNMENT", "EPU_POLICY")
    assert not theme_matches("TAX_MILITARY_TITLE", "MILITARY") and not theme_matches("EPU_ECONOMY_HISTORIC", "EPU_POLICY")
    assert theme_matches("ECON_CRYPTOCURRENCY", "*CRYPTO")


def test_macro_for_exposure_treats_an_unsettled_regime_as_transitional():
    raw = {"regime": {"current_regime": "contraction", "confidence": "moderate"},
           "composite": {"composite_score": 54.7, "zone": "Transition Zone (Preparing)", "data_quality": {}}}
    adapted = P.macro_for_exposure(raw)
    assert adapted["regime_score"] == 50 and "regime_score" not in raw  # raw report untouched
    confident = {**raw, "regime": {"current_regime": "contraction", "confidence": "high"}}
    assert "regime_score" not in P.macro_for_exposure(confident)
    settled = {**raw, "composite": {"composite_score": 20, "zone": "Stable", "data_quality": {}}}
    assert "regime_score" not in P.macro_for_exposure(settled)
