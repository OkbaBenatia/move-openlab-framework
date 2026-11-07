"""Negative-test plugin: claims an optimal, feasible solution but assigns every passenger to every driver."""
METADATA = {"method_id": "bogus-output", "name": "Invalid output (test)", "version": "1.0.0", "kind": "heuristic",
            "problem_id": "synthetic-capacitated-bipartite-assignment", "objective_spec_id": "lex-max-served-then-min-cost/1.0.0",
            "deterministic": True, "author": "test", "description": "returns infeasible decisions", "default_config": {}}


def solve(instance, config):
    pairs = [[d["id"], p["id"]] for d in instance["drivers"] for p in instance["passengers"]]
    return {"decisions": pairs, "status": "OPTIMAL", "declared": {"served": len(instance["passengers"]), "cost": 0}}
