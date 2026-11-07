"""Named geographic areas saved in a researcher's workspace.

An area is a name, a bounding box (south, west, north, east) and a road-network profile; once its network has been
fetched it also records the network id. Changing the box or the profile detaches the network (a different area needs a
different network) unless a network for the new box and profile is already stored. Areas are private to the workspace;
networks are shared, content-addressed installation resources.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import time
from pathlib import Path

from .osm import DEFAULT_PROFILE, bbox_km2, validate_bbox

AREA_ID = re.compile(r"^a-[0-9]{8}T[0-9]{6}-[0-9a-f]{6}$")
MAX_AREAS = 100


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class AreaStore:
    def __init__(self, workspace_root: Path):
        self.root = Path(workspace_root) / "areas"

    def _file(self, area_id: str) -> Path:
        if not area_id or not AREA_ID.match(area_id):
            raise KeyError("area not found")
        return self.root / f"{area_id}.json"

    def _write(self, rec: dict) -> dict:
        self.root.mkdir(parents=True, exist_ok=True)
        f = self._file(rec["area_id"])
        tmp = f.with_suffix(f".tmp{os.getpid()}")
        tmp.write_text(json.dumps(rec, indent=1, sort_keys=True))
        os.replace(tmp, f)
        return rec

    @staticmethod
    def _clean(name: str, bbox, profile: str | None) -> tuple[str, list[float], str]:
        name = " ".join(str(name or "").split())[:80]
        if len(name) < 2:
            raise ValueError("area name must contain at least 2 characters")
        prof = profile or DEFAULT_PROFILE
        box = [round(x, 5) for x in validate_bbox(bbox, prof)]
        return name, box, prof

    def list(self) -> list[dict]:
        out = []
        for f in sorted(self.root.glob("a-*.json")):
            try:
                out.append(json.loads(f.read_text()))
            except (OSError, ValueError):
                continue
        return sorted(out, key=lambda a: a["updated_at"], reverse=True)

    def get(self, area_id: str) -> dict:
        f = self._file(area_id)
        if not f.exists():
            raise KeyError("area not found")
        return json.loads(f.read_text())

    def create(self, name: str, bbox, profile: str | None = None, origin: dict | None = None,
               network_id: str | None = None) -> dict:
        if len(list(self.root.glob("a-*.json"))) >= MAX_AREAS:
            raise ValueError(f"at most {MAX_AREAS} areas per workspace")
        name, box, prof = self._clean(name, bbox, profile)
        aid = f"a-{time.strftime('%Y%m%dT%H%M%S', time.gmtime())}-{secrets.token_hex(3)}"
        return self._write(dict(area_id=aid, name=name, bbox=box, profile=prof, km2=round(bbox_km2(box), 1),
                                network_id=network_id, origin=(origin or {}), created_at=_now(), updated_at=_now()))

    def update(self, area_id: str, name: str | None = None, bbox=None, profile: str | None = None,
               network_id: str | None = None) -> dict:
        rec = self.get(area_id)
        new_name, box, prof = self._clean(name if name is not None else rec["name"],
                                          bbox if bbox is not None else rec["bbox"], profile or rec["profile"])
        if box != rec["bbox"] or prof != rec["profile"]:
            rec["network_id"] = network_id                   # a different box or profile needs its own network
        elif network_id:
            rec["network_id"] = network_id
        rec.update(name=new_name, bbox=box, profile=prof, km2=round(bbox_km2(box), 1), updated_at=_now())
        return self._write(rec)

    def attach(self, area_id: str, network_id: str) -> dict:
        rec = self.get(area_id)
        rec.update(network_id=network_id, updated_at=_now())
        return self._write(rec)

    def delete(self, area_id: str) -> None:
        f = self._file(area_id)
        if not f.exists():
            raise KeyError("area not found")
        f.unlink()
