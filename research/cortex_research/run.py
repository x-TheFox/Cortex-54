"""Entry point for the GitHub Actions research jobs.

    python -m cortex_research.run crypto   [--dry-run]
    python -m cortex_research.run equity   [--dry-run]

Env:
    UPSTREAM_DIR          checkout of tradermonty/claude-trading-skills at UPSTREAM_SHA
    UPSTREAM_SHA          pinned commit (recorded as each item's version)
    CORTEX_URL            e.g. https://cortex.<subdomain>.workers.dev
    INGEST_HMAC_SECRET    shared with the cortex worker
    FMP_API_KEY           equity job (ftd, macro, market-top)
    GITHUB_SERVER_URL / GITHUB_REPOSITORY / GITHUB_RUN_ID   provenance link (set by Actions)
"""

from __future__ import annotations

import argparse
import glob
import hashlib
import hmac
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import requests

from . import payload as P

TIMEOUT_S = 420


def now_ms() -> int:
    return int(time.time() * 1000)


def run_url() -> str | None:
    s, r, i = os.environ.get("GITHUB_SERVER_URL"), os.environ.get("GITHUB_REPOSITORY"), os.environ.get("GITHUB_RUN_ID")
    return f"{s}/{r}/actions/runs/{i}" if s and r and i else None


def run_skill(skill: str, script: str, args: list[str], out_dir: Path) -> None:
    """Run an upstream skill script from its own directory (it imports sibling modules)."""
    upstream = Path(os.environ["UPSTREAM_DIR"]) / "skills" / skill / "scripts"
    cmd = [sys.executable, script, *args]
    res = subprocess.run(cmd, cwd=upstream, capture_output=True, text=True, timeout=TIMEOUT_S, env=os.environ.copy())
    if res.returncode != 0:
        tail = (res.stderr or res.stdout)[-800:]
        fmp = os.environ.get("FMP_API_KEY")
        if fmp:
            tail = tail.replace(fmp, "***")
        raise RuntimeError(f"{skill} failed ({res.returncode}): {tail}")


def newest(out_dir: Path, pattern: str) -> Path:
    files = sorted(glob.glob(str(out_dir / pattern)))
    if not files:
        raise FileNotFoundError(f"no output matching {pattern}")
    return Path(files[-1])


def okx_funding(symbols: tuple[str, ...] = ("BTC", "ETH", "SOL")) -> dict:
    """Perp funding from OKX public API (Binance/Bybit block US runners)."""
    rates: dict[str, float] = {}
    for s in symbols:
        try:
            r = requests.get(
                "https://www.okx.com/api/v5/public/funding-rate",
                params={"instId": f"{s}-USDT-SWAP"},
                timeout=15,
            )
            r.raise_for_status()
            data = r.json().get("data") or []
            if data:
                rates[s] = float(data[0]["fundingRate"])
        except Exception as e:  # noqa: BLE001 - a missing component is reported, never fatal
            print(f"okx funding {s} unavailable: {e}", file=sys.stderr)
    annualized = {s: r * 3 * 365 for s, r in rates.items()}
    return {
        "headline": ", ".join(f"{s} {a * 100:.1f}%/yr" for s, a in annualized.items()) or "unavailable",
        "funding_8h": rates,
        "annualized": annualized,
        "max_annualized": max(annualized.values()) if annualized else None,
        "source": "okx",
    }


def crypto_job(out: Path, version: str) -> dict:
    run_skill("crypto-regime-analyzer", "crypto_regime_analyzer.py", ["--output-dir", str(out), "--quiet"], out)
    path = out / "crypto_regime.json"
    raw = path.read_bytes()
    summary = P.summarize_crypto_regime(json.loads(raw))
    funding = okx_funding()
    t = now_ms()
    items = [
        P.item("crypto-regime-analyzer", version, t, raw, summary),
        P.item("crypto-funding-liquidation-scanner", "okx-v1", t, P.dumps(funding).encode(), funding),
    ]
    return P.batch("crypto-regime", t, run_url(), items, P.crypto_posture(summary, funding))


def equity_job(out: Path, version: str) -> dict:
    steps = [
        ("market-breadth-analyzer", "market_breadth_analyzer.py", "market_breadth_2*.json", "Breadth"),
        ("uptrend-analyzer", "uptrend_analyzer.py", "uptrend_analysis_*.json", "Uptrend"),
        ("ftd-detector", "ftd_detector.py", "ftd_detector_*.json", None),
        ("macro-regime-detector", "macro_regime_detector.py", "macro_regime_*.json", None),
        ("market-top-detector", "market_top_detector.py", "market_top_*.json", "Top risk"),
    ]
    t = now_ms()
    items: list[dict] = []
    paths: dict[str, Path] = {}
    for skill, script, pattern, label in steps:
        try:
            run_skill(skill, script, ["--output-dir", str(out)], out)
            p = newest(out, pattern)
        except Exception as e:  # noqa: BLE001 - exposure-coach handles missing inputs (lower confidence)
            print(f"{skill}: {e}", file=sys.stderr)
            continue
        paths[skill] = p
        raw = p.read_bytes()
        d = json.loads(raw)
        if skill == "ftd-detector":
            summary = P.summarize_ftd(d)
        elif skill == "macro-regime-detector":
            summary = P.summarize_macro(d)
        else:
            summary = P.summarize_composite(d, label or skill)
        items.append(P.item(skill, version, t, raw, summary))

    flags = {
        "market-breadth-analyzer": "--breadth",
        "uptrend-analyzer": "--uptrend",
        "ftd-detector": "--ftd",
        "macro-regime-detector": "--regime",
        "market-top-detector": "--top-risk",
    }
    args = [x for skill, p in paths.items() for x in (flags[skill], str(p))]
    run_skill("exposure-coach", "calculate_exposure.py", [*args, "--output-dir", str(out), "--json-only"], out)
    exp_path = newest(out, "exposure_posture_*.json")
    raw = exp_path.read_bytes()
    exposure = json.loads(raw)
    items.append(
        P.item(
            "exposure-coach",
            version,
            t,
            raw,
            {
                "headline": f"{exposure.get('recommendation')} · ceiling {exposure.get('exposure_ceiling_pct')}% · "
                f"{exposure.get('confidence')} confidence",
                "inputs_missing": exposure.get("inputs_missing"),
            },
        )
    )
    return P.batch("equity-posture", t, run_url(), items, P.equity_posture(exposure))


def world_job(version: str) -> dict | None:
    from .world import world_items

    t = now_ms()
    items, _failed = world_items("gdelt-doc-v2", t, Path(__file__).resolve().parents[2])
    if not items:
        return None
    return P.batch("world-intel", t, run_url(), items, None)


def sign_and_post(body: str) -> requests.Response:
    secret = os.environ["INGEST_HMAC_SECRET"]
    ts = str(int(time.time()))
    sig = hmac.new(secret.encode(), f"{ts}.{body}".encode(), hashlib.sha256).hexdigest()
    url = os.environ["CORTEX_URL"].rstrip("/") + "/ingest/batch"
    return requests.post(
        url,
        data=body.encode(),
        headers={"content-type": "application/json", "x-cortex-timestamp": ts, "x-cortex-signature": f"sha256={sig}"},
        timeout=30,
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("job", choices=["crypto", "equity", "world"])
    ap.add_argument("--dry-run", action="store_true", help="print the payload instead of posting")
    a = ap.parse_args()
    version = os.environ.get("UPSTREAM_SHA", "unknown")
    if a.job == "world":
        b = world_job(version)
        if b is None:
            print("world-intel: no candidates this run")
            return 0
    else:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            b = crypto_job(out, version) if a.job == "crypto" else equity_job(out, version)
    body = P.dumps(b)
    p = b["posture"]
    head = f"{p['arena']} {p['posture']} score {p['score']:.1f}" if p else f"{sum(len(i['payload'].get('candidates', [])) for i in b['items'])} candidates"
    print(f"{b['job']}: {head} ({len(b['items'])} items, {len(body)} bytes)")
    if a.dry_run:
        print(body[:2000])
        return 0
    res = sign_and_post(body)
    print(f"ingest → HTTP {res.status_code}: {res.text[:300]}")
    return 0 if res.ok else 1


if __name__ == "__main__":
    sys.exit(main())
