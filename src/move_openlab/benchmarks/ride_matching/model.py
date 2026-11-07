"""Public ride-matching problem: specification, independent validator, reference methods, semantics, variants.

Drivers and riders have fixed roles. Each driver may carry at most one rider, picked up at the rider's origin and
dropped at the rider's destination before the driver continues to their own destination::

    x[d,r] in {0,1}, sum_d x[d,r] <= 1 (each rider once), sum_r x[d,r] <= 1 (one rider per driver),
    x[d,r] = 0 unless (d,r) is a compatible pair.

A pair is compatible when the driver's detour  t(o_d,o_r) + t(o_r,d_r) + t(d_r,d_d) - t(o_d,d_d)  is within the
instance's detour limits and a departure time of the driver in its window reaches the rider's origin inside the
rider's pickup window. Travel times come from the road network the instance was built on (stored in the instance, so
validation never needs the network). Lexicographic objective: maximise served riders, then minimise the total detour.
"""
from __future__ import annotations

from collections import Counter

PROBLEM_ID = "public-ride-matching"
PROBLEM_SPEC_VERSION = "1.0.0"
OBJECTIVE_SPEC_ID = "lex-max-served-riders-then-min-detour/1.0.0"
CONSTRAINT_SPEC_ID = "one-rider-per-driver+rider-once+detour-and-time-compatibility+binary/1.0.0"
INSTANCE_SCHEMA = "move-openlab/ride-matching-instance/1"
VALIDATOR_VERSION = "1.0.0"
OBJECTIVES = {OBJECTIVE_SPEC_ID: dict(type="lexicographic", levels=[dict(sense="max", expression="sum x[d,r]"),
                                                                    dict(sense="min", expression="sum detour[d,r] x[d,r]")])}


def num(s: str) -> int:
    return int("".join(ch for ch in s if ch.isdigit()) or 0)


# ---------------------------------------------------------------- integrity and validation
def check_content(inst: dict) -> list[str]:
    errs = []
    for k in ("drivers", "riders", "pairs"):
        if not isinstance(inst.get(k), list):
            return [f"{k} must be a list"]
    d_ids, r_ids = [d.get("id") for d in inst["drivers"]], [r.get("id") for r in inst["riders"]]
    if not all(isinstance(x, str) and x for x in d_ids + r_ids) or len(set(d_ids + r_ids)) != len(d_ids + r_ids):
        errs.append("identifiers must be distinct non-empty strings")
    direct = {d["id"]: d.get("direct_s") for d in inst["drivers"]}
    win_d = {d["id"]: (d.get("earliest"), d.get("latest")) for d in inst["drivers"]}
    win_r = {r["id"]: (r.get("earliest"), r.get("latest")) for r in inst["riders"]}
    for a in inst["drivers"] + inst["riders"]:
        e, l = a.get("earliest"), a.get("latest")
        if not (isinstance(e, int) and isinstance(l, int) and 0 <= e <= l):
            errs.append(f"invalid time window for {a.get('id')}")
        if not (isinstance(a.get("direct_s"), int) and a["direct_s"] >= 0):
            errs.append(f"invalid direct travel time for {a.get('id')}")
    seen = set()
    for p in inst["pairs"]:
        key = (p.get("driver"), p.get("rider"))
        if key[0] not in direct or key[1] not in win_r:
            errs.append(f"pair references unknown id {key}"); continue
        if key in seen:
            errs.append(f"duplicate pair {key}")
        seen.add(key)
        vals = [p.get(k) for k in ("to_pickup_s", "ride_s", "to_dest_s", "detour_s", "pickup_earliest", "pickup_latest")]
        if not all(isinstance(v, int) for v in vals):
            errs.append(f"non-integer pair data {key}"); continue
        if p["detour_s"] != p["to_pickup_s"] + p["ride_s"] + p["to_dest_s"] - direct[key[0]] or p["detour_s"] < 0:
            errs.append(f"detour of {key} is inconsistent with its travel times")
        lo = max(win_d[key[0]][0] + p["to_pickup_s"], win_r[key[1]][0])
        hi = min(win_d[key[0]][1] + p["to_pickup_s"], win_r[key[1]][1])
        if (lo, hi) != (p["pickup_earliest"], p["pickup_latest"]) or lo > hi:
            errs.append(f"pickup window of {key} is inconsistent with the agents' windows")
    return errs


def check_decisions(decisions) -> list[str]:
    if not isinstance(decisions, list):
        return ["decisions must be a list"]
    if not all(isinstance(x, (list, tuple)) and len(x) == 2 and all(isinstance(v, str) for v in x) for x in decisions):
        return ["each decision must be [driver_id, rider_id] (strings)"]
    return []


def validate(inst: dict, decisions) -> dict:
    errs = []
    det = {(p["driver"], p["rider"]): p["detour_s"] for p in inst["pairs"]}
    drivers, riders = {d["id"] for d in inst["drivers"]}, {r["id"] for r in inst["riders"]}
    pairs = []
    for a in decisions:
        if not (isinstance(a, (list, tuple)) and len(a) == 2 and all(isinstance(v, str) for v in a)):
            errs.append(f"malformed decision {a!r}"); continue
        pairs.append((a[0], a[1]))
    for d, r in pairs:
        if d not in drivers:
            errs.append(f"unknown driver {d}")
        if r not in riders:
            errs.append(f"unknown rider {r}")
        if (d, r) not in det:
            errs.append(f"incompatible match {d}->{r}")
    for what, keys in (("driver", [d for d, _ in pairs]), ("rider", [r for _, r in pairs])):
        dup = sorted(k for k, n in Counter(keys).items() if n > 1)
        if dup:
            errs.append(f"{what}s matched more than once {dup[:5]}")
    uniq = set(pairs)
    return dict(feasible=not errs, metrics=dict(served=len({r for _, r in uniq}),
                                                detour_s=sum(det.get(k, 0) for k in uniq)),
                errors=errs, validator_version=VALIDATOR_VERSION)


# ---------------------------------------------------------------- reference methods
EXACT_META = dict(method_id="exact-matching-highs", name="Exact matching MILP (HiGHS, lexicographic)", version="1.0.0",
                  kind="exact", problem_id=PROBLEM_ID, objective_spec_id=OBJECTIVE_SPEC_ID, deterministic=True,
                  author="MOVE OpenLab",
                  description="Two-stage lexicographic MILP on the compatible pairs: (1) max matched riders; (2) fix that "
                              "level, min total detour. HiGHS, one thread, zero MIP gap.",
                  default_config=dict(time_limit_s=60.0, threads=1, random_seed=0, mip_rel_gap=0.0, mip_abs_gap=0.0))


def solve_exact(instance, config) -> dict:
    import highspy
    pairs = sorted(instance["pairs"], key=lambda p: (num(p["driver"]), num(p["rider"]), p["driver"], p["rider"]))
    n = len(pairs)
    h = highspy.Highs()
    h.setOptionValue("output_flag", False)
    for k in ("threads", "random_seed"):
        h.setOptionValue(k, int(config[k]))
    for k in ("mip_rel_gap", "mip_abs_gap"):
        h.setOptionValue(k, float(config[k]))
    h.setOptionValue("time_limit", float(config["time_limit_s"]))
    meta = dict(solver="HiGHS", solver_version=h.version())
    if n == 0:
        return dict(decisions=[], status="OPTIMAL", declared=dict(served=0, detour_s=0), metadata={**meta, "solver_time_s": 0.0})
    inf = highspy.kHighsInf
    for _ in range(n):
        h.addCol(0.0, 0.0, 1.0, 0, [], [])
    h.changeColsIntegrality(n, list(range(n)), [highspy.HighsVarType.kInteger] * n)
    for key in ("driver", "rider"):
        groups: dict[str, list[int]] = {}
        for k, p in enumerate(pairs):
            groups.setdefault(p[key], []).append(k)
        for idx in groups.values():
            h.addRow(-inf, 1.0, len(idx), idx, [1.0] * len(idx))
    h.changeColsCost(n, list(range(n)), [1.0] * n)
    h.changeObjectiveSense(highspy.ObjSense.kMaximize)
    h.run()
    st1, t1 = h.modelStatusToString(h.getModelStatus()), h.getRunTime()
    if h.getModelStatus() != highspy.HighsModelStatus.kOptimal:
        return dict(decisions=[], status="TIME_LIMIT" if "time" in st1.lower() else "ERROR",
                    metadata={**meta, "solver_time_s": t1}, diagnostics=dict(stage1_status=st1))
    served = int(round(h.getInfo().objective_function_value))
    h.addRow(float(served), inf, n, list(range(n)), [1.0] * n)
    h.changeColsCost(n, list(range(n)), [float(p["detour_s"]) for p in pairs])
    h.changeObjectiveSense(highspy.ObjSense.kMinimize)
    h.run()
    st2, t2 = h.modelStatusToString(h.getModelStatus()), h.getRunTime()
    x = h.getSolution().col_value
    chosen = [[pairs[k]["driver"], pairs[k]["rider"]] for k in range(n) if x[k] > 0.5]
    ok = h.getModelStatus() == highspy.HighsModelStatus.kOptimal
    return dict(decisions=chosen, status="OPTIMAL" if ok else ("TIME_LIMIT" if "time" in st2.lower() else "FEASIBLE"),
                declared=dict(served=len(chosen), detour_s=sum(pairs[k]["detour_s"] for k in range(n) if x[k] > 0.5)),
                metadata={**meta, "solver_time_s": round(t1 + t2, 6)},
                diagnostics=dict(stage1_status=st1, stage2_status=st2, served_star=served, variables=n))


GREEDY_META = dict(method_id="greedy-min-detour", name="Greedy (smallest detour first)", version="1.0.0", kind="heuristic",
                   problem_id=PROBLEM_ID, objective_spec_id=OBJECTIVE_SPEC_ID, deterministic=True, author="MOVE OpenLab",
                   description="Scan compatible pairs by (detour, driver, rider) and match when both are still free.",
                   default_config={})


def solve_greedy(instance, config) -> dict:
    used_d, used_r, chosen, total = set(), set(), [], 0
    for p in sorted(instance["pairs"], key=lambda p: (p["detour_s"], num(p["driver"]), num(p["rider"]), p["driver"], p["rider"])):
        if p["driver"] not in used_d and p["rider"] not in used_r:
            used_d.add(p["driver"]); used_r.add(p["rider"]); chosen.append([p["driver"], p["rider"]]); total += p["detour_s"]
    return dict(decisions=chosen, status="HEURISTIC", declared=dict(served=len(chosen), detour_s=total),
                diagnostics=dict(pairs_scanned=len(instance["pairs"])))


# ---------------------------------------------------------------- semantics for comparability
def components(inst: dict, objective_id: str) -> dict:
    if objective_id not in OBJECTIVES:
        raise ValueError(f"unknown objective {objective_id!r}")
    return dict(region=dict(drivers=sorted(d["id"] for d in inst["drivers"]), riders=sorted(r["id"] for r in inst["riders"]),
                            pairs=sorted([p["driver"], p["rider"]] for p in inst["pairs"]), constraints=CONSTRAINT_SPEC_ID),
                coefficients=sorted([p["driver"], p["rider"], p["detour_s"]] for p in inst["pairs"]),
                objective=OBJECTIVES[objective_id])


SEMANTIC_KEYS = {"drivers", "riders", "pairs"}
BOOKKEEPING = {"instance_hash", "instance_id", "derivation", "provenance", "name"}


def explain(a: dict, b: dict) -> dict:
    dims, nonbinding = [], []
    for key, label in (("drivers", "supply: driver set"), ("riders", "demand: rider set")):
        sa, sb = {x["id"] for x in a[key]}, {x["id"] for x in b[key]}
        if sa != sb:
            dims.append(dict(dimension=label, detail=f"{len(sa ^ sb)} id(s) differ"))
    pa = {(p["driver"], p["rider"]): p["detour_s"] for p in a["pairs"]}
    pb = {(p["driver"], p["rider"]): p["detour_s"] for p in b["pairs"]}
    if set(pa) != set(pb):
        dims.append(dict(dimension="compatibility relation (feasible matches)",
                         detail=f"+{len(set(pb) - set(pa))} / -{len(set(pa) - set(pb))} compatible pair(s)"))
    changed = [k for k in set(pa) & set(pb) if pa[k] != pb[k]]
    if changed:
        dims.append(dict(dimension="detour coefficients", detail=f"{len(changed)} pair detour(s) differ"))
    if not changed and set(pa) == set(pb):
        other = sorted(k for k in set(a) | set(b) if k not in SEMANTIC_KEYS | BOOKKEEPING and a.get(k) != b.get(k))
        if other:
            nonbinding.append(dict(dimension="non-semantic or non-binding data", detail=f"field(s) {other} differ"))
        geo = [x["id"] for x in a["drivers"] + a["riders"]
               if x != next((y for y in b["drivers"] + b["riders"] if y["id"] == x["id"]), x)]
        if geo:
            nonbinding.append(dict(dimension="agent attributes",
                                   detail=f"{len(geo)} agent(s) differ without changing compatible pairs or detours"))
    return dict(dimensions=dims, nonbinding=nonbinding)
