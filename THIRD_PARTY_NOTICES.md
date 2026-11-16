# Third-party notices

MOVE OpenLab uses the third-party software, fonts and data listed here. Each keeps its own licence. This file is an
inventory, not a legal opinion; the licence texts are those distributed with each component.

**Licence of MOVE OpenLab itself:** Apache License 2.0 for the framework's code, documentation and example plug-ins
([LICENSE](LICENSE), [NOTICE](NOTICE)). The data and assets below are not covered by it and keep their own licences.
Every runtime dependency listed here is under a licence compatible with redistribution alongside Apache-2.0 code (MIT,
BSD-2-Clause, BSD-3-Clause, ISC, PSF-2.0, Apache-2.0, 0BSD, Zlib, CC0-1.0).

How this inventory was made: licence identifiers were read from the metadata of the installed packages
(`*.dist-info/METADATA` for Python, `package.json` for npm) in a development installation. `pyproject.toml` gives
lower bounds only and `frontend/package.json` gives ranges, so another installation may resolve other versions: the
version column is the one that was inspected, not a pin. Check the metadata of your own installation before
redistributing.

## Backend: Python packages at run time

Declared in `pyproject.toml` (`dependencies`, and the `highs` extra for the exact reference methods), with the
packages they pull in.

| Package | Inspected version | Licence (package metadata) | Why it is installed |
|---|---|---|---|
| fastapi | 0.162.5 | MIT | declared dependency: HTTP API |
| uvicorn | 0.54.0 | BSD-3-Clause | declared dependency: server |
| pydantic | 2.14.3 | MIT | declared dependency: request validation |
| python-multipart | 0.0.33 | Apache-2.0 | declared dependency: file uploads |
| highspy | 1.16.0 | MIT | `highs` extra: the HiGHS solver used by the exact reference methods |
| starlette | 1.10.0 | BSD-3-Clause | required by fastapi |
| anyio | 4.16.0 | MIT | required by starlette |
| idna | 3.20 | BSD-3-Clause | required by anyio |
| pydantic-core | 2.50.4 | MIT | required by pydantic |
| annotated-types | 0.8.0 | MIT | required by pydantic |
| typing-inspection | 0.4.5 | MIT | required by pydantic |
| typing-extensions | 4.16.0 | PSF-2.0 | required by fastapi, pydantic |
| annotated-doc | 0.0.6 | MIT | required by fastapi |
| opentelemetry-api | 1.45.2 | Apache-2.0 | required by the inspected fastapi version |
| click | 8.5.1 | BSD-3-Clause | required by uvicorn |
| h11 | 0.16.0 | MIT | required by uvicorn |
| numpy | 2.5.4 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 | required by highspy |

HiGHS bundles third-party code under further licences; they are listed in the `THIRD_PARTY_NOTICES.md` file shipped
inside the `highspy` distribution. numpy's compound expression covers the components it vendors; its distribution
carries the individual texts.

The server also uses the Python standard library, including its `sqlite3` module for the credential store.

## Backend: development and test tools

Installed by the `dev` extra; not needed to run the application.

| Package | Inspected version | Licence (package metadata) |
|---|---|---|
| pytest | 9.2.0 | MIT |
| httpx | 0.28.1 | BSD-3-Clause |
| ruff | 0.15.0 (pinned) | MIT |

The build backend named in `pyproject.toml` is hatchling. It was not present in the inspected environment, so its
licence is not stated here.

## Frontend: packages in the built interface

Declared under `dependencies` in `frontend/package.json`; they are bundled into `frontend/dist`.

| Package | Inspected version | Licence (`package.json`) | Use |
|---|---|---|---|
| react | 19.3.1 | MIT | interface |
| react-dom | 19.3.1 | MIT | interface |
| scheduler | 0.28.0 | MIT | required by react-dom |
| leaflet | 1.9.4 | BSD-2-Clause | maps (script and stylesheet) |
| lucide-react | 1.69.0 | ISC | icons |

## Frontend: build and lint tools

Declared under `devDependencies`; used to build and check the interface, not shipped in it.

| Package | Inspected version | Licence (`package.json`) |
|---|---|---|
| vite | 8.3.6 | MIT |
| @vitejs/plugin-react | 6.2.1 | MIT |
| typescript | 6.0.3 | Apache-2.0 |
| eslint | 9.39.5 | MIT |
| @eslint/js | 9.39.5 | MIT |
| typescript-eslint | 8.72.2 | MIT |
| eslint-plugin-react-hooks | 7.1.1 | MIT |
| @types/react | 19.3.0 | MIT |
| @types/react-dom | 19.3.0 | MIT |
| @types/leaflet | 1.9.22 | MIT |

These tools install many further packages of their own. They are not inventoried here: none of them is part of the
built interface. `frontend/package-lock.json` lists them exactly.

## Fonts and images in the repository

| Asset | Where | Licence |
|---|---|---|
| Inter typeface (two WOFF2 subsets) | `frontend/public/fonts/inter/` | SIL Open Font License 1.1; © 2016 The Inter Project Authors. The licence text is next to the files (`OFL.txt`) |
| MOVE OpenLab logo and banner | `frontend/public/brand/`, `docs/assets/brand/` | the project's own marks, not third-party; not licensed under Apache-2.0 (its section 6 grants no trademark rights) |
| Screenshots | `docs/assets/screenshots/` | taken from the application; the maps in them show OpenStreetMap tiles, © OpenStreetMap contributors |

## Map data and services

| Source | Used for | Licence and attribution |
|---|---|---|
| OpenStreetMap data, through the Overpass API | road networks, travel times and distances, route geometry | © OpenStreetMap contributors, Open Database License (ODbL) 1.0 — https://www.openstreetmap.org/copyright. A road network or derived database shared publicly keeps the attribution and the licence |
| OpenStreetMap standard tile service | the default basemap, loaded by the browser | map tiles © OpenStreetMap contributors; use is governed by the tile usage policy — https://operations.osmfoundation.org/policies/tiles/ — which allows light use only. A public deployment configures its own tile service ([docs/MAPS.md](docs/MAPS.md#tiles)) |
| Nominatim (default place search) or a Photon service | place search | results derived from OpenStreetMap data, © OpenStreetMap contributors (ODbL); each service has its own usage policy ([docs/DATASETS.md](docs/DATASETS.md#external-services-and-their-rules)) |

No tile and no place-search result is stored in the repository.

## Data shipped in the repository

| Data | Where | Origin | Licence |
|---|---|---|---|
| Demonstration bundle: scenarios, road travel times and distances, replay geometry | `src/move_openlab/demo/bundle/` | derived from OpenStreetMap data | ODbL 1.0, © OpenStreetMap contributors |
| Demonstration bundle: participants | same | resampled from the open data of the French carpooling proof registry (Registre de Preuve de Covoiturage), published on data.gouv.fr | Licence Ouverte / Open Licence (Etalab). Attribution names the producer and the date of the last update and must not suggest endorsement; records are anonymised by the publisher, and re-identification is forbidden |
| Sample bundle | `src/move_openlab/samples/montbeliard/` | exported from the demonstration: same two sources | ODbL 1.0 and Licence Ouverte / Open Licence (Etalab), as above |
| Sample trip dataset | `examples/scenario-import/montbeliard-synthetic-trips.csv`, `src/move_openlab/samples/trips/` | generated by `scripts/build_sample_trips.py`; no observed or personal data | Creative Commons Zero 1.0 (CC0-1.0) — https://creativecommons.org/publicdomain/zero/1.0/ |
| Synthetic assignment benchmark | generated at run time from seeds | this project | no third-party data |

Provenance of the demonstration in detail: [src/move_openlab/demo/README.md](src/move_openlab/demo/README.md).

## Reference values in the vehicle presets

The presets in `src/move_openlab/mobility/presets/` hold a few numerical values read from public reports, each cited
in its `source` field and in [docs/DATASETS.md](docs/DATASETS.md#vehicle-profiles-and-emission-presets):

| Source | Values |
|---|---|
| European Commission, COM(2024) 122 final (real-world CO₂ emissions and fuel consumption of cars and vans) | average real-world fuel consumption of petrol and diesel cars |
| UK Department for Energy Security and Net Zero, Greenhouse gas reporting: conversion factors 2026 | fuel emission factors |
| European Environment Agency, indicator ENER038 | greenhouse gas emission intensity of electricity generation |

The reuse terms of these three publications are not recorded in this repository and are not stated here; consult
each publisher. Only individual figures are quoted, with their source.

## Open-data connector

The connector in `src/move_openlab/integrations/rpc.py` downloads releases of the French carpooling proof registry
at a user's request. Data obtained through it is under the Licence Ouverte / Open Licence (Etalab) and is stored in
the installation's data directory, not in this repository.

## Keeping this file current

When a dependency is added or changed: read its licence from the installed metadata, add or update its row, and say
so when a licence cannot be determined instead of guessing. New runtime dependencies must be compatible with
redistribution alongside Apache-2.0 code ([CONTRIBUTING.md](CONTRIBUTING.md)).
