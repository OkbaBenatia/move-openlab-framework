# Reproducibility and semantic comparability

## What is recorded

| Element | How it is identified |
|---|---|
| Instance | SHA-256 of its canonical JSON (sorted keys, no whitespace), stored once and never modified |
| Scenario set | generator name and version, parameters, ordered instance hashes |
| Problem | problem id and specification version, objective and constraint specification ids, instance schema, validator version |
| Method | id and semantic version; plugins also by the SHA-256 of their code |
| Configuration | repetitions, timeout, time budget, per-method options; the effective configuration of each run |
| Run | decisions, independent validation, declared values, status, solver/method/total times, isolation mode |
| Environment | Python, OS, machine, CPU model digest, CPU count, framework and solver versions |
| Campaign | checksum over all of the above once locked; parent checksum for derived campaigns |

## Determinism

- Generators use only `random.Random` seeded from (size, seed, generator version): identical on every platform.
- Worker processes run with `PYTHONHASHSEED=0` and one thread; built-in methods break ties deterministically; the
  exact method uses a fixed solver seed and zero MIP gap.
- Bundles are deterministic: identical records produce identical member files (only the export timestamp in the
  manifest differs, so the archive's own hash changes with each export; the manifest lists the hash of every member).

## Geographic scenarios and open data

| Element | Reproducible how |
|---|---|
| Road network | Content-addressed (`network_id`, includes the profile: road classes and speed factor); provenance records the Overpass query, bounding box, retrieval time, OSM data timestamp and SHA-256 of the raw response. Re-fetching later gives a different network when OpenStreetMap has changed |
| Open-data subset | Release, resource id, SHA-256 and size of the full file, bounding box, cleaning rules and rejection counts; the publisher may revise a release, which the hash reveals |
| Uploaded dataset | SHA-256 and size of the uploaded file, column mapping, time and date formats, rejection counts, SHA-256 of the stored normalised trips |
| Generated scenario | Seed, generator version and inputs (network id, dataset key, time window, minimum trip length); same inputs give the same scenario |
| Instance | Snapped points, travel times and compatible pairs are stored in the instance; methods, validation, bundles and reproductions need neither the network nor the open data |

## Experiment bundles

A bundle carries a locked experiment and its whole lineage between researchers, as JSON only (no code, no password,
no server data). Format 2 (`move-openlab-bundle/2`) contains:

| Member or manifest field | Content |
|---|---|
| `campaigns/*.json` | each campaign of the lineage with its checksum: problem specification, methods, configuration, runs, environment |
| `instances/*.json` | every instance used: frozen participants, parameters, travel times, dataset and network provenance |
| `geometry/*.json` | optional replay polylines of the legs an instance can use (derived from OpenStreetMap, ODbL) |
| `problem` | objective levels, metric definitions, evaluation contract (validator, timing definitions), decision description |
| `scenarios` | per instance: name, size, source, generator, seed, dataset key, network id, derivation |
| `networks` | road-network references: id, profile, box, OSM data timestamp, raw-response SHA-256, builder version, licence |
| `datasets` | dataset provenance: provider, release or source hash, licence, attribution |
| `campaigns`, `lineage` | kind, relation to the parent, configuration and result summary of every campaign |
| `methods`, `environment_requirements`, `environments` | method ids, versions, code hashes; recorded execution environments |
| `vehicles` | every vehicle profile frozen in the instances: powertrain, capacity, each parameter with value, unit, CO₂/CO₂e basis, source, source version, applicability, notes, timestamp |
| `emissions` | the emission configuration of every campaign (scope, baseline) and the domain descriptors (what the emission figures of each campaign × instance depend on, with their fingerprints) |
| `fingerprints` | **experiment fingerprint** (what was run: specification, validator, instances, methods, configuration of the lineage — hence the emission configuration too) and **semantic fingerprint** (which problem: the instances' problem fingerprints and the evaluation contract, plus the domain descriptors when the instances carry vehicle data) |
| `files`, `manifest.sha256` | SHA-256 of every member and of the manifest |

Importing recomputes and checks everything before writing: member hashes, instance hashes and structure, campaign
checksums and lineage, the problem specification and validator version, both fingerprints and that every geometry
member belongs to an instance of the bundle. Instances are content-addressed, so imported vehicle parameters are
restored exactly as exported. Format 1 bundles and format 2 bundles written before the `vehicles` / `emissions`
sections existed are still imported (their semantic fingerprint has no domain component and verifies unchanged).

Changing an emission parameter (for example the electricity emission factor) is therefore never silent: the
instance hash, the experiment fingerprint and the semantic fingerprint all change, the bundle records the new value
with its provenance, and the comparability check reports the difference (below).

The shipped demonstration (`src/move_openlab/demo/`) is such a bundle: two experiments on Paris built from RPC open
data and OpenStreetMap routing with fixed seeds. Re-running it on any installation reproduces every result exactly
(`tests/test_lab.py`).

## What a reproduction verifies

A reproduction campaign re-executes the parent's methods on the parent's instance hashes in another workspace or
installation. Per scenario × method cell:

| Verdict | Meaning |
|---|---|
| Identical solution | same validated metrics and the same decisions |
| Equal objective | same validated metrics, different decisions (alternative optima) |
| Different | a validated metric differs, or the cell is missing |

Runtimes are reported but never required to match: they depend on the hardware and the load.

## Semantic comparability

Equal files are not required for a valid comparison, and equal names are not sufficient. Four fingerprints answer
four questions:

| Fingerprint | Question |
|---|---|
| Raw artifact hash | Are the instance files identical? |
| Problem fingerprint | Is it the same optimization problem? (feasible region, coefficients, objective definition) |
| Evaluation fingerprint | Are the metrics defined identically? (definitions, units, aggregation, scale, ranking, validator, timing) |
| Environment fingerprint | Were runtimes measured under the same hardware and software? |

Each comparison is decided for a claim:

| Claim | Incompatible when | Conditional when |
|---|---|---|
| Quality | problem differs; a result is infeasible; metric definitions differ without a verified transformation | verified normalisation applied; time budgets differ; same method with different options |
| Runtime | problem differs; timing definitions differ | environments, time budgets or repetition counts differ |
| Emissions | problem differs; no emission data on one side; a result is infeasible; emission scope, baseline, unit or CO₂/CO₂e basis differ | vehicle parameter values, the driver-to-vehicle assignment or the riders' baseline vehicle differ |

The only built-in verified normalisation is the positive scaling of one metric (a change of unit). Different methods
never make a comparison invalid — comparing methods is the purpose of a benchmark. The emissions claim never
restricts the other two: the same scenario studied with other emission factors keeps its objective results directly
comparable while its emission figures are only comparable with conditions (the reasons are listed under *Why?*).
Scenarios of two experiments are matched by instance hash, by derivation (controlled variants) or by equal problem
fingerprint (same optimization problem, other vehicle or emission data).

## Limits

- Problem fingerprints do not detect relabelled (isomorphic) instances.
- Campaign checksums detect modification but do not authenticate their author (see the security model).
- Results obtained on pruned instances (threshold studies) are optimal only for the pruned problem; reports label
  them "optimal for the reduced instance only".
- Dynamic (share) thresholds keep every candidate tied at the cut-off and every unscored candidate, so the kept share
  can exceed the requested share; reports show the effective threshold and the actual kept share.
