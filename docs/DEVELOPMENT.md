# Development guide

## Requirements

- Python ≥ 3.11 and Node.js 20.19+ or 22.12+ (the interface build refuses older versions).
- Linux with bubblewrap (`bwrap`) and unprivileged user namespaces, for sandboxed plugins and their tests.
- Network access only for the optional OpenStreetMap, place-search and open-data features.

## One command

```bash
./start-local.sh
```

Starts the complete application (API and built interface, one process) at http://127.0.0.1:8765, on the loopback
interface only. It creates `.venv` and installs the package when they are missing or `pyproject.toml` changed, runs
`npm ci` and rebuilds the interface only when its sources are newer than `frontend/dist`, uses the data directory
`.openlab-data/dev` as it is (override with `MOVE_OPENLAB_DATA_DIR`), enables plug-ins in the verified sandbox
(`MOVE_OPENLAB_PLUGIN_MODE=sandbox`, the approved directory `plugins/`) and, when the account store is empty, creates
an administrator `admin` with a temporary password stored in `<data dir>/dev-credentials.json` (mode 0600, never
printed). It refuses to start when the port is taken by another program, reports the address when MOVE OpenLab
already runs there, holds a lock so that two terminals cannot start two servers on one data directory, and refuses
`MOVE_OPENLAB_ENV=production`. Ctrl+C stops the server cleanly; jobs still running are recorded as interrupted.
`MOVE_OPENLAB_PORT` selects another port; `--check` prepares and checks without starting.

## Browser acceptance run

`scripts/e2e/acceptance.mjs` drives a real headless Chromium (Chrome DevTools Protocol, no npm dependency) through the
whole workflow — accounts, first use, Help and the tour, Library *Use*, wizard, execution and cancellation, Export and
staged Import, reproduction, comparison (with the collapsible evidence summary), sample bundle, expanded map, hidden
records, appearance, phone width, supervision and isolation. It creates accounts and experiments, so run it against a
server on a **copy** of a data directory:

```bash
cp -a .openlab-data/dev /tmp/openlab-e2e && MOVE_OPENLAB_DATA_DIR=/tmp/openlab-e2e MOVE_OPENLAB_PORT=8791 ./start-local.sh
```

```bash
node scripts/e2e/acceptance.mjs --base http://127.0.0.1:8791 --creds /tmp/openlab-e2e/dev-credentials.json --out /tmp/openlab-e2e-out
```

It writes numbered screenshots and `acceptance-report.json` into `--out`; exit status 0 only if every check passed and
no page error occurred. `--only fallback` checks the map without a basemap (start that server with
`MOVE_OPENLAB_TILE_URL=none`).

### Final acceptance run (33 required scenarios)

`scripts/e2e/final_acceptance.mjs` signs in as the test administrator and a second researcher and runs the required
scenarios end to end — first use, Workspace restore, manual and random participants, Randomize locations, Save & Run,
vehicle and CO₂ changes, single-ZIP export and its integrity, staged import, reproduction, comparisons of exactly two
and three experiments with a changed reference, verdicts, chart tooltips and types, CO₂ charts, chart export, the
*My Greedy Matching* plugin, custom metric, hidden records, markers, Import menu, locked results, isolation, layouts,
permissions. Same usage as above (`--base`, `--creds`, `--out`); it writes `final-acceptance.json` (action, expected,
actual, PASS/FAIL, evidence per scenario) and the screenshots.

### Browser journeys (CI, synthetic data only)

`scripts/e2e/ci_journeys.mjs` runs the main journeys on a fresh, deterministic data directory: sign-in, first-use
demonstration, Generate (seeded synthetic demand on a generated road grid) and Save & Run, compare exactly two
experiments, export one ZIP, workspace isolation, import into a second researcher's workspace, independent
reproduction, add and validate a method (sandboxed plug-in), phone layout. CI runs it on every push and pull request
(`.github/workflows/browser.yml`); the same commands run locally:

```bash
export MOVE_OPENLAB_DATA_DIR=/tmp/openlab-ci MOVE_OPENLAB_PORT=8791 MOVE_OPENLAB_TILE_URL=none
.venv/bin/python scripts/e2e/seed_ci.py
```

```bash
./start-local.sh
```

```bash
node scripts/e2e/ci_journeys.mjs --base http://127.0.0.1:8791 --creds /tmp/openlab-ci/dev-credentials.json --out /tmp/openlab-ci-out
```

`seed_ci.py` creates two researcher accounts with random passwords (in the data directory's 0600 credentials file,
never printed) and a *Synthetic grid* area whose road network is generated, not downloaded. The report
(`ci-journeys.json`) and screenshots are the only CI artefacts — never the data directory.

### Workflow acceptance (live demonstration scenarios)

`scripts/e2e/workflow_acceptance.mjs` (same usage as the final acceptance run, on a data copy) runs the team
demonstration's Scenarios A–C and the workflow checks (compact charts at 100 % / 160 % zoom and on a phone, Compare
methods, exactly two experiments, Run with this method, Save & Run transition, collapsible metadata, participants added
from the Workspace, Randomize with a typed seed, marker types, short titles, the public benchmark); it writes
`workflow-acceptance.json` and the screenshots. Manual version: `docs/MANUAL_ACCEPTANCE.md`.

### Result views (CI, synthetic data only)

`scripts/e2e/final_corrections.mjs` runs on the same seeded data directory (`seed_ci.py` also creates one ordinary
administrator): an administrator and a researcher get the same results and CO₂ summary for the same public
demonstration; *Choose metrics* controls the Workspace columns, both comparison tables and the charts (select all,
deselect all, reset, kept for the account or for the tab); every chart type draws; charts are selected and exported
together, and the script opens the ZIP and verifies each PNG (size, drawn rows), SVG, CSV and the manifest; the two
kinds of comparison; the public synthetic benchmark; French and English. Same usage as `ci_journeys.mjs`; it writes
`final-corrections.json` and screenshots.

## Installation (manual)

```bash
python -m venv .venv && .venv/bin/pip install -e ".[dev]"
```

```bash
cd frontend && npm ci && npm run build && cd ..
```

## Local accounts

Accounts are local; there is no self-registration. Create the first administrator on the host:

```bash
.venv/bin/move-openlab users add alice --display-name "Alice" --role admin
```

The command prints a temporary password once; it must be changed at the first sign-in. Administrators then create
further accounts under *Administration*. Recovery on the host:

```bash
.venv/bin/move-openlab users reset-password alice
```

## Running

Single-origin server (API + built interface) on http://127.0.0.1:8765:

```bash
.venv/bin/move-openlab serve
```

For interface work, run the Vite development server as well (http://localhost:5180, proxied to the API):

```bash
npm --prefix frontend run dev
```

Configuration is read from environment variables; every variable is listed in [INSTALL.md](INSTALL.md#4-configuration)
(source: `src/move_openlab/settings.py`). The most useful in development:

| Variable | Purpose |
|---|---|
| `MOVE_OPENLAB_DATA_DIR` | data directory (accounts, workspaces, networks, datasets, jobs); keep it outside Git |
| `MOVE_OPENLAB_PLUGIN_DIR`, `MOVE_OPENLAB_PLUGIN_MODE` | approved plugin directory and `disabled` / `sandbox` / `trusted-process` |
| `MOVE_OPENLAB_TILE_URL`, `MOVE_OPENLAB_TILE_ATTRIBUTION` | map tile service; `none` = maps without a basemap |
| `MOVE_OPENLAB_OVERPASS_URL`, `MOVE_OPENLAB_GEOCODER_URL` | road-network and place-search services (`off` disables search) |
| `MOVE_OPENLAB_EXTERNAL_FETCH` | `researcher` (default) or `admin`: who may start downloads from public services |

In development the session signing key is random at each start, so restarting the server signs everyone out; set
`SESSION_SECRET` (32 characters or more) to keep sessions across restarts.

## Tests

```bash
MOVE_OPENLAB_REQUIRE_SANDBOX=1 .venv/bin/python -m pytest
```

Without `MOVE_OPENLAB_REQUIRE_SANDBOX=1`, sandbox tests are skipped on machines without bubblewrap; CI sets it so a
broken sandbox fails the build. All tests use synthetic data (artificial grids and files); none contacts an external
service.

| Suite | Covers |
|---|---|
| `test_benchmark_core.py` | synthetic benchmark: generator, validator, exact method against brute force and an oracle |
| `test_workflow.py` | campaigns, locking, bundles and tampering, reproduction, worker isolation |
| `test_variants_threshold_semantic.py` | variants, fingerprints, threshold studies, optimality scope |
| `test_api.py`, `test_admin.py` | authentication, sessions, administration, audit, workspace isolation |
| `test_jobs.py` | background jobs, cancellation, restart recovery |
| `test_plugin_security.py` | sandbox isolation and fail-closed behaviour |
| `test_geo.py`, `test_geo_workflow.py` | road networks, routing, scenarios, ride matching, RPC ingestion |
| `test_areas_datasets.py` | areas, profiles, place search, CSV/GeoJSON uploads, limits, isolation |
| `test_public_safety.py` | confidentiality and hygiene gate |
| `test_lab.py`, `test_export_import_dialogs.py`, `test_sample_bundle.py` | Workspace API and saved view, demonstration, bundle format 2, one-ZIP export with the evidence report, manifest schema and tampering, sample bundle, extensions as comparison reference |
| `test_mobility.py`, `test_emissions_examples.py` | vehicles and emissions (worked examples, units, negative avoided CO₂, traceability), wizard composition, Randomize locations, edited-participant provenance |
| `test_custom_metrics.py`, `test_method_tools.py` | custom-metric contract, aggregation, declared inputs only, no package loading, the example metric file; method template, `method check`, the *My Greedy Matching* example |
| `test_metric_security.py` | registered metrics: sandbox isolation (other workspaces, credential store, environment, network), never in the server process, timeout and memory limit, invalid outputs, pinned code, fail closed |
| `test_solver_robustness.py` | a solver time limit is never an optimality claim, a worker that does not answer is killed with diagnostics, solver / method / end-to-end times, HiGHS's cumulative clock |
| `test_bundle_compatibility.py` | newer bundle formats and sections refused clearly, a method missing here, complete exchange between two researchers |
| `test_restricted_problems.py` | restricted problems: invisible without a grant whatever the role, grant, use and revocation, audit of grants and refusals |
| `test_studies.py` | study views: methods of several experiments on the same scenarios, provenance kept, mismatches refused |
| `test_solver_settings.py`, `test_result_import.py`, `test_problem_capabilities.py` | solver settings against their schema and as a new version, hybrid optimality scope, candidate view and preview; results computed elsewhere re-validated and kept apart, run facts and display names; presentation capabilities |
| `test_sample_trips.py`, `test_private_files.py`, `test_private_data_permissions.py` | the sample trip dataset through the normal CSV import; owner-only credential store, audit log and data directory |
| `test_accounts_compat.py`, `test_workflow_fixes.py` | password policy levels, roles and supervision, version label, place-search providers, comparison candidates; short derived titles, Save & Run reusing the preview, the public benchmark and its oracle check, extensions |
| `test_scientific_audit.py` | claim-dependent verdicts, a CO₂ calculation change as a new traceable configuration, CO₂ units and aggregation, scenario-level matching, the three separate statements |

Frontend unit tests (the comparison selection model and the scenario matching of compared experiments; TypeScript
compiled by `tsc`, run by `node --test`, no extra dependency):

```bash
npm --prefix frontend test
```

Other checks run in CI (ruff is pinned in the `dev` extra, as in CI; the frontend lint uses ESLint's and
typescript-eslint's recommended rules plus the Rules of Hooks, `frontend/eslint.config.js`):

```bash
.venv/bin/ruff check src tests scripts plugins
```

```bash
npm --prefix frontend run lint
```

```bash
python scripts/check_public_safety.py
```

```bash
npm --prefix frontend run build
```

`python scripts/smoke_synthetic.py` runs the complete two-installation workflow on the default synthetic scenario
set (about a minute).

`python scripts/benchmark_synthetic_assignment.py --out <dir>` reproduces the public synthetic capacitated-assignment
benchmark from its frozen seeds (30 instances, three methods including the sandboxed example plug-in, five
repetitions, validator and min-cost-flow oracle checks) and writes a JSON record and a Markdown table — its own
measured figures, not those of a scientific study.

`python scripts/solver_stress.py --out <file>` is the controlled repetition and concurrency stress test of the exact
ride-matching method used to investigate an intermittent solver stall: deterministic inputs (the sample bundle's frozen
scenarios, optionally a seeded scenario on a local road network), several concurrency levels, the environment and
versions, and every run's status, solver / method / end-to-end time, worker CPU time and peak memory.

## Conventions

- Strict TypeScript; Python typed public functions; ruff (E, F, W, B).
- Interface text is short and technical; numbers shown are always computed from stored records.
- Every fix comes with a regression test; every feature with tests and documentation.
- Branching, commits and pull requests follow [GITFLOW.md](GITFLOW.md).
