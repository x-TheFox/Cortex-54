# research/: Python batch jobs (GitHub Actions or the desktop job runner)

Everything here runs on GitHub Actions runners (or on the user's computer through the local job runner), never in
the Worker. Results are signed and posted to `/ingest/batch`.

```
research/
  pyproject.toml          uv-managed
  cortex_research/
    run.py                entry point: `python -m cortex_research.run crypto|equity|world|options|screeners|kronos|backtest`
                          (runs the pinned upstream skills with a scrubbed environment, signs, POSTs)
    payload.py            batch/item envelopes (skill_id, version, produced_at, inputs_sha256, provenance)
    world.py              GDELT GKG world-risk pulse, wire press releases, EDGAR
    screeners.py          Stockbee setup screeners → Tier 2 candidates
    calendar.py           earnings calendar (Nasdaq + FMP) for the 72 h blackout
    hmm.py                regime HMM context
    kronos_forecast.py    Kronos forecasts (low-confidence court context only)
    companions.py         Chronos-2 companion forecasts
    backtest.py           the weekly backtest lab (BH-FDR, deflated Sharpe, PBO; declares its survivorship bias)
    deep/                 the web research desk (agent, read-only tools, LLM chain, dossier job)
    governor/             daily/weekly Governor: grades, calibration, fitness, LIVE gate, memory proposals
    options/              the options shadow lab (Black-Scholes, structures, virtual ledger)
  tests/                  pytest (run in CI)
```

Rules:
- Data sources from `docs/DATA_SOURCES.md` only. No Binance/Bybit (US geo-block on runners).
- Every payload carries `skill_id`, `version`, `produced_at`, `inputs_sha256`, `provenance[]`.
- The Governor only opens pull requests against `config/`; it never writes to the live brain directly.
- Upstream skills get only public data keys (`run.skill_env`), never the ingest secret, broker or model keys.
