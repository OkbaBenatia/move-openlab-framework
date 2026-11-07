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

The only built-in verified normalisation is the positive scaling of one metric (a change of unit). Different methods
never make a comparison invalid — comparing methods is the purpose of a benchmark.

## Limits

- Problem fingerprints do not detect relabelled (isomorphic) instances.
- Campaign checksums detect modification but do not authenticate their author (see the security model).
- Results obtained on pruned instances (threshold studies) are optimal only for the pruned problem; reports label
  them "optimal for the reduced instance only".
- Dynamic (share) thresholds keep every candidate tied at the cut-off and every unscored candidate, so the kept share
  can exceed the requested share; reports show the effective threshold and the actual kept share.
