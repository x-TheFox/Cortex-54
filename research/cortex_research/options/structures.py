# Portions Copyright (c) 2026 staskh, MIT License (full text in NOTICE.md).
"""Options shadow-lab structures (pure; unit-tested). ADR-031.

Fills are pessimistic: we sell at the bid and buy at the ask on every leg, entry and exit, and charge
FEE_PER_CONTRACT per contract per fill. Results are in R = P&L / max loss, so they compare with the stock and
crypto strategies.

The PMCC rubric (`pmcc_base_score`, `trend_score`, `short_premium_score`, `strike_density_score`,
`weekly_score`) is ported from staskh/trading_skills `scanner_pmcc.py` (MIT, commit
b71a74fe327b12e314fc96618d7131dca4638ab3; see NOTICE.md). The earnings term is dropped (no free earnings calendar
we trust); liquidity is daily volume + open interest as upstream.
"""

from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass, field
from datetime import date

from . import bs

MULT = 100
FEE_PER_CONTRACT = 0.05  # USD per contract per fill: ORF + OCC + TAF, rounded up (Alpaca charges $0 commission)
RISK_FREE = 0.04
MAX_LEG_SPREAD_PCT = 35.0  # skip legs whose bid/ask spread is wider than this % of mid
OCC = re.compile(r"^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$")


@dataclass(frozen=True)
class Quote:
    symbol: str
    kind: str  # call | put
    strike: float
    expiry: date
    bid: float
    ask: float
    delta: float | None = None
    iv: float | None = None
    volume: int = 0
    oi: int = 0

    @property
    def mid(self) -> float:
        return (self.bid + self.ask) / 2

    @property
    def spread_pct(self) -> float:
        return (self.ask - self.bid) / self.mid * 100 if self.mid > 0 else 100.0


def parse_occ(symbol: str) -> tuple[str, date, str, float] | None:
    m = OCC.match(symbol)
    if not m:
        return None
    root, yy, mm, dd, cp, k = m.groups()
    return root, date(2000 + int(yy), int(mm), int(dd)), "call" if cp == "C" else "put", int(k) / 1000


def quote_from_snapshot(symbol: str, snap: dict, spot: float | None = None, today: date | None = None) -> Quote | None:
    p = parse_occ(symbol)
    q = snap.get("latestQuote") or {}
    if not p or q.get("bp") is None or q.get("ap") is None:
        return None
    _, exp, kind, strike = p
    g = snap.get("greeks") or {}
    d = g.get("delta")
    iv = snap.get("impliedVolatility")
    if d is None and spot and today:  # fill missing greeks from our own Black-Scholes
        t = max((exp - today).days, 0) / 365
        mid = (float(q["bp"]) + float(q["ap"])) / 2
        iv = iv or bs.implied_vol(mid, spot, strike, t, RISK_FREE, kind)
        d = bs.delta(spot, strike, t, RISK_FREE, iv, kind) if iv else None
    vol = int(((snap.get("dailyBar") or {}).get("v")) or 0)
    return Quote(symbol, kind, strike, exp, float(q["bp"]), float(q["ap"]), d, iv, vol)


@dataclass(frozen=True)
class Leg:
    symbol: str
    side: str  # long | short
    kind: str
    strike: float
    expiry: str  # ISO date


@dataclass
class Plan:
    strategy: str
    structure: str
    underlying: str
    legs: list[Leg]
    entry_cash: float  # per share: > 0 credit received, < 0 debit paid (after natural pricing)
    max_loss_cents: int
    max_profit_cents: int | None
    fees_cents: int  # entry + planned exit fees
    detail: dict = field(default_factory=dict)

    def as_event(self, ts: int, trade_id: str, permits_live: bool) -> dict:
        return {
            "trade_id": trade_id, "kind": "OPEN", "ts": ts, "strategy": self.strategy, "structure": self.structure,
            "underlying": self.underlying, "legs": [asdict(x) for x in self.legs], "cash": round(self.entry_cash, 4),
            "max_loss_cents": self.max_loss_cents, "max_profit_cents": self.max_profit_cents,
            "fees_cents": self.fees_cents, "pnl_cents": None, "r": None, "reason": None,
            "sizer_permits_live": permits_live, "detail": self.detail,
        }


def fees_cents(n_legs: int, fills: int = 2) -> int:
    return math.ceil(n_legs * fills * FEE_PER_CONTRACT * 100)


def usable(q: Quote | None) -> bool:
    return q is not None and q.bid > 0 and q.ask >= q.bid and q.spread_pct <= MAX_LEG_SPREAD_PCT


def dte(exp: date, today: date) -> int:
    return (exp - today).days


def pick_expiry(quotes: list[Quote], today: date, lo: int, hi: int) -> date | None:
    exps = sorted({q.expiry for q in quotes if lo <= dte(q.expiry, today) <= hi})
    if not exps:
        return None
    mid = (lo + hi) / 2
    return min(exps, key=lambda e: abs(dte(e, today) - mid))


def _closest(quotes: list[Quote], target: float, key) -> Quote | None:
    c = [q for q in quotes if key(q) is not None]
    return min(c, key=lambda q: abs(key(q) - target)) if c else None


def bull_put_spread(sid: str, und: str, spot: float, puts: list[Quote], today: date, p: dict) -> Plan | str:
    exp = pick_expiry(puts, today, *p["dte"])
    if not exp:
        return "no expiry in DTE window"
    chain = [q for q in puts if q.expiry == exp and q.kind == "put" and q.strike < spot]
    lo, hi = p["short_delta"]
    cands = [q for q in chain if q.delta is not None and lo <= abs(q.delta) <= hi and usable(q)]
    short = _closest(cands, (lo + hi) / 2, lambda q: abs(q.delta))
    if not short:
        return "no short put in delta band"
    target = short.strike - p["width_pct"] * spot
    longs = [q for q in chain if q.strike < short.strike and usable(q)]
    long = _closest(longs, target, lambda q: q.strike)
    if not long:
        return "no long put"
    width = short.strike - long.strike
    credit = short.bid - long.ask
    if credit < p["min_credit_to_width"] * width:
        return f"credit {credit:.2f} < {p['min_credit_to_width']}×width {width:.2f}"
    fee = fees_cents(2)
    return Plan(
        sid, "vertical_credit", und,
        [Leg(short.symbol, "short", "put", short.strike, exp.isoformat()), Leg(long.symbol, "long", "put", long.strike, exp.isoformat())],
        credit, round((width - credit) * MULT * 100) + fee, round(credit * MULT * 100) - fee, fee,
        {"width": width, "dte": dte(exp, today), "short_delta": short.delta, "spot": spot, "iv": short.iv},
    )


def bull_call_debit(sid: str, und: str, spot: float, calls: list[Quote], today: date, p: dict) -> Plan | str:
    exp = pick_expiry(calls, today, *p["dte"])
    if not exp:
        return "no expiry in DTE window"
    chain = [q for q in calls if q.expiry == exp and q.kind == "call"]
    lo, hi = p["long_delta"]
    cands = [q for q in chain if q.delta is not None and lo <= q.delta <= hi and usable(q)]
    long = _closest(cands, (lo + hi) / 2, lambda q: q.delta)
    if not long:
        return "no long call in delta band"
    shorts = [q for q in chain if q.strike > long.strike and usable(q)]
    short = _closest(shorts, long.strike + p["width_pct"] * spot, lambda q: q.strike)
    if not short:
        return "no short call"
    width = short.strike - long.strike
    debit = long.ask - short.bid
    if debit <= 0 or debit > p["max_debit_to_width"] * width:
        return f"debit {debit:.2f} vs width {width:.2f} outside 0–{p['max_debit_to_width']}"
    fee = fees_cents(2)
    return Plan(
        sid, "vertical_debit", und,
        [Leg(long.symbol, "long", "call", long.strike, exp.isoformat()), Leg(short.symbol, "short", "call", short.strike, exp.isoformat())],
        -debit, round(debit * MULT * 100) + fee, round((width - debit) * MULT * 100) - fee, fee,
        {"width": width, "dte": dte(exp, today), "long_delta": long.delta, "spot": spot, "iv": long.iv},
    )


# ------------------------------------------------------------------ PMCC rubric (ported, see module docstring)


def trend_score(price: float, sma50: float | None, rsi: float | None, macd: float | None, signal: float | None) -> float:
    s = 0.0
    if sma50 is not None:
        s += 1.0 if price > sma50 else -1.0
    if rsi is not None:
        s += 0.5 if rsi > 50 else -0.5
    if macd is not None and signal is not None:
        s += 0.5 if macd > signal else -0.5
    return s


def weekly_score(expiries: list[date], today: date) -> float:
    near = sorted(d for d in (dte(e, today) for e in set(expiries)) if 0 <= d <= 60)
    return 0.0 if any(b - a <= 10 for a, b in zip(near, near[1:])) else -1.0


def strike_density_score(n: int) -> float:
    return -2.0 if n < 3 else (-1.0 if n < 5 else 0.0)


def short_premium_score(mid: float) -> float:
    return -1.0 if mid < 0.10 else (-0.5 if mid < 0.50 else 0.0)


def pmcc_base_score(leaps_delta, short_delta, leaps_liq, short_liq, leaps_spread, short_spread, avg_iv, annual_yield,
                    leaps_target=0.80, short_target=0.20) -> float:
    s = 0.0
    s += 2.0 if abs(leaps_delta - leaps_target) <= 0.05 else (1.0 if abs(leaps_delta - leaps_target) <= 0.10 else 0.0)
    s += 1.0 if abs(short_delta - short_target) <= 0.05 else (0.5 if abs(short_delta - short_target) <= 0.10 else 0.0)
    s += 1.0 if leaps_liq > 100 else (0.5 if leaps_liq > 20 else 0.0)
    s += 1.0 if short_liq > 500 else (0.5 if short_liq > 100 else 0.0)
    s += 1.0 if leaps_spread < 5 else (0.5 if leaps_spread < 10 else 0.0)
    s += 1.0 if short_spread < 10 else (0.5 if short_spread < 20 else 0.0)
    s += 2.0 if 0.25 <= avg_iv <= 0.50 else (1.0 if 0.20 <= avg_iv <= 0.60 else 0.0)
    s += 2.0 if annual_yield > 50 else (1.0 if annual_yield > 30 else (0.5 if annual_yield > 15 else 0.0))
    return round(s, 1)


def pmcc(sid: str, und: str, spot: float, calls: list[Quote], leaps: list[Quote], today: date, p: dict,
         trend: float) -> Plan | str:
    lexps = sorted({q.expiry for q in leaps if dte(q.expiry, today) >= p["leaps_min_dte"]})
    if not lexps:
        return "no LEAPS expiry"
    lchain = [q for q in leaps if q.expiry == lexps[0] and q.delta is not None and usable(q)]
    lq = _closest(lchain, p["leaps_delta"], lambda q: q.delta)
    if not lq:
        return "no LEAPS near target delta"
    lo, hi = p["short_dte"]
    sexp = pick_expiry(calls, today, lo, hi)
    if not sexp:
        return "no short expiry"
    schain = [q for q in calls if q.expiry == sexp and q.strike > max(spot, lq.strike) and q.delta is not None and usable(q)]
    sq = _closest(schain, p["short_delta"], lambda q: q.delta)
    if not sq:
        return "no short call near target delta"
    sdays = dte(sexp, today)
    annual_yield = (sq.mid / lq.mid * 100) * (365 / sdays) if lq.mid > 0 and sdays > 0 else 0.0
    avg_iv = sum(x for x in (lq.iv, sq.iv) if x) / max(1, sum(1 for x in (lq.iv, sq.iv) if x))
    density = sum(1 for q in calls if q.expiry == sexp and spot <= q.strike <= sq.strike)
    score = (
        pmcc_base_score(lq.delta, sq.delta, lq.volume + lq.oi, sq.volume + sq.oi, lq.spread_pct, sq.spread_pct, avg_iv,
                        annual_yield, p["leaps_delta"], p["short_delta"])
        + trend + short_premium_score(sq.mid) + strike_density_score(density)
        + weekly_score([q.expiry for q in calls], today)
    )
    if score < p["min_rubric_score"]:
        return f"rubric {score:.1f} < {p['min_rubric_score']}"
    debit = lq.ask - sq.bid
    if debit <= 0:
        return "non-positive debit"
    # audit F-B1-06: with the short assigned on a rally the position is worth at least the strike width, so a debit
    # at or above the width locks in a loss on the very move the trade wants; max loss = the debit only holds when
    # debit < width (the classic PMCC rule), which is now required
    width = sq.strike - lq.strike
    if debit >= width:
        return f"debit {debit:.2f} ≥ strike width {width:.2f}: a rally would lock in a loss"
    fee = fees_cents(2)
    return Plan(
        sid, "diagonal", und,
        [Leg(lq.symbol, "long", "call", lq.strike, lq.expiry.isoformat()), Leg(sq.symbol, "short", "call", sq.strike, sexp.isoformat())],
        -debit, round(debit * MULT * 100) + fee, None, fee,
        {"rubric": round(score, 1), "leaps_dte": dte(lq.expiry, today), "short_dte": sdays, "annual_yield_pct": round(annual_yield, 1),
         "spot": spot, "iv": round(avg_iv, 4)},
    )


# ------------------------------------------------------------------ marks and exits


def close_cash(legs: list[dict], quotes: dict[str, Quote]) -> float | None:
    """Cash per share to close now at natural prices: + bid for longs, − ask for shorts. None if a quote is missing."""
    total = 0.0
    for leg in legs:
        q = quotes.get(leg["symbol"])
        if q is None or q.ask <= 0:
            return None
        total += q.bid if leg["side"] == "long" else -q.ask
    return total


def settle_cash(legs: list[dict], spot: float) -> float:
    total = 0.0
    for leg in legs:
        k = leg["strike"]
        intrinsic = max(0.0, spot - k) if leg["kind"] == "call" else max(0.0, k - spot)
        total += intrinsic if leg["side"] == "long" else -intrinsic
    return total


def exit_decision(trade: dict, p: dict, quotes: dict[str, Quote], spot: float | None, today: date) -> tuple[str, float, bool] | None:
    """(reason, close cash per share, settled) or None to keep holding."""
    legs = trade["legs"]
    first_exp = min(date.fromisoformat(x["expiry"]) for x in legs)
    if today > first_exp and spot is not None:
        return "EXPIRY", settle_cash(legs, spot), True
    cc = close_cash(legs, quotes)
    if cc is None:
        return None
    entry = trade["cash"]
    days = dte(first_exp, today)
    s = trade["structure"]
    # Assignment stub (W3-07): a short leg in the money with ≤ 3 days left can be assigned early (a cash account can't
    # carry the resulting shares/short). Close it at natural prices instead of modelling the assignment.
    if spot is not None and days <= 3:
        for leg in legs:
            itm = (leg["kind"] == "call" and spot > leg["strike"]) or (leg["kind"] == "put" and spot < leg["strike"])
            if leg["side"] == "short" and itm:
                return "ASSIGNMENT_RISK", cc, False
    if s == "vertical_credit":
        cost = -cc
        if cost <= p["take_profit_pct"] * entry:
            return "TARGET", cc, False
        if cost >= p["stop_multiple"] * entry:
            return "STOP", cc, False
        if days <= p["exit_dte"]:
            return "TIME", cc, False
    elif s == "vertical_debit":
        debit = -entry
        width = abs(legs[0]["strike"] - legs[1]["strike"])
        if cc >= debit + p["take_profit_pct"] * (width - debit):
            return "TARGET", cc, False
        if cc <= (1 - p["stop_pct"]) * debit:
            return "STOP", cc, False
        if days <= p["exit_dte"]:
            return "TIME", cc, False
    elif s == "diagonal":
        debit = -entry
        if cc >= debit * (1 + p["take_profit_pct"]):
            return "TARGET", cc, False
        if cc <= debit * (1 - p["stop_pct"]):
            return "STOP", cc, False
        if days <= p["exit_short_dte"]:
            return "TIME", cc, False
    return None


def close_event(trade: dict, reason: str, cc: float, settled: bool, ts: int) -> dict:
    n = len(trade["legs"])
    entry_fee = fees_cents(n, 1)
    exit_fee = 0 if settled else fees_cents(n, 1)
    pnl = round((trade["cash"] + cc) * MULT * 100) - entry_fee - exit_fee
    return {
        "trade_id": trade["trade_id"], "kind": "CLOSE", "ts": ts, "strategy": trade["strategy"],
        "structure": trade["structure"], "underlying": trade["underlying"], "legs": trade["legs"],
        "cash": round(cc, 4), "max_loss_cents": trade["max_loss_cents"], "max_profit_cents": trade.get("max_profit_cents"),
        "fees_cents": entry_fee + exit_fee, "pnl_cents": pnl, "r": round(pnl / trade["max_loss_cents"], 4),
        "reason": reason, "sizer_permits_live": bool(trade.get("sizer_permits_live")), "detail": {"settled": settled},
    }
