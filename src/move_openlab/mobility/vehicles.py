"""Vehicle profiles: what a driver drives, with every energy and emission parameter editable and documented.

A profile::

    {"id": "compact-petrol", "name": "Compact petrol car", "category": "car", "passenger_capacity": 4,
     "powertrain": "ICE" | "HEV" | "PHEV" | "BEV" | "custom", "energy": "petrol",
     "parameters": {<parameter id>: {"value": 6.1, "unit": "L/100 km", "basis": "CO2e"?, "source": ..., "source_version": ...,
                                     "applicability": ..., "notes": ..., "recorded_at": ...}},
     "provenance": {"kind": "preset" | "researcher" | "imported" | "demo", ...}, "version": 1, "updated_at": ...}

No value is built into the code: presets are data files under ``presets/`` that carry their source, edition and
geographic applicability; a researcher's value always wins and is never replaced. A parameter that is absent stays
absent — nothing is defaulted silently — and the emission model then reports the computation as incomplete.
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

POWERTRAINS = ("ICE", "HEV", "PHEV", "BEV", "custom")
BASES = ("CO2", "CO2e")
PARAMETERS = {
    "fuel_consumption_l_100km": dict(label="Fuel consumption", unit="L/100 km", factor=False),
    "electricity_consumption_kwh_100km": dict(label="Electricity consumption", unit="kWh/100 km", factor=False),
    "fuel_emission_factor_g_per_l": dict(label="Fuel emission factor", unit="g/L", factor=True),
    "electricity_emission_factor_g_per_kwh": dict(label="Electricity emission factor", unit="g/kWh", factor=True),
    "direct_co2_g_per_km": dict(label="Direct CO2 intensity", unit="g/km", factor=True),
}
FUEL = ("fuel_consumption_l_100km", "fuel_emission_factor_g_per_l")
ELECTRICITY = ("electricity_consumption_kwh_100km", "electricity_emission_factor_g_per_kwh")
DIRECT = "direct_co2_g_per_km"
RECORD_KEYS = ("value", "unit", "basis", "source", "source_version", "applicability", "notes", "recorded_at")
PROVENANCE_KINDS = ("preset", "researcher", "imported", "demo")
ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}\Z")
MAX_PROFILES = 200
PRESETS = Path(__file__).resolve().parent / "presets"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _text(v, limit: int, what: str, required: bool = False) -> str | None:
    if v is None or v == "":
        if required:
            raise ValueError(f"{what} is required")
        return None
    if not isinstance(v, str):
        raise ValueError(f"{what} must be text")
    s = " ".join(v.split())
    if len(s) > limit:
        raise ValueError(f"{what} is longer than {limit} characters")
    return s or None


def validate_record(pid: str, rec, stamp: bool = False) -> dict:
    """One parameter record (a bare number is accepted and wrapped). ``stamp`` sets ``recorded_at`` when missing."""
    if pid not in PARAMETERS:
        raise ValueError(f"unknown vehicle parameter {pid!r}")
    spec = PARAMETERS[pid]
    if isinstance(rec, bool) or rec is None:
        raise ValueError(f"{pid}: a value or a record is required")
    if isinstance(rec, (int, float)):
        rec = dict(value=rec)
    if not isinstance(rec, dict) or set(rec) - set(RECORD_KEYS):
        raise ValueError(f"{pid}: unknown record field(s) {sorted(set(rec) - set(RECORD_KEYS)) if isinstance(rec, dict) else ''}")
    v = rec.get("value")
    if v is not None:
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not (0 <= float(v) < 1e6):
            raise ValueError(f"{pid}: value must be a number in [0, 1e6)")
        v = float(v)
    out = dict(value=v, unit=_text(rec.get("unit"), 24, f"{pid} unit") or spec["unit"])
    if spec["factor"]:
        basis = rec.get("basis") or "CO2"
        if basis not in BASES:
            raise ValueError(f"{pid}: basis must be one of {BASES}")
        out["basis"] = basis
    for k, lim in (("source", 300), ("source_version", 80), ("applicability", 120), ("notes", 400)):
        t = _text(rec.get(k), lim, f"{pid} {k}")
        if t:
            out[k] = t
    ra = _text(rec.get("recorded_at"), 40, f"{pid} recorded_at")
    if ra:
        out["recorded_at"] = ra
    elif stamp and v is not None:
        out["recorded_at"] = _now()
    return out


def validate_profile(p, stamp: bool = False) -> dict:
    """Normalised copy of a profile; raises ValueError with an actionable message."""
    if not isinstance(p, dict):
        raise ValueError("vehicle profile must be an object")
    pid = str(p.get("id", ""))
    if not ID.match(pid):
        raise ValueError("vehicle id must be 1-40 characters: lowercase letters, digits, '-' or '_'")
    pt = p.get("powertrain")
    if pt not in POWERTRAINS:
        raise ValueError(f"powertrain must be one of {POWERTRAINS}")
    cap = p.get("passenger_capacity", 1)
    if isinstance(cap, bool) or not isinstance(cap, int) or not 1 <= cap <= 60:
        raise ValueError("passenger_capacity must be an integer in [1, 60]")
    params = p.get("parameters") or {}
    if not isinstance(params, dict):
        raise ValueError("parameters must be an object")
    if set(params) - set(PARAMETERS):
        raise ValueError(f"unknown vehicle parameter(s) {sorted(set(params) - set(PARAMETERS))}")
    prov = p.get("provenance") or dict(kind="researcher")
    if not isinstance(prov, dict) or prov.get("kind") not in PROVENANCE_KINDS:
        raise ValueError(f"provenance.kind must be one of {PROVENANCE_KINDS}")
    if len(prov) > 12:
        raise ValueError("provenance has too many fields")
    prov = {k: (v if isinstance(v, (bool, int, float)) else _text(str(v), 300, f"provenance.{k}"))
            for k, v in prov.items() if v is not None and ID.match(str(k))}
    ver = p.get("version", 1)
    if isinstance(ver, bool) or not isinstance(ver, int) or ver < 1:
        raise ValueError("version must be a positive integer")
    out = dict(id=pid, name=_text(p.get("name"), 80, "vehicle name", required=True),
               category=_text(p.get("category"), 40, "category") or "car", passenger_capacity=cap, powertrain=pt,
               energy=_text(p.get("energy"), 40, "energy") or {"BEV": "electricity", "PHEV": "fuel + electricity"}.get(pt, "fuel"),
               parameters={k: validate_record(k, params[k], stamp) for k in PARAMETERS if k in params},
               provenance=prov, version=ver)
    ua = _text(p.get("updated_at"), 40, "updated_at")
    if ua:
        out["updated_at"] = ua
    return out


def snapshot(profile: dict) -> dict:
    """The profile as frozen inside an instance (identical to the stored profile: values, units and provenance)."""
    return validate_profile(profile)


def value(profile: dict, pid: str) -> float | None:
    rec = (profile.get("parameters") or {}).get(pid)
    return None if rec is None else rec.get("value")


def required_parameters(powertrain: str, scope: str) -> list[list[str]]:
    """Alternatives (lists of parameter ids) of which at least one must be complete for the given scope; an empty
    alternative means nothing is needed (a battery-electric vehicle has no tailpipe)."""
    if scope == "direct-intensity":
        return [[DIRECT]]
    if scope == "tailpipe":
        return {"BEV": [[]], "custom": [list(FUEL), [DIRECT]]}.get(powertrain, [list(FUEL)])
    if scope == "operational-energy":
        return {"BEV": [list(ELECTRICITY)], "PHEV": [list(FUEL) + list(ELECTRICITY)],
                "custom": [[DIRECT], list(FUEL), list(ELECTRICITY)]}.get(powertrain, [list(FUEL)])
    raise ValueError(f"unknown emission scope {scope!r}")


# ---------------------------------------------------------------- presets (versioned data files)
def presets() -> list[dict]:
    out = []
    for f in sorted(PRESETS.glob("*.json")):
        p = json.loads(f.read_text())
        p.setdefault("provenance", {}).update(kind="preset", preset_file=f.name)
        out.append(validate_profile(p))
    return out


def preset(pid: str) -> dict | None:
    return next((p for p in presets() if p["id"] == pid), None)


def default_profile() -> dict | None:
    """The preset flagged as default (``provenance.default``), else the first preset, else None."""
    ps = presets()
    return next((p for p in ps if p["provenance"].get("default")), ps[0] if ps else None)


# ---------------------------------------------------------------- researcher's saved profiles
class VehicleStore:
    """Vehicle profiles of one researcher (``<workspace>/vehicles.json``). Profiles are never deleted by the
    application; editing bumps ``version`` and ``updated_at``."""

    def __init__(self, root: Path):
        self.file = Path(root) / "vehicles.json"

    def _load(self) -> list[dict]:
        if not self.file.exists():
            return []
        try:
            return json.loads(self.file.read_text()).get("profiles", [])
        except (OSError, ValueError):
            return []

    def _save(self, profiles: list[dict]) -> None:
        self.file.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.file.with_suffix(f".tmp{os.getpid()}")
        tmp.write_text(json.dumps(dict(profiles=profiles), indent=1, sort_keys=True))
        os.replace(tmp, self.file)

    def list(self) -> list[dict]:
        return self._load()

    def get(self, pid: str) -> dict | None:
        return next((p for p in self._load() if p["id"] == pid), None)

    def put(self, profile: dict) -> dict:
        """Create or update (same id): the stored version is bumped and the researcher's values are kept exactly."""
        p = validate_profile(profile, stamp=True)
        if p["provenance"].get("kind") == "preset":                # a saved copy of a preset is the researcher's
            p["provenance"] = dict(p["provenance"], kind="researcher", preset_id=p["provenance"].get("preset_id", p["id"]))
        ps = self._load()
        old = next((x for x in ps if x["id"] == p["id"]), None)
        p["version"] = (old["version"] + 1) if old else 1
        p["updated_at"] = _now()
        ps = [p if x["id"] == p["id"] else x for x in ps] if old else ps + [p]
        if len(ps) > MAX_PROFILES:
            raise ValueError(f"at most {MAX_PROFILES} vehicle profiles per workspace")
        self._save(ps)
        return p

    def duplicate(self, pid: str, new_id: str | None = None) -> dict:
        src = self.get(pid) or preset(pid)
        if src is None:
            raise KeyError("vehicle profile not found")
        ids = {p["id"] for p in self._load()}
        nid = new_id or f"{pid}-copy"
        n = 2
        while nid in ids:
            nid, n = f"{pid}-copy{n}", n + 1
        copy = dict(src, id=nid, name=f"{src['name']} (copy)",
                    provenance=dict(kind="researcher", derived_from=pid, derived_version=src.get("version", 1)))
        copy.pop("version", None); copy.pop("updated_at", None)
        return self.put(copy)
