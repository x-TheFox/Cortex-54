"""Kronos forecasts for the brain (ADR-041).

Kronos (shiyu-coder/Kronos, MIT) is a foundation model for candlesticks. We run it from a pinned checkout (never
copied, like the upstream skills) on GitHub's free CPU runners: for each crypto pair, N independent sampled paths of
the next 48 h of 4-hour candles. The paths become probabilities — never sizes (constitution U2):

- p_up: share of paths closing above the last price at the horizon
- p_target_first / p_stop_first: share of paths touching the strategy's target (or stop) first, using the same ATR
  multiples the brain will use for the contract (read from config/doctrine.yaml, one source of truth)
- p_win: share of paths that end profitable for that trade (first touch, else marked at the horizon)

The summary math is pure numpy and tested without torch; only `forecast_paths` needs the model.
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import requests
import yaml

from . import payload as P

STRATEGY_ID = "CRYPTO_KRONOS_FORECAST_V1"
DATA = "https://data.alpaca.markets"
MODEL = "NeoQuasar/Kronos-base"  # operator 2026-10-24: base (102M), not small
TOKENIZER = "NeoQuasar/Kronos-Tokenizer-base"
MAX_CONTEXT = 512


def strategy(doctrine_path: Path) -> dict:
    d = yaml.safe_load(doctrine_path.read_text())
    s = next((x for x in d["strategies"] if x["id"] == STRATEGY_ID), None)
    if s is None:
        raise KeyError(f"{STRATEGY_ID} missing from doctrine")
    return s


def atr(high: np.ndarray, low: np.ndarray, close: np.ndarray, period: int = 14) -> float | None:
    """Wilder ATR, matching src/strategy/indicators.ts."""
    if len(close) < period + 1:
        return None
    tr = np.maximum(high[1:] - low[1:], np.maximum(abs(high[1:] - close[:-1]), abs(low[1:] - close[:-1])))
    v = float(tr[:period].mean())
    for x in tr[period:]:
        v = (v * (period - 1) + float(x)) / period
    return v


def vol_scale(closes_hist: np.ndarray, path_end: np.ndarray, last: float, steps: int) -> float:
    """Kronos samples are far tighter than reality (48 h band ±1% vs ~2.6% daily ATR on BTC, 2026-10-24). Scale
    path moves so their spread matches the realized `steps`-candle volatility; keeps the model's direction and shape."""
    if len(closes_hist) <= steps + 10:
        return 1.0
    realized = float(np.std(np.log(closes_hist[steps:] / closes_hist[:-steps])))
    model = float(np.std(np.log(path_end / last)))
    if model <= 0:
        return 1.0
    return float(np.clip(realized / model, 1.0, 10.0))


def rescale(a: np.ndarray, last: float, k: float) -> np.ndarray:
    return last * (1 + (a / last - 1) * k)


def fan_chart(hist_bars: list[dict], closes: np.ndarray, hist_n: int = 42) -> dict:
    """For the panel (ADR-047): the last `hist_n` candle closes and the 10/50/90% band of the sampled future closes."""
    q = np.quantile(closes, [0.1, 0.5, 0.9], axis=0)
    sig = lambda xs: [float(f"{x:.6g}") for x in xs]  # noqa: E731
    return {
        "hist": sig([b["c"] for b in hist_bars[-hist_n:]]),
        "fan": {"p10": sig(q[0]), "p50": sig(q[1]), "p90": sig(q[2])},
    }


def summarize(highs: np.ndarray, lows: np.ndarray, closes: np.ndarray, last: float, stop: float, target: float) -> dict:
    """Probabilities from sampled paths, shape (n_paths, horizon). Same-candle touches count as the stop (pessimistic)."""
    n, _ = closes.shape
    hit_t = highs >= target
    hit_s = lows <= stop
    big = closes.shape[1] + 1
    first_t = np.where(hit_t.any(axis=1), hit_t.argmax(axis=1), big)
    first_s = np.where(hit_s.any(axis=1), hit_s.argmax(axis=1), big)
    target_first = first_t < first_s
    stop_first = (first_s <= first_t) & (first_s < big)
    neither = ~target_first & ~stop_first
    end = closes[:, -1]
    win = target_first | (neither & (end > last))
    ret = end / last - 1
    return {
        "paths": int(n),
        "p_up": round(float((end > last).mean()), 4),
        "p_target_first": round(float(target_first.mean()), 4),
        "p_stop_first": round(float(stop_first.mean()), 4),
        "p_win": round(float(win.mean()), 4),
        "exp_ret": round(float(ret.mean()), 5),
        "q10_ret": round(float(np.quantile(ret, 0.1)), 5),
        "q90_ret": round(float(np.quantile(ret, 0.9)), 5),
    }


def _h() -> dict[str, str]:
    k, s = os.environ.get("ALPACA_KEY_ID"), os.environ.get("ALPACA_SECRET")
    return {"APCA-API-KEY-ID": k, "APCA-API-SECRET-KEY": s} if k and s else {}


def crypto_bars(symbols: list[str], timeframe: str, days: int) -> dict[str, list[dict]]:
    """One request series per symbol: authenticated multi-symbol paging silently dropped later symbols (2026-10-24)."""
    start = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:00:00Z")
    out: dict[str, list[dict]] = {}
    for sym in symbols:
        params = {"symbols": sym, "timeframe": timeframe, "start": start, "limit": 10000}
        for _ in range(10):
            r = requests.get(f"{DATA}/v1beta3/crypto/us/bars", params=params, headers=_h(), timeout=30)
            r.raise_for_status()
            d = r.json()
            out.setdefault(sym, []).extend((d.get("bars") or {}).get(sym) or [])
            tok = d.get("next_page_token")
            if not tok:
                break
            params["page_token"] = tok
    return out


def load_predictor(kronos_dir: Path):
    sys.path.insert(0, str(kronos_dir))
    import torch  # noqa: PLC0415 - heavy, only in the kronos job
    from model import Kronos, KronosPredictor, KronosTokenizer  # type: ignore  # noqa: PLC0415

    torch.manual_seed(54)
    torch.set_num_threads(max(1, os.cpu_count() or 1))
    tok = KronosTokenizer.from_pretrained(TOKENIZER)
    model = Kronos.from_pretrained(MODEL)
    return KronosPredictor(model, tok, device="cpu", max_context=MAX_CONTEXT)


def forecast_paths(predictor, bars: list[dict], horizon: int, n_paths: int, candle_hours: int = 4):
    """n_paths independent single-sample forecasts in one batch → (highs, lows, closes) arrays (n_paths, horizon)."""
    import pandas as pd  # noqa: PLC0415

    df = pd.DataFrame(
        {"open": [b["o"] for b in bars], "high": [b["h"] for b in bars], "low": [b["l"] for b in bars],
         "close": [b["c"] for b in bars], "volume": [b["v"] for b in bars]}
    ).astype("float64")
    df["amount"] = df["volume"] * df[["open", "high", "low", "close"]].mean(axis=1)
    ts = pd.Series(pd.to_datetime([b["t"] for b in bars], utc=True)).dt.tz_localize(None)
    future = pd.Series(pd.date_range(ts.iloc[-1] + pd.Timedelta(hours=candle_hours), periods=horizon, freq=f"{candle_hours}h"))
    preds = predictor.predict_batch(
        [df] * n_paths, [ts] * n_paths, [future] * n_paths, pred_len=horizon, T=1.0, top_p=0.9, sample_count=1,
        verbose=False,
    )
    highs = np.stack([p["high"].to_numpy() for p in preds])
    lows = np.stack([p["low"].to_numpy() for p in preds])
    closes = np.stack([p["close"].to_numpy() for p in preds])
    # a sampled candle can come back with high < close; keep the envelope consistent
    highs = np.maximum(highs, closes)
    lows = np.minimum(lows, closes)
    return highs, lows, closes


def kronos_job(kronos_dir: Path, doctrine_path: Path, now_ms: int, version: str, run_url: str | None) -> dict | None:
    s = strategy(doctrine_path)
    p = s["params"]
    universe: list[str] = s["universe"]
    candles = crypto_bars(universe, f"{p['candle_hours']}Hour", p["lookback_hours"] // 24 + 3)
    daily = crypto_bars(universe, "1Day", 40)
    predictor = load_predictor(kronos_dir)
    forecasts: list[dict] = []
    failed: list[str] = []
    for sym in universe:
        try:
            hb = (candles.get(sym) or [])[-(p["lookback_hours"] // p["candle_hours"]):]
            db = daily.get(sym) or []
            if len(hb) < 60 or len(db) < 16:
                failed.append(f"{sym}: not enough bars")
                continue
            a = atr(np.array([b["h"] for b in db]), np.array([b["l"] for b in db]), np.array([b["c"] for b in db]))
            last = float(hb[-1]["c"])
            if not a or a <= 0:
                failed.append(f"{sym}: no ATR")
                continue
            stop, target = last - p["atr_stop_multiple"] * a, last + p["atr_target_multiple"] * a
            steps = p["horizon_hours"] // p["candle_hours"]
            hi, lo, cl = forecast_paths(predictor, hb, steps, p["paths"], p["candle_hours"])
            k = vol_scale(np.array([b["c"] for b in hb], dtype=float), cl[:, -1], last, steps)
            raw = summarize(hi, lo, cl, last, stop, target)
            f = {"symbol": sym, "last": last, "last_bar_at": hb[-1]["t"], "atr": round(a, 8), "stop": stop,
                 "target": target, "vol_scale": round(k, 3), "raw_p_up": raw["p_up"], "raw_exp_ret": raw["exp_ret"],
                 **summarize(rescale(hi, last, k), rescale(lo, last, k), rescale(cl, last, k), last, stop, target)}
            f.update(fan_chart(hb, rescale(cl, last, k)))
            forecasts.append(f)
            print(f"{sym}: p_win {f['p_win']:.2f} target-first {f['p_target_first']:.2f} stop-first {f['p_stop_first']:.2f} "
                  f"exp {f['exp_ret'] * 100:+.2f}%")
        except Exception as e:  # noqa: BLE001 - one pair failing never drops the batch
            failed.append(f"{sym}: {str(e)[:120]}")
    if not forecasts:
        print(f"kronos: no forecasts ({failed[:3]})", file=sys.stderr)
        return None
    body = {"model": MODEL, "candle_hours": p["candle_hours"], "horizon_hours": p["horizon_hours"], "paths": p["paths"],
            "atr_stop_multiple": p["atr_stop_multiple"], "atr_target_multiple": p["atr_target_multiple"],
            "forecasts": forecasts, "failed": failed[:20]}
    item = P.item("kronos-forecast", version, now_ms, P.dumps(body).encode(), body)
    return P.batch("kronos", now_ms, run_url, [item], None)
