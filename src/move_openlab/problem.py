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
* **candidate scoring** — optional candidate decisions that a scorer may prune before solving (threshold studies);
* **presentation** — optional capabilities the interface may use (map, route playback), the plural noun of what the
  ``served`` metric counts, and a per-scenario summary (counts and the denominator of ``served``).

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
    # presentation only (never part of the evaluation contract or of a fingerprint):
    category: str | None = None        # metric group in the interface: "optimization" (default) | "mobility" | "performance" | "ml"
    note: str | None = None            # how to read the metric (a boundary, a caveat), shown with its definition

    def to_dict(self) -> dict:
        d = asdict(self)
        for k in ("category", "note"):  # records and reports made before these existed stay identical
            if d[k] is None:
                del d[k]
        return d


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
    #: A restricted problem is visible only to the accounts an administrator granted it to on this installation
    #: (:mod:`move_openlab.access`). No role implies the grant. Problems shipped with the framework are open.
    restricted: bool = False

    def spec_record(self) -> dict:
        return dict(problem_id=self.problem_id, problem_spec_version=self.problem_spec_version,
                    objective_spec_id=self.objective_spec_id, constraint_spec_id=self.constraint_spec_id,
                    instance_schema=self.instance_schema)

    def describe(self) -> dict:
        return dict(spec=self.spec_record(), title=self.title, description=self.description, synthetic=self.synthetic,
                    restricted=bool(self.restricted),
                    validator_version=self.validator_version, objective=[o.to_dict() for o in self.objective],
                    metrics=[m.to_dict() for m in self.metrics],
                    reference_method=list(self.reference_method) if self.reference_method else None,
                    decision_description=self.decision_description, scenario_parameters=self.scenario_parameters(),
                    variants=[v.to_dict() for v in self.variants().values()],
                    scorers=[dict(id=s.id, label=s.label, description=s.description, learned=s.learned)
                             for s in self.scorers().values()],
                    candidate_scoring=self.supports_candidates(), presentation=self.presentation())

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

    def archived_methods(self) -> frozenset[str]:
        """Ids of built-in methods kept only so that earlier records stay readable and reproducible (pilots, superseded
        versions). The interface lists them under *History*, not among the methods offered for a new run."""
        return frozenset()

    # ---------------------------------------------------------------- presentation (optional, read by the interface)
    #: ``"map"``: instances carry ``drivers`` / ``riders`` with ``origin`` / ``destination`` coordinates for the map;
    #: ``"playback"``: route playback of a run (see :meth:`playback`; implies ``"map"``).
    capabilities: frozenset[str] = frozenset()
    #: Plural noun of what the ``served`` metric counts (e.g. "riders"); default: that metric's unit.
    participants: str | None = None
    #: Why scenarios of this problem cannot be edited or generated in the interface (shown where editing is offered for
    #: other problems); ``None`` when the problem has no such limit to state.
    authoring_note: str | None = None

    def participant_properties(self, instance: dict) -> dict[str, list[list[str]]]:
        """What the interface may show about a participant or vehicle of a scenario when its marker is clicked, beyond
        the generic fields it reads itself (identifier, time window, vehicle profile): ``{participant id: [[label,
        value], ...]}``. Display only, from the frozen instance; never computed by a method."""
        return {}

    def playback(self, instance: dict, decisions: list) -> dict:
        """Route playback of one run: ``{t_min, t_max, vehicles: [{driver, rider, path: [[lat, lon, t]], stops}],
        unserved: [{rider, at}], served, riders, geometry, attribution}``. Overriding it declares ``"playback"``.
        A problem that declares ``"playback"`` without overriding it uses the built-in mobility planner (instances with
        ``drivers``, ``riders`` and a road network). Raise ``ValueError`` when no playback exists for this instance."""
        raise NotImplementedError

    def candidate_view(self, instance: dict, run: dict) -> dict:
        """Read-only view of the candidate reduction behind one run, for methods that remove candidates (e.g. arcs)
        before an exact solve: ``{stops: [{node, lat, lon}], vehicles: [{vehicle_id, label}], edges: [{edge_id, i, j}],
        removed, protected, selected: [[vehicle_id, edge_id]], counts: {candidates, retained, removed, protected,
        selected, reduction_pct}, policy, checks, sources, geometry}``. Built from recorded data only, never recomputed.
        Overriding it declares ``"candidates"`` (implies ``"map"``). Raise ``ValueError`` when the data behind a run is
        not available."""
        raise NotImplementedError

    def candidate_preview(self, instance: dict, method: dict, config: dict) -> dict:
        """The candidate reduction a method would apply to one instance with the given (already validated) settings,
        before any solve: the same shape as :meth:`candidate_view` plus ``preview: true``, ``policy``, ``timings``
        (e.g. inference time) and ``provenance`` (model, policy, feature pipeline). Nothing is solved or stored.
        Overriding it declares ``"candidate-preview"``. Raise ``ValueError`` when the method removes no candidates or
        the data needed for this instance are not available."""
        raise NotImplementedError

    def method_display_name(self, method_id: str, config: dict) -> str | None:
        """A display alias of a method in an experiment with the given settings (e.g. its publication name); ``None``
        keeps the recorded name. Display only: stored records keep their names."""
        return None

    def run_fact_definitions(self) -> list[dict]:
        """Per-run figures a method records (see :meth:`run_facts`): ``[{id, label, unit, kind: "number" | "text",
        aggregate: "sum" | "median" | "ratio" | "none", of?: [numerator id, denominator id] (ratio, in %), group}]``.
        ``none``: shown per scenario only, never summed over scenarios. Optional keys for the interface: ``category``
        (``"optimization"`` (default) | ``"performance"`` | ``"ml"`` | ``"mobility"``: the group in *Choose metrics*),
        ``default`` (shown without being chosen; default: aggregated numbers), ``help`` (a definition), ``speedup``
        (``true`` on one time fact: reference ÷ this is offered as a speed-up, a ratio of sums)."""
        return []

    def run_facts(self, run: dict, instance: dict) -> dict:
        """``{fact id: value}`` of one run, from what the run recorded (never recomputed by solving). Display only:
        validation, ranking and comparability never use them."""
        return {}

    def ml_evaluations(self, method_id: str, config: dict) -> list[dict]:
        """Classification evaluations of a learned method, from real predictions and real labels on a named population:
        ``[{population, split, graphs, candidates, positives, prevalence_pct, decision, positive_label, convention,
        confusion: {tp, fn, fp, tn}, metrics: {accuracy, balanced_accuracy, precision, recall, specificity, f1, pr_auc,
        roc_auc}, source: {name, sha256}, notes: [str]}]``. ``decision`` says which score and threshold or policy produced
        the matrix. Return ``[]`` when no labelled evaluation exists: the interface then says so and shows no figure.
        Display only; a problem must never derive these from solver outcomes alone."""
        return []

    def scenario_notes(self, instance: dict) -> list[str]:
        """Documented limitations of a scenario, shown next to its results."""
        return []

    def presentation(self) -> dict:
        """What the interface may show for this problem; derived from the declarations above and the metrics."""
        caps = set(self.capabilities)
        if overrides(self, "playback"):
            caps.add("playback")
        if overrides(self, "candidate_view"):
            caps.add("candidates")
        if overrides(self, "candidate_preview"):
            caps.add("candidate-preview")
        if caps & {"playback", "candidates", "candidate-preview"}:
            caps.add("map")
        served = next((m for m in self.metrics if m.id == "served"), None)
        return dict(capabilities=sorted(caps), participants=self.participants or (served.unit if served else None),
                    served_label=served.label if served else None, authoring_note=self.authoring_note)

    def scenario_summary(self, instance: dict) -> dict:
        """Counts shown per scenario. ``served_of`` (the denominator of ``served``) comes from an integer
        ``served_denominator`` in the instance; without it the interface uses the number of riders."""
        out = {k: len(instance[k]) for k in ("drivers", "riders", "pairs") if isinstance(instance.get(k), list)}
        d = instance.get("served_denominator")
        if isinstance(d, int) and not isinstance(d, bool) and d >= 0:
            out["served_of"] = d
        return out

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

    # ---------------------------------------------------------------- domain metrics (optional)
    # Figures a problem's domain derives from validated decisions (never from a method's report), outside the
    # objective: computed by the platform after validation, stored with the run, aggregated per method, and compared
    # only under their own comparability claim. The core never interprets them.
    def domain_metrics(self, instance: dict, decisions: list, experiment_config: dict | None) -> dict | None:
        """Domain figures of validated decisions, or None when the instance carries no data for them."""
        return None

    def domain_descriptor(self, instance: dict, experiment_config: dict | None) -> dict | None:
        """What the domain figures depend on (with a ``fingerprint``), for comparability and bundles; None if none."""
        return None

    def aggregate_domain(self, parts: list[dict | None]) -> dict | None:
        """Totals of domain figures over scenarios; None unless every part is complete and compatible."""
        return None

    def domain_metric_definitions(self) -> list[dict]:
        """``[{"id", "label", "unit", "better"}]`` of the aggregated domain figures (for tables and charts)."""
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


def overrides(problem: Problem, name: str) -> bool:
    """Whether a problem implements an optional :class:`Problem` hook itself."""
    return getattr(type(problem), name, None) is not getattr(Problem, name)
