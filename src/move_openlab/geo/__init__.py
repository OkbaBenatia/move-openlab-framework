"""Geographic layer: OpenStreetMap road networks, routing, mobility scenarios and route playback.

Data provenance and licences
* Road networks are built from OpenStreetMap data obtained through the Overpass API. OpenStreetMap data is
  © OpenStreetMap contributors and available under the Open Database License (ODbL 1.0); derived road graphs that are
  shared publicly must remain under the ODbL and carry the attribution. Networks are stored in the installation's data
  directory with their full provenance (query, bounding box, retrieval time, OSM data timestamp, SHA-256 of the raw
  response); no OSM data is shipped with MOVE OpenLab.
* Areas are runtime configuration (name + bounding box); the framework contains no built-in area.
"""
