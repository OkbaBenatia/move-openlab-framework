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
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(p for p in ROOT.rglob("*") if p.is_file()):
            z.writestr(zipfile.ZipInfo(f.relative_to(ROOT).as_posix(), date_time=ZIP_TIME), f.read_bytes())
    return buf.getvalue()


@lru_cache(maxsize=1)
def info() -> dict:
    try:
        return json.loads(INFO.read_text())
    except (OSError, ValueError):
        return {}
