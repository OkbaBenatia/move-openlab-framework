"""The shipped demonstration experiment: a frozen bundle (format 2), unpacked under ``bundle/``.

It is imported into a researcher's workspace through the normal, fully verified import path (``Workspace.import_bundle``)
the first time they open the workspace. Rebuild with ``scripts/build_demo.py``; provenance and licences in README.md.
"""
from __future__ import annotations

import io
import json
import zipfile
from functools import lru_cache
from pathlib import Path

from ..bundles import ZIP_TIME

ROOT = Path(__file__).resolve().parent / "bundle"
DEMO_ID = "public-mobility-demo"
AREA_LABEL = "Montbéliard"                          # label of the demo's road network (the bundle itself carries no area name)
# Observed trips of the source release kept inside the demonstration area when the bundle was built (the ingest report's
# ``rows_kept``; see README.md). Shown as the size of the *source* data: the scenarios' participants are sampled from
# these trips, they are not the observed trips themselves.
OBSERVED_TRIPS = {"2026-10_c3c5185c01ce": 404}


def available() -> bool:
    return (ROOT / "manifest.json").is_file()


@lru_cache(maxsize=1)
def bundle_bytes() -> bytes:
    """The demo as a bundle archive, rebuilt deterministically from the unpacked members."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(p for p in ROOT.rglob("*") if p.is_file()):
            z.writestr(zipfile.ZipInfo(f.relative_to(ROOT).as_posix(), date_time=ZIP_TIME), f.read_bytes())
    return buf.getvalue()


@lru_cache(maxsize=1)
def manifest() -> dict:
    return json.loads((ROOT / "manifest.json").read_text())


def network_labels() -> dict[str, str]:
    return {n["network_id"]: AREA_LABEL for n in manifest().get("networks", [])}
