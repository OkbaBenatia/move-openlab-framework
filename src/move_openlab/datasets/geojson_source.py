"""GeoJSON trip files (RFC 7946).

Accepted: a ``FeatureCollection`` whose features each describe one trip:

* ``LineString`` — the first position is the origin, the last the destination (intermediate positions are ignored);
* ``MultiPoint`` with exactly two positions — origin, destination.

Positions are ``[longitude, latitude]`` in WGS-84, as RFC 7946 requires. A legacy ``crs`` member is accepted only if
it names WGS-84 longitude/latitude (CRS84 / EPSG:4326); any other reference system is refused rather than guessed.
``Point`` features are refused: an origin and a destination must belong to the same feature. The departure time (and
optionally the date and role) come from feature properties chosen in the mapping.
"""
from __future__ import annotations

import json

from .tabular import DATE_FORMATS, TIME_FORMATS, Collector, DatasetError, detect_time_format

MAX_FEATURES = 200_000
WGS84 = {"urn:ogc:def:crs:ogc:1.3:crs84", "urn:ogc:def:crs:epsg::4326", "epsg:4326", "crs84"}
REQUIRED = ("departure",)
OPTIONAL = ("date", "role")


def _load(raw: bytes) -> dict:
    if raw.count(b'"Feature"') > MAX_FEATURES:
        raise DatasetError(f"too many features (at most {MAX_FEATURES})")
    try:
        doc = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise DatasetError("not valid JSON (UTF-8 expected) or nested too deeply") from None
    if not isinstance(doc, dict) or doc.get("type") != "FeatureCollection" or not isinstance(doc.get("features"), list):
        raise DatasetError("expected a GeoJSON FeatureCollection")
    crs = doc.get("crs")
    if crs is not None:
        props = crs.get("properties") if isinstance(crs, dict) else None
        name = str(props.get("name", "") if isinstance(props, dict) else "").strip().casefold()
        if name not in WGS84:
            raise DatasetError(f"coordinate reference system {name or '?'} is not supported; reproject to WGS-84 "
                               "longitude/latitude (RFC 7946)")
    if len(doc["features"]) > MAX_FEATURES:
        raise DatasetError(f"too many features ({len(doc['features'])}; at most {MAX_FEATURES})")
    if not doc["features"]:
        raise DatasetError("the FeatureCollection has no feature")
    for i, f in enumerate(doc["features"], start=1):           # RFC 7946 structure: refuse, never guess
        if not isinstance(f, dict) or f.get("type") != "Feature":
            raise DatasetError(f"feature #{i} is not a GeoJSON Feature object")
        if f.get("properties") is not None and not isinstance(f["properties"], dict):
            raise DatasetError(f"feature #{i}: properties must be an object or null")
        if f.get("geometry") is not None and not isinstance(f["geometry"], dict):
            raise DatasetError(f"feature #{i}: geometry must be an object or null")
        if f.get("properties") is None:
            f["properties"] = {}
    return doc


def _ends(geom) -> tuple[list, list]:
    if not isinstance(geom, dict):
        raise ValueError("feature without geometry")
    t, c = geom.get("type"), geom.get("coordinates")
    if t == "LineString" and isinstance(c, list) and len(c) >= 2:
        return c[0], c[-1]
    if t == "MultiPoint" and isinstance(c, list) and len(c) == 2:
        return c[0], c[1]
    if t == "Point":
        raise ValueError("Point geometry (origin and destination must be in one LineString or MultiPoint)")
    raise ValueError(f"unsupported geometry {t}")


def inspect(raw: bytes) -> dict:
    doc = _load(raw)
    feats = doc["features"]
    kinds: dict[str, int] = {}
    props: dict[str, int] = {}
    for f in feats:
        g = (f or {}).get("geometry") or {}
        kinds[str(g.get("type"))] = kinds.get(str(g.get("type")), 0) + 1
        for k in ((f or {}).get("properties") or {}):
            props[k] = props.get(k, 0) + 1
    preview = [dict(geometry=((f or {}).get("geometry") or {}).get("type"), properties=(f or {}).get("properties"))
               for f in feats[:5]]
    return dict(features=len(feats), geometry_types=kinds, properties=sorted(props, key=lambda k: -props[k])[:100],
                preview=preview, required=list(REQUIRED), optional=list(OPTIONAL), time_formats=list(TIME_FORMATS),
                date_formats=list(DATE_FORMATS),
                suggested_mapping={f: p for f, p in (("departure", next((p for p in props if p.casefold() in (
                    "departure", "departure_time", "start_time", "start", "time", "datetime")), None)),
                    ("date", next((p for p in props if p.casefold() in ("date", "day")), None)),
                    ("role", next((p for p in props if p.casefold() in ("role", "type")), None))) if p})


def parse(raw: bytes, mapping: dict, time_format: str = "auto", date_format: str = "YYYY-MM-DD") -> tuple[Collector, dict]:
    doc = _load(raw)
    if not mapping.get("departure"):
        raise DatasetError("map the departure property")
    if time_format not in TIME_FORMATS or date_format not in DATE_FORMATS:
        raise DatasetError("unknown time or date format")
    feats = doc["features"]
    dep = mapping["departure"]
    if time_format == "auto":
        time_format = detect_time_format([((f or {}).get("properties") or {}).get(dep, "") for f in feats])
    col = Collector()
    for i, f in enumerate(feats, start=1):
        p = (f or {}).get("properties") or {}
        try:
            o, d = _ends((f or {}).get("geometry"))
            if not all(isinstance(x, list) and len(x) >= 2 for x in (o, d)):
                raise ValueError("position must be [longitude, latitude]")
        except ValueError as e:
            col.read += 1
            col.reject(i, str(e))
            continue
        col.add(i, o[1], o[0], d[1], d[0], p.get(dep, ""), time_format,
                p.get(mapping["date"]) if mapping.get("date") else None, date_format,
                p.get(mapping["role"]) if mapping.get("role") else None, has_role=bool(mapping.get("role")))
    return col, dict(format="geojson", mapping=mapping, time_format=time_format,
                     date_format=date_format if mapping.get("date") else None)
