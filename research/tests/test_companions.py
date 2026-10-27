"""Kronos companion summary (ADR-069)."""

from cortex_research.companions import view


def test_view_interpolates_p_up_and_returns():
    q = {0.1: 95.0, 0.5: 101.0, 0.9: 110.0}
    v = view(q, 100.0)
    # CDF at 100: between 0.1@95 and 0.5@101 → 0.1 + 0.4 * 5/6 = 0.4333 → p_up 0.5667
    assert v["p_up"] == 0.5667
    assert v["q10_ret"] == -0.05 and v["q50_ret"] == 0.01 and v["q90_ret"] == 0.1


def test_view_tails_and_empty():
    assert view({0.1: 105.0, 0.9: 120.0}, 100.0)["p_up"] > 0.9  # everything above the last close
    assert view({0.1: 80.0, 0.9: 90.0}, 100.0)["p_up"] < 0.1
    assert view({}, 100.0) == {}


def test_forecast_uses_the_pipeline_output_shape():
    import pandas as pd

    from cortex_research.companions import forecast

    class Fake:
        def predict_df(self, df, prediction_length, quantile_levels, **kw):
            assert prediction_length == 2 and len(df) == 40
            return pd.DataFrame([{str(q): 100 + (q - 0.5) * 20 for q in quantile_levels}] * prediction_length)

    bars = [{"t": f"2026-10-{1 + i // 24:02d}T{i % 24:02d}:00:00Z", "c": 100.0} for i in range(40)]
    out = forecast(Fake(), bars, 2, "h")
    assert out["model"].endswith("chronos-2") and abs(out["p_up"] - 0.5) < 0.01
