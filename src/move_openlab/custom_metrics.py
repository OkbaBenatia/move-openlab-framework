"""Custom metrics: extra figures a researcher registers for a problem without changing the framework.

A metric is installed like a problem package — an object exposed under the entry-point group
``move_openlab.metrics`` of an installed distribution (``pip install ...``); no module path is modified and nothing
is loaded from user uploads. The framework ships one example (:data:`DETOUR_PER_SERVED_RIDER`).

Trust: a custom metric is computed **by the platform**, scenario by scenario, from the figures the platform itself
established — the metrics recomputed by the problem's independent validator, the CO₂ figures computed from the
validated decisions (``domain``) and counts of the frozen instance. It never receives what a method *reported* about
its own solution, so a method cannot inflate a custom metric.

Contract (every field is checked when the metric is loaded; a malformed metric is refused and reported):

=================  ====================================================================================================
``id``             lowercase identifier, ``[a-z][a-z0-9-]{1,63}``
``version``        semantic version ``MAJOR.MINOR.PATCH`` (change it whenever the formula changes)
``name`` / ``unit`` display name and unit of the value
``direction``      ``higher`` or ``lower`` is better
``problems``       problem ids the metric is defined for (it is offered nowhere else)
``requires``       inputs it reads: validated metric ids (``served``), ``domain.<key>`` (CO₂ figures) or
                   ``instance.<key>`` (``drivers``, ``riders``, ``pairs``); a scenario lacking one gets no value
``aggregate``      how scenario values combine: ``sum``, ``mean``, ``median`` or ``ratio-of-sums`` (``compute``
                   then returns ``(numerator, denominator)``)
``compute``        ``compute(ctx) -> float | (float, float) | None`` with ``ctx = {"metrics", "domain", "instance"}``
``description``    what it measures; ``provenance``: who maintains it and where its definition is published
=================  ====================================================================================================
"""
from __future__ import annotations

import math
import re
import statistics
import threading
from dataclasses import dataclass, field
from importlib.metadata import entry_points
from typing import Any, Callable

GROUP = "move_openlab.metrics"
AGGREGATES = ("sum", "mean", "median", "ratio-of-sums")
DIRECTIONS = ("higher", "lower")
ID = re.compile(r"^[a-z][a-z0-9-]{1,63}$")
SEMVER = re.compile(r"^\d+\.\d+\.\d+$")
INSTANCE_KEYS = ("drivers", "riders", "pairs")


@dataclass(frozen=True)
class MetricSpec:
    id: str
    version: str
    name: str
    unit: str
    direction: str
    problems: tuple[str, ...]
    requires: tuple[str, ...]
    aggregate: str
    compute: Callable[[dict], Any] = field(repr=False, compare=False)
    description: str = ""
    provenance: str = ""

    def public(self) -> dict:
        return dict(id=self.id, version=self.version, name=self.name, unit=self.unit, direction=self.direction,
                    problems=list(self.problems), requires=list(self.requires), aggregate=self.aggregate,
                    description=self.description, provenance=self.provenance,
                    trust="computed by the platform from validated results")


def check(spec: object) -> list[str]:
    """Contract errors of a metric object (empty when it can be registered)."""
    if not isinstance(spec, MetricSpec):
        return ["not a MetricSpec"]
    errs = []
    if not ID.match(spec.id or ""):
        errs.append(f"id {spec.id!r} must match {ID.pattern}")
    if not SEMVER.match(spec.version or ""):
        errs.append(f"version {spec.version!r} is not MAJOR.MINOR.PATCH")
    if not (spec.name or "").strip() or not (spec.unit or "").strip():
        errs.append("name and unit are required")
    if spec.direction not in DIRECTIONS:
        errs.append(f"direction must be one of {DIRECTIONS}")
    if spec.aggregate not in AGGREGATES:
        errs.append(f"aggregate must be one of {AGGREGATES}")
    if not spec.problems or not all(isinstance(p, str) and p for p in spec.problems):
        errs.append("problems: at least one problem id")
    for r in spec.requires:
        if r.startswith("instance.") and r.split(".", 1)[1] not in INSTANCE_KEYS:
            errs.append(f"requires {r!r}: instance inputs are {INSTANCE_KEYS}")
    if not callable(spec.compute):
        errs.append("compute must be callable")
    return errs


# ------------------------------------------------------------------ the shipped example
def _detour_per_served(ctx: dict):
    m = ctx["metrics"]
    return (m["detour_s"] / 60.0, m["served"])


DETOUR_PER_SERVED_RIDER = MetricSpec(
    id="detour-per-served-rider", version="1.0.0", name="Detour per served rider", unit="min", direction="lower",
    problems=("public-ride-matching",), requires=("served", "detour_s"), aggregate="ratio-of-sums",
    compute=_detour_per_served,
    description="Total detour the drivers accept divided by the riders they serve (validated figures).",
    provenance="MOVE OpenLab example metric (move_openlab.custom_metrics), public")

BUILTIN = (DETOUR_PER_SERVED_RIDER,)

_lock = threading.Lock()
_metrics: dict[str, MetricSpec] | None = None
_errors: dict[str, str] = {}


def _load() -> dict[str, MetricSpec]:
    global _metrics
    with _lock:
        if _metrics is None:
            found = {m.id: m for m in BUILTIN}
            for ep in entry_points(group=GROUP):
                try:
                    obj = ep.load()
                    spec = obj() if callable(obj) and not isinstance(obj, MetricSpec) else obj
                    errs = check(spec)
                    if errs:
                        raise ValueError("; ".join(errs))
                    if spec.id in found:
                        raise ValueError(f"duplicate metric id {spec.id!r}")
                    found[spec.id] = spec
                except Exception as e:                       # reported by status(), never hidden
                    _errors[ep.name] = f"{type(e).__name__}: {e}"
            _metrics = found
        return _metrics


def register(spec: MetricSpec) -> None:
    """Explicit registration (tests, embedding applications); the contract is checked."""
    errs = check(spec)
    if errs:
        raise ValueError("; ".join(errs))
    ms = _load()
    with _lock:
        if spec.id in ms and ms[spec.id] is not spec:
            raise ValueError(f"duplicate metric id {spec.id!r}")
        ms[spec.id] = spec


def unregister(metric_id: str) -> None:
    with _lock:
        if _metrics is not None and metric_id not in {m.id for m in BUILTIN}:
            _metrics.pop(metric_id, None)


def for_problem(problem_id: str) -> list[MetricSpec]:
    """Metrics defined for this problem (a metric is never offered for another one)."""
    return sorted((m for m in _load().values() if problem_id in m.problems), key=lambda m: m.id)


def status() -> dict:
    return dict(loaded=sorted(_load()), errors=dict(_errors))


def _input(ctx: dict, key: str):
    if key.startswith("domain."):
        return (ctx.get("domain") or {}).get(key.split(".", 1)[1])
    if key.startswith("instance."):
        return (ctx.get("instance") or {}).get(key.split(".", 1)[1])
    return (ctx.get("metrics") or {}).get(key)


def evaluate(spec: MetricSpec, contexts: list[dict]) -> tuple[list[float | None], float | None]:
    """Value per scenario and aggregated value. A scenario missing a required input, or whose computation fails or
    is not finite, has no value; the aggregate uses the scenarios that have one (ratio-of-sums: Σnum / Σden)."""
    per: list[float | None] = []
    parts: list[tuple[float, float]] = []
    for ctx in contexts:
        if any(_input(ctx, k) is None for k in spec.requires):
            per.append(None)
            continue
        try:
            out = spec.compute(ctx)
        except Exception:                                    # a broken formula never breaks the comparison
            out = None
        if spec.aggregate == "ratio-of-sums":
            ok = isinstance(out, tuple) and len(out) == 2 and all(isinstance(x, (int, float)) and math.isfinite(x) for x in out)
            if ok:
                parts.append((float(out[0]), float(out[1])))
            per.append(float(out[0]) / float(out[1]) if ok and out[1] else None)
        else:
            ok = isinstance(out, (int, float)) and math.isfinite(out)
            per.append(float(out) if ok else None)
    vals = [v for v in per if v is not None]
    if spec.aggregate == "ratio-of-sums":
        den = sum(d for _, d in parts)
        total = sum(n for n, _ in parts) / den if den else None
    elif not vals:
        total = None
    elif spec.aggregate == "sum":
        total = sum(vals)
    elif spec.aggregate == "mean":
        total = sum(vals) / len(vals)
    else:
        total = statistics.median(vals)
    return per, total
