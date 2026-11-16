"""Participant and vehicle authoring for ride-matching scenarios: a seeded generator and the checks of one participant.

Two entry points, both pure functions of a road network and their arguments (no storage, nothing solved):

* :func:`generate` — "Randomize": drivers and riders with origins and destinations on the road network's nodes (the
  whole network or a rectangle of it), departures in an interval, a departure window per driver and a pick-up window
  per rider, and a fleet drawn from vehicle-type shares. The same parameters and seed always give the same scenario;
  each participant's draw depends only on the seed, the generation area, its role and its rank, so changing the number
  of riders leaves the drivers where they are. The scenario records its generator, seed and parameters in its
  provenance: generated data is never presented as observed data.
* :func:`resolve_participant` and :func:`snap_point` — a participant placed or moved by hand: its points are snapped to
  the road network, its direct travel time is computed, its time window is checked.

Nothing invalid is produced silently: every refusal is a ``ValueError`` whose message says what to change.

The public ride-matching problem carries one rider per driver and has a departure window per driver and a pick-up
window per rider (no drop-off window). A vehicle's passenger capacity is recorded with its profile; an arrival deadline
is expressed through the latest departure (arrival minus the direct travel time).
"""
from __future__ import annotations

import random

from ..geo import scenarios as SC
from ..geo.osm import haversine_m
from .vehicles import validate_profile

GENERATOR = "move_openlab.mobility.authoring/1.0.0"
#: Vehicle types of the authoring tools and the powertrains they cover (a custom powertrain counts as combustion).
GROUPS: dict[str, tuple[str, ...]] = dict(combustion=("ICE", "custom"), hybrid=("HEV", "PHEV"), electric=("BEV",))
HORIZON_S = 2 * 86400
MAX_WINDOW_S = 4 * 3600
STEP_S = 300
DEFAULTS = dict(n_drivers=10, n_riders=15, seed=1, departure=[7 * 3600, 9 * 3600], driver_window_s=900,
                rider_window_s=1200, max_detour_s=900, max_detour_ratio=0.5, min_trip_m=1500.0)


def group_of(powertrain: str) -> str:
    return next((g for g, pts in GROUPS.items() if powertrain in pts), "combustion")


def hhmm(s: int) -> str:
    return f"{int(s) // 3600:02d}:{int(s) % 3600 // 60:02d}"


def split_counts(n: int, shares: list[float]) -> list[int]:
    """``n`` items split by percentage shares (largest remainder; a tie goes to the earlier share)."""
    total = sum(shares)
    if n <= 0 or total <= 0:
        return [0] * len(shares)
    exact = [n * s / total for s in shares]
    out = [int(x) for x in exact]
    order = sorted(range(len(shares)), key=lambda i: (-(exact[i] - out[i]), i))
    for i in order[: n - sum(out)]:
        out[i] += 1
    return out


def with_capacity(profile: dict, capacity: int) -> dict:
    """The profile with another passenger capacity, as a new researcher profile that names the one it comes from."""
    if profile["passenger_capacity"] == capacity:
        return profile
    prov = profile.get("provenance") or {}
    base_id = prov["derived_from"] if prov.get("change") == "passenger_capacity" and prov.get("derived_from") else profile["id"]
    base_name = profile["name"].split(" · ")[0] if prov.get("change") == "passenger_capacity" else profile["name"]
    out = {k: v for k, v in profile.items() if k not in ("version", "updated_at")}
    out.update(id=f"{str(base_id)[:35]}-{capacity}p", name=f"{base_name[:60]} · {capacity} seats", passenger_capacity=capacity,
               provenance=dict(kind="researcher", derived_from=str(base_id), change="passenger_capacity"))
    return validate_profile(out)


def _whole(v, what: str, lo: int, hi: int, unit: str = "") -> int:
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    if isinstance(v, bool) or not isinstance(v, int):
        raise ValueError(f"{what} must be a whole number between {lo} and {hi}{unit}")
    if not lo <= v <= hi:
        raise ValueError(f"{what} must be between {lo} and {hi}{unit} (got {v})")
    return v


def _number(v, what: str, lo: float, hi: float, unit: str = "") -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v:
        raise ValueError(f"{what} must be a number between {lo:g} and {hi:g}{unit}")
    if not lo <= v <= hi:
        raise ValueError(f"{what} must be between {lo:g} and {hi:g}{unit} (got {v:g})")
    return float(v)


def _bbox(b) -> list[float] | None:
    if b is None:
        return None
    if not (isinstance(b, (list, tuple)) and len(b) == 4
            and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in b)):
        raise ValueError("the generation rectangle must be [south, west, north, east] in degrees")
    s, w, n, e = (float(x) for x in b)
    if not (-90 <= s < n <= 90 and -180 <= w < e <= 180):
        raise ValueError("the generation rectangle is empty: its south-west corner must lie below and to the left of "
                         "its north-east corner")
    return [round(s, 6), round(w, 6), round(n, 6), round(e, 6)]


def _capacity(capacity) -> int | None:
    if capacity is None:
        return None
    if isinstance(capacity, float) and capacity.is_integer():
        capacity = int(capacity)
    if isinstance(capacity, bool) or not isinstance(capacity, int):
        raise ValueError("the vehicle capacity must be a whole number of seats between 1 and 60")
    if capacity < 1:
        raise ValueError(f"the vehicle capacity must be at least 1 seat (got {capacity}): enter a whole number "
                         "between 1 and 60")
    if capacity > 60:
        raise ValueError(f"the vehicle capacity must be at most 60 seats (got {capacity})")
    return capacity


def _fleet(p: dict) -> list[dict] | None:
    """``[{group, share, profile}]`` for the vehicle types with a share, or None when the scenario has no vehicles."""
    shares, profiles = p.get("shares"), p.get("profiles")
    capacity = _capacity(p.get("capacity"))
    if shares is None and not profiles:
        return None
    if not isinstance(shares, dict) or set(shares) - set(GROUPS):
        raise ValueError(f"vehicle shares are given per vehicle type: {', '.join(GROUPS)}")
    if not isinstance(profiles, list) or len(profiles) > 50:
        raise ValueError("vehicle profiles must be a list of at most 50 profiles")
    profiles = [validate_profile(x) for x in profiles]
    if len({x["id"] for x in profiles}) != len(profiles):
        raise ValueError("vehicle profile ids must be distinct")
    share = {g: _number(shares.get(g, 0), f"the {g} share", 0, 100, " %") for g in GROUPS}
    total = sum(share.values())
    if abs(total - 100) > 0.01:
        raise ValueError(f"the vehicle shares add up to {total:g} %, not 100 %: change them so that combustion + "
                         "hybrid + electric = 100")
    choice = p.get("vehicles") or {}
    if not isinstance(choice, dict) or set(choice) - set(GROUPS):
        raise ValueError(f"the chosen vehicles are given per vehicle type: {', '.join(GROUPS)}")
    out = []
    for g in GROUPS:
        if share[g] <= 0:
            continue
        cands = [x for x in profiles if group_of(x["powertrain"]) == g]
        if not cands:
            raise ValueError(f"no {g} vehicle is available in this scenario: set the {g} share to 0 % or add a {g} "
                             "vehicle profile first")
        chosen = next((x for x in cands if x["id"] == choice.get(g)), None) if choice.get(g) else cands[0]
        if chosen is None:
            raise ValueError(f"vehicle {choice[g]!r} is not a {g} vehicle of this scenario")
        out.append(dict(group=g, share=share[g], profile=with_capacity(chosen, capacity) if capacity else chosen))
    return out


def validate_params(p) -> dict:
    """Normalised generation parameters (defaults filled in); raises ``ValueError`` saying what to change."""
    if not isinstance(p, dict):
        raise ValueError("generation parameters must be an object")
    known = set(DEFAULTS) | {"bbox", "capacity", "shares", "profiles", "vehicles"}
    if set(p) - known:
        raise ValueError(f"unknown generation parameter(s) {sorted(set(p) - known)}")
    p = dict(DEFAULTS, **{k: v for k, v in p.items() if v is not None})
    out = dict(n_drivers=_whole(p["n_drivers"], "the number of drivers", 1, 100),
               n_riders=_whole(p["n_riders"], "the number of riders", 1, 100),
               seed=_whole(p["seed"], "the random seed", 0, 1_000_000))
    dep = p["departure"]
    if isinstance(dep, (int, float)) and not isinstance(dep, bool):
        dep = [dep, dep]                                     # one departure time
    if not (isinstance(dep, (list, tuple)) and len(dep) == 2):
        raise ValueError("the departure is one time or an interval [from, to] in seconds since midnight")
    start = _whole(dep[0], "the first departure", 0, HORIZON_S, " s (00:00 to 48:00)")
    end = _whole(dep[1], "the last departure", 0, HORIZON_S, " s (00:00 to 48:00)")
    if end < start:
        raise ValueError(f"the departure interval ends ({hhmm(end)}) before it starts ({hhmm(start)}): set its end at "
                         "or after its start")
    out["departure"] = [start, end]
    for key, what in (("driver_window_s", "the driver departure window"), ("rider_window_s", "the rider pick-up window")):
        w = p[key]
        if isinstance(w, float) and w.is_integer():
            w = int(w)
        if isinstance(w, bool) or not isinstance(w, int) or not 0 <= w <= MAX_WINDOW_S:
            raise ValueError(f"{what} must be between 0 and {MAX_WINDOW_S // 60} minutes"
                             + (f" (got {w / 60:g} min)" if isinstance(w, (int, float)) and not isinstance(w, bool) else ""))
        out[key] = w
        if end + w > HORIZON_S:
            raise ValueError(f"{what} would end after 48:00: choose an earlier departure or a shorter window")
    out["max_detour_s"] = _whole(p["max_detour_s"], "the maximum detour", 0, 7200, " s (0 to 120 minutes)")
    out["max_detour_ratio"] = _number(p["max_detour_ratio"], "the maximum detour ratio", 0, 5)
    out["min_trip_m"] = _number(p["min_trip_m"], "the minimum trip length", 200, 50_000, " m")
    out["bbox"] = _bbox(p.get("bbox"))
    out["capacity"] = _capacity(p.get("capacity"))
    out["fleet"] = _fleet(p)
    return out


def _pool(net, bbox: list[float] | None, min_trip_m: float) -> list[int]:
    """Road nodes the participants are drawn from: all of them, or those inside the rectangle."""
    if len(net) < 2:
        raise ValueError("the road network has too few nodes to place participants")
    if bbox is None:
        pool = list(range(len(net)))
        where = "the working area"
    else:
        s, w, n, e = bbox
        pool = [i for i in range(len(net)) if s <= net.lat[i] <= n and w <= net.lon[i] <= e]
        where = "the rectangle"
        if not pool:
            raise ValueError("the rectangle contains no road node of this area: move it over the roads or enlarge it")
    la, lo = [net.lat[i] for i in pool], [net.lon[i] for i in pool]
    span = haversine_m(min(la), min(lo), max(la), max(lo))
    if len(pool) < 2 or span < min_trip_m:
        raise ValueError(f"{where} is too small for trips of at least {min_trip_m:.0f} m (its road nodes span "
                         f"{span:.0f} m): enlarge it or lower the minimum trip length")
    return pool


def generate(net, params: dict, name: str = "Generated scenario") -> dict:
    """The (unsaved) scenario the parameters and the seed give on this road network, in the editor format of
    :mod:`move_openlab.geo.scenarios` (to be checked and built like any other scenario)."""
    p = validate_params(params)
    pool = _pool(net, p["bbox"], p["min_trip_m"])
    start, end = p["departure"]
    m = len(pool)
    where = "the rectangle" if p["bbox"] else "the working area"
    area = ",".join(f"{x:.6f}" for x in p["bbox"]) if p["bbox"] else "network"

    def participant(role: str, prefix: str, k: int, window: int) -> dict:
        rnd = random.Random(f"authoring:{net.network_id}:{area}:{p['seed']}:{role}:{k}")
        for _ in range(400):
            a, b = pool[rnd.randrange(m)], pool[rnd.randrange(m)]
            if haversine_m(net.lat[a], net.lon[a], net.lat[b], net.lon[b]) >= p["min_trip_m"]:
                break
        else:
            raise ValueError(f"{where} is too small for trips of at least {p['min_trip_m']:.0f} m: enlarge it or lower "
                             "the minimum trip length")
        dep = start + STEP_S * rnd.randrange((end - start) // STEP_S + 1)
        return dict(id=f"{prefix}{k + 1}", origin=[net.lat[a], net.lon[a]], destination=[net.lat[b], net.lon[b]],
                    earliest=dep, latest=dep + window)

    drivers = [participant("drivers", "D", k, p["driver_window_s"]) for k in range(p["n_drivers"])]
    riders = [participant("riders", "R", k, p["rider_window_s"]) for k in range(p["n_riders"])]
    # what the draw depended on (the detour limits are the scenario's own parameters and may be changed afterwards)
    recorded = dict(driver_window_s=p["driver_window_s"], rider_window_s=p["rider_window_s"])
    sc = dict(name=name, network_id=net.network_id,
              params=dict(max_detour_s=p["max_detour_s"], max_detour_ratio=p["max_detour_ratio"]),
              drivers=drivers, riders=riders)
    fleet = p["fleet"]
    if fleet:
        counts = split_counts(p["n_drivers"], [f["share"] for f in fleet])
        ids = [f["profile"]["id"] for f, c in zip(fleet, counts) for _ in range(c)]
        random.Random(f"authoring-fleet:{net.network_id}:{p['seed']}").shuffle(ids)
        default = max(fleet, key=lambda f: f["share"])["profile"]["id"]        # the first of the largest shares
        sc["vehicles"] = dict(profiles=[f["profile"] for f in fleet], default=default,
                              assignments={d["id"]: v for d, v in zip(drivers, ids) if v != default})
        recorded.update(capacity=p["capacity"], vehicle_shares={f["group"]: f["share"] for f in fleet},
                        vehicles={f["group"]: f["profile"]["id"] for f in fleet},
                        vehicle_counts={f["group"]: c for f, c in zip(fleet, counts)})
    sc["provenance"] = dict(source="generator", generator=GENERATOR, seed=p["seed"], n_drivers=p["n_drivers"],
                            n_riders=p["n_riders"], window=[start, end], min_trip_m=p["min_trip_m"], area=p["bbox"],
                            parameters=recorded)
    return sc


# ---------------------------------------------------------------- one participant placed or moved by hand
def _inside(lat: float, lon: float, box) -> bool:
    return bool(box) and box[0] <= lat <= box[2] and box[1] <= lon <= box[3]


def snap_point(net, lat: float, lon: float, area_bbox=None, what: str = "this point") -> dict:
    """The road node a point placed on the map stands for. Refused outside the working area (the area's rectangle and
    the extent of its road network) and beyond the snapping limit of scenarios."""
    if isinstance(lat, bool) or isinstance(lon, bool) or not all(isinstance(x, (int, float)) for x in (lat, lon)) \
            or not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError(f"{what} must be a place on the map (latitude, longitude)")
    try:
        node, dist = net.snap(lat, lon)
    except ValueError:
        raise ValueError(f"{what} is outside the working area, too far from the road network: place it inside the "
                         "area") from None
    s, w, n, e = net.bounds()
    if not (_inside(lat, lon, [s, w, n, e]) or _inside(lat, lon, area_bbox)):
        raise ValueError(f"{what} is outside the working area ({dist:.0f} m from the road network): place it inside "
                         "the area")
    if dist > SC.MAX_SNAP_M:
        raise ValueError(f"{what} is {dist:.0f} m from the road network (limit {SC.MAX_SNAP_M:.0f} m): place it nearer "
                         "to a road")
    return dict(point=[net.lat[node], net.lon[node]], node=node, snap_m=dist)


def resolve_participant(net, role: str, a, area_bbox=None) -> dict:
    """One driver or rider as the scenario will hold it: both points on the road network, the direct travel time and
    distance, and a checked time window. ``arrive_by`` (optional, seconds) is a latest arrival by the direct trip: it
    is refused when the direct travel time does not allow it, and otherwise tightens the latest departure (driver) or
    pick-up (rider) to ``arrive_by - direct travel time``."""
    if role not in ("driver", "rider"):
        raise ValueError("role must be 'driver' or 'rider'")
    if not isinstance(a, dict):
        raise ValueError("participant must be an object")
    pid = str(a.get("id", ""))
    if not SC.ID.match(pid):
        raise ValueError(f"invalid identifier {a.get('id')!r}: start with a letter, then letters, digits, '-' or '_' "
                         "(at most 32 characters)")
    start_name = "start" if role == "driver" else "pick-up point"
    pts = {}
    for key, label in (("origin", start_name), ("destination", "destination")):
        v = a.get(key)
        if not (isinstance(v, (list, tuple)) and len(v) == 2):
            raise ValueError(f"{pid}: the {label} must be placed on the map")
        pts[key] = snap_point(net, v[0], v[1], area_bbox, f"{pid}: the {label}")
    if pts["origin"]["node"] == pts["destination"]["node"]:
        raise ValueError(f"{pid}: the {start_name} and the destination are at the same road node: place them further "
                         "apart")
    try:
        t, m = net.travel(pts["origin"]["node"], pts["destination"]["node"])
    except ValueError:
        raise ValueError(f"{pid}: no road connects the {start_name} to the destination: move one of them") from None
    direct_s, direct_m = int(round(t)), round(float(m), 1)
    what = "departure" if role == "driver" else "pick-up"
    e, l = a.get("earliest"), a.get("latest")
    if isinstance(e, bool) or isinstance(l, bool) or not (isinstance(e, int) and isinstance(l, int)):
        raise ValueError(f"{pid}: the earliest and latest {what} are times of day (HH:MM)")
    if not (0 <= e <= HORIZON_S and 0 <= l <= HORIZON_S):
        raise ValueError(f"{pid}: the {what} times must lie between 00:00 and 48:00")
    if l < e:
        raise ValueError(f"{pid}: the latest {what} ({hhmm(l)}) is before the earliest {what} ({hhmm(e)}): choose "
                         f"{hhmm(e)} or later")
    by = a.get("arrive_by")
    if by is not None:
        if isinstance(by, bool) or not isinstance(by, int) or not 0 <= by <= HORIZON_S + 86400:
            raise ValueError(f"{pid}: the latest arrival is a time of day (HH:MM)")
        if by < e + direct_s:
            first = e + direct_s + (-(e + direct_s) % 60)                    # the first whole minute that works
            raise ValueError(f"{pid}: the latest arrival {hhmm(by)} is earlier than the direct travel time allows "
                             f"(earliest {what} {hhmm(e)} + {max(1, round(direct_s / 60))} min on the road): choose "
                             f"{hhmm(first)} or later, or an earlier {what}")
        l = min(l, by - direct_s)
    return dict(id=pid, origin=pts["origin"]["point"], destination=pts["destination"]["point"], earliest=e, latest=l,
                direct_s=direct_s, direct_m=direct_m, snap_m=[pts["origin"]["snap_m"], pts["destination"]["snap_m"]],
                arrival=[e + direct_s, l + direct_s])
