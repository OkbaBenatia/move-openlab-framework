"""Helpers shared by the analysis modules."""
from __future__ import annotations

import json
import statistics


def by_cell(runs: list[dict]) -> dict:
    """{(instance_hash, method_id): [runs sorted by repetition]}"""
    out: dict = {}
    for r in runs:
        out.setdefault((r["instance_hash"], r["method_id"]), []).append(r)
    for v in out.values():
        v.sort(key=lambda r: r["repetition"])
    return out


def consistent(rs: list[dict]) -> bool:
    """All repetitions returned the same decisions and the same validated metrics."""
    return len({(json.dumps(r["decisions"]), json.dumps(r["validation"]["metrics"], sort_keys=True)) for r in rs}) == 1


def med(rs: list[dict], key: str):
    vals = [r[key] for r in rs if isinstance(r.get(key), (int, float))]
    return round(statistics.median(vals), 6) if vals else None


def median_or_none(vals):
    vals = [v for v in vals if isinstance(v, (int, float))]
    return round(statistics.median(vals), 6) if vals else None


def summary_stats(vals: list[float]) -> dict:
    return dict(n=len(vals), mean=round(statistics.mean(vals), 4) if vals else None,
                median=round(statistics.median(vals), 4) if vals else None, max=round(max(vals), 4) if vals else None)


# ---------------------------------------------------------------- optimality scope
SCOPE_FULL = "proven optimal (full problem)"
SCOPE_REDUCED = "optimal for the reduced instance only"
SCOPE_TIME_LIMIT = "not proven (time limit)"
SCOPE_FEASIBLE = "feasible, optimality not proven"
SCOPE_HEURISTIC = "heuristic (no optimality claim)"
SCOPE_INVALID = "invalid (rejected by the validator)"
SCOPES = (SCOPE_FULL, SCOPE_REDUCED, SCOPE_TIME_LIMIT, SCOPE_FEASIBLE, SCOPE_HEURISTIC, SCOPE_INVALID)


def optimality_scope(run: dict, instance: dict, method_kind: str | None) -> str:
    """What a run's result proves. A solver proves optimality only for the model it was given: on an instance whose
    candidates were pruned by a scorer (``derivation.scorer``), OPTIMAL means optimal for the reduced instance, never
    for the full problem. Only an exact method's OPTIMAL status on an unpruned instance is a full-problem proof. A hybrid
    method (a learned reduction of the candidates followed by an exact solver) proves at most optimality of the model it
    reduced itself: its OPTIMAL is reduced-instance optimality, never a full-problem proof."""
    if not run.get("accepted"):
        return SCOPE_INVALID
    status = run.get("status_declared")
    if status == "OPTIMAL" and method_kind == "exact":
        return SCOPE_REDUCED if (instance.get("derivation") or {}).get("scorer") else SCOPE_FULL
    if status == "OPTIMAL" and method_kind == "hybrid":
        return SCOPE_REDUCED
    if status == "TIME_LIMIT":
        return SCOPE_TIME_LIMIT
    if status in ("OPTIMAL", "FEASIBLE"):
        return SCOPE_FEASIBLE
    return SCOPE_HEURISTIC


def scope_counts(ws, c: dict) -> dict[str, dict[str, int]]:
    """{method_id: {scope label: number of runs}} for a campaign (first repetition of each cell)."""
    kinds = {m["method_id"]: m.get("kind") for m in c["methods"]}
    insts: dict[str, dict] = {}
    out: dict[str, dict[str, int]] = {}
    for r in c["runs"]:
        if r.get("repetition") != 1:
            continue
        inst = insts.setdefault(r["instance_hash"], ws.inst.get_instance(r["instance_hash"]))
        label = optimality_scope(r, inst, kinds.get(r["method_id"]))
        out.setdefault(r["method_id"], {}).setdefault(label, 0)
        out[r["method_id"]][label] += 1
    return out
