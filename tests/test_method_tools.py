"""Method template and the ``method check`` workflow: metadata, sandboxed self-test, run on an imported benchmark."""
import pytest

from move_openlab import demo
from move_openlab.cli import main
from move_openlab.method_tools import check_method, new_method

from conftest import sandbox_or_skip

PID = "public-ride-matching"
NEAREST = '''
def solve(instance, config) -> dict:
    used, out = set(), []
    for p in sorted(instance["pairs"], key=lambda p: (p["to_pickup_s"], p["driver"], p["rider"])):
        if p["driver"] not in used and p["rider"] not in {r for _, r in out}:
            used.add(p["driver"]); out.append([p["driver"], p["rider"]])
    return dict(decisions=out, status="HEURISTIC", declared=dict(served=len(out)))
'''


def _with_solve(d, body: str):
    f = d / "plugin.py"
    src = f.read_text()
    f.write_text(src[: src.index("def solve(")] + body.lstrip())


def test_template_is_a_valid_method(tmp_path):
    sandbox_or_skip(tmp_path)
    d = new_method("nearest_pickup", PID, tmp_path, "Researcher B")
    assert (d / "plugin.py").is_file() and (d / "test_plugin.py").is_file()
    rep = check_method(d)
    assert rep["ok"] and [s["step"] for s in rep["steps"]] == ["metadata", "self-test"]
    with pytest.raises(ValueError):
        new_method("nearest_pickup", PID, tmp_path)               # never overwrites
    with pytest.raises(ValueError):
        new_method("x", PID, tmp_path)
    with pytest.raises(ValueError):
        new_method("valid_name", "no-such-problem", tmp_path)


def test_new_method_runs_on_the_imported_experiment_and_is_compared(tmp_path):
    sandbox_or_skip(tmp_path)
    d = new_method("nearest_pickup", PID, tmp_path)
    _with_solve(d, NEAREST)
    rep = check_method(d, demo.bundle_bytes())
    bench = rep["steps"][-1]
    assert rep["ok"] and bench["step"] == "benchmark" and bench["detail"].startswith("3/3")
    assert {r["method_id"] for r in bench["comparison"]} == {"exact-matching-highs", "greedy-min-detour", "nearest-pickup"}
    exact = next(r for r in bench["comparison"] if r["method_id"] == "exact-matching-highs")
    mine = next(r for r in bench["comparison"] if r["method_id"] == "nearest-pickup")
    assert mine["totals"]["served"] <= exact["totals"]["served"]


def test_clear_errors_for_broken_methods(tmp_path, capsys):
    sandbox_or_skip(tmp_path)
    bad_meta = new_method("bad_meta", PID, tmp_path)
    (bad_meta / "plugin.py").write_text((bad_meta / "plugin.py").read_text().replace('"0.1.0"', '"v1"'))
    rep = check_method(bad_meta)
    assert not rep["ok"] and rep["steps"][0]["step"] == "metadata" and "semantic version" in rep["steps"][0]["detail"]
    invalid = new_method("invalid_out", PID, tmp_path)
    _with_solve(invalid, '''
def solve(instance, config) -> dict:
    d = instance["drivers"][0]["id"]
    return dict(decisions=[[d, "nobody"]], status="HEURISTIC")
''')
    rep = check_method(invalid)
    assert not rep["ok"] and rep["steps"][-1]["step"] == "self-test" and "self-test failed" in rep["steps"][-1]["detail"]
    assert main(["method", "check", str(bad_meta)]) == 1
    assert "[FAILED] metadata" in capsys.readouterr().out
    assert check_method(tmp_path / "missing")["steps"][0]["ok"] is False


def test_documented_schemas_match_the_records():
    import json
    from pathlib import Path
    root = Path(__file__).resolve().parents[1] / "schemas"
    run_schema = json.loads((root / "run-record.schema.json").read_text())
    res_schema = json.loads((root / "method-result.schema.json").read_text())
    camp = json.loads(next((demo.ROOT / "campaigns").glob("*.json")).read_text())
    for r in camp["runs"]:
        assert set(run_schema["required"]) <= set(r), set(run_schema["required"]) - set(r)
        assert set(r) <= set(run_schema["properties"]), set(r) - set(run_schema["properties"])
    from move_openlab.methods import STATUSES
    assert tuple(res_schema["properties"]["status"]["enum"]) == STATUSES
