"""Threshold-study report: how aggressively can candidates be pruned before solution quality degrades?

For every (scenario, threshold) cell, the study campaign's run of the method on the pruned instance is compared with
the parent campaign's run of the same method on the full instance (the reference — not a ground truth):

``kept_share``            candidates kept / candidates of the full instance
``feasible_on_original``  the pruned solution re-validated on the ORIGINAL instance (pruning only removes options)
``equal_objective``       every objective level equals the full-instance run
``final_level_gap_pct``   relative gap on the last level where previous levels are equal (positive = worse)
``level1_shortfall``      deficit on the first level (positive = worse)
``reference_recall``      share of the full-instance solution's decisions still available after pruning
``time_ratio``            median total time pruned / full
"""
from __future__ import annotations

from ..store import BenchError, problem_for
from .common import SCOPES, med, optimality_scope, summary_stats


def threshold_report(ws, cid: str) -> dict:
    c = ws.get(cid)
    if c["kind"] != "threshold-study":
        raise BenchError("not a threshold-study campaign")
    if not c["runs"]:
        raise BenchError("the study has not been executed yet")
    parent = ws.get(c["parent"]["campaign_id"])
    problem = problem_for(c)
    st = c["threshold_study"]
    mid = st["method"]["method_id"]
    levels = problem.objective
    ref_runs = {}
    for r in parent["runs"]:
        if r["method_id"] == mid:
            ref_runs.setdefault(r["instance_hash"], []).append(r)
    study_runs = {}
    for r in c["runs"]:
        study_runs.setdefault(r["instance_hash"], []).append(r)
    kind = next((m.get("kind") for m in c["methods"] if m["method_id"] == mid), None)
    per_t: dict[float, dict] = {t: dict(cells=0, kept=[], feasible=0, equal=0, gaps=[], shortfall=0.0, recall=[],
                                        ratio=[], eff=[], scopes={}) for t in st["thresholds"]}
    rows = []
    for cellrec in st["cells"]:
        refs, runs = ref_runs.get(cellrec["parent_instance_hash"]), study_runs.get(cellrec["instance_hash"])
        if not refs or not runs:
            continue
        refs.sort(key=lambda r: r["repetition"]); runs.sort(key=lambda r: r["repetition"])
        original = ws.inst.get_instance(cellrec["parent_instance_hash"])
        v_ref = problem.validate(original, refs[0]["decisions"])
        v_new = problem.validate(original, runs[0]["decisions"])          # re-validated on the full instance
        a = per_t[cellrec["threshold"]]
        a["cells"] += 1
        kept_share = cellrec["candidates_kept"] / cellrec["candidates_total"] if cellrec["candidates_total"] else 1.0
        a["kept"].append(kept_share)
        a["feasible"] += int(v_new["feasible"])
        rm, nm = v_ref["metrics"], v_new["metrics"]
        k = 0
        while k < len(levels) and rm[levels[k].metric] == nm[levels[k].metric]:
            k += 1
        a["equal"] += int(k == len(levels))
        first = levels[0]
        a["shortfall"] += (rm[first.metric] - nm[first.metric]) if first.sense == "max" else (nm[first.metric] - rm[first.metric])
        gap = None
        if k >= len(levels) - 1 and rm[levels[-1].metric]:
            last = levels[-1]
            d = (rm[last.metric] - nm[last.metric]) if last.sense == "max" else (nm[last.metric] - rm[last.metric])
            gap = 100.0 * d / abs(rm[last.metric])
            a["gaps"].append(gap)
        pruned = ws.inst.get_instance(cellrec["instance_hash"])
        scope = optimality_scope(runs[0], pruned, kind)
        a["scopes"][scope] = a["scopes"].get(scope, 0) + 1
        if cellrec.get("effective_threshold") is not None:
            a["eff"].append(cellrec["effective_threshold"])
        kept_ids = {x["id"] for x in problem.candidates(pruned)}
        ref_used = [problem.decision_candidate(d) for d in refs[0]["decisions"]]
        recall = (sum(1 for x in ref_used if x in kept_ids) / len(ref_used)) if ref_used else 1.0
        a["recall"].append(recall)
        t_ref, t_new = med(refs, "total_time_s"), med(runs, "total_time_s")
        if t_ref and t_new:
            a["ratio"].append(t_new / t_ref)
        rows.append(dict(scenario=cellrec["parent_instance_id"], threshold=cellrec["threshold"],
                         effective_threshold=cellrec.get("effective_threshold", cellrec["threshold"]),
                         candidates_kept=cellrec["candidates_kept"], candidates_total=cellrec["candidates_total"],
                         reduction_pct=round(100.0 * (1 - kept_share), 2), optimality_scope=scope,
                         reference_metrics=rm, pruned_metrics=nm, feasible_on_original=v_new["feasible"],
                         equal_objective=k == len(levels), final_level_gap_pct=None if gap is None else round(gap, 4),
                         reference_recall=round(recall, 4), median_total_time_s=dict(full=t_ref, pruned=t_new)))
    summary = []
    for t, a in per_t.items():
        n = a["cells"]
        summary.append(dict(threshold=t, cells=n, mean_kept_share=round(sum(a["kept"]) / n, 4) if n else None,
                            mean_reduction_pct=round(100.0 * (1 - sum(a["kept"]) / n), 2) if n else None,
                            min_kept_share=round(min(a["kept"]), 4) if n else None,
                            max_kept_share=round(max(a["kept"]), 4) if n else None,
                            effective_threshold=summary_stats(a["eff"]), optimality_scope=a["scopes"],
                            feasible_on_original=a["feasible"], equal_objective=a["equal"],
                            level1_shortfall=round(a["shortfall"], 6), final_level_gap_pct=summary_stats(a["gaps"]),
                            mean_reference_recall=round(sum(a["recall"]) / n, 4) if n else None,
                            median_time_ratio=summary_stats(a["ratio"])["median"]))
    return dict(campaign_id=cid, parent_campaign_id=parent["campaign_id"], method=st["method"], scorer=st["scorer"],
                thresholds=st["thresholds"], top_k=st["top_k"], mode=st.get("mode", "absolute"),
                selection_rule=st["selection_rule"], scope_labels=list(SCOPES),
                objective=[o.to_dict() for o in levels], summary=summary, rows=rows,
                definitions=dict(reference="the parent campaign's run of the same method on the full instance",
                                 gap="positive = worse than the full-instance run; computed where previous levels are equal",
                                 recall="share of the full-instance solution's decisions still available after pruning"),
                synthetic=problem.synthetic)
