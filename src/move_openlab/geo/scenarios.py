"""Mobility scenarios on a road network and their conversion into ride-matching instances.

Scenario (editor format)::

    {"name": str, "network_id": str, "params": {"max_detour_s": int, "max_detour_ratio": float},
     "drivers": [{"id", "origin": [lat, lon], "destination": [lat, lon], "earliest": s, "latest": s}],
     "riders":  [{"id", "origin": [lat, lon], "destination": [lat, lon], "earliest": s, "latest": s}],
     "vehicles"?: {"profiles": [...], "default": id, "assignments": {driver_id: id}}   (mobility.vehicles)
     "emissions"?: {"scope": ..., "baseline": ...}                                      (mobility.emissions)
     "provenance": {"source": "editor" | "generator" | "open-data", ...}}

Times are seconds since midnight. For drivers the window is the departure window; for riders it is the pickup window.
Building an instance snaps every point to the nearest road node (refused beyond ``MAX_SNAP_M``), computes free-flow
travel times and distances on the network, and keeps every driver–rider pair whose detour respects both limits and
whose pickup window is non-empty. All times and distances are stored in the instance, so it can be validated and
its emissions computed without the network; each driver's vehicle profile is frozen inside the instance.

Three ways to create scenarios:
* the map editor (points placed by the researcher);
* :func:`generate_synthetic` — seeded random origins/destinations on the network's nodes;
* :func:`generate_empirical` — seeded resampling (with replacement) of validated trip records (RPC open data or a
  dataset uploaded by the researcher). Roles are not
  observed in those records: drivers and riders are drawn independently from the same pool. Each agent takes one
  record's origin–destination pair as published (coordinates already truncated by the publisher) and a departure
  time re-drawn inside the publisher's 10-minute rounding interval; identifiers, dates, distances and operator
  classes are not carried over. Building the instance snaps the points to the road network.
"""
from __future__ import annotations

import random
import re

from ..benchmarks.ride_matching import model as M
from ..hashing import with_hash
from .network import RoadNetwork

MAX_AGENTS = 200
MAX_SNAP_M = 1500.0
ID = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,31}$")
DEFAULT_PARAMS = dict(max_detour_s=900, max_detour_ratio=0.5)


def validate_scenario(sc: dict) -> dict:
    if not isinstance(sc, dict):
        raise ValueError("scenario must be an object")
    name = " ".join(str(sc.get("name", "")).split())[:120]
    if len(name) < 3:
        raise ValueError("scenario name must contain at least 3 characters")
    params = dict(DEFAULT_PARAMS, **(sc.get("params") or {}))
    if not (isinstance(params["max_detour_s"], int) and 0 <= params["max_detour_s"] <= 7200):
        raise ValueError("max_detour_s must be an integer in [0, 7200]")
    if not (isinstance(params["max_detour_ratio"], (int, float)) and 0 <= params["max_detour_ratio"] <= 5):
        raise ValueError("max_detour_ratio must be in [0, 5]")
    agents = {}
    for role in ("drivers", "riders"):
        out = []
        for a in sc.get(role) or []:
            if not ID.match(str(a.get("id", ""))):
                raise ValueError(f"invalid {role[:-1]} id {a.get('id')!r}")
            pts = []
            for k in ("origin", "destination"):
                p = a.get(k)
                if not (isinstance(p, (list, tuple)) and len(p) == 2 and all(isinstance(x, (int, float)) for x in p)
                        and -90 <= p[0] <= 90 and -180 <= p[1] <= 180):
                    raise ValueError(f"{a['id']}: {k} must be [lat, lon]")
                pts.append([round(float(p[0]), 6), round(float(p[1]), 6)])
            e, l = a.get("earliest"), a.get("latest")
            if not (isinstance(e, int) and isinstance(l, int) and 0 <= e <= l <= 2 * 86400):
                raise ValueError(f"{a['id']}: earliest/latest must be seconds with earliest <= latest")
            out.append(dict(id=a["id"], origin=pts[0], destination=pts[1], earliest=e, latest=l))
        agents[role] = out
    ids = [a["id"] for a in agents["drivers"] + agents["riders"]]
    if len(set(ids)) != len(ids):
        raise ValueError("agent ids must be distinct")
    if not agents["drivers"] or not agents["riders"]:
        raise ValueError("a scenario needs at least one driver and one rider")
    if len(ids) > MAX_AGENTS:
        raise ValueError(f"at most {MAX_AGENTS} agents per scenario")
    out = dict(name=name, network_id=str(sc.get("network_id", "")), params=params, drivers=agents["drivers"],
               riders=agents["riders"], provenance=sc.get("provenance") or dict(source="editor"))
    if sc.get("vehicles"):
        out["vehicles"] = validate_vehicles(sc["vehicles"], [d["id"] for d in agents["drivers"]])
    if sc.get("emissions"):
        from ..mobility.emissions import validate_config
        out["emissions"] = validate_config(sc["emissions"])
    return out


def validate_vehicles(v, driver_ids: list[str]) -> dict:
    """``{"profiles": [...], "default": id, "assignments": {driver: id}}``: the default profile is every driver's
    vehicle unless assigned otherwise, and the riders' vehicle in the everyone-drives-alone baseline."""
    from ..mobility.vehicles import validate_profile
    if not isinstance(v, dict) or not isinstance(v.get("profiles"), list) or not v["profiles"]:
        raise ValueError("vehicles must carry at least one profile")
    if len(v["profiles"]) > 50:
        raise ValueError("at most 50 vehicle profiles per scenario")
    profiles = [validate_profile(p) for p in v["profiles"]]
    ids = [p["id"] for p in profiles]
    if len(set(ids)) != len(ids):
        raise ValueError("vehicle profile ids must be distinct")
    default = v.get("default") or ids[0]
    if default not in ids:
        raise ValueError(f"default vehicle {default!r} is not among the profiles")
    assignments = v.get("assignments") or {}
    if not isinstance(assignments, dict):
        raise ValueError("vehicle assignments must map driver ids to profile ids")
    for d, pid in assignments.items():
        if d not in driver_ids:
            raise ValueError(f"vehicle assigned to unknown driver {d!r}")
        if pid not in ids:
            raise ValueError(f"{d}: unknown vehicle profile {pid!r}")
    return dict(profiles=profiles, default=default, assignments={d: assignments[d] for d in sorted(assignments)})


def build_instance(sc: dict, net: RoadNetwork, network_prov: dict, instance_id: str) -> dict:
    sc = validate_scenario(sc)
    nodes = {}
    for a in sc["drivers"] + sc["riders"]:
        for k in ("origin", "destination"):
            n, d = net.snap(*a[k])
            if d > MAX_SNAP_M:
                raise ValueError(f"{a['id']}: {k} is {d:.0f} m from the road network (limit {MAX_SNAP_M:.0f} m)")
            nodes[(a["id"], k)] = (n, d)
    t: dict[tuple[int, int], tuple[int, float]] = {}

    def travel(u: int, v: int) -> tuple[int, float]:         # (seconds, metres) of the fastest path
        if (u, v) not in t:
            s, m = net.travel(u, v)
            t[(u, v)] = (int(round(s)), round(float(m), 1))
        return t[(u, v)]
    tt = lambda u, v: travel(u, v)[0]                           # noqa: E731
    tm = lambda u, v: travel(u, v)[1]                           # noqa: E731
    vehicles = sc.get("vehicles")
    by_id = {p["id"]: p for p in vehicles["profiles"]} if vehicles else {}
    drivers, riders = [], []
    for role, out in (("drivers", drivers), ("riders", riders)):
        for a in sc[role]:
            o, d = nodes[(a["id"], "origin")], nodes[(a["id"], "destination")]
            rec = dict(a, origin_node=net.osm_node_ids[o[0]], destination_node=net.osm_node_ids[d[0]],
                       snap_m=[o[1], d[1]], direct_s=tt(o[0], d[0]), direct_m=tm(o[0], d[0]))
            if vehicles and role == "drivers":                   # the vehicle travels frozen inside the instance
                rec["vehicle"] = by_id[vehicles["assignments"].get(a["id"], vehicles["default"])]
            out.append(rec)
    p = sc["params"]
    pairs = []
    for dr in drivers:
        od, dd = nodes[(dr["id"], "origin")][0], nodes[(dr["id"], "destination")][0]
        limit = min(p["max_detour_s"], int(p["max_detour_ratio"] * dr["direct_s"]))
        for r in riders:
            orn, drn = nodes[(r["id"], "origin")][0], nodes[(r["id"], "destination")][0]
            tp = tt(od, orn)
            ride, td = r["direct_s"], tt(drn, dd)
            detour = tp + ride + td - dr["direct_s"]
            lo, hi = max(dr["earliest"] + tp, r["earliest"]), min(dr["latest"] + tp, r["latest"])
            if 0 <= detour <= limit and lo <= hi:
                pairs.append(dict(driver=dr["id"], rider=r["id"], to_pickup_s=tp, ride_s=ride, to_dest_s=td,
                                  detour_s=detour, pickup_earliest=lo, pickup_latest=hi,
                                  to_pickup_m=tm(od, orn), ride_m=r["direct_m"], to_dest_m=tm(drn, dd)))
    inst = dict(schema=M.INSTANCE_SCHEMA, problem_id=M.PROBLEM_ID, problem_spec_version=M.PROBLEM_SPEC_VERSION,
                instance_id=instance_id, name=sc["name"], params=p,
                network=dict(network_id=net.network_id, attribution=network_prov["licence"]["attribution"],
                             licence=network_prov["licence"]["id"], osm_timestamp=network_prov["source"].get("osm_timestamp"),
                             travel_model="free-flow travel times from the OSM speed profile"),
                drivers=drivers, riders=riders, pairs=pairs, provenance=sc["provenance"])
    if vehicles:
        inst["vehicles"] = dict(default=by_id[vehicles["default"]])
    if sc.get("emissions"):
        inst["emissions"] = sc["emissions"]
    return with_hash(inst)


def _windows(rnd: random.Random, dep: int) -> tuple[tuple[int, int], tuple[int, int]]:
    return (dep - 300, dep + 600), (dep - 600, dep + 600)


def generate_synthetic(net: RoadNetwork, name: str, n_drivers: int, n_riders: int, seed: int, start_s: int, end_s: int,
                       params: dict | None = None, min_trip_m: float = 1500.0) -> dict:
    """Seeded synthetic demand: origins and destinations drawn among the network's nodes (straight-line distance at
    least ``min_trip_m``), departures uniform in [start, end) in 5-minute steps."""
    from .osm import haversine_m
    if not (1 <= n_drivers <= 100 and 1 <= n_riders <= 100) or not 0 <= start_s < end_s <= 2 * 86400:
        raise ValueError("1-100 drivers, 1-100 riders and a valid time interval are required")
    rnd = random.Random(f"synthetic:{net.network_id}:{seed}")
    n = len(net)

    def od():
        for _ in range(1000):
            a, b = rnd.randrange(n), rnd.randrange(n)
            if haversine_m(net.lat[a], net.lon[a], net.lat[b], net.lon[b]) >= min_trip_m:
                return [net.lat[a], net.lon[a]], [net.lat[b], net.lon[b]]
        raise ValueError("network too small for the minimum trip length")
    sc = dict(name=name, network_id=net.network_id, params=params or DEFAULT_PARAMS, drivers=[], riders=[],
              provenance=dict(source="generator", generator="move_openlab.geo.synthetic/1.0.0", seed=seed,
                              n_drivers=n_drivers, n_riders=n_riders, window=[start_s, end_s], min_trip_m=min_trip_m))
    for role, count, prefix in (("drivers", n_drivers, "D"), ("riders", n_riders, "R")):
        for i in range(count):
            o, d = od()
            dep = start_s + 300 * rnd.randrange(max(1, (end_s - start_s) // 300))
            wd, wr = _windows(rnd, dep)
            e, l = wd if role == "drivers" else wr
            sc[role].append(dict(id=f"{prefix}{i + 1}", origin=o, destination=d, earliest=max(0, e), latest=l))
    return sc


def generate_empirical(trips: list[dict], dataset: dict, network_id: str, name: str, n_drivers: int, n_riders: int,
                       seed: int, start_s: int, end_s: int, params: dict | None = None, date: str | None = None) -> dict:
    """Seeded resampling of validated trip records (see the module docstring).

    ``dataset`` is the dataset report (RPC ingestion report or workspace dataset report). When records carry a role,
    drivers are drawn from driver (or unlabelled) records and riders from rider (or unlabelled) records. RPC
    departures are re-drawn inside the publisher's 10-minute rounding interval; other datasets keep their times.
    """
    pool = [t for t in trips if start_s <= t["start_s"] < end_s and (date is None or t.get("date") == date)]
    if len(pool) < 5:
        raise ValueError(f"only {len(pool)} trip(s) in the selected period and area; widen the time interval, the "
                         "date or the area")
    if not (1 <= n_drivers <= 100 and 1 <= n_riders <= 100):
        raise ValueError("1-100 drivers and 1-100 riders are required")
    rpc = dataset.get("provider", "rpc") == "rpc" and "release" in dataset
    pools = {"drivers": [t for t in pool if t.get("role") != "rider"],
             "riders": [t for t in pool if t.get("role") != "driver"]}
    for role, p in pools.items():
        if not p:
            raise ValueError(f"no trip usable for {role} in the selected period (check the role column)")
    rnd = random.Random(f"empirical:{dataset['dataset_key']}:{seed}")
    prov = dict(source="open-data" if rpc else "dataset", generator="move_openlab.geo.empirical/1.0.0", seed=seed,
                dataset_key=dataset["dataset_key"], licence=dataset.get("licence"),
                attribution=dataset.get("attribution"), window=[start_s, end_s], date=date, pool_size=len(pool),
                n_drivers=n_drivers, n_riders=n_riders)
    if rpc:
        prov.update(release=dataset["release"],
                    method="drivers and riders drawn independently from the empirical OD/departure "
                           "distribution; departures re-drawn within the 10-minute rounding interval")
    else:
        prov.update(provider=dataset.get("provider"), dataset_name=dataset.get("name"),
                    source_sha256=(dataset.get("source") or {}).get("sha256"),
                    method="records resampled with replacement" + (", roles respected" if any(
                        t.get("role") for t in pool) else "") + "; departure times as recorded")
    sc = dict(name=name, network_id=network_id, params=params or DEFAULT_PARAMS, drivers=[], riders=[],
              provenance=prov)
    for role, count, prefix in (("drivers", n_drivers, "D"), ("riders", n_riders, "R")):
        p = pools[role]
        for i in range(count):
            t = p[rnd.randrange(len(p))]
            dep = t["start_s"] + (rnd.randrange(-300, 300) if rpc else 0)
            wd, wr = _windows(rnd, dep)
            e, l = wd if role == "drivers" else wr
            sc[role].append(dict(id=f"{prefix}{i + 1}", origin=[t["start_lat"], t["start_lon"]],
                                 destination=[t["end_lat"], t["end_lon"]], earliest=max(0, e), latest=l))
    return sc


def summary(inst: dict) -> dict:
    return dict(instance_hash=inst["instance_hash"], instance_id=inst["instance_id"], drivers=len(inst["drivers"]),
                riders=len(inst["riders"]), pairs=len(inst["pairs"]),
                riders_with_option=len({p["rider"] for p in inst["pairs"]}),
                max_snap_m=max(max(a["snap_m"]) for a in inst["drivers"] + inst["riders"]),
                mean_detour_s=round(sum(p["detour_s"] for p in inst["pairs"]) / len(inst["pairs"]), 1) if inst["pairs"] else None)
