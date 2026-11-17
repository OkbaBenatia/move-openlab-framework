# Road network of the demonstration

The original road network the demonstration's scenarios were built on (network id `2858421165cd47486a509d26`), shipped
so that an installation can edit the demonstration's participants without downloading anything. When the
demonstration is installed, these files are copied **unchanged** into the installation's network store after every
digest has been checked against the frozen bundle (`../bundle/manifest.json` › `networks`); they are never rebuilt or
replaced by a new download (OpenStreetMap data change, so a new download of the same area gives another network).

| File | Content | Check |
|---|---|---|
| `network.json.gz` | the built network (58 710 nodes, 108 664 edges), gzip of the stored `network.json` | SHA-256 of `network.json` = `99fe4d80a6c36f926df040f0a7b1eb65c4b976f4b2a31c122ff1b53a301f96b7` (`network_sha256`); its content hash gives the network id |
| `overpass_raw.json.gz` | the raw Overpass API response it was built from | SHA-256 of the response = `88bc1bb5c7ed214f6dd1e16532451f15239edb2f7ebb107a7ad102fd9fede722` (`raw_sha256`) |
| `provenance.json` | service, Overpass query (box 47.42, 6.66 – 47.60, 6.96, profile `car`), retrieval time 2026-11-09T14:30:01Z, OSM data timestamp 2026-11-09T14:28:31Z, builder `move_openlab.geo.osm/1.1.0`, licence | the same digests |

`tests/test_demo_network.py` checks every digest and that the builder makes exactly this network from the raw response.

## Licence and attribution

© OpenStreetMap contributors (https://www.openstreetmap.org/copyright). Both files are OpenStreetMap data, available
under the Open Database License 1.0 (ODbL, https://opendatacommons.org/licenses/odbl/1-0/): the raw response is an
extract of the OpenStreetMap database and the built network is a derivative database of it. They are redistributed
under the same licence, with this notice; anything built from them and shared keeps the attribution and the licence.
They are not covered by the Apache License of the framework.
