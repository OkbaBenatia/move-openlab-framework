# Changelog

All notable changes are documented here. Versions follow Semantic Versioning; pre-1.0 minor versions may change
interfaces.

## Unreleased

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
