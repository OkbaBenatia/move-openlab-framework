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
import re
import threading

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

from .. import demo, samples
from ..analysis.common import SCOPE_FULL, by_cell, med
from ..analysis.compare import compare
from ..analysis.reproducibility import reproducibility
from ..analysis.semantic import semantic_compare
from ..datasets import DatasetStore
from ..geo.areas import AreaStore
from ..hashing import sha256_bytes
from ..integrations import rpc
from ..mobility import emissions as E
from ..mobility import vehicles as V
from ..store import BenchError, _write, problem_for
from .experiments import _call, ws
from .geo import RIDE, ComposeBody, ScenarioBody
from .geo import store as network_store
from .geo import save_scenario as geo_save_scenario

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


class PrefsBody(BaseModel):
    tour_dismissed: bool | None = None
    start_dismissed: bool | None = None                              # the first-use "start here" card
    theme: str | None = Field(None, pattern=r"^(light|dark)$")       # appearance; light unless the user chooses dark
    last_experiment: str | None = Field(None, max_length=128)
    area_id: str | None = Field(None, max_length=64)
    hidden_ids: list[str] | None = Field(None, max_length=1000)     # records hidden from lists (never deleted)


@router.get("/state")
def state(request: Request):
    w = ws(request)
    p = _prefs(w)
    # "installed" means *this* demonstration (by bundle digest): a newer shipped demonstration is imported next to the
    # previous one, which stays in the workspace (nothing is ever deleted)
    installed = demo.available() and p.get("demo_installed") == sha256_bytes(demo.bundle_bytes())
    return dict(preferences={k: p.get(k) for k in ("tour_dismissed", "start_dismissed", "theme", "last_experiment", "area_id")}
                | dict(hidden_ids=p.get("hidden_ids") or []),
                demo=dict(available=demo.available(), installed=installed, campaigns=p.get("demo_campaigns") or [],
                          area=p.get("demo_area")),
                sample=_sample_state(p))


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


@router.put("/preferences")
def set_preferences(body: PrefsBody, request: Request):
    w = ws(request)
    upd = body.model_dump(exclude_unset=True)
    if upd.get("last_experiment") is not None and not CID.match(upd["last_experiment"]):
        raise HTTPException(400, "invalid experiment id")
    if upd.get("hidden_ids") is not None and not all(CID.match(str(x)) for x in upd["hidden_ids"]):
        raise HTTPException(400, "invalid record id")
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
    """The demonstration's area in this workspace, so that Generate starts there: an existing area on the same box and
    profile is reused, otherwise one is added once with the shipped box (its road network is attached when this
    installation already stores it; otherwise the wizard offers to prepare it). Never recreated after the user removes it."""
    net = next(iter(demo.manifest().get("networks") or []), None)
    if not net or not net.get("bbox"):
        return None
    areas, prof = AreaStore(w.root), net.get("profile") or "car"
    box = [round(x, 5) for x in net["bbox"]]
    for a in areas.list():
        if a.get("network_id") == net["network_id"] or (a["bbox"] == box and a["profile"] == prof):
            return a["area_id"]
    try:
        hit = network_store(request).find(box, prof)
        return areas.create(demo.AREA_LABEL, box, prof, dict(name=demo.AREA_LABEL, kind="demonstration"),
                            hit["network_id"] if hit else None)["area_id"]
    except ValueError:                                 # area limit reached: the demonstration still works without it
        return None


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
        out.append(dict(campaign_id=e["campaign_id"], title=e["title"], kind=e["kind"], status=e["status"],
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


@router.get("/experiments/{cid}")
def experiment(cid: str, request: Request):
    w = ws(request)
    c = _call(w.get, cid)
    problem = _call(problem_for, c)
    imp = w.import_record(cid)
    insts = [w.inst.get_instance(h) for h in c["scenario_set"]["instance_hashes"]]
    prov = (insts[0].get("provenance") or {}) if insts else {}
    nid = (insts[0].get("network") or {}).get("network_id") if insts else None
    parent = c.get("parent")
    out = dict(
        campaign=dict(campaign_id=cid, title=c["title"], kind=c["kind"], status=c["status"],
                      locked=bool(c.get("checksum")), owner_display=c["owner_display"], created_at=c["created_at"],
                      imported=bool(imp), imported_from=imp and imp["original_owner_display"],
                      parent=parent and dict(campaign_id=parent["campaign_id"], relation=parent["relation"],
                                             kind=parent["kind"]),
                      variant=(c.get("semantic_variant") or {}).get("description"), problem_id=problem.problem_id,
                      repetitions=c["config"]["repetitions"], emissions=c["config"].get("emissions"),
                      category=category_of(c["kind"], bool(imp), cid in set(_prefs(w).get("demo_campaigns") or []))),
        context=dict(area=_area_label(request, w, nid), dataset=_dataset_label(request, w, prov),
                     scenario=f"{len(insts)} scenario{'s' if len(insts) != 1 else ''}"),
        problem=dict(title=problem.title, synthetic=problem.synthetic, metrics=[m.to_dict() for m in problem.metrics],
                     objective=[o.to_dict() for o in problem.objective], domain_metrics=problem.domain_metric_definitions()),
        scenarios=[dict(instance_hash=i["instance_hash"], instance_id=i["instance_id"], name=i.get("name"),
                        seed=(i.get("provenance") or {}).get("seed"),
                        edited=list((i.get("provenance") or {}).get("edited_agents") or []),
                        vehicles=_vehicle_summary(i), emissions=E.config_of(i, c["config"]),
                        **{k: len(i[k]) for k in ("drivers", "riders", "pairs") if isinstance(i.get(k), list)})
                   for i in insts],
        methods=[dict(method_id=m["method_id"], version=m["version"], name=m.get("name"), kind=m.get("kind"),
                      source=m["source"]) for m in c["methods"]],
        validation=validation_of(c), provenance=_provenance(request, w, insts),
        runs=[], job_id=next((j["job_id"] for j in request.app.state.jobs.history(w.user, 1, subject=f"{w.user}/{cid}")), None),
        results=None, comparability=None, reproduction=None)
    if c["runs"]:
        cmp = _call(compare, w, cid)
        scope = {r["campaign_id"] for r in cmp["rows"]} | {cid}          # the campaigns the comparison shows
        out["runs"] = [dict(run_id=r["run_id"], campaign_id=x["campaign_id"], instance_hash=r["instance_hash"],
                            method_id=r["method_id"], accepted=r["accepted"], status=r.get("status_declared"))
                       for x in _call(w.lineage, cid) if x["campaign_id"] in scope
                       for r in x["runs"] if r.get("repetition") == 1]
        out["results"] = dict(rows=[_row(problem, insts, r) for r in cmp["rows"]], warnings=cmp["warnings"],
                              reference=cmp["reference"], metrics=cmp["metrics"])
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


def _provenance(request: Request, w, insts: list[dict]) -> dict:
    """Where the scenarios come from, kept apart from the scenarios themselves: the *source* (observed trips of an open
    data release, an uploaded file, a generator, the map editor) and how the participants were *derived* from it."""
    prov = (insts[0].get("provenance") or {}) if insts else {}
    src = prov.get("source")
    out = dict(source=src, sampled=src in ("open-data", "dataset"), release=prov.get("release"),
               attribution=prov.get("attribution"), licence=(prov.get("licence") or {}).get("name"),
               method=prov.get("method"), generator=prov.get("generator"), window=prov.get("window"),
               pool_size=prov.get("pool_size"), seeds=[(i.get("provenance") or {}).get("seed") for i in insts],
               observed_trips=_observed_trips(request, prov.get("dataset_key")) if src == "open-data" else None,
               edited=sorted({a for i in insts for a in ((i.get("provenance") or {}).get("edited_agents") or [])}))
    return out


def _row(problem, insts, r: dict) -> dict:
    sc = r.get("optimality_scope") or {}
    proven = sc.get(SCOPE_FULL, 0)
    return dict(method_id=r["method_id"], version=r["version"], name=r["name"], kind=r["kind"], source=r["source"],
                campaign_id=r["campaign_id"], origin=r["origin"], campaign_kind=r["campaign_kind"],
                researcher=r["researcher"], scenarios=r["scenarios"], valid=r["all_feasible"],
                proven_optimal=proven, optimal=r.get("optimal"), totals=r["totals"],
                descriptive=problem.descriptive_metrics(insts, r["totals"]), domain=r.get("domain"),
                gap_pct=(r.get("final_level_gap_pct") or {}).get("mean"),
                solver_time_s=r["median_solver_time_s"], total_time_s=r["median_total_time_s"],
                mean_rank=r.get("mean_rank"), reproduction=r.get("reproduction_status"),
                repetitions=r.get("repetitions"), repetitions_consistent=r.get("repetitions_consistent"),
                per_scenario=r.get("per_scenario") or {})


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


@router.post("/run")
def run(body: RunBody, request: Request):
    """Store the scenario (when one is given), create the experiment and start its execution in one call. Nothing is
    stored before this call: the wizard's Review step is the only place that triggers it."""
    hashes = list(body.instance_hashes)
    scenario = None
    if body.scenario is not None:
        scenario = geo_save_scenario(ScenarioBody(scenario=body.scenario, parent=body.parent, basis=body.basis), request)
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
        out.append(dict(campaign_id=cb["campaign_id"], title=cb["title"], kind=cb["kind"], owner_display=cb["owner_display"],
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
    return dict(a=dict(campaign_id=a, title=ca["title"], kind=ca["kind"], validation=validation_of(ca)), candidates=out,
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
    return dict(applicable=True, reproduced=bool(rr["numerically_reproduced"]), cells=rr["cells"],
                different=(rr.get("agreement") or {}).get("different"))


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
    side = lambda c, mid: dict(campaign_id=c["campaign_id"], title=c["title"], kind=c["kind"], method_id=mid,   # noqa: E731
                               methods=[m["method_id"] for m in c["methods"]], owner_display=c["owner_display"],
                               emissions=c["config"].get("emissions"))
    return dict(a=side(ca, ma), b=side(cb, mb), rows=rows, totals=totals, comparability=comparability,
                metrics=[m.to_dict() for m in problem.metrics], domain_metrics=problem.domain_metric_definitions(),
                matched=len(rows), unmatched=dict(a=len(ca["scenario_set"]["instance_hashes"]) - len(rows),
                                                  b=len(cb["scenario_set"]["instance_hashes"]) - len(rows)))
