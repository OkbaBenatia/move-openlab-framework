"""Route playback: the validated matches of one run as a deterministic, timed plan on the road network.

Nothing is optimised or invented here. For each driver the plan follows the instance's own travel times:

* matched driver: departs at the earliest time that reaches the rider at the start of the pickup window
  (``max(earliest, pickup_earliest - to_pickup)``), picks the rider up, drops them off, continues to its destination;
* unmatched driver: departs at the start of its window and drives directly;
* unserved riders are listed with their pickup window.

Geometry: fastest paths on the instance's road network when it is available (``road``), otherwise straight segments
(``straight``). Positions between nodes are interpolated along the path in proportion to distance.
"""
from __future__ import annotations

from .osm import haversine_m


def _leg(net, index, a_node, b_node, a_pt, b_pt, t0: float, duration: float) -> list[list[float]]:
    coords = None
    if net is not None and a_node in index and b_node in index:
        try:
            coords = net.route(index[a_node], index[b_node])["coords"]
        except ValueError:
            coords = None
    coords = coords or [a_pt, b_pt]
    if len(coords) == 1:
        coords = [coords[0], coords[0]]
    cum = [0.0]
    for p, q in zip(coords, coords[1:]):
        cum.append(cum[-1] + haversine_m(p[0], p[1], q[0], q[1]))
    total = cum[-1] or 1.0
    return [[round(p[0], 6), round(p[1], 6), round(t0 + duration * c / total, 1)] for p, c in zip(coords, cum)]


def plan(inst: dict, decisions: list, net=None) -> dict:
    index = {osm: i for i, osm in enumerate(net.osm_node_ids)} if net is not None else {}
    riders = {r["id"]: r for r in inst["riders"]}
    pairs = {(p["driver"], p["rider"]): p for p in inst["pairs"]}
    match = {d: r for d, r in decisions if (d, r) in pairs}
    vehicles, served = [], set()
    for dr in inst["drivers"]:
        r_id = match.get(dr["id"])
        if r_id:
            p, r = pairs[(dr["id"], r_id)], riders[r_id]
            dep = max(dr["earliest"], p["pickup_earliest"] - p["to_pickup_s"])
            t_pick = dep + p["to_pickup_s"]
            t_drop = t_pick + p["ride_s"]
            t_end = t_drop + p["to_dest_s"]
            path = _leg(net, index, dr["origin_node"], r["origin_node"], dr["origin"], r["origin"], dep, p["to_pickup_s"])
            path += _leg(net, index, r["origin_node"], r["destination_node"], r["origin"], r["destination"], t_pick, p["ride_s"])[1:]
            path += _leg(net, index, r["destination_node"], dr["destination_node"], r["destination"], dr["destination"],
                         t_drop, p["to_dest_s"])[1:]
            stops = [dict(type="depart", t=dep, at=dr["origin"]), dict(type="pickup", t=t_pick, at=r["origin"], rider=r_id),
                     dict(type="dropoff", t=t_drop, at=r["destination"], rider=r_id), dict(type="arrive", t=t_end, at=dr["destination"])]
            served.add(r_id)
            vehicles.append(dict(driver=dr["id"], rider=r_id, detour_s=p["detour_s"], path=path, stops=stops))
        else:
            dep = dr["earliest"]
            path = _leg(net, index, dr["origin_node"], dr["destination_node"], dr["origin"], dr["destination"], dep,
                        dr["direct_s"])
            vehicles.append(dict(driver=dr["id"], rider=None, detour_s=0, path=path,
                                 stops=[dict(type="depart", t=dep, at=dr["origin"]),
                                        dict(type="arrive", t=dep + dr["direct_s"], at=dr["destination"])]))
    unserved = [dict(rider=r["id"], at=r["origin"], destination=r["destination"], window=[r["earliest"], r["latest"]])
                for r in inst["riders"] if r["id"] not in served]
    times = [pt[2] for v in vehicles for pt in v["path"]]
    return dict(instance_id=inst["instance_id"], geometry="road" if net is not None else "straight",
                timing="instance travel times (free-flow); earliest feasible departures",
                attribution=(inst.get("network") or {}).get("attribution"), t_min=min(times), t_max=max(times),
                vehicles=vehicles, unserved=unserved, served=len(served), riders=len(inst["riders"]))
