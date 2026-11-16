"""Independent solution validator. It never trusts a method's own report: feasibility, served passengers and cost are
recomputed from the instance and the returned decisions only."""
from __future__ import annotations

from collections import Counter

from .spec import VALIDATOR_VERSION


def check_instance_content(instance: dict) -> list[str]:
    errs = []
    for key in ("drivers", "passengers", "compatible_pairs"):
        if not isinstance(instance.get(key), list):
            return [f"{key} must be a list"]
    if not isinstance(instance.get("instance_id"), str) or not instance["instance_id"]:
        errs.append("instance_id missing")
    d_ids = [d.get("id") for d in instance["drivers"]]
    p_ids = [p.get("id") for p in instance["passengers"]]
    if not all(isinstance(i, str) for i in d_ids + p_ids):
        errs.append("identifiers must be strings")
    if len(set(d_ids)) != len(d_ids) or len(set(p_ids)) != len(p_ids) or set(d_ids) & set(p_ids):
        errs.append("duplicate identifiers")
    for d in instance["drivers"]:
        if not isinstance(d.get("capacity"), int) or isinstance(d.get("capacity"), bool) or d["capacity"] < 0:
            errs.append(f"invalid capacity for {d.get('id')}")
    ds, ps, seen = set(d_ids), set(p_ids), set()
    for pr in instance["compatible_pairs"]:
        key = (pr.get("driver"), pr.get("passenger"))
        if key[0] not in ds or key[1] not in ps:
            errs.append(f"pair references unknown id {key}")
        if key in seen:
            errs.append(f"duplicate pair {key}")
        seen.add(key)
        if not isinstance(pr.get("cost"), int) or isinstance(pr.get("cost"), bool):
            errs.append(f"non-integer cost {key}")
    return errs


def check_decisions(decisions) -> list[str]:
    if not isinstance(decisions, list):
        return ["decisions must be a list"]
    if not all(isinstance(x, (list, tuple)) and len(x) == 2 and all(isinstance(v, str) for v in x) for x in decisions):
        return ["each decision must be [driver_id, passenger_id] (strings)"]
    return []


def validate(instance: dict, decisions) -> dict:
    errs = []
    cost_of = {(p["driver"], p["passenger"]): p["cost"] for p in instance["compatible_pairs"]}
    cap = {d["id"]: d["capacity"] for d in instance["drivers"]}
    pax = {p["id"] for p in instance["passengers"]}
    pairs = []
    for a in decisions:
        if not (isinstance(a, (list, tuple)) and len(a) == 2 and all(isinstance(v, str) for v in a)):
            errs.append(f"malformed decision {a!r}")
            continue
        pairs.append((a[0], a[1]))
    for d, p in pairs:
        if d not in cap:
            errs.append(f"unknown driver {d}")
        if p not in pax:
            errs.append(f"unknown passenger {p}")
        if (d, p) not in cost_of:
            errs.append(f"incompatible assignment {d}->{p}")
    dup = [k for k, v in Counter(pairs).items() if v > 1]
    if dup:
        errs.append(f"duplicate decisions {dup[:3]}")
    uniq = set(pairs)
    over = sorted(p for p, k in Counter(p for _, p in uniq).items() if k > 1)
    if over:
        errs.append(f"passengers assigned more than once {over[:5]}")
    for d, k in Counter(d for d, _ in uniq).items():
        if d in cap and k > cap[d]:
            errs.append(f"capacity exceeded for {d}: {k} > {cap[d]}")
    served = len({p for _, p in uniq})
    cost = sum(cost_of.get(k, 0) for k in uniq)
    return dict(feasible=not errs, metrics=dict(served=served, cost=cost), errors=errs,
                validator_version=VALIDATOR_VERSION)
