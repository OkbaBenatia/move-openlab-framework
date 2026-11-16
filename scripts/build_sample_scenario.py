#!/usr/bin/env python3
"""Build the public sample scenario package (format ``move-openlab-scenario/1``) shipped unpacked in
``src/move_openlab/samples/scenario/`` and described by ``src/move_openlab/samples/scenario-sample.json``.

Content: one frozen scenario of the public Montbéliard demonstration — the baseline's sample 1 (20 drivers, 30 riders,
participants sampled from the Registre de Preuve de Covoiturage open data, release 2026-10), its editable composition
and its replay geometry. Steps, all deterministic:

  1. in a fresh temporary installation, import the shipped demonstration bundle (the normal verified import);
  2. take the baseline's instance named "Montbéliard demo, sample 1";
  3. recover its composition from the instance and check it is exactly the one the demonstration builder used: the
     builder names each instance ``demo-sample-<seed>-<first 8 hex digits of the SHA-256 of its composition>``
     (``scripts/build_demo.py``), so the recovered composition must have that digest prefix;
  4. with ``--network-data DIR`` (an installation that stores the Montbéliard road network), also rebuild the instance
     from the composition on that network and require the identical instance hash;
  5. export the package with the generic exporter (fixed creation date), unpack it into the package directory, record
     the build in ``scenario-sample.json``.

Usage: python scripts/build_sample_scenario.py [--network-data DIR] [--check]
``--check`` builds into memory and compares with the shipped files (exit 1 when they differ).
Afterwards: ``python scripts/pack_examples.py --update`` refreshes ``examples/SHA256SUMS``.
"""
from __future__ import annotations

import argparse
import io
import json
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

from move_openlab import demo, samples, scenario_packages as SP
from move_openlab.geo import scenarios as SC
from move_openlab.geo.osm import NetworkStore
from move_openlab.hashing import sha256, sha256_bytes
from move_openlab.store import Installation

NAME = "Montbéliard demo, sample 1"
CREATED_AT = "2026-11-16T00:00:00+00:00"
DESCRIPTION = ("One frozen scenario of the public Montbéliard demonstration (its baseline's sample 1): 20 drivers and "
               "30 riders whose trips are sampled from the Registre de Preuve de Covoiturage open data (data.gouv.fr, "
               "release 2026-10), on the OpenStreetMap road network of the Pays de Montbéliard; departures 07:00-09:00; "
               "detour at most 15 min and 50 % of the direct trip; vehicle profiles and the emission configuration of the "
               "demonstration.")


def build(network_data: Path | None) -> tuple[bytes, dict]:
    with tempfile.TemporaryDirectory(prefix="move-openlab-sample-scenario-") as tmp:
        w = Installation(Path(tmp) / "inst", None, "move-openlab-sample").workspace("sample", "MOVE OpenLab sample")
        rep = w.import_bundle(demo.bundle_bytes())
        base = next(c for c in rep["campaigns_verified"] if c["kind"] == "baseline")
        hashes = w.get(base["campaign_id"])["scenario_set"]["instance_hashes"]
        inst = next(i for i in (w.inst.get_instance(h) for h in hashes) if i["name"] == NAME)
        comp = SP.composition_from_instance(inst)
        errs, valid = SP.composition_errors(comp, inst)
        prefix = inst["instance_id"].rsplit("-", 1)[-1]
        if errs or valid != comp or sha256(valid)[:8] != prefix:
            raise SystemExit(f"the recovered composition is not the demonstration builder's: {errs or 'digest differs'}")
        check = dict(composition_digest_prefix=prefix, instance_id=inst["instance_id"],
                     statement="the composition recovered from the instance has the SHA-256 prefix the demonstration "
                               "builder put in the instance id (scripts/build_demo.py): it is the composition used")
        if network_data:
            nid = inst["network"]["network_id"]
            nets = NetworkStore(network_data)
            again = SC.build_instance(valid, nets.load(nid), nets.provenance(nid), inst["instance_id"])
            if again["instance_hash"] != inst["instance_hash"]:
                raise SystemExit("rebuilt on the road network, the composition gives a different instance")
            check["rebuilt_on_network"] = dict(network_id=nid, identical=True)
        data, meta = w.export_scenario_package(inst["instance_hash"], created_at=CREATED_AT, description=DESCRIPTION)
        verified = w.verify_scenario_package(data)
    info = dict(title=NAME, filename=samples.SCENARIO_FILENAME, format=SP.FORMAT, problem_id=inst["problem_id"],
                instance_id=inst["instance_id"], instance_hash=inst["instance_hash"], drivers=len(inst["drivers"]),
                riders=len(inst["riders"]), pairs=len(inst["pairs"]), network_id=inst["network"]["network_id"],
                composition=meta["composition"], geometry=meta["geometry"], created_at=CREATED_AT,
                licences=verified["licences"], source="the Montbéliard demonstration's frozen baseline scenario, sample 1",
                composition_check=check)
    return data, info


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--network-data", type=Path, help="an installation data directory that stores the Montbéliard network")
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    data, info = build(a.network_data)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        members = {n: z.read(n) for n in z.namelist()}
    if a.check:
        same = all((samples.SCENARIO_ROOT / n).is_file() and (samples.SCENARIO_ROOT / n).read_bytes() == b
                   for n, b in members.items()) and len(list(samples.SCENARIO_ROOT.iterdir())) == len(members)
        print("identical to the shipped sample scenario" if same else "DIFFERENT from the shipped sample scenario")
        return 0 if same else 1
    if samples.SCENARIO_ROOT.exists():
        shutil.rmtree(samples.SCENARIO_ROOT)
    samples.SCENARIO_ROOT.mkdir(parents=True)
    for n, b in members.items():
        (samples.SCENARIO_ROOT / n).write_bytes(b)
    samples.scenario_bytes.cache_clear()
    packed = samples.scenario_bytes()
    info.update(packed_sha256=sha256_bytes(packed), packed_bytes=len(packed),
                manifest_sha256=sha256_bytes((samples.SCENARIO_ROOT / "manifest.json").read_bytes()))
    samples.SCENARIO_INFO.write_text(json.dumps(info, indent=1, ensure_ascii=False) + "\n")
    print(json.dumps({k: info[k] for k in ("title", "format", "drivers", "riders", "packed_sha256", "packed_bytes")}, indent=1))
    print("now run: python scripts/pack_examples.py --update", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
