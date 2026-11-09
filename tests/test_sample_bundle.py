"""The public sample bundle: shipped with a recorded cross-installation check, deterministic, importable, verifiable,
reproducible in another installation, and extensible with a registered method (in the verified sandbox)."""
import io
import json
import shutil
import zipfile

from conftest import ROOT, sandbox_or_skip

from move_openlab import registry, samples
from move_openlab.analysis.compare import compare
from move_openlab.analysis.reproducibility import reproducibility
from move_openlab.hashing import sha256_bytes
from move_openlab.store import Installation

PID = "public-ride-matching"


def test_sample_is_offered_only_with_a_successful_recorded_check():
    info = samples.info()
    assert samples.available()
    assert info["check"]["ok"] and info["check"]["reproduction"]["reproduced"]
    assert info["packed_sha256"] == sha256_bytes(samples.bundle_bytes()) == info["check"]["packed_sha256"]
    assert samples.bundle_bytes() == samples.bundle_bytes()                       # deterministic packing
    names = zipfile.ZipFile(io.BytesIO(samples.bundle_bytes())).namelist()
    assert "manifest.json" in names and not any(n.endswith(".py") for n in names)
    man = json.loads((samples.ROOT / "manifest.json").read_text())
    assert man["format"] == "move-openlab-bundle/2" and man["spec"]["problem_id"] == PID


def test_sample_imports_verifies_and_reproduces_in_another_installation(tmp_path):
    w = Installation(tmp_path / "B", None, "inst-b").workspace("researcher-b", "Researcher B")
    rep = w.import_bundle(samples.bundle_bytes())
    assert rep["ok"] and not rep["executable_code_in_bundle"] and rep["fingerprints"] and rep["geometry_verified"] == 3
    repro = w.create_reproduction(rep["root_campaign_id"])
    w.execute(repro["campaign_id"])
    w.lock(repro["campaign_id"])
    rr = reproducibility(w, repro["campaign_id"])
    assert rr["numerically_reproduced"] and rr["agreement"]["different"] == 0


def test_sample_extends_with_a_registered_method_in_the_sandbox(tmp_path):
    sandbox_or_skip(tmp_path)
    plugins = tmp_path / "plugins"
    shutil.copytree(ROOT / "plugins" / "nearest_pickup", plugins / "nearest_pickup")
    w = Installation(tmp_path / "B", plugins, "inst-b", plugin_mode="sandbox").workspace("researcher-b", "Researcher B")
    rep = w.import_bundle(samples.bundle_bytes())
    reg = w.register_plugin(registry.get(PID), "nearest_pickup")
    assert reg["selftest"]["accepted"]
    ext = w.create_extension(rep["root_campaign_id"], [("nearest-pickup", "1.0.0")])
    w.execute(ext["campaign_id"])
    runs = w.get(ext["campaign_id"])["runs"]
    assert runs and all(r["accepted"] and r["isolation"] == "sandbox" for r in runs if r["source"] == "plugin")
    rows = compare(w, ext["campaign_id"])["rows"]
    assert {r["method_id"] for r in rows} >= {"nearest-pickup", "exact-matching-highs", "greedy-min-detour"}
    assert all(r["all_feasible"] for r in rows)
