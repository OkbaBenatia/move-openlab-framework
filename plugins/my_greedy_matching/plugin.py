"""My Greedy Matching — the worked example of docs/ADD_YOUR_METHOD.md (public-ride-matching).

Created with ``move-openlab method new my_greedy_matching --problem public-ride-matching --dir plugins``, then
implemented below and checked with ``move-openlab method check plugins/my_greedy_matching --bundle <experiment.zip>``.
Not a novel algorithm: a deterministic greedy rule that shows how a researcher adds a method. Standard library only.

Rule ("most constrained rider first"): count, for each rider, the drivers it is compatible with (the instance's
pairs); serve the riders with the fewest options first — they are the easiest to lose — each with the free driver
whose detour is smallest (ties: shorter time to the pickup point, then driver id). Riders without a free compatible
driver stay unserved.

Contract (docs/EXTENDING.md): METADATA is a literal read without running this file; solve(instance, config) returns
the decisions [driver_id, rider_id]; the platform re-validates them independently and reports only the validator's
metrics ("declared" values are compared, never trusted). Runs happen in the verified sandbox.
"""

from __future__ import annotations

METADATA = {
    "method_id": "my-greedy-matching",
    "name": "My Greedy Matching",
    "version": "1.0.0",
    "kind": "heuristic",
    "problem_id": "public-ride-matching",
    "objective_spec_id": "lex-max-served-riders-then-min-detour/1.0.0",
    "deterministic": True,
    "author": "MOVE OpenLab example",
    "description": "Greedy matching, most constrained rider first: riders with the fewest compatible drivers are served "
                   "first, each by the free driver with the smallest detour.",
    "default_config": {},
}


def solve(instance, config) -> dict:
    options: dict[str, list[dict]] = {}
    for p in instance["pairs"]:
        options.setdefault(p["rider"], []).append(p)
    busy, decisions, detour = set(), [], 0
    for rider in sorted(options, key=lambda r: (len(options[r]), r)):
        free = [p for p in options[rider] if p["driver"] not in busy]
        if not free:
            continue
        best = min(free, key=lambda p: (p["detour_s"], p["to_pickup_s"], p["driver"]))
        busy.add(best["driver"])
        decisions.append([best["driver"], rider])
        detour += best["detour_s"]
    return dict(decisions=decisions, status="HEURISTIC", declared=dict(served=len(decisions), detour_s=detour),
                metadata={}, diagnostics=dict(pairs_considered=len(instance["pairs"]), riders_with_options=len(options)))
