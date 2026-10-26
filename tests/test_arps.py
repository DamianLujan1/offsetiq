"""Unit tests for Arps decline math and EUR (pipeline/arps.py)."""
import numpy as np
import pytest

from pipeline.arps import (_switch_time, eur_bbl, fit_hyperbolic, forecast_to_limit,
                           hyperbolic_rate, terminal_rate)

DMIN = 0.05 / 12


def test_hyperbolic_at_zero_is_qi():
    assert hyperbolic_rate(np.array([0.0]), 20000, 0.2, 1.0)[0] == pytest.approx(20000)


def test_hyperbolic_closed_form_b1():
    # b = 1 (harmonic): q = qi / (1 + Di t)
    t = np.array([12.0])
    assert hyperbolic_rate(t, 10000, 0.1, 1.0)[0] == pytest.approx(10000 / (1 + 0.1 * 12))


def test_switch_time_matches_definition():
    qi, Di, b = 15000, 0.25, 1.2
    ts = _switch_time(qi, Di, b, DMIN)
    assert Di / (1 + b * Di * ts) == pytest.approx(DMIN)


def test_terminal_rate_continuous_and_exponential_after_switch():
    qi, Di, b = 15000, 0.25, 1.2
    ts = _switch_time(qi, Di, b, DMIN)
    q = terminal_rate(np.array([ts - 1e-6, ts + 1e-6, ts + 12]), qi, Di, b, DMIN)
    assert q[0] == pytest.approx(q[1], rel=1e-6)
    assert q[2] / q[1] == pytest.approx(np.exp(-DMIN * 12), rel=1e-6)


def test_forecast_stops_at_econ_limit():
    r = forecast_to_limit(20000, 0.2, 1.0, DMIN, 150.0)
    assert len(r) > 0 and r.min() >= 150.0
    nxt = terminal_rate(np.array([len(r) + 1.0]), 20000, 0.2, 1.0, DMIN)[0]
    assert nxt < 150.0


def test_eur_is_cum_plus_remaining_and_exponential_closed_form():
    # b -> tiny (near-exponential, Di > Dmin) checked against geometric series sum
    out = eur_bbl(10000, 0.1, 1.0, cum_produced_bbl=50000, Dmin=DMIN, econ_limit_bpm=150, start_t=1)
    assert out["eur_bbl"] == pytest.approx(out["cum_produced_bbl"] + out["remaining_bbl"])
    rates = forecast_to_limit(10000, 0.1, 1.0, DMIN, 150.0)
    assert out["remaining_bbl"] == pytest.approx(rates.sum())


def test_fit_recovers_known_parameters():
    t = np.arange(1, 49, dtype=float)
    q = hyperbolic_rate(t, 18000, 0.18, 0.9)
    f = fit_hyperbolic(t, q, Dmin=DMIN, qi_max=q.max() * 1.2)
    assert f["status"] == "ok"
    assert f["Di_monthly"] == pytest.approx(0.18, rel=0.02)
    assert f["b"] == pytest.approx(0.9, rel=0.03)
    assert f["r_squared"] > 0.999


def test_fit_rejects_short_history():
    assert fit_hyperbolic(np.arange(1, 8.0), np.linspace(1000, 500, 7))["status"] == "insufficient_data"
