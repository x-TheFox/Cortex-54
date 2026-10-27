"""Governor entry point (GitHub Actions: governor.yml).

    python -m cortex_research.governor.run [--weekly] [--dry-run]

Daily: grade the rejection shadow ledger, postmortem closed trades, compute calibration/fitness/gate status and
send them to the brain (signed /ingest/batch). Weekly (--weekly): also post the report card to Discord and, once
≥50 outcomes exist, write config/calibration.json so the workflow can open a pull request (constitution U8).
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import random
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import requests
import yaml

from .. import payload as P
from . import memory as MEM
from . import exits as EX
from . import metrics as M

REPO = Path(__file__).resolve().parents[3]
DATA = "https://data.alpaca.markets"
MIN_OUTCOMES_FOR_MAP = 50  # mirrors doctrine.funnel.calibration.min_outcomes_before_trusting


# ----------------------------------------------------------------------------- I/O


def _sign(body: str, route: str) -> dict[str, str]:
    """Route-bound signature (audit F-A3-03): HMAC over `ts.route.body`, with the route in x-cortex-audience."""
    ts = str(int(time.time()))
    msg = f"{ts}.{route}.{body}".encode()
    sig = hmac.new(os.environ["INGEST_HMAC_SECRET"].encode(), msg, hashlib.sha256).hexdigest()
    return {
        "content-type": "application/json",
        "x-cortex-timestamp": ts,
        "x-cortex-audience": route,
        "x-cortex-signature": f"sha256={sig}",
    }


def export(table: str, limit: int = 100) -> list[dict]:
    url = os.environ["CORTEX_URL"].rstrip("/") + "/governor/export"
    rows: list[dict] = []
    after = 0
    while True:
        body = json.dumps({"table": table, "after": after, "limit": limit}, separators=(",", ":"))
        r = requests.post(url, data=body.encode(), headers=_sign(body, "/governor/export"), timeout=30)
        r.raise_for_status()
        d = r.json()
        rows += d["rows"]
        if d["next"] is None or len(d["rows"]) < limit:
            return rows
        after = d["next"]


def hourly_bars(symbol: str, start_ms: int, end_ms: int) -> list[M.Bar]:
    h = {"APCA-API-KEY-ID": os.environ["ALPACA_KEY_ID"], "APCA-API-SECRET-KEY": os.environ["ALPACA_SECRET"]}
    crypto = "/" in symbol
    url = f"{DATA}/v1beta3/crypto/us/bars" if crypto else f"{DATA}/v2/stocks/bars"
    params = {
        "symbols": symbol,
        "timeframe": "1Hour",
        "start": datetime.fromtimestamp(start_ms / 1000, timezone.utc).isoformat().replace("+00:00", "Z"),
        "end": datetime.fromtimestamp(end_ms / 1000, timezone.utc).isoformat().replace("+00:00", "Z"),
        "limit": 10000,
        "sort": "asc",
    }
    if not crypto:
        params["feed"] = "iex"
    out: list[M.Bar] = []
    token = None
    for _ in range(10):
        if token:
            params["page_token"] = token
        r = requests.get(url, params=params, headers=h, timeout=30)
        r.raise_for_status()
        d = r.json()
        for b in (d.get("bars") or {}).get(symbol, []):
            out.append(M.Bar(int(datetime.fromisoformat(b["t"].replace("Z", "+00:00")).timestamp() * 1000), b["h"], b["l"], b["c"]))
        token = d.get("next_page_token")
        if not token:
            break
    return out


# ----------------------------------------------------------------------------- analysis


def jload(s, default=None):
    try:
        return json.loads(s) if isinstance(s, str) else (s if s is not None else default)
    except (TypeError, ValueError):
        return default


def build_trades(journal: list[dict], contracts: dict[str, dict]) -> list[dict]:
    """Closed trades from EXIT rows + ENTRY fills (journal) + contract stop."""
    by8 = {cid.replace("-", "")[-8:]: cid for cid in contracts}
    entries: dict[tuple[str, str], list[tuple[float, float]]] = defaultdict(list)
    first_fill: dict[tuple[str, str], int] = {}
    for r in journal:
        if r["kind"] != "FILL":
            continue
        p = jload(r["payload_json"], {})
        if p.get("role") != "ENTRY":
            continue
        parts = (r.get("ref_id") or "").split("-")
        cid = by8.get(parts[2]) if len(parts) > 2 else None
        if cid:
            entries[(cid, r["account"])].append((float(p["qty"]), float(p["price"])))
            first_fill.setdefault((cid, r["account"]), r["ts"])
    trades = []
    for r in journal:
        if r["kind"] != "EXIT":
            continue
        cid, acct = r.get("ref_id"), r["account"]
        p = jload(r["payload_json"], {})
        k = contracts.get(cid or "")
        fills = entries.get((cid or "", acct), [])
        if not k or not fills or p.get("pnl_cents") is None:
            continue
        qty = sum(q for q, _ in fills)
        avg = sum(q * px for q, px in fills) / qty
        stop = float(jload(k["invalidation_criteria"], {}).get("stop_price", 0))
        risk = qty * (avg - stop)
        if risk <= 0:
            continue
        r_mult = (p["pnl_cents"] / 100) / risk
        probs = jload(k.get("clef_probabilities"), None) or {}
        plan = jload(k.get("entry_plan"), {}) or {}
        inval = jload(k["invalidation_criteria"], {}) or {}
        target = float((plan.get("targets") or [0])[0] or 0)
        trades.append(
            {
                "contract_id": cid,
                "account": acct,
                "strategy_id": k["strategy_id"],
                "origin": k.get("origin", "COURT"),
                "symbol": k["symbol"],
                "arena": k.get("arena"),
                "source": MEM.contract_source(k),
                "reason": p.get("reason", "EXIT"),
                "r": round(r_mult, 4),
                "ts": r["ts"],
                "win_prob_raw": (probs.get("raw") or {}).get("win_prob"),
                "entry": avg,
                "stop": stop,
                "target": target,
                "entry_ts": first_fill.get((cid or "", acct), r["ts"]),
                "horizon_h": float(inval.get("max_hold_hours") or 48),
            }
        )
    return trades


def daily_bars(symbols: list[str], days: int) -> dict[str, list[M.Bar]]:
    h = {"APCA-API-KEY-ID": os.environ["ALPACA_KEY_ID"], "APCA-API-SECRET-KEY": os.environ["ALPACA_SECRET"]}
    start = datetime.fromtimestamp(time.time() - days * 86_400, timezone.utc).strftime("%Y-%m-%d")
    out: dict[str, list[M.Bar]] = {}
    for crypto in (True, False):
        syms = [s for s in symbols if ("/" in s) == crypto]
        if not syms:
            continue
        url = f"{DATA}/v1beta3/crypto/us/bars" if crypto else f"{DATA}/v2/stocks/bars"
        params = {"symbols": ",".join(syms), "timeframe": "1Day", "start": start, "limit": 10000, "sort": "asc"}
        if not crypto:
            params.update({"feed": "iex", "adjustment": "split"})
        r = requests.get(url, params=params, headers=h, timeout=30)
        r.raise_for_status()
        for sym, rows in (r.json().get("bars") or {}).items():
            out[sym] = [M.Bar(int(datetime.fromisoformat(b["t"].replace("Z", "+00:00")).timestamp() * 1000), b["h"], b["l"], b["c"])
                        for b in rows]
    return out


def exit_and_monkey(trades: list[dict], journal: list[dict], now: int, seed: int = 54) -> tuple[dict, dict]:
    """Exit scorecard + virtual monkey control over the last 20 closed trades (one hourly-bars fetch per trade)."""
    exc = {(r.get("ref_id"), r["account"]): jload(r["payload_json"], {}) or {} for r in journal if r["kind"] == "EXCURSIONS"}
    rng = random.Random(seed)
    rows, real, r_ent, r_ex = [], [], [], []
    for t in trades[-20:]:
        risk = t["entry"] - t["stop"]
        if risk <= 0:
            continue
        try:
            bars = hourly_bars(t["symbol"], t["entry_ts"] - 30 * 86_400_000, min(now, t["ts"] + 72 * 3_600_000))
        except Exception as e:  # noqa: BLE001
            print(f"bars {t['symbol']}: {e}", file=sys.stderr)
            continue
        x = exc.get((t["contract_id"], t["account"]))
        exit_px = t["entry"] + t["r"] * risk
        rows.append({"r": t["r"], "reason": t["reason"], "mfe_r": (x or {}).get("mfe_r"),
                     "post": EX.post_exit_excursion(bars, t["ts"], exit_px, risk)})
        plan = EX.Plan(t["entry_ts"], t["entry"], risk / t["entry"],
                       max(0.0, (t["target"] - t["entry"]) / t["entry"]) or 2 * risk / t["entry"], t["horizon_h"])
        real.append(t["r"])
        r_ent += EX.monkey_entries(bars, plan, 10, rng)
        r_ex += EX.monkey_exits(bars, plan, 10, rng)
    return EX.exit_scorecard(rows), EX.monkey_summary(real, r_ent, r_ex)


def find_missed_moves(journal: list[dict], rejections: list[dict], contracts: dict[str, dict], now: int) -> list[dict]:
    w = (yaml.safe_load((REPO / "config" / "doctrine.yaml").read_text()) or {}).get("watchlists", {})
    symbols = sorted({s for v in w.values() for s in (v or [])})
    try:
        daily = daily_bars(symbols, 40)
    except Exception as e:  # noqa: BLE001
        print(f"missed moves: {e}", file=sys.stderr)
        return []
    day = lambda ms: datetime.fromtimestamp(ms / 1000, timezone.utc).date().isoformat()  # noqa: E731
    seen = {(rj.get("symbol"), day(rj["ts"])) for rj in rejections if rj.get("symbol")}
    seen |= {(k["symbol"], day(k["created_at"])) for k in contracts.values() if k.get("created_at")}
    return EX.missed_moves(daily, seen, now - 3 * 86_400_000)


def grade_rejections(rejections: list[dict], graded: set[tuple[int, str]], contracts: dict[str, dict], now: int) -> list[dict]:
    """Grade every rejection whose horizon has elapsed (one bars fetch per symbol)."""
    todo: dict[str, list[tuple[dict, M.Hypo, str]]] = defaultdict(list)
    for rj in rejections:
        hyp_raw = jload(rj.get("hypothetical"), {}) or {}
        if rj.get("contract_id") and rj["contract_id"] in contracts and "entry" not in hyp_raw:
            k = contracts[rj["contract_id"]]
            plan = jload(k["entry_plan"], {})
            hyp_raw = {
                "entry": (float(plan["zone_low"]) + float(plan["zone_high"])) / 2,
                "stop": jload(k["invalidation_criteria"], {}).get("stop_price"),
                "targets": plan.get("targets"),
            }
        hyp = M.hypothetical(hyp_raw)
        if not hyp or not rj.get("symbol"):
            continue
        for hz, hours in M.HORIZONS_H.items():
            if (rj["id"], hz) not in graded and now >= rj["ts"] + hours * 3_600_000:
                todo[rj["symbol"]].append((rj, hyp, hz))
    grades: list[dict] = []
    for symbol, items in todo.items():
        start = min(rj["ts"] for rj, _, _ in items)
        end = min(now, max(rj["ts"] + M.HORIZONS_H[hz] * 3_600_000 for rj, _, hz in items))
        try:
            bars = hourly_bars(symbol, start, end)
        except Exception as e:  # noqa: BLE001
            print(f"bars {symbol}: {e}", file=sys.stderr)
            continue
        for rj, hyp, hz in items:
            hit, r = M.grade_path(bars, hyp, rj["ts"], rj["ts"] + M.HORIZONS_H[hz] * 3_600_000)
            grades.append({"rejection_id": rj["id"], "horizon": hz, "graded_at": now, "outcome_r": None if r is None else round(r, 4), "hit": hit})
    return grades


def calibration_pairs(trades: list[dict], rejections: list[dict], grades: list[dict], contracts: dict[str, dict]) -> list[tuple[float, int]]:
    """(raw court win prob, target-before-stop) pairs in time order, purged of overlapping holds (audit W2-24)."""
    items = [{"p": t["win_prob_raw"], "y": 1 if t["reason"] == "TARGET" else 0, "ts": t["ts"], "symbol": t["symbol"]}
             for t in trades if t["origin"] == "COURT" and t["win_prob_raw"] is not None]
    by_rej = {(g["rejection_id"], g["horizon"]): g for g in grades}
    for rj in rejections:
        k = contracts.get(rj.get("contract_id") or "")
        if not k or k.get("origin") != "COURT" or rj.get("stage") != "VALIDATOR":
            continue
        g = by_rej.get((rj["id"], "72h"))
        p = ((jload(k.get("clef_probabilities"), {}) or {}).get("raw") or {}).get("win_prob")
        if g and g["hit"] in ("TARGET", "STOP") and p is not None:
            items.append({"p": float(p), "y": 1 if g["hit"] == "TARGET" else 0, "ts": rj["ts"], "symbol": rj.get("symbol")})
    return [(it["p"], it["y"]) for it in M.purge_overlaps(items)]


def gate_status(journal: list[dict], trades: list[dict], rejections: list[dict], brier_value: float | None, n_pairs: int, now: int,
                calibrated: bool = False) -> list[dict]:
    """RISK_DOCTRINE §7 LIVE gate (b)+(c) from data; (a) phases and (d) ratification are manual."""
    def ok(cond, value):
        return {"status": "PASS" if cond else "FAIL", "value": value}

    boots = [r["ts"] for r in journal if r["kind"] == "BOOT"]
    interventions = []
    for r in journal:
        p = jload(r["payload_json"], {}) or {}
        k = r["kind"]
        if k in ("KILL_SEEN", "COURT_REQUEST", "RESET") or (k == "UNLOCK" and p.get("by") != "auto") or (k == "DIAL") or (
            k == "MODE" and ("discord:" in str(p.get("reason", "")) or "web:" in str(p.get("reason", "")))
        ) or (k == "FLATTEN" and "operator" in str(p.get("why", ""))):
            interventions.append(r["ts"])
    since = max([min(boots)] + interventions) if boots else now
    days = (now - since) / 86_400_000
    paper = [t for t in trades if t["account"] == "PAPER"]
    rs = [t["r"] for t in paper]
    st = M.strategy_stats(rs) if rs else {"n": 0, "expectancy_r": None, "profit_factor": None}
    rail = sum(1 for rj in rejections if any(str(c).startswith("U3") for c in (jload(rj.get("reason_codes"), []) or [])))
    rolls = [jload(r["payload_json"], {}) or {} for r in journal if r["kind"] == "DAY_ROLL"]
    gaps = [p["max_gap_s"] for p in rolls if isinstance(p.get("max_gap_s"), (int, float))]
    reds = sum(1 for r in journal if r["kind"] == "RED_LOCK" and r["account"] == "PAPER")
    return [
        {"criterion": "(a) Phases 0–6 complete", **{"status": "MANUAL", "value": "see docs/ROADMAP.md"}},
        {"criterion": "(b) ≥30 days fully autonomous", **ok(days >= 30, f"{days:.1f} days since last operator intervention")},
        {"criterion": "(b) ≥25 closed PAPER trades", **ok(st["n"] >= 25, st["n"])},
        {"criterion": "(b) post-fee expectancy > 0", **(ok((st["expectancy_r"] or 0) > 0, st["expectancy_r"]) if st["n"] else {"status": "WAIT", "value": None})},
        {"criterion": "(b) profit factor > 1.2", **(ok((st["profit_factor"] or 0) > 1.2, st["profit_factor"]) if st["n"] else {"status": "WAIT", "value": None})},
        {"criterion": "(b) zero rail violations", **ok(rail == 0, rail)},
        {"criterion": "(b) heartbeat (max daily gap ≤ 10 min)", **(ok(max(gaps) <= 600, f"worst {max(gaps):.0f}s over {len(gaps)} day(s)") if gaps else {"status": "WAIT", "value": "no full day yet"})},
        {"criterion": "(b) calibrated Brier < 0.25 (≥20 pairs)", **(ok(brier_value < 0.25, round(brier_value, 4) if calibrated else f"{round(brier_value, 4)} (raw: no calibration map yet)") if brier_value is not None and n_pairs >= 20 else {"status": "WAIT", "value": f"{n_pairs} pairs"})},
        {"criterion": "(b) RED trips self-recovered", **{"status": "INFO", "value": reds}},
        {"criterion": "(c) live kill drill", **{"status": "MANUAL", "value": "after LIVE keys exist"}},
        {"criterion": "(d) operator RATIFY", **{"status": "MANUAL", "value": "/dial account:LIVE stop:3 confirm:RATIFY"}},
    ]


def gate_cost(rejections: list[dict], grades: list[dict]) -> str:
    """What the regime gate refused, graded at 72 h: positive average R means it is costing money."""
    gated = {rj["id"] for rj in rejections if any(("regime gate closed" in str(c)) or str(c).startswith("equity posture")
                                                   for c in (jload(rj.get("reason_codes"), []) or []))}
    rs = [float(g["outcome_r"]) for g in grades if g["rejection_id"] in gated and g["horizon"] == "72h" and g.get("outcome_r") is not None]
    if not rs:
        return f"{len(gated)} refusal(s) recorded; none graded at 72 h yet"
    wins = sum(1 for r in rs if r > 0)
    return f"{len(rs)} graded at 72 h · avg R {sum(rs) / len(rs):+.2f} · {wins} would have won · positive avg R = the gate is costing money"


def options_gate(events: list[dict]) -> list[dict]:
    """Phase 5 exit (≥30 shadow trades scored) and RISK_DOCTRINE 'options live' (positive post-fee expectancy)."""
    rs = [float(e["r"]) for e in events if e["kind"] == "CLOSE" and e.get("r") is not None]
    exp = round(sum(rs) / len(rs), 3) if rs else None
    return [
        {"criterion": "Phase 5 exit: ≥30 shadow options trades", "status": "PASS" if len(rs) >= 30 else "FAIL", "value": len(rs)},
        {"criterion": "Options live: shadow expectancy > 0 and sizer permits", "status": "MANUAL" if rs else "WAIT",
         "value": f"E[R] {exp}; sizer permits {sum(1 for e in events if e['kind'] == 'OPEN' and e.get('sizer_permits_live'))} of {sum(1 for e in events if e['kind'] == 'OPEN')}"},
    ]


def options_summary(events: list[dict]) -> str:
    opens = {e["trade_id"]: e for e in events if e["kind"] == "OPEN"}
    closes = [e for e in events if e["kind"] == "CLOSE"]
    by: dict[str, list[float]] = defaultdict(list)
    for e in closes:
        by[e["strategy"]].append(float(e["r"] or 0))
    parts = [f"{s.replace('OPTIONS_', '')}: n={len(v)} E[R] {sum(v) / len(v):+.2f}" for s, v in sorted(by.items())]
    return f"{len(opens) - len(closes)} open · {len(closes)} closed" + ("; " + "; ".join(parts) if parts else "")


def iso_week(ms: int) -> str:
    y, w, _ = datetime.fromtimestamp(ms / 1000, timezone.utc).isocalendar()
    return f"{y}-W{w:02d}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--weekly", action="store_true", help="post the report card and refresh calibration.json")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    now = int(time.time() * 1000)

    journal = export("journal", 200)
    contracts = {k["contract_id"]: k for k in export("decision_contracts", 50)}
    rejections = export("rejections", 200)
    graded_rows = export("rejection_grades", 200)
    graded = {(g["rejection_id"], g["horizon"]) for g in graded_rows}
    triage = export("triage_log", 200)
    llm = export("llm_calls", 200)
    options = export("options_shadow", 200)

    trades = build_trades(journal, contracts)
    new_grades = grade_rejections(rejections, graded, contracts, now)
    postmortems = [
        {"contract_id": t["contract_id"], "account": t["account"], "classification": M.classify(t["reason"], t["r"]),
         "realized_r": t["r"], "notes": f"{t['strategy_id']} {t['symbol']} exit {t['reason']} R={t['r']:+.2f}"}
        for t in trades
    ]
    pairs = calibration_pairs(trades, rejections, graded_rows + new_grades, contracts)
    b_raw = M.brier(pairs)
    # audit F-B1-08: the LIVE gate asks for a *calibrated* Brier, so score the probabilities through the map the
    # brain actually applies (config/calibration.json); with no map yet the brain shrinks toward 0.5, so raw is the
    # honest stand-in and the criterion says so
    live_map = (json.loads((REPO / "config" / "calibration.json").read_text()).get("maps", {}).get("court.win_prob")
                or {}).get("points")
    b_gate = M.brier([(M.apply_map([tuple(x) for x in live_map], x), o) for x, o in pairs]) if live_map else b_raw

    # strategy fitness (+ BH-FDR across strategies with enough trades)
    by_strat: dict[str, list[float]] = defaultdict(list)
    for t in trades:
        by_strat[t["strategy_id"]].append(t["r"])
    for e in options:  # shadow lab closes score like any other strategy (R = P&L / max loss)
        if e["kind"] == "CLOSE" and e.get("r") is not None:
            by_strat[e["strategy"]].append(float(e["r"]))
    stats = {s: M.strategy_stats(rs) for s, rs in by_strat.items()}
    dsr = {s: M.deflated_sharpe(rs, max(1, len(by_strat))) for s, rs in by_strat.items()}  # audit W2-28
    adj = M.bh_fdr({s: (st["p_value"] if st["n"] >= 10 else None) for s, st in stats.items()})
    week = iso_week(now)
    fitness = [
        {"skill_id": s, "week": week, "signals": st["n"], "expectancy_r": st["expectancy_r"], "brier": None,
         "p_value": st["p_value"], "p_value_bh": adj.get(s),
         "status": "INSUFFICIENT" if st["n"] < 10 else ("PROMOTE?" if (adj.get(s) or 1) < 0.05 and (st["expectancy_r"] or 0) > 0
                                                          and ((dsr.get(s) or {}).get("dsr") or 0) >= 0.95 else "HOLD")}
        for s, st in stats.items()
    ]

    # shadow ledger summary by stage (new + previously graded at 72h are not re-fetched; summarize new only)
    stage_of = {rj["id"]: rj["stage"] for rj in rejections}
    ledger: dict[str, list[float]] = defaultdict(list)
    for g in new_grades:
        if g["horizon"] == "72h" and g["outcome_r"] is not None:
            ledger[stage_of.get(g["rejection_id"], "?")].append(g["outcome_r"])

    t1 = [x for x in triage if x["tier"] == 1]
    t2 = [x for x in triage if x["tier"] == 2]
    llm_ok = defaultdict(lambda: [0, 0])
    for c in llm:
        llm_ok[f"{c['role']} {c['provider']}"][0 if c["outcome"] == "OK" else 1] += 1
    gate = gate_status(journal, trades, rejections, b_gate, len(pairs), now, calibrated=bool(live_map))
    gate += options_gate(options)
    fills = []
    for r in journal:
        if r["kind"] != "FILL":
            continue
        p = jload(r["payload_json"], {}) or {}
        parts = (r.get("ref_id") or "").split("-")
        if len(parts) > 2 and p.get("price") and p.get("qty"):
            fills.append({"account": r["account"], "contract": parts[2], "role": p.get("role"), "qty": p["qty"], "price": p["price"]})
    twin = M.twin_divergence(fills)
    gate.append({"criterion": "R2: live-vs-paper slippage < 15 bps", "status": "WAIT" if not twin["pairs"] else ("PASS" if twin["mean_bps"] < 15 else "FAIL"),
                 "value": "no LIVE fills yet" if not twin["pairs"] else f"mean {twin['mean_bps']} bps, worst {twin['worst_bps']} over {twin['pairs']}"})
    chain = M.verify_chain(journal)
    gate.insert(0, {"criterion": "Journal hash chain intact (U7)", "status": "PASS" if chain["ok"] else "FAIL",
                    "value": f"{chain['rows']} rows verified" if chain["ok"] else f"BROKEN at seq {chain['broken_at']}: {chain['why']}"})

    # memory: reputation (trades + graded court shadow outcomes), beliefs, scar proposals (ADR-033)
    win_p = lambda k: ((jload(k.get("clef_probabilities"), {}) or {}).get("raw") or {}).get("win_prob")
    outcomes = [{"source": t["source"], "r": t["r"], "ts": t["ts"], "p": t["win_prob_raw"], "win": t["reason"] == "TARGET"} for t in trades]
    rej_by_id = {rj["id"]: rj for rj in rejections}
    for g in graded_rows + new_grades:
        rj = rej_by_id.get(g["rejection_id"])
        k = contracts.get((rj or {}).get("contract_id") or "")
        if g["horizon"] == "72h" and g.get("outcome_r") is not None and k and rj.get("stage") == "VALIDATOR":
            outcomes.append({"source": MEM.contract_source(k), "r": float(g["outcome_r"]), "ts": rj["ts"],
                             "p": win_p(k), "win": g.get("hit") == "TARGET"})
    rep = MEM.reputation(outcomes, now)
    bel = MEM.beliefs(trades, now)
    facts = {r["ref_id"]: (jload(r["payload_json"], {}) or {}).get("facts", {}) for r in journal if r["kind"] == "ENTRY_FACTS" and r.get("ref_id")}
    scar_path = REPO / "config" / "scar-tissue.yaml"
    scar_doc = yaml.safe_load(scar_path.read_text()) or {}
    new_scars = MEM.scar_proposals(trades, facts, scar_doc.get("rules") or [], datetime.now(timezone.utc).date())
    if a.weekly and new_scars:
        text = scar_path.read_text()
        header = "".join(line + "\n" for line in text.splitlines() if line.startswith("#") and not line.startswith("# -") and not line.startswith("#   "))
        scar_doc["rules"] = (scar_doc.get("rules") or []) + new_scars
        scar_path.write_text(header + yaml.safe_dump(scar_doc, sort_keys=False, allow_unicode=True))
        print(f"scar-tissue.yaml: proposed {len(new_scars)} rule(s)")

    dec = M.brier_decomposition(pairs)  # audit W2-21
    court_rows = []
    r_by_contract = {t["contract_id"]: t["r"] for t in trades}
    for r in journal:
        if r["kind"] == "COURT":
            p = jload(r["payload_json"], {}) or {}
            court_rows.append({"panel": p.get("panel") or [], "win_used": p.get("win_used", p.get("win_cal")),
                               "r": r_by_contract.get(r.get("ref_id"))})
    pvj = M.panel_vs_judge(court_rows)  # audit W2-01
    slip = M.slippage_summary([jload(r["payload_json"], {}) or {} for r in journal if r["kind"] == "FILL"])  # W2-36
    scar_cost = M.scar_veto_cost(rejections, graded_rows + new_grades)  # audit W2-14
    exit_card, monkey = exit_and_monkey(trades, journal, now)  # ADR-059 / ADR-061
    missed = find_missed_moves(journal, rejections, contracts, now)  # MLP4-014
    sections = [
        {"name": "Trades", "value": f"{len(trades)} closed · " + (", ".join(f"{s}: n={st['n']} E[R]={st['expectancy_r']} PF={st['profit_factor']}" for s, st in stats.items()) or "none yet")},
        {"name": "Options shadow lab", "value": options_summary(options)},
        {"name": "Regime gate (ADR-039)", "value": gate_cost(rejections, graded_rows + new_grades)},
        {"name": "Memory", "value": ("reputation: " + ("; ".join(f"{r['source']} n={r['signals']} E[R] {r['expectancy_r_30d']:+.2f} w={r['weight']}" for r in rep) or "no attributed outcomes yet")
                                    + f" · beliefs {len(bel)} · scar proposals {len(new_scars)}" + (" (PR)" if a.weekly and new_scars else ""))},
        {"name": "Funnel", "value": f"Tier 1 items {sum(len(jload(x['candidate_ids'], [])) for x in t1)} · Tier 2 {len(t2)} · court sessions {sum(1 for r in journal if r['kind'] == 'COURT')} · contracts {len(contracts)}"},
        {"name": "LLM providers (ok/fail)", "value": "; ".join(f"{k} {v[0]}/{v[1]}" for k, v in sorted(llm_ok.items())) or "no calls yet"},
        {"name": "Shadow ledger (72h, new grades)", "value": "; ".join(f"{s}: n={len(v)} avg R {sum(v) / len(v):+.2f}" for s, v in ledger.items()) or f"{len(new_grades)} new grade(s); none at 72h yet"},
        {"name": "Calibration (court win prob)", "value": f"{len(pairs)} pair(s) after purging overlaps · Brier {b_raw if b_raw is None else round(b_raw, 4)}"
                                                         + (f" = reliability {dec['reliability']} − resolution {dec['resolution']} + uncertainty {dec['uncertainty']}" if dec else "")
                                                         + f" · map needs {MIN_OUTCOMES_FOR_MAP}"},
        {"name": "Panel vs judge (ADR-044 kill check)", "value": (f"n={pvj['n']}: panel majority right {pvj['panel_hit']:.0%}, judge right {pvj['judge_hit']:.0%}" if pvj["n"] else "no graded court trades yet")},
        {"name": "Realized slippage", "value": (f"{slip['n']} fills · mean {slip['mean_bps']} bps · p90 {slip['p90_bps']} · worst {slip['worst_bps']}" if slip["n"] else "no fills with an order price yet")},
        {"name": "Scar vetoes (72h)", "value": "; ".join(f"{k}: n={v['n']} avg R {v['avg_r']:+.2f}" for k, v in scar_cost.items()) or "no graded vetoes"},
        {"name": "Exit scorecard (ADR-059)", "value": (
            f"n={exit_card['n']} · capture {exit_card['capture']} of best R · give-back {exit_card['giveback_r']} R · "
            f"left on table (72h) {exit_card['left_on_table_r']} R · saved by stops {exit_card['saved_r']} R · {exit_card['by_reason']}"
            if exit_card.get("n") else "no closed trades yet")},
        {"name": "Monkey control (virtual)", "value": (
            f"real E[R] {monkey['real_r']} over {monkey['n_real']} · random entries {monkey['random_entries_r']} "
            f"(entry edge {monkey['entry_edge_r']}) · random exits {monkey['random_exits_r']} (exit edge {monkey['exit_edge_r']})"
            if monkey["n_real"] else "no closed trades yet")},
        {"name": "Missed moves (≥ 3 ATR, nothing reached Tier 0)", "value": "; ".join(
            f"{m['symbol']} {m['date']} {m['move_atr']:+} ATR" for m in missed[:8]) or "none in the last 3 days"},
        {"name": "Deflated Sharpe", "value": "; ".join(f"{s}: DSR {d['dsr']}" for s, d in dsr.items() if d) or "needs ≥ 10 trades per strategy"},
        {"name": "LIVE gate", "value": "\n".join(f"{'✅' if g['status'] == 'PASS' else '❌' if g['status'] == 'FAIL' else '⏳' if g['status'] == 'WAIT' else '•'} {g['criterion']}: {g['value']}" for g in gate)[:1000]},
    ]
    sections = [{"name": x["name"][:100], "value": (x["value"] or "—")[:1000]} for x in sections]
    card = {"title": f"🧬 Governor report · {week}", "sections": sections, "post": bool(a.weekly)}
    alarm = None if chain["ok"] else f"🚨 Journal hash chain BROKEN at seq {chain['broken_at']} ({chain['why']}). Investigate before trusting any history."

    # calibration map → file (the workflow turns a changed file into a PR)
    if a.weekly and len(pairs) >= MIN_OUTCOMES_FOR_MAP:
        method, pts = M.calibration_map(pairs)
        # audit F-A2-03: maps only ever shrink confidence above a coin flip (the TS schema refuses anything else);
        # min of two non-decreasing curves stays non-decreasing
        pts = [(x, min(y, max(x, 0.5))) for x, y in pts]
        cal_path = REPO / "config" / "calibration.json"
        cal = json.loads(cal_path.read_text())
        incumbent = (cal.get("maps", {}).get("court.win_prob") or {}).get("points")
        check = M.map_beats_incumbent(pairs, M.calibration_map, [tuple(x) for x in incumbent] if incumbent else None)
        print(f"calibration acceptance: {check}")
    if a.weekly and len(pairs) >= MIN_OUTCOMES_FOR_MAP and check["ok"]:
        cal["maps"]["court.win_prob"] = {
            "n": len(pairs), "method": method, "points": [[x, y] for x, y in pts], "brier_raw": round(b_raw or 0, 4),
            "brier_calibrated": round(M.brier([(M.apply_map(pts, x), o) for x, o in pairs]) or 0, 4),
        }
        cal["generated_at"] = now
        cal_path.write_text(json.dumps(cal, indent=2) + "\n")
        print("calibration.json updated")

    items = [
        P.item("rejection-ledger-grader", "gov-v1", now, P.dumps(new_grades).encode(), {"grades": new_grades}),
        P.item("signal-postmortem", "gov-v1", now, P.dumps(postmortems).encode(), {"postmortems": postmortems}),
        P.item("skill-fitness-leaderboard", "gov-v1", now, P.dumps(fitness).encode(), {"fitness": fitness, "gate": gate}),
        P.item("weekly-performance-digest", "gov-v1", now, P.dumps(card).encode(), {"card": card, "alarm": alarm, "chain": chain}),
        P.item("source-reputation", "gov-v1", now, P.dumps(rep).encode(), {"reputation": rep}),
        P.item("belief-writer", "gov-v1", now, P.dumps(bel).encode(), {"beliefs": bel}),
    ]
    b = P.batch("governor", now, os.environ.get("RUN_URL") or None, items, None)
    body = P.dumps(b)
    print(f"governor: trades {len(trades)}, new grades {len(new_grades)}, postmortems {len(postmortems)}, pairs {len(pairs)}, {len(body)} bytes")
    for g in gate:
        print(f"  gate {g['status']:6s} {g['criterion']}: {g['value']}")
    if a.dry_run:
        return 0
    url = os.environ["CORTEX_URL"].rstrip("/") + "/ingest/batch"
    r = requests.post(url, data=body.encode(), headers=_sign(body, "/ingest/batch"), timeout=60)
    print(f"ingest → HTTP {r.status_code}: {r.text[:300]}")
    return 0 if r.ok else 1


if __name__ == "__main__":
    sys.exit(main())
