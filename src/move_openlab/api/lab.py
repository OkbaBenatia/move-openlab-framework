"""Workspace (map-first interface) API: per-user preferences, the shipped demonstration, experiment summaries.

  GET  /api/lab/state                 preferences and demonstration status of the signed-in user
  PUT  /api/lab/preferences           update preferences (known keys only)
  POST /api/lab/demo                  import the demonstration into the user's workspace (verified import, idempotent)
  GET  /api/lab/experiments           the user's experiments with their area references (for filtering)
  GET  /api/lab/experiments/{cid}     one experiment as the workspace shows it: context, scenarios, results,
                                      comparability with its parent, reproduction verdict, runs to replay

Every summary is computed from the locked or stored records; nothing here changes an experiment.
"""
from __future__ import annotations

import json
import re

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .. import demo
from ..analysis.common import SCOPE_FULL
from ..analysis.compare import compare
from ..analysis.reproducibility import reproducibility
from ..analysis.semantic import semantic_compare
from ..datasets import DatasetStore
from ..geo.areas import AreaStore
from ..integrations import rpc
from ..store import BenchError, _write, problem_for
from .experiments import _call, ws

router = APIRouter(prefix="/api/lab")
PREFS = "preferences.json"
CID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


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


@router.get("/state")
def state(request: Request):
    w = ws(request)
    p = _prefs(w)
    return dict(preferences={k: p.get(k) for k in ("tour_dismissed", "last_experiment", "area_id")},
                demo=dict(available=demo.available(), installed=bool(p.get("demo_installed")),
                          campaigns=p.get("demo_campaigns") or []))


@router.put("/preferences")
def set_preferences(body: PrefsBody, request: Request):
    w = ws(request)
    p = _prefs(w)
    for k, v in body.model_dump(exclude_unset=True).items():
        if k == "last_experiment" and v is not None and not CID.match(v):
            raise HTTPException(400, "invalid experiment id")
        p[k] = v
    _write(w.root / PREFS, p)
    return state(request)


@router.post("/demo")
def install_demo(request: Request):
    """Import the demonstration once into this workspace. Re-running it is harmless: identical campaigns are kept."""
    if not demo.available():
        raise HTTPException(404, "no demonstration is shipped with this installation")
    w = ws(request)
    rep = _call(w.import_bundle, demo.bundle_bytes())
    p = _prefs(w)
    camps = [c["campaign_id"] for c in rep["campaigns_verified"]]
    p.update(demo_installed=rep["bundle_sha256"], demo_campaigns=camps)
    p.setdefault("last_experiment", rep["root_campaign_id"])
    _write(w.root / PREFS, p)
    return dict(installed=True, campaigns=camps, root_campaign_id=rep["root_campaign_id"])


def _networks(w, c: dict) -> list[str]:
    nids = []
    for h in c["scenario_set"]["instance_hashes"]:
        nid = (w.inst.get_instance(h).get("network") or {}).get("network_id")
        if nid and nid not in nids:
            nids.append(nid)
    return nids


@router.get("/experiments")
def experiments(request: Request):
    w = ws(request)
    p = _prefs(w)
    demo_ids = set(p.get("demo_campaigns") or [])
    out = []
    for e in w.list():
        try:
            c = w.get(e["campaign_id"])
        except BenchError:
            continue
        out.append(dict(campaign_id=e["campaign_id"], title=e["title"], kind=e["kind"], status=e["status"],
                        problem_id=e["problem_id"], imported=e["imported"], locked=bool(e["checksum"]),
                        created_at=e["created_at"], owner_display=e["owner_display"],
                        parent=(e.get("parent") or {}).get("campaign_id"), demo=e["campaign_id"] in demo_ids,
                        network_ids=_networks(w, c)))
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
                      repetitions=c["config"]["repetitions"]),
        context=dict(area=_area_label(request, w, nid), dataset=_dataset_label(request, w, prov),
                     scenario=f"{len(insts)} scenario{'s' if len(insts) != 1 else ''}"),
        problem=dict(title=problem.title, synthetic=problem.synthetic, metrics=[m.to_dict() for m in problem.metrics],
                     objective=[o.to_dict() for o in problem.objective]),
        scenarios=[dict(instance_hash=i["instance_hash"], instance_id=i["instance_id"], name=i.get("name"),
                        **{k: len(i[k]) for k in ("drivers", "riders", "pairs") if isinstance(i.get(k), list)})
                   for i in insts],
        methods=[dict(method_id=m["method_id"], version=m["version"], name=m.get("name"), kind=m.get("kind"),
                      source=m["source"]) for m in c["methods"]],
        runs=[dict(run_id=r["run_id"], instance_hash=r["instance_hash"], method_id=r["method_id"],
                   accepted=r["accepted"], status=r.get("status_declared"))
              for r in c["runs"] if r.get("repetition") == 1],
        results=None, comparability=None, reproduction=None)
    if c["runs"]:
        cmp = _call(compare, w, cid)
        out["results"] = dict(rows=[_row(problem, insts, r) for r in cmp["rows"]], warnings=cmp["warnings"],
                              reference=cmp["reference"], metrics=cmp["metrics"])
        if parent:
            try:
                sem = semantic_compare(w, parent["campaign_id"], cid)
                out["comparability"] = dict(reference=parent["campaign_id"], quality=_verdict(sem, "quality"),
                                            runtime=_verdict(sem, "runtime"),
                                            reasons=sorted({q for r in sem["rows"] for q in
                                                            r["quality"]["incompatible"] + r["quality"]["qualifications"]
                                                            + r["runtime"]["incompatible"] + r["runtime"]["qualifications"]})[:8])
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
    return dict(method_id=r["method_id"], name=r["name"], kind=r["kind"], source=r["source"],
                campaign_id=r["campaign_id"], origin=r["origin"], campaign_kind=r["campaign_kind"],
                researcher=r["researcher"], scenarios=r["scenarios"], valid=r["all_feasible"],
                proven_optimal=proven, optimal=r.get("optimal"), totals=r["totals"],
                descriptive=problem.descriptive_metrics(insts, r["totals"]),
                gap_pct=(r.get("final_level_gap_pct") or {}).get("mean"),
                solver_time_s=r["median_solver_time_s"], total_time_s=r["median_total_time_s"],
                mean_rank=r.get("mean_rank"), reproduction=r.get("reproduction_status"))
