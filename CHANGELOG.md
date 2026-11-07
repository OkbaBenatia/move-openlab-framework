# Changelog

All notable changes are documented here. Versions follow Semantic Versioning; pre-1.0 minor versions may change
interfaces.

## Unreleased

### Added
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
