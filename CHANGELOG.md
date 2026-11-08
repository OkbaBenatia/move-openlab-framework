# Changelog

All notable changes are documented here. Versions follow Semantic Versioning; pre-1.0 minor versions may change
interfaces.

## Unreleased

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
