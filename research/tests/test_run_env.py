"""Audit F-B1-01/02: upstream skills run with a scrubbed environment and error tails are redacted."""

from cortex_research.run import redact, skill_env


def test_skill_env_keeps_data_keys_and_basics_only():
    env = {
        "PATH": "/usr/bin",
        "HOME": "/home/x",
        "FMP_API_KEY": "fmp123456",
        "INGEST_HMAC_SECRET": "hmac-secret-value",
        "ALPACA_SECRET": "alpaca-secret",
        "GROQ_API_KEY": "gsk_abcdef",
        "PYTHONPATH": "/x",
    }
    got = skill_env(env)
    assert got == {"PATH": "/usr/bin", "HOME": "/home/x", "FMP_API_KEY": "fmp123456", "PYTHONPATH": "/x"}


def test_redact_scrubs_every_secret_value():
    env = {"INGEST_HMAC_SECRET": "hmac-secret-value", "GROQ_API_KEY": "gsk_abcdef", "PATH": "/usr/bin"}
    out = redact("boom hmac-secret-value and gsk_abcdef in /usr/bin", env)
    assert "hmac-secret-value" not in out and "gsk_abcdef" not in out and "/usr/bin" in out
