# Changelog

All notable changes are documented here. Versions follow Semantic Versioning; pre-1.0 minor versions may change
interfaces.

## Unreleased

### Fixed
- **Participants editor without a road network**: the palette and *Randomize…* are no longer disabled without a
  reason. When the area has no stored road network the step says so and links to *Area & Data* (where the one-time
  download is offered); when a scenario was built on a road network this installation does not store (for example the
  shipped demonstration on a fresh installation: a new OpenStreetMap download gives a different network), the editor
  says that its participants cannot be edited here.
- **Workflow acceptance on a fresh installation** (`scripts/e2e/workflow_acceptance.mjs`): fixtures prepare the
  demonstration area's road network and a reproduction through the interface's own endpoints (nothing changes where
  they exist); editing the demonstration on an installation without its road network is reported as that limitation.

### Changed — dependencies
- GitHub Actions `actions/checkout`, `actions/setup-python`, `actions/setup-node` v7; `vite` 8.3.8,
  `@vitejs/plugin-react` 6.3.0, `lucide-react` 1.72.0. TypeScript 7 is held: `typescript-eslint` does not support it yet.

## 0.3.0 — 2026-11-16

### Fixed — release
- **First start**: generated passwords always meet the server's password policy (`auth.new_password`), so the first
  administrator created by `start-local.sh` and the CI test accounts are never refused (a random draw without a digit
  or an upper-case letter, about one in fifty, made the first start fail).
- **CI**: the browser workflow sets its data directory in a step (the `runner` context is not available in job `env`).

### Changed — public presentation
- **README** rewritten for the public release: identity header with the official banner, navigation, *Why MOVE
  OpenLab?*, the GUI and the CLI (commands checked against `move-openlab --help`), adapters, the three ways to add a
  method, the demonstration, validation, metrics and ML evaluation, maps, comparison, benchmarks, exchange and
  reproduction, the research software ecosystem (Benchopt, MLflow, Optuna, OR-Tools, from their official
  documentation), installation, sample packages, citation, licences.
- **Screenshots**: a new gallery of 16 screenshots of the public application with OpenStreetMap tiles
  (`docs/assets/screenshots/gallery/`, [docs/GALLERY.md](docs/GALLERY.md)); the older screenshots are replaced.
- **Diagram 8**, GUI and CLI (`docs/diagrams/08-gui-cli.mmd`, [docs/DIAGRAMS.md](docs/DIAGRAMS.md)).
- **Attribution**: *Conceived, designed, developed and implemented by Dr. Okba BEN ATIA* in `NOTICE`, the README,
  `CITATION.cff` and the architecture and presentation guides; `scripts/check_release_ready.py` checks that `NOTICE`
  is complete.

### Added — publication preparation
- **Licence**: Apache License 2.0 for the framework (`LICENSE`, `NOTICE`; `license` in `pyproject.toml` and
  `frontend/package.json`). Data and assets keep their own licences (ODbL 1.0, Licence Ouverte, CC0 1.0, OFL 1.1, the
  project's marks), listed in `NOTICE` and `THIRD_PARTY_NOTICES.md`.
- **CITATION.cff** completed from verified facts (author, affiliation, version, licence); no DOI and no release date
  until they exist; a commented template for the platform paper once accepted.
- **Release assets**: `sample_scenario.zip`, `sample_experiment.zip` and `SHA256SUMS`, built by
  `scripts/pack_examples.py`, intended to be attached to each GitHub release.
- `scripts/check_release_ready.py`: what must be true before a release (licence files, NOTICE without placeholders,
  citation, sample assets and checksums).

### Added — sample packages, ML evidence in bundles
- **Scenario packages** (`move-openlab-scenario/1`): export a library scenario or an experiment's frozen scenario, import
  it with full verification (checksums, problem and validator, instance hash, geometry, composition; the instance is
  rebuilt and must be identical where the road network is installed). `scenario_packages.py`, routes under
  `/api/geo/scenario-packages/` and `/api/geo/…/package`.
- **Import ▾ → Try a sample**: the public *sample scenario* (`sample_scenario.zip`) and *sample experiment*
  (`sample_experiment.zip`, the existing sample bundle). Kept unpacked; `scripts/pack_examples.py` writes both files
  into `examples/`, byte-identical, checksums in `examples/SHA256SUMS`.
- **ML evaluation evidence in experiment bundles** (`ml_evaluations/`, export option `ml_evidence=full|reference|none`):
  documents re-validated and recomputed at import, or references shown as not recomputable.
- Tests: scenario packages, ML evidence in bundles, researcher A → researcher B reproduction through the samples.

### Changed
- *Import ▾ → Try an imported experiment* moved into *Import ▾ → Try a sample*.
- `workflow_acceptance` P1 asks the server which experiments have nothing comparable instead of assuming the test data.

### Added — result views, ML evaluation evidence, participant authoring
- **Public Workspace and restricted-research context.** A granted account now works in two explicit contexts of the
  one application. In the public Workspace it sees what every other account sees; *Private Research* enters the
  restricted context (a bar under the header says so); *Workspace* then asks *"Exit Private Research and return to the
  public Workspace?"* (*Exit to Workspace* / *Cancel*) and, on confirmation, starts the public Workspace again on a
  public experiment. Enforced by the server: requests of the public context carry `X-Move-Context: public`, and
  restricted problems and their records are then left out of every answer (lists, lookups, scenarios, jobs, exports),
  also for a granted account. The header only narrows an answer. An installation without a restricted package is
  unchanged.
- **One metric selection** for the Workspace results, Compare › Methods, Compare › Experiments, the charts and the
  exported tables: *Choose metrics* in each view, groups Validation, Optimization, ML evaluation, Performance, Mobility
  and CO₂, Custom metrics; select all, deselect all, per-group all / none, reset to defaults; kept for the account
  (per problem) or for the browser tab. New validation metrics: validated runs, repetitions identical.
- **Charts**: tick charts, *Select all charts*, *Clear selection*, *Export selected (ZIP)* — a PNG, an SVG and a CSV per
  chart plus `manifest.json` (`move-openlab/chart-export@1`: title, metric, unit, chart type, scenario scope, method
  labels, provenance). Exported images are the chart as drawn, with its title, legend and provenance line. A problem
  without a map gets the same charts in the Workspace. A metric that cannot be charted says why instead of being
  dropped.
- **CO₂ in the Workspace** depends on the experiment and its validated data, never on the role; a problem with a map
  but without the platform's CO₂ calculation shows *Not configured* (no value, nothing assumed) and, where the
  problem reports one, its own mobility figure labelled as such.
- **ML evaluation from imported evidence** (`move-openlab/ml-evaluation-evidence@1`, JSON or CSV with metadata):
  `POST /api/lab/experiments/{id}/evaluation`, `GET …/evaluation?method_id=&threshold=`,
  `GET …/evaluation/evidence/{sha}`, `POST …/evidence/{sha}/withdraw`. Confusion matrix, accuracy, balanced accuracy,
  precision, recall, specificity, F1, PR-AUC and ROC-AUC where defined, a threshold sweep and an exploratory threshold
  that never replaces the recorded decision. Additional classification metrics register through the entry-point
  group `move_openlab.ml_metrics`. Evidence is stored content-addressed and owner-only, never changes the experiment,
  and can travel with the experiment bundle (section `ml_evaluations/`: the documents, re-validated and recomputed at import, or references only, shown as not recomputable). Example plug-in `plugins/example_scored_filter` (kind `learned`) and a synthetic
  fixture in `examples/ml-evaluation/`.
- **Participant authoring** in the scenario editor: a *Randomize* dialog (counts, ratio, vehicle-type shares,
  capacity, area, departure interval, time windows, maximum detour, seed) with seeded, server-validated generation,
  and manual placement by drag and drop or click/tap, with an editable detail panel, repositioning, Undo and Cancel.
- `scripts/e2e/final_corrections.mjs` (result views) and `scripts/e2e/ml_evaluation.mjs`, `scripts/e2e/authoring.mjs`;
  `seed_ci.py` also creates one ordinary administrator.

### Fixed
- The scenario editor opened while an experiment of another problem was shown (a public benchmark run, for instance)
  offered that problem's methods, and *Save & Run* was then refused. The editor now always offers the ride-matching
  methods, and an error raised while it is open is shown above it.

### Changed
- Compare › Experiments reads its rows from the shared metric model: the rows are the chosen metrics, named as
  elsewhere (*CO₂e emissions*, *CO₂e reduction*, *CO₂e per served passenger*).
- The public benchmark's scope statement also says that its data is artificial and that it reproduces no other study.


### Added — restricted problems, study views, comparison and metrics
- **Restricted problems and per-account access.** A problem package may declare `Problem.restricted = True`; it is then
  visible only to the accounts an administrator granted it to (*Administration › Extensions*, `GET /api/admin/extensions`,
  `PUT /api/admin/extensions/{problem_id}/access`; grants in `<data>/problem-grants.json`, owner-only). Enforced on the
  server at the workspace: without a grant the problem answers exactly like a problem that is not installed, whatever
  the role; grants and refusals are in the audit log. One application: an installation without such a package shows
  nothing of the kind. A granted account gets a *Private Research* entry in the header.
- **Study views**: methods of several experiments shown together on the same scenarios without merging their records
  (`GET` / `PUT /api/lab/studies`, `DELETE /api/lab/studies/{study_id}`, `GET /api/lab/experiments/{id}?view=records`
  for the experiment's own records); a study is presentation only and is stored next to the experiments.
- **Workspace**: *Displayed methods* (what is shown) is separate from *Methods to run*; earlier methods a problem keeps
  for its records (`Problem.archived_methods()`) are listed under *History*; scenario navigation by real scenario names
  with previous / next and search.
- **One Compare entry, two tabs**: *Methods* (Results, Charts, Maps — two synchronised maps for two methods — and ML
  evaluation) and *Experiments* (validation, reproducibility and semantic comparability per claim, results, charts,
  maps, replay, diff).
- **Choose metrics**: one dialog with the groups Optimization, ML, Performance, Mobility and emissions and Custom
  metrics; the choice is kept per account and problem (preference `metrics`). `MetricDefinition.category` and `.note`;
  run-fact definitions may carry `category`, `default`, `help` and `speedup`. A metric the problem cannot provide reads
  *Not configured* or *Not available* with the reason, never zero.
- **ML evaluation contract**: `Problem.ml_evaluations(method_id, config)` and
  `GET /api/lab/experiments/{id}/evaluation` — a confusion matrix and classification figures only from labelled
  predictions on a named population; otherwise the explicit reason.
- **Participant and vehicle inspection on the map**: a card with what the frozen scenario records and what the selected
  solution does with it (`Problem.participant_properties`, `Problem.authoring_note`,
  `GET /api/geo/instances/{hash}/participants`).
- **Results computed elsewhere** imported as data and re-validated (`POST /api/campaigns/import-results`); solver
  settings declared by a method (`config_schema`) and changed as a new experiment version; candidate-reduction view and
  preview (`Problem.candidate_view`, `candidate_preview`); `Problem.method_display_name`, `run_fact_definitions` /
  `run_facts`, `scenario_notes`.
- **Interface language**: EN | FR in the header and on the sign-in and change-password pages; English is the default;
  *Make this my default language?* keeps the choice for the account (preference `language`).
- **Library menu**: *Data setup* (areas with their road networks, then mobility data), Scenarios, Experiments,
  Benchmarks, Jobs and traces; *Hidden records* moved to the profile menu.
- **Public example for scenario import**: a synthetic trip dataset, CC0 1.0
  (`examples/scenario-import/montbeliard-synthetic-trips.csv`, built by `scripts/build_sample_trips.py`, served by
  `GET /api/lab/sample/trips`, *Import ▾ → Try the sample trip dataset*), next to the sample experiment bundle. The two
  are not interchangeable: one is mobility data, the other an experiment with results.
- Tests: `test_restricted_problems.py`, `test_studies.py`, `test_solver_settings.py`, `test_result_import.py`,
  `test_problem_capabilities.py`, `test_sample_trips.py`.

### Documentation
- New guides: `docs/INSTALL.md`, `docs/ADAPTERS.md`, `docs/SOLVER_INTEGRATION.md`, `docs/ML_INTEGRATION.md`,
  `docs/METRICS.md`, `docs/IMPORT_EXPORT.md`, `docs/MAPS.md`, `docs/MULTI_USER.md`, `docs/PRIVATE_EXTENSIONS.md`,
  `docs/TROUBLESHOOTING.md`, and `docs/DIAGRAMS.md` with one Mermaid source per diagram under `docs/diagrams/`.
- `THIRD_PARTY_NOTICES.md` (dependencies, fonts, map and data sources with their licences) and `CITATION.cff`.
- `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `docs/SECURITY_MODEL.md` (restricted problems, secrets, confidentiality
  checklist) and `examples/README.md` (both example packages) brought up to date.
- The licence of the project was stated as to be confirmed by the maintainer; no licence was named (superseded by Apache-2.0, see Unreleased).

### Changed — workflow and usability corrections
- **Compact charts**: equal compact cards (fixed plot height, width following the card), *All metrics* grid, 3 / 2 / 1
  per row (wide, medium or 160 % zoom, phone), thinned labels, Enlarge; the axis always reaches the largest value.
- **Compare methods** inside one experiment (`#/methods/<experiment>`), and in the comparison picker; when nothing is
  comparable the picker says so and offers compare methods, run another method, reproduce.
- **Run with this method** after registering (or for a built-in method not yet run): an extension, never a change to the
  locked original. Run is labelled *Run added methods* when it creates an extension; a blocked Run says why.
- **Save & Run** opens the new experiment at once with its job stages; the server reuses the preview's routing (Save &
  Run 2.9 s → 0.05 s measured); double submissions are ignored; an experiment opened while running shows its progress.
- **Workspace**: compact metadata with *Experiment details* (remembered per account); Participants **+ Driver**,
  **+ Rider**, **Randomize** open the wizard's participants step on a new scenario version; Randomize locations with a
  typed seed; placement buttons show coordinates.
- **Markers**: vehicle type by colour and icon, riders as person icons, pick-up / drop-off arrows; legends match.
- **Titles**: derived experiments get short numbered titles (*… — Reproduction 2*); old nested titles are displayed
  short (stored titles unchanged).
- **Benchmarks**: the public synthetic benchmark can be run from Library › Benchmarks, with an independent oracle check
  (`GET /api/lab/benchmark/public`); the scientific study stays *Planned*.
- Tests: `test_workflow_fixes.py`, frontend `chartScale.test.ts`, browser `scripts/e2e/workflow_acceptance.mjs`;
  `docs/MANUAL_ACCEPTANCE.md`.

### Security — release hardening
- **Custom metrics are sandboxed.** A third-party metric is a file `<approved plugin directory>/<name>/metric.py`
  (literal `METADATA` + `compute(ctx)`), never imported by the server: read statically, registered per workspace
  (`POST /api/lab/metrics/register`) with its SHA-256 pinned and a sandboxed self-test, and evaluated only in the
  verified bubblewrap sandbox (no network, no server environment, no data directory, credential store or other
  workspace), with a 20 s timeout and memory/CPU limits. It receives only its declared inputs; every output is
  validated (invalid values, exceptions and timeouts give no value and are reported in `custom_issues`). Without
  plug-ins or a verified sandbox a registered metric has no value — no fallback. Built-in metrics are the documented
  trusted path. **Breaking:** packages declaring the `move_openlab.metrics` entry-point group are no longer loaded; the
  example moved from `examples/custom_metric/` to `plugins/co2_avoided_per_served_rider/metric.py`.
- Workers start with `python -I -B`: no bytecode written into the installation (`-I` ignores `PYTHONDONTWRITEBYTECODE`).

### Fixed — release hardening
- **Comparison values are matched by scenario**: sample *k* of a comparison is the reference's *k*-th scenario, found
  in every other experiment by its frozen instance hash (it was the other experiment's *k*-th scenario, i.e. possibly
  another scenario); totals over all scenarios are shown beside the reference's only for the same scenario set (an
  experiment on a subset showed a misleading delta). The table notes when a side covers other scenarios.
- **Solver time of the exact methods**: HiGHS's run clock is cumulative over the two lexicographic stages, and the
  stage-1 time was counted twice in `solver_time_s`; the final reading is now recorded once. Earlier records keep
  their value (results unaffected).
- `./start-local.sh` works with a Python environment that has no pip (one created by uv): uv, then `ensurepip`.
- Clearer refusals for bundles from a newer version (unknown format or section): what this installation reads and what
  to do; nothing is imported.

### Added — release hardening
- **Run diagnostics**: worker CPU time and peak memory with every run; a run killed at its timeout records the state
  and CPU time of its processes, a Python traceback taken one second before the deadline and the tail of the solver
  log; HiGHS search statistics when a stage does not end optimal.
- `scripts/solver_stress.py`: controlled repetition and concurrency stress test of the exact ride-matching method.
- `scripts/benchmark_synthetic_assignment.py`: reproduces the public synthetic capacitated-assignment benchmark from its
  frozen seeds (validator and oracle checks, JSON and Markdown output, labelled as its own measurements).
- **Browser journeys in CI** (`.github/workflows/browser.yml`, `scripts/e2e/ci_journeys.mjs`, `scripts/e2e/seed_ci.py`):
  sign-in, demonstration, Generate and Save & Run, compare two, export, isolation, import, reproduction, add method,
  phone layout, on a generated road grid and the public demonstration only.
- **Lint**: ESLint (recommended rules, typescript-eslint, Rules of Hooks; `npm --prefix frontend run lint`) and ruff
  pinned in the `dev` extra; CI runs both and the frontend unit tests.
- Tests: `test_metric_security.py`, `test_solver_robustness.py`, `test_bundle_compatibility.py`,
  `test_scientific_audit.py`; frontend `scenarioMatch.test.ts`.
- `docs/TEAM_PRESENTATION_GUIDE.md`: a 15–20 minute live demonstration with exact clicks, expected results, a French
  speaking script, a fallback plan and the claims that may be presented publicly.

### Added — scientific UX corrections and validation
- **Comparison selection is exact**: the open experiment is a visible item that can be unticked; *Compare selected (N)*
  compares exactly the ticked experiments (A = reference, then B, C… in tick order); the reference is named and can be
  changed; table, charts, maps, replay, diff and CSV use the selected set only. Selection model with unit tests
  (`npm --prefix frontend test`).
- **Interactive charts**: bar, grouped bar, line, box and scatter where they apply (otherwise disabled with the reason);
  a metric selector (served riders, objective, runtime, gap, vehicles, vehicle distance, service rate, CO₂, CO₂ avoided,
  custom metrics); tooltips with experiment, method, scenario, value and unit, repetitions and aggregation; CSV, PNG
  and SVG export.
- **CO₂ charts**: baseline vs solution, avoided (kg and %, negative values drawn below zero), per served rider and per
  vehicle, with the calculation, baseline, vehicle parameters and their sources; not drawn side by side when the CO₂
  calculations are incompatible.
- **Traceable CO₂ and vehicle changes** (Results › Advanced): another calculation or baseline runs as a new experiment on
  the same frozen scenarios; edited vehicles or parameters open the wizard on a new scenario version that records the
  frozen scenario it derives from (`from_instance`). Worked emissions examples and unit conversions in tests.
- **Custom metrics**: contract (id, version, name, unit, direction, problems, required validated inputs, aggregation,
  provenance), computed from validated figures only; example `detour-per-served-rider`; `GET /api/lab/metrics`
  (third-party metrics: see *Security — release hardening* above).
- **Workspace restore** per account: experiment, scenario, selected result, methods, scope and map view after
  navigation, reload or a new sign-in (`preferences.workspace`).
- **Randomize locations** in the wizard: a new seed gives new places on the road network inside the area; ids and time
  windows are kept; the seed is recorded in the scenario's provenance and re-checked when saved.
- **Map markers**: drivers as squares lettered by vehicle type (C combustion, H hybrid, P plug-in hybrid, E electric),
  pick-ups filled, drop-offs hollow, unmatched riders grey; tooltips with role, vehicle and served state; points at the
  same place fanned out; replay plans name each driver's vehicle.
- **One-ZIP export**: the evidence report goes inside the bundle (`evidence/report.json`, listed and checksummed, checked
  against the root experiment and fingerprints on import); the report alone is an explicit action. Manifest schema
  check; documentation of what each checksum protects.
- **My Greedy Matching**, a public plugin example (`plugins/my_greedy_matching/`), and the tutorial
  `docs/ADD_YOUR_METHOD.md` with verified commands and outputs; `docs/DEMO_GUIDE.md`.
- Final browser acceptance run of the required scenarios: `scripts/e2e/final_acceptance.mjs`.

### Changed
- *Show hidden* moved into a compact **Filters** control (experiment picker, comparison picker, Library, Experiments),
  with an explanation of hidden records.
- The **Locked** badge explains: *Original results are frozen. Re-run or extend this experiment to create new results.*
  (on hover and keyboard focus).
- Incomplete CO₂ figures name the missing parameter in words and where to enter it.

### Fixed
- An **extension** used as the comparison reference was reported incompatible with every experiment, its own parent
  included ("no scenario maps"): its reference-method runs are now taken from its lineage.
- Scenarios saved from the wizard listed **every participant as edited** (stored coordinates are rounded, generated ones
  were not); the comparison now uses the stored rounding.
- The **Import** menu opened under the map's expand control; it now opens above it, stays inside the viewport on a
  phone and works with the keyboard.
- Typing a number of **repetitions** (delete "3", type "2") gave 12: the field now accepts typing and clamps on leaving.
- The wizard kept a scenario name built from the previous area; the suggested name follows the chosen area until edited.


### Added — polish pass: export and import dialogs, Library Use, expanded map
- **Export dialog**: what the bundle contains before anything is written — manifest and integrity, records and lineage,
  scenario definitions, run results and validator evidence, area / road network / mobility data references, vehicle and
  emission parameters (required, shown as such), replay geometry and a separate evidence report (optional, on by
  default). `GET /api/lab/export/{id}`, `GET /api/campaigns/{id}/export?geometry=false`,
  `GET /api/lab/experiments/{id}/evidence` (validation, reproducibility, comparability, fingerprints, results).
- **Import dialog** in stages: choose file → inspect (complete verification on the server, nothing written:
  `POST /api/lab/inspect`) → what will be imported (records new / already here / in conflict, scenarios, area and
  road network, mobility data, methods available here, vehicles and CO₂, replay geometry) → integrity and
  compatibility (importable, reproducible here, comparable) → confirm; *Reproduce it here* when the records are
  already present. A public flow export → import → reproduce → compare works on the demonstration.
- **Comparison**: the evidence summary collapses to a one-line strip (remembered on the browser) and states what is
  identical, comparable (per claim) and not applicable.
- **Expanded map** in the workspace: header and side panels give way, the action bar stays, panels open as overlays,
  *Exit expanded map* or Esc returns.
- **Mobility icons** (rider, combustion, hybrid, plug-in hybrid, electric car) in participant lists, fleet summaries,
  the map legend (now also explaining driver starts) and the wizard review.
- **Help menu**: Quick tour plus short definitions of Area, Mobility data, Scenario, Library and Hidden records; the
  Library menu has a one-line introduction and a tooltip per entry; each Library view explains itself in one line.

### Fixed
- The Quick Tour reopened every time the workspace was shown again after it had been opened once from Help; it now
  opens only on request, *Don't show again* is kept for the account, and the start card no longer offers it then.
- Library *Use*: an area becomes the working area of the account (saved, shown as *In use*, followed by the Workspace
  and Generate); mobility data now has *Use* (opens Generate with that data on its area); scenarios have *Use* (starts
  a new experiment with the scenario in the Workspace). `area_id` preferences are validated (format, existence).
- Hidden records: the page states its purpose, groups records by kind with counts, tells same-titled experiments
  apart, and can drop entries for records no longer in the workspace; the Library's *Show hidden (n)* counts only the
  records of the current view; an empty scenario list says how many are hidden.
- *Add method* opened from the wizard or the sample guide appeared underneath them.
- **Security**: `auth.sqlite3` (and its SQLite side files), `audit.log` and `dev-credentials.json` are owner-only
  (`0600`) from creation whatever the umask, and existing wider files are tightened (`move_openlab.privatefiles`).

### Added — final UX implementation, one-command start, sample bundle
- **`./start-local.sh`**: one command starts the complete application at http://127.0.0.1:8765 (loopback only):
  prepares `.venv` and the interface build when missing or outdated, keeps the local data directory as it is,
  detects an already-running instance and ports taken by other programs, holds a per-data-directory lock, creates a
  first administrator with a temporary password (stored, never printed) on an empty installation, stops cleanly
  with Ctrl+C; `--check` prepares without starting.
- **Header**: Workspace, a compact *Library* menu (areas, road networks, mobility data, scenarios, experiments,
  benchmarks, jobs and traces, hidden records), jobs indicator, help, and a profile menu (My account, My students,
  Administration, Appearance, Change password, Sign out); Administration is no longer a top-level tab.
- **Appearance**: light by default whatever the system setting, dark on request, kept per user
  (`PUT /api/lab/preferences` → `theme`); self-hosted **Inter** (SIL Open Font Licence, `frontend/public/fonts/inter/`).
- **Experiment picker** grouped as Public mobility demonstration, My experiments, Imported, Reproductions,
  Benchmarks, with area, mobility data, scenarios, problem, methods and status (no hashes); `GET /api/lab/experiments`
  returns `group`, `area`, `data`, `sampled`, `methods`, `validation`.
- **First use**: the demonstration's area is added to the workspace once (never recreated after removal), the
  baseline opens with a start card (*Compare with the variant*, *Generate your own*, *Try an imported experiment*,
  *Quick tour*); the Quick Tour no longer opens by itself.
- **Provenance**: mobility data shows its source and that participants are *sampled* from the observed trips (pool
  size, sample k of n, seed); `GET /api/lab/experiments/{id}` → `provenance`.
- **Results**: explicit measurement basis (one sample or all scenarios, repetitions and their agreement, aggregation),
  per-scenario rows (`per_scenario` in comparison rows), gap only when meaningful, runtimes in ms below one second.
- **Evidence** shown separately: independent validation (*n of n runs accepted*), reproducibility (only for a
  reproduction and its original) and semantic comparability (*Why?*); the comparison picker shows all three per
  candidate and does not count hidden experiments.
- **Execution stages**: Queued → Preparing → Running methods → Validating → Results, with a `validate` job event.
- **Comparison workspace**: tabs Results, Charts (CSV, PNG, SVG export), Maps (synchronised), Replay (one clock) and
  Diff (scenario parameters, assignments, served riders, routes, vehicles and CO₂ when comparable, runtimes).
- **Sample bundle** *Montbéliard sample — Baseline* (`src/move_openlab/samples/`, [examples/README.md](examples/README.md)):
  built by `scripts/build_sample_bundle.py` in one installation, checked by `scripts/check_sample_bundle.py` in a
  second one (integrity, reproduction, sandboxed extension, comparison); offered by *Import → Try an imported
  experiment* (`GET /api/lab/sample/bundle`, `POST /api/lab/sample/verify`, `POST /api/lab/sample`) only when that
  recorded check passed.
- **Add method** with three choices (built-in, register my method, create from the template), the evaluation chain
  and the commands under *Developer details*.
- **Generate wizard**: steps renamed *Methods & Experiment* and *Review & Save*; a new area is a draft box (search,
  pick on the map or draw, resize) created only with *Create area and prepare road network*.
- **Administration** redesigned: accounts table with role, supervision, status and last sign-in, *New account*
  drawer with role cards, temporary password shown once (masked, show/copy), reset / deactivate / reactivate with
  confirmation, audit log tab.
- Benchmarks page: the synthetic scientific benchmark is shown as *Planned* until a reproducible, publishable
  version is integrated.
- Browser end-to-end tooling without dependencies (`scripts/e2e/`, Chrome DevTools Protocol over Node's WebSocket).

### Changed
- Sign-in and password pages: logo lockup, light by default with the user's dark choice, Inter, legend of the
  strength indicator; the sign-in card is centred.
- CO₂ calculation label *Fuel and electricity use* (was *Fuel + electricity use*).
- Interface strings gathered in `frontend/src/i18n/en.ts` for a later French version.

### Removed
- The square icon files and `favicon.ico` derived from the logo pack (every square icon in the pack carries a
  cropped fragment of the tagline). A neutral letter-mark `favicon.svg` is used until a clean square icon is
  supplied; it is not presented as the logo.

### Added — UX consolidation, Montbéliard demonstration, comparison picker, accounts
- **Montbéliard** is the default demonstration: *Montbéliard Demo — Baseline* and *— Controlled Variant*, built from
  one frozen RPC release (2026-10, 404 trips inside the 47.42, 6.66 – 47.60, 6.96 box) on the OpenStreetMap network of
  2026-11-09; provenance (release, dataset key, network, raw hashes) in the bundle manifest and in
  `src/move_openlab/demo/README.md`.
- **Comparison picker** (`GET /api/lab/compatible?a=`): *Compare with…* lists every executed experiment of the same
  problem with its relation to A and the verdicts of the semantic engine; directly and conditionally comparable
  candidates first, incompatible ones under *Show incompatible (n)* with their reasons; checkboxes and *Compare
  selected*. The comparison workspace accepts several experiments (`#/compare/A|B1,B2`) and shows their compatible
  metrics in one table.
- **+ Add method** next to the Method list (workspace and wizard): built-in methods, plugin registration from the
  approved directory, template and bundle-check commands with *Copy*.
- **Accounts**: roles Administrator / Researcher / Student; *Can supervise students* for researchers, who manage only
  their own students (`/api/supervision/*`, *Students* section); students' supervisor recorded on the account;
  `move-openlab users add --role student --supervisor <researcher>`; credential store schema 2 with guarded in-place
  migration; administrators read the audit log in the interface.
- **Password workflow**: server-side policy (`password_policy()`, `POST /api/auth/password-policy`) — 12 characters,
  three character classes, nothing from the username or name, *strong* at 16 characters with four classes; *New
  password* with a red / yellow / green strength indicator and *Repeat password* with a match indicator on the
  forced-change page.
- **Place search providers** (`MOVE_OPENLAB_GEOCODER_PROVIDER`): Nominatim stays explicit-search only; Photon offers
  search-as-you-type; the interface enables auto-complete only when the configured provider declares it
  (`GET /api/geo/config` → `geocoding`).
- **Hide / Show hidden** for areas, datasets and scenarios (Data section) in addition to experiments — the same
  per-user preference, nothing deleted.
- Approved **visual identity**: logo in the header, sign-in and password pages, favicon and touch icon, README banner.

### Changed — terminology and context
- *Dataset* → **Mobility data** in the top bar; the experiment panel shows **Experiment**, Area, Road network, Mobility
  data and Scenario on separate lines; *Save & Run* is the main action of a new experiment; *Start point* / *End
  point* in the wizard (academic terms stay in the records); **CO₂ calculation** with *Tailpipe only*, *Fuel +
  electricity use* and *Direct CO₂/km* (the scientific identifiers in the data are unchanged); road-network and
  data jobs show *Queued → Downloading → Building network → Ready* in plain words.
- The interface shows **Development build** instead of a `0.x` number; `/api/info` carries both (`version` for
  display, `release` for the exact number). The first official release will be MOVE OpenLab 1.0.0.
- Comparability verdicts count only the candidate's own rows; an experiment with no scenario in common with the
  reference is *not comparable* instead of vacuously *directly comparable*. A record made by an earlier framework
  version stays comparable when the problem specification and validator are unchanged.

### Added — mobility-first workflow, vehicles and configurable emissions
- Five-step **Generate wizard** over the map (Area & Data → Participants & Vehicles → Constraints → Experiment →
  Review) with *Save Scenario* and *Save & Run*; nothing is stored before the Review step. Participants can be
  generated (synthetic, trip dataset) or placed on the map (Origin, Destination, *Route* draws the road route or
  reports why it cannot). The same wizard replaces the former Editor and Generate forms of the Data section.
- **Vehicle profiles** (`move_openlab.mobility.vehicles`): powertrain (ICE, HEV, PHEV, BEV, custom), passenger
  capacity, energy and every emission parameter as an editable, documented record (value, unit, CO2/CO2e basis,
  source, source version, applicability, notes, timestamp). Versioned platform presets with their sources
  (`mobility/presets/`), per-workspace profiles (create, edit, duplicate), a default vehicle and per-driver
  assignment; vehicles are frozen inside the instances and travel with bundles.
- **Configurable emissions** (`move_openlab.mobility.emissions`): scopes *tailpipe*, *operational energy*,
  *direct intensity*; explicit baselines *everyone drives alone* (default) and *drivers only*; total, baseline,
  avoided (absolute and %), per vehicle, per served request, per passenger-km, vehicle distance; computed by the
  platform from validated decisions, never reported when a parameter is missing, never defaulted.
- Emission configuration and vehicle parameters are part of the instance hash, the experiment fingerprint, the
  semantic fingerprint (domain component), bundles (`vehicles`, `emissions` sections) and the comparability
  contract: new **emissions claim** (not comparable when scope, baseline, units or data differ; comparable with
  conditions when factor values or assignments differ) shown as a third verdict with its reasons under *Why?*.
- **A/B comparison workspace** (`#/compare/<A>|<B>`): two maps (synchronised zoom and centre), one replay clock,
  compatible metrics side by side, assignment and served-rider differences per scenario, comparability verdicts.
- **Trace** in the workspace and in Jobs: an execution timeline (created, queued, preparing, every method run with
  its prepare / method / validation durations, persistence, completion, cancellation, errors), raw events under
  *Technical details*, "No trace available" when a job is gone.
- Library organisation: *Demo · Imported · Generated · Edited · Reproduced* categories, experiments grouped by
  category, non-destructive *Hide from lists / Show hidden* per account.
- Problem hooks `domain_metrics`, `domain_descriptor`, `aggregate_domain`, `domain_metric_definitions`; run
  records carry `domain`; comparison rows carry aggregated domain figures; charts offer emission metrics only under
  one scope, baseline and basis.
- Demonstration rebuilt with vehicle profiles (petrol preset; a clearly labelled demonstration electric car) and an
  explicit emission configuration; a newer demonstration is imported next to a previous one (nothing deleted).

### Fixed
- *Route* in the editor drew nothing when origin and destination snapped to the same road node (a one-point
  polyline) or lay off the network: the API now refuses both cases with a reason and the wizard shows it inline.
- *Trace* rendered below the job table, off-screen on long histories: it opens in a drawer.
- Semantic comparability and the A/B diff match scenarios that are the same optimization problem (equal problem
  fingerprint) even when their files differ, e.g. by vehicle or emission data.

### Fixed (earlier in this cycle)
- Map tiles refused (HTTP 403) by tile servers requiring a referrer: tile images now send the page origin
  (`strict-origin-when-cross-origin`); the page itself keeps `Referrer-Policy: same-origin`. When tiles cannot be
  loaded the map says so and keeps showing the data.
- Comparing a controlled variant (or an extension of one) reported its parent's rows; a variant now starts its own
  comparison scope.

### Added
- Map-first workspace as the main screen: Area, Dataset and Experiment selectors; Generate, Run, Compare, Replay,
  Import, Export; participants with served status; routes of the selected method on the map; live run progress;
  key results; comparability with the parent experiment (directly comparable / with conditions / not comparable,
  with the reasons); Export, Reproduce, Extend; advanced options collapsed. Lists follow the selected area.
- Comparison panel with a concise table and charts of any metric the problem supports (objective, mobility
  descriptive metrics, gap, runtimes), exported as CSV, SVG or PNG; no chart library.
- Replay bar: play, speed, timeline with pickup and drop-off ticks, vehicles moving, riders on board and delivered.
- Optional Quick Tour (8 steps, Skip, "Don't show again" saved per account).
- Demonstration experiment shipped with the framework (*Public Mobility Demo — Baseline* and *— Controlled
  Variant*, Paris, RPC open data and OpenStreetMap routing, fixed seeds), imported into each workspace on first use
  through the verified import path; `scripts/build_demo.py` rebuilds it.
- Bundle format 2: problem definition, scenario, network and dataset references with licences, lineage, method and
  campaign configuration, environments, experiment and semantic fingerprints (recomputed on import), replay geometry
  so routes replay on installations without the road network. Format 1 bundles are still imported.
- `move-openlab method new` (template with a local test) and `move-openlab method check` (metadata, sandboxed
  self-test, run on an experiment bundle, comparison, actionable errors); example plugin `nearest_pickup` for ride
  matching; JSON schemas of the method result and the run record (`schemas/`).
- Display-only descriptive metrics declared by problems (`Problem.descriptive_metrics`): service rate and mean
  detour per served rider for ride matching.
- URL routing (hash routes) for every view; per-user workspace preferences.
- `MOVE_OPENLAB_TILE_URL=none` for maps without a basemap.
- Geographic areas in the researcher's workspace: place search (Nominatim proxy, cached, one request per second),
  map selection, box drawing and resizing, road-network profiles (`car`, `car-main-roads`, `car-peak`), network
  download with cache reuse, coverage map, route measurement, area switching.
- Dataset providers: CSV and GeoJSON uploads with detection, explicit mapping, validation report and confirmation
  of rejected rows; workspace dataset store; provider entry-point group `move_openlab.dataset_providers`.
- RPC ingestion by area, restricted to areas in France; scenario generation from any dataset (roles respected).
- Fair-use limits for external services: daily quotas, one download at a time per service, size limits.
- Request-body limits applied before reading; bounded concurrent upload parsing.
- Credential store schema versioning; operator recovery command documented.
- Documentation: `docs/DATASETS.md`, `docs/DEVELOPMENT.md`; README with screenshots; CI lint job; ruff
  configuration in `pyproject.toml`.
- Ride matching on road networks benchmark (`public-ride-matching`): exact two-stage MILP (HiGHS), greedy heuristic,
  controlled variants, relative-detour scorer; travel times stored in the instance.
- Geographic layer: OpenStreetMap road networks via Overpass (content-addressed, full provenance), routing, scenario
  validation, seeded and open-data generators, route playback.
- RPC open-data connector (data.gouv.fr, Licence Ouverte): release listing, streamed hashed ingestion, area filter,
  cleaning with counted rejection reasons, provenance and attribution records.
- Web interface: *Scenarios & maps* (scenario library, map editor with route preview, generators, road networks and
  open data), route playback, *Jobs & traces* (history, stage durations, replay), *Administration* (accounts).
- Persistent background jobs with progress, cancellation (no partial campaign), restart recovery and per-run stage
  traces.
- Account administration API and interface with audit log; operator command `move-openlab users reset-password`.
- Dynamic (share) thresholds with ties kept at the cut-off; threshold reports with candidate reduction, effective
  thresholds, kept-share range and a chart.
- Optimality-scope label on every result (full problem, reduced instance only, not proven, heuristic, invalid) in
  campaign views, comparisons, threshold reports and the Markdown/CSV reports.

### Changed
- Road networks are fetched per area (`POST /api/geo/areas/{id}/network`), by researchers within quotas (or
  administrators only with `MOVE_OPENLAB_EXTERNAL_FETCH=admin`); open-data routes moved to `/api/datasets`;
  `/scenarios/from-open-data` became `/scenarios/from-dataset`.
- Shared networks and RPC subsets record boxes and profiles, not private area names.
- Unused scenario-source interfaces replaced by dataset providers; `GET /api/integrations` lists providers.
- Comparison column "Optimal" renamed "Equals reference optimum"; CSV column `optimal` renamed
  `equals_reference_optimum` and a column `optimality_scope` added.
- Content Security Policy allows images from the configured map tile origin.

## 0.2.0 — not yet released (foundation)

### Added
- Problem-agnostic framework: `Problem` interface, entry-point registry, method contract, independent validation.
- Campaigns (baseline, reproduction, extension, controlled variant, threshold study), lineage, locking, checksums.
- Verified export/import bundles; reproducibility verification; method comparison; semantic comparability;
  candidate scoring with threshold and top-k selection; Markdown, CSV and JSON reports.
- Local accounts with signed sessions and per-researcher workspaces; FastAPI API; React web interface.
- Synthetic capacitated assignment benchmark with exact (HiGHS), greedy and example plugin methods.
- Plugin execution modes: disabled by default, verified bubblewrap sandbox (fail closed), administrator-only
  trusted process.
- Interfaces for OpenStreetMap and open trip-record scenario sources.
- Confidentiality and hygiene gate, CI, GitFlow guide, contribution and security policies.
