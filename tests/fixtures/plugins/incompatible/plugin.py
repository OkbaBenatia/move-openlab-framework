"""Negative-test plugin: declares another problem and objective (must be refused at registration)."""
METADATA = {"method_id": "other-problem", "name": "Incompatible (test)", "version": "1.0.0", "kind": "heuristic",
            "problem_id": "vehicle-routing", "objective_spec_id": "min-distance/1.0.0",
            "deterministic": True, "author": "test", "description": "wrong problem", "default_config": {}}


def solve(instance, config):
    return {"decisions": [], "status": "HEURISTIC"}
