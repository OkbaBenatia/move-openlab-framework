"""Vehicle CO2 of a ride-matching solution, computed by the platform from validated decisions only.

Scopes (every output names its scope; nothing is ever mixed silently)::

    tailpipe            CO2 of fuel combustion while driving. A battery-electric vehicle emits 0 at the tailpipe —
                        this is not a life-cycle statement.
    operational-energy  CO2 of the energy used for driving: fuel combustion plus the generation of the electricity
                        consumed. For a plug-in hybrid both consumptions are entered by the researcher (they embed
                        the electric/fuel split); no split is invented here.
    direct-intensity    a validated direct intensity (g CO2 per km) entered by the researcher.

Formulas (distance in km)::

    fuel         CO2 = km x fuel_consumption_l_100km / 100 x fuel_emission_factor_g_per_l
    electricity  CO2 = km x electricity_consumption_kwh_100km / 100 x electricity_emission_factor_g_per_kwh
    direct       CO2 = km x direct_co2_g_per_km

Baselines are explicit (the active one is returned with its definition); avoided CO2 = baseline - solution::

    everyone-drives-alone  every driver drives their own trip directly in their vehicle and every rider drives their
                           own trip in the scenario's default vehicle
    drivers-only           every driver drives their own trip directly; riders are not counted (neither in the
                           baseline nor in the solution)

A missing parameter makes the result *incomplete*: metrics are then not reported (never substituted).
"""
from __future__ import annotations

from ..hashing import sha256
from . import vehicles as V

SCOPES = {
    "tailpipe": "tailpipe CO2 of fuel combustion only; battery-electric driving counts as zero at the tailpipe",
    "operational-energy": "CO2 of the energy used for driving: fuel combustion plus generation of the electricity consumed",
    "direct-intensity": "a validated direct CO2 intensity per kilometre entered by the researcher",
}
BASELINES = {
    "everyone-drives-alone": "every driver drives their own trip directly and every rider drives their own trip in "
                             "the scenario's default vehicle",
    "drivers-only": "every driver drives their own trip directly; riders are not counted in the baseline nor in the "
                    "solution",
}
DEFAULT = dict(scope="operational-energy", baseline="everyone-drives-alone")
UNIT = "g"


def validate_config(cfg) -> dict:
    """``{"scope", "baseline"}`` (unknown keys refused)."""
    if not isinstance(cfg, dict) or set(cfg) - {"scope", "baseline"}:
        raise ValueError("emissions configuration must be {scope, baseline}")
    scope, baseline = cfg.get("scope", DEFAULT["scope"]), cfg.get("baseline", DEFAULT["baseline"])
    if scope not in SCOPES:
        raise ValueError(f"emission scope must be one of {sorted(SCOPES)}")
    if baseline not in BASELINES:
        raise ValueError(f"emission baseline must be one of {sorted(BASELINES)}")
    return dict(scope=scope, baseline=baseline)


def config_of(instance: dict, experiment_config: dict | None) -> dict | None:
    """Effective scope and baseline: the experiment's choice overrides the scenario's; None when neither exists."""
    cfg = (experiment_config or {}).get("emissions") or instance.get("emissions")
    return validate_config(cfg) if cfg else None


# ---------------------------------------------------------------- per-vehicle computation
def co2_g(profile: dict, distance_m: float, scope: str) -> tuple[float | None, list[str]]:
    """(grams, missing parameter ids). ``custom`` vehicles use the direct intensity when present, else every
    complete fuel / electricity pair they carry (tailpipe: the fuel pair only)."""
    km = distance_m / 1000.0
    pt = profile["powertrain"]
    val = lambda k: V.value(profile, k)                        # noqa: E731
    have = lambda ks: all(val(k) is not None for k in ks)     # noqa: E731
    fuel = lambda: km * val(V.FUEL[0]) / 100.0 * val(V.FUEL[1])                        # noqa: E731
    elec = lambda: km * val(V.ELECTRICITY[0]) / 100.0 * val(V.ELECTRICITY[1])          # noqa: E731
    if scope == "direct-intensity":
        return (km * val(V.DIRECT), []) if have([V.DIRECT]) else (None, [V.DIRECT])
    if scope == "tailpipe":
        if pt == "BEV":
            return 0.0, []
        if pt == "custom" and have([V.DIRECT]) and not have(V.FUEL):
            return km * val(V.DIRECT), []
        return (fuel(), []) if have(V.FUEL) else (None, [k for k in V.FUEL if val(k) is None])
    if scope == "operational-energy":
        if pt == "BEV":
            return (elec(), []) if have(V.ELECTRICITY) else (None, [k for k in V.ELECTRICITY if val(k) is None])
        if pt == "PHEV":
            need = list(V.FUEL) + list(V.ELECTRICITY)
            return (fuel() + elec(), []) if have(need) else (None, [k for k in need if val(k) is None])
        if pt == "custom":
            if have([V.DIRECT]):
                return km * val(V.DIRECT), []
            parts = [f() for ks, f in ((V.FUEL, fuel), (V.ELECTRICITY, elec)) if have(ks)]
            return (sum(parts), []) if parts else (None, list(V.FUEL))
        return (fuel(), []) if have(V.FUEL) else (None, [k for k in V.FUEL if val(k) is None])
    raise ValueError(f"unknown emission scope {scope!r}")


def _basis(profiles: list[dict]) -> str:
    bases = {rec.get("basis") for p in profiles for k, rec in (p.get("parameters") or {}).items()
             if V.PARAMETERS[k]["factor"] and rec.get("value") is not None}
    bases.discard(None)
    return "mixed" if len(bases) > 1 else (bases.pop() if bases else "CO2")


# ---------------------------------------------------------------- descriptor (comparability, fingerprints)
def descriptor(instance: dict, experiment_config: dict | None) -> dict | None:
    """What the emission figures of an instance depend on: scope, baseline, units/basis, every vehicle's parameter
    values and the driver -> vehicle assignment. None when the instance carries no vehicle data."""
    cfg = config_of(instance, experiment_config)
    default = (instance.get("vehicles") or {}).get("default")
    drivers = [d for d in instance.get("drivers", []) if isinstance(d.get("vehicle"), dict)]
    if cfg is None or not drivers:
        return None
    all_profiles = [d["vehicle"] for d in drivers] + ([default] if default else [])
    profiles = {}
    for p in all_profiles:
        profiles[p["id"]] = dict(powertrain=p["powertrain"],
                                 parameters={k: dict(value=r.get("value"), unit=r.get("unit"), basis=r.get("basis"))
                                             for k, r in sorted((p.get("parameters") or {}).items())})
    d = dict(scope=cfg["scope"], baseline=cfg["baseline"], unit=UNIT, basis=_basis(all_profiles),
             units={k: V.PARAMETERS[k]["unit"] for k in V.PARAMETERS},
             profiles=profiles, assignment={d["id"]: d["vehicle"]["id"] for d in drivers},
             rider_vehicle=default["id"] if default else None)
    return dict(d, fingerprint=sha256(d))


# ---------------------------------------------------------------- solution accounting
def compute(instance: dict, decisions: list, experiment_config: dict | None) -> dict | None:
    """Emission metrics of validated decisions ``[[driver, rider], ...]`` or ``{"complete": False, "missing": [...]}``;
    None when the instance has no emission configuration or vehicle data at all."""
    cfg = config_of(instance, experiment_config)
    default = (instance.get("vehicles") or {}).get("default")
    if cfg is None or not any(isinstance(d.get("vehicle"), dict) for d in instance.get("drivers", [])):
        return None
    scope, baseline = cfg["scope"], cfg["baseline"]
    missing: list[str] = []
    pairs = {(p["driver"], p["rider"]): p for p in instance["pairs"]}
    match = {d: r for d, r in decisions if (d, r) in pairs}
    riders_counted = baseline == "everyone-drives-alone"

    def need(d: dict, keys: tuple[str, ...]) -> bool:
        lost = [f"{d['id']}: {k}" for k in keys if d.get(k) is None]
        missing.extend(lost)
        return not lost

    def emit(profile: dict | None, meters: float, who: str) -> float:
        if profile is None:
            missing.append(f"{who}: no vehicle")
            return 0.0
        g, lost = co2_g(profile, meters, scope)
        missing.extend(f"{who}: {profile['id']}.{k}" for k in lost)
        return g or 0.0

    sol_g = base_g = sol_km = base_km = person_km = 0.0
    fleet: dict[str, int] = {}
    vehicles_used = 0
    for d in instance["drivers"]:
        prof = d.get("vehicle")
        if not need(d, ("direct_m",)):
            continue
        base_km += d["direct_m"]
        base_g += emit(prof, d["direct_m"], d["id"])
        if d["id"] in match:
            p = pairs[(d["id"], match[d["id"]])]
            if not need(p, ("to_pickup_m", "ride_m", "to_dest_m")):
                continue
            meters = p["to_pickup_m"] + p["ride_m"] + p["to_dest_m"]
            person_km += p["ride_m"]
        else:
            meters = d["direct_m"]
        person_km += d["direct_m"]
        sol_km += meters
        sol_g += emit(prof, meters, d["id"])
        vehicles_used += 1
        if prof:
            fleet[prof["powertrain"]] = fleet.get(prof["powertrain"], 0) + 1
    served = set(match.values())
    if riders_counted:
        for r in instance["riders"]:
            if not need(r, ("direct_m",)):
                continue
            base_km += r["direct_m"]
            base_g += emit(default, r["direct_m"], r["id"])
            if r["id"] not in served:
                sol_km += r["direct_m"]
                person_km += r["direct_m"]
                sol_g += emit(default, r["direct_m"], r["id"])
                vehicles_used += 1
    if missing:
        return dict(complete=False, scope=scope, baseline=baseline, missing=sorted(set(missing))[:20])
    avoided = base_g - sol_g
    pkm = person_km / 1000.0
    r1 = lambda x: round(x, 1)                                 # noqa: E731
    profiles = {p["id"]: p for p in [d["vehicle"] for d in instance["drivers"]] + ([default] if default else [])}
    return dict(complete=True, scope=scope, scope_definition=SCOPES[scope], baseline=baseline,
                baseline_definition=BASELINES[baseline], unit=UNIT, basis=_basis(list(profiles.values())),
                solution_g=r1(sol_g), baseline_g=r1(base_g), avoided_g=r1(avoided),
                avoided_pct=round(100.0 * avoided / base_g, 2) if base_g else None,
                per_vehicle_g=r1(sol_g / vehicles_used) if vehicles_used else None,
                per_served_request_g=r1(sol_g / len(served)) if served else None,
                per_passenger_km_g=r1(sol_g / pkm) if pkm else None,
                vehicle_km=round(sol_km / 1000.0, 3), baseline_vehicle_km=round(base_km / 1000.0, 3),
                passenger_km=round(pkm, 3), served=len(served), vehicles_used=vehicles_used, fleet=fleet,
                parameters={k: p.get("parameters") for k, p in sorted(profiles.items())})


def aggregate(parts: list[dict | None]) -> dict | None:
    """Totals over the scenarios of one method; None unless every part is complete under one scope and baseline."""
    if not parts or any(not p or not p.get("complete") for p in parts):
        return None
    if len({(p["scope"], p["baseline"], p["basis"]) for p in parts}) != 1:
        return None
    s = lambda k: sum(p[k] for p in parts)                      # noqa: E731
    sol, base, pkm, served, used = s("solution_g"), s("baseline_g"), s("passenger_km"), s("served"), s("vehicles_used")
    first = parts[0]
    fleet: dict[str, int] = {}
    for p in parts:
        for k, n in p["fleet"].items():
            fleet[k] = fleet.get(k, 0) + n
    return dict(complete=True, scope=first["scope"], scope_definition=first["scope_definition"],
                baseline=first["baseline"], baseline_definition=first["baseline_definition"], unit=UNIT,
                basis=first["basis"], scenarios=len(parts), solution_g=round(sol, 1), baseline_g=round(base, 1),
                avoided_g=round(base - sol, 1), avoided_pct=round(100.0 * (base - sol) / base, 2) if base else None,
                per_vehicle_g=round(sol / used, 1) if used else None,
                per_served_request_g=round(sol / served, 1) if served else None,
                per_passenger_km_g=round(sol / pkm, 1) if pkm else None,
                vehicle_km=round(s("vehicle_km"), 3), baseline_vehicle_km=round(s("baseline_vehicle_km"), 3),
                passenger_km=round(pkm, 3), served=served, vehicles_used=used, fleet=fleet)


METRICS = [dict(id="solution_g", label="CO2", unit="g", better="lower"),
           dict(id="baseline_g", label="Baseline CO2", unit="g", better=None),
           dict(id="avoided_g", label="Avoided CO2", unit="g", better="higher"),
           dict(id="avoided_pct", label="Avoided CO2", unit="%", better="higher"),
           dict(id="per_vehicle_g", label="CO2 per vehicle", unit="g", better="lower"),
           dict(id="per_served_request_g", label="CO2 per served request", unit="g", better="lower"),
           dict(id="per_passenger_km_g", label="CO2 per passenger-km", unit="g/km", better="lower"),
           dict(id="vehicle_km", label="Vehicle distance", unit="km", better="lower"),
           dict(id="vehicles_used", label="Vehicles", unit="vehicle", better="lower")]
