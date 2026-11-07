"""Geographic API: road networks, routing preview, open-data ingestion, scenario library, route playback.

Fetching a road network and ingesting an open-data release contact external services and create shared installation
resources: administrators only, as background jobs (progress, cancellation, trace). Every signed-in user can use the
stored networks and datasets and manages scenarios in their own workspace.
"""
from __future__ import annotations

import re
import threading
import time
from collections import OrderedDict

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .. import registry
from ..geo import playback as PB
from ..geo import scenarios as SC
from ..geo.osm import NetworkStore, fetch_overpass, validate_bbox
from ..hashing import sha256
from ..integrations import rpc
from ..store import BenchError, problem_for
from .experiments import _call, ws

router = APIRouter(prefix="/api/geo")
RIDE = "public-ride-matching"
_nets: "OrderedDict[str, object]" = OrderedDict()
_nets_lock = threading.Lock()
_releases: dict = {}


def _admin(request: Request):
    ses = request.state.session
    if ses is None or not ses.is_admin:
        raise HTTPException(403, "administrator role required")
    return ses


def _store(request: Request) -> NetworkStore:
    return NetworkStore(request.app.state.settings.data_dir)


def _rpc_root(request: Request):
    return request.app.state.settings.data_dir / "opendata" / "rpc"


def _network(request: Request, network_id: str):
    with _nets_lock:
        if network_id in _nets:
            _nets.move_to_end(network_id)
            return _nets[network_id]
    try:
        net = _store(request).load(network_id)
    except KeyError as e:
        raise HTTPException(404, str(e)) from None
    except ValueError as e:
        raise HTTPException(422, str(e)) from None
    with _nets_lock:
        _nets[network_id] = net
        while len(_nets) > 3:
            _nets.popitem(last=False)
    return net


def _job(request: Request, kind: str, subject: str, title: str, work):
    try:
        return request.app.state.jobs.start(request.state.session.username, kind, subject, work, title=title)
    except RuntimeError as e:
        raise HTTPException(409, str(e)) from None


# ---------------------------------------------------------------- configuration and networks
@router.get("/config")
def config(request: Request):
    s = request.app.state.settings
    return dict(tile_url=s.tile_url, tile_attribution=s.tile_attribution, can_manage=request.state.session.is_admin,
                networks=_store(request).list(), datasets=rpc.list_datasets(_rpc_root(request)),
                osm_licence="© OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)")


class NetworkBody(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    bbox: list[float] = Field(min_length=4, max_length=4)


@router.post("/networks")
def fetch_network(body: NetworkBody, request: Request):
    _admin(request)
    try:
        bbox = validate_bbox(body.bbox)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    store, url = _store(request), request.app.state.settings.overpass_url

    def work(mon):
        mon.event("download", f"Overpass query for {body.name}")
        raw = fetch_overpass(bbox, url)
        mon.event("build", f"{len(raw)} bytes received; building the road graph")
        prov = store.save(raw, dict(name=" ".join(body.name.split()), bbox=list(bbox)), url)
        mon.event("stored", f"network {prov['network_id']}: {prov['nodes']} nodes, {prov['edges']} edges")
    return _job(request, "osm-network", f"network/{sha256(list(bbox))[:12]}", f"Road network {body.name}", work)


@router.get("/networks/{network_id}")
def network(network_id: str, request: Request):
    net = _network(request, network_id)
    return dict(provenance=_store(request).provenance(network_id), bounds=net.bounds(), nodes=len(net))


def _pt(s: str) -> tuple[float, float]:
    m = re.fullmatch(r"\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\s*", s or "")
    if not m:
        raise HTTPException(400, "points are 'lat,lon'")
    return float(m.group(1)), float(m.group(2))


@router.get("/networks/{network_id}/route")
def route(network_id: str, a: str, b: str, request: Request):
    net = _network(request, network_id)
    (ua, da), (ub, db) = net.snap(*_pt(a)), net.snap(*_pt(b))
    try:
        r = net.route(ua, ub)
    except ValueError:
        raise HTTPException(404, "no path") from None
    return dict(r, snap_m=[da, db])


# ---------------------------------------------------------------- open data (RPC)
@router.get("/opendata/rpc/releases")
def rpc_releases(request: Request):
    if not _releases or time.time() - _releases.get("t", 0) > 3600:
        try:
            _releases.update(t=time.time(), items=rpc.list_releases())
        except Exception as e:                              # network errors are reported, not hidden
            raise HTTPException(502, f"data.gouv.fr unavailable: {type(e).__name__}") from None
    return dict(releases=_releases["items"], licence=rpc.LICENCE, producer=rpc.PRODUCER, dataset=rpc.DATASET_PAGE)


class IngestBody(BaseModel):
    release: str = Field(pattern=r"^\d{4}-\d{2}$")
    area_name: str = Field(min_length=2, max_length=80)
    bbox: list[float] = Field(min_length=4, max_length=4)


@router.post("/opendata/rpc/ingest")
def rpc_ingest(body: IngestBody, request: Request):
    _admin(request)
    try:
        bbox = validate_bbox(body.bbox)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    rel = next((r for r in rpc_releases(request)["releases"] if r["release"] == body.release), None)
    if rel is None:
        raise HTTPException(404, "release not found")
    root = _rpc_root(request)

    def work(mon):
        mon.event("download", f"streaming {rel['title']} ({rel.get('filesize')} bytes) from data.gouv.fr")
        rep = rpc.ingest(rel, bbox, " ".join(body.area_name.split()), root, progress=mon, cancel=mon.cancel)
        mon.event("stored", f"{rep['rows_kept']} trips kept of {rep['rows_read']} read; sha256 {rep['source']['sha256'][:16]}")
    return _job(request, "rpc-ingest", f"rpc/{rpc.dataset_key(body.release, bbox)}", f"RPC {body.release} · {body.area_name}", work)


@router.get("/opendata/rpc/datasets")
def rpc_datasets(request: Request):
    return dict(datasets=rpc.list_datasets(_rpc_root(request)))


# ---------------------------------------------------------------- scenario library
def _build_and_save(request: Request, scenario: dict, parent: str | None = None) -> dict:
    w = ws(request)
    try:
        sc = SC.validate_scenario(scenario)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    net = _network(request, sc["network_id"])
    prov = _store(request).provenance(sc["network_id"])
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


@router.post("/scenarios/generate")
def generate(body: GenerateBody, request: Request):
    net = _network(request, body.network_id)
    try:
        sc = SC.generate_synthetic(net, body.name, body.n_drivers, body.n_riders, body.seed, body.start_s, body.end_s, body.params)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    return _build_and_save(request, sc)


class EmpiricalBody(GenerateBody):
    dataset_key: str
    date: str | None = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")


@router.post("/scenarios/from-open-data")
def from_open_data(body: EmpiricalBody, request: Request):
    _network(request, body.network_id)
    try:
        trips, rep = rpc.load_trips(_rpc_root(request), body.dataset_key)
    except KeyError:
        raise HTTPException(404, "dataset not found") from None
    try:
        sc = SC.generate_empirical(trips, rep, body.network_id, body.name, body.n_drivers, body.n_riders, body.seed,
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
            net = _network(request, nid)
        except HTTPException:
            net = None                                      # network not installed here: straight-line geometry
    try:
        return dict(PB.plan(inst, run["decisions"], net), run_id=run_id, method_id=run["method_id"],
                    accepted=run["accepted"], metrics=run["validation"]["metrics"])
    except BenchError as e:
        raise HTTPException(e.status, str(e)) from None
