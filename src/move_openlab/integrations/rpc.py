"""Connector for the French national carpooling proof registry open data (Registre de Preuve de Covoiturage, RPC).

Source and licence (verified on data.gouv.fr)
* Dataset "Trajets réalisés en covoiturage — Registre de Preuve de Covoiturage", published by the registry on
  data.gouv.fr, one CSV per month (``YYYY-MM.csv``, semicolon-separated).
* Licence: Licence Ouverte / Open Licence (Etalab, data.gouv.fr code ``fr-lo``). Reuse, including commercial reuse and
  redistribution, is allowed; attribution must name the producer and the date of the last update and must not suggest
  endorsement. The data are anonymised by the publisher (no person identifiers, times rounded to 10 minutes,
  coordinates truncated to 2–3 decimals, rare municipalities removed); reusers remain bound by personal-data law and
  must not attempt re-identification.

What the connector does
1. lists the monthly releases from the data.gouv.fr API;
2. streams one release once, computing the SHA-256 and size of the full file while reading;
3. keeps only journeys whose start *and* end lie inside the requested bounding box;
4. cleans and validates each kept row (reasons for every rejection are counted);
5. stores the cleaned subset (no identifiers) and a provenance report; the full file is never written to disk.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

from .. import __version__

DATASET_ID = "5e8ee97c16601da4ee24ffb7"
DATASET_API = f"https://www.data.gouv.fr/api/1/datasets/{DATASET_ID}/"
DATASET_PAGE = "https://www.data.gouv.fr/datasets/trajets-realises-en-covoiturage-registre-de-preuve-de-covoiturage"
PRODUCER = "Registre de Preuve de Covoiturage"
LICENCE = dict(id="fr-lo", name="Licence Ouverte / Open Licence (Etalab)",
               url="https://www.data.gouv.fr/pages/legal/licences/etalab-2.0/")
CONNECTOR = "move_openlab.integrations.rpc/1.0.0"
USER_AGENT = f"move-openlab/{__version__} (+https://github.com/OkbaBenatia/move-openlab-framework)"
MONTH = re.compile(r"^(\d{4})-(\d{2})\.csv$")
KEPT = ("start_datetime", "date", "start_s", "start_lat", "start_lon", "end_datetime", "end_lat", "end_lon",
        "distance_m", "duration_min", "passenger_seats", "operator_class")
MAX_SPEED_KMH = 150.0
# The registry covers journeys in France only. Approximate boxes (south, west, north, east) of metropolitan France
# with Corsica and of the overseas departments; an area must lie inside one of them.
FRANCE_REGIONS = {
    "metropolitan France": (41.3, -5.3, 51.2, 9.7), "Guadeloupe": (15.8, -61.9, 16.6, -61.0),
    "Martinique": (14.3, -61.3, 14.9, -60.8), "French Guiana": (2.1, -54.7, 5.8, -51.6),
    "La Réunion": (-21.4, 55.2, -20.8, 55.9), "Mayotte": (-13.1, 45.0, -12.6, 45.3),
}
ALLOWED_HOSTS = ("www.data.gouv.fr", "data.gouv.fr", "static.data.gouv.fr", "object.files.data.gouv.fr")


def france_region(bbox) -> str | None:
    """Name of the French region box containing the whole area, or None (RPC has no data outside France)."""
    s, w, n, e = (float(x) for x in bbox)
    for name, (rs, rw, rn, re_) in FRANCE_REGIONS.items():
        if rs <= s and rw <= w and n <= rn and e <= re_:
            return name
    return None


def check_download_url(url: str) -> str:
    """Only HTTPS downloads from data.gouv.fr hosts are followed (no arbitrary server-side fetching)."""
    u = urllib.parse.urlsplit(url or "")
    if u.scheme != "https" or u.hostname not in ALLOWED_HOSTS:
        raise ValueError("release URL is not an HTTPS data.gouv.fr address")
    return url


class Cancelled(RuntimeError):
    pass


def list_releases(opener=urllib.request.urlopen) -> list[dict]:
    req = urllib.request.Request(DATASET_API, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with opener(req, timeout=60) as r:
        doc = json.loads(r.read())
    out = []
    for res in doc.get("resources", []):
        m = MONTH.match(res.get("title", ""))
        if m and res.get("url"):
            out.append(dict(release=f"{m.group(1)}-{m.group(2)}", resource_id=res.get("id"), title=res["title"],
                            url=res["url"], filesize=res.get("filesize"), last_modified=res.get("last_modified")))
    return sorted(out, key=lambda r: r["release"], reverse=True)


class _HashingReader(io.RawIOBase):
    def __init__(self, raw, on_bytes=None, cancel=None):
        self.raw, self.h, self.n, self.on_bytes, self.cancel = raw, hashlib.sha256(), 0, on_bytes, cancel

    def readable(self) -> bool:
        return True

    def readinto(self, b) -> int:
        if self.cancel is not None and self.cancel.is_set():
            raise Cancelled("ingestion cancelled")
        chunk = self.raw.read(len(b))
        if not chunk:
            return 0
        self.h.update(chunk)
        self.n += len(chunk)
        b[: len(chunk)] = chunk
        if self.on_bytes:
            self.on_bytes(self.n)
        return len(chunk)


def _f(x: str) -> float | None:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if v == v else None


def clean_row(row: dict, bbox: tuple[float, float, float, float]) -> tuple[dict | None, str | None]:
    """(cleaned record, None) or (None, rejection reason). Identifiers are dropped."""
    s, w, n, e = bbox
    slat, slon, elat, elon = (_f(row.get(k)) for k in ("journey_start_lat", "journey_start_lon", "journey_end_lat",
                                                        "journey_end_lon"))
    if None in (slat, slon, elat, elon) or not (-90 <= slat <= 90 and -90 <= elat <= 90):
        return None, "invalid_coordinates"
    if not (s <= slat <= n and w <= slon <= e and s <= elat <= n and w <= elon <= e):
        return None, "outside_area"
    try:
        t0 = datetime.strptime(row["journey_start_datetime"], "%Y-%m-%dT%H:%M:%S%z")
        t1 = datetime.strptime(row["journey_end_datetime"], "%Y-%m-%dT%H:%M:%S%z")
    except (KeyError, TypeError, ValueError):
        return None, "invalid_datetime"
    if t1 < t0:
        return None, "end_before_start"
    dist, dur = _f(row.get("journey_distance")), _f(row.get("journey_duration"))
    if dist is None or dur is None or dist <= 0 or dur <= 0:
        return None, "non_positive_distance_or_duration"
    if (dist / 1000.0) / (dur / 60.0) > MAX_SPEED_KMH:
        return None, "implausible_speed"
    seats = _f(row.get("passenger_seats"))
    return dict(start_datetime=t0.isoformat(), date=t0.date().isoformat(),
                start_s=t0.hour * 3600 + t0.minute * 60 + t0.second, start_lat=slat, start_lon=slon,
                end_datetime=t1.isoformat(), end_lat=elat, end_lon=elon, distance_m=int(dist), duration_min=int(dur),
                passenger_seats=int(seats) if seats is not None else None,
                operator_class=(row.get("operator_class") or "").strip()[:2]), None


def dataset_key(release: str, bbox) -> str:
    return f"{release}_" + hashlib.sha256(json.dumps([round(float(x), 5) for x in bbox]).encode()).hexdigest()[:12]


def ingest(release: dict, bbox, area_name: str, out_root: Path, source=None, progress=None, cancel=None) -> dict:
    """Stream one monthly release, keep and clean the rows inside ``bbox``, write ``trips.csv`` and ``report.json``
    under ``<out_root>/<dataset_key>/``. ``source`` may be a local file path (tests, offline use) instead of the URL."""
    bbox = tuple(float(x) for x in bbox)
    key = dataset_key(release["release"], bbox)
    d = Path(out_root) / key
    d.mkdir(parents=True, exist_ok=True)
    t_start = time.time()
    if source is None:
        req = urllib.request.Request(check_download_url(release["url"]), headers={"User-Agent": USER_AGENT})
        raw = urllib.request.urlopen(req, timeout=120)
    else:
        raw = open(source, "rb")
    reasons: dict[str, int] = {}
    seen: set[str] = set()
    total = kept = 0
    tmp = d / "trips.csv.part"
    try:
        hr = _HashingReader(raw, (lambda n: progress(n, release.get("filesize"))) if progress else None, cancel)
        text = io.TextIOWrapper(io.BufferedReader(hr, buffer_size=1 << 20), encoding="utf-8", newline="")
        reader = csv.DictReader(text, delimiter=";")
        missing = {"journey_start_datetime", "journey_start_lat", "journey_start_lon", "journey_end_datetime",
                   "journey_end_lat", "journey_end_lon", "journey_distance", "journey_duration"} - set(reader.fieldnames or [])
        if missing:
            raise ValueError(f"unexpected file format: missing columns {sorted(missing)}")
        with tmp.open("w", newline="") as fh:
            wr = csv.DictWriter(fh, fieldnames=KEPT)
            wr.writeheader()
            for row in reader:
                total += 1
                jid = row.get("journey_id") or ""
                rec, why = clean_row(row, bbox)
                if rec is not None and jid and jid in seen:
                    rec, why = None, "duplicate_journey"
                if rec is None:
                    reasons[why] = reasons.get(why, 0) + 1
                    continue
                if jid:
                    seen.add(jid)
                wr.writerow(rec)
                kept += 1
        size, digest = hr.n, hr.h.hexdigest()
    finally:
        raw.close()
    tmp.replace(d / "trips.csv")
    report = dict(dataset_key=key, release=release["release"], area=dict(name=area_name, bbox=list(bbox)),
                  source=dict(dataset_id=DATASET_ID, page=DATASET_PAGE, resource_id=release.get("resource_id"),
                              url=release.get("url") if source is None else f"local file ({Path(source).name})",
                              last_modified=release.get("last_modified"), bytes=size, sha256=digest),
                  licence=LICENCE, producer=PRODUCER,
                  attribution=f"{PRODUCER}, data.gouv.fr, release {release['release']}"
                              f" (updated {str(release.get('last_modified') or '')[:10]}), {LICENCE['name']}",
                  rows_read=total, rows_kept=kept, rejected=dict(sorted(reasons.items())),
                  outside_area=reasons.get("outside_area", 0),
                  cleaning=["start and end inside the bounding box", "valid coordinates and ISO 8601 times",
                            "end not before start", "positive distance and duration",
                            f"mean speed at most {MAX_SPEED_KMH:g} km/h", "first occurrence of each journey kept",
                            "identifiers (journey_id, trip_id) dropped"],
                  connector=CONNECTOR, ingested_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                  duration_s=round(time.time() - t_start, 1))
    (d / "report.json").write_text(json.dumps(report, indent=1))
    return report


def load_trips(out_root: Path, key: str) -> tuple[list[dict], dict]:
    d = Path(out_root) / key
    if not re.fullmatch(r"\d{4}-\d{2}_[0-9a-f]{12}", key or "") or not (d / "report.json").exists():
        raise KeyError("dataset not found")
    report = json.loads((d / "report.json").read_text())
    trips = []
    with (d / "trips.csv").open(newline="") as fh:
        for r in csv.DictReader(fh):
            trips.append(dict(date=r["date"], start_s=int(r["start_s"]), start_lat=float(r["start_lat"]),
                              start_lon=float(r["start_lon"]), end_lat=float(r["end_lat"]), end_lon=float(r["end_lon"])))
    return trips, report


def list_datasets(out_root: Path) -> list[dict]:
    out = []
    for f in sorted(Path(out_root).glob("*/report.json")):
        try:
            out.append(json.loads(f.read_text()))
        except (OSError, ValueError):
            continue
    return out
