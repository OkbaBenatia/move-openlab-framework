# Adapter guide

MOVE OpenLab is extended through adapters. None of them requires a change to the framework, and each has a fixed
contract that the platform checks. This page says which adapter to write for which need and gives a complete,
minimal problem package. The reference of each contract is in [EXTENDING.md](EXTENDING.md); a method worked through
with every command is in [ADD_YOUR_METHOD.md](ADD_YOUR_METHOD.md).

## Which adapter?

| You want to add | Adapter | How it is plugged in | Runs where | Guide |
|---|---|---|---|---|
| A new optimization problem (instances, constraints, objective, validator) | **Problem** — subclass `move_openlab.problem.Problem` | an installed Python package, entry-point group `move_openlab.problems` | the server process (trusted, like the framework) | this page |
| A reference method shipped with a problem (an exact solver, a heuristic) | **Built-in method** — returned by `Problem.builtin_methods()` | part of the problem package | a separate worker process per run | [SOLVER_INTEGRATION.md](SOLVER_INTEGRATION.md) |
| Your own method on an existing problem | **Method plug-in** — a file `plugin.py` with `METADATA` and `solve` | the approved plug-in directory, registered per workspace | the verified sandbox | [ADD_YOUR_METHOD.md](ADD_YOUR_METHOD.md) |
| A learned or hybrid method (a model that scores or removes candidates) | a method of kind `learned` or `hybrid`, plus the optional problem hooks for candidates and ML evaluation | part of a problem package | a separate worker process per run | [ML_INTEGRATION.md](ML_INTEGRATION.md) |
| A trip data source (a file format or a service) | **Dataset provider** — subclass `move_openlab.datasets.DatasetProvider` | an installed package, entry-point group `move_openlab.dataset_providers` | the server process | [DATASETS.md](DATASETS.md#writing-a-dataset-provider) |
| An extra figure per scenario and method | **Custom metric** — a file `metric.py` with `METADATA` and `compute` | the approved plug-in directory, registered per workspace | the verified sandbox | [METRICS.md](METRICS.md#custom-metrics) |

The adapters and where they connect are drawn in [DIAGRAMS.md](DIAGRAMS.md#2-adapters).

Two rules hold for every adapter:

1. **The experiment owns the definitions.** Scenario, objective, validator, metrics and comparison rules belong to
   the problem and the experiment. A method proposes decisions and can redefine none of them.
2. **Nothing a method reports about itself is trusted.** Feasibility and every metric are recomputed by the problem's
   validator from the instance and the returned decisions.

A problem package and a dataset provider are code the installation chooses to install: they run in the server
process. Method plug-ins and custom metrics are third-party code: they run only in the sandbox
([SECURITY_MODEL.md](SECURITY_MODEL.md)).

## A minimal problem package

The example assigns tasks to workers — one task per worker — maximising the tasks served, then minimising the total
cost. It was run through the framework as written here: scenarios generated, the method executed in a worker,
validated, the experiment locked, exported and compared.

```
my-problem/
├── pyproject.toml
└── task_assignment/
    ├── __init__.py
    └── problem.py
```

`pyproject.toml`:

```toml
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "task-assignment"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = ["move-openlab"]

[project.entry-points."move_openlab.problems"]
example-task-assignment = "task_assignment.problem:problem"

[tool.hatch.build.targets.wheel]
packages = ["task_assignment"]
```

The entry point names a `Problem` instance, or a zero-argument callable that returns one.

`task_assignment/problem.py`:

```python
import random

from move_openlab.hashing import with_hash
from move_openlab.problem import MetricDefinition, ObjectiveLevel, Problem

PROBLEM_ID = "example-task-assignment"
OBJECTIVE = "lex-max-served-then-min-cost/1.0.0"
CONSTRAINTS = "one-task-per-worker+task-once/1.0.0"
SCHEMA = "example-task-assignment-instance/1"


def build(seed: int, workers: int = 4, tasks: int = 5) -> dict:
    rng = random.Random(f"example-task-assignment/{workers}/{tasks}/{seed}")
    pairs = [dict(worker=f"W{w}", task=f"T{t}", cost=rng.randint(1, 20))
             for w in range(1, workers + 1) for t in range(1, tasks + 1) if rng.random() < 0.6]
    return with_hash(dict(schema=SCHEMA, problem_id=PROBLEM_ID, problem_spec_version="1.0.0",
                          instance_id=f"task-{workers}x{tasks}-s{seed}", name=f"{workers} workers, {tasks} tasks, seed {seed}",
                          workers=[f"W{w}" for w in range(1, workers + 1)], tasks=[f"T{t}" for t in range(1, tasks + 1)],
                          pairs=pairs, served_denominator=tasks))


def solve_greedy(instance, config):
    used_w, used_t, chosen = set(), set(), []
    for p in sorted(instance["pairs"], key=lambda p: (p["cost"], p["worker"], p["task"])):
        if p["worker"] not in used_w and p["task"] not in used_t:
            used_w.add(p["worker"]); used_t.add(p["task"]); chosen.append([p["worker"], p["task"]])
    return dict(decisions=chosen, status="HEURISTIC")


GREEDY = dict(method_id="greedy-min-cost", name="Greedy (cheapest pair first)", version="1.0.0", kind="heuristic",
              problem_id=PROBLEM_ID, objective_spec_id=OBJECTIVE, deterministic=True, author="Example",
              description="Scan the pairs by (cost, worker, task) and assign when both are free.", default_config={})


class TaskAssignment(Problem):
    # ---- specification (class attributes)
    problem_id = PROBLEM_ID
    problem_spec_version = "1.0.0"
    objective_spec_id = OBJECTIVE
    constraint_spec_id = CONSTRAINTS
    instance_schema = SCHEMA
    validator_version = "1.0.0"
    title = "Task assignment (example)"
    description = "Assign tasks to workers, one task per worker: maximise served tasks, then minimise total cost."
    synthetic = True
    objective = (ObjectiveLevel("served", "max"), ObjectiveLevel("cost", "min"))
    metrics = (MetricDefinition("served", "Served tasks", "task", "number of tasks with a validated assignment", "higher"),
               MetricDefinition("cost", "Total cost", "cost-unit", "sum of the costs of the validated assignments", "lower"))
    decision_description = "[worker_id, task_id] for every assignment"
    participants = "tasks"

    # ---- scenarios (abstract)
    def scenario_parameters(self) -> dict:
        return dict(fields=[dict(id="seeds", label="Seeds", type="int-list", min=1, max=1000)], defaults=dict(seeds=[1, 2, 3]))

    def generate_scenarios(self, params: dict) -> tuple[list[dict], dict]:
        seeds = params.get("seeds", [1, 2, 3])
        if not isinstance(seeds, list) or not seeds or any(not isinstance(s, int) or not 1 <= s <= 1000 for s in seeds):
            raise ValueError("seeds must be a non-empty list of integers in [1, 1000]")
        return [build(s) for s in seeds], dict(params=dict(seeds=seeds),
                                               generator=dict(name="example-task-generator", version="1.0.0"))

    def selftest_instance(self) -> dict:
        return build(0)                                      # seed 0 is reserved: never part of a scenario set

    # ---- integrity and validation (abstract)
    def check_instance_content(self, instance: dict) -> list[str]:
        if instance.get("schema") != SCHEMA:
            return [f"unknown schema {instance.get('schema')!r}"]
        w, t = set(instance["workers"]), set(instance["tasks"])
        return [f"pair {p} refers to an unknown worker or task" for p in instance["pairs"]
                if p["worker"] not in w or p["task"] not in t]

    def check_decisions(self, decisions) -> list[str]:
        ok = isinstance(decisions, list) and all(isinstance(d, (list, tuple)) and len(d) == 2
                                                 and all(isinstance(x, str) for x in d) for d in decisions)
        return [] if ok else ["each decision must be [worker_id, task_id] (strings)"]

    def validate(self, instance: dict, decisions: list) -> dict:
        cost = {(p["worker"], p["task"]): p["cost"] for p in instance["pairs"]}
        pairs = [tuple(d) for d in decisions]
        errs = [f"pair {w}->{t} is not allowed" for w, t in pairs if (w, t) not in cost]
        if len({w for w, _ in pairs}) != len(pairs):
            errs.append("a worker is assigned more than one task")
        if len({t for _, t in pairs}) != len(pairs):
            errs.append("a task is assigned more than once")
        return dict(feasible=not errs, errors=errs, validator_version=self.validator_version,
                    metrics=dict(served=len({t for _, t in pairs}), cost=sum(cost.get(p, 0) for p in set(pairs))))

    def canonical_decisions(self, decisions: list) -> list:
        return sorted(list(d) for d in decisions)

    # ---- methods (abstract)
    def builtin_methods(self):
        return [(GREEDY, solve_greedy)]

    # ---- semantic comparability (abstract)
    def problem_components(self, instance: dict, objective_spec_id: str) -> dict:
        return dict(region=dict(workers=sorted(instance["workers"]), tasks=sorted(instance["tasks"]),
                                pairs=sorted([p["worker"], p["task"]] for p in instance["pairs"]), constraints=CONSTRAINTS),
                    coefficients=sorted([p["worker"], p["task"], p["cost"]] for p in instance["pairs"]),
                    objective=self.objective_definitions()[objective_spec_id])

    def explain_problem_differences(self, a: dict, b: dict) -> dict:
        dims = []
        for key in ("workers", "tasks"):
            if set(a[key]) != set(b[key]):
                dims.append(dict(dimension=key, detail=f"{len(a[key])} vs {len(b[key])} {key}"))
        ca, cb = ({(p["worker"], p["task"]): p["cost"] for p in x["pairs"]} for x in (a, b))
        if set(ca) != set(cb):
            dims.append(dict(dimension="allowed pairs", detail=f"{len(set(ca) ^ set(cb))} pair(s) differ"))
        elif ca != cb:
            dims.append(dict(dimension="costs", detail="pair costs differ"))
        return dict(dimensions=dims, nonbinding=[])


problem = TaskAssignment()
```

Install it in the environment that runs MOVE OpenLab and restart the server:

```bash
.venv/bin/pip install -e ./my-problem
```

The problem then appears in `GET /api/problems`, in *Library › Experiments* where a new experiment is created, and
under *Administration › Extensions* with the distribution that provides it. A package that fails to load is listed there with its error and never
stops the others. It must be **installed**: methods run in a worker started with `python -I`, which ignores
`PYTHONPATH` and the current directory, so a module that is only importable from a checkout is reported as
*not installed here*.

### The abstract methods

These nine methods of `Problem` are abstract; a subclass that misses one cannot be instantiated.

| Method | Returns |
|---|---|
| `scenario_parameters()` | `{"fields": [...], "defaults": {...}}` describing the scenario-set parameters for the interface |
| `generate_scenarios(params)` | `(instances, scenario-set metadata)`, deterministic; raises `ValueError` on invalid parameters |
| `selftest_instance()` | a reserved instance, never part of a scenario set, on which a method is self-tested at registration |
| `check_instance_content(instance)` | a list of structural errors (identifiers, types, references); empty when the instance is sound |
| `check_decisions(decisions)` | a list of schema errors of a method's `decisions`, before any recomputation |
| `validate(instance, decisions)` | `{"feasible", "errors", "metrics", "validator_version"}`, recomputed from the instance and the decisions only |
| `builtin_methods()` | `[(method metadata, solve function)]` shipped with the problem |
| `problem_components(instance, objective_spec_id)` | `{"region", "coefficients", "objective"}`: the data that define the optimization problem, without bookkeeping |
| `explain_problem_differences(a, b)` | `{"dimensions": [{dimension, detail}], "nonbinding": [{dimension, detail}]}` for two instances |

Class attributes to set: `problem_id`, `problem_spec_version`, `objective_spec_id`, `constraint_spec_id`,
`instance_schema`, `validator_version`, `title`, `description`, `objective` (the lexicographic levels), `metrics`,
and `decision_description`. Change `problem_spec_version` or `validator_version` whenever the instance schema, the
constraints, the objective or the validator change: records made under another specification are not opened as
experiments of the installed problem.

Conventions the example follows:

- An instance is a JSON object with `instance_id`, `problem_id` and an `instance_hash` computed by
  `move_openlab.hashing.with_hash`; `check_instance` verifies the hash before `check_instance_content` runs.
- Both shipped problems call their first objective metric `served`. The results table, the *served / N* figure
  (`served_denominator` in the instance, read by `scenario_summary`) and the `participants` noun are built around a
  metric with that id.
- Generators use only a seeded `random.Random`, so the same parameters give the same instances on every platform.

### Optional hooks

Everything else in `Problem` has a default and is implemented only when the problem needs it.

| Need | Hooks | Described in |
|---|---|---|
| A map, route playback, a noun for participants | `capabilities`, `playback`, `participants` | [MAPS.md](MAPS.md), [EXTENDING.md](EXTENDING.md#what-the-workspace-shows-presentation-capabilities) |
| Details of a participant or vehicle when its marker is clicked; why scenarios cannot be edited | `participant_properties(instance)`, `authoring_note` | [MAPS.md](MAPS.md#inspecting-a-participant-or-a-vehicle) |
| Solver settings a researcher may choose | `config_schema` in the method metadata | [SOLVER_INTEGRATION.md](SOLVER_INTEGRATION.md#settings-a-researcher-may-choose) |
| Controlled variants of an experiment | `variants()` | [REPRODUCIBILITY.md](REPRODUCIBILITY.md) |
| Candidate scoring and threshold studies | `supports_candidates`, `candidates`, `decision_candidate`, `restrict`, `scorers` | [ML_INTEGRATION.md](ML_INTEGRATION.md) |
| A before / after view of a candidate reduction, and its preview | `candidate_view(instance, run)`, `candidate_preview(instance, method, config)` | [ML_INTEGRATION.md](ML_INTEGRATION.md#candidate-view-and-preview) |
| Classification figures of a learned method | `ml_evaluations(method_id, config)` | [ML_INTEGRATION.md](ML_INTEGRATION.md#ml-evaluation) |
| Metric groups and reading notes | `MetricDefinition.category`, `MetricDefinition.note` | [METRICS.md](METRICS.md) |
| Figures a method records with each run | `run_fact_definitions()`, `run_facts(run, instance)` | [METRICS.md](METRICS.md#run-facts) |
| Figures derived from validated decisions, outside the objective (for example emissions) | `domain_metrics`, `domain_descriptor`, `aggregate_domain`, `domain_metric_definitions` | [METRICS.md](METRICS.md#domain-metrics) |
| Display-only figures from validated totals | `descriptive_metrics(instances, totals)` | [EXTENDING.md](EXTENDING.md#a-problem-package) |
| Another display name for a method, given its settings | `method_display_name(method_id, config)` | [EXTENDING.md](EXTENDING.md#what-the-workspace-shows-presentation-capabilities) |
| Methods kept only so that earlier records stay readable | `archived_methods()` | [SOLVER_INTEGRATION.md](SOLVER_INTEGRATION.md#archived-methods) |
| Notes shown with a scenario | `scenario_notes(instance)` | [EXTENDING.md](EXTENDING.md#what-the-workspace-shows-presentation-capabilities) |
| Visibility limited to granted accounts | `restricted = True` | [PRIVATE_EXTENSIONS.md](PRIVATE_EXTENSIONS.md) |

The hooks under *presentation* are for display only: validation, ranking, comparability verdicts and frozen records
never depend on them.

## Reference implementations in the repository

| Adapter | Where |
|---|---|
| Problem without geography | `src/move_openlab/benchmarks/synthetic_assignment/` |
| Problem on road networks, with emissions as domain metrics | `src/move_openlab/benchmarks/ride_matching/` |
| Method plug-ins | `plugins/nearest_pickup/`, `plugins/my_greedy_matching/`, `plugins/regret_greedy/` |
| Method template | `src/move_openlab/templates/method/`, created by `move-openlab method new` |
| Custom metric | `plugins/co2_avoided_per_served_rider/metric.py` |
| Dataset providers | `src/move_openlab/datasets/csv_source.py`, `geojson_source.py` |

Tests that exercise the optional contracts: `tests/test_problem_capabilities.py`,
`tests/test_solver_settings.py`, `tests/test_restricted_problems.py`, `tests/test_studies.py`,
`tests/test_result_import.py`.
