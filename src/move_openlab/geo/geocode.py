"""Place search through a configured geocoding service, behind a small provider abstraction.

The server is the only client of the service (a caching proxy); the provider decides what the interface may do:

``nominatim`` (default: the public OpenStreetMap Nominatim API, or a self-hosted instance)
    explicit searches only (submitted by the user, never search-as-you-type), one request per second for the whole
    installation whatever the number of users, an identifying User-Agent, results cached on disk for 30 days so
    repeated searches never reach the service — the usage policy of the public service.
``photon``  (a Photon / Komoot-compatible service — self-hosted, or one whose terms allow it)
    search-as-you-type permitted (``autocomplete=True``); the installation still sends at most five requests per
    second and caches results.

The service is switched off with ``MOVE_OPENLAB_GEOCODER_URL=off``; only the configured URL is ever contacted —
clients cannot choose the target. Results are © OpenStreetMap contributors (ODbL); the interface shows the
attribution next to the search box.
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .osm import USER_AGENT, SourceUnavailable

DEFAULT_URL = "https://nominatim.openstreetmap.org/search"
CACHE_TTL_S = 30 * 86400
MAX_QUERY = 120
MAX_RESULTS = 8
MAX_RESPONSE = 512 * 1024
MAX_WAIT_S = 5.0                                    # a search waiting longer for its slot is refused (busy)


def _nominatim_params(q: str) -> dict:
    return dict(q=q, format="jsonv2", limit=MAX_RESULTS, addressdetails=0)


def _nominatim_parse(items) -> list[dict]:
    results = []
    for it in items if isinstance(items, list) else []:
        try:
            s, n, w, e = (float(x) for x in it["boundingbox"])     # Nominatim order: south, north, west, east
            results.append(dict(name=str(it.get("display_name", ""))[:300], lat=float(it["lat"]), lon=float(it["lon"]),
                                bbox=[s, w, n, e], kind=f"{it.get('category') or it.get('class', '')}/{it.get('type', '')}"))
        except (KeyError, TypeError, ValueError):
            continue
    return results


def _photon_params(q: str) -> dict:
    return dict(q=q, limit=MAX_RESULTS)


def _photon_parse(doc) -> list[dict]:
    results = []
    for f in (doc.get("features") if isinstance(doc, dict) else None) or []:
        try:
            lon, lat = (float(x) for x in f["geometry"]["coordinates"][:2])
            pr = f.get("properties") or {}
            ext = pr.get("extent")                                  # Photon: [west, north, east, south]
            if ext and len(ext) == 4:
                w, n, e, s = (float(x) for x in ext)
            else:
                d = 0.01
                s, w, n, e = lat - d, lon - d, lat + d, lon + d
            name = ", ".join(str(pr[k]) for k in ("name", "city", "state", "country") if pr.get(k))
            results.append(dict(name=name[:300], lat=lat, lon=lon, bbox=[s, w, n, e],
                                kind=f"{pr.get('osm_key', '')}/{pr.get('osm_value', '')}"))
        except (KeyError, TypeError, ValueError):
            continue
    return results


PROVIDERS = {
    "nominatim": dict(label="Nominatim", autocomplete=False, min_interval_s=1.0, params=_nominatim_params,
                      parse=_nominatim_parse, attribution="Search: Nominatim, © OpenStreetMap contributors (ODbL)",
                      min_chars=2),
    "photon": dict(label="Photon", autocomplete=True, min_interval_s=0.2, params=_photon_params, parse=_photon_parse,
                   attribution="Search: Photon, © OpenStreetMap contributors (ODbL)", min_chars=3),
}
ATTRIBUTION = PROVIDERS["nominatim"]["attribution"]


def _norm(q: str) -> str:
    q = " ".join(unicodedata.normalize("NFC", q).split())
    return q.casefold()


class Geocoder:
    def __init__(self, url: str, cache_dir: Path, opener=urllib.request.urlopen, provider: str = "nominatim"):
        if provider not in PROVIDERS:
            raise ValueError(f"unknown geocoder provider {provider!r}; known: {sorted(PROVIDERS)}")
        self.url = url
        self.provider = provider
        self.spec = PROVIDERS[provider]
        self.enabled = bool(url) and url.lower() != "off"
        self.cache_dir = Path(cache_dir)
        self._open = opener
        self._lock = threading.Lock()
        self._last = 0.0

    def describe(self) -> dict:
        """What the interface may do with this service (never the URL itself)."""
        return dict(enabled=self.enabled, provider=self.provider, label=self.spec["label"],
                    autocomplete=bool(self.enabled and self.spec["autocomplete"]), min_chars=self.spec["min_chars"],
                    attribution=self.spec["attribution"])

    def _cache_file(self, q: str) -> Path:
        return self.cache_dir / (hashlib.sha256(f"{self.provider}:{q}".encode()).hexdigest()[:32] + ".json")

    def search(self, query: str, before_request=None) -> dict:
        """Cached results, or one request to the service. ``before_request`` (e.g. a quota check) runs only when a
        request is really about to be sent."""
        q = _norm(query or "")
        if len(q) < self.spec["min_chars"]:
            raise ValueError(f"type at least {self.spec['min_chars']} characters")
        if len(q) > MAX_QUERY:
            raise ValueError(f"query too long (at most {MAX_QUERY} characters)")
        if not self.enabled:
            raise SourceUnavailable("place search is switched off on this installation; draw the area on the map")
        f = self._cache_file(q)
        try:
            hit = json.loads(f.read_text())
            if time.time() - hit["t"] < CACHE_TTL_S:
                return dict(results=hit["results"], cached=True, attribution=self.spec["attribution"])
        except (OSError, ValueError, KeyError):
            pass
        if before_request is not None:
            before_request()
        params = urllib.parse.urlencode(self.spec["params"](q))
        req = urllib.request.Request(f"{self.url}?{params}", headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
        with self._lock:                 # reserve the next slot (installation-wide); the lock is brief
            now = time.monotonic()
            slot = max(now, self._last + self.spec["min_interval_s"])
            if slot - now > MAX_WAIT_S:
                raise SourceUnavailable("place search is busy; try again in a few seconds")
            self._last = slot
        if slot > now:
            time.sleep(slot - now)
        try:
            with self._open(req, timeout=15) as r:
                raw = r.read(MAX_RESPONSE + 1)
        except urllib.error.HTTPError as e:
            raise SourceUnavailable(f"place search refused (HTTP {e.code}); try again later") from None
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise SourceUnavailable(f"place search unreachable ({type(e).__name__})") from None
        if len(raw) > MAX_RESPONSE:
            raise SourceUnavailable("place search returned an unexpectedly large response")
        try:
            doc = json.loads(raw)
        except ValueError:
            raise SourceUnavailable("place search returned invalid data") from None
        results = self.spec["parse"](doc)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps(dict(t=time.time(), q=q, results=results)))
        return dict(results=results, cached=False, attribution=self.spec["attribution"])
