"""Place search through a configured geocoding service (default: OpenStreetMap Nominatim).

The server is the only client of the service (a caching proxy), as the Nominatim usage policy asks:

* one request per second at most for the whole installation, whatever the number of users;
* an identifying User-Agent; results cached on disk (30 days) so repeated searches never reach the service;
* searches are explicit (submitted by the user), never auto-complete; queries are length-limited;
* the service is switched off by setting ``MOVE_OPENLAB_GEOCODER_URL`` to ``off`` (no code change);
* only the configured URL is ever contacted — clients cannot choose the target.

Results are © OpenStreetMap contributors (ODbL); the interface shows the attribution next to the search box.
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
ATTRIBUTION = "Search: Nominatim, © OpenStreetMap contributors (ODbL)"
MIN_INTERVAL_S = 1.0
CACHE_TTL_S = 30 * 86400
MAX_QUERY = 120
MAX_RESULTS = 8
MAX_RESPONSE = 512 * 1024
MAX_WAIT_S = 5.0                                    # a search waiting longer for its slot is refused (busy)


def _norm(q: str) -> str:
    q = " ".join(unicodedata.normalize("NFC", q).split())
    return q.casefold()


class Geocoder:
    def __init__(self, url: str, cache_dir: Path, opener=urllib.request.urlopen):
        self.url = url
        self.enabled = bool(url) and url.lower() != "off"
        self.cache_dir = Path(cache_dir)
        self._open = opener
        self._lock = threading.Lock()
        self._last = 0.0

    def _cache_file(self, q: str) -> Path:
        return self.cache_dir / (hashlib.sha256(q.encode()).hexdigest()[:32] + ".json")

    def search(self, query: str, before_request=None) -> dict:
        """Cached results, or one request to the service. ``before_request`` (e.g. a quota check) runs only when a
        request is really about to be sent."""
        q = _norm(query or "")
        if len(q) < 2:
            raise ValueError("type at least 2 characters")
        if len(q) > MAX_QUERY:
            raise ValueError(f"query too long (at most {MAX_QUERY} characters)")
        if not self.enabled:
            raise SourceUnavailable("place search is switched off on this installation; draw the area on the map")
        f = self._cache_file(q)
        try:
            hit = json.loads(f.read_text())
            if time.time() - hit["t"] < CACHE_TTL_S:
                return dict(results=hit["results"], cached=True, attribution=ATTRIBUTION)
        except (OSError, ValueError, KeyError):
            pass
        if before_request is not None:
            before_request()
        params = urllib.parse.urlencode(dict(q=q, format="jsonv2", limit=MAX_RESULTS, addressdetails=0))
        req = urllib.request.Request(f"{self.url}?{params}", headers={"User-Agent": USER_AGENT,
                                                                     "Accept": "application/json"})
        with self._lock:                 # reserve the next one-second slot (installation-wide); the lock is brief
            now = time.monotonic()
            slot = max(now, self._last + MIN_INTERVAL_S)
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
            items = json.loads(raw)
        except ValueError:
            raise SourceUnavailable("place search returned invalid data") from None
        results = []
        for it in items if isinstance(items, list) else []:
            try:
                s, n, w, e = (float(x) for x in it["boundingbox"])     # Nominatim order: south, north, west, east
                results.append(dict(name=str(it.get("display_name", ""))[:300], lat=float(it["lat"]),
                                    lon=float(it["lon"]), bbox=[s, w, n, e],
                                    kind=f"{it.get('category') or it.get('class', '')}/{it.get('type', '')}"))
            except (KeyError, TypeError, ValueError):
                continue
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps(dict(t=time.time(), q=q, results=results)))
        return dict(results=results, cached=False, attribution=ATTRIBUTION)
