"""Replay geometry: road polylines of the legs an instance can use, so routes can be replayed without the network.

A ride-matching plan only ever drives these legs (OSM node ids)::

    driver origin -> driver destination            (unmatched driver)
    driver origin -> rider origin                  (to pickup, for every compatible pair)
    rider origin  -> rider destination             (ride)
    rider destination -> driver destination        (to destination, for every compatible pair)

The geometry is derived from OpenStreetMap data (ODbL): it carries the network id and attribution. It is stored per
instance under ``<data>/geometry/<instance_hash>.json``, travels in bundles (format 2) and is used by route playback
when the road network itself is not installed. It never affects validation or comparison.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

GEOMETRY_SCHEMA = "move-openlab-replay-geometry/1"
MAX_LEGS = 20000
MAX_POINTS = 400000


def _key(a: int, b: int) -> str:
    return f"{a}>{b}"


def legs_needed(inst: dict) -> set[tuple[int, int]]:
    d = {a["id"]: a for a in inst["drivers"]}
    r = {a["id"]: a for a in inst["riders"]}
    out = {(a["origin_node"], a["destination_node"]) for a in inst["drivers"] + inst["riders"]}
    for p in inst["pairs"]:
        out.add((d[p["driver"]]["origin_node"], r[p["rider"]]["origin_node"]))
        out.add((r[p["rider"]]["destination_node"], d[p["driver"]]["destination_node"]))
    return out


def build(inst: dict, net) -> dict:
    """Polylines (5 decimals, about 1 m) of every leg the instance can use, on the given road network."""
    index = {osm: i for i, osm in enumerate(net.osm_node_ids)}
    legs = {}
    for a, b in sorted(legs_needed(inst)):
        if a == b or a not in index or b not in index:
            continue
        try:
            coords = net.route(index[a], index[b])["coords"]
        except ValueError:
            continue
        legs[_key(a, b)] = [[round(p[0], 5), round(p[1], 5)] for p in coords]
    nw = inst.get("network") or {}
    return dict(schema=GEOMETRY_SCHEMA, instance_hash=inst["instance_hash"], network_id=nw.get("network_id"),
                attribution=nw.get("attribution"), licence=nw.get("licence"), legs=legs)


def check(doc: dict, inst: dict) -> list[str]:
    """Structural checks of an untrusted geometry document for the given instance."""
    if not isinstance(doc, dict) or doc.get("schema") != GEOMETRY_SCHEMA:
        return ["unknown geometry schema"]
    if doc.get("instance_hash") != inst["instance_hash"]:
        return ["geometry belongs to another instance"]
    legs = doc.get("legs")
    if not isinstance(legs, dict) or len(legs) > MAX_LEGS:
        return ["invalid or oversized legs"]
    allowed = {_key(a, b) for a, b in legs_needed(inst)}
    points = 0
    for k, v in legs.items():
        if k not in allowed:
            return [f"leg {k[:40]} is not used by the instance"]
        if not isinstance(v, list) or len(v) < 2:
            return [f"leg {k[:40]} is not a polyline"]
        for p in v:
            if not (isinstance(p, list) and len(p) == 2 and all(isinstance(x, (int, float)) and not isinstance(x, bool)
                                                                 for x in p) and -90 <= p[0] <= 90 and -180 <= p[1] <= 180):
                return [f"leg {k[:40]} has an invalid point"]
        points += len(v)
    if points > MAX_POINTS:
        return ["geometry too large"]
    return []


class GeometryStore:
    def __init__(self, data_dir: Path):
        self.root = Path(data_dir) / "geometry"

    def _file(self, h: str) -> Path:
        if not h or len(h) != 64 or not all(c in "0123456789abcdef" for c in h):
            raise KeyError("invalid instance hash")
        return self.root / f"{h}.json"

    def get(self, h: str) -> dict | None:
        try:
            f = self._file(h)
        except KeyError:
            return None
        return json.loads(f.read_text()) if f.exists() else None

    def put(self, doc: dict) -> None:
        f = self._file(doc["instance_hash"])
        if f.exists():
            return
        f.parent.mkdir(parents=True, exist_ok=True)
        tmp = f.with_suffix(f".tmp{os.getpid()}")
        tmp.write_text(json.dumps(doc, sort_keys=True, separators=(",", ":")))
        os.replace(tmp, f)
