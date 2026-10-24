"""Backtest lab (ADR-046): replay every deterministic RULE strategy over ~3 years of Alpaca daily bars with our fee and
slippage model, then score each the way the Governor scores live trades (expectancy in R, profit factor, bootstrap
p-value, max drawdown) with a Benjamini-Hochberg correction across all strategies. Free: runs on GitHub Actions.

Honest limits, stated in every report:
- Daily bars only. Intraday triggers (breakouts, bounces) fill at max(open, trigger); a gap through the trigger fills
  at the open. Stops and targets touched in the same bar count as the stop (pessimistic).
- Each strategy is replayed alone (no shared heat, slots or correlation guard), one position per symbol at a time.
- Crypto pays taker fees (0.25%) plus 0.10% slippage per side even though live entries are passive limits;
  equities pay 0.05% per side. The $10 minimum ticket and sizing are ignored: results are in R, not dollars.
- Inverse ETFs: there is no posture history, so "bearish" is approximated by the underlying closing below its
  50-day average. Kronos and the court are not replayed (no historical forecasts or debates).
The rules mirror src/strategy/*.ts and read their parameters from config/doctrine.yaml.
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
import yaml

from . import payload as P
from .governor import metrics as M

DATA = "https://data.alpaca.markets"
YEARS = 3
FEE = {"CRYPTO": 0.0025 + 0.0010, "EQUITIES": 0.0005}  # per side
INVERSE_UNDERLYING = {"SH": "SPY", "PSQ": "QQQ", "RWM": "IWM", "BITI": "BTC/USD"}


@dataclass(frozen=True)
class Bar:
    t: str  # ISO date
    o: float
    h: float
    l: float  # noqa: E741
    c: float


# ---------------------------------------------------------------- indicators (mirror src/strategy/indicators.ts)

def ema(xs: list[float], n: int) -> float | None:
    if len(xs) < n:
        return None
    k = 2 / (n + 1)
    e = sum(xs[:n]) / n
    for x in xs[n:]:
        e = x * k + e * (1 - k)
    return e


def sma(xs: list[float], n: int) -> float | None:
    return sum(xs[-n:]) / n if len(xs) >= n > 0 else None


def atr(bars: list[Bar], n: int = 14) -> float | None:
    if len(bars) < n + 1:
        return None
    tr = [max(b.h - b.l, abs(b.h - p.c), abs(b.l - p.c)) for p, b in zip(bars, bars[1:])]
    v = sum(tr[:n]) / n
    for x in tr[n:]:
        v = (v * (n - 1) + x) / n
    return v


def rsi(xs: list[float], n: int = 14) -> float | None:
    if len(xs) < n + 1:
        return None
    gain = loss = 0.0
    for a, b in zip(xs[: n], xs[1 : n + 1]):
        d = b - a
        gain += max(d, 0)
        loss += max(-d, 0)
    gain /= n
    loss /= n
    for a, b in zip(xs[n:], xs[n + 1 :]):
        d = b - a
        gain = (gain * (n - 1) + max(d, 0)) / n
        loss = (loss * (n - 1) + max(-d, 0)) / n
    return 100.0 if loss == 0 else 100 - 100 / (1 + gain / loss)


# ---------------------------------------------------------------- trade simulation

@dataclass
class Plan:
    entry: float
    stop: float
    target: float
    max_hold_days: float


def simulate(bars: list[Bar], i: int, plan: Plan, arena: str) -> tuple[float, int] | None:
    """Walk forward from the bar after entry; returns (R net of costs, exit index) or None if the risk is invalid."""
    risk = plan.entry - plan.stop
    if risk <= 0:
        return None
    last = min(len(bars) - 1, i + max(1, math.ceil(plan.max_hold_days)))
    exit_px, j = bars[last].c, last
    for j in range(i + 1, last + 1):
        b = bars[j]
        if b.o <= plan.stop:  # gap through the stop
            exit_px = b.o
            break
        if b.l <= plan.stop:  # pessimistic: a bar touching both counts as the stop
            exit_px = plan.stop
            break
        if b.o >= plan.target:
            exit_px = b.o
            break
        if b.h >= plan.target:
            exit_px = plan.target
            break
    else:
        exit_px, j = bars[last].c, last
    cost = (plan.entry + exit_px) * FEE[arena]
    return (exit_px - plan.entry - cost) / risk, j


def trigger_fill(b: Bar, trigger: float) -> float | None:
    """Price for a buy-stop style trigger inside a daily bar: the open if it gapped through, else the trigger."""
    if b.h <= trigger:
        return None
    return max(b.o, trigger)


# ---------------------------------------------------------------- strategy replays (one function per RULE strategy)

def replay_breakout(bars: list[Bar], btc: dict[str, Bar], p: dict) -> list[tuple[int, Plan]]:
    out = []
    lb, n = p["lookback_days"], p["atr_period"]
    btc_dates = sorted(btc)
    for i in range(max(lb, n) + 2, len(bars)):
        done = bars[:i]
        prior = [btc[d].c for d in btc_dates if d < bars[i].t]
        e = ema(prior, p["regime_proxy_ema"])
        if e is None or not prior or prior[-1] <= e:
            continue
        hi = max(b.h for b in done[-lb:])
        a = atr(done, n)
        px = trigger_fill(bars[i], hi)
        if px is None or a is None:
            continue
        out.append((i, Plan(px, px - p["atr_stop_multiple"] * a, px + p["atr_target_multiple"] * a, p["max_hold_hours"] / 24)))
    return out


def replay_bounce(bars: list[Bar], p: dict) -> list[tuple[int, Plan]]:
    out = []
    for i in range(p["ema_period"] + p["atr_period"] + 2, len(bars)):
        done = bars[:i]
        closes = [b.c for b in done]
        a, e, r = atr(done, p["atr_period"]), ema(closes, p["ema_period"]), rsi(closes, p["rsi_period"])
        if a is None or e is None or r is None or a <= 0:
            continue
        stretch = (e - min(closes[-3:])) / a
        if not (r <= p["rsi_max"] or stretch >= p["stretch_atr"]):
            continue
        px = trigger_fill(bars[i], done[-1].h)
        if px is None or px >= e:
            continue
        swing = min(b.l for b in bars[max(0, i - p["swing_lookback_days"]) : i + 1])
        stop = max(min(swing * 0.997, px - p["min_stop_atr"] * a), px - p["max_stop_atr"] * a)
        target = min(max(e, px + p["min_target_atr"] * a), px + p["max_target_atr"] * a)
        out.append((i, Plan(px, stop, target, p["max_hold_hours"] / 24)))
    return out


def replay_inverse(bars: list[Bar], under: dict[str, Bar], p: dict) -> list[tuple[int, Plan]]:
    out = []
    ud = sorted(under)
    for i in range(max(p["lookback_days"], p["ema_period"]) + 2, len(bars)):
        done = bars[:i]
        uc = [under[d].c for d in ud if d < bars[i].t]
        s50 = sma(uc, 50)
        if s50 is None or uc[-1] >= s50:  # proxy for a bearish posture
            continue
        a, e = atr(done, p["atr_period"]), ema([b.c for b in done], p["ema_period"])
        hi = max(b.h for b in done[-p["lookback_days"] :])
        px = trigger_fill(bars[i], hi)
        if px is None or a is None or e is None or px <= e:
            continue
        out.append((i, Plan(px, px - p["atr_stop_multiple"] * a, px + p["atr_target_multiple"] * a, p["max_hold_hours"] / 24)))
    return out


def replay_trend(bars: list[Bar], p: dict) -> list[tuple[int, Plan, float]]:
    out = []
    lbs = p["lookbacks"]
    for i in range(max(lbs) + p["ema_slow"] + 2, len(bars)):
        done = bars[:i]
        closes = [b.c for b in done]
        a, fast, slow = atr(done, 14), ema(closes, p["ema_fast"]), ema(closes, p["ema_slow"])
        slow_before = ema(closes[:-5], p["ema_slow"])
        if None in (a, fast, slow, slow_before) or a <= 0:
            continue
        if not all(closes[-1] > closes[-1 - n] for n in lbs) or not slow > slow_before:
            continue
        b = bars[i]
        hi = max(x.h for x in done[-p["breakout_days"] :])
        px = None
        if fast <= b.o <= fast + p["pullback_atr"] * a and b.o > slow:
            px = b.o
        elif (f := trigger_fill(b, hi)) is not None:
            px = f
        if px is None:
            continue
        strength = sum(closes[-1] / closes[-1 - n] - 1 for n in lbs) / len(lbs)
        out.append((i, Plan(px, px - p["atr_stop_multiple"] * a, px + p["atr_target_multiple"] * a, p["max_hold_hours"] / 24), strength))
    return out


def replay_rsi2(bars: list[Bar], p: dict) -> list[tuple[int, Plan]]:
    out = []
    for i in range(p["sma_trend"] + 2, len(bars)):
        closes = [b.c for b in bars[: i + 1]]  # Connors enters at the close
        a, trend, ex, r = atr(bars[:i], 14), sma(closes, p["sma_trend"]), sma(closes, p["sma_exit"]), rsi(closes, 2)
        if None in (a, trend, ex, r) or a <= 0:
            continue
        px = closes[-1]
        if px > trend and r < p["rsi_max"]:
            out.append((i, Plan(px, px - p["atr_stop_multiple"] * a, max(ex, px + p["min_target_atr"] * a), p["max_hold_hours"] / 24)))
    return out


def replay_tom(bars: list[Bar], p: dict) -> list[tuple[int, Plan]]:
    out = []
    for i in range(16, len(bars)):
        d = datetime.fromisoformat(bars[i].t)
        nxt = (d.replace(day=1) + timedelta(days=32)).replace(day=1)
        days_in_month = (nxt - timedelta(days=1)).day
        if d.day != days_in_month - p["last_days"] + 1:  # enter at the open of the window's first day
            continue
        a = atr(bars[:i], 14)
        if a is None:
            continue
        hold = (nxt.replace(day=p["exit_day"]) - d).days
        px = bars[i].o
        out.append((i, Plan(px, px - p["atr_stop_multiple"] * a, px + p["atr_target_multiple"] * a, hold)))
    return out


# ---------------------------------------------------------------- driver

def _h() -> dict[str, str]:
    k, s = os.environ.get("ALPACA_KEY_ID"), os.environ.get("ALPACA_SECRET")
    return {"APCA-API-KEY-ID": k, "APCA-API-SECRET-KEY": s} if k and s else {}


def daily_bars(symbol: str, crypto: bool, start: str) -> list[Bar]:
    url = f"{DATA}/v1beta3/crypto/us/bars" if crypto else f"{DATA}/v2/stocks/bars"
    params = {"symbols": symbol, "timeframe": "1Day", "start": start, "limit": 10000}
    if not crypto:
        params.update({"feed": "iex", "adjustment": "all"})
    out: list[Bar] = []
    for _ in range(20):
        r = requests.get(url, params=params, headers=_h(), timeout=30)
        r.raise_for_status()
        d = r.json()
        out += [Bar(b["t"][:10], b["o"], b["h"], b["l"], b["c"]) for b in (d.get("bars") or {}).get(symbol) or []]
        if not d.get("next_page_token"):
            break
        params["page_token"] = d["next_page_token"]
    return out


def run_trades(entries: list, bars: list[Bar], arena: str) -> list[tuple[str, float]]:
    """One position per symbol at a time: skip entries while the previous trade is still open."""
    trades, free_at = [], -1
    for e in entries:
        i, plan = e[0], e[1]
        if i <= free_at:
            continue
        res = simulate(bars, i, plan, arena)
        if res is None:
            continue
        r, j = res
        trades.append((bars[i].t, round(r, 4)))
        free_at = j
    return trades


def score(rs_by_date: list[tuple[str, float]]) -> dict:
    rs = [r for _, r in sorted(rs_by_date)]
    if not rs:
        return {"n": 0}
    s = M.strategy_stats(rs)
    cut = (2 * len(rs)) // 3
    return {
        **s,
        "max_dd_r": round(M.max_drawdown_r(rs), 2),
        "first_two_thirds_r": round(sum(rs[:cut]) / max(1, cut), 3),
        "last_third_r": round(sum(rs[cut:]) / max(1, len(rs) - cut), 3) if len(rs) > cut else None,
    }


def backtest_job(doctrine_path: Path, now_ms: int, run_url: str | None) -> dict:
    d = yaml.safe_load(doctrine_path.read_text())
    st = {s["id"]: s for s in d["strategies"]}
    start = (datetime.now(timezone.utc) - timedelta(days=365 * YEARS)).strftime("%Y-%m-%dT00:00:00Z")
    cache: dict[str, list[Bar]] = {}

    def bars(sym: str) -> list[Bar]:
        if sym not in cache:
            cache[sym] = daily_bars(sym, "/" in sym, start)
        return cache[sym]

    btc = {b.t: b for b in bars("BTC/USD")}
    trades: dict[str, list[tuple[str, float]]] = {}

    def add(sid: str, sym: str, entries: list, arena: str) -> None:
        trades.setdefault(sid, []).extend(run_trades(entries, bars(sym), arena))

    s = st.get("CRYPTO_BREAKOUT_BASELINE_V1")
    if s:
        for sym in s["universe"]:
            add(s["id"], sym, replay_breakout(bars(sym), btc, s["params"]), "CRYPTO")
    s = st.get("CRYPTO_OVERSOLD_BOUNCE_V1")
    if s:
        for sym in s["universe"]:
            add(s["id"], sym, replay_bounce(bars(sym), s["params"]), "CRYPTO")
    s = st.get("EQUITY_INVERSE_BREAKOUT_V1")
    if s:
        for sym in s["universe"]:
            under = {b.t: b for b in bars(INVERSE_UNDERLYING[sym])}
            add(s["id"], sym, replay_inverse(bars(sym), under, s["params"]), "EQUITIES")
    s = st.get("CRYPTO_TREND_V1")
    if s:
        # rank: keep the strongest max_new_per_run trends per day across the universe
        per_day: dict[str, list[tuple[float, str, int, Plan]]] = {}
        for sym in s["universe"]:
            for i, plan, strength in replay_trend(bars(sym), s["params"]):
                per_day.setdefault(bars(sym)[i].t, []).append((strength, sym, i, plan))
        keep: dict[str, list] = {}
        for _, xs in per_day.items():
            for strength, sym, i, plan in sorted(xs, reverse=True)[: s["params"]["max_new_per_run"]]:
                keep.setdefault(sym, []).append((i, plan))
        for sym, entries in keep.items():
            add(s["id"], sym, sorted(entries, key=lambda e: e[0]), "CRYPTO")
    s = st.get("EQUITY_RSI2_PULLBACK_V1")
    if s:
        for sym in s["universe"]:
            add(s["id"], sym, replay_rsi2(bars(sym), s["params"]), "EQUITIES")
    s = st.get("CRYPTO_TURN_OF_MONTH_V1")
    if s:
        for sym in s["universe"]:
            add(s["id"], sym, replay_tom(bars(sym), s["params"]), "CRYPTO")

    results = {sid: score(ts) for sid, ts in trades.items()}
    adj = M.bh_fdr({sid: r.get("p_value") for sid, r in results.items()})
    # audit W2-28: deflate each Sharpe by how many strategies were tried; W2-27: PBO across the lab on a monthly
    # calendar (does the in-sample winner keep winning out of sample?)
    n_trials = max(1, len(results))
    months = sorted({str(t)[:7] for ts in trades.values() for t, _ in ts})
    monthly = {sid: [sum(r for t, r in ts if str(t)[:7] == m) for m in months] for sid, ts in trades.items()}
    pbo = M.pbo_cscv(monthly)
    for sid, r in results.items():
        d_ = M.deflated_sharpe([x for _, x in sorted(trades[sid])], n_trials)
        r["dsr"] = d_["dsr"] if d_ else None
        r["q_value"] = adj.get(sid)
        r["status"] = st[sid]["status"]
        r["lab"] = sid in (d.get("lab") or {}).get("strategies", [])
        r["verdict"] = verdict(r)
    body = {
        "years": YEARS,
        "start": start[:10],
        "fees_per_side": FEE,
        "results": results,
        "pbo": pbo,
        "limits": "daily bars, pessimistic stop-first fills, taker fees, each strategy alone, results in R; "
        "inverse-ETF regime approximated by the underlying below its 50-day average",
    }
    item = P.item("backtest-lab", "bt@1", now_ms, P.dumps(body).encode(), body)
    return P.batch("backtest", now_ms, run_url, [item], None)


def verdict(r: dict) -> str:
    """Plain-language call. PASS needs a positive edge that survives the multiple-testing correction, holds up in the
    last third of the sample, and has a deflated Sharpe ≥ 0.95."""
    n, e, q, late = r.get("n", 0), r.get("expectancy_r"), r.get("q_value"), r.get("last_third_r")
    dsr = r.get("dsr")
    if n < 20:
        return "TOO FEW TRADES"
    if e is None or e <= 0:
        return "LOSES"
    # audit W2-28: also the deflated Sharpe — the edge must beat the best of n_trials lucky strategies
    if q is not None and q < 0.1 and late is not None and late > 0 and (dsr is None or dsr >= 0.95):
        return "PASS"
    return "UNPROVEN"
