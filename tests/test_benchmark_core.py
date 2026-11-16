"""Benchmark correctness: generator determinism, validator, exactness (brute force and min-cost-flow oracle),
heuristic feasibility, method contract, read-only instance view."""
import importlib.util
import json

import pytest

from move_openlab.benchmarks.synthetic_assignment import generator, methods, oracle
from move_openlab.hashing import instance_hash
from move_openlab.methods import ContractError, MethodRegistry, builtin_registry, check_metadata, check_output, freeze


def brute_force(problem, inst):
    pairs = inst["compatible_pairs"]; cap = {d["id"]: d["capacity"] for d in inst["drivers"]}
    by_pax = {}
    for p in pairs:
        by_pax.setdefault(p["passenger"], []).append(p)
    pax, best = sorted(by_pax), [(0, 0)]

    def rec(i, used, served, cost):
        if problem.objective_key(dict(served=served, cost=cost)) < problem.objective_key(dict(served=best[0][0], cost=best[0][1])):
            best[0] = (served, cost)
        if i == len(pax):
            return
        rec(i + 1, used, served, cost)
        for p in by_pax[pax[i]]:
            if used.get(p["driver"], 0) < cap[p["driver"]]:
                used[p["driver"]] = used.get(p["driver"], 0) + 1
                rec(i + 1, used, served + 1, cost + p["cost"])
                used[p["driver"]] -= 1
    rec(0, {}, 0, 0)
    return best[0]


def metrics(v):
    return (v["metrics"]["served"], v["metrics"]["cost"])


def test_generator_is_deterministic_and_hashed(problem):
    a, b = generator.generate("medium", 3), generator.generate("medium", 3)
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
    assert a["instance_hash"] == instance_hash(a) and problem.check_instance(a) == []
    assert generator.generate("medium", 4)["instance_hash"] != a["instance_hash"]
    assert all(len(generator.generate(s, 1)["drivers"]) == generator.SIZES[s][0] for s in generator.SIZES)
    with pytest.raises(ValueError):
        problem.generate_scenarios(dict(sizes=["small"], seeds=[0]))          # seed 0 is reserved


def test_validator_rejects_infeasible_decisions(problem):
    inst = generator.generate("small", 2)
    pr = inst["compatible_pairs"][0]
    assert problem.validate(inst, [[pr["driver"], pr["passenger"]]])["feasible"]
    assert not problem.validate(inst, [["D1", "P99"]])["feasible"]
    incompatible = next([d["id"], p["id"]] for d in inst["drivers"] for p in inst["passengers"]
                        if not any(x["driver"] == d["id"] and x["passenger"] == p["id"] for x in inst["compatible_pairs"]))
    assert not problem.validate(inst, [incompatible])["feasible"]
    assert not problem.validate(inst, [[pr["driver"], pr["passenger"]]] * 2)["feasible"]       # duplicate decision


@pytest.mark.parametrize("seed", generator.SEEDS)
def test_exact_matches_brute_force_on_small(problem, seed):
    inst = generator.generate("small", seed)
    out = methods.solve_exact(freeze(inst), methods.EXACT_META["default_config"])
    v = problem.validate(inst, out["decisions"])
    assert v["feasible"] and out["status"] == "OPTIMAL"
    assert metrics(v) == brute_force(problem, inst) == oracle.lex_optimum(inst)


@pytest.mark.parametrize("size,seed", [(s, k) for s in generator.SIZES for k in (1, 5, 10)])
def test_exact_matches_oracle_and_heuristics_never_better(problem, size, seed, plugin_dir):
    spec = importlib.util.spec_from_file_location("rg_test", plugin_dir / "regret_greedy" / "plugin.py")
    rg = importlib.util.module_from_spec(spec); spec.loader.exec_module(rg)
    inst = generator.generate(size, seed)
    ex = problem.validate(inst, methods.solve_exact(freeze(inst), methods.EXACT_META["default_config"])["decisions"])
    assert metrics(ex) == oracle.lex_optimum(inst)
    for out in (methods.solve_greedy(freeze(inst), {"tie_break": "x"}), rg.solve(freeze(inst), freeze(rg.METADATA["default_config"]))):
        v = problem.validate(inst, out["decisions"])
        assert v["feasible"]
        assert problem.objective_key(v["metrics"]) >= problem.objective_key(ex["metrics"])


def test_contract_rejects_bad_metadata_and_output(problem):
    ok = dict(methods.EXACT_META, method_id="x-method")
    check_metadata(ok, problem)
    for bad in (dict(ok, version="1.0"), dict(ok, problem_id="vrp"), dict(ok, objective_spec_id="min-cost/1"),
                dict(ok, method_id="X"), dict(ok, kind="magic"), dict(ok, deterministic="yes"), dict(ok, extra=1)):
        with pytest.raises(ContractError):
            check_metadata(bad, problem)
    r = MethodRegistry(problem); r.register_method(ok, lambda i, c: None)
    with pytest.raises(ContractError):
        r.register_method(ok, lambda i, c: None)
    assert check_output({"decisions": [["D1", "P1"]], "status": "HEURISTIC"}, problem) == []
    assert check_output({"decisions": "all", "status": "BEST"}, problem) != []
    assert check_output({"decisions": [], "status": "OPTIMAL", "declared": {"served": "many"}}, problem) != []
    assert check_output({"decisions": [], "status": "OPTIMAL", "declared": {"profit": 3}}, problem) != []
    assert check_output({"decisions": [], "status": "OPTIMAL", "shell": "rm -rf"}, problem) != []


def test_instance_view_is_read_only():
    v = freeze(generator.generate("small", 1))
    with pytest.raises(TypeError):
        v["drivers"][0]["capacity"] = 99
    with pytest.raises((TypeError, AttributeError)):
        v["drivers"].append({})


def test_builtin_registry(problem):
    assert {(m.method_id, m.version) for m in builtin_registry(problem).list()} == {("exact-milp-highs", "1.0.0"), ("greedy-min-cost", "1.0.0")}
