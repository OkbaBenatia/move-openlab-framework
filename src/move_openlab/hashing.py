"""Canonical JSON and SHA-256 helpers — the basis of every hash, checksum and fingerprint in the framework."""
from __future__ import annotations

import hashlib
import json
from typing import Any


def canonical(obj: Any) -> bytes:
    """Canonical JSON bytes: sorted keys, no whitespace, ASCII only."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def sha256(obj: Any) -> str:
    return hashlib.sha256(canonical(obj)).hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def instance_hash(instance: dict) -> str:
    """Content hash of an instance: everything except the stored ``instance_hash`` itself."""
    return sha256({k: v for k, v in instance.items() if k != "instance_hash"})


def with_hash(instance: dict) -> dict:
    out = {k: v for k, v in instance.items() if k != "instance_hash"}
    out["instance_hash"] = instance_hash(out)
    return out


def json_copy(obj: Any) -> Any:
    """Deep copy through canonical JSON (also proves the object is JSON-serialisable)."""
    return json.loads(canonical(obj))
