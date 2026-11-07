"""OpenStreetMap road-network acquisition (Overpass API) and graph construction.

The graph is directed, weighted by free-flow travel time from a documented speed profile (``maxspeed`` when it is a
plain km/h value, otherwise the default speed of the ``highway`` class, times the profile's speed factor), restricted
to its largest strongly connected component so that every routed pair has a path. The network id is the SHA-256 of the
built graph (which includes the profile), so identical inputs give identical ids.

Profiles (:data:`PROFILES`) select the road classes, a speed factor and the largest area one request may cover.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import math
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .. import __version__
from ..hashing import canonical, sha256

BUILDER = "move_openlab.geo.osm/1.1.0"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
USER_AGENT = f"move-openlab/{__version__} (+https://github.com/OkbaBenatia/move-openlab-framework)"
LICENCE = dict(id="ODbL-1.0", name="Open Database License 1.0", url="https://opendatacommons.org/licenses/odbl/1-0/",
               attribution="© OpenStreetMap contributors", copyright_url="https://www.openstreetmap.org/copyright")
# free-flow speed profile (km/h) by highway class — documented, overridable per network build
SPEED_KMH = {"motorway": 110, "trunk": 90, "primary": 70, "secondary": 60, "tertiary": 50, "unclassified": 40,
             "residential": 30, "living_street": 10, "motorway_link": 60, "trunk_link": 50, "primary_link": 40,
             "secondary_link": 40, "tertiary_link": 30}
MAX_OVERPASS_BYTES = 256 * 1024 * 1024       # refuse larger responses (memory bound while building the graph)
MAIN_CLASSES = ("motorway", "trunk", "primary", "secondary", "tertiary", "motorway_link", "trunk_link",
                "primary_link", "secondary_link", "tertiary_link")
PROFILES = {
    "car": dict(label="Car, all public roads", classes=tuple(SPEED_KMH), speed_factor=1.0, max_bbox_deg2=0.25),
    "car-main-roads": dict(label="Car, main roads only (larger areas)", classes=MAIN_CLASSES, speed_factor=1.0,
                           max_bbox_deg2=1.0),
    "car-peak": dict(label="Car, all roads, speeds × 0.7 (peak-hour sensitivity)", classes=tuple(SPEED_KMH),
                     speed_factor=0.7, max_bbox_deg2=0.25),
}
DEFAULT_PROFILE = "car"


class SourceUnavailable(RuntimeError):
    """The external service refused or failed; the message is safe to show to the user."""


def profile(name: str | None) -> dict:
    p = PROFILES.get(name or DEFAULT_PROFILE)
    if p is None:
        raise ValueError(f"unknown road-network profile {name!r}; available: {', '.join(PROFILES)}")
    return p


def bbox_km2(bbox) -> float:
    s, w, n, e = bbox
    return haversine_m(s, w, n, w) * haversine_m((s + n) / 2, w, (s + n) / 2, e) / 1e6


def validate_bbox(bbox, profile_name: str | None = None) -> tuple[float, float, float, float]:
    """(south, west, north, east) in WGS-84 degrees, within the profile's area limit."""
    try:
        s, w, n, e = (float(x) for x in bbox)
    except (TypeError, ValueError):
        raise ValueError("bbox must be [south, west, north, east]") from None
    if any(x != x for x in (s, w, n, e)) or not (-85 <= s < n <= 85 and -180 <= w < e <= 180):
        raise ValueError("invalid bounding box: south < north within ±85°, west < east within ±180°")
    if (n - s) < 0.002 or (e - w) < 0.002:
        raise ValueError("bounding box too small (at least about 200 m on each side)")
    lim = profile(profile_name)["max_bbox_deg2"]
    if (n - s) * (e - w) > lim:
        raise ValueError(f"area too large for profile {profile_name or DEFAULT_PROFILE}: {bbox_km2((s, w, n, e)):.0f} km² "
                         f"({(n - s) * (e - w):.3f} deg², limit {lim} deg²); draw a smaller box"
                         + (" or use the main-roads profile" if lim < PROFILES["car-main-roads"]["max_bbox_deg2"] else ""))
    return s, w, n, e


def overpass_query(bbox, profile_name: str | None = None) -> str:
    s, w, n, e = validate_bbox(bbox, profile_name)
    classes = "|".join(sorted(profile(profile_name)["classes"]))
    return (f'[out:json][timeout:180];way["highway"~"^({classes})$"]["access"!~"^(no|private)$"]'
            f'["motor_vehicle"!~"^(no|private)$"]({s},{w},{n},{e});(._;>;);out body;')


def fetch_overpass(bbox, url: str = OVERPASS_URL, timeout: float = 240.0, profile_name: str | None = None) -> bytes:
    """One Overpass request (identifying User-Agent, as the usage policy requires). Service errors become
    :class:`SourceUnavailable` with an actionable message; callers must not retry immediately (fair use)."""
    data = urllib.parse.urlencode({"data": overpass_query(bbox, profile_name)}).encode()
    req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read(MAX_OVERPASS_BYTES + 1)
    except urllib.error.HTTPError as e:
        if e.code == 429:
            raise SourceUnavailable("Overpass API is rate-limiting requests (HTTP 429); try again in a few minutes") from None
        if e.code in (502, 503, 504):
            raise SourceUnavailable(f"Overpass API timed out or is overloaded (HTTP {e.code}); try later, a smaller "
                                    "area or the main-roads profile") from None
        raise SourceUnavailable(f"Overpass API refused the request (HTTP {e.code})") from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise SourceUnavailable(f"Overpass API unreachable ({type(e).__name__}); check the network or the configured URL") from None
    if len(raw) > MAX_OVERPASS_BYTES:
        raise ValueError(f"Overpass response larger than {MAX_OVERPASS_BYTES // 2**20} MB; choose a smaller area")
    if b'"remark"' in raw[:4096] and b"runtime error" in raw[:4096]:
        raise SourceUnavailable("Overpass API stopped the query (area too dense for its time limit); draw a smaller box "
                                "or use the main-roads profile")
    return raw


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _speed(tags: dict, factor: float = 1.0) -> float:
    ms = str(tags.get("maxspeed", "")).strip()
    base = float(ms) if ms.isdigit() and 5 <= int(ms) <= 130 else float(SPEED_KMH.get(tags.get("highway", ""), 30))
    return base * factor


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


def _parse(raw: bytes) -> dict:
    try:
        doc = json.loads(raw)
    except ValueError:
        raise SourceUnavailable("the Overpass response is not valid JSON") from None
    if not isinstance(doc, dict):
        raise SourceUnavailable("unexpected Overpass response")
    return doc


def build_network(raw: bytes | dict, profile_name: str | None = None) -> dict:
    """Build the routable graph from an Overpass JSON response (bytes or parsed). Returns a JSON-serialisable network."""
    prof_name = profile_name or DEFAULT_PROFILE
    prof = profile(prof_name)
    classes = set(prof["classes"])
    doc = raw if isinstance(raw, dict) else _parse(raw)
    nodes = {el["id"]: (el["lat"], el["lon"]) for el in doc.get("elements", []) if el.get("type") == "node"}
    edges: dict[tuple[int, int], tuple[float, float]] = {}
    for el in doc.get("elements", []):
        if el.get("type") != "way" or len(el.get("nodes", [])) < 2:
            continue
        tags = el.get("tags", {})
        if tags.get("highway") not in classes:
            continue
        kmh, ow = _speed(tags, prof["speed_factor"]), _oneway(tags)
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
    if not keep or len(keep) < 2:
        raise ValueError("no routable road in this area for the selected profile")
    keep_ids = [ids[i] for i in keep]
    knew = {x: i for i, x in enumerate(keep_ids)}
    out_edges = sorted((knew[u], knew[v], round(length, 2), round(t, 3)) for (u, v), (length, t) in edges.items()
                       if u in knew and v in knew)
    net = dict(builder=BUILDER, profile=prof_name, speed_factor=prof["speed_factor"], road_classes=sorted(classes),
               speed_profile_kmh=SPEED_KMH,
               osm_node_ids=keep_ids, lat=[round(nodes[x][0], 7) for x in keep_ids],
               lon=[round(nodes[x][1], 7) for x in keep_ids], edges=[list(e) for e in out_edges])
    net["network_id"] = sha256(net)[:24]
    return net


class NetworkStore:
    """Content-addressed road networks under ``<data>/networks/<network_id>/`` (network, provenance, raw response)."""

    def __init__(self, data_dir: Path):
        self.root = Path(data_dir) / "networks"

    def save(self, raw: bytes, area: dict, source_url: str = OVERPASS_URL, profile_name: str | None = None) -> dict:
        prof_name = profile_name or DEFAULT_PROFILE
        doc = _parse(raw)                                     # parsed once (responses can be large)
        net = build_network(doc, prof_name)
        d = self.root / net["network_id"]
        d.mkdir(parents=True, exist_ok=True)
        (d / "network.json").write_bytes(canonical(net))
        with gzip.open(d / "overpass_raw.json.gz", "wb") as fh:
            fh.write(raw)
        prov = dict(network_id=net["network_id"], area=area, profile=prof_name, profile_label=PROFILES[prof_name]["label"],
                    source=dict(service="Overpass API", url=source_url, query=overpass_query(area["bbox"], prof_name), retrieved_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
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
                p = json.loads(f.read_text())
            except (OSError, ValueError):
                continue
            p.setdefault("profile", DEFAULT_PROFILE)                 # networks built before profiles existed
            out.append(p)
        return out

    @staticmethod
    def key(bbox, profile_name: str | None = None) -> tuple:
        return (profile_name or DEFAULT_PROFILE, *(round(float(x), 5) for x in bbox))

    def index(self) -> dict[tuple, dict]:
        """(profile, box) -> most recent stored network, built in one pass."""
        out: dict[tuple, dict] = {}
        for p in self.list():
            box = (p.get("area") or {}).get("bbox")
            if not box or len(box) != 4:
                continue
            k = self.key(box, p.get("profile"))
            if k not in out or out[k]["source"]["retrieved_at"] < p["source"]["retrieved_at"]:
                out[k] = p
        return out

    def find(self, bbox, profile_name: str | None = None) -> dict | None:
        """The most recent stored network fetched for exactly this box and profile (cache hit), if any."""
        return self.index().get(self.key(bbox, profile_name))

    def provenance(self, network_id: str) -> dict:
        f = self._dir(network_id) / "provenance.json"
        if not f.exists():
            raise KeyError(f"network {network_id} not found")
        prov = json.loads(f.read_text())
        prov.setdefault("profile", DEFAULT_PROFILE)
        return prov

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
