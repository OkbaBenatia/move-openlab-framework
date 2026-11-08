"""Public ride-matching benchmark on OpenStreetMap road networks (see :mod:`.model` for the formulation).

Instances are built from scenarios (map editor, seeded generator, or empirical distributions of open carpooling
data) by :mod:`move_openlab.geo.scenarios`; they embed all travel times they need, so validation, comparison and
reproduction never require the road network. The network is only needed to build instances and to draw routes.
"""
from __future__ import annotations

import copy

from ...hashing import with_hash
from ...problem import MetricDefinition, ObjectiveLevel, Problem, Variant
from ...scoring import KeepAllScorer, Scorer
from . import model as M


def _pair_id(d: str, r: str) -> str:
    return f"{d}|{r}"


class RelativeDetourScorer(Scorer):
    id = "relative-detour"
    label = "Relative detour (transparent baseline)"
    description = "Smallest detour among the rider's options divided by the pair detour; 1 = the rider's best option."

    def score(self, instance, cands):
        best: dict[str, int] = {}
        for p in instance["pairs"]:
            best[p["rider"]] = min(best.get(p["rider"], p["detour_s"]), p["detour_s"])
        return {_pair_id(p["driver"], p["rider"]): 1.0 if p["detour_s"] == 0 else round(best[p["rider"]] / p["detour_s"], 6)
                for p in instance["pairs"]}


def _derive(parent: dict, code: str, child: dict, modification: dict) -> dict:
    child["instance_id"] = f"{parent['instance_id']}~{code}"
    child["derivation"] = dict(parent_instance_id=parent["instance_id"], parent_instance_hash=parent["instance_hash"],
                               variant=code, modification=modification)
    return with_hash(child)


def detour_tightening(parent: dict) -> dict | None:
    limit = int(parent["params"]["max_detour_s"] * 0.5)
    child = copy.deepcopy(parent)
    child["pairs"] = [p for p in parent["pairs"] if p["detour_s"] <= limit]
    removed = len(parent["pairs"]) - len(child["pairs"])
    if removed == 0:
        return None
    child["params"]["max_detour_s"] = limit
    return _derive(parent, "detour-tightening", child, dict(field="params.max_detour_s", old=parent["params"]["max_detour_s"],
                                                            new=limit, pairs_removed=removed, intent="binding"))


def detour_nonbinding(parent: dict) -> dict | None:
    if not parent["pairs"]:
        return None
    limit = max(p["detour_s"] for p in parent["pairs"])
    if limit >= parent["params"]["max_detour_s"]:
        return None
    child = copy.deepcopy(parent)
    child["params"]["max_detour_s"] = limit
    return _derive(parent, "detour-nonbinding", child, dict(field="params.max_detour_s", old=parent["params"]["max_detour_s"],
                                                            new=limit, pairs_removed=0,
                                                            intent="non-binding: lowered to the largest existing detour"))


class RideMatching(Problem):
    problem_id = M.PROBLEM_ID
    problem_spec_version = M.PROBLEM_SPEC_VERSION
    objective_spec_id = M.OBJECTIVE_SPEC_ID
    constraint_spec_id = M.CONSTRAINT_SPEC_ID
    instance_schema = M.INSTANCE_SCHEMA
    validator_version = M.VALIDATOR_VERSION
    title = "Ride matching on road networks"
    description = ("Match riders to drivers (one rider per driver) on an OpenStreetMap road network: maximise served "
                   "riders, then minimise the drivers' total detour. Scenarios come from the map editor, a seeded "
                   "generator or open carpooling data distributions.")
    synthetic = False
    objective = (ObjectiveLevel("served", "max"), ObjectiveLevel("detour_s", "min"))
    metrics = (MetricDefinition("served", "Served riders", "rider", "number of riders with a validated match", "higher"),
               MetricDefinition("detour_s", "Total detour", "s", "sum of the drivers' detour times of the validated matches",
                                "lower"))
    reference_method = ("exact-matching-highs", "1.0.0")
    decision_description = "[driver_id, rider_id] for every match"

    def scenario_parameters(self) -> dict:
        return dict(fields=[dict(id="instance_hashes", label="Scenarios", type="scenario-library",
                                 help="Choose scenarios from the scenario library (map editor, generator, open data).")],
                    defaults=dict(instance_hashes=[]))

    def generate_scenarios(self, params: dict):
        raise ValueError("this problem builds instances from the scenario library; pass instance_hashes")

    def selftest_instance(self) -> dict:
        drivers = [dict(id="D1", origin=[0.0, 0.0], destination=[0.0, 0.0], earliest=0, latest=600, direct_s=600)]
        riders = [dict(id="R1", origin=[0.0, 0.0], destination=[0.0, 0.0], earliest=0, latest=900, direct_s=300)]
        pairs = [dict(driver="D1", rider="R1", to_pickup_s=100, ride_s=300, to_dest_s=300, detour_s=100,
                      pickup_earliest=100, pickup_latest=700)]
        return with_hash(dict(schema=M.INSTANCE_SCHEMA, problem_id=M.PROBLEM_ID, problem_spec_version=M.PROBLEM_SPEC_VERSION,
                              instance_id="ride-selftest", name="self-test", params=dict(max_detour_s=900, max_detour_ratio=1.0),
                              drivers=drivers, riders=riders, pairs=pairs, provenance=dict(source="self-test")))

    def instance_group(self, instance: dict) -> str:
        return (instance.get("provenance") or {}).get("source", "other")

    def check_instance_content(self, instance):
        return M.check_content(instance)

    def check_decisions(self, decisions):
        return M.check_decisions(decisions)

    def validate(self, instance, decisions):
        return M.validate(instance, decisions)

    def canonical_decisions(self, decisions):
        return sorted([list(d) for d in decisions])

    def builtin_methods(self):
        return [(M.EXACT_META, M.solve_exact), (M.GREEDY_META, M.solve_greedy)]

    def environment(self) -> dict:
        try:
            import highspy
            return dict(highs_version=highspy.Highs().version())
        except Exception:
            return dict(highs_version=None)

    def descriptive_metrics(self, instances, totals):
        riders = sum(len(i["riders"]) for i in instances)
        served, detour = totals.get("served", 0), totals.get("detour_s", 0)
        return [dict(id="service_rate", label="Service rate", unit="%", better="higher",
                     value=round(100.0 * served / riders, 1) if riders else None),
                dict(id="mean_detour_s", label="Mean detour per served rider", unit="s", better="lower",
                     value=round(detour / served, 1) if served else None)]

    def objective_definitions(self):
        return dict(M.OBJECTIVES)

    def problem_components(self, instance, objective_spec_id):
        return M.components(instance, objective_spec_id)

    def explain_problem_differences(self, a, b):
        return M.explain(a, b)

    def variants(self):
        vs = [Variant("detour-tightening", "detour limit halved (removes compatible pairs)", detour_tightening),
              Variant("detour-nonbinding", "detour limit lowered to the largest existing detour (no pair removed)",
                      detour_nonbinding),
              Variant("time-budget-1s", "time budget 1 s instead of the default (problem unchanged)", None,
                      dict(time_budget_s=1.0, method_configs={"exact-matching-highs": {"time_limit_s": 1.0}}))]
        return {v.id: v for v in vs}

    def supports_candidates(self) -> bool:
        return True

    def candidates(self, instance):
        return [dict(id=_pair_id(p["driver"], p["rider"]), groups=[f"D:{p['driver']}", f"R:{p['rider']}"],
                     features=dict(detour_s=p["detour_s"])) for p in instance["pairs"]]

    def decision_candidate(self, decision) -> str:
        return _pair_id(decision[0], decision[1])

    def restrict(self, instance, keep, derivation):
        child = dict(instance)
        child["pairs"] = [p for p in instance["pairs"] if _pair_id(p["driver"], p["rider"]) in keep]
        t = derivation.get("threshold")
        child["instance_id"] = f"{instance['instance_id']}~{derivation.get('scorer', 'pruned')}" + (f"@{t:g}" if t is not None else "")
        child["derivation"] = dict(derivation, kept=len(child["pairs"]), total=len(instance["pairs"]))
        return with_hash(child)

    def scorers(self):
        return {s.id: s for s in (KeepAllScorer(), RelativeDetourScorer())}


problem = RideMatching()
