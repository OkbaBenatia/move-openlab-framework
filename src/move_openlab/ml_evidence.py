"""Imported ML evaluation evidence of one workspace: owner-only, content-addressed files next to the experiments.

::

  <data>/workspaces/<user>/ml_evaluations/<experiment id>/<sha256>.json   one evidence document (immutable)
  <data>/workspaces/<user>/ml_evaluations/<experiment id>/index.json      what was imported, by whom, when

Evidence is kept *beside* an experiment, never inside it: importing or withdrawing evidence does not touch the
experiment record, so a locked experiment keeps its checksum. A file is named by the SHA-256 of its bytes and is
verified against that name at every read. Nothing is ever deleted: withdrawing evidence hides it from the evaluation
and keeps the file and its index entry. Evidence is not part of an experiment bundle (:mod:`move_openlab.bundles`).
"""
from __future__ import annotations

import json
import os
import re
import threading
from collections import OrderedDict
from pathlib import Path

from . import privatefiles
from .analysis import ml_evaluation as ML
from .hashing import canonical, sha256_bytes
from .store import SAFE_ID, IntegrityError, NotFound, now

SHA = re.compile(r"^[0-9a-f]{64}$")
_lock = threading.RLock()
_cache: OrderedDict = OrderedDict()            # (sha256, threshold, metric ids) -> evaluation; content-addressed
CACHE_SIZE = 64


class EvidenceStore:
    def __init__(self, workspace_root: Path):
        self.root = Path(workspace_root) / "ml_evaluations"

    def _dir(self, cid: str) -> Path:
        if not cid or not SAFE_ID.match(cid):
            raise NotFound("campaign not found")
        return self.root / cid

    def index(self, cid: str) -> list[dict]:
        f = self._dir(cid) / "index.json"
        try:
            got = json.loads(f.read_text()) if f.exists() else []
        except (OSError, ValueError):
            raise IntegrityError("the index of the imported evaluation evidence cannot be read") from None
        return got if isinstance(got, list) else []

    def entries(self, cid: str, method_id: str | None = None, withdrawn: bool = False) -> list[dict]:
        return [e for e in self.index(cid) if (method_id is None or e["method_id"] == method_id)
                and (withdrawn or not e.get("withdrawn"))]

    def _write_index(self, cid: str, entries: list[dict]) -> None:
        privatefiles.write(self._dir(cid) / "index.json", json.dumps(entries, indent=1, sort_keys=True))

    def add(self, cid: str, evidence: dict, data: bytes, source: dict, by: str, by_user: str) -> tuple[dict, bool]:
        """Store one validated evidence document (``data``: the bytes kept, named by their SHA-256). Returns
        ``(index entry, created)``; the same document imported again is not stored twice, and a withdrawn one is
        shown again."""
        sha = sha256_bytes(data)
        d = self._dir(cid)
        with _lock:
            d.mkdir(parents=True, exist_ok=True)
            for p in (self.root, d):
                os.chmod(p, 0o700)                              # owner-only whatever the process umask
            entries = self.index(cid)
            cur = next((e for e in entries if e["sha256"] == sha), None)
            if cur is not None:
                restored = bool(cur.get("withdrawn"))
                if restored:
                    cur.setdefault("history", []).append(dict(action="restored", by=by, at=now()))
                    cur["withdrawn"] = None
                    self._write_index(cid, entries)
                return cur, restored
            f = d / f"{sha}.json"
            if not f.exists():
                privatefiles.write(f, data)
            entry = dict(sha256=sha, method_id=evidence["method_id"], format=ML.FORMAT, records=len(evidence["records"]),
                         bytes=len(data), source=source, imported_by=by, imported_by_user=by_user, imported_at=now(),
                         withdrawn=None)
            self._write_index(cid, entries + [entry])
        return entry, True

    def add_reference(self, cid: str, ref: dict, source: dict, by: str, by_user: str) -> dict:
        """Record evidence that came with a bundle as a reference only (no predictions or labels): its provenance and
        the figures the exporter recorded. Never recomputed here; the same reference is not recorded twice."""
        sha = str(ref.get("evidence_sha256"))
        if not SHA.match(sha):
            raise IntegrityError("malformed ML evaluation reference")
        keep = {k: ref.get(k) for k in ("method_id", "records", "positives", "dataset", "positive_label", "decision", "model",
                                        "feature_pipeline", "notes", "has_scores", "recorded", "imported_by", "imported_at")}
        with _lock:
            self._dir(cid).mkdir(parents=True, exist_ok=True)
            for p in (self.root, self._dir(cid)):
                os.chmod(p, 0o700)
            entries = self.index(cid)
            cur = next((e for e in entries if e["sha256"] == sha), None)
            if cur is not None:
                return cur
            entry = dict(sha256=sha, method_id=keep["method_id"], format=ML.FORMAT, records=keep["records"], bytes=None,
                         source=dict(source, name=f"bundle {str(source.get('bundle_sha256'))[:12]} (reference)", sha256=sha),
                         imported_by=by, imported_by_user=by_user, imported_at=now(), withdrawn=None,
                         reference_only=True, reference=keep)
            self._write_index(cid, entries + [entry])
        return entry

    def entry(self, cid: str, sha: str) -> dict:
        e = next((x for x in self.index(cid) if x["sha256"] == sha), None) if SHA.match(sha or "") else None
        if e is None:
            raise NotFound("evaluation evidence not found for this experiment")
        return e

    def read(self, cid: str, sha: str) -> bytes:
        """The stored bytes of one evidence document of this experiment, verified against their SHA-256."""
        if self.entry(cid, sha).get("reference_only"):
            raise NotFound("this evidence came as a reference only: its predictions and labels are not on this installation")
        f = self._dir(cid) / f"{sha}.json"
        if not f.is_file():
            raise NotFound("evaluation evidence not found for this experiment")
        data = f.read_bytes()
        if sha256_bytes(data) != sha:
            raise IntegrityError(f"evaluation evidence {sha[:12]} fails its checksum: the stored file was modified")
        return data

    def withdraw(self, cid: str, sha: str, by: str) -> dict:
        """Hide one evidence document from the evaluation. The file and its index entry are kept."""
        with _lock:
            entries = self.index(cid)
            e = next((x for x in entries if x["sha256"] == sha), None) if SHA.match(sha or "") else None
            if e is None:
                raise NotFound("evaluation evidence not found for this experiment")
            if not e.get("withdrawn"):
                e["withdrawn"] = dict(by=by, at=now())
                e.setdefault("history", []).append(dict(action="withdrawn", by=by, at=e["withdrawn"]["at"]))
                self._write_index(cid, entries)
        return e

    def evaluation(self, cid: str, sha: str, threshold: float | None = None) -> dict:
        """The evaluation computed from one stored evidence document (read and verified at every call; the computed
        figures of an unchanged document are reused)."""
        data = self.read(cid, sha)
        key = (sha, threshold, tuple(ML.metric_registry()))
        with _lock:
            if key in _cache:
                _cache.move_to_end(key)
                return _cache[key]
        ev = ML.evaluate(ML.validate(ML.parse_json(data)), threshold)
        with _lock:
            _cache[key] = ev
            while len(_cache) > CACHE_SIZE:
                _cache.popitem(last=False)
        return ev


def stored_bytes(evidence: dict) -> bytes:
    """Canonical bytes of an evidence document built here (a CSV import): what is stored and hashed."""
    return canonical(evidence)
