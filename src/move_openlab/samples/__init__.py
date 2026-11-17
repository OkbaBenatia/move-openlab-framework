"""The public sample bundle: a frozen experiment exported by a researcher (“researcher A”) from the Montbéliard
demonstration, shipped unpacked under ``montbeliard/`` (the repository stores no archives) and packed deterministically
on demand. Anyone can download it, import it, verify it, reproduce it and extend it with their own method.

Built by ``scripts/build_sample_bundle.py``; checked end to end in a second, isolated installation by
``scripts/check_sample_bundle.py`` (import → verify → reproduce → compare → register a method → extend → compare).
``montbeliard.json`` records the build and the result of that check.
"""
from __future__ import annotations

import io
import json
import zipfile
from functools import lru_cache
from pathlib import Path

from ..bundles import ZIP_TIME

HERE = Path(__file__).resolve().parent
ROOT = HERE / "montbeliard"
INFO = HERE / "montbeliard.json"
FILENAME = "move-openlab-sample-montbeliard.zip"


def available() -> bool:
    """Offered only when the unpacked bundle is present *and* its recorded cross-installation check succeeded."""
    if not (ROOT / "manifest.json").is_file() or not INFO.is_file():
        return False
    return bool((info().get("check") or {}).get("ok"))


@lru_cache(maxsize=1)
def bundle_bytes() -> bytes:
    """The sample as a bundle archive, rebuilt deterministically (sorted members, fixed timestamps)."""
    return _pack(ROOT)


def _pack(root: Path) -> bytes:
    """An unpacked package as a ZIP archive, deterministically: sorted members, fixed timestamps."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted((p for p in root.rglob("*") if p.is_file()), key=lambda p: p.relative_to(root).as_posix()):  # same order on every OS
            z.writestr(zipfile.ZipInfo(f.relative_to(root).as_posix(), date_time=ZIP_TIME), f.read_bytes())
    return buf.getvalue()


@lru_cache(maxsize=1)
def info() -> dict:
    try:
        return json.loads(INFO.read_text())
    except (OSError, ValueError):
        return {}


# ---------------------------------------------------------------- sample trip dataset (scenario import example)
TRIPS_DIR = HERE / "trips"
TRIPS_INFO = TRIPS_DIR / "trips.json"


@lru_cache(maxsize=1)
def trips_info() -> dict:
    """The public sample trip dataset: a small synthetic CSV (CC0) built by ``scripts/build_sample_trips.py``. It is a
    *dataset* example (trips to sample scenarios from), not an experiment bundle; the two are not interchangeable."""
    try:
        return json.loads(TRIPS_INFO.read_text())
    except (OSError, ValueError):
        return {}


def trips_available() -> bool:
    i = trips_info()
    return bool(i.get("filename")) and (TRIPS_DIR / i["filename"]).is_file()


def trips_bytes() -> bytes:
    return (TRIPS_DIR / trips_info()["filename"]).read_bytes()


# ---------------------------------------------------------------- sample scenario package (scenario import example)
SCENARIO_ROOT = HERE / "scenario"
SCENARIO_INFO = HERE / "scenario-sample.json"
SCENARIO_FILENAME = "sample_scenario.zip"
EXPERIMENT_EXAMPLE = "sample_experiment.zip"       # examples/ name of the sample bundle (the same bytes as FILENAME)


@lru_cache(maxsize=1)
def scenario_info() -> dict:
    """The public sample scenario package (format ``move-openlab-scenario/1``): one frozen scenario of the Montbéliard
    demonstration with its composition and replay geometry, built by ``scripts/build_sample_scenario.py``."""
    try:
        return json.loads(SCENARIO_INFO.read_text())
    except (OSError, ValueError):
        return {}


def scenario_available() -> bool:
    return (SCENARIO_ROOT / "manifest.json").is_file() and bool(scenario_info().get("packed_sha256"))


@lru_cache(maxsize=1)
def scenario_bytes() -> bytes:
    """The sample scenario as a package archive, packed deterministically like the sample bundle."""
    return _pack(SCENARIO_ROOT)
