# Extending MOVE OpenLab

Four extension points, none of which requires changing the core: method adapters (plugins), custom metrics,
problem packages and dataset providers. This page is the reference of their contracts. Which adapter to write for
which need, with a complete minimal problem package: [ADAPTERS.md](ADAPTERS.md). A complete worked example of a
method, with every command and its output: [ADD_YOUR_METHOD.md](ADD_YOUR_METHOD.md). Topic guides:
[SOLVER_INTEGRATION.md](SOLVER_INTEGRATION.md) (statuses, time limits, what "optimal" proves),
[ML_INTEGRATION.md](ML_INTEGRATION.md) (learned methods), [METRICS.md](METRICS.md) (metric groups, facts, CO₂),
[IMPORT_EXPORT.md](IMPORT_EXPORT.md) and [MAPS.md](MAPS.md).

## A method plugin (adapter)

### Add your own method in five steps

Researcher B received an experiment bundle (`experiment.zip`) and wants to test a new method on it. To try this
without a colleague, use the shipped sample bundle (`move-openlab-sample-montbeliard.zip`, see
[examples/README.md](../examples/README.md)).

```bash
move-openlab method new nearest_pickup --problem public-ride-matching --dir plugins
```

1. **Create** — the command writes `plugins/nearest_pickup/plugin.py` (metadata and a `solve` that returns no
   decision — valid, serves nobody), `test_plugin.py` (metadata compatibility and a validated run on the
   problem's self-test instance) and `README.md` (where to implement `solve`, how to test, check and upload).
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
   Experiments → Methods & extensions*), once the operator has placed it in the approved plugin directory — or upload
   it yourself as a ZIP (*+ Add method → Create from template → Upload the completed plug-in*, sandbox mode only).
5. **Run and compare** — in the workspace, open the imported experiment, tick the method and press **Run**: an
   extension campaign runs it on the same instances; **Compare** shows it beside the original methods.

`plugins/nearest_pickup/plugin.py` is a complete example for the ride-matching benchmark and
`plugins/regret_greedy/plugin.py` one for the synthetic benchmark.

### Three routes in *+ Add method*

| Route | What it is | Who places the code |
|---|---|---|
| **Built-in methods** | methods shipped with the problem package | nobody: always there |
| **Register my method** | one catalogue per problem: *Ready-made examples* (shipped with the framework, listed in `plugins/catalog.json` (or marked `"catalog": "example"` in `METADATA`) — presentation only, not part of the contract), *Provided on this installation* (other plug-ins of the approved folder) and *Uploaded by you*; each with its state — *Available, not registered*, *Registered (code pinned …)*, *Not compatible* (with the reason) or *Registered version differs from the file* (a changed file never replaces a registration) | the operator (approved folder) or the researcher (upload) |
| **Create from template** | a form → the template ZIP → you implement `solve` → upload → checks → Register → Run → Compare | the researcher |

The platform does not write the algorithm or train a model. As generated, `solve` returns no decision: it is valid,
serves nobody and passes the self-test — it is a starting point, not a method.

### GUI ⇄ CLI equivalence

| Step | Web interface | Command line (same code) |
|---|---|---|
| Template | *Create from template → Generate the template (.zip)* (`POST /api/problems/{id}/methods/template`) | `move-openlab method new <name> --problem <id> [--author …] [--display-name …] [--kind heuristic\|exact\|learned\|hybrid] [--description …]` |
| Implement | edit `<name>/plugin.py` (`solve(instance, config)`) | same |
| Local test | — | `python -m pytest <name>/test_plugin.py` |
| Metadata check | *Details → Check compatibility* (`POST …/methods/check`; static, nothing executed) | `move-openlab method check <name>` (step *metadata*) |
| Self-test | after an upload, *Self-test in the sandbox* (`…/methods/check` with `selftest`) and **Register** | `move-openlab method check <name>` (step *self-test*) |
| Make it available | *Upload the completed plug-in (.zip)* (`POST …/methods/upload`) | the operator copies `<name>/` into `MOVE_OPENLAB_PLUGIN_DIR` |
| Register | **Register** (`POST …/methods/register`, `origin` `approved` or `uploaded`) | — (the CLI check registers in a throw-away installation) |
| Run, validate, compare | **Run with this method**, then **Compare** | `move-openlab method check <name> --bundle <experiment bundle>.zip` |

Both routes render the one template in `src/move_openlab/templates/method/` (`plugin.py`, `test_plugin.py`,
`README.md`) through `method_tools.new_method`.

### Upload rules

A ZIP of one directory `<name>/` holding `plugin.py` and, optionally, small text files only (`test_plugin.py`,
`README.md`, `README.txt`, `README`, `LICENSE*`, `NOTICE`, `AUTHORS`, `CHANGELOG.md`); at most 2 MB, 16 entries,
3 MB uncompressed, `plugin.py` at most 1 MB; no absolute paths, `..`, backslashes, symbolic links, special files,
sub-directories (remove `__pycache__`: `zip -r <name>.zip <name> -x '*__pycache__*'`) or nested archives. Sandbox
mode only. The plug-in is stored in your workspace only; change `version` in `METADATA` for every new code — the
same method id and version with other code is refused. Details: [SECURITY_MODEL.md](SECURITY_MODEL.md#uploaded-plug-ins).

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
method on an unpruned instance. A `hybrid` method (a learned reduction of the candidates followed by an exact solver)
proves at most optimality of the model it reduced: its `OPTIMAL` is shown as *optimal on the reduced model*, never as
a full-problem proof. A ride-matching instance exposes the vehicle of each driver (`driver["vehicle"]`)
and road distances (`direct_m`, pair `to_pickup_m`, `ride_m`, `to_dest_m`) read-only, so a method may *use* them
(e.g. prefer low-emission matches) without changing how emissions are accounted.

### Solver settings a researcher may choose

A built-in method may declare `config_schema` next to `default_config`, e.g. for a MILP solver:

```python
"default_config": {"time_limit_s": 60.0},
"config_schema": {
    "time_limit_s": {"type": "number", "label": "Time limit", "unit": "s", "min": 1, "max": 3600},
    "mip_gap": {"type": "number", "label": "Relative MIP gap", "min": 0, "max": 1, "nullable": True},
    "threads": {"type": "integer", "label": "Threads", "min": 1, "max": 64, "nullable": True},
}
```

Types are `number`, `integer`, `boolean` and `string`; `min`, `max`, `enum`, `nullable` (null keeps the solver's own
default), `unit` and `help` are optional. Settings are chosen per experiment (`method_configs` when creating it, the
method's settings in the Workspace) and checked against the schema before anything is stored: unknown keys, wrong
types and out-of-range values are refused. They are part of the experiment configuration (hence of its checksum and
fingerprint), and every run records its `effective_config`. Changing the settings of a locked experiment creates a new
version (`POST /api/campaigns/{id}/settings`): on the parent's frozen scenarios, it runs only the selected methods — by
default exactly those whose settings changed, never every method implicitly — optionally on a subset of the scenarios
(`methods`, `instance_hashes`). The changed settings and the scope are listed in `config_differences_from_parent`; the
original and its results are never modified. In the Workspace, Run again runs the changed methods on the shown scenario
or on all of them. A method without a schema has no
researcher-settable configuration; plug-ins run with their own defaults.

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

3. Install the package in the same environment as MOVE OpenLab and restart the server. It appears in the web
   interface and the API, and under *Administration › Extensions* with the distribution that provides it.

A package may declare `restricted = True`: the problem is then visible only to the accounts an administrator granted
it to, and behaves for every other account like a problem that is not installed
([PRIVATE_EXTENSIONS.md](PRIVATE_EXTENSIONS.md)). A complete minimal package, with the nine abstract methods:
[ADAPTERS.md](ADAPTERS.md#a-minimal-problem-package).

The synthetic assignment benchmark (`src/move_openlab/benchmarks/synthetic_assignment`) is the reference
implementation; the ride-matching benchmark shows the same interface on road networks.

## A dataset provider

Trip data sources (file formats or services) are dataset providers: see [DATASETS.md](DATASETS.md#writing-a-dataset-provider).
They plug in through the `move_openlab.dataset_providers` entry-point group without any change to the core.

## A geographic problem

`move_openlab.benchmarks.ride_matching` is the reference for problems on road networks: the instance stores the
travel times computed from the network at build time (so validation and re-execution need no network), and the
scenario field type `scenario-library` lets the campaign form pick scenarios from the researcher's library.

### What the Workspace shows: presentation capabilities

The interface never tests a problem id. What it shows for an experiment comes from `Problem.presentation()`
(also returned by `GET /api/problems`), which is derived from these optional declarations:

| Declaration | Effect |
|---|---|
| `capabilities = frozenset({"map"})` | instances carry `drivers` / `riders` with `origin` / `destination` coordinates: the Workspace map shows them |
| `capabilities` containing `"playback"`, or overriding `playback(instance, decisions)` | route playback of a selected run (implies `"map"`). Without an override, the built-in mobility planner is used (instances with drivers, riders and a road network). An override returns `{t_min, t_max, vehicles: [{driver, rider, path: [[lat, lon, t]], stops: [{type, t, at, rider?}]}], unserved: [{rider, at}], geometry, attribution}` and raises `ValueError` when this instance has no playback |
| `participants = "riders"` | the plural noun of what the `served` metric counts (default: that metric's unit) |
| the `served` metric's label | the label of served counts in results and comparisons |
| an integer `served_denominator` in an instance | the "*served* / N" denominator for that scenario (default: its number of riders); see `scenario_summary(instance)` |
| overriding `candidate_preview(instance, method, config)` | declares `"candidate-preview"` (implies `"map"`): before solving, a method's settings (e.g. a score threshold and a protection rule declared in its `config_schema`) can be previewed on the map — the candidates it would retain and remove on the shown scenario, with counts per scenario and per vehicle, the policy and the provenance of the scores. The settings are validated against the method's schema first; nothing is solved or stored (`POST /api/geo/candidates/preview`). Raises `ValueError` when the method removes no candidates or the data for this instance are not available |
| overriding `candidate_view(instance, run)` | declares `"candidates"` (implies `"map"`): for a run whose method removed candidates (e.g. arcs) before an exact solve, the Workspace map switches between **Routes**, **Before** (every candidate), **After** (retained, removed, kept by a structural rule) and **Solution** (candidates used by the solution), with counts and the reduction. Returns `{stops, vehicles, edges: [{edge_id, i, j}], removed, protected, selected: [[vehicle_id, edge_id]], counts, policy, checks, sources, geometry}` built from recorded data only; raises `ValueError` when the data behind a run is not available (served by `GET /api/geo/candidates/{campaign}/{run}`) |
| overriding `method_display_name(method_id, config)` | the name a method is shown under in this problem's results and comparisons, given the experiment's settings for it (e.g. which policy a threshold selects). The recorded name stays in the record and is returned next to it (`recorded_name`); a name the problem supplies is shown whole. Return `None` to keep the recorded name |
| overriding `run_fact_definitions()` and `run_facts(run, instance)` | facts a method records with each run (e.g. candidates removed, the solver's own status or gap, the time spent before solving) shown in the result details, *Compare methods* and the A/B comparison. Each definition is `{id, label, unit, kind: "number" \| "text", aggregate: "sum" \| "median" \| "ratio" \| "none", of?: [numerator, denominator], group}`; over several scenarios a `ratio` is the ratio of sums (in %), `none` is never aggregated, and a fact missing in any scenario is not aggregated. Optional keys for the interface: `category` (`"optimization"` (default), `"performance"`, `"ml"`, `"mobility"`: the group in *Choose metrics*), `default` (shown without being chosen), `help` (a definition), `speedup` (`true` on one time fact: *reference ÷ this* is offered as a speed-up). Facts come from the recorded run only ([METRICS.md](METRICS.md#run-facts)) |
| overriding `scenario_notes(instance)` | short notes shown with that scenario in results and comparisons (e.g. a documented limitation) |
| overriding `participant_properties(instance)` | what the card of a clicked marker shows about a participant or vehicle beyond the generic fields (identifier, time window, vehicle profile): `{participant id: [[label, value], ...]}`, from the frozen instance (served by `GET /api/geo/instances/{hash}/participants`) |
| `authoring_note = "…"` | why scenarios of this problem cannot be edited or generated in the interface; shown where editing is offered for other problems |
| overriding `archived_methods()` | ids of built-in methods kept only so that earlier records stay readable and reproducible (pilots, superseded versions): listed under *History*, not among the methods offered for a new run |
| overriding `ml_evaluations(method_id, config)` | classification evaluations of a learned method from real predictions and real labels on a named population (confusion matrix, metrics, decision, source); `[]` when none exists — the interface then gives the reason and shows no figure (served by `GET /api/lab/experiments/{id}/evaluation`; [ML_INTEGRATION.md](ML_INTEGRATION.md#ml-evaluation)) |
| `MetricDefinition(..., category=…, note=…)` | the group of a problem metric in *Choose metrics* (`"optimization"` (default), `"mobility"`, `"performance"`, `"ml"`) and how to read it (a boundary, a caveat); presentation only, never part of the evaluation contract or of a fingerprint |

Playback and these labels are for display only: validation, metrics, comparability verdicts and frozen records do
not depend on them.

### Results computed elsewhere

Results that a method produced outside the platform (for example an archived research runner) can be brought in as
**data** through `POST /api/campaigns/import-results` (`Workspace.import_results`). The body names the problem, the
stored scenarios, the installed built-in methods (with their settings, checked against their schemas), a `source`
(where the results come from) and one record per scenario and method: `decisions`, `status_declared`, `declared`
values, times, method metadata and diagnostics, and a `record_sha256` over the record's content. Nothing is executed
and nothing is solved. Before anything is stored, every digest is checked and every decision set is re-validated by
the problem's validator; declared values are compared, never trusted. A record that fails is kept as a rejected run.
A record is accepted when the validator finds its decisions feasible, no declared value differs and its declared status
is `OPTIMAL`, `FEASIBLE` or `TIME_LIMIT`. The result is a new experiment, locked at once, whose runs carry
`origin = "imported-external"`; its results are labelled "imported results (computed elsewhere, re-validated here, not
executed here)". Existing
experiments are never changed. Such an experiment exports like any other, and its runs are re-validated again when
the bundle is imported elsewhere.
The request body and every rule: [IMPORT_EXPORT.md](IMPORT_EXPORT.md#3-results-computed-elsewhere).
