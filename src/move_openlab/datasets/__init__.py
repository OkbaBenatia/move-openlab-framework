"""Trip datasets: providers, normalisation, validation and per-workspace storage.

Providers turn external trip data into normalised trips (:mod:`.tabular`). Built-in providers:

=============  =======================================================  ===================================
id             source                                                   stored in
=============  =======================================================  ===================================
``rpc``        French national carpooling proof registry open data       installation (shared, read-only)
``csv``        CSV file uploaded by a researcher                         researcher's workspace (private)
``geojson``    GeoJSON FeatureCollection uploaded by a researcher        researcher's workspace (private)
=============  =======================================================  ===================================

New providers subclass :class:`DatasetProvider` in their own package and register under the
``move_openlab.dataset_providers`` entry-point group; the experimentation engine only sees normalised trips, so no
core change is needed. See ``docs/DATASETS.md``.
"""
from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import secrets
import shutil
import time
from abc import ABC, abstractmethod
from importlib.metadata import entry_points
from pathlib import Path

from .tabular import Collector, DatasetError, summary

GROUP = "move_openlab.dataset_providers"
TRIP_FIELDS = ("date", "start_s", "start_lat", "start_lon", "end_lat", "end_lon", "role")
USER_KEY = re.compile(r"^u-[0-9]{8}T[0-9]{6}-[0-9a-f]{6}$")
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_DATASETS = 50
__all__ = ["DatasetError", "DatasetProvider", "DatasetStore", "catalogue", "MAX_UPLOAD_BYTES"]


class DatasetProvider(ABC):
    """A source of trip records. ``inspect`` describes raw input; ``parse`` returns normalised trips + metadata."""

    id: str = ""
    label: str = ""
    kind: str = "upload"                        # "upload" (researcher file) | "remote" (public service)
    coverage: str = "worldwide"
    licence: str = "as declared by the uploader"

    @abstractmethod
    def inspect(self, raw: bytes, **options) -> dict: ...

    @abstractmethod
    def parse(self, raw: bytes, mapping: dict, **options) -> tuple[Collector, dict]: ...

    def describe(self) -> dict:
        return dict(id=self.id, label=self.label, kind=self.kind, coverage=self.coverage, licence=self.licence)


class CsvProvider(DatasetProvider):
    id, label = "csv", "CSV file"

    def inspect(self, raw: bytes, **options) -> dict:
        from . import csv_source
        return csv_source.inspect(raw, options.get("delimiter"))

    def parse(self, raw: bytes, mapping: dict, **options) -> tuple[Collector, dict]:
        from . import csv_source
        return csv_source.parse(raw, mapping, options.get("time_format", "auto"),
                                options.get("date_format", "YYYY-MM-DD"), options.get("delimiter"))


class GeoJsonProvider(DatasetProvider):
    id, label = "geojson", "GeoJSON FeatureCollection"

    def inspect(self, raw: bytes, **options) -> dict:
        from . import geojson_source
        return geojson_source.inspect(raw)

    def parse(self, raw: bytes, mapping: dict, **options) -> tuple[Collector, dict]:
        from . import geojson_source
        return geojson_source.parse(raw, mapping, options.get("time_format", "auto"),
                                    options.get("date_format", "YYYY-MM-DD"))


BUILTIN = {p.id: p for p in (CsvProvider(), GeoJsonProvider())}


def providers() -> dict[str, DatasetProvider]:
    """Built-in upload providers plus installed ones (entry points). A broken plugin is skipped, never fatal."""
    out = dict(BUILTIN)
    for ep in entry_points(group=GROUP):
        try:
            obj = ep.load()
            p = obj() if isinstance(obj, type) else obj
            if isinstance(p, DatasetProvider) and p.id and p.id not in out:
                out[p.id] = p
        except Exception:                                  # noqa: BLE001 - third-party code
            continue
    return out


def catalogue() -> list[dict]:
    rpc = dict(id="rpc", label="RPC carpooling open data (France)", kind="remote", coverage="France",
               licence="Licence Ouverte / Open Licence (Etalab)")
    return [rpc] + [p.describe() for p in providers().values()]


class DatasetStore:
    """Validated datasets of one workspace: ``<workspace>/datasets/<key>/{trips.csv, report.json}``."""

    def __init__(self, workspace_root: Path):
        self.root = Path(workspace_root) / "datasets"

    def _dir(self, key: str) -> Path:
        if not key or not USER_KEY.match(key):
            raise KeyError("dataset not found")
        return self.root / key

    def save(self, name: str, trips: list[dict], report: dict) -> dict:
        name = " ".join(str(name or "").split())[:80]
        if len(name) < 2:
            raise DatasetError("dataset name must contain at least 2 characters")
        if not trips:
            raise DatasetError("no valid trip to save")
        if len(self.list()) >= MAX_DATASETS:
            raise DatasetError(f"at most {MAX_DATASETS} datasets per workspace; delete one first")
        key = f"u-{time.strftime('%Y%m%dT%H%M%S', time.gmtime())}-{secrets.token_hex(3)}"
        d = self.root / key
        tmp = self.root / f".{key}.tmp"
        tmp.mkdir(parents=True)
        try:
            with (tmp / "trips.csv").open("w", newline="") as fh:
                w = csv.DictWriter(fh, fieldnames=TRIP_FIELDS)
                w.writeheader()
                for t in trips:
                    w.writerow({k: ("" if t.get(k) is None else t.get(k)) for k in TRIP_FIELDS})
            rec = dict(report, dataset_key=key, name=name, rows_kept=len(trips),
                       trips_sha256=hashlib.sha256((tmp / "trips.csv").read_bytes()).hexdigest(),
                       saved_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
            (tmp / "report.json").write_text(json.dumps(rec, indent=1))
            os.replace(tmp, d)
        except BaseException:
            shutil.rmtree(tmp, ignore_errors=True)
            raise
        return rec

    def list(self) -> list[dict]:
        out = []
        for f in sorted(self.root.glob("u-*/report.json")):
            try:
                out.append(json.loads(f.read_text()))
            except (OSError, ValueError):
                continue
        return sorted(out, key=lambda r: r["saved_at"], reverse=True)

    def load(self, key: str) -> tuple[list[dict], dict]:
        d = self._dir(key)
        if not (d / "report.json").exists():
            raise KeyError("dataset not found")
        return read_trips(d / "trips.csv"), json.loads((d / "report.json").read_text())

    def delete(self, key: str) -> None:
        d = self._dir(key)
        if not d.exists():
            raise KeyError("dataset not found")
        shutil.rmtree(d)


def read_trips(path: Path) -> list[dict]:
    out = []
    with Path(path).open(newline="") as fh:
        for r in csv.DictReader(fh):
            out.append(dict(date=r.get("date") or None, start_s=int(r["start_s"]), start_lat=float(r["start_lat"]),
                            start_lon=float(r["start_lon"]), end_lat=float(r["end_lat"]), end_lon=float(r["end_lon"]),
                            role=r.get("role") or None))
    return out


def build_report(provider: DatasetProvider, filename: str, raw: bytes, col: Collector, meta: dict,
                 bbox=None) -> dict:
    """Provenance and validation report of one upload (never contains the raw data)."""
    return dict(provider=provider.id, source=dict(filename=os.path.basename(filename or "upload")[:120],
                                                  bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest()),
                licence=provider.licence, attribution="provided by the researcher", parsing=meta,
                rows_read=col.read, rows_valid=len(col.trips), rejected=dict(sorted(col.rejected.items())),
                examples=col.examples, coverage=summary(col.trips, bbox))
