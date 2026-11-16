# Import and export

Three different things can be brought into a workspace. They are not interchangeable, and each has its own path and
its own checks.

| | 1. Mobility data | 2. Experiment bundle | 3. Results computed elsewhere |
|---|---|---|---|
| What it is | trips: origin, destination, departure, optional role | a locked experiment with its lineage: scenarios, methods, validated runs | decisions a method produced outside the platform |
| File | CSV or GeoJSON (or an open-data release, or synthetic demand) | one `.zip` of JSON records, format `move-openlab-bundle/2` | a JSON request body |
| Becomes | a mobility dataset, from which scenarios are **generated** | an experiment marked *Imported*, read-only | a new locked experiment whose results read *imported results, re-validated here* |
| Checked | every row validated; rejected rows counted with reasons | every checksum, fingerprint, the problem specification and validator version | every record digest; every decision set re-validated |
| Carries results | no | yes | yes |
| Carries code | no | no | no |
| Where | *Library › Data setup › 2 · Mobility data*, or *Import ▾ → Try the sample trip dataset* | **Import ▾ → Import a bundle file…**, or *Try an imported experiment* | `POST /api/campaigns/import-results` (API only) |

Nothing is imported silently, nothing imported overwrites an existing record, and no import executes code.

## 1. Mobility data

Trips are a pool from which the participants of a scenario are sampled; they are never replayed one-to-one. Formats,
accepted values, limits and the open-data connector are described in [DATASETS.md](DATASETS.md).

| Where to click | What appears |
|---|---|
| *Library › Data setup › 1 · Area and road network* | your areas; an area needs its road network before scenarios can be built on it |
| *Library › Data setup › 2 · Mobility data* → choose a CSV or GeoJSON file | the detected encoding and delimiter, a preview, a suggested column mapping |
| Map every field to a column, validate | a report: trips kept, rows rejected with their reasons, trips inside the area |
| Save | the dataset in your list; saving a file with rejected rows asks for an explicit confirmation |
| **Generate** → choose the area and this dataset | the five-step wizard; drivers and riders are sampled from the dataset with a seed |

The raw file is not stored: only the validated, normalised trips and the report (file name, size, SHA-256, mapping,
rejections) are kept, in your workspace. The same steps through the API: `POST /api/datasets/csv/inspect` and
`POST /api/datasets/csv/import` (or `geojson`), as multipart forms.

## 2. Experiment bundles

A bundle carries a locked experiment and its whole lineage between researchers. What it contains and what each
checksum protects: [REPRODUCIBILITY.md](REPRODUCIBILITY.md#experiment-bundles).

### Export

| Where to click | What appears |
|---|---|
| **Export** in the Workspace action bar | *Export experiment*: the records, scenarios, area and data references, methods and runs the bundle will contain |
| Keep *Evidence report* ticked; optionally untick the replay geometry | the two optional sections; the required ones are fixed |
| *ML evaluation evidence* (only when evidence was imported for a learned method of these records) | *Include the evidence* · *References only* · *Leave out* — see [ML integration › Evidence in an experiment bundle](ML_INTEGRATION.md#evidence-in-an-experiment-bundle) |
| **Lock and export** | the experiment is locked (results frozen, checksum recorded) and one `.zip` is downloaded; its SHA-256 is shown — send that value with the file |

API:
`GET /api/campaigns/{id}/export` (`?geometry=false` leaves the replay geometry out, `?evidence=true` puts the
evidence report inside, `?ml_evidence=full|reference|none` says what of the imported ML evaluation evidence goes in);
`GET /api/lab/export/{id}` previews the content without building the file.

### Import

| Where to click | What appears |
|---|---|
| **Import ▾ → Import a bundle file…**, choose or drop the `.zip` | *Import experiment*: the file is inspected on the server; nothing is stored yet |
| Read the report | *Package* (experiment, exporter, format, SHA-256, problem); *What will be imported* (records, scenarios, area and road network, mobility data, methods, vehicles and CO₂, replay geometry, evidence report); the checks: *Records and lineage*, *Problem and validator*, *No executable code*, *Importable*, *Reproducible here*, *Comparable* |
| **Import experiment** | the experiment opens marked *Imported*, with *Integrity verified* |
| **Run again** | a re-execution on your installation; *Reproduced* when every validated metric is equal |

A bundle is refused, with the reason and without storing anything, when a checksum or fingerprint does not match,
when the problem is not installed here, when its specification or validator version differs from the installed one,
or when its format is newer than this installation reads. Compare the SHA-256 shown at import with the value the
exporter sent you: checksums detect corruption and inconsistent edits; they are not signatures. Limits: 64 MB per
bundle, 256 MB uncompressed. API: `POST /api/lab/inspect` (verification only), `POST /api/import`.

A method the bundle names but that is not installed here is shown as such: the experiment is still imported and
readable, and it becomes re-executable once the same method — same version and, for a plug-in, same code hash — is
installed.

## 3. Results computed elsewhere

Results that a method produced outside the platform — a long computation on another machine, an archived runner —
can be brought in as **data**. There is no form for this in the interface; it is one API call.

```
POST /api/campaigns/import-results
{
  "problem_id": "...", "title": "...",
  "instance_hashes": ["<stored scenario hash>", ...],
  "methods": [["<built-in method id>", "<version>"], ...],
  "method_configs": {"<method id>": {...}},
  "source": {"name": "where the results come from", "executed_by": "...", "environment": {...}},
  "records": [{"instance_hash": "...", "method_id": "...", "decisions": [...], "status_declared": "OPTIMAL",
               "declared": {...}, "solver_time_s": 0.0, "total_time_s": 0.0, "method_metadata": {...},
               "diagnostics": {...}, "effective_config": {...}, "executed_at": "...", "record_sha256": "..."}]
}
```

| Rule | Detail |
|---|---|
| Scenarios | every `instance_hash` must be a scenario already stored here, of that problem |
| Methods | installed built-in methods of the problem, each listed once; their settings are checked against their schemas |
| Digest | `record_sha256` is the SHA-256 of the record's canonical JSON (sorted keys, no whitespace) without that field; a mismatch refuses the import |
| Validation | every decision set is re-validated by the problem's validator; declared values are compared, never trusted |
| Accepted | the validator finds the decisions feasible, no declared value differs, and the declared status is `OPTIMAL`, `FEASIBLE` or `TIME_LIMIT` |
| Rejected records | kept as rejected runs, never dropped; the experiment records how many were validated, rejected and missing |
| Nothing is executed | no code is imported, nothing is solved |

The result is a new experiment, locked at once, whose runs carry `origin = "imported-external"`. Its results are
labelled *imported results (computed elsewhere, re-validated here, not executed here)* wherever they are shown. The experiment exports like any other,
and its runs are re-validated again when the bundle is imported elsewhere. Tests: `tests/test_result_import.py`.

## The example packages

Both are public and ship with the application. Files, sizes, checksums and licences:
[examples/README.md](../examples/README.md).

### A — Scenario import: the sample trip dataset

`montbeliard-synthetic-trips.csv` is mobility **data**: 120 synthetic commuting trips in the Montbéliard area,
generated by `scripts/build_sample_trips.py`, dedicated to the public domain (CC0 1.0). It contains no results.

| # | Where to click | What appears |
|---|---|---|
| 1 | **Import ▾ → Try the sample trip dataset** | a panel with the file name, size and the start of its SHA-256, its columns, and two numbered steps |
| 2 | *Download the CSV file* (optional) | the same file as `examples/scenario-import/montbeliard-synthetic-trips.csv` |
| 3 | **Import the sample dataset** | the file goes through the normal CSV import with its column mapping; the panel reads *Imported: … trips kept, … rejected* |
| 4 | **Generate a scenario from this dataset** | the Generate wizard, with this dataset selected |
| 5 | Choose an area that contains the trips (the demonstration's Montbéliard area); when its road network is not stored yet, prepare it | a background job downloads the network once from OpenStreetMap (Overpass); it needs network access |
| 6 | Set the numbers of drivers and riders, the constraints and the methods, then **Save & Run** | a new experiment with its job stages, then validated results |

By hand, without the panel: *Library › Data setup › 2 · Mobility data*, upload the downloaded file and map its
columns.

What to expect honestly: step 5 depends on an external service. Without network access, or when the service refuses
the request, the dataset is imported but no scenario can be generated from it on that area until the road network is
available.

### B — Experiment bundle: the sample bundle

`move-openlab-sample-montbeliard.zip` is an exported **experiment with results**: the three frozen scenarios of the
demonstration's baseline, two methods, three repetitions, every run accepted by the validator. It is not a dataset:
no scenario is generated from it.

| # | Where to click | What appears |
|---|---|---|
| 1 | **Import ▾ → Try a sample → Try an imported experiment** | a guide with the sample's title, size and SHA-256 |
| 2 | *Download sample bundle* (optional) | the `.zip`, packed on demand, byte-identical on every installation |
| 3 | Read *Integrity verified* | the verification report, computed without storing anything: archive and manifest, scenarios, replay geometry, experiment record, problem and validator, no executable code |
| 4 | *Import the sample* | the experiment in your workspace, marked *Imported*; *Open in the workspace* |
| 5 | *Reproduce on this installation* | a re-execution with progress, then the reproducibility verdict |
| 6 | *Compare original and reproduction* | the comparison of the two experiments, claim by claim |
| 7 | *Add your method* | registration of a plug-in (the sandbox must be available) and its run as an extension |
| 8 | *Compare again*, *Export the extension* | the extension next to the original; one `.zip` to send back |

The repository stores no archive, so the `.zip` exists only when the application or a script packs it; the packed
file has the same bytes everywhere and its SHA-256 is published in [examples/README.md](../examples/README.md). The
application offers the sample only when the recorded cross-installation check of exactly that file succeeded.
Steps 1 to 6 need no network access and no plug-in.

### Sample scenario package: `sample_scenario.zip`

A **scenario** — not data, not results: one frozen scenario of the demonstration (its baseline's sample 1, 20 drivers,
30 riders) in the scenario-package format `move-openlab-scenario/1`, with its editable composition and replay geometry.

| # | Where to click | What appears |
|---|---|---|
| 1 | **Import ▾ → Try a sample** | two cards: *Sample scenario* and *Sample experiment*, each with file name, size and SHA-256 |
| 2 | *Download* (optional) | `sample_scenario.zip`, the same bytes as `scripts/pack_examples.py` writes into `examples/` |
| 3 | *Import the sample scenario* | the verification report: manifest and every checksum, problem and validator, instance hash, geometry, composition consistent with the instance, licences; then *rebuilt here and identical* (road network installed) or *viewing and running work; editing the participants needs the area's road network* (not installed) |
| 4 | *Open it in a new experiment* | the Workspace with the scenario picked; tick the methods, **Run** |
| 5 | Results | every run checked by the independent validator; routes on the map |

The same file can be imported through **Import ▾ → Import a bundle file…**: the dialog recognises a scenario package by
its manifest and sends it to the scenario importer. Any scenario of your library, or the frozen scenario of an
experiment, can be exported in the same format (`GET /api/geo/scenarios/{id}/package`,
`GET /api/geo/instances/{hash}/package`); import with `POST /api/geo/scenario-packages/import`
(`/inspect` verifies without storing).

### Both samples as files

```bash
.venv/bin/python scripts/pack_examples.py          # writes examples/sample_scenario.zip and examples/sample_experiment.zip
cd examples && sha256sum -c SHA256SUMS
```

`sample_experiment.zip` is the sample bundle of section B (same bytes as `move-openlab-sample-montbeliard.zip`). The
repository's hygiene gate refuses committed archives, so the files are produced by this command (byte-identical
everywhere) and can be attached to a GitHub release.

### Which one do I need?

| I want to… | Use |
|---|---|
| see how my own trip file would be imported | A |
| build a scenario from data and run methods on it | A |
| check that an experiment travels and reproduces | B |
| run methods on a ready scenario without generating one | the sample scenario package |
| test my method against published results | B |
