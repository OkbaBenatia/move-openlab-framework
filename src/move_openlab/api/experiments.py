"""Experiment API. Every route requires a signed-in user (AuthGuard) and works in that user's own workspace: a
researcher can never read or modify another researcher's campaigns. Imported bundles never contain or trigger
executable code; methods are resolved from the trusted local installation."""
from __future__ import annotations

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import PlainTextResponse, Response
from pydantic import BaseModel, Field

from .. import registry
from ..analysis.common import scope_counts
from ..analysis.compare import compare
from ..analysis.report import comparison_csv, comparison_markdown
from ..analysis.reproducibility import reproducibility
from ..analysis.semantic import semantic_compare
from ..analysis.threshold import threshold_report
from ..hashing import canonical
from ..integrations import catalogue as integrations_catalogue
from ..methods import ContractError
from ..store import MAX_BUNDLE_BYTES, BenchError, Workspace, builtin_refs, problem_for
from ..version import APP_NAME, APP_SUBTITLE, DEVELOPER, app_version

router = APIRouter(prefix="/api")
MethodPair = tuple[str, str]


def ws(request: Request) -> Workspace:
    ses = request.state.session
    if ses is None:
        raise HTTPException(401, "authentication required")
    return request.app.state.installation.workspace(ses.username, ses.display)


def _problem(problem_id: str):
    try:
        return registry.get(problem_id)
    except registry.UnknownProblem as e:
        raise HTTPException(404, str(e)) from None


def _call(fn, *a, **k):
    try:
        return fn(*a, **k)
    except BenchError as e:
        raise HTTPException(e.status, str(e)) from None
    except ContractError as e:
        raise HTTPException(422, str(e)) from None


class CreateBody(BaseModel):
    problem_id: str = Field(min_length=3, max_length=120)
    title: str = Field(min_length=3, max_length=160)
    scenario_params: dict = Field(default_factory=dict)
    methods: list[MethodPair] = Field(min_length=1, max_length=20)
    repetitions: int = Field(3, ge=1, le=20)
    timeout_s: float = Field(120.0, ge=1, le=3600)
    time_budget_s: float | None = Field(None, gt=0, le=86400)


class ExtendBody(BaseModel):
    methods: list[MethodPair] = Field(min_length=1, max_length=20)


class VariantBody(BaseModel):
    variant: str = Field(min_length=2, max_length=64)


class ThresholdBody(BaseModel):
    method: MethodPair
    scorer: str = Field(min_length=2, max_length=64)
    thresholds: list[float] = Field(min_length=1, max_length=12)
    top_k: int | None = Field(None, ge=1, le=1000)
    mode: str = Field("absolute", pattern="^(absolute|share)$")


class RegisterBody(BaseModel):
    plugin: str = Field(min_length=1, max_length=80)


@router.get("/info")
def info(request: Request):
    inst = request.app.state.installation
    st = inst.plugin_status()
    return dict(app=APP_NAME, subtitle=APP_SUBTITLE, developer=DEVELOPER, version=app_version(),
                installation_id=inst.id, plugins_enabled=st["enabled"], plugin_mode=st["mode"],
                problems=[dict(problem_id=p.problem_id, title=p.title, synthetic=p.synthetic)
                          for p in registry.all_problems()],
                problem_load_errors=sorted(registry.load_errors()))


@router.get("/problems")
def problems():
    return dict(problems=[p.describe() for p in registry.all_problems()])


@router.get("/problems/{problem_id}")
def problem(problem_id: str):
    return _problem(problem_id).describe()


@router.get("/integrations")
def integrations():
    return dict(sources=integrations_catalogue())


@router.get("/problems/{problem_id}/methods")
def methods(problem_id: str, request: Request):
    p, w = _problem(problem_id), ws(request)
    st = w.inst.plugin_status()
    return dict(builtin=builtin_refs(p), registered=w.registered_methods(problem_id), plugins=w.available_plugins(p),
                plugins_enabled=st["enabled"], plugin_status={k: v for k, v in st.items() if k != "checks"},
                isolation_checks=st["checks"], can_register=st["enabled"] and (st["isolation"] == "sandbox"
                                                                              or request.state.session.is_admin),
                contract="register_method(method_metadata, solve_function) — see docs/EXTENDING.md")


@router.post("/problems/{problem_id}/methods/register")
def register(problem_id: str, body: RegisterBody, request: Request):
    return _call(ws(request).register_plugin, _problem(problem_id), body.plugin, admin=request.state.session.is_admin)


@router.get("/campaigns")
def campaigns(request: Request, problem_id: str | None = None):
    return dict(campaigns=ws(request).list(problem_id))


@router.post("/campaigns")
def create(body: CreateBody, request: Request):
    return _call(ws(request).create_campaign, body.problem_id, body.title, body.scenario_params,
                 [tuple(m) for m in body.methods], body.repetitions, body.timeout_s, body.time_budget_s)


@router.get("/campaigns/{cid}")
def get(cid: str, request: Request):
    w = ws(request)
    c = _call(w.get, cid)
    return dict(campaign=c, import_record=w.import_record(cid), optimality_scope=_call(scope_counts, w, c),
                lineage=[dict(campaign_id=x["campaign_id"], kind=x["kind"], owner_display=x["owner_display"],
                              checksum=x.get("checksum"), installation_id=x["installation_id"])
                         for x in _call(w.lineage, cid)])


@router.get("/campaigns/{cid}/record.json")
def record(cid: str, request: Request):
    c = _call(ws(request).get, cid)
    return Response(canonical(c), media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="campaign_{cid}.json"'})


@router.post("/campaigns/{cid}/execute")
def execute(cid: str, request: Request):
    w = ws(request)
    c = _call(w.get, cid)
    if c.get("checksum") or w.import_record(cid):
        raise HTTPException(409, "locked or imported campaigns cannot be executed again; derive a new campaign")
    _call(problem_for, c)
    try:
        return request.app.state.jobs.start(w.user, "execute", f"{w.user}/{cid}", lambda mon: w.execute(cid, mon),
                                            title=c["title"])
    except RuntimeError as e:
        raise HTTPException(409, str(e)) from None


@router.get("/jobs")
def jobs_history(request: Request, limit: int = 50):
    return dict(jobs=request.app.state.jobs.history(ws(request).user, limit))


@router.get("/jobs/{jid}")
def job(jid: str, request: Request, events: bool = True):
    j = request.app.state.jobs.get(ws(request).user, jid, events)
    if not j:
        raise HTTPException(404, "job not found")
    return j


@router.post("/jobs/{jid}/cancel")
def cancel_job(jid: str, request: Request):
    j = request.app.state.jobs.cancel(ws(request).user, jid)
    if not j:
        raise HTTPException(404, "job not found")
    return j


@router.post("/campaigns/{cid}/lock")
def lock(cid: str, request: Request):
    c = _call(ws(request).lock, cid)
    return dict(campaign_id=cid, checksum=c["checksum"], locked_at=c["locked_at"])


@router.get("/campaigns/{cid}/export")
def export(cid: str, request: Request):
    data, info_ = _call(ws(request).export_bundle, cid)
    return Response(data, media_type="application/zip", headers={
        "Content-Disposition": f'attachment; filename="move_openlab_campaign_{cid}.zip"',
        "X-Bundle-SHA256": info_["bundle_sha256"], "X-Manifest-SHA256": info_["manifest_sha256"]})


@router.post("/import")
async def import_bundle(request: Request, file: UploadFile = File(...)):
    data = await file.read(MAX_BUNDLE_BYTES + 1)
    return _call(ws(request).import_bundle, data)


@router.post("/campaigns/{cid}/reproduce")
def reproduce(cid: str, request: Request):
    return _call(ws(request).create_reproduction, cid)


@router.post("/campaigns/{cid}/extend")
def extend(cid: str, body: ExtendBody, request: Request):
    return _call(ws(request).create_extension, cid, [tuple(m) for m in body.methods])


@router.post("/campaigns/{cid}/variant")
def variant(cid: str, body: VariantBody, request: Request):
    return _call(ws(request).create_variant, cid, body.variant)


@router.post("/campaigns/{cid}/threshold-study")
def threshold_study(cid: str, body: ThresholdBody, request: Request):
    return _call(ws(request).create_threshold_study, cid, tuple(body.method), body.scorer, body.thresholds, body.top_k,
                 body.mode)


@router.get("/campaigns/{cid}/reproducibility")
def get_reproducibility(cid: str, request: Request):
    return _call(reproducibility, ws(request), cid)


@router.get("/campaigns/{cid}/compare")
def get_compare(cid: str, request: Request):
    return _call(compare, ws(request), cid)


@router.get("/campaigns/{cid}/threshold-report")
def get_threshold_report(cid: str, request: Request):
    return _call(threshold_report, ws(request), cid)


@router.get("/campaigns/{cid}/report.md")
def report_md(cid: str, request: Request):
    return PlainTextResponse(_call(comparison_markdown, ws(request), cid), media_type="text/markdown",
                             headers={"Content-Disposition": f'attachment; filename="comparison_{cid}.md"'})


@router.get("/campaigns/{cid}/report.csv")
def report_csv(cid: str, request: Request):
    return PlainTextResponse(_call(comparison_csv, ws(request), cid), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="comparison_{cid}.csv"'})


@router.get("/semantic-compare")
def get_semantic_compare(reference: str, candidate: str, request: Request):
    return _call(semantic_compare, ws(request), reference, candidate)
