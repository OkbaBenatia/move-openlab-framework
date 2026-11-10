"""HTTP API and single-origin web application."""
from __future__ import annotations

from fastapi import FastAPI

from ..auth import Auth
from ..geo.geocode import Geocoder
from ..jobs import Jobs
from ..limits import DailyQuota
from ..settings import Settings
from ..store import Installation
from ..version import APP_NAME, app_version


def create_app(settings: Settings | None = None, auth: Auth | None = None) -> FastAPI:
    from .admin import router as admin_router
    from .areas import router as areas_router
    from .datasets import router as datasets_router
    from .experiments import router as experiments_router
    from .geo import router as geo_router
    from .lab import router as lab_router
    from .supervision import router as supervision_router
    from ..datasets import MAX_UPLOAD_BYTES
    from ..store import MAX_BUNDLE_BYTES
    from .web import AuthGuard, BodyLimit, mount_frontend, router as web_router
    settings = settings or Settings.from_env()
    from .. import privatefiles
    for name in ("audit.log", "dev-credentials.json"):  # owner-only, also when written by an earlier version
        privatefiles.tighten(settings.data_dir / name)
    if settings.production and len(settings.session_secret) < 32:
        raise RuntimeError("production requires SESSION_SECRET (at least 32 characters)")
    if settings.production and settings.plugin_mode == "trusted-process":
        raise RuntimeError("trusted-process plugin mode is not a sandbox and is refused in production; use 'sandbox'")
    app = FastAPI(title=APP_NAME, version=app_version(), docs_url=None,
                  redoc_url=None, openapi_url=None if settings.production else "/api/openapi.json")
    app.state.settings = settings
    app.state.auth = auth or Auth(settings)
    app.state.installation = Installation(settings.data_dir, settings.plugin_dir, settings.installation_id,
                                          plugin_mode=settings.plugin_mode, protected=(settings.auth_db,))
    app.state.jobs = Jobs(settings.data_dir / "jobs")
    app.state.jobs.recover()                                  # jobs left running by a stopped server -> interrupted
    app.state.installation.recover_interrupted()             # their campaigns -> draft
    app.state.geocoder = Geocoder(settings.geocoder_url, settings.data_dir / "cache" / "geocode", provider=settings.geocoder_provider)
    app.state.quotas = dict(networks=DailyQuota(settings.daily_networks, "road-network downloads"),
                            rpc=DailyQuota(settings.daily_rpc, "RPC ingestions"),
                            geocode=DailyQuota(settings.daily_searches, "place searches"))
    app.add_middleware(AuthGuard)
    mb = 1024 * 1024
    app.add_middleware(BodyLimit, limits=[("/api/datasets/", MAX_UPLOAD_BYTES + mb), ("/api/import", MAX_BUNDLE_BYTES + mb)],
                       default=2 * mb)                  # outermost: runs before authentication and body parsing
    app.include_router(web_router)
    app.include_router(experiments_router)
    app.include_router(admin_router)
    app.include_router(supervision_router)
    app.include_router(geo_router)
    app.include_router(areas_router)
    app.include_router(datasets_router)
    app.include_router(lab_router)
    mount_frontend(app, settings.frontend_dist)
    return app
