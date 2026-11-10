"""Geographic API: stored road networks, routing, scenario library, instances, route playback.

Areas, place search and network downloads are in :mod:`.areas`; trip datasets in :mod:`.datasets`. Road networks are
shared, content-addressed installation resources; scenarios, areas and uploaded datasets belong to the researcher's
workspace.
"""
from __future__ import annotations

import re
import threading
from collections import OrderedDict

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .. import registry
from ..datasets import DatasetStore
from ..geo import playback as PB
from ..geo.geometry import GeometryStore
from ..geo import scenarios as SC
from ..geo.osm import PROFILES, NetworkStore
from ..hashing import sha256
from ..integrations import rpc
from ..store import BenchError, problem_for
from .experiments import _call, ws

router = APIRouter(prefix="/api/geo")
RIDE = "public-ride-matching"
_nets: "OrderedDict[str, object]" = OrderedDict()
_nets_lock = threading.Lock()


def require_fetch_permission(request: Request) -> None:
    ses = request.state.session
    if request.app.state.settings.external_fetch == "admin" and not ses.is_admin:
        raise HTTPException(403, "downloads from public services are restricted to administrators on this installation")


def store(request: Request) -> NetworkStore:
    return NetworkStore(request.app.state.settings.data_dir)


def rpc_root(request: Request):
    return request.app.state.settings.data_dir / "opendata" / "rpc"


def network(request: Request, network_id: str):
    with _nets_lock:
        if network_id in _nets:
            _nets.move_to_end(network_id)
            return _nets[network_id]
    try:
        net = store(request).load(network_id)
    except KeyError as e:
        raise HTTPException(404, str(e)) from None
    except ValueError as e:
        raise HTTPException(422, str(e)) from None
    with _nets_lock:
        _nets[network_id] = net
        while len(_nets) > 3:
            _nets.popitem(last=False)
    return net


def start_job(request: Request, kind: str, subject: str, title: str, work):
    try:
        return request.app.state.jobs.start(request.state.session.username, kind, subject, work, title=title)
    except RuntimeError as e:
        raise HTTPException(409, str(e)) from None


# ---------------------------------------------------------------- configuration and networks
@router.get("/config")
def config(request: Request):
    s = request.app.state.settings
    return dict(tile_url=s.tile_url, tile_attribution=s.tile_attribution, can_manage=request.state.session.is_admin,
                can_fetch=s.external_fetch == "researcher" or request.state.session.is_admin,
                geocoder=request.app.state.geocoder.enabled, geocoding=request.app.state.geocoder.describe(),
                profiles=[dict(id=k, label=v["label"], max_bbox_deg2=v["max_bbox_deg2"]) for k, v in PROFILES.items()],
                networks=store(request).list(), datasets=rpc.list_datasets(rpc_root(request)),
                osm_licence="© OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)")


@router.get("/networks/{network_id}")
def network_info(network_id: str, request: Request):
    net = network(request, network_id)
    return dict(provenance=store(request).provenance(network_id), bounds=net.bounds(), nodes=len(net))


@router.get("/networks/{network_id}/coverage")
def coverage(network_id: str, request: Request):
    return dict(network(request, network_id).coverage(), provenance=store(request).provenance(network_id))


def _pt(s: str) -> tuple[float, float]:
    m = re.fullmatch(r"\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\s*", s or "")
    if not m:
        raise HTTPException(400, "points are 'lat,lon'")
    return float(m.group(1)), float(m.group(2))


@router.get("/networks/{network_id}/route")
def route(network_id: str, a: str, b: str, request: Request):
    net = network(request, network_id)
    try:
        (ua, da), (ub, db) = net.snap(*_pt(a)), net.snap(*_pt(b))
    except ValueError as e:
        raise HTTPException(404, str(e)) from None
    if ua == ub:                                       # a one-point "route" would draw nothing: refuse it explicitly
        raise HTTPException(400, "origin and destination snap to the same road node: place them further apart")
    for what, dist in (("origin", da), ("destination", db)):   # the same limit as scenarios: no route from off-network points
        if dist > SC.MAX_SNAP_M:
            raise HTTPException(400, f"{what} is {dist:.0f} m from the road network (limit {SC.MAX_SNAP_M:.0f} m)")
    try:
        r = net.route(ua, ub)
    except ValueError as e:
        raise HTTPException(404, str(e)) from None
    return dict(r, snap_m=[da, db])


# ---------------------------------------------------------------- scenario library
def _build_and_save(request: Request, scenario: dict, parent: str | None = None) -> dict:
    w = ws(request)
    try:
        sc = SC.validate_scenario(scenario)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    net = network(request, sc["network_id"])
    prov = store(request).provenance(sc["network_id"])
    iid = "geo-" + re.sub(r"[^a-z0-9]+", "-", sc["name"].lower()).strip("-")[:40] + "-" + sha256(sc)[:8]
    try:
        inst = SC.build_instance(sc, net, prov, iid)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    rec = _call(w.save_scenario, registry.get(RIDE), sc, inst, parent)
    return dict(rec, summary=SC.summary(inst))


class ComposeBody(BaseModel):
    """A scenario described by its source: regenerated deterministically from a seed (synthetic, dataset) or given
    explicitly (manual). Vehicles and emissions are optional mobility data (see ``mobility``)."""
    source: str = Field(pattern="^(synthetic|dataset|manual)$")
    network_id: str = Field(min_length=8, max_length=64)
    name: str = Field("New scenario", min_length=3, max_length=120)
    n_drivers: int = Field(10, ge=1, le=100)
    n_riders: int = Field(15, ge=1, le=100)
    seed: int = Field(1, ge=0, le=1_000_000)
    start_s: int = Field(25200, ge=0, le=172800)
    end_s: int = Field(32400, ge=1, le=172800)
    params: dict | None = None
    min_trip_m: float = Field(1500.0, ge=200, le=50_000)
    dataset_key: str | None = Field(None, max_length=120)
    date: str | None = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    drivers: list[dict] | None = Field(None, max_length=200)
    riders: list[dict] | None = Field(None, max_length=200)
    vehicles: dict | None = None
    emissions: dict | None = None
    relocate_seed: int | None = Field(None, ge=0, le=1_000_000)    # manual: new places for the given participants


class ScenarioBody(BaseModel):
    scenario: dict
    parent: str | None = None
    basis: ComposeBody | None = None            # the composition a wizard scenario started from (keeps its provenance)
    from_instance: str | None = Field(None, pattern=r"^[0-9a-f]{64}$")   # an experiment's frozen scenario it edits


def _trips_inside(request: Request, net, key: str) -> tuple[list[dict], dict]:
    trips, rep = load_dataset(request, key)
    s, w, n, e = net.bounds()
    inside = [t for t in trips if s <= t["start_lat"] <= n and w <= t["start_lon"] <= e
              and s <= t["end_lat"] <= n and w <= t["end_lon"] <= e]
    if not inside:
        raise HTTPException(400, "no trip of this dataset lies inside the road network's area; choose the matching "
                                 "area or dataset")
    return inside, rep


def _compose(request: Request, b: ComposeBody) -> dict:
    """The (unsaved) scenario a composition yields."""
    net = network(request, b.network_id)
    try:
        if b.source == "synthetic":
            sc = SC.generate_synthetic(net, b.name, b.n_drivers, b.n_riders, b.seed, b.start_s, b.end_s, b.params, b.min_trip_m)
        elif b.source == "dataset":
            if not b.dataset_key:
                raise HTTPException(400, "dataset_key is required")
            inside, rep = _trips_inside(request, net, b.dataset_key)
            sc = SC.generate_empirical(inside, rep, b.network_id, b.name, b.n_drivers, b.n_riders, b.seed, b.start_s,
                                       b.end_s, b.params, b.date)
        else:
            drivers, riders, prov = b.drivers or [], b.riders or [], dict(source="editor")
            if b.relocate_seed is not None:      # "Randomize locations": ids and time windows kept, places re-drawn
                drivers, riders = SC.relocate(net, drivers, riders, b.relocate_seed, b.min_trip_m)
                prov["locations"] = dict(generator=SC.RELOCATE_GENERATOR, seed=b.relocate_seed, min_trip_m=b.min_trip_m)
            sc = dict(name=b.name, network_id=b.network_id, params=b.params or dict(SC.DEFAULT_PARAMS),
                      drivers=drivers, riders=riders, provenance=prov)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    if b.vehicles:
        sc["vehicles"] = b.vehicles
    if b.emissions:
        sc["emissions"] = b.emissions
    return sc


def _edited_agents(base: dict, sc: dict) -> list[str]:
    """Ids whose place or window differ between the composed scenario and the one being saved (added or removed too).
    Both sides are compared in their validated form (coordinates rounded as stored), so a scenario saved as it was
    previewed lists no edit."""
    def pt(v):                                  # the rounding validate_scenario applies before storing
        try:
            return [round(float(v[0]), 6), round(float(v[1]), 6)]
        except (TypeError, ValueError, IndexError):
            return v
    norm = lambda a: dict(a, origin=pt(a.get("origin")), destination=pt(a.get("destination")))   # noqa: E731
    base = {r: [norm(a) for a in base.get(r) or []] for r in ("drivers", "riders")}
    sc = {r: [norm(a) for a in sc.get(r) or [] if isinstance(a, dict)] for r in ("drivers", "riders")}
    keys = ("origin", "destination", "earliest", "latest")
    out = []
    for role in ("drivers", "riders"):
        ref = {a["id"]: a for a in base.get(role) or []}
        cur = {str(a.get("id")): a for a in sc.get(role) or []}
        out += [i for i in sorted(set(ref) ^ set(cur))]
        out += [i for i in sorted(set(ref) & set(cur)) if any(ref[i].get(k) != cur[i].get(k) for k in keys)]
    return out


@router.get("/scenarios")
def scenarios(request: Request):
    out = ws(request).scenarios(RIDE)
    for s in out:
        s["category"] = "Edited" if s.get("parent") else "Generated"
    return dict(scenarios=out)


@router.post("/scenarios")
def save_scenario(body: ScenarioBody, request: Request):
    """Scenarios saved from the wizard. Provenance is set here, never taken from the client: a scenario composed from
    a generator or a dataset keeps that provenance (seed, release, licence, attribution) plus the list of agents the
    researcher edited; an edited version records its parent and keeps the parent's provenance."""
    prov: dict = dict(source="editor")
    # a generator, a dataset or randomized locations: recomputed here, so the recorded seed matches the saved places
    # (participants moved by hand afterwards are listed as edited)
    if body.basis is not None and (body.basis.source != "manual" or body.basis.relocate_seed is not None):
        base = _compose(request, body.basis)
        prov = dict(base["provenance"])
        edited = _edited_agents(base, body.scenario)
        if edited:
            prov.update(edited_agents=edited[:50], edited_in="wizard")
    if body.parent:
        parent = _call(ws(request).scenario, body.parent)
        prov.update(parent=body.parent, derived_from=parent["scenario"].get("provenance") or dict(source="editor"))
    elif body.from_instance:                    # a new version of an experiment's frozen scenario (never overwritten)
        frozen = instance(body.from_instance, request)          # same access rule: used by one of the user's records
        prov.update(derived_from_instance=body.from_instance, derived_from=frozen.get("provenance") or dict(source="editor"))
    return _build_and_save(request, dict(body.scenario, provenance=prov), body.parent)


@router.post("/scenarios/preview")
def preview(body: ComposeBody, request: Request):
    """What a composition yields (participants, compatible pairs, snapping) — nothing is stored."""
    sc = _compose(request, body)
    try:
        sc = SC.validate_scenario(sc)
        inst = SC.build_instance(sc, network(request, sc["network_id"]), store(request).provenance(sc["network_id"]), "preview")
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    agents = [dict(id=a["id"], role=role, direct_s=a["direct_s"], direct_m=a["direct_m"], snap_m=a["snap_m"],
                   vehicle=(a.get("vehicle") or {}).get("id"))
              for role in ("drivers", "riders") for a in inst[role]]
    return dict(scenario=sc, summary=SC.summary(inst), agents=agents, riders_with_option=SC.summary(inst)["riders_with_option"])


class GenerateBody(BaseModel):
    network_id: str
    name: str = Field(min_length=3, max_length=120)
    n_drivers: int = Field(ge=1, le=100)
    n_riders: int = Field(ge=1, le=100)
    seed: int = Field(ge=0, le=1_000_000)
    start_s: int = Field(ge=0, le=172800)
    end_s: int = Field(ge=1, le=172800)
    params: dict | None = None
    min_trip_m: float = Field(1500.0, ge=200, le=50_000)


@router.post("/scenarios/generate")
def generate(body: GenerateBody, request: Request):
    net = network(request, body.network_id)
    try:
        sc = SC.generate_synthetic(net, body.name, body.n_drivers, body.n_riders, body.seed, body.start_s, body.end_s,
                                   body.params, body.min_trip_m)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    return _build_and_save(request, sc)


class DatasetScenarioBody(GenerateBody):
    dataset_key: str
    date: str | None = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")


def load_dataset(request: Request, key: str) -> tuple[list[dict], dict]:
    """Trips and report of a shared RPC dataset or of a dataset in the caller's own workspace."""
    try:
        if key.startswith("u-"):
            return DatasetStore(ws(request).root).load(key)
        return rpc.load_trips(rpc_root(request), key)
    except KeyError:
        raise HTTPException(404, "dataset not found") from None


@router.post("/scenarios/from-dataset")
def from_dataset(body: DatasetScenarioBody, request: Request):
    net = network(request, body.network_id)
    inside, rep = _trips_inside(request, net, body.dataset_key)
    try:
        sc = SC.generate_empirical(inside, rep, body.network_id, body.name, body.n_drivers, body.n_riders, body.seed,
                                   body.start_s, body.end_s, body.params, body.date)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    return _build_and_save(request, sc)


@router.get("/scenarios/{sid}")
def scenario(sid: str, request: Request):
    w = ws(request)
    rec = _call(w.scenario, sid)
    inst = w.inst.get_instance(rec["instance_hash"])
    return dict(rec, instance=inst, summary=SC.summary(inst))


@router.get("/instances/{instance_hash}")
def instance(instance_hash: str, request: Request):
    """An instance used by one of the user's campaigns or library scenarios (for maps)."""
    w = ws(request)
    allowed = {s["instance_hash"] for s in w.scenarios()} | {
        h for c in w.list() for h in _call(w.get, c["campaign_id"])["scenario_set"]["instance_hashes"]}
    if instance_hash not in allowed:
        raise HTTPException(404, "instance not found in this workspace")
    return w.inst.get_instance(instance_hash)


# ---------------------------------------------------------------- playback
@router.get("/playback/{cid}/{run_id}")
def playback(cid: str, run_id: str, request: Request):
    w = ws(request)
    c = _call(w.get, cid)
    if _call(problem_for, c).problem_id != RIDE:
        raise HTTPException(400, "route playback is available for ride-matching campaigns")
    run = next((r for r in c["runs"] if r.get("run_id") == run_id), None)
    if run is None:
        raise HTTPException(404, "run not found")
    inst = w.inst.get_instance(run["instance_hash"])
    nid = (inst.get("network") or {}).get("network_id")
    net = None
    if nid:
        try:
            net = network(request, nid)
        except HTTPException:
            net = None                                      # network not installed here
    legs = None
    if net is None:                                         # replay geometry imported with a bundle, else straight lines
        legs = (GeometryStore(w.root).get(inst["instance_hash"]) or {}).get("legs")
    try:
        return dict(PB.plan(inst, run["decisions"], net, legs), run_id=run_id, method_id=run["method_id"],
                    accepted=run["accepted"], metrics=run["validation"]["metrics"])
    except BenchError as e:
        raise HTTPException(e.status, str(e)) from None
