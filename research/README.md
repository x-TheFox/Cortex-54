# research/ — Python batch jobs (GitHub Actions)

Lands in Phase 2 (`docs/ROADMAP.md`). Everything here runs on free GitHub Actions runners, never in the
Worker.

Planned layout:

```
research/
  pyproject.toml          uv-managed; pins upstream skill repos by commit
  cortex_research/
    ingest.py             HMAC-signed POST to cortex /ingest/batch (produced_at, inputs_sha256, run_url)
    jobs/                 equity_preopen.py, crypto_regime.py, weekly_cot.py, insider_form4.py
    governor/             calibration.py, brier.py, monte_carlo.py, bh_fdr.py, rejection_grader.py, pr.py
    temporal_fence.py     no data with as_of > T_sim in replays
  fixtures/generate.py    parity fixtures for ts-hot ports → test/fixtures/
```

Rules:
- Data sources from `docs/DATA_SOURCES.md` only. No Binance/Bybit (US geo-block on runners).
- Every payload carries `skill_id`, `version`, `as_of`, `produced_at`, `inputs_sha256`, `provenance[]`.
- The Governor only opens pull requests against `config/`; it never writes to the live brain directly.
