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
from pydantic import BaseModel, Field

from .. import demo
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
from .geo import save_scenario as geo_save_scenario

router = APIRouter(prefix="/api/lab")
PREFS = "preferences.json"
_prefs_lock = threading.Lock()                # preference files are read-modify-written
CID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
CATEGORY = {"reproduction": "Reproduced", "variant": "Edited", "extended": "Edited", "threshold-study": "Edited"}


def category_of(kind: str, imported: bool, is_demo: bool) -> str:
    """Demo · Imported · Generated · Edited · Reproduced (how the record came into this workspace)."""
    return "Demo" if is_demo else "Imported" if imported else CATEGORY.get(kind, "Generated")


def _prefs(w) -> dict:
    f = w.root / PREFS
    try:
        return json.loads(f.read_text()) if f.exists() else {}
    except (OSError, ValueError):
        return {}


class PrefsBody(BaseModel):
    tour_dismissed: bool | None = None
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
    return dict(preferences={k: p.get(k) for k in ("tour_dismissed", "last_experiment", "area_id")}
                | dict(hidden_ids=p.get("hidden_ids") or []),
                demo=dict(available=demo.available(), installed=installed, campaigns=p.get("demo_campaigns") or []))


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
    with _prefs_lock:
        p = _prefs(w)
        p.update(demo_installed=rep["bundle_sha256"], demo_campaigns=sorted(set(p.get("demo_campaigns") or []) | set(camps)))
        if p.get("last_experiment") not in camps:
            p["last_experiment"] = rep["root_campaign_id"]
        _write(w.root / PREFS, p)
    return dict(installed=True, campaigns=camps, root_campaign_id=rep["root_campaign_id"])


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
    w = ws(request)
    p = _prefs(w)
    demo_ids = set(p.get("demo_campaigns") or [])
    hidden = set(p.get("hidden_ids") or [])
    out = []
    for e in w.list():
        try:
            nids, keys = _refs(w, w.get(e["campaign_id"]))
        except (BenchError, KeyError, OSError, ValueError):     # an unreadable record never hides the others
            continue
        out.append(dict(campaign_id=e["campaign_id"], title=e["title"], kind=e["kind"], status=e["status"],
                        problem_id=e["problem_id"], imported=e["imported"], locked=bool(e["checksum"]),
                        created_at=e["created_at"], owner_display=e["owner_display"],
                        parent=(e.get("parent") or {}).get("campaign_id"), demo=e["campaign_id"] in demo_ids,
                        category=category_of(e["kind"], e["imported"], e["campaign_id"] in demo_ids),
                        hidden=e["campaign_id"] in hidden, network_ids=nids, dataset_keys=keys))
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


def _verdict(sem: dict, claim: str) -> str:
    s = sem["summary"][claim]
    return "incompatible" if s["INCOMPATIBLE"] else "conditional" if s["CONDITIONAL"] else "direct"


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
                        vehicles=_vehicle_summary(i), emissions=E.config_of(i, c["config"]),
                        **{k: len(i[k]) for k in ("drivers", "riders", "pairs") if isinstance(i.get(k), list)})
                   for i in insts],
        methods=[dict(method_id=m["method_id"], version=m["version"], name=m.get("name"), kind=m.get("kind"),
                      source=m["source"]) for m in c["methods"]],
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
                mean_rank=r.get("mean_rank"), reproduction=r.get("reproduction_status"))


def _comparability(sem: dict) -> dict:
    """Verdict per claim plus the reasons shown under "Why?". The emissions claim is reported only when at least one
    side carries emission data."""
    claims = ("quality", "runtime") + (("emissions",) if any(r.get("emissions_applicable") for r in sem["rows"]) else ())
    reasons = sorted({q for r in sem["rows"] for cl in claims for q in r[cl]["incompatible"] + r[cl]["qualifications"]})
    return dict(reference=sem["reference"]["campaign_id"], quality=_verdict(sem, "quality"), runtime=_verdict(sem, "runtime"),
                emissions=_verdict(sem, "emissions") if "emissions" in claims else None, reasons=reasons[:10])


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
