"""Candidates and transparent (non-learned) scorers for the synthetic benchmark.

Candidates are the compatible pairs; each belongs to two groups (its driver and its passenger), so a top-k selection
keeps a pair when it is among the k best of its driver *or* of its passenger.
"""
from __future__ import annotations

from ...hashing import with_hash
from ...scoring import KeepAllScorer, Scorer


def pair_id(driver: str, passenger: str) -> str:
    return f"{driver}|{passenger}"


def candidates(instance: dict) -> list[dict]:
    return [dict(id=pair_id(p["driver"], p["passenger"]), groups=[f"D:{p['driver']}", f"P:{p['passenger']}"],
                 features=dict(cost=p["cost"])) for p in instance["compatible_pairs"]]


def restrict(instance: dict, keep: set[str], derivation: dict) -> dict:
    child = dict(instance)
    child["compatible_pairs"] = [p for p in instance["compatible_pairs"] if pair_id(p["driver"], p["passenger"]) in keep]
    t = derivation.get("threshold")
    child["instance_id"] = f"{instance['instance_id']}~{derivation.get('scorer', 'pruned')}" + (f"@{t:g}" if t is not None else "")
    child["derivation"] = dict(derivation, kept=len(child["compatible_pairs"]), total=len(instance["compatible_pairs"]))
    return with_hash(child)


class RelativeCostScorer(Scorer):
    """score(d, p) = cheapest cost among the passenger's compatible pairs / cost(d, p), in (0, 1]; 1 for each
    passenger's cheapest option(s). A zero-cost pair scores 1."""
    id = "relative-cost"
    label = "Relative cost (transparent baseline)"
    description = "Cheapest option of the passenger divided by the pair cost; 1 = the passenger's cheapest pair."

    def score(self, instance, cands):
        best: dict[str, int] = {}
        for p in instance["compatible_pairs"]:
            best[p["passenger"]] = min(best.get(p["passenger"], p["cost"]), p["cost"])
        out = {}
        for p in instance["compatible_pairs"]:
            out[pair_id(p["driver"], p["passenger"])] = 1.0 if p["cost"] == 0 else round(best[p["passenger"]] / p["cost"], 6)
        return out


def scorers() -> dict[str, Scorer]:
    return {s.id: s for s in (KeepAllScorer(), RelativeCostScorer())}
