# Demonstration experiment

`bundle/` is a frozen experiment bundle (format 2) imported into each researcher's workspace the first time they
open the workspace, through the normal verified import path. It contains no code.

| Item | Value |
|---|---|
| Experiments | *Montbéliard Demo — Baseline* and *Montbéliard Demo — Controlled Variant* (lineage: variant of the baseline) |
| Problem | `public-ride-matching` (one rider per driver; maximise served riders, then minimise total detour) |
| Methods | exact two-stage MILP (HiGHS) and greedy (smallest detour first); 3 repetitions |
| Scenarios | 3 samples (seeds 1, 2, 3), 20 drivers and 30 riders each, departures 07:00–09:00, detour ≤ 15 min and ≤ 50 % of the direct trip |
| Controlled change | `detour-nonbinding`: the detour limit is lowered to the largest existing detour; no compatible pair is removed, so the problem is unchanged (quality results directly comparable) |
| Vehicles | drivers D6–D20 of each sample: platform preset *Petrol car (EU real-world average)* — consumption 7.89 L/100 km (European Commission, COM(2024) 122, real-world fuel consumption of petrol cars registered in 2021), fuel factor 2075 g CO₂e/L (UK DESNZ conversion factors 2026, petrol average biofuel blend, combustion only). Drivers D1–D5: *Battery-electric car (demonstration)* — consumption **16 kWh/100 km, a demonstration assumption** (no official EU average exists; labelled as such in the parameter's source and the profile's provenance, edit before any study), grid factor 43 g CO₂e/kWh (EEA indicator ENER038, France, 2024 early estimate). The riders' baseline vehicle is the petrol preset. |
| Emissions | scope *operational energy* (fuel combustion plus generation of the electricity consumed), baseline *everyone drives alone*; both are experiment configuration and can be changed in the wizard or in a new experiment |
| Area | Montbéliard (Pays de Montbéliard, France), bounding box 47.42, 6.66 – 47.60, 6.96 (about 450 km²), profile `car` |
| Road network | OpenStreetMap via Overpass API, OSM data of 2026-11-09 (58 710 nodes, 108 664 edges); network id, raw-response SHA-256 and builder version in the manifest. The original network and its raw response ship in `network/` and are stored unchanged when the demonstration is installed, so its participants can be edited on any installation ([network/README.md](network/README.md)) |
| Trip data | RPC carpooling open data (Registre de Preuve de Covoiturage), one frozen release — 2026-10 (published 2026-11-07) — 404 trips with both ends inside the area; drivers and riders resampled from the published origin–destination and departure records (no identifiers) |
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

The inputs are the stored Montbéliard network and the RPC 2026-10 subset for the same box (created in the web interface):
`--network 2858421165cd47486a509d26 --dataset 2026-10_c3c5185c01ce`. A single release was enough for the demonstration, so no
merging of releases (and no de-duplication across releases) is involved. `--check`
rebuilds into a temporary directory and compares instances and fingerprints with the shipped bundle; runtimes always
differ.
