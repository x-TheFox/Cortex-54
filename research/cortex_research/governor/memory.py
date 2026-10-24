"""Governor memory (pure; unit-tested): source reputation, beliefs, scar-tissue proposals. ADR-033.

Reputation feeds the sizer's W_rep (bounded by doctrine, capped at the rung by the sizer). Beliefs are context for
Tier 2 / the court. Scar rules are only *proposed* (written to config/scar-tissue.yaml on a branch); the operator
merges them (constitution U8). Every rule cites ≥3 contract ids.
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from datetime import date, timedelta

DAY = 86_400_000
REP_WINDOW_DAYS = 30
REP_SHRINK = 20  # weight moves toward 1 + 0.5·E[R] as n/(n+20)
W_MIN, W_MAX = 0.5, 1.2  # mirrors doctrine sizing.reputation_weight


def _j(s, default):
    try:
        return json.loads(s) if isinstance(s, str) else (s if s is not None else default)
    except (TypeError, ValueError):
        return default


def contract_source(k: dict) -> str | None:
    for r in _j(k.get("bull_case_receipts"), []) or []:
        if r.get("evidence_id") == "catalyst_source" and isinstance(r.get("metric_value"), str):
            return r["metric_value"]
    return None


def reputation(outcomes: list[dict], now: int, min_signals: int = 20) -> list[dict]:
    """outcomes: {source, r, ts, p (win prob or None), win (bool or None)}. 30-day window."""
    by: dict[str, list[dict]] = defaultdict(list)
    for o in outcomes:
        if o.get("source") and o.get("r") is not None and now - o["ts"] <= REP_WINDOW_DAYS * DAY:
            by[o["source"]].append(o)
    out = []
    for src, os_ in sorted(by.items()):
        n = len(os_)
        e = sum(o["r"] for o in os_) / n
        pairs = [(o["p"], 1 if o["win"] else 0) for o in os_ if o.get("p") is not None and o.get("win") is not None]
        brier = round(sum((p - y) ** 2 for p, y in pairs) / len(pairs), 4) if pairs else None
        w = 1.0 if n < min_signals else 1 + 0.5 * e * n / (n + REP_SHRINK)
        out.append({"source": src[:80], "signals": n, "brier_30d": brier, "expectancy_r_30d": round(e, 4),
                    "weight": round(min(W_MAX, max(W_MIN, w)), 4)})
    return out


def beliefs(trades: list[dict], now: int, min_n: int = 3) -> list[dict]:
    """One belief per symbol and per strategy×arena with ≥ min_n closed trades in 30 days."""
    recent = [t for t in trades if now - t["ts"] <= 30 * DAY]
    groups: dict[tuple[str, str, str], list[dict]] = defaultdict(list)
    for t in recent:
        groups[("sym", t["symbol"], t.get("arena") or "")].append(t)
        groups[("strat", t.get("arena") or "UNKNOWN", t["strategy_id"])].append(t)
    out = []
    for (kind, subject, extra), ts in sorted(groups.items()):
        n = len(ts)
        if n < min_n:
            continue
        e = sum(t["r"] for t in ts) / n
        wins = sum(1 for t in ts if t["r"] > 0)
        label = subject if kind == "sym" else f"{extra} in {subject}"
        out.append({
            "belief_id": f"{kind}:{subject}:{extra}"[:120], "subject": subject[:40],
            "tags": [x for x in (extra, kind) if x][:10],
            "statement": f"{label}: {n} closed trades in 30 days, {wins} winners, E[R] {e:+.2f}."[:300],
            "c0": round(min(0.9, n / (n + 5)), 3), "half_life_days": 60, "validated_at": now, "validations": n,
            "status": "ACTIVE", "evidence": [t["contract_id"] for t in ts][:50],
        })
    return out


def _same(expr_a: dict, expr_b: dict) -> bool:
    key = lambda e: sorted(json.dumps(c, sort_keys=True) for c in e.get("all", []))
    return key(expr_a) == key(expr_b)


def scar_proposals(trades: list[dict], facts: dict[str, dict], existing: list[dict], today: date) -> list[dict]:
    """New hard-filter proposals from repeated losses. Never duplicates an existing expression."""
    # a hand-edited id like "SCAR-xyz" must not crash the whole Governor run (audit W2-16)
    nums = [int(m.group(1)) for r in existing if (m := re.match(r"SCAR-(\d+)$", str(r.get("id", ""))))]
    nxt = max(nums, default=0) + 1
    out: list[dict] = []

    def add(rule: str, arena: str | None, conds: list[dict], evidence: list[str], expires: date | None):
        nonlocal nxt
        expr = {"all": conds, "action": "reject"}
        if any(r.get("expression") and _same(r["expression"], expr) for r in existing + out):
            return
        r = {"id": f"SCAR-{nxt:03d}", "kind": "hard_filter", "rule": rule[:300], "expression": expr,
             "evidence": evidence[:20], "added": today.isoformat()}
        if arena:
            r["arena"] = arena
        if expires:
            r["expires"] = expires.isoformat()
        out.append(r)
        nxt += 1

    cutoff = today - timedelta(days=14)
    by_sym: dict[str, list[dict]] = defaultdict(list)
    for t in trades:
        if date.fromtimestamp(t["ts"] / 1000) >= cutoff:
            by_sym[t["symbol"]].append(t)
    for sym, ts in sorted(by_sym.items()):
        losers = [t for t in ts if t["r"] < 0]
        if len(losers) >= 3 and sum(t["r"] for t in ts) <= -2:
            add(f"Cool down {sym}: {len(losers)} losing trades in 14 days (sum R {sum(t['r'] for t in ts):+.2f}).",
                ts[0].get("arena"), [{"field": "symbol", "op": "==", "value": sym}],
                [t["contract_id"] for t in losers], today + timedelta(days=30))

    by_sp: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for t in trades:
        posture = (facts.get(t["contract_id"]) or {}).get("posture")
        if posture:
            by_sp[(t["strategy_id"], posture)].append(t)
    for (sid, posture), ts in sorted(by_sp.items()):
        losers = [t for t in ts if t["r"] < 0]
        e = sum(t["r"] for t in ts) / len(ts)
        if len(ts) >= 3 and len(losers) >= 3 and e <= -0.5:
            add(f"No {sid} entries while posture is {posture}: {len(ts)} trades, E[R] {e:+.2f}.",
                ts[0].get("arena"),
                [{"field": "strategy_id", "op": "==", "value": sid}, {"field": "posture", "op": "==", "value": posture}],
                [t["contract_id"] for t in losers], None)
    return out
