# Geographic areas and trip datasets

MOVE OpenLab works for any area covered by OpenStreetMap. An area is defined in the web interface, not in code;
trip data can come from public open data, from the researcher's own files, or be generated synthetically.

## Areas and road networks

An **area** is a name, a bounding box and a road-network profile, saved in the researcher's workspace
(*Scenarios & maps → Areas*). It is created by:

- **place search** — a city, locality or region (Nominatim, see the usage rules below); very large results start
  from a 8 × 8 km box around the place;
- **pick on map** — a 5 × 5 km box centred on a click;
- **draw box** — two clicks for opposite corners;

and adjusted by dragging the corner handles (resize), the centre handle (move) or by editing the coordinates.

| Profile | Roads | Speeds | Largest box |
|---|---|---|---|
| `car` | all public roads open to cars | `maxspeed`, else the class default | 0.25 deg² (≈ 2 000 km² at 45°N) |
| `car-main-roads` | motorway to tertiary (and links) | as `car` | 1 deg² |
| `car-peak` | as `car` | `car` speeds × 0.7 (peak-hour sensitivity) | 0.25 deg² |

Downloading the network sends **one** Overpass query. A network already stored for the same box and profile is
reused without any request. Networks are shared, content-addressed installation resources carrying their provenance
(query, OSM data timestamp, raw-response SHA-256) but no private area name. Coverage, node and edge counts and road
length are shown on the map; *Measure route* gives the free-flow distance and travel time between two points.

Errors are explicit: boxes over the profile limit are refused before any request; Overpass rate limits (HTTP 429),
time-outs and areas without a routable road return an actionable message.

## Datasets

All datasets are normalised to trips `{date, departure time, origin, destination, role}`; the role (driver or rider)
is optional. Every rejected row is counted under its reason with examples, and saving a dataset with rejected rows
requires an explicit confirmation. A dataset can be checked against an area: trips with both ends inside it are
counted, and a dataset with none is refused.

### RPC open data (France only)

The national carpooling proof registry publishes one file per month on data.gouv.fr (Licence Ouverte / Open
Licence, Etalab). *Datasets → RPC open carpooling data* lists the releases; importing one for an area streams the
file once, keeps the trips that start and end inside the area, drops identifiers and records the release, size,
SHA-256, cleaning rules and rejection counts. The area must lie in France (metropolitan France, Corsica or an overseas
department); other areas are refused, because the registry has no data there. Imported subsets are shared,
read-only installation resources.

### CSV files

One trip per row. The encoding (UTF-8, UTF-8 with BOM, Windows-1252, else Latin-1) and the delimiter (`,` `;` tab
`|`) are detected and shown; every field must then be mapped to a column explicitly. Column-name suggestions cover
common English, French and Spanish names.

| Field | Required | Accepted values |
|---|---|---|
| origin latitude / longitude | yes | decimal degrees; a decimal comma is accepted |
| destination latitude / longitude | yes | idem |
| departure | yes | ISO 8601 date-time, time of day `HH:MM[:SS]`, or Unix seconds (read as UTC); one format per file |
| date | no | `YYYY-MM-DD`, `DD/MM/YYYY` or `MM/DD/YYYY` (chosen explicitly) |
| role | no | driver / conducteur / conductor, rider / passenger / passager / pasajero |

Rows are rejected for: missing or non-numeric coordinates, latitude outside ±90 (often swapped columns), longitude
outside ±180, a (0, 0) point, identical origin and destination, an invalid time or date, an unknown role, or a wrong
number of fields.

### GeoJSON files

A `FeatureCollection` (RFC 7946, WGS-84 longitude/latitude). Each feature is one trip:

- `LineString` — first position = origin, last position = destination;
- `MultiPoint` with exactly two positions — origin, destination.

`Point` features are rejected (origin and destination must be in one feature). A legacy `crs` member other than
CRS84 / EPSG:4326 is refused rather than reprojected. Departure, date and role come from feature properties chosen in
the mapping.

### Synthetic demand

*Generate → Synthetic demand* draws origins and destinations among the network's nodes, with a minimum trip length,
departures in a time window and a seed. Same network, parameters and seed give the same scenario.

### Scenarios from a dataset

*Generate → Resample a trip dataset* draws drivers and riders (with replacement, seeded) from the dataset's trips
inside the current area and time window; when roles are present, drivers come from driver or unlabelled trips and
riders from rider or unlabelled trips. Each agent takes one record's origin and destination. RPC departure times are
re-drawn inside the publisher's 10-minute rounding. The scenario records the dataset key, provider, licence,
attribution and source hash.

## Limits and isolation

| Resource | Limit |
|---|---|
| Upload | 25 MB per file (request bodies are refused above the limit before being read); at most 2 parsed at once |
| CSV | 200 000 rows, 200 columns, 4 096 characters per field |
| GeoJSON | 200 000 features |
| Workspace | 100 areas, 50 datasets |
| Downloads | per user and day: 10 road networks, 3 RPC ingestions, 200 place searches (cache hits are free); one download at a time per service |

Uploaded files are parsed in memory and never stored; only the validated, normalised trips and a report (file name,
size, SHA-256, mapping, rejections) are kept, in the uploader's workspace. Other researchers cannot list or read them.

## External services and their rules

| Service | Rules followed |
|---|---|
| Nominatim (place search) | explicit searches only (no auto-complete); at most one request per second for the whole installation; results cached 30 days; identifying User-Agent; attribution shown; switch off with `MOVE_OPENLAB_GEOCODER_URL=off` |
| Overpass API (road networks) | one query per download; one download at a time; bounded area and response size (256 MB); identifying User-Agent |
| OpenStreetMap tiles | light interactive use with attribution; set `MOVE_OPENLAB_TILE_URL` for any heavier or public deployment |
| data.gouv.fr (RPC) | HTTPS data.gouv.fr hosts only, checked on every redirect; one ingestion at a time |

OpenStreetMap data is © OpenStreetMap contributors under the ODbL; a road network or derived database shared
publicly must keep the attribution and the licence.

## Writing a dataset provider

A provider turns a file format or a service into normalised trips without touching the experimentation engine.
Subclass `move_openlab.datasets.DatasetProvider` in your own package and register it under the
`move_openlab.dataset_providers` entry-point group:

```python
from move_openlab.datasets import DatasetProvider
from move_openlab.datasets.tabular import Collector, DatasetError


class MyFormat(DatasetProvider):
    id, label = "my-format", "My trip format"
    licence = "as declared by the uploader"

    def inspect(self, raw: bytes, **options) -> dict:
        # describe the file: columns or properties, a preview, a suggested mapping
        ...

    def parse(self, raw: bytes, mapping: dict, **options) -> tuple[Collector, dict]:
        col = Collector()
        for i, rec in enumerate(read_records(raw), start=1):
            col.add(i, rec["olat"], rec["olon"], rec["dlat"], rec["dlon"], rec["time"], "iso")
        return col, dict(format="my-format", mapping=mapping)
```

```toml
[project.entry-points."move_openlab.dataset_providers"]
my-format = "my_package.provider:MyFormat"
```

Rules: raise `DatasetError` with an actionable message for files that cannot be interpreted; reject rows through
`Collector` (never drop them silently); never keep personal identifiers; document the licence and attribution of
any public data. `GET /api/integrations` lists installed providers; the upload routes
(`/api/datasets/<id>/inspect` and `/api/datasets/<id>/import`) accept every provider of kind `upload`.
