"""Problem semantics for comparability: the data that define the feasible region and the objective.

region        passenger ids, driver ids with their *effective* capacity min(capacity, degree), compatible pairs,
              constraint specification
coefficients  the cost of every compatible pair
objective     the objective definition (senses, levels, expressions), not its name

A capacity above a driver's number of compatible passengers is non-binding: it changes the instance file but not the
feasible set, hence not the problem fingerprint.
"""
from __future__ import annotations

from .spec import CONSTRAINT_SPEC_ID

OBJECTIVES = {
    "lex-max-served-then-min-cost/1.0.0": dict(
        type="lexicographic", levels=[dict(sense="max", expression="sum x[d,p]"),
                                      dict(sense="min", expression="sum cost[d,p] x[d,p]")]),
}
SEMANTIC_KEYS = {"drivers", "passengers", "compatible_pairs"}
BOOKKEEPING_KEYS = {"instance_hash", "instance_id", "derivation"}


def degrees(instance: dict) -> dict:
    deg = {d["id"]: 0 for d in instance["drivers"]}
    for p in instance["compatible_pairs"]:
        deg[p["driver"]] = deg.get(p["driver"], 0) + 1
    return deg


def components(instance: dict, objective_id: str) -> dict:
    deg = degrees(instance)
    if objective_id not in OBJECTIVES:
        raise ValueError(f"unknown objective {objective_id!r}")
    return dict(
        region=dict(passengers=sorted(p["id"] for p in instance["passengers"]),
                    drivers=sorted([d["id"], min(d["capacity"], deg[d["id"]])] for d in instance["drivers"]),
                    pairs=sorted([p["driver"], p["passenger"]] for p in instance["compatible_pairs"]),
                    constraints=CONSTRAINT_SPEC_ID),
        coefficients=sorted([p["driver"], p["passenger"], p["cost"]] for p in instance["compatible_pairs"]),
        objective=OBJECTIVES[objective_id])


def _attrs(inst: dict, key: str, ident: str) -> dict:
    for a in inst[key]:
        if a["id"] == ident:
            return {k: v for k, v in a.items() if k not in ("id", "capacity")}
    return {}


def explain(i1: dict, i2: dict) -> dict:
    """Component-level differences; also lists raw differences that do NOT change the problem."""
    dims, nonbinding = [], []
    p1, p2 = {p["id"] for p in i1["passengers"]}, {p["id"] for p in i2["passengers"]}
    if p1 != p2:
        dims.append(dict(dimension="demand: passenger set", detail=f"{len(p1 ^ p2)} passenger id(s) differ"))
    deg1, deg2 = degrees(i1), degrees(i2)
    cap1, cap2 = {d["id"]: d["capacity"] for d in i1["drivers"]}, {d["id"]: d["capacity"] for d in i2["drivers"]}
    if set(cap1) != set(cap2):
        dims.append(dict(dimension="supply: driver set", detail=f"{len(set(cap1) ^ set(cap2))} driver id(s) differ"))
    for d in sorted(set(cap1) & set(cap2)):
        eff1, eff2 = min(cap1[d], deg1[d]), min(cap2[d], deg2[d])
        if eff1 != eff2:
            dims.append(dict(dimension="supply: driver capacity",
                             detail=f"{d}: effective capacity {eff1} -> {eff2} (capacity {cap1[d]} -> {cap2[d]})"))
        elif cap1[d] != cap2[d]:
            nonbinding.append(dict(dimension="supply: driver capacity",
                                   detail=f"{d}: capacity {cap1[d]} -> {cap2[d]} is non-binding "
                                          f"(at most {max(deg1[d], deg2[d])} compatible passenger(s))"))
    pr1 = {(p["driver"], p["passenger"]): p["cost"] for p in i1["compatible_pairs"]}
    pr2 = {(p["driver"], p["passenger"]): p["cost"] for p in i2["compatible_pairs"]}
    g1, g2 = i1.get("generator", {}), i2.get("generator", {})
    gen_diff = {k: (g1.get(k), g2.get(k)) for k in sorted(set(g1) | set(g2))
                if g1.get(k) != g2.get(k) and k not in ("seed", "size")}
    if set(pr1) != set(pr2):
        cause = f"; generator parameter(s) changed: {gen_diff}" if gen_diff else ""
        dims.append(dict(dimension="compatibility relation (feasible assignments)",
                         detail=f"+{len(set(pr2) - set(pr1))} / -{len(set(pr1) - set(pr2))} compatible pair(s){cause}"))
    elif gen_diff:
        nonbinding.append(dict(dimension="generator parameters", detail=f"{gen_diff} changed, compatible pairs unchanged"))
    changed_cost = [k for k in set(pr1) & set(pr2) if pr1[k] != pr2[k]]
    if changed_cost:
        dims.append(dict(dimension="cost coefficients", detail=f"{len(changed_cost)} pair cost(s) differ"))
    meta = sorted(k for k in set(i1) | set(i2) if k not in SEMANTIC_KEYS | BOOKKEEPING_KEYS | {"generator"}
                  and i1.get(k) != i2.get(k))
    if meta:
        nonbinding.append(dict(dimension="non-semantic metadata", detail=f"field(s) {meta} differ"))
    geo = [d for d in sorted(set(cap1) & set(cap2)) if _attrs(i1, "drivers", d) != _attrs(i2, "drivers", d)]
    geo += [p for p in sorted(p1 & p2) if _attrs(i1, "passengers", p) != _attrs(i2, "passengers", p)]
    if geo and not changed_cost and set(pr1) == set(pr2):
        nonbinding.append(dict(dimension="generative attributes",
                               detail=f"locations/time windows of {len(geo)} agent(s) differ without changing "
                                      "compatible pairs or costs"))
    return dict(dimensions=dims, nonbinding=nonbinding)
