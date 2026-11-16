# Examples

Two public example packages ship with MOVE OpenLab. They are different things and are **not interchangeable**.

| | A — Scenario import | B — Experiment bundle |
|---|---|---|
| What it is | mobility **data**: synthetic commuting trips | an exported **experiment with results** |
| File | [`scenario-import/montbeliard-synthetic-trips.csv`](scenario-import/montbeliard-synthetic-trips.csv) | `move-openlab-sample-montbeliard.zip`, packed on demand |
| Size | 6 962 bytes, 120 trips | 869 357 bytes |
| SHA-256 | `869a5e9fc274897e290c979beec54896c53f81be2f5bf73592802282a5a96b95` | `3346947061afda42626cf3948bc9149304b23f9c5dcba4f1651d4d0fb2d165d1` |
| Described by | [`src/move_openlab/samples/trips/trips.json`](../src/move_openlab/samples/trips/trips.json) | [`src/move_openlab/samples/montbeliard.json`](../src/move_openlab/samples/montbeliard.json) |
| In the application | *Import ▾ → Try the sample trip dataset* | *Import ▾ → Try a sample → Try an imported experiment* |
| What you do with it | import it as a mobility dataset, then **Generate** a scenario from it and run methods | import, verify, reproduce, add your method, compare |
| Contains results | no | yes |
| Licence of the content | CC0 1.0 | ODbL 1.0 (OpenStreetMap) and Licence Ouverte / Open Licence (Etalab) |

A trip dataset cannot be imported as an experiment, and a bundle is not a dataset: no scenario is generated from it.
Step-by-step use of both, with what appears at each click: [docs/IMPORT_EXPORT.md](../docs/IMPORT_EXPORT.md#the-two-example-packages).

A third, smaller example is of another nature: [C — ML evaluation evidence](#c-ml-evaluation-evidence--synthetic-example),
a **synthetic** file of labelled records for trying the import of evaluation evidence. It is neither a dataset nor an
experiment, and it is not a result.

## The two downloadable sample packages

| | Sample scenario | Sample experiment |
|---|---|---|
| File | `sample_scenario.zip` — 274 781 bytes | `sample_experiment.zip` — 869 357 bytes (the same bytes as `move-openlab-sample-montbeliard.zip`, section B) |
| SHA-256 | `5be2218bcbb52cb85758b365eb30ac9e3f9c9bf050a625addf1a7ff4a83cfd74` | `3346947061afda42626cf3948bc9149304b23f9c5dcba4f1651d4d0fb2d165d1` |
| Format | `move-openlab-scenario/1` (scenario package) | `move-openlab-bundle/2` (experiment bundle) |
| Content | one frozen scenario of the Montbéliard demonstration — its baseline's sample 1, 20 drivers and 30 riders — with its editable composition and replay geometry | an exported experiment with its validated results (section B) |
| Kept unpacked in | [`src/move_openlab/samples/scenario/`](../src/move_openlab/samples/scenario/), described by [`scenario-sample.json`](../src/move_openlab/samples/scenario-sample.json) | [`src/move_openlab/samples/montbeliard/`](../src/move_openlab/samples/montbeliard/) |
| In the application | *Import ▾ → Try a sample → Sample scenario* (`GET /api/lab/sample/scenario`) | *Import ▾ → Try a sample → Sample experiment* (`GET /api/lab/sample/bundle`) |

The checksums are in [`SHA256SUMS`](SHA256SUMS). The repository stores no archives, so the two files are packed on
demand, deterministically (sorted members, fixed timestamps) — one command writes both into `examples/` and checks them:

```bash
.venv/bin/python scripts/pack_examples.py          # writes examples/sample_scenario.zip and examples/sample_experiment.zip
cd examples && sha256sum -c SHA256SUMS
```

The same bytes are downloaded from *Try a sample*. A GitHub release can attach the two files produced by this command.

**Sample scenario, step by step.** Download it (or not: *Import the sample scenario* imports the same bytes), import it
— the importer checks the manifest digest and every file checksum, that the problem specification and validator are this
installation's, that the instance passes the problem's checks and has the content hash the manifest names, that the
replay geometry belongs to the instance and that the composition gives the instance's participants, time windows,
parameters and vehicles — then *Open it in a new
experiment*: tick the methods, *Run*; every run is checked by the independent validator, results and routes appear in
the Workspace. Where the Montbéliard road network is installed, the importer also rebuilds the instance from the
composition and requires the identical instance (*rebuilt here and identical*); where it is not — a new installation —
the verified frozen instance and its geometry are stored and the import says plainly that viewing and running work
while editing the participants needs the area's road network (prepared once from Data setup). The composition is the
one the demonstration builder used: recovered from the frozen instance, its SHA-256 starts with the digits the builder
put in the instance id (`demo-sample-1-a4d13d15`); rebuilt on the Montbéliard network it gives the identical instance.
Rebuild with `scripts/build_sample_scenario.py [--network-data <data dir>]`, then `scripts/pack_examples.py --update`.
Licences: participants sampled from the Registre de Preuve de Covoiturage (data.gouv.fr, Licence Ouverte / Open
Licence, Etalab); road network, travel times and route geometry © OpenStreetMap contributors, ODbL 1.0.

Any library scenario, or an experiment's frozen scenario, exports to the same format
(`GET /api/geo/scenarios/{id}/package`, `GET /api/geo/instances/{hash}/package`); *Import ▾ → Import a bundle file…*
recognises a scenario package by its manifest and sends it to the scenario importer. Tests:
`tests/test_scenario_packages.py`; browser check: `scripts/e2e/samples.mjs`.

## A. Scenario import — *Montbéliard synthetic commuting trips*

A small, fully synthetic trip dataset, shipped so that anyone can try the data path — import a file, map its columns,
generate a scenario — without owning mobility data.

| Item | Value |
|---|---|
| File | [`scenario-import/montbeliard-synthetic-trips.csv`](scenario-import/montbeliard-synthetic-trips.csv) — 6 962 bytes, SHA-256 `869a5e9fc274897e290c979beec54896c53f81be2f5bf73592802282a5a96b95` (also in [`scenario-import/SHA256SUMS`](scenario-import/SHA256SUMS)) |
| Format | CSV, UTF-8, comma-separated, one trip per row, 120 rows |
| Columns | `date`, `departure_time`, `origin_lat`, `origin_lon`, `destination_lat`, `destination_lon`, `role` (driver or rider) |
| Area | inside the box of the Montbéliard demonstration: 47.42, 6.66 – 47.60, 6.96 |
| Origin | generated by [`scripts/build_sample_trips.py`](../scripts/build_sample_trips.py) with a fixed seed: origins and destinations drawn around commune centres of the area, departures around a morning peak. No observed and no personal mobility data |
| Licence | Creative Commons Zero 1.0 (CC0-1.0, public domain dedication) — https://creativecommons.org/publicdomain/zero/1.0/ |

### Getting the file

- It is in the repository: `examples/scenario-import/montbeliard-synthetic-trips.csv`. The application serves the
  same bytes from a packaged copy (`src/move_openlab/samples/trips/`).
- In the application: *Import ▾ → Try the sample trip dataset → Download the CSV file* (`GET /api/lab/sample/trips`).

Check it:

```bash
cd examples/scenario-import && sha256sum -c SHA256SUMS
```

### Using it

1. *Import ▾ → Try the sample trip dataset → Import the sample dataset*. The file goes through the normal CSV import
   with the column mapping recorded in `trips.json`; the panel reports the trips kept and rejected.
2. *Generate a scenario from this dataset*, choose an area that contains the trips (the demonstration's Montbéliard
   area), set participants, constraints and methods, then *Save & Run*.

By hand: *Library › Data setup › 2 · Mobility data*, upload the file and map its columns.

**What it needs.** Generating a scenario needs the road network of the area. A new installation does not have it: it
is downloaded once from OpenStreetMap through the Overpass API, as a background job, and needs network access. The
import of the dataset itself needs none.

### Rebuilding

```bash
.venv/bin/python scripts/build_sample_trips.py
```

The script is deterministic: it writes the same bytes again, in both locations, with `trips.json` and `SHA256SUMS`.
Test: `tests/test_sample_trips.py`.

## B. Experiment bundle — *Montbéliard sample — Baseline*

A real experiment exported from MOVE OpenLab, shipped so that anyone can try the whole cycle
**Import → Validate → Reproduce → Extend → Compare** without a colleague at hand. In the application:
*Import ▾ → Try a sample → Try an imported experiment*. It is an experiment with its results, not a dataset.

| Item | Value |
|---|---|
| File | `move-openlab-sample-montbeliard.zip` — 869 357 bytes, SHA-256 `3346947061afda42626cf3948bc9149304b23f9c5dcba4f1651d4d0fb2d165d1` |
| Format | `move-openlab-bundle/2` (records only: no executable code) |
| Problem | `public-ride-matching` 1.0.0, validator 1.0.0 |
| Scenarios | the three frozen scenarios of the Montbéliard demonstration's baseline (20 drivers and 30 riders each, participants sampled from RPC 2026-10 observed trips; seeds 1, 2, 3) |
| Methods | exact matching MILP (HiGHS) 1.0.0 and greedy (smallest detour first) 1.0.0 |
| Runs | 3 repetitions → 18 runs, 18 accepted by the independent validator |
| Exported by | *Researcher A*, in a separate, temporary installation (`scripts/build_sample_bundle.py`) |

### Where it is

The bundle is kept **unpacked** in the package: [`src/move_openlab/samples/montbeliard/`](../src/move_openlab/samples/montbeliard/)
(`manifest.json`, `manifest.sha256`, `campaigns/`, `instances/`, `geometry/`), described by
[`src/move_openlab/samples/montbeliard.json`](../src/move_openlab/samples/montbeliard.json) (build information and the
recorded independent check). The repository accepts no archives and no file over 1 MB, so the `.zip` is packed on
demand, deterministically: the packed file is byte-identical everywhere (the SHA-256 above).

### Getting the `.zip`

- In the application: *Import ▾ → Try a sample → Download sample bundle* (`GET /api/lab/sample/bundle`),
  or the same screen's *Import the sample*, which verifies and imports it directly.
- From a terminal, in the project directory:

```bash
.venv/bin/python -c "from move_openlab import samples; open(samples.FILENAME, 'wb').write(samples.bundle_bytes())"
```

### Checking your own method against it

```bash
.venv/bin/move-openlab method check plugins/nearest_pickup --bundle move-openlab-sample-montbeliard.zip
```

`plugins/nearest_pickup/` is a working example plug-in; `move-openlab method new my_method --problem
public-ride-matching --dir plugins` creates a new one from the template. Guides:
[docs/ADD_YOUR_METHOD.md](../docs/ADD_YOUR_METHOD.md), [docs/SOLVER_INTEGRATION.md](../docs/SOLVER_INTEGRATION.md).

### How it was checked before it was offered

`scripts/check_sample_bundle.py` plays *Researcher B* in a second, isolated installation (plug-ins in the verified
sandbox): import → integrity (7 files, 3 instances, 3 route geometries, fingerprints recomputed, specification and
validator match, no code) → reproduction (6 of 6 cells with identical solutions: *Reproduced*) → registration of
the example method (self-test accepted in the sandbox) → extension (9 of 9 runs accepted) → comparison (all
results valid; results, runtimes and CO₂ directly comparable). The application offers the sample only when that
recorded check says `ok` for exactly this packed file. The same cycle runs in the test suite
(`tests/test_sample_bundle.py`).

### Rebuilding

```bash
.venv/bin/python scripts/build_sample_bundle.py
```

```bash
.venv/bin/python scripts/check_sample_bundle.py --record
```

A rebuild produces a new experiment (new identifiers, new runtimes); the check must then pass again before the
application offers it.

### Data and licences

Same sources as the demonstration ([src/move_openlab/demo/README.md](../src/move_openlab/demo/README.md)): road
network, travel times and route geometry derived from OpenStreetMap data © OpenStreetMap contributors (ODbL 1.0);
trip records from the Registre de Preuve de Covoiturage (data.gouv.fr, Licence Ouverte / Open Licence, Etalab),
used only as a pool from which participants are sampled — never replayed one-to-one.

## C. ML evaluation evidence — *synthetic example*

**These records are SYNTHETIC.** They are not a mobility result, they are not the output of any real model, and
they evaluate no method — not a method of MOVE OpenLab, not the example plug-ins, not anyone's research. Labels and
scores are drawn by a seeded random generator. The files exist so that anyone can try *Import evaluation evidence*
and check the computation against values known in advance. The figures obtained from them mean nothing beyond that.

| Item | Value |
|---|---|
| Files | [`ml-evaluation/synthetic-binary-evidence.json`](ml-evaluation/synthetic-binary-evidence.json) — 26 310 bytes, SHA-256 `1fd6d8671a91fdffc398ecdaad93b737a5ce0bd40d1fb82f1697182cef086da3`; [`ml-evaluation/synthetic-binary-evidence.csv`](ml-evaluation/synthetic-binary-evidence.csv) — 6 815 bytes, SHA-256 `6f791e806bd9dd17cbde8469088d732c23fe5a8c5e8c6392ed3f164425fcb1f2` (both in [`ml-evaluation/SHA256SUMS`](ml-evaluation/SHA256SUMS)) |
| Format | JSON: an evidence document `move-openlab/ml-evaluation-evidence@1`; CSV: the same records as `id,label,score` ([docs/ML_INTEGRATION.md](../docs/ML_INTEGRATION.md#the-evidence-format)) |
| Records | 400 artificial records, 120 with label 1; scores between 0 and 1 with three decimals (some are tied) |
| Decision | `score >= 0.5` |
| Origin | [`scripts/build_ml_evaluation_example.py`](../scripts/build_ml_evaluation_example.py), seed 20261116 |

### What it must give

At the recorded threshold the confusion matrix is fixed by construction:

| | Predicted positive | Predicted negative |
|---|---|---|
| **Label 1** | TP = 96 | FN = 24 |
| **Label 0** | FP = 28 | TN = 252 |

Hence accuracy 348 ÷ 400 = 87 %, precision 96 ÷ 124 = 77.42 %, recall 96 ÷ 120 = 80 %, specificity 252 ÷ 280 = 90 %,
balanced accuracy 85 %, F1 192 ÷ 244 = 78.69 %. At the exploratory threshold 0.7 the matrix is TP 79, FN 41, FP 11,
TN 269. `tests/test_ml_evaluation.py` checks these values.

Check the files:

```bash
cd examples/ml-evaluation && sha256sum -c SHA256SUMS
```

### Using it

Evidence is imported for a learned or hybrid method of one of your experiments (*Compare → Methods → ML evaluation
→ Import evaluation evidence*). An experiment with only exact and heuristic methods has nothing to attach it to.

- **The CSV** holds the records only. The dialog asks for the description (model, feature pipeline, dataset,
  population, decision) and attaches the evidence to the method whose card you opened it from. Describe it as what it
  is — synthetic records — so that the evaluation shown says so.
- **The JSON** names the method `synthetic-example-classifier`, a placeholder that exists nowhere: as it is, the
  import is refused with that reason, which is itself worth seeing. It documents the format; to import it, copy it and
  set `method_id` to a learned method of your experiment.

Either way the card then shows figures of the synthetic records under your method's name: **they say nothing about
that method.** Use *Withdraw this evidence…* when you have seen how it works. The example plug-in
`plugins/example_scored_filter/` gives you a learned method to try this on
([docs/ML_INTEGRATION.md](../docs/ML_INTEGRATION.md#an-ml-assisted-method-without-a-problem-package)); no evaluation
of that plug-in is shipped.

### Rebuilding

```bash
.venv/bin/python scripts/build_ml_evaluation_example.py
```

The script is deterministic: it writes the same bytes again, with `SHA256SUMS`, and stops if the records do not give
the matrix above.

Every third-party licence in one place: [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
