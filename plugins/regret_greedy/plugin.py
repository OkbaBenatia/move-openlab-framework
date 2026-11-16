"""Example researcher plugin — Regret-Based Greedy Matching for the synthetic assignment benchmark.

Not a novel algorithm: a deterministic regret-based assignment heuristic used to demonstrate the extension interface.
Standard library only; it receives a read-only instance view and returns decisions following the method contract.

Rule (regret-2): while some unassigned passenger still has a feasible driver (compatible pair, residual capacity > 0):
  for every such passenger, options = feasible drivers sorted by (cost, driver number);
  regret = cost(second option) - cost(first option), or +infinity when only one option remains;
  pick the passenger with the largest regret; ties: fewer options, then lower best cost, then lower passenger number;
  assign it to its first option (cheapest feasible driver; ties: lower driver number).
"""
from __future__ import annotations

import math

METADATA = {                                  # a plain literal: the platform reads it without executing the plugin
    "method_id": "regret-greedy",
    "name": "Regret-Based Greedy Matching",
    "version": "1.0.0",
    "kind": "heuristic",
    "problem_id": "synthetic-capacitated-bipartite-assignment",
    "objective_spec_id": "lex-max-served-then-min-cost/1.0.0",
    "deterministic": True,
    "author": "Example contributor",
    "description": "Regret-2 priority: repeatedly assign the passenger whose cheapest and second-cheapest feasible drivers "
                   "differ most (single-option passengers first); deterministic tie-breaking by option count, best cost, ids.",
    "default_config": {"regret_k": 2, "tie_break": "regret desc, options asc, best_cost asc, passenger_number asc"},
}


def _num(s: str) -> int:
    return int("".join(ch for ch in s if ch.isdigit()) or 0)


def solve(instance, config) -> dict:
    if int(config.get("regret_k", 2)) != 2:
        raise ValueError("this plugin implements regret-2 only")
    residual = {d["id"]: d["capacity"] for d in instance["drivers"]}
    by_pax: dict[str, list[tuple[int, int, str]]] = {}
    for pr in instance["compatible_pairs"]:
        by_pax.setdefault(pr["passenger"], []).append((pr["cost"], _num(pr["driver"]), pr["driver"]))
    unassigned = set(by_pax)
    chosen, total, iterations = [], 0, 0
    while True:
        best = None
        for p in unassigned:
            opts = sorted(o for o in by_pax[p] if residual[o[2]] > 0)
            if not opts:
                continue
            regret = math.inf if len(opts) == 1 else opts[1][0] - opts[0][0]
            key = (-regret, len(opts), opts[0][0], _num(p))
            if best is None or key < best[0]:
                best = (key, p, opts[0])
        if best is None:
            break
        _, p, (cost, _, d) = best
        chosen.append([d, p]); total += cost; residual[d] -= 1; unassigned.discard(p); iterations += 1
    return dict(decisions=chosen, status="HEURISTIC", declared=dict(served=len(chosen), cost=total),
                metadata=dict(regret_k=2, tie_break=config.get("tie_break")), diagnostics=dict(iterations=iterations))
