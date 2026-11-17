"""The repository passes its own confidentiality and hygiene gate (secrets, archives, absolute paths, import-path
mutation, attribution trailers; plus an external denylist when one is supplied via MOVE_OPENLAB_DENYLIST)."""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_public_safety_gate_is_clean():
    r = subprocess.run([sys.executable, str(ROOT / "scripts" / "check_public_safety.py")], cwd=ROOT,
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stdout


def test_no_denylist_material_is_stored_in_the_repository():
    """Screening terms must live outside the repository: even hashed short words are reversible by dictionary."""
    assert not (ROOT / "scripts" / "denylist.sha256").exists()
    gate = (ROOT / "scripts" / "check_public_safety.py").read_text()
    assert "hashlib" not in gate and "MOVE_OPENLAB_DENYLIST" in gate


def test_lockfile_digests_are_not_screened_but_everything_else_is():
    """A short screening term can occur by chance in a lockfile's base64 integrity digest: only that value is skipped."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("gate", ROOT / "scripts" / "check_public_safety.py")
    gate = importlib.util.module_from_spec(spec); spec.loader.exec_module(gate)
    digest = '      "integrity": "sha512-AbQzzqXyZ09+/zzq0w==",'
    assert "zzq" not in gate.norm(gate.screened("frontend/package-lock.json", digest))
    assert "zzq" in gate.norm(gate.screened("docs/notes.md", digest))                      # other files: unchanged
    named = '    "node_modules/zzq-package": {'
    assert "zzq" in gate.norm(gate.screened("frontend/package-lock.json", named))         # names stay screened
    resolved = '      "resolved": "https://registry.npmjs.org/zzq/-/zzq-1.0.0.tgz",'
    assert "zzq" in gate.norm(gate.screened("frontend/package-lock.json", resolved))


def test_only_the_demonstration_network_may_be_compressed_and_it_is_screened_decompressed(tmp_path, monkeypatch):
    """The shipped road network is gzip JSON: screened decompressed like text; any other archive is still refused."""
    import gzip
    import importlib.util
    spec = importlib.util.spec_from_file_location("gate", ROOT / "scripts" / "check_public_safety.py")
    gate = importlib.util.module_from_spec(spec); spec.loader.exec_module(gate)
    net = tmp_path / "src/move_openlab/demo/network"
    net.mkdir(parents=True)
    (net / "clean.json.gz").write_bytes(gzip.compress(b'{"name": "rue du Parc"}'))
    (net / "leak.json.gz").write_bytes(gzip.compress(b'{"name": "rue zzq"}'))
    (net / "broken.json.gz").write_bytes(b"not gzip")
    (net / "other.zip").write_bytes(b"PK")
    (tmp_path / "data.json.gz").write_bytes(gzip.compress(b"{}"))                         # outside the folder
    monkeypatch.setattr(gate, "ROOT", tmp_path)
    monkeypatch.setattr(gate, "files", lambda: sorted(p for p in tmp_path.rglob("*") if p.is_file()))
    found = gate.scan(["zzq"])
    assert not any("clean.json.gz" in x for x in found)
    assert any(x.startswith("src/move_openlab/demo/network/leak.json.gz:1: denylisted term") for x in found)
    assert any("broken.json.gz: compressed data that cannot be screened" in x for x in found)
    assert any("other.zip: archive" in x for x in found) and any(x.startswith("data.json.gz: archive") for x in found)
    monkeypatch.setattr(gate, "MAX_GZ_TEXT", 10)
    assert any("clean.json.gz: compressed data that cannot be screened" in x for x in gate.scan([]))   # bomb guard


def test_comparability_transform_rules(problem):
    """Positive scaling of one metric is a verified normalisation; a different aggregation is not."""
    from move_openlab.benchmarks.synthetic_assignment import generator
    from move_openlab.comparability.contract import check, normalized_metric
    from move_openlab.comparability.model import cell
    inst = generator.generate("small", 3)
    run = dict(decisions=[], status_declared="OPTIMAL", solver_time_s=0.1, total_time_s=0.2)
    base = dict(instance=inst, objective_id=problem.objective_spec_id, config=dict(time_budget_s=60, repetitions=1),
                environment={"python": "3"}, method=dict(method_id="m-one", version="1.0.0", kind="exact"), runs=[run],
                origin="c", researcher="r", experiment_id="e")
    ev = problem.evaluation_contract()
    scaled = __import__("copy").deepcopy(ev); scaled["metrics"]["cost"].update(scale=10, unit="deci-cost")
    maxagg = __import__("copy").deepcopy(ev); maxagg["metrics"]["cost"]["aggregation"] = "max"
    e1 = cell(problem, evaluation=ev, **base)
    e2 = cell(problem, evaluation=scaled, **base)
    e3 = cell(problem, evaluation=maxagg, **base)
    d = check(problem, e1, e2, "quality")
    assert d["status"] == "CONDITIONAL" and d["normalization"]["name"] == "metric-positive-scaling"
    assert normalized_metric(e2, "cost") == e1["R"]["metrics"]["cost"]
    assert check(problem, e1, e3, "quality")["status"] == "INCOMPATIBLE"
    assert check(problem, e1, e3, "runtime")["status"] == "DIRECT"
    e4 = cell(problem, evaluation=ev, **dict(base, environment={"python": "4"}))
    assert check(problem, e1, e4, "quality")["status"] == "DIRECT" and check(problem, e1, e4, "runtime")["status"] == "CONDITIONAL"
