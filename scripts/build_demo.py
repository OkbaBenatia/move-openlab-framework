#!/usr/bin/env python3
"""Build the frozen demonstration experiment shipped in ``src/move_openlab/demo/bundle/``.

Inputs (from an installation's data directory, normally produced through the web interface):
  * a stored OpenStreetMap road network (``--network``), and
  * an RPC open-data subset for the same area (``--dataset``).

Steps, all seeded and recorded in provenance:
  1. three scenarios resampled from the dataset (seeds 1, 2, 3; drivers and riders drawn independently), with vehicle
     profiles (the platform's petrol preset for most drivers, a clearly labelled demonstration electric car for the
     first five) and an explicit emission configuration (operational energy, baseline "everyone drives alone");
  2. instances built on the road network (travel times, distances and vehicles embedded);
  3. baseline campaign "Montbéliard Demo — Baseline": exact MILP (HiGHS) and greedy, executed and locked;
  4. controlled variant "Montbéliard Demo — Controlled Variant" (``detour-nonbinding``: the detour limit is lowered
     to the largest existing detour, no pair is removed), executed and locked;
  5. export of the variant with its lineage (bundle format 2, with replay geometry), unpacked into the package.

Usage:
  python scripts/build_demo.py --data .openlab-data/dev --network <network_id> --dataset <dataset_key> [--check]
``--check`` builds into a temporary directory and compares with the shipped bundle (same instances and fingerprints;
runtimes always differ).
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

from move_openlab import registry
from move_openlab.geo import scenarios as SC
from move_openlab.geo.osm import NetworkStore
from move_openlab.hashing import sha256
from move_openlab.integrations import rpc
from move_openlab.mobility import vehicles as V
from move_openlab.store import Installation

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "src" / "move_openlab" / "demo" / "bundle"
PID = "public-ride-matching"
METHODS = [("exact-matching-highs", "1.0.0"), ("greedy-min-detour", "1.0.0")]
SEEDS = (1, 2, 3)
DRIVERS, RIDERS = 20, 30
WINDOW = (7 * 3600, 9 * 3600)                     # 07:00-09:00, every day of the release
PARAMS = dict(max_detour_s=900, max_detour_ratio=0.5)
BASE_TITLE = "Montbéliard Demo — Baseline"
VARIANT_TITLE = "Montbéliard Demo — Controlled Variant"
EMISSIONS = dict(scope="operational-energy", baseline="everyone-drives-alone")
ELECTRIC_DRIVERS = ("D1", "D2", "D3", "D4", "D5")
DEMO_ASSUMPTION = "demonstration assumption — not a measured or published value; edit before any study"


def demo_vehicles() -> dict:
    """The petrol preset (sourced values) as default vehicle, plus a demonstration electric car whose consumption is
    an explicitly labelled assumption (no official average exists) and whose grid factor is the EEA value of the
    France preset."""
    petrol, ev_preset = V.preset("petrol-car-eu-real-world"), V.preset("electric-car-france-grid")
    ev = dict(id="demo-electric-car", name="Battery-electric car (demonstration)", category="car", passenger_capacity=4,
              powertrain="BEV", energy="electricity",
              parameters=dict(electricity_consumption_kwh_100km=dict(value=16.0, unit="kWh/100 km", source=DEMO_ASSUMPTION,
                                                                     source_version="demo 2026-11", applicability="demonstration only",
                                                                     notes="No official EU average electricity consumption of battery-electric "
                                                                           "cars was found; the value only illustrates the computation."),
                              electricity_emission_factor_g_per_kwh=ev_preset["parameters"]["electricity_emission_factor_g_per_kwh"]),
              provenance=dict(kind="demo", notes="Demonstration vehicle: the consumption is an assumption, the grid factor "
                                                 "is the EEA figure of the France preset (see the parameter's source)."))
    return dict(profiles=[petrol, V.validate_profile(ev)], default=petrol["id"], assignments={d: "demo-electric-car" for d in ELECTRIC_DRIVERS})


def build(data: Path, network_id: str, dataset_key: str, work: Path) -> Path:
    src_nets = NetworkStore(data)
    net = src_nets.load(network_id)
    prov = src_nets.provenance(network_id)
    trips, report = rpc.load_trips(data / "opendata" / "rpc", dataset_key)
    inst_dir = work / "installation"
    (inst_dir / "networks" / network_id).mkdir(parents=True)
    for f in ("network.json", "provenance.json"):           # replay geometry is built from the network at export
        shutil.copy(data / "networks" / network_id / f, inst_dir / "networks" / network_id / f)
    ws = Installation(inst_dir, installation_id="move-openlab-demo").workspace("demo", "MOVE OpenLab demo")
    problem = registry.get(PID)
    s, w, n, e = net.bounds()
    inside = [t for t in trips if s <= t["start_lat"] <= n and w <= t["start_lon"] <= e
              and s <= t["end_lat"] <= n and w <= t["end_lon"] <= e]
    hashes = []
    for seed in SEEDS:
        sc = SC.generate_empirical(inside, report, network_id, f"Montbéliard demo, sample {seed}", DRIVERS, RIDERS,
                                   seed, *WINDOW, PARAMS)
        sc.update(vehicles=demo_vehicles(), emissions=EMISSIONS)
        sc = SC.validate_scenario(sc)
        inst = SC.build_instance(sc, net, prov, f"demo-sample-{seed}-{sha256(sc)[:8]}")
        rec = ws.save_scenario(problem, sc, inst)
        hashes.append(rec["instance_hash"])
        print(f"sample {seed}: {len(inst['pairs'])} compatible pairs, "
              f"{len({p['rider'] for p in inst['pairs']})} riders with an option", file=sys.stderr)
    base = ws.create_campaign(PID, BASE_TITLE, dict(instance_hashes=hashes), METHODS, repetitions=3, timeout_s=120,
                              emissions=EMISSIONS)
    ws.execute(base["campaign_id"])
    ws.lock(base["campaign_id"])
    var = ws.create_variant(base["campaign_id"], "detour-nonbinding", title=VARIANT_TITLE)
    ws.execute(var["campaign_id"])
    ws.lock(var["campaign_id"])
    data_zip, info = ws.export_bundle(var["campaign_id"])
    print(json.dumps(info, indent=1), file=sys.stderr)
    out = work / "bundle"
    with zipfile.ZipFile(io.BytesIO(data_zip)) as z:
        z.extractall(out)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--network", required=True)
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    with tempfile.TemporaryDirectory(prefix="move-openlab-demo-") as tmp:
        built = build(a.data, a.network, a.dataset, Path(tmp))
        if a.check:
            new = json.loads((built / "manifest.json").read_text())
            old = json.loads((OUT / "manifest.json").read_text())
            same = new["instances"] == old["instances"] and new["fingerprints"] == old["fingerprints"]
            print("identical instances and fingerprints" if same else "DIFFERENT from the shipped demo")
            return 0 if same else 1
        if OUT.exists():
            shutil.rmtree(OUT)
        shutil.copytree(built, OUT)
    print(f"written {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
