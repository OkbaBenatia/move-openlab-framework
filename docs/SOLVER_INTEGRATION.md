# Integrating a solver or a heuristic

A method is the adapter between an experiment and an algorithm: an exact solver, a heuristic, or a learned
procedure. This page describes the contract every method follows, the settings a researcher may choose, time limits,
the statuses a method may declare and what each of them proves, and how every result is validated independently.
Learned and hybrid methods add the contracts of [ML_INTEGRATION.md](ML_INTEGRATION.md). A worked plug-in:
[ADD_YOUR_METHOD.md](ADD_YOUR_METHOD.md).

## Two ways to provide a method

| | Built-in method | Method plug-in |
|---|---|---|
| Where | in a problem package, returned by `Problem.builtin_methods()` as `(metadata, solve)` | a file `<approved plug-in directory>/<name>/plugin.py` with `METADATA` and `solve` |
| Who decides | whoever installs the package | a researcher registers it for their workspace (administrators only in `trusted-process` mode) |
| Runs in | a separate worker process (`python -I -B -m move_openlab.worker`) | the verified bubblewrap sandbox: no network, no data directory, read-only Python installation |
| Researcher-settable settings | yes, through `config_schema` | no: a plug-in runs with its own `default_config` |
| May use a solver library | any library of the installation (the shipped exact methods use HiGHS through `highspy`) | what is importable from the read-only Python installation; nothing can be downloaded at run time |

Both follow the same contract and are judged by the same validator.

## The contract

```python
METADATA = {
    "method_id": "my-method",                  # 3-64 characters: a lowercase letter, then lowercase letters, digits, '-'
    "name": "My method",
    "version": "1.0.0",                        # MAJOR.MINOR.PATCH; a code change needs a new version
    "kind": "exact",                           # exact | heuristic | learned | hybrid
    "problem_id": "public-ride-matching",
    "objective_spec_id": "lex-max-served-riders-then-min-detour/1.0.0",
    "deterministic": True,
    "author": "Your name",
    "description": "What it does, including tie-breaking rules.",
    "default_config": {},
    "config_schema": {},                       # built-in methods only
}


def solve(instance, config):
    return {"decisions": [...], "status": "OPTIMAL", "declared": {...}, "metadata": {...}, "diagnostics": {...}}
```

`problem_id` and `objective_spec_id` must equal the problem's; a method declared for another problem or objective is
refused as incompatible. Unknown metadata fields are refused.

| Input | What it is |
|---|---|
| `instance` | a deep read-only view of the frozen scenario; it cannot be modified |
| `config` | read-only: the method's `default_config` overlaid with the experiment's settings for this method |

| Output field | Required | Meaning |
|---|---|---|
| `decisions` | yes | a list of decisions in the problem's own format (`Problem.check_decisions`) |
| `status` | yes | one of `OPTIMAL`, `FEASIBLE`, `HEURISTIC`, `TIME_LIMIT`, `INFEASIBLE`, `ERROR` — self-declared |
| `declared` | no | `{metric id: number}` — what the method believes it achieved; compared with the validator's values, never used |
| `metadata` | no | a JSON object; `solver_time_s` is read from it as the solver time |
| `diagnostics` | no | a JSON object, method-specific |

Any other field, a non-serialisable output or an output above 4 MB makes the run rejected. The schema is
[`schemas/method-result.schema.json`](../schemas/method-result.schema.json); the stored run is described by
[`schemas/run-record.schema.json`](../schemas/run-record.schema.json).

A method is a pure function of its two arguments. The worker's environment is minimal (`PATH`, a fixed
`PYTHONHASHSEED`, one OpenMP thread, a UTF-8 locale); nothing else is inherited from the server. Anything a method
prints goes to the worker's standard error, which is kept only as a diagnostic tail when a run fails.

## Settings a researcher may choose

A built-in method declares the settings an experiment may change in `config_schema`, next to `default_config`. The
exact ride-matching method declares:

```python
"default_config": {"time_limit_s": 60.0, "threads": 1, "random_seed": 0, "mip_rel_gap": 0.0, "mip_abs_gap": 0.0},
"config_schema": {
    "time_limit_s": {"type": "number", "label": "Time limit", "unit": "s", "min": 1, "max": 3600},
    "mip_rel_gap": {"type": "number", "label": "Relative MIP gap", "min": 0, "max": 1},
    "mip_abs_gap": {"type": "number", "label": "Absolute MIP gap", "min": 0},
    "threads": {"type": "integer", "label": "Threads", "min": 1, "max": 64},
    "random_seed": {"type": "integer", "label": "Random seed", "min": 0, "max": 2147483647},
}
```

| Rule | Detail |
|---|---|
| Schema | at most 32 settings; a key is lowercase letters, digits and `_`; each setting needs a `type` (`number`, `integer`, `boolean`, `string`) and a `label`; optional `unit`, `min`, `max`, `enum`, `nullable`, `help` |
| Defaults | the declared defaults must satisfy their own schema, or the method is refused |
| Check | settings are validated before anything is stored: unknown keys, wrong types, values out of range and values outside `enum` are refused; `null` is accepted only for a `nullable` setting and keeps the solver's own default |
| Record | settings are experiment configuration (`config.method_configs`), part of its checksum and fingerprint; every run stores its `effective_config` |
| Changing them | on a locked experiment, new settings create a **new version** (`POST /api/campaigns/{id}/settings`): it runs the selected methods on the parent's frozen scenarios and lists what changed in `config_differences_from_parent`; the original is never modified |

`GET /api/problems/{problem_id}/methods` returns the settings of every built-in method that declares a schema.
Tests: `tests/test_solver_settings.py`.

## Time: three limits, three clocks

| Limit | Set by | Effect |
|---|---|---|
| The method's own limit, for example `time_limit_s` | the method's settings | handed to the solver by the method; when the solver stops on it the method must declare `TIME_LIMIT` |
| Run timeout `timeout_s` | the experiment (1 to 3600 s, default 120 s) | an outer wall-clock bound enforced by the platform: a worker that has not answered is killed and its run rejected with diagnostics (process states and CPU time at the deadline, a Python traceback taken one second before it, the tail of the solver log) |
| Time budget `time_budget_s` | the experiment (default: the problem's `default_time_budget_s`) | a declared part of the configuration, not a kill switch: two experiments with different budgets are comparable *with conditions* |

The worker also gets a CPU-time limit slightly above the run timeout and an address-space limit
(`MOVE_OPENLAB_WORKER_MEMORY_MB`).

Three times are stored with every run, always `solver ≤ method ≤ total`:

| Time | Measured by | Covers |
|---|---|---|
| `solver_time_s` | the method (`metadata.solver_time_s`); equals the method time when the method reports none | the solver's own clock |
| `method_time_s` | the worker | the `solve()` call, model building included |
| `total_time_s` | the platform | the whole isolated execution: process start, input, solve, reply. Validation is excluded |

A solver whose clock is cumulative over several stages must report its final reading once. Comparisons use the
median over repetitions.

## Statuses and what "optimal" proves

The status is a declaration by the method. What a result **proves** is derived by the platform from the status, the
kind of the method, the instance and the validator's verdict:

| Validator | Declared status | Method kind | Instance | Scope shown |
|---|---|---|---|---|
| accepted | `OPTIMAL` | `exact` | unpruned | *proven optimal (full problem)* |
| accepted | `OPTIMAL` | `exact` | pruned by a scorer (threshold study) | *optimal for the reduced instance only* |
| accepted | `OPTIMAL` | `hybrid` | any | *optimal for the reduced instance only* — the solver proved optimality of the model the method reduced itself |
| accepted | `TIME_LIMIT` | any | any | *not proven (time limit)* |
| accepted | `OPTIMAL` (other kinds) or `FEASIBLE` | any | any | *feasible, optimality not proven* |
| accepted | anything else | any | any | *heuristic (no optimality claim)* |
| rejected | any | any | any | *invalid (rejected by the validator)* |

Consequences:

- A solver proves optimality only for the model it was given. A method that removes candidates before solving never
  produces a full-problem proof, whatever the solver reports.
- A time limit is never an optimality claim, even when the returned decisions are feasible.
- "Equals the reference" in a comparison counts scenarios where a method reached the reference method's objective
  values. It is not a proof: where the reference stopped at its time limit, a better value only means a better
  incumbent was found.
- A heuristic or learned method that declares `OPTIMAL` gains nothing: its result is shown as feasible.

## Independent validation

Every run goes through the same stages, recorded in its trace:

1. **prepare** — the instance hash and structure are verified; for a sandboxed plug-in, the isolation is verified.
2. **execute** — the method runs in its worker and returns its output.
3. **validate** — the output schema is checked (`check_output`), then `Problem.validate(instance, decisions)`
   recomputes feasibility and every metric from the instance and the decisions only. A run is *accepted* when the
   output respects the contract and the validator finds the decisions feasible.
4. **domain** — when the problem defines domain metrics (emissions for ride matching), they are computed by the
   platform from the accepted decisions.

Declared values that differ from the validator's are recorded with the run (`declared_mismatch`); the validator's
values are the ones stored, ranked and compared. A failed execution is kept as a rejected run with its error: runs
are never dropped.

## Archived methods

A problem package may keep earlier built-in methods — pilots, superseded versions — so that the records made with
them stay readable and reproducible. `Problem.archived_methods()` returns their ids;
`GET /api/problems/{problem_id}/methods` marks them `archived`, and the Workspace lists them under *History*
instead of among the methods offered for a new run. Archiving is presentation: the method still exists and its
records are unchanged.

## Results computed elsewhere

When a method cannot run inside the platform — a long computation on another machine, an archived runner — its
results can be imported as **data** and re-validated here: [IMPORT_EXPORT.md](IMPORT_EXPORT.md#3-results-computed-elsewhere).
The method must still be an installed built-in method of the problem, so that the records name something the
installation knows.

## Checklist for a new method

- [ ] `METADATA` complete; `problem_id` and `objective_spec_id` equal the problem's; a semantic version.
- [ ] `solve` reads only `instance` and `config`; deterministic tie-breaking; a fixed solver seed.
- [ ] The solver's time limit comes from a setting, and a stop on it is declared `TIME_LIMIT`.
- [ ] `OPTIMAL` is declared only when the solver proved it for the model it was given.
- [ ] `solver_time_s` in `metadata` when a solver is used; the solver's name and version too.
- [ ] For a plug-in: `move-openlab method check <dir> --bundle <experiment.zip>` passes.
