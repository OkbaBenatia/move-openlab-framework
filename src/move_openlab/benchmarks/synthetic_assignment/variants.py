"""Controlled variants (deterministic perturbation operators). Every derived instance records its parent and the exact
modification, and is a new content-addressed artifact; a perturbation that cannot be made effective on an instance
returns None (recorded as "not applicable", never forced).

Instance-level
  capacity-binding         driver with capacity < degree (largest deficit, lowest id): capacity + 1
  capacity-nonbinding      driver with capacity >= degree (lowest id): capacity + 1 (same feasible set)
  temporal-tightening      minimum time-window overlap raised to 20 min; compatible pairs recomputed
  temporal-nonbinding      minimum overlap raised to the smallest overlap of an existing pair (no pair removed)
  metadata-only            adds a display label and a note
Configuration-level
  time-budget-1s           time budget 1 s instead of the default (instances unchanged)
"""
from __future__ import annotations

import copy

from ...hashing import with_hash
from ...problem import Variant
from .generator import derive_pairs, overlap
from .semantics import degrees
from .spec import idnum

TIGHT_OVERLAP = 20
VERSION = "move_openlab.synthetic_assignment.variants/1.0.0"


def _finish(parent: dict, child: dict, code: str, modification: dict) -> dict:
    child["instance_id"] = f"{parent['instance_id']}~{code}"
    child["derivation"] = dict(parent_instance_id=parent["instance_id"], parent_instance_hash=parent["instance_hash"],
                               variant=code, modification=modification, generator=VERSION)
    return with_hash(child)


def _bump_capacity(parent: dict, code: str, binding: bool) -> dict | None:
    deg = degrees(parent)
    if binding:
        cand = [d for d in parent["drivers"] if d["capacity"] < deg[d["id"]]]
        if not cand:
            return None
        d = min(cand, key=lambda d: (-(deg[d["id"]] - d["capacity"]), idnum(d["id"])))
    else:
        cand = [d for d in parent["drivers"] if d["capacity"] >= deg[d["id"]]]
        if not cand:
            return None
        d = min(cand, key=lambda d: idnum(d["id"]))
    child = copy.deepcopy(parent)
    for x in child["drivers"]:
        if x["id"] == d["id"]:
            x["capacity"] += 1
    return _finish(parent, child, code, dict(
        field=f"drivers[{d['id']}].capacity", old=d["capacity"], new=d["capacity"] + 1, degree=deg[d["id"]],
        intent="binding: capacity below the number of compatible passengers" if binding
        else "non-binding: capacity already >= compatible passengers"))


def capacity_binding(parent: dict) -> dict | None:
    return _bump_capacity(parent, "capacity-binding", True)


def capacity_nonbinding(parent: dict) -> dict | None:
    return _bump_capacity(parent, "capacity-nonbinding", False)


def _temporal(parent: dict, code: str, new_overlap: int, intent: str) -> dict:
    child = copy.deepcopy(parent)
    child["compatible_pairs"] = derive_pairs(parent["drivers"], parent["passengers"], parent["generator"]["radius"],
                                             new_overlap)
    child["generator"]["min_overlap"] = new_overlap
    old = {(p["driver"], p["passenger"]) for p in parent["compatible_pairs"]}
    new = {(p["driver"], p["passenger"]) for p in child["compatible_pairs"]}
    return _finish(parent, child, code, dict(field="generator.min_overlap (temporal compatibility threshold, minutes)",
                                             old=parent["generator"]["min_overlap"], new=new_overlap,
                                             pairs_removed=len(old - new), pairs_added=len(new - old), intent=intent))


def temporal_tightening(parent: dict) -> dict | None:
    if "generator" not in parent:
        return None
    child = _temporal(parent, "temporal-tightening", TIGHT_OVERLAP, "binding: removes compatible pairs")
    return child if child["derivation"]["modification"]["pairs_removed"] > 0 else None


def temporal_nonbinding(parent: dict) -> dict | None:
    if "generator" not in parent or not parent["compatible_pairs"]:
        return None
    by = {(d["id"], p["id"]): overlap(d, p) for d in parent["drivers"] for p in parent["passengers"]}
    m = min(by[(p["driver"], p["passenger"])] for p in parent["compatible_pairs"])
    if m <= parent["generator"]["min_overlap"]:
        return None
    child = _temporal(parent, "temporal-nonbinding", m,
                      "non-binding: threshold raised to the smallest overlap of an existing pair")
    mod = child["derivation"]["modification"]
    return child if mod["pairs_removed"] == mod["pairs_added"] == 0 else None


def metadata_only(parent: dict) -> dict:
    child = copy.deepcopy(parent)
    child["display_label"] = f"Scenario {parent['instance_id']} (relabelled for display)"
    child["notes"] = "Display-only annotation; no change to agents, pairs or costs."
    return _finish(parent, child, "metadata-only", dict(field="display_label, notes (added)",
                                                        intent="non-semantic metadata only"))


def variants() -> dict[str, Variant]:
    vs = [
        Variant("capacity-binding", "binding capacity relaxation (+1 on a driver whose capacity is below its number of "
                "compatible passengers)", capacity_binding),
        Variant("capacity-nonbinding", "non-binding capacity change (+1 on a driver whose capacity already covers all "
                "its compatible passengers)", capacity_nonbinding),
        Variant("temporal-tightening", f"temporal tightening (minimum time-window overlap -> {TIGHT_OVERLAP} min; "
                "compatible pairs recomputed)", temporal_tightening),
        Variant("temporal-nonbinding", "non-binding temporal change (threshold raised without removing any compatible "
                "pair)", temporal_nonbinding),
        Variant("metadata-only", "display label and note added (metadata only)", metadata_only),
        Variant("time-budget-1s", "time budget 1 s instead of the default (problem unchanged)", None,
                dict(time_budget_s=1.0, method_configs={"exact-milp-highs": {"time_limit_s": 1.0}})),
    ]
    return {v.id: v for v in vs}
