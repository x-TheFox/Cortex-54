# Portions Copyright (c) 2026 staskh, MIT License (full text in NOTICE.md).
"""Black-Scholes price, delta and implied volatility (pure).

Ported from staskh/trading_skills `src/trading_skills/black_scholes.py` (MIT, commit
b71a74fe327b12e314fc96618d7131dca4638ab3; see NOTICE.md). Changes: scipy.stats.norm replaced by math.erf so the
batch job needs no scipy; only the functions the shadow lab uses are kept.
"""

from __future__ import annotations

import math


def norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def _d1_d2(S: float, K: float, T: float, r: float, sigma: float, q: float = 0.0) -> tuple[float, float]:
    sqrt_t = math.sqrt(T)
    d1 = (math.log(S / K) + (r - q + 0.5 * sigma**2) * T) / (sigma * sqrt_t)
    return d1, d1 - sigma * sqrt_t


def price(S: float, K: float, T: float, r: float, sigma: float, kind: str, q: float = 0.0) -> float:
    if T <= 0 or sigma <= 0:
        return max(0.0, S - K) if kind == "call" else max(0.0, K - S)
    d1, d2 = _d1_d2(S, K, T, r, sigma, q)
    if kind == "call":
        return S * math.exp(-q * T) * norm_cdf(d1) - K * math.exp(-r * T) * norm_cdf(d2)
    return K * math.exp(-r * T) * norm_cdf(-d2) - S * math.exp(-q * T) * norm_cdf(-d1)


def vega(S: float, K: float, T: float, r: float, sigma: float, q: float = 0.0) -> float:
    if T <= 0 or sigma <= 0:
        return 0.0
    d1, _ = _d1_d2(S, K, T, r, sigma, q)
    return S * math.exp(-q * T) * norm_pdf(d1) * math.sqrt(T)


def delta(S: float, K: float, T: float, r: float, sigma: float, kind: str, q: float = 0.0) -> float:
    if T <= 0 or sigma <= 0:
        if kind == "call":
            return 1.0 if S > K else 0.0
        return -1.0 if S < K else 0.0
    d1, _ = _d1_d2(S, K, T, r, sigma, q)
    return math.exp(-q * T) * (norm_cdf(d1) if kind == "call" else norm_cdf(d1) - 1.0)


def implied_vol(market: float, S: float, K: float, T: float, r: float, kind: str, q: float = 0.0) -> float | None:
    """Newton-Raphson with a bisection fallback; None when the price is below intrinsic or T ≤ 0."""
    if market <= 0 or T <= 0:
        return None
    intrinsic = max(0.0, S - K) if kind == "call" else max(0.0, K - S)
    if market < intrinsic * math.exp(-r * T) - 1e-9:
        return None
    sigma = 0.3
    for _ in range(100):
        diff = price(S, K, T, r, sigma, kind, q) - market
        if abs(diff) < 1e-6:
            return sigma
        v = vega(S, K, T, r, sigma, q)
        if v < 1e-10:
            break
        sigma = min(5.0, max(0.001, sigma - diff / v))
    lo, hi = 0.001, 5.0
    for _ in range(100):
        mid = (lo + hi) / 2
        p = price(S, K, T, r, mid, kind, q)
        if abs(p - market) < 1e-6:
            return mid
        lo, hi = (lo, mid) if p > market else (mid, hi)
    return (lo + hi) / 2
