"""Example researcher plugin for the ride-matching benchmark — Nearest Pickup First.

Not a novel algorithm: a deterministic greedy rule used to demonstrate how a researcher adds a method and runs it on
an imported experiment (docs/EXTENDING.md). Created with ``move-openlab method new`` and checked with
``move-openlab method check plugins/nearest_pickup --bundle <experiment.zip>``. Standard library only.

Rule: consider the compatible driver–rider pairs in increasing order of the driver's time to the pickup point (ties:
smaller detour, then driver id, then rider id); keep a pair when neither its driver nor its rider is already matched.
"""
from __future__ import annotations

METADATA = {
    "method_id": "nearest-pickup",
    "name": "Nearest Pickup First",
    "version": "1.0.0",
    "kind": "heuristic",
    "problem_id": "public-ride-matching",
    "objective_spec_id": "lex-max-served-riders-then-min-detour/1.0.0",
    "deterministic": True,
    "author": "Example contributor",
    "description": "Greedy matching by increasing time from the driver's origin to the rider's pickup point.",
    "default_config": {},
}


def solve(instance, config) -> dict:
    drivers, riders, decisions, detour = set(), set(), [], 0
    for p in sorted(instance["pairs"], key=lambda p: (p["to_pickup_s"], p["detour_s"], p["driver"], p["rider"])):
        if p["driver"] in drivers or p["rider"] in riders:
            continue
        drivers.add(p["driver"]); riders.add(p["rider"])
        decisions.append([p["driver"], p["rider"]]); detour += p["detour_s"]
    return dict(decisions=decisions, status="HEURISTIC", declared=dict(served=len(decisions), detour_s=detour),
                metadata={}, diagnostics=dict(pairs_considered=len(instance["pairs"])))
