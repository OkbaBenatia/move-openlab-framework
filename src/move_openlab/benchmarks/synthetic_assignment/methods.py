"""Reference methods shipped with the benchmark: an exact lexicographic MILP (HiGHS) and a deterministic greedy.
Both see only the read-only instance view and obey the same contract as researcher plugins."""
from __future__ import annotations

from .spec import OBJECTIVE_SPEC_ID, PROBLEM_ID, idnum

EXACT_META = dict(
    method_id="exact-milp-highs", name="Exact MILP (HiGHS, lexicographic)", version="1.0.0", kind="exact",
    problem_id=PROBLEM_ID, objective_spec_id=OBJECTIVE_SPEC_ID, deterministic=True, author="MOVE OpenLab",
    description="Two-stage lexicographic MILP: (1) max sum x; (2) fix sum x >= served*, min sum c x. "
                "HiGHS, one thread, fixed random seed, zero relative and absolute MIP gap.",
    default_config=dict(time_limit_s=60.0, threads=1, random_seed=0, mip_rel_gap=0.0, mip_abs_gap=0.0, presolve="on"))


def solve_exact(instance, config) -> dict:
    import highspy
    pairs = sorted(instance["compatible_pairs"], key=lambda p: (idnum(p["driver"]), idnum(p["passenger"])))
    n = len(pairs)
    h = highspy.Highs()
    h.setOptionValue("output_flag", False)
    h.setOptionValue("threads", int(config["threads"]))
    h.setOptionValue("random_seed", int(config["random_seed"]))
    h.setOptionValue("mip_rel_gap", float(config["mip_rel_gap"]))
    h.setOptionValue("mip_abs_gap", float(config["mip_abs_gap"]))
    h.setOptionValue("presolve", str(config["presolve"]))
    h.setOptionValue("time_limit", float(config["time_limit_s"]))
    version = h.version() if hasattr(h, "version") else "unknown"
    meta = dict(solver="HiGHS", solver_version=version, highs_options={k: config[k] for k in sorted(config)})
    if n == 0:
        return dict(decisions=[], status="OPTIMAL", declared=dict(served=0, cost=0), metadata={**meta, "solver_time_s": 0.0},
                    diagnostics=dict(stage1_status="trivial", stage2_status="trivial", variables=0))
    inf = highspy.kHighsInf
    for _ in range(n):
        h.addCol(0.0, 0.0, 1.0, 0, [], [])
    h.changeColsIntegrality(n, list(range(n)), [highspy.HighsVarType.kInteger] * n)
    for p in instance["passengers"]:
        idx = [k for k, pr in enumerate(pairs) if pr["passenger"] == p["id"]]
        if idx:
            h.addRow(-inf, 1.0, len(idx), idx, [1.0] * len(idx))
    for d in instance["drivers"]:
        idx = [k for k, pr in enumerate(pairs) if pr["driver"] == d["id"]]
        if idx:
            h.addRow(-inf, float(d["capacity"]), len(idx), idx, [1.0] * len(idx))
    h.changeColsCost(n, list(range(n)), [1.0] * n)                       # stage 1: maximise service
    h.changeObjectiveSense(highspy.ObjSense.kMaximize)
    h.run()
    st1 = h.modelStatusToString(h.getModelStatus()); t1 = h.getRunTime()
    if h.getModelStatus() != highspy.HighsModelStatus.kOptimal:
        return dict(decisions=[], status="TIME_LIMIT" if "time" in st1.lower() else "ERROR",
                    metadata={**meta, "solver_time_s": t1}, diagnostics=dict(stage1_status=st1))
    served_star = int(round(h.getInfo().objective_function_value))
    h.addRow(float(served_star), inf, n, list(range(n)), [1.0] * n)       # stage 2: min cost at optimal service
    h.changeColsCost(n, list(range(n)), [float(p["cost"]) for p in pairs])
    h.changeObjectiveSense(highspy.ObjSense.kMinimize)
    h.run()
    st2 = h.modelStatusToString(h.getModelStatus()); t2 = h.getRunTime()
    ok = h.getModelStatus() == highspy.HighsModelStatus.kOptimal
    x = h.getSolution().col_value
    chosen = [[pairs[k]["driver"], pairs[k]["passenger"]] for k in range(n) if x[k] > 0.5]
    return dict(decisions=chosen, status="OPTIMAL" if ok else ("TIME_LIMIT" if "time" in st2.lower() else "FEASIBLE"),
                declared=dict(served=len(chosen), cost=int(round(sum(pairs[k]["cost"] for k in range(n) if x[k] > 0.5)))),
                metadata={**meta, "solver_time_s": round(t1 + t2, 6)},
                diagnostics=dict(stage1_status=st1, stage2_status=st2, served_star=served_star, variables=n,
                                 stage1_time_s=round(t1, 6), stage2_time_s=round(t2, 6)))


GREEDY_META = dict(
    method_id="greedy-min-cost", name="Deterministic greedy (min cost first)", version="1.0.0", kind="heuristic",
    problem_id=PROBLEM_ID, objective_spec_id=OBJECTIVE_SPEC_ID, deterministic=True, author="MOVE OpenLab",
    description="Scan compatible pairs by (cost, driver number, passenger number) ascending; assign when the passenger "
                "is free and the driver has residual capacity.",
    default_config=dict(tie_break="cost,driver_number,passenger_number"))


def solve_greedy(instance, config) -> dict:
    cap = {d["id"]: d["capacity"] for d in instance["drivers"]}
    taken, chosen, cost = set(), [], 0
    for p in sorted(instance["compatible_pairs"], key=lambda p: (p["cost"], idnum(p["driver"]), idnum(p["passenger"]))):
        if p["passenger"] not in taken and cap[p["driver"]] > 0:
            chosen.append([p["driver"], p["passenger"]]); taken.add(p["passenger"]); cap[p["driver"]] -= 1
            cost += p["cost"]
    return dict(decisions=chosen, status="HEURISTIC", declared=dict(served=len(chosen), cost=cost),
                metadata=dict(tie_break=config["tie_break"]), diagnostics=dict(pairs_scanned=len(instance["compatible_pairs"])))


BUILTIN = [(EXACT_META, solve_exact), (GREEDY_META, solve_greedy)]
