"""Specification of the synthetic capacitated assignment benchmark.

Capacitated bipartite assignment between synthetic drivers D and passengers P::

    x[d,p] in {0,1}                                 1 if passenger p is assigned to driver d
    sum_d x[d,p] <= 1               for every p     each passenger is assigned at most once
    sum_p x[d,p] <= cap[d]          for every d     driver capacity
    x[d,p] = 0                      if (d,p) is not a compatible pair (spatial radius and time-window overlap)

Lexicographic objective:
    1. maximise served = sum x[d,p]
    2. among maximal-service solutions, minimise cost = sum cost[d,p] x[d,p]      (integer costs)

A solution serving fewer passengers is always worse, whatever its cost. Every value is artificial: this is a
methodological benchmark for reproducibility and comparability, not a model of real mobility.
"""
PROBLEM_ID = "synthetic-capacitated-bipartite-assignment"
PROBLEM_SPEC_VERSION = "1.0.0"
OBJECTIVE_SPEC_ID = "lex-max-served-then-min-cost/1.0.0"
CONSTRAINT_SPEC_ID = "assign-at-most-once+capacity+compatibility+binary/1.0.0"
INSTANCE_SCHEMA = "move-openlab/synthetic-assignment-instance/1"
VALIDATOR_VERSION = "1.0.0"


def idnum(s: str) -> int:
    """Numeric part of an identifier such as D12 or P3 (used for deterministic tie-breaking)."""
    return int("".join(ch for ch in s if ch.isdigit()) or 0)
