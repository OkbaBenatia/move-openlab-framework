"""OpenStreetMap road-network acquisition (Overpass API) and graph construction.

The graph is directed, weighted by free-flow travel time from a documented speed profile (``maxspeed`` when it is a
plain km/h value, otherwise the default speed of the ``highway`` class), restricted to its largest strongly connected
component so that every routed pair has a path. The network id is the SHA-256 of the built graph, so identical inputs
give identical ids.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import math
import time
import urllib.parse
import urllib.request
from pathlib import Path

from .. import __version__
from ..hashing import canonical, sha256

BUILDER = "move_openlab.geo.osm/1.0.0"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
USER_AGENT = f"move-openlab/{__version__} (+https://github.com/OkbaBenatia/move-openlab-framework)"
LICENCE = dict(id="ODbL-1.0", name="Open Database License 1.0", url="https://opendatacommons.org/licenses/odbl/1-0/",
               attribution="© OpenStreetMap contributors", copyright_url="https://www.openstreetmap.org/copyright")
# free-flow speed profile (km/h) by highway class — documented, overridable per network build
SPEED_KMH = {"motorway": 110, "trunk": 90, "primary": 70, "secondary": 60, "tertiary": 50, "unclassified": 40,
             "residential": 30, "living_street": 10, "motorway_link": 60, "trunk_link": 50, "primary_link": 40,
             "secondary_link": 40, "tertiary_link": 30}
MAX_OVERPASS_BYTES = 256 * 1024 * 1024       # refuse larger responses (memory bound while building the graph)
MAX_BBOX_DEG2 = 0.25                       # refuse areas larger than ~0.5° x 0.5° (fair use of the public Overpass API)


def validate_bbox(bbox) -> tuple[float, float, float, float]:
    """(south, west, north, east) in WGS-84 degrees."""
    try:
        s, w, n, e = (float(x) for x in bbox)
    except (TypeError, ValueError):
        raise ValueError("bbox must be [south, west, north, east]") from None
    if not (-90 <= s < n <= 90 and -180 <= w < e <= 180):
        raise ValueError("invalid bbox")
    if (n - s) * (e - w) > MAX_BBOX_DEG2:
        raise ValueError(f"area too large for one Overpass query (> {MAX_BBOX_DEG2} square degrees)")
    return s, w, n, e


def overpass_query(bbox) -> str:
    s, w, n, e = validate_bbox(bbox)
    classes = "|".join(sorted(SPEED_KMH))
    return (f'[out:json][timeout:180];way["highway"~"^({classes})$"]["access"!~"^(no|private)$"]'
            f'["motor_vehicle"!~"^(no|private)$"]({s},{w},{n},{e});(._;>;);out body;')


def fetch_overpass(bbox, url: str = OVERPASS_URL, timeout: float = 240.0) -> bytes:
    """One Overpass request (identifying User-Agent, as the usage policy requires). Raises on HTTP errors; callers
    should not retry immediately after a 429/504 (the policy asks for a pause)."""
    data = urllib.parse.urlencode({"data": overpass_query(bbox)}).encode()
    req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read(MAX_OVERPASS_BYTES + 1)
    if len(raw) > MAX_OVERPASS_BYTES:
        raise ValueError(f"Overpass response larger than {MAX_OVERPASS_BYTES // 2**20} MB; choose a smaller area")
    return raw


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _speed(tags: dict) -> float:
    ms = str(tags.get("maxspeed", "")).strip()
    if ms.isdigit() and 5 <= int(ms) <= 130:
        return float(ms)
    return float(SPEED_KMH.get(tags.get("highway", ""), 30))


def _oneway(tags: dict) -> int:
    ow = str(tags.get("oneway", "")).lower()
    if ow in ("yes", "true", "1") or tags.get("junction") in ("roundabout", "circular") or tags.get("highway") == "motorway":
        return 1
    if ow == "-1":
        return -1
    return 0


def _largest_scc(n: int, adj: list[list[int]]) -> list[int]:
    """Kosaraju (iterative). Returns the node indices of the largest strongly connected component."""
    order, seen = [], [False] * n
    for s in range(n):
        if seen[s]:
            continue
        stack = [(s, 0)]
        seen[s] = True
        while stack:
            v, i = stack[-1]
            if i < len(adj[v]):
                stack[-1] = (v, i + 1)
                w = adj[v][i]
                if not seen[w]:
                    seen[w] = True
                    stack.append((w, 0))
            else:
                stack.pop()
                order.append(v)
    radj: list[list[int]] = [[] for _ in range(n)]
    for v in range(n):
        for w in adj[v]:
            radj[w].append(v)
    comp, best, cid = [-1] * n, [], 0
    for s in reversed(order):
        if comp[s] != -1:
            continue
        members, stack = [], [s]
        comp[s] = cid
        while stack:
            v = stack.pop()
            members.append(v)
            for w in radj[v]:
                if comp[w] == -1:
                    comp[w] = cid
                    stack.append(w)
        if len(members) > len(best):
            best = members
        cid += 1
    return sorted(best)


def build_network(raw: bytes) -> dict:
    """Build the routable graph from an Overpass JSON response. Returns a JSON-serialisable network."""
    doc = json.loads(raw)
    nodes = {el["id"]: (el["lat"], el["lon"]) for el in doc.get("elements", []) if el.get("type") == "node"}
    edges: dict[tuple[int, int], tuple[float, float]] = {}
    for el in doc.get("elements", []):
        if el.get("type") != "way" or len(el.get("nodes", [])) < 2:
            continue
        tags = el.get("tags", {})
        kmh, ow = _speed(tags), _oneway(tags)
        seq = [x for x in el["nodes"] if x in nodes]
        for a, b in zip(seq, seq[1:]):
            if a == b:
                continue
            length = haversine_m(*nodes[a], *nodes[b])
            t = length / (kmh / 3.6)
            for u, v in ((a, b), (b, a)) if ow == 0 else (((a, b),) if ow == 1 else ((b, a),)):
                if (u, v) not in edges or edges[(u, v)][1] > t:
                    edges[(u, v)] = (length, t)
    ids = sorted({u for u, _ in edges} | {v for _, v in edges})
    index = {x: i for i, x in enumerate(ids)}
    adj: list[list[int]] = [[] for _ in ids]
    for u, v in edges:
        adj[index[u]].append(index[v])
    keep = _largest_scc(len(ids), adj)
    if not keep:
        raise ValueError("the OSM response contains no routable road")
    keep_ids = [ids[i] for i in keep]
    knew = {x: i for i, x in enumerate(keep_ids)}
    out_edges = sorted((knew[u], knew[v], round(length, 2), round(t, 3)) for (u, v), (length, t) in edges.items()
                       if u in knew and v in knew)
    net = dict(builder=BUILDER, speed_profile_kmh=SPEED_KMH,
               osm_node_ids=keep_ids, lat=[round(nodes[x][0], 7) for x in keep_ids],
               lon=[round(nodes[x][1], 7) for x in keep_ids], edges=[list(e) for e in out_edges])
    net["network_id"] = sha256(net)[:24]
    return net


class NetworkStore:
    """Content-addressed road networks under ``<data>/networks/<network_id>/`` (network, provenance, raw response)."""

    def __init__(self, data_dir: Path):
        self.root = Path(data_dir) / "networks"

    def save(self, raw: bytes, area: dict, source_url: str = OVERPASS_URL) -> dict:
        net = build_network(raw)
        doc = json.loads(raw)
        d = self.root / net["network_id"]
        d.mkdir(parents=True, exist_ok=True)
        (d / "network.json").write_bytes(canonical(net))
        with gzip.open(d / "overpass_raw.json.gz", "wb") as fh:
            fh.write(raw)
        prov = dict(network_id=net["network_id"], area=area, source=dict(service="Overpass API", url=source_url,
                    query=overpass_query(area["bbox"]), retrieved_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    osm_timestamp=(doc.get("osm3s") or {}).get("timestamp_osm_base"),
                    raw_sha256=hashlib.sha256(raw).hexdigest(), raw_bytes=len(raw)),
                    licence=LICENCE, builder=BUILDER, nodes=len(net["lat"]), edges=len(net["edges"]),
                    network_sha256=hashlib.sha256(canonical(net)).hexdigest())
        (d / "provenance.json").write_text(json.dumps(prov, indent=1))
        return prov

    def list(self) -> list[dict]:
        out = []
        for f in sorted(self.root.glob("*/provenance.json")):
            try:
                out.append(json.loads(f.read_text()))
            except (OSError, ValueError):
                continue
        return out

    def provenance(self, network_id: str) -> dict:
        f = self._dir(network_id) / "provenance.json"
        if not f.exists():
            raise KeyError(f"network {network_id} not found")
        return json.loads(f.read_text())

    def load(self, network_id: str):
        from .network import RoadNetwork
        f = self._dir(network_id) / "network.json"
        if not f.exists():
            raise KeyError(f"network {network_id} not found")
        net = json.loads(f.read_bytes())
        body = {k: v for k, v in net.items() if k != "network_id"}
        if sha256(body)[:24] != network_id:
            raise ValueError(f"network {network_id} fails its content hash")
        return RoadNetwork(net)

    def _dir(self, network_id: str) -> Path:
        if not network_id or not all(c in "0123456789abcdef" for c in network_id) or len(network_id) != 24:
            raise KeyError("invalid network id")
        return self.root / network_id
