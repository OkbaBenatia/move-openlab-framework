"""The shipped demonstration experiment: a frozen bundle (format 2), unpacked under ``bundle/``.

It is imported into a researcher's workspace through the normal, fully verified import path (``Workspace.import_bundle``)
the first time they open the workspace. Rebuild with ``scripts/build_demo.py``; provenance and licences in README.md.

The original road network the scenarios were built on is shipped next to it (``network/``: the built network, the raw
Overpass response it was built from, its provenance), so that an installation without it — a fresh one — can edit the
demonstration's participants. It is copied into the installation's network store unchanged, never rebuilt or downloaded.
"""
from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import shutil
import tempfile
import zipfile
from functools import lru_cache
from pathlib import Path

from ..bundles import zip_member

ROOT = Path(__file__).resolve().parent / "bundle"
NETWORK = Path(__file__).resolve().parent / "network"
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
        for f in sorted((p for p in ROOT.rglob("*") if p.is_file()), key=lambda p: p.relative_to(ROOT).as_posix()):  # same order on every OS
            z.writestr(zip_member(f.relative_to(ROOT).as_posix()), f.read_bytes())
    return buf.getvalue()


@lru_cache(maxsize=1)
def manifest() -> dict:
    return json.loads((ROOT / "manifest.json").read_text())


def network_labels() -> dict[str, str]:
    return {n["network_id"]: AREA_LABEL for n in manifest().get("networks", [])}


def network_ref() -> dict | None:
    """The demonstration's road network as the bundle references it (id, box, profile, digests)."""
    return next(iter(manifest().get("networks") or []), None)


def install_network(store) -> str | None:
    """Store the shipped original road network in ``store`` (a ``NetworkStore``) unless it is already there; returns its
    id, or None when this installation ships none. Every file is checked against the bundle's digests before it is
    stored; a copy that fails a check is refused (ValueError) and nothing is written."""
    ref = network_ref()
    if not ref or not (NETWORK / "network.json.gz").is_file():
        return None
    nid = ref["network_id"]
    dest = store._dir(nid)
    if (dest / "network.json").is_file():
        return nid
    net = gzip.decompress((NETWORK / "network.json.gz").read_bytes())
    raw_gz = (NETWORK / "overpass_raw.json.gz").read_bytes()
    prov = json.loads((NETWORK / "provenance.json").read_text())
    if hashlib.sha256(net).hexdigest() != ref["network_sha256"] or json.loads(net).get("network_id") != nid:
        raise ValueError("the shipped demonstration network does not match the demonstration bundle")
    if hashlib.sha256(gzip.decompress(raw_gz)).hexdigest() != ref["raw_sha256"]:
        raise ValueError("the shipped Overpass response does not match the demonstration bundle")
    if (prov.get("network_id"), prov.get("network_sha256"), (prov.get("source") or {}).get("raw_sha256")) != \
            (nid, ref["network_sha256"], ref["raw_sha256"]):
        raise ValueError("the shipped network provenance does not match the demonstration bundle")
    store.root.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix=f".{nid}-", dir=store.root))
    try:
        (tmp / "network.json").write_bytes(net)
        (tmp / "overpass_raw.json.gz").write_bytes(raw_gz)
        (tmp / "provenance.json").write_text(json.dumps(prov, indent=1))
        os.replace(tmp, dest)                          # atomic; another process that stored it first wins
    except OSError:
        if not (dest / "network.json").is_file():
            raise
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return nid
