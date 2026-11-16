"""End-to-end workflow across two isolated installations, plus the negative tests (integrity, immutability,
plugin trust boundary). Reduced scenario set (small + medium, 2 seeds, 2 repetitions) to keep the suite fast."""
import io
import json
import zipfile

import pytest

from conftest import PROBLEM_ID, baseline, plugin_ref, sandbox_or_skip
from move_openlab.analysis.compare import compare
from move_openlab.analysis.report import comparison_csv, comparison_markdown
from move_openlab.analysis.reproducibility import reproducibility
from move_openlab.benchmarks.synthetic_assignment import generator
from move_openlab.methods import ContractError
from move_openlab.runner import run_once
from move_openlab.store import BenchError, ImmutableError, IntegrityError, NotFound


def test_full_workflow_across_installations(installations, problem):
    instA, instB = installations
    r1 = instA.workspace("researcher1", "Researcher 1"); r2 = instB.workspace("researcher2", "Researcher 2")
    base = baseline(r1)
    assert base["checksum"] and len(base["runs"]) == 4 * 2 * 2 and all(r["accepted"] for r in base["runs"])
    data, info = r1.export_bundle(base["campaign_id"])
    assert r1.export_bundle(base["campaign_id"])[0] != b""
    rep = r2.import_bundle(data)
    assert rep["ok"] and rep["executable_code_in_bundle"] is False and rep["instances_verified"] == 4
    assert r2.import_record(base["campaign_id"])["bundle_sha256"] == info["bundle_sha256"]
    assert r2.get(base["campaign_id"]) == base
    with pytest.raises(ImmutableError):
        r2.lock(base["campaign_id"])                                                  # imported = read-only
    repro = r2.create_reproduction(base["campaign_id"])
    assert repro["parent"]["checksum"] == base["checksum"] and repro["scenario_set"] == base["scenario_set"]
    r2.execute(repro["campaign_id"])
    rr = reproducibility(r2, repro["campaign_id"])
    assert rr["numerically_reproduced"] and rr["agreement"]["different"] == 0 and rr["cells"] == 8
    assert all(r["origin"] == "executed" and r["executed_by"] == "Researcher 2" for r in r2.get(repro["campaign_id"])["runs"])
    r2.lock(repro["campaign_id"])
    reg = r2.register_plugin(problem, "regret_greedy")
    assert reg["selftest"]["accepted"] and reg["method_id"] == "regret-greedy"
    ext = r2.create_extension(repro["campaign_id"], [("regret-greedy", "1.0.0")])
    assert ext["parent"]["relation"] == "extends" and ext["scenario_set"]["instance_hashes"] == base["scenario_set"]["instance_hashes"]
    r2.execute(ext["campaign_id"]); r2.lock(ext["campaign_id"])
    cmp = compare(r2, ext["campaign_id"])
    assert [l["kind"] for l in cmp["lineage"]] == ["extended", "reproduction", "baseline"]
    assert {r["method_id"] for r in cmp["rows"]} == {"exact-milp-highs", "greedy-min-cost", "regret-greedy"}
    assert all(r["all_feasible"] for r in cmp["rows"]) and any("different installations" in w for w in cmp["warnings"])
    assert all(r["optimal"] == 4 and r["shortfall"] == 0 for r in cmp["rows"] if r["method_id"] == "exact-milp-highs")
    assert all(r["mean_rank"] >= 1 for r in cmp["rows"])
    assert [r["reproduction_status"] for r in cmp["rows"] if r["campaign_kind"] == "reproduction"] == ["REPRODUCED"] * 2
    md, csv_ = comparison_markdown(r2, ext["campaign_id"]), comparison_csv(r2, ext["campaign_id"])
    assert base["campaign_id"] in md and "regret-greedy" in csv_ and len(csv_.strip().splitlines()) == 1 + len(cmp["rows"])
    assert r1.get(base["campaign_id"]) == base                                         # the original is unchanged
    data2, _ = r2.export_bundle(ext["campaign_id"])
    names = zipfile.ZipFile(io.BytesIO(data2)).namelist()
    assert sum(n.startswith("campaigns/") for n in names) == 3 and not any(n.endswith(".py") for n in names)
    r1.import_bundle(data2)                                                            # round trip back to A
    assert r1.lineage(ext["campaign_id"])[-1]["checksum"] == base["checksum"]


def test_bundle_export_is_deterministic(installations):
    instA, _ = installations
    w = instA.workspace("researcher1", "Researcher 1")
    base = baseline(w, reps=1)
    a, _ = w.export_bundle(base["campaign_id"])
    b, _ = w.export_bundle(base["campaign_id"])
    za, zb = zipfile.ZipFile(io.BytesIO(a)), zipfile.ZipFile(io.BytesIO(b))
    files = [n for n in za.namelist() if n.startswith(("campaigns/", "instances/"))]
    assert all(za.read(n) == zb.read(n) for n in files)                               # only created_at may differ


def _tamper(data: bytes, member_suffix: str, fn) -> bytes:
    zin = zipfile.ZipFile(io.BytesIO(data)); buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zout:
        for n in zin.namelist():
            b = zin.read(n)
            zout.writestr(n, fn(b) if n.endswith(member_suffix) else b)
    return buf.getvalue()


def _add_member(data: bytes, name: str, content: bytes) -> bytes:
    zin = zipfile.ZipFile(io.BytesIO(data)); buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zout:
        for n in zin.namelist():
            zout.writestr(n, zin.read(n))
        zout.writestr(name, content)
    return buf.getvalue()


def test_corrupted_bundles_are_rejected_without_side_effects(installations):
    instA, instB = installations
    r1 = instA.workspace("researcher1", "Researcher 1"); r2 = instB.workspace("researcher2", "Researcher 2")
    base = baseline(r1, reps=1); data, _ = r1.export_bundle(base["campaign_id"])
    flipped = bytes(x ^ 0xFF if i == len(data) // 3 else x for i, x in enumerate(data))
    camp = [n for n in zipfile.ZipFile(io.BytesIO(data)).namelist() if n.startswith("campaigns/")][0]

    def edit_campaign(b):
        c = json.loads(b); c["runs"][0]["validation"]["metrics"]["cost"] += 1
        return json.dumps(c).encode()
    cases = [b"not a zip", data[: len(data) // 2], flipped,
             _tamper(data, ".json", lambda b: b.replace(b'"cost":', b'"cost": ', 1)),
             _tamper(data, "manifest.sha256", lambda b: b"0" * 64),
             _tamper(data, camp.split("/")[-1], edit_campaign),
             _add_member(data, "plugins/evil/plugin.py", b"import os"),
             _add_member(data, "../escape.json", b"{}")]
    for bad in cases:
        with pytest.raises(IntegrityError):
            r2.import_bundle(bad)
    assert r2.list() == [] and not (instB.data / "instances").exists()


def test_immutability_and_isolation(installations):
    instA, _ = installations
    r1 = instA.workspace("researcher1", "Researcher 1"); other = instA.workspace("researcher2", "Researcher 2")
    base = baseline(r1, reps=1)
    with pytest.raises(ImmutableError):
        r1.execute(base["campaign_id"])
    with pytest.raises(ImmutableError):
        r1.lock(base["campaign_id"])
    with pytest.raises(NotFound):
        other.get(base["campaign_id"])
    for bad in ("../researcher1", ".hidden", "a/b", ""):
        with pytest.raises((NotFound, BenchError)):
            r1.get(bad)
    f = r1.root / "campaigns" / base["campaign_id"] / "campaign.json"
    c = json.loads(f.read_text()); c["runs"][0]["validation"]["metrics"]["served"] += 1; f.write_text(json.dumps(c))
    with pytest.raises(IntegrityError):
        r1.get(base["campaign_id"])


def test_custom_method_rejections(installations, problem):
    instA, _ = installations
    w = instA.workspace("researcher2", "Researcher 2")
    with pytest.raises(ContractError, match="incompatible"):
        w.register_plugin(problem, "incompatible")
    with pytest.raises(ContractError, match="self-test"):
        w.register_plugin(problem, "invalid_output")
    with pytest.raises(ContractError, match="self-test"):
        w.register_plugin(problem, "mutating")
    assert w.registered_methods() == []
    for bad in ("../../etc", "..", "/etc", ".hidden"):
        with pytest.raises(NotFound):
            w.register_plugin(problem, bad)
    w.register_plugin(problem, "regret_greedy")
    with pytest.raises(BenchError):
        w.register_plugin(problem, "regret_greedy")


def test_no_plugin_directory_means_builtins_only(tmp_path, problem):
    from move_openlab.store import Installation
    w = Installation(tmp_path / "x", tmp_path / "plugins-but-no-mode").workspace("r", "R")
    assert w.available_plugins(problem) == []
    with pytest.raises(ContractError):
        w.register_plugin(problem, "regret_greedy")


def test_tampered_plugin_code_is_not_executed(installations, plugin_dir, problem):
    instA, _ = installations
    w = instA.workspace("researcher2", "Researcher 2")
    w.register_plugin(problem, "regret_greedy")
    c = w.create_campaign(PROBLEM_ID, "plugin run", dict(sizes=["small"], seeds=[1]), [("regret-greedy", "1.0.0")], repetitions=1)
    p = plugin_dir / "regret_greedy" / "plugin.py"; p.write_text(p.read_text() + "\n# changed after registration\n")
    with pytest.raises(ContractError):
        w.execute(c["campaign_id"])
    assert w.get(c["campaign_id"])["status"] == "draft"


def test_worker_refuses_code_that_differs_from_the_pinned_hash(installations, problem):
    """Even when called directly, the worker executes only bytes whose hash matches (no check/use gap)."""
    instA, _ = installations
    ref = plugin_ref(instA, "regret_greedy", "regret-greedy", sha="0" * 64)
    r = run_once(problem, ref, generator.generate("small", 1), {}, sandbox=instA.sandbox_spec)
    assert not r["accepted"] and "SHA-256" in r["error"]


def test_invalid_output_is_flagged_not_trusted(installations, problem):
    instA, _ = installations
    ref = plugin_ref(instA, "invalid_output", "bogus-output")
    r = run_once(problem, ref, generator.generate("small", 1), {}, sandbox=instA.sandbox_spec)
    assert r["status_declared"] == "OPTIMAL" and not r["accepted"] and not r["validation"]["feasible"]
    assert r["declared_mismatch"]


def test_worker_isolation(installations, problem, monkeypatch):
    """Printed output cannot corrupt the reply; no platform secret is inherited; the working directory is temporary."""
    monkeypatch.setenv("SESSION_SECRET", "x" * 40)
    monkeypatch.setenv("MOVE_OPENLAB_DATA_DIR", "/should/not/leak")
    instA, _ = installations
    ref = plugin_ref(instA, "noisy_stdout", "noisy-method")
    r = run_once(problem, ref, generator.generate("small", 1), {}, sandbox=instA.sandbox_spec)
    assert r["accepted"], r.get("error")
    assert r["diagnostics"]["visible_secret_vars"] == []
    assert r["diagnostics"]["cwd"] == "/tmp" and r["isolation"] == "sandbox"


def test_timeout_is_enforced(problem, tmp_path):
    sandbox_or_skip(tmp_path)
    from move_openlab.sandbox import SandboxSpec
    d = tmp_path / "p" / "slow"; d.mkdir(parents=True)
    (d / "plugin.py").write_text(
        'METADATA = {"method_id": "slow-method", "name": "Slow", "version": "1.0.0", "kind": "heuristic", '
        '"problem_id": "synthetic-capacitated-bipartite-assignment", "objective_spec_id": "lex-max-served-then-min-cost/1.0.0", '
        '"deterministic": True, "author": "t", "description": "sleeps"}\n'
        'import time\ndef solve(instance, config):\n    time.sleep(30)\n')
    from move_openlab.plugins import code_sha256
    f = d / "plugin.py"
    ref = dict(source="plugin", method_id="slow-method", version="1.0.0", plugin_file=str(f), code_sha256=code_sha256(f),
               isolation="sandbox")
    r = run_once(problem, ref, generator.generate("small", 1), {}, timeout_s=1.5, sandbox=SandboxSpec.of(tmp_path / "data"))
    assert not r["accepted"] and "timeout" in r["error"] and r["total_time_s"] < 10
