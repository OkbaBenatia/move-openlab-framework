"""Experiment API. Every route requires a signed-in user (AuthGuard) and works in that user's own workspace: a
researcher can never read or modify another researcher's campaigns. Imported bundles never contain or trigger
executable code; methods are resolved from the trusted local installation."""
from __future__ import annotations

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import PlainTextResponse, Response
from pydantic import BaseModel, Field

from .. import plugins as plugin_files, registry
from ..analysis.common import scope_counts
from ..analysis.compare import compare
from ..analysis.report import comparison_csv, comparison_markdown
from ..analysis.reproducibility import reproducibility
from ..analysis.semantic import semantic_compare
from ..analysis.threshold import threshold_report
from ..hashing import canonical
from ..datasets import catalogue as dataset_catalogue
from ..methods import ContractError, builtin_registry
from ..store import MAX_BUNDLE_BYTES, BenchError, NotFound, Workspace, builtin_refs, problem_for
from ..version import APP_NAME, APP_SUBTITLE, DEVELOPER, app_version, display_version

router = APIRouter(prefix="/api")
MethodPair = tuple[str, str]


def ws(request: Request) -> Workspace:
    ses = request.state.session
    if ses is None:
        raise HTTPException(401, "authentication required")
    return request.app.state.installation.workspace(ses.username, ses.display, public_only=public_context(request))


def public_context(request: Request) -> bool:
    """A request made from the public Workspace (header ``X-Move-Context: public``): restricted problems and their
    records are left out even when they are granted to the account. The header can only narrow what is returned; the
    grants decide what an account may ever see."""
    return request.headers.get("x-move-context", "").strip().lower() == "public"


def _problem(problem_id: str, request: Request):
    """An installed problem the signed-in account may use. A restricted problem that is not granted to the account
    answers like a problem that is not installed; the refused attempt is written to the audit log."""
    w = ws(request)
    try:
        return w.problem(problem_id)
    except BenchError as e:
        try:
            registry.get(problem_id)
        except registry.UnknownProblem:
            pass
        else:
            # a refusal is audited; a granted account asking from the public context is not refused, only out of context
            if not request.app.state.installation.access.allows(registry.get(problem_id), w.user):
                from .admin import audit
                audit(request, w.user, "refused_restricted_problem", problem_id)
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
    emissions: dict | None = None                  # {scope, baseline}: experiment configuration of the domain metrics
    method_configs: dict[str, dict] | None = Field(None, max_length=20)   # {method_id: solver settings}, schema-checked


class ExtendBody(BaseModel):
    methods: list[MethodPair] = Field(min_length=1, max_length=20)


class VariantBody(BaseModel):
    variant: str = Field(min_length=2, max_length=64)


class ImportResultsBody(BaseModel):
    problem_id: str = Field(min_length=3, max_length=120)
    title: str = Field(min_length=3, max_length=160)
    instance_hashes: list[str] = Field(min_length=1, max_length=500)
    methods: list[MethodPair] = Field(min_length=1, max_length=20)
    method_configs: dict[str, dict] | None = Field(None, max_length=20)
    records: list[dict] = Field(min_length=1, max_length=5000)
    source: dict


class SettingsBody(BaseModel):
    method_configs: dict[str, dict] = Field(min_length=1, max_length=20)
    title: str | None = Field(None, min_length=3, max_length=160)
    methods: list[str] | None = Field(None, max_length=20)          # the methods to run (default: those whose settings changed)
    instance_hashes: list[str] | None = Field(None, max_length=500)  # a subset of the parent's scenarios (default: all)


class ThresholdBody(BaseModel):
    method: MethodPair
    scorer: str = Field(min_length=2, max_length=64)
    thresholds: list[float] = Field(min_length=1, max_length=12)
    top_k: int | None = Field(None, ge=1, le=1000)
    mode: str = Field("absolute", pattern="^(absolute|share)$")


class RegisterBody(BaseModel):
    plugin: str = Field(min_length=1, max_length=120)
    origin: str = Field("approved", pattern="^(approved|uploaded)$")   # the approved folder, or this account's uploads


class CheckBody(RegisterBody):
    selftest: bool = False                         # also one sandboxed run on the self-test instance (nothing recorded)


class TemplateBody(BaseModel):
    name: str = Field(min_length=3, max_length=41)
    display_name: str = Field("", max_length=80)
    author: str = Field("", max_length=80)
    kind: str = Field("heuristic", max_length=16)
    description: str = Field("", max_length=300)


@router.get("/info")
def info(request: Request):
    inst = request.app.state.installation
    st = inst.plugin_status()
    return dict(app=APP_NAME, subtitle=APP_SUBTITLE, developer=DEVELOPER, version=display_version(), release=app_version(),
                installation_id=inst.id, plugins_enabled=st["enabled"], plugin_mode=st["mode"],
                problems=[dict(problem_id=p.problem_id, title=p.title, synthetic=p.synthetic, restricted=bool(p.restricted))
                          for p in ws(request).problems()],
                problem_load_errors=sorted(registry.load_errors()) if request.state.session.is_admin else [])


@router.get("/problems")
def problems(request: Request):
    return dict(problems=[p.describe() for p in ws(request).problems()])


@router.get("/problems/{problem_id}")
def problem(problem_id: str, request: Request):
    return _problem(problem_id, request).describe()


@router.get("/integrations")
def integrations():
    return dict(sources=dataset_catalogue())


@router.get("/problems/{problem_id}/methods")
def methods(problem_id: str, request: Request):
    p, w = _problem(problem_id, request), ws(request)
    st = w.inst.plugin_status()
    settings = {f"{m.method_id}@{m.version}": dict(default_config=m.default_config, config_schema=m.config_schema)
                for m in builtin_registry(p).list() if m.config_schema}
    old = p.archived_methods()
    builtin = [dict(b, recorded_name=b["name"], name=p.method_display_name(b["method_id"], {}) or b["name"], archived=b["method_id"] in old)
               for b in builtin_refs(p)]
    return dict(builtin=builtin, settings=settings, registered=w.registered_methods(problem_id), plugins=w.available_plugins(p),
                plugins_enabled=st["enabled"], plugin_status={k: v for k, v in st.items() if k != "checks"},
                isolation_checks=st["checks"], can_register=st["enabled"] and (st["isolation"] == "sandbox"
                                                                              or request.state.session.is_admin),
                can_upload=st["enabled"] and st["isolation"] == "sandbox",
                upload_limits=dict(zip_bytes=plugin_files.MAX_UPLOAD_BYTES, members=plugin_files.MAX_UPLOAD_MEMBERS,
                                   plugin_bytes=plugin_files.MAX_PLUGIN_BYTES, text_bytes=plugin_files.MAX_TEXT_BYTES,
                                   files=[plugin_files.PLUGIN_FILE, *plugin_files.TEXT_FILES]),
                contract="register_method(method_metadata, solve_function) — see docs/EXTENDING.md")


@router.post("/problems/{problem_id}/methods/register")
def register(problem_id: str, body: RegisterBody, request: Request):
    from .admin import audit
    p, w = _problem(problem_id, request), ws(request)
    entry = _call(w.register_plugin, p, body.plugin, admin=request.state.session.is_admin, origin=body.origin)
    audit(request, w.user, "plugin_registered", f"{p.problem_id}/{entry['method_id']}@{entry['version']} "
                                                f"({body.origin}, code sha256 {entry['code_sha256'][:16]})")
    return entry


@router.post("/problems/{problem_id}/methods/check")
def check_plugin(problem_id: str, body: CheckBody, request: Request):
    """Compatibility check of a catalogue plug-in, step by step; with ``selftest``, one sandboxed run on the problem's
    reserved self-test instance. Nothing is registered."""
    return _call(ws(request).check_plugin, _problem(problem_id, request), body.plugin, body.origin, body.selftest,
                 admin=request.state.session.is_admin)


@router.post("/problems/{problem_id}/methods/upload")
async def upload_plugin(problem_id: str, request: Request, file: UploadFile = File(...)):
    """A completed plug-in as a ZIP: checked before anything is stored (see ``plugins.inspect_archive``), stored in this
    account's own workspace only, never executed here. Sandbox mode only."""
    from .admin import audit
    p, w = _problem(problem_id, request), ws(request)
    data = await file.read(plugin_files.MAX_UPLOAD_BYTES + 1)
    try:
        rec = _call(w.upload_plugin, p, data, admin=request.state.session.is_admin)
    except HTTPException as e:
        audit(request, w.user, "plugin_upload_refused", f"{p.problem_id}: {str(e.detail)[:160]}")
        raise
    audit(request, w.user, "plugin_uploaded", f"{p.problem_id}/{rec['method_id']}@{rec['version']} (code sha256 "
                                              f"{rec['code_sha256'][:16]}, upload sha256 {rec['upload_sha256'][:16]})")
    return dict(upload=rec, steps=[dict(step="archive", ok=True, detail="ZIP checked: " + ", ".join(sorted(rec["files"]))),
                                   dict(step="metadata", ok=True, detail=f"{rec['method_id']}@{rec['version']} ({rec['kind']}) "
                                                                         f"for {p.problem_id}")])


@router.get("/problems/{problem_id}/methods/template")
def template_info(problem_id: str, request: Request):
    """What a method of this problem receives and returns, and the rules of the template form."""
    from ..method_tools import NAME, template_values
    return dict(template_values(_problem(problem_id, request)), name_pattern=NAME.pattern,
                files=["plugin.py", "test_plugin.py", "README.md"])


@router.post("/problems/{problem_id}/methods/template")
def template(problem_id: str, body: TemplateBody, request: Request):
    """The method template as a ZIP (``<name>/plugin.py``, ``test_plugin.py``, ``README.md``): the same template and
    rendering as ``move-openlab method new``. Nothing is stored or executed."""
    from ..method_tools import template_zip
    p = _problem(problem_id, request)
    try:
        data = template_zip(body.name, p.problem_id, body.author, body.display_name, body.kind, body.description)
    except ValueError as e:
        raise HTTPException(422, str(e)) from None
    return Response(data, media_type="application/zip", headers={
        "Content-Disposition": f'attachment; filename="{body.name}.zip"', "Cache-Control": "no-store"})


@router.get("/campaigns")
def campaigns(request: Request, problem_id: str | None = None):
    return dict(campaigns=ws(request).list(problem_id))


@router.post("/campaigns")
def create(body: CreateBody, request: Request):
    return _call(ws(request).create_campaign, body.problem_id, body.title, body.scenario_params,
                 [tuple(m) for m in body.methods], body.repetitions, body.timeout_s, body.time_budget_s,
                 emissions=body.emissions, method_configs=body.method_configs)


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
def jobs_history(request: Request, limit: int = 50, campaign: str | None = None):
    """The user's jobs, newest first; ``campaign`` keeps only the executions of that campaign."""
    w = ws(request)
    user = w.user
    jobs = request.app.state.jobs.history(user, limit, subject=f"{user}/{campaign}" if campaign else None)
    if w.public_only:
        jobs = [j for j in jobs if _job_in_context(w, j)]
    return dict(jobs=jobs)


def _job_in_context(w: Workspace, job: dict) -> bool:
    """In the public context, a job about a record the context leaves out (a restricted problem's) is left out too."""
    cid = str(job.get("subject", "")).partition("/")[2]
    if not cid.startswith("c-"):
        return True
    try:
        w.get(cid)
    except NotFound:
        return not (w._cdir(cid) / "campaign.json").exists()          # a record that exists but is out of context
    except BenchError:
        return True
    return True


@router.get("/jobs/{jid}")
def job(jid: str, request: Request, events: bool = True):
    w = ws(request)
    j = request.app.state.jobs.get(w.user, jid, events)
    if not j or (w.public_only and not _job_in_context(w, j)):
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
def export(cid: str, request: Request, geometry: bool = True, evidence: bool = False, ml_evidence: str = "full"):
    """One ZIP. ``evidence=true`` puts the evidence report inside it (``evidence/report.json``, listed and checksummed in
    the manifest like every other member); nothing else is downloaded. ``ml_evidence`` (``full`` · ``reference`` ·
    ``none``) says what of the ML evaluation evidence imported for these records goes in (``ml_evaluations/``)."""
    w = ws(request)
    doc = None
    if evidence:
        from .lab import evidence_doc                    # lazy: the Workspace API module imports this one
        if not all(c.get("checksum") for c in _call(w.lineage, cid)):
            raise HTTPException(400, "lock the campaign before exporting it")
        doc = evidence_doc(cid, request)
    data, info_ = _call(w.export_bundle, cid, geometry, doc, ml_evidence)
    return Response(data, media_type="application/zip", headers={
        "Content-Disposition": f'attachment; filename="move_openlab_campaign_{cid}.zip"',
        "X-Bundle-SHA256": info_["bundle_sha256"], "X-Manifest-SHA256": info_["manifest_sha256"],
        "X-Bundle-Evidence": "included" if doc else "not-included",
        "X-Bundle-ML-Evidence": (info_.get("ml_evaluations") or {}).get("mode") or "none"})


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


@router.post("/campaigns/import-results")
def import_results(body: ImportResultsBody, request: Request):
    """Results computed outside the platform (data only), re-validated and stored as a new locked experiment."""
    _problem(body.problem_id, request)
    return _call(ws(request).import_results, body.problem_id, body.title, body.instance_hashes, [tuple(m) for m in body.methods],
                 body.records, body.source, body.method_configs)


@router.post("/campaigns/{cid}/settings")
def settings_version(cid: str, body: SettingsBody, request: Request):
    """New experiment version with changed solver settings (the locked parent is never modified)."""
    return _call(ws(request).create_settings_version, cid, body.method_configs, body.title, body.methods, body.instance_hashes)


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
