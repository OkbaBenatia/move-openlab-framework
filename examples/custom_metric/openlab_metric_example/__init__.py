"""Example custom metric for MOVE OpenLab: CO2 avoided per served rider.

Installed with ``pip install ./examples/custom_metric`` into the platform's environment, it appears for the
ride-matching problem only (``problems``), next to the shipped example ``detour-per-served-rider``.

Inputs (``requires``): the CO2 figures the platform computed from the validated decisions (``domain.avoided_g``)
and the validator's count of served riders (``served``). A scenario without complete CO2 figures (no vehicle data,
a missing emission factor) gets no value — never a guessed one. Avoided CO2 can be negative (detours emit more than
the baseline); the metric keeps the sign.

Aggregation: ratio of sums — Σ avoided / Σ served over the scenarios, in kg CO2e per served rider.
"""
from move_openlab.custom_metrics import MetricSpec


def _avoided_per_served(ctx):
    if not ctx["domain"].get("complete"):          # incomplete CO2 figures: no value rather than a partial one
        return None
    return (ctx["domain"]["avoided_g"] / 1000.0, ctx["metrics"]["served"])


CO2_AVOIDED_PER_SERVED_RIDER = MetricSpec(
    id="co2-avoided-per-served-rider", version="1.0.0", name="CO₂ avoided per served rider", unit="kg",
    direction="higher", problems=("public-ride-matching",), requires=("served", "domain.avoided_g"),
    aggregate="ratio-of-sums", compute=_avoided_per_served,
    description="CO2 avoided against the experiment's baseline, divided by the riders served (validated figures).",
    provenance="MOVE OpenLab example package examples/custom_metric, public")
