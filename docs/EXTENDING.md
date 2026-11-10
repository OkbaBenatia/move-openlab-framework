# Extending MOVE OpenLab

Four extension points, none of which requires changing the core: method adapters (plugins), custom metrics,
problem packages and dataset providers. A complete worked example of a method, with every command and its output:
[ADD_YOUR_METHOD.md](ADD_YOUR_METHOD.md).

## A method plugin (adapter)

### Add your own method in five steps

Researcher B received an experiment bundle (`experiment.zip`) and wants to test a new method on it. To try this
without a colleague, use the shipped sample bundle (`move-openlab-sample-montbeliard.zip`, see
[examples/README.md](../examples/README.md)).

```bash
move-openlab method new nearest_pickup --problem public-ride-matching --dir plugins
```

1. **Create** — the command writes `plugins/nearest_pickup/plugin.py` (metadata and a `solve` that returns no
   decision — valid, serves nobody) and `test_plugin.py` (metadata compatibility and a validated run on the
   problem's self-test instance).
2. **Implement** `solve(instance, config)`; run the local test with `python -m pytest plugins/nearest_pickup`.
3. **Check** it the way the platform runs it:

   ```bash
   move-openlab method check plugins/nearest_pickup --bundle experiment.zip
   ```

   In a throw-away installation the check reads the metadata without executing the file, registers the method (a
   self-test inside the verified sandbox), imports and verifies the bundle, extends the imported experiment with the
   method, runs it on every instance and prints the validator's verdict per instance and a comparison with the
   experiment's methods. Each step stops with an actionable message (`[FAILED] metadata: version 'v1' is not a
   semantic version MAJOR.MINOR.PATCH`, `[FAILED] self-test: contract self-test failed: …`, invalid decisions with
   the validator's errors). Add `--json` for a machine-readable report.
4. **Register** it in the web interface (*+ Add method → Register my method* next to the Method list, or *Library →
   Experiments → Methods & extensions*), once the operator has placed it in the approved plugin directory.
5. **Run and compare** — in the workspace, open the imported experiment, tick the method and press **Run**: an
   extension campaign runs it on the same instances; **Compare** shows it beside the original methods.

`plugins/nearest_pickup/plugin.py` is a complete example for the ride-matching benchmark and
`plugins/regret_greedy/plugin.py` one for the synthetic benchmark.

### Contract

```python
METADATA = {
    "method_id": "my-method",                 # 3-64 chars: lowercase letters, digits, '-'
    "name": "My method",
    "version": "1.0.0",                        # semantic version; any code change needs a new version
    "kind": "heuristic",                       # exact | heuristic | learned | hybrid
    "problem_id": "public-ride-matching",
    "objective_spec_id": "lex-max-served-riders-then-min-detour/1.0.0",
    "deterministic": True,
    "author": "Your name",
    "description": "What it does, including tie-breaking rules.",
    "default_config": {},
}


def solve(instance, config):
    # instance and config are read-only views
    return {"decisions": [...], "status": "HEURISTIC", "declared": {"served": 0, "detour_s": 0}}
```

The result is documented by [`schemas/method-result.schema.json`](../schemas/method-result.schema.json): `decisions`
and `status` are required; `declared`, `metadata` and `diagnostics` are optional. The experiment owns the scenario,
objective, validator, metrics, vehicles, emission model, baseline and comparison rules: a method proposes decisions
only and can redefine none of them. The platform validates the decisions independently, derives the domain figures
(for ride matching: CO₂ under the experiment's scope and baseline, from the vehicles frozen in the instance) and
records a run as described by [`schemas/run-record.schema.json`](../schemas/run-record.schema.json) (status,
objective values from the validator, runtime, diagnostics, declared optimality scope, environment, `domain`).
Declared values are compared with the validator's, never trusted; an `OPTIMAL` status is a proof only for an exact
method on an unpruned instance. A ride-matching instance exposes the vehicle of each driver (`driver["vehicle"]`)
and road distances (`direct_m`, pair `to_pickup_m`, `ride_m`, `to_dest_m`) read-only, so a method may *use* them
(e.g. prefer low-emission matches) without changing how emissions are accounted.

Plugins are off by default. The operator enables them with an approved directory and a mode
(`MOVE_OPENLAB_PLUGIN_DIR=plugins MOVE_OPENLAB_PLUGIN_MODE=sandbox`); see the [security model](SECURITY_MODEL.md).
Registration reads `METADATA` without executing the file, checks the problem, objective and version, records the
file's SHA-256, then runs a self-test on a reserved instance inside the sandbox. The independent validator must
accept the self-test output. In the sandbox a plugin has no network access and no file access beyond the Python
installation: it receives everything it needs through `instance` and `config`. Bundles never carry plugin code: a
colleague who wants to re-run your method installs the same plugin (same version and code hash) on their side.

## A custom metric

An extra figure computed for every scenario and aggregated per method — for example *detour per served rider* or
*CO₂ avoided per served rider*. It is computed from figures the platform established: the metrics recomputed by the
problem's validator, the CO₂ figures computed from the validated decisions and counts of the frozen instance. It
receives **only the inputs it declares** in `requires`, never what a method reported about itself, so a method cannot
inflate it.

A custom metric is third-party code, so it follows the rules of method plug-ins
([SECURITY_MODEL.md › Custom metrics](SECURITY_MODEL.md#custom-metrics)): a file
`<approved plugin directory>/<name>/metric.py`, never imported by the server, registered per workspace with its
SHA-256 pinned, and computed only in the verified sandbox, with a timeout and memory limits. Without plug-ins (the
default) or without a working sandbox, registered metrics are listed with the reason and **no value** — there is no
fallback.

```python
# plugins/co2_avoided_per_served_rider/metric.py   (the complete, shipped example)
METADATA = {
    "id": "co2-avoided-per-served-rider", "version": "1.0.0", "name": "CO₂ avoided per served rider", "unit": "kg",
    "direction": "higher", "problems": ["public-ride-matching"],
    "requires": ["served", "domain.avoided_g", "domain.complete"], "aggregate": "ratio-of-sums",
    "description": "CO2 avoided against the experiment's baseline, divided by the riders served (validated figures).",
    "provenance": "MOVE OpenLab example metric plugins/co2_avoided_per_served_rider, public",
}


def compute(ctx):
    if not ctx["domain"]["complete"]:           # incomplete CO2 figures: no value rather than a partial one
        return None
    return (ctx["domain"]["avoided_g"] / 1000.0, ctx["metrics"]["served"])
```

| Field | Meaning |
|---|---|
| `id`, `version` | lowercase identifier; semantic version — change it whenever the formula changes (a changed file is refused until it is registered again under a new version) |
| `name`, `unit`, `direction` | display name, unit, `higher` or `lower` is better |
| `problems` | the problems it is defined for; it is offered nowhere else (no *Accuracy* on ride matching) |
| `requires` | validated metric ids (`served`, `detour_s`), `domain.<key>` (CO₂ figures, e.g. `domain.avoided_g`, `domain.complete`) or `instance.<drivers\|riders\|pairs>`; checked against the problem at registration; a scenario lacking one gets no value |
| `aggregate` | `sum`, `mean`, `median` or `ratio-of-sums` (`compute` then returns `(numerator, denominator)`) |
| `compute(ctx)` | `ctx = {"metrics", "domain", "instance"}` holding the declared inputs only (read-only); returns a finite number, a pair or `None` (no value — never a guess). Anything else, an exception or a timeout gives no value and is reported |
| `description`, `provenance` | what it measures; who maintains it and where its definition is published |

`METADATA` must be a literal (it is read without executing the file). Register the file for your workspace — the
self-test runs it once in the sandbox on a reserved context (every input = 1):

```bash
curl -b cookies -X POST http://127.0.0.1:8765/api/lab/metrics/register \
     -H 'content-type: application/json' -d '{"problem_id": "public-ride-matching", "plugin": "co2_avoided_per_served_rider"}'
```

`GET /api/lab/metrics?problem_id=…` lists the metrics of your workspace (built-in and registered, with their trust
statement and code hash), the metric files that could be registered and why a registered one cannot be computed here.
Values appear per scenario and per method in the experiment results (`per_scenario[…].custom`, `custom`, and
`custom_issues` for invalid outputs, failures and timeouts) and in the comparison charts' metric selector.

The platform ships one **built-in** metric, `detour-per-served-rider` (`move_openlab.custom_metrics`). Built-in metrics
are part of the framework, reviewed with it, and are the only metric code that runs in the server process. Packages
declaring the former entry-point group `move_openlab.metrics` are no longer loaded. Tests:
`tests/test_custom_metrics.py`, `tests/test_metric_security.py`.

## A problem package

Optional domain figures (the mobility package uses them for emissions): implement `domain_metrics(instance,
decisions, experiment_config)` (figures derived from validated decisions, or `{"complete": False, "missing": [...]}`
when data is missing, or `None` when the instance carries none), `domain_descriptor(instance, experiment_config)`
(what the figures depend on, with a `fingerprint`; compared under the *emissions*-style claim and carried by
bundles), `aggregate_domain(parts)` and `domain_metric_definitions()`. The core stores, aggregates, fingerprints and
compares them without interpreting them.

1. Subclass `move_openlab.problem.Problem` and implement the abstract methods: scenario parameters and generation,
   a reserved self-test instance, structural instance checks, the decision schema, the independent validator, the
   built-in methods, the fingerprint components and the explanation of differences. Optionally provide variants,
   candidates, `restrict` and scorers to enable controlled variants and threshold studies, and
   `descriptive_metrics` for display-only figures derived from validated totals (e.g. a service rate).
2. Expose an instance (or a zero-argument factory) and register it in your package's `pyproject.toml`:

```toml
[project.entry-points."move_openlab.problems"]
my-problem = "my_package.problem:problem"
```

3. Install the package in the same environment as MOVE OpenLab. It appears in the web interface and the API.

The synthetic assignment benchmark (`src/move_openlab/benchmarks/synthetic_assignment`) is the reference
implementation; the ride-matching benchmark shows the same interface on road networks.

## A dataset provider

Trip data sources (file formats or services) are dataset providers: see [DATASETS.md](DATASETS.md#writing-a-dataset-provider).
They plug in through the `move_openlab.dataset_providers` entry-point group without any change to the core.

## A geographic problem

`move_openlab.benchmarks.ride_matching` is the reference for problems on road networks: the instance stores the
travel times computed from the network at build time (so validation and re-execution need no network), and the
scenario field type `scenario-library` lets the campaign form pick scenarios from the researcher's library.
