"""Method comparison along a campaign lineage (baseline → reproduction → extension), driven only by the problem's
objective levels. With a lexicographic objective ``(level 1, level 2, ...)``:

* ``reference_matches[k]``  scenarios where the first k+1 levels equal the reference method's values
* ``optimal``               scenarios where every level equals the reference (when the reference is exact)
* ``shortfall``             level-1 deficit versus the reference, summed (positive = worse)
* ``final_level_gap_pct``   relative gap on the last level, only where all previous levels equal the reference
                            (positive = worse); a method that is worse on an earlier level is never ranked better
* ``mean_rank``             mean lexicographic rank per scenario (ties share a rank)
"""
from __future__ import annotations

import json
import statistics

from ..store import BenchError, problem_for
from .common import by_cell, consistent, med, median_or_none, optimality_scope, summary_stats
from .reproducibility import reproducibility

ORIGIN = {"baseline": "original campaign", "reproduction": "re-executed (reproduction campaign)",
          "extended": "extended campaign", "variant": "controlled variant"}
SCOPE_ROOTS = ("baseline", "variant")          # campaigns that define the scenario set of a comparison


def _worse_by(sense: str, value: float, ref: float) -> float:
    return (ref - value) if sense == "max" else (value - ref)


def _problem_spec(c: dict) -> dict:
    """The part of a campaign's spec that defines the problem and its validator. The framework version is provenance:
    a record made by an earlier release of the framework stays comparable as long as the problem specification and the
    validator did not change (the semantic engine checks everything else)."""
    return {k: v for k, v in c["spec"].items() if k != "framework_version"}


def compare(ws, cid: str) -> dict:
    """Rows of the campaign and its ancestors back to the campaign that defined its scenario set: the baseline, or a
    controlled variant (whose derived scenarios start a new comparison; it is compared with its parent separately,
    by the semantic check)."""
    chain = []
    for c in ws.lineage(cid):
        chain.append(c)
        if c["kind"] in SCOPE_ROOTS:
            break
    problem = problem_for(chain[0])
    warnings, rows_src = [], []
    ref_set = chain[-1]["scenario_set"]["instance_hashes"]
    for c in chain:
        if c["kind"] not in ORIGIN:
            warnings.append(f"campaign {c['campaign_id']} ({c['kind']}) uses derived scenarios — compared separately")
            continue
        if c["scenario_set"]["instance_hashes"] != ref_set:
            warnings.append(f"campaign {c['campaign_id']} uses a different scenario set — excluded")
            continue
        if _problem_spec(c) != _problem_spec(chain[-1]):
            warnings.append(f"campaign {c['campaign_id']} uses another specification or validator version — excluded")
            continue
        for m in c["methods"]:
            runs = [r for r in c["runs"] if r["method_id"] == m["method_id"]]
            if runs:
                rows_src.append((c, m, runs))
    if not rows_src:
        raise BenchError("nothing to compare: execute the campaign first")
    return _table(ws, cid, problem, chain, rows_src, ref_set, warnings)


def compare_members(ws, members: list[dict]) -> dict:
    """Rows of a *study*: chosen methods of several experiments, shown together because they were evaluated on the same
    scenarios under the same problem specification and validator. Nothing is merged or rewritten: every row keeps its
    own experiment, origin and provenance, and an experiment that does not match is refused, never silently adapted.
    ``members``: ``[{campaign_id, method_id}]`` in display order; the scenario order is the first member's."""
    if not members:
        raise BenchError("a study needs at least one member")
    cs: dict[str, dict] = {}
    for m in members:
        if m["campaign_id"] not in cs:
            cs[m["campaign_id"]] = ws.get(m["campaign_id"])
    chain = list(cs.values())
    first = chain[0]
    problem = problem_for(first)
    ref_set = first["scenario_set"]["instance_hashes"]
    warnings, rows_src = [], []
    for c in chain[1:]:
        if set(c["scenario_set"]["instance_hashes"]) != set(ref_set):
            raise BenchError(f"experiment {c['campaign_id']} was not evaluated on the same scenarios as {first['campaign_id']}")
        if _problem_spec(c) != _problem_spec(first):
            raise BenchError(f"experiment {c['campaign_id']} uses another problem specification or validator version")
    for m in members:
        c = cs[m["campaign_id"]]
        ref = next((x for x in c["methods"] if x["method_id"] == m["method_id"]), None)
        runs = [r for r in c["runs"] if r["method_id"] == m["method_id"]]
        if ref is None or not runs:
            raise BenchError(f"experiment {c['campaign_id']} has no results of method {m['method_id']}")
        rows_src.append((c, ref, runs))
    if len(chain) > 1:
        warnings.append("rows come from different experiments evaluated on the same scenarios; each row names its experiment")
    return _table(ws, first["campaign_id"], problem, chain, rows_src, ref_set, warnings)


def _table(ws, cid: str, problem, chain: list[dict], rows_src: list, ref_set: list[str], warnings: list[str]) -> dict:
    levels = problem.objective
    envs = {json.dumps({k: (c.get("environment") or {}).get(k) for k in ("cpu_model_sha256", "python", "os_release",
                                                                        *problem.environment())}, sort_keys=True)
            for c, _, _ in rows_src}
    if len({c["installation_id"] for c, _, _ in rows_src}) > 1:
        warnings.append("rows were executed on different installations: runtime comparisons are indicative only "
                        "(objective comparisons are unaffected)")
    if len(envs) > 1:
        warnings.append("rows were executed in different computational environments")
    reps = {c["config"]["repetitions"] for c, _, _ in rows_src}
    if len(reps) > 1:
        warnings.append(f"different repetition counts {sorted(reps)}")
    budgets = {c["config"].get("time_budget_s") for c, _, _ in rows_src}
    if len(budgets) > 1:
        warnings.append(f"different time budgets {sorted(budgets, key=str)}: quality differences are budget-qualified")

    # reference: the oldest campaign of the lineage that ran the problem's reference method
    ref, ref_c = None, None
    if problem.reference_method:
        exact = [x for x in rows_src if x[1]["method_id"] == problem.reference_method[0]]
        if exact:
            ref_c = exact[-1][0]
            ref = {k[0]: rs[0]["validation"]["metrics"] for k, rs in by_cell(exact[-1][2]).items()}
            for _c, _m, runs in exact[:-1]:
                mism = [k[0] for k, rs in by_cell(runs).items() if problem.objective_key(rs[0]["validation"]["metrics"])
                        != problem.objective_key(ref.get(k[0], rs[0]["validation"]["metrics"]))]
                if mism:
                    warnings.append(f"reference runs disagree between campaigns on {len(mism)} scenario(s)")
    if ref is None:
        warnings.append("no reference method in the lineage: reference-based columns are not computed")

    groups = {h: problem.instance_group(ws.inst.get_instance(h)) for h in ref_set}
    fact_defs = problem.run_fact_definitions()
    table, keys = [], {}
    for c, m, runs in rows_src:
        cells = {k[0]: v for k, v in by_cell(runs).items()}
        feas = all(r["accepted"] and r["validation"]["feasible"] for rs in cells.values() for r in rs)
        totals = {met.id: sum(rs[0]["validation"]["metrics"].get(met.id, 0) for rs in cells.values()) for met in problem.metrics}
        alias = problem.method_display_name(m["method_id"], (c["config"].get("method_configs") or {}).get(m["method_id"]) or {})
        row = dict(method_id=m["method_id"], version=m["version"], name=alias or m.get("name"), recorded_name=m.get("name"), kind=m.get("kind"),
                   source=m["source"], code_sha256=m.get("code_sha256"), campaign_id=c["campaign_id"],
                   campaign_kind=c["kind"], origin=("imported results (computed elsewhere, re-validated here, not executed here)"
                                                       if c.get("result_import") else ORIGIN[c["kind"]]), researcher=c["owner_display"],
                   installation_id=c["installation_id"], environment=c.get("environment"),
                   repetitions=c["config"]["repetitions"], scenarios=len(cells), all_feasible=feas, totals=totals,
                   repetitions_consistent=all(consistent(rs) for rs in cells.values()),
                   median_solver_time_s=median_or_none(med(rs, "solver_time_s") for rs in cells.values()),
                   median_total_time_s=median_or_none(med(rs, "total_time_s") for rs in cells.values()),
                   reproduction_status=None)
        scopes: dict[str, int] = {}
        per: dict[str, dict] = {}
        for h, rs in cells.items():
            inst_h = ws.inst.get_instance(h)
            lab = optimality_scope(rs[0], inst_h, m.get("kind"))
            scopes[lab] = scopes.get(lab, 0) + 1
            # one scenario on its own: values of repetition 1 (``consistent`` says whether every repetition agreed),
            # times as the median over this scenario's repetitions — never mixed with the all-scenario totals
            per[h] = dict(metrics=rs[0]["validation"]["metrics"], repetitions=len(rs), consistent=consistent(rs),
                          feasible=all(r["accepted"] and r["validation"]["feasible"] for r in rs),
                          # why the validator rejected this cell (its own messages; empty when every run was accepted)
                          errors=[str(e)[:200] for r in rs if not r["accepted"] for e in ((r.get("validation") or {}).get("errors") or [])[:2]][:3],
                          accepted=sum(1 for r in rs if r["accepted"]), optimality=lab,
                          median_solver_time_s=med(rs, "solver_time_s"), median_total_time_s=med(rs, "total_time_s"),
                          domain=rs[0].get("domain"), gap_pct=None, facts=problem.run_facts(rs[0], inst_h) if fact_defs else {},
                          # every recorded run of this cell (for distributions: box plots, per-repetition lines)
                          runs=[dict(repetition=r.get("repetition"), total_time_s=r.get("total_time_s"),
                                     solver_time_s=r.get("solver_time_s"), accepted=r.get("accepted"))
                                for r in sorted(rs, key=lambda r: r.get("repetition") or 0)])
        row["optimality_scope"] = scopes
        row["per_scenario"] = per
        row["facts"] = aggregate_facts(fact_defs, [p_["facts"] for p_ in per.values()])
        row["domain"] = problem.aggregate_domain([rs[0].get("domain") for rs in cells.values()])
        if ref is not None:
            matches, shortfall, gaps, optimal = [0] * len(levels), 0.0, [], 0
            for h, rs in cells.items():
                v, r0 = rs[0]["validation"]["metrics"], ref[h]
                shortfall += _worse_by(levels[0].sense, v[levels[0].metric], r0[levels[0].metric])
                k = 0
                while k < len(levels) and v[levels[k].metric] == r0[levels[k].metric]:
                    matches[k] += 1
                    k += 1
                if k == len(levels):
                    optimal += 1
                if k >= len(levels) - 1:                                 # all previous levels equal the reference
                    last = levels[-1]
                    if r0[last.metric]:
                        g = 100.0 * _worse_by(last.sense, v[last.metric], r0[last.metric]) / abs(r0[last.metric])
                        gaps.append(g)
                        per[h]["gap_pct"] = round(g, 6)
                    else:
                        per[h]["gap_pct"] = 0.0 if v[last.metric] == r0[last.metric] else None
            row.update(reference_matches=matches, optimal=optimal, shortfall=round(shortfall, 6),
                       final_level_gap_pct=summary_stats(gaps))
        by_group: dict[str, dict] = {}
        for g in sorted(set(groups.values())):
            hs = [h for h in cells if groups.get(h) == g]
            if hs:
                by_group[g] = dict(scenarios=len(hs),
                                   totals={met.id: sum(cells[h][0]["validation"]["metrics"].get(met.id, 0) for h in hs)
                                           for met in problem.metrics},
                                   optimal=(sum(1 for h in hs if problem.objective_key(cells[h][0]["validation"]["metrics"])
                                                == problem.objective_key(ref[h])) if ref is not None else None),
                                   median_solver_time_s=median_or_none(med(cells[h], "solver_time_s") for h in hs),
                                   median_total_time_s=median_or_none(med(cells[h], "total_time_s") for h in hs))
        row["by_group"] = by_group
        table.append(row)
        for h, rs in cells.items():                                       # first row of each method in lineage order
            keys.setdefault(h, {}).setdefault(m["method_id"], problem.objective_key(rs[0]["validation"]["metrics"]))
    ranks: dict[str, list[int]] = {}
    for per_method in keys.values():
        order = sorted(set(per_method.values()))
        for mid, key in per_method.items():
            ranks.setdefault(mid, []).append(order.index(key) + 1)
    for t in table:
        rs = ranks.get(t["method_id"])
        t["mean_rank"] = round(sum(rs) / len(rs), 3) if rs else None
        if t["campaign_kind"] == "reproduction":
            t["reproduction_status"] = "REPRODUCED" if reproducibility(ws, t["campaign_id"])["numerically_reproduced"] \
                else "NOT REPRODUCED"
    return dict(campaign_id=cid, problem=dict(problem.spec_record(), title=problem.title, synthetic=problem.synthetic),
                objective=[o.to_dict() for o in levels], metrics=[m.to_dict() for m in problem.metrics],
                domain_metrics=problem.domain_metric_definitions(),
                lineage=[dict(campaign_id=c["campaign_id"], kind=c["kind"], owner_display=c["owner_display"],
                              installation_id=c["installation_id"], checksum=c.get("checksum"), title=c["title"],
                              imported_results=bool(c.get("result_import")),
                              relation=(c.get("parent") or {}).get("relation")) for c in chain],
                scenarios=len(ref_set),
                instance_hashes_identical=all(c["scenario_set"]["instance_hashes"] == ref_set for c, _, _ in rows_src),
                reference=(dict(method_id=problem.reference_method[0], campaign_id=ref_c["campaign_id"],
                                owner_display=ref_c["owner_display"]) if ref_c else None),
                ranking_rule="lexicographic: " + ", then ".join(f"{o.sense} {o.metric}" for o in levels)
                             + "; a method worse on an earlier level is never ranked better; ties share a rank",
                timing_definitions=dict(solver_time="solver-reported time, or method time when there is no solver",
                                        total_time="platform wall time of the isolated execution"),
                warnings=warnings, rows=table, synthetic=problem.synthetic)


def aggregate_facts(defs: list[dict], per: list[dict]) -> dict:
    """Facts over the scenarios of a row: a sum, a median, or a ratio of sums (in %); ``none`` facts (e.g. a solver
    status or a gap of one scenario) are never aggregated. A fact missing in any scenario is not aggregated."""
    out = {}
    for d in defs:
        vals = [f.get(d["id"]) for f in per]
        how = d.get("aggregate", "none")
        if how == "ratio":
            a, b = d["of"]
            num, den = [f.get(a) for f in per], [f.get(b) for f in per]
            ok = all(isinstance(x, (int, float)) for x in num + den) and sum(den) > 0
            out[d["id"]] = round(100.0 * sum(num) / sum(den), 4) if ok else None
        elif how in ("sum", "median"):
            if per and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in vals):
                out[d["id"]] = round(sum(vals), 6) if how == "sum" else round(statistics.median(vals), 6)
            else:
                out[d["id"]] = None
    return out
