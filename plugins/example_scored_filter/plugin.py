"""Example of an ML-assisted method for the public ride-matching problem — Scored Pair Filter + Greedy.

**This is an example of the interface, not a trained model and not a research result.** The "model" below is a linear
score with two weights written by hand (``WEIGHTS``): nothing was learned from data. It exists so that a researcher
can see, on a public installation and without any private package, how a method that scores candidates is added
(*Add method*), run, and then evaluated from evidence (*Compare › Methods › ML evaluation › Import evaluation
evidence*, docs/ML_INTEGRATION.md). Replace ``score`` with your own model to make it a real learned method.

Method:

1. **Score** every compatible driver–rider pair in [0, 1] from two features known before solving: the pair's detour
   relative to the scenario's detour limit, and the driver's time to the pickup point relative to the largest one in
   the scenario. A higher score means a more promising pair.
2. **Filter**: keep the pairs whose score is at least ``threshold`` (0.35).
3. **Match** greedily on the kept pairs, smallest detour first (ties: time to pickup, driver id, rider id).

A rider whose pairs are all removed stays unserved: that is the trade-off a filter makes, and the platform shows it
(the validator recomputes every figure; nothing declared here is trusted).

It declares ``kind: "learned"`` because its decisions come from a scorer followed by a simple rule: the platform then
never reports its result as proven optimal, and offers the ML evaluation for it. No evaluation figure is shipped for
it: accuracy, precision or recall appear only after evidence — this scorer's own decisions against labels you define
(for example: *the pair is used by the exact method's validated solution*) on scenarios you name — is imported.

Contract (docs/EXTENDING.md): METADATA is a literal read without running this file; solve(instance, config) returns
the decisions [driver_id, rider_id]. Standard library only; runs in the verified sandbox.
"""
from __future__ import annotations

METADATA = {
    "method_id": "example-scored-filter-greedy",
    "name": "Example: scored pair filter + greedy",
    "version": "1.0.0",
    "kind": "learned",
    "problem_id": "public-ride-matching",
    "objective_spec_id": "lex-max-served-riders-then-min-detour/1.0.0",
    "deterministic": True,
    "author": "MOVE OpenLab example",
    "description": "EXAMPLE of an ML-assisted method, not a trained model: a hand-written linear score of each compatible "
                   "pair (relative detour, relative time to pickup) removes the pairs scored below 0.35, then a greedy "
                   "match (smallest detour first) is made on the pairs that are left.",
    "default_config": {"threshold": 0.35},
}

WEIGHTS = {"relative_detour": 0.7, "relative_pickup": 0.3}      # written by hand: NOT learned from any data


def score(pair, max_detour_s: float, max_pickup_s: float) -> float:
    """Score of one pair in [0, 1]; 1 = no detour and the driver already at the pickup point."""
    cost = (WEIGHTS["relative_detour"] * min(1.0, pair["detour_s"] / max_detour_s if max_detour_s else 0.0)
            + WEIGHTS["relative_pickup"] * (pair["to_pickup_s"] / max_pickup_s if max_pickup_s else 0.0))
    return round(1.0 - cost, 6)


def solve(instance, config) -> dict:
    threshold = float(config.get("threshold", 0.35))
    pairs = list(instance["pairs"])
    max_detour = float(instance["params"]["max_detour_s"])
    max_pickup = float(max((p["to_pickup_s"] for p in pairs), default=0))
    kept = [p for p in pairs if score(p, max_detour, max_pickup) >= threshold]
    drivers, riders, decisions, detour = set(), set(), [], 0
    for p in sorted(kept, key=lambda p: (p["detour_s"], p["to_pickup_s"], p["driver"], p["rider"])):
        if p["driver"] in drivers or p["rider"] in riders:
            continue
        drivers.add(p["driver"]); riders.add(p["rider"])
        decisions.append([p["driver"], p["rider"]]); detour += p["detour_s"]
    return dict(decisions=decisions, status="HEURISTIC", declared=dict(served=len(decisions), detour_s=detour),
                metadata=dict(scorer="hand-written linear score (example, not trained)", threshold=threshold),
                diagnostics=dict(pairs_considered=len(pairs), pairs_kept=len(kept), pairs_removed=len(pairs) - len(kept)))
