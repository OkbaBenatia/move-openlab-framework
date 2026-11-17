"""Solver robustness: a solver time limit never becomes an optimality claim, a worker that does not answer is killed at
the run's deadline with diagnostics (process states, CPU time, Python traceback, solver log), solver and end-to-end
times are measured separately, and HiGHS's cumulative run clock is not counted twice."""
import glob
import json
import time
from pathlib import Path

import sys

import pytest

import move_openlab
from move_openlab import registry
from move_openlab.analysis.common import SCOPE_FULL, SCOPE_TIME_LIMIT, optimality_scope
from move_openlab.runner import run_once

RIDE = registry.get("public-ride-matching")
EXACT = dict(source="builtin", method_id="exact-matching-highs", version="1.0.0")
GREEDY = dict(source="builtin", method_id="greedy-min-detour", version="1.0.0")
CFG = dict(threads=1, random_seed=0, mip_rel_gap=0.0, mip_abs_gap=0.0)


def sample_instances():
    root = Path(move_openlab.__file__).parent / "samples" / "montbeliard" / "instances"
    return [json.loads(Path(f).read_text()) for f in sorted(glob.glob(str(root / "*.json")))]


def test_a_solver_time_limit_is_never_an_optimality_claim():
    inst = sample_instances()[0]
    r = run_once(RIDE, EXACT, inst, dict(CFG, time_limit_s=0.0), timeout_s=60)
    assert r["status_declared"] == "TIME_LIMIT" and r["diagnostics"]["stage1_status"] == "Time limit reached"
    assert "stage1_search" in r["diagnostics"]
    # an empty matching is feasible (accepted by the validator) but proves nothing
    assert r["accepted"] and r["validation"]["metrics"]["served"] == 0
    assert optimality_scope(r, inst, "exact") == SCOPE_TIME_LIMIT
    ok = run_once(RIDE, EXACT, inst, dict(CFG, time_limit_s=60.0), timeout_s=60)
    assert ok["status_declared"] == "OPTIMAL" and optimality_scope(ok, inst, "exact") == SCOPE_FULL
    assert ok["validation"]["metrics"]["served"] > 0


@pytest.mark.parametrize("ref", [EXACT, GREEDY], ids=["exact", "greedy"])
def test_solver_method_and_end_to_end_times_are_separate(ref):
    for inst in sample_instances():
        r = run_once(RIDE, ref, inst, dict(CFG, time_limit_s=60.0), timeout_s=60)
        assert r["accepted"]
        assert 0 <= r["solver_time_s"] <= r["method_time_s"] <= r["total_time_s"]
        if sys.platform == "win32":                    # CPU time and peak memory come from POSIX getrusage()
            assert "resources" not in r
            continue
        res = r["resources"]
        assert res["cpu_user_s"] + res["cpu_system_s"] > 0 and res["max_rss_mb"] > 0


def test_highs_run_clock_is_cumulative_and_counted_once():
    """HiGHS's getRunTime() accumulates over run() calls; the exact method reports the second reading only."""
    highspy = pytest.importorskip("highspy")
    h = highspy.Highs()
    h.setOptionValue("output_flag", False)
    for _ in range(50):
        h.addCol(1.0, 0.0, 1.0, 0, [], [])
    h.addRow(-highspy.kHighsInf, 10.0, 50, list(range(50)), [1.0] * 50)
    h.changeObjectiveSense(highspy.ObjSense.kMaximize)
    h.run()
    t1 = h.getRunTime()
    h.run()
    assert h.getRunTime() >= t1                     # never reset between the two stages
    src = (Path(move_openlab.__file__).parent / "benchmarks" / "ride_matching" / "model.py").read_text()
    assert "round(t1 + t2" not in src


def test_a_worker_that_does_not_answer_is_killed_with_diagnostics(tmp_path):
    """A method stuck past the run's deadline (here a plugin in trusted-process mode, no sandbox needed) is killed at
    the deadline; the run is rejected and records the processes' state, their CPU time and where Python was."""
    plugin = tmp_path / "stuck" / "plugin.py"
    plugin.parent.mkdir()
    plugin.write_text('''METADATA = {"method_id": "stuck", "name": "Stuck", "version": "1.0.0", "kind": "heuristic",
            "problem_id": "public-ride-matching", "objective_spec_id": "%s", "deterministic": True, "author": "tests",
            "description": "never answers"}


def solve(instance, config):
    import time
    print("solver log line before the stall")
    time.sleep(120)
''' % RIDE.objective_spec_id)
    from move_openlab.plugins import code_sha256
    ref = dict(source="plugin", method_id="stuck", version="1.0.0", plugin_file=str(plugin),
               code_sha256=code_sha256(plugin), isolation="process")
    t0 = time.perf_counter()
    r = run_once(RIDE, ref, sample_instances()[0], {}, timeout_s=3.0)
    assert time.perf_counter() - t0 < 15
    assert not r["accepted"] and r["error"] == "timeout after 3.0 s" and r["status_declared"] == "ERROR"
    d = r["diagnostics"]
    procs = d["timeout_snapshot"]
    if sys.platform.startswith("linux"):                # the process snapshot reads /proc (Linux); elsewhere it is empty
        assert procs and procs[0]["state"] in "SRD" and procs[0]["cpu_user_s"] < 2.5   # sleeping, not computing
    else:
        assert procs == []
    assert "solver log line before the stall" in d["stderr_tail"]
    assert "Timeout" in d["stderr_tail"] and "in solve" in d["stderr_tail"]            # faulthandler traceback
