"""Negative-test plugin: tries to modify the scenario it receives (must fail: the instance view is read-only)."""
METADATA = {"method_id": "mutating-method", "name": "Mutating (test)", "version": "1.0.0", "kind": "heuristic",
            "problem_id": "synthetic-capacitated-bipartite-assignment", "objective_spec_id": "lex-max-served-then-min-cost/1.0.0",
            "deterministic": True, "author": "test", "description": "attempts to change capacities", "default_config": {}}


def solve(instance, config):
    instance["drivers"][0]["capacity"] = 99
    return {"decisions": [], "status": "HEURISTIC"}
