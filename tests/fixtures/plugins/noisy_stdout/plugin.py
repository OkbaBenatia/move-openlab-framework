"""Test plugin: prints to stdout and inspects its environment; output must not corrupt the reply channel and no
platform secret may be visible to it."""
import os

METADATA = {"method_id": "noisy-method", "name": "Noisy (test)", "version": "1.0.0", "kind": "heuristic",
            "problem_id": "synthetic-capacitated-bipartite-assignment", "objective_spec_id": "lex-max-served-then-min-cost/1.0.0",
            "deterministic": True, "author": "test", "description": "prints while solving", "default_config": {}}

print("module-level noise")


def solve(instance, config):
    print("solve-time noise {not json")
    leaked = sorted(k for k in os.environ if "SECRET" in k or "TOKEN" in k or k.startswith("MOVE_OPENLAB"))
    return {"decisions": [], "status": "HEURISTIC", "diagnostics": {"visible_secret_vars": leaked, "cwd": os.getcwd()}}
