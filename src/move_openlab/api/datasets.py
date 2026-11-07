"""Trip datasets: RPC open-data releases (shared) and CSV / GeoJSON uploads (private to the workspace).

Uploads are read in memory up to a size limit, parsed by the provider, validated and, when the researcher saves
them, stored as normalised trips with a provenance report. The uploaded file itself is never stored, so no staging
area needs cleaning; a validation request without ``save`` leaves no trace.
"""
from __future__ import annotations

import json
import time

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field

from ..datasets import MAX_UPLOAD_BYTES, DatasetError, DatasetStore, build_report, catalogue, providers
from ..datasets.tabular import summary
from ..integrations import rpc
from ..limits import SERIAL, QuotaExceeded
from .areas import areas
from .experiments import ws
from .geo import load_dataset, require_fetch_permission, rpc_root, start_job

router = APIRouter(prefix="/api/datasets")
_releases: dict = {}


def _mine(request: Request) -> DatasetStore:
    return DatasetStore(ws(request).root)


def _area_bbox(request: Request, area_id: str | None):
    if not area_id:
        return None, None
    try:
        a = areas(request).get(area_id)
    except KeyError:
        raise HTTPException(404, "area not found") from None
    return a, a["bbox"]


@router.get("")
def list_datasets(request: Request):
    shared = [dict(dataset_key=d["dataset_key"], provider="rpc", name=f"RPC {d['release']} · {d['area']['name']}",
                   rows_kept=d["rows_kept"], area=d["area"], licence=d["licence"]["name"], attribution=d["attribution"],
                   release=d["release"]) for d in rpc.list_datasets(rpc_root(request))]
    mine = [dict(dataset_key=d["dataset_key"], provider=d["provider"], name=d["name"], rows_kept=d["rows_kept"],
                 saved_at=d["saved_at"], coverage=d.get("coverage"), source=d.get("source"))
            for d in _mine(request).list()]
    return dict(providers=catalogue(), shared=shared, mine=mine, max_upload_bytes=MAX_UPLOAD_BYTES)


# ---------------------------------------------------------------- RPC open data (France)
@router.get("/rpc/releases")
def rpc_releases(request: Request):
    if not _releases or time.time() - _releases.get("t", 0) > 3600:
        try:
            _releases.update(t=time.time(), items=rpc.list_releases())
        except Exception as e:                              # network errors are reported, not hidden
            raise HTTPException(502, f"data.gouv.fr unavailable: {type(e).__name__}") from None
    return dict(releases=_releases["items"], licence=rpc.LICENCE, producer=rpc.PRODUCER, dataset=rpc.DATASET_PAGE,
                coverage="France (metropolitan and overseas departments)")


class IngestBody(BaseModel):
    release: str = Field(pattern=r"^\d{4}-\d{2}$")
    area_id: str


@router.post("/rpc/ingest")
def rpc_ingest(body: IngestBody, request: Request):
    area, bbox = _area_bbox(request, body.area_id)
    region = rpc.france_region(bbox)
    if region is None:
        raise HTTPException(400, f"RPC open data covers France only; the area '{area['name']}' lies outside France. "
                                 "Use a CSV or GeoJSON dataset, or synthetic demand, for this area")
    root = rpc_root(request)
    key = rpc.dataset_key(body.release, bbox)
    if (root / key / "report.json").exists():
        return dict(cached=True, dataset=json.loads((root / key / "report.json").read_text()))
    require_fetch_permission(request)
    rel = next((r for r in rpc_releases(request)["releases"] if r["release"] == body.release), None)
    if rel is None:
        raise HTTPException(404, "release not found")
    try:
        rpc.check_download_url(rel["url"])
        request.app.state.quotas["rpc"].take(request.state.session.username)
    except ValueError as e:
        raise HTTPException(502, str(e)) from None
    except QuotaExceeded as e:
        raise HTTPException(429, str(e)) from None

    def work(mon):
        if not SERIAL["data.gouv.fr"].acquire(blocking=False):
            mon.event("queued", "another RPC download is running; waiting for it (one at a time)")
            SERIAL["data.gouv.fr"].acquire()
        try:
            mon.event("download", f"streaming {rel['title']} ({rel.get('filesize')} bytes) from data.gouv.fr")
            rep = rpc.ingest(rel, bbox, area["name"], root, progress=mon, cancel=mon.cancel)
        finally:
            SERIAL["data.gouv.fr"].release()
        mon.event("stored", f"{rep['rows_kept']} trips kept of {rep['rows_read']} read ({region}); "
                            f"sha256 {rep['source']['sha256'][:16]}")
    return dict(cached=False, job=start_job(request, "rpc-ingest", f"rpc/{key}", f"RPC {body.release} · {area['name']}",
                                            work))


# ---------------------------------------------------------------- uploads (CSV, GeoJSON)
def _provider(pid: str):
    p = providers().get(pid)
    if p is None or p.kind != "upload":
        raise HTTPException(404, f"unknown upload format {pid!r}")
    return p


async def _read(file: UploadFile) -> bytes:
    raw = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"file larger than {MAX_UPLOAD_BYTES // 2**20} MB")
    if not raw:
        raise HTTPException(400, "empty file")
    return raw


@router.post("/{pid}/inspect")
async def inspect(pid: str, request: Request, file: UploadFile = File(...), delimiter: str | None = Form(None)):
    p = _provider(pid)
    raw = await _read(file)
    try:
        return dict(p.inspect(raw, delimiter=delimiter or None), filename=file.filename, bytes=len(raw))
    except DatasetError as e:
        raise HTTPException(400, str(e)) from None


@router.post("/{pid}/import")
async def import_dataset(pid: str, request: Request, file: UploadFile = File(...), mapping: str = Form(...),
                         name: str = Form(""), time_format: str = Form("auto"), date_format: str = Form("YYYY-MM-DD"),
                         delimiter: str | None = Form(None), area_id: str | None = Form(None),
                         save: bool = Form(False), accept_rejections: bool = Form(False)):
    """Validate (``save`` false) or validate and store (``save`` true). Rejected rows are never dropped silently:
    saving a dataset with rejections requires ``accept_rejections``."""
    p = _provider(pid)
    raw = await _read(file)
    try:
        m = json.loads(mapping)
        if not isinstance(m, dict) or not all(isinstance(v, (str, type(None))) for v in m.values()):
            raise ValueError
    except ValueError:
        raise HTTPException(400, "mapping must be a JSON object of field -> column") from None
    area, bbox = _area_bbox(request, area_id)
    try:
        col, meta = p.parse(raw, m, time_format=time_format, date_format=date_format, delimiter=delimiter or None)
    except DatasetError as e:
        raise HTTPException(400, str(e)) from None
    report = build_report(p, file.filename or "", raw, col, meta, bbox)
    if area:
        report["checked_area"] = dict(area_id=area["area_id"], name=area["name"], bbox=area["bbox"])
    problems = []
    if not col.trips:
        problems.append("no valid trip: fix the mapping or the file")
    if area and report["coverage"].get("inside_area", 0) == 0 and col.trips:
        problems.append(f"no trip has both ends inside the area '{area['name']}'; check the area, or latitude/longitude order")
    report["problems"] = problems
    if not save:
        return dict(saved=False, report=report)
    if problems:
        raise HTTPException(400, "; ".join(problems))
    if col.rejected and not accept_rejections:
        raise HTTPException(409, f"{sum(col.rejected.values())} row(s) were rejected; confirm to save the "
                                 f"{len(col.trips)} valid trip(s)")
    try:
        rec = _mine(request).save(name, col.trips, report)
    except DatasetError as e:
        raise HTTPException(400, str(e)) from None
    return dict(saved=True, report=rec)


@router.get("/{key}")
def get_dataset(key: str, request: Request, sample: int = 300):
    trips, rep = load_dataset(request, key)
    n = max(0, min(sample, 2000))
    step = max(1, len(trips) // n) if n else len(trips) + 1
    return dict(report=rep, coverage=summary(trips), sample=trips[::step][:n])


@router.delete("/{key}")
def delete_dataset(key: str, request: Request):
    if not key.startswith("u-"):
        raise HTTPException(403, "shared open-data subsets are managed by administrators")
    try:
        _mine(request).delete(key)
    except KeyError:
        raise HTTPException(404, "dataset not found") from None
    return dict(deleted=key)
