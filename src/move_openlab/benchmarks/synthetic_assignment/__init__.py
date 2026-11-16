"""Synthetic capacitated assignment benchmark — the first public example problem of MOVE OpenLab.

Fully synthetic: artificial drivers, passengers, coordinates, time windows and costs generated deterministically from
a seed. It exercises every framework capability (exact and heuristic reference methods, researcher plugins,
independent validation, campaign locking, portable bundles, re-execution, extension, comparison, semantic
comparability, controlled variants and candidate-pruning threshold studies) on a problem small enough to be certified
by an independent min-cost-flow oracle. It is not evidence about real-world mobility.
"""
from __future__ import annotations

from ...problem import MetricDefinition, ObjectiveLevel, Problem
from . import generator, methods, scoring, semantics, spec, validator, variants


class SyntheticAssignment(Problem):
    problem_id = spec.PROBLEM_ID
    problem_spec_version = spec.PROBLEM_SPEC_VERSION
    objective_spec_id = spec.OBJECTIVE_SPEC_ID
    constraint_spec_id = spec.CONSTRAINT_SPEC_ID
    instance_schema = spec.INSTANCE_SCHEMA
    validator_version = spec.VALIDATOR_VERSION
    title = "Synthetic capacitated assignment"
    description = ("Capacitated bipartite assignment between artificial drivers and passengers: maximise the number of "
                   "served passengers, then minimise the total pair cost. Synthetic data only.")
    synthetic = True
    objective = (ObjectiveLevel("served", "max"), ObjectiveLevel("cost", "min"))
    metrics = (MetricDefinition("served", "Served passengers", "passenger",
                                "number of distinct passengers with a validated assignment", "higher"),
               MetricDefinition("cost", "Total cost", "cost-unit", "sum of the pair costs of the validated assignments",
                                "lower"))
    reference_method = ("exact-milp-highs", "1.0.0")
    decision_description = "[driver_id, passenger_id] for every assignment"
    participants = "passengers"                           # no map: instances carry no coordinates

    # scenarios
    def scenario_parameters(self) -> dict:
        return dict(fields=[dict(id="sizes", label="Instance sizes", type="multi-choice",
                                 choices=[dict(id=k, label=f"{k}: {d} drivers x {p} passengers")
                                          for k, (d, p) in generator.SIZES.items()]),
                            dict(id="seeds", label="Seeds", type="int-list", min=1, max=1_000_000,
                                 help="Seed 0 is reserved for method self-tests.")],
                    defaults=dict(sizes=list(generator.SIZES), seeds=generator.SEEDS))

    def generate_scenarios(self, params: dict) -> tuple[list[dict], dict]:
        sizes = params.get("sizes", list(generator.SIZES))
        seeds = params.get("seeds", generator.SEEDS)
        if not isinstance(sizes, list) or not sizes or any(s not in generator.SIZES for s in sizes) or len(set(sizes)) != len(sizes):
            raise ValueError(f"sizes must be a non-empty list of distinct values among {list(generator.SIZES)}")
        if (not isinstance(seeds, list) or not 1 <= len(seeds) <= 100 or len(set(seeds)) != len(seeds)
                or any(not isinstance(k, int) or isinstance(k, bool) or not 1 <= k <= 1_000_000 for k in seeds)):
            raise ValueError("seeds must be 1-100 distinct integers in [1, 1000000] (0 is reserved)")
        insts = [generator.generate(s, k) for s in sizes for k in seeds]
        return insts, dict(params=dict(sizes=sizes, seeds=seeds),
                           generator=dict(name=generator.GENERATOR_NAME, version=generator.GENERATOR_VERSION))

    def selftest_instance(self) -> dict:
        return generator.generate("small", 0)

    def instance_group(self, instance: dict) -> str:
        return (instance.get("generator") or {}).get("size", "other")

    # validation
    def check_instance_content(self, instance: dict) -> list[str]:
        return validator.check_instance_content(instance)

    def check_decisions(self, decisions) -> list[str]:
        return validator.check_decisions(decisions)

    def validate(self, instance: dict, decisions: list) -> dict:
        return validator.validate(instance, decisions)

    def canonical_decisions(self, decisions: list) -> list:
        return sorted([list(d) for d in decisions])

    # methods
    def builtin_methods(self):
        return list(methods.BUILTIN)

    def environment(self) -> dict:
        try:
            import highspy
            return dict(highs_version=highspy.Highs().version())
        except Exception:
            return dict(highs_version=None)

    # comparability
    def evaluation_contract(self) -> dict:
        ev = super().evaluation_contract()
        ev["validator"] = f"move_openlab.synthetic_assignment.validator/{spec.VALIDATOR_VERSION}"
        return ev

    def metric_values(self, validation: dict, instance: dict, decisions: list, evaluation: dict) -> dict:
        cspec = evaluation["metrics"]["cost"]
        cost_of = {(p["driver"], p["passenger"]): p["cost"] for p in instance["compatible_pairs"]}
        costs = [cost_of[k] for k in {tuple(d) for d in decisions} if k in cost_of]
        agg = cspec.get("aggregation", "sum")
        if agg == "sum":
            base = sum(costs)
        elif agg == "max":
            base = max(costs) if costs else 0
        else:
            raise ValueError(f"unknown cost aggregation {agg!r}")
        return dict(served=validation["metrics"]["served"] * evaluation["metrics"]["served"].get("scale", 1),
                    cost=base * cspec.get("scale", 1))

    def objective_definitions(self) -> dict:
        return dict(semantics.OBJECTIVES)

    def problem_components(self, instance: dict, objective_spec_id: str) -> dict:
        return semantics.components(instance, objective_spec_id)

    def explain_problem_differences(self, a: dict, b: dict) -> dict:
        return semantics.explain(a, b)

    def variants(self):
        return variants.variants()

    # candidate scoring
    def supports_candidates(self) -> bool:
        return True

    def candidates(self, instance: dict) -> list[dict]:
        return scoring.candidates(instance)

    def decision_candidate(self, decision) -> str:
        return scoring.pair_id(decision[0], decision[1])

    def restrict(self, instance: dict, keep: set[str], derivation: dict) -> dict:
        return scoring.restrict(instance, keep, derivation)

    def scorers(self):
        return scoring.scorers()


problem = SyntheticAssignment()
