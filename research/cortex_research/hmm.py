"""Two-state Gaussian HMM on daily log returns (audit W2-29). numpy only, Baum–Welch with scaling, fixed seed.

State 0/1 are re-labelled so state 1 is the high-volatility regime. Output is context for the court (LOW
confidence); it does not size anything until the Governor shows the gate would have earned its keep."""

from __future__ import annotations

import math

import numpy as np


def _gauss(x: np.ndarray, mu: float, sd: float) -> np.ndarray:
    sd = max(sd, 1e-6)
    return np.exp(-0.5 * ((x - mu) / sd) ** 2) / (sd * math.sqrt(2 * math.pi))


def fit_hmm(r: np.ndarray, iters: int = 60) -> dict | None:
    """Returns {p_high_vol_now, persist_high, persist_low, vol_low, vol_high, days} or None (too little data)."""
    r = np.asarray(r, dtype=float)
    r = r[np.isfinite(r)]
    n = len(r)
    if n < 120:
        return None
    sd = float(np.std(r))
    mu = np.array([float(np.mean(r))] * 2)
    sig = np.array([sd * 0.6, sd * 1.6])
    A = np.array([[0.95, 0.05], [0.05, 0.95]])
    pi = np.array([0.5, 0.5])
    for _ in range(iters):
        B = np.vstack([_gauss(r, mu[k], sig[k]) for k in range(2)]).T + 1e-300  # (n, 2)
        alpha = np.zeros((n, 2))
        c = np.zeros(n)
        alpha[0] = pi * B[0]
        c[0] = alpha[0].sum()
        alpha[0] /= c[0]
        for t in range(1, n):
            alpha[t] = (alpha[t - 1] @ A) * B[t]
            c[t] = alpha[t].sum()
            alpha[t] /= c[t]
        beta = np.ones((n, 2))
        for t in range(n - 2, -1, -1):
            beta[t] = (A @ (B[t + 1] * beta[t + 1])) / c[t + 1]
        gamma = alpha * beta
        gamma /= gamma.sum(axis=1, keepdims=True)
        xi = np.zeros((2, 2))
        for t in range(n - 1):
            x = np.outer(alpha[t], B[t + 1] * beta[t + 1]) * A
            xi += x / x.sum()
        pi = gamma[0]
        A = xi / xi.sum(axis=1, keepdims=True)
        w = gamma.sum(axis=0)
        mu = (gamma * r[:, None]).sum(axis=0) / w
        sig = np.sqrt((gamma * (r[:, None] - mu) ** 2).sum(axis=0) / w)
    hi = int(np.argmax(sig))
    lo = 1 - hi
    return {
        "p_high_vol_now": round(float(alpha[-1][hi]), 3),
        "persist_high": round(float(A[hi, hi]), 3),
        "persist_low": round(float(A[lo, lo]), 3),
        "vol_low_daily": round(float(sig[lo]), 5),
        "vol_high_daily": round(float(sig[hi]), 5),
        "days": n,
    }
