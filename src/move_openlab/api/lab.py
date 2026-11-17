"""Workspace (map-first interface) API: per-user preferences, the shipped demonstration, experiment summaries.

  GET  /api/lab/state                 preferences and demonstration status of the signed-in user
  PUT  /api/lab/preferences           update preferences (known keys only)
  POST /api/lab/demo                  import the demonstration into the user's workspace (verified import, idempotent)
  GET  /api/lab/experiments           the user's experiments with their area references (for filtering)
  GET  /api/lab/experiments/{cid}     one experiment as the workspace shows it: context, scenarios, results,
                                      comparability with its parent, reproduction verdict, runs to replay
  POST /api/lab/run                   Save & Run of the wizard: store the scenario, create the experiment, start it
  GET  /api/lab/diff                  A/B comparison of two experiments: assignments, served riders, metrics, emissions
  GET/PUT /api/lab/vehicles           vehicle profiles: presets, the researcher's own, parameters and emission options

Every summary is computed from the locked or stored records; nothing here changes an experiment.
"""
from __future__ import annotations

import json
import math
import re
import threading

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator

from .. import bundles, custom_metrics, demo, samples
from ..analysis.common import SCOPE_FULL, SCOPE_REDUCED, SCOPE_TIME_LIMIT, by_cell, med
from ..analysis.compare import compare, compare_members
from ..analysis import ml_evaluation as ML
from ..ml_evidence import EvidenceStore, stored_bytes
from ..analysis.reproducibility import reproducibility
from ..analysis.semantic import semantic_compare
from ..datasets import DatasetStore
from ..geo.areas import AREA_ID, AreaStore
from ..hashing import sha256_bytes
from ..integrations import rpc
from ..mobility import emissions as E
from ..mobility import vehicles as V
from ..store import MAX_BUNDLE_BYTES, BenchError, _write, display_title, now, problem_for
from .experiments import _call, _problem, ws
from .geo import RIDE, ComposeBody, ScenarioBody
from .geo import store as network_store
from .geo import save_scenario as geo_save_scenario
from .geo import inspect_package as inspect_scenario_package, library_entry
from .. import scenario_packages

router = APIRouter(prefix="/api/lab")
PREFS = "preferences.json"
_prefs_lock = threading.Lock()                # preference files are read-modify-written
CID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
CATEGORY = {"reproduction": "Reproduced", "variant": "Edited", "extended": "Edited", "threshold-study": "Edited"}


def category_of(kind: str, imported: bool, is_demo: bool) -> str:
    """Demo · Imported · Generated · Edited · Reproduced (how the record came into this workspace)."""
    return "Demo" if is_demo else "Imported" if imported else CATEGORY.get(kind, "Generated")


GROUP = {"Demo": "demo", "Imported": "imported", "Reproduced": "reproduction"}


def group_of(category: str, synthetic: bool) -> str:
    """Experiment-picker group: the public demonstration, benchmarks (problems without geography), reproductions,
    imported experiments, the researcher's own experiments."""
    if category == "Demo":
        return "demo"
    if synthetic:
        return "benchmark"
    return GROUP.get(category, "mine")


def validation_of(c: dict) -> dict:
    """Independent validation of one record: how many runs the validator accepted (not a reproduction claim)."""
    return dict(runs=len(c["runs"]), accepted=sum(1 for r in c["runs"] if r.get("accepted")),
                validator_version=(c.get("spec") or {}).get("validator_version"))


def _prefs(w) -> dict:
    f = w.root / PREFS
    try:
        return json.loads(f.read_text()) if f.exists() else {}
    except (OSError, ValueError):
        return {}


class MapViewBody(BaseModel):
    center: tuple[float, float]
    zoom: int = Field(ge=0, le=22)

    @field_validator("center")
    @classmethod
    def _on_earth(cls, c):
        if not (-90 <= c[0] <= 90 and -180 <= c[1] <= 180):
            raise ValueError("center outside latitude/longitude ranges")
        return c


class WorkspaceView(BaseModel):
    """What the Workspace showed for the last experiment: restored when the researcher comes back to it."""
    campaign_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
    instance_hash: str = Field("", pattern=r"^([0-9a-f]{64})?$")
    methods: list[str] = Field(default_factory=list, max_length=200)
    result: str = Field("", max_length=300)
    scope: str = Field("scenario", pattern=r"^(scenario|all)$")
    map: MapViewBody | None = None

    @field_validator("methods")
    @classmethod
    def _keys(cls, ms):
        if not all(isinstance(m, str) and 0 < len(m) <= 200 and re.match(r"^[A-Za-z0-9._:@+-]+$", m) for m in ms):
            raise ValueError("invalid method key")
        return ms


class PrefsBody(BaseModel):
    tour_dismissed: bool | None = None
    start_dismissed: bool | None = None                              # the first-use "start here" card
    details_open: bool | None = None                                 # Workspace: "Experiment details" expanded
    theme: str | None = Field(None, pattern=r"^(light|dark)$")       # appearance; light unless the user chooses dark
    language: str | None = Field(None, pattern=r"^(en|fr)$")         # interface language kept for the account
    metrics: dict[str, list[str]] | None = Field(None, max_length=40)   # {problem id: metric ids shown in tables and charts}
    last_experiment: str | None = Field(None, max_length=128)
    area_id: str | None = Field(None, max_length=64)
    hidden_ids: list[str] | None = Field(None, max_length=1000)     # records hidden from lists (never deleted)
    workspace: WorkspaceView | None = None                            # scenario, methods, result and map of the last view


@router.get("/state")
def state(request: Request):
    w = ws(request)
    p = _prefs(w)
    # "installed" means *this* demonstration (by bundle digest): a newer shipped demonstration is imported next to the
    # previous one, which stays in the workspace (nothing is ever deleted)
    installed = demo.available() and p.get("demo_installed") == sha256_bytes(demo.bundle_bytes())
    if installed and p.get("demo_area"):
        _attach_demo_network(request, w, p["demo_area"])
    return dict(preferences={k: p.get(k) for k in ("tour_dismissed", "start_dismissed", "details_open", "theme", "language", "metrics", "last_experiment", "area_id", "workspace")}
                | dict(hidden_ids=p.get("hidden_ids") or []),
                demo=dict(available=demo.available(), installed=installed, campaigns=p.get("demo_campaigns") or [],
                          area=p.get("demo_area")),
                sample=_sample_state(p),
                sample_scenario=_sample_scenario_state(w),
                sample_trips=({k: samples.trips_info().get(k) for k in ("filename", "title", "rows", "bytes", "sha256", "format",
                                                                         "mapping", "synthetic", "licence", "source")}
                              if samples.trips_available() else None))


def _sample_scenario_state(w) -> dict:
    """The public sample scenario package and, when it is in this account's library, its library entry."""
    if not samples.scenario_available():
        return dict(available=False)
    i = samples.scenario_info()
    return dict(available=True, title=i.get("title"), filename=samples.SCENARIO_FILENAME, bytes=i.get("packed_bytes"),
                sha256=i.get("packed_sha256"), format=i.get("format"), drivers=i.get("drivers"), riders=i.get("riders"),
                pairs=i.get("pairs"), instance_hash=i.get("instance_hash"), licences=i.get("licences") or [],
                experiment_filename=samples.EXPERIMENT_EXAMPLE,
                scenario_id=library_entry(w, i.get("problem_id") or RIDE, i.get("instance_hash") or ""))


def _sample_state(p: dict) -> dict:
    """The public sample bundle is offered only when it ships with a successful cross-installation check."""
    if not samples.available():
        return dict(available=False)
    i = samples.info()
    return dict(available=True, title=i.get("title"), filename=samples.FILENAME, bytes=i.get("packed_bytes"),
                sha256=i.get("packed_sha256"), format=i.get("format"), runs=i.get("runs"), scenarios=i.get("scenarios"),
                check=dict(checked_at=i["check"]["checked_at"], reproduction=i["check"]["reproduction"]),
                imported=p.get("sample_imported") == i.get("packed_sha256"), campaign_id=i.get("campaign_id"))


@router.get("/sample/bundle")
def sample_bundle(request: Request):
    """Download the public sample bundle (the exact bytes that "Try an imported experiment" imports)."""
    ws(request)
    if not samples.available():
        raise HTTPException(404, "the sample bundle is not available in this installation")
    return Response(samples.bundle_bytes(), media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="{samples.FILENAME}"'})


@router.get("/sample/trips")
def sample_trips(request: Request):
    """Download the public sample trip dataset (CSV). Import it under Data setup › Mobility data like any CSV file."""
    ws(request)
    if not samples.trips_available():
        raise HTTPException(404, "the sample trip dataset is not available in this installation")
    return Response(samples.trips_bytes(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{samples.trips_info()["filename"]}"'})


@router.post("/sample/verify")
def verify_sample(request: Request):
    """Verify the sample bundle without importing it (the report of the import's integrity checks)."""
    if not samples.available():
        raise HTTPException(404, "the sample bundle is not available in this installation")
    return _call(ws(request).verify_bundle, samples.bundle_bytes())[0]


@router.post("/sample")
def import_sample(request: Request):
    """Import the public sample bundle through the normal, fully verified import path; returns the verification report."""
    if not samples.available():
        raise HTTPException(404, "the sample bundle is not available in this installation")
    w = ws(request)
    rep = _call(w.import_bundle, samples.bundle_bytes())
    with _prefs_lock:
        p = _prefs(w)
        p["sample_imported"] = rep["bundle_sha256"]
        _write(w.root / PREFS, p)
    return rep


def _require_sample_scenario() -> None:
    if not samples.scenario_available():
        raise HTTPException(404, "the sample scenario is not available in this installation")


@router.get("/sample/scenario")
def sample_scenario(request: Request):
    """Download the public sample scenario package (the exact bytes that "Try a sample › Sample scenario" imports)."""
    ws(request)
    _require_sample_scenario()
    return Response(samples.scenario_bytes(), media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="{samples.SCENARIO_FILENAME}"'})


@router.post("/sample/scenario/verify")
def verify_sample_scenario(request: Request):
    """Verify the sample scenario package without importing it."""
    _require_sample_scenario()
    return inspect_scenario_package(ws(request), samples.scenario_bytes())


@router.post("/sample/scenario")
def import_sample_scenario(request: Request):
    """Import the public sample scenario through the normal, fully verified scenario-package import."""
    _require_sample_scenario()
    return _call(ws(request).import_scenario_package, samples.scenario_bytes())


@router.put("/preferences")
def set_preferences(body: PrefsBody, request: Request):
    w = ws(request)
    upd = body.model_dump(exclude_unset=True)
    if upd.get("last_experiment") is not None and not CID.match(upd["last_experiment"]):
        raise HTTPException(400, "invalid experiment id")
    if upd.get("hidden_ids") is not None and not all(CID.match(str(x)) for x in upd["hidden_ids"]):
        raise HTTPException(400, "invalid record id")
    if upd.get("metrics") is not None:                 # merged per problem; ids are plain identifiers
        ok = all(isinstance(k, str) and len(k) <= 120 and isinstance(v, list) and len(v) <= 80
                 and all(isinstance(x, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,80}", x) for x in v) for k, v in upd["metrics"].items())
        if not ok:
            raise HTTPException(400, "invalid metric selection")
        upd["metrics"] = {**(_prefs(w).get("metrics") or {}), **upd["metrics"]}
    if upd.get("area_id"):                       # the working area (Library › Use, the area filter); "" clears it
        if not AREA_ID.match(upd["area_id"]):
            raise HTTPException(400, "invalid area id")
        try:
            AreaStore(w.root).get(upd["area_id"])
        except KeyError:
            raise HTTPException(404, "area not found") from None
    with _prefs_lock:
        p = _prefs(w)
        p.update(upd)
        _write(w.root / PREFS, p)
    return state(request)


@router.post("/demo")
def install_demo(request: Request):
    """Import the demonstration once into this workspace. Re-running it is harmless: identical campaigns are kept."""
    if not demo.available():
        raise HTTPException(404, "no demonstration is shipped with this installation")
    w = ws(request)
    rep = _call(w.import_bundle, demo.bundle_bytes())
    camps = [c["campaign_id"] for c in rep["campaigns_verified"]]
    # first use opens the baseline (the start of the lineage); its controlled variant is one click away (Compare)
    first = next((x["campaign_id"] for x in demo.manifest().get("lineage") or [] if not x.get("parent") and x["campaign_id"] in camps),
                 rep["root_campaign_id"])
    with _prefs_lock:
        p = _prefs(w)
        area = p.get("demo_area") or _demo_area(request, w)
        p.update(demo_installed=rep["bundle_sha256"], demo_campaigns=sorted(set(p.get("demo_campaigns") or []) | set(camps)),
                 demo_area=area or "")          # "" = tried, no area (never retried on every visit)
        if not p.get("last_experiment"):                 # a returning user keeps the experiment they had open
            p["last_experiment"] = first
        _write(w.root / PREFS, p)
    return dict(installed=True, campaigns=camps, root_campaign_id=rep["root_campaign_id"], baseline_id=first, area_id=area)


def _demo_area(request: Request, w) -> str | None:
    """The demonstration's area in this workspace, so that Generate starts there and its participants can be edited: an
    existing area on the same box and profile is reused, otherwise one is added once with the shipped box. Its road
    network is the original one the scenarios were built on, stored from the copy shipped with the installation. Never
    recreated after the user removes it."""
    net = demo.network_ref()
    if not net or not net.get("bbox"):
        return None
    areas, prof = AreaStore(w.root), net.get("profile") or "car"
    box = [round(x, 5) for x in net["bbox"]]
    nid = _demo_network(request)
    listed = areas.list()
    for a in listed:
        if a.get("network_id") == net["network_id"]:
            return a["area_id"]
    for a in listed:
        if a["bbox"] == box and a["profile"] == prof:
            if not a.get("network_id") and nid:
                areas.attach(a["area_id"], nid)
            return a["area_id"]
    try:
        hit = None if nid else network_store(request).find(box, prof)
        return areas.create(demo.AREA_LABEL, box, prof, dict(name=demo.AREA_LABEL, kind="demonstration"),
                            nid or (hit["network_id"] if hit else None))["area_id"]
    except ValueError:                                 # area limit reached: the demonstration still works without it
        return None


def _demo_network(request: Request) -> str | None:
    """The demonstration's original road network, stored in this installation (from the shipped copy) if needed."""
    try:
        return demo.install_network(network_store(request))
    except (OSError, ValueError, KeyError):            # never blocks the demonstration; the wizard explains a missing network
        return None


def _attach_demo_network(request: Request, w, area_id: str) -> None:
    """A demonstration area added without a road network (by an earlier version) gets the original one."""
    net = demo.network_ref()
    try:
        a = AreaStore(w.root).get(area_id)
    except (KeyError, ValueError, OSError):
        return
    if net and not a.get("network_id") and a["bbox"] == [round(x, 5) for x in net.get("bbox") or []] \
            and a["profile"] == (net.get("profile") or "car"):
        nid = _demo_network(request)
        if nid:
            AreaStore(w.root).attach(area_id, nid)


def _refs(w, c: dict) -> tuple[list[str], list[str]]:
    """Road networks and datasets the experiment's instances were built from (for filtering by area or dataset)."""
    nids, keys = [], []
    for h in c["scenario_set"]["instance_hashes"]:
        inst = w.inst.get_instance(h)
        nid = (inst.get("network") or {}).get("network_id")
        key = (inst.get("provenance") or {}).get("dataset_key")
        if nid and nid not in nids:
            nids.append(nid)
        if key and key not in keys:
            keys.append(key)
    return nids, keys


@router.get("/experiments")
def experiments(request: Request):
    """Every experiment of the workspace with the short context the experiment picker shows (area, mobility data,
    scenarios, problem, methods, status, validation) — no hashes."""
    w = ws(request)
    p = _prefs(w)
    demo_ids = set(p.get("demo_campaigns") or [])
    hidden = set(p.get("hidden_ids") or [])
    areas = {a.get("network_id"): a["name"] for a in AreaStore(w.root).list() if a.get("network_id")}
    areas.update({k: v for k, v in demo.network_labels().items() if k not in areas})
    out = []
    for e in w.list():
        try:
            c = w.get(e["campaign_id"])
            nids, keys = _refs(w, c)
            problem = problem_for(c)
            first = w.inst.get_instance(c["scenario_set"]["instance_hashes"][0]) if c["scenario_set"]["instance_hashes"] else {}
        except (BenchError, KeyError, OSError, ValueError, IndexError):   # an unreadable record never hides the others
            continue
        cat = category_of(e["kind"], e["imported"], e["campaign_id"] in demo_ids)
        prov = first.get("provenance") or {}
        n = len(c["scenario_set"]["instance_hashes"])
        out.append(dict(campaign_id=e["campaign_id"], title=display_title(e["title"]), kind=e["kind"], status=e["status"],
                        problem_id=e["problem_id"], imported=e["imported"], locked=bool(e["checksum"]),
                        created_at=e["created_at"], owner_display=e["owner_display"],
                        parent=(e.get("parent") or {}).get("campaign_id"), demo=e["campaign_id"] in demo_ids,
                        category=cat, group=group_of(cat, problem.synthetic),
                        hidden=e["campaign_id"] in hidden, network_ids=nids, dataset_keys=keys,
                        area=next((areas[x] for x in nids if x in areas), None),
                        data=_dataset_label(request, w, prov), sampled=prov.get("source") in ("open-data", "dataset"),
                        scenarios=n, problem=problem.title, synthetic=problem.synthetic,
                        methods=[m.get("name") or m["method_id"] for m in c["methods"]], validation=validation_of(c)))
    return dict(experiments=out)


def _area_label(request: Request, w, nid: str | None) -> dict:
    if not nid:
        return dict(label=None, network_id=None)
    for a in AreaStore(w.root).list():
        if a.get("network_id") == nid:
            return dict(label=a["name"], network_id=nid, area_id=a["area_id"], bbox=a["bbox"])
    if nid in demo.network_labels():
        return dict(label=demo.network_labels()[nid], network_id=nid)
    from ..geo.osm import NetworkStore
    try:
        box = (NetworkStore(request.app.state.settings.data_dir).provenance(nid).get("area") or {}).get("bbox")
    except KeyError:
        box = None
    return dict(label=rpc.area_label(box) if box else None, network_id=nid, bbox=box)


def _dataset_label(request: Request, w, prov: dict) -> str | None:
    if prov.get("source") == "open-data" and prov.get("release"):
        return f"RPC open data {prov['release']}"
    if prov.get("source") == "dataset":
        key = prov.get("dataset_key")
        try:
            return DatasetStore(w.root).load(key)[1].get("name") if key else None
        except KeyError:
            return prov.get("dataset_name") or "uploaded dataset"
    if prov.get("source") == "generator":
        return "synthetic demand"
    return {"editor": "map editor"}.get(prov.get("source"), prov.get("source"))


class StudyMember(BaseModel):
    campaign_id: str = Field(min_length=3, max_length=80)
    method_id: str = Field(min_length=3, max_length=80)
    label: str | None = Field(None, max_length=120)             # display name in the study (the record keeps its own)
    note: str | None = Field(None, max_length=120)              # e.g. which policy or version this member is


class StudyBody(BaseModel):
    study_id: str | None = Field(None, max_length=80)
    title: str = Field(min_length=3, max_length=160)
    description: str = Field("", max_length=600)
    members: list[StudyMember] = Field(min_length=1, max_length=12)
    featured_instance: str | None = Field(None, pattern=r"^[0-9a-f]{64}$")


def _study_view(w, st: dict) -> dict:
    """A study with what its members are: the experiment each method comes from, and how that experiment was made."""
    members = []
    for m in st["members"]:
        c = w.get(m["campaign_id"])
        ref = next((x for x in c["methods"] if x["method_id"] == m["method_id"]), {})
        cfg = (c["config"].get("method_configs") or {}).get(m["method_id"]) or {}
        members.append(dict(m, experiment=display_title(c["title"]), locked=bool(c.get("checksum")), kind=c["kind"],
                            name=m.get("label") or problem_for(c).method_display_name(m["method_id"], cfg) or ref.get("name") or m["method_id"],
                            runs=sum(1 for r in c["runs"] if r["method_id"] == m["method_id"]),
                            imported_results=bool(c.get("result_import")), imported=bool(w.import_record(m["campaign_id"])),
                            checksum=c.get("checksum")))
    return dict(st, members=members)


@router.get("/studies")
def studies(request: Request):
    """Saved study views of this workspace (methods of several experiments shown together on the same scenarios)."""
    w = ws(request)
    return dict(studies=[_study_view(w, st) for st in w.studies()])


@router.put("/studies")
def save_study(body: StudyBody, request: Request):
    w = ws(request)
    st = _call(w.save_study, body.title, [m.model_dump(exclude_none=True) for m in body.members], body.featured_instance,
               body.description, body.study_id)
    return _study_view(w, st)


@router.delete("/studies/{study_id}")
def delete_study(study_id: str, request: Request):
    _call(ws(request).delete_study, study_id)
    return dict(ok=True)


@router.get("/experiments/{cid}")
def experiment(cid: str, request: Request, view: str = "", study: str = ""):
    """One experiment for the Workspace. ``view=records`` shows the experiment's own record lineage; by default an
    experiment that is a member of a saved study opens in that study's view (``study`` chooses one of several)."""
    w = ws(request)
    c = _call(w.get, cid)
    mine = [st for st in w.studies() if any(m["campaign_id"] == cid for m in st["members"])]
    st_view = None if view == "records" or not mine else next((x for x in mine if x["study_id"] == study), mine[0])
    problem = _call(problem_for, c)
    imp = w.import_record(cid)
    insts = [w.inst.get_instance(h) for h in c["scenario_set"]["instance_hashes"]]
    prov = (insts[0].get("provenance") or {}) if insts else {}
    nid = (insts[0].get("network") or {}).get("network_id") if insts else None
    parent = c.get("parent")
    out = dict(
        campaign=dict(campaign_id=cid, title=display_title(c["title"]), record_title=c["title"], kind=c["kind"], status=c["status"],
                      locked=bool(c.get("checksum")), owner_display=c["owner_display"], created_at=c["created_at"],
                      imported=bool(imp), imported_from=imp and imp["original_owner_display"],
                      result_import=c.get("result_import") and dict(source=(c["result_import"].get("source") or {}).get("name"),
                                                                     counts=c["result_import"].get("counts")),
                      parent=parent and dict(campaign_id=parent["campaign_id"], relation=parent["relation"],
                                             kind=parent["kind"]),
                      variant=(c.get("semantic_variant") or {}).get("description"), problem_id=problem.problem_id,
                      repetitions=c["config"]["repetitions"], emissions=c["config"].get("emissions"),
                      method_configs=c["config"].get("method_configs") or {},
                      category=category_of(c["kind"], bool(imp), cid in set(_prefs(w).get("demo_campaigns") or []))),
        context=dict(area=_area_label(request, w, nid), dataset=_dataset_label(request, w, prov),
                     scenario=f"{len(insts)} scenario{'s' if len(insts) != 1 else ''}"),
        problem=dict(title=problem.title, synthetic=problem.synthetic, metrics=[m.to_dict() for m in problem.metrics],
                     objective=[o.to_dict() for o in problem.objective], domain_metrics=problem.domain_metric_definitions(),
                     presentation=problem.presentation(), facts=problem.run_fact_definitions()),
        scenarios=[dict(instance_hash=i["instance_hash"], instance_id=i["instance_id"], name=i.get("name"),
                        derived_from=(i.get("derivation") or {}).get("parent_instance_hash"),
                        seed=(i.get("provenance") or {}).get("seed"),
                        edited=list((i.get("provenance") or {}).get("edited_agents") or []),
                        vehicles=_vehicle_summary(i), emissions=E.config_of(i, c["config"]),
                        notes=problem.scenario_notes(i), **problem.scenario_summary(i))
                   for i in insts],
        methods=[dict(method_id=m["method_id"], version=m["version"], kind=m.get("kind"), source=m["source"], recorded_name=m.get("name"),
                      name=problem.method_display_name(m["method_id"], (c["config"].get("method_configs") or {}).get(m["method_id"]) or {}) or m.get("name"))
                 for m in c["methods"]],
        validation=validation_of(c), provenance=_provenance(request, w, insts),
        runs=[], job_id=next((j["job_id"] for j in request.app.state.jobs.history(w.user, 1, subject=f"{w.user}/{cid}")), None),
        results=None, comparability=None, reproduction=None)
    out["view"] = dict(mode="study" if st_view else "records", study=st_view and _study_view(w, st_view),
                       studies=[dict(study_id=x["study_id"], title=x["title"]) for x in mine])
    if c["runs"]:
        if st_view:                                              # the study's members, each from its own experiment
            cmp = _call(compare_members, w, st_view["members"])
            pairs = {(m["campaign_id"], m["method_id"]) for m in st_view["members"]}
            sources = [w.get(x) for x in dict.fromkeys(m["campaign_id"] for m in st_view["members"])]
        else:
            cmp = _call(compare, w, cid)
            scope = {r["campaign_id"] for r in cmp["rows"]} | {cid}      # the campaigns the comparison shows
            sources = [x for x in _call(w.lineage, cid) if x["campaign_id"] in scope]
            pairs = None
        out["runs"] = [dict(run_id=r["run_id"], campaign_id=x["campaign_id"], instance_hash=r["instance_hash"],
                            method_id=r["method_id"], accepted=r["accepted"], status=r.get("status_declared"))
                       for x in sources for r in x["runs"]
                       if r.get("repetition") == 1 and (pairs is None or (x["campaign_id"], r["method_id"]) in pairs)]
        customs = _customs(w, problem, insts, cmp["rows"])
        rows = [_row(problem, insts, r, cu) for r, cu in zip(cmp["rows"], customs)]
        titles = {x["campaign_id"]: display_title(x["title"]) for x in sources}
        notes = {(m["campaign_id"], m["method_id"]): m for m in (st_view["members"] if st_view else [])}
        for r in rows:                                           # where each row comes from; a study may rename a member
            m = notes.get((r["campaign_id"], r["method_id"]), {})
            r.update(experiment=titles.get(r["campaign_id"]), note=m.get("note"), method_name=r["name"], name=m.get("label") or r["name"])
        out["results"] = dict(rows=rows, warnings=cmp["warnings"], reference=cmp["reference"], metrics=cmp["metrics"])
        if parent:
            try:
                out["comparability"] = _comparability(semantic_compare(w, parent["campaign_id"], cid))
            except (BenchError, HTTPException):
                out["comparability"] = None
        if c["kind"] == "reproduction":
            rr = _call(reproducibility, w, cid)
            out["reproduction"] = dict(reproduced=rr["numerically_reproduced"], cells=rr["cells"],
                                       agreement=rr["agreement"])
    return out


def _observed_trips(request: Request, key: str | None) -> int | None:
    """Observed trips of the source release inside the area (the ingest report), else the demonstration's record."""
    if not key:
        return None
    try:
        from .datasets import rpc_root
        return rpc.load_trips(rpc_root(request), key)[1].get("rows_kept")
    except (KeyError, OSError, ValueError, ImportError):
        return demo.OBSERVED_TRIPS.get(key)


def _licence_name(lic) -> str | None:
    return lic.get("name") if isinstance(lic, dict) else lic if isinstance(lic, str) and lic else None


def _provenance(request: Request, w, insts: list[dict]) -> dict:
    """Where the scenarios come from, kept apart from the scenarios themselves: the *source* (observed trips of an open
    data release, an uploaded file, a generator, the map editor) and how the participants were *derived* from it."""
    prov = (insts[0].get("provenance") or {}) if insts else {}
    src = prov.get("source")
    out = dict(source=src, sampled=src in ("open-data", "dataset"), release=prov.get("release"),
               # an open-data release records its licence as {id, name, url}; an uploaded file as the uploader's statement
               attribution=prov.get("attribution"), licence=_licence_name(prov.get("licence")),
               method=prov.get("method"), generator=prov.get("generator"), window=prov.get("window"),
               pool_size=prov.get("pool_size"), seeds=[(i.get("provenance") or {}).get("seed") for i in insts],
               observed_trips=_observed_trips(request, prov.get("dataset_key")) if src == "open-data" else None,
               edited=sorted({a for i in insts for a in ((i.get("provenance") or {}).get("edited_agents") or [])}))
    return out


def _customs(w, problem, insts, rows: list[dict]) -> list[tuple[dict, dict, dict]]:
    """Custom metrics of this problem for every result row, computed from validated figures (never from what a
    method reported): built-in metrics in this process, registered ones in isolation — one isolated evaluation per
    metric for all rows. Per row: (value per scenario keyed like ``per_scenario``, aggregate per metric, issues)."""
    keys, ctxs = [], []
    for ri, r in enumerate(rows):
        per = r.get("per_scenario") or {}
        for i in insts:
            h = i["instance_hash"]
            if h in per:
                keys.append((ri, h))
                ctxs.append(dict(metrics=per[h].get("metrics") or {}, domain=per[h].get("domain") or {},
                                 instance={k: len(i[k]) for k in custom_metrics.INSTANCE_KEYS if isinstance(i.get(k), list)}))
    out = [({h: {} for h in (r.get("per_scenario") or {})}, {}, {}) for r in rows]
    if not ctxs:
        return out
    for meta, ev in w.metric_evaluations(problem, ctxs):
        spec = _spec_of(meta)
        for ri in range(len(rows)):
            idx = [n for n, (rj, _) in enumerate(keys) if rj == ri]
            if not idx:
                continue
            sub = (custom_metrics.Evaluation([None] * len(idx), None, ev.issues) if ev.outputs is None
                   else custom_metrics.combine(spec, [ev.outputs[n] for n in idx]))     # this row's scenarios only
            for n, v in zip(idx, sub.per):
                out[ri][0].setdefault(keys[n][1], {})[meta["id"]] = v
            out[ri][1][meta["id"]] = sub.total
            if sub.issues:
                out[ri][2][meta["id"]] = sub.issues
    return out


def _spec_of(meta: dict):
    """Aggregation view of a metric description (no code: only ``aggregate`` and the identity are used)."""
    return custom_metrics.MetricSpec(**{k: tuple(meta[k]) if k in ("problems", "requires") else meta[k]
                                        for k in custom_metrics.METADATA_KEYS}, source=meta.get("source", "builtin"))


def _row(problem, insts, r: dict, customs: tuple[dict, dict, dict] = ({}, {}, {})) -> dict:
    sc = r.get("optimality_scope") or {}
    proven = sc.get(SCOPE_FULL, 0)
    by_scen, custom, issues = customs
    per = {h: dict(c, custom=by_scen.get(h, {})) for h, c in (r.get("per_scenario") or {}).items()}
    return dict(method_id=r["method_id"], version=r["version"], name=r["name"], kind=r["kind"], source=r["source"],
                campaign_id=r["campaign_id"], origin=r["origin"], campaign_kind=r["campaign_kind"],
                researcher=r["researcher"], scenarios=r["scenarios"], valid=r["all_feasible"],
                proven_optimal=proven, reduced_optimal=sc.get(SCOPE_REDUCED, 0), time_limited=sc.get(SCOPE_TIME_LIMIT, 0),
                facts=r.get("facts") or {}, recorded_name=r.get("recorded_name"),
                optimal=r.get("optimal"), totals=r["totals"],
                descriptive=problem.descriptive_metrics(insts, r["totals"]), domain=r.get("domain"),
                gap_pct=(r.get("final_level_gap_pct") or {}).get("mean"),
                solver_time_s=r["median_solver_time_s"], total_time_s=r["median_total_time_s"],
                mean_rank=r.get("mean_rank"), reproduction=r.get("reproduction_status"),
                repetitions=r.get("repetitions"), repetitions_consistent=r.get("repetitions_consistent"),
                per_scenario=per, custom=custom, custom_issues=issues)


def _comparability(sem: dict) -> dict:
    """Verdict per claim plus the reasons shown under "Why?". Only the candidate's own rows count (the reference's
    other methods are listed by the engine for the report but say nothing about the candidate); when no scenario of the
    candidate maps to the reference, every claim is incompatible. The emissions claim is reported only when at least
    one side carries emission data."""
    ref = sem["reference"]["campaign_id"]
    rows = [r for r in sem["rows"] if r["side"] == "candidate campaign"]
    if not rows:
        return dict(reference=ref, quality="incompatible", runtime="incompatible", emissions=None,
                    reasons=["no scenario of this experiment corresponds to a scenario of the reference"])
    claims = ("quality", "runtime") + (("emissions",) if any(r.get("emissions_applicable") for r in rows) else ())

    def verdict(claim: str) -> str:
        statuses = {r[claim]["status"] for r in rows}
        return "incompatible" if "INCOMPATIBLE" in statuses else "conditional" if "CONDITIONAL" in statuses else "direct"
    reasons = sorted({q for r in rows for cl in claims for q in r[cl]["incompatible"] + r[cl]["qualifications"]})
    return dict(reference=ref, quality=verdict("quality"), runtime=verdict("runtime"),
                emissions=verdict("emissions") if "emissions" in claims else None, reasons=reasons[:10])


def _vehicle_summary(inst: dict) -> dict | None:
    """Fleet of one scenario: profiles used (name, powertrain, drivers) and the riders' default vehicle."""
    drivers = [d for d in inst.get("drivers", []) if isinstance(d.get("vehicle"), dict)]
    if not drivers:
        return None
    fleet: dict[str, dict] = {}
    for d in drivers:
        v = d["vehicle"]
        f = fleet.setdefault(v["id"], dict(id=v["id"], name=v["name"], powertrain=v["powertrain"], energy=v.get("energy"),
                                           passenger_capacity=v.get("passenger_capacity"), drivers=0,
                                           provenance=v.get("provenance", {}).get("kind"), parameters=v.get("parameters", {})))
        f["drivers"] += 1
    default = (inst.get("vehicles") or {}).get("default") or {}
    return dict(fleet=list(fleet.values()), default=dict(id=default.get("id"), name=default.get("name")) if default else None)


# ---------------------------------------------------------------- Save & Run (wizard)
class RunBody(BaseModel):
    title: str = Field(min_length=3, max_length=160)
    methods: list[tuple[str, str]] = Field(min_length=1, max_length=20)
    repetitions: int = Field(3, ge=1, le=20)
    timeout_s: float = Field(120.0, ge=1, le=3600)
    emissions: dict | None = None
    instance_hashes: list[str] = Field(default_factory=list, max_length=500)
    scenario: dict | None = None
    basis: ComposeBody | None = None
    parent: str | None = Field(None, max_length=64)
    from_instance: str | None = Field(None, pattern=r"^[0-9a-f]{64}$")


@router.post("/run")
def run(body: RunBody, request: Request):
    """Store the scenario (when one is given), create the experiment and start its execution in one call. Nothing is
    stored before this call: the wizard's Review step is the only place that triggers it."""
    hashes = list(body.instance_hashes)
    scenario = None
    if body.scenario is not None:
        scenario = geo_save_scenario(ScenarioBody(scenario=body.scenario, parent=body.parent, basis=body.basis,
                                                  from_instance=body.from_instance), request)
        hashes.insert(0, scenario["instance_hash"])
    if not hashes:
        raise HTTPException(400, "choose or create at least one scenario")
    w = ws(request)
    c = _call(w.create_campaign, RIDE, body.title, dict(instance_hashes=hashes), [tuple(m) for m in body.methods],
              body.repetitions, body.timeout_s, emissions=body.emissions)
    cid = c["campaign_id"]
    try:
        job = request.app.state.jobs.start(w.user, "execute", f"{w.user}/{cid}", lambda mon: w.execute(cid, mon),
                                           title=c["title"])
    except RuntimeError as e:
        raise HTTPException(409, str(e)) from None
    return dict(campaign_id=cid, job=job, scenario=scenario and dict(scenario_id=scenario["scenario_id"],
                                                                    instance_hash=scenario["instance_hash"]))


# ---------------------------------------------------------------- vehicle profiles
@router.get("/vehicles")
def vehicles(request: Request):
    w = ws(request)
    return dict(presets=V.presets(), mine=V.VehicleStore(w.root).list(), default=V.default_profile(),
                parameters=[dict(id=k, **v) for k, v in V.PARAMETERS.items()], powertrains=list(V.POWERTRAINS),
                scopes=[dict(id=k, definition=v) for k, v in E.SCOPES.items()],
                baselines=[dict(id=k, definition=v) for k, v in E.BASELINES.items()], default_emissions=E.DEFAULT)


@router.put("/vehicles")
def put_vehicle(profile: dict, request: Request):
    """Create or update one of the researcher's profiles (values are kept exactly as entered; nothing is defaulted)."""
    try:
        return V.VehicleStore(ws(request).root).put(profile)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None


@router.post("/vehicles/{pid}/duplicate")
def duplicate_vehicle(pid: str, request: Request):
    if not V.ID.match(pid):
        raise HTTPException(400, "invalid vehicle id")
    try:
        return V.VehicleStore(ws(request).root).duplicate(pid)
    except KeyError as e:
        raise HTTPException(404, str(e).strip("'")) from None
    except ValueError as e:
        raise HTTPException(400, str(e)) from None


# ---------------------------------------------------------------- comparison candidates
RELATION = {"reproduces": "Reproduction", "perturbs": "Controlled variant", "extends": "Extension"}
_compat_cache: dict[tuple, dict] = {}
_compat_lock = threading.Lock()


def _relation(a: dict, b: dict, fp_a: set[str], fp_b: set[str]) -> str:
    pa, pb = a.get("parent") or {}, b.get("parent") or {}
    if pb.get("campaign_id") == a["campaign_id"]:
        return RELATION.get(pb.get("relation"), "Derived")
    if pa.get("campaign_id") == b["campaign_id"]:
        return RELATION.get(pa.get("relation"), "Derived") + " (parent)"
    if a["scenario_set"]["instance_hashes"] == b["scenario_set"]["instance_hashes"]:
        return "Same scenario"
    if fp_a & fp_b:
        return "Same problem, other file"
    return "Different scenario"


@router.get("/compatible")
def compatible(a: str, request: Request):
    """Candidates for comparing with experiment ``a``: every other executed experiment of the same problem, with its
    relation to ``a`` and the verdicts of the three claims (quality, runtime, emissions) from the semantic engine.
    Directly and conditionally comparable candidates are meant to be shown first; incompatible ones under a fold.
    Verdicts are cached per pair of records (checksums or run counts), so the picker stays instant."""
    from ..comparability.model import problem_fingerprint
    w = ws(request)
    ca = _call(w.get, a)
    problem = _call(problem_for, ca)
    if not ca["runs"]:
        raise HTTPException(400, "run the experiment before comparing it")
    fps = lambda c: {problem_fingerprint(problem, w.inst.get_instance(h), problem.objective_spec_id)["problem"]   # noqa: E731
                     for h in c["scenario_set"]["instance_hashes"]}
    fp_a = fps(ca)
    p = _prefs(w)
    hidden, demo_ids = set(p.get("hidden_ids") or []), set(p.get("demo_campaigns") or [])
    stamp = lambda c: c.get("checksum") or f"runs:{len(c['runs'])}:{c.get('completed_at')}"               # noqa: E731
    out = []
    for e in w.list(problem.problem_id):
        if e["campaign_id"] == a:
            continue
        try:
            cb = w.get(e["campaign_id"])
        except (BenchError, KeyError, OSError, ValueError):
            continue
        if not cb["runs"]:
            continue
        key = (w.user, a, stamp(ca), cb["campaign_id"], stamp(cb))
        with _compat_lock:
            verdict = _compat_cache.get(key)
        if verdict is None:
            try:
                verdict = _comparability(semantic_compare(w, a, cb["campaign_id"]))
            except (BenchError, HTTPException, RuntimeError) as x:
                verdict = dict(reference=a, quality="incompatible", runtime="incompatible", emissions=None,
                               reasons=[str(x)[:200]])
            with _compat_lock:
                if len(_compat_cache) > 5000:
                    _compat_cache.clear()
                _compat_cache[key] = verdict
        worst = "incompatible" if verdict["quality"] == "incompatible" and verdict["runtime"] == "incompatible" else \
            "conditional" if "conditional" in (verdict["quality"], verdict["runtime"]) or verdict["quality"] == "incompatible" else "direct"
        out.append(dict(campaign_id=cb["campaign_id"], title=display_title(cb["title"]), kind=cb["kind"], owner_display=cb["owner_display"],
                        validation=validation_of(cb), reproducibility=_repro_between(w, ca, cb),
                        imported=bool(w.import_record(cb["campaign_id"])), hidden=cb["campaign_id"] in hidden,
                        category=category_of(cb["kind"], bool(w.import_record(cb["campaign_id"])), cb["campaign_id"] in demo_ids),
                        relation=_relation(ca, cb, fp_a, fps(cb)), methods=[m["method_id"] for m in cb["methods"]],
                        created_at=cb["created_at"], emissions_config=cb["config"].get("emissions"),
                        quality=verdict["quality"], runtime=verdict["runtime"], emissions=verdict["emissions"],
                        overall=worst, reasons=verdict["reasons"]))
    order = {"direct": 0, "conditional": 1, "incompatible": 2}
    out.sort(key=lambda x: (order[x["overall"]], x["hidden"], x["created_at"]), reverse=False)
    # hidden records are never counted: the counts describe what the picker shows
    return dict(a=dict(campaign_id=a, title=display_title(ca["title"]), kind=ca["kind"], validation=validation_of(ca)), candidates=out,
                counts={k: sum(1 for x in out if x["overall"] == k and not x["hidden"]) for k in order},
                hidden=sum(1 for x in out if x["hidden"]))


def _repro_between(w, ca: dict, cb: dict) -> dict:
    """Reproducibility applies only when one record is the re-execution of the other; it is then measured by the
    reproducibility analysis (identical validated results per cell), never inferred from comparability."""
    pa, pb = (ca.get("parent") or {}), (cb.get("parent") or {})
    repro = cb if (cb["kind"] == "reproduction" and pb.get("campaign_id") == ca["campaign_id"]) else \
        ca if (ca["kind"] == "reproduction" and pa.get("campaign_id") == cb["campaign_id"]) else None
    if repro is None:
        return dict(applicable=False)
    try:
        rr = reproducibility(w, repro["campaign_id"])
    except (BenchError, HTTPException):
        return dict(applicable=True, reproduced=None)
    agree = rr.get("agreement") or {}
    return dict(applicable=True, reproduced=bool(rr["numerically_reproduced"]), cells=rr["cells"],
                different=agree.get("different"), identical=agree.get("identical_solution"))


# ---------------------------------------------------------------- A/B comparison
def _pick_run(c: dict, method_id: str | None, problem) -> tuple[str | None, dict]:
    """First-repetition runs of one method of a campaign: the requested one, else the reference method, else the
    first method of the campaign. ``{instance_hash: run}``."""
    mids = [m["method_id"] for m in c["methods"]]
    if method_id and method_id not in mids:
        raise HTTPException(400, f"{method_id} is not a method of {c['campaign_id']}")
    mid = method_id or (problem.reference_method[0] if problem.reference_method and problem.reference_method[0] in mids
                        else (mids[0] if mids else None))
    return mid, {k[0]: rs[0] for k, rs in by_cell([r for r in c["runs"] if r["method_id"] == mid]).items()}


def _matched_scenarios(w, problem, ca: dict, cb: dict) -> list[tuple[dict, dict]]:
    """Scenarios of A and B that describe the same situation: identical instances, one derived from the other, or
    the same optimization problem (equal problem fingerprint, e.g. other vehicle or emission data)."""
    from ..comparability.model import problem_fingerprint
    ia = {h: w.inst.get_instance(h) for h in ca["scenario_set"]["instance_hashes"]}
    ib = {h: w.inst.get_instance(h) for h in cb["scenario_set"]["instance_hashes"]}
    root = lambda i: (i.get("derivation") or {}).get("parent_instance_hash", i["instance_hash"])    # noqa: E731
    fp = lambda i: problem_fingerprint(problem, i, problem.objective_spec_id)["problem"]            # noqa: E731
    by_root_b = {root(i): i for i in ib.values()}
    by_fp_b: dict[str, dict] = {}
    for i in ib.values():
        by_fp_b.setdefault(fp(i), i)
    out, used = [], set()
    for i in ia.values():
        j = ib.get(i["instance_hash"]) or by_root_b.get(root(i)) or by_fp_b.get(fp(i))
        if j is not None and j["instance_hash"] not in used:
            out.append((i, j))
            used.add(j["instance_hash"])
    return out


@router.get("/diff")
def diff(a: str, b: str, request: Request, method_a: str | None = None, method_b: str | None = None):
    """Experiment A vs experiment B, scenario by scenario: assignments, served riders, validated metrics, runtime,
    vehicle usage and emissions, with the comparability verdicts of the three claims."""
    w = ws(request)
    ca, cb = _call(w.get, a), _call(w.get, b)
    problem = _call(problem_for, ca)
    if _call(problem_for, cb).problem_id != problem.problem_id:
        raise HTTPException(400, "the two experiments study different problems")
    ma, ra = _pick_run(ca, method_a, problem)
    mb, rb = _pick_run(cb, method_b, problem)
    rows = []
    for ia, ib in _matched_scenarios(w, problem, ca, cb):
        xa, xb = ra.get(ia["instance_hash"]), rb.get(ib["instance_hash"])
        row = dict(instance_id=ia["instance_id"], instance_id_b=ib["instance_id"], instance_hash=ia["instance_hash"],
                   instance_hash_b=ib["instance_hash"], same_instance=ia["instance_hash"] == ib["instance_hash"],
                   run_a=xa and xa.get("run_id"), run_b=xb and xb.get("run_id"))
        if xa and xb and "pairs" in ia:
            da = {d: r for d, r in xa["decisions"]}
            db = {d: r for d, r in xb["decisions"]}
            drivers = sorted(set(da) | set(db))
            detail = [dict(driver=d, a=da.get(d), b=db.get(d)) for d in drivers if da.get(d) != db.get(d)]
            sa, sb = set(da.values()), set(db.values())
            row.update(assignments=dict(same=sum(1 for d in drivers if da.get(d) == db.get(d) and d in da),
                                        changed=sum(1 for d in drivers if d in da and d in db and da[d] != db[d]),
                                        only_a=sum(1 for d in drivers if d in da and d not in db),
                                        only_b=sum(1 for d in drivers if d in db and d not in da), detail=detail[:200]),
                       served=dict(a=len(sa), b=len(sb), both=len(sa & sb), only_a=sorted(sa - sb)[:50], only_b=sorted(sb - sa)[:50]))
        if xa and xb:
            row.update(metrics=dict(a=xa["validation"]["metrics"], b=xb["validation"]["metrics"]),
                       runtime=dict(a=xa.get("total_time_s"), b=xb.get("total_time_s")),
                       emissions=dict(a=xa.get("domain"), b=xb.get("domain")))
        rows.append(row)
    if not rows:
        raise HTTPException(400, "the two experiments share no scenario (neither identical nor derived)")
    tot = lambda rs, side: {m.id: sum((r.get("metrics") or {}).get(side, {}).get(m.id, 0) for r in rs) for m in problem.metrics}  # noqa: E731
    totals = dict(metrics=dict(a=tot(rows, "a"), b=tot(rows, "b")),
                  runtime=dict(a=med([dict(t=r["runtime"]["a"]) for r in rows if r.get("runtime")], "t"),
                               b=med([dict(t=r["runtime"]["b"]) for r in rows if r.get("runtime")], "t")),
                  emissions=dict(a=problem.aggregate_domain([(r.get("emissions") or {}).get("a") for r in rows]),
                                 b=problem.aggregate_domain([(r.get("emissions") or {}).get("b") for r in rows])),
                  assignments=dict(same=sum((r.get("assignments") or {}).get("same", 0) for r in rows),
                                   changed=sum((r.get("assignments") or {}).get("changed", 0) for r in rows),
                                   only_a=sum((r.get("assignments") or {}).get("only_a", 0) for r in rows),
                                   only_b=sum((r.get("assignments") or {}).get("only_b", 0) for r in rows)),
                  served=dict(a=sum((r.get("served") or {}).get("a", 0) for r in rows), b=sum((r.get("served") or {}).get("b", 0) for r in rows)))
    comparability = None
    try:
        comparability = _comparability(semantic_compare(w, a, b)) if a != b else None
    except (BenchError, HTTPException, RuntimeError):
        comparability = None
    side = lambda c, mid: dict(campaign_id=c["campaign_id"], title=display_title(c["title"]), kind=c["kind"], method_id=mid,   # noqa: E731
                               methods=[m["method_id"] for m in c["methods"]], owner_display=c["owner_display"],
                               emissions=c["config"].get("emissions"))
    return dict(a=side(ca, ma), b=side(cb, mb), rows=rows, totals=totals, comparability=comparability,
                metrics=[m.to_dict() for m in problem.metrics], domain_metrics=problem.domain_metric_definitions(),
                matched=len(rows), unmatched=dict(a=len(ca["scenario_set"]["instance_hashes"]) - len(rows),
                                                  b=len(cb["scenario_set"]["instance_hashes"]) - len(rows)))


# ------------------------------------------------------------------ export and import dialogs
@router.get("/export/{cid}")
def export_preview(cid: str, request: Request):
    """What Export would put in the bundle — records, scenarios, references, methods, parameters — without building it."""
    w = ws(request)
    _call(w.get, cid)
    return _call(bundles.preview, w, cid)


@router.get("/experiments/{cid}/evidence")
def evidence_report(cid: str, request: Request):
    """The evidence report alone, as a JSON download (an explicit action; Export can also put it inside the bundle)."""
    body = json.dumps(evidence_doc(cid, request), indent=1, ensure_ascii=False)
    return Response(body, media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="move_openlab_evidence_{cid}.json"'})


def evidence_doc(cid: str, request: Request) -> dict:
    """A readable evidence report: provenance, independent validation, reproducibility (for a re-execution), semantic
    comparability with the parent, fingerprints and the results table. Computed from the stored records only. Inside a
    bundle (``evidence/report.json``) it is informative: the importer verifies the records themselves and recomputes
    the fingerprints; the report must name the bundle's root experiment, its checksum and the same fingerprints."""
    w = ws(request)
    e = experiment(cid, request)
    chain = _call(w.lineage, cid)
    c = chain[0]
    fingerprints = None
    if all(x.get("checksum") for x in chain):
        problem = problem_for(c)
        insts = {h: w.inst.get_instance(h) for x in chain for h in x["scenario_set"]["instance_hashes"]}
        fingerprints = dict(experiment=bundles.experiment_fingerprint(chain), semantic=bundles.semantic_fingerprint(problem, insts, chain))
    camp = e["campaign"]
    rep = dict(
        format="move-openlab-evidence/1", generated_at=now(), generated_by=w.display,
        note="Evidence summary computed from the stored records. Validation: every solution re-checked by the problem's "
             "validator. Reproducibility: only for a re-execution of the same experiment. Comparability: whether figures "
             "may be put side by side (results, runtimes, CO2).",
        experiment=dict(campaign_id=cid, title=camp["title"], kind=camp["kind"], locked=camp["locked"], checksum=c.get("checksum"),
                        parent=camp["parent"], problem=e["problem"]["title"], repetitions=camp["repetitions"],
                        emissions=camp["emissions"], imported_from=camp["imported_from"]),
        provenance=e["provenance"], context=e["context"], methods=e["methods"], validation=e["validation"],
        reproducibility=e["reproduction"] or dict(applicable=False, reason="not a re-execution of another experiment"),
        comparability_with_parent=e["comparability"], fingerprints=fingerprints,
        results=[dict(method_id=r["method_id"], name=r.get("name"), kind=r.get("kind"), campaign_id=r.get("campaign_id"),
                      totals=r.get("totals"), proven_optimal=r.get("proven_optimal"), repetitions=r.get("repetitions"),
                      repetitions_consistent=r.get("repetitions_consistent")) for r in (e["results"] or {}).get("rows", [])])
    return rep


@router.post("/inspect")
async def inspect_bundle(request: Request, file: UploadFile = File(...)):
    """Check a bundle completely without importing it, and say what importing it would do here: what it contains, which
    records are new, already present or in conflict, whether its methods are available for a re-execution, and what can
    be compared. Nothing is written. A scenario package (its manifest names ``move-openlab-scenario/1``) is verified by
    the scenario-package importer instead; its report says ``kind: "scenario"``."""
    data = await file.read(MAX_BUNDLE_BYTES + 1)
    w = ws(request)
    if scenario_packages.is_package(data):
        return dict(inspect_scenario_package(w, data), filename=file.filename)
    rep = _call(w.verify_bundle, data)[0]
    present: dict[str, str] = {}
    for ent in rep["campaigns_verified"]:
        try:
            have = w.get(ent["campaign_id"])
            present[ent["campaign_id"]] = "identical" if have.get("checksum") == ent["checksum"] else "different"
        except BenchError:
            present[ent["campaign_id"]] = "new"
    missing = [m for m in rep["methods"] if not m["available_locally"]]
    warnings = []
    if any(v == "different" for v in present.values()):
        warnings.append("A different experiment with the same identifier is already in your workspace: the import will be refused.")
    if missing:
        warnings.append("Not available here: " + ", ".join(f"{m['method_id']} {m['version']}" for m in missing)
                        + ". The results can be inspected and compared; re-running them needs these methods (Add method).")
    if rep["networks"] and not rep["geometry_verified"]:
        warnings.append("No replay geometry in the bundle: routes replay only where the road network is installed.")
    if present and all(v == "identical" for v in present.values()):
        warnings.append("Already in your workspace (identical records): importing adds nothing; you can reproduce it directly.")
    rep.update(filename=file.filename, bytes=len(data), present=present,
               adds=sum(1 for v in present.values() if v == "new"),
               importable=not any(v == "different" for v in present.values()), reproducible_here=not missing,
               comparable="Same problem and validator as this installation: results can be compared with your experiments of "
                          "this problem; runtimes only with conditions (other hardware and load).",
               warnings=warnings)
    return rep


@router.get("/metrics")
def metrics(request: Request, problem_id: str = ""):
    """Custom metrics of a problem for this workspace: the built-in ones (trusted, shipped with the framework) and the
    ones this researcher registered (third-party code, computed only in isolation), the metric files that could be
    registered, and why a registered metric cannot be computed here. Listing never executes metric code."""
    w = ws(request)
    if not problem_id:
        return dict(metrics=[], available=[], errors={}, can_register=False)
    problem = _problem(problem_id, request)
    listed, errors = [], {}
    for meta, ev in w.metric_evaluations(problem, []):
        listed.append(meta)
        if meta.get("available") is False:
            errors[meta["id"]] = "; ".join(ev.issues)
    st = w.inst.plugin_status()
    return dict(metrics=listed, available=w.available_metrics(problem), errors=errors,
                can_register=st["enabled"] and (st["isolation"] == "sandbox" or request.state.session.is_admin),
                plugin_status={k: v for k, v in st.items() if k != "checks"})


class MetricRegisterBody(BaseModel):
    problem_id: str = Field(min_length=1, max_length=120)
    plugin: str = Field(min_length=1, max_length=120)


@router.post("/metrics/register")
def register_metric(body: MetricRegisterBody, request: Request):
    """Register a metric file of the approved plugin directory for this workspace (pinned SHA-256, isolated
    self-test). Same rules as method plugins: plugins enabled; trusted-process mode: administrators only."""
    return _call(ws(request).register_metric, _problem(body.problem_id, request), body.plugin, admin=request.state.session.is_admin)


# ---------------------------------------------------------------- ML evaluation of learned methods (labelled data only)
#
#   GET  /api/lab/experiments/{cid}/evaluation?method_id=&threshold=   evaluations of one method: those the problem
#                                                                      package provides, then the imported evidence
#   POST /api/lab/experiments/{cid}/evaluation                         import evaluation evidence (JSON, or CSV + metadata)
#   GET  /api/lab/experiments/{cid}/evaluation/evidence/{sha}          download one stored evidence document
#   POST /api/lab/experiments/{cid}/evaluation/evidence/{sha}/withdraw hide one imported evidence (the file is kept)
#
# Evidence is stored beside the experiment (owner-only, named by its SHA-256), never in the experiment record: a locked
# experiment keeps its checksum. Every route goes through the signed-in account's own workspace.
NO_PREDICTIONS = ("exact", "heuristic")
NOT_APPLICABLE = "Not applicable: this method makes no predictions (it has no learned classifier)."
NO_EVIDENCE = ("Not available: labelled predictions are needed (true labels and the method's predictions on a named "
               "evaluation population). None are provided for this method.")


def _ml_method(w, cid: str, method_id: str, missing: int = 404):
    """The experiment (through the account's workspace: another account's, or a restricted problem's, is not found),
    its problem, the method reference, its settings and its display name."""
    c = _call(w.get, cid)
    problem = _call(problem_for, c)
    ref = next((m for m in c["methods"] if m["method_id"] == method_id), None)
    if ref is None:
        raise HTTPException(missing, "method not in this experiment" if missing == 404 else
                            f"the evidence is about method {method_id[:80]!r}, which is not a method of this experiment "
                            f"(its methods: {', '.join(m['method_id'] for m in c['methods'])})")
    cfg = (c["config"].get("method_configs") or {}).get(method_id) or {}
    return c, problem, ref, cfg, problem.method_display_name(method_id, cfg) or ref.get("name") or method_id


def _imported(entry: dict, ev: dict) -> dict:
    return dict(ev, origin="imported", source=dict(name=entry["source"]["name"], sha256=entry["source"]["sha256"]),
                evidence_sha256=entry["sha256"], evidence_format=entry.get("format", ML.FORMAT),
                imported_by=entry["imported_by"], imported_at=entry["imported_at"])


def _reference(entry: dict) -> dict:
    """Evidence received as a reference only: the exporter's recorded figures and provenance, never recomputed here."""
    r, rec = entry["reference"], entry["reference"].get("recorded") or {}
    n, pos = r.get("records") or 0, r.get("positives") or 0
    ds = r.get("dataset") or {}
    return dict(origin="bundle-reference", recomputable=False, reference_only=True,
                reason="Received as a reference: the predictions and labels were not included in the bundle, so these "
                       "figures are the exporter's and cannot be recomputed here.",
                population=ds.get("population"), split=ds.get("split"), unit=ds.get("unit"), graphs=None, candidates=n,
                records=n, positives=pos, prevalence_pct=round(100 * pos / n, 4) if n else None, decision=rec.get("decision"),
                positive_label=r.get("positive_label"), convention="as recorded by the exporter",
                confusion=rec.get("confusion"), metrics=rec.get("metrics") or {}, metric_reasons=rec.get("metric_reasons") or {},
                extra_metrics=[], notes=list(r.get("notes") or []),
                provenance=dict(dataset=ds, model=r.get("model"), feature_pipeline=r.get("feature_pipeline"),
                                decision=r.get("decision"), method_id=entry["method_id"]),
                has_scores=r.get("has_scores"), threshold_adjustable=False, threshold=(r.get("decision") or {}).get("threshold"),
                exploratory=False, recorded_decision=None, sweep=[], score_range=None,
                source=dict(name=entry["source"].get("name"), sha256=entry["sha256"]), evidence_sha256=entry["sha256"],
                evidence_format=entry.get("format", ML.FORMAT), imported_by=entry["imported_by"], imported_at=entry["imported_at"])


@router.get("/experiments/{cid}/evaluation")
def ml_evaluation(cid: str, method_id: str, request: Request, threshold: float | None = None):
    """Classification evaluations of one method of an experiment: first those the problem provides from real predictions
    and labels (``origin: "adapter"``), then those computed from evidence imported for this experiment (``origin:
    "imported"``, with provenance, the evidence SHA-256, who imported it and when, and a threshold sweep). ``threshold``
    recomputes the threshold-adjustable ones at an exploratory threshold (``exploratory: true``; the recorded decision
    is still returned). Without any evaluation the answer says why; nothing is derived from solver outcomes."""
    w = ws(request)
    _c, problem, ref, cfg, name = _ml_method(w, cid, method_id)
    base = dict(method_id=method_id, name=name, kind=ref.get("kind"))
    if ref.get("kind") in NO_PREDICTIONS:
        return dict(base, available=False, evaluations=[], reason=NOT_APPLICABLE, can_import=False)
    if threshold is not None and not math.isfinite(threshold):
        raise HTTPException(422, "threshold must be a finite number")
    adapter_error = None
    try:
        evs = [dict(dict(e), origin="adapter", threshold_adjustable=False, exploratory=False)
               for e in problem.ml_evaluations(method_id, cfg)]
    except (OSError, ValueError, KeyError) as e:
        evs, adapter_error = [], f"Not available: the evaluation data could not be read ({type(e).__name__})."
    store, errors = EvidenceStore(w.root), []
    index = _call(store.index, cid)
    for entry in index:
        if entry["method_id"] != method_id or entry.get("withdrawn"):
            continue
        if entry.get("reference_only"):                         # came with a bundle without its predictions and labels
            evs.append(_reference(entry))
            continue
        try:
            evs.append(_imported(entry, store.evaluation(cid, entry["sha256"], threshold)))
        except (BenchError, ML.EvidenceError, OSError) as e:    # a stored file that no longer verifies: said, not hidden
            errors.append(dict(evidence_sha256=entry["sha256"], reason=f"Not available: {e}"))
    out = dict(base, can_import=True, evidence_errors=errors, adapter_error=adapter_error,
               withdrawn=sum(1 for e in index if e["method_id"] == method_id and e.get("withdrawn")))
    if not evs:
        return dict(out, available=False, evaluations=[], reason=adapter_error or NO_EVIDENCE)
    return dict(out, available=True, evaluations=evs, reason=None)


@router.post("/experiments/{cid}/evaluation")
def import_ml_evidence(cid: str, request: Request, file: UploadFile = File(...), method_id: str | None = Form(None),
                       metadata: str | None = Form(None)):
    """Import evaluation evidence (real predictions and ground-truth labels) for one method of an experiment: a JSON
    document of the format ``move-openlab/ml-evaluation-evidence@1``, or a CSV of records (``id,label,score[,prediction]``)
    with ``method_id`` and ``metadata`` (a JSON object holding the other fields of the format). The evidence is
    validated, stored content-addressed in an owner-only file beside the experiment and recorded in the audit log. The
    experiment record is not modified."""
    w = ws(request)
    c = _call(w.get, cid)                                         # authorisation first: unknown here answers 404
    raw = file.file.read(ML.MAX_EVIDENCE_BYTES + 1)
    name = (file.filename or "evidence").replace("\\", "/").rsplit("/", 1)[-1][:160]
    try:
        if raw.lstrip(b"\xef\xbb\xbf \t\r\n")[:1] in (b"{", b"[") or name.lower().endswith(".json"):
            if metadata:
                raise ML.EvidenceError("a JSON evidence file carries its own metadata: send the metadata fields only with a CSV file")
            evidence, kind = ML.validate(ML.parse_json(raw)), "json"
            if method_id and method_id != evidence["method_id"]:
                raise ML.EvidenceError(f"this evidence is about method {evidence['method_id'][:80]!r}, not {method_id[:80]!r}: "
                                       "it can only be imported for the method it names")
            data = raw
        else:
            try:
                meta = json.loads(metadata) if metadata else {}
            except (ValueError, RecursionError):
                raise ML.EvidenceError("metadata must be a JSON object") from None
            if isinstance(meta, dict) and method_id:
                if meta.get("method_id") not in (None, method_id):
                    raise ML.EvidenceError("method_id and metadata.method_id differ")
                meta = dict(meta, method_id=method_id)
            evidence, kind = ML.validate(ML.from_csv(raw, meta)), "csv"
            data = stored_bytes(evidence)
    except ML.EvidenceError as e:
        raise HTTPException(e.status, str(e)) from None
    _c, _problem_, ref, _cfg, _name = _ml_method(w, c["campaign_id"], evidence["method_id"], missing=422)
    if ref.get("kind") in NO_PREDICTIONS:
        raise HTTPException(422, NOT_APPLICABLE + " Evaluation evidence can be imported for a learned or hybrid method only.")
    ses = request.state.session
    entry, created = _call(EvidenceStore(w.root).add, cid, evidence, data,
                           dict(name=name, sha256=sha256_bytes(raw), bytes=len(raw), kind=kind), ses.display, ses.username)
    if created:
        from .admin import audit
        audit(request, ses.username, "import_ml_evidence", f"{cid}:{evidence['method_id']}:{entry['sha256']}")
    return dict(campaign_id=cid, method_id=evidence["method_id"], evidence_sha256=entry["sha256"], created=created,
                records=entry["records"], source=entry["source"], imported_by=entry["imported_by"],
                imported_at=entry["imported_at"], stored="owner-only file beside the experiment; the experiment record is unchanged")


@router.get("/experiments/{cid}/evaluation/evidence/{sha}")
def ml_evidence_file(cid: str, sha: str, request: Request):
    """The stored evidence document, byte for byte (its SHA-256 is its name)."""
    w = ws(request)
    _call(w.get, cid)
    data = _call(EvidenceStore(w.root).read, cid, sha)
    return Response(data, media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="ml-evaluation-evidence-{sha[:16]}.json"',
                             "X-Evidence-SHA256": sha, "X-Content-Type-Options": "nosniff"})


@router.post("/experiments/{cid}/evaluation/evidence/{sha}/withdraw")
def withdraw_ml_evidence(cid: str, sha: str, request: Request):
    """Hide one imported evidence from the evaluation. Nothing is deleted: the file and its index entry are kept, and
    importing the same file again shows it again. Recorded in the audit log."""
    w = ws(request)
    _call(w.get, cid)
    store, ses = EvidenceStore(w.root), request.state.session
    already = bool(_call(store.entry, cid, sha).get("withdrawn"))
    entry = _call(store.withdraw, cid, sha, ses.display)
    if not already:
        from .admin import audit
        audit(request, ses.username, "withdraw_ml_evidence", f"{cid}:{entry['method_id']}:{sha}")
    return dict(campaign_id=cid, method_id=entry["method_id"], evidence_sha256=sha, withdrawn=entry["withdrawn"])


# ---------------------------------------------------------------- public synthetic benchmark (methodological)
PUBLIC_BENCHMARK = "synthetic-capacitated-bipartite-assignment"


def _benchmark_definition() -> dict:
    from ..benchmarks.synthetic_assignment import generator
    from ..registry import get as get_problem
    from ..store import builtin_refs
    p = get_problem(PUBLIC_BENCHMARK)
    return dict(
        problem_id=PUBLIC_BENCHMARK, title="Public synthetic assignment benchmark", problem_title=p.title,
        description="Capacitated assignment of artificial passengers to drivers: maximise the passengers served, then "
                    "minimise the total pair cost. Fully synthetic and public; no map, no real mobility data.",
        objective=[o.to_dict() for o in p.objective], metrics=[m.to_dict() for m in p.metrics],
        generator=dict(name=generator.GENERATOR_NAME, version=generator.GENERATOR_VERSION,
                       sizes={k: dict(drivers=v[0], passengers=v[1]) for k, v in generator.SIZES.items()},
                       seeds=list(generator.SEEDS)),
        scenario_params=dict(sizes=list(generator.SIZES), seeds=list(generator.SEEDS)), repetitions=5,
        methods=[dict(method_id=m["method_id"], version=m["version"], name=m.get("name"), kind=m.get("kind")) for m in builtin_refs(p)],
        optional_plugin=dict(plugin="regret_greedy", note="the example plug-in; register it with + Add method to include it"),
        validator=p.validator_version, oracle="independent min-cost maximum flow (successive shortest paths), not the MILP",
        command="python scripts/benchmark_synthetic_assignment.py --out <dir>",
        scope="A methodological benchmark with its own measured results: a fixed protocol (scenarios, methods, repetitions, "
              "validator, oracle) that anyone can repeat and compare run by run. Its data is artificial: it is not the "
              "mobility demonstration, and it reproduces the results of no other study.")


@router.get("/benchmark/public")
def public_benchmark(request: Request):
    """The public synthetic benchmark: its frozen definition, this researcher's runs of it, and for each run an
    independent check of every validated result against the min-cost-flow oracle (computed here, not by a method)."""
    from ..benchmarks.synthetic_assignment import oracle
    w = ws(request)
    d = _benchmark_definition()
    runs = []
    for e in w.list(PUBLIC_BENCHMARK):
        c = w.get(e["campaign_id"])
        if (c["scenario_set"].get("params") or {}) != d["scenario_params"] or not c["runs"]:
            continue
        opt = {h: oracle.lex_optimum(w.inst.get_instance(h)) for h in c["scenario_set"]["instance_hashes"]}
        per: dict = {}
        for r in c["runs"]:
            m = per.setdefault(r["method_id"], dict(method_id=r["method_id"], runs=0, accepted=0, oracle_optimal=0, scenarios=set()))
            m["runs"] += 1
            m["accepted"] += bool(r.get("accepted"))
            v = (r.get("validation") or {}).get("metrics") or {}
            m["oracle_optimal"] += bool(r.get("accepted")) and (v.get("served"), v.get("cost")) == opt.get(r["instance_hash"])
            m["scenarios"].add(r["instance_hash"])
        runs.append(dict(campaign_id=c["campaign_id"], title=display_title(c["title"]), created_at=c["created_at"],
                         locked=bool(c.get("checksum")), kind=c["kind"], scenarios=len(opt),
                         methods=[dict(m, scenarios=len(m["scenarios"])) for m in per.values()]))
    return dict(definition=d, runs=sorted(runs, key=lambda x: x["created_at"], reverse=True))
