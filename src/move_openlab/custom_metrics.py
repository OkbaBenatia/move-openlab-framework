"""Custom metrics: extra figures a researcher adds for a problem without changing the framework.

Two kinds, with two different trust paths:

**Built-in metrics** (:data:`BUILTIN`) ship with the framework and are reviewed with it. They are the only metric
code ever executed in the server process (the *trusted execution path*).

**Registered metrics** are third-party code: a file ``<approved plugin directory>/<name>/metric.py`` defining a
literal ``METADATA`` dict and a ``compute(ctx)`` function. They follow the rules of method plugins
(:mod:`move_openlab.plugins`, :mod:`move_openlab.sandbox`):

1. **Never imported by the server.** Discovery and registration read ``METADATA`` statically (``ast.literal_eval``);
   installed packages are not scanned and no entry point is loaded.
2. **Registered per workspace**, only where plugins are enabled (``MOVE_OPENLAB_PLUGIN_MODE``); in
   ``trusted-process`` mode only an administrator may register. Registration pins the SHA-256 of the file and runs a
   self-test on a reserved context.
3. **Executed in the verified sandbox** (no network, private PID namespace, cleared environment, read-only
   installation, no data directory, credential store or other workspace), with a wall-clock timeout and memory/CPU
   limits. In ``trusted-process`` mode they run in a separate plain process (administrator decision, not a sandbox).
   If the required isolation is unavailable the metric is **not computed** — there is no fallback to the server
   process.
4. **Exactly the registered code**: a file changed after registration, or whose ``METADATA`` no longer matches, is
   refused (register a new semantic version).
5. **Controlled inputs, validated outputs.** A metric receives only the inputs it declares in ``requires``, taken from
   what the platform itself established (the metrics recomputed by the problem's independent validator, the CO₂
   figures computed from validated decisions, counts of the frozen instance) — never what a method reported. Every
   output is checked by the server (finite number, or a ``(numerator, denominator)`` pair for ``ratio-of-sums``);
   anything else gives no value and is reported.

Contract (checked at registration; a malformed metric is refused):

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
                   (read-only views holding the declared inputs only)
``description``    what it measures; ``provenance``: who maintains it and where its definition is published
=================  ====================================================================================================
"""
from __future__ import annotations

import ast
import hashlib
import json
import math
import re
import statistics
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

METRIC_FILE = "metric.py"
MAX_METRIC_BYTES = 200_000
AGGREGATES = ("sum", "mean", "median", "ratio-of-sums")
DIRECTIONS = ("higher", "lower")
ID = re.compile(r"^[a-z][a-z0-9-]{1,63}\Z")
SEMVER = re.compile(r"^\d+\.\d+\.\d+\Z")
INPUT = re.compile(r"^(?:(?:domain|instance)\.)?[a-z][a-z0-9_]{0,63}\Z")
INSTANCE_KEYS = ("drivers", "riders", "pairs")
METADATA_KEYS = ("id", "version", "name", "unit", "direction", "problems", "requires", "aggregate", "description",
                 "provenance")
TIMEOUT_S = 20.0                  # one isolated evaluation (every scenario of every result of a view)
MEMORY_MB = 512
TRUST_BUILTIN = "built-in: shipped with the framework, computed by the platform from validated results"
TRUST_SANDBOX = "registered: third-party code computed in the verified sandbox from validated results"
TRUST_PROCESS = "registered: third-party code computed in a separate trusted process (administrator decision, not a sandbox)"


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
    compute: Callable[[dict], Any] | None = field(default=None, repr=False, compare=False)
    description: str = ""
    provenance: str = ""
    source: str = "builtin"                      # builtin | registered
    code_sha256: str = ""                        # registered metrics: the pinned code

    def public(self, isolation: str | None = None) -> dict:
        out = dict(id=self.id, version=self.version, name=self.name, unit=self.unit, direction=self.direction,
                   problems=list(self.problems), requires=list(self.requires), aggregate=self.aggregate,
                   description=self.description, provenance=self.provenance, source=self.source,
                   trust=TRUST_BUILTIN if self.source == "builtin" else TRUST_PROCESS if isolation == "process" else TRUST_SANDBOX)
        if self.code_sha256:
            out["code_sha256"] = self.code_sha256
        return out


def check(spec: object) -> list[str]:
    """Contract errors of a metric (empty when it can be registered). A built-in metric needs a callable ``compute``;
    a registered one carries none in the server (its code runs only in isolation)."""
    if not isinstance(spec, MetricSpec):
        return ["not a MetricSpec"]
    errs = []
    if not isinstance(spec.id, str) or not ID.match(spec.id):
        errs.append(f"id {spec.id!r} must match {ID.pattern}")
    if not isinstance(spec.version, str) or not SEMVER.match(spec.version):
        errs.append(f"version {spec.version!r} is not MAJOR.MINOR.PATCH")
    if not isinstance(spec.name, str) or not spec.name.strip() or not isinstance(spec.unit, str) or not spec.unit.strip():
        errs.append("name and unit are required")
    if spec.direction not in DIRECTIONS:
        errs.append(f"direction must be one of {DIRECTIONS}")
    if spec.aggregate not in AGGREGATES:
        errs.append(f"aggregate must be one of {AGGREGATES}")
    if not spec.problems or not all(isinstance(p, str) and p for p in spec.problems):
        errs.append("problems: at least one problem id")
    if not spec.requires or len(spec.requires) > 32:
        errs.append("requires: between 1 and 32 inputs")
    for r in spec.requires:
        if not isinstance(r, str) or not INPUT.match(r):
            errs.append(f"requires {r!r}: a metric id, domain.<key> or instance.<key>")
        elif r.startswith("instance.") and r.split(".", 1)[1] not in INSTANCE_KEYS:
            errs.append(f"requires {r!r}: instance inputs are {INSTANCE_KEYS}")
    if spec.source == "builtin" and not callable(spec.compute):
        errs.append("compute must be callable")
    if spec.source not in ("builtin", "registered"):
        errs.append("unknown metric source")
    return errs


def compatibility(spec: MetricSpec, problem) -> list[str]:
    """Whether the declared inputs exist for this problem (validated metric ids and domain figure ids)."""
    if problem.problem_id not in spec.problems:
        return [f"the metric is not defined for problem {problem.problem_id!r}"]
    metric_ids = {m.id for m in problem.metrics}
    domain_ids = {d["id"] for d in problem.domain_metric_definitions()} | {"complete"}
    errs = []
    for r in spec.requires:
        if r.startswith("domain."):
            if r[7:] not in domain_ids:
                errs.append(f"requires {r!r}: this problem has no such CO₂/domain figure")
        elif not r.startswith("instance.") and r not in metric_ids:
            errs.append(f"requires {r!r}: not a validated metric of this problem ({sorted(metric_ids)})")
    return errs


# ------------------------------------------------------------------ the shipped (trusted) example
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
_extra: dict[str, MetricSpec] = {}           # explicit registrations by the embedding application (trusted code)


def register(spec: MetricSpec) -> None:
    """Explicit in-process registration by the application embedding the framework (tests, a fork of the platform).
    This is trusted code by definition — it is already running in the server. Third-party metrics are registered from
    a metric file instead (:func:`spec_from_file`) and never run in the server process."""
    errs = check(spec)
    if spec.source != "builtin":
        errs.append("only trusted in-process metrics can be registered this way")
    if errs:
        raise ValueError("; ".join(errs))
    with _lock:
        if spec.id in {m.id for m in BUILTIN} or (spec.id in _extra and _extra[spec.id] is not spec):
            raise ValueError(f"duplicate metric id {spec.id!r}")
        _extra[spec.id] = spec


def unregister(metric_id: str) -> None:
    with _lock:
        _extra.pop(metric_id, None)


def builtin_for(problem_id: str) -> list[MetricSpec]:
    """Trusted metrics defined for this problem (a metric is never offered for another one)."""
    with _lock:
        ms = list(BUILTIN) + list(_extra.values())
    return sorted((m for m in ms if problem_id in m.problems), key=lambda m: m.id)


for_problem = builtin_for


def is_builtin_id(metric_id: str) -> bool:
    with _lock:
        return metric_id in {m.id for m in BUILTIN} or metric_id in _extra


# ------------------------------------------------------------------ third-party metric files (never imported here)
def read_metadata(path: Path) -> dict:
    """``METADATA`` of a metric file, read statically: the file is NOT executed."""
    return metadata_of_source(Path(path).read_bytes(), str(path))


def metadata_of_source(src: bytes, filename: str = METRIC_FILE) -> dict:
    if len(src) > MAX_METRIC_BYTES:
        raise ValueError("metric file too large")
    tree = ast.parse(src, filename=filename)
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "METADATA" for t in node.targets):
            meta = ast.literal_eval(node.value)
            if not isinstance(meta, dict):
                raise ValueError("METADATA must be a dict literal")
            return meta
    raise ValueError("metric file defines no literal METADATA")


def spec_from_metadata(meta: dict, code_sha256: str = "") -> MetricSpec:
    unknown = sorted(set(meta) - set(METADATA_KEYS))
    if unknown:
        raise ValueError(f"unknown METADATA keys {unknown}")
    lists = {}
    for k in ("problems", "requires"):
        v = meta.get(k)
        if not isinstance(v, (list, tuple)) or not all(isinstance(x, str) for x in v):
            raise ValueError(f"{k} must be a list of strings")
        lists[k] = tuple(v)
    strings = {k: meta.get(k, "") for k in ("id", "version", "name", "unit", "direction", "aggregate", "description", "provenance")}
    if not all(isinstance(v, str) for v in strings.values()):
        raise ValueError("id, version, name, unit, direction, aggregate, description and provenance must be strings")
    spec = MetricSpec(**strings, **lists, source="registered", code_sha256=code_sha256)
    errs = check(spec)
    if errs:
        raise ValueError("; ".join(errs))
    return spec


def metric_path(plugin_dir: Path | None, name: str) -> Path:
    """Resolved path of an approved metric file; refuses anything outside the approved directory (``..``, symlinks)."""
    if plugin_dir is None:
        raise FileNotFoundError("no approved plugin directory is configured on this installation")
    root = Path(plugin_dir).resolve()
    if not name or "/" in name or "\\" in name or name.startswith("."):
        raise FileNotFoundError("metric not found in the approved plugin directory")
    f = (root / name / METRIC_FILE).resolve()
    if root not in f.parents or not f.is_file():
        raise FileNotFoundError("metric not found in the approved plugin directory")
    return f


def code_sha256(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def discover(plugin_dir: Path | None, problem=None) -> list[dict]:
    """Metric files in the approved directory with their static metadata and compatibility (nothing is executed)."""
    if plugin_dir is None or not Path(plugin_dir).is_dir():
        return []
    root = Path(plugin_dir).resolve()
    out = []
    for f in sorted(root.glob(f"*/{METRIC_FILE}")):
        try:
            f = metric_path(root, f.parent.name)
        except FileNotFoundError:
            continue
        item = dict(plugin=f.parent.name, code_sha256=code_sha256(f))
        try:
            spec = spec_from_metadata(read_metadata(f), item["code_sha256"])
            item["metadata"] = spec.public()
            errs = compatibility(spec, problem) if problem is not None else []
            item["compatible"] = not errs
            if errs:
                item["incompatibility"] = "; ".join(errs)
        except (ValueError, SyntaxError) as e:
            item.update(compatible=False, incompatibility=str(e))
        out.append(item)
    return out


def selftest_context(spec: MetricSpec) -> dict:
    """Reserved context of the registration self-test (never a benchmark or user value): every declared input = 1,
    ``domain.complete`` = True."""
    ctx: dict = dict(metrics={}, domain={}, instance={})
    for r in spec.requires:
        if r.startswith("domain."):
            ctx["domain"][r[7:]] = True if r == "domain.complete" else 1.0
        elif r.startswith("instance."):
            ctx["instance"][r[9:]] = 1
        else:
            ctx["metrics"][r] = 1.0
    return ctx


# ------------------------------------------------------------------ inputs, outputs, aggregation
def _input(ctx: dict, key: str):
    if key.startswith("domain."):
        return (ctx.get("domain") or {}).get(key.split(".", 1)[1])
    if key.startswith("instance."):
        return (ctx.get("instance") or {}).get(key.split(".", 1)[1])
    return (ctx.get("metrics") or {}).get(key)


def inputs_of(spec: MetricSpec, ctx: dict) -> dict | None:
    """The declared inputs only (``None`` when one is missing): a metric never sees anything else."""
    out: dict = dict(metrics={}, domain={}, instance={})
    for k in spec.requires:
        v = _input(ctx, k)
        if v is None:
            return None
        if k.startswith("domain."):
            out["domain"][k[7:]] = v
        elif k.startswith("instance."):
            out["instance"][k[9:]] = v
        else:
            out["metrics"][k] = v
    return out


def _num(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


@dataclass
class Evaluation:
    per: list[float | None]
    total: float | None
    issues: list[str] = field(default_factory=list)
    outputs: list | None = None          # the raw outputs (to aggregate a subset); None when nothing was computed


def combine(spec: MetricSpec, outputs: list) -> Evaluation:
    """Validate the raw outputs (one per scenario; ``None`` = no value) and aggregate them. Invalid outputs give no
    value and are reported; the aggregate uses the scenarios that have one (ratio-of-sums: Σnum / Σden)."""
    per: list[float | None] = []
    parts: list[tuple[float, float]] = []
    issues: dict[str, int] = {}

    def issue(msg: str) -> None:
        issues[msg] = issues.get(msg, 0) + 1
    for out in outputs:
        if out is None:
            per.append(None)
        elif isinstance(out, dict) and ("error" in out or "invalid" in out):
            issue(f"computation failed ({out['error']})" if "error" in out else f"invalid output ({out['invalid']})")
            per.append(None)
        elif spec.aggregate == "ratio-of-sums":
            if isinstance(out, (tuple, list)) and len(out) == 2 and all(_num(x) for x in out):
                n, d = float(out[0]), float(out[1])
                parts.append((n, d))
                per.append(n / d if d else None)
            else:
                issue("invalid output (expected a (numerator, denominator) pair of finite numbers)")
                per.append(None)
        elif _num(out):
            per.append(float(out))
        else:
            issue("invalid output (expected a finite number)")
            per.append(None)
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
    return Evaluation(per, total, [f"{m} in {n} scenario{'s' if n > 1 else ''}" for m, n in issues.items()], list(outputs))


def plain(v) -> Any:
    """JSON form of one raw ``compute`` result (shared by the in-process path and the isolated worker)."""
    if v is None:
        return None
    if isinstance(v, bool):
        return {"invalid": "bool"}
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, (tuple, list)) and len(v) == 2 and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in v):
        return [float(v[0]), float(v[1])]
    return {"invalid": type(v).__name__}


def evaluate_detailed(spec: MetricSpec, contexts: list[dict]) -> Evaluation:
    """Trusted (built-in) metric, computed in this process."""
    from .methods import freeze
    outs: list = []
    for ctx in contexts:
        inp = inputs_of(spec, ctx)
        if inp is None:
            outs.append(None)
            continue
        try:
            outs.append(plain(spec.compute(freeze(inp))))
        except Exception as e:                               # a broken formula never breaks the comparison
            outs.append({"error": type(e).__name__})
    return combine(spec, outs)


def evaluate(spec: MetricSpec, contexts: list[dict]) -> tuple[list[float | None], float | None]:
    ev = evaluate_detailed(spec, contexts)
    return ev.per, ev.total


_cache: dict[str, tuple[float, Evaluation]] = {}
_cache_lock = threading.Lock()
CACHE_SIZE, RETRY_FAILED_S = 512, 300.0


def evaluate_isolated(spec: MetricSpec, contexts: list[dict], plugin_file: str, isolation: str, sandbox=None,
                      timeout_s: float | None = None) -> Evaluation:
    """Registered metric, computed in the isolated worker (``isolation``: ``sandbox`` with a verified ``sandbox``
    specification, or ``process`` in trusted-process mode). The worker re-checks the code hash and METADATA before
    executing; the server validates every output. Results are cached by code hash and inputs (failures are retried
    after a few minutes)."""
    from .runner import execute_isolated
    from .sandbox import SandboxUnavailable, verify
    timeout_s = TIMEOUT_S if timeout_s is None else timeout_s
    inputs = [inputs_of(spec, c) for c in contexts]
    if all(i is None for i in inputs):
        return combine(spec, [None] * len(inputs))
    key = hashlib.sha256(json.dumps([spec.code_sha256, spec.id, spec.version, isolation, inputs], sort_keys=True,
                                    default=str).encode()).hexdigest()
    with _cache_lock:
        hit = _cache.get(key)
    if hit and (not hit[1].issues or time.time() - hit[0] < RETRY_FAILED_S):
        return hit[1]
    if isolation == "sandbox":
        if sandbox is None:
            return Evaluation([None] * len(inputs), None, ["not computed: no sandbox specification (fail closed)"])
        try:
            verify(sandbox)
        except SandboxUnavailable as e:
            return Evaluation([None] * len(inputs), None, [f"not computed: sandbox unavailable ({e}); no fallback"])
    elif isolation != "process":
        return Evaluation([None] * len(inputs), None, ["not computed: no isolation decided for this metric (fail closed)"])
    req = dict(kind="metric", metric=dict(metric_id=spec.id, version=spec.version, plugin_file=plugin_file,
                                          code_sha256=spec.code_sha256),
               contexts=inputs, limits=dict(memory_mb=MEMORY_MB, cpu_s=int(math.ceil(timeout_s)) + 2))
    reply, _ = execute_isolated(req, timeout_s, sandbox=sandbox if isolation == "sandbox" else None)
    outs = reply.get("outputs") if reply.get("ok") else None
    if not isinstance(outs, list) or len(outs) != len(inputs):
        err = str(reply.get("error") or "worker reply has the wrong number of values")[:200]
        ev = Evaluation([None] * len(inputs), None, [f"not computed: {err}"])
    else:
        ev = combine(spec, outs)
    with _cache_lock:
        if len(_cache) >= CACHE_SIZE:
            _cache.pop(next(iter(_cache)))
        _cache[key] = (time.time(), ev)
    return ev
