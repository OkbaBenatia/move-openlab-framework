"""Runtime settings, read from the environment once per application instance.

``MOVE_OPENLAB_DATA_DIR``         installation data directory (campaigns, instances, workspaces)   [default ./.openlab-data]
``MOVE_OPENLAB_PLUGIN_DIR``       approved local plugin directory; unset = built-in methods only
``MOVE_OPENLAB_PLUGIN_MODE``      ``disabled`` (default) | ``sandbox`` (verified bubblewrap isolation, fail closed) |
                                  ``trusted-process`` (administrators only; NOT a sandbox; refused in production)
``MOVE_OPENLAB_INSTALLATION_ID``  optional fixed installation identifier
``MOVE_OPENLAB_AUTH_DB``          SQLite credential store                               [default <data>/auth.sqlite3]
``MOVE_OPENLAB_ENV``              ``development`` (default) or ``production``
``SESSION_SECRET``                session signing key, >= 32 characters (required in production)
``SESSION_TTL_HOURS``             session lifetime                                                  [default 8]
``COOKIE_SECURE``                 force the Secure cookie flag (default: on in production)
``MOVE_OPENLAB_FRONTEND_DIST``    built frontend directory served by the API          [default ./frontend/dist]
``MOVE_OPENLAB_TILE_URL``         map tile URL template                 [default OpenStreetMap standard tiles]
``MOVE_OPENLAB_TILE_ATTRIBUTION`` attribution shown on maps             [default © OpenStreetMap contributors]
``MOVE_OPENLAB_OVERPASS_URL``     Overpass API endpoint for road networks         [default overpass-api.de]
``MOVE_OPENLAB_GEOCODER_URL``     place-search endpoint (Nominatim API); ``off`` disables search  [default nominatim.openstreetmap.org]
``MOVE_OPENLAB_EXTERNAL_FETCH``   who may start downloads from public services (road networks, RPC releases):
                                  ``researcher`` (default; per-user daily quotas) or ``admin``
``MOVE_OPENLAB_DAILY_NETWORKS``   road-network downloads per user per day                          [default 10]
``MOVE_OPENLAB_DAILY_RPC``        RPC release ingestions per user per day                         [default 3]
``MOVE_OPENLAB_DAILY_SEARCHES``   place searches sent to the geocoder per user per day (cache hits are free) [default 200]
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _path(name: str, default: str | None) -> Path | None:
    v = os.environ.get(name, "").strip()
    return Path(v).expanduser() if v else (Path(default) if default else None)


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    plugin_dir: Path | None
    installation_id: str | None
    auth_db: Path | None
    production: bool
    session_secret: str
    session_ttl_s: int
    cookie_secure: bool
    frontend_dist: Path
    plugin_mode: str = "disabled"
    tile_url: str = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
    tile_attribution: str = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    overpass_url: str = "https://overpass-api.de/api/interpreter"
    geocoder_url: str = "https://nominatim.openstreetmap.org/search"
    external_fetch: str = "researcher"
    daily_networks: int = 10
    daily_rpc: int = 3
    daily_searches: int = 200

    @classmethod
    def from_env(cls) -> "Settings":
        data = _path("MOVE_OPENLAB_DATA_DIR", ".openlab-data")
        production = os.environ.get("MOVE_OPENLAB_ENV", "development").strip().lower() == "production"
        try:
            ttl = max(300, int(float(os.environ.get("SESSION_TTL_HOURS", "8")) * 3600))
        except ValueError:
            ttl = 8 * 3600
        cs = os.environ.get("COOKIE_SECURE", "").strip().lower()
        auth_db = os.environ.get("MOVE_OPENLAB_AUTH_DB", "").strip()
        fetch = os.environ.get("MOVE_OPENLAB_EXTERNAL_FETCH", "researcher").strip().lower()

        def _int(name: str, default: int) -> int:
            try:
                return max(0, int(os.environ.get(name, str(default))))
            except ValueError:
                return default
        return cls(data_dir=data, plugin_dir=_path("MOVE_OPENLAB_PLUGIN_DIR", None),
                   installation_id=os.environ.get("MOVE_OPENLAB_INSTALLATION_ID", "").strip() or None,
                   auth_db=None if auth_db == ":memory:" else Path(auth_db) if auth_db else data / "auth.sqlite3",
                   production=production, session_secret=os.environ.get("SESSION_SECRET", "").strip(),
                   session_ttl_s=ttl, cookie_secure=(cs in ("1", "true", "yes")) if cs else production,
                   frontend_dist=_path("MOVE_OPENLAB_FRONTEND_DIST", "frontend/dist"),
                   plugin_mode=os.environ.get("MOVE_OPENLAB_PLUGIN_MODE", "disabled").strip().lower() or "disabled",
                   external_fetch="admin" if fetch == "admin" else "researcher",
                   daily_networks=_int("MOVE_OPENLAB_DAILY_NETWORKS", 10), daily_rpc=_int("MOVE_OPENLAB_DAILY_RPC", 3),
                   daily_searches=_int("MOVE_OPENLAB_DAILY_SEARCHES", 200),
                   **{k: v for k, v in dict(tile_url=os.environ.get("MOVE_OPENLAB_TILE_URL", "").strip(),
                                            tile_attribution=os.environ.get("MOVE_OPENLAB_TILE_ATTRIBUTION", "").strip(),
                                            overpass_url=os.environ.get("MOVE_OPENLAB_OVERPASS_URL", "").strip(),
                                            geocoder_url=os.environ.get("MOVE_OPENLAB_GEOCODER_URL", "").strip()).items() if v})
