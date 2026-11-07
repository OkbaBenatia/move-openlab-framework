# Changelog

All notable changes are documented here. Versions follow Semantic Versioning; pre-1.0 minor versions may change
interfaces.

## Unreleased

### Added
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
