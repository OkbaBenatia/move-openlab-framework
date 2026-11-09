#!/usr/bin/env python3
"""Build the public sample bundle as “researcher A”: in a fresh, temporary installation, import the Montbéliard
demonstration (its frozen scenarios), create a new experiment on the demonstration's baseline scenarios with the
built-in methods, execute it, lock it and export it. The bundle is written unpacked to
``src/move_openlab/samples/montbeliard/`` and described in ``montbeliard.json``; run ``scripts/check_sample_bundle.py``
afterwards (it records whether the cross-installation cycle succeeded — the application offers the sample only then).

Usage: python scripts/build_sample_bundle.py [--repetitions 3]
"""
from __future__ import annotations

import argparse
import io
import json
import shutil
import tempfile
import zipfile
from pathlib import Path

from move_openlab import demo, registry, samples
from move_openlab.hashing import sha256_bytes
from move_openlab.store import Installation
from move_openlab.version import app_version

ROOT = Path(__file__).resolve().parents[1]
PID = "public-ride-matching"
METHODS = [("exact-matching-highs", "1.0.0"), ("greedy-min-detour", "1.0.0")]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repetitions", type=int, default=3)
    a = ap.parse_args()
    with tempfile.TemporaryDirectory(prefix="move-openlab-sample-a-") as tmp:
        w = Installation(Path(tmp) / "A", ROOT / "plugins", "sample-installation-a").workspace("researcher-a", "Researcher A")
        rep = w.import_bundle(demo.bundle_bytes())
        base = next(c for c in rep["campaigns_verified"] if c["kind"] == "baseline")
        demo_c = w.get(base["campaign_id"])
        c = w.create_campaign(PID, "Montbéliard sample — Baseline", dict(instance_hashes=demo_c["scenario_set"]["instance_hashes"]),
                              METHODS, repetitions=a.repetitions, emissions=demo_c["config"].get("emissions"))
        w.execute(c["campaign_id"])
        locked = w.lock(c["campaign_id"])
        data, meta = w.export_bundle(c["campaign_id"])
    if samples.ROOT.exists():
        shutil.rmtree(samples.ROOT)
    samples.ROOT.mkdir(parents=True)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for n in z.namelist():
            out = samples.ROOT / n
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(z.read(n))
    samples.bundle_bytes.cache_clear()
    packed = samples.bundle_bytes()
    man = json.loads((samples.ROOT / "manifest.json").read_text())
    info = dict(title=locked["title"], campaign_id=locked["campaign_id"], format=man["format"],
                problem_id=PID, problem_spec_version=registry.get(PID).spec_record().get("problem_spec_version"),
                validator_version=registry.get(PID).validator_version, framework_version=app_version(),
                exported_by=man["exported_by"], created_at=man["created_at"], methods=[f"{m}@{v}" for m, v in METHODS],
                repetitions=a.repetitions, scenarios=len(locked["scenario_set"]["instance_hashes"]),
                runs=len(locked["runs"]), accepted=sum(r["accepted"] for r in locked["runs"]),
                manifest_sha256=sha256_bytes((samples.ROOT / "manifest.json").read_bytes()),
                packed_sha256=sha256_bytes(packed), packed_bytes=len(packed), filename=samples.FILENAME,
                source="the Montbéliard demonstration's frozen baseline scenarios (demand sampled from RPC 2026-10 observed trips)",
                check=None)
    samples.INFO.write_text(json.dumps(info, indent=1, ensure_ascii=False) + "\n")
    print(json.dumps({k: info[k] for k in ("title", "format", "runs", "accepted", "packed_sha256", "packed_bytes")}, indent=1))
    print("now run: python scripts/check_sample_bundle.py --record")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
