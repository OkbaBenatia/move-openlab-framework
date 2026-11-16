# Metrics

Every figure shown in a table or a chart comes from one of six sources, each with its own rules. This page lists
them, says how values are aggregated over scenarios, how to choose what is displayed, how the CO₂ figures of the
public ride-matching problem are configured, and what the interface shows when a metric has no value.

One rule runs through all of it: **a metric without data is never shown as zero.** It reads *Not configured*,
*Not available* or a dash, with the reason.

## Where a figure comes from

| Source | Defined by | Computed by | Trusted because |
|---|---|---|---|
| Problem metrics | `Problem.metrics` (`MetricDefinition`) | the problem's validator, from the instance and the returned decisions | independent of the method |
| Derived figures | the interface | from validated metrics and recorded times: service rate, objective difference against the reference, runtime, solver time, speed-up | arithmetic on stored values, with the basis stated |
| Domain metrics | `Problem.domain_metrics` and its companions | the platform, from validated decisions (CO₂ for ride matching) | never from a method's report |
| Run facts | `Problem.run_fact_definitions`, `run_facts` | read from what a run recorded | display only: never used for validation, ranking or comparability |
| ML evaluation | `Problem.ml_evaluations`, or evaluation evidence a researcher imports for a method of an experiment | provided by the problem from labelled predictions; for imported evidence, computed by the platform from the records (labels and the method's scores or predictions) | shown with population, decision, model, feature pipeline and the SHA-256 of the source; never derived from an optimization result; otherwise absent ([ML_INTEGRATION.md](ML_INTEGRATION.md#ml-evaluation)) |
| Custom metrics | a built-in metric, or a registered `metric.py` | from declared, validated inputs only; registered ones in the sandbox | inputs filtered, outputs validated |

## Metric groups and *Choose metrics*

**Choose metrics** opens one dialog with a checkbox per metric. There is one selection per problem, and every result
view uses it: the **Workspace** results table, **Compare → Methods**, **Compare → Experiments**, the **charts**, and the
tables exported from them. The button is in each of those views; a choice made in one applies in all.

| Group | Contains |
|---|---|
| Validation | validated runs (accepted by the independent validator / executed), repetitions identical |
| Optimization | the problem's objective metrics, service rate, objective difference against the reference, other problem metrics, run facts of this group |
| ML evaluation | accuracy, precision, recall, F1, PR-AUC, ROC-AUC — listed only when the experiment has a learned or hybrid method — and run facts of this group |
| Performance | runtime, solver time, speed-up against the reference, run facts of this group |
| Mobility and CO₂ | problem metrics of category `mobility`, vehicles used, vehicle distance, CO₂e emissions, CO₂e avoided, CO₂e reduction, CO₂e per served passenger |
| Custom metrics | the built-in and registered custom metrics of the problem |

In the dialog: tick individual metrics; **Select all**, **Deselect all** (*Apply* then waits for at least one metric),
**all** / **none** per group, **Reset to defaults**, **Apply**. With **Keep this choice for my account** (ticked by
default) the choice is saved per problem (preference `metrics`, `PUT /api/lab/preferences` with
`{"metrics": {"<problem id>": ["<metric id>", ...]}}`; an empty list clears it) and applies again at the next sign-in;
unticked, it applies until the browser tab is closed. Hovering a metric shows its definition and how it is aggregated.
A metric the problem cannot provide stays in the list with the reason under its name — it is never shown as zero.

Without a saved choice, the Workspace panel starts with a compact set (the objective metrics, the difference against
the reference and the runtime) and the comparison pages with the full default set. The table shows the scope it is
computed over — the selected scenario or all scenarios — and each heading says how the value is aggregated.

What does not depend on the choice: *Status* and *Source* in Compare → Methods, the validation, reproducibility and
comparability evidence in Compare → Experiments, and the exported experiment bundle — a bundle always carries every
recorded result.

A problem places its own metrics and facts in a group:

```python
MetricDefinition("vehicle_km", "Vehicle distance", "km", "distance driven by the vehicles used", "lower",
                 category="mobility", note="Distances on the road network of the scenario.")
```

`category` is `"optimization"` (the default), `"mobility"`, `"performance"` or `"ml"`; `note` says how to read the
metric — a boundary, a caveat — and is shown with its definition. Both are presentation only: they are not part of
the evaluation contract or of any fingerprint, and a definition without them serialises exactly as before.

## Basis: how a value is aggregated

A value is shown for **one scenario** or for **all scenarios**. The basis — how the all-scenarios value is obtained
— is stated for every metric (hover the metric); it is not itself a metric.

| Metric | One scenario | All scenarios |
|---|---|---|
| Served, objective metrics, other problem metrics | value of the scenario (repetition 1) | sum over the scenarios |
| Service rate | served ÷ the scenario's denominator | ratio of sums |
| Objective difference against the reference | on the last objective level, where the earlier levels are equal | mean over the scenarios where it is defined |
| Runtime | median of the repetitions | median of the scenario medians |
| Solver time | not shown per scenario | median over scenarios |
| Speed-up against the reference | ratio for the scenario | ratio of sums when a time fact is flagged `speedup`, else ratio of the medians |
| Vehicles used, vehicle distance, CO₂e, CO₂e avoided | value of the scenario | sum |
| CO₂e reduction (%), CO₂e per served passenger | value of the scenario | ratio of sums |
| Run fact | value of the scenario | its declared aggregate: sum, median over scenarios, ratio of sums, or none |
| ML figures | not shown per scenario | the evaluation population, as provided or as imported, at the recorded decision (an explored threshold never reaches a table) |
| Custom metric | value of the scenario | its declared aggregate: `sum`, `mean`, `median`, `ratio-of-sums` |

An objective metric whose unit is seconds is displayed in minutes.

**Reference.** Differences are *other − reference*. The reference is the comparison baseline you choose (column A),
not necessarily a proven optimum. The *objective difference against the reference* is therefore not a proven
optimality gap: where the reference stopped at its time limit, a negative difference only means a better incumbent
was found. A solver's own gap between its incumbent and its bound is a different quantity; a problem may show it as
a run fact, per scenario.

**Totals side by side.** Totals over all scenarios are put next to each other only for results that cover the same
scenario set; scenarios are matched by their frozen instance, never by position.

## Run facts

A problem may show figures a method recorded with each run — candidates removed, the solver's own status or gap,
time spent before solving.

```python
def run_fact_definitions(self) -> list[dict]:
    return [
        {"id": "removed", "label": "Candidates removed", "unit": "", "kind": "number", "aggregate": "sum", "group": "reduction"},
        {"id": "removed_pct", "label": "Reduction", "unit": "%", "kind": "number", "aggregate": "ratio",
         "of": ["removed", "candidates"], "group": "reduction", "category": "ml", "help": "Removed ÷ candidates."},
        {"id": "solve_s", "label": "Solve time", "unit": "s", "kind": "number", "aggregate": "sum", "group": "time",
         "category": "performance", "speedup": True},
        {"id": "solver_status", "label": "Solver status", "unit": "", "kind": "text", "aggregate": "none", "group": "solver"},
    ]

def run_facts(self, run: dict, instance: dict) -> dict:
    d = run.get("diagnostics") or {}
    return {k: d[k] for k in ("removed", "candidates", "solve_s", "solver_status") if k in d}
```

| Key | Meaning |
|---|---|
| `id`, `label`, `unit` | identifier, display name, unit |
| `kind` | `"number"` or `"text"` |
| `aggregate` | `"sum"`, `"median"`, `"ratio"` (ratio of the sums of `of: [numerator id, denominator id]`, in %) or `"none"` (shown per scenario only) |
| `group` | a grouping label |
| `category` | optional: the group in *Choose metrics* — `"optimization"` (default), `"performance"`, `"ml"`, `"mobility"` |
| `default` | optional: shown without being chosen (default: aggregated numbers) |
| `help` | optional: a definition shown on hover |
| `speedup` | optional, `true` on one time fact: *reference ÷ this* is offered as a speed-up, a ratio of sums |

Facts come from the recorded run only. A fact that is missing in one scenario is not aggregated over the scenarios,
and a fact with `aggregate: "none"` asks for one scenario to be chosen.

## Domain metrics

Figures a problem's domain derives from validated decisions, outside the objective. The platform computes them after
validation, stores them with the run (`run["domain"]`), aggregates them per method, and compares them under their
own comparability claim. The core never interprets them.

| Hook | Role |
|---|---|
| `domain_metrics(instance, decisions, experiment_config)` | the figures; `{"complete": False, "missing": [...]}` when data is missing; `None` when the instance carries no data for them |
| `domain_descriptor(instance, experiment_config)` | what the figures depend on, with a `fingerprint`; compared and carried by bundles |
| `aggregate_domain(parts)` | totals over scenarios; `None` unless every part is complete and compatible |
| `domain_metric_definitions()` | `[{"id", "label", "unit", "better"}]` for tables and charts |

## CO₂ of the public ride-matching problem

The ride-matching problem implements the domain hooks with `move_openlab.mobility.emissions`.

**Inputs.** Each driver's vehicle profile is frozen in the scenario: powertrain (`ICE`, `HEV`, `PHEV`, `BEV`,
`custom`), passenger capacity and five possible parameters, each a record with value, unit, CO₂ or CO₂e basis,
source, source version, applicability, notes and timestamp.

| Parameter | Unit |
|---|---|
| Fuel consumption | L/100 km |
| Electricity consumption | kWh/100 km |
| Fuel emission factor | g/L |
| Electricity emission factor | g/kWh |
| Direct CO₂ intensity | g/km |

**Scope** — what is counted:

| Scope | Counts |
|---|---|
| `tailpipe` | fuel combustion while driving; a battery-electric vehicle counts zero at the tailpipe (not a life-cycle statement) |
| `operational-energy` (default) | fuel combustion plus the generation of the electricity consumed |
| `direct-intensity` | a direct intensity per kilometre entered by the researcher |

**Baseline** — what the solution is compared with; avoided CO₂ = baseline − solution:

| Baseline | Definition |
|---|---|
| `everyone-drives-alone` (default) | every driver drives their own trip directly, and every rider drives their own trip in the scenario's default vehicle |
| `drivers-only` | every driver drives their own trip directly; riders are counted neither in the baseline nor in the solution |

**Formulas** (distance in km):

```
fuel         CO2 = km × fuel consumption (L/100 km) / 100 × fuel emission factor (g/L)
electricity  CO2 = km × electricity consumption (kWh/100 km) / 100 × electricity emission factor (g/kWh)
direct       CO2 = km × direct intensity (g/km)
```

**Outputs** (grams in the records, kilograms in the interface): CO₂ of the solution, baseline CO₂, avoided CO₂
(absolute and %), CO₂ per vehicle, per served request and per passenger-km, vehicle distance, vehicles used.

**Configuration.** Scope and baseline are chosen in the Generate wizard (*Methods & Experiment*) and are experiment
configuration (`config.emissions`): part of the fingerprints, carried by the bundle. Another scope or baseline on the
same frozen scenarios is a new experiment; edited vehicles or parameters are a new scenario version. Locked results
are never rewritten. Vehicle profiles are read and saved through `GET` / `PUT /api/lab/vehicles`; the shipped presets
and their sources are listed in [DATASETS.md](DATASETS.md#vehicle-profiles-and-emission-presets).

**Comparability.** Emission figures have their own verdict, separate from results and runtimes: another scope,
baseline, unit or CO₂ / CO₂e basis makes them *not comparable*; other parameter values or vehicle assignments make
them *comparable with conditions* ([REPRODUCIBILITY.md](REPRODUCIBILITY.md#semantic-comparability)).

## Custom metrics

An extra figure computed for every scenario and aggregated per method, from validated inputs only.

- **Built-in**: `detour-per-served-rider` ships with the framework (`move_openlab.custom_metrics`).
- **Registered**: a file `<approved plug-in directory>/<name>/metric.py` with a literal `METADATA` and a
  `compute(ctx)` function, registered per workspace (`POST /api/lab/metrics/register`) with its SHA-256 pinned, and
  evaluated only in the verified sandbox. The shipped example is `plugins/co2_avoided_per_served_rider/metric.py`.

A metric receives only the inputs it declares in `requires` — validated metric ids, `domain.<key>`,
`instance.<key>` — and returns a finite number, a `(numerator, denominator)` pair for `ratio-of-sums`, or `None` for
no value. The full contract, a complete example and the registration call are in
[EXTENDING.md](EXTENDING.md#a-custom-metric); the isolation is described in
[SECURITY_MODEL.md](SECURITY_MODEL.md#custom-metrics). `GET /api/lab/metrics?problem_id=…` lists the metrics of your
workspace and why a registered one cannot be computed here.

## Charts: types, selection and export

Charts are drawn from recorded, validated results, for the chosen metrics. Five types: **Bar** (one value per method
over all scenarios), **Grouped bar** and **Line** (one value per scenario), **Box plot** (distribution over scenarios,
or over every recorded run for the runtime) and **Scatter** (a metric against the runtime). A type the recorded data
cannot support is disabled and says why (a box plot needs five values per series, a grouped bar two scenarios). A
metric the problem cannot provide gets a card that says *Not configured* or *Not available* with the reason — never an
empty plot. CO₂ charts appear only where the CO₂ figures are complete and comparable.

Each chart exports its **CSV** (the numbers behind it), **PNG** and **SVG**. The images are the chart as drawn, with
its title, what it is computed over, its legend and a provenance line. To export several at once: tick the box before
each title — or **Select all charts** — then **Export selected (ZIP)**; **Clear selection** unticks them. The archive
holds `charts/<name>.png`, `.svg` and `.csv` per chart, a `README.txt`, and `manifest.json`
(`move-openlab/chart-export@1`): for every chart its title, metric and metric id, unit, chart type, scenario scope,
method labels and files; and for the comparison the experiments, methods, validator version, accepted runs and CO₂
calculation. Nothing is sent to a server: the files are made in the browser from what is on screen.

## When a metric has no value

| What is shown | When | Example of the reason given |
|---|---|---|
| *Not configured* | the problem or the scenarios do not carry the data the metric needs | the scenarios carry no vehicle energy profiles for the CO₂ calculation; the problem records no vehicle distances |
| *Not available* | the metric exists but its inputs are not provided, or it is mathematically undefined on them | an ML figure without labelled predictions; an ML figure asked for one scenario; recall when the imported labels contain no positive, precision when nothing is predicted positive, ROC-AUC with one class or without scores ([definitions](ML_INTEGRATION.md#what-is-computed)) |
| *Not applicable* | the metric has no meaning for this method | an ML figure for an exact or heuristic method, which makes no predictions |
| *Not computed* reason, shown as a dash | the data is incomplete | a vehicle parameter has no value, and none is assumed |
| a dash | nothing was recorded for this cell | a fact a run did not record |
| no value, listed with the reason | a registered custom metric cannot run here | plug-ins off, sandbox unavailable, file changed since registration |

Incomplete CO₂ figures are not reported at all: a partial sum is never shown as a total. A custom metric that
returns something invalid, fails or times out gives no value and is reported in `custom_issues`.
