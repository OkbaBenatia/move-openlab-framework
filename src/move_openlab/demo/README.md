# Demonstration experiment

`bundle/` is a frozen experiment bundle (format 2) imported into each researcher's workspace the first time they
open the workspace, through the normal verified import path. It contains no code.

| Item | Value |
|---|---|
| Experiments | *Public Mobility Demo — Baseline* and *Public Mobility Demo — Controlled Variant* (lineage: variant of the baseline) |
| Problem | `public-ride-matching` (one rider per driver; maximise served riders, then minimise total detour) |
| Methods | exact two-stage MILP (HiGHS) and greedy (smallest detour first); 3 repetitions |
| Scenarios | 3 samples (seeds 1, 2, 3), 20 drivers and 30 riders each, departures 07:00–09:00, detour ≤ 15 min and ≤ 50 % of the direct trip |
| Controlled change | `detour-nonbinding`: the detour limit is lowered to the largest existing detour; no compatible pair is removed, so the problem is unchanged (quality results directly comparable) |
| Area | Paris, bounding box 48.81558, 2.22412 – 48.90216, 2.46976, profile `car` |
| Road network | OpenStreetMap via Overpass API, OSM data of 2026-11-07; network id, raw-response SHA-256 and builder version in the manifest |
| Trip data | RPC carpooling open data (Registre de Preuve de Covoiturage), release 2026-08, trips with both ends inside the area; drivers and riders resampled from the published origin–destination and departure records (no identifiers) |
| Replay geometry | road polylines of the legs each instance can use (`geometry/`), so routes replay without the network |

## Licences and attribution

- Road network, travel times and route geometry are derived from OpenStreetMap data: © OpenStreetMap contributors,
  Open Database License 1.0 (https://www.openstreetmap.org/copyright). Shared derived data keep this attribution and
  licence.
- Trip records: Registre de Preuve de Covoiturage, data.gouv.fr, Licence Ouverte / Open Licence (Etalab). Records
  are published by the registry with truncated coordinates and rounded times; re-identification is forbidden.

## Rebuilding

```bash
python scripts/build_demo.py --data <data dir> --network <network id> --dataset <RPC dataset key>
```

The inputs are a stored Paris network and an RPC subset for the same box (created in the web interface). `--check`
rebuilds into a temporary directory and compares instances and fingerprints with the shipped bundle; runtimes always
differ.
