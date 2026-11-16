"""Place search, named areas (workspace) and road-network downloads for an area.

Downloads go to the configured Overpass endpoint only, one at a time for the whole installation, within the profile's
area limit and the user's daily quota. A network already stored for the same box and profile is reused without any
request.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ..geo.areas import AreaStore
from ..geo.osm import PROFILES, SourceUnavailable, fetch_overpass
from ..runner import Cancelled
from ..limits import SERIAL, QuotaExceeded
from .experiments import ws
from .geo import require_fetch_permission, start_job, store

router = APIRouter(prefix="/api/geo")


def areas(request: Request) -> AreaStore:
    return AreaStore(ws(request).root)


def _get(request: Request, area_id: str) -> dict:
    try:
        return areas(request).get(area_id)
    except KeyError:
        raise HTTPException(404, "area not found") from None


@router.get("/geocode")
def geocode(q: str, request: Request):
    g = request.app.state.geocoder
    try:
        return g.search(q, before_request=lambda: request.app.state.quotas["geocode"].take(request.state.session.username))
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    except QuotaExceeded as e:
        raise HTTPException(429, str(e)) from None
    except SourceUnavailable as e:
        raise HTTPException(503 if not g.enabled or "busy" in str(e) else 502, str(e)) from None


class AreaBody(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    bbox: list[float] = Field(min_length=4, max_length=4)
    profile: str = "car"
    origin: dict | None = None


class AreaUpdate(BaseModel):
    name: str | None = Field(None, min_length=2, max_length=80)
    bbox: list[float] | None = Field(None, min_length=4, max_length=4)
    profile: str | None = None


def _with_cache(request: Request, rec: dict, index: dict | None = None) -> dict:
    if index is None:
        hit = store(request).find(rec["bbox"], rec["profile"])
    else:
        hit = index.get(store(request).key(rec["bbox"], rec["profile"]))
    return dict(rec, cached_network=hit["network_id"] if hit else None)


@router.get("/areas")
def list_areas(request: Request):
    index = store(request).index()                       # one pass over stored networks for the whole list
    return dict(areas=[_with_cache(request, a, index) for a in areas(request).list()])


@router.post("/areas")
def create_area(body: AreaBody, request: Request):
    origin = {k: str(v)[:300] for k, v in (body.origin or {}).items() if k in ("search", "name", "kind")}
    try:
        hit = store(request).find(body.bbox, body.profile)
        return _with_cache(request, areas(request).create(body.name, body.bbox, body.profile, origin,
                                                          hit["network_id"] if hit else None))
    except ValueError as e:
        raise HTTPException(400, str(e)) from None


@router.get("/areas/{area_id}")
def get_area(area_id: str, request: Request):
    return _with_cache(request, _get(request, area_id))


@router.put("/areas/{area_id}")
def update_area(area_id: str, body: AreaUpdate, request: Request):
    cur = _get(request, area_id)
    try:
        hit = store(request).find(body.bbox or cur["bbox"], body.profile or cur["profile"])
        return _with_cache(request, areas(request).update(area_id, body.name, body.bbox, body.profile,
                                                          hit["network_id"] if hit else None))
    except ValueError as e:
        raise HTTPException(400, str(e)) from None


@router.delete("/areas/{area_id}")
def delete_area(area_id: str, request: Request):
    _get(request, area_id)
    areas(request).delete(area_id)                  # the shared network, if any, is kept
    return dict(deleted=area_id)


class NetworkRequest(BaseModel):
    refresh: bool = False


@router.post("/areas/{area_id}/network")
def fetch_network(area_id: str, body: NetworkRequest, request: Request):
    """Attach a stored network for the area's box and profile, or download one (background job)."""
    rec = _get(request, area_id)
    st, a = store(request), areas(request)
    hit = st.find(rec["bbox"], rec["profile"])
    if hit and not body.refresh:
        return dict(cached=True, area=a.attach(area_id, hit["network_id"]), network=hit)
    if body.refresh and not request.state.session.is_admin:
        raise HTTPException(403, "only administrators can refresh a stored network")
    require_fetch_permission(request)
    quota, user = request.app.state.quotas["networks"], request.state.session.username
    try:
        quota.take(user)
    except QuotaExceeded as e:
        raise HTTPException(429, str(e)) from None
    url = request.app.state.settings.overpass_url
    bbox, prof, name = rec["bbox"], rec["profile"], rec["name"]

    def attach_if_unchanged(mon, network_id: str) -> None:
        try:
            now = a.get(area_id)
        except KeyError:
            mon.event("note", "the area was deleted meanwhile; the network stays stored for other areas")
            return
        if now["bbox"] == bbox and now["profile"] == prof:
            a.attach(area_id, network_id)
        else:
            mon.event("note", "the area was edited meanwhile; the network is stored but not attached")

    def work(mon):
        if not SERIAL["overpass"].acquire(blocking=False):
            mon.event("queued", "another road-network download is running; waiting for it (one at a time)")
            SERIAL["overpass"].acquire()
        try:
            if mon.cancel.is_set():
                raise Cancelled("cancelled before the download started")
            hit = None if body.refresh else st.find(bbox, prof)    # downloaded by another job while waiting?
            if hit:
                mon.event("cached", f"network {hit['network_id']} already stored")
                return attach_if_unchanged(mon, hit["network_id"])
            mon.event("download", f"Overpass query: {PROFILES[prof]['label']}, {rec['km2']} km²")
            raw = fetch_overpass(bbox, url, profile_name=prof)
        finally:
            SERIAL["overpass"].release()
        if mon.cancel.is_set():
            raise Cancelled("cancelled; the response was discarded")
        mon.event("build", f"{len(raw)} bytes received; building the road graph")
        p = st.save(raw, dict(name=None, bbox=list(bbox)), url, prof)    # shared resource: no private area name
        attach_if_unchanged(mon, p["network_id"])
        mon.event("stored", f"network {p['network_id']}: {p['nodes']} nodes, {p['edges']} edges")
    try:
        job = start_job(request, "osm-network", f"network/{area_id}", f"Road network · {name}", work)
    except HTTPException:
        quota.refund(user)
        raise
    return dict(cached=False, job=job)
