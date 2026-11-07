# Extending MOVE OpenLab

## A method plugin

A plugin is one file, `<approved plugin dir>/<name>/plugin.py`, with a literal `METADATA` dictionary and a `solve`
function. See `plugins/regret_greedy/plugin.py` for a complete example.

```python
METADATA = {
    "method_id": "my-method",                 # 3-64 chars: lowercase letters, digits, '-'
    "name": "My method",
    "version": "1.0.0",                        # semantic version; any code change needs a new version
    "kind": "heuristic",                       # exact | heuristic | learned | hybrid
    "problem_id": "synthetic-capacitated-bipartite-assignment",
    "objective_spec_id": "lex-max-served-then-min-cost/1.0.0",
    "deterministic": True,
    "author": "Your name",
    "description": "What it does, including tie-breaking rules.",
    "default_config": {},
}


def solve(instance, config):
    # instance and config are read-only views
    return {"decisions": [...], "status": "HEURISTIC", "declared": {"served": 0, "cost": 0}}
```

Plugins are off by default. The operator enables them with an approved directory and a mode
(`MOVE_OPENLAB_PLUGIN_DIR=plugins MOVE_OPENLAB_PLUGIN_MODE=sandbox`); see the [security model](SECURITY_MODEL.md).
Registration (web interface: *Methods & extensions*) reads `METADATA` without executing the file, checks the
problem, objective and version, records the file's SHA-256, then runs a self-test on a reserved instance inside the
sandbox. The independent validator must accept the self-test output. In the sandbox a plugin has no network access
and no file access beyond the Python installation: it receives everything it needs through `instance` and `config`.

## A problem package

1. Subclass `move_openlab.problem.Problem` and implement the abstract methods: scenario parameters and generation,
   a reserved self-test instance, structural instance checks, the decision schema, the independent validator, the
   built-in methods, the fingerprint components and the explanation of differences. Optionally provide variants,
   candidates, `restrict` and scorers to enable controlled variants and threshold studies.
2. Expose an instance (or a zero-argument factory) and register it in your package's `pyproject.toml`:

```toml
[project.entry-points."move_openlab.problems"]
my-problem = "my_package.problem:problem"
```

3. Install the package in the same environment as MOVE OpenLab. It appears in the web interface and the API.

The synthetic assignment benchmark (`src/move_openlab/benchmarks/synthetic_assignment`) is the reference
implementation; the ride-matching benchmark shows the same interface on road networks.

## A scenario source

The bundled sources are the OpenStreetMap road-network layer (`move_openlab.geo.osm`) and the RPC open-data
connector (`move_openlab.integrations.rpc`), used by the *Scenarios & maps* section. Separately installed sources
implement `move_openlab.integrations.ScenarioSource` and register with the `move_openlab.scenario_sources`
entry-point group; `GET /api/integrations` lists them. Their provenance must name the data release, its checksum, its
licence and every processing step. Sources should document how records become agents; the RPC generator resamples published
origin–destination pairs with replacement and re-draws departure times, and drops identifiers.

## A geographic problem

`move_openlab.benchmarks.ride_matching` is the reference for problems on road networks: the instance stores the
travel times computed from the network at build time (so validation and re-execution need no network), and the
scenario field type `scenario-library` lets the campaign form pick scenarios from the researcher's library.
