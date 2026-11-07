"""Generic candidate scoring with configurable thresholds.

A problem may expose *candidate decisions* (e.g. the compatible pairs of an assignment problem). A scorer assigns each
candidate a score (or ``None`` when it does not score it); :func:`select` keeps a candidate when

* its score is at least ``threshold`` (when a threshold is set), **and**
* it is among the ``top_k`` best-scored candidates of at least one of its groups (when ``top_k`` is set).

Unscored candidates are always kept, so a scorer can never silently remove what it did not evaluate. Selection is
deterministic: ties are broken by candidate id. Scorers see the instance only (pre-solution information), never a
solution. Learned scorers are provided by separately installed problem packages; the framework ships none.
"""
from __future__ import annotations

import math
from abc import ABC, abstractmethod


class Scorer(ABC):
    id: str = "abstract"
    label: str = "Abstract scorer"
    description: str = ""
    learned: bool = False

    @abstractmethod
    def score(self, instance: dict, candidates: list[dict]) -> dict[str, float | None]:
        ...

    def info(self) -> dict:
        return dict(id=self.id, label=self.label, description=self.description, learned=self.learned)


class KeepAllScorer(Scorer):
    """No pruning: every candidate is kept (scores are None)."""
    id = "keep-all"
    label = "No pruning"
    description = "Keeps every candidate; produces no score."

    def score(self, instance, candidates):
        return {c["id"]: None for c in candidates}


def validate_selection(threshold: float | None, top_k: int | None) -> None:
    if threshold is not None and not (isinstance(threshold, (int, float)) and math.isfinite(threshold)):
        raise ValueError("threshold must be a finite number")
    if top_k is not None and (not isinstance(top_k, int) or isinstance(top_k, bool) or top_k < 1):
        raise ValueError("top_k must be a positive integer")


def select(candidates: list[dict], scores: dict[str, float | None], threshold: float | None = None,
           top_k: int | None = None) -> set[str]:
    validate_selection(threshold, top_k)
    ids = [c["id"] for c in candidates]
    if all(scores.get(i) is None for i in ids):
        return set(ids)
    pool = [c for c in candidates if scores.get(c["id"]) is None or threshold is None or scores[c["id"]] >= threshold]
    if not top_k:
        return {c["id"] for c in pool}
    keep: set[str] = {c["id"] for c in pool if scores.get(c["id"]) is None}
    groups: dict[str, list[dict]] = {}
    for c in pool:
        for g in c.get("groups") or ["*"]:
            groups.setdefault(g, []).append(c)
    for members in groups.values():
        members.sort(key=lambda c: (-(scores[c["id"]] if scores.get(c["id"]) is not None else math.inf), c["id"]))
        keep.update(c["id"] for c in members[:top_k])
    return keep


def select_share(candidates: list[dict], scores: dict[str, float | None], share: float) -> tuple[set[str], float | None]:
    """Dynamic threshold: keep the best-scored ``share`` of the scored candidates of one instance. The effective
    threshold is the score of the last kept candidate; every candidate scoring at least that value is kept (ties are
    never split arbitrarily). Unscored candidates are always kept. Returns (kept ids, effective threshold)."""
    if not (isinstance(share, (int, float)) and 0 < share <= 1):
        raise ValueError("share must be in (0, 1]")
    scored = sorted((scores[c["id"]], c["id"]) for c in candidates if scores.get(c["id"]) is not None)
    keep = {c["id"] for c in candidates if scores.get(c["id"]) is None}
    if not scored:
        return keep, None
    k = max(1, math.ceil(share * len(scored)))
    cutoff = sorted((s for s, _ in scored), reverse=True)[k - 1]
    keep |= {i for s, i in scored if s >= cutoff}
    return keep, cutoff


MODES = ("absolute", "share")


def normalise_thresholds(values, max_count: int = 12, decimals: int = 4) -> list[float]:
    """Sorted, de-duplicated thresholds (values closer than 10^-decimals are the same threshold)."""
    out = sorted({round(float(v), decimals) for v in values})
    if not out:
        raise ValueError("at least one threshold is required")
    if len(out) > max_count:
        raise ValueError(f"at most {max_count} thresholds")
    if any(not math.isfinite(v) for v in out):
        raise ValueError("thresholds must be finite numbers")
    return out
