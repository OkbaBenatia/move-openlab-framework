# Development guide

## Requirements

- Python ≥ 3.11 and Node.js ≥ 20.
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

Configuration is read from environment variables; the full list is in `src/move_openlab/settings.py`. The most
useful in development:

| Variable | Purpose |
|---|---|
| `MOVE_OPENLAB_DATA_DIR` | data directory (accounts, workspaces, networks, datasets, jobs); keep it outside Git |
| `MOVE_OPENLAB_PLUGIN_DIR`, `MOVE_OPENLAB_PLUGIN_MODE` | approved plugin directory and `disabled` / `sandbox` / `trusted-process` |
| `MOVE_OPENLAB_TILE_URL`, `MOVE_OPENLAB_TILE_ATTRIBUTION` | map tile service; `none` = maps without a basemap |
| `MOVE_OPENLAB_OVERPASS_URL`, `MOVE_OPENLAB_GEOCODER_URL` | road-network and place-search services (`off` disables search) |
| `MOVE_OPENLAB_EXTERNAL_FETCH` | `researcher` (default) or `admin`: who may start downloads from public services |

Restarting the server signs everyone out (sessions are held in memory).

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
| `test_custom_metrics.py`, `test_method_tools.py` | custom-metric contract, aggregation and loading; method template, `method check`, the *My Greedy Matching* example |

Frontend unit tests (the comparison selection model; TypeScript compiled by `tsc`, run by `node --test`, no extra
dependency):

```bash
npm --prefix frontend test
```

Other checks run in CI:

```bash
ruff check src tests scripts plugins
```

```bash
python scripts/check_public_safety.py
```

```bash
npm --prefix frontend run build
```

`python scripts/smoke_synthetic.py` runs the complete two-installation workflow on the default synthetic scenario
set (about a minute).

## Conventions

- Strict TypeScript; Python typed public functions; ruff (E, F, W, B).
- Interface text is short and technical; numbers shown are always computed from stored records.
- Every fix comes with a regression test; every feature with tests and documentation.
- Branching, commits and pull requests follow [GITFLOW.md](GITFLOW.md).
