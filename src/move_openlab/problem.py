"""The problem interface: everything the framework needs to know about an optimization problem (a benchmark).

The framework itself never knows what a driver, a route or a cost is. A problem definition provides:

* **specification** — problem, objective and constraint identifiers, instance schema, validator version;
* **scenarios** — a deterministic scenario generator (or loader) and a reserved self-test instance;
* **validation** — structural integrity of instances and an *independent* solution validator that recomputes
  feasibility and every metric from the instance and the returned decisions only;
* **objective semantics** — named metrics and a lexicographic list of objective levels (a single objective is one
  level), from which every ranking, gap and optimality count is derived;
* **built-in methods** — reference methods shipped with the problem (the same contract as researcher plugins);
* **semantic comparability** — the data that define the feasible region and the objective, and a component-level
  explanation of differences between two instances;
* **controlled variants** — optional instance-level or configuration-level perturbation operators;
* **candidate scoring** — optional candidate decisions that a scorer may prune before solving (threshold studies).

Problems are registered with the ``move_openlab.problems`` entry-point group (see :mod:`move_openlab.registry`).
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field
from typing import Any, Callable

from .hashing import instance_hash

SENSES = ("max", "min")


@dataclass(frozen=True)
class MetricDefinition:
    id: str
    label: str
    unit: str
    definition: str
    better: str | None = None          # "higher" | "lower" | None (descriptive metric)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class ObjectiveLevel:
    metric: str
    sense: str                          # "max" | "min"

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class Variant:
    """A controlled perturbation. ``apply`` derives a new instance (or returns None when the perturbation cannot be
    made effective on that instance); ``config_patch`` changes the experiment configuration instead."""
    id: str
    description: str
    apply: Callable[[dict], dict | None] | None = None
    config_patch: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return dict(id=self.id, description=self.description, instance_level=self.apply is not None,
                    config_patch=self.config_patch)


class Problem(ABC):
    # ---------------------------------------------------------------- specification (class attributes)
    problem_id: str
    problem_spec_version: str
    objective_spec_id: str
    constraint_spec_id: str
    instance_schema: str
    validator_version: str
    title: str
    description: str
    synthetic: bool = False
    objective: tuple[ObjectiveLevel, ...] = ()
    metrics: tuple[MetricDefinition, ...] = ()
    reference_method: tuple[str, str] | None = None      # (method_id, version) used as the quality reference
    decision_description: str = ""
    default_time_budget_s: float = 60.0

    def spec_record(self) -> dict:
        return dict(problem_id=self.problem_id, problem_spec_version=self.problem_spec_version,
                    objective_spec_id=self.objective_spec_id, constraint_spec_id=self.constraint_spec_id,
                    instance_schema=self.instance_schema)

    def describe(self) -> dict:
        return dict(spec=self.spec_record(), title=self.title, description=self.description, synthetic=self.synthetic,
                    validator_version=self.validator_version, objective=[o.to_dict() for o in self.objective],
                    metrics=[m.to_dict() for m in self.metrics],
                    reference_method=list(self.reference_method) if self.reference_method else None,
                    decision_description=self.decision_description, scenario_parameters=self.scenario_parameters(),
                    variants=[v.to_dict() for v in self.variants().values()],
                    scorers=[dict(id=s.id, label=s.label, description=s.description, learned=s.learned)
                             for s in self.scorers().values()],
                    candidate_scoring=self.supports_candidates())

    # ---------------------------------------------------------------- scenarios
    @abstractmethod
    def scenario_parameters(self) -> dict:
        """Description of the scenario-set parameters for user interfaces: ``{"fields": [...], "defaults": {...}}``."""

    @abstractmethod
    def generate_scenarios(self, params: dict) -> tuple[list[dict], dict]:
        """Deterministic scenario set: (instances, scenario-set metadata). Raises ValueError on invalid params."""

    @abstractmethod
    def selftest_instance(self) -> dict:
        """A reserved instance (never part of a benchmark scenario set) used to self-test a method at registration."""

    def instance_group(self, instance: dict) -> str:
        """Group label used for per-group result tables (e.g. instance size)."""
        return "all"

    # ---------------------------------------------------------------- integrity and validation
    def check_instance(self, instance: dict) -> list[str]:
        errs = [] if instance.get("instance_hash") == instance_hash(instance) else ["instance hash mismatch"]
        if instance.get("problem_id") not in (None, self.problem_id):
            errs.append(f"instance belongs to problem {instance.get('problem_id')!r}")
        return errs + self.check_instance_content(instance)

    @abstractmethod
    def check_instance_content(self, instance: dict) -> list[str]:
        """Problem-specific structural checks (identifiers, types, references)."""

    @abstractmethod
    def check_decisions(self, decisions: Any) -> list[str]:
        """Schema of the ``decisions`` field of a method output (before any recomputation)."""

    @abstractmethod
    def validate(self, instance: dict, decisions: list) -> dict:
        """Independent validation. Returns ``{"feasible": bool, "errors": [...], "metrics": {...},
        "validator_version": str}``; metrics are recomputed from the instance and the decisions only."""

    def canonical_decisions(self, decisions: list) -> list:
        """Order-independent representation used to compare two solutions."""
        return sorted(decisions, key=repr)

    # ---------------------------------------------------------------- objective semantics
    def objective_key(self, metrics: dict) -> tuple:
        """Smaller is better, level by level (max levels are negated)."""
        return tuple(-metrics[o.metric] if o.sense == "max" else metrics[o.metric] for o in self.objective)

    def objective_definitions(self) -> dict[str, dict]:
        """Objective *definitions* by objective-spec id (used by the problem fingerprint)."""
        return {self.objective_spec_id: dict(levels=[o.to_dict() for o in self.objective])}

    # ---------------------------------------------------------------- methods
    @abstractmethod
    def builtin_methods(self) -> list[tuple[dict, Callable]]:
        """[(method metadata, solve function)] shipped with the problem."""

    def environment(self) -> dict:
        """Extra environment fields relevant to this problem's methods (e.g. solver versions)."""
        return {}

    # ---------------------------------------------------------------- semantic comparability
    def evaluation_contract(self) -> dict:
        """How reported metrics are defined. Positive scaling of one metric is a verified normalisation."""
        return dict(metrics={m.id: dict(definition=m.definition, unit=m.unit, aggregation="sum", scale=1)
                             for m in self.metrics},
                    ranking="lexicographic: " + ", then ".join(f"{o.sense} {o.metric}" for o in self.objective),
                    validator=f"{self.problem_id}.validator/{self.validator_version}",
                    timing=dict(solver_time="solver-reported time; method wall time when no solver",
                                total_time="platform wall time of the isolated execution",
                                statistic="median over repetitions"))

    def metric_values(self, validation: dict, instance: dict, decisions: list, evaluation: dict) -> dict:
        """Metrics as defined by an evaluation contract (default: canonical value x scale)."""
        out = {}
        for mid, spec in evaluation["metrics"].items():
            if spec.get("aggregation", "sum") != "sum":
                raise ValueError(f"no rule maps aggregation {spec['aggregation']!r} of {mid}")
            out[mid] = validation["metrics"][mid] * spec.get("scale", 1)
        return out

    def descriptive_metrics(self, instances: list[dict], totals: dict) -> list[dict]:
        """Descriptive figures derived from validated totals (e.g. a rate), for display only: never used for
        validation, ranking or comparability. ``[{"id", "label", "unit", "value", "better"}]``; default none."""
        return []

    @abstractmethod
    def problem_components(self, instance: dict, objective_spec_id: str) -> dict:
        """``{"region": ..., "coefficients": ..., "objective": ...}``: the data that define the optimization problem
        (feasible region, objective coefficients, objective definition), excluding bookkeeping and non-binding data."""

    @abstractmethod
    def explain_problem_differences(self, a: dict, b: dict) -> dict:
        """``{"dimensions": [{dimension, detail}], "nonbinding": [{dimension, detail}]}`` for two instances (the
        objective dimension is handled by the framework)."""

    # ---------------------------------------------------------------- controlled variants
    def variants(self) -> dict[str, Variant]:
        return {}

    # ---------------------------------------------------------------- candidate scoring (optional)
    def supports_candidates(self) -> bool:
        return False

    def candidates(self, instance: dict) -> list[dict]:
        """Candidate decisions ``[{"id": str, "groups": [str, ...], "features": {...}}]`` a scorer may prune."""
        raise NotImplementedError

    def decision_candidate(self, decision: Any) -> str:
        """Candidate id that a decision uses."""
        raise NotImplementedError

    def restrict(self, instance: dict, keep: set[str], derivation: dict) -> dict:
        """A new instance keeping only the given candidates (with ``derivation`` recorded and a new hash)."""
        raise NotImplementedError

    def scorers(self) -> dict:
        return {}
