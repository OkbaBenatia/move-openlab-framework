"""Reproducibility verification of a reproduction campaign against its (locked, usually imported) parent.

Per scenario x method cell, comparing the first repetition of each side:

``IDENTICAL_SOLUTION``  same validated metrics and the same decisions
``EQUAL_OBJECTIVE``     same validated metrics, different decisions (alternative optima)
``DIFFERENT``           different validated metrics, or a missing cell
Runtimes are reported, never required to match.
"""
from __future__ import annotations

from ..store import BenchError, problem_for
from .common import by_cell, consistent, med


def reproducibility(ws, cid: str) -> dict:
    c = ws.get(cid)
    if c["kind"] != "reproduction":
        raise BenchError("reproducibility is reported for reproduction campaigns")
    if not c["runs"]:
        raise BenchError("the reproduction has not been executed yet")
    parent = ws.get(c["parent"]["campaign_id"])
    if parent.get("checksum") != c["parent"]["checksum"]:
        raise BenchError("parent checksum differs from the recorded one")
    problem_for(c)
    orig, new = by_cell(parent["runs"]), by_cell(c["runs"])
    rows, agree = [], dict(identical_solution=0, equal_objective=0, different=0)
    for key in sorted(orig):
        o, n = orig[key], new.get(key)
        if not n:
            rows.append(dict(instance_id=o[0]["instance_id"], instance_hash=key[0], method_id=key[1], status="MISSING"))
            agree["different"] += 1
            continue
        ov, nv = o[0]["validation"], n[0]["validation"]
        same_obj = ov["feasible"] and nv["feasible"] and ov["metrics"] == nv["metrics"]
        same_sol = same_obj and o[0]["decisions"] == n[0]["decisions"]
        st = "IDENTICAL_SOLUTION" if same_sol else "EQUAL_OBJECTIVE" if same_obj else "DIFFERENT"
        agree[st.lower()] += 1
        rows.append(dict(instance_id=o[0]["instance_id"], instance_hash=key[0], method_id=key[1], status=st,
                         original=dict(metrics=ov["metrics"], feasible=ov["feasible"], repetitions_consistent=consistent(o),
                                       median_total_time_s=med(o, "total_time_s"), median_solver_time_s=med(o, "solver_time_s")),
                         reexecuted=dict(metrics=nv["metrics"], feasible=nv["feasible"], repetitions_consistent=consistent(n),
                                         median_total_time_s=med(n, "total_time_s"), median_solver_time_s=med(n, "solver_time_s"))))
    n_cells = len(rows)
    return dict(campaign_id=cid, parent_campaign_id=parent["campaign_id"], parent_checksum=parent["checksum"],
                original_researcher=parent["owner_display"], reexecuting_researcher=c["owner_display"],
                original_installation=parent["installation_id"], reexecution_installation=c["installation_id"],
                original_environment=parent.get("environment"), reexecution_environment=c.get("environment"),
                cells=n_cells, agreement=agree,
                all_feasible=all(r.get("reexecuted", {}).get("feasible") for r in rows),
                numerically_reproduced=agree["different"] == 0 and n_cells > 0,
                note="Equality is required for every validated metric; decisions may differ only when every metric is "
                     "equal (alternative optima). Runtimes are reported, not required to match.",
                rows=rows)
