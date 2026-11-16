"""CO₂ with worked examples and unit conversions (values of the shipped presets), negative avoided emissions, and
traceability: changing a parameter, the calculation or the baseline changes what the figures depend on."""
import pytest

from move_openlab.mobility import emissions as E

from test_mobility import _instance, profile

PETROL = dict(fuel_consumption_l_100km=7.89, fuel_emission_factor_g_per_l=2075.0)      # EU real-world · UK DESNZ 2026
BEV = dict(electricity_consumption_kwh_100km=16.0, electricity_emission_factor_g_per_kwh=43.0)  # demo assumption · EEA FR


def test_worked_examples_and_units():
    # distances arrive in metres; formulas use km: 12 500 m = 12.5 km
    g, missing = E.co2_g(profile("p", "ICE", **PETROL), 12_500.0, "operational-energy")
    assert missing == [] and g == pytest.approx(12.5 * 7.89 / 100 * 2075)          # 2 046.47 g = 2.046 kg CO₂e
    assert round(g / 1000, 3) == 2.046                                             # g → kg as the interface shows
    assert E.co2_g(profile("e", "BEV", **BEV), 12_500.0, "operational-energy")[0] == pytest.approx(86.0)   # 12.5 × 0.16 × 43
    assert E.co2_g(profile("e", "BEV", **BEV), 12_500.0, "tailpipe")[0] == 0.0     # tailpipe, not life cycle
    assert E.co2_g(profile("c", "custom", direct_co2_g_per_km=120.0), 12_500.0, "direct-intensity")[0] == pytest.approx(1500.0)
    # one parameter changed → proportional change (2075 → 2310 g/L for a fossil-only petrol factor)
    g2 = E.co2_g(profile("p", "ICE", **{**PETROL, "fuel_emission_factor_g_per_l": 2310.0}), 12_500.0, "operational-energy")[0]
    assert g2 / g == pytest.approx(2310 / 2075)


def test_avoided_emissions_can_be_negative_and_are_reported_as_such():
    # the only matched pair makes the petrol driver detour 30 km, while the rider would have driven an electric car
    ev = profile("ev", "BEV", **BEV)
    inst = _instance(pet=profile("petrol", "ICE", **PETROL), default="ev")
    inst["vehicles"]["default"] = ev
    inst["pairs"][0].update(to_pickup_m=15_000.0, ride_m=5_000.0, to_dest_m=15_000.0)
    r = E.compute(inst, [["D1", "R1"]], None)
    ice = lambda m: m / 1000 * 7.89 / 100 * 2075                                   # noqa: E731
    bev = lambda m: m / 1000 * 16 / 100 * 43                                       # noqa: E731
    d2 = inst["drivers"][1]["vehicle"]                                             # the second driver's own profile
    d2g = E.co2_g(d2, 8_000.0, "operational-energy")[0]
    base = ice(10_000) + d2g + bev(5_000) + bev(4_000)
    sol = ice(35_000) + d2g + bev(4_000)
    assert r["complete"] and r["baseline_g"] == pytest.approx(base, abs=0.1) and r["solution_g"] == pytest.approx(sol, abs=0.1)
    assert r["avoided_g"] < 0 and r["avoided_g"] == pytest.approx(base - sol, abs=0.2)
    assert r["avoided_pct"] == pytest.approx(round(100 * (base - sol) / base, 2), abs=0.01) and r["avoided_pct"] < 0


def test_a_parameter_calculation_or_baseline_change_is_traceable():
    inst = _instance(pet=profile("petrol", "ICE", **PETROL))
    d0 = E.descriptor(inst, None)
    changed = _instance(pet=profile("petrol", "ICE", **{**PETROL, "fuel_consumption_l_100km": 6.5}))
    assert E.descriptor(changed, None)["fingerprint"] != d0["fingerprint"]          # new configuration, not overwritten
    assert E.descriptor(inst, dict(emissions=dict(scope="tailpipe", baseline="everyone-drives-alone")))["fingerprint"] != d0["fingerprint"]
    assert E.descriptor(inst, dict(emissions=dict(scope="operational-energy", baseline="drivers-only")))["fingerprint"] != d0["fingerprint"]
    assert E.descriptor(_instance(pet=profile("petrol", "ICE", **PETROL)), None)["fingerprint"] == d0["fingerprint"]
    # a missing factor is never replaced: the figures are reported incomplete
    gap = E.compute(_instance(missing=True), [["D1", "R1"]], None)
    assert gap["complete"] is False and any("fuel_emission_factor_g_per_l" in m for m in gap["missing"])
