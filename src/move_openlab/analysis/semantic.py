"""Semantic comparability inside a researcher's workspace: claim-dependent decisions (quality, runtime) for every
scenario x method of a candidate campaign (and of the reference campaign) against the reference method's runs of
the reference campaign. Derived scenarios are matched to their parent through their recorded derivation."""
from __future__ import annotations

from ..comparability.contract import CLAIMS, CONTRACT_VERSION, check
from ..comparability.model import cell, environment_descriptor
from ..store import BenchError, problem_for


def _cells(ws, problem, c: dict) -> dict:
    env = environment_descriptor(c.get("environment") or {}, problem)
    budget = c["config"].get("time_budget_s", problem.default_time_budget_s)
    evaluation = problem.evaluation_contract()
    out = {}
    for h in c["scenario_set"]["instance_hashes"]:
        inst = ws.inst.get_instance(h)
        for m in c["methods"]:
            rs = [r for r in c["runs"] if r["instance_hash"] == h and r["method_id"] == m["method_id"]]
            if not rs:
                continue
            opts = {k: v for k, v in (rs[0].get("effective_config") or {}).items() if k != "time_limit_s"}
            e = cell(problem, experiment_id=f"{c['campaign_id']}:{inst['instance_id']}:{m['method_id']}",
                     researcher=c["owner_display"], instance=inst, objective_id=c["spec"]["objective_spec_id"],
                     evaluation=evaluation, config=dict(time_budget_s=budget, repetitions=len(rs), method_options=opts),
                     environment=env, method=dict(method_id=m["method_id"], version=m["version"], kind=m.get("kind")),
                     runs=rs, origin=c["campaign_id"], installation_id=c["installation_id"])
            parent_hash = (inst.get("derivation") or {}).get("parent_instance_hash", h)
            out[(parent_hash, m["method_id"])] = e
    return out


def semantic_compare(ws, reference_id: str, candidate_id: str) -> dict:
    ref, cand = ws.get(reference_id), ws.get(candidate_id)
    problem = problem_for(ref)
    if problem_for(cand).problem_id != problem.problem_id:
        raise BenchError("the two campaigns study different problems")
    if not problem.reference_method:
        raise BenchError(f"problem {problem.problem_id} declares no reference method")
    if not ref["runs"] or not cand["runs"]:
        raise BenchError("both campaigns must have executed runs")
    ref_mid = problem.reference_method[0]
    rc, cc = _cells(ws, problem, ref), _cells(ws, problem, cand)
    rows, summary = [], {cl: dict(DIRECT=0, CONDITIONAL=0, INCOMPATIBLE=0) for cl in CLAIMS}
    items = list(cc.items()) + ([] if reference_id == candidate_id else [(k, v) for k, v in rc.items() if k[1] != ref_mid])
    for (ph, mid), e2 in sorted(items, key=lambda kv: (kv[0], kv[1]["origin"] != reference_id)):
        e1 = rc.get((ph, ref_mid))
        if e1 is None:
            continue
        dec = {cl: check(problem, e1, e2, cl) for cl in CLAIMS}
        for cl in CLAIMS:
            summary[cl][dec[cl]["status"]] += 1
        rows.append(dict(scenario=e1["instance_id"], candidate_instance=e2["instance_id"], method=mid, campaign=e2["origin"],
                         researcher=e2["researcher"],
                         side="reference campaign" if e2["origin"] == reference_id else "candidate campaign",
                         reference=dict(method=ref_mid, metrics=e1["R"]["canonical_metrics"],
                                        certified_optimal=e1["R"]["certified_optimal"]),
                         candidate=dict(metrics=e2["R"]["canonical_metrics"], feasible=e2["R"]["feasible"],
                                        median_total_time_s=e2["R"]["median_total_time_s"]),
                         raw_hash_equal=e1["I"]["raw_artifact_hash"] == e2["I"]["raw_artifact_hash"],
                         problem_fingerprint=dict(reference=e1["P"]["fingerprint"]["problem"][:12],
                                                  candidate=e2["P"]["fingerprint"]["problem"][:12]),
                         quality={k: dec["quality"][k] for k in ("status", "incompatible", "qualifications", "notes")},
                         runtime={k: dec["runtime"][k] for k in ("status", "incompatible", "qualifications", "notes")}))
    if not rows:
        raise BenchError("no scenario of the candidate maps to a scenario of the reference")
    return dict(reference=dict(campaign_id=ref["campaign_id"], title=ref["title"], researcher=ref["owner_display"],
                               kind=ref["kind"], checksum=ref.get("checksum")),
                candidate=dict(campaign_id=cand["campaign_id"], title=cand["title"], researcher=cand["owner_display"],
                               kind=cand["kind"], checksum=cand.get("checksum"), variant=cand.get("semantic_variant")),
                reference_method=ref_mid, claims=list(CLAIMS), summary=summary, rows=rows, contract=CONTRACT_VERSION,
                metrics=[m.to_dict() for m in problem.metrics], synthetic=problem.synthetic)
