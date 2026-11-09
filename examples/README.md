# Examples

## Sample bundle — *Montbéliard sample — Baseline*

A real experiment exported from MOVE OpenLab, shipped so that anyone can try the whole cycle
**Import → Validate → Reproduce → Extend → Compare** without a colleague at hand. In the application:
*Import → Try an imported experiment*.

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

- In the application: *Import → Try an imported experiment → Download sample bundle* (or the same screen's *Import*
  button, which verifies and imports it directly).
- From a terminal, in the project directory:

```bash
.venv/bin/python -c "from move_openlab import samples; open(samples.FILENAME, 'wb').write(samples.bundle_bytes())"
```

### Checking your own method against it

```bash
.venv/bin/move-openlab method check plugins/nearest_pickup --bundle move-openlab-sample-montbeliard.zip
```

`plugins/nearest_pickup/` is a working example plug-in; `move-openlab method new my_method --problem
public-ride-matching --dir plugins` creates a new one from the template. Guide: [docs/EXTENDING.md](../docs/EXTENDING.md).

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
