"""Example registered custom metric for MOVE OpenLab: CO2 avoided per served rider.

A metric file is third-party code: the platform never imports it. Its ``METADATA`` is read statically; a researcher
registers it for their workspace (the SHA-256 of this file is pinned and a self-test runs in the sandbox), and from
then on it is computed in the verified sandbox, scenario by scenario, from the figures the platform established:

* ``served`` — riders served, recomputed by the problem's independent validator;
* ``domain.avoided_g`` and ``domain.complete`` — the CO2 figures the platform computed from the validated decisions.

A scenario without complete CO2 figures (no vehicle data, a missing emission factor) gets no value, never a guessed
one. Avoided CO2 can be negative (detours emit more than the baseline); the metric keeps the sign.

Aggregation: ratio of sums — Σ avoided / Σ served over the scenarios, in kg CO2e per served rider.

Register it (approved plugin directory = this repository's ``plugins/``, plugin mode ``sandbox``)::

    POST /api/lab/metrics/register  {"problem_id": "public-ride-matching", "plugin": "co2_avoided_per_served_rider"}
"""

METADATA = {
    "id": "co2-avoided-per-served-rider",
    "version": "1.0.0",
    "name": "CO₂ avoided per served rider",
    "unit": "kg",
    "direction": "higher",
    "problems": ["public-ride-matching"],
    "requires": ["served", "domain.avoided_g", "domain.complete"],
    "aggregate": "ratio-of-sums",
    "description": "CO2 avoided against the experiment's baseline, divided by the riders served (validated figures).",
    "provenance": "MOVE OpenLab example metric plugins/co2_avoided_per_served_rider, public",
}


def compute(ctx):
    if not ctx["domain"]["complete"]:              # incomplete CO2 figures: no value rather than a partial one
        return None
    return (ctx["domain"]["avoided_g"] / 1000.0, ctx["metrics"]["served"])
