#!/usr/bin/env python3
"""Cross-installation check of the public sample bundle, as “researcher B” in a second, isolated installation:

import (full verification) → reproduce (independent re-execution) → reproducibility analysis → comparison →
register the example method in the verified sandbox → extend the experiment with it → comparison again.

Prints a JSON report; exit status 0 only if every step succeeded. ``--record`` stores the report in
``src/move_openlab/samples/montbeliard.json`` (the application offers the sample only when it says ``ok``).
Usage: python scripts/check_sample_bundle.py [--record]
"""
from __future__ import annotations

import argparse
import json
import shutil
import tempfile
import time
from pathlib import Path

from move_openlab import registry, samples
from move_openlab.analysis.compare import compare
from move_openlab.analysis.reproducibility import reproducibility
from move_openlab.analysis.semantic import semantic_compare
from move_openlab.store import Installation
from move_openlab.version import app_version

ROOT = Path(__file__).resolve().parents[1]
PID = "public-ride-matching"


def run_cycle(tmp: Path) -> dict:
    plugins = tmp / "plugins"
    shutil.copytree(ROOT / "plugins" / "nearest_pickup", plugins / "nearest_pickup")
    w = Installation(tmp / "B", plugins, "sample-installation-b", plugin_mode="sandbox").workspace("researcher-b", "Researcher B")
    t0 = time.perf_counter()
    data = samples.bundle_bytes()
    imp = w.import_bundle(data)
    root = imp["root_campaign_id"]
    repro = w.create_reproduction(root)
    w.execute(repro["campaign_id"])
    w.lock(repro["campaign_id"])
    rr = reproducibility(w, repro["campaign_id"])
    reg = w.register_plugin(registry.get(PID), "nearest_pickup")
    ext = w.create_extension(repro["campaign_id"], [("nearest-pickup", "1.0.0")])
    w.execute(ext["campaign_id"])
    ext = w.lock(ext["campaign_id"])
    cmp = compare(w, ext["campaign_id"])
    sem = semantic_compare(w, root, repro["campaign_id"])
    ok = (imp["ok"] and not imp["executable_code_in_bundle"] and rr["numerically_reproduced"] and reg["selftest"]["accepted"]
          and all(r["accepted"] for r in ext["runs"])
          and all(r["isolation"] == "sandbox" for r in ext["runs"] if r["source"] == "plugin")
          and all(r["all_feasible"] for r in cmp["rows"]))
    return dict(
        ok=bool(ok), checked_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), framework_version=app_version(),
        packed_sha256=imp["bundle_sha256"],
        integrity=dict(format=imp["format"], files_checked=imp["files_checked"], instances_verified=imp["instances_verified"],
                       geometry_verified=imp["geometry_verified"], campaigns=len(imp["campaigns_verified"]),
                       fingerprints_recomputed=bool(imp["fingerprints"]), spec_match=imp["spec_match"],
                       executable_code_in_bundle=imp["executable_code_in_bundle"]),
        reproduction=dict(cells=rr["cells"], agreement=rr["agreement"], reproduced=rr["numerically_reproduced"],
                          rule=rr["note"]),
        comparability=dict(summary=sem.get("summary")),
        method=dict(method="nearest-pickup@1.0.0", selftest=reg["selftest"]["accepted"],
                    isolation=reg["isolation_at_registration"],
                    runs=len([r for r in ext["runs"] if r["source"] == "plugin"]),
                    accepted=len([r for r in ext["runs"] if r["source"] == "plugin" and r["accepted"]])),
        comparison=[dict(method=r["method_id"], origin=r["campaign_kind"], valid=r["all_feasible"],
                         served=r["totals"].get("served"), detour_s=r["totals"].get("detour_s"),
                         optimal=f"{r.get('optimal')}/{r['scenarios']}", reproduction=r["reproduction_status"])
                    for r in cmp["rows"]],
        wall_time_s=round(time.perf_counter() - t0, 1))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--record", action="store_true")
    a = ap.parse_args()
    with tempfile.TemporaryDirectory(prefix="move-openlab-sample-b-") as tmp:
        rep = run_cycle(Path(tmp))
    print(json.dumps(rep, indent=1, ensure_ascii=False))
    if a.record:
        info = json.loads(samples.INFO.read_text())
        if info.get("packed_sha256") != rep["packed_sha256"]:
            print("refusing to record: the checked bundle is not the built one")
            return 1
        info["check"] = rep
        samples.INFO.write_text(json.dumps(info, indent=1, ensure_ascii=False) + "\n")
    return 0 if rep["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
