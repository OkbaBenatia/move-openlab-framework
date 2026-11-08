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
                geocoder=request.app.state.geocoder.enabled,
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


class ScenarioBody(BaseModel):
    scenario: dict
    parent: str | None = None


@router.get("/scenarios")
def scenarios(request: Request):
    return dict(scenarios=ws(request).scenarios(RIDE))


@router.post("/scenarios")
def save_scenario(body: ScenarioBody, request: Request):
    """Scenarios saved from the editor. Provenance is set here, never taken from the client: an edited version records
    its parent and keeps the parent's provenance (generator seed, open-data release, licence and attribution)."""
    prov: dict = dict(source="editor")
    if body.parent:
        parent = _call(ws(request).scenario, body.parent)
        prov.update(parent=body.parent, derived_from=parent["scenario"].get("provenance") or dict(source="editor"))
    return _build_and_save(request, dict(body.scenario, provenance=prov), body.parent)


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
    trips, rep = load_dataset(request, body.dataset_key)
    s, w, n, e = net.bounds()
    inside = [t for t in trips if s <= t["start_lat"] <= n and w <= t["start_lon"] <= e
              and s <= t["end_lat"] <= n and w <= t["end_lon"] <= e]
    if not inside:
        raise HTTPException(400, "no trip of this dataset lies inside the road network's area; choose the matching "
                                 "area or dataset")
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
        legs = (GeometryStore(request.app.state.settings.data_dir).get(inst["instance_hash"]) or {}).get("legs")
    try:
        return dict(PB.plan(inst, run["decisions"], net, legs), run_id=run_id, method_id=run["method_id"],
                    accepted=run["accepted"], metrics=run["validation"]["metrics"])
    except BenchError as e:
        raise HTTPException(e.status, str(e)) from None
